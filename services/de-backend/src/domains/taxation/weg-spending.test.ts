import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { checkAnschaffungsnahe, type CheckAcquisition, type CheckSource } from './anschaffungsnahe.js';
import { planClassification, treatmentFieldsCheck, type SplitFacts, type TaxClassification, type TaxClassificationId } from './classification.js';
import { planDepositClassification } from './deposit-closing.js';
import { continuousOwners, distribute } from './distribution-82b.js';
import { DE_CATEGORY_DEFAULTS_V1 } from './rules/de-category-defaults.js';
import { RuleRegistry, TAX_RULES } from './rules/registry.js';
import { treatmentFits } from './vocabulary.js';
import {
  deriveWegTaxMeaning,
  planWegClassification,
  possiblyTwice,
  useFacts,
  wegNotCounted,
  withdrawalFacts,
  withdrawalUnitShare,
} from './weg-sources.js';

/** VC-7-03 (api-design.md §58B): the WEG sources, the fields of an election, § 82b and the anschaffungsnahe check. Synthetic figures. */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2026-10-30');
const rule = { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 };

const withdrawal = (overrides: Partial<Parameters<typeof withdrawalFacts>[0]> = {}, line: Partial<Parameters<typeof withdrawalFacts>[0]['line']> = {}) =>
  withdrawalFacts({
    statementId: 'st-1',
    status: 'CONFIRMED',
    supersededBy: null,
    financialYear: 2026,
    periodFrom: day('2026-01-01'),
    periodUntil: day('2026-12-31'),
    financialYearStartMonth: 1,
    membershipId: 'm-1',
    propertyReferenceId: 'pr-1',
    mea: { numerator: '125', denominator: '1000' },
    line: { position: 2, description: 'Dachreparatur', kind: 'WITHDRAWAL', withdrawal: eur('8000.00'), date: day('2026-06-15'), ...line },
    predecessor: null,
    ...overrides,
  });

const use = (overrides: Partial<Parameters<typeof useFacts>[0]> = {}) =>
  useFacts({
    assessmentId: 'a-1',
    storedStatus: 'ACTIVE',
    membershipId: 'm-1',
    propertyReferenceId: 'pr-1',
    financialYearStartMonth: 1,
    use: { position: 1, date: day('2027-06-10'), description: 'Fassade', unitShare: eur('14800.00') },
    usesExceedPaid: null,
    ...overrides,
  });

const classification = (overrides: Partial<TaxClassification> = {}): TaxClassification => ({
  id: 'c-1' as TaxClassificationId,
  mreRealmId: 'r',
  sourceType: 'WEG_ASSESSMENT_USE',
  sourceId: 'a-1',
  taxCategory: 'WEG_SPENDING',
  treatment: 'DEDUCTIBLE',
  reviewState: 'USER_CONFIRMED',
  rule: { ruleCode: 'DE_WEG_SPENDING', version: 1 },
  treatmentRule: null,
  advisorPartyId: null,
  notes: null,
  sourceReferences: [],
  taxYear: null,
  refundOfYear: null,
  depositClosing: null,
  sourcePosition: 1,
  reserveWithdrawal: null,
  assessmentUse: { date: day('2027-06-10'), unitShare: eur('14800.00') },
  netAmount: null,
  annuallyRecurring: false,
  distributionYears: null,
  mostlyResidentialConfirmed: null,
  anschaffungsnaheAcquisitionId: null,
  supersedes: null,
  supersededBy: null,
  supersededAt: null,
  createdAt: new Date('2027-07-01T10:00:00Z'),
  createdBy: 'anna@example.com',
  version: 1,
  ...overrides,
});

const wegRequest = {
  taxCategory: 'WEG_SPENDING',
  treatment: 'DEDUCTIBLE',
  supersedes: null,
  taxYear: null,
  netAmount: null,
  mostlyResidentialConfirmed: null,
  anschaffungsnaheAcquisitionId: null,
} as const;
const codes = (flags: readonly { code: string }[]) => flags.map((f) => f.code);

describe('the WEG sources (§58B)', () => {
  it('the default of both sources: UNCLASSIFIED, no treatment, NEEDS_REVIEW, by DE_WEG_SPENDING@1', () => {
    for (const facts of [withdrawal(), use()]) {
      expect(deriveWegTaxMeaning(facts, null, TAX_RULES, today)).toMatchObject({
        taxCategory: 'UNCLASSIFIED',
        treatment: null,
        reviewState: 'NEEDS_REVIEW',
        origin: 'DEFAULT',
        rule: { ruleCode: 'DE_WEG_SPENDING', version: 1 },
        treatmentRule: null,
        counts: true,
      });
    }
  });

  it('their lines and treatments; TREATMENT_NOT_ALLOWED with its details; WEG_SPENDING refused on a split and a deposit', () => {
    const ok = (taxCategory: string, treatment: string) =>
      planWegClassification(use(), null, { ...wegRequest, taxCategory, treatment } as never, TAX_RULES).kind === 'CLASSIFY';
    expect(ok('WEG_SPENDING', 'DEDUCTIBLE')).toBe(true);
    expect(ok('WEG_SPENDING', 'CAPITALIZED')).toBe(true);
    expect(ok('NOT_RELEVANT', 'NOT_RELEVANT')).toBe(true);
    expect(planWegClassification(use(), null, { ...wegRequest, taxCategory: 'MAINTENANCE' }, TAX_RULES)).toEqual({
      kind: 'TREATMENT_NOT_ALLOWED',
      categoryType: null,
      sourceType: 'WEG_ASSESSMENT_USE',
      allowed: ['DEDUCTIBLE', 'DISTRIBUTED_82B', 'CAPITALIZED', 'NOT_RELEVANT'],
      taxCategories: ['WEG_SPENDING', 'NOT_RELEVANT'],
    });
    expect(ok('WEG_SPENDING', 'NOT_RELEVANT')).toBe(false);
    const split: SplitFacts = {
      splitId: 's',
      transactionId: 't',
      position: 1,
      bookingDate: day('2026-05-14'),
      direction: 'OUTFLOW',
      amount: eur('1000.00'),
      financialCategoryCode: 'MAINTENANCE',
      categoryType: 'OPERATING_EXPENSE',
      propertyReferenceId: 'pr-1',
      transactionStatus: 'CONFIRMED',
      correctionRole: null,
    };
    expect(planClassification(split, null, { ...wegRequest }, TAX_RULES)).toMatchObject({
      kind: 'TREATMENT_NOT_ALLOWED',
      reason: 'WEG_SPENDING_ONLY_FOR_WEG_SOURCES',
    });
    const deposit = {
      securityDepositId: 'd',
      status: 'CLOSED',
      closingDate: day('2027-06-30'),
      retainedAmount: eur('400.00'),
      propertyReferenceId: null,
      propertyCandidates: [],
    };
    expect(planDepositClassification(deposit, null, { taxCategory: 'WEG_SPENDING', treatment: 'DEDUCTIBLE', supersedes: null }, TAX_RULES)).toMatchObject({
      kind: 'TREATMENT_NOT_ALLOWED',
      reason: 'WEG_SPENDING_ONLY_FOR_WEG_SOURCES',
    });
    // The WEG_FUNDS hard rule is unchanged: a WEG_SPECIAL_ASSESSMENT split is only NOT_RELEVANT.
    expect(
      planClassification({ ...split, financialCategoryCode: 'WEG_SPECIAL_ASSESSMENT', categoryType: 'WEG_FUNDS' }, null, { ...wegRequest, taxCategory: 'MAINTENANCE' }, TAX_RULES),
    ).toMatchObject({ kind: 'TREATMENT_NOT_ALLOWED', categoryType: 'WEG_FUNDS', allowed: ['NOT_RELEVANT'] });
  });

  it('the unit share: withdrawal × MEA, half-up to the cent; NOT_A_WITHDRAWAL for another kind, none or a zero share', () => {
    expect(withdrawalUnitShare(eur('8000.00'), { numerator: '125', denominator: '1000' })).toEqual(eur('1000.00'));
    // 0.04 × 125/1000 = 0.005 → 0.01 (the exact half up); 0.03 × 125/1000 = 0.00375 → 0.00.
    expect(withdrawalUnitShare(eur('0.04'), { numerator: '125', denominator: '1000' })).toEqual(eur('0.01'));
    expect(withdrawalUnitShare(eur('0.03'), { numerator: '125', denominator: '1000' })).toEqual(eur('0.00'));
    expect(withdrawalUnitShare(eur('1000.00'), { numerator: '125.5', denominator: '10000' })).toEqual(eur('12.55'));
    expect(withdrawal({}, { kind: 'CONTRIBUTION' }).notCounted).toMatchObject({ reason: 'NOT_A_WITHDRAWAL' });
    expect(withdrawal({}, { withdrawal: null }).notCounted).toMatchObject({ reason: 'NOT_A_WITHDRAWAL' });
    expect(withdrawal({}, { withdrawal: eur('0.03') }).notCounted).toMatchObject({ reason: 'NOT_A_WITHDRAWAL' });
    expect(withdrawal({ status: 'DRAFT' }).notCounted).toEqual({ reason: 'STATEMENT_NOT_CONFIRMED', details: { status: 'DRAFT' } });
    expect(withdrawal({ status: 'VOID' }).notCounted).toMatchObject({ reason: 'STATEMENT_NOT_CONFIRMED' });
    expect(withdrawal({ status: 'SUPERSEDED', supersededBy: 'st-2' }).notCounted).toEqual({ reason: 'STATEMENT_SUPERSEDED', details: { supersededBy: 'st-2' } });
    expect(deriveWegTaxMeaning(withdrawal({}, { kind: 'OTHER' }), null, TAX_RULES, today)).toMatchObject({ counts: false, notCountedReason: 'NOT_A_WITHDRAWAL' });
  });

  it('the date: its own; else the period end, WITHDRAWAL_DATE_ASSUMED; WEG_FINANCIAL_YEAR_NOT_CALENDAR for July, not for a short calendar period', () => {
    expect(withdrawal()).toMatchObject({ date: '2026-06-15', dateSource: 'WITHDRAWAL', allowedTaxYears: null, sourceFlags: [] });
    const undated = withdrawal({}, { date: null });
    expect(undated).toMatchObject({ date: '2026-12-31', dateSource: 'PERIOD_END', allowedTaxYears: [2026] });
    expect(codes(undated.sourceFlags)).toEqual(['WITHDRAWAL_DATE_ASSUMED']);
    const july = withdrawal({ financialYearStartMonth: 7, periodFrom: day('2025-07-01'), periodUntil: day('2026-06-30') }, { date: null });
    expect(july.sourceFlags).toEqual([
      { code: 'WITHDRAWAL_DATE_ASSUMED', details: { date: '2026-06-30', periodUntil: '2026-06-30' } },
      {
        code: 'WEG_FINANCIAL_YEAR_NOT_CALENDAR',
        details: { financialYear: 2026, financialYearStartMonth: 7, periodFrom: '2025-07-01', periodUntil: '2026-06-30' },
      },
    ]);
    expect(july.allowedTaxYears).toEqual([2025, 2026]);
    const short = withdrawal({ periodFrom: day('2026-04-01'), periodUntil: day('2026-12-31') }, { date: null });
    expect(codes(short.sourceFlags)).toEqual(['WITHDRAWAL_DATE_ASSUMED']);
  });

  it('the taxYear override: undated only, a year the period touches; with its own date 400 NOT_SUPPORTED', () => {
    const july = withdrawal({ financialYearStartMonth: 7, periodFrom: day('2025-07-01'), periodUntil: day('2026-06-30') }, { date: null });
    expect(planWegClassification(july, null, { ...wegRequest, taxYear: 2025 }, TAX_RULES)).toMatchObject({ kind: 'CLASSIFY' });
    expect(planWegClassification(july, null, { ...wegRequest, taxYear: 2027 }, TAX_RULES)).toEqual({
      kind: 'WITHDRAWAL_TAX_YEAR_OUT_OF_RANGE',
      taxYear: 2027,
      allowedYears: [2025, 2026],
    });
    expect(planWegClassification(withdrawal(), null, { ...wegRequest, taxYear: 2026 }, TAX_RULES)).toEqual({ kind: 'FIELD_NOT_SUPPORTED', field: 'taxYear' });
    const overridden = deriveWegTaxMeaning(july, classification({ sourceType: 'WEG_RESERVE_WITHDRAWAL', assessmentUse: null, taxYear: 2025 }), TAX_RULES, today);
    expect(overridden).toMatchObject({ taxYear: 2025, attribution: { rule: null, proposedYear: 2026, overridden: true } });
  });

  it('a use: counts; USE_CHANGED (date, unit share); a changed description alone still counts; ASSESSMENT_VOID', () => {
    const c = classification();
    expect(wegNotCounted(use(), c)).toBeNull();
    expect(wegNotCounted(use({ use: { position: 1, date: day('2027-06-10'), description: 'Fassade neu', unitShare: eur('14800.00') } }), c)).toBeNull();
    expect(wegNotCounted(use({ use: { position: 1, date: day('2027-06-11'), description: 'Fassade', unitShare: eur('14800.00') } }), c)).toMatchObject({
      reason: 'USE_CHANGED',
    });
    expect(wegNotCounted(use({ use: { position: 1, date: day('2027-06-10'), description: 'Fassade', unitShare: eur('14800.01') } }), c)).toMatchObject({
      reason: 'USE_CHANGED',
    });
    expect(wegNotCounted(use({ storedStatus: 'VOID' }), c)).toEqual({ reason: 'ASSESSMENT_VOID', details: {} });
    // A replace of the uses stops the classification, never the source: a new classification may follow.
    const changed = use({ use: { position: 1, date: day('2027-06-11'), description: 'Fassade', unitShare: eur('14800.00') } });
    expect(deriveWegTaxMeaning(changed, c, TAX_RULES, today)).toMatchObject({ counts: false, notCountedReason: 'USE_CHANGED', origin: 'CLASSIFICATION' });
    expect(planWegClassification(changed, 'c-1', { ...wegRequest, supersedes: 'c-1' }, TAX_RULES)).toMatchObject({
      kind: 'CLASSIFY',
      assessmentUse: { date: '2027-06-11' },
    });
    expect(planWegClassification(use({ storedStatus: 'VOID' }), null, wegRequest, TAX_RULES)).toMatchObject({
      kind: 'WEG_SOURCE_NOT_COUNTED',
      reason: 'ASSESSMENT_VOID',
    });
  });

  it('USES_EXCEED_PAID carried, informative; WEG_SPENDING_POSSIBLY_TWICE on equal unit shares in one financial year; PREDECESSOR_CLASSIFIED', () => {
    const exceeded = use({ usesExceedPaid: { uses: eur('14800.00'), paid: eur('7400.00') } });
    expect(deriveWegTaxMeaning(exceeded, null, TAX_RULES, today)).toMatchObject({ counts: true });
    expect(codes(deriveWegTaxMeaning(exceeded, null, TAX_RULES, today).flags)).toEqual(['USES_EXCEED_PAID']);
    const w = withdrawal({}, { withdrawal: eur('118400.00'), date: day('2027-03-01') });
    const u = use();
    const twice = possiblyTwice([w, u, use({ use: { position: 2, date: day('2028-01-02'), description: 'x', unitShare: eur('14800.00') } })]);
    expect(twice.get('WEG_RESERVE_WITHDRAWAL/st-1/2')).toEqual([{ sourceType: 'WEG_ASSESSMENT_USE', sourceId: 'a-1', sourcePosition: 1 }]);
    expect(twice.get('WEG_ASSESSMENT_USE/a-1/1')).toEqual([{ sourceType: 'WEG_RESERVE_WITHDRAWAL', sourceId: 'st-1', sourcePosition: 2 }]);
    expect(twice.get('WEG_ASSESSMENT_USE/a-1/2')).toBeUndefined();
    const successor = withdrawal({ statementId: 'st-2', predecessor: { statementId: 'st-1', classificationIds: ['c-9', 'c-3'] } });
    expect(deriveWegTaxMeaning(successor, null, TAX_RULES, today).flags).toContainEqual({
      code: 'PREDECESSOR_CLASSIFIED',
      details: { statementId: 'st-1', classificationIds: ['c-3', 'c-9'] },
    });
    expect(codes(deriveWegTaxMeaning(successor, classification({ sourceType: 'WEG_RESERVE_WITHDRAWAL' }), TAX_RULES, today).flags)).not.toContain(
      'PREDECESSOR_CLASSIFIED',
    );
  });

  it('no applicable rule before 2000 for the default; before 2004 for an election', () => {
    expect(planWegClassification(use({ use: { position: 1, date: day('1999-12-31'), description: 'x', unitShare: eur('10.00') } }), null, wegRequest, TAX_RULES)).toEqual({
      kind: 'NO_APPLICABLE_RULE',
      ruleCode: 'DE_WEG_SPENDING',
      date: '1999-12-31',
    });
    const old = use({ use: { position: 1, date: day('2003-12-31'), description: 'x', unitShare: eur('10.00') } });
    const election = { ...wegRequest, treatment: 'DISTRIBUTED_82B', mostlyResidentialConfirmed: true } as const;
    expect(planWegClassification(old, null, election, TAX_RULES)).toEqual({ kind: 'NO_APPLICABLE_RULE', ruleCode: 'DE_82B_DISTRIBUTION', date: '2003-12-31' });
    const fresh = use({ use: { position: 1, date: day('2004-01-01'), description: 'x', unitShare: eur('10.00') } });
    expect(planWegClassification(fresh, null, election, TAX_RULES)).toMatchObject({ kind: 'CLASSIFY', treatmentRule: rule });
  });
});

describe('the fields of §58B (treatmentFieldsCheck)', () => {
  const source = { date: day('2026-05-14'), direction: 'OUTFLOW', grossAmount: eur('18000.00'), propertyReferenceId: 'pr-1' } as const;
  const acquisition = { id: 'acq-1', propertyReferenceId: 'pr-1', status: 'CONFIRMED', transferDate: day('2026-03-15') };
  const request = { taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE' } as const;
  it('DISTRIBUTION_NOT_ALLOWED: NOT_MOSTLY_RESIDENTIAL, NOT_AN_OUTFLOW; the fit only with MAINTENANCE or WEG_SPENDING', () => {
    expect(treatmentFieldsCheck(source, { ...request, treatment: 'DISTRIBUTED_82B', mostlyResidentialConfirmed: false }, rule, undefined, TAX_RULES)).toEqual({
      kind: 'DISTRIBUTION_NOT_ALLOWED',
      reason: 'NOT_MOSTLY_RESIDENTIAL',
    });
    expect(
      treatmentFieldsCheck({ ...source, direction: 'INFLOW' }, { ...request, treatment: 'DISTRIBUTED_82B', mostlyResidentialConfirmed: true }, rule, undefined, TAX_RULES),
    ).toEqual({ kind: 'DISTRIBUTION_NOT_ALLOWED', reason: 'NOT_AN_OUTFLOW' });
    expect(treatmentFieldsCheck(source, { ...request, treatment: 'DISTRIBUTED_82B', mostlyResidentialConfirmed: true }, rule, undefined, TAX_RULES)).toEqual({
      treatmentRule: rule,
    });
    expect(treatmentFits('MAINTENANCE', 'DISTRIBUTED_82B')).toBe(true);
    expect(treatmentFits('WEG_SPENDING', 'DISTRIBUTED_82B')).toBe(true);
    expect(treatmentFits('INSURANCE', 'DISTRIBUTED_82B')).toBe(false);
  });

  it('NET_AMOUNT_EXCEEDS_GROSS above the gross amount, equal allowed (no VAT)', () => {
    expect(treatmentFieldsCheck(source, { ...request, netAmount: eur('18000.01') }, null, undefined, TAX_RULES)).toEqual({
      kind: 'NET_AMOUNT_EXCEEDS_GROSS',
      netAmount: eur('18000.01'),
      grossAmount: eur('18000.00'),
    });
    expect(treatmentFieldsCheck(source, { ...request, netAmount: eur('18000.00') }, null, undefined, TAX_RULES)).toEqual({ treatmentRule: null });
  });

  it('anschaffungsnaheAcquisitionId: 404, OTHER_PROPERTY_REFERENCE, ACQUISITION_NOT_CONFIRMED, OUTSIDE_WINDOW; else DE_ANSCHAFFUNGSNAHE@1', () => {
    const capitalise = { taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: 'acq-1' } as const;
    const check = (a: typeof acquisition | null, s = source) => treatmentFieldsCheck(s, capitalise, null, a, TAX_RULES);
    expect(check(null)).toEqual({ kind: 'ACQUISITION_NOT_FOUND', acquisitionId: 'acq-1' });
    expect(check({ ...acquisition, propertyReferenceId: 'pr-2' })).toMatchObject({ reason: 'OTHER_PROPERTY_REFERENCE' });
    expect(check({ ...acquisition, status: 'DRAFT' })).toMatchObject({ reason: 'ACQUISITION_NOT_CONFIRMED' });
    expect(check(acquisition, { ...source, date: day('2026-03-14') })).toMatchObject({ reason: 'OUTSIDE_WINDOW' });
    expect(check(acquisition, { ...source, date: day('2029-03-16') })).toMatchObject({ reason: 'OUTSIDE_WINDOW' });
    expect(check(acquisition, { ...source, date: day('2029-03-15') })).toEqual({ treatmentRule: { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 } });
    expect(check({ ...acquisition, transferDate: day('2003-06-01') }, { ...source, date: day('2003-07-01') })).toMatchObject({ reason: 'NO_APPLICABLE_RULE' });
  });
});

describe('§ 82b EStDV: the parts (§58B)', () => {
  const parts = (amount: string, years: number, ownerships: { id: string; validUntil: BusinessDate | null }[] = []) =>
    distribute({ amount: eur(amount), firstYear: 2026, years, rule, ownerships });
  it('1,000.00 over 3 → 333.33, 333.33, 333.34; 0.05 over 3 → 0.01, 0.01, 0.03; the parts sum exactly', () => {
    expect(parts('1000.00', 3).distribution.parts.map((p) => [p.year, p.amount.amount])).toEqual([
      [2026, '333.33'],
      [2027, '333.33'],
      [2028, '333.34'],
    ]);
    expect(parts('0.05', 3).distribution.parts.map((p) => p.amount.amount)).toEqual(['0.01', '0.01', '0.03']);
    expect(parts('9000.00', 5).distribution.parts.map((p) => p.amount.amount)).toEqual(['1800.00', '1800.00', '1800.00', '1800.00', '1800.00']);
    expect(parts('1000.00', 3).distribution).toMatchObject({ years: 3, firstYear: 2026, endYear: null, rule });
  });

  it('the end of ownership: every owner ended in F+1 → 333.33 and 666.67, DISTRIBUTION_ENDED; only some → OWNERSHIP_PARTLY_ENDED', () => {
    const ended = parts('1000.00', 3, [
      { id: 'o-2', validUntil: day('2027-04-30') },
      { id: 'o-1', validUntil: day('2026-12-31') },
    ]);
    expect(ended.distribution.parts.map((p) => [p.year, p.amount.amount])).toEqual([
      [2026, '333.33'],
      [2027, '666.67'],
    ]);
    expect(ended.distribution.endYear).toBe(2027);
    expect(ended.flags).toEqual([{ code: 'DISTRIBUTION_ENDED', details: { endYear: 2027, ownershipIds: ['o-1', 'o-2'], foldedYears: [2028] } }]);
    const partly = parts('1000.00', 3, [
      { id: 'o-1', validUntil: day('2027-04-30') },
      { id: 'o-2', validUntil: null },
    ]);
    expect(partly.distribution.parts).toHaveLength(3);
    expect(partly.flags).toEqual([{ code: 'OWNERSHIP_PARTLY_ENDED', details: { ownershipIds: ['o-1'] } }]);
    // Ended in the last year or later: nothing folds; no owners at all: nothing folds.
    expect(parts('1000.00', 3, [{ id: 'o-1', validUntil: day('2028-01-01') }]).flags).toEqual([]);
    expect(parts('1000.00', 3).flags).toEqual([]);
  });

  it('a mere ownership change is no end (review of the VC-7-04 spec): 1/2 → 1/1 the next day does not fold; a sale by all does; a co-owner sells: partly', () => {
    const fold = (ownerships: { id: string; partyId: string; validFrom: string; validUntil: string | null }[]) =>
      distribute({
        amount: eur('1000.00'),
        firstYear: 2026,
        years: 3,
        rule,
        ownerships: continuousOwners(
          ownerships.map((o) => ({ ...o, validFrom: day(o.validFrom), validUntil: o.validUntil === null ? null : day(o.validUntil) })),
          day('2026-05-14'),
        ),
      });
    // Anna 1/2 and Ben 1/2 until 30.06.2027; Anna continues at 1/1 from 01.07.2027: Anna never stopped owning.
    const change = fold([
      { id: 'o-1', partyId: 'anna', validFrom: '2026-01-01', validUntil: '2027-06-30' },
      { id: 'o-2', partyId: 'ben', validFrom: '2026-01-01', validUntil: '2027-06-30' },
      { id: 'o-3', partyId: 'anna', validFrom: '2027-07-01', validUntil: null },
    ]);
    expect(change.distribution.endYear).toBeNull();
    expect(change.flags).toEqual([{ code: 'OWNERSHIP_PARTLY_ENDED', details: { ownershipIds: ['o-2'] } }]);
    // Anna alone 1/2 → 1/1 the next day: no fold, no flag.
    const alone = fold([
      { id: 'o-1', partyId: 'anna', validFrom: '2026-01-01', validUntil: '2027-06-30' },
      { id: 'o-3', partyId: 'anna', validFrom: '2027-07-01', validUntil: null },
    ]);
    expect(alone.distribution.parts).toHaveLength(3);
    expect(alone.flags).toEqual([]);
    // A gap of a day is an end: continued on 02.07.2027 is a new ownership.
    expect(
      fold([
        { id: 'o-1', partyId: 'anna', validFrom: '2026-01-01', validUntil: '2027-06-30' },
        { id: 'o-3', partyId: 'anna', validFrom: '2027-07-02', validUntil: null },
      ]).distribution.endYear,
    ).toBe(2027);
    // A real sale by all owners: the continuous periods end in 2027, the rest folds into 2027.
    const sale = fold([
      { id: 'o-1', partyId: 'anna', validFrom: '2026-01-01', validUntil: '2027-06-30' },
      { id: 'o-3', partyId: 'anna', validFrom: '2027-07-01', validUntil: '2027-09-30' },
      { id: 'o-2', partyId: 'ben', validFrom: '2026-01-01', validUntil: '2027-09-30' },
    ]);
    expect(sale.distribution.parts.map((p) => [p.year, p.amount.amount])).toEqual([
      [2026, '333.33'],
      [2027, '666.67'],
    ]);
    expect(sale.flags[0]).toMatchObject({ code: 'DISTRIBUTION_ENDED', details: { endYear: 2027 } });
  });

  it('an owner who stops letting is not recognised: the parts run on as derived', () => {
    // DE knows no "own use" or vacancy (§ 82b Abs. 2 EStDV): the Ownership stays open, so nothing folds.
    expect(parts('9000.00', 3, [{ id: 'o-1', validUntil: null }]).distribution.parts.map((p) => p.amount.amount)).toEqual(['3000.00', '3000.00', '3000.00']);
  });
});

describe('the anschaffungsnahe check (§58B)', () => {
  const acquisition: CheckAcquisition = {
    id: 'acq-1',
    propertyReferenceId: 'pr-1',
    status: 'CONFIRMED',
    transferDate: day('2026-03-15'),
    acquiredShare: { numerator: 1, denominator: 1 },
    purchasePrice: eur('240000.00'),
  };
  const costs = [
    { category: 'REAL_ESTATE_TRANSFER_TAX', amount: eur('24000.00') },
    { category: 'FINANCING_RELATED', amount: eur('1500.00') },
  ];
  const allocation = { id: 'al-1', reviewState: 'CONFIRMED', totalAllocableAmount: eur('264000.00'), buildingAmount: eur('198000.00') };
  const source = (overrides: Partial<CheckSource> = {}): CheckSource => ({
    sourceType: 'TRANSACTION_SPLIT',
    sourceId: 's-1',
    sourcePosition: null,
    date: day('2027-05-14'),
    taxYear: 2027,
    taxCategory: 'MAINTENANCE',
    treatment: 'DEDUCTIBLE',
    reviewState: 'USER_CONFIRMED',
    origin: 'CLASSIFICATION',
    classificationId: 'c-1',
    grossAmount: eur('29700.00'),
    direction: 'OUTFLOW',
    netAmount: null,
    annuallyRecurring: false,
    anschaffungsnaheAcquisitionId: null,
    sourceFlags: [],
    ...overrides,
  });
  const check = (sources: CheckSource[], overrides: Partial<Parameters<typeof checkAnschaffungsnahe>[0]> = {}) =>
    checkAnschaffungsnahe({ acquisition, costs, allocation, sources, statements: [], today: day('2030-01-01'), ...overrides }, TAX_RULES);

  it('the basis: (price + costs without FINANCING_RELATED) × building / total; threshold 29,700.00; exactly 15 % is not above, one cent more is', () => {
    const at = check([source()]);
    expect(at.basis).toMatchObject({ acquisitionCosts: eur('24000.00'), basisAmount: eur('198000.00') });
    expect(at).toMatchObject({ threshold: '29700.00', status: 'NOT_ABOVE_THRESHOLD', percentOfBasis: '15.00', thresholdPercent: 15, final: false });
    expect(check([source({ grossAmount: eur('29700.01') })]).status).toBe('ABOVE_THRESHOLD');
    // Without costs: 240,000 × 198,000 / 264,000 = 180,000.00.
    expect(check([source()], { costs: [] }).basis?.basisAmount).toEqual(eur('180000.00'));
    // One rounding, half-up: 240,000.01 × 1/3 = 80,000.0033… → 80,000.00; the threshold keeps four places.
    const odd = check([source()], {
      costs: [],
      acquisition: { ...acquisition, purchasePrice: eur('240000.10') },
      allocation: { ...allocation, totalAllocableAmount: eur('3.00'), buildingAmount: eur('1.00') },
    });
    expect(odd.basis?.basisAmount).toEqual(eur('80000.03'));
    expect(odd.threshold).toBe('12000.0045');
  });

  it('net, else gross with VAT_NOT_SEPARATED and NOT_FINAL (GROSS_AMOUNTS); a refund reduces the sum; annually recurring left out', () => {
    const net = check([source({ grossAmount: eur('35000.00'), netAmount: eur('29700.00') })]);
    expect(net).toMatchObject({ status: 'NOT_ABOVE_THRESHOLD', final: true, sum: eur('29700.00') });
    const gross = check([source({ grossAmount: eur('35000.00') })]);
    expect(gross.status).toBe('ABOVE_THRESHOLD');
    expect(codes(gross.sources[0]?.flags ?? [])).toEqual(['VAT_NOT_SEPARATED', 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN']);
    expect(gross.flags[0]).toMatchObject({ code: 'NOT_FINAL', details: { reasons: ['GROSS_AMOUNTS'] } });
    const refund = check([source({ grossAmount: eur('35000.00') }), source({ sourceId: 's-2', direction: 'INFLOW', grossAmount: eur('5300.00') })]);
    expect(refund).toMatchObject({ sum: eur('29700.00'), status: 'NOT_ABOVE_THRESHOLD' });
    const recurring = check([source({ grossAmount: eur('35000.00'), annuallyRecurring: true })]);
    expect(recurring).toMatchObject({ sum: eur('0.00'), status: 'NOT_ABOVE_THRESHOLD', sources: [] });
    expect(recurring.excluded.map((e) => e.reason)).toEqual(['ANNUALLY_RECURRING']);
  });

  it('which are summed: MAINTENANCE / WEG_SPENDING with DEDUCTIBLE or DISTRIBUTED_82B, or CAPITALIZED on this check; unclassified listed', () => {
    const sources = [
      source({ sourceId: 'a', treatment: 'DISTRIBUTED_82B', grossAmount: eur('100.00') }),
      source({ sourceId: 'b', treatment: 'CAPITALIZED', grossAmount: eur('200.00') }),
      source({ sourceId: 'c', treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: 'acq-1', grossAmount: eur('400.00') }),
      source({ sourceId: 'd', taxCategory: 'INSURANCE', grossAmount: eur('800.00') }),
      source({ sourceId: 'e', taxCategory: 'UNCLASSIFIED', treatment: null, grossAmount: eur('1600.00') }),
      source({ sourceId: 'f', sourceType: 'WEG_ASSESSMENT_USE', sourcePosition: 1, taxCategory: 'WEG_SPENDING', grossAmount: eur('3200.00') }),
    ];
    const result = check(sources);
    expect(result.sources.map((s) => s.sourceId)).toEqual(['a', 'c', 'f']);
    expect(result.sum).toEqual(eur('3700.00'));
    expect(result.unclassified.map((s) => s.sourceId)).toEqual(['e']);
    expect(result.flags[0]).toMatchObject({ code: 'NOT_FINAL', details: { reasons: ['GROSS_AMOUNTS', 'UNCLASSIFIED_SOURCES'] } });
  });

  it('the window: the transfer day, the third anniversary, not the day before nor after; 29 February ends on 28 February', () => {
    const summed = (date: string, a = acquisition) => check([source({ date: day(date) })], { acquisition: a }).sources.length;
    expect(summed('2026-03-15')).toBe(1);
    expect(summed('2029-03-15')).toBe(1);
    expect(summed('2026-03-14')).toBe(0);
    expect(summed('2029-03-16')).toBe(0);
    const leap = { ...acquisition, transferDate: day('2028-02-29') };
    expect(check([], { acquisition: leap }).window).toEqual({ from: '2028-02-29', until: '2031-02-28' });
    expect(summed('2031-02-28', leap)).toBe(1);
    expect(summed('2031-03-01', leap)).toBe(0);
  });

  it('DATE_IS_BOOKING_DATE on day 89 and 90 inside each edge, not on day 91, with DATES_NEAR_WINDOW_EDGE', () => {
    const edge = (date: string) => check([source({ date: day(date) })]);
    for (const [date, side] of [
      ['2026-06-12', 'START'], // day 89
      ['2026-06-13', 'START'], // day 90
      ['2028-12-16', 'END'], // 89 days before 15.03.2029
      ['2028-12-15', 'END'], // 90 days before
    ] as const) {
      const result = edge(date);
      expect(result.sources[0]?.flags, date).toContainEqual({ code: 'DATE_IS_BOOKING_DATE', details: { edge: side, date } });
      expect((result.flags[0]?.details as { reasons: string[] }).reasons, date).toContain('DATES_NEAR_WINDOW_EDGE');
    }
    for (const date of ['2026-06-14', '2028-12-14']) {
      expect(codes(edge(date).sources[0]?.flags ?? []), date).not.toContain('DATE_IS_BOOKING_DATE');
      expect((edge(date).flags[0]?.details as { reasons: string[] }).reasons, date).not.toContain('DATES_NEAR_WINDOW_EDGE');
    }
  });

  it('the strip after the window (owner on VC-7-03): 60 days after its end excluded AFTER_WINDOW_NEAR_EDGE, NOT_FINAL; day 90 in, day 91 out; never summed', () => {
    const base = source({ sourceId: 'in', date: day('2027-05-14'), grossAmount: eur('1000.00'), netAmount: eur('1000.00') });
    const after = (date: string, overrides: Partial<CheckSource> = {}) =>
      check([base, source({ sourceId: 'after', date: day(date), grossAmount: eur('50000.00'), ...overrides })]);
    const sixty = after('2029-05-14');
    expect(sixty.sum).toEqual(eur('1000.00'));
    expect(sixty.sources.map((s) => s.sourceId)).toEqual(['in']);
    expect(sixty.excluded.map((e) => [e.sourceId, e.reason])).toEqual([['after', 'AFTER_WINDOW_NEAR_EDGE']]);
    expect(sixty.excluded[0]?.flags).toContainEqual({ code: 'DATE_IS_BOOKING_DATE', details: { edge: 'END', date: '2029-05-14' } });
    expect(sixty).toMatchObject({ final: false, status: 'NOT_ABOVE_THRESHOLD' });
    expect(sixty.flags[0]).toMatchObject({ code: 'NOT_FINAL', details: { reasons: ['DATES_NEAR_WINDOW_EDGE'] } });
    // Day 90 after 15.03.2029 is 13.06.2029; day 91 is 14.06.2029.
    expect(after('2029-06-13').excluded.map((e) => e.sourceId)).toEqual(['after']);
    expect(after('2029-06-14').excluded).toEqual([]);
    expect(after('2029-06-14')).toMatchObject({ final: true });
    // The same filter as the summed sources, plus the unclassified ones: other lines are not read.
    expect(after('2029-05-14', { taxCategory: 'INSURANCE' }).excluded).toEqual([]);
    expect(after('2029-05-14', { taxCategory: 'UNCLASSIFIED', treatment: null }).excluded.map((e) => e.reason)).toEqual(['AFTER_WINDOW_NEAR_EDGE']);
    // Before the window's start nothing extra is read.
    expect(after('2026-03-14').excluded).toEqual([]);
  });

  it('a partial acquisition: the sum × acquiredShare, flagged; above compared on the exact fraction', () => {
    const half = { ...acquisition, acquiredShare: { numerator: 1, denominator: 2 } };
    const result = check([source({ grossAmount: eur('59400.01'), netAmount: eur('59400.01') })], { acquisition: half });
    // 59,400.01 / 2 = 29,700.005: shown 29,700.01, compared exactly: above.
    expect(result).toMatchObject({ attributableAmount: eur('29700.01'), status: 'ABOVE_THRESHOLD' });
    expect(result.flags).toContainEqual({ code: 'PARTIAL_ACQUISITION', details: { acquiredShare: '1/2' } });
    expect(check([source({ grossAmount: eur('59400.00'), netAmount: eur('59400.00') })], { acquisition: half }).status).toBe('NOT_ABOVE_THRESHOLD');
  });

  it('every NOT_COMPUTABLE reason; never estimated', () => {
    const reason = (overrides: Partial<Parameters<typeof checkAnschaffungsnahe>[0]>) => check([source()], overrides).notComputableReason;
    expect(reason({ acquisition: { ...acquisition, transferDate: day('2003-12-31') } })).toBe('NO_APPLICABLE_RULE');
    expect(reason({ acquisition: { ...acquisition, status: 'DRAFT' } })).toBe('ACQUISITION_NOT_CONFIRMED');
    expect(reason({ allocation: null })).toBe('NO_ALLOCATION');
    expect(reason({ allocation: { ...allocation, reviewState: 'UNREVIEWED' } })).toBe('ALLOCATION_NOT_CONFIRMED');
    expect(reason({ allocation: { ...allocation, reviewState: 'NEEDS_REVIEW' } })).toBe('ALLOCATION_NOT_CONFIRMED');
    expect(reason({ allocation: { ...allocation, reviewState: 'ADVISOR_CONFIRMED' } })).toBeNull();
    expect(reason({ allocation: { ...allocation, buildingAmount: eur('0.00') } })).toBe('NO_BUILDING');
    const draft = check([source({ grossAmount: eur('99999.00') })], { acquisition: { ...acquisition, status: 'DRAFT' } });
    expect(draft).toMatchObject({ status: 'NOT_COMPUTABLE', threshold: null, percentOfBasis: null, affectedYears: null });
    expect(draft.sources).toHaveLength(1);
  });

  it('WINDOW_OPEN; WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED with an overlapping confirmed statement, not without', () => {
    expect((check([source()], { today: day('2029-03-15') }).flags[0]?.details as { reasons: string[] }).reasons).toContain('WINDOW_OPEN');
    expect((check([source()], { today: day('2029-03-16') }).flags[0]?.details as { reasons: string[] }).reasons).not.toContain('WINDOW_OPEN');
    const statements = [
      { id: 'st-2', periodFrom: day('2025-01-01'), periodUntil: day('2025-12-31') },
      { id: 'st-1', periodFrom: day('2026-01-01'), periodUntil: day('2026-12-31') },
    ];
    const withHausgeld = check([source({ netAmount: eur('1.00') })], { statements });
    expect(withHausgeld.flags).toContainEqual({ code: 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED', details: { statementIds: ['st-1'] } });
    expect(withHausgeld).toMatchObject({ final: false, status: 'NOT_ABOVE_THRESHOLD' });
    expect(check([source({ netAmount: eur('1.00') })], { statements: [statements[0] as (typeof statements)[number]] })).toMatchObject({ final: true });
  });

  it('above 15 %: every summed source flagged, affectedYears; a capitalisation on this check kept in the sum; below again ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE', () => {
    const repair = source({ sourceId: 'r', date: day('2026-05-14'), taxYear: 2026, grossAmount: eur('18000.00'), netAmount: eur('15126.05') });
    const use1 = source({ sourceType: 'WEG_ASSESSMENT_USE', sourceId: 'a', sourcePosition: 1, date: day('2027-06-10'), taxYear: 2027, taxCategory: 'WEG_SPENDING', grossAmount: eur('14800.00') });
    const above = check([repair, use1]);
    expect(above).toMatchObject({ status: 'ABOVE_THRESHOLD', sum: eur('29926.05'), affectedYears: [2026, 2027] });
    expect(above.sources.every((s) => s.suggestedTreatment === 'CAPITALIZED')).toBe(true);
    const capitalised = check([repair, { ...use1, treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: 'acq-1' }]);
    expect(capitalised).toMatchObject({ status: 'ABOVE_THRESHOLD', sum: eur('29926.05') });
    const below = check([{ ...repair, netAmount: eur('1000.00') }, { ...use1, treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: 'acq-1' }]);
    expect(below.status).toBe('NOT_ABOVE_THRESHOLD');
    expect(below.sources[1]?.flags).toContainEqual({ code: 'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE', details: { acquisitionId: 'acq-1' } });
  });
});

describe('the registry of VC-7-03 (§58B)', () => {
  it('five rules, no overlap; DE_CATEGORY_DEFAULTS@1 unchanged (its parameters against a fixed copy)', () => {
    expect(() => new RuleRegistry(TAX_RULES.codes().flatMap((code) => TAX_RULES.versions(code)))).not.toThrow();
    expect(TAX_RULES.codes()).toHaveLength(5);
    expect(TAX_RULES.select('DE_ANSCHAFFUNGSNAHE', day('2003-12-31'))).toBeUndefined();
    expect(TAX_RULES.select('DE_82B_DISTRIBUTION', day('2004-01-01'))?.version).toBe(1);
    expect(JSON.stringify(DE_CATEGORY_DEFAULTS_V1.parameters)).toBe(FROZEN_DEFAULTS_V1);
  });
});

/** DE_CATEGORY_DEFAULTS@1's parameters as frozen with VC-7-02 (review on #159): every change is a new version. */
const FROZEN_DEFAULTS_V1 = JSON.stringify({
  taxCategories: [
    'RENT',
    'OPERATING_COST_ADVANCES',
    'OPERATING_COST_SETTLEMENT',
    'OTHER_INCOME',
    'REFUNDS_OF_EARLIER_YEARS',
    'RETAINED_DEPOSIT_RENT',
    'RETAINED_DEPOSIT_DAMAGES',
    'LOAN_INTEREST',
    'FINANCING_COSTS',
    'WEG_HAUSGELD',
    'MAINTENANCE',
    'ADMINISTRATION',
    'INSURANCE',
    'PROPERTY_TAX',
    'BANK_FEES',
    'TAX_ADVICE',
    'TRAVEL',
    'OTHER_EXPENSE',
    'NOT_RELEVANT',
    'UNCLASSIFIED',
  ],
  treatments: ['INCOME', 'DEDUCTIBLE', 'CAPITALIZED', 'NOT_RELEVANT'],
  defaults: {
    RENT_BASE: { taxCategory: 'RENT', treatment: 'INCOME', reviewState: 'SUGGESTED' },
    RENT_OPERATING_COST_ADVANCE: { taxCategory: 'OPERATING_COST_ADVANCES', treatment: 'INCOME', reviewState: 'SUGGESTED' },
    RENT_OPERATING_COST_SETTLEMENT: { taxCategory: 'OPERATING_COST_SETTLEMENT', treatment: 'INCOME', reviewState: 'SUGGESTED' },
    OTHER_INCOME: { taxCategory: 'OTHER_INCOME', treatment: 'INCOME', reviewState: 'NEEDS_REVIEW' },
    LOAN_INTEREST: { taxCategory: 'LOAN_INTEREST', treatment: 'DEDUCTIBLE', reviewState: 'SUGGESTED' },
    LOAN_PRINCIPAL: { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', reviewState: 'SUGGESTED' },
    WEG_RECOVERABLE: { taxCategory: 'WEG_HAUSGELD', treatment: 'DEDUCTIBLE', reviewState: 'SUGGESTED' },
    WEG_NON_RECOVERABLE: { taxCategory: 'WEG_HAUSGELD', treatment: 'DEDUCTIBLE', reviewState: 'SUGGESTED' },
    WEG_RESERVE_CONTRIBUTION: { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', reviewState: 'SUGGESTED' },
    WEG_SPECIAL_ASSESSMENT: { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', reviewState: 'SUGGESTED' },
    MAINTENANCE: { taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', reviewState: 'SUGGESTED' },
    ADMINISTRATION: { taxCategory: 'ADMINISTRATION', treatment: 'DEDUCTIBLE', reviewState: 'SUGGESTED' },
    INSURANCE: { taxCategory: 'INSURANCE', treatment: 'DEDUCTIBLE', reviewState: 'SUGGESTED' },
    PROPERTY_TAX: { taxCategory: 'PROPERTY_TAX', treatment: 'DEDUCTIBLE', reviewState: 'SUGGESTED' },
    BANK_FEES: { taxCategory: 'BANK_FEES', treatment: 'DEDUCTIBLE', reviewState: 'SUGGESTED' },
    OTHER_EXPENSE: { taxCategory: 'UNCLASSIFIED', treatment: null, reviewState: 'NEEDS_REVIEW' },
    SECURITY_DEPOSIT: { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', reviewState: 'SUGGESTED' },
    SECURITY_DEPOSIT_INTEREST: { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', reviewState: 'SUGGESTED' },
    ACQUISITION: { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', reviewState: 'SUGGESTED' },
    OWNER_CONTRIBUTION: { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', reviewState: 'SUGGESTED' },
    OWNER_WITHDRAWAL: { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', reviewState: 'SUGGESTED' },
    TRANSFER: { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', reviewState: 'SUGGESTED' },
    OTHER: { taxCategory: 'UNCLASSIFIED', treatment: null, reviewState: 'NEEDS_REVIEW' },
  },
  unlisted: { taxCategory: 'UNCLASSIFIED', treatment: null, reviewState: 'NEEDS_REVIEW' },
  notRelevantOnlyCategoryTypes: ['WEG_FUNDS', 'SECURITY_DEPOSIT', 'TRANSFER'],
  forbiddenTreatmentsByCode: { LOAN_PRINCIPAL: ['DEDUCTIBLE'], ACQUISITION: ['CAPITALIZED'] },
  depositClosing: {
    default: { taxCategory: 'UNCLASSIFIED', treatment: null, reviewState: 'NEEDS_REVIEW' },
    taxCategories: ['RETAINED_DEPOSIT_RENT', 'RETAINED_DEPOSIT_DAMAGES', 'NOT_RELEVANT'],
    treatments: ['INCOME', 'NOT_RELEVANT'],
  },
});
