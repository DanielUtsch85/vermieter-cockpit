import { Money, type AuditActor, type VersionConflict } from '../../shared/index.js';

/**
 * RentPaymentReconciliation (data-model.md §18A, api-design.md §37.1, phase-4-plan P4-D1…D3, P4-D7): counted rent cash
 * of one DE Transaction matched to one MRE rent term. It never creates or changes a Transaction (ADR-004A), and it
 * never changes MRE here: write-back is VC-4-04.
 */

export const RECONCILIATION_STATUSES = ['SUGGESTED', 'CONFIRMED', 'REJECTED', 'RELEASED'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** The rent income categories whose splits are a Transaction's rent cash (P4-D3, migration 0008). */
export const RENT_CATEGORIES = ['RENT_BASE', 'RENT_OPERATING_COST_ADVANCE', 'RENT_OPERATING_COST_SETTLEMENT'] as const;

/** Until VC-4-04 nothing is written back. */
export type MreWriteBackState = 'NOT_WRITTEN';

export type RentPaymentReconciliationId = string & { readonly __brand: 'RentPaymentReconciliationId' };

export interface RentPaymentReconciliation {
  readonly id: RentPaymentReconciliationId;
  readonly mreRealmId: string;
  readonly status: ReconciliationStatus;
  readonly transactionId: string;
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
  readonly matchedAmount: Money;
  readonly confidence: string | null;
  readonly suggestionReason: string | null;
  readonly confirmedAt: Date | null;
  readonly confirmedBy: string | null;
  readonly releasedAt: Date | null;
  readonly releasedBy: string | null;
  readonly releaseReason: string | null;
  readonly notes: string | null;
  readonly mreWriteBackState: MreWriteBackState;
  readonly createdAt: Date;
  readonly version: number;
}

/** A manual match (§37.1), validated at the API boundary. */
export interface NewMatch {
  readonly mreRealmId: string;
  readonly transactionId: string;
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
  readonly matchedAmount: Money;
  readonly notes: string | null;
}

/**
 * MRE's term key `YYYYMMDDHH`: ten digits, a date that exists, an hour `00`–`23` (§37.1). MRE's monthly terms end in
 * `0100`, but other frequencies exist, so only the form is checked here; MRE decides whether the term exists.
 */
export function isTermKey(term: string): boolean {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(term);
  if (match === null) return false;
  const [year, month, day, hour] = match.slice(1).map(Number) as [number, number, number, number];
  if (hour > 23 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The Transaction as the cash rules see it, with its `CONFIRMED` matches. */
export interface MatchCash {
  readonly status: string;
  readonly direction: string;
  readonly correctionRole: string | null;
  /** Σ of its rent-category splits, or null when it has none. */
  readonly rentCash: Money | null;
  readonly confirmed: readonly {
    readonly id: string;
    readonly mreTenantId: string;
    readonly mreRentTerm: string;
    readonly matchedAmount: Money;
  }[];
}

export type MatchRefusal =
  | { readonly kind: 'TRANSACTION_NOT_FOUND' }
  | { readonly kind: 'TRANSACTION_NOT_COUNTED'; readonly status: string; readonly correctionRole: string | null }
  | { readonly kind: 'TRANSACTION_NOT_INFLOW' }
  | { readonly kind: 'NO_RENT_CASH' }
  | { readonly kind: 'ALREADY_MATCHED'; readonly reconciliationId: string }
  | { readonly kind: 'RENT_CASH_EXCEEDED'; readonly rentCash: Money; readonly available: Money };

/** Rent cash minus the `CONFIRMED` matches (P4-D3). */
export function availableOf(cash: MatchCash & { readonly rentCash: Money }): Money {
  return cash.confirmed.reduce((left, c) => left.subtract(c.matchedAmount), cash.rentCash);
}

/** Checks 2–7 of §37.1's order; undefined when the match may be written. */
export function checkMatch(cash: MatchCash | undefined, request: Pick<NewMatch, 'mreTenantId' | 'mreRentTerm' | 'matchedAmount'>): MatchRefusal | undefined {
  if (cash === undefined) return { kind: 'TRANSACTION_NOT_FOUND' };
  if ((cash.status !== 'CONFIRMED' && cash.status !== 'RECONCILED') || cash.correctionRole === 'REVERSAL') {
    return { kind: 'TRANSACTION_NOT_COUNTED', status: cash.status, correctionRole: cash.correctionRole };
  }
  if (cash.direction !== 'INFLOW') return { kind: 'TRANSACTION_NOT_INFLOW' };
  if (cash.rentCash === null || cash.rentCash.isZero()) return { kind: 'NO_RENT_CASH' };
  const same = cash.confirmed.find((c) => c.mreTenantId === request.mreTenantId && c.mreRentTerm === request.mreRentTerm);
  if (same !== undefined) return { kind: 'ALREADY_MATCHED', reconciliationId: same.id };
  const available = availableOf({ ...cash, rentCash: cash.rentCash });
  if (request.matchedAmount.compare(available) > 0) return { kind: 'RENT_CASH_EXCEEDED', rentCash: cash.rentCash, available };
  return undefined;
}

/** The idempotency fingerprint of a manual match: the normalized body (§15). */
export function matchFingerprint(match: NewMatch): string {
  return JSON.stringify([match.transactionId, match.mreTenantId, match.mreRentTerm, match.matchedAmount.amount, match.matchedAmount.currency, match.notes]);
}

export type ReleasePlan =
  | { readonly kind: 'RELEASE'; readonly next: RentPaymentReconciliation }
  /** Already `RELEASED`: a 200 no-op keeping the first reason and time, whatever the version. */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'NOT_RELEASABLE'; readonly status: ReconciliationStatus };

/** Checks 3–4 of §37.1's release; `If-Match` is checked after it by the caller. */
export function planRelease(current: RentPaymentReconciliation, reason: string, at: Date, actor: AuditActor): ReleasePlan {
  if (current.status === 'RELEASED') return { kind: 'UNCHANGED' };
  if (current.status !== 'CONFIRMED') return { kind: 'NOT_RELEASABLE', status: current.status };
  return {
    kind: 'RELEASE',
    next: { ...current, status: 'RELEASED', releasedAt: at, releasedBy: actor.actorId, releaseReason: reason, version: current.version + 1 },
  };
}

export type CreateMatchOutcome =
  | { readonly kind: 'CREATED'; readonly reconciliation: RentPaymentReconciliation }
  | { readonly kind: 'REPLAYED'; readonly reconciliation: RentPaymentReconciliation }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | MatchRefusal;

/** Before the MRE read: a replay or a refusal answers without asking MRE (§37.1). */
export type PrecheckOutcome = { readonly kind: 'PROCEED' } | Exclude<CreateMatchOutcome, { kind: 'CREATED' }>;

export type ReleaseOutcome =
  | { readonly kind: 'RELEASED'; readonly reconciliation: RentPaymentReconciliation; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<ReleasePlan, { kind: 'RELEASE' | 'UNCHANGED' }>
  | VersionConflict;

export interface ReconciliationFilter {
  readonly status?: readonly ReconciliationStatus[];
  readonly transactionId?: string;
  readonly mreTenantId?: string;
  readonly mreRentTerm?: string;
}

export interface ReconciliationPage {
  readonly items: readonly RentPaymentReconciliation[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface RentReconciliationRepository {
  /** Checks 2–7 and a replay of the key, in one snapshot; nothing is written. */
  precheck(match: NewMatch, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<PrecheckOutcome>;
  /** The Transaction row first (P4-D8's no-op write), then checks 2–7 again, then the insert and its AuditRecord. */
  create(match: NewMatch, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateMatchOutcome>;
  findById(id: string, mreRealmId: string): Promise<RentPaymentReconciliation | undefined>;
  list(mreRealmId: string, filter: ReconciliationFilter, page: { readonly page: number; readonly pageSize: number }): Promise<ReconciliationPage>;
  /** The Transaction row first, then the reconciliation `FOR UPDATE`, then `planRelease`. */
  release(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ReleaseOutcome>;
}
