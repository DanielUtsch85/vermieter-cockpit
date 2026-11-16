import type { FormEvent } from 'react';
import type { ImportBatchSummaryDto, ImportHistoryQuery } from '../../api/imports';
import type { FinancialAccountDto, PageDto } from '../../api/transactions';
import { formatBusinessDate } from '../../format/dates';
import { importBatchPath } from '../../routing';
import { Badge } from '../Badge';
import { TimestampText } from '../format';
import { Link } from '../Link';
import type { Loadable } from '../RealmChoice';
import { buttonClass, LoadingState, ReadProblem } from '../states';
import { accountStatusLabel } from '../transactions/labels';
import { batchStatusText } from './import-labels';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The page and filters of the import list in the URL of `…/import` (ui-guide.md §3.2; VC-X-76): `?page=2`,
 * `?status=NEEDS_REVIEW` („Nur mit offenen Klärfällen“), `?financialAccountId=<id>`. A value the list cannot send is
 * read as absent: another page is page 1, another status or an account id that is not a UUID no filter.
 */
export function readHistoryQuery(search: string): ImportHistoryQuery {
  const params = new URLSearchParams(search);
  const page = params.get('page') ?? '1';
  const account = params.get('financialAccountId') ?? '';
  return {
    page: /^[1-9]\d{0,5}$/.test(page) ? Number(page) : 1,
    openOnly: params.get('status') === 'NEEDS_REVIEW',
    financialAccountId: UUID.test(account) ? account.toLowerCase() : undefined,
  };
}

/** The URL search of a list state; the page last, page 1 left out. */
export function historySearch(query: ImportHistoryQuery): string {
  const params = new URLSearchParams();
  if (query.openOnly) params.set('status', 'NEEDS_REVIEW');
  if (query.financialAccountId !== undefined) params.set('financialAccountId', query.financialAccountId);
  if (query.page > 1) params.set('page', String(query.page));
  const search = params.toString();
  return search === '' ? '' : `?${search}`;
}

const filtered = (query: ImportHistoryQuery) => query.openOnly || query.financialAccountId !== undefined;

/** „Buchungen 01.10.2026 – 31.10.2026“ (VC-X-75), or nothing when the import has no row with a booking date. */
export function bookingRangeText(b: Pick<ImportBatchSummaryDto, 'firstBookingDate' | 'lastBookingDate'>): string | undefined {
  if (b.firstBookingDate === null || b.lastBookingDate === null) return undefined;
  return `Buchungen ${formatBusinessDate(b.firstBookingDate) ?? b.firstBookingDate} – ${formatBusinessDate(b.lastBookingDate) ?? b.lastBookingDate}`;
}

const open = (b: Pick<ImportBatchSummaryDto, 'status'>) => b.status === 'NEEDS_REVIEW';
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * „Bisherige Importe“ under the import form (#369; Entscheidung des Projektinhabers, 2026-11-16: „die Liste unter dem
 * Importformular mit offenen Klärfällen hervorgehoben“): the Realm's imports newest first as `GET /imports` answers them
 * (api-design.md §32.6), each with its file, account, time, counters and status, and one link to its result. An import
 * with open review items (`status = NEEDS_REVIEW`) is highlighted: its badge, a border and the number of open items say
 * it in words, the colour only repeats it (ui-guide.md §4.1). Each import shows the range of its booking dates (VC-X-75);
 * the list filters by account and open review items (VC-X-76). Loading, empty and error are distinct states (§7.4);
 * pages from the server's `total`.
 */
export function ImportHistory(props: {
  readonly realmId: string;
  readonly query: ImportHistoryQuery;
  readonly list: Loadable<PageDto<ImportBatchSummaryDto>>;
  readonly accounts: readonly FinancialAccountDto[];
  readonly href: (query: ImportHistoryQuery) => string;
  readonly onFilter: (query: ImportHistoryQuery) => void;
  readonly onRetry: () => void;
}) {
  const { list, query } = props;
  return (
    <section aria-labelledby="bisherige-importe" className="flex flex-col gap-3 rounded-card border border-border bg-surface p-6">
      <h2 id="bisherige-importe" className="text-section font-semibold">
        Bisherige Importe
      </h2>
      {/* Keyed by the URL and the loaded accounts: an account chosen by its id before the names arrive stays chosen. */}
      <HistoryFilter key={`${historySearch(query)}|${props.accounts.length}`} {...props} />
      {list.status === 'pending' ? (
        <LoadingState label="Bisherige Importe werden geladen …" />
      ) : list.status === 'error' ? (
        <ReadProblem error={list.error} onRetry={props.onRetry} />
      ) : list.data.total === 0 ? (
        <p className="text-muted">{filtered(query) ? 'Keine Importe zu diesen Filtern.' : 'Noch keine Importe in diesem Bestand.'}</p>
      ) : (
        <Rows {...props} href={(page) => props.href({ ...query, page })} page={list.data} />
      )}
    </section>
  );
}

const inputClass = 'min-h-touch w-full min-w-0 rounded-input border border-border bg-surface px-3 text-base';

/**
 * The filters of the list (VC-X-76; Entscheidung des Projektinhabers, 2026-11-16): the account chosen by name as in the
 * Buchungsliste (ui-guide.md §6.3), and the shortcut „Nur mit offenen Klärfällen“. Applied on submit, into the URL, from
 * page 1; „Filter zurücksetzen“ shows every import again. Keyed by the URL, so it starts afresh from every URL.
 */
function HistoryFilter(props: {
  readonly query: ImportHistoryQuery;
  readonly accounts: readonly FinancialAccountDto[];
  readonly href: (query: ImportHistoryQuery) => string;
  readonly onFilter: (query: ImportHistoryQuery) => void;
}) {
  const { query, accounts } = props;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const account = form.get('financialAccountId');
    props.onFilter({
      page: 1,
      openOnly: form.get('status') === 'NEEDS_REVIEW',
      financialAccountId: typeof account === 'string' && account !== '' ? account : undefined,
    });
  };
  const known = accounts.some((a) => a.financialAccountId === query.financialAccountId);
  return (
    <form aria-label="Filter der Importliste" onSubmit={submit} className="flex flex-wrap items-end gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor="importe-konto" className="text-label text-muted">
          Konto der Importe
        </label>
        <select id="importe-konto" name="financialAccountId" defaultValue={query.financialAccountId ?? ''} className={inputClass}>
          <option value="">Alle Konten</option>
          {accounts.map((account) => (
            <option key={account.financialAccountId} value={account.financialAccountId}>
              {account.displayName}
              {account.status === 'OPEN' ? '' : ` (${accountStatusLabel(account.status).text})`}
            </option>
          ))}
          {query.financialAccountId !== undefined && !known && <option value={query.financialAccountId}>{`Konto ${query.financialAccountId}`}</option>}
        </select>
      </div>
      <label className="flex min-h-touch items-center gap-2">
        <input type="checkbox" name="status" value="NEEDS_REVIEW" defaultChecked={query.openOnly} />
        Nur mit offenen Klärfällen
      </label>
      <button type="submit" className={buttonClass}>
        Filter anwenden
      </button>
      {filtered(query) && <Link href={props.href({ page: 1, openOnly: false, financialAccountId: undefined })}>Filter zurücksetzen</Link>}
    </form>
  );
}

function Rows(props: {
  readonly realmId: string;
  readonly page: PageDto<ImportBatchSummaryDto>;
  readonly accounts: readonly FinancialAccountDto[];
  readonly href: (page: number) => string;
}) {
  const { page } = props;
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  if (page.items.length === 0) {
    return (
      <p>
        {`Seite ${page.page} gibt es nicht. `}
        <Link href={props.href(pages)}>Zur letzten Seite</Link>
      </p>
    );
  }
  return (
    <>
      <ul aria-label={`Bisherige Importe, Seite ${page.page} von ${pages}`} className="flex flex-col gap-2">
        {page.items.map((b) => (
          <Row key={b.importBatchId} realmId={props.realmId} batch={b} accounts={props.accounts} />
        ))}
      </ul>
      <nav aria-label="Seiten der Importliste" className="mt-3 flex flex-wrap items-center gap-4">
        {page.page > 1 && <Link href={props.href(page.page - 1)}>Vorherige Seite</Link>}
        <p className="tabular-nums">{`Seite ${page.page} von ${pages} · ${count(page.total, 'Import', 'Importe')}`}</p>
        {page.page < pages && <Link href={props.href(page.page + 1)}>Nächste Seite</Link>}
      </nav>
    </>
  );
}

function Row(props: { readonly realmId: string; readonly batch: ImportBatchSummaryDto; readonly accounts: readonly FinancialAccountDto[] }) {
  const b = props.batch;
  const account = props.accounts.find((candidate) => candidate.financialAccountId === b.financialAccountId);
  const highlighted = open(b);
  const file = b.sourceFilename ?? 'Datei ohne Namen';
  const range = bookingRangeText(b);
  return (
    <li
      aria-label={highlighted ? `${file}, Klärfälle offen` : file}
      className={`flex flex-col gap-1 rounded-card border p-3 ${highlighted ? 'border-l-4 border-warning-text bg-warning-bg' : 'border-border'}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold">{file}</span>
        <Badge label={{ text: batchStatusText(b.status), tone: highlighted ? 'warning' : 'neutral', known: true }} />
        {highlighted && <span className="font-semibold text-warning-text">{count(b.needsReviewCount, 'offener Klärfall', 'offene Klärfälle')}</span>}
      </div>
      <p className="text-label text-muted">
        <TimestampText value={b.importedAt} />
        {' · Konto '}
        {account === undefined ? <code className="font-mono">{b.financialAccountId}</code> : account.displayName}
      </p>
      {range !== undefined && <p className="text-label tabular-nums">{range}</p>}
      <p className="text-label tabular-nums">
        {[
          count(b.transactionCount, 'neue Buchung', 'neue Buchungen'),
          count(b.duplicateCount, 'Duplikat', 'Duplikate'),
          count(b.errorCount, 'Zeile mit Fehler', 'Zeilen mit Fehler'),
          `${b.skippedCount} übersprungen`,
        ].join(' · ')}
      </p>
      <div>
        <Link href={importBatchPath(props.realmId, b.importBatchId)}>{highlighted ? 'Klärfälle bearbeiten' : 'Ergebnis öffnen'}</Link>
      </div>
    </li>
  );
}
