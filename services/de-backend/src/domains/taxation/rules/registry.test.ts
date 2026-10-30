import { describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../../shared/index.js';
import { CASH_TIMING } from './de-cash-timing.js';
import { CATEGORY_DEFAULTS, DE_CATEGORY_DEFAULTS_V1 } from './de-category-defaults.js';
import { RuleRegistry, TAX_RULES } from './registry.js';
import type { RuleVersion } from './rule-version.js';

/** VC-7-01: the registry of api-design.md §58 — selection by date, non-overlap, the derived status, resolution. */
const day = (value: string) => value as BusinessDate;
const version = (ruleCode: string, v: number, effectiveFrom: string, effectiveTo: string | null): RuleVersion => ({
  ruleCode,
  version: v,
  title: `${ruleCode} v${v}`,
  legalBasis: '§ 9 EStG',
  effectiveFrom: day(effectiveFrom),
  effectiveTo: effectiveTo === null ? null : day(effectiveTo),
  parameters: {},
  source: 'test',
});

describe('RuleRegistry (§58)', () => {
  it('selects the version whose period holds the date: from inclusive, to exclusive', () => {
    const registry = new RuleRegistry([version('R', 2, '2025-01-01', null), version('R', 1, '2000-01-01', '2025-01-01')]);
    expect(registry.select('R', day('1999-12-31'))).toBeUndefined();
    expect(registry.select('R', day('2000-01-01'))?.version).toBe(1);
    expect(registry.select('R', day('2024-12-31'))?.version).toBe(1);
    expect(registry.select('R', day('2025-01-01'))?.version).toBe(2);
    expect(registry.select('UNKNOWN', day('2025-01-01'))).toBeUndefined();
    expect(registry.versions('R').map((v) => v.version)).toEqual([1, 2]);
  });

  it('refuses overlapping, open-then-later, duplicate and empty versions', () => {
    expect(() => new RuleRegistry([version('R', 1, '2000-01-01', '2025-06-01'), version('R', 2, '2025-01-01', null)])).toThrow('overlap');
    expect(() => new RuleRegistry([version('R', 1, '2000-01-01', null), version('R', 2, '2025-01-01', null)])).toThrow('overlap');
    expect(() => new RuleRegistry([version('R', 1, '2000-01-01', '2001-01-01'), version('R', 1, '2001-01-01', null)])).toThrow('twice');
    expect(() => new RuleRegistry([version('R', 1, '2000-01-01', '2000-01-01')])).toThrow('after effectiveFrom');
    expect(() => new RuleRegistry([version('R', 0, '2000-01-01', null)])).toThrow('positive integer');
    // Adjacent periods do not overlap; different rules never conflict.
    expect(
      () => new RuleRegistry([version('R', 1, '2000-01-01', '2025-01-01'), version('R', 2, '2025-01-01', null), version('S', 1, '2000-01-01', null)]),
    ).not.toThrow();
  });

  it('the registered versions of the backend never overlap', () => {
    expect(() => new RuleRegistry(TAX_RULES.codes().flatMap((code) => TAX_RULES.versions(code)))).not.toThrow();
    // VC-7-03 (§58B): five rules; the three new ones beside the frozen DE_CATEGORY_DEFAULTS@1.
    expect(TAX_RULES.codes()).toEqual(['DE_82B_DISTRIBUTION', 'DE_ANSCHAFFUNGSNAHE', CASH_TIMING, CATEGORY_DEFAULTS, 'DE_WEG_SPENDING']);
  });

  it('status: ACTIVE today, SUPERSEDED with a later version, RETIRED without one, PENDING before its start', () => {
    const registry = new RuleRegistry([
      version('R', 1, '2000-01-01', '2025-01-01'),
      version('R', 2, '2025-01-01', null),
      version('S', 1, '2000-01-01', '2020-01-01'),
    ]);
    const today = day('2026-10-30');
    const [r1, r2] = registry.versions('R') as [RuleVersion, RuleVersion];
    expect(registry.status(r1, today)).toBe('SUPERSEDED');
    expect(registry.status(r2, today)).toBe('ACTIVE');
    expect(registry.status(registry.versions('S')[0] as RuleVersion, today)).toBe('RETIRED');
    expect(registry.status(r2, day('2024-06-01'))).toBe('PENDING');
    expect(TAX_RULES.status(DE_CATEGORY_DEFAULTS_V1, today)).toBe('ACTIVE');
  });

  it('isRegistered and unregistered: only known ruleCode@version resolve', () => {
    expect(TAX_RULES.isRegistered(CATEGORY_DEFAULTS, 1)).toBe(true);
    expect(TAX_RULES.isRegistered(CATEGORY_DEFAULTS, 2)).toBe(false);
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
});
