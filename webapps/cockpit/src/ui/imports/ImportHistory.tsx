import type { ImportBatchSummaryDto } from '../../api/imports';
import type { FinancialAccountDto, PageDto } from '../../api/transactions';
import { importBatchPath } from '../../routing';
import { Badge } from '../Badge';
import { TimestampText } from '../format';
import { Link } from '../Link';
import type { Loadable } from '../RealmChoice';
import { LoadingState, ReadProblem } from '../states';
import { batchStatusText } from './import-labels';

/** The page of the import list in the URL of `…/import` (ui-guide.md §3.2): `?page=2`; anything else is page 1. */
export function readHistoryPage(search: string): number {
  const page = new URLSearchParams(search).get('page') ?? '1';
  return /^[1-9]\d{0,5}$/.test(page) ? Number(page) : 1;
}

export const historySearch = (page: number) => (page > 1 ? `?page=${page}` : '');

const open = (b: Pick<ImportBatchSummaryDto, 'status'>) => b.status === 'NEEDS_REVIEW';
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * „Bisherige Importe“ under the import form (#369; Entscheidung des Projektinhabers, 2026-11-16: „die Liste unter dem
 * Importformular mit offenen Klärfällen hervorgehoben“): the Realm's imports newest first as `GET /imports` answers them
 * (api-design.md §32.6), each with its file, account, time, counters and status, and one link to its result. An import
 * with open review items (`status = NEEDS_REVIEW`) is highlighted: its badge, a border and the number of open items say
 * it in words, the colour only repeats it (ui-guide.md §4.1). Loading, empty and error are distinct states (§7.4); pages
 * from the server's `total`.
 */
export function ImportHistory(props: {
  readonly realmId: string;
  readonly list: Loadable<PageDto<ImportBatchSummaryDto>>;
  readonly accounts: readonly FinancialAccountDto[];
  readonly href: (page: number) => string;
  readonly onRetry: () => void;
}) {
  const { list } = props;
  return (
    <section aria-labelledby="bisherige-importe" className="rounded-card border border-border bg-surface p-6">
      <h2 id="bisherige-importe" className="mb-2 text-section font-semibold">
        Bisherige Importe
      </h2>
      {list.status === 'pending' ? (
        <LoadingState label="Bisherige Importe werden geladen …" />
      ) : list.status === 'error' ? (
        <ReadProblem error={list.error} onRetry={props.onRetry} />
      ) : list.data.total === 0 ? (
        <p className="text-muted">Noch keine Importe in diesem Bestand.</p>
      ) : (
        <Rows {...props} page={list.data} />
      )}
    </section>
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
