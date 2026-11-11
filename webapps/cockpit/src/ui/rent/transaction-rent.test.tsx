// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act as testingLibraryAct, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, routedFetch, type Call } from '../../api/fetch.test-support';
import { createQueryClient } from '../../query';
import { confirmed, REC, transactionCoverage } from '../../rent/fixtures.test-support';
import { category, detail, page, property, REALM_A, REALM_B, split, TX } from '../../transactions/fixtures.test-support';
import { TransactionsArea } from '../transactions/TransactionsArea';
import { rentKeys } from './rent-keys';

/**
 * Step 6 on the Transaction detail (jsdom, real client): the Transaction's rent reconciliations from
 * `GET /transactions/{id}/rent-reconciliations` (api-design.md §37.2), a read that never writes and never calls MRE.
 */

const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const RENT = `GET /api/v1/transactions/${TX}/rent-reconciliations`;
const routeOf = (call: Call) => `${call.method} ${new URL(call.url, 'https://cockpit.internal').pathname}`;

function area(rent: (() => Response)[]) {
  const { fetch, calls } = routedFetch({
    'GET /api/v1/financial-accounts': [() => json(200, page([]))],
    'GET /api/v1/property-references': [() => json(200, page([property()]))],
    'GET /api/v1/financial-categories': [() => json(200, { items: [category()] })],
    [`GET /api/v1/transactions/${TX}`]: [() => json(200, detail({ status: 'CONFIRMED', version: 5, splits: [split()] }), { etag: '"5"' })],
    [RENT]: rent,
  });
  const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <TransactionsArea client={client} realmId={REALM_A} epoch={1} transactionId={TX} search="" />
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}

afterEach(cleanup);

describe('step 6: the rent reconciliations of a Transaction (ui-guide.md §6.6, api-design.md §37.2)', () => {
  it('rent cash, matched and free, and every reconciliation with two badges and a link; a refetch sends no command', async () => {
    const { calls, queryClient } = area([() => json(200, transactionCoverage()), () => json(200, transactionCoverage())]);
    const section = await screen.findByRole('region', { name: 'Mietabgleich dieser Buchung' });
    await within(section).findByText('Mietanteil der Buchung');
    expect(section.textContent).toContain('Mietanteil der Buchung850,00 €');
    expect(section.textContent).toContain('Davon bestätigt zugeordnet800,00 €');
    expect(section.textContent).toContain('Noch frei50,00 €');
    const list = within(section).getByRole('list', { name: 'Mietzuordnungen der Buchung' });
    expect(within(list).getByText('Zuordnung bestätigt')).toBeTruthy();
    expect(within(list).getByText('MRE: nicht übertragen')).toBeTruthy();
    expect(within(list).getByRole('link', { name: 'Zuordnung öffnen' }).getAttribute('href')).toBe(`/cockpit/r/${REALM_A}/mietabgleich/${REC}`);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: rentKeys.all(REALM_A, 1) });
    });
    expect(calls.filter((call) => routeOf(call) === RENT)).toHaveLength(2);
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('no rent split says so; an unconfirmed Transaction has nothing free, never an invented 0,00', async () => {
    area([() => json(200, transactionCoverage({ rentCash: null, available: null, matchedTotal: { amount: '0.00', currency: 'EUR' }, reconciliations: [] }))]);
    expect(await screen.findByText('Kein Mietanteil: die Aufteilung hat keine Mietkategorie.')).toBeTruthy();
    expect(screen.getByText('Keine Mietzuordnung.')).toBeTruthy();
    cleanup();
    area([
      () =>
        json(
          200,
          transactionCoverage({
            counted: false,
            status: 'CLASSIFIED',
            available: null,
            matchedTotal: { amount: '0.00', currency: 'EUR' },
            reconciliations: [],
          }),
        ),
    ]);
    expect(await screen.findByText(/Nicht zuordenbar, solange die Buchung nicht bestätigt ist/)).toBeTruthy();
  });

  it('a reconciliation of another Realm is not shown; a refused read is said', async () => {
    area([() => json(200, transactionCoverage({ reconciliations: [confirmed('800.00', { mreRealmId: REALM_B })] }))]);
    const section = await screen.findByRole('region', { name: 'Mietabgleich dieser Buchung' });
    expect(await within(section).findByText('Antwort eines anderen Bestands')).toBeTruthy();
    expect(within(section).queryByRole('list')).toBeNull();
    cleanup();
    area([() => envelope(404, 'NOT_FOUND', { transactionId: TX })]);
    const again = await screen.findByRole('region', { name: 'Mietabgleich dieser Buchung' });
    expect(await within(again).findByText('Nicht gefunden')).toBeTruthy();
  });
});
