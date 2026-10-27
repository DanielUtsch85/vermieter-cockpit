import { addDays, addMonths, type AuditActor, type BusinessDate, type Money, type VersionConflict } from '../../shared/index.js';
import { debtFrom, type Loan, type LoanStatus } from './loan.js';

/**
 * Loan terms (data-model.md §22, api-design.md §41.2, backlog VC-3-02): the Loan's conditions as periods, appended
 * after the last one, never edited, only the last one voidable (phase-3-plan P3-D2). The schedule is derived from them
 * on read, never stored (P3-D5): monthly payments from `firstPaymentDate`, interest `round_half_up(balance × rate /
 * 100 / 12)` to the cent (30/360), exact in cents and thousandths of a percent.
 */

export type LoanTermsId = string & { readonly __brand: 'LoanTermsId' };

export const REPAYMENT_MODELS = ['ANNUITY', 'INTEREST_ONLY'] as const;
export type RepaymentModel = (typeof REPAYMENT_MODELS)[number];

export const TERMS_STATUSES = ['VALID', 'VOID'] as const;
export type TermsStatus = (typeof TERMS_STATUSES)[number];

/** A rate in percent p.a. with at most three decimals, as thousandths of a percent ("3.450" → 3450n). */
export type RateMilli = bigint;

export interface LoanTermsData {
  readonly validFrom: BusinessDate;
  /** Percent p.a., `0 ≤ r < 100`, three decimals. */
  readonly interestRate: RateMilli;
  readonly repaymentModel: RepaymentModel;
  /** As on the contract; exactly for `ANNUITY`. */
  readonly scheduledPayment: Money | null;
  readonly firstPaymentDate: BusinessDate;
  /** Restarts the plan's balance; not on the first period, never above `principalOriginal`. */
  readonly principalAtStart: Money | null;
  readonly fixedRateUntil: BusinessDate | null;
  readonly initialRepaymentRate: RateMilli | null;
  readonly specialRepaymentLimit: Money | null;
  readonly notes: string | null;
}

export interface LoanTerms extends LoanTermsData {
  readonly id: LoanTermsId;
  readonly loanId: string;
  readonly mreRealmId: string;
  readonly status: TermsStatus;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** A period with its derived end: the day before the next `VALID` period's `validFrom`, `null` for the last. */
export interface LoanTermsView extends LoanTerms {
  readonly validUntil: BusinessDate | null;
}

const RATE = /^(\d{1,2})(?:\.(\d{1,3}))?$/;

/** `"3.45"` → 3450n; undefined when not a decimal with at most three decimals in `[0, 100)`. */
export function parseRate(value: string): RateMilli | undefined {
  const match = RATE.exec(value);
  if (match === null) return undefined;
  return BigInt(match[1] as string) * 1000n + BigInt((match[2] ?? '').padEnd(3, '0'));
}

/** 3450n → `"3.450"`. */
export function formatRate(rate: RateMilli): string {
  return `${rate / 1000n}.${(rate % 1000n).toString().padStart(3, '0')}`;
}

/** Cents of a two-decimal EUR amount. */
export function toCents(money: Money): bigint {
  const [whole = '0', fraction = ''] = money.amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

/** One month's interest on `balance` cents: `round_half_up(balance × rate / 100 / 12)`, rate in thousandths of a percent. */
export function monthlyInterest(balance: bigint, rate: RateMilli): bigint {
  const numerator = balance * rate;
  const denominator = 1_200_000n; // 100 (percent) × 1000 (thousandths) × 12 (months)
  return (2n * numerator + denominator) / (2n * denominator);
}

export interface ScheduleEntry {
  readonly termsId: string;
  readonly paymentDate: BusinessDate;
  /** Cents. */
  readonly balanceBefore: bigint;
  readonly interest: bigint;
  readonly principal: bigint;
  readonly payment: bigint;
  readonly balanceAfter: bigint;
}

/** The 50-year cap of P3-D5. */
export const MAX_PAYMENTS = 600;

/** A `VALID` period as the schedule reads it. */
export type SchedulePeriod = Pick<LoanTerms, 'id' | 'validFrom' | 'interestRate' | 'repaymentModel' | 'scheduledPayment' | 'firstPaymentDate' | 'principalAtStart'>;

/**
 * The planned payments (P3-D5), periods in `validFrom` order. A period's payments fall monthly from its
 * `firstPaymentDate` (the same day, clamped to the month's end) while before the next period's `validFrom`, not after
 * `maturityDate`, and while the balance is above zero; at most 600 in all. A period's balance is its
 * `principalAtStart`, else the balance carried over, the first one `principalOriginal`.
 */
export function deriveSchedule(principalOriginal: Money, maturityDate: BusinessDate | null, periods: readonly SchedulePeriod[]): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  let balance = toCents(principalOriginal);
  periods.forEach((period, i) => {
    if (period.principalAtStart !== null) balance = toCents(period.principalAtStart);
    const next = periods[i + 1]?.validFrom ?? null;
    for (let k = 0; balance > 0n && entries.length < MAX_PAYMENTS; k++) {
      const paymentDate = addMonths(period.firstPaymentDate, k);
      if ((next !== null && paymentDate >= next) || (maturityDate !== null && paymentDate > maturityDate)) break;
      const interest = monthlyInterest(balance, period.interestRate);
      const principal =
        period.repaymentModel === 'ANNUITY' && period.scheduledPayment !== null
          ? minBig(maxBig(toCents(period.scheduledPayment) - interest, 0n), balance)
          : 0n;
      entries.push({ termsId: period.id, paymentDate, balanceBefore: balance, interest, principal, payment: interest + principal, balanceAfter: balance - principal });
      balance -= principal;
      // An interest-only period never repays: one payment per month until the next period or maturity.
    }
  });
  return entries;
}

/**
 * The planned balance on `date`: the balance a period starting that day would start from. Walks the periods that
 * began before `date`: a period's `principalAtStart` restarts the balance, its payments before `date` lower it.
 */
export function plannedBalanceOn(principalOriginal: Money, maturityDate: BusinessDate | null, periods: readonly SchedulePeriod[], date: BusinessDate): bigint {
  const entries = deriveSchedule(principalOriginal, maturityDate, periods);
  let balance = toCents(principalOriginal);
  for (const period of periods) {
    if (period.validFrom >= date) break;
    if (period.principalAtStart !== null) balance = toCents(period.principalAtStart);
    for (const entry of entries) {
      if (entry.termsId === period.id && entry.paymentDate < date) balance = entry.balanceAfter;
    }
  }
  return balance;
}

const minBig = (x: bigint, y: bigint) => (x < y ? x : y);
const maxBig = (x: bigint, y: bigint) => (x > y ? x : y);

/** The derived `validUntil` of each period, over the `VALID` ones only; `VOID` ones get the end they would have. */
export function withValidUntil(items: readonly LoanTerms[]): LoanTermsView[] {
  const valid = items.filter((t) => t.status === 'VALID').map((t) => t.validFrom).sort();
  return items.map((t) => {
    const next = valid.find((from) => from > t.validFrom);
    return { ...t, validUntil: next === undefined ? null : addDays(next, -1) };
  });
}

/** Identity of a create request for `Idempotency-Key` replays: the Loan and the normalized payload. */
export function termsFingerprint(loanId: string, terms: LoanTermsData): string {
  return JSON.stringify([
    loanId,
    terms.validFrom,
    terms.interestRate.toString(),
    terms.repaymentModel,
    terms.scheduledPayment?.amount ?? null,
    terms.firstPaymentDate,
    terms.principalAtStart?.amount ?? null,
    terms.fixedRateUntil,
    terms.initialRepaymentRate?.toString() ?? null,
    terms.specialRepaymentLimit?.amount ?? null,
    terms.notes,
  ]);
}

export type AppendRefusal =
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  | { readonly kind: 'TERMS_BEFORE_DEBT'; readonly debtFrom: BusinessDate }
  | { readonly kind: 'TERMS_NOT_APPENDED'; readonly lastValidFrom: BusinessDate }
  | { readonly kind: 'PREVIOUS_TERMS_WITHOUT_PAYMENT'; readonly termsId: string; readonly firstPaymentDate: BusinessDate }
  | { readonly kind: 'PRINCIPAL_AT_START_ON_FIRST_TERMS' }
  | { readonly kind: 'PRINCIPAL_AT_START_EXCEEDS_ORIGINAL'; readonly principalOriginal: Money }
  | { readonly kind: 'PAYMENT_DOES_NOT_COVER_INTEREST'; readonly firstInterest: bigint; readonly balance: bigint };

/** Checks 3–7 of §41.2 against the Loan and its `VALID` periods (in `validFrom` order); undefined when the period may be appended. */
export function checkAppend(loan: Loan, valid: readonly LoanTerms[], terms: LoanTermsData): AppendRefusal | undefined {
  if (loan.status !== 'ACTIVE') return { kind: 'LOAN_NOT_ACTIVE', status: loan.status };
  const from = debtFrom(loan);
  if (terms.validFrom < from) return { kind: 'TERMS_BEFORE_DEBT', debtFrom: from };
  const last = valid.at(-1);
  if (last !== undefined && terms.validFrom <= last.validFrom) return { kind: 'TERMS_NOT_APPENDED', lastValidFrom: last.validFrom };
  if (last !== undefined && terms.validFrom <= last.firstPaymentDate) {
    return { kind: 'PREVIOUS_TERMS_WITHOUT_PAYMENT', termsId: last.id, firstPaymentDate: last.firstPaymentDate };
  }
  if (terms.principalAtStart !== null) {
    if (last === undefined) return { kind: 'PRINCIPAL_AT_START_ON_FIRST_TERMS' };
    if (toCents(terms.principalAtStart) > toCents(loan.principalOriginal)) return { kind: 'PRINCIPAL_AT_START_EXCEEDS_ORIGINAL', principalOriginal: loan.principalOriginal };
  }
  if (terms.repaymentModel === 'ANNUITY' && terms.scheduledPayment !== null) {
    const balance = terms.principalAtStart !== null ? toCents(terms.principalAtStart) : plannedBalanceOn(loan.principalOriginal, loan.maturityDate, valid, terms.validFrom);
    const firstInterest = monthlyInterest(balance, terms.interestRate);
    if (toCents(terms.scheduledPayment) <= firstInterest) return { kind: 'PAYMENT_DOES_NOT_COVER_INTEREST', firstInterest, balance };
  }
  return undefined;
}

export type VoidTermsPlan =
  | { readonly kind: 'VOID'; readonly next: LoanTerms }
  /** Already void: a 200 no-op whatever the reason or version; the first reason and time stay. */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'LOAN_NOT_ACTIVE'; readonly status: LoanStatus }
  /** Only the last `VALID` period is voidable (→ 409 TERMS_NOT_LAST). */
  | { readonly kind: 'TERMS_NOT_LAST'; readonly laterTermsId: string };

export function planVoidTerms(loan: Loan, current: LoanTerms, valid: readonly LoanTerms[], reason: string, at: Date): VoidTermsPlan {
  if (current.status === 'VOID') return { kind: 'UNCHANGED' };
  if (loan.status !== 'ACTIVE') return { kind: 'LOAN_NOT_ACTIVE', status: loan.status };
  const later = valid.find((t) => t.validFrom > current.validFrom);
  if (later !== undefined) return { kind: 'TERMS_NOT_LAST', laterTermsId: later.id };
  return { kind: 'VOID', next: { ...current, status: 'VOID', voidedAt: at, voidReason: reason, version: current.version + 1 } };
}

export type CreateTermsOutcome =
  | { readonly kind: 'CREATED'; readonly terms: LoanTermsView }
  | { readonly kind: 'REPLAYED'; readonly terms: LoanTermsView }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'LOAN_NOT_FOUND' }
  | AppendRefusal;

export type VoidTermsOutcome =
  | { readonly kind: 'VOIDED'; readonly terms: LoanTermsView; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | Exclude<VoidTermsPlan, { kind: 'VOID' | 'UNCHANGED' }>
  | VersionConflict;

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface LoanTermsRepository {
  /** The Loan `FOR UPDATE`, then its `VALID` periods, then `checkAppend`; claims the key in the same transaction. */
  create(
    loanId: string,
    mreRealmId: string,
    terms: LoanTermsData,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateTermsOutcome>;
  /** The Loan `FOR UPDATE`, then the period and the `VALID` periods, then `planVoidTerms`. */
  void(loanId: string, termsId: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidTermsOutcome>;
  /** The Loan's periods in `validFrom`, then `createdAt` order, with `validUntil`; undefined for an unknown or foreign Loan. */
  list(loanId: string, mreRealmId: string, status?: TermsStatus): Promise<readonly LoanTermsView[] | undefined>;
}
