import type { ReactNode } from 'react';
import { ApiError } from '../../api/errors';
import type { RentReconciliationReadDto } from '../../api/rent-reconciliations';
import type { TransactionRead } from '../../api/transactions';
import { DateText, MoneyText, TimestampText } from '../format';
import type { Loadable } from '../RealmChoice';
import { LoadingState } from '../states';
import { TechnicalDetails } from '../technical';
import { directionLabel } from '../transactions/labels';
import { StatusBadge } from '../transactions/TransactionList';
import { confidenceText, suggestionReasonText, writeBackErrorText } from './rent-labels';
import { Code, ReconciliationBadges, TenantText, TermLink, TermText, TransactionLink } from './RentParts';

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[14rem_1fr]">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** MRE stores a payment's date as `DD/MM/YYYY` text (api-design.md §37.4); shown as the same day, never through `Date`. */
export function mreDateText(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return match === null ? `Datum laut MRE: ${value === '' ? 'leer' : value}` : `${match[1] ?? ''}.${match[2] ?? ''}.${match[3] ?? ''}`;
}

const none = (text = 'Nicht verfügbar') => <span className="text-muted">{text}</span>;

function Who({ at, by }: { readonly at: string | null; readonly by: string | null }) {
  return (
    <>
      <TimestampText value={at} />
      {by !== null && <span className="text-muted"> von {by}</span>}
    </>
  );
}

/**
 * The Transaction of a reconciliation, from the Transaction read the Buchungen area already uses (ui-guide.md §6.6:
 * labels from existing reads, never guessed from ids). A refusal of that read says so and keeps the id and the link.
 */
function TransactionSummary({ realmId, id, read }: { readonly realmId: string; readonly id: string; readonly read: Loadable<TransactionRead> }) {
  if (read.status === 'pending') return <LoadingState label="Buchung wird geladen …" />;
  if (read.status === 'error') {
    const text =
      read.error instanceof ApiError && read.error.status === 404 ? 'Buchung nicht gefunden oder nicht zugänglich' : 'Buchung konnte nicht gelesen werden';
    return (
      <>
        {none(text)} <Code value={id} /> <TransactionLink realmId={realmId} id={id} />
      </>
    );
  }
  const t = read.data.transaction;
  return (
    <>
      <DateText value={t.bookingDate} /> · <MoneyText money={t.amount} direction={t.direction} /> ({directionLabel(t.direction).text}) ·{' '}
      <StatusBadge code={t.status} />
      <span className="block">
        {[t.counterpartyNameRaw, t.description].filter((part) => part !== null).join(' · ') || none('Ohne Gegenpartei und Verwendungszweck')}
      </span>
      <span className="block">
        <TransactionLink realmId={realmId} id={id} />
      </span>
    </>
  );
}

/**
 * One rent reconciliation as the server answered it (api-design.md §37.1–§37.5): status and MRE write-back state as two
 * badges, the Transaction, the MRE Tenant and term (by id; the coverage of the term is linked), the amount, the
 * suggestion's confidence and reason, and every step with its time and person. Read only; the actions are their own
 * sections below it.
 */
export function ReconciliationDetailView({
  realmId,
  r,
  etag,
  transaction,
}: {
  readonly realmId: string;
  readonly r: RentReconciliationReadDto;
  readonly etag: string;
  readonly transaction: Loadable<TransactionRead>;
}) {
  return (
    <section aria-labelledby="zuordnung" className="rounded-card border border-border bg-surface p-6">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 id="zuordnung" className="text-section font-semibold">
          Mietzuordnung
        </h2>
        <ReconciliationBadges r={r} />
      </div>
      <dl className="divide-y divide-border">
        <Row label="Buchung">
          <TransactionSummary realmId={realmId} id={r.transactionId} read={transaction} />
        </Row>
        <Row label="Mieter">
          <TenantText id={r.mreTenantId} />
        </Row>
        <Row label="Termin">
          <TermText term={r.mreRentTerm} /> · <TermLink realmId={realmId} r={r} />
        </Row>
        <Row label={r.status === 'SUGGESTED' ? 'Vorgeschlagener Betrag' : 'Zugeordneter Betrag'}>
          <MoneyText money={r.matchedAmount} />
        </Row>
        <Row label="Vorschlag">
          {suggestionReasonText(r.suggestionReason)} <span className="text-muted">(Sicherheit: {confidenceText(r.confidence)})</span>
        </Row>
        <Row label="Bestätigt">{r.confirmedAt === null ? none('Noch nicht bestätigt') : <Who at={r.confirmedAt} by={r.confirmedBy} />}</Row>
        {r.rejectedAt !== null && (
          <Row label="Abgelehnt">
            <Who at={r.rejectedAt} by={r.rejectedBy} />
            {r.rejectReason !== null && <span className="block">Grund: {r.rejectReason}</span>}
          </Row>
        )}
        {r.releasedAt !== null && (
          <Row label="Aufgehoben">
            <Who at={r.releasedAt} by={r.releasedBy} />
            {r.releaseReason !== null && <span className="block">Grund: {r.releaseReason}</span>}
          </Row>
        )}
        <Row label="Übertragen an MRE">
          {r.mreWrittenBackAt === null ? none('Nicht übertragen') : <Who at={r.mreWrittenBackAt} by={r.mreWrittenBackBy} />}
          {r.mrePayment !== null && (
            <span className="block">
              {'Zahlung in MRE: '}
              {mreDateText(r.mrePayment.date)} · <MoneyText money={r.mrePayment.amount} /> · Kennung <Code value={r.mrePayment.reference} />
            </span>
          )}
        </Row>
        {r.mreWriteBackError !== null && (
          <Row label="Letzter Fehler">
            {writeBackErrorText(r.mreWriteBackError)}
            {r.mreWriteBackFailedAt !== null && (
              <>
                {' am '}
                <TimestampText value={r.mreWriteBackFailedAt} />
              </>
            )}
          </Row>
        )}
        {r.mreRemovedAt !== null && (
          <Row label="Aus MRE entfernt">
            <Who at={r.mreRemovedAt} by={r.mreRemovedBy} />
          </Row>
        )}
        {r.notes !== null && <Row label="Notiz">{r.notes}</Row>}
        <Row label="Angelegt">
          <TimestampText value={r.createdAt} />
        </Row>
      </dl>
      <TechnicalDetails
        entries={[
          ['Zuordnungs-ID', r.reconciliationId],
          ['Version', `${r.version} (ETag ${etag})`],
          ['Buchungs-ID', r.transactionId],
        ]}
      />
    </section>
  );
}
