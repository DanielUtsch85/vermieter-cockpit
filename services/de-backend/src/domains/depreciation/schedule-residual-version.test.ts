import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import { EXTENSION, perItem, withParameters } from './schedule-items.test-support.js';
import { declared, example, gutachten } from './schedule-residual.test-support.js';
import { A, B, capitalized, day } from './schedule.test-support.js';
import { computeVersionEntries } from './version-compute.js';
import { inputFingerprint, truncateInputs } from './version-fingerprint.js';
import { identity, live } from './version.test-support.js';

/**
 * §59G Part 2 and §60 (VC-X-41 Part 2): a late evidence's component stores its Stichtag and the owners' declared AfA
 * (migration 0061), so `computeSchedule(storedInputs)` re-derives the switch, the residual values and the items' last
 * month; the declared AfA counts in the fingerprint from `YE` only; the Stichtag from the first year. Synthetic.
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
const month = withParameters((p) => ({ ...p, shorterUsefulLife: { ...p.shorterUsefulLife, evidenceYearCounts: 'FROM_VALUATION_MONTH' } }));
const input = (entries = [gutachten('2027-05-20')]) =>
  example(entries, {
    capitalizedItems: [capitalized(EXTENSION, '2025-05-05', '10000.00'), capitalized(EXTENSION.replace('72', '75'), '2030-10-15', '33000.00')],
  });

describe('a late evidence recorded (§60 "Reproducible", §59G "Recorded versions")', () => {
  for (const [label, reg] of [
    ['the registry', registry],
    ['PER_ITEM_SERIES', perItem],
    ['the Stichtag’s month', month],
  ] as const) {
    it(`the stored inputs recompute to the derivation’s entries under ${label}, every throughYear, to the cent`, () => {
      const state = live(input(), reg, 2062);
      expect(state.entries.length).toBeGreaterThan(100);
      for (const through of [2024, 2026, 2027, 2030, 2059, 2062]) {
        const recomputed = computeVersionEntries(truncateInputs(state.inputs, through), reg, 2024, through);
        expect(recomputed).toEqual(state.entries.filter((e) => e.year <= through));
      }
    });
  }

  it('the component stores its Stichtag, its SHORTER_USEFUL_LIFE rate and the declared AfA in cents; a band component none of it', () => {
    const stored = live(input(), registry, 2062).inputs.components[0];
    expect(stored?.rate).toEqual({ kind: 'SHORTER_USEFUL_LIFE', usefulLifeYears: 33 });
    expect(stored?.acquisition).toMatchObject({
      shorterLifeValuationDate: '2027-05-20',
      shorterLifeDeclaredAfa: [
        { partyId: A, throughYear: 2026, amount: 792_000n },
        { partyId: B, throughYear: 2026, amount: 528_000n },
      ].sort((x, y) => (x.partyId < y.partyId ? -1 : 1)),
    });
    const band = live(input([]), registry, 2062).inputs.components[0]?.acquisition;
    expect(band).not.toHaveProperty('shorterLifeValuationDate');
    expect(band).not.toHaveProperty('shorterLifeDeclaredAfa');
    // A FROM_START component stores its Stichtag, no declared AfA (not read for it).
    expect(live(input([gutachten('2024-11-30')]), registry, 2062).inputs.components[0]?.acquisition).not.toHaveProperty('shorterLifeDeclaredAfa');
  });

  it('a changed declared AfA changes the fingerprint from YE (2027) only; a changed Stichtag from the first year', () => {
    // One input, its entry swapped (the same Ownership ids, so only the entry differs).
    const shared = input();
    const withEntry = (entry: ReturnType<typeof gutachten>) =>
      live({ ...shared, asset: { ...shared.asset, shorterUsefulLives: [entry] } }, registry, 2062).inputs;
    const base = withEntry(gutachten('2027-05-20'));
    // A recorded version is computable, so it was matching; a differing declared AfA (a new review) is another input.
    const other = withEntry(gutachten('2027-05-20', { declaredAfa: [declared(A, '7920.01'), declared(B, '5280.00')] }));
    expect(inputFingerprint(other, 2026, identity)).toBe(inputFingerprint(base, 2026, identity));
    expect(inputFingerprint(other, 2027, identity)).not.toBe(inputFingerprint(base, 2027, identity));
    const moved = withEntry(gutachten('2028-02-01', { declaredAfa: [declared(A, '10800.00', 2027), declared(B, '7200.00', 2027)] }));
    expect(inputFingerprint(moved, 2024, identity)).not.toBe(inputFingerprint(base, 2024, identity));
    // Counter-check: the document's date alone is no input.
    const document = withEntry(gutachten('2027-05-20', { evidence: { ...gutachten('2027-05-20').evidence, date: day('2027-09-01') } }));
    expect(inputFingerprint(document, 2062, identity)).toBe(inputFingerprint(base, 2062, identity));
  });
});
