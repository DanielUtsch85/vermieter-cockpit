import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate, type RuleVersion } from '../../shared/index.js';
import type { BasisCost } from '../acquisition/index.js';
import { checkAnschaffungsnahe, type CheckAcquisition, type CheckSource } from './anschaffungsnahe.js';
import { capitalizedItemsOf } from './capitalized-items.js';
import type { TaxMeaning } from './classification.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import {
  classificationFingerprint,
  planClassification,
  planWegClassification,
  type NewTaxClassification,
  type SplitFacts,
  type WegSourceFacts,
} from './index.js';
import type { Performance } from './performance.js';
import { DE_ANSCHAFFUNGSNAHE_V1, type AnschaffungsnaheParameters } from './rules/de-anschaffungsnahe.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import { PHASE_7_DEPRECIATION } from './tax-year-depreciation.test-support.js';
import { buildTaxYearView, type TaxYearView, type ViewOwnership } from './tax-year-view.js';
import { partialTreatmentParts, type TreatmentPart } from './treatment-parts.js';

/**
 * VC-X-38 Part 2 (api-design.md §59F "As implemented (VC-X-38 Part 2)"; Entscheidung des Projektinhabers, 2026-11-02,
 * 239-2): a source straddling the anschaffungsnahe window's end takes a partial treatment on one classification, the
 * part performed in the window CAPITALIZED, the rest DEDUCTIBLE, the amounts from the evidenced points only. A source
 * begun before the transfer date (the start, or both edges) stays refused (STRADDLES_START; the owner's review of
 * #252). §59F's example (synthetic): transfer 2026-03-15, window 2026-03-15–2029-03-15, basis 198,000.00; S3 performed 2029-02-01–2029-04-15
 * with the evidenced point 2029-03-15: 5,600.00 of 8,400.00. No cash correction. Synthetic data only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const WINDOW = { from: day('2026-03-15'), until: day('2029-03-15') };
const performed = (from: string, until: string, progress: [string, string][] = [], estimated = false): Performance => ({
  from: day(from),
  until: day(until),
  progress: progress.map(([through, amount]) => ({ through: day(through), amount: eur(amount) })),
  progressEstimated: progress.length === 0 ? null : estimated,
});
const amounts = (parts: readonly TreatmentPart[]) => parts.map((p) => [p.position, p.treatment, p.amount.amount]);
const S3_PERFORMANCE = performed('2029-02-01', '2029-04-15', [['2029-03-15', '5600.00']]);
/** A registry whose `DE_ANSCHAFFUNGSNAHE@1` has no `partialTreatment` (the rule as it was before VC-X-38 Part 2). */
const withoutParameter = () => {
  const { partialTreatment: _withdrawn, ...performance } = DE_ANSCHAFFUNGSNAHE_V1.parameters.performance;
  const rule: RuleVersion<AnschaffungsnaheParameters> = { ...DE_ANSCHAFFUNGSNAHE_V1, parameters: { ...DE_ANSCHAFFUNGSNAHE_V1.parameters, performance } };
  return new RuleRegistry(TAXATION_RULE_VERSIONS.map((r) => (r.ruleCode === rule.ruleCode ? rule : r)));
};

describe('the parts from the evidenced points (partialTreatmentParts)', () => {
  const parts = (p: Performance, gross = '8400.00', used = gross) => partialTreatmentParts(p, eur(gross), eur(used), WINDOW);

  it('across the window end with a point on W: 5,600.00 CAPITALIZED, 2,800.00 DEDUCTIBLE, summing to the source', () => {
    const result = parts(S3_PERFORMANCE);
    expect('parts' in result && amounts(result.parts)).toEqual([
      [1, 'CAPITALIZED', '5600.00'],
      [2, 'DEDUCTIBLE', '2800.00'],
    ]);
  });

  it('across the window start, even with a point on S - 1: STRADDLES_START, no parts (work before the transfer is not decided)', () => {
    expect(parts(performed('2026-02-01', '2026-04-30', [['2026-03-14', '2000.00']]))).toEqual({ cause: 'STRADDLES_START' });
    expect(parts(performed('2026-02-01', '2026-04-30', [['2026-03-15', '2000.00']]))).toEqual({ cause: 'STRADDLES_START' });
    expect(parts(performed('2026-02-01', '2026-04-30'))).toEqual({ cause: 'STRADDLES_START' });
    // The edge itself: begun on the day before the transfer is across the start; begun on the transfer day is inside.
    expect(parts(performed('2026-03-14', '2026-04-30', [['2026-03-14', '100.00']]))).toEqual({ cause: 'STRADDLES_START' });
    expect(parts(performed('2026-03-15', '2026-04-30'))).toEqual({ cause: 'NOT_STRADDLING' });
  });

  it('across both edges, even with points on S - 1 and W: STRADDLES_START, no parts; counter-check: the end alone with W exact', () => {
    expect(
      parts(
        performed('2026-02-01', '2029-04-15', [
          ['2026-03-14', '1000.00'],
          ['2029-03-15', '9000.00'],
        ]),
        '10000.00',
      ),
    ).toEqual({ cause: 'STRADDLES_START' });
    const end = parts(performed('2026-03-15', '2029-04-15', [['2029-03-15', '9000.00']]), '10000.00');
    expect('parts' in end && amounts(end.parts)).toEqual([
      [1, 'CAPITALIZED', '9000.00'],
      [2, 'DEDUCTIBLE', '1000.00'],
    ]);
  });

  it('points exactly at the edge decide: a point on W + 1 leaves the part open; on W it is exact', () => {
    expect(parts(performed('2029-02-01', '2029-04-15', [['2029-03-16', '5600.00']]))).toEqual({
      cause: 'SPLIT_NOT_EVIDENCED',
      lower: eur('0.00'),
      upper: eur('5600.00'),
    });
    expect('parts' in parts(S3_PERFORMANCE)).toBe(true);
  });

  it('points missing at the edge: refused with the evidenced bounds, never spread by calendar days; no points: 0 to the whole amount', () => {
    expect(
      parts(
        performed('2029-02-01', '2029-04-15', [
          ['2029-03-10', '5000.00'],
          ['2029-03-31', '6500.00'],
        ]),
      ),
    ).toEqual({ cause: 'SPLIT_NOT_EVIDENCED', lower: eur('5000.00'), upper: eur('6500.00') });
    expect(parts(performed('2029-02-01', '2029-04-15'))).toEqual({ cause: 'SPLIT_NOT_EVIDENCED', lower: eur('0.00'), upper: eur('8400.00') });
  });

  it('an estimated point is ignored (239-1): the same point estimated leaves the part open', () => {
    expect(parts(performed('2029-02-01', '2029-04-15', [['2029-03-15', '5600.00']], true))).toEqual({
      cause: 'SPLIT_NOT_EVIDENCED',
      lower: eur('0.00'),
      upper: eur('8400.00'),
    });
  });

  it('wholly in the window: NOT_STRADDLING (capitalised whole, never in parts); the window edges themselves are inside', () => {
    expect(parts(performed('2028-11-02', '2028-12-20'))).toEqual({ cause: 'NOT_STRADDLING' });
    expect(parts(performed('2026-03-15', '2029-03-15'))).toEqual({ cause: 'NOT_STRADDLING' });
  });

  it('with a net amount: the gross window part pro rata, half-up to the cent, the rest the gross amount less it (the sum exact)', () => {
    const net = parts(performed('2029-02-01', '2029-04-15', [['2029-03-15', '3333.33']]), '11305.00', '9500.00');
    expect('parts' in net && amounts(net.parts)).toEqual([
      [1, 'CAPITALIZED', '3966.66'],
      [2, 'DEDUCTIBLE', '7338.34'],
    ]);
    // Exactly half a cent: 1.01 × 0.50 / 1.00 = 0.505 → 0.51 (half-up), the rest 0.50.
    const half = parts(performed('2029-02-01', '2029-04-15', [['2029-03-15', '0.50']]), '1.01', '1.00');
    expect('parts' in half && amounts(half.parts)).toEqual([
      [1, 'CAPITALIZED', '0.51'],
      [2, 'DEDUCTIBLE', '0.50'],
    ]);
  });
});

const facts = (overrides: Partial<SplitFacts> = {}): SplitFacts => ({
  splitId: 's-3',
  transactionId: 't-3',
  position: 1,
  bookingDate: day('2029-04-30'),
  direction: 'OUTFLOW',
  amount: eur('8400.00'),
  financialCategoryCode: 'MAINTENANCE',
  categoryType: 'OPERATING_EXPENSE',
  propertyReferenceId: 'pr-1',
  transactionStatus: 'CONFIRMED',
  correctionRole: null,
  ...overrides,
});
const acquisitionFacts = { id: 'acq-1', propertyReferenceId: 'pr-1', status: 'CONFIRMED', transferDate: day('2026-03-15') };
type Request = Parameters<typeof planClassification>[2];
const capitalise = (request: Partial<Request>, registry = TAX_RULES, split: Partial<SplitFacts> = {}) =>
  planClassification(
    facts(split),
    null,
    {
      taxCategory: 'MAINTENANCE',
      treatment: 'CAPITALIZED',
      anschaffungsnaheAcquisitionId: 'acq-1',
      supersedes: null,
      taxYear: null,
      refundOfYear: null,
      sourceReferences: ['Leistungsstand zum 15.03.2029 (synthetisch)'],
      performance: S3_PERFORMANCE,
      ...request,
    },
    registry,
    undefined,
    acquisitionFacts,
  );

describe('a capitalisation on the check with a partial treatment (§59F, 239-2)', () => {
  it('accepted with the parts from the evidenced points; without the partial treatment the whole capitalisation is still refused', () => {
    expect(capitalise({ partialTreatment: true })).toEqual({
      kind: 'CLASSIFY',
      rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
      treatmentRule: { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 },
      treatmentParts: [
        { position: 1, treatment: 'CAPITALIZED', amount: eur('5600.00') },
        { position: 2, treatment: 'DEDUCTIBLE', amount: eur('2800.00') },
      ],
    });
    expect(capitalise({})).toEqual({
      kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE',
      reason: 'PERFORMANCE_REQUIRED',
      acquisitionId: 'acq-1',
      cause: 'STRADDLES_WINDOW',
    });
  });

  it('the remaining refusals: points that do not decide the edge (SPLIT_NOT_EVIDENCED with the bounds), an estimated point, no performance', () => {
    expect(capitalise({ partialTreatment: true, performance: performed('2029-02-01', '2029-04-15', [['2029-03-31', '6500.00']]) })).toEqual({
      kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE',
      reason: 'PERFORMANCE_REQUIRED',
      acquisitionId: 'acq-1',
      cause: 'SPLIT_NOT_EVIDENCED',
      inWindow: { lower: eur('0.00'), upper: eur('6500.00') },
    });
    expect(capitalise({ partialTreatment: true, performance: performed('2029-02-01', '2029-04-15', [['2029-03-15', '5600.00']], true) })).toMatchObject({
      cause: 'SPLIT_NOT_EVIDENCED',
      inWindow: { lower: eur('0.00'), upper: eur('8400.00') },
    });
    expect(capitalise({ partialTreatment: true, performance: null })).toMatchObject({ reason: 'PERFORMANCE_REQUIRED', cause: 'MISSING' });
  });

  it('a source begun before the transfer date (the start, or both edges) is refused STRADDLES_START with points on each edge; whole still STRADDLES_WINDOW', () => {
    const start = performed('2026-02-01', '2026-04-30', [['2026-03-14', '2000.00']]);
    const both = performed('2026-02-01', '2029-04-15', [
      ['2026-03-14', '1000.00'],
      ['2029-03-15', '7000.00'],
    ]);
    // Booked 2027-12-31, so both periods lie within the plausible years around the source's date.
    const booked = { bookingDate: day('2027-12-31') };
    for (const performance of [start, both]) {
      expect(capitalise({ partialTreatment: true, performance }, TAX_RULES, booked)).toEqual({
        kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE',
        reason: 'PERFORMANCE_REQUIRED',
        acquisitionId: 'acq-1',
        cause: 'STRADDLES_START',
      });
      expect(capitalise({ performance }, TAX_RULES, booked)).toMatchObject({ reason: 'PERFORMANCE_REQUIRED', cause: 'STRADDLES_WINDOW' });
    }
    // Counter-check: the end alone, begun on the transfer day or later, is accepted with its parts.
    expect(capitalise({ partialTreatment: true }, TAX_RULES, booked)).toMatchObject({ kind: 'CLASSIFY' });
    expect(
      capitalise({ partialTreatment: true, performance: performed('2026-03-15', '2029-04-15', [['2029-03-15', '7000.00']]) }, TAX_RULES, booked),
    ).toMatchObject({
      kind: 'CLASSIFY',
      treatmentParts: [
        { position: 1, treatment: 'CAPITALIZED', amount: eur('7000.00') },
        { position: 2, treatment: 'DEDUCTIBLE', amount: eur('1400.00') },
      ],
    });
  });

  it('the order: OUTSIDE_WINDOW before the partial treatment; wholly inside NOT_STRADDLING; counter-check: wholly inside without it accepted whole', () => {
    expect(capitalise({ partialTreatment: true, performance: performed('2029-03-16', '2029-04-15') })).toMatchObject({ reason: 'OUTSIDE_WINDOW' });
    expect(capitalise({ partialTreatment: true, performance: performed('2028-11-02', '2028-12-20') })).toEqual({
      kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE',
      reason: 'PARTIAL_TREATMENT_NOT_APPLICABLE',
      acquisitionId: 'acq-1',
      cause: 'NOT_STRADDLING',
    });
    const whole = capitalise({ performance: performed('2028-11-02', '2028-12-20') });
    expect(whole).toMatchObject({ kind: 'CLASSIFY' });
    expect(whole).not.toHaveProperty('treatmentParts');
  });

  it('read from the rule: without performance.partialTreatment the partial treatment is refused as before (STRADDLES_WINDOW)', () => {
    expect(capitalise({ partialTreatment: true }, withoutParameter())).toMatchObject({ reason: 'PERFORMANCE_REQUIRED', cause: 'STRADDLES_WINDOW' });
    expect(capitalise({ partialTreatment: true })).toMatchObject({ kind: 'CLASSIFY' });
    // A source wholly in the window is never partially treated, whatever the rule: NOT_STRADDLING comes first.
    expect(capitalise({ partialTreatment: true, performance: performed('2028-11-02', '2028-12-20') }, withoutParameter())).toMatchObject({
      reason: 'PARTIAL_TREATMENT_NOT_APPLICABLE',
      cause: 'NOT_STRADDLING',
    });
  });

  it('a WEG withdrawal (no cash to correct): the parts of its unit share; with a net amount pro rata on the gross unit share', () => {
    const withdrawal: WegSourceFacts = {
      sourceType: 'WEG_RESERVE_WITHDRAWAL',
      sourceId: 'st-1',
      sourcePosition: 1,
      membershipId: 'm-1',
      propertyReferenceId: 'pr-1',
      description: 'Dachsanierung (synthetisch)',
      amount: eur('8400.00'),
      date: day('2029-04-30'),
      dateSource: 'WITHDRAWAL',
      allowedTaxYears: null,
      financialYearStartMonth: 1,
      notCounted: null,
      sourceFlags: [],
      predecessor: null,
    };
    const request = {
      taxCategory: 'WEG_SPENDING',
      treatment: 'CAPITALIZED',
      supersedes: null,
      taxYear: null,
      netAmount: null,
      mostlyResidentialConfirmed: null,
      anschaffungsnaheAcquisitionId: 'acq-1',
      performance: S3_PERFORMANCE,
      sourceReferences: ['Abrechnung des Verwalters (synthetisch)'],
      partialTreatment: true,
    } as const;
    expect(planWegClassification(withdrawal, null, request, TAX_RULES, acquisitionFacts)).toMatchObject({
      kind: 'CLASSIFY',
      treatmentParts: [
        { position: 1, treatment: 'CAPITALIZED', amount: eur('5600.00') },
        { position: 2, treatment: 'DEDUCTIBLE', amount: eur('2800.00') },
      ],
      reserveWithdrawal: { unitShare: eur('8400.00') },
    });
    // Across the transfer date: refused as a split is (STRADDLES_START), no parts.
    const start = { ...request, performance: performed('2026-03-01', '2026-04-30', [['2026-03-14', '400.00']]) };
    expect(planWegClassification({ ...withdrawal, date: day('2026-12-31') }, null, start, TAX_RULES, acquisitionFacts)).toMatchObject({
      kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE',
      reason: 'PERFORMANCE_REQUIRED',
      cause: 'STRADDLES_START',
    });
  });

  it('the fingerprint takes the partial treatment only when asked for, so a key stored before replays unchanged', () => {
    const base: NewTaxClassification = {
      mreRealmId: 'r',
      sourceType: 'TRANSACTION_SPLIT',
      sourceId: 's-3',
      taxCategory: 'MAINTENANCE',
      treatment: 'CAPITALIZED',
      reviewState: 'USER_CONFIRMED',
      supersedes: null,
      notes: null,
      sourceReferences: ['x'],
      anschaffungsnaheAcquisitionId: 'acq-1',
      performance: S3_PERFORMANCE,
    };
    expect(classificationFingerprint({ ...base, partialTreatment: true })).not.toBe(classificationFingerprint(base));
    expect(classificationFingerprint({ ...base, partialTreatment: false })).toBe(classificationFingerprint(base));
  });
});

// The check: the same source DEDUCTIBLE (before) and with the partial treatment (after).
const acquisition: CheckAcquisition = {
  id: 'acq-1',
  propertyReferenceId: 'pr-1',
  status: 'CONFIRMED',
  transferDate: day('2026-03-15'),
  contractDate: day('2026-03-15'),
  acquiredShare: { numerator: 1, denominator: 1 },
  purchasePrice: eur('240000.00'),
};
const costs: BasisCost[] = [{ id: 'cost-1', category: 'REAL_ESTATE_TRANSFER_TAX', amount: eur('24000.00'), classification: null }];
const allocation = { id: 'al-1', reviewState: 'CONFIRMED', totalAllocableAmount: eur('264000.00'), buildingAmount: eur('198000.00') };
const PARTS: readonly TreatmentPart[] = [
  { position: 1, treatment: 'CAPITALIZED', amount: eur('5600.00') },
  { position: 2, treatment: 'DEDUCTIBLE', amount: eur('2800.00') },
];
const checkSource = (id: string, net: string, performance: Performance, overrides: Partial<CheckSource> = {}): CheckSource => ({
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: id,
  sourcePosition: null,
  date: day('2029-04-30'),
  dateSource: 'BOOKING',
  taxYear: 2029,
  taxCategory: 'MAINTENANCE',
  treatment: 'DEDUCTIBLE',
  reviewState: 'USER_CONFIRMED',
  origin: 'CLASSIFICATION',
  classificationId: `c-${id}`,
  grossAmount: eur(net),
  direction: 'OUTFLOW',
  netAmount: eur(net),
  annuallyRecurring: false,
  anschaffungsnaheAcquisitionId: null,
  performance,
  sourceFlags: [],
  ...overrides,
});
const BIG = checkSource('S1', '27000.00', performed('2027-04-01', '2027-04-30'));
const check = (sources: CheckSource[]) =>
  checkAnschaffungsnahe({ acquisition, costs, allocation, sources, statements: [], today: day('2029-08-01') }, TAX_RULES);

describe('the check with a partial treatment: exactly the window part counts, the sums unchanged', () => {
  it('before (DEDUCTIBLE) and after (partial, CAPITALIZED on the check): sum, upper bound and percent equal; the split no longer required', () => {
    const before = check([BIG, checkSource('S3', '8400.00', S3_PERFORMANCE)]);
    const after = check([
      BIG,
      checkSource('S3', '8400.00', S3_PERFORMANCE, { treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: 'acq-1', treatmentParts: PARTS }),
    ]);
    for (const c of [before, after]) {
      expect([c.status, c.sum.amount, c.sumUpper.amount, c.percentOfBasis]).toEqual(['ABOVE_THRESHOLD', '32600.00', '32600.00', '16.46']);
      expect(c.sources.find((e) => e.sourceId === 'S3')?.inWindow).toEqual({ lower: eur('5600.00'), upper: eur('5600.00') });
    }
    const herstellung = (c: typeof before) =>
      c.sources.find((e) => e.sourceId === 'S3')?.flags.find((f) => f.code === 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN')?.details as { splitRequired?: boolean };
    expect([herstellung(before).splitRequired, herstellung(after).splitRequired]).toEqual([true, false]);
    // Never suggested as a whole, either way.
    expect(after.sources.find((e) => e.sourceId === 'S3')?.suggestedTreatment).toBeNull();
  });

  it('counter-check: a partial treatment on another Acquisition does not mark the split done here', () => {
    const elsewhere = check([
      BIG,
      checkSource('S3', '8400.00', S3_PERFORMANCE, { treatment: 'DEDUCTIBLE', anschaffungsnaheAcquisitionId: 'acq-2', treatmentParts: PARTS }),
    ]);
    const flag = elsewhere.sources.find((e) => e.sourceId === 'S3')?.flags.find((f) => f.code === 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN');
    expect((flag?.details as { splitRequired?: boolean }).splitRequired).toBe(true);
  });
});

// The view and the capitalised items.
const PR = '0000aaaa-0000-4000-8000-000000000001';
const [A, B] = ['a', 'b'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000000`) as [string, string];
const own = (party: string, n: number, d: number): ViewOwnership => ({
  id: `own-${party.slice(0, 1)}`,
  partyId: party,
  share: { numerator: n, denominator: d },
  validFrom: day('2026-03-15'),
  validUntil: null,
});
const OWNERS = [own(A, 1, 3), own(B, 2, 3)];
const meaning = (amount: string, parts: readonly TreatmentPart[] | null, treatment: TaxMeaning['treatment'] = 'CAPITALIZED'): TaxMeaning => ({
  splitId: '00000000-0000-4000-8000-000000000003',
  sourceId: '00000000-0000-4000-8000-000000000003',
  sourceType: 'TRANSACTION_SPLIT',
  transactionId: '00000000-0000-4000-8000-000000000033',
  position: 1,
  bookingDate: day('2029-04-30'),
  direction: 'OUTFLOW',
  amount: eur(amount),
  financialCategoryCode: 'MAINTENANCE',
  categoryType: 'OPERATING_EXPENSE',
  propertyReferenceId: PR,
  transactionStatus: 'CONFIRMED',
  correctionRole: null,
  counts: true,
  taxCategory: 'MAINTENANCE',
  treatment,
  reviewState: 'USER_CONFIRMED',
  origin: 'CLASSIFICATION',
  rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
  classificationId: '00000000-0000-4000-8000-0000000000c3'.replace('c', 'a'),
  taxYear: 2029,
  attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: 2029, proposedYear: 2029, overridden: false },
  refund: null,
  netAmount: null,
  performance: S3_PERFORMANCE,
  treatmentParts: parts,
  treatmentRule: { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 },
  distribution: null,
  suggestion: null,
  flags: [],
});
const viewOf = (m: TaxMeaning, ownerPartyId: string | null = null): TaxYearView => {
  const outcome = buildTaxYearView(
    {
      propertyReferenceId: PR,
      ownerPartyFound: ownerPartyId === null ? null : true,
      sources: [{ item: { ...m, yearAmount: m.amount }, listed: true }],
      unattributedDeposits: [],
      ownerships: OWNERS,
      checks: [],
      attribution: { references: [], candidates: [] },
      allocatedLoanInterest: [],
      loanAllocationSets: new Map(),
      depreciation: PHASE_7_DEPRECIATION,
    },
    { year: 2029, ownerPartyId, today: day('2029-08-01'), registry: TAX_RULES, fingerprinter },
  );
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
};
const maintenanceOf = (v: TaxYearView) => v.werbungskosten.lines.find((l) => l.line === 'MAINTENANCE');

describe('the tax-year view and the capitalised items with a partial treatment (§58C, §59B)', () => {
  it('the window part in capitalized, the rest on MAINTENANCE (immediate), the two summing to the cash amount; the cash fields unchanged', () => {
    const v = viewOf(meaning('8400.00', PARTS));
    expect(v.capitalized.items.map((i) => [i.lineAmount?.amount, i.treatment, i.treatmentPart?.treatment, i.amount.amount, i.date, i.taxYear])).toEqual([
      ['5600.00', 'CAPITALIZED', 'CAPITALIZED', '8400.00', '2029-04-30', 2029],
    ]);
    const line = maintenanceOf(v);
    expect([line?.total.amount, line?.subtotals?.immediate.amount, line?.items.map((i) => [i.lineAmount?.amount, i.treatmentPart?.treatment])]).toEqual([
      '2800.00',
      '2800.00',
      [['2800.00', 'DEDUCTIBLE']],
    ]);
    expect(v.capitalized.total.amount).toBe('5600.00');
    // Counter-check: the same source capitalised whole (before VC-X-38 Part 2 it could not be) puts 8,400.00 in capitalized.
    const whole = viewOf(meaning('8400.00', null));
    expect([whole.capitalized.total.amount, maintenanceOf(whole)?.total.amount]).toEqual(['8400.00', '0.00']);
  });

  it('two owners 1/3 and 2/3: each part shared out on its own; the owners sum to the property per part, to the cent', () => {
    const m = meaning('100.01', [
      { position: 1, treatment: 'CAPITALIZED', amount: eur('66.67') },
      { position: 2, treatment: 'DEDUCTIBLE', amount: eur('33.34') },
    ]);
    const property = viewOf(m);
    const [a, b] = [viewOf(m, A), viewOf(m, B)];
    expect([a.capitalized.total.amount, b.capitalized.total.amount, property.capitalized.total.amount]).toEqual(['22.22', '44.45', '66.67']);
    expect([maintenanceOf(a)?.total.amount, maintenanceOf(b)?.total.amount, maintenanceOf(property)?.total.amount]).toEqual(['11.11', '22.23', '33.34']);
    expect(property.owners?.map((o) => [o.ownerPartyId, o.capitalized.total.amount])).toEqual([
      [A, '22.22'],
      [B, '44.45'],
    ]);
  });

  it('the capitalised item takes the window part only, with the view’s per-part shares; counter-check: a whole capitalisation the whole amount', () => {
    const items = capitalizedItemsOf([{ meaning: meaning('8400.00', PARTS), anschaffungsnaheAcquisitionId: 'acq-1' }], OWNERS);
    expect(items.map((i) => [i.lineAmount.amount, i.performance, i.parts.map((p) => p.amount.amount)])).toEqual([
      ['5600.00', { from: '2029-02-01', until: '2029-04-15' }, ['3733.33', '1866.67']],
    ]);
    expect(capitalizedItemsOf([{ meaning: meaning('8400.00', null), anschaffungsnaheAcquisitionId: 'acq-1' }], OWNERS)[0]?.lineAmount.amount).toBe('8400.00');
  });

  it('the review: ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN on both parts informative (the suggestion followed by the partial treatment)', () => {
    const flag = { code: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', details: { acquisitionId: 'acq-1', final: true, splitRequired: false } };
    const v = viewOf({ ...meaning('8400.00', PARTS), flags: [flag] });
    expect(v.review.open.map((o) => o.code)).not.toContain('ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN');
    expect(v.review.info.find((o) => o.code === 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN')?.count).toBe(2);
    // Counter-check: DEDUCTIBLE whole with the same flag keeps it open.
    const open = viewOf({ ...meaning('8400.00', null, 'DEDUCTIBLE'), flags: [flag] });
    expect(open.review.open.map((o) => o.code)).toContain('ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN');
  });
});
