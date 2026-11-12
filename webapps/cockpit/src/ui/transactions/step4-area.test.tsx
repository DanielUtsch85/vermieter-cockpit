// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, routedFetch, type Call } from '../../api/fetch.test-support';
import { createQueryClient } from '../../query';
import {
  category,
  correctionAnswer,
  detail,
  page,
  property,
  REALM_A,
  REALM_B,
  split,
  transaction,
  TX,
  TX_REPLACEMENT,
  TX_REVERSAL,
} from '../../transactions/fixtures.test-support';
import { TransactionsArea } from './TransactionsArea';

/**
 * Step 4 in the Buchungen area (jsdom): confirm and correct on the detail, the re-read after the answer, the statuses
 * that offer neither, and the Realm of the page as the only one asked and shown (ui-guide.md §7.3).
 */

const pickers = () => ({
  'GET /api/v1/financial-accounts': [() => json(200, page([]))],
  'GET /api/v1/property-references': [() => json(200, page([property()]))],
  'GET /api/v1/financial-categories': [() => json(200, { items: [category()] })],
});

const at = (id: string) => `GET /api/v1/transactions/${id}`;
const CONFIRM = `POST /api/v1/transactions/${TX}/confirm`;
const CORRECT = (id: string) => `POST /api/v1/transactions/${id}/correct`;
const routeOf = (call: Call) => `${call.method} ${new URL(call.url, 'https://cockpit.internal').pathname}`;

const SPLITS = [split({ amount: { amount: '850.00', currency: 'EUR' } })];
const CLASSIFIED = () => json(200, detail({ status: 'CLASSIFIED', version: 4, splits: SPLITS }), { etag: '"4"' });
const CONFIRMED = (overrides = {}) =>
  json(200, detail({ status: 'CONFIRMED', version: 5, confirmedAt: '2026-03-05T10:00:00.000Z', splits: SPLITS, ...overrides }), { etag: '"5"' });

function area(routes: Record<string, (() => Response)[]>, transactionId = TX) {
  const { fetch, calls } = routedFetch({ ...pickers(), ...routes });
  const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  const queryClient = createQueryClient();
  const view = (id: string) => (
    <QueryClientProvider client={queryClient}>
      <TransactionsArea client={client} realmId={REALM_A} epoch={1} transactionId={id} search="" />
    </QueryClientProvider>
  );
  const { rerender } = render(view(transactionId));
  return { calls, moveTo: (id: string) => rerender(view(id)) };
}

async function correctDescription(text = 'Korrigierter Verwendungszweck') {
  fireEvent.click(await screen.findByRole('button', { name: 'Korrektur erfassen' }));
  fireEvent.change(document.getElementById('korrektur-reason') as HTMLTextAreaElement, { target: { value: 'Falscher Verwendungszweck' } });
  fireEvent.change(document.getElementById('korrektur-description') as HTMLInputElement, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Korrektur ausführen' }));
}

afterEach(cleanup);

describe('step 4 in the Buchungen area', () => {
  it('confirm: If-Match of the detail, Realm A only, the badge turns green only with the re-read; the editor goes', async () => {
    const { calls } = area({
      [at(TX)]: [CLASSIFIED, CONFIRMED],
      [CONFIRM]: [() => json(200, transaction({ status: 'CONFIRMED', version: 5 }), { etag: '"5"' })],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Buchung bestätigen' }));
    expect(screen.getByRole('form', { name: 'Aufteilung bearbeiten' })).toBeTruthy();
    const heading = screen.getByRole('heading', { name: 'Angaben zur Buchung' }).parentElement as HTMLElement;
    expect(within(heading).getByText('Aufgeteilt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt bestätigen' }));
    await screen.findByText(/Buchung bestätigt \(Version 5/);
    expect(calls.find((call) => routeOf(call) === CONFIRM)?.headers.get('if-match')).toBe('"4"');
    await waitFor(() => expect(calls.filter((call) => routeOf(call) === at(TX))).toHaveLength(2));
    await waitFor(() => expect(within(heading).getByText('Bestätigt')).toBeTruthy());
    expect(screen.queryByRole('form', { name: 'Aufteilung bearbeiten' })).toBeNull();
    // Confirmed now: the correction is offered.
    expect(await screen.findByRole('button', { name: 'Korrektur erfassen' })).toBeTruthy();
    expect(calls.map((call) => call.headers.get('organizationid'))).toEqual(calls.map(() => REALM_A));
  });

  it('correct: the chain is shown, the detail read again; the replacement corrected next is a new intent with a new key', async () => {
    const { calls, moveTo } = area({
      [at(TX)]: [CONFIRMED, () => json(200, detail({ ...correctionAnswer().original, splits: SPLITS }))],
      [CORRECT(TX)]: [() => json(201, correctionAnswer({ description: 'Korrigierter Verwendungszweck' }))],
      [at(TX_REPLACEMENT)]: [() => json(200, detail({ ...correctionAnswer().replacement, splits: SPLITS }), { etag: '"1"' })],
      [CORRECT(TX_REPLACEMENT)]: [() => json(201, correctionAnswer({}, correctionAnswer().replacement))],
    });
    expect(screen.queryByRole('button', { name: 'Buchung bestätigen' })).toBeNull();
    await correctDescription();
    await screen.findByRole('heading', { name: 'Korrektur ausgeführt' });
    await waitFor(() => expect(calls.filter((call) => routeOf(call) === at(TX))).toHaveLength(2));
    // The original is CORRECTED now: its own chain section links reversal and replacement; nothing edits it.
    const chain = screen.getByRole('region', { name: 'Korrekturen' });
    await waitFor(() =>
      expect(
        within(chain)
          .getAllByRole('link')
          .map((a) => a.textContent),
      ).toEqual(['Storno dieser Buchung', 'Ersatzbuchung']),
    );
    expect(screen.queryByRole('button', { name: 'Korrektur erfassen' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Aufteilung bearbeiten' })).toBeNull();
    const first = calls.find((call) => routeOf(call) === CORRECT(TX));

    moveTo(TX_REPLACEMENT);
    await correctDescription();
    await waitFor(() => expect(calls.some((call) => routeOf(call) === CORRECT(TX_REPLACEMENT))).toBe(true));
    const second = calls.find((call) => routeOf(call) === CORRECT(TX_REPLACEMENT));
    expect(second?.body).toBe(first?.body);
    expect(second?.headers.get('idempotency-key')).not.toBe(first?.headers.get('idempotency-key'));
    expect(second?.headers.get('if-match')).toBe('"1"');
  });

  it('a corrected original, a reversal, an unconfirmed or ignored Transaction offer no correction; CORRECTED nothing at all', async () => {
    const cases: [string, Response][] = [
      ['CORRECTED', json(200, detail({ ...correctionAnswer().original, splits: SPLITS }), { etag: '"5"' })],
      ['REVERSAL', json(200, detail({ ...correctionAnswer().reversal, splits: SPLITS }), { etag: '"1"' })],
      ['CLASSIFIED', json(200, detail({ status: 'CLASSIFIED', splits: SPLITS }), { etag: '"4"' })],
      ['IGNORED', json(200, detail({ status: 'IGNORED' }), { etag: '"4"' })],
      ['RECONCILED', json(200, detail({ status: 'RECONCILED', splits: SPLITS }), { etag: '"4"' })],
    ];
    for (const [name, response] of cases) {
      area({ [at(TX)]: [() => response] });
      await screen.findByRole('heading', { name: 'Angaben zur Buchung' });
      expect(screen.queryByRole('button', { name: 'Korrektur erfassen' }), name).toBeNull();
      if (name !== 'CLASSIFIED') expect(screen.queryByRole('button', { name: 'Buchung bestätigen' }), name).toBeNull();
      if (name === 'CORRECTED') expect(screen.queryByRole('form', { name: 'Aufteilung bearbeiten' })).toBeNull();
      cleanup();
    }
  });

  it('a confirm answer of another Realm is refused and never shown as confirmed', async () => {
    area({
      [at(TX)]: [CLASSIFIED],
      [CONFIRM]: [() => json(200, transaction({ status: 'CONFIRMED', version: 5, mreRealmId: REALM_B }), { etag: '"5"' })],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Buchung bestätigen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt bestätigen' }));
    await screen.findByText('Antwort eines anderen Bestands');
    expect(screen.queryByText(/Buchung bestätigt \(/)).toBeNull();
    const heading = screen.getByRole('heading', { name: 'Angaben zur Buchung' }).parentElement as HTMLElement;
    expect(within(heading).getByText('Aufgeteilt')).toBeTruthy();
  });

  it('a correction answer naming another Realm is refused; no chain is shown, the draft stays', async () => {
    const answer = correctionAnswer();
    const { calls } = area({
      [at(TX)]: [CONFIRMED],
      [CORRECT(TX)]: [() => json(201, { ...answer, replacement: { ...answer.replacement, mreRealmId: REALM_B, description: 'Fremde Ersatzbuchung' } })],
    });
    await correctDescription();
    await screen.findByText('Antwort eines anderen Bestands');
    expect(screen.queryByRole('heading', { name: 'Korrektur ausgeführt' })).toBeNull();
    expect(screen.queryByText('Fremde Ersatzbuchung')).toBeNull();
    expect((document.getElementById('korrektur-description') as HTMLInputElement).value).toBe('Korrigierter Verwendungszweck');
    expect(calls.map((call) => call.headers.get('organizationid'))).toEqual(calls.map(() => REALM_A));
    expect(calls.some((call) => routeOf(call) === at(TX_REVERSAL))).toBe(false);
  });

  it('a 412 on confirm reads again only on request; a re-read naming another Realm is not shown and blocks the action', async () => {
    const { calls } = area({
      [at(TX)]: [
        CLASSIFIED,
        () => json(200, detail({ status: 'CLASSIFIED', version: 6, splits: SPLITS, mreRealmId: REALM_B, description: 'Fremde Buchung' }), { etag: '"6"' }),
      ],
      [CONFIRM]: [() => envelope(412, 'VERSION_CONFLICT', { expectedVersions: [4], currentVersion: 6 })],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Buchung bestätigen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt bestätigen' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aktuellen Stand laden' }));
    await screen.findByText('Antwort eines anderen Bestands');
    expect(screen.queryByText('Fremde Buchung')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Buchung bestätigen' }).disabled).toBe(true);
    expect(calls.filter((call) => routeOf(call) === CONFIRM)).toHaveLength(1);
    expect(calls.filter((call) => routeOf(call) === at(TX))).toHaveLength(2);
  });
});
