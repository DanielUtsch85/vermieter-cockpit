import { useMemo } from 'react';
import { ApiError, partitionFieldErrors, type FieldError } from '../../api/errors';
import type { PageDto, TransactionDto } from '../../api/transactions';
import { AREAS, areaPath, transactionPath } from '../../routing';
import { hasFilters, LIST_FIELD_NAMES, pageCount, toSearch, withPage, type ListParams } from '../../transactions/list-params';
import { formatBusinessDate } from '../../format/dates';
import { Badge } from '../Badge';
import { DateText, MoneyText } from '../format';
import { IdText } from '../IdText';
import { Link } from '../Link';
import type { Loadable } from '../RealmChoice';
import { LoadingState, Notice, ReadProblem } from '../states';
import { FilterBar } from './FilterBar';
import { directionLabel, provenanceLabel, statusLabel } from './labels';
import { accountName, type References } from './references';

/** StatusBadge (ui-guide.md §4.3): the text always says the status, the colour only repeats it (§4.1). */
export function StatusBadge({ code }: { readonly code: string }) {
  return <Badge label={statusLabel(code)} />;
}

/** The field errors of a refused list read, by parameter name; the ones the filter bar has no control for stay out. */
export function listFieldErrors(error: unknown): ReadonlyMap<string, readonly FieldError[]> {
  const map = new Map<string, FieldError[]>();
  if (!(error instanceof ApiError)) return map;
  for (const entry of partitionFieldErrors(error.fields, LIST_FIELD_NAMES).known) map.set(entry.field, [...(map.get(entry.field) ?? []), entry]);
  return map;
}

const NO_ERRORS: ReadonlyMap<string, readonly FieldError[]> = new Map();

/**
 * The transaction list (ui-guide.md §6.3, §10 step 2): filter bar, table, pages. The list items carry no splits; the
 * detail shows them. Every state is its own text (§7.4, §11): loading, refused, nothing in the Realm, nothing for these
 * filters, a page beyond the last, and the page itself with the server's `total`. No sum of the page is shown (§6.3).
 */
export function TransactionListView(props: {
  readonly realmId: string;
  readonly params: ListParams;
  readonly list: Loadable<PageDto<TransactionDto>>;
  readonly references: References;
  readonly onFilter: (params: ListParams) => void;
  readonly onRetry: () => void;
}) {
  const area = AREAS.find((candidate) => candidate.id === 'buchungen') ?? AREAS[0];
  const listHref = (params: ListParams) => (area === undefined ? '' : areaPath(props.realmId, area, toSearch(params)));
  const resetHref = listHref({ filters: {}, page: '1', pageSize: props.params.pageSize });
  // One map per refusal: the filter bar focuses the first refused control when the map changes, not on every render.
  const failure = props.list.status === 'error' ? props.list.error : undefined;
  const errors = useMemo(() => (failure === undefined ? NO_ERRORS : listFieldErrors(failure)), [failure]);

  return (
    <>
      <FilterBar
        key={toSearch(props.params)}
        params={props.params}
        references={props.references}
        errors={errors}
        resetHref={resetHref}
        onFilter={props.onFilter}
      />
      <section aria-labelledby="ergebnis" className="flex flex-col gap-4">
        <h2 id="ergebnis" className="text-section font-semibold">
          Ergebnis
        </h2>
        <ListContent {...props} listHref={listHref} resetHref={resetHref} />
      </section>
    </>
  );
}

function ListContent(props: {
  readonly realmId: string;
  readonly params: ListParams;
  readonly list: Loadable<PageDto<TransactionDto>>;
  readonly references: References;
  readonly onRetry: () => void;
  readonly listHref: (params: ListParams) => string;
  readonly resetHref: string;
}) {
  const { list, params } = props;
  if (list.status === 'pending') return <LoadingState label="Buchungen werden geladen …" />;
  if (list.status === 'error') {
    return (
      <ReadProblem error={list.error} onRetry={props.onRetry}>
        {list.error instanceof ApiError && list.error.status === 400 && (
          <Link href={props.resetHref} reload>
            Filter zurücksetzen
          </Link>
        )}
      </ReadProblem>
    );
  }
  const page = list.data;
  const pages = pageCount(page.total, page.pageSize);
  if (page.total === 0) {
    return hasFilters(params) ? (
      <Notice tone="info">
        <p>Keine Buchung passt zu diesen Filtern.</p>
        <Link href={props.resetHref} reload>
          Filter zurücksetzen
        </Link>
      </Notice>
    ) : (
      <Notice tone="info">
        <p>In diesem Bestand gibt es noch keine Buchungen. Buchungen entstehen durch einen Bankimport oder eine manuelle Erfassung.</p>
      </Notice>
    );
  }
  if (page.items.length === 0) {
    const last = props.listHref(withPage(params, pages));
    return (
      <Notice tone="warning">
        <p>{`Seite ${page.page} gibt es nicht; die Liste hat ${pages} ${pages === 1 ? 'Seite' : 'Seiten'}.`}</p>
        <Link href={last}>Zur letzten Seite</Link>
      </Notice>
    );
  }
  return (
    <>
      <div className="overflow-x-auto rounded-card border border-border bg-surface">
        <table className="w-full text-left">
          <caption className="sr-only">{`Buchungen, Seite ${page.page} von ${pages}`}</caption>
          <thead className="border-b border-border text-label text-muted">
            <tr>
              <th scope="col" className="p-3">
                Buchungsdatum
              </th>
              <th scope="col" className="p-3 text-right">
                Betrag
              </th>
              <th scope="col" className="p-3">
                Richtung
              </th>
              <th scope="col" className="min-w-[14rem] p-3">
                Gegenpartei und Verwendungszweck
              </th>
              <th scope="col" className="p-3">
                Status
              </th>
              <th scope="col" className="p-3">
                Herkunft
              </th>
              <th scope="col" className="p-3">
                Konto
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {page.items.map((transaction) => (
              <Row key={transaction.transactionId} realmId={props.realmId} transaction={transaction} references={props.references} />
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page.page} pages={pages} total={page.total} params={params} listHref={props.listHref} />
    </>
  );
}

/**
 * One row. At 1280 px the purpose column takes the room and wraps to two lines (Issue #353 des Projektinhabers,
 * 2026-11-12, point 7), the account wraps to at most two lines (Entscheidung des Projektinhabers, 2026-11-13); text cut
 * off at the end of its line or lines has the whole text as `title`.
 */
function Row({ realmId, transaction, references }: { readonly realmId: string; readonly transaction: TransactionDto; readonly references: References }) {
  const date = formatBusinessDate(transaction.bookingDate) ?? transaction.bookingDate;
  const account = accountName(references, transaction.financialAccountId);
  return (
    <tr>
      <td className="p-3">
        <Link href={transactionPath(realmId, transaction.transactionId)} aria-label={`Buchung vom ${date} öffnen`}>
          <DateText value={transaction.bookingDate} />
        </Link>
      </td>
      <td className="p-3 text-right">
        <MoneyText money={transaction.amount} direction={transaction.direction} />
      </td>
      <td className="p-3">{directionLabel(transaction.direction).text}</td>
      <td className="p-3">
        <p className="line-clamp-1" title={transaction.counterpartyNameRaw ?? undefined}>
          {transaction.counterpartyNameRaw ?? <span className="text-muted">Keine Gegenpartei angegeben</span>}
        </p>
        <p className="line-clamp-2 text-label text-muted" title={transaction.description ?? undefined}>
          {transaction.description ?? 'Ohne Verwendungszweck'}
        </p>
      </td>
      <td className="p-3">
        <StatusBadge code={transaction.status} />
      </td>
      <td className="p-3">{provenanceLabel(transaction.provenance).text}</td>
      <td className="p-3">
        {account === undefined ? (
          <IdText id={transaction.financialAccountId} />
        ) : (
          <p className="line-clamp-2 max-w-[12rem]" title={account}>
            {account}
          </p>
        )}
      </td>
    </tr>
  );
}

/** Pages from the server's `total` (ui-guide.md §6.3: "Gesamtanzahl aus total"); links keep the filters (§3.2). */
function Pagination(props: {
  readonly page: number;
  readonly pages: number;
  readonly total: number;
  readonly params: ListParams;
  readonly listHref: (params: ListParams) => string;
}) {
  const previous = props.page > 1 ? props.listHref(withPage(props.params, Math.min(props.page - 1, props.pages))) : undefined;
  const next = props.page < props.pages ? props.listHref(withPage(props.params, props.page + 1)) : undefined;
  return (
    <nav aria-label="Seiten der Buchungsliste" className="flex flex-wrap items-center gap-4">
      {previous === undefined ? (
        <span className="text-muted">Vorherige Seite</span>
      ) : (
        <Link href={previous} rel="prev">
          Vorherige Seite
        </Link>
      )}
      <p className="tabular-nums">{`Seite ${props.page} von ${props.pages} · ${props.total} ${props.total === 1 ? 'Buchung' : 'Buchungen'}`}</p>
      {next === undefined ? (
        <span className="text-muted">Nächste Seite</span>
      ) : (
        <Link href={next} rel="next">
          Nächste Seite
        </Link>
      )}
    </nav>
  );
}
