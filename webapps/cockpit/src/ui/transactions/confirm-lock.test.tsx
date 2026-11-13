// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, json, routedFetch, type Call } from '../../api/fetch.test-support';
import { createQueryClient } from '../../query';
import { category, detail, page, property, REALM_A, split, transaction, TX } from '../../transactions/fixtures.test-support';
import { TransactionsArea } from './TransactionsArea';
import { findSaved } from '../technical.test-support';

/**
 * „Buchung bestätigen“ is locked while the split editor holds a draft that differs from the stored split set, with the
 * visible hint „Zuerst Aufteilung speichern oder verwerfen“ (Entscheidung des Projektinhabers, 2026-11-11, #336 F2).
 * The whole Buchungen area in jsdom, `fireEvent` only, the real client to a routed fetch.
 */

const HINT = 'Zuerst Aufteilung speichern oder verwerfen';
const DETAIL = `GET /api/v1/transactions/${TX}`;
const PUT = `PUT /api/v1/transactions/${TX}/splits`;
const CONFIRM = `POST /api/v1/transactions/${TX}/confirm`;
const STORED = [
  split({ amount: { amount: '700.00', currency: 'EUR' } }),
  split({ position: 2, financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE', propertyReferenceId: null, amount: { amount: '150.00', currency: 'EUR' } }),
];
const CLASSIFIED = (version = 4, splits = STORED) => json(200, detail({ status: 'CLASSIFIED', version, splits }), { etag: `"${version}"` });
const routeOf = (call: Call) => `${call.method} ${new URL(call.url, 'https://cockpit.internal').pathname}`;
const commands = (calls: readonly Call[]) => calls.filter((call) => call.method !== 'GET').map(routeOf);

function area(routes: Record<string, (() => Response)[]>) {
  const { fetch, calls } = routedFetch({
    'GET /api/v1/financial-accounts': [() => json(200, page([]))],
    'GET /api/v1/property-references': [() => json(200, page([property()]))],
    'GET /api/v1/financial-categories': [() => json(200, { items: [category(), category({ code: 'RENT_OPERATING_COST_ADVANCE', name: 'Nebenkosten' })] })],
    ...routes,
  });
  const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TransactionsArea client={client} realmId={REALM_A} epoch={1} transactionId={TX} search="" />
    </QueryClientProvider>,
  );
  return calls;
}

const confirmButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Buchung bestätigen' });
const amount = (index: number) => document.getElementById(`split-${index}-amount`) as HTMLInputElement;
const type = (element: Element, value: string) => fireEvent.change(element, { target: { value } });

/** The page with its editor and an enabled „Buchung bestätigen“, nothing sent yet. */
async function ready(routes: Record<string, (() => Response)[]> = {}) {
  const calls = area({ [DETAIL]: [() => CLASSIFIED(), () => CLASSIFIED(5)], ...routes });
  await waitFor(() => expect(amount(1)).toBeTruthy());
  await waitFor(() => expect(confirmButton().disabled).toBe(false));
  return calls;
}

function expectLocked(locked: boolean) {
  const button = confirmButton();
  expect(button.disabled).toBe(locked);
  if (locked) {
    const hint = screen.getByText(HINT);
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);
    expect(hint.id).not.toBe('');
  } else {
    expect(screen.queryByText(HINT)).toBeNull();
    expect(button.hasAttribute('aria-describedby')).toBe(false);
  }
}

afterEach(cleanup);

describe('Buchung bestaetigen waits for an unsaved split draft (#336 F2)', () => {
  it('a clean draft: enabled, no hint, no discard offered', async () => {
    await ready();
    expectLocked(false);
    expect(screen.queryByRole('button', { name: 'Entwurf verwerfen' })).toBeNull();
  });

  it('a changed draft locks it with the visible hint; the same amounts typed back (also as 700) unlock it', async () => {
    const calls = await ready();
    type(amount(0), '650,00');
    type(amount(1), '200,00');
    expectLocked(true);
    fireEvent.click(confirmButton());
    expect(screen.queryByRole('dialog')).toBeNull();
    type(amount(0), '700');
    type(amount(1), '150,00');
    expectLocked(false);
    for (const change of [
      () => type(document.getElementById('split-1-description') as HTMLInputElement, 'Nebenkosten Oktober'),
      () => type(document.getElementById('split-1-category') as HTMLSelectElement, 'RENT_BASE'),
      () => fireEvent.click(screen.getByRole('button', { name: 'Teilbetrag hinzufügen' })),
    ]) {
      change();
      expectLocked(true);
      fireEvent.click(screen.getByRole('button', { name: 'Entwurf verwerfen' }));
      expectLocked(false);
    }
    expect(commands(calls)).toEqual([]);
  });

  it('Entwurf verwerfen puts the stored set back, sends nothing and unlocks', async () => {
    const calls = await ready();
    type(amount(0), '600,00');
    expectLocked(true);
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf verwerfen' }));
    expect([amount(0).value, amount(1).value]).toEqual(['700,00', '150,00']);
    expectLocked(false);
    expect(screen.queryByRole('button', { name: 'Entwurf verwerfen' })).toBeNull();
    expect(commands(calls)).toEqual([]);
  });

  it('Aufteilung speichern unlocks it once the saved set is read; then the confirm goes with the new version', async () => {
    const saved = [split({ amount: { amount: '650.00', currency: 'EUR' } }), STORED[1] ?? split()].map((s, i) =>
      i === 1 ? { ...s, amount: { amount: '200.00', currency: 'EUR' } } : s,
    );
    const calls = await ready({
      [DETAIL]: [() => CLASSIFIED(), () => CLASSIFIED(5, saved), () => CLASSIFIED(6, saved)],
      [PUT]: [
        () =>
          json(
            200,
            { transactionId: TX, amount: { amount: '850.00', currency: 'EUR' }, direction: 'INFLOW', status: 'CLASSIFIED', version: 5, splits: saved },
            { etag: '"5"' },
          ),
      ],
      [`POST /api/v1/transactions/${TX}/confirm`]: [() => json(200, transaction({ status: 'CONFIRMED', version: 6 }), { etag: '"6"' })],
    });
    type(amount(0), '650,00');
    type(amount(1), '200,00');
    expectLocked(true);
    fireEvent.click(screen.getByRole('button', { name: 'Aufteilung speichern' }));
    await findSaved(/Aufteilung gespeichert \(Status/, 5);
    await waitFor(() => expect(confirmButton().disabled).toBe(false));
    expectLocked(false);
    fireEvent.click(confirmButton());
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt bestätigen' }));
    await screen.findByText(/Buchung bestätigt/);
    expect(commands(calls)).toEqual([PUT, CONFIRM]);
    expect(calls.filter((call) => call.method !== 'GET').map((call) => call.headers.get('if-match'))).toEqual(['"4"', '"5"']);
  });

  it('a draft changed while the dialog is open disables Jetzt bestaetigen with the hint; nothing is sent', async () => {
    const calls = await ready();
    fireEvent.click(confirmButton());
    const now = screen.getByRole<HTMLButtonElement>('button', { name: 'Jetzt bestätigen' });
    expect(now.disabled).toBe(false);
    type(amount(0), '600,00');
    expect(now.disabled).toBe(true);
    expect(now.getAttribute('aria-describedby')).toBe(screen.getByText(HINT).id);
    fireEvent.click(now);
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf verwerfen' }));
    expect(now.disabled).toBe(false);
    expect(commands(calls)).toEqual([]);
    // The old warning in the dialog is gone: the lock replaces it.
    expect(screen.getByRole('dialog').textContent).not.toMatch(/Nicht gespeicherte Änderungen/);
  });
});
