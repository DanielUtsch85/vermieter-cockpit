import { describe, expect, it } from 'vitest';
import type { AllocationSetHistory, PartChange, PartItem } from './attribution-parts.js';
import { partChangeFingerprint, partChanges, partMoved, partOn } from './attribution-parts.js';
import {
  D1,
  D2,
  D3,
  D4,
  DEBITS,
  L,
  P1,
  P2,
  S1,
  S1_HISTORY,
  S2,
  STEP_1,
  STEP_2,
  allocationSet,
  day,
  eur,
  interest,
  partsOf,
  rec,
} from './attribution-parts.test-support.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { planAcknowledgement } from './tax-statements.js';
import type { LoanInterestSplit } from './tax-year-view.js';
import type { TaxMeaning } from './classification.js';
import { centsOf } from '../../shared/index.js';

/**
 * §58G (VC-X-48), pure: the part changes of a Loan's allocation sets, each judged alone by the one rule (P's part
 * before and after the record, the item's tax year, the record after 31 December); the example of §58G literally; each
 * state step (Entscheidung des Projektinhabers, 2026-11-03, Frage 3: every step changing P's summed part, not
 * `NOT_ATTRIBUTED` ↔ `NONE`); the fingerprint; the order of checks with the optional `kind` (Frage 4). Synthetic only.
 */
const ctx = (propertyReferenceId: string) => ({ propertyReferenceId, fingerprinter });
const candidateOf = (d: LoanInterestSplit) => ({ sourceId: d.item.sourceId, bookingDate: (d.item as TaxMeaning).bookingDate, amount: d.item.amount });
const run = (pr: string, year: number, sets: readonly AllocationSetHistory[], splits: readonly LoanInterestSplit[] = DEBITS[year as 2027 | 2028]) =>
  partChanges(partsOf(sets, splits), year, ctx(pr));
/** Each change as [kind, auditRecordId, items as [sourceId, stateBefore, partBefore, stateAfter, partAfter]]. */
const summary = (changes: readonly PartChange[]) =>
  changes.map((c) => [
    c.kind,
    c.auditRecordId,
    c.items.map((i) => [i.sourceId, i.stateBefore, i.partBefore?.amount ?? null, i.stateAfter, i.partAfter?.amount ?? null]),
  ]);
const only = (
  setId: string,
  validFrom: string,
  shares: readonly (readonly [string, string])[],
  records: AllocationSetHistory['records'],
  status: 'VALID' | 'VOID' = 'VALID',
) => ({
  set: allocationSet(setId, validFrom, shares, status),
  records,
});

describe('the example of §58G (P1 808.80 to 719.01, P2 539.20 to 628.99 in 2027)', () => {
  it('step 1, S2 appended on 2028-03-01: both 2027 views flagged for d2 and d3 (d1 untouched), 2028 not (the record lies in 2028)', () => {
    expect(summary(run(P1, 2027, STEP_1).changes)).toEqual([
      [
        'LOAN_ALLOCATION_SET_ADDED',
        'r-s2',
        [
          [D2, 'ATTRIBUTED', '269.99', 'ATTRIBUTED', '225.00'],
          [D3, 'ATTRIBUTED', '268.80', 'ATTRIBUTED', '224.00'],
        ],
      ],
    ]);
    expect(summary(run(P2, 2027, STEP_1).changes)).toEqual([
      [
        'LOAN_ALLOCATION_SET_ADDED',
        'r-s2',
        [
          [D2, 'ATTRIBUTED', '180.00', 'ATTRIBUTED', '224.99'],
          [D3, 'ATTRIBUTED', '179.20', 'ATTRIBUTED', '224.00'],
        ],
      ],
    ]);
    expect([run(P1, 2028, STEP_1).changes, run(P2, 2028, STEP_1).changes]).toEqual([[], []]);
    const [change] = run(P1, 2027, STEP_1).changes;
    expect(change).toMatchObject({ entityType: 'LoanAllocationSet', entityId: S2, keys: { loanId: L, allocationSetId: S2, validFrom: '2027-07-01' } });
    expect(change?.items.every((i) => i.taxYear === 2027 && i.sourceType === 'TRANSACTION_SPLIT')).toBe(true);
  });

  it('the totals: P1 and P2 sum to 1,348.00 under both sides, and the parts sum to each debit (no cent lost or made)', () => {
    const cents = (pr: string, sets: readonly AllocationSetHistory[], d: LoanInterestSplit) =>
      centsOf(
        partOn(
          pr,
          sets.map((h) => h.set).filter((x) => x.status === 'VALID'),
          candidateOf(d),
        ).part ?? eur('0.00'),
      );
    const total = (pr: string, sets: readonly AllocationSetHistory[]) => DEBITS[2027].reduce((s, d) => s + cents(pr, sets, d), 0n);
    expect([total(P1, [S1_HISTORY]), total(P2, [S1_HISTORY]), total(P1, STEP_1), total(P2, STEP_1)]).toEqual([80880n, 53920n, 71901n, 62899n]);
    for (const sets of [[S1_HISTORY], STEP_1]) {
      expect(total(P1, sets) + total(P2, sets)).toBe(134800n);
      for (const d of DEBITS[2027]) expect(cents(P1, sets, d) + cents(P2, sets, d)).toBe(centsOf(d.item.amount));
    }
  });

  it('step 2, S2 voided on 2029-02-01: a second change in 2027 (the reverse), and 2028 flagged for d4 in both views; the ADDED entry unchanged', () => {
    expect(summary(run(P1, 2027, STEP_2).changes)).toEqual([
      [
        'LOAN_ALLOCATION_SET_ADDED',
        'r-s2',
        [
          [D2, 'ATTRIBUTED', '269.99', 'ATTRIBUTED', '225.00'],
          [D3, 'ATTRIBUTED', '268.80', 'ATTRIBUTED', '224.00'],
        ],
      ],
      [
        'LOAN_ALLOCATION_SET_VOIDED',
        'r-s2v',
        [
          [D2, 'ATTRIBUTED', '225.00', 'ATTRIBUTED', '269.99'],
          [D3, 'ATTRIBUTED', '224.00', 'ATTRIBUTED', '268.80'],
        ],
      ],
    ]);
    expect(summary(run(P1, 2028, STEP_2).changes)).toEqual([['LOAN_ALLOCATION_SET_VOIDED', 'r-s2v', [[D4, 'ATTRIBUTED', '223.00', 'ATTRIBUTED', '267.60']]]]);
    expect(summary(run(P2, 2028, STEP_2).changes)).toEqual([['LOAN_ALLOCATION_SET_VOIDED', 'r-s2v', [[D4, 'ATTRIBUTED', '223.00', 'ATTRIBUTED', '178.40']]]]);
    // Each change judged alone: the ADDED entry keeps its fingerprint after the void.
    expect(run(P1, 2027, STEP_2).changes[0]?.changeFingerprint).toBe(run(P1, 2027, STEP_1).changes[0]?.changeFingerprint);
  });

  it('d3 (booked 2028-01-03, due 2027-12-31): the set by its booking date, the flag in its tax year 2027, never in 2028', () => {
    const items = run(P1, 2027, STEP_1).changes.flatMap((c) => c.items.map((i) => [i.sourceId, i.taxYear]));
    expect(items).toContainEqual([D3, 2027]);
    // Were S2 from 2028-01-01, it would still cover d3 by its booking date, not d2.
    const january = [
      S1_HISTORY,
      only(
        S2,
        '2028-01-01',
        [
          [P1, '1/2'],
          [P2, '1/2'],
        ],
        [rec('r-j', 'CREATED', '2028-03-01T10:00:00Z')],
      ),
    ];
    expect(summary(run(P1, 2027, january).changes)).toEqual([['LOAN_ALLOCATION_SET_ADDED', 'r-j', [[D3, 'ATTRIBUTED', '268.80', 'ATTRIBUTED', '224.00']]]]);
  });
});

describe('the one rule', () => {
  const late = (records: AllocationSetHistory['records']) => [
    S1_HISTORY,
    only(
      S2,
      '2027-07-01',
      [
        [P1, '1/2'],
        [P2, '1/2'],
      ],
      records,
    ),
  ];
  it('the 31-December rule on the record (Europe/Berlin): on 2027-12-31 nothing; 23:30 UTC that day is 1 January in Berlin, flagged; not the validFrom', () => {
    expect(run(P1, 2027, late([rec('x', 'CREATED', '2027-12-31T12:00:00Z')])).changes).toEqual([]);
    expect(run(P1, 2027, late([rec('x', 'CREATED', '2027-12-31T23:30:00Z')])).changes).toHaveLength(1);
    expect(run(P1, 2027, late([rec('x', 'CREATED', '2028-01-01T10:00:00Z')])).changes).toHaveLength(1);
    // A validFrom in 2027 recorded in 2027 (the backdated date alone) raises nothing.
    expect(run(P1, 2027, late([rec('x', 'CREATED', '2027-08-01T10:00:00Z')])).changes).toEqual([]);
  });

  it('a set appended with a validFrom after every booked split covers nothing: no change', () => {
    const after = [
      S1_HISTORY,
      only(
        S2,
        '2028-02-01',
        [
          [P1, '1/2'],
          [P2, '1/2'],
        ],
        [rec('x', 'CREATED', '2028-03-01T10:00:00Z')],
      ),
    ];
    expect(run(P1, 2027, after).changes).toEqual([]);
  });

  it('the part, not the share: the same share for P with another set can move a cent (flagged); an identical part is not', () => {
    // P1 keeps 1/2, P2's half goes to a third PropertyReference: 449.99 gives P1 225.00 both times (tie by id), no change.
    const P0 = '0000c48a-0000-4000-8000-000000000000';
    const half = [
      only(
        S1,
        '2027-02-01',
        [
          [P1, '1/2'],
          [P2, '1/2'],
        ],
        [rec('a', 'CREATED', '2027-02-01T10:00:00Z')],
      ),
    ];
    const swapped = [
      ...half,
      only(
        S2,
        '2027-07-01',
        [
          [P0, '1/2'],
          [P1, '1/2'],
        ],
        [rec('b', 'CREATED', '2028-03-01T10:00:00Z')],
      ),
    ];
    const d2 = [DEBITS[2027][1]];
    // With P0 < P1 the tie now goes to P0: P1's part of d2 moves from 225.00 to 224.99 at the same share.
    expect(summary(run(P1, 2027, swapped, d2).changes)).toEqual([['LOAN_ALLOCATION_SET_ADDED', 'b', [[D2, 'ATTRIBUTED', '225.00', 'ATTRIBUTED', '224.99']]]]);
    const P3 = '0000c48a-0000-4000-8000-000000000003';
    const same = [
      ...half,
      only(
        S2,
        '2027-07-01',
        [
          [P1, '1/2'],
          [P3, '1/2'],
        ],
        [rec('b', 'CREATED', '2028-03-01T10:00:00Z')],
      ),
    ];
    expect(run(P1, 2027, same, d2).changes).toEqual([]);
    // P2 is taken out entirely: ATTRIBUTED to NONE.
    expect(summary(run(P2, 2027, same, d2).changes)).toEqual([['LOAN_ALLOCATION_SET_ADDED', 'b', [[D2, 'ATTRIBUTED', '224.99', 'NONE', null]]]]);
  });

  it('each state step: NOT_ATTRIBUTED to ATTRIBUTED (a first set backdated) and back (the only set voided) flagged; NONE to ATTRIBUTED flagged', () => {
    const first = [
      only(
        S1,
        '2027-02-01',
        [
          [P1, '3/5'],
          [P2, '2/5'],
        ],
        [rec('f', 'CREATED', '2028-03-01T10:00:00Z')],
      ),
    ];
    // Before the first set there is no VALID set naming P: NONE for both views, not NOT_ATTRIBUTED.
    expect(summary(run(P1, 2027, first).changes)[0]?.[2]).toEqual([
      [D1, 'NONE', null, 'ATTRIBUTED', '270.01'],
      [D2, 'NONE', null, 'ATTRIBUTED', '269.99'],
      [D3, 'NONE', null, 'ATTRIBUTED', '268.80'],
    ]);
    // The other steps arise only in record orders §41.3 does not write (a set appended before the last one, a set not
    // the last voided; or a set held at its status by an inconsistent history): the rule is tested on them alone.
    // A set from 2027-07-01 recorded in time, one from 2027-02-01 after the year: d1 NOT_ATTRIBUTED, then ATTRIBUTED.
    const variant = [
      only(
        S2,
        '2027-07-01',
        [
          [P1, '1/2'],
          [P2, '1/2'],
        ],
        [rec('s', 'CREATED', '2027-07-01T10:00:00Z')],
      ),
      only(
        S1,
        '2027-02-01',
        [
          [P1, '3/5'],
          [P2, '2/5'],
        ],
        [rec('f', 'CREATED', '2028-03-01T10:00:00Z')],
      ),
    ];
    expect(summary(run(P1, 2027, variant).changes)).toEqual([['LOAN_ALLOCATION_SET_ADDED', 'f', [[D1, 'NOT_ATTRIBUTED', null, 'ATTRIBUTED', '270.01']]]]);
    const voided = [
      only(
        S1,
        '2027-02-01',
        [
          [P1, '3/5'],
          [P2, '2/5'],
        ],
        [rec('f', 'CREATED', '2027-02-01T10:00:00Z'), rec('v', 'VOIDED', '2028-03-01T10:00:00Z')],
        'VOID',
      ),
    ];
    expect(summary(run(P1, 2027, voided).changes)[0]?.[2]).toEqual([
      [D1, 'ATTRIBUTED', '270.01', 'NONE', null],
      [D2, 'ATTRIBUTED', '269.99', 'NONE', null],
      [D3, 'ATTRIBUTED', '268.80', 'NONE', null],
    ]);
    // ATTRIBUTED to NOT_ATTRIBUTED: the later set voided while an earlier one from after the debit still names P.
    const gap = [
      only(
        S1,
        '2027-02-01',
        [
          [P1, '3/5'],
          [P2, '2/5'],
        ],
        [rec('a', 'CREATED', '2027-02-01T10:00:00Z'), rec('av', 'VOIDED', '2028-03-01T10:00:00Z')],
        'VOID',
      ),
      only(
        S2,
        '2027-07-01',
        [
          [P1, '1/2'],
          [P2, '1/2'],
        ],
        [rec('b', 'CREATED', '2027-07-01T10:00:00Z')],
      ),
    ];
    expect(summary(run(P1, 2027, gap).changes)).toEqual([['LOAN_ALLOCATION_SET_VOIDED', 'av', [[D1, 'ATTRIBUTED', '270.01', 'NOT_ATTRIBUTED', null]]]]);
  });

  it('NOT_ATTRIBUTED to NONE is no part change (no figure of P moves): a set naming only P2 appended where P1 was not attributed', () => {
    const P3 = '0000c48a-0000-4000-8000-000000000003';
    expect(partMoved({ state: 'NOT_ATTRIBUTED', part: null }, { state: 'NONE', part: null })).toBe(false);
    expect(partMoved({ state: 'NONE', part: null }, { state: 'NOT_ATTRIBUTED', part: null })).toBe(false);
    expect(partMoved({ state: 'NOT_ATTRIBUTED', part: null }, { state: 'ATTRIBUTED', part: eur('0.00') })).toBe(true);
    expect(partMoved({ state: 'ATTRIBUTED', part: eur('1.00') }, { state: 'ATTRIBUTED', part: eur('1.00') })).toBe(false);
    // Through the derivation: P1 only in a later set; a set naming only P3 from 2027-02-01 voided after the year.
    const sets = [
      only(S1, '2027-02-01', [[P3, '1/1']], [rec('a', 'CREATED', '2027-02-01T10:00:00Z'), rec('av', 'VOIDED', '2028-03-01T10:00:00Z')], 'VOID'),
      only(S2, '2027-09-01', [[P1, '1/1']], [rec('b', 'CREATED', '2027-09-01T10:00:00Z')]),
    ];
    // d1 and d2 go from NONE (P3's set covers them) to NOT_ATTRIBUTED (no set covers them, S2 names P1): no change.
    expect(run(P1, 2027, sets, DEBITS[2027].slice(0, 2)).changes).toEqual([]);
    // P3's view: ATTRIBUTED to NONE, flagged.
    expect(summary(run(P3, 2027, sets, DEBITS[2027].slice(0, 2)).changes)[0]?.[2]).toEqual([
      [D1, 'ATTRIBUTED', '450.01', 'NONE', null],
      [D2, 'ATTRIBUTED', '449.99', 'NONE', null],
    ]);
  });

  it('a Loan whose only set naming P was voided is still judged (its void took the interest out of P view)', () => {
    const voided = [only(S1, '2027-02-01', [[P1, '1/1']], [rec('a', 'CREATED', '2027-02-01T10:00:00Z'), rec('v', 'VOIDED', '2028-03-01T10:00:00Z')], 'VOID')];
    expect(summary(run(P1, 2027, voided, [DEBITS[2027][0]]).changes)).toEqual([
      ['LOAN_ALLOCATION_SET_VOIDED', 'v', [[D1, 'ATTRIBUTED', '450.01', 'NONE', null]]],
    ]);
  });

  it('a taxYear override: the item is judged in the year it now counts in (the read gives it there), its taxYear that year', () => {
    const moved = interest('449.99', '2027-07-30', 2028, D2);
    expect(summary(run(P1, 2028, STEP_1, [moved]).changes)).toEqual([]);
    expect(summary(run(P1, 2028, STEP_2, [moved]).changes)).toEqual([
      ['LOAN_ALLOCATION_SET_VOIDED', 'r-s2v', [[D2, 'ATTRIBUTED', '225.00', 'ATTRIBUTED', '269.99']]],
    ]);
    expect(run(P1, 2028, STEP_2, [moved]).changes[0]?.items[0]?.taxYear).toBe(2028);
  });

  it('an inconsistent history: the set flagged ATTRIBUTION_HISTORY_INCONSISTENT, its records unused, its current status held', () => {
    // S2 VALID now but its records end VOIDED: unusable; S2 holds throughout, so nothing moves.
    const broken = [
      S1_HISTORY,
      only(
        S2,
        '2027-07-01',
        [
          [P1, '1/2'],
          [P2, '1/2'],
        ],
        [rec('r-s2', 'CREATED', '2028-03-01T10:00:00Z'), rec('x', 'VOIDED', '2029-02-01T10:00:00Z')],
      ),
    ];
    const found = run(P1, 2027, broken);
    expect([found.changes, found.inconsistent]).toEqual([[], [{ entityType: 'LoanAllocationSet', entityId: S2 }]]);
    // A VALID set without any record: inconsistent too.
    expect(run(P1, 2027, [{ ...S1_HISTORY, records: [] }]).inconsistent).toEqual([{ entityType: 'LoanAllocationSet', entityId: S1 }]);
  });

  it('entries by amendedAt, then auditRecordId; no Loan, no candidate or no record after the year: nothing', () => {
    const at = run(P1, 2027, STEP_2).changes.map((c) => c.amendedAt.toISOString());
    expect(at).toEqual(['2028-03-01T10:00:00.000Z', '2029-02-01T10:00:00.000Z']);
    expect(partChanges(undefined, 2027, ctx(P1))).toEqual({ changes: [], inconsistent: [] });
    expect(run(P1, 2027, STEP_2, []).changes).toEqual([]);
  });
});

describe('the fingerprint (§58G)', () => {
  const items: PartItem[] = [
    {
      sourceType: 'TRANSACTION_SPLIT',
      sourceId: D2,
      taxYear: 2027,
      stateBefore: 'ATTRIBUTED',
      partBefore: eur('269.99'),
      stateAfter: 'ATTRIBUTED',
      partAfter: eur('225.00'),
    },
    {
      sourceType: 'TRANSACTION_SPLIT',
      sourceId: D3,
      taxYear: 2027,
      stateBefore: 'ATTRIBUTED',
      partBefore: eur('268.80'),
      stateAfter: 'ATTRIBUTED',
      partAfter: eur('224.00'),
    },
  ];
  const fp = (o: Partial<Parameters<typeof partChangeFingerprint>[1]> = {}) =>
    partChangeFingerprint(fingerprinter, { propertyReferenceId: P1, year: 2027, auditRecordId: 'r-s2', kind: 'LOAN_ALLOCATION_SET_ADDED', items, ...o });
  it('stable over item order and id case; different for another part, state, year, record or kind; the derived one equals it', () => {
    expect(fp({ items: [...items].reverse() })).toBe(fp());
    expect(fp({ propertyReferenceId: P1.toUpperCase(), items: items.map((i) => ({ ...i, sourceId: i.sourceId.toUpperCase() })) })).toBe(fp());
    const otherPart = [{ ...(items[0] as PartItem), partAfter: eur('225.01') }, items[1] as PartItem];
    const otherState = [{ ...(items[0] as PartItem), stateAfter: 'NONE' as const, partAfter: null }, items[1] as PartItem];
    const otherYear = items.map((i) => ({ ...i, taxYear: 2028 }));
    const all = [
      fp(),
      fp({ items: otherPart }),
      fp({ items: otherState }),
      fp({ items: otherYear }),
      fp({ year: 2028 }),
      fp({ auditRecordId: 'x' }),
      fp({ kind: 'LOAN_ALLOCATION_SET_VOIDED' }),
    ];
    expect(new Set(all).size).toBe(all.length);
    expect(run(P1, 2027, STEP_1).changes[0]?.changeFingerprint).toBe(fp());
    // The two views of one change have their own fingerprints (P is in it).
    expect(run(P2, 2027, STEP_1).changes[0]?.changeFingerprint).not.toBe(fp());
  });
});

describe('the order of checks with the optional kind (Entscheidung des Projektinhabers, 2026-11-03, Frage 4)', () => {
  const [part] = run(P1, 2027, STEP_1).changes as [PartChange];
  // A year change of the same record: impossible for a set record in VC-X-48 (§58H's reconciliation will be both).
  const year = {
    ...part,
    kind: 'RECONCILIATION_CONFIRMED' as const,
    entityType: 'RentPaymentReconciliation' as const,
    keys: {},
    items: [{ sourceId: D2, yearBefore: 2027, yearAfter: 2028 }],
    changeFingerprint: 'b'.repeat(64),
  };
  it('one change: taken without kind; with its kind; another kind CHANGE_NOT_FLAGGED', () => {
    const request = { auditRecordId: 'r-s2', expectedFingerprint: part.changeFingerprint };
    expect(planAcknowledgement([part], request, [])).toEqual({ kind: 'CREATE', change: part });
    expect(planAcknowledgement([part], { ...request, kind: 'LOAN_ALLOCATION_SET_ADDED' }, [])).toEqual({ kind: 'CREATE', change: part });
    expect(planAcknowledgement([part], { ...request, kind: 'LOAN_ALLOCATION_SET_VOIDED' }, [])).toEqual({ kind: 'NOT_FLAGGED' });
    expect(planAcknowledgement([part], { ...request, expectedFingerprint: 'x' }, [])).toEqual({ kind: 'DIFFERS', currentFingerprint: part.changeFingerprint });
  });
  it('a record that is two changes: CHANGE_AMBIGUOUS naming the kinds without kind; the kind picks one, the 412 with its one currentFingerprint', () => {
    const request = { auditRecordId: 'r-s2', expectedFingerprint: part.changeFingerprint };
    expect(planAcknowledgement([year, part], request, [])).toEqual({ kind: 'AMBIGUOUS', kinds: ['LOAN_ALLOCATION_SET_ADDED', 'RECONCILIATION_CONFIRMED'] });
    expect(planAcknowledgement([year, part], { ...request, kind: 'LOAN_ALLOCATION_SET_ADDED' }, [])).toEqual({ kind: 'CREATE', change: part });
    expect(planAcknowledgement([year, part], { ...request, kind: 'RECONCILIATION_CONFIRMED' }, [])).toEqual({
      kind: 'DIFFERS',
      currentFingerprint: year.changeFingerprint,
    });
  });
});

describe('partOn (§58G table)', () => {
  const c = { sourceId: D4, bookingDate: day('2028-06-30'), amount: eur('446.00') };
  it('ATTRIBUTED by distribute over the whole set; NONE without an entry; NOT_ATTRIBUTED without a covering set while a set names P', () => {
    expect(partOn(P1, [S1_HISTORY.set], c)).toEqual({ state: 'ATTRIBUTED', part: eur('267.60') });
    expect(partOn('0000c48a-0000-4000-8000-000000000009', [S1_HISTORY.set], c)).toEqual({ state: 'NONE', part: null });
    expect(partOn(P1, [allocationSet(S2, '2028-07-01', [[P1, '1/1']])], c)).toEqual({ state: 'NOT_ATTRIBUTED', part: null });
    expect(partOn(P1, [], c)).toEqual({ state: 'NONE', part: null });
    expect(partOn(P2, [S1_HISTORY.set, STEP_1[1]?.set as never], c).part?.amount).toBe('223.00');
  });
});
