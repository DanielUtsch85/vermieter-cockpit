import type { AuditActor, BusinessDate, Money, VersionConflict } from '../../shared/index.js';
import type { CloseLoanOutcome, CloseRequest } from './close.js';

/**
 * Loan (data-model.md §21, api-design.md §41.1, backlog VC-3-01): one canonical financing contract (phase-3-plan
 * P3-D1). It is never duplicated per property; properties come only through allocations (VC-3-03). Full disbursement
 * is assumed: `principalOriginal` is owed from `debtFrom`. Status `ACTIVE` → `VOID` / `CLOSED`, both final.
 */

export type LoanId = string & { readonly __brand: 'LoanId' };

export const LOAN_STATUSES = ['ACTIVE', 'VOID', 'CLOSED'] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

/** The fields `amend` may change while the Loan is `ACTIVE`. */
export interface LoanAmendable {
  readonly lenderPartyId: string;
  /** 1–20, in the order given; the lender is never one of them. */
  readonly borrowerPartyIds: readonly string[];
  readonly maturityDate: BusinessDate | null;
  readonly contractNumber: string | null;
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
}

export interface LoanData extends LoanAmendable {
  /** > 0, EUR. Fixed. */
  readonly principalOriginal: Money;
  /** The contract date. Fixed. */
  readonly startDate: BusinessDate;
  /** Fixed; `startDate` stands in while unset (`debtFrom`). */
  readonly disbursementDate: BusinessDate | null;
  /** Informational, no effect on the Acquisition. Fixed. */
  readonly acquisitionId: string | null;
}

/** Why a Loan was closed (P3-D7, api-design §41.7). */
export const CLOSING_REASONS = ['REPAID', 'REFINANCED', 'OTHER'] as const;
export type ClosingReason = (typeof CLOSING_REASONS)[number];

export interface Loan extends LoanData {
  readonly id: LoanId;
  readonly mreRealmId: string;
  readonly status: LoanStatus;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  /** Set exactly while `CLOSED` (§41.7). */
  readonly closingDate: BusinessDate | null;
  readonly closingReason: ClosingReason | null;
  /** The Loan that took the debt over, exactly for `REFINANCED`. */
  readonly refinancedByLoanId: string | null;
  readonly closingNote: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** A validated, normalized Loan about to be created. */
export interface NewLoan extends LoanData {
  readonly mreRealmId: string;
}

export const AMENDABLE_FIELDS = ['lenderPartyId', 'borrowerPartyIds', 'maturityDate', 'contractNumber', 'sourceReferences', 'notes'] as const;
export type AmendableField = (typeof AMENDABLE_FIELDS)[number];
export type LoanChanges = { readonly [F in AmendableField]?: LoanAmendable[F] };

/** The day the debt starts: `disbursementDate`, or `startDate` while that is unset (P3-D1). */
export function debtFrom(loan: Pick<LoanData, 'startDate' | 'disbursementDate'>): BusinessDate {
  return loan.disbursementDate ?? loan.startDate;
}

/** A rule over the merged fields, answered as a 400 field error (api-design §41.1). */
export interface LoanFieldError {
  readonly field: string;
  readonly code: 'LENDER_IS_BORROWER' | 'NOT_AFTER_DISBURSEMENT';
}

/** The rules of §41.1 that span fields; the body's own shape is checked at the API boundary. */
export function fieldErrors(loan: Pick<LoanData, 'lenderPartyId' | 'borrowerPartyIds' | 'startDate' | 'disbursementDate' | 'maturityDate'>): LoanFieldError[] {
  const errors: LoanFieldError[] = [];
  const lender = loan.borrowerPartyIds.indexOf(loan.lenderPartyId);
  if (lender !== -1) errors.push({ field: `borrowerPartyIds.${lender}`, code: 'LENDER_IS_BORROWER' });
  if (loan.maturityDate !== null && loan.maturityDate <= debtFrom(loan)) errors.push({ field: 'maturityDate', code: 'NOT_AFTER_DISBURSEMENT' });
  return errors;
}

/** Identity of a create request for `Idempotency-Key` replays: the normalized payload. */
export function createFingerprint(loan: NewLoan): string {
  return JSON.stringify([
    loan.lenderPartyId,
    loan.borrowerPartyIds,
    loan.principalOriginal.amount,
    loan.principalOriginal.currency,
    loan.startDate,
    loan.disbursementDate,
    loan.maturityDate,
    loan.contractNumber,
    loan.acquisitionId,
    loan.sourceReferences,
    loan.notes,
  ]);
}

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

export type AmendPlan =
  | {
      readonly kind: 'AMEND';
      readonly values: LoanAmendable;
      readonly changed: readonly AmendableField[];
      /** The Parties this amend names anew (a new lender, or a borrower not in the current list), in id order. */
      readonly newPartyIds: readonly string[];
    }
  /** Every given value equals the current one: a 200 no-op, answered whatever the version (§16.1). */
  | { readonly kind: 'UNCHANGED' }
  /** `VOID` or `CLOSED`: no amend at all, a no-op included (→ 409 LOAN_NOT_ACTIVE, review on #59). */
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  | { readonly kind: 'INVALID'; readonly errors: readonly LoanFieldError[] };

/** The status before anything else; then the merged rules; then the no-op. Parties and the version are the caller's. */
export function planAmend(current: Loan, changes: LoanChanges): AmendPlan {
  if (current.status !== 'ACTIVE') return { kind: 'LOAN_NOT_ACTIVE', status: current.status };
  const values: LoanAmendable = {
    lenderPartyId: changes.lenderPartyId ?? current.lenderPartyId,
    borrowerPartyIds: changes.borrowerPartyIds ?? current.borrowerPartyIds,
    maturityDate: changes.maturityDate === undefined ? current.maturityDate : changes.maturityDate,
    contractNumber: changes.contractNumber === undefined ? current.contractNumber : changes.contractNumber,
    sourceReferences: changes.sourceReferences ?? current.sourceReferences,
    notes: changes.notes === undefined ? current.notes : changes.notes,
  };
  const errors = fieldErrors({ ...current, ...values });
  if (errors.length > 0) return { kind: 'INVALID', errors };
  const changed = AMENDABLE_FIELDS.filter((field) => !same(values[field], current[field]));
  if (changed.length === 0) return { kind: 'UNCHANGED' };
  const before = new Set([current.lenderPartyId, ...current.borrowerPartyIds]);
  const newPartyIds = [...new Set([values.lenderPartyId, ...values.borrowerPartyIds])].filter((id) => !before.has(id)).sort();
  return { kind: 'AMEND', values, changed, newPartyIds };
}

export type VoidPlan =
  | { readonly kind: 'VOID'; readonly next: Loan }
  /** Already void: a 200 no-op whatever the reason or version; the first reason and time stay. */
  | { readonly kind: 'UNCHANGED' }
  /** Closed is final (→ 409 LOAN_CLOSED). */
  | { readonly kind: 'LOAN_CLOSED' }
  /** Splits reference the Loan, reversals included (→ 409 LOAN_HAS_SPLITS; from VC-3-05). */
  | { readonly kind: 'LOAN_HAS_SPLITS'; readonly transactionIds: readonly string[] }
  /** `CLOSED` Loans name it as their refinancing (→ 409 LOAN_REFINANCES; §41.7, review on #71). */
  | { readonly kind: 'LOAN_REFINANCES'; readonly loanIds: readonly string[] };

/** `refinancedLoanIds`: the `CLOSED` Loans naming this one as `refinancedByLoanId`. */
export function planVoid(current: Loan, reason: string, at: Date, splitTransactionIds: readonly string[], refinancedLoanIds: readonly string[] = []): VoidPlan {
  if (current.status === 'VOID') return { kind: 'UNCHANGED' };
  if (current.status === 'CLOSED') return { kind: 'LOAN_CLOSED' };
  if (splitTransactionIds.length > 0) return { kind: 'LOAN_HAS_SPLITS', transactionIds: [...new Set(splitTransactionIds)].sort() };
  if (refinancedLoanIds.length > 0) return { kind: 'LOAN_REFINANCES', loanIds: [...new Set(refinancedLoanIds)].sort() };
  return { kind: 'VOID', next: { ...current, status: 'VOID', voidedAt: at, voidReason: reason, version: current.version + 1 } };
}

export type CreateLoanOutcome =
  | { readonly kind: 'CREATED'; readonly loan: Loan }
  | { readonly kind: 'REPLAYED'; readonly loan: Loan }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | { readonly kind: 'ACQUISITION_NOT_FOUND'; readonly acquisitionId: string }
  | { readonly kind: 'PARTY_INACTIVE'; readonly partyId: string };

export type AmendLoanOutcome =
  | { readonly kind: 'AMENDED'; readonly loan: Loan; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | { readonly kind: 'PARTY_INACTIVE'; readonly partyId: string }
  | Exclude<AmendPlan, { kind: 'AMEND' | 'UNCHANGED' }>
  | VersionConflict;

export type VoidLoanOutcome =
  | { readonly kind: 'VOIDED'; readonly loan: Loan; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<VoidPlan, { kind: 'VOID' | 'UNCHANGED' }>
  | VersionConflict;

export interface LoanFilter {
  readonly status?: LoanStatus;
  /** Lender or borrower. */
  readonly partyId?: string;
  readonly acquisitionId?: string;
}

export interface LoanPage {
  readonly items: readonly Loan[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface LoanRepository {
  /**
   * In one READ COMMITTED transaction: claims the key, locks the named Parties `FOR SHARE` in id order (none can turn
   * inactive meanwhile), checks the Acquisition, writes the Loan and an AuditRecord.
   */
  create(loan: NewLoan, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateLoanOutcome>;
  findById(id: string, mreRealmId: string): Promise<Loan | undefined>;
  /** Ordered by `startDate` (newest first), `createdAt` (newest first), id; count and page in one snapshot. */
  list(mreRealmId: string, filter: LoanFilter, page: { readonly page: number; readonly pageSize: number }): Promise<LoanPage>;
  /** Parties named in the changes `FOR SHARE` in id order, then the Loan `FOR UPDATE` (Parties → Loan), then `planAmend`. */
  amend(id: string, mreRealmId: string, changes: LoanChanges, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendLoanOutcome>;
  /**
   * The Loan and, for `REFINANCED`, the named Loan `FOR UPDATE` in id order, then the splits and their Transactions are
   * read, then `planClose` (§41.7); no Transaction is locked (P3-D8).
   */
  close(id: string, mreRealmId: string, request: CloseRequest, actor: AuditActor, expectedVersions?: readonly number[]): Promise<CloseLoanOutcome>;
  /** The Loan `FOR UPDATE`, then its splits and the `CLOSED` Loans naming it are read; no Transaction is locked (P3-D8). */
  void(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidLoanOutcome>;
}
