import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, centsOf, type BusinessDate } from '../../shared/index.js';
import { withValidUntil, type LoanAllocationSet } from '../financing/index.js';
import { yearOf } from './cash-timing.js';
import type { TaxMeaning } from './classification.js';
import type { ConstructionPeriodView, InterestFacts } from './construction-period-interest.js';
import { DE_CONSTRUCTION_PERIOD_INTEREST_V1 } from './rules/de-construction-period-interest.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import type { TaxYearDepreciationAsset } from './tax-year-depreciation.js';
import { UNCHANGED, asset, component, depreciationOf, part } from './tax-year-depreciation.test-support.js';
import { buildTaxYearView, type TaxYearRead, type TaxYearView, type ViewOwnership } from './tax-year-view.js';

/**
 * §59E "The flag's lifecycle" in the tax-year view (VC-X-36; the owner's decision of 2026-11-01:
 * `LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS` stays open until the interest provably enters the AfA basis exactly once, or
 * its classification is corrected). The owner's counter-check "only a `CAPITALIZED` Loan interest ⇒ `final: false`" on
 * the clean fixture of `tax-year-depreciation.test.ts`, at both levels; dropped only with the component on P's building
 * whose basis and owners' bases equal the item's; kept with each reason; `INTEREST_CAPITALIZED_CONDITIONS_MISSING` on a
 * PropertyReference's interest. Pure; synthetic ids and figures.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2029-10-15');
const PR = '0000bbbb-0000-4000-8000-000000000001';
const [A, B] = ['a', 'b'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000000`) as [string, string];
const BUILDING = '0000bbbb-0000-4000-8000-000000000010';
const KITCHEN = '0000bbbb-0000-4000-8000-000000000011';
const W = 'ACQUISITION:0000bbbb-0000-4000-8000-000000000002';
const L = '0000bbbb-0000-4000-8000-000000000031';
const R = '0000cccc-0000-4000-8000-000000000001';
const SPLIT = '0000bbbb-0000-4000-8000-000000000041';
const OWNERS: ViewOwnership[] = [3, 2].map((n, i) => ({
  id: `own-${i}`,
  partyId: i === 0 ? A : B,
  share: { numerator: n, denominator: 5 },
  validFrom: day('2026-07-01'),
  validUntil: null,
}));

function split(o: { propertyReferenceId?: string | null; treatment?: 'CAPITALIZED' | 'DEDUCTIBLE'; sourceId?: string } = {}): TaxMeaning {
  const date = day('2026-09-30');
  const sourceId = o.sourceId ?? SPLIT;
  return {
    splitId: sourceId,
    sourceId,
    sourceType: 'TRANSACTION_SPLIT',
    transactionId: '0000bbbb-0000-4000-8000-000000000051',
    position: 1,
    bookingDate: date,
    direction: 'OUTFLOW',
    amount: eur('100.00'),
    financialCategoryCode: 'LOAN_INTEREST',
    categoryType: 'FINANCING',
    propertyReferenceId: o.propertyReferenceId ?? null,
    transactionStatus: 'CONFIRMED',
    correctionRole: null,
    counts: true,
    taxCategory: 'LOAN_INTEREST',
    treatment: o.treatment ?? 'CAPITALIZED',
    reviewState: 'USER_CONFIRMED',
    origin: 'CLASSIFICATION',
    rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
    classificationId: '0000bbbb-0000-4000-8000-000000000061',
    taxYear: yearOf(date),
    attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: 2026, proposedYear: 2026, overridden: false },
    refund: null,
    netAmount: null,
    treatmentRule: { ruleCode: 'DE_CONSTRUCTION_PERIOD_INTEREST', version: 1 },
    distribution: null,
    suggestion: null,
    flags: [],
  };
}

const record = (o: Partial<ConstructionPeriodView> = {}): ConstructionPeriodView => ({
  id: R,
  loanId: L,
  propertyReferenceIds: [PR],
  herstellungFrom: day('2026-07-01'),
  herstellungUntil: null,
  advanceExpenseDeductible: false,
  buildingFundsShare: { numerator: 1n, denominator: 1n },
  reviewState: 'CONFIRMED',
  status: 'VALID',
  deductibleSplitIds: [],
  capitalizedSplitIds: [SPLIT],
  ...o,
});
const factsOf = (m: TaxMeaning, r: ConstructionPeriodView | null, loanId: string | null = L): InterestFacts => ({
  splitId: m.sourceId,
  loanId,
  bookingDate: m.bookingDate,
  amountCents: centsOf(m.amount),
  transactionInterestCents: centsOf(m.amount),
  constructionPeriodInterestId: r?.id ?? null,
  record: r,
  policy: DE_CONSTRUCTION_PERIOD_INTEREST_V1.parameters,
});

const SET = withValidUntil([
  {
    id: '0000eeee-0000-4000-8000-000000000001' as LoanAllocationSet['id'],
    loanId: L,
    mreRealmId: 'realm',
    status: 'VALID' as const,
    validFrom: day('2026-01-01'),
    basis: 'MANUAL' as const,
    allocations: [{ propertyReferenceId: PR, share: { numerator: 1n, denominator: 1n }, acquisitionId: null }],
    notes: null,
    voidedAt: null,
    voidReason: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    version: 1,
  },
]);

/** The item's component on an asset's index (not active in the year's AfA): basis and the owners' bases as given. */
const indexed = (basis: string, bases: Record<string, string>): TaxYearDepreciationAsset['componentIndex'][number] => ({
  componentId: `TRANSACTION_SPLIT:${SPLIT}`,
  source: { sourceType: 'TRANSACTION_SPLIT', sourceId: SPLIT, sourcePosition: null },
  computable: true,
  reasons: [],
  basis: eur(basis),
  partBases: Object.entries(bases).map(([participant, amount]) => ({ participant, amount: eur(amount) })),
});
const purchase = component(W, [part(A, '1526.40', { share: '3/5' }), part(B, '1017.60', { share: '2/5' })]);
const building = (index: TaxYearDepreciationAsset['componentIndex'] = []) =>
  asset(BUILDING, [purchase], { recording: UNCHANGED, componentIndex: [{ componentId: W, source: null, computable: true, reasons: [] }, ...index] });

/** The clean 2026 of ACC8 (final, nothing open) plus one attributed Loan interest item classified as given. */
function readOf(
  o: { record?: ConstructionPeriodView | null; assets?: TaxYearDepreciationAsset[]; treatment?: 'CAPITALIZED' | 'DEDUCTIBLE'; facts?: boolean } = {},
): TaxYearRead {
  const m = split({ treatment: o.treatment ?? 'CAPITALIZED' });
  const r = o.record === undefined ? record() : o.record;
  return {
    propertyReferenceId: PR,
    ownerPartyFound: null,
    sources: [],
    unattributedDeposits: [],
    ownerships: OWNERS,
    checks: [],
    attribution: { references: [], candidates: [] },
    allocatedLoanInterest: [{ item: { ...m, yearAmount: m.amount }, loanId: L }],
    loanAllocationSets: new Map([[L, SET]]),
    depreciation: depreciationOf(2026, o.assets ?? [building()]),
    ...(o.facts === false ? {} : { interest: new Map([[SPLIT, factsOf(m, r)]]) }),
  };
}
function viewOf(read: TaxYearRead, ownerPartyId: string | null = null): TaxYearView {
  const outcome = buildTaxYearView(read, { year: 2026, ownerPartyId, today, registry: TAX_RULES });
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
}
const notInBasis = (v: TaxYearView) => v.capitalized.items[0]?.flags.find((f) => f.code === 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS')?.details;
const IN_BASIS = [indexed('100.00', { [A]: '60.00', [B]: '40.00' })];

describe('§59E: only a CAPITALIZED Loan interest ⇒ final false (the owner’s counter-check)', () => {
  it('the clean year is final; one attributed CAPITALIZED item that is no source (record UNREVIEWED) holds it open at both levels, alone', () => {
    const clean = viewOf({ ...readOf(), allocatedLoanInterest: [] });
    expect(clean.review).toMatchObject({ final: true, open: [] });
    for (const level of [null, A, B]) {
      const v = viewOf(readOf({ record: record({ reviewState: 'UNREVIEWED' }) }), level);
      expect(v.review.open, String(level)).toEqual([{ code: 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS', count: 1 }]);
      expect(v.review.final, String(level)).toBe(false);
      expect(notInBasis(v)).toEqual({ loanId: L, allocationSetId: SET[0]?.id, reason: 'RECORD_NOT_CONFIRMED' });
    }
  });

  it('the same item as a source with its component (basis = P’s part, the owners’ bases its parts) makes the year final again, at both levels', () => {
    for (const level of [null, A, B]) {
      const v = viewOf(readOf({ assets: [building(IN_BASIS)] }), level);
      expect([v.review.final, v.review.open, notInBasis(v)], String(level)).toEqual([true, [], undefined]);
    }
    expect(viewOf(readOf({ assets: [building(IN_BASIS)] })).capitalized.items[0]?.component).toMatchObject({
      assetId: BUILDING,
      componentId: `TRANSACTION_SPLIT:${SPLIT}`,
    });
  });
});

describe('§59E: the flag kept with its reason until the interest provably entered P’s building basis exactly once', () => {
  it.each([
    ['no record (every classification before 0055)', { record: null }, 'CONSTRUCTION_PERIOD_INTEREST_MISSING'],
    ['the facts not read at all', { facts: false }, 'CONSTRUCTION_PERIOD_INTEREST_MISSING'],
    ['VOID', { record: record({ status: 'VOID' }) }, 'RECORD_VOID'],
    ['amended to case A', { record: record({ advanceExpenseDeductible: true }) }, 'RECORD_DEDUCTIBLE'],
    ['P not named', { record: record({ propertyReferenceIds: ['0000bbbb-0000-4000-8000-000000000099'] }) }, 'PROPERTY_NOT_NAMED'],
    ['the land share', { record: record({ buildingFundsShare: { numerator: 1n, denominator: 2n } }) }, 'LAND_SHARE_NOT_SEPARATED'],
    ['a source without a component on the building', {}, 'NO_COMPONENT'],
    ['no building at all (a self-built one)', { assets: [] }, 'NO_COMPONENT'],
    ['the component only on a separate asset', { assets: [asset(KITCHEN, [], { assetType: 'SEPARATE_ASSET', componentIndex: IN_BASIS })] }, 'NO_COMPONENT'],
    ['the whole split as the basis', { assets: [building([indexed('500.00', { [A]: '300.00', [B]: '200.00' })])] }, 'BASIS_MISMATCH'],
    ['an owner’s basis off by a cent', { assets: [building([indexed('100.00', { [A]: '60.01', [B]: '39.99' })])] }, 'BASIS_MISMATCH'],
    ['the component twice', { assets: [building([...IN_BASIS, ...IN_BASIS])] }, 'BASIS_MISMATCH'],
  ] as const)('%s: %s', (_name, options, reason) => {
    const v = viewOf(readOf(options as Parameters<typeof readOf>[0]));
    expect(notInBasis(v)).toMatchObject({ reason });
    expect(v.review.open).toContainEqual({ code: 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS', count: 1 });
  });

  it('gone with the classification: DEDUCTIBLE naming the record (case A) moves the item out of capitalized without the flag', () => {
    const v = viewOf(
      readOf({ treatment: 'DEDUCTIBLE', record: record({ advanceExpenseDeductible: true, capitalizedSplitIds: [], deductibleSplitIds: [SPLIT] }) }),
    );
    expect(v.capitalized.items).toEqual([]);
    expect(v.review.open).toEqual([]);
  });

  it('mixed treatment under one record: open, informative once ADVISOR_CONFIRMED (the item itself in the basis)', () => {
    const mixed = { deductibleSplitIds: ['0000bbbb-0000-4000-8000-000000000042'], capitalizedSplitIds: [SPLIT] };
    expect(viewOf(readOf({ record: record(mixed), assets: [building(IN_BASIS)] })).review.open).toEqual([
      { code: 'CONSTRUCTION_PERIOD_TREATMENT_MIXED', count: 1 },
    ]);
    const advisor = viewOf(readOf({ record: record({ ...mixed, reviewState: 'ADVISOR_CONFIRMED' }), assets: [building(IN_BASIS)] }));
    expect([advisor.review.final, advisor.review.info]).toEqual([true, [{ code: 'CONSTRUCTION_PERIOD_TREATMENT_MIXED', count: 1 }]]);
  });
});

describe('§59E: interest booked on a PropertyReference (open question 3)', () => {
  const listed = (r: ConstructionPeriodView | null) => {
    const m = split({ propertyReferenceId: PR, sourceId: '0000bbbb-0000-4000-8000-000000000043' });
    return {
      ...readOf(),
      allocatedLoanInterest: [],
      sources: [{ item: { ...m, yearAmount: m.amount }, listed: true }],
      interest: new Map([[m.sourceId, factsOf(m, r === null ? null : { ...r, loanId: null, capitalizedSplitIds: [m.sourceId] }, null)]]),
    };
  };

  it('CAPITALIZED interest failing the conditions carries INTEREST_CAPITALIZED_CONDITIONS_MISSING (open) with its reason; with them, none', () => {
    const v = viewOf(listed(null));
    expect(v.capitalized.items[0]?.flags).toContainEqual({
      code: 'INTEREST_CAPITALIZED_CONDITIONS_MISSING',
      details: { reason: 'CONSTRUCTION_PERIOD_INTEREST_MISSING' },
    });
    expect(v.review.open).toContainEqual({ code: 'INTEREST_CAPITALIZED_CONDITIONS_MISSING', count: 1 });
    expect(viewOf(listed(record({ reviewState: 'NEEDS_REVIEW' }))).capitalized.items[0]?.flags).toContainEqual({
      code: 'INTEREST_CAPITALIZED_CONDITIONS_MISSING',
      details: { reason: 'RECORD_NOT_CONFIRMED' },
    });
    const ok = viewOf(listed(record()));
    expect(ok.capitalized.items[0]?.flags.map((f) => f.code)).not.toContain('INTEREST_CAPITALIZED_CONDITIONS_MISSING');
    // Not the Loan flag: a PropertyReference's item is §59B's (NO_ASSET covers its basis).
    expect(ok.capitalized.items[0]?.flags.map((f) => f.code)).not.toContain('LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS');
  });
});
