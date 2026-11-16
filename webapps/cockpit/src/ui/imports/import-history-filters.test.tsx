// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, json, routedFetch, type Call } from '../../api/fetch.test-support';
import { IMPORT_HISTORY_PAGE_SIZE } from '../../api/imports';
import { BATCH, batchSummary, EARLIER_BATCH } from '../../imports/fixtures.test-support';
import { useLocationPath, useLocationSearch } from '../../navigation';
import { createQueryClient } from '../../query';
import { parseRoute } from '../../routing';
import { account, ACCOUNT, page, REALM_A } from '../../transactions/fixtures.test-support';
import { ImportArea } from './ImportArea';
import { bookingRangeText, historySearch, readHistoryQuery } from './ImportHistory';

/**
 * The booking range per import (VC-X-75) and the filters of „Bisherige Importe“ (VC-X-76; Entscheidung des
 * Projektinhabers, 2026-11-16): „Nur mit offenen Klärfällen“ and the account, both in the URL, both sent as the route's
 * own filters (api-design.md §32.6). Synthetic data only.
 */

const LIST = 'GET /api/v1/imports';
const IMPORT = `/cockpit/r/${REALM_A}/import`;
const SAVINGS = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const open = batchSummary({
  importBatchId: BATCH,
  status: 'NEEDS_REVIEW',
  needsReviewCount: 2,
  firstBookingDate: '2026-10-01',
  lastBookingDate: '2026-10-31',
});
const empty = batchSummary({ importBatchId: EARLIER_BATCH, importedAt: '2026-10-05T08:00:00.000Z', firstBookingDate: null, lastBookingDate: null });
const listPage =
  (items: readonly unknown[], pageNo = 1, total = items.length) =>
  () =>
    json(200, { items, page: pageNo, pageSize: IMPORT_HISTORY_PAGE_SIZE, total });
const routeOf = (call: Call) => `${call.method} ${new URL(call.url, 'https://cockpit.internal').pathname}`;
const searchOf = (call: Call) => new URL(call.url, 'https://cockpit.internal').search;

function Routed({ client }: { readonly client: ReturnType<typeof createDeClient> }) {
  const route = parseRoute(useLocationPath());
  const search = useLocationSearch();
  return <ImportArea client={client} realmId={REALM_A} epoch={1} importBatchId={route.kind === 'area' ? route.importBatchId : undefined} search={search} />;
}

function area(routes: Record<string, (() => Response)[]>, path = IMPORT) {
  window.history.pushState(null, '', path);
  const accounts = page([account(), account({ financialAccountId: SAVINGS, displayName: 'Tagesgeld Testbank' })]);
  const { fetch, calls } = routedFetch({ 'GET /api/v1/financial-accounts': [() => json(200, accounts)], ...routes });
  const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Routed client={client} />
    </QueryClientProvider>,
  );
  return { lists: () => calls.filter((call) => routeOf(call) === LIST).map(searchOf) };
}

const section = () => screen.getByRole('region', { name: 'Bisherige Importe' });
const filterForm = () => within(section()).getByRole('form', { name: 'Filter der Importliste' });
const base = `?page=1&pageSize=${IMPORT_HISTORY_PAGE_SIZE}`;

beforeEach(() => window.history.pushState(null, '', '/'));
afterEach(cleanup);

describe('the booking range per import (VC-X-75)', () => {
  it('shows „Buchungen 01.10.2026 – 31.10.2026“ and nothing for an import without a booking date', async () => {
    area({ [LIST]: [listPage([open, empty])] });
    const rows = within(await screen.findByRole('list', { name: 'Bisherige Importe, Seite 1 von 1' })).getAllByRole('listitem');
    expect(within(rows[0] as HTMLElement).getByText('Buchungen 01.10.2026 – 31.10.2026')).toBeTruthy();
    expect(rows[1]?.textContent).not.toContain('Buchungen ');
    expect(bookingRangeText({ firstBookingDate: '2026-10-15', lastBookingDate: '2026-10-15' })).toBe('Buchungen 15.10.2026 – 15.10.2026');
    expect(bookingRangeText({ firstBookingDate: null, lastBookingDate: null })).toBeUndefined();
  });
});

describe('the filters of the import list (VC-X-76)', () => {
  it('no filter: all accounts, the shortcut off, no reset link, and no filter sent', async () => {
    const { lists } = area({ [LIST]: [listPage([open, empty])] });
    await screen.findByRole('list', { name: 'Bisherige Importe, Seite 1 von 1' });
    expect(within(filterForm()).getByLabelText<HTMLSelectElement>('Konto der Importe').value).toBe('');
    expect(within(filterForm()).getByLabelText<HTMLInputElement>('Nur mit offenen Klärfällen').checked).toBe(false);
    expect(within(section()).queryByRole('link', { name: 'Filter zurücksetzen' })).toBeNull();
    expect(lists()).toEqual([base]);
  });

  it('applied on submit: the URL holds both, the list is read with both from page 1, and nothing is sent before', async () => {
    const { lists } = area({ [LIST]: [listPage([open, empty], 2, 22), listPage([open])] }, `${IMPORT}?page=2`);
    await screen.findByRole('list', { name: 'Bisherige Importe, Seite 2 von 2' });
    fireEvent.change(within(filterForm()).getByLabelText('Konto der Importe'), { target: { value: ACCOUNT } });
    fireEvent.click(within(filterForm()).getByLabelText('Nur mit offenen Klärfällen'));
    // Choosing reads nothing; only „Filter anwenden“ does.
    expect(lists()).toHaveLength(1);
    fireEvent.click(within(filterForm()).getByRole('button', { name: 'Filter anwenden' }));
    await waitFor(() => expect(window.location.search).toBe(`?status=NEEDS_REVIEW&financialAccountId=${ACCOUNT}`));
    await waitFor(() => expect(lists()).toEqual([`?page=2&pageSize=${IMPORT_HISTORY_PAGE_SIZE}`, `${base}&status=NEEDS_REVIEW&financialAccountId=${ACCOUNT}`]));
  });

  it('read from the URL: the form shows them, the pages keep them, „Filter zurücksetzen“ shows every import again', async () => {
    const search = `?status=NEEDS_REVIEW&financialAccountId=${SAVINGS}&page=2`;
    const { lists } = area({ [LIST]: [listPage([{ ...open, financialAccountId: SAVINGS }], 2, 41)] }, `${IMPORT}${search}`);
    await screen.findByRole('list', { name: 'Bisherige Importe, Seite 2 von 3' });
    expect(lists()).toEqual([`?page=2&pageSize=${IMPORT_HISTORY_PAGE_SIZE}&status=NEEDS_REVIEW&financialAccountId=${SAVINGS}`]);
    expect(within(filterForm()).getByLabelText<HTMLSelectElement>('Konto der Importe').value).toBe(SAVINGS);
    expect(within(filterForm()).getByLabelText<HTMLInputElement>('Nur mit offenen Klärfällen').checked).toBe(true);
    const link = (name: string) => within(section()).getByRole('link', { name }).getAttribute('href');
    expect(link('Vorherige Seite')).toBe(`${IMPORT}?status=NEEDS_REVIEW&financialAccountId=${SAVINGS}`);
    expect(link('Nächste Seite')).toBe(`${IMPORT}?status=NEEDS_REVIEW&financialAccountId=${SAVINGS}&page=3`);
    expect(link('Filter zurücksetzen')).toBe(IMPORT);
  });

  it('an empty filtered list says so, distinct from an empty Realm', async () => {
    area({ [LIST]: [listPage([])] }, `${IMPORT}?status=NEEDS_REVIEW`);
    expect(await within(section()).findByText('Keine Importe zu diesen Filtern.')).toBeTruthy();
    expect(within(section()).queryByText('Noch keine Importe in diesem Bestand.')).toBeNull();
  });

  it('an account the list does not hold stays chosen by its id, never dropped', async () => {
    const unknown = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
    area({ [LIST]: [listPage([])] }, `${IMPORT}?financialAccountId=${unknown}`);
    await within(section()).findByText('Keine Importe zu diesen Filtern.');
    const select = within(filterForm()).getByLabelText<HTMLSelectElement>('Konto der Importe');
    expect(select.value).toBe(unknown);
    expect(select.selectedOptions[0]?.textContent).toBe(`Konto ${unknown}`);
  });

  it('URL values the list cannot send are read as no filter: another status, an account that is no UUID, a bad page', () => {
    expect(readHistoryQuery('?status=COMPLETED&financialAccountId=abc&page=0')).toEqual({ page: 1, openOnly: false, financialAccountId: undefined });
    expect(readHistoryQuery(`?status=NEEDS_REVIEW&financialAccountId=${ACCOUNT.toUpperCase()}&page=4`)).toEqual({
      page: 4,
      openOnly: true,
      financialAccountId: ACCOUNT,
    });
    expect(historySearch({ page: 1, openOnly: false, financialAccountId: undefined })).toBe('');
    expect(historySearch({ page: 3, openOnly: true, financialAccountId: ACCOUNT })).toBe(`?status=NEEDS_REVIEW&financialAccountId=${ACCOUNT}&page=3`);
  });
});
