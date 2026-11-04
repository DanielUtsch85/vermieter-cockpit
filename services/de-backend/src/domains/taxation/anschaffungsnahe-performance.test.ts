import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate, type RuleVersion } from '../../shared/index.js';
import type { BasisCost } from '../acquisition/index.js';
import { checkAnschaffungsnahe, checkFlagsOf, type CheckAcquisition, type CheckSource } from './anschaffungsnahe.js';
import { partInWindow, type Performance } from './performance.js';
import { DE_ANSCHAFFUNGSNAHE_V1, type AnschaffungsnaheParameters } from './rules/de-anschaffungsnahe.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';

/**
 * §59F (VC-X-38; tax review of 2026-11-01, questions 14 and 16, mündlich bestätigt durch den Steuerberater, laut
 * Projektinhaber am 2026-11-01; the owner's decisions of 2026-11-02): the check measures the period of performance by
 * lower and upper bounds, never the booking date. §59F's example (synthetic): transfer 2026-03-15, basis 198,000.00,
 * window 2026-03-15–2029-03-15, threshold 29,700.00, read on 2029-08-01.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const WINDOW = { from: day('2026-03-15'), until: day('2029-03-15') };

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
const performed = (from: string, until: string, progress: [string, string][] = [], progressEstimated: boolean | null = null): Performance => ({
  from: day(from),
  until: day(until),
  progress: progress.map(([through, amount]) => ({ through: day(through), amount: eur(amount) })),
  progressEstimated: progress.length === 0 ? null : (progressEstimated ?? false),
});
const source = (id: string, date: string, net: string, performance: Performance | null, overrides: Partial<CheckSource> = {}): CheckSource => ({
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: id,
  sourcePosition: null,
  date: day(date),
  dateSource: 'BOOKING',
  taxYear: Number(date.slice(0, 4)),
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
const check = (sources: CheckSource[], registry: RuleRegistry = TAX_RULES, today = day('2029-08-01')) =>
  checkAnschaffungsnahe({ acquisition, costs, allocation, sources, statements: [], today }, registry);
const reasonsOf = (c: ReturnType<typeof check>) => (c.flags.find((f) => f.code === 'NOT_FINAL')?.details as { reasons: string[] } | undefined)?.reasons ?? [];
const codes = (flags: readonly { code: string }[]) => flags.map((f) => f.code);

// §59F's example: S1–S5.
const S1 = source('S1', '2027-05-20', '12000.00', performed('2027-04-01', '2027-04-30'));
const S2 = source('S2', '2029-07-10', '9500.00', performed('2028-11-02', '2028-12-20'), { grossAmount: eur('11305.00') });
const S3 = source('S3', '2029-04-30', '8400.00', performed('2029-02-01', '2029-04-15', [['2029-03-15', '5600.00']]));
const S4 = source('S4', '2026-03-02', '3000.00', performed('2026-04-10', '2026-04-20'));
const S5 = source('S5', '2027-09-14', '1200.00', null);

describe('the part in the window (§59F "The check measures the performance")', () => {
  const part = (p: Performance, cents = 840000n) => partInWindow(p, cents, WINDOW);
  it('inside exact; before and after 0; across the end with and without a point at W; across the start; never by calendar days', () => {
    expect(part(performed('2027-04-01', '2027-04-30'))).toEqual({ lower: 840000n, upper: 840000n });
    expect(part(performed('2026-03-15', '2029-03-15'))).toEqual({ lower: 840000n, upper: 840000n });
    expect(part(performed('2025-01-01', '2026-03-14'))).toEqual({ lower: 0n, upper: 0n });
    expect(part(performed('2029-03-16', '2029-05-01'))).toEqual({ lower: 0n, upper: 0n });
    expect(part(performed('2029-02-01', '2029-04-15', [['2029-03-15', '5600.00']]))).toEqual({ lower: 560000n, upper: 560000n });
    expect(part(performed('2029-02-01', '2029-04-15'))).toEqual({ lower: 0n, upper: 840000n });
    expect(
      part(
        performed('2029-02-01', '2029-04-15', [
          ['2029-03-10', '5000.00'],
          ['2029-03-31', '6500.00'],
        ]),
      ),
    ).toEqual({ lower: 500000n, upper: 650000n });
    // Begun before the transfer: only the evidenced part from S on; a point on S − 1 makes it exact.
    expect(part(performed('2026-02-01', '2026-04-30'))).toEqual({ lower: 0n, upper: 840000n });
    expect(part(performed('2026-02-01', '2026-04-30', [['2026-03-14', '2000.00']]))).toEqual({ lower: 640000n, upper: 640000n });
  });

  it('a refund swaps the bounds; an estimated point is ignored (not an evidenced share)', () => {
    expect(part(performed('2027-04-01', '2027-04-30'), -50000n)).toEqual({ lower: -50000n, upper: -50000n });
    expect(part(performed('2029-02-01', '2029-04-15'), -50000n)).toEqual({ lower: -50000n, upper: 0n });
    expect(part(performed('2029-02-01', '2029-04-15', [['2029-03-15', '5600.00']], true))).toEqual({ lower: 0n, upper: 840000n });
  });
});

describe('the example of §59F (synthetic), literally', () => {
  it('30,100.00 > 29,700.00: ABOVE_THRESHOLD, upper 31,300.00, not final by S5; S1, S2, S4 suggested, S3 shown with its share and split required', () => {
    const c = check([S4, S1, S5, S3, S2]);
    expect(c).toMatchObject({
      status: 'ABOVE_THRESHOLD',
      threshold: '29700.00',
      sum: eur('30100.00'),
      sumUpper: eur('31300.00'),
      percentOfBasis: '15.20',
      percentOfBasisUpper: '15.81',
      affectedYears: [2026, 2027, 2029],
      final: false,
      searchRange: { from: '2025-12-15', until: '2030-03-15' },
      outerBound: { from: '2023-03-15', until: '2032-03-15' },
    });
    expect(reasonsOf(c)).toEqual(['PERFORMANCE_IN_WINDOW_UNKNOWN']);
    expect(c.sources.map((e) => [e.sourceId, e.inWindow?.lower.amount, e.inWindow?.upper.amount, e.suggestedTreatment])).toEqual([
      ['S4', '3000.00', '3000.00', 'CAPITALIZED'],
      ['S1', '12000.00', '12000.00', 'CAPITALIZED'],
      ['S3', '5600.00', '5600.00', null],
      ['S2', '9500.00', '9500.00', 'CAPITALIZED'],
    ]);
    const s3 = c.sources.find((e) => e.sourceId === 'S3');
    expect(s3?.flags).toContainEqual({
      code: 'PERFORMANCE_STRADDLES_WINDOW',
      details: { edge: 'END', lower: { amount: '5600.00', currency: 'EUR' }, upper: { amount: '5600.00', currency: 'EUR' } },
    });
    expect(s3?.flags.find((f) => f.code === 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN')?.details).toMatchObject({
      splitRequired: true,
      inWindow: { lower: { amount: '5600.00' } },
    });
    expect(c.undetermined.map((e) => [e.sourceId, e.inWindow?.lower.amount, e.inWindow?.upper.amount, codes(e.flags)])).toEqual([
      ['S5', '0.00', '1200.00', ['PERFORMANCE_DATE_MISSING']],
    ]);
    expect(c.undetermined[0]?.flags[0]?.details).toEqual({ date: '2027-09-14', dateSource: 'BOOKING' });
    // The meanings: S3 flagged without a suggestion, S5 with PERFORMANCE_DATE_MISSING, S1 with the suggestion.
    expect(checkFlagsOf([c], { sourceType: 'TRANSACTION_SPLIT', sourceId: 'S3', sourcePosition: null }).suggestion).toBeNull();
    expect(codes(checkFlagsOf([c], { sourceType: 'TRANSACTION_SPLIT', sourceId: 'S5', sourcePosition: null }).flags)).toEqual(['PERFORMANCE_DATE_MISSING']);
    expect(checkFlagsOf([c], { sourceType: 'TRANSACTION_SPLIT', sourceId: 'S1', sourcePosition: null }).suggestion).toMatchObject({
      treatment: 'CAPITALIZED',
      final: false,
    });
  });

  it('variants: (a) S5 dated final; (b) S4 and S5 undated NOT_COMPUTABLE; (c) S3 between two points; (d) S6 outside the search range', () => {
    const s5 = { ...S5, performance: performed('2027-09-01', '2027-09-05') };
    expect(check([S4, S1, s5, S3, S2])).toMatchObject({ status: 'ABOVE_THRESHOLD', sum: eur('31300.00'), sumUpper: eur('31300.00'), final: true });
    const b = check([{ ...S4, performance: null }, S1, S5, S3, S2]);
    expect(b).toMatchObject({
      status: 'NOT_COMPUTABLE',
      notComputableReason: 'PERFORMANCE_IN_WINDOW_UNKNOWN',
      sum: eur('27100.00'),
      sumUpper: eur('31300.00'),
    });
    expect(b.percentOfBasis).toBeNull();
    const s3c = {
      ...S3,
      performance: performed('2029-02-01', '2029-04-15', [
        ['2029-03-10', '5000.00'],
        ['2029-03-31', '6500.00'],
      ]),
    };
    const c = check([S4, S1, s5, s3c, S2]);
    expect(c).toMatchObject({ status: 'ABOVE_THRESHOLD', sum: eur('30700.00'), final: false });
    expect(c.sources.find((e) => e.sourceId === 'S3')?.inWindow).toEqual({ lower: eur('5000.00'), upper: eur('6500.00') });
    const S6 = source('S6', '2025-10-01', '2000.00', null);
    const d = check([S6, S4, S1, s5, S3, S2]);
    expect(d).toMatchObject({ status: 'ABOVE_THRESHOLD', sum: eur('31300.00'), final: false });
    expect(d.outsideSearchRange.map((e) => [e.sourceId, codes(e.flags)])).toEqual([['S6', ['PERFORMANCE_DATE_MISSING']]]);
    expect(reasonsOf(d)).toEqual(['SOURCES_OUTSIDE_SEARCH_RANGE']);
    // Had the upper bound been below 15 %: NOT_COMPUTABLE, never NOT_ABOVE_THRESHOLD; counter-check without S6.
    expect(check([S6, S1])).toMatchObject({ status: 'NOT_COMPUTABLE', notComputableReason: 'SOURCES_OUTSIDE_SEARCH_RANGE', sum: eur('12000.00') });
    expect(check([S1])).toMatchObject({ status: 'NOT_ABOVE_THRESHOLD', final: true });
  });

  it('all five undated: each is undetermined in the search range, the lower bound 0.00, never dated by its booking date', () => {
    const undated = [S4, S1, S5, S3, S2].map((s) => ({ ...s, performance: null }));
    const c = check(undated);
    // Undated, every one lies in the search range (S2 117 days after the window, S4 13 days before it): all undetermined.
    expect(c.sum).toEqual(eur('0.00'));
    expect(c.undetermined.map((e) => e.sourceId)).toEqual(['S4', 'S1', 'S5', 'S3', 'S2']);
    expect(c.status).toBe('NOT_COMPUTABLE');
  });
});

describe('the outcome by the bounds (§59F)', () => {
  const at = (cents: string) => source('x', '2027-05-14', cents, performed('2027-05-14', '2027-05-14'));
  const undated = (cents: string) => source('u', '2027-06-01', cents, null);
  it('one cent below and above 15 % by the lower and by the upper bound; final with undated sources only when not above', () => {
    expect(check([at('29700.00')])).toMatchObject({ status: 'NOT_ABOVE_THRESHOLD', final: true });
    expect(check([at('29700.01')])).toMatchObject({ status: 'ABOVE_THRESHOLD', final: true });
    // Not above by the upper bound with an undated source: final (complete sources).
    expect(check([at('29000.00'), undated('700.00')])).toMatchObject({
      status: 'NOT_ABOVE_THRESHOLD',
      sum: eur('29000.00'),
      sumUpper: eur('29700.00'),
      final: true,
    });
    // In between: NOT_COMPUTABLE.
    expect(check([at('29000.00'), undated('700.01')])).toMatchObject({ status: 'NOT_COMPUTABLE', notComputableReason: 'PERFORMANCE_IN_WINDOW_UNKNOWN' });
    // Above by the lower bound: above, not final while an undated source is open.
    const above = check([at('29700.01'), undated('1.00')]);
    expect([above.status, above.final, reasonsOf(above)]).toEqual(['ABOVE_THRESHOLD', false, ['PERFORMANCE_IN_WINDOW_UNKNOWN']]);
    expect(above.undetermined[0]?.suggestedTreatment).toBeNull();
  });

  it('a refund never pushes over on a guess; a partial acquisition by the exact fraction; undated sources in the search range edges', () => {
    const refund = source('r', '2027-06-01', '100.00', null, { direction: 'INFLOW' });
    expect(check([at('29700.01'), refund])).toMatchObject({ status: 'NOT_COMPUTABLE', sum: eur('29600.01'), sumUpper: eur('29700.01') });
    const half = { ...acquisition, acquiredShare: { numerator: 1, denominator: 2 } };
    const partial = checkAnschaffungsnahe(
      { acquisition: half, costs, allocation, sources: [at('59400.01')], statements: [], today: day('2029-08-01') },
      TAX_RULES,
    );
    expect(partial).toMatchObject({ status: 'ABOVE_THRESHOLD', attributableAmount: eur('29700.01'), attributableAmountUpper: eur('29700.01') });
    // 90 days before and 365 after are summed in the upper bound; 91 and 366 are listed outside it.
    const edge = (date: string) => check([source('e', date, '10.00', null)]);
    expect(edge('2025-12-15').undetermined).toHaveLength(1);
    expect(edge('2025-12-14').outsideSearchRange).toHaveLength(1);
    expect(edge('2030-03-15').undetermined).toHaveLength(1);
    expect(edge('2030-03-16').outsideSearchRange).toHaveLength(1);
    // Beyond the outer bound: not a source of this check at all.
    expect(edge('2023-03-14')).toMatchObject({ undetermined: [], outsideSearchRange: [], final: true });
  });

  it('combined with the basis bounds of §59D: the basis gives the reason where both are open', () => {
    const other: BasisCost = { id: 'cost-o', category: 'OTHER', amount: eur('4000.00'), classification: null };
    const run = (sources: CheckSource[]) =>
      checkAnschaffungsnahe({ acquisition, costs: [...costs, other], allocation, sources, statements: [], today: day('2029-08-01') }, TAX_RULES);
    // Basis bounds 198,000.00 / 201,000.00 (thresholds 29,700.00 / 30,150.00).
    expect(run([at('29800.00')])).toMatchObject({ status: 'NOT_COMPUTABLE', notComputableReason: 'ACQUISITION_COST_UNCLASSIFIED' });
    expect(run([at('29000.00'), undated('2000.00')])).toMatchObject({ status: 'NOT_COMPUTABLE', notComputableReason: 'PERFORMANCE_IN_WINDOW_UNKNOWN' });
    expect(run([at('29800.00'), undated('1000.00')])).toMatchObject({ status: 'NOT_COMPUTABLE', notComputableReason: 'ACQUISITION_COST_UNCLASSIFIED' });
    const both = run([at('29800.00'), undated('1000.00')]);
    expect(reasonsOf(both)).toEqual(expect.arrayContaining(['PERFORMANCE_IN_WINDOW_UNKNOWN', 'ACQUISITION_COSTS_UNCLASSIFIED']));
    expect(run([at('30200.00'), undated('1.00')])).toMatchObject({ status: 'ABOVE_THRESHOLD' });
  });

  it('a source performed wholly outside is PERFORMED_OUTSIDE_WINDOW whatever its booking date; estimated points read as none, flagged', () => {
    const seller = source('o', '2026-04-01', '50000.00', performed('2026-01-10', '2026-02-20'));
    expect(check([seller]).excluded.map((e) => [e.sourceId, e.reason])).toEqual([['o', 'PERFORMED_OUTSIDE_WINDOW']]);
    const estimated = source('est', '2029-04-30', '8400.00', performed('2029-02-01', '2029-04-15', [['2029-03-15', '5600.00']], true));
    const e = check([estimated]).sources[0];
    expect([e?.inWindow?.lower.amount, e?.inWindow?.upper.amount, codes(e?.flags ?? [])]).toEqual([
      '0.00',
      '8400.00',
      ['PERFORMANCE_STRADDLES_WINDOW', 'PERFORMANCE_PROGRESS_ESTIMATED'],
    ]);
  });

  it('the parameters are read from the rule: a test registry with other read days changes the search range and the result', () => {
    const p: AnschaffungsnaheParameters = DE_ANSCHAFFUNGSNAHE_V1.parameters;
    const narrow: RuleVersion<AnschaffungsnaheParameters> = {
      ...DE_ANSCHAFFUNGSNAHE_V1,
      parameters: { ...p, performance: { ...p.performance, undatedReadAfterWindowDays: 30, plausibleYearsFromSourceDate: 1 } },
    };
    const registry = new RuleRegistry([...TAXATION_RULE_VERSIONS.filter((v) => v.ruleCode !== 'DE_ANSCHAFFUNGSNAHE'), narrow]);
    const late = source('l', '2029-05-01', '10.00', null);
    expect(check([late]).undetermined).toHaveLength(1);
    expect(check([late], registry)).toMatchObject({ undetermined: [], searchRange: { until: '2029-04-14' }, outerBound: { until: '2030-03-15' } });
    expect(check([late], registry).outsideSearchRange).toHaveLength(1);
  });

  it('a final check confirms the check, not the tax year: it closes no other flag and moves no cash year', () => {
    const c = check([S4, S1, { ...S5, performance: performed('2027-09-01', '2027-09-05') }, S3, S2]);
    expect(c.final).toBe(true);
    // The cash years of the suggested sources, as paid (S2 in 2029, S4 in 2026): the performance moves none.
    expect(c.sources.map((e) => [e.sourceId, e.taxYear])).toEqual([
      ['S4', 2026],
      ['S1', 2027],
      ['S5', 2027],
      ['S3', 2029],
      ['S2', 2029],
    ]);
    expect(c.flags.map((f) => f.code)).toEqual([]);
  });
});
