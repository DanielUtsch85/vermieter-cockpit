import type { CreateReconciliationInputDto, ReconciliationChanged, TransactionRentCoverageDto } from '../../api/rent-reconciliations';
import { MoneyText } from '../format';
import type { Loadable } from '../RealmChoice';
import { LoadingState, ReadProblem } from '../states';
import { ManualMatch } from './ManualMatch';
import { ReconciliationBadges, ReconciliationLink, TenantText, TermLink, TermText } from './RentParts';
import type { RentChoices } from './TenantTermChoice';

/**
 * The rent reconciliations of one Transaction (api-design.md §37.2, `GET /transactions/{id}/rent-reconciliations`;
 * ui-guide.md §6.6 "Abdeckungsansicht"): its rent cash, what is matched and what is still free, and every
 * reconciliation in any status with its two badges and a link to it, where its actions are. The read never calls MRE.
 * Its one action is „Manuell zuordnen“ (step 8, `ManualMatch`), offered while the booking has free rent cash; it is
 * shown only when the page passes `create`.
 */
export function TransactionRentSection({
  realmId,
  coverage,
  onRetry,
  create,
  onCreated,
  choices,
}: {
  readonly realmId: string;
  readonly coverage: Loadable<TransactionRentCoverageDto>;
  readonly onRetry: () => void;
  readonly create?: (body: CreateReconciliationInputDto, idempotencyKey: string) => Promise<ReconciliationChanged>;
  readonly onCreated?: () => void;
  /** #364: the lists „Manuell zuordnen“ chooses the Tenant and the term from (api-design.md §37.7). */
  readonly choices?: RentChoices;
}) {
  return (
    <section aria-labelledby="buchung-mietabgleich" className="rounded-card border border-border bg-surface p-6">
      <h2 id="buchung-mietabgleich" className="mb-2 text-section font-semibold">
        Mietabgleich dieser Buchung
      </h2>
      {coverage.status === 'pending' ? (
        <LoadingState label="Mietabgleich wird geladen …" />
      ) : coverage.status === 'error' ? (
        <ReadProblem error={coverage.error} onRetry={onRetry} />
      ) : (
        <>
          <Coverage realmId={realmId} c={coverage.data} />
          {create !== undefined && (
            <ManualMatch
              key={coverage.data.transactionId}
              realmId={realmId}
              coverage={coverage.data}
              create={create}
              onCreated={() => onCreated?.()}
              {...(choices === undefined ? {} : { choices })}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * „Noch frei“ is §37.2's `available` only for an `INFLOW`: an `OUTFLOW` with a rent split (e.g. a repaid rent) can never
 * be matched (§37.1 `TRANSACTION_NOT_INFLOW`), so the read's free amount is not shown as free but as „nicht zuordenbar“,
 * as the list shows no `rentAllocation` for it (§30.1A; #381). (Entscheidung des Projektinhabers, 2026-11-17): „Eine zurückgezahlte
 * Miete ist nicht zuordenbar, also soll das Detail unter „Noch frei“ dasselbe sagen wie die Liste: „Nicht zuordenbar
 * (Ausgang)“ statt eines Betrags.“
 */
function Coverage({ realmId, c }: { readonly realmId: string; readonly c: TransactionRentCoverageDto }) {
  return (
    <>
      {c.rentCash === null ? (
        <p className="text-muted">Kein Mietanteil: die Aufteilung hat keine Mietkategorie.</p>
      ) : (
        <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[16rem_1fr]">
          <dt className="text-muted">Mietanteil der Buchung</dt>
          <dd>
            <MoneyText money={c.rentCash} />
          </dd>
          <dt className="text-muted">Davon bestätigt zugeordnet</dt>
          <dd>
            <MoneyText money={c.matchedTotal} />
          </dd>
          <dt className="text-muted">Noch frei</dt>
          <dd>
            {c.direction !== 'INFLOW' ? (
              <span className="text-muted">Nicht zuordenbar (Ausgang)</span>
            ) : c.available === null ? (
              <span className="text-muted">Nicht zuordenbar, solange die Buchung nicht bestätigt ist (oder ein Storno ist)</span>
            ) : (
              <MoneyText money={c.available} />
            )}
          </dd>
        </dl>
      )}
      {c.reconciliations.length === 0 ? (
        <p className="mt-2 text-muted">Keine Mietzuordnung.</p>
      ) : (
        <ul aria-label="Mietzuordnungen der Buchung" className="mt-3 flex flex-col gap-2">
          {c.reconciliations.map((r) => (
            <li key={r.reconciliationId} className="flex flex-wrap items-center gap-2">
              <MoneyText money={r.matchedAmount} /> <ReconciliationBadges r={r} /> <TenantText id={r.mreTenantId} /> · <TermText term={r.mreRentTerm} /> ·{' '}
              <ReconciliationLink realmId={realmId} id={r.reconciliationId} /> · <TermLink realmId={realmId} r={r} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
