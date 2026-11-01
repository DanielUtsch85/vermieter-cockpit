import { describe, expect, it } from 'vitest';
import { RuleRegistry, type BusinessDate } from '../../shared/index.js';
import { constructionPeriodCheck, type ConstructionPeriodRecordFacts, type InterestSplitFacts } from './construction-period-checks.js';
import {
  STRICT_INTEREST_POLICY,
  constructionPeriodFlags,
  interestPolicyOn,
  interestReasonOf,
  isInterestSplit,
  planAmend,
  type ConstructionPeriodInterest,
  type ConstructionPeriodView,
  type InterestFacts,
} from './construction-period-interest.js';
import { DE_CONSTRUCTION_PERIOD_INTEREST_V1 } from './rules/de-construction-period-interest.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import { flagIsOpen } from './tax-year-review.js';

/**
 * §59E (VC-X-36), pure: which splits are interest, the conditions of a capitalised source each alone with its reason, the
 * land share to the cent, the record's flags on their edges, the amend's reset and the five checks of a classification's
 * create in their order. Synthetic ids and figures only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const [P1, P2] = ['0000aaaa-0000-4000-8000-000000000001', '0000aaaa-0000-4000-8000-000000000002'];
const L = '0000bbbb-0000-4000-8000-000000000001';
const R = '0000cccc-0000-4000-8000-000000000001';

const recordView = (o: Partial<ConstructionPeriodView> = {}): ConstructionPeriodView => ({
  id: R,
  loanId: L,
  propertyReferenceIds: [P1, P2],
  herstellungFrom: day('2028-01-15'),
  herstellungUntil: day('2028-10-31'),
  advanceExpenseDeductible: false,
  buildingFundsShare: { numerator: 1n, denominator: 1n },
  reviewState: 'CONFIRMED',
  status: 'VALID',
  deductibleSplitIds: [],
  capitalizedSplitIds: ['s-1'],
  ...o,
});

const facts = (o: Partial<InterestFacts> = {}): InterestFacts => ({
  splitId: 's-1',
  loanId: L,
  bookingDate: day('2028-03-31'),
  amountCents: 50_000n,
  transactionInterestCents: 50_000n,
  constructionPeriodInterestId: R,
  record: recordView(),
  policy: DE_CONSTRUCTION_PERIOD_INTEREST_V1.parameters,
  ...o,
});

describe('§59E: which splits are interest (the rule’s parameters)', () => {
  const policy = DE_CONSTRUCTION_PERIOD_INTEREST_V1.parameters;
  it('a LOAN_INTEREST category, or a classification naming LOAN_INTEREST or FINANCING_COSTS, whatever the line', () => {
    expect(isInterestSplit({ loanId: L, financialCategoryCode: 'LOAN_INTEREST', taxCategory: 'LOAN_INTEREST' }, policy)).toBe(true);
    // Interest classified MAINTENANCE stays interest: the conditions cannot be avoided by the line.
    expect(isInterestSplit({ loanId: null, financialCategoryCode: 'LOAN_INTEREST', taxCategory: 'MAINTENANCE' }, policy)).toBe(true);
    expect(isInterestSplit({ loanId: null, financialCategoryCode: 'REPAIRS', taxCategory: 'FINANCING_COSTS' }, policy)).toBe(true);
    expect(isInterestSplit({ loanId: null, financialCategoryCode: 'REPAIRS', taxCategory: 'LOAN_INTEREST' }, policy)).toBe(true);
    // Counter-checks: a repair is no interest; the parameter, not a constant, decides.
    expect(isInterestSplit({ loanId: null, financialCategoryCode: 'REPAIRS', taxCategory: 'MAINTENANCE' }, policy)).toBe(false);
    expect(
      isInterestSplit({ loanId: null, financialCategoryCode: 'LOAN_INTEREST', taxCategory: 'MAINTENANCE' }, { ...policy, interestCategoryCodes: [] }),
    ).toBe(false);
  });

  it('the policy of the booking date, else strict (a test registry without the rule)', () => {
    expect(interestPolicyOn(TAX_RULES, day('2028-03-31'))).toEqual({ rule: { ruleCode: 'DE_CONSTRUCTION_PERIOD_INTEREST', version: 1 }, policy: policyOf() });
    expect(interestPolicyOn(new RuleRegistry([]), day('2028-03-31'))).toEqual({ rule: null, policy: STRICT_INTEREST_POLICY });
    expect(interestPolicyOn(TAX_RULES, day('1999-12-31')).rule).toBeNull();
  });
  const policyOf = () => DE_CONSTRUCTION_PERIOD_INTEREST_V1.parameters;
});

describe('§59E: each condition alone fails the source with its reason', () => {
  it('a confirmed record naming P and the Loan, not deductible, the building’s share: a source; CONFIRMED and ADVISOR_CONFIRMED both', () => {
    expect(interestReasonOf(facts(), P1)).toBeNull();
    expect(interestReasonOf(facts({ record: recordView({ reviewState: 'ADVISOR_CONFIRMED' }) }), P2)).toBeNull();
  });

  it.each([
    ['no record', facts({ constructionPeriodInterestId: null, record: null }), 'CONSTRUCTION_PERIOD_INTEREST_MISSING'],
    ['VOID', facts({ record: recordView({ status: 'VOID' }) }), 'RECORD_VOID'],
    ['UNREVIEWED', facts({ record: recordView({ reviewState: 'UNREVIEWED' }) }), 'RECORD_NOT_CONFIRMED'],
    ['NEEDS_REVIEW', facts({ record: recordView({ reviewState: 'NEEDS_REVIEW' }) }), 'RECORD_NOT_CONFIRMED'],
    ['advanceExpenseDeductible', facts({ record: recordView({ advanceExpenseDeductible: true }) }), 'RECORD_DEDUCTIBLE'],
    ['another Loan (defensive)', facts({ loanId: '0000bbbb-0000-4000-8000-000000000009' }), 'RECORD_MISMATCH'],
    ['P not named', facts({ record: recordView({ propertyReferenceIds: [P2] }) }), 'PROPERTY_NOT_NAMED'],
  ] as const)('%s: %s', (_name, f, reason) => {
    expect(interestReasonOf(f, P1)).toBe(reason);
  });

  it('the land share: the split at most buildingFundsShare × its Transaction’s interest, exactly, to the cent', () => {
    const share = recordView({ buildingFundsShare: { numerator: 4n, denominator: 5n } });
    // 800.00 of 1,000.00 at 4/5: the edge is a source; one cent more is not.
    expect(interestReasonOf(facts({ record: share, amountCents: 80_000n, transactionInterestCents: 100_000n }), P1)).toBeNull();
    expect(interestReasonOf(facts({ record: share, amountCents: 80_001n, transactionInterestCents: 100_000n }), P1)).toBe('LAND_SHARE_NOT_SEPARATED');
    // Not separated in the cash: the whole debit as one split is refused at 4/5, accepted at 1/1.
    expect(interestReasonOf(facts({ record: share, amountCents: 100_000n, transactionInterestCents: 100_000n }), P1)).toBe('LAND_SHARE_NOT_SEPARATED');
    expect(interestReasonOf(facts({ amountCents: 100_000n, transactionInterestCents: 100_000n }), P1)).toBeNull();
  });

  it('the parameters decide: without capitalizedRequiresRecord no record is needed; without deductibleBlocksCapitalization case A passes', () => {
    const p = DE_CONSTRUCTION_PERIOD_INTEREST_V1.parameters;
    expect(interestReasonOf(facts({ record: null, policy: { ...p, capitalizedRequiresRecord: false } }), P1)).toBeNull();
    expect(
      interestReasonOf(facts({ record: recordView({ advanceExpenseDeductible: true }), policy: { ...p, deductibleBlocksCapitalization: false } }), P1),
    ).toBeNull();
    expect(interestReasonOf(facts({ record: recordView({ reviewState: 'CONFIRMED' }), policy: { ...p, recordReviewStates: ['ADVISOR_CONFIRMED'] } }), P1)).toBe(
      'RECORD_NOT_CONFIRMED',
    );
  });
});

describe('§59E: the record’s own flags', () => {
  const codes = (bookingDate: string, treatment: 'CAPITALIZED' | 'DEDUCTIBLE' = 'CAPITALIZED', record = recordView()) =>
    constructionPeriodFlags({ bookingDate: day(bookingDate), record }, treatment).map((f) => f.code);

  it('CONSTRUCTION_PERIOD_DATE_OUTSIDE on the day before herstellungFrom and after herstellungUntil, not on the two edges', () => {
    expect(codes('2028-01-14')).toEqual(['CONSTRUCTION_PERIOD_DATE_OUTSIDE']);
    expect(codes('2028-01-15')).toEqual([]);
    expect(codes('2028-10-31')).toEqual([]);
    expect(codes('2028-11-01')).toEqual(['CONSTRUCTION_PERIOD_DATE_OUTSIDE']);
    // An open period: never after it; a DEDUCTIBLE item is not judged by the period.
    expect(codes('2030-01-01', 'CAPITALIZED', recordView({ herstellungUntil: null }))).toEqual([]);
    expect(codes('2028-01-14', 'DEDUCTIBLE')).toEqual([]);
    expect(constructionPeriodFlags({ bookingDate: day('2028-01-14'), record: recordView() }, 'CAPITALIZED')[0]?.details).toEqual({
      bookingDate: '2028-01-14',
      herstellungFrom: '2028-01-15',
      herstellungUntil: '2028-10-31',
    });
  });

  it('CONSTRUCTION_PERIOD_TREATMENT_MIXED on every item of a record with both treatments: open, informative under ADVISOR_CONFIRMED', () => {
    const mixed = recordView({ deductibleSplitIds: ['s-2'], capitalizedSplitIds: ['s-1'] });
    const [flag] = constructionPeriodFlags({ bookingDate: day('2028-03-31'), record: mixed }, 'DEDUCTIBLE');
    expect(flag).toEqual({
      code: 'CONSTRUCTION_PERIOD_TREATMENT_MIXED',
      details: { constructionPeriodInterestId: R, deductibleSplitIds: ['s-2'], capitalizedSplitIds: ['s-1'], recordReviewState: 'CONFIRMED' },
    });
    const item = { treatment: 'DEDUCTIBLE', origin: 'CLASSIFICATION', reviewState: 'USER_CONFIRMED' } as const;
    expect(flagIsOpen('CONSTRUCTION_PERIOD_TREATMENT_MIXED', item, flag?.details)).toBe(true);
    const advisor = constructionPeriodFlags({ bookingDate: day('2028-03-31'), record: { ...mixed, reviewState: 'ADVISOR_CONFIRMED' } }, 'DEDUCTIBLE')[0];
    expect(flagIsOpen('CONSTRUCTION_PERIOD_TREATMENT_MIXED', item, advisor?.details)).toBe(false);
    // Counter-check: one treatment only is no flag.
    expect(codes('2028-03-31', 'CAPITALIZED', recordView({ deductibleSplitIds: [], capitalizedSplitIds: ['s-1', 's-2'] }))).toEqual([]);
    for (const code of ['INTEREST_CAPITALIZED_CONDITIONS_MISSING', 'CONSTRUCTION_PERIOD_DATE_OUTSIDE', 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS']) {
      expect(flagIsOpen(code, item), code).toBe(true);
    }
  });
});

describe('§59E: an amend never carries a changed fact under an old confirmation', () => {
  const record: ConstructionPeriodInterest = {
    id: R,
    mreRealmId: 'realm',
    loanId: L,
    propertyReferenceIds: [P1, P2],
    measure: 'Dachgeschossausbau, zwei neue Wohnungen (synthetisch)',
    herstellungFrom: day('2028-01-15'),
    herstellungUntil: day('2028-10-31'),
    useIntent: 'Vermietung der neuen Wohnungen',
    advanceExpenseDeductible: false,
    buildingFundsShare: { numerator: 1n, denominator: 1n },
    earlierYearsTreatment: 'keine Vorjahre betroffen',
    sourceReferences: ['Darlehensvertrag (synthetisch)'],
    notes: null,
    reviewState: 'ADVISOR_CONFIRMED',
    advisorPartyId: '0000dddd-0000-4000-8000-000000000001',
    status: 'VALID',
    voidedAt: null,
    voidReason: null,
    createdAt: new Date('2028-01-01T00:00:00Z'),
    createdBy: 'anna@example.com',
    updatedAt: new Date('2028-01-01T00:00:00Z'),
    version: 2,
  };

  it.each([
    ['advanceExpenseDeductible', { advanceExpenseDeductible: true }],
    ['buildingFundsShare', { buildingFundsShare: { numerator: 4n, denominator: 5n } }],
    ['herstellungUntil', { herstellungUntil: day('2028-12-31') }],
    ['propertyReferenceIds', { propertyReferenceIds: [P1] }],
    ['useIntent', { useIntent: 'Eigennutzung' }],
  ] as const)('%s resets to UNREVIEWED without an advisor', (key, changes) => {
    const plan = planAmend(record, changes);
    expect(plan).toMatchObject({ kind: 'AMEND', changed: [key], reviewState: 'UNREVIEWED', advisorPartyId: null });
  });

  it('notes and sourceReferences keep the review state; the same facts change nothing; a VOID record is refused', () => {
    expect(planAmend(record, { notes: 'Rechnung nachgereicht', sourceReferences: ['Bauvertrag (synthetisch)'] })).toMatchObject({
      reviewState: 'ADVISOR_CONFIRMED',
      changed: ['sourceReferences', 'notes'],
    });
    expect(planAmend(record, { propertyReferenceIds: [P2, P1, P1] })).toMatchObject({ changed: [], reviewState: 'ADVISOR_CONFIRMED' });
    expect(planAmend({ ...record, status: 'VOID' }, { notes: 'x' })).toEqual({ kind: 'RECORD_VOID' });
  });
});

describe('§59E: the five checks of a classification’s create, in their order', () => {
  const loanSplit: InterestSplitFacts = {
    bookingDate: day('2028-03-31'),
    loanId: L,
    propertyReferenceId: null,
    financialCategoryCode: 'LOAN_INTEREST',
    categoryType: 'FINANCING',
  };
  const prSplit: InterestSplitFacts = { ...loanSplit, loanId: null, propertyReferenceId: P1 };
  const record = (o: Partial<ConstructionPeriodRecordFacts> = {}): ConstructionPeriodRecordFacts => ({
    id: R,
    loanId: L,
    propertyReferenceIds: [P1, P2],
    advanceExpenseDeductible: false,
    status: 'VALID',
    ...o,
  });
  const allowed = ['DEDUCTIBLE', 'CAPITALIZED', 'NOT_RELEVANT'] as const;
  const check = (
    split: InterestSplitFacts,
    request: { taxCategory?: 'LOAN_INTEREST' | 'MAINTENANCE'; treatment: 'CAPITALIZED' | 'DEDUCTIBLE' | 'NOT_RELEVANT'; id: string | null },
    r: ConstructionPeriodRecordFacts | null | undefined,
  ) =>
    constructionPeriodCheck(
      split,
      { taxCategory: request.taxCategory ?? 'LOAN_INTEREST', treatment: request.treatment, constructionPeriodInterestId: request.id },
      r,
      TAX_RULES,
      allowed,
    );

  it('1. CAPITALIZED interest without a record: TREATMENT_NOT_ALLOWED, CONSTRUCTION_PERIOD_INTEREST_REQUIRED, also on MAINTENANCE', () => {
    const required = {
      kind: 'TREATMENT_NOT_ALLOWED',
      categoryType: 'FINANCING',
      allowed: ['DEDUCTIBLE', 'NOT_RELEVANT'],
      reason: 'CONSTRUCTION_PERIOD_INTEREST_REQUIRED',
    };
    expect(check(loanSplit, { treatment: 'CAPITALIZED', id: null }, undefined)).toEqual(required);
    expect(check(prSplit, { taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED', id: null }, undefined)).toEqual(required);
    // Counter-checks: DEDUCTIBLE interest needs none; a repair capitalised needs none.
    expect(check(loanSplit, { treatment: 'DEDUCTIBLE', id: null }, undefined)).toEqual({ treatmentRule: null });
    expect(check({ ...prSplit, financialCategoryCode: 'REPAIRS' }, { taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED', id: null }, undefined)).toEqual({
      treatmentRule: null,
    });
  });

  it('2.–5. not of the Realm, VOID, MISMATCH, DEDUCTIBLE, NOT_ALLOWED; a match stores DE_CONSTRUCTION_PERIOD_INTEREST@1', () => {
    expect(check(loanSplit, { treatment: 'CAPITALIZED', id: R }, null)).toEqual({
      kind: 'CONSTRUCTION_PERIOD_INTEREST_NOT_FOUND',
      constructionPeriodInterestId: R,
    });
    // VOID before the mismatch and the deductible check.
    expect(check(loanSplit, { treatment: 'CAPITALIZED', id: R }, record({ status: 'VOID', loanId: null, advanceExpenseDeductible: true }))).toMatchObject({
      kind: 'CONSTRUCTION_PERIOD_INTEREST_VOID',
    });
    expect(check(loanSplit, { treatment: 'CAPITALIZED', id: R }, record({ loanId: null, advanceExpenseDeductible: true }))).toEqual({
      kind: 'CONSTRUCTION_PERIOD_INTEREST_MISMATCH',
      loanId: L,
      propertyReferenceId: null,
      recordLoanId: null,
      recordPropertyReferenceIds: [P1, P2],
    });
    expect(check(prSplit, { treatment: 'CAPITALIZED', id: R }, record({ loanId: null, propertyReferenceIds: [P2] }))).toMatchObject({
      kind: 'CONSTRUCTION_PERIOD_INTEREST_MISMATCH',
    });
    expect(check(loanSplit, { treatment: 'CAPITALIZED', id: R }, record({ advanceExpenseDeductible: true }))).toEqual({
      kind: 'CONSTRUCTION_PERIOD_INTEREST_DEDUCTIBLE',
      constructionPeriodInterestId: R,
    });
    // Case A named as DEDUCTIBLE is the category of their own in case A: allowed.
    expect(check(loanSplit, { treatment: 'DEDUCTIBLE', id: R }, record({ advanceExpenseDeductible: true }))).toEqual({
      treatmentRule: { ruleCode: 'DE_CONSTRUCTION_PERIOD_INTEREST', version: 1 },
    });
    expect(
      check({ ...prSplit, financialCategoryCode: 'REPAIRS' }, { taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED', id: R }, record({ loanId: null })),
    ).toEqual({
      kind: 'CONSTRUCTION_PERIOD_INTEREST_NOT_ALLOWED',
      reason: 'NOT_INTEREST',
    });
    expect(check(loanSplit, { treatment: 'NOT_RELEVANT', id: R }, record())).toEqual({ kind: 'CONSTRUCTION_PERIOD_INTEREST_NOT_ALLOWED', reason: 'TREATMENT' });
    expect(check(loanSplit, { treatment: 'CAPITALIZED', id: R }, record({ reviewState: 'UNREVIEWED' } as never))).toEqual({
      treatmentRule: { ruleCode: 'DE_CONSTRUCTION_PERIOD_INTEREST', version: 1 },
    });
    expect(check(prSplit, { treatment: 'CAPITALIZED', id: R }, record({ loanId: null }))).toEqual({
      treatmentRule: { ruleCode: 'DE_CONSTRUCTION_PERIOD_INTEREST', version: 1 },
    });
  });
});
