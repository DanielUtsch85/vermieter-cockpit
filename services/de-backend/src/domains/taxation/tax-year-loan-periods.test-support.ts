import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { PHASE_7_DEPRECIATION } from './tax-year-depreciation.test-support.js';
import { Money, RuleRegistry, addMonths, type BusinessDate } from '../../shared/index.js';
import { withValidUntil, type AllocationBasis, type LoanAllocationSet, type LoanAllocationSetView } from '../financing/index.js';
import { refundOf, yearOf } from './cash-timing.js';
import type { TaxMeaning } from './classification.js';
import { interestPeriodOf, type InterestPeriod } from './loan-interest-periods.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import { buildTaxYearView, type LoanInterestSplit, type TaxYearRead, type TaxYearView, type ViewOwnership } from './tax-year-view.js';
import type { Treatment } from './vocabulary.js';

/**
 * Fixtures of §58L's examples (api-design.md §58L "Examples (synthetic)", VC-X-40): PropertyReferences P1 < P2, P1 owned
 * by A and B `"1/2"` each (A < B), P2 by C `"1/1"`, all from 2026-01-01; confirmed `OUTFLOW` debits with a `LOAN_INTEREST`
 * split carrying the Loan's `loanId`. Synthetic ids and figures only.
 */
export const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
export const day = (value: string) => value as BusinessDate;
export const eur = (amount: string) => Money.of(amount, 'EUR');
export const today = day('2028-03-01');
export const [P1, P2] = [1, 2].map((n) => `0000aaaa-0000-4000-8000-00000000000${n}`) as [string, string];
export const [A, B, C] = ['a', 'b', 'c'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000000`) as [string, string, string];
export const L = '0000bbbb-0000-4000-8000-000000000001';
let seq = 0;
export const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** Monthly payment dates from `first` (§41.4: the same day, clamped to the month's end), `count` of them. */
export const monthly = (first: string, count: number): BusinessDate[] => Array.from({ length: count }, (_, k) => addMonths(day(first), k));

/** The schedule's period of a booking date (rule 1), or a recorded one. */
export const scheduled = (bookingDate: string, debtFrom: string, first: string, count = 48): InterestPeriod | null =>
  interestPeriodOf(day(bookingDate), null, { debtFrom: day(debtFrom), paymentDates: monthly(first, count) });
export const recorded = (from: string, until: string): InterestPeriod => ({ from: day(from), until: day(until), source: 'CLASSIFICATION' });

/** A counting interest split of the Loan (no PropertyReference, 0027), `LOAN_INTEREST` / `DEDUCTIBLE` / `SUGGESTED`. */
export function split(
  amount: string,
  bookingDate: string,
  period: InterestPeriod | null,
  o: { readonly taxYear?: number; readonly treatment?: Treatment; readonly loanId?: string } = {},
): LoanInterestSplit {
  const date = day(bookingDate);
  const sourceId = id();
  const taxYear = o.taxYear ?? yearOf(date);
  const treatment = o.treatment ?? 'DEDUCTIBLE';
  const meaning: TaxMeaning = {
    splitId: sourceId,
    sourceId,
    sourceType: 'TRANSACTION_SPLIT',
    transactionId: id(),
    position: 1,
    bookingDate: date,
    direction: 'OUTFLOW',
    amount: eur(amount),
    financialCategoryCode: 'LOAN_INTEREST',
    categoryType: 'FINANCING',
    propertyReferenceId: null,
    transactionStatus: 'CONFIRMED',
    correctionRole: null,
    counts: true,
    taxCategory: 'LOAN_INTEREST',
    treatment,
    reviewState: treatment === 'CAPITALIZED' ? 'USER_CONFIRMED' : 'SUGGESTED',
    origin: treatment === 'CAPITALIZED' ? 'CLASSIFICATION' : 'DEFAULT',
    rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
    classificationId: treatment === 'CAPITALIZED' ? id() : null,
    taxYear,
    attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: yearOf(date), proposedYear: taxYear, overridden: false },
    refund: refundOf('OUTFLOW', 'LOAN_INTEREST', taxYear, null, null).refund,
    netAmount: null,
    performance: null,
    treatmentRule: null,
    distribution: null,
    suggestion: null,
    flags: [],
  };
  return { item: { ...meaning, yearAmount: meaning.amount }, loanId: o.loanId ?? L, period };
}

/** A set of the Loan: `[PropertyReference, "n/d"]` entries. */
export const set = (
  validFrom: string,
  shares: readonly (readonly [string, string])[],
  o: { readonly id?: string; readonly basis?: AllocationBasis; readonly status?: 'VALID' | 'VOID'; readonly loanId?: string } = {},
): LoanAllocationSet => ({
  id: (o.id ?? id()) as LoanAllocationSet['id'],
  loanId: o.loanId ?? L,
  mreRealmId: 'realm',
  status: o.status ?? 'VALID',
  validFrom: day(validFrom),
  basis: o.basis ?? 'MANUAL',
  allocations: shares.map(([propertyReferenceId, share]) => {
    const [n, d] = share.split('/') as [string, string];
    return { propertyReferenceId, share: { numerator: BigInt(n), denominator: BigInt(d) }, acquisitionId: o.basis === 'PURCHASE_PRICE' ? id() : null };
  }),
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2027-01-01T00:00:00Z'),
  version: 1,
});
export const views = (sets: readonly LoanAllocationSet[], loanId = L) =>
  new Map<string, readonly LoanAllocationSetView[]>([[loanId, withValidUntil([...sets].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1)))]]);

const own = (party: string, share: string): ViewOwnership => {
  const [n, d] = share.split('/').map(Number) as [number, number];
  return { id: `own-${party}`, partyId: party, share: { numerator: n, denominator: d }, validFrom: day('2026-01-01'), validUntil: null };
};
export const OWNERS: Record<string, ViewOwnership[]> = { [P1]: [own(A, '1/2'), own(B, '1/2')], [P2]: [own(C, '1/1')] };

export function readOf(
  pr: string,
  splits: readonly LoanInterestSplit[],
  sets: ReadonlyMap<string, readonly LoanAllocationSetView[]>,
  extra: Partial<TaxYearRead> = {},
): TaxYearRead {
  return {
    propertyReferenceId: pr,
    ownerPartyFound: null,
    sources: [],
    unattributedDeposits: [],
    ownerships: OWNERS[pr] ?? [],
    checks: [],
    attribution: { references: [], candidates: [] },
    allocatedLoanInterest: splits,
    loanAllocationSets: sets,
    depreciation: PHASE_7_DEPRECIATION,
    ...extra,
  };
}

export function viewOf(read: TaxYearRead, year = 2027, ownerPartyId: string | null = null): TaxYearView {
  const outcome = buildTaxYearView(read, { year, ownerPartyId, today, registry: TAX_RULES, fingerprinter });
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
}

export const interestLine = (v: TaxYearView) => v.werbungskosten.lines.find((l) => l.taxCategory === 'LOAN_INTEREST');
/** `[sourceId, lineAmount]` of the view's interest items. */
export const parts = (v: TaxYearView) => (interestLine(v)?.items ?? []).map((i) => [i.sourceId, i.lineAmount?.amount ?? null]);
export const flagOf = (v: TaxYearView, code: string) => v.flags.find((f) => f.code === code)?.details;
