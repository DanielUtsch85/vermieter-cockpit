import { describe, expect, it } from 'vitest';
import { amount, codes, component, derive, ownerIn, part1Registry, registry, withParameters, yearOf } from './schedule-purchase.test-support.js';
import { MATCHING, declared, example, gutachten, onDay, purchaseRows, spreadYears } from './schedule-residual.test-support.js';
import { A, B, W, day } from './schedule.test-support.js';

/**
 * §59G Part 2 (VC-X-41 Part 2; Prüfbericht 2026-11-01, Fragen 8 und 9, mündlich bestätigt durch den Steuerberater, laut
 * Projektinhaber am 2026-11-01; Entscheidung des Projektinhabers, 2026-11-02, questions 2, 3, 4, 5 and 11): a late
 * evidence keeps the band's years before its Stichtag's year and spreads each owner's carried-forward residual value
 * from January of that year over `n` whole years; it is released only with `ADVISOR_CONFIRMED`, its own evidence, a
 * release note and each owner's declared AfA through `YE − 1`, equal to the computed one to the cent. Synthetic.
 */

const BAND_2024_2026 = [
  [2024, '2160.00', '1440.00', 'CALCULATED'],
  [2025, '2880.00', '1920.00', 'CALCULATED'],
  [2026, '2880.00', '1920.00', 'CALCULATED'],
] as const;
const sumOf = (values: readonly (string | null)[]) => {
  const cents = values.reduce((s, v) => s + BigInt((v ?? '0').replace('.', '')), 0n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
};
const ownerReasons = (entries: Parameters<typeof example>[0], party: string, year = 2027, reg = registry) =>
  ownerIn(yearOf(component(derive(example(entries), reg)), year), party)?.reasons ?? [];

describe('the purchase under Part 2 (§59G "Example", the Part 2 column)', () => {
  it('the example literally: the band 2024–2026, from 2027-01 each owner’s residual over 33 years to 2059-12, the sums 144,000.00 and 96,000.00', () => {
    const rows = purchaseRows(example([gutachten('2027-05-20')]));
    expect(rows.slice(0, 3)).toEqual(BAND_2024_2026);
    expect(rows.map(([y]) => y)).toEqual(Array.from({ length: 36 }, (_, i) => 2024 + i));
    // The spread re-derived independently from the residual values shown at the end of 2026 (A 136,080.00, B 90,720.00).
    const a = spreadYears(14_400_000n, 792_000n, 396, 2027);
    const b = spreadYears(9_600_000n, 528_000n, 396, 2027);
    for (const [year, amountA, amountB, status] of rows.slice(3)) {
      expect([year, amountA, amountB, status]).toEqual([year, a.get(year), b.get(year), 'CALCULATED']);
    }
    // §59G's figures, literally.
    const at = (year: number) => rows.find(([y]) => y === year)?.slice(1, 3);
    expect([at(2027), at(2028)]).toEqual([
      ['4123.64', '2749.09'],
      ['4123.63', '2749.09'],
    ]);
    expect([2032, 2043, 2054].map((y) => at(y)?.[1])).toEqual(['2749.10', '2749.10', '2749.10']);
    expect([at(2058)?.[0], at(2059)?.[0]]).toEqual(['4123.63', '4123.64']);
    expect([sumOf(rows.map(([, x]) => x)), sumOf(rows.map(([, , x]) => x))]).toEqual(['144000.00', '96000.00']);
    const c = component(derive(example([gutachten('2027-05-20')])));
    expect([amount(ownerIn(yearOf(c, 2058), A)?.residualValue), amount(ownerIn(yearOf(c, 2059), A)?.residualValue)]).toEqual(['4123.64', '0.00']);
    expect(c.end).toEqual({ lastYear: 2059, lastMonth: '2059-12' });
    expect(c.flags).toEqual([
      {
        code: 'SHORTER_USEFUL_LIFE',
        details: {
          usefulLifeYears: 33,
          valuationDate: '2027-05-20',
          evidenceDate: '2027-06-15',
          method: 'FROM_EVIDENCE_YEAR',
          fromYear: 2027,
          lastMonth: '2059-12',
        },
      },
    ]);
    expect(c.rate).toMatchObject({
      kind: 'SHORTER_USEFUL_LIFE',
      rate: '63/2200',
      usefulLifeYears: 33,
      shorterUsefulLife: {
        usefulLifeYears: 33,
        valuationDate: '2027-05-20',
        evidenceDate: '2027-06-15',
        method: 'FROM_EVIDENCE_YEAR',
        fromYear: 2027,
        lastMonth: '2059-12',
      },
    });
    expect([yearOf(c, 2026).rate, yearOf(c, 2027).rate]).toEqual([
      { kind: 'BAND', annualFraction: '1/50' },
      { kind: 'SHORTER_USEFUL_LIFE', annualFraction: '63/2200' },
    ]);
    // The component's and the property's years are the sums of the owners'.
    const s = derive(example([gutachten('2027-05-20')]));
    expect([amount(yearOf(c, 2027).amount), amount(s.years.find((y) => y.year === 2027)?.amount)]).toEqual(['6872.73', '6872.73']);
    // Withdrawn by Part 2 where it computes: Part 1's reason appears nowhere.
    expect(JSON.stringify(s)).not.toContain('SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED');
  });

  it('no retroactive change: the years before YE byte-identical to the band only and to Part 1; FROM_START keeps today’s figures', () => {
    const band = purchaseRows(example([]));
    const part2 = purchaseRows(example([gutachten('2027-05-20')]));
    const part1 = purchaseRows(example([gutachten('2027-05-20')]), part1Registry);
    expect(part2.slice(0, 3)).toEqual(band.slice(0, 3));
    expect(part2.slice(0, 3)).toEqual(part1.slice(0, 3));
    for (const year of [2024, 2025, 2026]) {
      const p2 = yearOf(component(derive(example([gutachten('2027-05-20')]))), year);
      const p0 = yearOf(component(derive(example([]))), year);
      expect([amount(p2.cumulative), amount(p2.residualValue)]).toEqual([amount(p0.cumulative), amount(p0.residualValue)]);
    }
    // FROM_START (a Stichtag in the first year): 1/33 from 2024-04 as before, with or without a declared AfA (not read).
    const fromStart = purchaseRows(example([gutachten('2024-11-30', { declaredAfa: [] })]));
    expect(fromStart.slice(0, 2)).toEqual([
      [2024, '3272.73', '2181.82', 'CALCULATED'],
      [2025, '4363.63', '2909.09', 'CALCULATED'],
    ]);
    expect(purchaseRows(example([gutachten('2024-11-30', { declaredAfa: MATCHING })]))).toEqual(fromStart);
    expect(purchaseRows(example([gutachten('2024-11-30', { reviewState: 'CONFIRMED', releaseNote: null })]))).toEqual(fromStart);
  });
});

describe('the release and the declared AfA (§59G open questions 10 and 11)', () => {
  it('A matching and B one cent off: A computed, B not computable from 2027 (DECLARED_AFA_DIFFERS, both amounts), the component and the property null, B’s band years unchanged', () => {
    const entry = gutachten('2027-05-20', { declaredAfa: [declared(A, '7920.00'), declared(B, '5280.01')] });
    const rows = purchaseRows(example([entry]));
    const full = purchaseRows(example([gutachten('2027-05-20')]));
    expect(rows.slice(0, 3)).toEqual(BAND_2024_2026);
    expect(rows.slice(3).map(([y, a, b, s]) => [y, a, b, s])).toEqual(full.slice(3).map(([y, a]) => [y, a, null, 'NOT_CALCULABLE']));
    expect(ownerReasons([entry], B)).toEqual([
      {
        code: 'DECLARED_AFA_DIFFERS',
        details: {
          acquisitionId: W,
          throughYear: 2026,
          declaredAfa: { amount: '5280.01', currency: 'EUR' },
          computedAfa: { amount: '5280.00', currency: 'EUR' },
        },
      },
    ]);
    // Only the owner who differs: A carries no reason.
    expect(ownerReasons([entry], A)).toEqual([]);
    const c = component(derive(example([entry])));
    expect([yearOf(c, 2027).amount, yearOf(c, 2027).cumulative, yearOf(c, 2027).residualValue, c.end]).toEqual([null, null, null, null]);
    expect(derive(example([entry])).years.find((y) => y.year === 2027)?.amount ?? null).toBeNull();
    expect(derive(example([entry])).review.open.map((r) => r.code)).toContain('DECLARED_AFA_DIFFERS');
    // Counter-check: the declared AfA one cent lower differs too (never a tolerance).
    expect(codes(ownerReasons([gutachten('2027-05-20', { declaredAfa: [declared(A, '7920.00'), declared(B, '5279.99')] })], B))).toEqual([
      'DECLARED_AFA_DIFFERS',
    ]);
  });

  it('none recorded for B: SHORTER_USEFUL_LIFE_RELEASE_MISSING names DECLARED_AFA for B only; one through another year counts as none', () => {
    for (const rows of [[declared(A, '7920.00')], [declared(A, '7920.00'), declared(B, '3360.00', 2025)]]) {
      const entry = gutachten('2027-05-20', { declaredAfa: rows });
      expect(ownerReasons([entry], B)).toEqual([{ code: 'SHORTER_USEFUL_LIFE_RELEASE_MISSING', details: { acquisitionId: W, missing: ['DECLARED_AFA'] } }]);
      expect(ownerReasons([entry], A)).toEqual([]);
    }
    // The rule's parameter, never a constant: a test registry asking for no declared AfA computes B without one.
    const notRequired = withParameters((p) => ({
      ...p,
      shorterUsefulLife: { ...p.shorterUsefulLife, lateEvidenceRelease: { ...p.shorterUsefulLife.lateEvidenceRelease, declaredAfa: 'NOT_REQUIRED' } },
    }));
    expect(ownerReasons([gutachten('2027-05-20', { declaredAfa: [declared(A, '7920.00')] })], B, 2027, notRequired)).toEqual([]);
  });

  it('a late evidence only CONFIRMED, without its evidence, note and declared AfA: everything missing named, in order, for every owner; the band years stand', () => {
    const entry = gutachten('2027-05-20', {
      reviewState: 'CONFIRMED',
      releaseNote: null,
      declaredAfa: [],
      evidence: { ...gutachten(null).evidence, documentReference: null, valuationDate: day('2027-05-20') },
    });
    for (const party of [A, B]) {
      expect(ownerReasons([entry], party)).toEqual([
        {
          code: 'SHORTER_USEFUL_LIFE_RELEASE_MISSING',
          details: { acquisitionId: W, missing: ['ADVISOR_CONFIRMED', 'EVIDENCE', 'RELEASE_NOTE', 'DECLARED_AFA'] },
        },
      ]);
    }
    expect(purchaseRows(example([entry])).slice(0, 3)).toEqual(BAND_2024_2026);
    // A missing release and a differing declared AfA are both named.
    const both = gutachten('2027-05-20', { releaseNote: null, declaredAfa: [declared(A, '7000.00'), declared(B, '5280.00')] });
    expect(codes(ownerReasons([both], A))).toEqual(['SHORTER_USEFUL_LIFE_RELEASE_MISSING', 'DECLARED_AFA_DIFFERS']);
  });
});

describe('the switch month (§59G open question 2) and the threshold (open question 4)', () => {
  it('from January: a Stichtag on 1 January and one on 31 December of YE give the same years as 2027-05-20', () => {
    const may = purchaseRows(example([gutachten('2027-05-20')]));
    expect(purchaseRows(example([onDay('2027-01-01')]))).toEqual(may);
    expect(purchaseRows(example([onDay('2027-12-31')]))).toEqual(may);
  });

  it('the Stichtag’s month (test registry): 2027 split, January–April at the band and May–December spread, L 2060-04, the sums unchanged', () => {
    const month = withParameters((p) => ({ ...p, shorterUsefulLife: { ...p.shorterUsefulLife, evidenceYearCounts: 'FROM_VALUATION_MONTH' } }));
    const rows = purchaseRows(example([gutachten('2027-05-20')]), month);
    expect(rows.slice(0, 3)).toEqual(BAND_2024_2026);
    // A: 960.00 at the band (4 months), then from 8,880.00 shown at the end of April 135,120.00 over 396 months.
    expect(rows[3]).toEqual([2027, '3689.70', '2459.80', 'CALCULATED']);
    expect(rows.map(([y]) => y).pop()).toBe(2060);
    expect([sumOf(rows.map(([, x]) => x)), sumOf(rows.map(([, , x]) => x))]).toEqual(['144000.00', '96000.00']);
    const c = component(derive(example([gutachten('2027-05-20')]), month));
    expect(c.end).toEqual({ lastYear: 2060, lastMonth: '2060-04' });
    // Counter-check: January under the rule (Entscheidung des Projektinhabers, 2026-11-02).
    expect(purchaseRows(example([gutachten('2027-05-20')]))[3]).toEqual([2027, '4123.64', '2749.09', 'CALCULATED']);
  });

  it('the threshold from the first year: n 46 shorter (49), n 47 not (exactly 50: the band in every year, no release check), FROM_START n 47 judged on n', () => {
    expect(component(derive(example([gutachten('2027-05-20', { usefulLifeYears: 46 })]))).rate?.kind).toBe('SHORTER_USEFUL_LIFE');
    const notShorter = gutachten('2027-05-20', { usefulLifeYears: 47, reviewState: 'CONFIRMED', releaseNote: null, declaredAfa: [] });
    const c = component(derive(example([notShorter])));
    expect(c.flags).toEqual([{ code: 'USEFUL_LIFE_NOT_SHORTER', details: { usefulLifeYears: 47, shorterThanYears: 50, yearsFromFirstYear: 50 } }]);
    expect(purchaseRows(example([notShorter]))).toEqual(purchaseRows(example([]), registry).map(([y, a, b]) => [y, a, b, 'PROVISIONAL']));
    expect(JSON.stringify(c)).not.toContain('SHORTER_USEFUL_LIFE_RELEASE_MISSING');
    // n 48 (§59G "Variant threshold"): 51 years from the first year; judged on n alone it would be shorter.
    expect(component(derive(example([gutachten('2027-05-20', { usefulLifeYears: 48 })]))).flags[0]?.details['yearsFromFirstYear']).toBe(51);
    // FROM_START is judged on n: 47 is shorter than 50.
    expect(component(derive(example([gutachten('2024-11-30', { usefulLifeYears: 47 })]))).rate?.kind).toBe('SHORTER_USEFUL_LIFE');
  });

  it('YE = Y1 + 1: the band in 2024 only, the declared AfA through 2024, the residual over 33 years from 2025', () => {
    const entry = onDay('2025-03-01', { declaredAfa: [declared(A, '2160.00', 2024), declared(B, '1440.00', 2024)] });
    const rows = purchaseRows(example([entry]));
    expect(rows[0]).toEqual([2024, '2160.00', '1440.00', 'CALCULATED']);
    const a = spreadYears(14_400_000n, 216_000n, 396, 2025);
    expect(rows.slice(1).map(([y, x]) => [y, x])).toEqual([...a.entries()]);
    expect(rows.map(([y]) => y).pop()).toBe(2057);
    expect([sumOf(rows.map(([, x]) => x)), sumOf(rows.map(([, , x]) => x))]).toEqual(['144000.00', '96000.00']);
  });

  it('a Stichtag before the contract year stays not computable (§59G open question 5), whatever its declared AfA', () => {
    const c = component(derive(example([gutachten('2023-12-31')])));
    expect([c.status, codes(c.reasons)]).toEqual(['NOT_COMPUTABLE', ['USEFUL_LIFE_EVIDENCE_BEFORE_PURCHASE']]);
  });
});
