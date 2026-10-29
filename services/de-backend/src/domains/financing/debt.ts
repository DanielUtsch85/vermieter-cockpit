import { addDays, type AuditActor, type BusinessDate, type Money, type VersionConflict } from '../../shared/index.js';
import { largestRemainder } from '../acquisition/index.js';
import type { Fraction } from '../ownership/index.js';
import { setOn, type LoanAllocationSetView } from './allocation.js';
import { debtFrom, type ClosingReason, type Loan, type LoanStatus } from './loan.js';
import { loanSchedule, plannedBalanceOn, scheduleOf, toCents, type FixedRateEnd, type ScheduleEndReason, type SchedulePeriod } from './terms.js';

/**
 * Remaining debt, payments and lender statements (api-design.md §41.6, backlog VC-3-06, phase-3-plan P3-D6, ADR-016).
 * Remaining debt is derived from the contract, the payments that count (§41.5) and the plan (§41.4), never stored; a
 * lender's statement is evidence compared with it, never the truth. Everything is exact in cents.
 */

export type LoanSplitCategory = 'LOAN_INTEREST' | 'LOAN_PRINCIPAL';

/** A split that counts for the Loan (§41.5): of a current Transaction, `CONFIRMED` or `RECONCILED`, not a reversal. */
export interface CountedSplit {
  readonly transactionId: string;
  readonly bookingDate: BusinessDate;
  readonly category: LoanSplitCategory;
  /** Cents, ≥ 0. */
  readonly amount: bigint;
}

/** The Loan-level values on a day; `planned` and `difference` are null without terms. */
export interface DebtOnDay {
  readonly principalPaid: bigint;
  readonly actual: bigint;
  readonly planned: bigint | null;
  readonly difference: bigint | null;
  readonly planEndReason: ScheduleEndReason;
}

/** The inputs of every read of §41.6, from one snapshot. */
export interface DebtInputs {
  readonly loan: Loan;
  /** `VALID` periods in `validFrom` order. */
  readonly periods: readonly SchedulePeriod[];
  /** Every set with `validUntil`. */
  readonly sets: readonly LoanAllocationSetView[];
  readonly splits: readonly CountedSplit[];
  readonly statements: readonly LoanBalanceStatement[];
}

/** Σ `LOAN_PRINCIPAL` booked on or before `day`. */
export function principalPaidOn(splits: readonly CountedSplit[], day: BusinessDate): bigint {
  return splits.reduce((sum, s) => (s.category === 'LOAN_PRINCIPAL' && s.bookingDate <= day ? sum + s.amount : sum), 0n);
}

/** Whether `day` is after a `CLOSED` Loan's closing date (§41.7). */
const closedBefore = (loan: Loan, day: BusinessDate) => loan.status === 'CLOSED' && loan.closingDate !== null && day > loan.closingDate;

/**
 * `principalOriginal` − principal paid on `day`; 0 before `debtFrom` and after a `CLOSED` Loan's closing date (§41.7);
 * negative when more was paid than lent.
 */
export function actualOn(loan: Loan, splits: readonly CountedSplit[], day: BusinessDate): bigint {
  if (day < debtFrom(loan) || closedBefore(loan, day)) return 0n;
  return toCents(loan.principalOriginal) - principalPaidOn(splits, day);
}

/**
 * The Loan-level values of §41.6 on `day`. `planned` is the plan's balance after its last payment on or before `day`
 * (before the first, the balance the period in effect starts from); with `MATURITY` it is 0 from `maturityDate` on,
 * inclusive (review on #69); `PAYMENT_CAP` keeps `balanceDue`. Before `debtFrom` everything is 0.
 */
export function debtOn(loan: Loan, periods: readonly SchedulePeriod[], splits: readonly CountedSplit[], day: BusinessDate): DebtOnDay {
  const { endReason } = scheduleOf(loan.principalOriginal, loan.maturityDate, periods).summary;
  const planEndReason = loanSchedule(loan, periods).summary.endReason;
  if (day < debtFrom(loan)) {
    const zero = endReason === 'NO_TERMS' ? null : 0n;
    return { principalPaid: 0n, actual: 0n, planned: zero, difference: zero, planEndReason };
  }
  const principalPaid = principalPaidOn(splits, day);
  if (closedBefore(loan, day)) {
    // §41.7: after the closing date nothing is owed; principalPaid stays what was paid.
    const zero = endReason === 'NO_TERMS' ? null : 0n;
    return { principalPaid, actual: 0n, planned: zero, difference: zero, planEndReason };
  }
  const actual = toCents(loan.principalOriginal) - principalPaid;
  if (endReason === 'NO_TERMS') return { principalPaid, actual, planned: null, difference: null, planEndReason };
  const matured = endReason === 'MATURITY' && loan.maturityDate !== null && day >= loan.maturityDate;
  // plannedBalanceOn(d + 1): the balance after every payment on or before d, restarts of periods from d included.
  const planned = matured ? 0n : plannedBalanceOn(loan.principalOriginal, loan.maturityDate, periods, addDays(day, 1));
  return { principalPaid, actual, planned, difference: actual - planned, planEndReason };
}

/**
 * `total` cents by the set's shares by largest remainder, ties by `propertyReferenceId`; a negative total by its
 * absolute value, the sign restored on each part. In the set's order; the parts sum exactly to `total`.
 */
export function distribute(total: bigint, allocations: readonly { readonly propertyReferenceId: string; readonly share: Fraction }[]): bigint[] {
  const negative = total < 0n;
  const parts = largestRemainder(
    negative ? -total : total,
    allocations.map((a) => ({ key: a.propertyReferenceId, weight: a.share })),
  );
  return allocations.map((a) => {
    const part = parts.get(a.propertyReferenceId) ?? 0n;
    return negative ? -part : part;
  });
}

export interface PropertyDebt {
  readonly propertyReferenceId: string;
  readonly share: Fraction;
  readonly actual: bigint;
  readonly planned: bigint | null;
  readonly difference: bigint | null;
}

/**
 * `actual` and `planned` distributed; each `difference` derived as `actual_i − planned_i`, never distributed (F4b):
 * largest remainder is not monotone, so a separately distributed difference could break the identity.
 */
export function debtPerProperty(debt: DebtOnDay, set: LoanAllocationSetView): PropertyDebt[] {
  const actual = distribute(debt.actual, set.allocations);
  const planned = debt.planned === null ? null : distribute(debt.planned, set.allocations);
  return set.allocations.map((a, i) => {
    const actualPart = actual[i] as bigint;
    const plannedPart = planned === null ? null : (planned[i] as bigint);
    return {
      propertyReferenceId: a.propertyReferenceId,
      share: a.share,
      actual: actualPart,
      planned: plannedPart,
      difference: plannedPart === null ? null : actualPart - plannedPart,
    };
  });
}

/** A `CLOSED` Loan's closing (§41.7); `actualOnClosingDate` is derived now, so a later correction shows here. */
export interface Closing {
  readonly closingDate: BusinessDate;
  readonly reason: ClosingReason;
  readonly refinancedByLoanId: string | null;
  readonly actualOnClosingDate: bigint;
}

export type RemainingDebt = DebtOnDay & {
  readonly asOf: BusinessDate;
  readonly debtFrom: BusinessDate;
  readonly principalOriginal: Money;
  readonly latestStatement: StatementView | null;
  readonly closing: Closing | null;
  /** The plan's balance at the end of the fixed-rate period, as in the schedule's summary (#119). */
  readonly fixedRateEnd: FixedRateEnd | null;
};

export type RemainingDebtPerProperty = RemainingDebt & { readonly allocationSetId: string; readonly items: readonly PropertyDebt[] };

export type RemainingDebtOutcome =
  | { readonly kind: 'LOAN_LEVEL'; readonly debt: RemainingDebt }
  | { readonly kind: 'PER_PROPERTY'; readonly debt: RemainingDebtPerProperty }
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  | { readonly kind: 'LOAN_NOT_ALLOCATED'; readonly asOf: BusinessDate };

/** §41.6's remaining debt on `asOf`, with the latest `VALID` statement on or before it. */
export function remainingDebt(inputs: DebtInputs, asOf: BusinessDate, perProperty: boolean): RemainingDebtOutcome {
  const { loan, periods, sets, splits, statements } = inputs;
  if (loan.status === 'VOID') return { kind: 'LOAN_NOT_ACTIVE', status: loan.status };
  const latest = latestStatementOn(statements, asOf);
  const debt: RemainingDebt = {
    ...debtOn(loan, periods, splits, asOf),
    asOf,
    debtFrom: debtFrom(loan),
    principalOriginal: loan.principalOriginal,
    latestStatement: latest === null ? null : compareStatement(loan, splits, latest),
    closing:
      loan.status === 'CLOSED' && loan.closingDate !== null && loan.closingReason !== null
        ? {
            closingDate: loan.closingDate,
            reason: loan.closingReason,
            refinancedByLoanId: loan.refinancedByLoanId,
            actualOnClosingDate: actualOn(loan, splits, loan.closingDate),
          }
        : null,
    fixedRateEnd: loanSchedule(loan, periods).summary.fixedRateEnd,
  };
  if (!perProperty) return { kind: 'LOAN_LEVEL', debt };
  const set = setOn(sets, asOf);
  if (set === null) return { kind: 'LOAN_NOT_ALLOCATED', asOf };
  return { kind: 'PER_PROPERTY', debt: { ...debt, allocationSetId: set.id, items: debtPerProperty(debt, set) } };
}

export interface YearPayments {
  readonly year: number;
  readonly interest: bigint;
  readonly principal: bigint;
  /** The number of Transactions. */
  readonly payments: number;
}

export interface PropertyPayments {
  readonly propertyReferenceId: string;
  readonly interest: bigint;
  readonly principal: bigint;
}

export type YearPaymentsOutcome =
  | { readonly kind: 'LOAN_LEVEL'; readonly payments: YearPayments }
  | { readonly kind: 'PER_PROPERTY'; readonly payments: YearPayments; readonly items: readonly PropertyPayments[] }
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  /** `bookingDate`: the first counted split of the year on a day without a set. */
  | { readonly kind: 'LOAN_NOT_ALLOCATED'; readonly bookingDate: BusinessDate };

/**
 * The interest and principal paid in `year`. Per property each split is attributed by the set covering its booking
 * date and distributed by largest remainder, then summed per property and category, so each column sums exactly.
 */
export function paymentsInYear(inputs: DebtInputs, year: number, perProperty: boolean): YearPaymentsOutcome {
  const { loan, sets } = inputs;
  if (loan.status === 'VOID') return { kind: 'LOAN_NOT_ACTIVE', status: loan.status };
  const prefix = `${year}-`;
  const splits = inputs.splits
    .filter((s) => s.bookingDate.startsWith(prefix))
    .sort((x, y) => (x.bookingDate < y.bookingDate ? -1 : x.bookingDate > y.bookingDate ? 1 : 0));
  const sum = (category: LoanSplitCategory) => splits.reduce((total, s) => (s.category === category ? total + s.amount : total), 0n);
  const payments: YearPayments = {
    year,
    interest: sum('LOAN_INTEREST'),
    principal: sum('LOAN_PRINCIPAL'),
    payments: new Set(splits.map((s) => s.transactionId)).size,
  };
  if (!perProperty) return { kind: 'LOAN_LEVEL', payments };
  const totals = new Map<string, { interest: bigint; principal: bigint }>();
  for (const s of splits) {
    const set = setOn(sets, s.bookingDate);
    if (set === null) return { kind: 'LOAN_NOT_ALLOCATED', bookingDate: s.bookingDate };
    const parts = distribute(s.amount, set.allocations);
    set.allocations.forEach((a, i) => {
      const entry = totals.get(a.propertyReferenceId) ?? { interest: 0n, principal: 0n };
      if (s.category === 'LOAN_INTEREST') entry.interest += parts[i] as bigint;
      else entry.principal += parts[i] as bigint;
      totals.set(a.propertyReferenceId, entry);
    });
  }
  const items = [...totals.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([propertyReferenceId, t]) => ({ propertyReferenceId, interest: t.interest, principal: t.principal }));
  return { kind: 'PER_PROPERTY', payments, items };
}

// Lender statements.

export type LoanBalanceStatementId = string & { readonly __brand: 'LoanBalanceStatementId' };

export const STATEMENT_STATUSES = ['VALID', 'VOID'] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

export interface StatementData {
  readonly statementDate: BusinessDate;
  /** ≥ 0, EUR. */
  readonly balance: Money;
  readonly source: string;
  readonly notes: string | null;
}

export interface LoanBalanceStatement extends StatementData {
  readonly id: LoanBalanceStatementId;
  readonly loanId: string;
  readonly mreRealmId: string;
  readonly status: StatementStatus;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** A statement with its comparison, derived at each read so it follows later corrections of the ledger. */
export interface StatementView extends LoanBalanceStatement {
  readonly comparison: {
    /** The actual remaining debt on `statementDate` as derived now, cents. */
    readonly actualOnDate: bigint;
    /** `balance − actualOnDate`, signed cents. */
    readonly difference: bigint;
  };
}

export function compareStatement(loan: Loan, splits: readonly CountedSplit[], statement: LoanBalanceStatement): StatementView {
  const actualOnDate = actualOn(loan, splits, statement.statementDate);
  return { ...statement, comparison: { actualOnDate, difference: toCents(statement.balance) - actualOnDate } };
}

/** The `VALID` statement with the latest `statementDate` on or before `asOf`; of several that day, the last created. */
export function latestStatementOn(statements: readonly LoanBalanceStatement[], asOf: BusinessDate): LoanBalanceStatement | null {
  let latest: LoanBalanceStatement | null = null;
  for (const s of statements) {
    if (s.status !== 'VALID' || s.statementDate > asOf) continue;
    if (latest === null || s.statementDate > latest.statementDate || (s.statementDate === latest.statementDate && s.createdAt >= latest.createdAt)) latest = s;
  }
  return latest;
}

/** Statements by `statementDate`, then `createdAt`, each with its comparison. */
export function statementViews(inputs: DebtInputs, status?: StatementStatus): StatementView[] {
  return [...inputs.statements]
    .filter((s) => status === undefined || s.status === status)
    .sort((x, y) => (x.statementDate !== y.statementDate ? (x.statementDate < y.statementDate ? -1 : 1) : x.createdAt.getTime() - y.createdAt.getTime()))
    .map((s) => compareStatement(inputs.loan, inputs.splits, s));
}

export function statementFingerprint(loanId: string, data: StatementData): string {
  return JSON.stringify([loanId, data.statementDate, data.balance.amount, data.source, data.notes]);
}

export type StatementRefusal =
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  | { readonly kind: 'STATEMENT_BEFORE_DEBT'; readonly debtFrom: BusinessDate }
  | { readonly kind: 'STATEMENT_AFTER_CLOSING'; readonly closingDate: BusinessDate };

/** Checks 3 and 4 of §41.6's create, then a `CLOSED` Loan's closing date (§41.7); undefined when it may be recorded. */
export function checkStatement(loan: Loan, statementDate: BusinessDate): StatementRefusal | undefined {
  if (loan.status === 'VOID') return { kind: 'LOAN_NOT_ACTIVE', status: loan.status };
  const from = debtFrom(loan);
  if (statementDate < from) return { kind: 'STATEMENT_BEFORE_DEBT', debtFrom: from };
  if (loan.status === 'CLOSED' && loan.closingDate !== null && statementDate > loan.closingDate)
    return { kind: 'STATEMENT_AFTER_CLOSING', closingDate: loan.closingDate };
  return undefined;
}

export type VoidStatementPlan =
  | { readonly kind: 'VOID'; readonly next: LoanBalanceStatement }
  /** Already void: a 200 no-op whatever the reason or version; the first reason and time stay. */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus };

export function planVoidStatement(loan: Loan, current: LoanBalanceStatement, reason: string, at: Date): VoidStatementPlan {
  if (current.status === 'VOID') return { kind: 'UNCHANGED' };
  if (loan.status === 'VOID') return { kind: 'LOAN_NOT_ACTIVE', status: loan.status };
  return { kind: 'VOID', next: { ...current, status: 'VOID', voidedAt: at, voidReason: reason, version: current.version + 1 } };
}

export type CreateStatementOutcome =
  | { readonly kind: 'CREATED'; readonly statement: StatementView }
  | { readonly kind: 'REPLAYED'; readonly statement: StatementView }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'LOAN_NOT_FOUND' }
  | StatementRefusal;

export type VoidStatementOutcome =
  | { readonly kind: 'VOIDED'; readonly statement: StatementView; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  | VersionConflict;

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface LoanDebtRepository {
  /** The Loan, its `VALID` periods, its sets, the counted splits and the statements in one `REPEATABLE READ READ ONLY` snapshot. */
  debtInputs(loanId: string, mreRealmId: string): Promise<DebtInputs | undefined>;
  /** The Loan `FOR UPDATE`, then `checkStatement`; claims the key in the same transaction. */
  createStatement(
    loanId: string,
    mreRealmId: string,
    data: StatementData,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateStatementOutcome>;
  /** The Loan `FOR UPDATE`, then the statement and `planVoidStatement`. */
  voidStatement(
    loanId: string,
    statementId: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidStatementOutcome>;
}
