import { describe, expect, it } from 'vitest';
import type { Money, RuleRegistry } from '../../shared/index.js';
import type { DepreciationSchedule, ScheduleAcquisition } from './schedule.js';
import { A, B, C, D, W, X, Y, acc8, acquisition, day, ownership } from './schedule.test-support.js';
import { amount, codes, component, derive, exactBasis, ownerIn, registry, withParameters, yearOf } from './schedule-purchase.test-support.js';

/**
 * VC-8-02 domain (api-design.md §59A, §28.1A "Effect on §59A"): the owners' tenure in the purchase components — the
 * end and the disposal year, a reduced share, OWNER_WITHOUT_ACQUISITION, an existing owner buying a further share.
 * Moved out of `schedule.test.ts` unchanged (issue #191); the inputs as there.
 */
describe('the tenure, a reduced share, the end (P8-D8, P8-D9)', () => {
  /** B sells its 2/5 to C effective `transfer`; C's Acquisition X with `economicTransferDate` (or not). */
  const sale = (transfer: string, economic: boolean, reg: RuleRegistry = registry) => {
    const lastDay = new Date(`${transfer}T00:00:00Z`);
    lastDay.setUTCDate(lastDay.getUTCDate() - 1);
    const until = lastDay.toISOString().slice(0, 10);
    return derive(
      {
        ...acc8({ from: 2028, to: 2030 }),
        acquisitions: [
          acquisition(),
          acquisition({
            ...exactBasis('110000.00'),
            id: X,
            sellerPartyIds: [B],
            acquiredShare: { numerator: 2, denominator: 5 },
            contractDate: day(transfer),
            economicTransferDate: economic ? day(transfer) : null,
          }),
        ],
        ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', until, W), ownership(C, '2/5', transfer, null, X)],
      },
      reg,
    );
  };

  it('B sells to C on 2029-07-01: B’s 2029 is 6/12 = 1,017.60, CALCULATED (the disposal year confirmed); C’s component from July', () => {
    const s = sale('2029-07-01', true);
    const w = component(s, 0);
    const b2029 = ownerIn(yearOf(w, 2029), B);
    expect([b2029?.months, amount(b2029?.amount), b2029?.calculationStatus]).toEqual([6, '1017.60', 'CALCULATED']);
    // Prüfbericht 01.11.2026, Frage 4 (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01):
    // DISPOSAL_YEAR_TO_VERIFY no longer appears.
    expect(b2029?.flags).toEqual([]);
    expect(w.owners.find((o) => o.ownerPartyId === B)?.tenure).toEqual({
      from: '2026-07-01',
      lastDay: '2029-06-30',
      lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE',
    });
    expect(ownerIn(yearOf(w, 2030), B)).toBeUndefined();
    expect(component(s, 1).start).toMatchObject({ date: '2029-07-01', month: '2029-07' });
    expect(ownerIn(yearOf(w, 2028), B)?.flags).toEqual([]);
    // The seller's residual value stays as it was; nothing passes to the buyer.
    expect(amount(ownerIn(yearOf(w, 2029), B)?.residualValue)).toBe(amount({ amount: (101760 - 1017.6 - 2035.2 * 2 - 1017.6).toFixed(2) } as Money));
  });

  it('a sale on the 15th: endMonthCounts true takes the month of the last day (7/12 = 1,187.20), false does not (6/12 = 1,017.60)', () => {
    expect(amount(ownerIn(yearOf(component(sale('2029-07-15', true), 0), 2029), B)?.amount)).toBe('1187.20');
    const notCounting = withParameters((p) => ({ ...p, end: { ...p.end, disposal: { ...p.end.disposal, endMonthCounts: false } } }));
    expect(amount(ownerIn(yearOf(component(sale('2029-07-15', true, notCounting), 0), 2029), B)?.amount)).toBe('1017.60');
    // On the 1st both agree.
    expect(amount(ownerIn(yearOf(component(sale('2029-07-01', true, notCounting), 0), 2029), B)?.amount)).toBe('1017.60');
  });

  it('15 November: 11/12 of the year for the seller with endMonthCounts true', () => {
    const s = derive({
      ...acc8({ from: 2029, to: 2029 }),
      acquisitions: [
        acquisition({ economicTransferDate: day('2026-01-01') }),
        acquisition({ ...exactBasis('1.00'), id: X, sellerPartyIds: [A], contractDate: day('2029-11-15'), economicTransferDate: day('2029-11-15') }),
      ],
      ownerships: [ownership(A, '1/1', '2026-01-01', '2029-11-14', W), ownership(C, '1/1', '2029-11-15', null, X)],
    });
    expect(amount(ownerIn(yearOf(component(s, 0), 2029), A)?.amount)).toBe('4664.00');
    expect(ownerIn(yearOf(component(s, 0), 2029), A)?.months).toBe(11);
  });

  it('DISPOSAL_DATE_MISSING without the buyer’s Acquisition: B’s 2029 NOT_CALCULABLE with amount null (never 0.00), 2028 computed, A shown', () => {
    const s = derive({
      ...acc8({ from: 2028, to: 2030 }),
      ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', '2029-06-30', W)],
    });
    const w = component(s);
    const b2029 = ownerIn(yearOf(w, 2029), B);
    expect(b2029).toMatchObject({ amount: null, residualValue: null, months: null, calculationStatus: 'NOT_CALCULABLE' });
    expect(b2029?.reasons).toEqual([{ code: 'DISPOSAL_DATE_MISSING', details: { validUntil: '2029-06-30', buyerAcquisitionId: null } }]);
    expect(amount(ownerIn(yearOf(w, 2028), B)?.amount)).toBe('2035.20');
    expect(amount(ownerIn(yearOf(w, 2029), A)?.amount)).toBe('3052.80');
    expect(yearOf(w, 2029)).toMatchObject({ amount: null, cumulative: null, residualValue: null, calculationStatus: 'NOT_CALCULABLE' });
    const y2029 = s.years.find((y) => y.year === 2029);
    expect(y2029).toMatchObject({ status: 'PARTIAL', calculationStatus: 'NOT_CALCULABLE', amount: null, residualValue: null });
    expect(y2029?.owners?.map((o) => [o.ownerPartyId, amount(o.amount)])).toEqual([
      [A, '3052.80'],
      [B, null],
    ]);
    // Nothing follows the year of the end.
    expect(ownerIn(yearOf(w, 2030), B)).toBeUndefined();
    expect(w.owners.find((o) => o.ownerPartyId === B)?.tenure).toEqual({ from: '2026-07-01', lastDay: '2029-06-30', lastDaySource: 'VALID_UNTIL' });
  });

  it('DISPOSAL_DATE_MISSING when the buyer’s Acquisition has no economicTransferDate: the buyer named', () => {
    const b2029 = ownerIn(yearOf(component(sale('2029-07-01', false), 0), 2029), B);
    expect(b2029?.reasons).toEqual([{ code: 'DISPOSAL_DATE_MISSING', details: { validUntil: '2029-06-30', buyerAcquisitionId: X } }]);
  });

  it('a DRAFT buyer’s Acquisition gives no cut-off, even with its economicTransferDate: B’s 2029 DISPOSAL_DATE_MISSING, 2028 computed', () => {
    const s = derive({
      ...acc8({ from: 2028, to: 2030 }),
      acquisitions: [
        acquisition(),
        acquisition({
          ...exactBasis('110000.00'),
          id: X,
          status: 'DRAFT',
          sellerPartyIds: [B],
          acquiredShare: { numerator: 2, denominator: 5 },
          contractDate: day('2029-07-01'),
          economicTransferDate: day('2029-07-01'),
        }),
      ],
      ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', '2029-06-30', W), ownership(C, '2/5', '2029-07-01', null, X)],
    });
    const w = component(s, 0);
    const b2029 = ownerIn(yearOf(w, 2029), B);
    expect(b2029).toMatchObject({ amount: null, calculationStatus: 'NOT_CALCULABLE' });
    expect(b2029?.reasons).toEqual([{ code: 'DISPOSAL_DATE_MISSING', details: { validUntil: '2029-06-30', buyerAcquisitionId: null } }]);
    expect(amount(ownerIn(yearOf(w, 2028), B)?.amount)).toBe('2035.20');
  });

  it('DISPOSAL_YEAR_TO_VERIFY only while the rule says unverified: a test registry with verified false computes the same, PROVISIONAL', () => {
    const unverified = withParameters((p) => ({ ...p, end: { ...p.end, disposal: { ...p.end.disposal, verified: false } } }));
    const b2029 = ownerIn(yearOf(component(sale('2029-07-01', true, unverified), 0), 2029), B);
    expect([amount(b2029?.amount), b2029?.calculationStatus]).toEqual(['1017.60', 'PROVISIONAL']);
    expect(b2029?.flags).toEqual([
      {
        code: 'DISPOSAL_YEAR_TO_VERIFY',
        details: {
          lastDay: '2029-06-30',
          months: 6,
          endMonthCounts: true,
          legalBasis:
            'R 7.4 Abs. 8 EStR; Prüfbericht 01.11.2026, mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01: Frage 4, the month of disposal counts in full for the seller',
        },
      },
    ]);
  });

  it('a share changed by §26.2 without a sale does not end the tenure: A 1/1 closed and continued at 1/1 the next day', () => {
    const s = derive({
      ...acc8({ from: 2027, to: 2029 }),
      acquisitions: [acquisition({ economicTransferDate: day('2026-01-01') })],
      ownerships: [ownership(A, '1/1', '2026-01-01', '2027-12-31', W), ownership(A, '1/1', '2028-01-01', null, null)],
    });
    const w = component(s);
    expect(w.owners[0]?.tenure.lastDay).toBeNull();
    expect([2027, 2028, 2029].map((y) => amount(yearOf(w, y).amount))).toEqual(['5088.00', '5088.00', '5088.00']);
    expect(s.years.flatMap((y) => codes(y.flags))).toEqual([]);
  });

  it('a reduced share keeps the fraction still held (OWNER_SHARE_CHANGED) and never rises again without a purchase', () => {
    const s = derive({
      ...acc8({ from: 2028, to: 2031 }),
      acquisitions: [
        acquisition({ economicTransferDate: day('2026-01-01') }),
        acquisition({
          ...exactBasis('100000.00'),
          id: X,
          sellerPartyIds: [A],
          acquiredShare: { numerator: 1, denominator: 2 },
          contractDate: day('2028-07-01'),
          economicTransferDate: day('2028-07-01'),
        }),
      ],
      ownerships: [
        ownership(A, '1/1', '2026-01-01', '2028-06-30', W),
        ownership(A, '1/2', '2028-07-01', '2029-12-31', null),
        ownership(C, '1/2', '2028-07-01', '2029-12-31', X),
        // A back at 1/1 from 2030 without an Acquisition (C's half came back, not recorded as a purchase).
        ownership(A, '1/1', '2030-01-01', null, null),
      ],
    });
    const w = component(s, 0);
    const a2028 = ownerIn(yearOf(w, 2028), A);
    // 6 months at 1/1, 6 at 1/2: 2,544.00 + 1,272.00.
    // The disposal year confirmed (Prüfbericht 01.11.2026, Frage 4): only the informative OWNER_SHARE_CHANGED remains.
    expect([amount(a2028?.amount), a2028?.fraction, a2028?.calculationStatus]).toEqual(['3816.00', '1/2', 'CALCULATED']);
    expect(a2028?.flags).toEqual([{ code: 'OWNER_SHARE_CHANGED', details: { date: '2028-07-01', from: '1/1', to: '1/2' } }]);
    expect([2030, 2031].map((y) => [amount(ownerIn(yearOf(w, y), A)?.amount), ownerIn(yearOf(w, y), A)?.fraction])).toEqual([
      ['2544.00', '1/2'],
      ['2544.00', '1/2'],
    ]);
    // The half held again without a purchase is uncovered.
    expect(s.years.find((y) => y.year === 2030)?.flags.find((f) => f.code === 'OWNER_WITHOUT_ACQUISITION')?.details).toEqual({
      ownerPartyId: A,
      from: '2030-01-01',
      heldShare: '1/1',
      coveredShare: '1/2',
    });
  });

  it('a reduced share without the buyer’s date: that year and every later one NOT_CALCULABLE for the owner', () => {
    const s = derive({
      ...acc8({ from: 2028, to: 2029 }),
      acquisitions: [acquisition({ economicTransferDate: day('2026-01-01') })],
      ownerships: [ownership(A, '1/1', '2026-01-01', '2028-06-30', W), ownership(A, '1/2', '2028-07-01', null, null)],
    });
    for (const y of [2028, 2029]) {
      expect(ownerIn(yearOf(component(s), y), A)).toMatchObject({
        amount: null,
        calculationStatus: 'NOT_CALCULABLE',
        reasons: [{ code: 'DISPOSAL_DATE_MISSING' }],
      });
    }
  });
});

describe('OWNER_WITHOUT_ACQUISITION (P8-D8)', () => {
  const flagged = (s: DepreciationSchedule, year: number) =>
    s.years
      .find((y) => y.year === year)
      ?.flags.filter((f) => f.code === 'OWNER_WITHOUT_ACQUISITION')
      .map((f) => f.details);

  it('an inherited share: B’s 2/5 passes to D the next day without an Acquisition', () => {
    const s = derive({
      ...acc8({ from: 2029, to: 2030 }),
      acquisitions: [
        acquisition(),
        acquisition({
          ...exactBasis('1.00'),
          id: X,
          status: 'CONFIRMED',
          sellerPartyIds: [C],
          contractDate: day('2020-01-01'),
          economicTransferDate: day('2020-01-01'),
        }),
      ].slice(0, 1),
      ownerships: [
        ownership(A, '3/5', '2026-07-01', null, W),
        ownership(B, '2/5', '2026-07-01', '2029-06-30', W),
        ownership(D, '2/5', '2029-07-01', null, null),
      ],
    });
    expect(flagged(s, 2029)).toEqual([{ ownerPartyId: D, from: '2029-07-01', heldShare: '2/5', coveredShare: '0/1' }]);
    expect(flagged(s, 2030)).toEqual([{ ownerPartyId: D, from: '2030-01-01', heldShare: '2/5', coveredShare: '0/1' }]);
    expect(s.years.find((y) => y.year === 2029)?.calculationStatus).not.toBe('CALCULATED');
    // At D's owner level: no component, years of 0.00, and the flag.
    const own = derive({
      ...acc8({ from: 2029, to: 2030, ownerPartyId: D }),
      ownerships: [
        ownership(A, '3/5', '2026-07-01', null, W),
        ownership(B, '2/5', '2026-07-01', '2029-06-30', W),
        ownership(D, '2/5', '2029-07-01', null, null),
      ],
    });
    expect(own.components).toEqual([]);
    expect(own.years.map((y) => [amount(y.amount), codes(y.flags)])).toEqual([
      ['0.00', ['OWNER_WITHOUT_ACQUISITION']],
      ['0.00', ['OWNER_WITHOUT_ACQUISITION']],
    ]);
  });

  it('a share raised by §26.2 without an Acquisition: A 3/5 → 4/5', () => {
    const s = derive({
      ...acc8({ from: 2028, to: 2028 }),
      ownerships: [
        ownership(A, '3/5', '2026-07-01', '2027-12-31', W),
        ownership(A, '4/5', '2028-01-01', null, null),
        ownership(B, '1/5', '2026-07-01', null, W),
      ],
    });
    expect(flagged(s, 2028)).toEqual([{ ownerPartyId: A, from: '2028-01-01', heldShare: '4/5', coveredShare: '3/5' }]);
  });

  it('an owner with no Acquisition at all', () => {
    const s = derive({ ...acc8({ from: 2026, to: 2026 }), acquisitions: [], ownerships: [ownership(D, '1/1', '2020-01-01', null, null)] });
    expect(flagged(s, 2026)).toEqual([{ ownerPartyId: D, from: '2026-01-01', heldShare: '1/1', coveredShare: '0/1' }]);
    expect(s.review.open).toEqual([{ code: 'OWNER_WITHOUT_ACQUISITION', count: 1 }]);
  });
});

describe('an existing owner buying a further share (§28.1A "Effect on §59A")', () => {
  /** A 1/2 (W) buys B's 1/2 in X on 2028-07-01: O1 and O2 end on 2028-06-30, O3 A 1/1 carries X. */
  const furtherShare = (xShare: string, xStatus = 'CONFIRMED') => {
    const [n, d] = xShare.split('/').map(Number) as [number, number];
    return {
      ...acc8({ from: 2028, to: 2029 }),
      acquisitions: [
        acquisition({ economicTransferDate: day('2026-01-01'), acquiredShare: { numerator: 1, denominator: 1 } }),
        acquisition({
          ...exactBasis('130000.00'),
          id: X,
          status: xStatus,
          sellerPartyIds: [B],
          acquiredShare: { numerator: n, denominator: d },
          contractDate: day('2028-06-01'),
          economicTransferDate: day('2028-07-01'),
        }),
      ],
      ownerships: [
        ownership(A, '1/2', '2026-01-01', '2028-06-30', W),
        ownership(B, '1/2', '2026-01-01', '2028-06-30', W),
        ownership(A, '1/1', '2028-07-01', null, X),
      ],
    };
  };

  it('W and X both computed in full from the transfer: no BUYER_ALREADY_OWNER, no OWNER_WITHOUT_ACQUISITION; W unchanged by O1’s end', () => {
    const s = derive(furtherShare('1/2'));
    const [w, x] = [component(s, 0), component(s, 1)];
    expect([w.status, x.status, x.reasons]).toEqual(['COMPUTABLE', 'COMPUTABLE', []]);
    expect(x.owners.map((o) => [o.ownerPartyId, o.share, o.shareBefore, o.acquiredShare, o.weight, amount(o.basis)])).toEqual([
      [A, '1/1', '1/2', '1/2', '1/1', '130000.00'],
    ]);
    // A's half of W keeps depreciating at 1/1 of A's part (2,544.00 a year), through O3.
    expect(w.owners.find((o) => o.ownerPartyId === A)?.tenure.lastDay).toBeNull();
    expect([2028, 2029].map((y) => [amount(ownerIn(yearOf(w, y), A)?.amount), ownerIn(yearOf(w, y), A)?.fraction])).toEqual([
      ['2544.00', '1/1'],
      ['2544.00', '1/1'],
    ]);
    expect(amount(yearOf(x, 2029).amount)).toBe('2600.00');
    expect(s.years.flatMap((y) => codes(y.flags)).filter((c) => c === 'OWNER_WITHOUT_ACQUISITION' || c === 'BUYER_ALREADY_OWNER')).toEqual([]);
  });

  it('a later reduction across both components is pro rata; SHARE_REDUCTION_SPLIT_TO_VERIFY only while the rule leaves it unverified', () => {
    const base = furtherShare('1/2');
    const input = {
      ...base,
      acquisitions: [
        ...base.acquisitions,
        acquisition({
          ...exactBasis('140000.00'),
          id: Y,
          sellerPartyIds: [A],
          acquiredShare: { numerator: 1, denominator: 2 },
          contractDate: day('2029-07-01'),
          economicTransferDate: day('2029-07-01'),
        }),
      ],
      ownerships: [
        ownership(A, '1/2', '2026-01-01', '2028-06-30', W),
        ownership(B, '1/2', '2026-01-01', '2028-06-30', W),
        ownership(A, '1/1', '2028-07-01', '2029-06-30', X),
        ownership(A, '1/2', '2029-07-01', null, null),
        ownership(C, '1/2', '2029-07-01', null, Y),
      ],
    };
    const s = derive(input);
    // Prüfbericht 01.11.2026, Fragen 4 and 11 (mündlich bestätigt durch den Steuerberater, laut Projektinhaber am
    // 2026-11-01): neither DISPOSAL_YEAR_TO_VERIFY nor SHARE_REDUCTION_SPLIT_TO_VERIFY appears any more.
    for (const c of [component(s, 0), component(s, 1)]) {
      const a = ownerIn(yearOf(c, 2029), A);
      expect(a?.fraction).toBe('1/2');
      expect([codes(a?.flags ?? []), a?.calculationStatus]).toEqual([['OWNER_SHARE_CHANGED'], 'CALCULATED']);
    }
    // With the split unverified again (a test registry), the flag is back on both components, naming them.
    const unverified = derive(
      input,
      withParameters((p) => ({ ...p, shareReduction: { ...p.shareReduction, verified: false } })),
    );
    for (const c of [component(unverified, 0), component(unverified, 1)]) {
      const a = ownerIn(yearOf(c, 2029), A);
      expect(codes(a?.flags ?? [])).toEqual(['OWNER_SHARE_CHANGED', 'SHARE_REDUCTION_SPLIT_TO_VERIFY']);
      expect(a?.flags.find((f) => f.code === 'SHARE_REDUCTION_SPLIT_TO_VERIFY')?.details).toEqual({
        date: '2029-07-01',
        from: '1/1',
        to: '1/2',
        componentIds: [`ACQUISITION:${W}`, `ACQUISITION:${X}`],
      });
    }
    // One component only: the reduction is not split, so no SHARE_REDUCTION_SPLIT_TO_VERIFY (the reference case below).
  });

  /**
   * The reference case of the tax review (Prüfbericht 01.11.2026, Frage 11; mündlich bestätigt durch den Steuerberater,
   * laut Projektinhaber am 2026-11-01): A bought 50 % (W, building 100,000.00 for A's half) and later the other 50 %
   * (X, building 160,000.00); A sells 50 % to C. Pro rata over both purchases, 130,000.00 of basis remain
   * (50,000.00 + 80,000.00), never 80,000.00 (FIFO: W sold first) or 50,000.00 (LIFO: X sold first).
   */
  it('the review’s reference case: 50 % of 100,000 and 160,000 sold pro rata leaves a 130,000.00 basis share, 2,600.00 a year at 2 %', () => {
    const input = {
      ...acc8({ from: 2028, to: 2030 }),
      acquisitions: [
        acquisition({ ...exactBasis('200000.00'), economicTransferDate: day('2026-01-01') }),
        acquisition({
          ...exactBasis('160000.00'),
          id: X,
          sellerPartyIds: [B],
          acquiredShare: { numerator: 1, denominator: 2 },
          contractDate: day('2028-06-01'),
          economicTransferDate: day('2028-07-01'),
        }),
        acquisition({
          ...exactBasis('150000.00'),
          id: Y,
          sellerPartyIds: [A],
          acquiredShare: { numerator: 1, denominator: 2 },
          contractDate: day('2029-12-01'),
          economicTransferDate: day('2030-01-01'),
        }),
      ],
      ownerships: [
        ownership(A, '1/2', '2026-01-01', '2028-06-30', W),
        ownership(B, '1/2', '2026-01-01', '2028-06-30', W),
        ownership(A, '1/1', '2028-07-01', '2029-12-31', X),
        ownership(A, '1/2', '2030-01-01', null, null),
        ownership(C, '1/2', '2030-01-01', null, Y),
      ],
    };
    const s = derive(input);
    const [w, x] = [component(s, 0), component(s, 1)];
    const basisOf = (c: typeof w) => c.owners.find((o) => o.ownerPartyId === A)?.basis;
    expect([amount(basisOf(w)), amount(basisOf(x))]).toEqual(['100000.00', '160000.00']);
    // 2029: A holds both purchases in full, 2 % of 260,000.00.
    const a2029 = [w, x].map((c) => ownerIn(yearOf(c, 2029), A));
    expect(a2029.map((o) => [amount(o?.amount), o?.fraction])).toEqual([
      ['2000.00', '1/1'],
      ['3200.00', '1/1'],
    ]);
    // 2030: each purchase keeps half, 50,000.00 + 80,000.00 = 130,000.00; 2 % of it is 2,600.00 (FIFO 1,600.00, LIFO 1,000.00).
    const a2030 = [w, x].map((c) => ownerIn(yearOf(c, 2030), A));
    expect(a2030.map((o) => [amount(o?.amount), o?.fraction, o?.calculationStatus])).toEqual([
      ['1000.00', '1/2', 'CALCULATED'],
      ['1600.00', '1/2', 'CALCULATED'],
    ]);
    const remaining = [w, x].reduce((sum, c, i) => {
      const [n, d] = (a2030[i]?.fraction ?? '0/1').split('/').map(BigInt) as [bigint, bigint];
      return sum + (BigInt((amount(basisOf(c)) ?? '0').replace('.', '')) * n) / d;
    }, 0n);
    expect(remaining).toBe(13_000_000n);
    expect(a2030.reduce((sum, o) => sum + Number(amount(o?.amount)), 0)).toBe(2600);
    // The confirmed split carries no SHARE_REDUCTION_SPLIT_TO_VERIFY; the reduction is informative only.
    expect(a2030.map((o) => codes(o?.flags ?? []))).toEqual([['OWNER_SHARE_CHANGED'], ['OWNER_SHARE_CHANGED']]);
    // One component only (A sells half of W alone, never having bought X): never split, never flagged, verified or not.
    const one = derive(
      {
        ...input,
        acquisitions: [
          input.acquisitions[0] as ScheduleAcquisition,
          { ...(input.acquisitions[2] as ScheduleAcquisition), contractDate: day('2027-12-01'), economicTransferDate: day('2028-01-01') },
        ],
        ownerships: [
          ownership(A, '1/1', '2026-01-01', '2027-12-31', W),
          ownership(A, '1/2', '2028-01-01', null, null),
          ownership(C, '1/2', '2028-01-01', null, Y),
        ],
      },
      withParameters((p) => ({ ...p, shareReduction: { ...p.shareReduction, verified: false } })),
    );
    expect(codes(ownerIn(yearOf(component(one, 0), 2028), A)?.flags ?? [])).toEqual(['OWNER_SHARE_CHANGED']);
  });

  it('the legacy 1/1 workaround (X confirmed with acquiredShare 1/1) is still BUYER_ALREADY_OWNER, not computed; W unaffected', () => {
    const s = derive(furtherShare('1/1'));
    const x = component(s, 1);
    expect(x.status).toBe('NOT_COMPUTABLE');
    expect(x.reasons).toEqual([{ code: 'BUYER_ALREADY_OWNER', details: { ownerPartyIds: [A], expected: '1/1', actual: '1/2' } }]);
    expect(yearOf(x, 2029)).toMatchObject({ amount: null, calculationStatus: 'NOT_CALCULABLE' });
    expect(component(s, 0).status).toBe('COMPUTABLE');
    expect(amount(ownerIn(yearOf(component(s, 0), 2029), A)?.amount)).toBe('2544.00');
  });

  it('a DRAFT X is listed with ACQUISITION_NOT_CONFIRMED only', () => {
    const x = component(derive(furtherShare('1/1', 'DRAFT')), 1);
    expect(x.reasons).toEqual([{ code: 'ACQUISITION_NOT_CONFIRMED', details: {} }]);
  });
});
