import { describe, expect, it } from 'vitest';
import { ExactDecimal, RoundingMode, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import type { AssetRead, DepreciationAsset, DepreciationAssetId, ShorterUsefulLife } from './asset.js';
import { bandOf, buildingRuleOn, deriveRate, isShorter, reciprocalPercent } from './rate.js';
import { DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2, type BuildingLinearParameters, type BuildingRateBand } from './rules/de-afa-building-linear.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';

/**
 * VC-8-01 domain (api-design.md §59, P8-D4): the bands of `DE_AFA_BUILDING_LINEAR@2` (version 1 until VC-8-02
 * renumbered it, §59A "The rule versions") at each boundary, the selection by tax year, the exact rates, the thresholds
 * of § 7 Abs. 4 S. 2 EStG read from the rule, and the `rate` block with its reasons. VC-8-02 adds `@1` (2006–2022) and
 * moves the year without a rule from 2022 to 2005. Depreciation's own registry: a domain test never imports
 * `domains/tax-rules/`. Figures are synthetic.
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const parameters = DE_AFA_BUILDING_LINEAR_V2.parameters;
const band = (year: number) => bandOf(parameters, year) as BuildingRateBand;
const bandNamed = (name: string) => parameters.bands.find((b) => b.band === name) as BuildingRateBand;
const ACQ_1 = '0000cccc-0000-4000-8000-000000000001';
const ACQ_2 = '0000cccc-0000-4000-8000-000000000002';

const entry = (overrides: Partial<ShorterUsefulLife> = {}): ShorterUsefulLife => ({
  acquisitionId: ACQ_1,
  usefulLifeYears: 30,
  evidence: { source: 'Gutachten zur Restnutzungsdauer', date: day('2026-06-15'), documentReference: null },
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  ...overrides,
});
const asset = (overrides: Partial<DepreciationAsset> = {}): DepreciationAsset => ({
  id: '0000dddd-0000-4000-8000-000000000001' as DepreciationAssetId,
  mreRealmId: 'realm-synthetic',
  propertyReferenceId: '0000eeee-0000-4000-8000-000000000001',
  assetType: 'BUILDING',
  depreciationMethod: 'LINEAR_7_4',
  status: 'ACTIVE',
  buildingCompletionYear: 1995,
  sourceReferences: [],
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  shorterUsefulLives: [],
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2026-10-30T09:00:00Z'),
  version: 1,
  ...overrides,
});
const read = (overrides: Partial<DepreciationAsset> = {}, cancelledAcquisitionIds: string[] = []): AssetRead => ({
  asset: asset(overrides),
  cancelledAcquisitionIds,
});

describe('DE_AFA_BUILDING_LINEAR@2: the bands (§ 7 Abs. 4 S. 1 Nr. 2 EStG)', () => {
  it('at each boundary and at the outer ends: 1924 → C 2.5 %, 1925 → B 2 %, 2022 → B 2 %, 2023 → A 3 %, 1000 → C, 2100 → A', () => {
    expect([1000, 1924, 1925, 2022, 2023, 2100].map((y) => [y, band(y).band, band(y).ratePercent])).toEqual([
      [1000, 'C', '2.5'],
      [1924, 'C', '2.5'],
      [1925, 'B', '2'],
      [2022, 'B', '2'],
      [2023, 'A', '3'],
      [2100, 'A', '3'],
    ]);
  });

  it('the bands cover 1000–2100 once each: no gap, no overlap', () => {
    for (let year = 1000; year <= 2100; year++) {
      const holding = parameters.bands.filter((b) => (b.completedFromYear ?? -Infinity) <= year && year <= (b.completedToYear ?? Infinity));
      expect(holding, `year ${year}`).toHaveLength(1);
    }
  });

  it('selection by the tax year computed (§59A): 2005 → none (NO_APPLICABLE_RULE), 2006 and 2022 → version 1, 2023 and 2100 → version 2', () => {
    expect(buildingRuleOn(registry, 2005)).toBeUndefined();
    expect(buildingRuleOn(registry, 2000)).toBeUndefined();
    expect(buildingRuleOn(registry, 2006)?.version).toBe(1);
    expect(buildingRuleOn(registry, 2022)?.version).toBe(1);
    expect(buildingRuleOn(registry, 2023)?.version).toBe(2);
    expect(buildingRuleOn(registry, 2100)?.version).toBe(2);
    expect(deriveRate(read(), 2005, registry)).toMatchObject({ rule: null, band: null, ratePercent: null, reasons: ['NO_APPLICABLE_RULE'] });
  });

  it('ratePercent is exact: a decimal string, never a binary float (× 100 back and forth compares as strings)', () => {
    for (const b of parameters.bands) {
      expect(typeof b.ratePercent).toBe('string');
      const fraction = ExactDecimal.of(b.ratePercent).dividedBy(ExactDecimal.of('100'), 10, RoundingMode.HALF_EVEN);
      expect(fraction.times(ExactDecimal.of('100')).toString()).toBe(b.ratePercent);
    }
    expect(['C', 'B', 'A'].map((name) => deriveRate(read({ buildingCompletionYear: band2year(name) }), 2026, registry).ratePercent)).toEqual(['2.5', '2', '3']);
  });

  it('shortness at each threshold, read from shorterThanYears: A 32 shorter, 33 not; B 49, 50; C 39, 40', () => {
    expect([32, 33].map((n) => isShorter(n, bandNamed('A')))).toEqual([true, false]);
    expect([49, 50].map((n) => isShorter(n, bandNamed('B')))).toEqual([true, false]);
    expect([39, 40].map((n) => isShorter(n, bandNamed('C')))).toEqual([true, false]);
  });

  it('band A at 33 years is not shorter although 1/33 exceeds 3 %: the threshold is never derived from ratePercent', () => {
    expect(ExactDecimal.of(reciprocalPercent(33)).compare(ExactDecimal.of(bandNamed('A').ratePercent))).toBe(1);
    const rate = deriveRate(read({ buildingCompletionYear: 2024, shorterUsefulLives: [entry({ usefulLifeYears: 33 })] }), 2026, registry);
    expect(rate.shorterUsefulLives[0]).toMatchObject({ applies: false, reasons: ['USEFUL_LIFE_NOT_SHORTER'] });
  });

  it('the bands and thresholds come from the rule passed in: other parameters give other answers (no constant elsewhere)', () => {
    const other: BuildingLinearParameters = {
      ...parameters,
      bands: parameters.bands.map((b) =>
        b.band === 'B' ? { ...b, ratePercent: '1.75', shorterUsefulLife: { ...b.shorterUsefulLife, shorterThanYears: 20 } } : b,
      ),
    };
    const altered = new RuleRegistry([{ ...DE_AFA_BUILDING_LINEAR_V2, parameters: other }]);
    const rate = deriveRate(read({ shorterUsefulLives: [entry({ usefulLifeYears: 30 })] }), 2026, altered);
    expect([rate.ratePercent, rate.shorterThanYears]).toEqual(['1.75', 20]);
    expect(rate.shorterUsefulLives[0]?.reasons).toEqual(['USEFUL_LIFE_NOT_SHORTER']);
  });
});

describe('DE_AFA_BUILDING_LINEAR@1 (2006–2022, §59A "The rule versions"): the lettering before the JStG 2022', () => {
  const v1 = DE_AFA_BUILDING_LINEAR_V1.parameters;
  const v1Band = (year: number) => bandOf(v1, year) as BuildingRateBand;

  it('two bands: 1924 → B 2.5 % (Buchst. b a. F.), 1925 → A 2 % (Buchst. a a. F.), 2022 → A 2 %; thresholds 50 / 40; not verified', () => {
    expect([1000, 1924, 1925, 2022, 2100].map((y) => [y, v1Band(y).band, v1Band(y).ratePercent, v1Band(y).shorterUsefulLife.shorterThanYears])).toEqual([
      [1000, 'B', '2.5', 40],
      [1924, 'B', '2.5', 40],
      [1925, 'A', '2', 50],
      [2022, 'A', '2', 50],
      [2100, 'A', '2', 50],
    ]);
    expect(v1.verified).toBe(false);
    expect(DE_AFA_BUILDING_LINEAR_V2.parameters.verified).toBe(true);
    for (let year = 1000; year <= 2100; year++) {
      const holding = v1.bands.filter((b) => (b.completedFromYear ?? -Infinity) <= year && year <= (b.completedToYear ?? Infinity));
      expect(holding, `year ${year}`).toHaveLength(1);
    }
  });

  it('a letter names a different band in each version, the rate of a building does not change at 2023 (1920 → 2.5 %, 1995 → 2 %)', () => {
    expect(deriveRate(read({ buildingCompletionYear: 1920 }), 2022, registry)).toMatchObject({ rule: { version: 1 }, band: 'B', ratePercent: '2.5' });
    expect(deriveRate(read({ buildingCompletionYear: 1920 }), 2023, registry)).toMatchObject({ rule: { version: 2 }, band: 'C', ratePercent: '2.5' });
    expect(deriveRate(read(), 2022, registry)).toMatchObject({ band: 'A', ratePercent: '2', legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. a EStG a. F.' });
    expect(deriveRate(read(), 2023, registry)).toMatchObject({ band: 'B', ratePercent: '2', legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG' });
  });
});

/** A completion year inside the named band. */
function band2year(name: string): number {
  return { A: 2024, B: 1995, C: 1900 }[name] as number;
}

describe('the rate block (§59)', () => {
  it('a confirmed asset of band B in 2026: the rule, the band, its rate, legal basis and threshold, no reasons', () => {
    expect(deriveRate(read(), 2026, registry)).toEqual({
      year: 2026,
      rule: { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 },
      band: 'B',
      ratePercent: '2',
      legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG',
      shorterThanYears: 50,
      reasons: [],
      shorterUsefulLives: [],
    });
    expect(deriveRate(read(), 2023, registry)).toMatchObject({ year: 2023, band: 'B', reasons: [] });
  });

  it('the reasons, each alone: ASSET_VOID, COMPLETION_YEAR_MISSING (band null), NO_APPLICABLE_RULE, ASSET_NOT_CONFIRMED (band shown)', () => {
    expect(deriveRate(read({ status: 'VOID' }), 2026, registry)).toMatchObject({ band: 'B', reasons: ['ASSET_VOID'] });
    expect(deriveRate(read({ buildingCompletionYear: null, reviewState: 'CONFIRMED' }), 2026, registry)).toMatchObject({
      rule: { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 },
      band: null,
      ratePercent: null,
      legalBasis: null,
      shorterThanYears: null,
      reasons: ['COMPLETION_YEAR_MISSING'],
    });
    expect(deriveRate(read(), 2005, registry)).toMatchObject({ band: null, reasons: ['NO_APPLICABLE_RULE'] });
    for (const reviewState of ['UNREVIEWED', 'NEEDS_REVIEW'] as const) {
      expect(deriveRate(read({ reviewState }), 2026, registry)).toMatchObject({ band: 'B', ratePercent: '2', reasons: ['ASSET_NOT_CONFIRMED'] });
    }
    expect(deriveRate(read({ reviewState: 'ADVISOR_CONFIRMED' }), 2026, registry).reasons).toEqual([]);
  });

  it('the reasons in their order, all at once', () => {
    expect(deriveRate(read({ status: 'VOID', buildingCompletionYear: null, reviewState: 'UNREVIEWED' }), 2005, registry).reasons).toEqual([
      'ASSET_VOID',
      'COMPLETION_YEAR_MISSING',
      'NO_APPLICABLE_RULE',
      'ASSET_NOT_CONFIRMED',
    ]);
  });

  it('a completion year is never guessed: without it, COMPLETION_YEAR_MISSING and band null in every year', () => {
    for (let year = 2000; year <= 2100; year++) {
      const rate = deriveRate(read({ buildingCompletionYear: null, reviewState: 'UNREVIEWED' }), year, registry);
      expect(rate.band).toBeNull();
      expect(rate.reasons).toContain('COMPLETION_YEAR_MISSING');
    }
  });

  it('no rate before 2006 (§59A, was: before 2023): NO_APPLICABLE_RULE for 2000–2005, never 2 %; 2006–2022 take version 1', () => {
    for (let year = 2000; year <= 2005; year++)
      expect(deriveRate(read(), year, registry)).toMatchObject({ ratePercent: null, reasons: ['NO_APPLICABLE_RULE'] });
    for (let year = 2006; year <= 2022; year++)
      expect(deriveRate(read(), year, registry)).toMatchObject({ rule: { version: 1 }, band: 'A', ratePercent: '2', reasons: [] });
  });

  it('1/n exact, and its display rounding half-even to four places: 1/30 → 3.3333, 1/16 → 6.2500', () => {
    expect(reciprocalPercent(30)).toBe('3.3333');
    expect(reciprocalPercent(16)).toBe('6.2500');
    expect(reciprocalPercent(3)).toBe('33.3333');
    expect(reciprocalPercent(1)).toBe('100.0000');
    // No n of 1–99 gives an exact tie at four places; a terminating quotient is padded, never rounded.
    expect(reciprocalPercent(32)).toBe('3.1250');
    const rate = deriveRate(read({ shorterUsefulLives: [entry({ usefulLifeYears: 16 })] }), 2026, registry);
    expect(rate.shorterUsefulLives[0]).toMatchObject({ rate: '1/16', ratePercent: '6.2500' });
  });

  it('each entry reason: ACQUISITION_CANCELLED, USEFUL_LIFE_NOT_SHORTER, USEFUL_LIFE_NOT_CONFIRMED, in this order; applies only without', () => {
    const lives = [entry({ acquisitionId: ACQ_2, usefulLifeYears: 30 }), entry({ acquisitionId: ACQ_1, usefulLifeYears: 30 })];
    const rate = (e: ShorterUsefulLife, cancelled: string[] = []) =>
      deriveRate(read({ shorterUsefulLives: [e] }, cancelled), 2026, registry).shorterUsefulLives[0];
    expect(rate(entry())).toEqual({ acquisitionId: ACQ_1, rate: '1/30', ratePercent: '3.3333', applies: true, reasons: [] });
    expect(rate(entry(), [ACQ_1])).toMatchObject({ applies: false, reasons: ['ACQUISITION_CANCELLED'] });
    expect(rate(entry({ usefulLifeYears: 50 }))).toMatchObject({ applies: false, reasons: ['USEFUL_LIFE_NOT_SHORTER'] });
    expect(rate(entry({ reviewState: 'NEEDS_REVIEW' }))).toMatchObject({ applies: false, reasons: ['USEFUL_LIFE_NOT_CONFIRMED'] });
    expect(rate(entry({ reviewState: 'UNREVIEWED', usefulLifeYears: 60 }), [ACQ_1])?.reasons).toEqual([
      'ACQUISITION_CANCELLED',
      'USEFUL_LIFE_NOT_SHORTER',
      'USEFUL_LIFE_NOT_CONFIRMED',
    ]);
    expect(rate(entry({ reviewState: 'ADVISOR_CONFIRMED' }))?.applies).toBe(true);
    // In acquisitionId order, whatever the stored order.
    expect(deriveRate(read({ shorterUsefulLives: lives }), 2026, registry).shorterUsefulLives.map((e) => e.acquisitionId)).toEqual([ACQ_1, ACQ_2]);
  });

  it('an unconfirmed shorter life is never used, nor is the band rate shown as usable: applies false until confirmed', () => {
    const unconfirmed = deriveRate(read({ shorterUsefulLives: [entry({ reviewState: 'UNREVIEWED' })] }), 2026, registry);
    expect(unconfirmed.shorterUsefulLives[0]?.applies).toBe(false);
    expect(unconfirmed.reasons).toEqual([]);
  });

  it("an entry never applies while the asset's reasons stand; without a band, shortness is not judged (the asset's reasons say why)", () => {
    const unconfirmedAsset = deriveRate(read({ reviewState: 'NEEDS_REVIEW', shorterUsefulLives: [entry()] }), 2026, registry);
    expect(unconfirmedAsset.shorterUsefulLives[0]).toMatchObject({ applies: false, reasons: [] });
    const noYear = deriveRate(
      read({ buildingCompletionYear: null, reviewState: 'UNREVIEWED', shorterUsefulLives: [entry({ usefulLifeYears: 90 })] }),
      2026,
      registry,
    );
    expect(noYear.shorterUsefulLives[0]).toMatchObject({ applies: false, reasons: [] });
    const before = deriveRate(read({ shorterUsefulLives: [entry({ usefulLifeYears: 90 })] }), 2005, registry);
    expect(before.shorterUsefulLives[0]).toMatchObject({ applies: false, reasons: [] });
  });

  it('the year of evidence computes nothing in VC-8-01 (VC-8-02 decides): a later evidence date applies all the same', () => {
    const later = entry({ evidence: { source: 'Gutachten', date: day('2099-01-01'), documentReference: null } });
    expect(deriveRate(read({ shorterUsefulLives: [later] }), 2026, registry).shorterUsefulLives[0]?.applies).toBe(true);
  });
});
