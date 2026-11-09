import { describe, expect, it } from 'vitest';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { centsOf, moneyOfCents } from '../../shared/index.js';
import { withValidUntil, type LoanAllocationSet } from '../financing/index.js';
import { capitalizedSourcesOf } from './capitalized-items.js';
import type { TaxMeaning } from './classification.js';
import { partChanges, partOn } from './attribution-parts.js';
import { distributeOverPeriod, type InterestPeriod } from './loan-interest-periods.js';
import { DE_CONSTRUCTION_PERIOD_INTEREST_V1 } from './rules/de-construction-period-interest.js';
import { LOAN_INTEREST_OUTSIDE_LETTING, flagIsOpen, loanInterestOf, reviewOf, type LoanInterestSplit } from './tax-year-view.js';
import {
  A,
  B,
  C,
  L,
  OWNERS,
  P1,
  P2,
  day,
  eur,
  flagOf,
  interestLine,
  readOf,
  scheduled,
  set,
  split,
  viewOf,
  views,
} from './tax-year-loan-periods.test-support.js';

/**
 * VC-X-43 (api-design.md §58V; Entscheidung des Projektinhabers, 2026-11-07, questions 1, 6, 7): the part outside
 * letting in the tax-year view. Its interest enters no figure (no line, no owner part, no AfA source); it is listed on
 * the item (`loanAllocation.outsideLetting`) and in the informative year flag `LOAN_INTEREST_OUTSIDE_LETTING`. The
 * section's synthetic example (P1 1/2, P2 3/10, outside letting 1/5 from 2027-01-01; P1 5/8, P2 3/8 from 2027-04-16),
 * the tie, a split all outside letting, the usable set, §58G and §59E. Synthetic figures and ids only.
 */

const EVIDENCE = ['Auszahlungsbeleg der Bank vom 2027-01-04 (synthetisch)', 'Kaufvertrag Pkw vom 2027-01-05 (synthetisch)'];
const outside = (s: LoanAllocationSet, share: string): LoanAllocationSet => {
  const [n, d] = share.split('/') as [string, string];
  return { ...s, outsideLetting: { share: { numerator: BigInt(n), denominator: BigInt(d) } }, useEvidence: EVIDENCE };
};
const S1 = outside(
  set('2027-01-01', [
    [P1, '1/2'],
    [P2, '3/10'],
  ]),
  '1/5',
);
const S2 = set('2027-04-16', [
  [P1, '5/8'],
  [P2, '3/8'],
]);
const period = (bookingDate: string) => scheduled(bookingDate, '2027-01-01', '2027-01-31');
const march = split('450.01', '2027-03-31', period('2027-03-31'));
const april = split('600.00', '2027-04-30', period('2027-04-30'));
const sets = views([S1, S2]);
const amounts = (v: ReturnType<typeof viewOf>) => (interestLine(v)?.items ?? []).map((i) => i.lineAmount?.amount ?? null);
const outsideOf = (v: ReturnType<typeof viewOf>) => (interestLine(v)?.items ?? []).map((i) => i.loanAllocation?.outsideLetting ?? null);

describe('§58V rule 5: the weights per day, one distribute with the part outside letting', () => {
  it('March wholly in S1: P1 225.01, P2 135.00, outside letting 90.00 (w_O 1/5); the parts sum to the split', () => {
    const d = distributeOverPeriod(sets.get(L) ?? [], 45_001n, march.period, day('2027-03-31'));
    expect(d.kind === 'COVERED' ? [d.weights.map((w) => [w.propertyReferenceId, w.cents]), d.outsideLetting] : d.kind).toEqual([
      [
        [P1, 22_501n],
        [P2, 13_500n],
      ],
      { share: { numerator: 1n, denominator: 5n }, cents: 9_000n },
    ]);
  });

  it('April over S1 and S2 (15 days each): w_P1 9/16, w_P2 27/80, w_O 1/10: P1 337.50, P2 202.50, outside 60.00', () => {
    const d = distributeOverPeriod(sets.get(L) ?? [], 60_000n, april.period, day('2027-04-30'));
    if (d.kind !== 'COVERED') throw new Error(d.kind);
    expect(d.weights.map((w) => [w.share, w.cents])).toEqual([
      [{ numerator: 9n, denominator: 16n }, 33_750n],
      [{ numerator: 27n, denominator: 80n }, 20_250n],
    ]);
    // Per day, never by the booking date's set (S2, no part outside letting): mutation M4.
    expect(d.outsideLetting).toEqual({ share: { numerator: 1n, denominator: 10n }, cents: 6_000n });
  });

  it('no part in any segment: outsideLetting null and the weights as before; in two segments the days add up', () => {
    const plain = views([set('2027-01-01', [[P1, '1/1']])]);
    const d = distributeOverPeriod(plain.get(L) ?? [], 45_001n, march.period, day('2027-03-31'));
    expect(d.kind === 'COVERED' ? [d.weights.map((w) => w.cents), d.outsideLetting] : d.kind).toEqual([[45_001n], null]);
    const S2b = outside(
      set('2027-04-16', [
        [P1, '1/2'],
        [P2, '1/4'],
      ]),
      '1/4',
    );
    const two = distributeOverPeriod(views([S1, S2b]).get(L) ?? [], 60_000n, april.period, day('2027-04-30'));
    // w_O = 15/30 × 1/5 + 15/30 × 1/4 = 9/40; 60,000 × 9/40 = 13,500 exactly.
    expect(two.kind === 'COVERED' ? two.outsideLetting : two.kind).toEqual({ share: { numerator: 9n, denominator: 40n }, cents: 13_500n });
    // S2 alone carries a part outside letting that, with entries summing to 1/1, is not usable.
    expect(distributeOverPeriod(views([S1, outside(S2, '1/4')]).get(L) ?? [], 60_000n, april.period, day('2027-04-30')).kind).toBe('UNCOVERED');
  });

  it('the tie in the view: 1.01 by P1 1/2 and outside 1/2: P1 0.50, outside 0.51 (no property overstated by the cent)', () => {
    const tie = views([outside(set('2027-01-01', [[P1, '1/2']]), '1/2')]);
    const d = split('1.01', '2027-03-31', period('2027-03-31'));
    const v = viewOf(readOf(P1, [d], tie));
    expect(amounts(v)).toEqual(['0.50']);
    expect(outsideOf(v)).toEqual([{ share: '1/2', part: eur('0.51') }]);
  });
});

describe('§58V rule 6: in the tax-year view, listed and summed into nothing', () => {
  const v1 = viewOf(readOf(P1, [march, april], sets));
  const v2 = viewOf(readOf(P2, [march, april], sets));

  it('P1 225.01 + 337.50 = 562.51, P2 135.00 + 202.50 = 337.50; outside letting 150.00 in neither; the splits sum to 1,050.01', () => {
    expect([amounts(v1), amounts(v2)]).toEqual([
      ['225.01', '337.50'],
      ['135.00', '202.50'],
    ]);
    expect([interestLine(v1)?.total, interestLine(v2)?.total]).toEqual([eur('562.51'), eur('337.50')]);
    expect([v1.werbungskosten.total, v2.werbungskosten.total]).toEqual([eur('562.51'), eur('337.50')]);
    expect([v1.result.amount, v2.result.amount]).toEqual([eur('-562.51'), eur('-337.50')]);
    expect(centsOf(eur('562.51')) + centsOf(eur('337.50')) + centsOf(eur('150.00'))).toBe(105_001n);
  });

  it('on the item: the same outsideLetting in every view; the segments carry each set s part; P s share and part unchanged in shape', () => {
    for (const v of [v1, v2])
      expect(outsideOf(v)).toEqual([
        { share: '1/5', part: eur('90.00') },
        { share: '1/10', part: eur('60.00') },
      ]);
    const item = interestLine(v1)?.items[1]?.loanAllocation;
    expect(item?.segments.map((s) => [s.share, s.outsideLettingShare])).toEqual([
      ['1/2', '1/5'],
      ['5/8', null],
    ]);
    expect([item?.share, item?.propertyPart]).toEqual(['9/16', eur('337.50')]);
  });

  it('LOAN_INTEREST_OUTSIDE_LETTING: informative in both views, interestTotal 150.00 over both splits; the review counts it as info only', () => {
    for (const v of [v1, v2]) {
      expect(flagOf(v, LOAN_INTEREST_OUTSIDE_LETTING)).toEqual({
        loanIds: [L],
        interestTotal: eur('150.00').toJSON(),
        splitIds: [march.item.sourceId, april.item.sourceId].sort(),
      });
      expect(v.review.info).toContainEqual({ code: LOAN_INTEREST_OUTSIDE_LETTING, count: 1 });
      expect(v.review.open.map((o) => o.code)).not.toContain(LOAN_INTEREST_OUTSIDE_LETTING);
    }
    // The flag alone leaves a year final (mutation M7: made open).
    expect(reviewOf([{ code: LOAN_INTEREST_OUTSIDE_LETTING, details: {} }], []).final).toBe(true);
    expect(flagIsOpen(LOAN_INTEREST_OUTSIDE_LETTING, { treatment: null, origin: 'DEFAULT', reviewState: 'SUGGESTED' })).toBe(false);
  });

  it('only the splits with a part: a split under S2 alone is not in the flag; an INFLOW is subtracted; no flag without any part', () => {
    const may = split('500.00', '2027-05-31', period('2027-05-31'));
    const refund = { ...march, item: { ...march.item, sourceId: 'refund', direction: 'INFLOW' } } as unknown as LoanInterestSplit;
    const v = viewOf(readOf(P1, [march, may, refund], sets));
    expect(flagOf(v, LOAN_INTEREST_OUTSIDE_LETTING)).toEqual({
      loanIds: [L],
      interestTotal: eur('0.00').toJSON(),
      splitIds: [march.item.sourceId, 'refund'].sort(),
    });
    expect(flagOf(viewOf(readOf(P1, [may], sets)), LOAN_INTEREST_OUTSIDE_LETTING)).toBeUndefined();
  });

  it('per owner: A and B share P1 s part only (sum 562.51); C takes P2 s; the flag in every owner view', () => {
    const [a, b, c] = [
      viewOf(readOf(P1, [march, april], sets), 2027, A),
      viewOf(readOf(P1, [march, april], sets), 2027, B),
      viewOf(readOf(P2, [march, april], sets), 2027, C),
    ];
    expect(centsOf(a.werbungskosten.total) + centsOf(b.werbungskosten.total)).toBe(56_251n);
    expect(c.werbungskosten.total).toEqual(eur('337.50'));
    expect(v1.owners?.map((o) => o.werbungskosten.total)).toEqual([a.werbungskosten.total, b.werbungskosten.total]);
    expect(v1.notOwned).toBeNull();
    for (const v of [a, b, c]) expect(flagOf(v, LOAN_INTEREST_OUTSIDE_LETTING)).toMatchObject({ interestTotal: eur('150.00').toJSON() });
    expect(OWNERS[P1]?.length).toBe(2);
  });
});

describe('§58V: the three cases and the usable set', () => {
  it('a split all outside letting is ELSEWHERE in every view (no item, no flag, nothing not attributed)', () => {
    const all = { ...set('2027-01-01', []), outsideLetting: { share: { numerator: 1n, denominator: 1n } }, useEvidence: EVIDENCE };
    for (const pr of [P1, P2]) {
      expect(loanInterestOf(pr, [march], views([all])).map((c) => c.kind)).toEqual(['ELSEWHERE']);
      const v = viewOf(readOf(pr, [march], views([all])));
      expect([interestLine(v)?.items ?? [], v.notAttributed.items, flagOf(v, LOAN_INTEREST_OUTSIDE_LETTING)]).toEqual([[], [], undefined]);
    }
  });

  it('a set whose entries alone sum to 1/1 plus a part is not usable: NOT_ATTRIBUTED, ALLOCATION_SUM_NOT_ONE (mutation M5)', () => {
    const over = views([outside(set('2027-01-01', [[P1, '1/1']]), '1/5')]);
    expect(loanInterestOf(P1, [march], over).map((c) => [c.kind, c.kind === 'NOT_ATTRIBUTED' ? c.reason : null])).toEqual([
      ['NOT_ATTRIBUTED', 'ALLOCATION_SUM_NOT_ONE'],
    ]);
    // Entries below one with the part to complete it are usable.
    expect(loanInterestOf(P1, [march], sets).map((c) => c.kind)).toEqual(['ATTRIBUTED']);
  });

  it('candidates of a not attributed split stay the PropertyReferences (the part names none); the item carries no outsideLetting', () => {
    const before = split('451.20', '2027-01-31', { from: day('2026-12-15'), until: day('2027-01-31'), source: 'CLASSIFICATION' });
    const [c] = loanInterestOf(P1, [before], sets);
    expect(
      c?.kind === 'NOT_ATTRIBUTED' ? [c.candidates, c.allocation.outsideLetting, c.allocation.segments.map((s) => s.outsideLettingShare)] : c?.kind,
    ).toEqual([[P1, P2], null, ['1/5']]);
  });
});

describe('§58V: §58G part changes and §59E capitalised interest', () => {
  const rec = (auditRecordId: string, action: string, iso: string) => ({ auditRecordId, action, occurredAt: new Date(iso) });
  const candidate = (d: LoanInterestSplit) => ({
    sourceId: d.item.sourceId,
    bookingDate: (d.item as TaxMeaning).bookingDate,
    amount: d.item.amount,
    period: d.period,
  });

  it('partOn reads the same weights as the view (P s part with the part outside letting)', () => {
    for (const pr of [P1, P2]) {
      const c = loanInterestOf(pr, [april], sets)[0];
      expect(partOn(pr, [S1, S2], candidate(april)).part).toEqual(c?.kind === 'ATTRIBUTED' ? moneyOfCents(c.propertyCents, 'EUR') : null);
    }
  });

  it('a backdated set adding a part outside letting, recorded after the year: PROPERTY_PART_CHANGED with the moved part', () => {
    const plain = set('2027-01-01', [
      [P1, '5/8'],
      [P2, '3/8'],
    ]);
    const withPart = outside(
      set('2027-03-01', [
        [P1, '1/2'],
        [P2, '3/10'],
      ]),
      '1/5',
    );
    const input = {
      loans: [
        {
          loanId: L,
          candidates: [candidate(march)],
          sets: [
            { set: plain, records: [rec('r-1', 'CREATED', '2027-01-02T10:00:00Z')] },
            { set: withPart, records: [rec('r-2', 'CREATED', '2028-02-10T10:00:00Z')] },
          ],
        },
      ],
    };
    const items = (pr: string) => partChanges(input, 2027, { propertyReferenceId: pr, fingerprinter }).changes.flatMap((c) => c.items);
    expect(items(P1).map((i) => [i.partBefore?.amount, i.partAfter?.amount])).toEqual([['281.26', '225.01']]);
    expect(items(P2).map((i) => [i.partBefore?.amount, i.partAfter?.amount])).toEqual([['168.75', '135.00']]);
  });

  it('§59E: a capitalised split with a part outside letting enters P s basis with P s part only', () => {
    const d = split('450.01', '2027-03-31', period('2027-03-31'), { treatment: 'CAPITALIZED' });
    const record = {
      id: '0000cccc-0000-4000-8000-000000000001',
      loanId: L,
      propertyReferenceIds: [P1, P2],
      herstellungFrom: day('2027-01-01'),
      herstellungUntil: day('2027-12-31'),
      advanceExpenseDeductible: false,
      // §59E: P's part is already net of the part outside letting; the building funds are the whole of it here.
      buildingFundsShare: { numerator: 1n, denominator: 1n },
      reviewState: 'CONFIRMED' as const,
      status: 'VALID' as const,
      deductibleSplitIds: [],
      capitalizedSplitIds: [],
    };
    const facts = {
      splitId: d.item.sourceId,
      loanId: L,
      bookingDate: day('2027-03-31'),
      amountCents: 45_001n,
      transactionInterestCents: 45_001n,
      constructionPeriodInterestId: record.id,
      record,
      policy: DE_CONSTRUCTION_PERIOD_INTEREST_V1.parameters,
    };
    const sources = capitalizedSourcesOf(
      loanInterestOf(P1, [d], sets).flatMap((c) =>
        c.kind !== 'ATTRIBUTED'
          ? []
          : [
              {
                meaning: d.item as never,
                anschaffungsnaheAcquisitionId: null,
                loan: { loanId: L, set: c.sets.length === 1 ? (c.sets[0] ?? null) : null, propertyCents: c.propertyCents },
                interest: facts as never,
              },
            ],
      ),
      OWNERS[P1] ?? [],
      P1,
    );
    expect(sources.items.map((i) => [i.lineAmount.amount, i.loan?.share])).toEqual([['225.01', '1/2']]);
    const v = viewOf(readOf(P1, [d], sets, { interest: new Map([[d.item.sourceId, facts as never]]) }));
    expect(v.capitalized.total).toEqual(eur('225.01'));
    expect(v.capitalized.items[0]?.loanAllocation?.outsideLetting).toEqual({ share: '1/5', part: eur('90.00') });
  });

  it('withValidUntil keeps the part on each set view', () => {
    expect(withValidUntil([S1, S2]).map((s) => s.outsideLetting?.share ?? null)).toEqual([{ numerator: 1n, denominator: 5n }, null]);
    expect((march.period as InterestPeriod).from).toBe('2027-03-01');
  });
});
