import { describe, expect, it } from 'vitest';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { centsOf, moneyOfCents, type BusinessDate } from '../../shared/index.js';
import { distribute, setOn, withValidUntil, type LoanAllocationSet } from '../financing/index.js';
import { attributeTaxYear, interestTiming } from './cash-timing.js';
import { capitalizedSourcesOf } from './capitalized-items.js';
import type { TaxMeaning } from './classification.js';
import { partChanges, partOn } from './attribution-parts.js';
import { distributeOverPeriod, interestPeriodOf, type InterestPeriod } from './loan-interest-periods.js';
import { DE_CONSTRUCTION_PERIOD_INTEREST_V1 } from './rules/de-construction-period-interest.js';
import { flagIsOpen, loanInterestOf, type LoanInterestSplit } from './tax-year-view.js';
import {
  A,
  B,
  C,
  L,
  OWNERS,
  P1,
  P2,
  TAX_RULES,
  day,
  eur,
  flagOf,
  id,
  interestLine,
  monthly,
  parts,
  readOf,
  recorded,
  scheduled,
  set,
  split,
  viewOf,
  views,
} from './tax-year-loan-periods.test-support.js';

/**
 * VC-X-40 (api-design.md §58L; Entscheidung des Projektinhabers, 2026-11-04, L1–L12; Prüfbericht 2026-11-01, Frage 22,
 * mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01): each interest split distributed over
 * its interest period by the sets valid on each day, one `distribute` per split, the payment deciding the year.
 * Examples 1–3 of §58L at both levels with every figure, the rule-7 property, the unchanged money sums, the year, the
 * flags, §58G's part change and §59E's `SEVERAL_ALLOCATION_SETS`. Synthetic figures and ids only.
 */

const S1 = set('2027-01-01', [[P1, '1/1']]);
const S2 = set('2027-03-16', [
  [P1, '1/2'],
  [P2, '1/2'],
]);
/** Example 1's Loan L: debtFrom 2027-01-01, monthly from 2027-01-31 (due on the last day). */
const ex1 = (bookingDate: string) => scheduled(bookingDate, '2027-01-01', '2027-01-31');
/** A split's booking date. */
const bd = (d: LoanInterestSplit): BusinessDate => (d.item as TaxMeaning).bookingDate;
const ownerParts = (v: ReturnType<typeof viewOf>) => (interestLine(v)?.items ?? []).map((i) => i.lineAmount?.amount ?? null);

describe('§58L rule 1: the interest period', () => {
  it('the schedule entry nearest the booking date, from the day after the previous one; clipped at debtFrom; the recorded one wins; none without a schedule', () => {
    expect(ex1('2027-03-31')).toEqual({ from: '2027-03-01', until: '2027-03-31', source: 'LOAN_SCHEDULE' });
    expect(ex1('2027-04-30')).toEqual({ from: '2027-04-01', until: '2027-04-30', source: 'LOAN_SCHEDULE' });
    // Example 3: one month before the first entry, clipped at debtFrom 2027-03-16.
    expect(scheduled('2027-03-31', '2027-03-16', '2027-03-31')).toEqual({ from: '2027-03-16', until: '2027-03-31', source: 'LOAN_SCHEDULE' });
    expect(
      interestPeriodOf(day('2027-12-30'), recorded('2027-01-01', '2027-12-31'), { debtFrom: day('2026-01-01'), paymentDates: monthly('2026-01-31', 36) }),
    ).toEqual(recorded('2027-01-01', '2027-12-31'));
    expect(interestPeriodOf(day('2027-03-31'), null, { debtFrom: day('2027-01-01'), paymentDates: [] })).toBeNull();
    expect(interestPeriodOf(day('2027-03-31'), null, undefined)).toBeNull();
  });

  it('edge: a payment date on debtFrom gives a one-day period, never an empty one', () => {
    expect(scheduled('2027-03-16', '2027-03-16', '2027-03-16')).toEqual({ from: '2027-03-16', until: '2027-03-16', source: 'LOAN_SCHEDULE' });
  });
});

describe('Example 1: a set change within an interest period', () => {
  const d1 = split('310.00', '2027-03-31', ex1('2027-03-31'));
  const d2 = split('300.00', '2027-04-30', ex1('2027-04-30'));
  const sets = views([S1, S2]);

  it('the weights 23/31 and 8/31: P1 230.00, P2 80.00; April in S2 alone 150.00 each (unchanged)', () => {
    const v1 = viewOf(readOf(P1, [d1, d2], sets));
    const v2 = viewOf(readOf(P2, [d1, d2], sets));
    expect(parts(v1)).toEqual([
      [d1.item.sourceId, '230.00'],
      [d2.item.sourceId, '150.00'],
    ]);
    expect(parts(v2)).toEqual([
      [d1.item.sourceId, '80.00'],
      [d2.item.sourceId, '150.00'],
    ]);
    const march = interestLine(v1)?.items[0]?.loanAllocation;
    expect(march).toMatchObject({ share: '23/31', allocationSetId: null, validFrom: null, basis: null, propertyPart: eur('230.00') });
    expect(march?.interestPeriod).toEqual({ from: '2027-03-01', until: '2027-03-31', source: 'LOAN_SCHEDULE' });
    expect(march?.segments).toEqual([
      { from: '2027-03-01', until: '2027-03-15', allocationSetId: S1.id, basis: 'MANUAL', share: '1/1' },
      { from: '2027-03-16', until: '2027-03-31', allocationSetId: S2.id, basis: 'MANUAL', share: '1/2' },
    ]);
    expect(interestLine(v2)?.items[0]?.loanAllocation).toMatchObject({ share: '8/31', allocationSetId: null });
    expect(interestLine(v2)?.items[0]?.loanAllocation?.segments.map((s) => s.share)).toEqual([null, '1/2']);
    // A period in one set names it (rule 7).
    expect(interestLine(v1)?.items[1]?.loanAllocation).toMatchObject({ share: '1/2', allocationSetId: S2.id, validFrom: '2027-03-16', validUntil: null });
  });

  it('the owners on the booking date: A 115.00 and B 115.00, then 75.00 each; C takes P2', () => {
    expect(ownerParts(viewOf(readOf(P1, [d1, d2], sets), 2027, A))).toEqual(['115.00', '75.00']);
    expect(ownerParts(viewOf(readOf(P1, [d1, d2], sets), 2027, B))).toEqual(['115.00', '75.00']);
    expect(ownerParts(viewOf(readOf(P2, [d1, d2], sets), 2027, C))).toEqual(['80.00', '150.00']);
  });

  it('2027 across both views: P1 380.00 + P2 230.00 = 610.00 as by the booking date (305.00 + 305.00); each split sums to its amount', () => {
    const total = (pr: string, s: readonly LoanInterestSplit[]) => interestLine(viewOf(readOf(pr, s, sets)))?.total.amount;
    expect([total(P1, [d1, d2]), total(P2, [d1, d2])]).toEqual(['380.00', '230.00']);
    // The booking-date rule (a one-day period, rule 7) on the same debits.
    const today = [d1, d2].map((d) => ({ ...d, period: { from: bd(d), until: bd(d), source: 'LOAN_SCHEDULE' as const } }));
    expect([total(P1, today), total(P2, today)]).toEqual(['305.00', '305.00']);
    for (const d of [d1, d2]) {
      const sum = [P1, P2].reduce((s, pr) => s + (loanInterestOf(pr, [d], sets).map((c) => (c.kind === 'ATTRIBUTED' ? c.propertyCents : 0n))[0] ?? 0n), 0n);
      expect(sum).toBe(centsOf(d.item.amount));
    }
  });

  it('the cent case (100.00): one distribute, P1 74.19, P2 25.81; the owners A 37.10, B 37.09 by the lower ownerPartyId; never two roundings (74.20)', () => {
    const d = split('100.00', '2027-03-31', ex1('2027-03-31'));
    expect(parts(viewOf(readOf(P1, [d], sets)))).toEqual([[d.item.sourceId, '74.19']]);
    expect(parts(viewOf(readOf(P2, [d], sets)))).toEqual([[d.item.sourceId, '25.81']]);
    expect(ownerParts(viewOf(readOf(P1, [d], sets), 2027, A))).toEqual(['37.10']);
    expect(ownerParts(viewOf(readOf(P1, [d], sets), 2027, B))).toEqual(['37.09']);
    // The alternative not taken (L7): the segments by days (48.39, 51.61), then each by its set: P1 74.20.
    const [s1, s2] = distribute(10_000n, [
      { propertyReferenceId: 'S1', share: { numerator: 15n, denominator: 31n } },
      { propertyReferenceId: 'S2', share: { numerator: 16n, denominator: 31n } },
    ]) as [bigint, bigint];
    const twoSteps = s1 + (distribute(s2, S2.allocations)[0] as bigint);
    expect(twoSteps).toBe(7_420n);
    expect(twoSteps).not.toBe(7_419n);
  });
});

describe('Example 2: annual interest paid in December across a change of use', () => {
  const T1 = set('2026-01-01', [[P1, '1/1']]);
  const T2 = set('2027-10-01', [[P2, '1/1']]);
  const sets = views([T1, T2]);
  const schedule = { debtFrom: day('2026-01-01'), paymentDates: monthly('2026-01-31', 48) };

  it('by the schedule alone still December: P2 3,650.00 (the monthly schedule cannot say annual; VC-X-53)', () => {
    const d = split('3650.00', '2027-12-30', interestPeriodOf(day('2027-12-30'), null, schedule));
    expect(d.period).toEqual({ from: '2027-12-01', until: '2027-12-31', source: 'LOAN_SCHEDULE' });
    expect(parts(viewOf(readOf(P2, [d], sets)))).toEqual([[d.item.sourceId, '3650.00']]);
    expect(parts(viewOf(readOf(P1, [d], sets)))).toEqual([]);
  });

  it('with the recorded year (L4): T1 273 days, T2 92 days: P1 2,730.00 (A 1,365.00, B 1,365.00), P2 920.00 (C); sum 3,650.00', () => {
    const d = split('3650.00', '2027-12-30', interestPeriodOf(day('2027-12-30'), { from: day('2027-01-01'), until: day('2027-12-31') }, schedule));
    expect(parts(viewOf(readOf(P1, [d], sets)))).toEqual([[d.item.sourceId, '2730.00']]);
    expect(parts(viewOf(readOf(P2, [d], sets)))).toEqual([[d.item.sourceId, '920.00']]);
    expect(ownerParts(viewOf(readOf(P1, [d], sets), 2027, A))).toEqual(['1365.00']);
    expect(ownerParts(viewOf(readOf(P1, [d], sets), 2027, B))).toEqual(['1365.00']);
    expect(ownerParts(viewOf(readOf(P2, [d], sets), 2027, C))).toEqual(['920.00']);
    expect(interestLine(viewOf(readOf(P1, [d], sets)))?.items[0]?.loanAllocation).toMatchObject({
      share: '273/365',
      interestPeriod: { from: '2027-01-01', until: '2027-12-31', source: 'CLASSIFICATION' },
    });
  });

  it('variant paid 2028-01-05: the 10-day rule reads the schedule (due 2027-12-31), never the recorded period; 2027 with ATTRIBUTED_BY_10_DAY_RULE and the same parts', () => {
    const facts = { bookingDate: day('2028-01-05'), financialCategoryCode: 'LOAN_INTEREST' };
    const year = attributeTaxYear(facts, interestTiming(facts.bookingDate, schedule.paymentDates), null, TAX_RULES);
    expect(year.taxYear).toBe(2027);
    expect(year.flags.map((f) => f.code)).toEqual(['ATTRIBUTED_BY_10_DAY_RULE']);
    const d = split('3650.00', '2028-01-05', recorded('2027-01-01', '2027-12-31'), { taxYear: year.taxYear });
    expect(parts(viewOf(readOf(P1, [d], sets)))).toEqual([[d.item.sourceId, '2730.00']]);
    expect(parts(viewOf(readOf(P2, [d], sets)))).toEqual([[d.item.sourceId, '920.00']]);
    // No set of 2028-01-05 is read for it: a set from 2028-01-01 changes nothing.
    const later = views([T1, T2, set('2028-01-01', [[P1, '1/1']])]);
    expect(parts(viewOf(readOf(P2, [d], later)))).toEqual([[d.item.sourceId, '920.00']]);
  });
});

describe('Example 3: the first period and a day before the first set', () => {
  it('clipped at debtFrom 2027-03-16, wholly U1: P1 81.00, as by the booking date', () => {
    const d = split('81.00', '2027-03-31', scheduled('2027-03-31', '2027-03-16', '2027-03-31'));
    expect(parts(viewOf(readOf(P1, [d], views([set('2027-03-16', [[P1, '1/1']])]))))).toEqual([[d.item.sourceId, '81.00']]);
  });

  it('variant U1 from 2027-03-20: the whole split not attributed (L3), NO_LOAN_ALLOCATION with the uncovered days; LOAN_INTEREST_NOT_ATTRIBUTED 81.00; nothing estimated', () => {
    const d = split('81.00', '2027-03-31', scheduled('2027-03-31', '2027-03-16', '2027-03-31'));
    const v = viewOf(readOf(P1, [d], views([set('2027-03-20', [[P1, '1/1']])])));
    expect(interestLine(v)?.items ?? []).toEqual([]);
    expect(v.notAttributed.items.map((i) => [i.sourceId, i.lineAmount, i.notAttributed?.reason, i.notAttributed?.uncovered])).toEqual([
      [d.item.sourceId, null, 'NO_LOAN_ALLOCATION', [{ from: '2027-03-16', until: '2027-03-19' }]],
    ]);
    expect(v.notAttributed.items[0]?.notAttributed?.interestPeriod).toEqual({ from: '2027-03-16', until: '2027-03-31', source: 'LOAN_SCHEDULE' });
    expect(flagOf(v, 'LOAN_INTEREST_NOT_ATTRIBUTED')).toEqual({ loanIds: [L], interestTotal: eur('81.00').toJSON(), splitIds: [d.item.sourceId] });
    expect(v.review.final).toBe(false);
  });
});

describe('rule 7, unchanged money sums and the year', () => {
  /** A seeded generator (no Math.random: reproducible). */
  const rng = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const SHARES: readonly (readonly (readonly [string, string])[])[] = [
    [[P1, '1/1']],
    [[P2, '1/1']],
    [
      [P1, '1/2'],
      [P2, '1/2'],
    ],
    [
      [P1, '1/3'],
      [P2, '2/3'],
    ],
    [
      [P1, '3/5'],
      [P2, '2/5'],
    ],
  ];
  const at = (r: () => number, from: number, span: number) => {
    const d = new Date(Date.UTC(2027, 0, 1 + from + Math.floor(r() * span)));
    return d.toISOString().slice(0, 10);
  };

  it('a period inside one set gives exactly distribute over that set (rule 7), 200 seeded cases', () => {
    const r = rng(40);
    for (let k = 0; k < 200; k++) {
      const s = set(at(r, 0, 100), SHARES[Math.floor(r() * SHARES.length)] as never);
      const sets = views([s]);
      const from = at(r, 110, 100);
      const until = at(r, 215, 100);
      const cents = BigInt(1 + Math.floor(r() * 1_000_000));
      const d = distributeOverPeriod([...sets.values()][0] ?? [], cents, recorded(from, until), day(until));
      expect(d.kind).toBe('COVERED');
      const want = distribute(cents, s.allocations);
      const got = s.allocations.map((a) => (d.kind === 'COVERED' ? d.weights.find((w) => w.propertyReferenceId === a.propertyReferenceId)?.cents : -1n));
      expect(got).toEqual(want);
    }
  });

  it('for every split the parts over all views sum to its amount; per Loan attributed + not attributed = its interest; never in or out of the year', () => {
    const r = rng(58);
    for (let k = 0; k < 60; k++) {
      const boundaries = [at(r, 0, 1), at(r, 30, 100), at(r, 140, 150)].sort();
      const sets = views(boundaries.map((b) => set(b, SHARES[Math.floor(r() * SHARES.length)] as never)));
      const splits = Array.from({ length: 6 }, () => {
        const booked = at(r, 0, 360);
        // A first set after debtFrom sometimes: the January splits are then not attributed (L3).
        const debtFrom = r() < 0.3 ? '2026-12-15' : '2027-01-01';
        return split(`${1 + Math.floor(r() * 5000)}.${String(Math.floor(r() * 100)).padStart(2, '0')}`, booked, scheduled(booked, debtFrom, '2027-01-31'));
      });
      let attributed = 0n;
      let notAttributed = 0n;
      for (const d of splits) {
        const cases = [P1, P2].map((pr) => loanInterestOf(pr, [d], sets)[0]);
        const sum = cases.reduce((s, c) => s + (c?.kind === 'ATTRIBUTED' ? c.propertyCents : 0n), 0n);
        if (cases.some((c) => c?.kind === 'NOT_ATTRIBUTED')) {
          expect(sum).toBe(0n);
          notAttributed += centsOf(d.item.amount);
        } else {
          expect(sum).toBe(centsOf(d.item.amount));
          attributed += sum;
        }
      }
      expect(attributed + notAttributed).toBe(splits.reduce((s, d) => s + centsOf(d.item.amount), 0n));
      // The views of 2027 together: P1's and P2's interest lines plus the not attributed total.
      const lines = [P1, P2].reduce((s, pr) => s + centsOf(interestLine(viewOf(readOf(pr, splits, sets)))?.total ?? eur('0.00')), 0n);
      const listed = flagOf(viewOf(readOf(P1, splits, sets)), 'LOAN_INTEREST_NOT_ATTRIBUTED') as { interestTotal: { amount: string } } | undefined;
      expect(lines + (listed === undefined ? 0n : centsOf(eur(listed.interestTotal.amount)))).toBe(attributed + notAttributed);
      for (const d of splits) expect(d.item.taxYear).toBe(2027);
    }
  });

  it('every non-interest line, section and result is the same as by the booking date; only the interest moves between P1 and P2', () => {
    const base = split('120.00', '2027-05-10', null);
    const insurance = {
      ...base.item,
      propertyReferenceId: P1,
      financialCategoryCode: 'INSURANCE',
      categoryType: 'OPERATING_EXPENSE' as const,
      taxCategory: 'INSURANCE' as const,
    };
    const sets = views([S1, S2]);
    const d = split('310.00', '2027-03-31', ex1('2027-03-31'));
    const old = { ...d, period: { from: bd(d), until: bd(d), source: 'LOAN_SCHEDULE' as const } };
    const now = viewOf(readOf(P1, [d], sets, { sources: [{ item: insurance, listed: true }] }));
    const before = viewOf(readOf(P1, [old], sets, { sources: [{ item: insurance, listed: true }] }));
    expect(now.einnahmen).toEqual(before.einnahmen);
    expect(now.werbungskosten.lines.filter((l) => l.taxCategory !== 'LOAN_INTEREST')).toEqual(
      before.werbungskosten.lines.filter((l) => l.taxCategory !== 'LOAN_INTEREST'),
    );
    expect(now.capitalized).toEqual(before.capitalized);
    expect([now.werbungskosten.total.amount, before.werbungskosten.total.amount]).toEqual(['350.00', '275.00']);
    expect([now.result.amount.amount, before.result.amount.amount]).toEqual(['-350.00', '-275.00']);
  });

  it('a period across 31 December is distributed by December sets and stays in its §58A year (rule 10)', () => {
    // Due on the 15th: the payment of 2028-01-15 pays 2027-12-16 – 2028-01-15; a change of use on 2028-01-01.
    const sets = views([set('2027-01-01', [[P1, '1/1']]), set('2028-01-01', [[P2, '1/1']])]);
    const d = split('310.00', '2028-01-15', scheduled('2028-01-15', '2027-01-01', '2027-01-15'));
    expect(d.period).toEqual({ from: '2027-12-16', until: '2028-01-15', source: 'LOAN_SCHEDULE' });
    expect(parts(viewOf(readOf(P1, [d], sets), 2028))).toEqual([[d.item.sourceId, '160.00']]);
    expect(parts(viewOf(readOf(P2, [d], sets), 2028))).toEqual([[d.item.sourceId, '150.00']]);
    expect(interestLine(viewOf(readOf(P1, [d], sets), 2028))?.items[0]?.taxYear).toBe(2028);
  });
});

describe('the flags', () => {
  it('INTEREST_PERIOD_UNKNOWN (rule 8): by the booking date, open with more than one VALID set, informative with one (L8)', () => {
    const d = split('310.00', '2027-03-31', null);
    const two = viewOf(readOf(P1, [d], views([S1, S2])));
    expect(parts(two)).toEqual([[d.item.sourceId, '155.00']]);
    const item = interestLine(two)?.items[0];
    expect(item?.loanAllocation).toMatchObject({ interestPeriod: null, segments: [], allocationSetId: S2.id, share: '1/2' });
    expect(item?.flags).toContainEqual({ code: 'INTEREST_PERIOD_UNKNOWN', details: { loanId: L, reason: 'NO_SCHEDULE', validAllocationSets: 2 } });
    expect(two.review.open).toContainEqual({ code: 'INTEREST_PERIOD_UNKNOWN', count: 1 });
    const one = viewOf(readOf(P1, [d], views([S1])));
    expect(one.review.info).toContainEqual({ code: 'INTEREST_PERIOD_UNKNOWN', count: 1 });
    expect(one.review.open.map((o) => o.code)).not.toContain('INTEREST_PERIOD_UNKNOWN');
    expect(flagIsOpen('INTEREST_PERIOD_UNKNOWN', { treatment: null, origin: 'DEFAULT', reviewState: 'SUGGESTED' }, { validAllocationSets: 1 })).toBe(false);
  });

  it('LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY: one entry per multi-entry PURCHASE_PRICE set among the segments, each cleared by its own confirmation', () => {
    const K1 = set(
      '2027-01-01',
      [
        [P1, '3/5'],
        [P2, '2/5'],
      ],
      { basis: 'PURCHASE_PRICE' },
    );
    const K2 = set(
      '2027-03-16',
      [
        [P1, '1/5'],
        [P2, '4/5'],
      ],
      { basis: 'PURCHASE_PRICE' },
    );
    const d = split('310.00', '2027-03-31', ex1('2027-03-31'));
    const flags = (confirmed: readonly LoanAllocationSet[]) => {
      const confirmations = new Map(
        confirmed.map((s) => [
          s.id as string,
          {
            confirmationId: id(),
            allocationSetId: s.id,
            status: 'ACTIVE' as const,
            confirmedAt: new Date('2028-01-10T00:00:00Z'),
            confirmedBy: 'u',
            advisorPartyId: null,
          },
        ]),
      );
      const v = viewOf(readOf(P1, [d], views([K1, K2]), { taxConfirmations: confirmations as never }));
      return { v, item: interestLine(v)?.items[0] };
    };
    const none = flags([]);
    expect(
      none.item?.flags
        .filter((f) => f.code === 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY')
        .map((f) => (f.details as { allocationSetId: string }).allocationSetId),
    ).toEqual([K1.id, K2.id]);
    expect(none.item?.loanAllocation?.taxConfirmation).toBeNull();
    expect(none.v.review.open).toContainEqual({ code: 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', count: 1 });
    expect(flags([K1]).v.review.open).toContainEqual({ code: 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', count: 1 });
    const both = flags([K1, K2]).v;
    expect(both.review.open.map((o) => o.code)).not.toContain('LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY');
    expect(both.review.info).toContainEqual({ code: 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', count: 1 });
    // P1: 15/31 × 3/5 + 16/31 × 1/5 = 61/155 of 310.00 = 122.00.
    expect(parts(none.v)).toEqual([[d.item.sourceId, '122.00']]);
  });
});

describe('§58G and §59E under the period distribution', () => {
  const rec = (auditRecordId: string, action: string, iso: string) => ({ auditRecordId, action, occurredAt: new Date(iso) });
  const candidate = (d: LoanInterestSplit) => ({ sourceId: d.item.sourceId, bookingDate: bd(d), amount: d.item.amount, period: d.period });

  it('the view and partOn compute the same part (one function), also over a set boundary', () => {
    const d = split('100.00', '2027-03-31', ex1('2027-03-31'));
    for (const pr of [P1, P2]) {
      const c = loanInterestOf(pr, [d], views([S1, S2]))[0];
      expect(partOn(pr, [S1, S2], candidate(d)).part).toEqual(c?.kind === 'ATTRIBUTED' ? moneyOfCents(c.propertyCents, 'EUR') : null);
    }
  });

  it('Example 1 with S2 recorded 2028-02-10: a part change of 2027 in both views, P1 310.00 → 230.00 and P2 NONE → 80.00', () => {
    const d = split('310.00', '2027-03-31', ex1('2027-03-31'));
    const input = {
      loans: [
        {
          loanId: L,
          candidates: [candidate(d)],
          sets: [
            { set: S1, records: [rec('r-s1', 'CREATED', '2027-01-02T10:00:00Z')] },
            { set: S2, records: [rec('r-s2', 'CREATED', '2028-02-10T10:00:00Z')] },
          ],
        },
      ],
    };
    const items = (pr: string) => partChanges(input, 2027, { propertyReferenceId: pr, fingerprinter }).changes.flatMap((c) => c.items);
    expect(items(P1).map((i) => [i.stateBefore, i.partBefore?.amount, i.stateAfter, i.partAfter?.amount])).toEqual([
      ['ATTRIBUTED', '310.00', 'ATTRIBUTED', '230.00'],
    ]);
    expect(items(P2).map((i) => [i.stateBefore, i.partBefore, i.stateAfter, i.partAfter?.amount])).toEqual([['NONE', null, 'ATTRIBUTED', '80.00']]);
  });

  it('a set within the period after the booking date is a part change now (none by the booking date)', () => {
    // Booked 2027-03-28 for a period to 2027-03-31; a set from 2027-03-30 recorded in 2028.
    const d = split('310.00', '2027-03-28', recorded('2027-03-01', '2027-03-31'));
    const late = set('2027-03-30', [[P2, '1/1']]);
    const history = (c: ReturnType<typeof candidate>) => ({
      loans: [
        {
          loanId: L,
          candidates: [c],
          sets: [
            { set: S1, records: [rec('r-s1', 'CREATED', '2027-01-02T10:00:00Z')] },
            { set: late, records: [rec('r-late', 'CREATED', '2028-02-10T10:00:00Z')] },
          ],
        },
      ],
    });
    const changes = (c: ReturnType<typeof candidate>) => partChanges(history(c), 2027, { propertyReferenceId: P1, fingerprinter }).changes;
    expect(changes(candidate(d)).flatMap((c) => c.items.map((i) => i.partAfter?.amount))).toEqual(['290.00']);
    expect(changes({ ...candidate(d), period: { from: bd(d), until: bd(d), source: 'LOAN_SCHEDULE' } })).toEqual([]);
  });

  it('pinned until VC-X-54: other terms after the year end move a part without any flag (only sets, deposits and corrections are part kinds)', () => {
    const sets = views([S1, S2]);
    const before = split('310.00', '2027-03-31', ex1('2027-03-31'));
    // New terms due on the 15th: the payment nearest 2027-03-31 is 2027-04-15, its period 2027-03-16 – 2027-04-15, wholly S2.
    const after = { ...before, period: scheduled('2027-03-31', '2027-01-01', '2027-01-15') };
    expect(parts(viewOf(readOf(P1, [before], sets)))).toEqual([[before.item.sourceId, '230.00']]);
    const v = viewOf(readOf(P1, [after], sets));
    expect(parts(v)).toEqual([[before.item.sourceId, '155.00']]);
    expect(v.flags.map((f) => f.code)).not.toContain('PROPERTY_PART_CHANGED');
    // VC-X-53 (§58O, Entscheidung des Projektinhabers, 2026-11-05, question 10): the interval entered after the year's end
    // moves a part the same way, still without a flag until VC-X-54. Quarterly from 2027-03-31: 2027-01-01 – 2027-03-31.
    const quarterly = {
      ...before,
      period: interestPeriodOf(day('2027-03-31'), null, {
        debtFrom: day('2027-01-01'),
        paymentDates: [day('2027-03-31'), day('2027-06-30')],
        firstIntervalMonths: 3,
      }),
    };
    const q = viewOf(readOf(P1, [quarterly], sets));
    // 74 days S1, 16 days S2: 310.00 × 82/90.
    expect(parts(q)).toEqual([[before.item.sourceId, '282.44']]);
    expect(q.flags.map((f) => f.code)).not.toContain('PROPERTY_PART_CHANGED');
  });

  it('§59E: a capitalised split over two sets enters no basis, SEVERAL_ALLOCATION_SETS (L9); over one set it does', () => {
    const d = split('310.00', '2027-03-31', ex1('2027-03-31'), { treatment: 'CAPITALIZED' });
    const record = {
      id: '0000cccc-0000-4000-8000-000000000001',
      loanId: L,
      propertyReferenceIds: [P1, P2],
      herstellungFrom: day('2027-01-01'),
      herstellungUntil: day('2027-12-31'),
      advanceExpenseDeductible: false,
      buildingFundsShare: { numerator: 1n, denominator: 1n },
      reviewState: 'CONFIRMED' as const,
      status: 'VALID' as const,
      deductibleSplitIds: [],
      capitalizedSplitIds: [],
    };
    const facts = {
      splitId: d.item.sourceId,
      loanId: L,
      bookingDate: bd(d),
      amountCents: 31_000n,
      transactionInterestCents: 31_000n,
      constructionPeriodInterestId: record.id,
      record,
      policy: DE_CONSTRUCTION_PERIOD_INTEREST_V1.parameters,
    };
    const sourcesOf = (s: LoanInterestSplit, sets: ReturnType<typeof views>) =>
      capitalizedSourcesOf(
        loanInterestOf(P1, [s], sets).flatMap((c) =>
          c.kind !== 'ATTRIBUTED'
            ? []
            : [
                {
                  meaning: s.item as never,
                  anschaffungsnaheAcquisitionId: null,
                  loan: { loanId: L, set: c.sets.length === 1 ? (c.sets[0] ?? null) : null, propertyCents: c.propertyCents },
                  interest: facts as never,
                },
              ],
        ),
        OWNERS[P1] ?? [],
        P1,
      );
    const two = sourcesOf(d, views([S1, S2]));
    expect(two.items).toEqual([]);
    expect(two.notSources).toEqual([{ sourceId: d.item.sourceId, loanId: L, reason: 'SEVERAL_ALLOCATION_SETS' }]);
    const one = sourcesOf(split('300.00', '2027-04-30', ex1('2027-04-30'), { treatment: 'CAPITALIZED' }), views([S1, S2]));
    expect(one.items.map((i) => [i.lineAmount.amount, i.loan?.allocationSetId, i.loan?.share])).toEqual([['150.00', S2.id, '1/2']]);
    // The view's flag names the reason.
    const flag = interestLine(viewOf(readOf(P1, [d], views([S1, S2]), { interest: new Map([[d.item.sourceId, facts as never]]) })));
    const capitalized = viewOf(readOf(P1, [d], views([S1, S2]), { interest: new Map([[d.item.sourceId, facts as never]]) })).capitalized.items[0];
    expect(flag?.items ?? []).toEqual([]);
    expect(capitalized?.flags.find((f) => f.code === 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS')?.details).toEqual({
      loanId: L,
      allocationSetId: null,
      reason: 'SEVERAL_ALLOCATION_SETS',
    });
  });

  it('setOn and the period agree on a VOID set: it covers no day', () => {
    const voided = set('2027-03-16', [[P2, '1/1']], { status: 'VOID' });
    const all = withValidUntil([S1, voided]);
    expect(setOn(all, day('2027-03-20'))?.id).toBe(S1.id);
    const d = distributeOverPeriod(all, 31_000n, ex1('2027-03-31') as InterestPeriod, day('2027-03-31'));
    expect(d.kind === 'COVERED' ? d.weights.map((w) => [w.propertyReferenceId, w.cents]) : []).toEqual([[P1, 31_000n]]);
  });
});
