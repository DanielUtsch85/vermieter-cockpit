import { describe, expect, it } from 'vitest';
import { RuleRegistry, ruleKey, type BusinessDate, type RuleVersion } from '../../shared/index.js';
import {
  AFA_BUILDING_LINEAR,
  AFA_MOVABLE_LINEAR,
  DE_AFA_BUILDING_LINEAR_V1,
  DE_AFA_BUILDING_LINEAR_V2,
  DE_AFA_MOVABLE_LINEAR_V1,
  DEPRECIATION_RULE_VERSIONS,
  type BuildingLinearParameters,
  type MovableLinearParameters,
} from '../depreciation/index.js';
import {
  ANSCHAFFUNGSNAHE,
  CASH_TIMING,
  CATEGORY_DEFAULTS,
  DE_CATEGORY_DEFAULTS_V1,
  TAXATION_RULE_VERSIONS,
  WEG_SPENDING,
  type AnschaffungsnaheParameters,
  type CategoryDefaultsParameters,
  type WegSpendingParameters,
} from '../taxation/index.js';
import { TAX_RULES } from './index.js';

/**
 * The registry of the backend (api-design.md §58, §59, §59B; P8-D11): the seven rules of both domains, none overlapping, each
 * exported by its own domain; `DE_AFA_BUILDING_LINEAR@2` (today's rule, `@1` until VC-8-02) with its bands and
 * thresholds, and `@1` for 2006–2022 (§59A "The rule versions"), read from `TAX_RULES`.
 */
const day = (value: string) => value as BusinessDate;
const today = day('2026-10-30');

describe('TAX_RULES (§58, §59)', () => {
  it('seven rules, none overlapping (DE_AFA_MOVABLE_LINEAR since VC-8-03, §59B)', () => {
    expect(() => new RuleRegistry(TAX_RULES.codes().flatMap((code) => TAX_RULES.versions(code)))).not.toThrow();
    expect(TAX_RULES.codes()).toEqual([
      'DE_82B_DISTRIBUTION',
      AFA_BUILDING_LINEAR,
      AFA_MOVABLE_LINEAR,
      'DE_ANSCHAFFUNGSNAHE',
      CASH_TIMING,
      CATEGORY_DEFAULTS,
      'DE_WEG_SPENDING',
    ]);
  });

  it("Taxation's five versions and Depreciation's three, each from its domain's index, make up TAX_RULES: none twice, none left out", () => {
    expect(TAXATION_RULE_VERSIONS.map(ruleKey).sort()).toEqual([
      'DE_82B_DISTRIBUTION@1',
      'DE_ANSCHAFFUNGSNAHE@1',
      'DE_CASH_TIMING@1',
      'DE_CATEGORY_DEFAULTS@1',
      'DE_WEG_SPENDING@1',
    ]);
    expect(DEPRECIATION_RULE_VERSIONS.map(ruleKey)).toEqual(['DE_AFA_BUILDING_LINEAR@1', 'DE_AFA_BUILDING_LINEAR@2', 'DE_AFA_MOVABLE_LINEAR@1']);
    const registered = TAX_RULES.codes().flatMap((code) => TAX_RULES.versions(code));
    expect(registered.map(ruleKey).sort()).toEqual([...TAXATION_RULE_VERSIONS, ...DEPRECIATION_RULE_VERSIONS].map(ruleKey).sort());
    for (const v of [...TAXATION_RULE_VERSIONS, ...DEPRECIATION_RULE_VERSIONS]) expect(TAX_RULES.find(v)).toBe(v);
  });

  it('status on 2026-10-30: every registered version is ACTIVE but DE_AFA_BUILDING_LINEAR@1, SUPERSEDED by @2 (§59A)', () => {
    expect(TAX_RULES.status(DE_CATEGORY_DEFAULTS_V1, today)).toBe('ACTIVE');
    expect(TAX_RULES.status(DE_AFA_BUILDING_LINEAR_V2, today)).toBe('ACTIVE');
    expect(TAX_RULES.status(DE_AFA_BUILDING_LINEAR_V1, today)).toBe('SUPERSEDED');
  });

  it('isRegistered and unregistered: only known ruleCode@version resolve', () => {
    expect(TAX_RULES.isRegistered(CATEGORY_DEFAULTS, 1)).toBe(true);
    expect(TAX_RULES.isRegistered(CATEGORY_DEFAULTS, 2)).toBe(false);
    expect(TAX_RULES.isRegistered(AFA_BUILDING_LINEAR, 1)).toBe(true);
    // #177's counter-check moved from @2 to @3 when VC-8-02 registered @2 (§59A "The rule versions").
    expect(TAX_RULES.isRegistered(AFA_BUILDING_LINEAR, 2)).toBe(true);
    expect(TAX_RULES.isRegistered(AFA_BUILDING_LINEAR, 3)).toBe(false);
    expect(TAX_RULES.isRegistered('DE_UNKNOWN', 1)).toBe(false);
    expect(
      TAX_RULES.unregistered([
        { ruleCode: CATEGORY_DEFAULTS, version: 1 },
        { ruleCode: CATEGORY_DEFAULTS, version: 7 },
        { ruleCode: 'A_RULE', version: 1 },
        { ruleCode: CATEGORY_DEFAULTS, version: 7 },
      ]),
    ).toEqual([
      { ruleCode: 'A_RULE', version: 1 },
      { ruleCode: CATEGORY_DEFAULTS, version: 7 },
    ]);
  });

  it('DE_CATEGORY_DEFAULTS version 1: from 2000-01-01, open, with its legal basis', () => {
    expect(DE_CATEGORY_DEFAULTS_V1).toMatchObject({ ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1, effectiveFrom: '2000-01-01', effectiveTo: null });
    expect(DE_CATEGORY_DEFAULTS_V1.legalBasis).toBe('§ 8, § 9, § 11, § 21 EStG');
    expect(DE_CATEGORY_DEFAULTS_V1.source).toContain('BFH IX R 19/24');
  });

  it('DE_AFA_BUILDING_LINEAR version 2: from 2023-01-01, open, its legal basis and its source', () => {
    const rule = TAX_RULES.find({ ruleCode: AFA_BUILDING_LINEAR, version: 2 });
    expect(rule).toMatchObject({ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2, effectiveFrom: '2023-01-01', effectiveTo: null });
    expect(rule?.title).toBe('Lineare Gebäude-AfA im Privatvermögen (§ 7 Abs. 4 EStG)');
    expect(rule?.legalBasis).toBe('§ 7 Abs. 4 S. 1 Nr. 2 und S. 2 EStG');
    expect(rule?.source).toContain('docs/germany/depreciation.md');
    expect(rule?.source).toContain('B1–B3');
  });

  it('DE_AFA_BUILDING_LINEAR version 1 (§59A): 2006-01-01 to 2023-01-01, the same title and legal basis, not verified', () => {
    const rule = TAX_RULES.find({ ruleCode: AFA_BUILDING_LINEAR, version: 1 }) as RuleVersion<BuildingLinearParameters>;
    expect(rule).toMatchObject({ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 1, effectiveFrom: '2006-01-01', effectiveTo: '2023-01-01' });
    expect(rule.legalBasis).toBe('§ 7 Abs. 4 S. 1 Nr. 2 und S. 2 EStG');
    expect(rule.source).toContain('JStG 2022');
    expect(rule.parameters.verified).toBe(false);
    expect(rule.parameters.bands.map((b) => [b.band, b.completedFromYear, b.completedToYear, b.ratePercent, b.shorterUsefulLife.shorterThanYears])).toEqual([
      ['A', 1925, null, '2', 50],
      ['B', null, 1924, '2.5', 40],
    ]);
  });

  it('selection by the tax year (§59A): none before 2006, version 1 for 2006–2022, version 2 from 2023 to 2100', () => {
    for (const year of [2000, 2005]) expect(TAX_RULES.select(AFA_BUILDING_LINEAR, day(`${year}-01-01`))).toBeUndefined();
    expect(TAX_RULES.select(AFA_BUILDING_LINEAR, day('2005-12-31'))).toBeUndefined();
    for (const year of [2006, 2021, 2022]) expect(TAX_RULES.select(AFA_BUILDING_LINEAR, day(`${year}-01-01`))?.version).toBe(1);
    expect(TAX_RULES.select(AFA_BUILDING_LINEAR, day('2022-12-31'))?.version).toBe(1);
    for (const year of [2023, 2026, 2100]) expect(TAX_RULES.select(AFA_BUILDING_LINEAR, day(`${year}-01-01`))?.version).toBe(2);
  });

  it('the schedule parameters are the same in both versions, and the basis excludes what DE_ANSCHAFFUNGSNAHE@1 excludes (§59A)', () => {
    const v1 = DE_AFA_BUILDING_LINEAR_V1.parameters;
    const v2 = DE_AFA_BUILDING_LINEAR_V2.parameters;
    for (const key of [
      'basis',
      'firstYear',
      'end',
      'rounding',
      'methodUnknownFromCompletionYear',
      'shorterUsefulLife',
      // §59B: added to both versions additively, identically.
      'subsequentCostStart',
      'subsequentCostRate',
      'subsequentCostEnd',
    ] as const)
      expect(v1[key]).toEqual(v2[key]);
    expect(v2.methodUnknownFromCompletionYear).toBe(2018);
    expect('degressiveHint' in v2).toBe(false);
    const check = TAX_RULES.find({ ruleCode: ANSCHAFFUNGSNAHE, version: 1 }) as { parameters: AnschaffungsnaheParameters };
    expect([...v2.basis.excludedCostCategories]).toEqual([...check.parameters.excludedCostCategories]);
    expect(v2.end.disposal).toMatchObject({ endMonthCounts: true, verified: false, cutOff: 'BUYER_ECONOMIC_TRANSFER_DATE' });
  });

  it('the bands are parameters of the rule: they cover every completion year from 1000 to 2100 exactly once', () => {
    const { bands } = (TAX_RULES.find({ ruleCode: AFA_BUILDING_LINEAR, version: 2 }) as { parameters: BuildingLinearParameters }).parameters;
    for (let year = 1000; year <= 2100; year++) {
      const holding = bands.filter((b) => (b.completedFromYear ?? -Infinity) <= year && year <= (b.completedToYear ?? Infinity));
      expect(
        holding.map((b) => b.band),
        `year ${year}`,
      ).toHaveLength(1);
    }
    // Both boundaries are year-ends (31.12.1924, 31.12.2022): the completion year decides the band.
    expect(bands.map((b) => [b.band, b.completedFromYear, b.completedToYear, b.ratePercent, b.legalBasis])).toEqual([
      ['A', 2023, null, '3', '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. a EStG'],
      ['B', 1925, 2022, '2', '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG'],
      ['C', null, 1924, '2.5', '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. c EStG'],
    ]);
  });

  it('the thresholds of the shorter useful life are parameters: 33, 50 and 40 years, each by § 7 Abs. 4 S. 2 EStG, not derived from the rate', () => {
    const { parameters } = TAX_RULES.find({ ruleCode: AFA_BUILDING_LINEAR, version: 2 }) as { parameters: BuildingLinearParameters };
    expect(parameters.bands.map((b) => [b.band, b.shorterUsefulLife])).toEqual([
      ['A', { shorterThanYears: 33, legalBasis: '§ 7 Abs. 4 S. 2 EStG' }],
      ['B', { shorterThanYears: 50, legalBasis: '§ 7 Abs. 4 S. 2 EStG' }],
      ['C', { shorterThanYears: 40, legalBasis: '§ 7 Abs. 4 S. 2 EStG' }],
    ]);
    // 100 / 3 is not 33, and 100 / 2.5 is 40 only by coincidence: the statute names the years.
    expect(parameters.shorterUsefulLife).toEqual({ legalBasis: '§ 7 Abs. 4 S. 2 EStG', rate: 'RECIPROCAL_OF_YEARS' });
  });

  it('DE_AFA_BUILDING_LINEAR: the parameters of §59B in both versions, read from the registry', () => {
    for (const version of [1, 2]) {
      const { parameters } = TAX_RULES.find({ ruleCode: AFA_BUILDING_LINEAR, version }) as { parameters: BuildingLinearParameters };
      expect(parameters.basis).toMatchObject({
        capitalizedItemReviewStates: ['USER_CONFIRMED', 'ADVISOR_CONFIRMED'],
        capitalizedItemAmount: 'GROSS_LINE_AMOUNT',
      });
      expect(parameters.subsequentCostStart).toEqual({
        method: 'START_OF_YEAR',
        notBeforeOwnerStart: true,
        verified: false,
        legalBasis: 'R 7.4 Abs. 9 S. 3 EStR (reviewer input on #173; VERIFY)',
      });
      expect(parameters.subsequentCostRate).toEqual({ rate: 'OWNER_PURCHASE_RATE', shorterLifeVerified: false });
      expect(parameters.subsequentCostEnd).toEqual({
        method: 'POOLED_BASIS',
        remainingUsefulLife: { allowed: true, computed: false },
        verified: false,
        legalBasis: 'R 7.4 Abs. 9 S. 1–2 EStR (review on #179; VERIFY)',
      });
    }
    expect(DE_AFA_BUILDING_LINEAR_V2.source).toContain('depreciation.md §6 v0.2; verification-checklist B11; phase-8-plan P8-D6');
  });

  it('DE_AFA_MOVABLE_LINEAR version 1 (§59B): its fields and parameters; end, rounding and basis.amount equal the building rule’s', () => {
    const rule = TAX_RULES.find({ ruleCode: AFA_MOVABLE_LINEAR, version: 1 }) as RuleVersion<MovableLinearParameters>;
    expect(rule).toBe(DE_AFA_MOVABLE_LINEAR_V1);
    expect(rule).toMatchObject({
      ruleCode: 'DE_AFA_MOVABLE_LINEAR',
      version: 1,
      title: 'Lineare AfA beweglicher Wirtschaftsgüter (§ 7 Abs. 1 EStG)',
      legalBasis: '§ 7 Abs. 1 EStG (S. 4: the first year)',
      effectiveFrom: '2023-01-01',
      effectiveTo: null,
    });
    expect(rule.source).toBe(
      'docs/germany/depreciation.md §5, §6 v0.2 (verified 29.10.2026); verification-checklist B6, B8, B9; phase-8-plan P8-D7; api-design §59B',
    );
    expect(rule.parameters.usefulLife).toEqual({ from: 'ASSET', minYears: 1, maxYears: 99, rate: 'RECIPROCAL_OF_YEARS' });
    expect(rule.parameters.firstYear).toEqual({ startMonthCounts: true, from: 'ACQUIRED_ON', legalBasis: '§ 7 Abs. 1 S. 4 EStG' });
    expect(rule.parameters.basis).toEqual({
      itemReviewStates: ['USER_CONFIRMED', 'ADVISOR_CONFIRMED'],
      amount: 'GROSS_LINE_AMOUNT',
      laterItems: { verified: false },
    });
    expect(rule.parameters.gwgHint).toEqual({
      netThreshold: '800.00',
      legalBasis: '§ 9 Abs. 1 S. 3 Nr. 7 S. 2 i. V. m. § 6 Abs. 2 S. 1–3 EStG',
      sammelposten: false,
    });
    // One end and one rounding for both rules; the same amount and review states as the building's items.
    const building = DE_AFA_BUILDING_LINEAR_V2.parameters;
    expect(rule.parameters.end).toEqual(building.end);
    expect(rule.parameters.end.disposal.verified).toBe(false);
    expect(rule.parameters.rounding).toEqual(building.rounding);
    expect(rule.parameters.basis.amount).toBe(building.basis.capitalizedItemAmount);
    expect(rule.parameters.basis.itemReviewStates).toEqual(building.basis.capitalizedItemReviewStates);
    expect(TAX_RULES.status(rule, today)).toBe('ACTIVE');
    for (const year of [2000, 2022]) expect(TAX_RULES.select(AFA_MOVABLE_LINEAR, day(`${year}-12-31`))).toBeUndefined();
    for (const year of [2023, 2027, 2100]) expect(TAX_RULES.select(AFA_MOVABLE_LINEAR, day(`${year}-01-01`))?.version).toBe(1);
  });

  it('only a classification moves the basis (§59B): no registered default rule gives treatment CAPITALIZED', () => {
    for (const rule of TAX_RULES.versions(CATEGORY_DEFAULTS) as readonly RuleVersion<CategoryDefaultsParameters>[]) {
      const defaults = [...Object.values(rule.parameters.defaults), rule.parameters.unlisted];
      expect(defaults.length).toBeGreaterThan(1);
      for (const d of defaults) expect(d.treatment, ruleKey(rule)).not.toBe('CAPITALIZED');
    }
    for (const rule of TAX_RULES.versions(WEG_SPENDING) as readonly RuleVersion<WegSpendingParameters>[]) {
      expect(rule.parameters.default.treatment, ruleKey(rule)).not.toBe('CAPITALIZED');
    }
  });
});
