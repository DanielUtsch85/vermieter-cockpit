import type { RentReconciliationDto } from '../../api/rent-reconciliations';
import type { PageDto } from '../../api/transactions';
import { MoneyText } from '../format';
import type { Loadable } from '../RealmChoice';
import { LoadingState, ReadProblem } from '../states';
import { STATUS_FILTERS } from './rent-labels';
import { Link, ReconciliationBadges, ReconciliationLink, TenantText, TermLink, TermText, TransactionLink } from './RentParts';

/** The list's filter and page in the URL (ui-guide.md §3.2): `?status=CONFIRMED&page=2`; `alle` lists every status. */
export interface RentListParams {
  /** undefined: every status. */
  readonly status: string | undefined;
  readonly page: number;
}

const ALL = 'alle';

export function readRentListParams(search: string): RentListParams {
  const params = new URLSearchParams(search);
  const status = params.get('status');
  const page = params.get('page') ?? '1';
  return {
    status: status === ALL ? undefined : STATUS_FILTERS.some(([code]) => code !== undefined && code === status) ? (status ?? undefined) : 'SUGGESTED',
    page: /^[1-9]\d{0,5}$/.test(page) ? Number(page) : 1,
  };
}

export function rentListSearch(params: RentListParams): string {
  const search = new URLSearchParams({ status: params.status ?? ALL });
  if (params.page > 1) search.set('page', String(params.page));
  return `?${search.toString()}`;
}

const EMPTY: Readonly<Record<string, string>> = {
  SUGGESTED: 'Keine offenen Vorschläge. Das heißt nicht, dass alle Mieten bezahlt sind: oben einen Zeitraum ermitteln.',
  CONFIRMED: 'Keine bestätigten Zuordnungen.',
  RELEASED: 'Keine aufgehobenen Zuordnungen.',
  REJECTED: 'Keine abgelehnten Vorschläge.',
};

/**
 * The reconciliations of the Realm (api-design.md §37.1: newest first), one status at a time, with their references:
 * the Transaction (a link), the MRE Tenant and term by id, the amount, and status and write-back state as two badges.
 * Loading, empty and error are distinct states (ui-guide.md §7.4); pages from the server's `total`.
 */
export function ReconciliationListView(props: {
  readonly realmId: string;
  readonly params: RentListParams;
  readonly list: Loadable<PageDto<RentReconciliationDto>>;
  readonly href: (params: RentListParams) => string;
  readonly onRetry: () => void;
}) {
  const { params, list } = props;
  return (
    <section aria-labelledby="zuordnungen" className="rounded-card border border-border bg-surface p-6">
      <h2 id="zuordnungen" className="mb-2 text-section font-semibold">
        Vorschläge und Zuordnungen
      </h2>
      <nav aria-label="Status der Zuordnungen">
        <ul className="mb-3 flex flex-wrap gap-4">
          {STATUS_FILTERS.map(([code, label]) => (
            <li key={label}>
              {code === params.status ? (
                <span aria-current="page" className="font-semibold">
                  {label}
                </span>
              ) : (
                <Link href={props.href({ status: code, page: 1 })}>{label}</Link>
              )}
            </li>
          ))}
        </ul>
      </nav>
      {list.status === 'pending' ? (
        <LoadingState label="Zuordnungen werden geladen …" />
      ) : list.status === 'error' ? (
        <ReadProblem error={list.error} onRetry={props.onRetry} />
      ) : list.data.total === 0 ? (
        <p className="text-muted">{params.status === undefined ? 'Noch keine Vorschläge oder Zuordnungen.' : (EMPTY[params.status] ?? 'Keine Einträge.')}</p>
      ) : (
        <Rows {...props} page={list.data} />
      )}
    </section>
  );
}

function Rows(props: {
  readonly realmId: string;
  readonly params: RentListParams;
  readonly page: PageDto<RentReconciliationDto>;
  readonly href: (params: RentListParams) => string;
}) {
  const { page } = props;
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  if (page.items.length === 0) {
    return (
      <p>
        {`Seite ${page.page} gibt es nicht. `}
        <Link href={props.href({ ...props.params, page: pages })}>Zur letzten Seite</Link>
      </p>
    );
  }
  return (
    <>
      <ul aria-label={`Zuordnungen, Seite ${page.page} von ${pages}`} className="flex flex-col divide-y divide-border">
        {page.items.map((r) => (
          <li key={r.reconciliationId} className="flex flex-col gap-1 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <MoneyText money={r.matchedAmount} />
              <ReconciliationBadges r={r} />
            </div>
            <div>
              <TenantText id={r.mreTenantId} /> · <TermText term={r.mreRentTerm} />
            </div>
            <div className="flex flex-wrap gap-4">
              <ReconciliationLink realmId={props.realmId} id={r.reconciliationId}>
                {r.status === 'SUGGESTED' ? 'Vorschlag prüfen' : 'Zuordnung öffnen'}
              </ReconciliationLink>
              <TransactionLink realmId={props.realmId} id={r.transactionId} />
              <TermLink realmId={props.realmId} r={r} />
            </div>
          </li>
        ))}
      </ul>
      <nav aria-label="Seiten" className="mt-3 flex flex-wrap items-center gap-4">
        {page.page > 1 && <Link href={props.href({ ...props.params, page: page.page - 1 })}>Vorherige Seite</Link>}
        <p className="tabular-nums">{`Seite ${page.page} von ${pages} · ${page.total} ${page.total === 1 ? 'Eintrag' : 'Einträge'}`}</p>
        {page.page < pages && <Link href={props.href({ ...props.params, page: page.page + 1 })}>Nächste Seite</Link>}
      </nav>
    </>
  );
}
