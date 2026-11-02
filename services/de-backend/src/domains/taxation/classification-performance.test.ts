import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import {
  RuleRegistry,
  TAXATION_RULE_VERSIONS,
  classificationFingerprint,
  planClassification,
  type NewTaxClassification,
  type Performance,
  type SplitFacts,
} from './index.js';

/**
 * §59F "API" and "A capitalisation on the check" (VC-X-38; the owner's decisions of 2026-11-02): the checks of a
 * classification's performance that need the source, in their order after NET_AMOUNT_EXCEEDS_GROSS, and the
 * anschaffungsnahe link judged by the performance (PERFORMANCE_REQUIRED, OUTSIDE_WINDOW). Synthetic data only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const facts = (overrides: Partial<SplitFacts> = {}): SplitFacts => ({
  splitId: 's-1',
  transactionId: 't-1',
  position: 1,
  bookingDate: day('2027-05-14'),
  direction: 'OUTFLOW',
  amount: eur('10000.00'),
  financialCategoryCode: 'MAINTENANCE',
  categoryType: 'OPERATING_EXPENSE',
  propertyReferenceId: 'pr-1',
  transactionStatus: 'CONFIRMED',
  correctionRole: null,
  ...overrides,
});
const performed = (from: string, until: string, progress: [string, string][] = []): Performance => ({
  from: day(from),
  until: day(until),
  progress: progress.map(([through, amount]) => ({ through: day(through), amount: eur(amount) })),
  progressEstimated: progress.length === 0 ? null : false,
});
const acquisition = { id: 'acq-1', propertyReferenceId: 'pr-1', status: 'CONFIRMED', transferDate: day('2026-03-15') };
type Request = Parameters<typeof planClassification>[2];
const plan = (request: Partial<Request>, split: Partial<SplitFacts> = {}, acq: typeof acquisition | null = acquisition) =>
  planClassification(
    facts(split),
    null,
    { taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', supersedes: null, taxYear: null, refundOfYear: null, sourceReferences: ['Rechnung 1'], ...request },
    TAX_RULES,
    undefined,
    acq,
  );

describe('the checks of a performance on create (§59F "Order of checks")', () => {
  it('interest refused: a LOAN_INTEREST split classified MAINTENANCE; counter-check: a MAINTENANCE split accepted', () => {
    expect(plan({ performance: performed('2027-05-01', '2027-05-14') }, { financialCategoryCode: 'LOAN_INTEREST', categoryType: 'FINANCING' })).toMatchObject({
      kind: 'PERFORMANCE_NOT_ALLOWED',
    });
    expect(plan({ performance: performed('2027-05-01', '2027-05-14') })).toMatchObject({ kind: 'CLASSIFY' });
  });

  it('a point not below the amount used refused (the net amount, else the gross); one cent below accepted', () => {
    expect(plan({ performance: performed('2027-05-01', '2027-05-14', [['2027-05-07', '10000.00']]) })).toEqual({
      kind: 'PERFORMANCE_PROGRESS_EXCEEDS_AMOUNT',
      amountUsed: eur('10000.00'),
      amount: eur('10000.00'),
    });
    expect(plan({ netAmount: eur('8403.36'), performance: performed('2027-05-01', '2027-05-14', [['2027-05-07', '8403.36']]) })).toMatchObject({
      kind: 'PERFORMANCE_PROGRESS_EXCEEDS_AMOUNT',
      amountUsed: eur('8403.36'),
    });
    expect(plan({ performance: performed('2027-05-01', '2027-05-14', [['2027-05-07', '9999.99']]) })).toMatchObject({ kind: 'CLASSIFY' });
  });

  it('points without a source reference refused (PERFORMANCE_EVIDENCE_REQUIRED); a period alone needs none', () => {
    expect(plan({ sourceReferences: [], performance: performed('2027-05-01', '2027-05-14', [['2027-05-07', '100.00']]) })).toEqual({
      kind: 'PERFORMANCE_EVIDENCE_REQUIRED',
    });
    expect(plan({ sourceReferences: [], performance: performed('2027-05-01', '2027-05-14') })).toMatchObject({ kind: 'CLASSIFY' });
  });

  it('PERFORMANCE_OUT_OF_RANGE beyond three years of the source date, both directions; the edges accepted', () => {
    expect(plan({ performance: performed('2024-05-13', '2024-06-01') })).toEqual({
      kind: 'PERFORMANCE_OUT_OF_RANGE',
      sourceDate: '2027-05-14',
      from: '2024-05-13',
      until: '2024-06-01',
      allowedFrom: '2024-05-14',
      allowedUntil: '2030-05-14',
    });
    expect(plan({ performance: performed('2030-05-01', '2030-05-15') })).toMatchObject({ kind: 'PERFORMANCE_OUT_OF_RANGE' });
    expect(plan({ performance: performed('2024-05-14', '2030-05-14') })).toMatchObject({ kind: 'CLASSIFY' });
  });

  it('the order: NET_AMOUNT_EXCEEDS_GROSS before the performance, the performance before the Acquisition (404)', () => {
    const bad = performed('2020-01-01', '2020-01-02');
    expect(plan({ netAmount: eur('10000.01'), performance: bad })).toMatchObject({ kind: 'NET_AMOUNT_EXCEEDS_GROSS' });
    expect(plan({ treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: 'acq-x', performance: bad }, {}, null)).toMatchObject({
      kind: 'PERFORMANCE_OUT_OF_RANGE',
    });
  });
});

describe('a capitalisation on the check needs sufficient performance data (§59F, open question 12)', () => {
  const capitalise = (performance: Performance | null, split: Partial<SplitFacts> = {}) =>
    plan({ treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: 'acq-1', performance }, split);
  it('MISSING without; STRADDLES_WINDOW at either edge; OUTSIDE_WINDOW by the performance; wholly inside accepted, the booking date outside', () => {
    expect(capitalise(null)).toEqual({ kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE', reason: 'PERFORMANCE_REQUIRED', acquisitionId: 'acq-1', cause: 'MISSING' });
    expect(capitalise(performed('2029-02-01', '2029-04-15'), { bookingDate: day('2029-04-30') })).toEqual({
      kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE',
      reason: 'PERFORMANCE_REQUIRED',
      acquisitionId: 'acq-1',
      cause: 'STRADDLES_WINDOW',
    });
    expect(capitalise(performed('2026-03-01', '2026-03-20'), { bookingDate: day('2026-03-20') })).toMatchObject({ cause: 'STRADDLES_WINDOW' });
    expect(capitalise(performed('2026-01-10', '2026-02-20'), { bookingDate: day('2026-04-01') })).toEqual({
      kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE',
      reason: 'OUTSIDE_WINDOW',
      acquisitionId: 'acq-1',
    });
    // Booked 117 days after the window, performed in it: accepted (never judged by the booking date).
    expect(capitalise(performed('2028-11-02', '2028-12-20'), { bookingDate: day('2029-07-10') })).toEqual({
      kind: 'CLASSIFY',
      rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
      treatmentRule: { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 },
    });
    // Counter-check: booked inside the window, performed after it: refused.
    expect(capitalise(performed('2029-03-16', '2029-03-20'), { bookingDate: day('2028-01-10') })).toMatchObject({ reason: 'OUTSIDE_WINDOW' });
  });
});

describe('the fingerprint (§59F "Idempotency")', () => {
  it('includes the performance only when given: a body without it keeps its fingerprint; two performances differ', () => {
    const base: NewTaxClassification = {
      mreRealmId: 'r',
      sourceType: 'TRANSACTION_SPLIT',
      sourceId: 's',
      taxCategory: 'MAINTENANCE',
      treatment: 'DEDUCTIBLE',
      reviewState: 'USER_CONFIRMED',
      supersedes: null,
      notes: null,
      sourceReferences: [],
    };
    expect(classificationFingerprint({ ...base, performance: null })).toBe(classificationFingerprint(base));
    const a = classificationFingerprint({ ...base, performance: performed('2027-05-01', '2027-05-14') });
    expect(a).not.toBe(classificationFingerprint(base));
    expect(a).not.toBe(classificationFingerprint({ ...base, performance: performed('2027-05-01', '2027-05-15') }));
    expect(classificationFingerprint({ ...base, performance: performed('2027-05-01', '2027-05-14', [['2027-05-07', '1.00']]) })).not.toBe(a);
  });
});
