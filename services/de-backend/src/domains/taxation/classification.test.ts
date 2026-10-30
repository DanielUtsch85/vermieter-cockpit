import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import {
  CATEGORY_DEFAULTS,
  DE_CATEGORY_DEFAULTS_V1,
  RuleRegistry,
  TAX_CATEGORIES,
  TAX_RULES,
  TREATMENTS,
  deriveTaxMeaning,
  planClassification,
  planReview,
  treatmentFits,
  treatmentRefusal,
  type SplitFacts,
  type TaxCategory,
  type TaxClassification,
  type TaxClassificationId,
  type Treatment,
} from './index.js';

/** VC-7-01 domain (api-design.md §55–§57): the default table, the fit, TREATMENT_NOT_ALLOWED, the derivation, the plans. */
const day = (value: string) => value as BusinessDate;
const today = day('2026-10-30');

/**
 * Every category seeded by the migrations (0008, 0038, 0044; 0041 moves WEG_RESERVE_CONTRIBUTION to WEG_FUNDS) with
 * its type. The repository test checks the same against the migrated database.
 */
const SEEDED: readonly (readonly [string, string])[] = [
  ['RENT_BASE', 'INCOME'],
  ['RENT_OPERATING_COST_ADVANCE', 'INCOME'],
  ['RENT_OPERATING_COST_SETTLEMENT', 'INCOME'],
  ['OTHER_INCOME', 'INCOME'],
  ['LOAN_INTEREST', 'FINANCING'],
  ['LOAN_PRINCIPAL', 'FINANCING'],
  ['WEG_RECOVERABLE', 'OPERATING_EXPENSE'],
  ['WEG_NON_RECOVERABLE', 'OPERATING_EXPENSE'],
  ['WEG_RESERVE_CONTRIBUTION', 'WEG_FUNDS'],
  ['WEG_SPECIAL_ASSESSMENT', 'WEG_FUNDS'],
  ['MAINTENANCE', 'OPERATING_EXPENSE'],
  ['ADMINISTRATION', 'OPERATING_EXPENSE'],
  ['INSURANCE', 'OPERATING_EXPENSE'],
  ['PROPERTY_TAX', 'OPERATING_EXPENSE'],
  ['BANK_FEES', 'OPERATING_EXPENSE'],
  ['OTHER_EXPENSE', 'OPERATING_EXPENSE'],
  ['SECURITY_DEPOSIT', 'SECURITY_DEPOSIT'],
  ['SECURITY_DEPOSIT_INTEREST', 'SECURITY_DEPOSIT'],
  ['ACQUISITION', 'CAPITAL_MOVEMENT'],
  ['OWNER_CONTRIBUTION', 'CAPITAL_MOVEMENT'],
  ['OWNER_WITHDRAWAL', 'CAPITAL_MOVEMENT'],
  ['TRANSFER', 'TRANSFER'],
  ['OTHER', 'OTHER'],
];

const facts = (overrides: Partial<SplitFacts> = {}): SplitFacts => ({
  splitId: 's-1',
  transactionId: 't-1',
  position: 1,
  bookingDate: day('2026-03-02'),
  direction: 'OUTFLOW',
  amount: Money.of('120.00', 'EUR'),
  financialCategoryCode: 'MAINTENANCE',
  categoryType: 'OPERATING_EXPENSE',
  propertyReferenceId: 'p-1',
  transactionStatus: 'CONFIRMED',
  correctionRole: null,
  ...overrides,
});

const classification = (overrides: Partial<TaxClassification> = {}): TaxClassification => ({
  id: 'c-1' as TaxClassificationId,
  mreRealmId: 'r',
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: 's-1',
  taxCategory: 'MAINTENANCE',
  treatment: 'CAPITALIZED',
  reviewState: 'USER_CONFIRMED',
  rule: { ruleCode: CATEGORY_DEFAULTS, version: 1 },
  advisorPartyId: null,
  notes: null,
  sourceReferences: [],
  taxYear: null,
  refundOfYear: null,
  depositClosing: null,
  supersedes: null,
  supersededBy: null,
  supersededAt: null,
  createdAt: new Date('2026-10-01T10:00:00Z'),
  createdBy: 'anna@example.com',
  version: 1,
  ...overrides,
});

const meaningOf = (code: string, type: string, extra: Partial<SplitFacts> = {}) =>
  deriveTaxMeaning(facts({ financialCategoryCode: code, categoryType: type as SplitFacts['categoryType'], ...extra }), null, null, TAX_RULES, today);

describe('the default table of DE_CATEGORY_DEFAULTS@1 (§55)', () => {
  it('lists every seeded category', () => {
    const listed = Object.keys(DE_CATEGORY_DEFAULTS_V1.parameters.defaults).sort();
    expect(listed).toEqual(SEEDED.map(([code]) => code).sort());
  });

  it('reads each category as the table says', () => {
    const table = Object.fromEntries(SEEDED.map(([code, type]) => [code, meaningOf(code, type)]));
    const row = (code: string) => {
      const m = table[code];
      return m === undefined ? undefined : [m.taxCategory, m.treatment, m.reviewState];
    };
    expect(row('RENT_BASE')).toEqual(['RENT', 'INCOME', 'SUGGESTED']);
    expect(row('RENT_OPERATING_COST_ADVANCE')).toEqual(['OPERATING_COST_ADVANCES', 'INCOME', 'SUGGESTED']);
    expect(row('RENT_OPERATING_COST_SETTLEMENT')).toEqual(['OPERATING_COST_SETTLEMENT', 'INCOME', 'SUGGESTED']);
    expect(row('OTHER_INCOME')).toEqual(['OTHER_INCOME', 'INCOME', 'NEEDS_REVIEW']);
    expect(row('LOAN_INTEREST')).toEqual(['LOAN_INTEREST', 'DEDUCTIBLE', 'SUGGESTED']);
    expect(row('LOAN_PRINCIPAL')).toEqual(['NOT_RELEVANT', 'NOT_RELEVANT', 'SUGGESTED']);
    for (const code of ['WEG_RECOVERABLE', 'WEG_NON_RECOVERABLE']) expect(row(code)).toEqual(['WEG_HAUSGELD', 'DEDUCTIBLE', 'SUGGESTED']);
    for (const code of ['WEG_RESERVE_CONTRIBUTION', 'WEG_SPECIAL_ASSESSMENT']) expect(row(code)).toEqual(['NOT_RELEVANT', 'NOT_RELEVANT', 'SUGGESTED']);
    expect(row('MAINTENANCE')).toEqual(['MAINTENANCE', 'DEDUCTIBLE', 'SUGGESTED']);
    for (const code of ['ADMINISTRATION', 'INSURANCE', 'PROPERTY_TAX', 'BANK_FEES']) expect(row(code)).toEqual([code, 'DEDUCTIBLE', 'SUGGESTED']);
    expect(row('OTHER_EXPENSE')).toEqual(['UNCLASSIFIED', null, 'NEEDS_REVIEW']);
    for (const code of ['SECURITY_DEPOSIT', 'SECURITY_DEPOSIT_INTEREST']) expect(row(code)).toEqual(['NOT_RELEVANT', 'NOT_RELEVANT', 'SUGGESTED']);
    expect(row('ACQUISITION')).toEqual(['NOT_RELEVANT', 'NOT_RELEVANT', 'SUGGESTED']);
    for (const code of ['OWNER_CONTRIBUTION', 'OWNER_WITHDRAWAL', 'TRANSFER']) expect(row(code)).toEqual(['NOT_RELEVANT', 'NOT_RELEVANT', 'SUGGESTED']);
    expect(row('OTHER')).toEqual(['UNCLASSIFIED', null, 'NEEDS_REVIEW']);
    for (const m of Object.values(table))
      expect(m).toMatchObject({ origin: 'DEFAULT', rule: { ruleCode: CATEGORY_DEFAULTS, version: 1 }, classificationId: null });
  });

  it('every default fits, and every default passes TREATMENT_NOT_ALLOWED', () => {
    for (const [code, type] of SEEDED) {
      const d = DE_CATEGORY_DEFAULTS_V1.parameters.defaults[code];
      if (d === undefined) throw new Error(code);
      expect(treatmentFits(d.taxCategory, d.treatment), code).toBe(true);
      expect(treatmentRefusal(DE_CATEGORY_DEFAULTS_V1, { code, categoryType: type }, d.treatment), code).toBeUndefined();
    }
  });

  it('an unknown code reads as OTHER; the direction does not change the default', () => {
    expect(TAX_CATEGORIES).not.toContain('ACQUISITION');
    expect(meaningOf('NEW_CODE_LATER', 'OPERATING_EXPENSE')).toMatchObject({ taxCategory: 'UNCLASSIFIED', treatment: null, reviewState: 'NEEDS_REVIEW' });
    expect(meaningOf('MAINTENANCE', 'OPERATING_EXPENSE', { direction: 'INFLOW' })).toMatchObject({ taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE' });
    expect(meaningOf('RENT_BASE', 'INCOME', { direction: 'OUTFLOW' })).toMatchObject({ taxCategory: 'RENT', treatment: 'INCOME' });
  });

  it('the parameters know the lines and treatments of VC-7-01, not those of VC-7-03', () => {
    expect(DE_CATEGORY_DEFAULTS_V1.parameters.taxCategories).toEqual(TAX_CATEGORIES.filter((c) => c !== 'WEG_SPENDING'));
    expect(DE_CATEGORY_DEFAULTS_V1.parameters.treatments).toEqual(TREATMENTS.filter((t) => t !== 'DISTRIBUTED_82B'));
  });
});

describe('the fit of taxCategory and treatment (§56)', () => {
  const fits = (c: TaxCategory) => [...TREATMENTS, null].filter((t) => treatmentFits(c, t));
  it('income lines only INCOME; NOT_RELEVANT only NOT_RELEVANT; UNCLASSIFIED only null; the others anything but INCOME and null', () => {
    for (const c of ['RENT', 'OPERATING_COST_ADVANCES', 'OPERATING_COST_SETTLEMENT', 'OTHER_INCOME'] as const) expect(fits(c)).toEqual(['INCOME']);
    expect(fits('NOT_RELEVANT')).toEqual(['NOT_RELEVANT']);
    expect(fits('UNCLASSIFIED')).toEqual([null]);
    for (const c of ['MAINTENANCE', 'LOAN_INTEREST', 'OTHER_EXPENSE', 'WEG_HAUSGELD', 'TAX_ADVICE'] as const) {
      expect(fits(c)).toEqual(['DEDUCTIBLE', 'CAPITALIZED', 'DISTRIBUTED_82B', 'NOT_RELEVANT']);
    }
  });
});

describe('TREATMENT_NOT_ALLOWED (§56)', () => {
  const refusal = (code: string, categoryType: string, treatment: Treatment | null) =>
    treatmentRefusal(DE_CATEGORY_DEFAULTS_V1, { code, categoryType }, treatment);
  it('WEG_FUNDS, SECURITY_DEPOSIT and TRANSFER only NOT_RELEVANT', () => {
    for (const [code, type] of [
      ['WEG_RESERVE_CONTRIBUTION', 'WEG_FUNDS'],
      ['WEG_SPECIAL_ASSESSMENT', 'WEG_FUNDS'],
      ['SECURITY_DEPOSIT', 'SECURITY_DEPOSIT'],
      ['SECURITY_DEPOSIT_INTEREST', 'SECURITY_DEPOSIT'],
      ['TRANSFER', 'TRANSFER'],
    ] as const) {
      expect(refusal(code, type, 'NOT_RELEVANT')).toBeUndefined();
      for (const t of ['INCOME', 'DEDUCTIBLE', 'CAPITALIZED', null] as const)
        expect(refusal(code, type, t)).toEqual({ categoryType: type, allowed: ['NOT_RELEVANT'] });
    }
  });
  it('LOAN_PRINCIPAL never DEDUCTIBLE, ACQUISITION never CAPITALIZED; every other category accepts every treatment', () => {
    expect(refusal('LOAN_PRINCIPAL', 'FINANCING', 'DEDUCTIBLE')).toEqual({ categoryType: 'FINANCING', allowed: ['INCOME', 'CAPITALIZED', 'NOT_RELEVANT'] });
    expect(refusal('LOAN_PRINCIPAL', 'FINANCING', 'CAPITALIZED')).toBeUndefined();
    expect(refusal('ACQUISITION', 'CAPITAL_MOVEMENT', 'CAPITALIZED')).toEqual({
      categoryType: 'CAPITAL_MOVEMENT',
      allowed: ['INCOME', 'DEDUCTIBLE', 'NOT_RELEVANT'],
    });
    for (const t of ['NOT_RELEVANT', 'DEDUCTIBLE', null] as const) expect(refusal('ACQUISITION', 'CAPITAL_MOVEMENT', t)).toBeUndefined();
    for (const t of [...TREATMENTS, null] as const) {
      expect(refusal('LOAN_INTEREST', 'FINANCING', t)).toBeUndefined();
      expect(refusal('MAINTENANCE', 'OPERATING_EXPENSE', t)).toBeUndefined();
      expect(refusal('OTHER', 'OTHER', t)).toBeUndefined();
    }
  });
});

describe('deriveTaxMeaning (§55)', () => {
  it('a classification wins over the default and keeps its rule', () => {
    const m = deriveTaxMeaning(facts(), classification(), null, TAX_RULES, today);
    expect(m).toMatchObject({
      origin: 'CLASSIFICATION',
      taxCategory: 'MAINTENANCE',
      treatment: 'CAPITALIZED',
      reviewState: 'USER_CONFIRMED',
      classificationId: 'c-1',
    });
    expect(m.flags).toEqual([]);
  });

  it('NOT_COUNTED for an unconfirmed, a corrected and a reversal Transaction; RECONCILED counts', () => {
    for (const [status, role] of [
      ['CLASSIFIED', null],
      ['CORRECTED', null],
      ['CONFIRMED', 'REVERSAL'],
      ['IGNORED', null],
    ] as const) {
      const m = deriveTaxMeaning(facts({ transactionStatus: status, correctionRole: role }), null, null, TAX_RULES, today);
      expect(m.counts).toBe(false);
      expect(m.flags).toEqual([{ code: 'NOT_COUNTED', details: { transactionStatus: status, correctionRole: role } }]);
    }
    expect(deriveTaxMeaning(facts({ transactionStatus: 'RECONCILED' }), null, null, TAX_RULES, today).counts).toBe(true);
    expect(deriveTaxMeaning(facts({ correctionRole: 'REPLACEMENT' }), null, null, TAX_RULES, today).counts).toBe(true);
  });

  it('CLASSIFICATION_ON_CORRECTED_SPLIT only without an own classification', () => {
    const original = { originalTransactionId: 't-0', classificationIds: ['c-9', 'c-8'] };
    const replacement = facts({ correctionRole: 'REPLACEMENT' });
    expect(deriveTaxMeaning(replacement, null, original, TAX_RULES, today).flags).toEqual([
      { code: 'CLASSIFICATION_ON_CORRECTED_SPLIT', details: { originalTransactionId: 't-0', classificationIds: ['c-8', 'c-9'] } },
    ]);
    expect(deriveTaxMeaning(replacement, classification(), original, TAX_RULES, today).flags).toEqual([]);
    expect(deriveTaxMeaning(replacement, null, { ...original, classificationIds: [] }, TAX_RULES, today).flags).toEqual([]);
  });

  it('RULE_SUPERSEDED when a later version of the rule applies today; never changes the meaning', () => {
    const v2 = { ...DE_CATEGORY_DEFAULTS_V1, version: 2, effectiveFrom: day('2026-01-01') };
    const registry = new RuleRegistry([{ ...DE_CATEGORY_DEFAULTS_V1, effectiveTo: day('2026-01-01') }, v2]);
    const m = deriveTaxMeaning(facts(), classification(), null, registry, today);
    expect(m).toMatchObject({ treatment: 'CAPITALIZED', rule: { version: 1 } });
    expect(m.flags).toEqual([{ code: 'RULE_SUPERSEDED', details: { ruleCode: CATEGORY_DEFAULTS, version: 1, applicableVersion: 2 } }]);
    expect(deriveTaxMeaning(facts(), classification(), null, registry, day('2025-06-01')).flags).toEqual([]);
    // The default takes the version of the booking date.
    expect(deriveTaxMeaning(facts({ bookingDate: day('2025-12-31') }), null, null, registry, today).rule).toEqual({ ruleCode: CATEGORY_DEFAULTS, version: 1 });
    expect(deriveTaxMeaning(facts({ bookingDate: day('2026-01-01') }), null, null, registry, today).rule).toEqual({ ruleCode: CATEGORY_DEFAULTS, version: 2 });
  });

  it('before every version of the rule: UNCLASSIFIED, NEEDS_REVIEW, no rule', () => {
    expect(deriveTaxMeaning(facts({ bookingDate: day('1999-12-31') }), null, null, TAX_RULES, today)).toMatchObject({
      taxCategory: 'UNCLASSIFIED',
      treatment: null,
      reviewState: 'NEEDS_REVIEW',
      rule: null,
    });
  });
});

describe('planClassification (§56 order of checks)', () => {
  const request = { treatment: 'DEDUCTIBLE' as Treatment | null, supersedes: null as string | null };
  it('SOURCE_NOT_COUNTED before NO_APPLICABLE_RULE before TREATMENT_NOT_ALLOWED before supersedes', () => {
    const fundsCorrected = facts({ financialCategoryCode: 'WEG_RESERVE_CONTRIBUTION', categoryType: 'WEG_FUNDS', transactionStatus: 'CORRECTED' });
    expect(planClassification(fundsCorrected, 'c-1', request, TAX_RULES)).toMatchObject({ kind: 'SOURCE_NOT_COUNTED', transactionStatus: 'CORRECTED' });
    expect(planClassification({ ...fundsCorrected, transactionStatus: 'CONFIRMED', bookingDate: day('1999-01-01') }, 'c-1', request, TAX_RULES)).toEqual({
      kind: 'NO_APPLICABLE_RULE',
      ruleCode: CATEGORY_DEFAULTS,
      date: '1999-01-01',
    });
    expect(planClassification({ ...fundsCorrected, transactionStatus: 'CONFIRMED' }, 'c-1', request, TAX_RULES)).toEqual({
      kind: 'TREATMENT_NOT_ALLOWED',
      categoryType: 'WEG_FUNDS',
      allowed: ['NOT_RELEVANT'],
    });
    expect(planClassification(facts(), 'c-1', request, TAX_RULES)).toEqual({ kind: 'CLASSIFICATION_EXISTS', currentClassificationId: 'c-1' });
    expect(planClassification(facts(), 'c-1', { ...request, supersedes: 'c-0' }, TAX_RULES)).toEqual({
      kind: 'NOT_CURRENT_CLASSIFICATION',
      currentClassificationId: 'c-1',
    });
    expect(planClassification(facts(), null, { ...request, supersedes: 'c-0' }, TAX_RULES)).toEqual({
      kind: 'NOT_CURRENT_CLASSIFICATION',
      currentClassificationId: null,
    });
    expect(planClassification(facts(), 'c-1', { ...request, supersedes: 'c-1' }, TAX_RULES)).toEqual({
      kind: 'CLASSIFY',
      rule: { ruleCode: CATEGORY_DEFAULTS, version: 1 },
    });
    expect(planClassification(facts(), null, request, TAX_RULES)).toEqual({ kind: 'CLASSIFY', rule: { ruleCode: CATEGORY_DEFAULTS, version: 1 } });
  });
});

describe('planReview (§57)', () => {
  const counted = { transactionStatus: 'CONFIRMED', correctionRole: null } as const;
  it('confirm: NEEDS_REVIEW → USER_CONFIRMED; again a no-op; from ADVISOR_CONFIRMED refused', () => {
    expect(planReview(classification({ reviewState: 'NEEDS_REVIEW' }), { kind: 'CONFIRM' }, counted, TAX_RULES)).toEqual({
      reviewState: 'USER_CONFIRMED',
      advisorPartyId: null,
      changed: true,
    });
    expect(planReview(classification(), { kind: 'CONFIRM' }, counted, TAX_RULES)).toMatchObject({ changed: false });
    expect(planReview(classification({ reviewState: 'ADVISOR_CONFIRMED' }), { kind: 'CONFIRM' }, counted, TAX_RULES)).toEqual({ kind: 'ADVISOR_CONFIRMED' });
  });

  it('advisor-confirm and mark-needs-review from any state; the same advisor again is a no-op', () => {
    const advisor = { kind: 'ADVISOR_CONFIRM', advisorPartyId: 'p-1', note: null } as const;
    for (const state of ['USER_CONFIRMED', 'NEEDS_REVIEW', 'ADVISOR_CONFIRMED'] as const) {
      expect(planReview(classification({ reviewState: state }), advisor, counted, TAX_RULES)).toMatchObject({
        reviewState: 'ADVISOR_CONFIRMED',
        advisorPartyId: 'p-1',
      });
      expect(
        planReview(classification({ reviewState: state, advisorPartyId: null }), { kind: 'MARK_NEEDS_REVIEW', reason: 'r' }, counted, TAX_RULES),
      ).toMatchObject({
        reviewState: 'NEEDS_REVIEW',
        advisorPartyId: null,
        changed: state !== 'NEEDS_REVIEW',
      });
    }
    expect(planReview(classification({ reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: 'p-1' }), advisor, counted, TAX_RULES)).toMatchObject({
      changed: false,
    });
    expect(planReview(classification({ reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: 'p-2' }), advisor, counted, TAX_RULES)).toMatchObject({
      changed: true,
    });
  });

  it('a superseded one is refused first; then the source must count and the rule resolve', () => {
    expect(planReview(classification({ supersededBy: 'c-2', reviewState: 'ADVISOR_CONFIRMED' }), { kind: 'CONFIRM' }, counted, TAX_RULES)).toEqual({
      kind: 'CLASSIFICATION_SUPERSEDED',
      supersededBy: 'c-2',
    });
    expect(planReview(classification(), { kind: 'CONFIRM' }, { transactionStatus: 'CORRECTED', correctionRole: null }, TAX_RULES)).toMatchObject({
      kind: 'SOURCE_NOT_COUNTED',
      transactionStatus: 'CORRECTED',
    });
    expect(planReview(classification({ rule: { ruleCode: CATEGORY_DEFAULTS, version: 9 } }), { kind: 'CONFIRM' }, counted, TAX_RULES)).toEqual({
      kind: 'RULE_NOT_REGISTERED',
      ruleCode: CATEGORY_DEFAULTS,
      version: 9,
    });
  });
});
