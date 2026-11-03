import { describe, expect, it } from 'vitest';
import type { ScheduleInput } from './schedule.js';
import { EXTENSION, REFUND, amount, codes, derive, item, items, owner, perItem, registry, yearOf } from './schedule-items.test-support.js';
import { declared, example, gutachten, purchase } from './schedule-residual.test-support.js';
import { A, B, C, W, asset, capitalized, eur, ownership } from './schedule.test-support.js';

/**
 * §59G Part 2's later costs (VC-X-41 Part 2; Prüfbericht 2026-11-01, Frage 9: „Restwert + HK über die
 * Restnutzungsdauer“, mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01; Entscheidung des
 * Projektinhabers, 2026-11-02, question 8): every part in the pool of a purchase with an applying shorter life runs to
 * that purchase's last month `L`; a part begun before a late evidence's switch runs at the band until it and then its
 * rest to `L`; no overflow; a part after `L` needs a new evidence. Heirs and `NOT_OWNED` keep the band. Synthetic.
 */

const item2030 = capitalized(EXTENSION, '2030-10-15', '33000.00');
const item2025 = capitalized(EXTENSION.replace('72', '75'), '2025-05-05', '19800.00', [[A, '1/1']]);
const sumOf = (values: readonly (string | null | undefined)[]) => {
  const cents = values.reduce((s, v) => s + BigInt((v ?? '0').replace('.', '')), 0n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
};
const withItems = (valuationDate: string, list: NonNullable<ScheduleInput['capitalizedItems']>, extra: Partial<ScheduleInput> = {}, entry = {}) =>
  example([gutachten(valuationDate, entry)], { capitalizedItems: list, ...extra });
const partRows = (input: ScheduleInput, party: string, i = 0, reg = registry) =>
  item(derive(input, reg), i).years.map((y) => [y.year, amount(owner(y, party)?.amount)]);

describe('later costs over the remaining useful life (§59G Part 2 "Later costs")', () => {
  it('an item starting after S (2030-01): 360 months to 2059-12, A 660.00 and B 440.00 a year, ending with the purchase; never at 1/33', () => {
    const s = derive(withItems('2027-05-20', [item2030]));
    const c = item(s);
    expect(c.owners.map((o) => [o.ownerPartyId, o.rate])).toEqual([
      [A, '1/30'],
      [B, '1/30'],
    ]);
    expect(c.years.map((y) => [y.year, amount(owner(y, A)?.amount), amount(owner(y, B)?.amount)])).toEqual(
      Array.from({ length: 30 }, (_, i) => [2030 + i, '660.00', '440.00']),
    );
    expect(c.end).toEqual({ lastYear: 2059, lastMonth: '2059-12' });
    expect(JSON.stringify(s)).not.toContain('SUBSEQUENT_COST_SHORTER_LIFE_NOT_SUPPORTED');
    expect(JSON.stringify(s)).not.toContain('SUBSEQUENT_COST_END_TO_VERIFY');
  });

  it('an item begun before S (2025) beside one after it: the band to 2026-12, then its rest to 2059-12; both end in L to the cent; POOLED_BASIS and PER_ITEM_SERIES equal', () => {
    const input = withItems('2027-05-20', [item2025, item2030]);
    const early = partRows(input, A, 0);
    expect(early.slice(0, 3)).toEqual([
      [2025, '396.00'],
      [2026, '396.00'],
      [2027, '576.00'],
    ]);
    expect(early.map(([y]) => y).pop()).toBe(2059);
    expect(sumOf(early.map(([, a]) => a as string | null))).toBe('19800.00');
    expect(sumOf(partRows(input, A, 1).map(([, a]) => a as string | null))).toBe('19800.00');
    expect(sumOf(partRows(input, B, 1).map(([, a]) => a as string | null))).toBe('13200.00');
    for (const i of [0, 1]) {
      expect(item(derive(input, perItem), i).years).toEqual(item(derive(input), i).years);
      expect(codes(item(derive(input), i).years.flatMap((y) => y.flags))).not.toContain('SUBSEQUENT_COST_END_TO_VERIFY');
    }
    // Counter-check: the band rate kept after S (two rates) would give 396.00 in 2027 and run past 2059.
    expect(early[2]).not.toEqual([2027, '396.00']);
  });

  it('a refund begun before S spreads its own negative rest the same way, to L', () => {
    const refund = capitalized(REFUND, '2025-06-01', '-3300.00', [[A, '1/1']]);
    const rows = partRows(withItems('2027-05-20', [refund]), A);
    expect(rows.slice(0, 3)).toEqual([
      [2025, '-66.00'],
      [2026, '-66.00'],
      [2027, '-96.00'],
    ]);
    expect(sumOf(rows.map(([, a]) => a as string | null))).toBe('-3300.00');
  });

  it('an item after L: REMAINING_USEFUL_LIFE_ENDED; within the life it is spread to L (n 2: L 2028-12)', () => {
    const short = { usefulLifeYears: 2 };
    const after = item(derive(withItems('2027-05-20', [capitalized(EXTENSION, '2029-03-03', '1200.00', [[A, '1/1']])], {}, short)));
    expect(owner(after.years[0], A)?.reasons).toEqual([{ code: 'REMAINING_USEFUL_LIFE_ENDED', details: { acquisitionId: W, lastMonth: '2028-12' } }]);
    const within = partRows(withItems('2027-05-20', [capitalized(EXTENSION, '2028-03-03', '1200.00', [[A, '1/1']])], {}, short), A);
    expect(within).toEqual([[2028, '1200.00']]);
  });

  it('FROM_START (Stichtag 2024-11-30): the item 2030-01 to 2057-03 (327 months), A 726.61 … 181.65, B 484.40 … 121.10, the sums whole', () => {
    const rows = item(derive(withItems('2024-11-30', [item2030]))).years.map((y) => [y.year, amount(owner(y, A)?.amount), amount(owner(y, B)?.amount)]);
    expect(rows.slice(0, 3)).toEqual([
      [2030, '726.61', '484.40'],
      [2031, '726.60', '484.41'],
      [2032, '726.61', '484.40'],
    ]);
    expect(rows[rows.length - 1]).toEqual([2057, '181.65', '121.10']);
    expect([sumOf(rows.map(([, a]) => a as string)), sumOf(rows.map(([, , b]) => b as string))]).toEqual(['19800.00', '13200.00']);
  });

  it('an owner not released from YE (B’s declared AfA missing) stops B’s part from 2027 with B’s reason; A’s runs; the band years before stand', () => {
    const input = withItems('2027-05-20', [capitalized(EXTENSION, '2025-05-05', '10000.00')], {}, { declaredAfa: [declared(A, '7920.00')] });
    const c = item(derive(input));
    expect([amount(owner(yearOf(c, 2026), B)?.amount), amount(owner(yearOf(c, 2027), B)?.amount)]).toEqual(['80.00', null]);
    expect(owner(yearOf(c, 2027), B)?.reasons).toEqual([
      { code: 'SHORTER_USEFUL_LIFE_RELEASE_MISSING', details: { acquisitionId: W, missing: ['DECLARED_AFA'] } },
    ]);
    expect(amount(owner(yearOf(c, 2027), A)?.amount)).toBe('174.55');
    expect(yearOf(c, 2027).amount).toBeNull();
  });

  it('an heir’s part and NOT_OWNED keep the band in pools of their own; the owners and NOT_OWNED sum to the component, the components to the property', () => {
    const entry = gutachten('2027-05-20', { declaredAfa: [declared(A, '13200.00')] });
    const input: ScheduleInput = {
      ...example([entry]),
      asset: asset({ buildingCompletionYear: 1965, shorterUsefulLives: [entry] }),
      acquisitions: [purchase({ acquiredShare: { numerator: 3, denominator: 5 } })],
      ownerships: [ownership(A, '3/5', '2024-04-01', null, W), ownership(C, '1/5', '2024-01-01', null, null)],
      capitalizedItems: [
        capitalized(EXTENSION, '2030-05-05', '10000.00', [
          [A, '3/5'],
          [C, '1/5'],
        ]),
      ],
      to: 2031,
    };
    const s = derive(input);
    const c = item(s);
    expect(c.owners.map((o) => [o.ownerPartyId, o.rate])).toEqual([
      [A, '1/30'],
      [C, '1/50'],
    ]);
    const y = yearOf(c, 2030);
    expect([amount(owner(y, A)?.amount), amount(owner(y, C)?.amount), amount(y.notOwned), amount(y.amount)]).toEqual(['200.00', '40.00', '40.00', '280.00']);
    const property = s.years.find((x) => x.year === 2030);
    const purchaseAmount = s.components[0]?.years.find((x) => x.year === 2030)?.amount;
    expect(amount(property?.amount)).toBe(sumOf([amount(purchaseAmount), '280.00']));
    expect(items(s)).toHaveLength(1);
  });
});

describe('the purchase’s rateEntry, never its stored entry (#238 M6, #240)', () => {
  // A late evidence not shorter from the first year (n 48, YE three years after Y1: 51 years): the band, while `w.entry`
  // judged on n alone would give 1/48.
  const notShorter = gutachten('2027-05-20', { usefulLifeYears: 48 });

  it('the pooled walk of a late evidence not shorter: the item exactly as without the entry (the overflow at the band)', () => {
    const list = [capitalized(EXTENSION, '2025-05-05', '10000.00'), capitalized(EXTENSION.replace('72', '76'), '2070-02-02', '5000.00')];
    const without = derive(example([], { capitalizedItems: list, to: 2100 }));
    const withEntry = derive(example([notShorter], { capitalizedItems: list, to: 2100 }));
    for (const i of [0, 1])
      expect(item(withEntry, i).years.map((y) => [y.year, amount(y.amount)])).toEqual(item(without, i).years.map((y) => [y.year, amount(y.amount)]));
    // The pool really overflows here (the first item ends before the purchase does), so the allowance is read.
    expect(codes(item(without, 0).years.flatMap((y) => y.flags))).toContain('SUBSEQUENT_COST_END_TO_VERIFY');
  });

  it('the nominal last month of a not computable purchase (allocation unreviewed) with that entry: the band’s 2074-03, as without the entry', () => {
    const unreviewed = purchase({
      allocation: {
        id: '0000bbbb-0000-4000-8000-000000000041',
        method: 'PURCHASE_CONTRACT',
        reviewState: 'UNREVIEWED',
        totalAllocableAmount: eur('240000.00'),
        buildingAmount: eur('240000.00'),
      },
    });
    const stopOf = (entries: readonly ReturnType<typeof gutachten>[]) =>
      owner(
        item(
          derive(example(entries, { acquisitions: [unreviewed], capitalizedItems: [capitalized(EXTENSION, '2025-05-05', '10000.00')], to: 2100 })),
        ).years.find((y) => owner(y, A)?.reasons.length),
        A,
      )?.reasons[0];
    expect(stopOf([notShorter])).toEqual(stopOf([]));
    expect(stopOf([notShorter])?.details['nominalLastMonth']).toBe('2074-03');
  });
});
