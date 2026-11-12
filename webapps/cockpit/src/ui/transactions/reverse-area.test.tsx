// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, json, routedFetch, type Call } from '../../api/fetch.test-support';
import { createQueryClient } from '../../query';
import {
  category,
  correctionAnswer,
  detail,
  page,
  property,
  REALM_A,
  REALM_B,
  reversalAnswer,
  split,
  TX,
  TX_REPLACEMENT,
  TX_REVERSAL,
} from '../../transactions/fixtures.test-support';
import { TransactionsArea } from './TransactionsArea';

/**
 * „Stornieren“ in the Buchungen area (jsdom, `fireEvent` only; Entscheidung des Projektinhabers, 2026-11-11): offered
 * exactly where „Korrigieren“ is, its own button; the reversal re-reads the detail; the Realm of the page is the only
 * one asked and shown (ui-guide.md §7.3).
 */

const pickers = () => ({
  'GET /api/v1/financial-accounts': [() => json(200, page([]))],
  'GET /api/v1/property-references': [() => json(200, page([property()]))],
  'GET /api/v1/financial-categories': [() => json(200, { items: [category()] })],
});

const at = (id: string) => `GET /api/v1/transactions/${id}`;
const REVERSE = (id: string) => `POST /api/v1/transactions/${id}/reverse`;
const routeOf = (call: Call) => `${call.method} ${new URL(call.url, 'https://cockpit.internal').pathname}`;
const SPLITS = [split({ amount: { amount: '850.00', currency: 'EUR' } })];
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

async function reverse(reason = 'Doppelt erfasst') {
  fireEvent.click(await screen.findByRole('button', { name: 'Stornieren' }));
  fireEvent.change(document.getElementById('storno-reason') as HTMLTextAreaElement, { target: { value: reason } });
  fireEvent.click(screen.getByRole('button', { name: 'Storno ausführen' }));
  fireEvent.click(screen.getByRole('button', { name: 'Jetzt stornieren' }));
}

afterEach(cleanup);

describe('„Stornieren“ in the Buchungen area', () => {
  it('offered with „Korrigieren“ for CONFIRMED (also a replacement), as its own button; for no other status or a reversal', async () => {
    const cases: [string, Response, boolean][] = [
      ['CONFIRMED', CONFIRMED(), true],
      ['REPLACEMENT', json(200, detail({ ...correctionAnswer().replacement, splits: SPLITS }), { etag: '"1"' }), true],
      ['CORRECTED', json(200, detail({ ...reversalAnswer().original, splits: SPLITS }), { etag: '"6"' }), false],
      ['REVERSAL', json(200, detail({ ...correctionAnswer().reversal, splits: SPLITS }), { etag: '"1"' }), false],
      ['IMPORTED', json(200, detail({ status: 'IMPORTED' }), { etag: '"3"' }), false],
      ['CLASSIFIED', json(200, detail({ status: 'CLASSIFIED', splits: SPLITS }), { etag: '"4"' }), false],
      ['IGNORED', json(200, detail({ status: 'IGNORED' }), { etag: '"4"' }), false],
      ['RECONCILED', json(200, detail({ status: 'RECONCILED', splits: SPLITS }), { etag: '"4"' }), false],
      ['SOMETHING_NEW', json(200, detail({ status: 'SOMETHING_NEW' as never, splits: SPLITS }), { etag: '"4"' }), false],
    ];
    for (const [name, response, offered] of cases) {
      area({ [at(TX)]: [() => response] });
      await screen.findByRole('heading', { name: 'Angaben zur Buchung' });
      const korrigieren = screen.queryByRole('button', { name: 'Korrektur erfassen' });
      const stornieren = screen.queryByRole<HTMLButtonElement>('button', { name: 'Stornieren' });
      expect(stornieren !== null, name).toBe(offered);
      expect(korrigieren !== null, name).toBe(offered);
      if (stornieren !== null) {
        expect(stornieren.disabled, name).toBe(false);
        expect(stornieren).not.toBe(korrigieren);
        expect(screen.getByRole('region', { name: 'Stornieren' })).toBeTruthy();
      }
      cleanup();
    }
  });

  it('reverse: one request, the chain shown, the detail read again; the original is CORRECTED with no replacement', async () => {
    const { calls } = area({
      [at(TX)]: [CONFIRMED, () => json(200, detail({ ...reversalAnswer().original, splits: SPLITS }), { etag: '"6"' })],
      [REVERSE(TX)]: [() => json(201, reversalAnswer())],
    });
    await reverse();
    await screen.findByRole('heading', { name: 'Storno ausgeführt' });
    await waitFor(() => expect(calls.filter((call) => routeOf(call) === at(TX))).toHaveLength(2));
    const chain = screen.getByRole('region', { name: 'Korrekturen' });
    await waitFor(() =>
      expect(
        within(chain)
          .getAllByRole('link')
          .map((a) => a.textContent),
      ).toEqual(['Storno dieser Buchung']),
    );
    expect(within(chain).getByRole('link').getAttribute('href')).toBe(`/cockpit/r/${REALM_A}/buchungen/${TX_REVERSAL}`);
    // The correction is no longer possible on the reversed original.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Korrektur erfassen' }).disabled).toBe(true);
    const commands = calls.filter((call) => call.method !== 'GET');
    expect(commands.map(routeOf)).toEqual([REVERSE(TX)]);
    expect(commands[0]?.headers.get('if-match')).toBe('"5"');
    expect(commands[0]?.body).toBe('{"reason":"Doppelt erfasst"}');
    expect(calls.map((call) => call.headers.get('organizationid'))).toEqual(calls.map(() => REALM_A));
  });

  it('a success ends the intent: the next reversal, of another booking with the same reason, gets a new key', async () => {
    const { calls, moveTo } = area({
      [at(TX)]: [CONFIRMED, CONFIRMED],
      [REVERSE(TX)]: [() => json(201, reversalAnswer())],
      [at(TX_REPLACEMENT)]: [() => CONFIRMED({ transactionId: TX_REPLACEMENT })],
      [REVERSE(TX_REPLACEMENT)]: [() => json(201, reversalAnswer({ transactionId: TX_REPLACEMENT }))],
    });
    await reverse();
    await screen.findByRole('heading', { name: 'Storno ausgeführt' });
    moveTo(TX_REPLACEMENT);
    await reverse();
    await waitFor(() => expect(calls.some((call) => routeOf(call) === REVERSE(TX_REPLACEMENT))).toBe(true));
    const [first, second] = [REVERSE(TX), REVERSE(TX_REPLACEMENT)].map((route) => calls.find((call) => routeOf(call) === route));
    expect(second?.body).toBe(first?.body);
    expect(second?.headers.get('idempotency-key')).toMatch(/^[\x21-\x7e]{1,255}$/);
    expect(second?.headers.get('idempotency-key')).not.toBe(first?.headers.get('idempotency-key'));
  });

  it('a reversal answer naming another Realm is refused; no chain is shown, nothing of it is read or linked', async () => {
    const answer = reversalAnswer();
    const { calls } = area({
      [at(TX)]: [CONFIRMED],
      [REVERSE(TX)]: [() => json(201, { ...answer, reversal: { ...answer.reversal, mreRealmId: REALM_B, description: 'Fremdes Storno' } })],
    });
    await reverse();
    await screen.findByText('Antwort eines anderen Bestands');
    expect(screen.queryByRole('heading', { name: 'Storno ausgeführt' })).toBeNull();
    expect(screen.queryByText('Fremdes Storno')).toBeNull();
    expect((document.getElementById('storno-reason') as HTMLTextAreaElement).value).toBe('Doppelt erfasst');
    expect(calls.map((call) => call.headers.get('organizationid'))).toEqual(calls.map(() => REALM_A));
    expect(calls.some((call) => routeOf(call) === at(TX_REVERSAL))).toBe(false);
  });
});
