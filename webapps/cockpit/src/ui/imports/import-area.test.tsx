// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act as testingLibraryAct, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, routedFetch, type Call } from '../../api/fetch.test-support';
import {
  batch,
  BATCH,
  conflict,
  csvFile,
  EARLIER_BATCH,
  EARLIER_ITEM,
  ITEM,
  mixedBatch,
  resolved,
  reviewItem,
  TX_CREATED,
} from '../../imports/fixtures.test-support';
import { useLocationPath, useLocationSearch } from '../../navigation';
import { createQueryClient } from '../../query';
import { parseRoute } from '../../routing';
import { account, page, REALM_A, REALM_B, TX, TX_REPLACEMENT } from '../../transactions/fixtures.test-support';
import { transactionKeys } from '../transactions/TransactionsArea';
import { ImportArea } from './ImportArea';
import { ReviewItems } from './ReviewItems';

/**
 * Step 5 in the Import area (jsdom, real client, routed by the URL as the app does): import, the result read again, the
 * review items side by side, the decision under the owning batch, the re-read after it, a lost answer, and the Realm of
 * the page as the only one asked and shown (ui-guide.md §6.5, §7.3, §7.4).
 */

const IBAN = 'DE00 0000 0000 0000 0000 01';
const LIST = transactionKeys.list(REALM_A, 1, { page: '1', pageSize: '50' });
const NBSP = '\u00a0';
const BATCH_GET = (id: string) => `GET /api/v1/imports/${id}`;
const ITEMS_GET = (id: string) => `GET /api/v1/imports/${id}/review-items`;
const RESOLVE = (id: string, item: string) => `POST /api/v1/imports/${id}/review-items/${item}/resolve`;
const POST = 'POST /api/v1/imports/bank-transactions';
const routeOf = (call: Call) => `${call.method} ${new URL(call.url, 'https://cockpit.internal').pathname}`;
const count = (calls: Call[], route: string) => calls.filter((call) => routeOf(call) === route).length;
const items = (id: string, list: readonly ReturnType<typeof reviewItem>[]) => () => json(200, { importBatchId: id, items: list });

function Routed({ client }: { readonly client: ReturnType<typeof createDeClient> }) {
  const route = parseRoute(useLocationPath());
  const search = useLocationSearch();
  return <ImportArea client={client} realmId={REALM_A} epoch={1} importBatchId={route.kind === 'area' ? route.importBatchId : undefined} search={search} />;
}

function area(routes: Record<string, (() => Response)[]>, path = `/cockpit/r/${REALM_A}/import`) {
  window.history.pushState(null, '', path);
  const { fetch, calls } = routedFetch({ 'GET /api/v1/financial-accounts': [() => json(200, page([account({ iban: IBAN })]))], ...routes });
  const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  const queryClient = createQueryClient();
  // A Transaction list of the Realm read before: what an import or a decision must invalidate (§7.3).
  queryClient.setQueryData(LIST, page([]));
  render(
    <QueryClientProvider client={queryClient}>
      <Routed client={client} />
    </QueryClientProvider>,
  );
  return { calls, listInvalidated: () => queryClient.getQueryState(LIST)?.isInvalidated === true };
}

/** `act` typed as it is used here (the library's overloads are not resolved by the type-checked lint). */
const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const card = () => screen.getByRole('article', { name: /Klärfall Zeile/ });
const TRIGGER = { CREATE: 'Als eigenständige Buchung übernehmen', SKIP: 'Nicht als neue Buchung übernehmen' } as const;
const NOW = { CREATE: 'Jetzt übernehmen', SKIP: 'Jetzt nicht übernehmen' } as const;
/** A decision as the user makes it: the button opens the confirmation step, its confirm button sends (2026-11-11). */
const decide = async (resolution: 'CREATE' | 'SKIP') => {
  fireEvent.click(await screen.findByRole('button', { name: TRIGGER[resolution] }));
  fireEvent.click(screen.getByRole('button', { name: NOW[resolution] }));
};

beforeEach(() => window.history.pushState(null, '', '/'));
afterEach(cleanup);

describe('import, result and the re-read (ui-guide.md §6.5)', () => {
  it('the answer is shown at its own URL and read again with GET; counters, continuity and rows as the server sent them', async () => {
    // Distinct counters, shown as the server sent them, not counted from the rows.
    const answer = mixedBatch({ transactionCount: 11, duplicateCount: 12, needsReviewCount: 13, errorCount: 14, skippedCount: 15 });
    const { calls, listInvalidated } = area({
      [POST]: [() => json(201, answer)],
      [BATCH_GET(BATCH)]: [() => json(200, answer)],
      [ITEMS_GET(BATCH)]: [items(BATCH, [reviewItem()])],
    });
    fireEvent.change(await screen.findByLabelText('CSV-Datei'), { target: { files: [csvFile()] } });
    fireEvent.click(screen.getByRole('button', { name: 'Import ausführen' }));
    await screen.findByRole('heading', { name: 'Ergebnis des Imports' });
    expect(window.location.pathname).toBe(`/cockpit/r/${REALM_A}/import/${BATCH}`);
    expect(listInvalidated()).toBe(true);
    await waitFor(() => expect(count(calls, BATCH_GET(BATCH))).toBe(1));
    await screen.findByRole('article', { name: 'Klärfall Zeile 3' });
    expect(
      within(screen.getByRole('list', { name: 'Ablauf des Imports' }))
        .getByText('3 Ergebnis & Klärfälle')
        .getAttribute('aria-current'),
    ).toBe('step');
    expect(screen.getByText(BATCH)).toBeTruthy();
    expect(screen.getByText('Klärfälle offen')).toBeTruthy();
    const counters = document.querySelector('dl[aria-label="Zähler"]') as HTMLElement;
    expect(
      [...counters.querySelectorAll('dd')].map((dd) => dd.textContent),
      'transactionCount, duplicateCount, needsReviewCount, errorCount, skippedCount',
    ).toEqual(['11', '12', '13', '14', '15']);
    // Continuity, balances exactly as the strings of the API (18 digits, negative), never through a float.
    expect(screen.getByText(/Lücke: frühere Salden sind bekannt/)).toBeTruthy();
    expect(screen.getByText('Reihenfolge der Datei: älteste Buchung zuerst.')).toBeTruthy();
    const breaks = screen.getByRole('list', { name: 'Saldosprünge' });
    expect(breaks.textContent).toBe(`Zeile 5: erwartet 1.234.567.890.123.456,78${NBSP}€, in der Datei -12,50${NBSP}€`);
    // By default only the rows with a hint; the counters stay as they are.
    expect(
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.querySelectorAll('td')[0]?.textContent),
    ).toEqual(['3', '4', '5', '6']);
    fireEvent.click(screen.getByRole('button', { name: 'Alle Zeilen' }));
    expect([...counters.querySelectorAll('dd')].map((dd) => dd.textContent)).toEqual(['11', '12', '13', '14', '15']);
    // Rows in file order with their outcome.
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => row.querySelectorAll('td')[1]?.textContent)).toEqual([
      'Neu angelegt',
      'Duplikat',
      'Klärfall',
      'Klärfall',
      'Fehler',
      'Übersprungen',
    ]);
    expect(
      within(rows[0] as HTMLElement)
        .getByRole('link', { name: 'Buchung öffnen' })
        .getAttribute('href'),
    ).toBe(`/cockpit/r/${REALM_A}/buchungen/${TX}`);
    expect(
      within(rows[1] as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe(`/cockpit/r/${REALM_A}/buchungen/${TX_REPLACEMENT}`);
    expect(rows[2]?.textContent).toMatch(/unten entscheiden/);
    expect(within(rows[2] as HTMLElement).queryByRole('link')).toBeNull();
    expect(
      within(rows[3] as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe(`/cockpit/r/${REALM_A}/import/${EARLIER_BATCH}`);
    expect(rows[4]?.textContent).toMatch(/amount: zu viele Nachkommastellen/);
    expect(rows[5]?.textContent).toMatch(/Betrag 0: kein Geldfluss/);
    expect(calls.map((call) => call.headers.get('organizationid'))).toEqual(calls.map(() => REALM_A));
  });

  it('a known batch is read at its URL (after a reload or a lost answer); a file without balances says so', async () => {
    const { calls } = area({ [BATCH_GET(BATCH)]: [() => json(200, batch())], [ITEMS_GET(BATCH)]: [items(BATCH, [])] }, `/cockpit/r/${REALM_A}/import/${BATCH}`);
    await screen.findByText('Dieser Import hat keine eigenen Klärfälle.');
    expect(screen.getByText(/keine Saldo-Spalte mit Werten/)).toBeTruthy();
    expect(count(calls, POST)).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Ergebnis neu laden' }));
    await waitFor(() => expect(count(calls, BATCH_GET(BATCH))).toBe(2));
  });

  it('unknown status, outcome, reason and order are shown with their codes; an item of unknown status offers no decision', async () => {
    const strange = batch({
      status: 'ARCHIVED' as 'COMPLETED',
      rows: [{ outcome: 'merged', position: 1 } as never],
      continuity: { order: 'SIDEWAYS' as 'OLDEST_FIRST', breaks: [], previousExport: 'SOMETIMES' as 'GAP' },
    });
    area(
      {
        [BATCH_GET(BATCH)]: [() => json(200, strange)],
        [ITEMS_GET(BATCH)]: [items(BATCH, [reviewItem({ status: 'PARKED' as 'PENDING', ambiguityReason: 'NEW_REASON' as 'ADAPTER_VERSION_CONFLICT' })])],
      },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    await screen.findByRole('article', { name: /Klärfall/ });
    expect(screen.getByText('Unbekannter Status (ARCHIVED)')).toBeTruthy();
    expect(screen.getByText('Unbekanntes Ergebnis (merged)')).toBeTruthy();
    expect(screen.getByText('Reihenfolge der Datei: unbekannte Reihenfolge (SIDEWAYS).')).toBeTruthy();
    expect(screen.getByText('Unbekanntes Ergebnis (SOMETIMES)')).toBeTruthy();
    expect(screen.getByText('Unbekannter Grund (NEW_REASON)')).toBeTruthy();
    expect(screen.getByText(/Unbekannter Status \(PARKED\); keine Entscheidung möglich/)).toBeTruthy();
    expect(within(card()).queryAllByRole('button')).toEqual([]);
  });
});

describe('a review item (ui-guide.md §6.5: side by side, CREATE or SKIP, no merge)', () => {
  const routes = (after = resolved('CREATE')) => ({
    [BATCH_GET(BATCH)]: [() => json(200, batch({ status: 'NEEDS_REVIEW', needsReviewCount: 1 })), () => json(200, batch())],
    [ITEMS_GET(BATCH)]: [items(BATCH, [reviewItem()]), items(BATCH, [{ ...after, conflictingTransactions: [conflict()] }])],
  });

  it('the new row and the competing Transaction side by side, amounts exactly; exactly the two decisions', async () => {
    area(routes(), `/cockpit/r/${REALM_A}/import/${BATCH}`);
    await screen.findByRole('article', { name: 'Klärfall Zeile 3' });
    const row = within(card()).getByRole('region', { name: 'Neue Zeile aus der Datei' });
    const existing = within(card()).getByRole('region', { name: 'Vorhandene Buchungen' });
    expect(row.textContent).toContain(`Betrag1.234.567.890.123.456,78${NBSP}€ (Eingang)`);
    expect(row.textContent).toContain(`Saldo danach-12,50${NBSP}€`);
    expect(within(row).getByText('Miete Oktober Testwohnung (neue Datei)')).toBeTruthy();
    expect(existing.textContent).toContain(`Betrag850,00${NBSP}€ (Eingang)`);
    expect(within(existing).getByText('Miete Oktober Testwohnung')).toBeTruthy();
    expect(within(existing).getByRole('link', { name: 'Buchung öffnen' }).getAttribute('href')).toBe(`/cockpit/r/${REALM_A}/buchungen/${TX}`);
    expect(within(card()).getByText('Gleicher Inhalt wie eine Buchung aus einer anderen Datei')).toBeTruthy();
    expect(
      within(card())
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Als eigenständige Buchung übernehmen', 'Nicht als neue Buchung übernehmen']);
    expect(screen.queryByRole('button', { name: /Zusammenf/ })).toBeNull();
  });

  it('CREATE sends { resolution } under the batch, then the result and the list are read again', async () => {
    const { calls, listInvalidated } = area(
      { ...routes(), [RESOLVE(BATCH, ITEM)]: [() => json(200, resolved('CREATE'))] },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    await screen.findByRole('article', { name: 'Klärfall Zeile 3' });
    expect(listInvalidated()).toBe(false);
    await decide('CREATE');
    await screen.findByText(/Entschieden: Als eigenständige Buchung übernommen von vermieter@example.invalid/);
    const call = calls.find((c) => routeOf(c) === RESOLVE(BATCH, ITEM));
    expect(call?.body).toBe('{"resolution":"CREATE"}');
    await waitFor(() => expect(count(calls, BATCH_GET(BATCH))).toBe(2));
    await waitFor(() => expect(count(calls, ITEMS_GET(BATCH))).toBe(2));
    await waitFor(() => expect(screen.getByText('Abgeschlossen')).toBeTruthy());
    expect(listInvalidated()).toBe(true);
    expect(within(card()).getByRole('link', { name: 'Angelegte Buchung öffnen' }).getAttribute('href')).toBe(`/cockpit/r/${REALM_A}/buchungen/${TX_CREATED}`);
    expect(within(card()).queryByRole('button', { name: 'Nicht als neue Buchung übernehmen' })).toBeNull();
  });

  it('an item owned by an earlier batch is decided under that batch: the row links it, SKIP goes there', async () => {
    const earlier = reviewItem({ reviewItemId: EARLIER_ITEM, importBatchId: EARLIER_BATCH });
    const { calls } = area(
      {
        [BATCH_GET(BATCH)]: [() => json(200, mixedBatch())],
        [ITEMS_GET(BATCH)]: [items(BATCH, [reviewItem()])],
        [BATCH_GET(EARLIER_BATCH)]: [() => json(200, batch({ importBatchId: EARLIER_BATCH })), () => json(200, batch({ importBatchId: EARLIER_BATCH }))],
        [ITEMS_GET(EARLIER_BATCH)]: [
          items(EARLIER_BATCH, [earlier]),
          items(EARLIER_BATCH, [resolved('SKIP', { reviewItemId: EARLIER_ITEM, importBatchId: EARLIER_BATCH })]),
        ],
        [RESOLVE(EARLIER_BATCH, EARLIER_ITEM)]: [() => json(200, resolved('SKIP', { reviewItemId: EARLIER_ITEM, importBatchId: EARLIER_BATCH }))],
      },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    fireEvent.click(await screen.findByRole('link', { name: /Klärfall im früheren Import 7d6f0c9b öffnen/ }));
    expect(window.location.pathname).toBe(`/cockpit/r/${REALM_A}/import/${EARLIER_BATCH}`);
    await screen.findByText(EARLIER_BATCH);
    await decide('SKIP');
    await screen.findByText(/Entschieden: Nicht als neue Buchung übernommen/);
    expect(calls.filter((c) => c.method === 'POST').map(routeOf)).toEqual([RESOLVE(EARLIER_BATCH, EARLIER_ITEM)]);
    expect(calls.find((c) => c.method === 'POST')?.body).toBe('{"resolution":"SKIP"}');
    expect(calls.some((c) => routeOf(c) === RESOLVE(BATCH, EARLIER_ITEM))).toBe(false);
    await waitFor(() => expect(count(calls, ITEMS_GET(EARLIER_BATCH))).toBe(2));
  });

  it('while the result is read again, no decision can be sent', async () => {
    const pending = () => new Promise<Response>(() => undefined) as unknown as Response;
    area(
      { [BATCH_GET(BATCH)]: [() => json(200, batch()), pending], [ITEMS_GET(BATCH)]: [items(BATCH, [reviewItem()]), pending] },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    const create = await screen.findByRole<HTMLButtonElement>('button', { name: 'Als eigenständige Buchung übernehmen' });
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Ergebnis neu laden' }));
    await waitFor(() => expect(create.disabled).toBe(true));
    expect(create.isConnected).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Nicht als neue Buchung übernehmen' }).disabled).toBe(true);
  });

  it('a late answer after the list is gone changes nothing and reads nothing again', async () => {
    let answer: (item: ReturnType<typeof reviewItem>) => void = () => undefined;
    let resolvedCount = 0;
    const view = render(
      <ReviewItems
        realmId={REALM_A}
        batch={batch()}
        items={{ status: 'success', data: [reviewItem()] }}
        stale={false}
        resolve={() => new Promise((resolve) => (answer = resolve))}
        onResolved={() => (resolvedCount += 1)}
        onReread={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Als eigenständige Buchung übernehmen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Jetzt übernehmen' }));
    view.unmount();
    await act(() => answer(resolved('CREATE')));
    await settle();
    expect(resolvedCount).toBe(0);
  });

  it('a double click decides once', async () => {
    const { calls } = area(
      { ...routes(), [RESOLVE(BATCH, ITEM)]: [() => json(200, resolved('CREATE')), () => json(200, resolved('CREATE'))] },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    const create = await screen.findByRole('button', { name: 'Als eigenständige Buchung übernehmen' });
    await act(() => {
      fireEvent.click(create);
      fireEvent.click(create);
    });
    // The step replaces both decisions: SKIP cannot be pressed while CREATE is asked.
    expect(screen.queryByRole('button', { name: 'Nicht als neue Buchung übernehmen' })).toBeNull();
    const now = screen.getByRole('button', { name: 'Jetzt übernehmen' });
    await act(() => {
      fireEvent.click(now);
      fireEvent.click(now);
    });
    await settle();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('no answer: unclear, the known batch is read again on request, the same decision can be sent again', async () => {
    const { calls } = area(
      {
        ...routes(),
        [RESOLVE(BATCH, ITEM)]: [() => envelope(504, 'GATEWAY_TIMEOUT'), () => json(200, resolved('CREATE'))],
      },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    await decide('CREATE');
    await screen.findByText(/Ob die Entscheidung gespeichert wurde, ist unklar/);
    expect(screen.queryByText(/Entschieden:/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Erneut senden' }));
    await screen.findByText(/Entschieden: Als eigenständige Buchung übernommen/);
    const posts = calls.filter((c) => routeOf(c) === RESOLVE(BATCH, ITEM));
    expect(posts.map((c) => c.body)).toEqual(['{"resolution":"CREATE"}', '{"resolution":"CREATE"}']);
  });

  it('no answer, then "Stand neu laden" reads the batch and its items again and shows the stored decision', async () => {
    const { calls } = area(
      { ...routes(resolved('SKIP')), [RESOLVE(BATCH, ITEM)]: [() => envelope(503, 'SERVICE_UNAVAILABLE')] },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    await decide('SKIP');
    fireEvent.click(await screen.findByRole('button', { name: 'Stand neu laden' }));
    await waitFor(() => expect(count(calls, ITEMS_GET(BATCH))).toBe(2));
    expect(count(calls, BATCH_GET(BATCH))).toBe(2);
    await screen.findByText(/Entschieden: Nicht als neue Buchung übernommen/);
  });

  it('409 ALREADY_RESOLVED and ACCOUNT_CLOSED are explained; an unknown reason keeps its code; no resend', async () => {
    area(
      {
        ...routes(),
        [RESOLVE(BATCH, ITEM)]: [
          () => envelope(409, 'CONFLICT', { reason: 'ALREADY_RESOLVED', resolution: 'SKIP' }),
          () => envelope(409, 'CONFLICT', { reason: 'ACCOUNT_CLOSED' }),
          () => envelope(409, 'CONFLICT', { reason: 'NEW_REASON' }),
        ],
      },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    await decide('CREATE');
    await screen.findByText(/bereits anders entschieden \(„Nicht als neue Buchung übernommen“\)/);
    expect(screen.queryByRole('button', { name: 'Erneut senden' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stand neu laden' })).toBeTruthy();
    await decide('CREATE');
    await screen.findByText(/nach dem Schließtag des Kontos/);
    await decide('CREATE');
    await screen.findByText('Grund NEW_REASON.');
  });
});

describe('Realm isolation (ui-guide.md §7.3)', () => {
  it('a batch of another Realm is not shown, nor its items', async () => {
    const { calls } = area(
      { [BATCH_GET(BATCH)]: [() => json(200, mixedBatch({ mreRealmId: REALM_B, sourceFilename: 'fremd.csv' }))] },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    await screen.findByText('Antwort eines anderen Bestands');
    expect(screen.queryByText('fremd.csv')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Ergebnis des Imports' })).toBeNull();
    expect(count(calls, ITEMS_GET(BATCH))).toBe(0);
  });

  it('review items of another account than the batch are refused: no row, no decision', async () => {
    area(
      {
        [BATCH_GET(BATCH)]: [() => json(200, batch())],
        [ITEMS_GET(BATCH)]: [items(BATCH, [reviewItem({ financialAccountId: 'b1ad4a3f-5c6e-4f78-8a9b-3b4c5d6e7f80', description: 'x' } as never)])],
      },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    await screen.findByText('Antwort eines anderen Bestands');
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Als eigenständige Buchung übernehmen' })).toBeNull();
  });

  it('a resolve answer of another account is refused and never shown as decided; every request names Realm A', async () => {
    const { calls } = area(
      {
        [BATCH_GET(BATCH)]: [() => json(200, batch())],
        [ITEMS_GET(BATCH)]: [items(BATCH, [reviewItem()])],
        [RESOLVE(BATCH, ITEM)]: [() => json(200, resolved('CREATE', { financialAccountId: 'b1ad4a3f-5c6e-4f78-8a9b-3b4c5d6e7f80' }))],
      },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    await decide('CREATE');
    await screen.findByText('Antwort eines anderen Bestands');
    expect(screen.queryByText(/Entschieden:/)).toBeNull();
    expect(calls.map((call) => call.headers.get('organizationid'))).toEqual(calls.map(() => REALM_A));
  });
});

describe('the confirmation step before CREATE and SKIP (Entscheidung des Projektinhabers, 2026-11-11)', () => {
  const routes = (after: 'CREATE' | 'SKIP') => ({
    [BATCH_GET(BATCH)]: [() => json(200, batch({ status: 'NEEDS_REVIEW', needsReviewCount: 1 })), () => json(200, batch())],
    [ITEMS_GET(BATCH)]: [items(BATCH, [reviewItem()]), items(BATCH, [{ ...resolved(after), conflictingTransactions: [conflict()] }])],
    [RESOLVE(BATCH, ITEM)]: [() => json(200, resolved(after))],
  });
  const QUESTION = { CREATE: 'Als eigenständige Buchung übernehmen?', SKIP: 'Nicht als neue Buchung übernehmen?' } as const;
  const SAYS = { CREATE: 'wird eine eigene Buchung angelegt', SKIP: 'wird keine Buchung angelegt' } as const;

  for (const resolution of ['CREATE', 'SKIP'] as const) {
    it(`${resolution}: the button opens a dialog that says what happens, with the focus on its question; nothing is sent`, async () => {
      const { calls } = area(routes(resolution), `/cockpit/r/${REALM_A}/import/${BATCH}`);
      fireEvent.click(await screen.findByRole('button', { name: TRIGGER[resolution] }));
      const dialog = within(card()).getByRole('dialog', { name: QUESTION[resolution] });
      expect(document.activeElement).toBe(within(dialog).getByRole('heading', { name: QUESTION[resolution] }));
      expect(dialog.textContent).toContain(SAYS[resolution]);
      expect(dialog.textContent).toContain('Die Entscheidung ist endgültig');
      expect(
        within(card())
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual([NOW[resolution], 'Abbrechen']);
      await settle();
      expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    });

    it(`${resolution}: Abbrechen and Escape send nothing and give the focus back to the button`, async () => {
      const { calls, listInvalidated } = area(routes(resolution), `/cockpit/r/${REALM_A}/import/${BATCH}`);
      fireEvent.click(await screen.findByRole('button', { name: TRIGGER[resolution] }));
      fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: TRIGGER[resolution] }));
      fireEvent.click(screen.getByRole('button', { name: TRIGGER[resolution] }));
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole('button', { name: TRIGGER[resolution] }));
      await settle();
      expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
      expect(count(calls, BATCH_GET(BATCH))).toBe(1);
      expect(listInvalidated()).toBe(false);
    });

    it(`${resolution}: only the confirm button sends, one POST with the body and headers as before; the answer takes the focus`, async () => {
      const { calls } = area(routes(resolution), `/cockpit/r/${REALM_A}/import/${BATCH}`);
      await decide(resolution);
      await screen.findByText(/Entschieden: /);
      const posts = calls.filter((c) => c.method === 'POST');
      expect(posts.map(routeOf)).toEqual([RESOLVE(BATCH, ITEM)]);
      expect(posts[0]?.body).toBe(`{"resolution":"${resolution}"}`);
      expect(posts[0]?.headers.get('content-type')).toBe('application/json');
      expect(posts[0]?.headers.has('if-match')).toBe(false);
      expect(posts[0]?.headers.has('idempotency-key')).toBe(false);
      expect(posts[0]?.headers.get('organizationid')).toBe(REALM_A);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement?.textContent).toMatch(/^Entschieden: /);
    });
  }

  it('while the result is read again, the open step cannot send; Abbrechen still works', async () => {
    const pending = () => new Promise<Response>(() => undefined) as unknown as Response;
    const { calls } = area(
      { [BATCH_GET(BATCH)]: [() => json(200, batch()), pending], [ITEMS_GET(BATCH)]: [items(BATCH, [reviewItem()]), pending] },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    const create = await screen.findByRole<HTMLButtonElement>('button', { name: TRIGGER.CREATE });
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    fireEvent.click(screen.getByRole('button', { name: 'Ergebnis neu laden' }));
    const now = screen.getByRole<HTMLButtonElement>('button', { name: NOW.CREATE });
    await waitFor(() => expect(now.disabled).toBe(true));
    fireEvent.click(now);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Abbrechen' }).disabled).toBe(false);
    await settle();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('a lost answer: Erneut senden sends the same decision again without a second dialog', async () => {
    const { calls } = area(
      { ...routes('CREATE'), [RESOLVE(BATCH, ITEM)]: [() => envelope(504, 'GATEWAY_TIMEOUT'), () => json(200, resolved('CREATE'))] },
      `/cockpit/r/${REALM_A}/import/${BATCH}`,
    );
    await decide('CREATE');
    await screen.findByText(/Ob die Entscheidung gespeichert wurde, ist unklar/);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Erneut senden' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await screen.findByText(/Entschieden: Als eigenständige Buchung übernommen/);
    expect(calls.filter((c) => routeOf(c) === RESOLVE(BATCH, ITEM)).map((c) => c.body)).toEqual(['{"resolution":"CREATE"}', '{"resolution":"CREATE"}']);
  });
});
