import { describe, expect, it } from 'vitest';
import type { RuleRegistry } from '../../shared/index.js';
import type { ComponentYear, ScheduleComponent } from './schedule.js';
import type { ItemComponent } from './schedule-items.js';
import { A, B, C, W, X, acc8, acquisition, asset, capitalized, day, eur, ownership } from './schedule.test-support.js';
import {
  EXTENSION,
  REFUND,
  amount,
  cents,
  codes,
  derive,
  item,
  items,
  owner,
  perItem,
  random,
  registry,
  repair,
  use,
  withParameters,
  yearOf,
} from './schedule-items.test-support.js';

/**
 * VC-8-03 domain (api-design.md §59B): the owner parts of the capitalised items — the owner's purchase without
 * economicTransferDate (VC-X-33), per owner (§58C's parts), reasons and carried flags. Moved out of
 * `schedule-items.test.ts` unchanged (issue #191); ACC8 as there.
 */
describe('the owner’s purchase without economicTransferDate (§59A open question 6, decided 2026-10-31; VC-X-33)', () => {
  /** ACC8 with W undated: contract 2026-03-01, the Ownerships from it (§27.1's transferDate), an item of 2026-09-15. */
  const undated = (reg: RuleRegistry = registry) =>
    derive(
      acc8({
        from: 2026,
        to: 2027,
        acquisitions: [acquisition({ contractDate: day('2026-03-01'), economicTransferDate: null })],
        ownerships: [ownership(A, '3/5', '2026-03-01', null, W), ownership(B, '2/5', '2026-03-01', null, W)],
        capitalizedItems: [capitalized(EXTENSION, '2026-09-15', '12000.00')],
      }),
      reg,
    );

  it('never before the owner’s start, and that start unknown: every owner part TRANSFER_DATE_MISSING, amounts null, under either end method', () => {
    for (const reg of [registry, perItem]) {
      const c = item(undated(reg));
      const reason = { code: 'TRANSFER_DATE_MISSING', details: { acquisitionId: W, contractDate: '2026-03-01' } };
      // The contract date is never the owner's first month (it would be 2026-03).
      expect(c.owners.map((o) => [o.ownerPartyId, o.firstMonth])).toEqual([
        [A, null],
        [B, null],
      ]);
      expect(c.years.map((y) => [y.year, y.amount, y.calculationStatus, y.owners.map((o) => [o.amount, o.calculationStatus, o.reasons])])).toEqual(
        [2026, 2027].map((year) => [
          year,
          null,
          'NOT_CALCULABLE',
          [
            [null, 'NOT_CALCULABLE', [reason]],
            [null, 'NOT_CALCULABLE', [reason]],
          ],
        ]),
      );
    }
  });

  it('a later purchase of the pool undated: POOL_PURCHASE_NOT_COMPUTABLE from the first year (no nominal months from the contract date); the seller’s DISPOSAL_DATE_MISSING names it', () => {
    const input = (reg: RuleRegistry) =>
      derive(
        {
          asset: asset(),
          acquisitions: [
            acquisition(),
            acquisition({
              id: X,
              sellerPartyIds: [B],
              acquiredShare: { numerator: 1, denominator: 2 },
              contractDate: day('2028-06-01'),
              economicTransferDate: null,
            }),
          ],
          ownerships: [
            ownership(A, '1/2', '2026-07-01', '2028-05-31', W),
            ownership(B, '1/2', '2026-07-01', '2028-05-31', W),
            ownership(A, '1/1', '2028-06-01', null, X),
          ],
          capitalizedItems: [
            capitalized(EXTENSION, '2027-04-04', '12000.00', [
              [A, '1/2'],
              [B, '1/2'],
            ]),
          ],
          today: day('2026-10-30'),
          from: 2027,
          to: 2029,
          ownerPartyId: null,
        },
        reg,
      );
    const s = input(registry);
    const [w, x] = s.components as [ScheduleComponent, ScheduleComponent];
    expect([x.acquisitionId, x.status, x.reasons, x.start]).toEqual([
      X,
      'NOT_COMPUTABLE',
      [{ code: 'TRANSFER_DATE_MISSING', details: { contractDate: '2028-06-01' } }],
      null,
    ]);
    // §28.1A: A's half bought in X is still read at its Ownership change: no BUYER_ALREADY_OWNER, no OWNER_WITHOUT_ACQUISITION.
    expect(x.owners.map((o) => [o.ownerPartyId, o.shareBefore, o.acquiredShare, o.tenure.from])).toEqual([[A, '1/2', '1/2', null]]);
    expect(s.years.flatMap((y) => codes(y.flags))).not.toContain('OWNER_WITHOUT_ACQUISITION');
    // The seller B's year of the sale: DISPOSAL_DATE_MISSING naming the undated buyer X; A's W part goes on.
    const w2028 = w.years.find((y) => y.year === 2028) as ComponentYear;
    expect(owner(w2028, B)?.reasons).toEqual([{ code: 'DISPOSAL_DATE_MISSING', details: { validUntil: '2028-05-31', buyerAcquisitionId: X } }]);
    expect(amount(owner(w2028, A)?.amount)).toBe('2544.00');
    // A's item part: the pool's purchase X has no start, so no nominal last month; not computed in any year.
    const c = item(s);
    const pool = {
      code: 'POOL_PURCHASE_NOT_COMPUTABLE',
      details: { poolComponentId: `ACQUISITION:${X}`, nominalLastMonth: null, reasons: ['TRANSFER_DATE_MISSING', 'NOT_COMPUTABLE'] },
    };
    expect([2027, 2028, 2029].map((y) => owner(yearOf(c, y), A))).toEqual(
      [2027, 2028, 2029].map(() => expect.objectContaining({ amount: null, calculationStatus: 'NOT_CALCULABLE', reasons: [pool] })),
    );
    // B's part (B's own tenure, W only) is computed until the sale, then DISPOSAL_DATE_MISSING.
    expect(amount(owner(yearOf(c, 2027), B)?.amount)).toBe('120.00');
    expect(owner(yearOf(c, 2028), B)?.reasons).toEqual([{ code: 'DISPOSAL_DATE_MISSING', details: { validUntil: '2028-05-31', buyerAcquisitionId: X } }]);
    // PER_ITEM_SERIES (a test registry): A's part computed on its own series and flagged from its first year.
    const series = item(input(perItem));
    expect(owner(yearOf(series, 2027), A)).toMatchObject({ amount: eur('120.00'), flags: [{ code: 'SUBSEQUENT_COST_END_TO_VERIFY' }] });
  });
});

describe('per owner (§59B "Per owner"; §58C’s parts)', () => {
  it('the running minimum against the share on the item’s date; a share raised later takes nothing more', () => {
    // A buys B's 2/5 on 2029-07-01 (§28.1A, the increase): A's part of the 2028 item stays 3/5 of it.
    const x = acquisition({
      id: X,
      contractDate: day('2029-05-01'),
      economicTransferDate: day('2029-07-01'),
      sellerPartyIds: [B],
      acquiredShare: { numerator: 2, denominator: 5 },
    });
    const s = derive(
      acc8({
        from: 2028,
        to: 2030,
        acquisitions: [acquisition(), x],
        ownerships: [
          ownership(A, '3/5', '2026-07-01', '2029-06-30', W),
          ownership(A, '1/1', '2029-07-01', null, X),
          ownership(B, '2/5', '2026-07-01', '2029-06-30', W),
        ],
        capitalizedItems: [capitalized(EXTENSION, '2028-05-05', '10000.00')],
      }),
    );
    expect([2028, 2029, 2030].map((y) => amount(owner(yearOf(item(s), y), A)?.amount))).toEqual(['120.00', '120.00', '120.00']);
  });

  it('a share reduced within the tenure lowers the part (OWNER_SHARE_CHANGED), never rising again', () => {
    const x = acquisition({
      id: X,
      contractDate: day('2029-05-01'),
      economicTransferDate: day('2029-07-01'),
      sellerPartyIds: [A],
      acquiredShare: { numerator: 3, denominator: 10 },
    });
    const s = derive(
      acc8({
        from: 2029,
        to: 2031,
        acquisitions: [acquisition(), x],
        ownerships: [
          ownership(A, '3/5', '2026-07-01', '2029-06-30', W),
          ownership(A, '3/10', '2029-07-01', null, W),
          ownership(B, '2/5', '2026-07-01', null, W),
          ownership(C, '3/10', '2029-07-01', null, X),
        ],
        capitalizedItems: [capitalized(EXTENSION, '2028-05-05', '10000.00')],
      }),
    );
    const c = item(s);
    expect([2029, 2030, 2031].map((y) => amount(owner(yearOf(c, y), A)?.amount))).toEqual(['90.00', '60.00', '60.00']);
    // The disposal year confirmed (Prüfbericht 01.11.2026, Frage 4): DISPOSAL_YEAR_TO_VERIFY no longer appears.
    expect(codes(owner(yearOf(c, 2029), A)?.flags ?? [])).toEqual(['OWNER_SHARE_CHANGED']);
  });

  it('owners + NOT_OWNED = the component = the property, and every part at most its basis (random shares, items, refunds, sales)', () => {
    const next = random(7);
    for (let run = 0; run < 10; run++) {
      const a = 1 + next(9);
      const shares: [string, string][] = [
        [A, `${a}/10`],
        [B, `${(10 - a) * (next(2) === 0 ? 1 : 0)}/10`],
      ];
      const list = Array.from({ length: 1 + next(3) }, (_, i) =>
        capitalized(
          `0000eeee-0000-4000-8000-0000000002${String(run).padStart(2, '0')}${i}`,
          `20${27 + next(20)}-0${1 + next(9)}-1${next(10)}`,
          `${next(4) === 0 ? '-' : ''}${1 + next(50000)}.${String(next(100)).padStart(2, '0')}`,
          shares.filter(([, s]) => !s.startsWith('0/')),
        ),
      );
      const s = derive({
        asset: asset(),
        acquisitions: [acquisition({ acquiredShare: { numerator: 1, denominator: 1 } })],
        ownerships: [ownership(A, '1/1', '2026-07-01', null, W)],
        capitalizedItems: list,
        today: day('2026-10-30'),
        from: 2026,
        to: 2100,
        ownerPartyId: null,
      });
      for (const c of items(s)) {
        for (const y of c.years) {
          if (y.amount === null) continue;
          expect(cents(y.amount)).toBe(y.owners.reduce((sum, o) => sum + cents(o.amount), 0n) + cents(y.notOwned));
        }
        const basis = cents(c.basis.amount);
        const total = c.years.reduce((sum, y) => sum + cents(y.amount), 0n);
        expect(total < 0n ? -total : total).toBeLessThanOrEqual(basis < 0n ? -basis : basis);
      }
      for (const y of s.years) {
        const listed = s.components.flatMap((c) => c.years.filter((cy) => cy.year === y.year));
        expect(cents(y.amount)).toBe(listed.reduce((sum, cy) => sum + cents(cy.amount), 0n));
      }
    }
  });

  it('at the owner level: the item components with that owner only, no NOT_OWNED', () => {
    const s = derive(acc8({ from: 2027, to: 2027, ownerPartyId: B, capitalizedItems: [repair()] }));
    expect(item(s).owners.map((o) => o.ownerPartyId)).toEqual([B]);
    // B's purchase part 2,035.20 + B's repair part 285.60.
    expect(amount(s.years[0]?.amount)).toBe('2320.80');
    expect([item(s).notOwned, s.years[0]?.notOwned, s.years[0]?.owners]).toEqual([null, null, null]);
  });
});

describe('reasons and carried flags (§59B "Reasons and flags")', () => {
  it('ITEM_CLASSIFICATION_NEEDS_REVIEW: listed with its basis, amounts null, the year PARTIAL (never a figure without it)', () => {
    const s = derive(acc8({ from: 2027, to: 2027, capitalizedItems: [repair({ reviewState: 'NEEDS_REVIEW' })] }));
    const c = item(s);
    expect(c.status).toBe('NOT_COMPUTABLE');
    expect(codes(c.reasons)).toEqual(['ITEM_CLASSIFICATION_NEEDS_REVIEW']);
    expect(c.basis.amount).toEqual(eur('35700.00'));
    expect([yearOf(c, 2027).amount, yearOf(c, 2027).calculationStatus]).toEqual([null, 'NOT_CALCULABLE']);
    expect([s.years[0]?.status, s.years[0]?.amount]).toEqual(['PARTIAL', null]);
  });

  it('the states that feed a figure are the rule’s parameter (a test registry accepting NEEDS_REVIEW computes it)', () => {
    const accepting = withParameters((p) => ({ ...p, basis: { ...p.basis, capitalizedItemReviewStates: ['NEEDS_REVIEW'] } }));
    expect(item(derive(acc8({ from: 2027, to: 2027, capitalizedItems: [repair({ reviewState: 'NEEDS_REVIEW' })] }), accepting)).status).toBe('COMPUTABLE');
    expect(item(derive(acc8({ from: 2027, to: 2027, capitalizedItems: [repair()] }), accepting)).status).toBe('NOT_COMPUTABLE');
  });

  it('CAPITALIZED_YEAR_DIFFERS for a taxYear override; DATE_IS_BOOKING_DATE, WITHDRAWAL_DATE_ASSUMED and ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE carried', () => {
    const flags = [
      { code: 'WITHDRAWAL_DATE_ASSUMED', details: { date: '2028-02-15' } },
      { code: 'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE', details: { acquisitionId: W } },
      { code: 'RULE_SUPERSEDED', details: {} },
    ];
    const c = item(derive(acc8({ from: 2028, to: 2028, capitalizedItems: [use({ taxYear: 2027, flags })] })));
    expect(codes(c.flags)).toEqual([
      'ANSCHAFFUNGSNAHE_CAPITALIZED',
      'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE',
      'CAPITALIZED_YEAR_DIFFERS',
      'SUBSEQUENT_COST_START_TO_VERIFY',
      'WITHDRAWAL_DATE_ASSUMED',
    ]);
    expect(c.flags.find((f) => f.code === 'CAPITALIZED_YEAR_DIFFERS')?.details).toEqual({ date: '2028-02-15', taxYear: 2027 });
  });

  it('REFUND_EXCEEDS_CAPITALIZED for a refund after a sale (B capitalised nothing on the refund’s date)', () => {
    const c = acquisition({
      id: X,
      contractDate: day('2030-05-01'),
      economicTransferDate: day('2030-07-01'),
      sellerPartyIds: [B],
      acquiredShare: { numerator: 2, denominator: 5 },
    });
    const s = derive(
      acc8({
        from: 2031,
        to: 2031,
        acquisitions: [acquisition(), c],
        ownerships: [
          ownership(A, '3/5', '2026-07-01', null, W),
          ownership(B, '2/5', '2026-07-01', '2030-06-30', W),
          ownership(C, '2/5', '2030-07-01', null, X),
        ],
        capitalizedItems: [
          capitalized(EXTENSION, '2028-05-05', '1000.00'),
          capitalized(REFUND, '2031-02-02', '-2000.00', [
            [A, '3/5'],
            [C, '2/5'],
          ]),
        ],
      }),
    );
    const refund = items(s)[1] as ItemComponent;
    expect(refund.flags.filter((f) => f.code === 'REFUND_EXCEEDS_CAPITALIZED')).toEqual([
      {
        code: 'REFUND_EXCEEDS_CAPITALIZED',
        details: { ownerPartyId: A, basisSum: { amount: '-600.00', currency: 'EUR' }, refundComponentId: `TRANSACTION_SPLIT:${REFUND}` },
      },
      {
        code: 'REFUND_EXCEEDS_CAPITALIZED',
        details: { ownerPartyId: C, basisSum: { amount: '-800.00', currency: 'EUR' }, refundComponentId: `TRANSACTION_SPLIT:${REFUND}` },
      },
    ]);
    expect(refund.years.every((y) => y.amount !== null)).toBe(true);
  });

  it('REFUND_EXCEEDS_CAPITALIZED at the boundary: a sum of −0.01 is flagged, a sum of exactly 0.00 is not (review on #187)', () => {
    const refundFlags = (refund: string) => {
      const s = derive(
        acc8({
          from: 2031,
          to: 2031,
          ownerships: [ownership(A, '1/1', '2026-07-01', null, W)],
          capitalizedItems: [capitalized(EXTENSION, '2028-05-05', '1000.00', [[A, '1/1']]), capitalized(REFUND, '2031-02-02', refund, [[A, '1/1']])],
        }),
      );
      return (items(s)[1] as ItemComponent).flags.filter((f) => f.code === 'REFUND_EXCEEDS_CAPITALIZED');
    };
    expect(refundFlags('-1000.01')).toEqual([
      {
        code: 'REFUND_EXCEEDS_CAPITALIZED',
        details: { ownerPartyId: A, basisSum: { amount: '-0.01', currency: 'EUR' }, refundComponentId: `TRANSACTION_SPLIT:${REFUND}` },
      },
    ]);
    expect(refundFlags('-1000.00')).toEqual([]);
  });

  it('CAPITALIZED_ITEM_NOT_OWNED only for a NOT_OWNED basis other than 0.00: 0.01 at 3/5 leaves it 0.00, 0.02 gives it 0.01 (review on #187)', () => {
    const notOwned = (amount: string) => {
      const s = derive(
        acc8({
          from: 2028,
          to: 2028,
          acquisitions: [acquisition({ acquiredShare: { numerator: 3, denominator: 5 } })],
          ownerships: [ownership(A, '3/5', '2026-07-01', null, W)],
          capitalizedItems: [capitalized(EXTENSION, '2028-05-05', amount, [[A, '3/5']])],
        }),
      );
      return [item(s).notOwned, item(s).flags.filter((f) => f.code === 'CAPITALIZED_ITEM_NOT_OWNED')];
    };
    expect(notOwned('0.01')).toEqual([{ share: '2/5', basis: eur('0.00') }, []]);
    expect(notOwned('0.02')).toEqual([
      { share: '2/5', basis: eur('0.01') },
      [{ code: 'CAPITALIZED_ITEM_NOT_OWNED', details: { notOwnedBasis: { amount: '0.01', currency: 'EUR' }, date: '2028-05-05' } }],
    ]);
  });

  it('the asset’s reasons stop the items too', () => {
    const s = derive(acc8({ asset: asset({ reviewState: 'UNREVIEWED' }), from: 2027, to: 2027, capitalizedItems: [repair()] }));
    expect(item(s).status).toBe('NOT_COMPUTABLE');
    expect(yearOf(item(s), 2027).amount).toBeNull();
  });
});
