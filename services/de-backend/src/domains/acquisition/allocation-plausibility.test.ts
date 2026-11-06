import { describe, expect, it } from 'vitest';
import { TAX_RULES } from '../tax-rules/index.js';
import { DE_LAND_BUILDING_PLAUSIBILITY_V1 } from '../depreciation/index.js';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import { ALLOCATION_METHODS, allocationFingerprint, type NewAllocation } from './allocation.js';
import {
  comparisonLandShare,
  deviationIsOpen,
  plausibilityFlags,
  type AllocationComparison,
  type ComparisonMethod,
  type PlausibilitySubject,
} from './allocation-plausibility.js';

/**
 * §58T (VC-X-44; Entscheidung des Projektinhabers, 2026-11-06): rule 2 exactly in cents, both directions, the level by
 * the reason and by `ADVISOR_CONFIRMED` (question 5), the hint without a comparison (question 7), the version by the
 * allocation's own date, and a seeded property test against an independent rational comparison. Synthetic figures.
 */
const eur = (amount: string) => Money.of(amount, 'EUR');
const comparison = (land: string, building: string, method: ComparisonMethod = 'BMF_TOOL'): AllocationComparison => ({
  method,
  landValue: eur(land),
  buildingValue: eur(building),
  sourceReferences: ['BMF-Arbeitshilfe, Ausdruck 2026-08-03 (synthetisch)'],
});
/** E1 of §58T's example: 400,000.00 = 40,000.00 + 360,000.00, a contract split, confirmed, on 2026-07-01. */
const e1 = (over: Partial<PlausibilitySubject> = {}): PlausibilitySubject => ({
  id: 'E1',
  method: 'PURCHASE_CONTRACT',
  reviewState: 'CONFIRMED',
  effectiveDate: '2026-07-01' as BusinessDate,
  totalAllocableAmount: eur('400000.00'),
  landAmount: eur('40000.00'),
  buildingAmount: eur('360000.00'),
  comparison: null,
  deviationReason: null,
  ...over,
});
const RULE = { ruleCode: 'DE_LAND_BUILDING_PLAUSIBILITY', version: 1 };
const flagsOf = (a: PlausibilitySubject, registry: RuleRegistry = TAX_RULES) => plausibilityFlags(a, registry);
const conspicuous = (a: PlausibilitySubject) => flagsOf(a).some((f) => f.code === 'ALLOCATION_DEVIATES_FROM_COMPARISON');

describe('the plausibility of the land/building allocation (§58T)', () => {
  it('E1 against the Arbeitshilfe 120000.00 / 280000.00: deviation +0.2000, LAND_SHARE_LOWER, OPEN, the details in full', () => {
    expect(flagsOf(e1({ comparison: comparison('120000.00', '280000.00') }))).toEqual([
      {
        code: 'ALLOCATION_DEVIATES_FROM_COMPARISON',
        level: 'OPEN',
        details: {
          allocationId: 'E1',
          comparisonMethod: 'BMF_TOOL',
          allocationLandShare: '0.1000',
          comparisonLandShare: '0.3000',
          deviation: '0.2000',
          threshold: '0.10',
          direction: 'LAND_SHARE_LOWER',
          reasonGiven: false,
          reviewState: 'CONFIRMED',
          closedBy: null,
          rule: RULE,
        },
      },
    ]);
  });

  it('within the threshold (60000.00 / 340000.00, +0.0500): no flag', () => {
    expect(flagsOf(e1({ comparison: comparison('60000.00', '340000.00') }))).toEqual([]);
  });

  it('the edge 80000.00 / 320000.00 (exactly 0.1000) is conspicuous; one cent less land value is not, on either value', () => {
    const [edge] = flagsOf(e1({ comparison: comparison('80000.00', '320000.00') }));
    expect(edge?.details).toMatchObject({ deviation: '0.1000', comparisonLandShare: '0.2000', direction: 'LAND_SHARE_LOWER' });
    // cL = 79,999.99 / 399,999.99 < 0.2: below the edge; the rounded shares still read 0.2000 and 0.1000.
    expect(conspicuous(e1({ comparison: comparison('79999.99', '320000.00') }))).toBe(false);
    // cL = 80,000.00 / 400,000.01 < 0.2: below the edge through the building value.
    expect(conspicuous(e1({ comparison: comparison('80000.00', '320000.01') }))).toBe(false);
    // One cent above, on each value: conspicuous.
    expect(conspicuous(e1({ comparison: comparison('80000.01', '320000.00') }))).toBe(true);
    expect(conspicuous(e1({ comparison: comparison('80000.00', '319999.99') }))).toBe(true);
  });

  it('the edge in the other direction: land 120000.00 against 80000.00 / 320000.00 (exactly -0.1000) is conspicuous, one cent inside is not', () => {
    const split = (land: string, building: string) => ({ landAmount: eur(land), buildingAmount: eur(building) });
    const [edge] = flagsOf(e1({ ...split('120000.00', '280000.00'), comparison: comparison('80000.00', '320000.00') }));
    expect(edge?.details).toMatchObject({ deviation: '-0.1000', direction: 'LAND_SHARE_HIGHER', allocationLandShare: '0.3000' });
    expect(conspicuous(e1({ ...split('119999.99', '280000.01'), comparison: comparison('80000.00', '320000.00') }))).toBe(false);
    expect(conspicuous(e1({ ...split('120000.01', '279999.99'), comparison: comparison('80000.00', '320000.00') }))).toBe(true);
  });

  it('a higher land share: 200000.00 / 200000.00 against 120000.00 / 280000.00 is conspicuous, LAND_SHARE_HIGHER, -0.2000', () => {
    const [flag] = flagsOf(e1({ landAmount: eur('200000.00'), buildingAmount: eur('200000.00'), comparison: comparison('120000.00', '280000.00') }));
    expect(flag?.details).toMatchObject({ allocationLandShare: '0.5000', comparisonLandShare: '0.3000', deviation: '-0.2000', direction: 'LAND_SHARE_HIGHER' });
  });

  it('a comparison not summing to the total (150000.00 / 350000.00): only the ratio counts, comparisonLandShare 0.3000', () => {
    const [flag] = flagsOf(e1({ comparison: comparison('150000.00', '350000.00') }));
    expect(flag?.details).toMatchObject({ comparisonLandShare: '0.3000', deviation: '0.2000', direction: 'LAND_SHARE_LOWER' });
  });

  it('not checked without a building part; a zero land part (Erbbaurecht) is checked; comparisons of 0.00 / x and x / 0.00', () => {
    const noBuilding = { landAmount: eur('400000.00'), buildingAmount: eur('0.00') };
    expect(flagsOf(e1({ ...noBuilding, comparison: comparison('100.00', '399900.00') }))).toEqual([]);
    expect(flagsOf(e1(noBuilding))).toEqual([]);
    const noLand = { landAmount: eur('0.00'), buildingAmount: eur('400000.00') };
    expect(flagsOf(e1({ ...noLand, comparison: comparison('80000.00', '320000.00') }))[0]?.details).toMatchObject({
      allocationLandShare: '0.0000',
      deviation: '0.2000',
    });
    expect(flagsOf(e1({ ...noLand, comparison: comparison('0.00', '300000.00') }))).toEqual([]);
    expect(flagsOf(e1({ comparison: comparison('0.00', '300000.00') }))[0]?.details).toMatchObject({ comparisonLandShare: '0.0000', deviation: '-0.1000' });
    expect(flagsOf(e1({ comparison: comparison('300000.00', '0.00') }))[0]?.details).toMatchObject({ comparisonLandShare: '1.0000', deviation: '0.9000' });
  });

  it('the decision never reads the rounded shares: both comparisons round to 0.2000 and a deviation of 0.1000, only one is conspicuous', () => {
    const above = comparison('80000.01', '320000.00');
    const below = comparison('79999.99', '320000.00');
    expect([comparisonLandShare(above), comparisonLandShare(below)]).toEqual(['0.2000', '0.2000']);
    expect(flagsOf(e1({ comparison: above }))[0]?.details).toMatchObject({ comparisonLandShare: '0.2000', deviation: '0.1000' });
    expect(conspicuous(e1({ comparison: below }))).toBe(false);
    // The rounded figures of `below` would decide the other way: 0.2000 - 0.1000 >= 0.10.
  });

  it('question 5: CONFIRMED without a reason OPEN; with one INFORMATIVE closedBy DEVIATION_REASON; ADVISOR_CONFIRMED INFORMATIVE closedBy ADVISOR_CONFIRMED either way', () => {
    const c = comparison('120000.00', '280000.00');
    const reason = 'Bodenwert wegen Altlasten im Vertrag gemindert, Gutachten folgt (synthetisch)';
    const level = (over: Partial<PlausibilitySubject>) => {
      const [f] = flagsOf(e1({ comparison: c, ...over }));
      return [f?.level, f?.details['reasonGiven'], f?.details['closedBy'], f?.details['reviewState']];
    };
    expect(level({})).toEqual(['OPEN', false, null, 'CONFIRMED']);
    expect(level({ deviationReason: reason })).toEqual(['INFORMATIVE', true, 'DEVIATION_REASON', 'CONFIRMED']);
    expect(level({ reviewState: 'ADVISOR_CONFIRMED' })).toEqual(['INFORMATIVE', false, 'ADVISOR_CONFIRMED', 'ADVISOR_CONFIRMED']);
    expect(level({ reviewState: 'ADVISOR_CONFIRMED', deviationReason: reason })).toEqual(['INFORMATIVE', true, 'ADVISOR_CONFIRMED', 'ADVISOR_CONFIRMED']);
    // The other states without a reason stay open; with one (E2′, UNREVIEWED) informative.
    for (const reviewState of ['UNREVIEWED', 'NEEDS_REVIEW'] as const) {
      expect(level({ reviewState })).toEqual(['OPEN', false, null, reviewState]);
      expect(level({ reviewState, deviationReason: reason })).toEqual(['INFORMATIVE', true, 'DEVIATION_REASON', reviewState]);
    }
  });

  it('deviationIsOpen: open unless closedBy names ADVISOR_CONFIRMED or DEVIATION_REASON; counter-check on an unknown value', () => {
    expect(deviationIsOpen({ closedBy: null })).toBe(true);
    expect(deviationIsOpen({})).toBe(true);
    expect(deviationIsOpen({ closedBy: 'SOMETHING_ELSE' })).toBe(true);
    expect(deviationIsOpen({ closedBy: 'ADVISOR_CONFIRMED' })).toBe(false);
    expect(deviationIsOpen({ closedBy: 'DEVIATION_REASON' })).toBe(false);
  });

  it('question 7: ALLOCATION_PLAUSIBILITY_NOT_CHECKED only for PURCHASE_CONTRACT and OTHER without a comparison', () => {
    for (const method of ALLOCATION_METHODS) {
      const without = flagsOf(e1({ method }));
      expect(without).toEqual(
        method === 'PURCHASE_CONTRACT' || method === 'OTHER'
          ? [{ code: 'ALLOCATION_PLAUSIBILITY_NOT_CHECKED', level: 'INFORMATIVE', details: { allocationId: 'E1', method } }]
          : [],
      );
      // With a comparison within the threshold: nothing for any method.
      expect(flagsOf(e1({ method, comparison: comparison('60000.00', '340000.00') }))).toEqual([]);
    }
  });

  it('no version on the effective date: no flag of either code; the threshold and the directions are read from the version', () => {
    const before = e1({ effectiveDate: '2005-12-31' as BusinessDate, comparison: comparison('120000.00', '280000.00') });
    expect(flagsOf(before)).toEqual([]);
    expect(flagsOf(e1({ effectiveDate: '2005-12-31' as BusinessDate }))).toEqual([]);
    const v = DE_LAND_BUILDING_PLAUSIBILITY_V1;
    const registryWith = (parameters: Partial<typeof v.parameters>) => new RuleRegistry([{ ...v, parameters: { ...v.parameters, ...parameters } }]);
    const within = e1({ comparison: comparison('60000.00', '340000.00') });
    expect(flagsOf(within, registryWith({ landShareDeviation: '0.05' }))[0]?.details).toMatchObject({ threshold: '0.05', deviation: '0.0500' });
    expect(flagsOf(within, registryWith({ landShareDeviation: '0.0501' }))).toEqual([]);
    const lower = e1({ comparison: comparison('120000.00', '280000.00') });
    expect(flagsOf(lower, registryWith({ directions: ['LAND_SHARE_HIGHER'] }))).toEqual([]);
    expect(flagsOf(lower, registryWith({ closingReviewStates: [] }))[0]?.level).toBe('OPEN');
    expect(flagsOf(e1({ reviewState: 'ADVISOR_CONFIRMED', comparison: lower.comparison }), registryWith({ closingReviewStates: [] }))[0]?.level).toBe('OPEN');
  });

  it('a seeded property test: the decision equals an independent rational comparison, the direction its sign', () => {
    let seed = 0x5eed44;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
    const text = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    for (let i = 0; i < 2000; i++) {
      const total = 1 + next(50_000_000);
      const land = next(total + 1);
      const cLand = next(30_000_000);
      const cBuilding = next(30_000_000) + (cLand === 0 ? 1 : 0);
      if (land === total) continue; // no building part: not checked (its own test).
      const a = e1({
        totalAllocableAmount: eur(text(total)),
        landAmount: eur(text(land)),
        buildingAmount: eur(text(total - land)),
        comparison: comparison(text(cLand), text(cBuilding)),
      });
      // cL - aL as a reduced fraction, then |n| / d >= 1 / 10.
      let n = BigInt(cLand) * BigInt(total) - BigInt(land) * BigInt(cLand + cBuilding);
      let d = BigInt(total) * BigInt(cLand + cBuilding);
      const g = gcd(n, d);
      if (g !== 0n) [n, d] = [n / g, d / g];
      const expected = (n < 0n ? -n : n) * 10n >= d;
      const flags = flagsOf(a);
      expect(flags.length === 1, `case ${i}`).toBe(expected);
      if (expected) expect(flags[0]?.details['direction']).toBe(n > 0n ? 'LAND_SHARE_LOWER' : 'LAND_SHARE_HIGHER');
    }
  });

  it('the fingerprint: without comparison and reason as before (a stored key still replays); each one moves it', () => {
    const base: NewAllocation = {
      mreRealmId: 'r',
      acquisitionId: 'a',
      totalAllocableAmount: eur('400000.00'),
      landAmount: eur('40000.00'),
      buildingAmount: eur('360000.00'),
      method: 'PURCHASE_CONTRACT',
      reviewState: 'CONFIRMED',
      effectiveDate: null,
      advisorPartyId: null,
      sourceReferences: [],
      notes: null,
      supersedes: null,
    };
    const before = '["a","400000.00","40000.00","360000.00","EUR","PURCHASE_CONTRACT","CONFIRMED",null,null,[],null,null]';
    expect(allocationFingerprint(base)).toBe(before);
    expect(allocationFingerprint({ ...base, comparison: null, deviationReason: null })).toBe(before);
    const c = comparison('120000.00', '280000.00');
    const withComparison = allocationFingerprint({ ...base, comparison: c });
    expect(withComparison).not.toBe(before);
    expect(allocationFingerprint({ ...base, comparison: c, deviationReason: 'Grund A' })).not.toBe(withComparison);
    expect(allocationFingerprint({ ...base, comparison: c, deviationReason: 'Grund A' })).not.toBe(
      allocationFingerprint({ ...base, comparison: c, deviationReason: 'Grund B' }),
    );
    expect(allocationFingerprint({ ...base, comparison: { ...c, method: 'APPRAISAL' } })).not.toBe(withComparison);
  });
});
