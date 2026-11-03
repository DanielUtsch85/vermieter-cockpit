import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import { withValidUntil, type LoanAllocationSet, type LoanAllocationSetView } from '../financing/index.js';
import type { AllocationSetHistory, PartChangeInput } from './attribution-parts.js';
import type { HistoryRecord } from './attribution-history.js';
import { yearOf } from './cash-timing.js';
import type { TaxMeaning } from './classification.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import { NO_DEPRECIATION } from './tax-year-depreciation.js';
import type { LoanInterestSplit, TaxYearRead, ViewOwnership } from './tax-year-view.js';

/**
 * Builders of §58G's pure tests (VC-X-48): the worked example of api-design.md §58G (P1 < P2, Loan L, S1 `MANUAL` 3/5 and
 * 2/5 from 2027-02-01, S2 1/2 and 1/2 from 2027-07-01 appended on 2028-03-01 and voided on 2029-02-01, the debits d1–d4)
 * and the reads around it. Synthetic figures and ids only. Test support only.
 */
export const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
export const day = (value: string) => value as BusinessDate;
export const eur = (amount: string) => Money.of(amount, 'EUR');
export const today = day('2029-10-30');
/** PropertyReferences P1 < P2 and Parties A < B < C by id. */
export const [P1, P2] = [1, 2].map((n) => `0000c48a-0000-4000-8000-00000000000${n}`) as [string, string];
export const [A, B, C] = ['a', 'b', 'c'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000048`) as [string, string, string];
export const L = '0000c48b-0000-4000-8000-000000000001';
export const [S1, S2] = ['0000c48c-0000-4000-8000-000000000001', '0000c48c-0000-4000-8000-000000000002'];
export const rec = (auditRecordId: string, action: string, iso: string): HistoryRecord => ({ auditRecordId, action, occurredAt: new Date(iso) });

let seq = 0;
const id = () => `0000c48d-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** A counting `LOAN_INTEREST` split of L, `DEDUCTIBLE`, of the given tax year (default its booking year). */
export function interest(amount: string, bookingDate: string, taxYear = yearOf(day(bookingDate)), sourceId = id()): LoanInterestSplit {
  const date = day(bookingDate);
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
    treatment: 'DEDUCTIBLE',
    reviewState: 'USER_CONFIRMED',
    origin: 'CLASSIFICATION',
    rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
    classificationId: id(),
    taxYear,
    attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: yearOf(date), proposedYear: taxYear, overridden: false },
    refund: null,
    netAmount: null,
    performance: null,
    treatmentRule: null,
    distribution: null,
    suggestion: null,
    flags: [],
  };
  return { item: { ...meaning, yearAmount: meaning.amount }, loanId: L };
}

export function allocationSet(
  setId: string,
  validFrom: string,
  shares: readonly (readonly [string, string])[],
  status: 'VALID' | 'VOID' = 'VALID',
  basis: 'MANUAL' | 'PURCHASE_PRICE' = 'MANUAL',
): LoanAllocationSet {
  return {
    id: setId as LoanAllocationSet['id'],
    loanId: L,
    mreRealmId: 'realm',
    status,
    validFrom: day(validFrom),
    basis,
    allocations: shares.map(([propertyReferenceId, share]) => {
      const [n, d] = share.split('/') as [string, string];
      return { propertyReferenceId, share: { numerator: BigInt(n), denominator: BigInt(d) }, acquisitionId: null };
    }),
    notes: null,
    voidedAt: null,
    voidReason: null,
    createdAt: new Date('2027-02-01T10:00:00Z'),
    version: 1,
  };
}

/** The debits of the example (§58G "Example"); d3 is due 2027-12-31 and counts in 2027 by the 10-day rule. */
export const [D1, D2, D3, D4] = [1, 2, 3, 4].map((n) => `0000c48e-0000-4000-8000-00000000000${n}`) as [string, string, string, string];
export const DEBITS = {
  2027: [interest('450.01', '2027-03-31', 2027, D1), interest('449.99', '2027-07-30', 2027, D2), interest('448.00', '2028-01-03', 2027, D3)],
  2028: [interest('446.00', '2028-06-30', 2028, D4)],
} as const;

export const S1_SET = allocationSet(S1, '2027-02-01', [
  [P1, '3/5'],
  [P2, '2/5'],
]);
export const S1_HISTORY: AllocationSetHistory = { set: S1_SET, records: [rec('r-s1', 'CREATED', '2027-02-01T10:00:00Z')] };
const s2 = (status: 'VALID' | 'VOID') =>
  allocationSet(
    S2,
    '2027-07-01',
    [
      [P1, '1/2'],
      [P2, '1/2'],
    ],
    status,
  );
/** Step 1: S2 appended on 2028-03-01. */
export const STEP_1: AllocationSetHistory[] = [S1_HISTORY, { set: s2('VALID'), records: [rec('r-s2', 'CREATED', '2028-03-01T10:00:00Z')] }];
/** Step 2: S2 voided on 2029-02-01. */
export const STEP_2: AllocationSetHistory[] = [
  S1_HISTORY,
  { set: s2('VOID'), records: [rec('r-s2', 'CREATED', '2028-03-01T10:00:00Z'), rec('r-s2v', 'VOIDED', '2029-02-01T10:00:00Z')] },
];

/** The part input of `year` with the Loan's sets as given and the example's debits of `year` (or the given ones). */
export const partsOf = (sets: readonly AllocationSetHistory[], splits: readonly LoanInterestSplit[]): PartChangeInput => ({
  loans: [
    {
      loanId: L,
      candidates: splits.map((s) => ({ sourceId: s.item.sourceId, bookingDate: (s.item as TaxMeaning).bookingDate, amount: s.item.amount })),
      sets,
    },
  ],
});

const own = (party: string, share: string, from: string): ViewOwnership => {
  const [n, d] = share.split('/').map(Number) as [number, number];
  return { id: id(), partyId: party, share: { numerator: n, denominator: d }, validFrom: day(from), validUntil: null };
};
export const OWNERS: Record<string, ViewOwnership[]> = {
  [P1]: [own(A, '1/2', '2026-01-01'), own(B, '1/2', '2026-01-01')],
  [P2]: [own(C, '1/1', '2026-01-01')],
};

/** The view's read of P's `year` with the sets as now recorded (the history's current statuses) and §58G's part input. */
export function readOf(pr: string, year: 2027 | 2028, sets: readonly AllocationSetHistory[], extra: Partial<TaxYearRead> = {}): TaxYearRead {
  const splits = DEBITS[year];
  return {
    propertyReferenceId: pr,
    ownerPartyFound: null,
    sources: [],
    unattributedDeposits: [],
    ownerships: OWNERS[pr] ?? [],
    checks: [],
    attribution: { references: [], candidates: [] },
    allocatedLoanInterest: splits,
    loanAllocationSets: new Map<string, readonly LoanAllocationSetView[]>([[L, withValidUntil(sets.map((h) => h.set))]]),
    depreciation: NO_DEPRECIATION(year),
    parts: partsOf(sets, splits),
    ...extra,
  };
}
