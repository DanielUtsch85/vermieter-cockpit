// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, json, type Call } from '../../api/fetch.test-support';
import type { FetchLike } from '../../api/transport';
import { createQueryClient } from '../../query';
import { category, detail, page, property, PROPERTY, REALM_A, REALM_B, split, TX, TX_REPLACEMENT } from '../../transactions/fixtures.test-support';
import { TransactionsArea } from './TransactionsArea';

/**
 * Step 3 in the Buchungen area (jsdom): the editor appears on the detail of a Transaction whose status allows splits,
 * its request goes to the Realm of the page only, and an answer of another Realm is never shown (ui-guide.md §7.3).
 */

/** A fetch that answers by method and path, each route with its own queue of answers; every call is recorded. */
function routedFetch(routes: Record<string, (() => Response)[]>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init = {}) => {
    const call: Call = {
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
      credentials: init.credentials,
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    const key = `${call.method} ${new URL(url, 'https://cockpit.internal').pathname}`;
    const next = routes[key]?.shift();
    return next === undefined ? Promise.reject(new Error(`unexpected call ${key}`)) : Promise.resolve(next());
  };
  return { fetch, calls };
}

const pickers = () => ({
  'GET /api/v1/financial-accounts': [() => json(200, page([]))],
  'GET /api/v1/property-references': [() => json(200, page([property()]))],
  'GET /api/v1/financial-categories': [() => json(200, { items: [category(), category({ code: 'RENT_OPERATING_COST_ADVANCE', name: 'Nebenkosten' })] })],
});

const DETAIL = `GET /api/v1/transactions/${TX}`;
const PUT = `PUT /api/v1/transactions/${TX}/splits`;

function area(routes: Record<string, (() => Response)[]>) {
  const { fetch, calls } = routedFetch({ ...pickers(), ...routes });
  const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <TransactionsArea client={client} realmId={REALM_A} epoch={1} transactionId={TX} search="" />
    </QueryClientProvider>,
  );
  return calls;
}

const splitsAnswer = () =>
  json(
    200,
    {
      transactionId: TX,
      amount: { amount: '850.00', currency: 'EUR' },
      direction: 'INFLOW',
      status: 'CLASSIFIED',
      version: 4,
      splits: [split({ amount: { amount: '850.00', currency: 'EUR' } })],
    },
    { etag: '"4"' },
  );

async function saveWholeAmountOnObject() {
  const amount = await waitFor(() => {
    const element = document.getElementById('split-0-amount');
    if (element === null) throw new Error('no editor yet');
    return element;
  });
  fireEvent.change(document.getElementById('split-0-category') as HTMLSelectElement, { target: { value: 'RENT_BASE' } });
  fireEvent.change(document.getElementById('split-0-reference') as HTMLSelectElement, { target: { value: 'property' } });
  fireEvent.change(document.getElementById('split-0-property') as HTMLSelectElement, { target: { value: PROPERTY } });
  expect((amount as HTMLInputElement).value).toBe('850,00');
  fireEvent.click(screen.getByRole('button', { name: 'Aufteilung speichern' }));
}

afterEach(cleanup);

describe('step 3, the editor in the Buchungen area', () => {
  it('appears for an imported Transaction and saves with its ETag, to the Realm of the page only', async () => {
    const calls = area({
      [DETAIL]: [() => json(200, detail(), { etag: '"3"' }), () => json(200, detail({ status: 'CLASSIFIED', version: 4 }), { etag: '"4"' })],
      [PUT]: [splitsAnswer],
    });
    await saveWholeAmountOnObject();
    await screen.findByText(/Aufteilung gespeichert \(Version 4/);
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.headers.get('if-match')).toBe('"3"');
    expect(calls.map((call) => call.headers.get('organizationid'))).toEqual(calls.map(() => REALM_A));
    // The save invalidates the Transaction's reads of this Realm: the detail is read again.
    await waitFor(() => expect(calls.filter((call) => `${call.method} ${new URL(call.url, 'https://x').pathname}` === DETAIL)).toHaveLength(2));
  });

  it('confirmed, corrected, ignored or unknown statuses get no editor', async () => {
    for (const status of ['CONFIRMED', 'RECONCILED', 'CORRECTED', 'IGNORED', 'SOMETHING_NEW']) {
      area({ [DETAIL]: [() => json(200, detail({ status: status as never }), { etag: '"3"' })] });
      await screen.findByRole('heading', { name: /Buchung vom/ });
      expect(screen.queryByRole('form', { name: 'Aufteilung bearbeiten' }), status).toBeNull();
      cleanup();
    }
  });

  it('moving to another Transaction whose status allows no splits shows no editor there', async () => {
    const { fetch } = routedFetch({
      ...pickers(),
      [DETAIL]: [() => json(200, detail(), { etag: '"3"' })],
      [`GET /api/v1/transactions/${TX_REPLACEMENT}`]: [() => json(200, detail({ transactionId: TX_REPLACEMENT, status: 'CONFIRMED' }), { etag: '"5"' })],
    });
    const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
    const queryClient = createQueryClient();
    const at = (transactionId: string) => (
      <QueryClientProvider client={queryClient}>
        <TransactionsArea client={client} realmId={REALM_A} epoch={1} transactionId={transactionId} search="" />
      </QueryClientProvider>
    );
    const { rerender } = render(at(TX));
    await screen.findByRole('form', { name: 'Aufteilung bearbeiten' });
    rerender(at(TX_REPLACEMENT));
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Aufteilung bearbeiten' })).toBeNull());
    await screen.findByRole('heading', { name: /Buchung vom/ });
    expect(screen.queryByRole('form', { name: 'Aufteilung bearbeiten' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Aufteilung speichern' })).toBeNull();
  });

  it('a detail of another Realm is never shown and offers no editor', async () => {
    const calls = area({ [DETAIL]: [() => json(200, detail({ mreRealmId: REALM_B, description: 'Fremde Buchung' }), { etag: '"3"' })] });
    await screen.findByText('Antwort eines anderen Bestands');
    expect(screen.queryByText('Fremde Buchung')).toBeNull();
    expect(screen.queryByRole('form', { name: 'Aufteilung bearbeiten' })).toBeNull();
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('after a save, a re-read naming another Realm is refused and not shown; the draft stays', async () => {
    area({
      [DETAIL]: [() => json(200, detail(), { etag: '"3"' }), () => json(200, detail({ mreRealmId: REALM_B, description: 'Fremde Buchung' }), { etag: '"9"' })],
      [PUT]: [splitsAnswer],
    });
    await saveWholeAmountOnObject();
    await screen.findByText('Antwort eines anderen Bestands');
    expect(screen.queryByText('Fremde Buchung')).toBeNull();
    expect(screen.getByRole('form', { name: 'Aufteilung bearbeiten' })).toBeTruthy();
    expect(screen.getByText('Gesendet wird mit If-Match "4".')).toBeTruthy();
  });
});
