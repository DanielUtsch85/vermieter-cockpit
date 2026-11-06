import { describe, expect, it } from 'vitest';
import { addDays } from '../../shared/index.js';
import type { ScheduleAcquisition, ScheduleInput, ScheduleOwnership } from './schedule.js';
import { A, B, D, W, X, acquisition, asset, day, ownership } from './schedule.test-support.js';
import { amount, codes, component, derive, ownerIn, exactBasis, random, yearOf } from './schedule-purchase.test-support.js';

/**
 * §59A under §58R (VC-X-57; ADR-044; Entscheidung des Projektinhabers, 2026-11-06), rules unchanged: an Acquisition
 * confirmed from the transfer (`confirmedOwnershipStart` = `t`, the seller to `t − 1`, the buyers from `t`) gives from the
 * outset exactly what §58Q's act gives as a repair. One fixture, two paths, every component byte-identical: the example
 * (S 800.00, A 2,133.33 in 2025) and a seeded property over dates and splits. Synthetic values only.
 */
const S = D;
const RECORDED = new Date('2026-01-15T10:00:00Z');
const ALIGNED = new Date('2026-02-10T10:00:00Z');

/** W (S from 2015-07-01, 120,000.00) and X (S sells to the buyers, contract `c`, transfer `t` recorded while a DRAFT). */
function base(c: string, t: string): { w: ScheduleAcquisition; x: ScheduleAcquisition } {
  const w = acquisition({ ...exactBasis('120000.00'), id: W, sellerPartyIds: [], contractDate: day('2015-06-01'), economicTransferDate: day('2015-07-01') });
  const x = acquisition({
    ...exactBasis('160000.00'),
    id: X,
    sellerPartyIds: [S],
    acquiredShare: { numerator: 1, denominator: 1 },
    contractDate: day(c),
    economicTransferDate: day(t),
    economicTransferRecordedAt: RECORDED,
  });
  return { w, x };
}
const input = (acquisitions: ScheduleAcquisition[], ownerships: ScheduleOwnership[]): ScheduleInput => ({
  asset: asset(),
  acquisitions,
  ownerships,
  today: day('2026-11-06'),
  from: 2014,
  to: 2032,
  ownerPartyId: null,
});
/** VC-X-57: confirmed from the transfer, the rows written on `t` from the outset. */
function fromOutset(c: string, t: string, buyers: readonly (readonly [string, string])[] = [[A, '1/1']]): ScheduleInput {
  const { w, x } = base(c, t);
  return input(
    [w, { ...x, confirmedOwnershipStart: day(t) }],
    [ownership(S, '1/1', '2015-07-01', addDays(day(t), -1), W), ...buyers.map(([party, share]) => ownership(party, share, t, null, X))],
  );
}
/** §58N then §58Q's act: the rows from `c`, then aligned (the seller to `t − 1`, the buyers from `t`). */
function repaired(c: string, t: string, buyers: readonly (readonly [string, string])[] = [[A, '1/1']]): ScheduleInput {
  const { w, x } = base(c, t);
  return input(
    [w, { ...x, ownershipAlignedAt: ALIGNED }],
    [ownership(S, '1/1', '2015-07-01', addDays(day(t), -1), W), ...buyers.map(([party, share]) => ownership(party, share, t, null, X))],
  );
}
/** Every component as JSON, the fixture's generated Ownership ids left out (the two paths write different rows). */
const comparable = (i: ScheduleInput) => JSON.stringify(derive(i).components, (key, value: unknown) => (key === 'ownershipId' ? undefined : value));

describe('§59A for an Acquisition confirmed from the transfer (§58R)', () => {
  it('the example: S 800.00 (lastDay 2025-04-30, BUYER_ECONOMIC_TRANSFER_DATE), A 2133.33, no flag; byte-identical to §58Q repaired', () => {
    const out = derive(fromOutset('2025-03-01', '2025-05-01'));
    const [w, x] = [component(out, 0), component(out, 1)];
    expect(amount(ownerIn(yearOf(w, 2025), S)?.amount)).toBe('800.00');
    expect(w.owners[0]?.tenure).toEqual({ from: '2015-07-01', lastDay: '2025-04-30', lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' });
    expect(amount(ownerIn(yearOf(x, 2025), A)?.amount)).toBe('2133.33');
    expect(codes(x.flags)).not.toContain('OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER');
    expect(comparable(fromOutset('2025-03-01', '2025-05-01'))).toBe(comparable(repaired('2025-03-01', '2025-05-01')));
  });

  it('counter-check: the same rows read without the stored day (ownershipStart ignoring it) lose the cut-off, DISPOSAL_DATE_MISSING', () => {
    const i = fromOutset('2025-03-01', '2025-05-01');
    const unmarked = { ...i, acquisitions: i.acquisitions.map((a) => ({ ...a, confirmedOwnershipStart: null })) };
    const w = component(derive(unmarked), 0);
    expect(codes(ownerIn(yearOf(w, 2025), S)?.reasons ?? [])).toEqual(['DISPOSAL_DATE_MISSING']);
  });

  it('unchanged money sums, seeded: both paths byte-identical in every component for dates, gaps and splits', () => {
    const next = random(57);
    for (let i = 0; i < 40; i++) {
      const c = new Date(Date.UTC(2016 + next(14), next(12), 1 + next(28))).toISOString().slice(0, 10);
      const t = addDays(day(c), 1 + next(400));
      const split = next(2);
      const buyers: [string, string][] =
        split === 0
          ? [[A, '1/1']]
          : [
              [A, '1/3'],
              [B, '2/3'],
            ];
      expect(comparable(fromOutset(c, t, buyers)), `${c} → ${t}, split ${split}`).toBe(comparable(repaired(c, t, buyers)));
    }
  });
});
