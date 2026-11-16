// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act as testingLibraryAct, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, routedFetch, type Call } from '../../api/fetch.test-support';
import { IMPORT_HISTORY_PAGE_SIZE } from '../../api/imports';
import { batch, BATCH, batchSummary, EARLIER_BATCH, ITEM, resolved, reviewItem } from '../../imports/fixtures.test-support';
import { navigate, useLocationPath, useLocationSearch } from '../../navigation';
import { createQueryClient } from '../../query';
import { parseRoute } from '../../routing';
import { account, page, REALM_A } from '../../transactions/fixtures.test-support';
import { ImportArea } from './ImportArea';

/**
 * „Bisherige Importe“ under the import form (#369; Entscheidung des Projektinhabers, 2026-11-16; api-design.md §32.6):
 * the list as the server sends it, newest first, an import with open review items highlighted and reachable without its
 * address, the pages in the URL, its states, and the re-read after an import or a decision.
 */

const LIST = 'GET /api/v1/imports';
const IMPORT = `/cockpit/r/${REALM_A}/import`;
const open = batchSummary({ importBatchId: BATCH, sourceFilename: 'umsaetze-november.csv', status: 'NEEDS_REVIEW', needsReviewCount: 2, transactionCount: 3 });
const done = batchSummary({ importBatchId: EARLIER_BATCH, sourceFilename: null, importedAt: '2026-10-05T08:00:00.000Z', duplicateCount: 4 });
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
  const { fetch, calls } = routedFetch({ 'GET /api/v1/financial-accounts': [() => json(200, page([account()]))], ...routes });
  const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Routed client={client} />
    </QueryClientProvider>,
  );
  return { calls, lists: () => calls.filter((call) => routeOf(call) === LIST) };
}

const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const section = () => screen.getByRole('region', { name: 'Bisherige Importe' });

beforeEach(() => window.history.pushState(null, '', '/'));
afterEach(cleanup);

describe('Bisherige Importe (#369, §32.6)', () => {
  it('lists the imports under the form, newest first, with file, time, account, counters and status, as the server sent them', async () => {
    const { lists } = area({ [LIST]: [listPage([open, done], 1, 2)] });
    const list = await screen.findByRole('list', { name: 'Bisherige Importe, Seite 1 von 1' });
    // Under the form: the form's file field comes first in the page.
    const form = screen.getByLabelText('CSV-Datei');
    expect(form.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['umsaetze-november.csv, Klärfälle offen', 'Datei ohne Namen']);
    expect(rows[0]?.textContent).toContain('Girokonto Testbank');
    expect(rows[0]?.textContent).toContain('3 neue Buchungen · 0 Duplikate · 0 Zeilen mit Fehler · 0 übersprungen');
    expect(rows[1]?.textContent).toContain('1 neue Buchung · 4 Duplikate');
    expect(within(rows[1] as HTMLElement).getByText('Abgeschlossen')).toBeTruthy();
    expect(
      within(rows[1] as HTMLElement)
        .getByRole('time')
        .getAttribute('datetime'),
    ).toBe('2026-10-05T08:00:00.000Z');
    expect(within(section()).getByText('Seite 1 von 1 · 2 Importe')).toBeTruthy();
    // One read: the first page, the list's page size, no filter.
    expect(lists().map(searchOf)).toEqual([`?page=1&pageSize=${IMPORT_HISTORY_PAGE_SIZE}`]);
  });

  it('an import with open review items is highlighted in words and reachable without its address', async () => {
    area({
      [LIST]: [listPage([open, done], 1, 2)],
      [`GET /api/v1/imports/${BATCH}`]: [() => json(200, batch({ status: 'NEEDS_REVIEW', needsReviewCount: 1, sourceFilename: 'umsaetze-november.csv' }))],
      [`GET /api/v1/imports/${BATCH}/review-items`]: [() => json(200, { importBatchId: BATCH, items: [reviewItem()] })],
    });
    const highlighted = await screen.findByRole('listitem', { name: 'umsaetze-november.csv, Klärfälle offen' });
    expect(within(highlighted).getByText('Klärfälle offen')).toBeTruthy();
    expect(within(highlighted).getByText('2 offene Klärfälle')).toBeTruthy();
    expect(highlighted.className).toContain('border-warning-text');
    const plain = screen.getByRole('listitem', { name: 'Datei ohne Namen' });
    expect(plain.className).not.toContain('border-warning-text');
    expect(within(plain).queryByText(/offene Klärf/)).toBeNull();
    expect(within(plain).getByRole('link', { name: 'Ergebnis öffnen' }).getAttribute('href')).toBe(`${IMPORT}/${EARLIER_BATCH}`);
    // The link of the highlighted import leads to its review items.
    fireEvent.click(within(highlighted).getByRole('link', { name: 'Klärfälle bearbeiten' }));
    expect(window.location.pathname).toBe(`${IMPORT}/${BATCH}`);
    await screen.findByRole('article', { name: 'Klärfall Zeile 3' });
  });

  it('pages from the server s total; the page is the URL s, a page beyond the last offers the last', async () => {
    const twentyOne = Array.from({ length: IMPORT_HISTORY_PAGE_SIZE }, (_, i) =>
      batchSummary({ importBatchId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, sourceFilename: `datei-${i + 1}.csv` }),
    );
    const { lists } = area({ [LIST]: [listPage(twentyOne, 1, 21), listPage([done], 2, 21), listPage([], 3, 21)] });
    await screen.findByRole('list', { name: 'Bisherige Importe, Seite 1 von 2' });
    expect(within(section()).queryByRole('link', { name: 'Vorherige Seite' })).toBeNull();
    fireEvent.click(within(section()).getByRole('link', { name: 'Nächste Seite' }));
    expect(window.location.search).toBe('?page=2');
    await screen.findByRole('list', { name: 'Bisherige Importe, Seite 2 von 2' });
    expect(within(section()).getByText('Seite 2 von 2 · 21 Importe')).toBeTruthy();
    expect(within(section()).queryByRole('link', { name: 'Nächste Seite' })).toBeNull();
    expect(within(section()).getByRole('link', { name: 'Vorherige Seite' }).getAttribute('href')).toBe(IMPORT);
    // A page beyond the last (an import was resolved away meanwhile, or a typed URL).
    await act(() => navigate(`${IMPORT}?page=3`));
    await within(section()).findByText('Seite 3 gibt es nicht.', { exact: false });
    expect(within(section()).getByRole('link', { name: 'Zur letzten Seite' }).getAttribute('href')).toBe(`${IMPORT}?page=2`);
    expect(lists().map(searchOf)).toEqual([1, 2, 3].map((n) => `?page=${n}&pageSize=${IMPORT_HISTORY_PAGE_SIZE}`));
  });

  it('a Realm without imports says so; a refused read is an error with its retry, never an empty list', async () => {
    area({ [LIST]: [listPage([], 1, 0)] });
    expect(await within(await screen.findByRole('region', { name: 'Bisherige Importe' })).findByText('Noch keine Importe in diesem Bestand.')).toBeTruthy();
    cleanup();
    const { lists } = area({ [LIST]: [() => envelope(503, 'SERVICE_UNAVAILABLE'), listPage([done], 1, 1)] });
    const retry = await within(await screen.findByRole('region', { name: 'Bisherige Importe' })).findByRole('button', { name: /erneut/i });
    expect(within(section()).queryByText('Noch keine Importe in diesem Bestand.')).toBeNull();
    fireEvent.click(retry);
    await screen.findByRole('listitem', { name: 'Datei ohne Namen' });
    expect(lists()).toHaveLength(2);
  });

  it('a decision on the batch s page makes the list read again when the user returns', async () => {
    const { lists } = area({
      [LIST]: [listPage([open], 1, 1), listPage([{ ...open, status: 'COMPLETED', needsReviewCount: 0 }], 1, 1)],
      [`GET /api/v1/imports/${BATCH}`]: [() => json(200, batch({ status: 'NEEDS_REVIEW', needsReviewCount: 1 })), () => json(200, batch())],
      [`GET /api/v1/imports/${BATCH}/review-items`]: [
        () => json(200, { importBatchId: BATCH, items: [reviewItem()] }),
        () => json(200, { importBatchId: BATCH, items: [resolved('SKIP')] }),
      ],
      [`POST /api/v1/imports/${BATCH}/review-items/${ITEM}/resolve`]: [() => json(200, resolved('SKIP'))],
    });
    fireEvent.click(await screen.findByRole('link', { name: 'Klärfälle bearbeiten' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Nicht als neue Buchung übernehmen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt nicht übernehmen' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Jetzt nicht übernehmen' })).toBeNull());
    fireEvent.click(screen.getByRole('link', { name: 'Neue Datei importieren' }));
    const row = await screen.findByRole('listitem', { name: 'umsaetze-november.csv' });
    expect(within(row).getByText('Abgeschlossen')).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Ergebnis öffnen' })).toBeTruthy();
    expect(lists()).toHaveLength(2);
  });
});
