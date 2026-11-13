import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError, CLIENT_CODES } from '../../api/errors';
import type { PageDto, TransactionDto, TransactionRead } from '../../api/transactions';
import { readListParams } from '../../transactions/list-params';
import {
  account,
  ACCOUNT,
  category,
  detail,
  page,
  property,
  PROPERTY,
  REALM_A,
  split,
  transaction,
  TX,
  TX_REPLACEMENT,
  TX_REVERSAL,
} from '../../transactions/fixtures.test-support';
import type { Loadable } from '../RealmChoice';
import { firstInvalidControl } from './FilterBar';
import { statusLabel } from './labels';
import type { References } from './references';
import { TransactionDetailView } from './TransactionDetail';
import { listFieldErrors, TransactionListView } from './TransactionList';

const NBSP = '\u00a0';
/** A code a newer backend may send that the client types do not know (ui-guide.md §11: an unknown enum). */
const unknownCode = (code: string) => code as never;
const LIST = `/cockpit/r/${REALM_A}/buchungen`;
const nothing = () => undefined;

const loaded: References = {
  accounts: { status: 'success', data: page([account()]) },
  properties: { status: 'success', data: page([property()]) },
  categories: { status: 'success', data: [category(), category({ code: 'OLD_FEE', name: 'Alte Gebühr', active: false })] },
};

function list(state: Loadable<PageDto<TransactionDto>>, search = '', references: References = loaded): string {
  return renderToStaticMarkup(
    <TransactionListView realmId={REALM_A} params={readListParams(search)} list={state} references={references} onFilter={nothing} onRetry={nothing} />,
  );
}

function view(state: Loadable<TransactionRead>, references: References = loaded): string {
  return renderToStaticMarkup(<TransactionDetailView realmId={REALM_A} read={state} references={references} listHref={LIST} onRetry={nothing} />);
}

const error = (status: number, code: string, fields: { field: string; code: string }[] = [], retryAfter?: number) =>
  ({ status: 'error', error: new ApiError(status, code, 'x', fields.length === 0 ? undefined : { fields }, fields, retryAfter) }) as const;

/** The collapsed block „Technische Angaben“ of a card (Issue #352 des Projektinhabers, 2026-11-12, point 3). */
const technicalDetails = (html: string) => /<details[^>]*>.*?<\/details>/s.exec(html)?.[0] ?? '';

/** The text of the page without tags, entities of the markup decoded where the tests read them. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t\n]+/g, ' ');

describe('step 2, the transaction list in its states (ui-guide.md §6.3, §7.4, §11)', () => {
  it('loading: a busy status under the filters, no table and no zero amounts', () => {
    const html = list({ status: 'pending' });
    expect(html).toContain('role="status"');
    expect(html).toContain('Buchungen werden geladen');
    expect(html).toContain('aria-label="Filter der Buchungsliste"');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('0,00');
  });

  it('empty Realm: says there are no transactions yet, not an error and not a filter miss', () => {
    const html = list({ status: 'success', data: page([]) });
    expect(html).toContain('In diesem Bestand gibt es noch keine Buchungen');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('Keine Buchung passt');
  });

  it('empty for the filters: says so and offers to reset them, keeping the page size', () => {
    const html = list({ status: 'success', data: page([]) }, '?status=CONFIRMED&pageSize=100');
    expect(html).toContain('Keine Buchung passt zu diesen Filtern');
    expect(html).toContain(`href="${LIST}?pageSize=100"`);
    expect(html).not.toContain('noch keine Buchungen');
  });

  it('a page beyond the last: says how many pages there are and links to the last one', () => {
    const html = list({ status: 'success', data: page([], { page: 5, total: 120 }) }, '?status=IMPORTED&page=5');
    expect(text(html)).toContain('Seite 5 gibt es nicht; die Liste hat 3 Seiten.');
    expect(html).toContain(`href="${LIST}?status=IMPORTED&amp;page=3"`);
    expect(html).not.toContain('noch keine Buchungen');
  });

  it('success: each row with date, signed amount, direction, counterparty, status, origin and account name', () => {
    const items = [
      transaction(),
      transaction({
        transactionId: TX_REVERSAL,
        amount: { amount: '1234567.5', currency: 'EUR' },
        direction: 'OUTFLOW',
        status: 'CONFIRMED',
        provenance: 'MANUAL',
        counterpartyNameRaw: null,
        description: null,
      }),
    ];
    const html = list({ status: 'success', data: page(items) });
    const plain = text(html);
    expect(html).toContain(`href="${LIST}/${TX}" aria-label="Buchung vom 01.03.2026 öffnen"`);
    expect(html).toContain(`>850,00${NBSP}€<`);
    expect(html).toContain(`>-1.234.567,50${NBSP}€<`);
    for (const expected of [
      'Eingang',
      'Ausgang',
      'Erika Beispiel',
      'Miete Maerz Testwohnung',
      'Importiert · zu prüfen',
      'Bestätigt',
      'Bankimport (CSV)',
      'Manuell erfasst',
      'Girokonto Testbank',
      'Keine Gegenpartei angegeben',
      'Ohne Verwendungszweck',
    ]) {
      expect(plain).toContain(expected);
    }
    expect(plain).toContain('Seite 1 von 1 · 2 Buchungen');
    // No sum of the page and no total amount (ui-guide.md §6.3).
    expect(plain).not.toMatch(/Summe|Gesamtbetrag/);
  });

  it('pagination from total keeps the filters in its links; no link before the first or after the last page', () => {
    const items = [transaction()];
    const middle = list({ status: 'success', data: page(items, { page: 2, total: 120 }) }, '?reviewable=true&page=2');
    expect(text(middle)).toContain('Seite 2 von 3 · 120 Buchungen');
    expect(middle).toContain(`href="${LIST}?reviewable=true" rel="prev"`);
    expect(middle).toContain(`href="${LIST}?reviewable=true&amp;page=3" rel="next"`);
    const first = list({ status: 'success', data: page(items, { total: 120 }) }, '?reviewable=true');
    expect(first).not.toContain('rel="prev"');
    expect(first).toContain('rel="next"');
    const last = list({ status: 'success', data: page(items, { page: 3, total: 120 }) }, '?page=3');
    expect(last).not.toContain('rel="next"');
    expect(text(list({ status: 'success', data: page(items, { total: 1 }) }))).toContain('1 Buchung');
  });

  it('an unknown status, origin or direction is shown with its code, never an empty cell', () => {
    const html = text(
      list({
        status: 'success',
        data: page([transaction({ status: unknownCode('DISPUTED'), provenance: unknownCode('FAX'), direction: unknownCode('SIDEWAYS') })]),
      }),
    );
    expect(html).toContain('Unbekannter Status (DISPUTED)');
    expect(html).toContain('Unbekannte Herkunft (FAX)');
    expect(html).toContain('Unbekannte Richtung (SIDEWAYS)');
    expect(statusLabel('toString')).toMatchObject({ known: false });
  });

  it('an account name missing from the list shows the id, an unreadable amount says so', () => {
    const references: References = { ...loaded, accounts: { status: 'success', data: page([]) } };
    const html = list({ status: 'success', data: page([transaction({ amount: { amount: '1,50', currency: 'EUR' } })]) }, '', references);
    expect(html).toContain(`<code class="font-mono text-label">${ACCOUNT}</code>`);
    expect(html).toContain('Betrag nicht lesbar (1,50 EUR)');
  });
});

describe('Herkunft in the table and the filter (Entscheidung des Projektinhabers, 2026-11-13, zu #355 F4)', () => {
  const SHORT = [
    ['MANUAL', 'Manuell erfasst'],
    ['BANK_CSV', 'Bankimport (CSV)'],
    ['BANK_API', 'Bankschnittstelle'],
    ['MIGRATION', 'Datenübernahme'],
    ['CORRECTION', 'Korrektur'],
  ] as const;
  /** The Herkunft cell (the sixth) of every body row. */
  const provenanceCells = (html: string) =>
    [...html.matchAll(/<tr>(.*?)<\/tr>/gs)]
      .map((row) => [...(row[1] ?? '').matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((cell) => cell[1]))
      .filter((row) => row.length > 0)
      .map((row) => row[5]);
  /** The choices of the filter „Herkunft“: code and label. */
  const filterChoices = (html: string) => [...html.matchAll(/name="provenance" value="([^"]*)"[^>]*\/>([^<]*)</g)].map((m) => [m[1], m[2]]);

  it('every kind shows the same short text without Aus in the table and in the filter', () => {
    const items = SHORT.map(([code], i) => transaction({ transactionId: TX.replace(/.$/, String(i)), provenance: code }));
    const html = list({ status: 'success', data: page(items) });
    expect(provenanceCells(html)).toEqual(SHORT.map(([, label]) => label));
    expect(filterChoices(html)).toEqual(SHORT.map(([code, label]) => [code, label]));
    expect(text(html)).not.toMatch(/Aus (Bankimport|Bankschnittstelle|Datenübernahme|Korrektur)/);
  });

  it('an unknown kind keeps its code in the table and is no filter choice', () => {
    const html = list({ status: 'success', data: page([transaction({ provenance: unknownCode('FAX_IMPORT') })]) });
    expect(provenanceCells(html)).toEqual(['Unbekannte Herkunft (FAX_IMPORT)']);
    expect(filterChoices(html).map(([code]) => code)).not.toContain('FAX_IMPORT');
  });
});

describe('the table at 1280 px (Issue #353 des Projektinhabers, 2026-11-12, point 7)', () => {
  const LONG = 'Miete Oktober Testwohnung Musterstraße 12, 2. OG links, Mieterkonto 4711, Abschlag Nebenkosten und Stellplatz, Zahlung per Dauerauftrag';
  const cells = (html: string) => [...html.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((match) => match[0]);

  it('the purpose wraps to two lines with the whole text as title; the counterparty keeps one line with its title', () => {
    const html = list({ status: 'success', data: page([transaction({ description: LONG, counterpartyNameRaw: 'Erika Beispiel' })]) });
    expect(html).toContain('<th scope="col" class="min-w-[14rem] p-3">Gegenpartei und Verwendungszweck</th>');
    const purpose = cells(html)[3] ?? '';
    expect(purpose).toContain(`<p class="line-clamp-2 text-label text-muted" title="${LONG}">${LONG}</p>`);
    expect(purpose).toContain('<p class="line-clamp-1" title="Erika Beispiel">Erika Beispiel</p>');
    expect(purpose).not.toContain('truncate');
    expect(purpose).not.toContain('max-w-xs');
  });

  it('the account wraps to at most two lines with its whole name as title; without a name the id', () => {
    // Entscheidung des Projektinhabers, 2026-11-13: the account column on two lines with line-clamp-2, not cut off.
    const named = list({ status: 'success', data: page([transaction()]) });
    expect(cells(named)[6]).toBe('<td class="p-3"><p class="line-clamp-2 max-w-[12rem]" title="Girokonto Testbank">Girokonto Testbank</p></td>');
    expect(cells(named)[6]).not.toContain('truncate');
    const longName = 'Gemeinschaftskonto Hausverwaltung Musterstraße 12 Rücklage und Instandhaltung';
    const long = list({ status: 'success', data: page([transaction()]) }, '', {
      ...loaded,
      accounts: { status: 'success', data: page([account({ displayName: longName })]) },
    });
    expect(cells(long)[6]).toBe(`<td class="p-3"><p class="line-clamp-2 max-w-[12rem]" title="${longName}">${longName}</p></td>`);
    const unnamed = list({ status: 'success', data: page([transaction()]) }, '', { ...loaded, accounts: { status: 'pending' } });
    expect(cells(unnamed)[6]).toBe(`<td class="p-3"><code class="font-mono text-label">${ACCOUNT}</code></td>`);
  });

  it('no title where there is nothing to cut: no counterparty, no purpose', () => {
    const html = list({ status: 'success', data: page([transaction({ description: null, counterpartyNameRaw: null })]) });
    const purpose = cells(html)[3] ?? '';
    expect(purpose).not.toContain('title=');
    expect(text(purpose)).toContain('Keine Gegenpartei angegeben');
    expect(text(purpose)).toContain('Ohne Verwendungszweck');
  });
});

describe('one word for the statuses to check (Issue #353 des Projektinhabers, 2026-11-12, point 9)', () => {
  it('the badge and the filter both say „zu prüfen“; „prüfbar“ is gone', () => {
    expect(statusLabel('IMPORTED').text).toBe('Importiert · zu prüfen');
    const html = list({ status: 'success', data: page([transaction()]) });
    expect(text(html)).toContain('Nur zu prüfende (Importiert oder Ungeprüft)');
    expect(html).not.toMatch(/prüfbar/i);
  });
});

describe('step 2, refusals of the list (ui-guide.md §7.4)', () => {
  const fields = [
    { field: 'bookingDateTo', code: 'INVALID_RANGE' },
    { field: 'status', code: 'INVALID_FORMAT' },
    { field: 'zzz', code: 'INVALID_FORMAT' },
    { field: 'page', code: 'OUT_OF_RANGE' },
  ];

  it('400: every field in the summary in server order, the filters bound at their controls, a reset instead of a retry', () => {
    const html = list(error(400, 'VALIDATION_ERROR', fields), '?status=FOO&bookingDateFrom=2026-12-01&bookingDateTo=2026-01-01&page=0');
    const summary = [...html.matchAll(/<li><code class="font-mono">([^<]*)<\/code>: ([^<]*)<\/li>/g)].map((m) => `${m[1]}: ${m[2]}`);
    expect(summary).toEqual([
      'bookingDateTo: Ende liegt vor dem Beginn',
      'status: ungültig oder nicht vorgesehen',
      'zzz: ungültig oder nicht vorgesehen',
      'page: außerhalb des zulässigen Bereichs',
    ]);
    expect(html).toContain(
      'id="filter-bookingDateTo" type="date" name="bookingDateTo" class="min-h-touch w-full min-w-0 rounded-input border border-border bg-surface px-3 text-base" aria-invalid="true" aria-describedby="filter-bookingDateTo-fehler" value="2026-01-01"',
    );
    expect(html).not.toContain(
      'id="filter-bookingDateFrom" type="date" name="bookingDateFrom" class="min-h-touch w-full min-w-0 rounded-input border border-border bg-surface px-3 text-base" aria-invalid',
    );
    expect(html).toContain('<p id="filter-bookingDateTo-fehler" class="text-label text-danger-text">Ende liegt vor dem Beginn</p>');
    expect(html).toContain('<fieldset id="filter-status" tabindex="-1" class="flex min-w-0 flex-col gap-1" aria-describedby="filter-status-fehler">');
    expect(html).not.toContain('filter-zzz');
    expect(html).toContain('Filter zurücksetzen');
    expect(html).not.toContain('Erneut laden');
  });

  it('the bound fields are those the list knows; the first refused control in screen order gets the focus', () => {
    const map = listFieldErrors(new ApiError(400, 'VALIDATION_ERROR', 'x', { fields }, fields));
    expect([...map.keys()]).toEqual(['bookingDateTo', 'status', 'page']);
    expect(firstInvalidControl(map)).toBe('filter-status');
    expect(firstInvalidControl(new Map())).toBeUndefined();
    expect(listFieldErrors(new Error('x')).size).toBe(0);
  });

  it('403: no access, the Realm choice and no retry; 503 and no answer: a retry on request, the outcome unclear', () => {
    const forbidden = list(error(403, 'FORBIDDEN'));
    expect(forbidden).toContain('Kein Zugriff');
    expect(forbidden).toContain('Anderen Bestand wählen');
    expect(forbidden).not.toContain('Erneut laden');
    const unavailable = list(error(503, 'EXTERNAL_SYSTEM_ERROR', [], 9));
    expect(unavailable).toContain('Erneut laden');
    expect(unavailable).toContain('in 9 Sekunden');
    expect(unavailable).not.toContain('Anderen Bestand wählen');
    expect(list(error(0, CLIENT_CODES.network))).toContain('unklar');
    // A 403 without the envelope (a proxy page) is still a refusal of the Realm: no retry.
    const proxyForbidden = list(error(403, CLIENT_CODES.unexpected));
    expect(proxyForbidden).toContain('Anderen Bestand wählen');
    expect(proxyForbidden).not.toContain('Erneut laden');
  });

  it('an answer of another Realm is an error, never a list', () => {
    const html = list(error(200, CLIENT_CODES.realmMismatch));
    expect(html).toContain('Antwort eines anderen Bestands');
    expect(html).not.toContain('<table');
  });
});

describe('step 2, the filter bar (ui-guide.md §6.3: only the existing filters)', () => {
  it('shows the URL filters in its controls, chosen by name from the lists', () => {
    const html = list(
      { status: 'pending' },
      `?financialAccountId=${ACCOUNT}&status=IMPORTED,CLASSIFIED&bookingDateFrom=2026-01-01&financialCategoryCode=OLD_FEE&pageSize=100`,
    );
    expect(html).toContain(`<option value="${ACCOUNT}" selected="">Girokonto Testbank</option>`);
    expect(html).toContain('name="status" checked="" value="IMPORTED"');
    expect(html).toContain('name="status" checked="" value="CLASSIFIED"');
    expect(html).toContain('name="status" value="CONFIRMED"');
    expect(html).toContain('name="reviewable" value="true"');
    expect(html).not.toContain('name="status" disabled=""');
    expect(html).toContain('name="current" value="true"');
    expect(html).toContain(
      'name="bookingDateFrom" class="min-h-touch w-full min-w-0 rounded-input border border-border bg-surface px-3 text-base" value="2026-01-01"',
    );
    expect(html).toContain('<option value="OLD_FEE" selected="">Alte Gebühr (inaktiv)</option>');
    expect(html).toContain('<option value="100" selected="">100</option>');
    expect(html).toContain(`<option value="${PROPERTY}">Testhaus Wohnung 1</option>`);
  });

  it('offers no control the API does not have: no free text, sort or counterparty', () => {
    const html = list({ status: 'pending' });
    const names = [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(names)).toEqual(
      new Set([
        'financialAccountId',
        'propertyReferenceId',
        'financialCategoryCode',
        'status',
        'provenance',
        'reviewable',
        'current',
        'bookingDateFrom',
        'bookingDateTo',
        'pageSize',
      ]),
    );
    expect(html).not.toContain('type="search"');
  });

  it('a filter value missing from its list stays chosen; loading, refused and cut lists say so', () => {
    const references: References = {
      accounts: { status: 'pending' },
      properties: { status: 'error', error: new ApiError(503, 'EXTERNAL_SYSTEM_ERROR', 'x') },
      categories: { status: 'success', data: [] },
    };
    const html = list({ status: 'pending' }, `?financialAccountId=${ACCOUNT}&propertyReferenceId=${PROPERTY}`, references);
    expect(html).toContain(`<option value="${ACCOUNT}" selected="">Konto ${ACCOUNT}</option>`);
    expect(html).toContain(`<option value="${PROPERTY}" selected="">Objekt ${PROPERTY}</option>`);
    expect(html).toContain('Konten werden geladen');
    expect(html).toContain('Objekte konnten nicht geladen werden');
    const cut: References = { ...loaded, accounts: { status: 'success', data: page([account()], { pageSize: 200, total: 250 }) } };
    expect(list({ status: 'pending' }, '', cut)).toContain('Die Auswahl zeigt die ersten 1 von 250 Konten.');
    expect(list({ status: 'pending' })).not.toContain('Die Auswahl zeigt');
  });
});

describe('step 2, one Transaction (ui-guide.md §6.3, §6.1: the correction chain is the visible history)', () => {
  it('loading, 404 with the way back to the list, 403 with the Realm choice, 503 with a retry', () => {
    expect(view({ status: 'pending' })).toContain('Buchung wird geladen');
    const missing = view(error(404, 'NOT_FOUND'));
    expect(missing).toContain('nicht gefunden oder ist nicht zugänglich');
    expect(missing).toContain(`href="${LIST}"`);
    expect(missing).toContain('Zur Buchungsliste');
    expect(missing).not.toContain('Erneut laden');
    const forbidden = view(error(403, 'FORBIDDEN'));
    expect(forbidden).toContain('Anderen Bestand wählen');
    expect(forbidden).not.toContain('Zur Buchungsliste');
    expect(view(error(503, 'EXTERNAL_SYSTEM_ERROR'))).toContain('Erneut laden');
  });

  it('success: every field of the detail, the account and object by name, the version read', () => {
    const t = detail({ propertyReferenceId: PROPERTY, status: 'CONFIRMED', confirmedAt: '2026-03-31T23:30:00.000Z', confirmedBy: 'admin1@example.com' });
    const html = view({ status: 'success', data: { transaction: t, etag: '"3"' } });
    const plain = text(html);
    // The page title „Buchung vom 01.03.2026“ and the breadcrumbs are the shell's (PageTitle; durchstich-seiten.test.tsx).
    expect(html).toContain('<h2 id="buchung" class="text-section font-semibold">Angaben zur Buchung</h2>');
    expect(html).not.toContain('<nav aria-label="Brotkrumen">');
    for (const expected of [
      `850,00${NBSP}€ (Eingang)`,
      '01.03.2026',
      '02.03.2026',
      'Erika Beispiel',
      'DE00 0000 0000 0000 0000 00',
      'Wie in der Bankdatei angegeben',
      'Miete Maerz Testwohnung',
      'Bankimport (CSV)',
      'Bestätigt',
      'Konto Girokonto Testbank Objekt der Buchung Testhaus Wohnung 1 Angelegt',
      '02.03.2026, 09:15',
      '01.04.2026, 01:30 von admin1@example.com',
      'Keine Korrektur verknüpft.',
      'Noch nicht aufgeteilt.',
    ]) {
      expect(plain).toContain(expected);
    }
    // Issue #352 point 3: the names carry their ids as a tooltip; version, ETag and ids are in the collapsed details.
    expect(html).toContain(`<span title="${ACCOUNT}">Girokonto Testbank</span>`);
    expect(html).toContain(`<span title="${PROPERTY}">Testhaus Wohnung 1</span>`);
    const details = technicalDetails(html);
    for (const [label, value] of [
      ['Buchungs-ID', TX],
      ['Version', '3 (ETag "3")'],
      ['Konto-ID', ACCOUNT],
      ['Objekt-ID', PROPERTY],
    ]) {
      expect(text(details)).toContain(`${label} ${value}`);
    }
    const visible = text(html.replace(details, ''));
    expect(visible).not.toMatch(/If-Match|ETag|Version/);
    for (const id of [TX, ACCOUNT, PROPERTY]) expect(visible).not.toContain(id);
  });

  it('technical details: one collapsed block per card, closed by default, never a button', () => {
    const html = view({ status: 'success', data: { transaction: detail({ propertyReferenceId: null }), etag: undefined } });
    expect(html.match(/<details/g)).toHaveLength(1);
    expect(html).toContain('<details class="mt-3 text-label text-muted"><summary class="min-h-touch cursor-pointer py-2">Technische Angaben</summary>');
    expect(html).not.toContain('<details open');
    expect(text(technicalDetails(html))).toContain('Version 3 Konto-ID');
    expect(text(technicalDetails(html))).not.toContain('Objekt-ID');
  });

  it('read only: no button splits, confirms or corrects yet (steps 3 and 4)', () => {
    const html = view({ status: 'success', data: { transaction: detail(), etag: '"3"' } });
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<form');
  });

  it('the splits with category name, unsigned amount, references and description', () => {
    const splits = [
      split(),
      split({
        splitId: 's2',
        position: 2,
        amount: { amount: '150.00', currency: 'EUR' },
        financialCategoryCode: 'NEW_CODE',
        propertyReferenceId: null,
        loanId: TX_REPLACEMENT,
        description: 'Zinsanteil',
      }),
    ];
    const html = view({ status: 'success', data: { transaction: detail({ direction: 'OUTFLOW', splits }), etag: undefined } });
    const plain = text(html);
    expect(plain).toContain(`-850,00${NBSP}€ (Ausgang)`);
    // A category with a name shows the name, its code only as the tooltip; a code without a name stays visible.
    expect(html).toContain('<span title="RENT_BASE">Kaltmiete</span>');
    expect(plain).not.toContain('RENT_BASE');
    expect(html).toContain(`>700,00${NBSP}€<`);
    expect(html).toContain(`>150,00${NBSP}€<`);
    expect(plain).toContain('Objekt: Testhaus Wohnung 1');
    expect(html).toContain(`<span title="${PROPERTY}">Testhaus Wohnung 1</span>`);
    expect(plain).toContain(`Darlehen: ${TX_REPLACEMENT}`);
    expect(plain).toContain('Unbekannte Kategorie NEW_CODE');
    expect(plain).toContain('Zinsanteil');
    expect(plain).not.toContain('ETag');
  });

  it('the correction chain links original, reversal and replacement within the Realm', () => {
    const original = view({
      status: 'success',
      data: { transaction: detail({ status: 'CORRECTED', reversalTransactionId: TX_REVERSAL, replacementTransactionId: TX_REPLACEMENT }), etag: '"4"' },
    });
    expect(original).toContain(`href="${LIST}/${TX_REVERSAL}">Storno dieser Buchung</a>`);
    expect(original).toContain(`href="${LIST}/${TX_REPLACEMENT}">Ersatzbuchung</a>`);
    expect(text(original)).toContain('Korrigiert/storniert');
    const reversal = view({
      status: 'success',
      data: {
        transaction: detail({ transactionId: TX_REVERSAL, correctionRole: 'REVERSAL', correctionOfTransactionId: TX, provenance: 'CORRECTION' }),
        etag: '"1"',
      },
    });
    expect(text(reversal)).toContain('Storno zur korrigierten Buchung');
    expect(reversal).toContain(`href="${LIST}/${TX}">korrigierten Buchung</a>`);
  });

  it('a Transaction without counterparty, value date or names says so, never 0,00 € or an empty cell', () => {
    const references: References = { accounts: { status: 'pending' }, properties: { status: 'pending' }, categories: { status: 'pending' } };
    const t = detail({ counterpartyNameRaw: null, counterpartyIbanRaw: null, valueDate: null, provenance: 'MANUAL', splits: [split()] });
    const plain = text(view({ status: 'success', data: { transaction: t, etag: '"3"' } }, references));
    expect(plain).toContain('Keine Angabe (nur bei Bankimporten vorhanden)');
    expect(plain).toContain('Wertstellung Nicht verfügbar');
    expect(plain).toContain(`Konto Name nicht verfügbar ${ACCOUNT}`);
    expect(plain).toContain('Unbekannte Kategorie RENT_BASE');
  });
});
