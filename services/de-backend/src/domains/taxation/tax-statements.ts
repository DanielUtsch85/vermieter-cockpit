import type { AuditActor, BusinessDate } from '../../shared/index.js';
import type { AllocationBasis, LoanAllocationSetView, LoanStatus } from '../financing/index.js';
import type { AttributionChange, AttributionInput } from './attribution-changes.js';
import type { ChangeEntityType, ChangeItem, ChangeKind } from './attribution-rule.js';
import type { PartChange, PartChangeEntityType, PartChangeInput, PartChangeKind, PartItem } from './attribution-parts.js';

/**
 * A person's statements the tax-year view reads (api-design.md §58E Parts 2 and 3, VC-X-28): the acknowledgement of
 * one attribution change of one PropertyReference and year, matched by its fingerprint, and the tax confirmation of a
 * multi-entry `PURCHASE_PRICE` allocation set as a whole. Both are stored and audited, withdrawable with a reason
 * (decided 2026-11-01, question 2), and clear exactly their own flag (decided 2026-11-02, question 10): no figure,
 * no other flag, no stage of §60A.
 */

export const TAX_STATEMENT_STATUSES = ['ACTIVE', 'WITHDRAWN'] as const;
export type TaxStatementStatus = (typeof TAX_STATEMENT_STATUSES)[number];

export interface StatementWithdrawal {
  readonly withdrawnAt: Date | null;
  readonly withdrawnBy: string | null;
  readonly withdrawReason: string | null;
}

/** A change of either flag (§58G): `ATTRIBUTION_INPUT_CHANGED`'s year shape or `PROPERTY_PART_CHANGED`'s part shape. */
export type AcknowledgedKind = ChangeKind | PartChangeKind;
export type AnyChange = AttributionChange | PartChange;

export interface TaxYearAcknowledgement extends StatementWithdrawal {
  readonly acknowledgementId: string;
  readonly propertyReferenceId: string;
  readonly year: number;
  readonly status: TaxStatementStatus;
  readonly change: {
    readonly auditRecordId: string;
    readonly kind: AcknowledgedKind;
    readonly entityType: ChangeEntityType | PartChangeEntityType;
    readonly entityId: string;
    readonly recordedAt: Date;
    readonly fingerprint: string;
    /** The year shape for a kind of §58E Part 1, the part shape for a kind of §58G (`change.kind` tells which). */
    readonly items: readonly (ChangeItem | PartItem)[];
  };
  readonly reason: string;
  readonly acknowledgedAt: Date;
  readonly acknowledgedBy: string;
  readonly version: number;
}

export interface LoanAllocationTaxConfirmation extends StatementWithdrawal {
  readonly confirmationId: string;
  readonly loanId: string;
  readonly allocationSetId: string;
  readonly status: TaxStatementStatus;
  /** Read from the set, never stored again. */
  readonly set: {
    readonly validFrom: BusinessDate;
    readonly basis: AllocationBasis;
    readonly allocations: readonly { readonly propertyReferenceId: string; readonly share: string; readonly acquisitionId: string | null }[];
  };
  readonly reason: string;
  readonly advisorPartyId: string | null;
  readonly confirmedAt: Date;
  readonly confirmedBy: string;
  readonly version: number;
}

/** An entry's `acknowledgement` in the view (§58E "The flag, additively"). */
export interface AcknowledgementMark {
  readonly acknowledgementId: string;
  readonly acknowledgedAt: string;
  readonly acknowledgedBy: string;
}

/** The flag's `confirmation` and `Item.loanAllocation.taxConfirmation` (§58E "In the view"). */
export interface ConfirmationMark {
  readonly confirmationId: string;
  readonly confirmedAt: string;
  readonly confirmedBy: string;
  readonly advisorPartyId: string | null;
}

/**
 * The `ACTIVE` acknowledgement matching a change (§58E Part 2): the same PropertyReference and year (the caller reads
 * only those), the same `auditRecordId` and the same fingerprint; a withdrawn one never counts.
 */
export function matchAcknowledgement(
  change: Pick<AnyChange, 'auditRecordId' | 'changeFingerprint'>,
  acknowledgements: readonly TaxYearAcknowledgement[],
): AcknowledgementMark | null {
  const found = acknowledgements.find(
    (a) => a.status === 'ACTIVE' && a.change.auditRecordId === change.auditRecordId && a.change.fingerprint === change.changeFingerprint,
  );
  return found === undefined
    ? null
    : { acknowledgementId: found.acknowledgementId, acknowledgedAt: found.acknowledgedAt.toISOString(), acknowledgedBy: found.acknowledgedBy };
}

/** The `ACTIVE` confirmation of a set as the view shows it, or `null`. */
export function confirmationMark(confirmation: LoanAllocationTaxConfirmation | undefined): ConfirmationMark | null {
  return confirmation === undefined || confirmation.status !== 'ACTIVE'
    ? null
    : {
        confirmationId: confirmation.confirmationId,
        confirmedAt: confirmation.confirmedAt.toISOString(),
        confirmedBy: confirmation.confirmedBy,
        advisorPartyId: confirmation.advisorPartyId,
      };
}

/** Why a set takes no confirmation (§58E Part 3, step 4). */
export type NothingToConfirmCause = 'LOAN_VOID' | 'SET_VOID' | 'NOT_PURCHASE_PRICE' | 'SINGLE_ENTRY';

/** A `CLOSED` Loan's set can be confirmed: its interest up to the closing stays in the views. */
export function nothingToConfirm(loanStatus: LoanStatus, set: Pick<LoanAllocationSetView, 'status' | 'basis' | 'allocations'>): NothingToConfirmCause | null {
  if (loanStatus === 'VOID') return 'LOAN_VOID';
  if (set.status === 'VOID') return 'SET_VOID';
  if (set.basis !== 'PURCHASE_PRICE') return 'NOT_PURCHASE_PRICE';
  if (set.allocations.length < 2) return 'SINGLE_ENTRY';
  return null;
}

export type AcknowledgeDecision =
  | { readonly kind: 'NOT_FLAGGED' }
  | { readonly kind: 'AMBIGUOUS'; readonly kinds: readonly AcknowledgedKind[] }
  | { readonly kind: 'DIFFERS'; readonly currentFingerprint: string }
  | { readonly kind: 'NOOP'; readonly acknowledgement: TaxYearAcknowledgement }
  | { readonly kind: 'CREATE'; readonly change: AnyChange };

/**
 * Steps 3–5 of the acknowledgement's order of checks (§58E Part 2, step 3 widened by §58G): the change among both flags'
 * changes of the year derived in the command's snapshot, taken by `auditRecordId` and, when given, `kind`; a record that
 * is more than one change without `kind` is `AMBIGUOUS` (Entscheidung des Projektinhabers, 2026-11-03, Frage 4); then its
 * fingerprint the one the person saw, then the no-op over the `ACTIVE` acknowledgements.
 */
export function planAcknowledgement(
  changes: readonly AnyChange[],
  request: { readonly auditRecordId: string; readonly expectedFingerprint: string; readonly kind?: AcknowledgedKind },
  active: readonly TaxYearAcknowledgement[],
): AcknowledgeDecision {
  const found = changes.filter((c) => c.auditRecordId === request.auditRecordId && (request.kind === undefined || c.kind === request.kind));
  const [change] = found;
  if (change === undefined) return { kind: 'NOT_FLAGGED' };
  if (found.length > 1) return { kind: 'AMBIGUOUS', kinds: [...new Set(found.map((c) => c.kind))].sort() };
  if (change.changeFingerprint !== request.expectedFingerprint) return { kind: 'DIFFERS', currentFingerprint: change.changeFingerprint };
  const same = active.find(
    (a) => a.status === 'ACTIVE' && a.change.auditRecordId === change.auditRecordId && a.change.fingerprint === change.changeFingerprint,
  );
  return same === undefined ? { kind: 'CREATE', change } : { kind: 'NOOP', acknowledgement: same };
}

export type AcknowledgeOutcome =
  | { readonly kind: 'CREATED' | 'UNCHANGED'; readonly acknowledgement: TaxYearAcknowledgement; readonly replayed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_FLAGGED' }
  | { readonly kind: 'AMBIGUOUS'; readonly kinds: readonly AcknowledgedKind[] }
  | { readonly kind: 'DIFFERS'; readonly currentFingerprint: string }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'SERIALIZATION_FAILURE' };

export type ConfirmOutcome =
  | { readonly kind: 'CREATED' | 'UNCHANGED'; readonly confirmation: LoanAllocationTaxConfirmation; readonly replayed: boolean }
  | { readonly kind: 'LOAN_NOT_FOUND' }
  | { readonly kind: 'SET_NOT_FOUND' }
  | { readonly kind: 'ADVISOR_NOT_FOUND' }
  | { readonly kind: 'NOTHING_TO_CONFIRM'; readonly cause: NothingToConfirmCause }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' };

export type WithdrawOutcome<S> =
  | { readonly kind: 'WITHDRAWN'; readonly statement: S; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'VERSION_CONFLICT'; readonly currentVersion: number };

/** The port of both statements (§58E "In the database"); the PostgreSQL adapter keeps the orders of checks and locks. */
export interface TaxStatementRepository {
  acknowledge(input: {
    readonly propertyReferenceId: string;
    readonly year: number;
    readonly mreRealmId: string;
    readonly actor: AuditActor;
    readonly reason: string;
    /** The business day the meanings are derived on (only `RULE_SUPERSEDED` depends on it, never a tax year). */
    readonly today: BusinessDate;
    readonly idempotency?: { readonly key: string; readonly fingerprint: string };
    /** Steps 3–5, on the inputs of both flags read in the command's snapshot (§58E Part 1, §58G). */
    readonly decide: (
      inputs: { readonly attribution: AttributionInput; readonly parts: PartChangeInput },
      active: readonly TaxYearAcknowledgement[],
    ) => AcknowledgeDecision;
  }): Promise<AcknowledgeOutcome>;
  withdrawAcknowledgement(input: {
    readonly propertyReferenceId: string;
    readonly year: number;
    readonly acknowledgementId: string;
    readonly mreRealmId: string;
    readonly actor: AuditActor;
    readonly reason: string;
    readonly expectedVersions?: readonly number[];
  }): Promise<WithdrawOutcome<TaxYearAcknowledgement>>;
  /** `undefined`: the PropertyReference unknown or foreign. */
  listAcknowledgements(
    propertyReferenceId: string,
    year: number,
    mreRealmId: string,
    statuses: readonly TaxStatementStatus[] | null,
  ): Promise<readonly TaxYearAcknowledgement[] | undefined>;
  confirm(input: {
    readonly loanId: string;
    readonly allocationSetId: string;
    readonly mreRealmId: string;
    readonly actor: AuditActor;
    readonly reason: string;
    readonly advisorPartyId: string | null;
    readonly idempotency?: { readonly key: string; readonly fingerprint: string };
  }): Promise<ConfirmOutcome>;
  withdrawConfirmation(input: {
    readonly loanId: string;
    readonly allocationSetId: string;
    readonly confirmationId: string;
    readonly mreRealmId: string;
    readonly actor: AuditActor;
    readonly reason: string;
    readonly expectedVersions?: readonly number[];
  }): Promise<WithdrawOutcome<LoanAllocationTaxConfirmation>>;
  /** `LOAN_NOT_FOUND` / `SET_NOT_FOUND` as the confirmation's step 2. */
  listConfirmations(
    loanId: string,
    allocationSetId: string,
    mreRealmId: string,
  ): Promise<readonly LoanAllocationTaxConfirmation[] | 'LOAN_NOT_FOUND' | 'SET_NOT_FOUND'>;
}
