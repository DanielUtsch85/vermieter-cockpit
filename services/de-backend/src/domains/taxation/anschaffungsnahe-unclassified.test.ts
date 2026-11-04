import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import type { BasisCost } from '../acquisition/index.js';
import { checkAnschaffungsnahe, type CheckAcquisition, type CheckSource } from './anschaffungsnahe.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';

/**
 * §59F, the owner's decision 239-8 of 2026-11-02 („Abweichung 3 angenommen, mit einer Ergänzung“): an `UNCLASSIFIED`
 * source dated beyond the search range but within the 3-year outer bound keeps the check open: `NOT_FINAL` with
 * `UNCLASSIFIED_SOURCES`, listed under `unclassified` with `beyondSearchRange: true`; never `NOT_COMPUTABLE`, which stays
 * reserved for the classified sources (`SOURCES_OUTSIDE_SEARCH_RANGE`). Synthetic: transfer 2026-03-15, window
 * 2026-03-15–2029-03-15, search range 2025-12-15–2030-03-15 (90 / 365 days), outer bound 2023-03-15–2032-03-15.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
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
const source = (id: string, date: string, net: string, overrides: Partial<CheckSource> = {}): CheckSource => ({
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
  performance: null,
  sourceFlags: [],
  ...overrides,
});
/** An unclassified split (no classification: the default meaning). */
const unclassified = (id: string, date: string, amount = '5000.00') =>
  source(id, date, amount, {
    taxCategory: 'UNCLASSIFIED',
    treatment: null,
    reviewState: 'NEEDS_REVIEW',
    origin: 'DEFAULT',
    classificationId: null,
    netAmount: null,
  });
/** A dated repair performed in the window: 12,000.00, not above 29,700.00. */
const DATED = source('S1', '2027-05-20', '12000.00', {
  performance: { from: day('2027-04-01'), until: day('2027-04-30'), progress: [], progressEstimated: null },
});
const check = (sources: CheckSource[]) =>
  checkAnschaffungsnahe({ acquisition, costs, allocation, sources, statements: [], today: day('2029-08-01') }, TAX_RULES);
const reasonsOf = (c: ReturnType<typeof check>) => (c.flags.find((f) => f.code === 'NOT_FINAL')?.details as { reasons: string[] } | undefined)?.reasons ?? [];
const listed = (c: ReturnType<typeof check>) => c.unclassified.map((e) => [e.sourceId, e.beyondSearchRange]);

describe('an unclassified source by the search range and the outer bound (§59F, decision 239-8)', () => {
  it('the ranges as read: the search range 2025-12-15 to 2030-03-15, the outer bound 2023-03-15 to 2032-03-15', () => {
    const c = check([DATED]);
    expect([c.searchRange, c.outerBound]).toEqual([
      { from: '2025-12-15', until: '2030-03-15' },
      { from: '2023-03-15', until: '2032-03-15' },
    ]);
    expect([c.status, c.final, c.unclassified]).toEqual(['NOT_ABOVE_THRESHOLD', true, []]);
  });

  it('at the search-range edge listed with beyondSearchRange false; one day beyond, and at the outer bound, true; beyond the outer bound not listed', () => {
    for (const [date, expected] of [
      ['2030-03-15', false],
      ['2025-12-15', false],
      ['2030-03-16', true],
      ['2025-12-14', true],
      ['2032-03-15', true],
      ['2023-03-15', true],
    ] as const) {
      const c = check([DATED, unclassified('U', date)]);
      expect([date, listed(c), c.status, c.notComputableReason, c.final, reasonsOf(c)]).toEqual([
        date,
        [['U', expected]],
        'NOT_ABOVE_THRESHOLD',
        null,
        false,
        ['UNCLASSIFIED_SOURCES'],
      ]);
    }
    // Beyond the outer bound: not listed, the check final as without it.
    for (const date of ['2032-03-16', '2023-03-14']) {
      const c = check([DATED, unclassified('U', date)]);
      expect([date, c.unclassified, c.status, c.final, reasonsOf(c)]).toEqual([date, [], 'NOT_ABOVE_THRESHOLD', true, []]);
    }
  });

  it('never summed and never NOT_COMPUTABLE: the sums unchanged; a classified undated source just beyond is NOT_COMPUTABLE instead (counter-check)', () => {
    const base = check([DATED]);
    const beyond = check([DATED, unclassified('U', '2030-03-16', '99999.00')]);
    const sums = (c: ReturnType<typeof check>) => [c.sum.amount, c.sumUpper.amount, c.percentOfBasis, c.percentOfBasisUpper, c.threshold];
    expect(sums(beyond)).toEqual(sums(base));
    expect(sums(base)).toEqual(['12000.00', '12000.00', '6.06', '6.06', '29700.00']);
    expect([beyond.sources.length, beyond.undetermined, beyond.outsideSearchRange, beyond.excluded]).toEqual([1, [], [], []]);
    expect(beyond.unclassified[0]).toMatchObject({ inWindow: null, suggestedTreatment: null, reason: null, beyondSearchRange: true });
    // The classified counterpart on the same day: listed outside the search range, the check NOT_COMPUTABLE.
    const classified = check([DATED, source('S6', '2030-03-16', '5000.00')]);
    expect([classified.status, classified.notComputableReason, classified.outsideSearchRange.map((e) => e.sourceId), classified.unclassified]).toEqual([
      'NOT_COMPUTABLE',
      'SOURCES_OUTSIDE_SEARCH_RANGE',
      ['S6'],
      [],
    ]);
    expect(reasonsOf(classified)).not.toContain('UNCLASSIFIED_SOURCES');
  });

  it('above the threshold: the outcome holds, the suggestion stays and is not final; the other lists keep no marker', () => {
    const big = source('S7', '2027-06-20', '20000.00', {
      performance: { from: day('2027-06-01'), until: day('2027-06-15'), progress: [], progressEstimated: null },
    });
    const c = check([DATED, big, unclassified('U', '2031-01-10')]);
    expect([c.status, c.final, reasonsOf(c), listed(c)]).toEqual(['ABOVE_THRESHOLD', false, ['UNCLASSIFIED_SOURCES'], [['U', true]]]);
    expect(c.sources.map((e) => [e.sourceId, e.suggestedTreatment, 'beyondSearchRange' in e])).toEqual([
      ['S1', 'CAPITALIZED', false],
      ['S7', 'CAPITALIZED', false],
    ]);
    const herstellung = c.sources[0]?.flags.find((f) => f.code === 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN');
    expect(herstellung?.details).toMatchObject({ final: false });
  });
});
