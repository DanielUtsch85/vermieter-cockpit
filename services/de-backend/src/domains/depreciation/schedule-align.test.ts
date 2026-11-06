import { describe, expect, it } from 'vitest';
import { addDays } from '../../shared/index.js';
import type { ScheduleAcquisition, ScheduleComponent, ScheduleInput, ScheduleOwnership } from './schedule.js';
import { A, B, D, W, X, acquisition, asset, day, ownership } from './schedule.test-support.js';
import { amount, cents, codes, component, derive, exactBasis, ownerIn, random, yearOf } from './schedule-purchase.test-support.js';

/**
 * §59A under §58Q (VC-X-55; Entscheidung des Projektinhabers, 2026-11-05, Frage 1 (A)), rules unchanged: once the act
 * aligned X, the seller's tenure ends on `t − 1` and the cut-off finds X by `ownershipStart = t`, so the months between
 * contract and transfer, which nobody had, are the seller's; the buyers' AfA is unchanged in every figure. The example
 * (S 400.00 → 800.00, A 2,133.33), a gap across a year end (the disposal year moves), §28.1A (no disposal for the existing
 * owner), and a seeded property: the buyers' years byte-identical, the seller's equal before the gap's year, every year's
 * parts summing to its amount. Synthetic values only.
 */
const S = D;
const RECORDED = new Date('2026-01-15T10:00:00Z');
const ALIGNED = new Date('2026-02-10T10:00:00Z');

/** S holds P by W (120,000.00, from 2015-07-01), sells it to the buyers by X (contract `c`, transfer `t` recorded later). */
function before(c: string, t: string, buyers: readonly (readonly [string, string])[] = [[A, '1/1']], predecessor?: readonly [string, string]): ScheduleInput {
  const w = acquisition({ ...exactBasis('120000.00'), id: W, sellerPartyIds: [], contractDate: day('2015-06-01'), economicTransferDate: day('2015-07-01') });
  const x: ScheduleAcquisition = acquisition({
    ...exactBasis('160000.00'),
    id: X,
    sellerPartyIds: [S],
    acquiredShare: predecessor === undefined ? { numerator: 1, denominator: 1 } : { numerator: 1, denominator: 2 },
    contractDate: day(c),
    economicTransferDate: day(t),
    economicTransferRecordedAt: RECORDED,
  });
  const dayBefore = addDays(day(c), -1);
  const rows: ScheduleOwnership[] =
    predecessor === undefined
      ? [ownership(S, '1/1', '2015-07-01', dayBefore, W)]
      : [ownership(S, '1/2', '2015-07-01', dayBefore, W), ownership(predecessor[0], predecessor[1], '2015-07-01', dayBefore, W)];
  return {
    asset: asset(),
    acquisitions: [w, x],
    ownerships: [...rows, ...buyers.map(([party, share]) => ownership(party, share, c, null, X))],
    today: day('2026-10-30'),
    from: 2014,
    to: 2032,
    ownerPartyId: null,
  };
}

/** The same input after the act: the sellers' and predecessors' ends to `t − 1`, X's rows from `t`, X aligned. */
function aligned(input: ScheduleInput): ScheduleInput {
  const x = input.acquisitions.find((a) => a.id === X) as ScheduleAcquisition;
  const t = x.economicTransferDate as ReturnType<typeof day>;
  const dayBefore = addDays(x.contractDate, -1);
  return {
    ...input,
    acquisitions: input.acquisitions.map((a) => (a.id === X ? { ...a, ownershipAlignedAt: ALIGNED } : a)),
    ownerships: input.ownerships.map((o) =>
      o.acquisitionId === X ? { ...o, validFrom: t } : o.validUntil === dayBefore ? { ...o, validUntil: addDays(t, -1) } : o,
    ),
  };
}

const years = (input: ScheduleInput, id: string) =>
  derive(input).components.find((c): c is ScheduleComponent => 'acquisitionId' in c && c.acquisitionId === id);

describe('§59A once §58Q aligned the Ownerships', () => {
  it('the example: S 400.00 to 800.00 in 2025, lastDaySource BUYER_ECONOMIC_TRANSFER_DATE before and after; A 2133.33 unchanged in every year', () => {
    const input = before('2025-03-01', '2025-05-01');
    const [w0, x0] = [component(derive(input), 0), component(derive(input), 1)];
    const [w1, x1] = [component(derive(aligned(input)), 0), component(derive(aligned(input)), 1)];
    expect([amount(ownerIn(yearOf(w0, 2025), S)?.amount), amount(ownerIn(yearOf(w1, 2025), S)?.amount)]).toEqual(['400.00', '800.00']);
    expect([ownerIn(yearOf(w0, 2025), S)?.months, ownerIn(yearOf(w1, 2025), S)?.months]).toEqual([2, 4]);
    expect(w0.owners[0]?.tenure).toEqual({ from: '2015-07-01', lastDay: '2025-02-28', lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' });
    expect(w1.owners[0]?.tenure).toEqual({ from: '2015-07-01', lastDay: '2025-04-30', lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' });
    expect(amount(ownerIn(yearOf(x1, 2025), A)?.amount)).toBe('2133.33');
    expect(JSON.stringify(x1.years)).toBe(JSON.stringify(x0.years));
    expect([x0.start, x0.basis]).toEqual([x1.start, x1.basis]);
    // §58N's flag on the component before, gone after.
    expect([
      codes(x0.flags).includes('OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER'),
      codes(x1.flags).includes('OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER'),
    ]).toEqual([true, false]);
    // 2024 and every year before the contract unchanged for S.
    for (const y of [2015, 2020, 2024]) expect(JSON.stringify(yearOf(w1, y))).toBe(JSON.stringify(yearOf(w0, y)));
  });

  it('counter-check: aligned rows read without the marker lose the cut-off (DISPOSAL_DATE_MISSING), as ownershipStart ignoring it would', () => {
    const input = aligned(before('2025-03-01', '2025-05-01'));
    const unmarked = { ...input, acquisitions: input.acquisitions.map((a) => ({ ...a, ownershipAlignedAt: null })) };
    const w = component(derive(unmarked), 0);
    expect(codes(ownerIn(yearOf(w, 2025), S)?.reasons ?? [])).toEqual(['DISPOSAL_DATE_MISSING']);
    expect(yearOf(w, 2025).calculationStatus).toBe('NOT_CALCULABLE');
    expect(w.owners[0]?.tenure.lastDaySource).toBe('VALID_UNTIL');
  });

  it('a gap across a year end: the disposal year moves from 2024 (11 months) to 2025 (1 month), 2024 in full; the buyer equal', () => {
    const input = before('2024-12-01', '2025-02-01');
    const [w0, w1] = [component(derive(input), 0), component(derive(aligned(input)), 0)];
    expect([amount(ownerIn(yearOf(w0, 2024), S)?.amount), w0.years.some((y) => y.year === 2025 && y.owners.some((o) => o.ownerPartyId === S))]).toEqual([
      '2200.00',
      false,
    ]);
    expect([amount(ownerIn(yearOf(w1, 2024), S)?.amount), amount(ownerIn(yearOf(w1, 2025), S)?.amount)]).toEqual(['2400.00', '200.00']);
    expect(JSON.stringify(component(derive(aligned(input)), 1).years)).toBe(JSON.stringify(component(derive(input), 1).years));
  });

  it('§28.1A: B held 1/2 beside S 1/2 and buys S half; B keeps W without a disposal, X computed in full, its weight unchanged', () => {
    const input = before('2025-03-01', '2025-05-01', [[B, '1/1']], [B, '1/2']);
    const after = derive(aligned(input));
    const w = component(after, 0);
    expect(w.owners.find((o) => o.ownerPartyId === B)?.tenure.lastDay ?? null).toBeNull();
    expect(w.owners.find((o) => o.ownerPartyId === S)?.tenure.lastDay).toBe('2025-04-30');
    const x0 = component(derive(input), 1);
    const x1 = component(after, 1);
    expect(x1.owners.map((o) => [o.ownerPartyId, o.acquiredShare, o.weight])).toEqual(x0.owners.map((o) => [o.ownerPartyId, o.acquiredShare, o.weight]));
    expect(JSON.stringify(x1.years)).toBe(JSON.stringify(x0.years));
    expect(amount(ownerIn(yearOf(w, 2025), B)?.amount)).toBe('1200.00');
  });

  it('unchanged money sums, seeded: the buyers byte-identical, the seller equal before the gap year and never less after, every year parts summing to its amount', () => {
    const next = random(55);
    for (let i = 0; i < 60; i++) {
      const start = new Date(Date.UTC(2016 + next(14), next(12), 1 + next(28)));
      const c = start.toISOString().slice(0, 10);
      const t = addDays(day(c), 1 + next(400));
      const split = next(3);
      const buyers: [string, string][] =
        split === 0
          ? [[A, '1/1']]
          : split === 1
            ? [
                [A, '1/2'],
                [B, '1/2'],
              ]
            : [
                [A, '1/3'],
                [B, '2/3'],
              ];
      const input = before(c, t, buyers);
      const [w0, x0] = [years(input, W), years(input, X)];
      const [w1, x1] = [years(aligned(input), W), years(aligned(input), X)];
      if (w0 === undefined || w1 === undefined || x0 === undefined || x1 === undefined) throw new Error('component missing');
      const label = `${c} → ${t}, split ${split}`;
      expect(JSON.stringify(x1.years), label).toBe(JSON.stringify(x0.years));
      const gapYear = Number(c.slice(0, 4));
      for (const y0 of w0.years) {
        const y1 = w1.years.find((y) => y.year === y0.year);
        if (y0.year < gapYear) expect(JSON.stringify(y1), `${label} ${y0.year}`).toBe(JSON.stringify(y0));
        expect(cents(ownerIn(y1 ?? y0, S)?.amount) >= cents(ownerIn(y0, S)?.amount), `${label} ${y0.year} not less`).toBe(true);
      }
      for (const c1 of [w1, x1]) {
        for (const y of c1.years) {
          if (y.amount === null) continue;
          expect(
            y.owners.reduce((sum, o) => sum + cents(o.amount), 0n),
            `${label} ${c1.acquisitionId} ${y.year}`,
          ).toBe(cents(y.amount));
        }
      }
    }
  });
});
