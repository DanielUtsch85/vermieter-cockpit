import type { ReactNode } from 'react';
import { ApiError } from '../../api/errors';
import type { TransactionRead, TransactionSplitDto } from '../../api/transactions';
import { formatBusinessDate } from '../../format/dates';
import { onLinkClick } from '../../navigation';
import { transactionPath } from '../../routing';
import { DateText, MoneyText, TimestampText } from '../format';
import type { Loadable } from '../RealmChoice';
import { LoadingState, ReadProblem } from '../states';
import { correctionRoleLabel, directionLabel, provenanceLabel } from './labels';
import { accountName, categoryName, propertyName, type References } from './references';
import { StatusBadge } from './TransactionList';

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[14rem_1fr]">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const Id = ({ value }: { readonly value: string }) => <code className="font-mono text-label">{value}</code>;

function TransactionLink({ realmId, id, children }: { readonly realmId: string; readonly id: string; readonly children: ReactNode }) {
  const href = transactionPath(realmId, id);
  return (
    <a className="text-primary underline" href={href} onClick={(event) => onLinkClick(event, href)}>
      {children}
    </a>
  );
}

/** Breadcrumbs (ui-guide.md §3.2: sub-pages with breadcrumbs): Buchungen › this Transaction. */
function Breadcrumbs({ listHref, current }: { readonly listHref: string; readonly current: string }) {
  return (
    <nav aria-label="Brotkrumen">
      <ol className="flex flex-wrap gap-2 text-label text-muted">
        <li>
          <a className="text-primary underline" href={listHref} onClick={(event) => onLinkClick(event, listHref)}>
            Buchungen
          </a>
          <span aria-hidden="true"> ›</span>
        </li>
        <li aria-current="page">{current}</li>
      </ol>
    </nav>
  );
}

/**
 * One Transaction (ui-guide.md §6.3, §10 step 2): date, amount and direction, counterparty, purpose, origin, status,
 * account with its name, references of the splits, and the correction chain as the visible history (§6.1: no audit
 * timeline in version 1). Read only: splitting, confirming and correcting are steps 3 and 4, so no button offers them
 * yet (§3.2: no control without a data path). A `404` says "not found or not accessible", never where it might exist.
 */
export function TransactionDetailView(props: {
  readonly realmId: string;
  readonly read: Loadable<TransactionRead>;
  readonly references: References;
  readonly listHref: string;
  readonly onRetry: () => void;
}) {
  const { read } = props;
  if (read.status === 'pending') {
    return (
      <>
        <Breadcrumbs listHref={props.listHref} current="Buchung" />
        <LoadingState label="Buchung wird geladen …" />
      </>
    );
  }
  if (read.status === 'error') {
    return (
      <>
        <Breadcrumbs listHref={props.listHref} current="Buchung" />
        <ReadProblem error={read.error} onRetry={props.onRetry}>
          {read.error instanceof ApiError && read.error.status === 404 && (
            <a className="text-primary underline" href={props.listHref} onClick={(event) => onLinkClick(event, props.listHref)}>
              Zur Buchungsliste
            </a>
          )}
        </ReadProblem>
      </>
    );
  }
  const { transaction: t, etag } = read.data;
  const title = `Buchung vom ${formatBusinessDate(t.bookingDate) ?? t.bookingDate}`;
  const references = props.references;
  return (
    <>
      <Breadcrumbs listHref={props.listHref} current={title} />
      <section aria-labelledby="buchung" className="rounded-card border border-border bg-surface p-6">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h2 id="buchung" className="text-section font-semibold">
            {title}
          </h2>
          <StatusBadge code={t.status} />
        </div>
        <dl className="divide-y divide-border">
          <Row label="Betrag">
            <MoneyText money={t.amount} direction={t.direction} /> <span className="text-muted">({directionLabel(t.direction).text})</span>
          </Row>
          <Row label="Buchungsdatum">
            <DateText value={t.bookingDate} />
          </Row>
          <Row label="Wertstellung">
            <DateText value={t.valueDate} />
          </Row>
          <Row label="Gegenpartei">
            {t.counterpartyNameRaw === null && t.counterpartyIbanRaw === null ? (
              <span className="text-muted">Keine Angabe (nur bei Bankimporten vorhanden)</span>
            ) : (
              <>
                {t.counterpartyNameRaw ?? <span className="text-muted">Name nicht angegeben</span>}
                {t.counterpartyIbanRaw !== null && <span className="block font-mono text-label">{t.counterpartyIbanRaw}</span>}
                <span className="block text-label text-muted">Wie in der Bankdatei angegeben</span>
              </>
            )}
          </Row>
          <Row label="Verwendungszweck">{t.description ?? <span className="text-muted">Ohne Verwendungszweck</span>}</Row>
          <Row label="Herkunft">{provenanceLabel(t.provenance).text}</Row>
          <Row label="Konto">
            {accountName(references, t.financialAccountId) ?? <span className="text-muted">Name nicht verfügbar</span>} <Id value={t.financialAccountId} />
          </Row>
          <Row label="Objekt der Buchung">
            {t.propertyReferenceId === null ? (
              <span className="text-muted">Keines (Objekte können auch an der Aufteilung hängen)</span>
            ) : (
              <>
                {propertyName(references, t.propertyReferenceId) ?? <span className="text-muted">Name nicht verfügbar</span>}{' '}
                <Id value={t.propertyReferenceId} />
              </>
            )}
          </Row>
          <Row label="Angelegt">
            <TimestampText value={t.createdAt} />
          </Row>
          <Row label="Bestätigt">
            {t.confirmedAt === null ? (
              <span className="text-muted">Noch nicht bestätigt</span>
            ) : (
              <>
                <TimestampText value={t.confirmedAt} />
                {t.confirmedBy !== null && <span className="text-muted"> von {t.confirmedBy}</span>}
              </>
            )}
          </Row>
          <Row label="Version">
            <span className="tabular-nums">{t.version}</span>
            {etag !== undefined && <span className="text-label text-muted"> (ETag {etag})</span>}
          </Row>
        </dl>
      </section>
      <CorrectionChain realmId={props.realmId} transaction={t} />
      <Splits splits={read.data.transaction.splits} references={references} />
    </>
  );
}

/** The correction chain (api-design.md §35.4): original, reversal and replacement, each a link to its own detail. */
function CorrectionChain({ realmId, transaction: t }: { readonly realmId: string; readonly transaction: TransactionRead['transaction'] }) {
  const links: ReactNode[] = [];
  if (t.correctionRole !== null && t.correctionOfTransactionId !== null) {
    links.push(
      <li key="of">
        {`${correctionRoleLabel(t.correctionRole).text} zur `}
        <TransactionLink realmId={realmId} id={t.correctionOfTransactionId}>
          korrigierten Buchung
        </TransactionLink>
      </li>,
    );
  }
  if (t.reversalTransactionId !== null) {
    links.push(
      <li key="reversal">
        <TransactionLink realmId={realmId} id={t.reversalTransactionId}>
          Storno dieser Buchung
        </TransactionLink>
      </li>,
    );
  }
  if (t.replacementTransactionId !== null) {
    links.push(
      <li key="replacement">
        <TransactionLink realmId={realmId} id={t.replacementTransactionId}>
          Ersatzbuchung
        </TransactionLink>
      </li>,
    );
  }
  return (
    <section aria-labelledby="korrektur" className="rounded-card border border-border bg-surface p-6">
      <h3 id="korrektur" className="mb-2 text-section font-semibold">
        Korrekturen
      </h3>
      {links.length === 0 ? <p className="text-muted">Keine Korrektur verknüpft.</p> : <ul className="flex flex-col gap-1">{links}</ul>}
    </section>
  );
}

/** The references a split names (api-design.md §33.2); each id with the name where the client has one. */
function SplitReferences({ split, references }: { readonly split: TransactionSplitDto; readonly references: References }) {
  const entries: ReactNode[] = [];
  if (split.propertyReferenceId !== null) {
    entries.push(
      <li key="property">
        Objekt: {propertyName(references, split.propertyReferenceId) ?? 'Name nicht verfügbar'} <Id value={split.propertyReferenceId} />
      </li>,
    );
  }
  const ids = [
    ['loan', 'Darlehen', split.loanId],
    ['deposit', 'Kaution', split.securityDepositId],
    ['statement', 'WEG-Jahresabrechnung', split.wegAnnualStatementId],
    ['assessment', 'Sonderumlage', split.wegSpecialAssessmentId],
  ] as const;
  for (const [key, label, id] of ids) {
    if (id !== null) {
      entries.push(
        <li key={key}>
          {label}: <Id value={id} />
        </li>,
      );
    }
  }
  return entries.length === 0 ? <span className="text-muted">Kein Bezug</span> : <ul>{entries}</ul>;
}

function Splits({ splits, references }: { readonly splits: readonly TransactionSplitDto[]; readonly references: References }) {
  return (
    <section aria-labelledby="aufteilung" className="rounded-card border border-border bg-surface p-6">
      <h3 id="aufteilung" className="mb-2 text-section font-semibold">
        Aufteilung
      </h3>
      {splits.length === 0 ? (
        <p className="text-muted">Noch nicht aufgeteilt. Das Aufteilen entsteht im Durchstich Schritt 3.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">Aufteilung der Buchung</caption>
            <thead className="border-b border-border text-label text-muted">
              <tr>
                <th scope="col" className="p-2">
                  Position
                </th>
                <th scope="col" className="p-2">
                  Kategorie
                </th>
                <th scope="col" className="p-2 text-right">
                  Betrag
                </th>
                <th scope="col" className="p-2">
                  Bezug
                </th>
                <th scope="col" className="p-2">
                  Beschreibung
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {splits.map((split) => (
                <tr key={split.splitId}>
                  <td className="p-2 tabular-nums">{split.position}</td>
                  <td className="p-2">
                    {categoryName(references, split.financialCategoryCode) ?? <span className="text-muted">Unbekannte Kategorie</span>}{' '}
                    <Id value={split.financialCategoryCode} />
                  </td>
                  <td className="p-2 text-right">
                    <MoneyText money={split.amount} />
                  </td>
                  <td className="p-2">
                    <SplitReferences split={split} references={references} />
                  </td>
                  <td className="p-2">{split.description ?? <span className="text-muted">Ohne Beschreibung</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
