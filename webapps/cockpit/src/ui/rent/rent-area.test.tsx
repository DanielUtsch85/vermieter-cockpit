// @vitest-environment jsdom
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act as testingLibraryAct, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, routedFetch, type Call } from '../../api/fetch.test-support';
import { useLocationPath, useLocationSearch } from '../../navigation';
import { createQueryClient } from '../../query';
import { confirmed, read, reconciliation, REC, released, suggestResult, TENANT, TERM, termCoverage, written } from '../../rent/fixtures.test-support';
import { parseRoute } from '../../routing';
import { detail, page, REALM_A, REALM_B, TX } from '../../transactions/fixtures.test-support';
import { rentKeys } from './rent-keys';
import { RentArea } from './RentArea';

/**
 * Step 6 in the Mietabgleich area (jsdom, real client, routed by the URL as the app does): suggest, the list, one
 * reconciliation with its separate actions, the coverage of a term, and the rule that no MRE write is ever sent by
 * rendering, a refetch, a tab change or a remount (ui-guide.md §6.6, §7.3, §11).
 */

const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const BASE = `/cockpit/r/${REALM_A}/mietabgleich`;
const LIST = 'GET /api/v1/rent-reconciliations';
const DETAIL = `GET /api/v1/rent-reconciliations/${REC}`;
const TX_GET = `GET /api/v1/transactions/${TX}`;
const SUGGEST = 'POST /api/v1/rent-reconciliations/suggest';
const COMMAND = (name: string) => `POST /api/v1/rent-reconciliations/${REC}/${name}`;
const TERM_GET = `GET /api/v1/rent-reconciliations/terms/${TENANT}/${TERM}`;
const routeOf = (call: Call) => `${call.method} ${new URL(call.url, 'https://cockpit.internal').pathname}`;
const count = (calls: Call[], route: string) => calls.filter((call) => routeOf(call) === route).length;
const posts = (calls: Call[]) => calls.filter((call) => call.method === 'POST').map(routeOf);
const repeat = <T,>(n: number, answer: () => T) => Array.from({ length: n }, () => answer);

function Routed({ client }: { readonly client: ReturnType<typeof createDeClient> }) {
  const route = parseRoute(useLocationPath());
  const search = useLocationSearch();
  if (route.kind !== 'area') return null;
  return <RentArea client={client} realmId={REALM_A} epoch={1} reconciliationId={route.reconciliationId} rentTerm={route.rentTerm} search={search} />;
}

function area(routes: Record<string, (() => Response)[]>, path = BASE, queryClient: QueryClient = createQueryClient()) {
  window.history.pushState(null, '', path);
  const { fetch, calls } = routedFetch(routes);
  const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  const view = () => (
    <QueryClientProvider client={queryClient}>
      <Routed client={client} />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return { calls, queryClient, rerender: () => rendered.rerender(view()), unmount: rendered.unmount, remount: () => render(view()) };
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const link = (name: string) => fireEvent.click(screen.getAllByRole('link', { name })[0] as HTMLElement, { button: 0 });

beforeEach(() => window.history.pushState(null, '', '/'));
afterEach(cleanup);

describe('suggest and the list (ui-guide.md §6.6 steps 5 and 6)', () => {
  it('Vorschlaege ermitteln: one POST with { from, to } on the click, then the list is read again; nothing else is sent', async () => {
    const { calls } = area({
      [LIST]: [() => json(200, page([])), () => json(200, page([reconciliation()]))],
      [SUGGEST]: [() => json(200, suggestResult([reconciliation()]))],
    });
    expect(await screen.findByText(/Keine offenen Vorschläge\. Das heißt nicht, dass alle Mieten bezahlt sind/)).toBeTruthy();
    expect(calls[0]?.url).toBe('/api/v1/rent-reconciliations?status=SUGGESTED&page=1&pageSize=50');
    fireEvent.change(screen.getByLabelText('Erster Monat'), { target: { value: '2026-03' } });
    fireEvent.change(screen.getByLabelText('Letzter Monat'), { target: { value: '2026-04' } });
    click('Vorschläge ermitteln');
    await screen.findByText('1 neuer Vorschlag für 2026-03 bis 2026-04.');
    const post = calls.find((call) => routeOf(call) === SUGGEST);
    expect(post?.body).toBe('{"from":"2026-03","to":"2026-04"}');
    expect(post?.headers.has('idempotency-key')).toBe(false);
    await waitFor(() => expect(count(calls, LIST)).toBe(2));
    expect(within(screen.getByRole('list', { name: 'Neue Vorschläge' })).getByText(/850,00/)).toBeTruthy();
    expect(posts(calls)).toEqual([SUGGEST]);
    expect(calls.every((call) => call.headers.get('organizationid') === REALM_A)).toBe(true);
  });

  it('an empty run explains skipped.unconfirmed and skipped.noRentCash and links to Buchungen; it never says all rent is paid', async () => {
    area({ [LIST]: repeat(2, () => json(200, page([]))), [SUGGEST]: [() => json(200, suggestResult([], { unconfirmed: 3, noRentCash: 1 }))] });
    fireEvent.change(await screen.findByLabelText('Erster Monat'), { target: { value: '2026-03' } });
    fireEvent.change(screen.getByLabelText('Letzter Monat'), { target: { value: '2026-04' } });
    click('Vorschläge ermitteln');
    expect(await screen.findByText('Keine neuen Vorschläge für 2026-03 bis 2026-04.')).toBeTruthy();
    expect(screen.getByText(/„Keine Vorschläge“ heißt nicht „alle Mieten bezahlt“/)).toBeTruthy();
    expect(screen.getByText(/3 Zahlungseingänge im Zeitraum sind noch nicht bestätigt/)).toBeTruthy();
    expect(screen.getByText(/1 bestätigter Zahlungseingang hat keinen Anteil in einer Mietkategorie/)).toBeTruthy();
    const range = 'bookingDateFrom=2026-02-15&bookingDateTo=2026-04-30';
    expect(screen.getByRole('link', { name: 'Unbestätigte Buchungen des Zeitraums' }).getAttribute('href')).toBe(
      `/cockpit/r/${REALM_A}/buchungen?status=IMPORTED%2CUNREVIEWED%2CCLASSIFIED&${range}`,
    );
    expect(screen.getByRole('link', { name: 'Bestätigte Buchungen des Zeitraums' }).getAttribute('href')).toBe(
      `/cockpit/r/${REALM_A}/buchungen?status=CONFIRMED%2CRECONCILED&${range}`,
    );
  });

  it('more than twelve months, an inverted or a missing month: said at the input, nothing sent; the server field error is bound too', async () => {
    const { calls } = area({
      [LIST]: [() => json(200, page([]))],
      [SUGGEST]: [
        () =>
          envelope(400, 'VALIDATION_ERROR', {
            fields: [
              { field: 'to', code: 'RANGE_TOO_LONG' },
              { field: 'zzz', code: 'INVALID_FORMAT' },
            ],
          }),
      ],
    });
    fireEvent.change(await screen.findByLabelText('Erster Monat'), { target: { value: '2026-01' } });
    fireEvent.change(screen.getByLabelText('Letzter Monat'), { target: { value: '2027-01' } });
    click('Vorschläge ermitteln');
    expect(screen.getByText('Höchstens 12 Monate auf einmal.')).toBeTruthy();
    expect(screen.getByLabelText('Letzter Monat').getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(screen.getByLabelText('Letzter Monat'), { target: { value: '2025-12' } });
    expect(screen.getByText('Der letzte Monat liegt vor dem ersten.')).toBeTruthy();
    await settle();
    expect(count(calls, SUGGEST)).toBe(0);
    fireEvent.change(screen.getByLabelText('Letzter Monat'), { target: { value: '2026-12' } });
    click('Vorschläge ermitteln');
    await screen.findByRole('alert');
    expect(screen.getByText('Höchstens 12 Monate auf einmal.')).toBeTruthy();
    expect(within(screen.getByRole('alert')).getAllByText('zzz')).toHaveLength(1);
  });

  it('the list shows status and write-back state as two badges, an unknown one with its code; filters and pages are in the URL', async () => {
    const odd = reconciliation({
      status: 'NEW_STATUS' as never,
      mreWriteBackState: 'NEW_STATE' as never,
      reconciliationId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    });
    const { calls } = area(
      {
        [LIST]: [() => json(200, page([written(), odd], { total: 120, page: 2 }))],
      },
      `${BASE}?status=alle&page=2`,
    );
    expect(await screen.findByText('Zuordnung bestätigt')).toBeTruthy();
    expect(screen.getByText('MRE: übertragen')).toBeTruthy();
    expect(screen.getByText('Unbekannter Status (NEW_STATUS)')).toBeTruthy();
    expect(screen.getByText('MRE: unbekannter Stand (NEW_STATE)')).toBeTruthy();
    expect(calls[0]?.url).toBe('/api/v1/rent-reconciliations?page=2&pageSize=50');
    expect(screen.getByText('Seite 2 von 3 · 120 Einträge')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Nächste Seite' }).getAttribute('href')).toBe(`${BASE}?status=alle&page=3`);
    expect(screen.getByRole('link', { name: 'Bestätigt' }).getAttribute('href')).toBe(`${BASE}?status=CONFIRMED`);
  });

  it('a list item of another Realm is never shown', async () => {
    area({ [LIST]: [() => json(200, page([reconciliation({ mreRealmId: REALM_B })]))] });
    expect(await screen.findByText('Antwort eines anderen Bestands')).toBeTruthy();
    expect(screen.queryByText(/850,00/)).toBeNull();
  });
});

describe('no MRE write by rendering, refetch, tab change or remount (ui-guide.md §11)', () => {
  it('a confirmed, not written match: mount, render again, refetch, change tabs, remount: zero commands; only the click sends', async () => {
    const detailAnswer = () => json(200, read({ ...confirmed() }), { etag: '"2"' });
    const routes = {
      [DETAIL]: repeat(10, detailAnswer),
      [TX_GET]: repeat(10, () => json(200, detail({ status: 'CONFIRMED' }), { etag: '"3"' })),
      [LIST]: repeat(10, () => json(200, page([confirmed()]))),
      [COMMAND('write-back-to-mre')]: [() => json(200, written(), { etag: '"4"' })],
    };
    const { calls, queryClient, rerender, unmount, remount } = area(routes, `${BASE}/${REC}`);
    expect(await screen.findByRole('button', { name: 'An MRE übertragen' })).toBeTruthy();
    rerender();
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: rentKeys.all(REALM_A, 1) });
    });
    await act(async () => {
      await queryClient.refetchQueries();
    });
    // Tab change: to the list, through its status tabs, and back to the detail.
    link('Mietabgleich');
    await screen.findByText('Vorschläge und Zuordnungen');
    link('Bestätigt');
    await screen.findAllByText('Zuordnung bestätigt');
    link('Zuordnung öffnen');
    await screen.findByRole('button', { name: 'An MRE übertragen' });
    // An open confirmation step is gone with the remount; it never sends by itself.
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'An MRE übertragen' }).disabled).toBe(false));
    click('An MRE übertragen');
    expect(screen.getByRole('dialog', { name: 'Zahlung jetzt an MRE übertragen?' })).toBeTruthy();
    unmount();
    remount();
    await screen.findByRole('button', { name: 'An MRE übertragen' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await settle();
    expect(count(calls, DETAIL)).toBeGreaterThanOrEqual(3);
    expect(posts(calls)).toEqual([]);
    click('An MRE übertragen');
    click('Jetzt an MRE übertragen');
    await settle();
    expect(posts(calls)).toEqual([COMMAND('write-back-to-mre')]);
  });
});

describe('the three separate confirmations in one flow (ui-guide.md §6.6, §4.4)', () => {
  it('while the detail is read again, no action can be clicked; with the new read they can', async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const { queryClient } = area(
      {
        [DETAIL]: [() => json(200, read({ ...confirmed() }), { etag: '"2"' }), () => pending as unknown as Response],
        [TX_GET]: [() => json(200, detail({ status: 'CONFIRMED' }))],
      },
      `${BASE}/${REC}`,
    );
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'An MRE übertragen' })).disabled).toBe(false);
    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: rentKeys.all(REALM_A, 1) });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'An MRE übertragen' }).disabled).toBe(true);
    answer(json(200, read({ ...confirmed() }), { etag: '"2"' }));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'An MRE übertragen' }).disabled).toBe(false));
  });

  it('confirm, then write back, then release, then remove: each its own click, each followed by a re-read; badges as the server says', async () => {
    const detailAnswers = [
      read(),
      read({ ...confirmed() }),
      read({ ...written() }),
      read({ ...released('REMOVAL_REQUIRED') }),
      read({ ...released('REMOVED') }),
    ];
    const { calls } = area(
      {
        [DETAIL]: detailAnswers.map((r) => () => json(200, r, { etag: `"${r.version}"` })),
        [TX_GET]: [() => json(200, detail({ status: 'CONFIRMED' }), { etag: '"3"' })],
        [COMMAND('confirm')]: [() => json(200, confirmed())],
        [COMMAND('write-back-to-mre')]: [() => json(200, written())],
        [COMMAND('release')]: [() => json(200, released('REMOVAL_REQUIRED'))],
        [COMMAND('remove-from-mre')]: [() => json(200, released('REMOVED'))],
      },
      `${BASE}/${REC}`,
    );
    expect(await screen.findByText('Vorschlag · zu prüfen')).toBeTruthy();
    expect(screen.getByText('MRE: nicht übertragen')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'An MRE übertragen' })).toBeNull();
    click('Zuordnung bestätigen');
    expect(await screen.findByRole('button', { name: 'An MRE übertragen' })).toBeTruthy();
    expect(screen.getAllByText('Zuordnung bestätigt').length).toBeGreaterThan(0);
    expect(posts(calls)).toEqual([COMMAND('confirm')]);
    click('An MRE übertragen');
    click('Jetzt an MRE übertragen');
    await screen.findByText('MRE: übertragen');
    expect(screen.getByText(/Zahlung in MRE: 01\.03\.2026/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Aus MRE entfernen' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Grund für das Aufheben (Pflicht)'), { target: { value: 'Falsche Buchung' } });
    click('Zuordnung aufheben');
    expect(await screen.findByRole('button', { name: 'Aus MRE entfernen' })).toBeTruthy();
    expect(screen.getByText('MRE: Entfernen erforderlich')).toBeTruthy();
    expect(screen.getByText('Zuordnung aufgehoben')).toBeTruthy();
    expect(posts(calls)).toEqual([COMMAND('confirm'), COMMAND('write-back-to-mre'), COMMAND('release')]);
    click('Aus MRE entfernen');
    click('Jetzt aus MRE entfernen');
    await screen.findByText('MRE: entfernt');
    expect(posts(calls)).toEqual([COMMAND('confirm'), COMMAND('write-back-to-mre'), COMMAND('release'), COMMAND('remove-from-mre')]);
    expect(count(calls, DETAIL)).toBe(5);
    expect(calls.every((call) => call.headers.get('organizationid') === REALM_A && !call.headers.has('idempotency-key'))).toBe(true);
  });

  it('a detail of another Realm is not shown and offers nothing; a command answer of another Realm is refused', async () => {
    area({ [DETAIL]: [() => json(200, read({ mreRealmId: REALM_B }))] }, `${BASE}/${REC}`);
    expect(await screen.findByText('Antwort eines anderen Bestands')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /bestätigen|übertragen|aufheben|entfernen/ })).toBeNull();
    cleanup();
    const { calls } = area(
      {
        [DETAIL]: repeat(3, () => json(200, read({ ...confirmed() }), { etag: '"2"' })),
        [TX_GET]: [() => json(200, detail({ status: 'CONFIRMED' }))],
        [COMMAND('write-back-to-mre')]: [() => json(200, written({ mreRealmId: REALM_B }))],
      },
      `${BASE}/${REC}`,
    );
    await screen.findByRole('button', { name: 'An MRE übertragen' });
    click('An MRE übertragen');
    click('Jetzt an MRE übertragen');
    expect(await screen.findByText('Antwort eines anderen Bestands')).toBeTruthy();
    expect(screen.queryByText(/die Zahlung steht jetzt im Termin in MRE/)).toBeNull();
    expect(count(calls, COMMAND('write-back-to-mre'))).toBe(1);
  });

  it('the Transaction is named from its own read; a refused read keeps the id and the link', async () => {
    area(
      { [DETAIL]: [() => json(200, read())], [TX_GET]: [() => json(200, detail({ status: 'CONFIRMED', counterpartyNameRaw: 'Erika Beispiel' }))] },
      `${BASE}/${REC}`,
    );
    expect(await screen.findByText(/Erika Beispiel · Miete Maerz Testwohnung/)).toBeTruthy();
    expect(screen.getByText('Mieter in MRE')).toBeTruthy();
    expect(screen.getByText(TENANT)).toBeTruthy();
    cleanup();
    area({ [DETAIL]: [() => json(200, read())], [TX_GET]: [() => envelope(404, 'NOT_FOUND')] }, `${BASE}/${REC}`);
    expect(await screen.findByText('Buchung nicht gefunden oder nicht zugänglich')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Buchung öffnen' }).getAttribute('href')).toBe(`/cockpit/r/${REALM_A}/buchungen/${TX}`);
  });
});

describe('the coverage of a term (ui-guide.md §6.6; api-design.md §37.2)', () => {
  const at = `${BASE}/termin/${TENANT}/${TERM}`;
  it('AVAILABLE: DE matches and MRE payments side by side, never summed; coverage and open amount with their source', async () => {
    area({ [TERM_GET]: [() => json(200, termCoverage())] }, at);
    const de = await screen.findByRole('region', { name: 'Aus bestätigten Buchungen (DE)' });
    const mre = screen.getByRole('region', { name: 'MRE-Zahlungsstand' });
    expect(de.textContent).toContain('Summe der bestätigten Zuordnungen: 800,00 €');
    expect(mre.textContent).toContain('Sollbetrag laut MRE (ohne Vortrag): 850,00 €');
    expect(within(mre).getByRole('list', { name: 'Zahlungen in MRE' }).textContent).toContain('02.03.2026 · 850,00 € · cash');
    expect(de.textContent).not.toContain('1.650');
    const coverage = screen.getByRole('region', { name: 'Deckung' });
    expect(coverage.textContent).toContain('Teilweise zugeordnet.');
    expect(coverage.textContent).toContain('Offener Betrag: 50,00 € (Sollbetrag laut MRE abzüglich der bestätigten Zuordnungen in DE');
  });

  it('NOT_RETURNED and UNAVAILABLE are different texts; without MRE nothing is said to be paid and DE matches stay', async () => {
    for (const [mreStatus, text] of [
      ['NOT_RETURNED', 'MRE hat diesen Termin nicht geliefert'],
      ['UNAVAILABLE', 'MRE war nicht erreichbar oder antwortete unerwartet'],
    ] as const) {
      area({ [TERM_GET]: [() => json(200, termCoverage({ mreStatus, mre: null, coverage: null, openAmount: null }))] }, at);
      expect(await screen.findByText(new RegExp(text))).toBeTruthy();
      expect(screen.getByText(/Keine Aussage möglich/)).toBeTruthy();
      expect(screen.queryByText(/Offener Betrag/)).toBeNull();
      expect(document.body.textContent).not.toMatch(/bezahlt|(?<![\d.])0,00/);
      expect(screen.getByRole('list', { name: 'Zuordnungen in DE' }).textContent).toContain('800,00');
      cleanup();
    }
  });

  it('a 503 of the access check is explained and read again only on request; an unknown status or coverage is shown with its code', async () => {
    const { calls } = area(
      {
        [TERM_GET]: [
          () => envelope(503, 'EXTERNAL_SYSTEM_ERROR', undefined, { 'retry-after': '10' }),
          () => json(200, termCoverage({ mreStatus: 'NEW_MRE' as never, coverage: 'NEW_COVERAGE' as never })),
        ],
      },
      at,
    );
    expect(await screen.findByText(/Die Anmeldeprüfung bei MRE ist nicht erreichbar/)).toBeTruthy();
    expect(screen.getByText(/Frühestens in 10 Sekunden erneut versuchen/)).toBeTruthy();
    await settle();
    expect(count(calls, TERM_GET)).toBe(1);
    click('Erneut laden');
    expect(await screen.findByText('Unbekannter MRE-Stand (NEW_MRE).')).toBeTruthy();
    expect(screen.getByText('Unbekannte Deckung (NEW_COVERAGE).')).toBeTruthy();
  });
});
