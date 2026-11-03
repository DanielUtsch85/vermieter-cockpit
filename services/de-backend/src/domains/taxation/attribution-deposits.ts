import type { BusinessDate, Money } from '../../shared/index.js';
import { replay, walk, type HistoryRecord } from './attribution-history.js';
import { recordedAfter } from './attribution-rule.js';
import { yearOf } from './cash-timing.js';
import type { Part } from './attribution-parts.js';

/**
 * The deposit's PropertyReference as an input of `PROPERTY_PART_CHANGED` (api-design.md §58H Part 2, VC-X-49;
 * Entscheidung des Projektinhabers, 2026-11-03, Frage 2: §58G's flag). A retained deposit counts in the year of its
 * closing date and in the view of the one PropertyReference its Tenant's `CONFIRMED` reconciliations' rent splits are
 * booked on (§58A); none or several: not attributed, listed in every view (`NO_RECONCILED_RENT`) or in each candidate's
 * (`SEVERAL_PROPERTY_REFERENCES`). A reconciliation confirmed or released moves the deposit between views, never its
 * year. Each `CONFIRMED`/`RELEASED` record of the Tenant's reconciliations, at any date, is a step: the Tenant's set of
 * `CONFIRMED` reconciliations just before and just after it (replayed as §58E's reconciliation kinds), the deposit's
 * PropertyReference derived from each side, P's state and part per side. Which step is a change is §58G's rule
 * (`attribution-parts.ts`). A reopen with a new closing and a split correction are not here (Frage 3: VC-X-50).
 */

/** A reconciliation of the Tenant that is or was `CONFIRMED`, with its records and its rent splits' PropertyReferences. */
export interface DepositReconciliationHistory {
  readonly reconciliationId: string;
  readonly transactionId: string;
  readonly mreRentTerm: string;
  /** Its status now is `CONFIRMED`. */
  readonly confirmedNow: boolean;
  readonly records: readonly HistoryRecord[];
  /** The PropertyReferences of its Transaction's rent splits, as now (§58A's derivation). */
  readonly propertyReferenceIds: readonly string[];
}

/** A counting deposit closing of the Realm (`CLOSED`, a retained amount), with its Tenant's reconciliations. */
export interface DepositPartHistory {
  readonly securityDepositId: string;
  readonly mreTenantId: string;
  readonly closingDate: BusinessDate;
  readonly retainedAmount: Money;
  readonly reconciliations: readonly DepositReconciliationHistory[];
}

/** One record of a Tenant's reconciliations with P's part of each candidate deposit on both sides. */
export interface DepositStep {
  readonly kind: 'DEPOSIT_RECONCILIATION_CONFIRMED' | 'DEPOSIT_RECONCILIATION_RELEASED';
  readonly reconciliation: DepositReconciliationHistory;
  readonly mreTenantId: string;
  readonly record: HistoryRecord;
  readonly deposits: readonly { readonly securityDepositId: string; readonly before: Part; readonly after: Part }[];
}

/**
 * P's part of a deposit under one side's `CONFIRMED` reconciliations (§58H Part 2): `ATTRIBUTED` with the retained
 * amount when its one PropertyReference is P; `NOT_ATTRIBUTED` when it has none and P's view lists it (no candidate: every
 * view; several: each candidate's); `NONE` otherwise.
 */
export function depositPartOn(propertyReferenceId: string, confirmed: readonly DepositReconciliationHistory[], retainedAmount: Money): Part {
  const candidates = [...new Set(confirmed.flatMap((r) => r.propertyReferenceIds))];
  if (candidates.length === 1) return candidates[0] === propertyReferenceId ? { state: 'ATTRIBUTED', part: retainedAmount } : { state: 'NONE', part: null };
  return candidates.length === 0 || candidates.includes(propertyReferenceId) ? { state: 'NOT_ATTRIBUTED', part: null } : { state: 'NONE', part: null };
}

/**
 * Every record of the candidate deposits' Tenants' reconciliations made after 31 December of `year` (§58E's rule), with
 * P's part of each of the Tenant's deposits closed in `year` on both sides; and the reconciliations whose history does
 * not end in their status now (`ATTRIBUTION_HISTORY_INCONSISTENT`, their records unused, their status now held), named
 * where the Tenant's deposit concerns P (P among its candidates on some side, or listed in every view now).
 */
export function depositSteps(
  deposits: readonly DepositPartHistory[] | undefined,
  year: number,
  propertyReferenceId: string,
): { steps: DepositStep[]; inconsistent: { readonly entityType: 'RentPaymentReconciliation'; readonly entityId: string }[] } {
  const steps: DepositStep[] = [];
  const inconsistent = new Set<string>();
  // The candidates: counting closings (a retained amount) of `year`, their tax year by the closing date (§58A).
  const candidates = (deposits ?? []).filter((d) => yearOf(d.closingDate) === year && d.retainedAmount.isPositive());
  for (const tenant of [...new Set(candidates.map((d) => d.mreTenantId))].sort()) {
    const own = candidates.filter((d) => d.mreTenantId === tenant).sort((a, b) => (a.securityDepositId < b.securityDepositId ? -1 : 1));
    const byId = new Map(own.flatMap((d) => d.reconciliations).map((r) => [r.reconciliationId, r] as const));
    const reconciliations = [...byId.values()].sort((a, b) => (a.reconciliationId < b.reconciliationId ? -1 : 1));
    const histories = new Map(reconciliations.map((r) => [r.reconciliationId, replay(r.records, 'CONFIRMED', 'RELEASED', r.confirmedNow)] as const));
    const concerns =
      reconciliations.some((r) => r.propertyReferenceIds.includes(propertyReferenceId)) ||
      own.some(
        (d) =>
          depositPartOn(
            propertyReferenceId,
            reconciliations.filter((r) => r.confirmedNow),
            d.retainedAmount,
          ).state !== 'NONE',
      );
    for (const r of reconciliations) if (concerns && histories.get(r.reconciliationId) === undefined) inconsistent.add(r.reconciliationId);
    for (const step of walk(
      reconciliations,
      (r) => r.reconciliationId,
      (r) => histories.get(r.reconciliationId),
      (r) => r.confirmedNow,
      'CONFIRMED',
    )) {
      if (!recordedAfter(step.record.occurredAt, year)) continue;
      steps.push({
        kind: step.record.action === 'CONFIRMED' ? 'DEPOSIT_RECONCILIATION_CONFIRMED' : 'DEPOSIT_RECONCILIATION_RELEASED',
        reconciliation: step.entity,
        mreTenantId: tenant,
        record: step.record,
        deposits: own.map((d) => ({
          securityDepositId: d.securityDepositId,
          before: depositPartOn(propertyReferenceId, step.before, d.retainedAmount),
          after: depositPartOn(propertyReferenceId, step.after, d.retainedAmount),
        })),
      });
    }
  }
  return { steps, inconsistent: [...inconsistent].sort().map((entityId) => ({ entityType: 'RentPaymentReconciliation', entityId })) };
}
