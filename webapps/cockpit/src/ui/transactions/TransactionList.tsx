import { useMemo } from 'react';
import { ApiError, partitionFieldErrors, type FieldError } from '../../api/errors';
import type { PageDto, TransactionDto } from '../../api/transactions';
import { onLinkClick } from '../../navigation';
import { AREAS, areaPath, transactionPath } from '../../routing';
import { hasFilters, LIST_FIELD_NAMES, pageCount, toSearch, withPage, type ListParams } from '../../transactions/list-params';
import { formatBusinessDate } from '../../format/dates';
import { DateText, MoneyText } from '../format';
import type { Loadable } from '../RealmChoice';
import { LoadingState, Notice, ReadProblem } from '../states';
import { FilterBar } from './FilterBar';
import { directionLabel, provenanceLabel, statusLabel, type Tone } from './labels';
import { accountName, type References } from './references';

const TONES: Readonly<Record<Tone, string>> = {
  warning: 'border-warning-text bg-warning-bg text-warning-text',
  success: 'border-success-text bg-success-bg text-success-text',
  neutral: 'border-border bg-background text-text',
  info: 'border-info-text bg-info-bg text-info-text',
};

/** StatusBadge (ui-guide.md §4.3): the text always says the status, the colour only repeats it (§4.1). */
export function StatusBadge({ code }: { readonly code: string }) {
  const label = statusLabel(code);
  return <span className={`inline-block whitespace-nowrap rounded-input border px-2 text-label ${TONES[label.tone]}`}>{label.text}</span>;
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
          <a className="text-primary underline" href={props.resetHref}>
            Filter zurücksetzen
          </a>
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
        <a className="text-primary underline" href={props.resetHref}>
          Filter zurücksetzen
        </a>
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
        <a className="text-primary underline" href={last} onClick={(event) => onLinkClick(event, last)}>
          Zur letzten Seite
        </a>
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
              <th scope="col" className="p-3">
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

function Row({ realmId, transaction, references }: { readonly realmId: string; readonly transaction: TransactionDto; readonly references: References }) {
  const href = transactionPath(realmId, transaction.transactionId);
  const date = formatBusinessDate(transaction.bookingDate) ?? transaction.bookingDate;
  return (
    <tr>
      <td className="p-3">
        <a className="text-primary underline" href={href} aria-label={`Buchung vom ${date} öffnen`} onClick={(event) => onLinkClick(event, href)}>
          <DateText value={transaction.bookingDate} />
        </a>
      </td>
      <td className="p-3 text-right">
        <MoneyText money={transaction.amount} direction={transaction.direction} />
      </td>
      <td className="p-3">{directionLabel(transaction.direction).text}</td>
      <td className="max-w-xs p-3">
        <p className="truncate">{transaction.counterpartyNameRaw ?? <span className="text-muted">Keine Gegenpartei angegeben</span>}</p>
        <p className="truncate text-label text-muted">{transaction.description ?? 'Ohne Verwendungszweck'}</p>
      </td>
      <td className="p-3">
        <StatusBadge code={transaction.status} />
      </td>
      <td className="p-3">{provenanceLabel(transaction.provenance).text}</td>
      <td className="p-3">
        {accountName(references, transaction.financialAccountId) ?? <code className="font-mono text-label">{transaction.financialAccountId}</code>}
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
        <a className="text-primary underline" href={previous} rel="prev" onClick={(event) => onLinkClick(event, previous)}>
          Vorherige Seite
        </a>
      )}
      <p className="tabular-nums">{`Seite ${props.page} von ${props.pages} · ${props.total} ${props.total === 1 ? 'Buchung' : 'Buchungen'}`}</p>
      {next === undefined ? (
        <span className="text-muted">Nächste Seite</span>
      ) : (
        <a className="text-primary underline" href={next} rel="next" onClick={(event) => onLinkClick(event, next)}>
          Nächste Seite
        </a>
      )}
    </nav>
  );
}
