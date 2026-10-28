import { Money, type AuditActor, type BusinessDate, type VersionConflict } from '../../shared/index.js';
import type { Suggestion, SuggestionCandidate, SuggestionPair } from './suggestion.js';

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
  readonly rejectedAt: Date | null;
  readonly rejectedBy: string | null;
  readonly rejectReason: string | null;
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

export const COVERAGES = ['UNMATCHED', 'PARTIALLY_MATCHED', 'MATCHED', 'OVERPAID'] as const;
export type Coverage = (typeof COVERAGES)[number];

/**
 * A term's coverage by DE cash (api-design.md §37.2, BR-RENT-006/007): `matchedTotal` (DE's `CONFIRMED` matches)
 * against MRE's `amountDue`. MRE's own payments never enter it (BR-RENT-001). `openAmount` is signed: negative when
 * overpaid, and the rest stays visible (nothing is carried to another term).
 */
export function coverageOf(amountDue: Money, matchedTotal: Money): { readonly coverage: Coverage; readonly openAmount: Money } {
  const openAmount = amountDue.subtract(matchedTotal);
  const order = matchedTotal.compare(amountDue);
  const coverage: Coverage = order > 0 ? 'OVERPAID' : order === 0 ? 'MATCHED' : matchedTotal.isZero() ? 'UNMATCHED' : 'PARTIALLY_MATCHED';
  return { coverage, openAmount };
}

/** Σ `matchedAmount` of the `CONFIRMED` ones; `0.00` when none (§37.2). */
export function matchedTotalOf(reconciliations: readonly Pick<RentPaymentReconciliation, 'status' | 'matchedAmount'>[]): Money {
  return Money.sum(
    reconciliations.filter((r) => r.status === 'CONFIRMED').map((r) => r.matchedAmount),
    'EUR',
  );
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

/** The DE side of a Transaction's coverage read (§37.2): the cash rules' view and every reconciliation of it. */
export interface TransactionRentSide {
  readonly transactionId: string;
  readonly status: string;
  readonly direction: string;
  readonly correctionRole: string | null;
  readonly rentCash: Money | null;
  readonly reconciliations: readonly RentPaymentReconciliation[];
}

export type ConfirmPlan =
  | { readonly kind: 'CONFIRM'; readonly amount: Money }
  /** Already `CONFIRMED` with this amount: a 200 no-op whatever the version. */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'NOT_CONFIRMABLE'; readonly status: ReconciliationStatus }
  | { readonly kind: 'ABOVE_SUGGESTION'; readonly suggested: Money };

/** Checks 3–4 of §37.3's confirm: the status, then the amount (lowered or kept, never raised). */
export function planConfirm(current: RentPaymentReconciliation, requested: Money | undefined): ConfirmPlan {
  if (current.status === 'CONFIRMED' && (requested === undefined || requested.equals(current.matchedAmount))) return { kind: 'UNCHANGED' };
  if (current.status !== 'SUGGESTED') return { kind: 'NOT_CONFIRMABLE', status: current.status };
  const amount = requested ?? current.matchedAmount;
  if (amount.compare(current.matchedAmount) > 0) return { kind: 'ABOVE_SUGGESTION', suggested: current.matchedAmount };
  return { kind: 'CONFIRM', amount };
}

/**
 * Check 7 of §37.3's confirm: the amount above the term's open amount now (MRE's amount due − the term's `CONFIRMED`
 * matches) means someone matched the term in between.
 */
export function staleBy(amount: Money, amountDue: Money, termConfirmed: Money): { readonly openAmount: Money } | undefined {
  const openAmount = amountDue.subtract(termConfirmed);
  return amount.compare(openAmount) > 0 ? { openAmount } : undefined;
}

export type RejectPlan =
  | { readonly kind: 'REJECT'; readonly next: RentPaymentReconciliation }
  /** Already `REJECTED`: a 200 no-op keeping the first reason. */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'NOT_REJECTABLE'; readonly status: ReconciliationStatus };

export function planReject(current: RentPaymentReconciliation, reason: string, at: Date, actor: AuditActor): RejectPlan {
  if (current.status === 'REJECTED') return { kind: 'UNCHANGED' };
  if (current.status !== 'SUGGESTED') return { kind: 'NOT_REJECTABLE', status: current.status };
  return { kind: 'REJECT', next: { ...current, status: 'REJECTED', rejectedAt: at, rejectedBy: actor.actorId, rejectReason: reason, version: current.version + 1 } };
}

/** What a confirm needs before the MRE read: the reconciliation and the amount, or why not (§37.3 checks 2–5). */
export type ConfirmPrecheck =
  | { readonly kind: 'PROCEED'; readonly reconciliation: RentPaymentReconciliation; readonly amount: Money }
  | { readonly kind: 'UNCHANGED'; readonly reconciliation: RentPaymentReconciliation }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<ConfirmPlan, { kind: 'CONFIRM' | 'UNCHANGED' }>
  | Exclude<MatchRefusal, { kind: 'TRANSACTION_NOT_FOUND' }>;

export type ConfirmOutcome =
  | { readonly kind: 'CONFIRMED'; readonly reconciliation: RentPaymentReconciliation; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<ConfirmPlan, { kind: 'CONFIRM' | 'UNCHANGED' }>
  | Exclude<MatchRefusal, { kind: 'TRANSACTION_NOT_FOUND' }>
  | { readonly kind: 'SUGGESTION_STALE'; readonly openAmount: Money }
  | VersionConflict;

export type RejectOutcome =
  | { readonly kind: 'REJECTED'; readonly reconciliation: RentPaymentReconciliation; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<RejectPlan, { kind: 'REJECT' | 'UNCHANGED' }>
  | VersionConflict;

/** The DE side of a suggest run (§37.3 step 2), read in one snapshot. */
export interface SuggestionSnapshot {
  readonly candidates: readonly SuggestionCandidate[];
  /** Σ `CONFIRMED` per term key `tenant/term` of the given terms. */
  readonly confirmedByTerm: ReadonlyMap<string, Money>;
  readonly handled: readonly SuggestionPair[];
  readonly open: readonly SuggestionPair[];
  readonly history: readonly { readonly mreTenantId: string; readonly counterpartyIban: string }[];
}

export interface RentReconciliationRepository {
  /** §37.3 step 2: candidates booked from `from` to `to`, the terms' confirmed sums, handled and open pairs, the IBAN history. */
  suggestionSnapshot(
    mreRealmId: string,
    terms: readonly { readonly mreTenantId: string; readonly mreRentTerm: string }[],
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<SuggestionSnapshot>;
  /** §37.3 step 4: the Transactions in id order, each pair re-checked; returns the reconciliations written. */
  writeSuggestions(mreRealmId: string, suggestions: readonly Suggestion[], actor: AuditActor): Promise<readonly RentPaymentReconciliation[]>;
  /** §37.3 confirm checks 2–5 in one snapshot, before the MRE read. */
  confirmPrecheck(id: string, mreRealmId: string, amount: Money | undefined): Promise<ConfirmPrecheck>;
  /** The Transaction row first, then the reconciliation `FOR UPDATE`; checks 3–5 and 7 again with MRE's amount due. */
  confirm(id: string, mreRealmId: string, amount: Money | undefined, amountDue: Money, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ConfirmOutcome>;
  /** The reconciliation `FOR UPDATE` only: a rejection consumes no cash. */
  reject(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<RejectOutcome>;
  /** Every reconciliation of the Realm for this Tenant and term, in `createdAt` order (§37.2's DE side). */
  termSide(mreRealmId: string, mreTenantId: string, mreRentTerm: string): Promise<readonly RentPaymentReconciliation[]>;
  /** The Transaction of the Realm with its rent cash and reconciliations, in one snapshot; undefined when unknown. */
  transactionSide(transactionId: string, mreRealmId: string): Promise<TransactionRentSide | undefined>;
  /** Checks 2–7 and a replay of the key, in one snapshot; nothing is written. */
  precheck(match: NewMatch, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<PrecheckOutcome>;
  /** The Transaction row first (P4-D8's no-op write), then checks 2–7 again, then the insert and its AuditRecord. */
  create(match: NewMatch, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateMatchOutcome>;
  findById(id: string, mreRealmId: string): Promise<RentPaymentReconciliation | undefined>;
  list(mreRealmId: string, filter: ReconciliationFilter, page: { readonly page: number; readonly pageSize: number }): Promise<ReconciliationPage>;
  /** The Transaction row first, then the reconciliation `FOR UPDATE`, then `planRelease`. */
  release(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ReleaseOutcome>;
}
