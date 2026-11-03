import { describe, expect, it } from 'vitest';
import { partChanges, type AllocationSetHistory, type PartChange } from './attribution-parts.js';
import {
  A,
  B,
  D1,
  D2,
  D3,
  D4,
  P1,
  P2,
  S1,
  S1_HISTORY,
  S2,
  STEP_1,
  STEP_2,
  TAX_RULES,
  allocationSet,
  eur,
  readOf,
  rec,
  today,
} from './attribution-parts.test-support.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import type { TaxYearAcknowledgement } from './tax-statements.js';
import { flagIsOpen } from './tax-year-review.js';
import { buildTaxYearView, type TaxYearItem, type TaxYearRead, type TaxYearView } from './tax-year-view.js';

/**
 * §58G (VC-X-48) in the view, pure: `PROPERTY_PART_CHANGED` as a year flag and an item flag, its level by state (open
 * while an entry is not acknowledged, informative once each is), `final`, the figures of the sets as now recorded
 * (never moved by a flag or an acknowledgement), the owners' parts, the price flag independent, the inconsistent set
 * history. The example of §58G with its numbers. Synthetic values only.
 */
const viewOf = (read: TaxYearRead, year: number, ownerPartyId: string | null = null): TaxYearView => {
  const outcome = buildTaxYearView(read, { year, ownerPartyId, today, registry: TAX_RULES, fingerprinter });
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
};
const line = (v: TaxYearView) => v.werbungskosten.lines.find((l) => l.taxCategory === 'LOAN_INTEREST');
const level = (v: TaxYearView, code = 'PROPERTY_PART_CHANGED') => [v.review.open.some((o) => o.code === code), v.review.info.some((o) => o.code === code)];
type Entry = { kind: string; auditRecordId: string; changeFingerprint: string; acknowledgement: unknown; items: unknown[] };
const entries = (v: TaxYearView) => (v.flags.find((f) => f.code === 'PROPERTY_PART_CHANGED')?.details ?? []) as Entry[];
const itemFlag = (i: TaxYearItem | undefined) => i?.flags.find((f) => f.code === 'PROPERTY_PART_CHANGED')?.details as Entry[] | undefined;
const items = (v: TaxYearView) => line(v)?.items ?? [];
const changesOf = (pr: string, year: number, sets: readonly AllocationSetHistory[]) =>
  partChanges(readOf(pr, year as 2027, sets).parts, year, { propertyReferenceId: pr, fingerprinter }).changes;
const ackOf = (pr: string, year: number, c: PartChange, o: Partial<TaxYearAcknowledgement> = {}): TaxYearAcknowledgement => ({
  acknowledgementId: `ack-${pr.slice(-1)}-${year}-${c.kind}`,
  propertyReferenceId: pr,
  year,
  status: 'ACTIVE',
  change: {
    auditRecordId: c.auditRecordId,
    kind: c.kind,
    entityType: c.entityType,
    entityId: c.entityId,
    recordedAt: c.amendedAt,
    fingerprint: c.changeFingerprint,
    items: c.items,
  },
  reason: 'Erklärung noch nicht abgegeben (synthetisch)',
  acknowledgedAt: new Date('2029-03-01T10:00:00Z'),
  acknowledgedBy: 'anna@example.com',
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawReason: null,
  version: 1,
  ...o,
});

describe('the example of §58G in the views', () => {
  it('before S2: P1 808.80, P2 539.20 in 2027, no flag and final; after S2 appended on 2028-03-01: 719.01 and 628.99, flagged open, not final', () => {
    const [b1, b2] = [viewOf(readOf(P1, 2027, [S1_HISTORY]), 2027), viewOf(readOf(P2, 2027, [S1_HISTORY]), 2027)];
    expect([line(b1)?.total.amount, line(b2)?.total.amount]).toEqual(['808.80', '539.20']);
    expect([entries(b1), b1.review.final, b2.review.final]).toEqual([[], true, true]);
    const [v1, v2] = [viewOf(readOf(P1, 2027, STEP_1), 2027), viewOf(readOf(P2, 2027, STEP_1), 2027)];
    expect([line(v1)?.total.amount, line(v2)?.total.amount]).toEqual(['719.01', '628.99']);
    // Money across the views unchanged: 1,348.00 before and after.
    expect(Number(line(v1)?.total.amount) * 100 + Number(line(v2)?.total.amount) * 100).toBeCloseTo(134800, 6);
    for (const v of [v1, v2]) {
      expect(entries(v).map((e) => [e.kind, e.auditRecordId, e.acknowledgement])).toEqual([['LOAN_ALLOCATION_SET_ADDED', 'r-s2', null]]);
      expect([level(v), v.review.final, v.flags.some((f) => f.code === 'ATTRIBUTION_INPUT_CHANGED')]).toEqual([[true, false], false, false]);
      // The item flag on d2 and d3, not on d1.
      expect(items(v).map((i) => [i.sourceId, itemFlag(i)?.length ?? 0])).toEqual([
        [D1, 0],
        [D2, 1],
        [D3, 1],
      ]);
    }
    expect(entries(v1)[0]).toMatchObject({
      entityType: 'LoanAllocationSet',
      entityId: S2,
      allocationSetId: S2,
      validFrom: '2027-07-01',
      amendedAt: '2028-03-01T10:00:00.000Z',
      items: [
        {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: D2,
          taxYear: 2027,
          stateBefore: 'ATTRIBUTED',
          partBefore: eur('269.99').toJSON(),
          stateAfter: 'ATTRIBUTED',
          partAfter: eur('225.00').toJSON(),
        },
        {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: D3,
          taxYear: 2027,
          stateBefore: 'ATTRIBUTED',
          partBefore: eur('268.80').toJSON(),
          stateAfter: 'ATTRIBUTED',
          partAfter: eur('224.00').toJSON(),
        },
      ],
    });
    expect(itemFlag(items(v2)[1])?.[0]).toMatchObject({
      kind: 'LOAN_ALLOCATION_SET_ADDED',
      partBefore: eur('180.00').toJSON(),
      partAfter: eur('224.99').toJSON(),
    });
    // 2028: the record lies in 2028, d4 not flagged; the line is S2's.
    const v2028 = viewOf(readOf(P1, 2028, STEP_1), 2028);
    expect([entries(v2028), line(v2028)?.total.amount, v2028.review.final]).toEqual([[], '223.00', true]);
  });

  it('acknowledged in P1 2027: P1 informative and final, the figures unchanged; P2 2027 still open (one acknowledgement per view)', () => {
    const [change] = changesOf(P1, 2027, STEP_1) as [PartChange];
    const open = viewOf(readOf(P1, 2027, STEP_1), 2027);
    const done = viewOf(readOf(P1, 2027, STEP_1, { acknowledgements: [ackOf(P1, 2027, change)] }), 2027);
    expect([level(done), done.review.final, done.review.open]).toEqual([[false, true], true, []]);
    expect(entries(done)[0]?.acknowledgement).toEqual({
      acknowledgementId: `ack-1-2027-LOAN_ALLOCATION_SET_ADDED`,
      acknowledgedAt: '2029-03-01T10:00:00.000Z',
      acknowledgedBy: 'anna@example.com',
    });
    expect(itemFlag(items(done)[1])?.[0]?.acknowledgement).toMatchObject({ acknowledgementId: 'ack-1-2027-LOAN_ALLOCATION_SET_ADDED' });
    expect([done.werbungskosten.total, line(done)?.total, done.result, done.owners?.map((o) => o.result)]).toEqual([
      open.werbungskosten.total,
      line(open)?.total,
      open.result,
      open.owners?.map((o) => o.result),
    ]);
    // P1's acknowledgement in P2's view does not match (P is in the fingerprint).
    const p2 = viewOf(readOf(P2, 2027, STEP_1, { acknowledgements: [ackOf(P2, 2027, change)] }), 2027);
    expect([level(p2), p2.review.final]).toEqual([[true, false], false]);
    // Open again: withdrawn, another fingerprint, or acknowledged in another year.
    for (const ack of [ackOf(P1, 2027, change, { status: 'WITHDRAWN' }), ackOf(P1, 2027, { ...change, changeFingerprint: 'f'.repeat(64) })]) {
      expect(level(viewOf(readOf(P1, 2027, STEP_1, { acknowledgements: [ack] }), 2027))).toEqual([true, false]);
    }
  });

  it('step 2, S2 voided on 2029-02-01: a second entry in 2027 (the ADDED one keeps its acknowledgement), the line 808.80 again, 2028 flagged in both views', () => {
    const [added] = changesOf(P1, 2027, STEP_1) as [PartChange];
    const v = viewOf(readOf(P1, 2027, STEP_2, { acknowledgements: [ackOf(P1, 2027, added)] }), 2027);
    expect(entries(v).map((e) => [e.kind, e.acknowledgement === null])).toEqual([
      ['LOAN_ALLOCATION_SET_ADDED', false],
      ['LOAN_ALLOCATION_SET_VOIDED', true],
    ]);
    expect([line(v)?.total.amount, level(v), v.review.final]).toEqual(['808.80', [true, false], false]);
    expect(itemFlag(items(v)[1])?.map((e) => e.kind)).toEqual(['LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED']);
    for (const pr of [P1, P2]) {
      const y = viewOf(readOf(pr, 2028, STEP_2), 2028);
      expect([entries(y).map((e) => e.kind), level(y), items(y).map((i) => [i.sourceId, itemFlag(i)?.length])]).toEqual([
        ['LOAN_ALLOCATION_SET_VOIDED'],
        [true, false],
        [[D4, 1]],
      ]);
    }
    // Everything acknowledged: informative and final in both years.
    const all = changesOf(P1, 2027, STEP_2).map((c) => ackOf(P1, 2027, c));
    const final = viewOf(readOf(P1, 2027, STEP_2, { acknowledgements: all }), 2027);
    expect([level(final), final.review.final]).toEqual([[false, true], true]);
  });

  it('the owners: A and B (1/2 each) carry P1 part on both sides, summed to the line; the flag unfiltered at the owner level', () => {
    for (const sets of [[S1_HISTORY], STEP_1]) {
      const v = viewOf(readOf(P1, 2027, sets), 2027);
      const owners = (v.owners ?? []).map((o) => Number(o.werbungskosten.total.amount) * 100);
      expect(Math.round(owners.reduce((s, x) => s + x, 0))).toBe(Math.round(Number(v.werbungskosten.total.amount) * 100));
      expect(v.notOwned).toBeNull();
    }
    const ownerView = viewOf(readOf(P1, 2027, STEP_1), 2027, A);
    expect([entries(ownerView).length, level(ownerView)]).toEqual([1, [true, false]]);
    expect(viewOf(readOf(P1, 2027, STEP_1), 2027, B).flags.map((f) => f.code)).toContain('PROPERTY_PART_CHANGED');
  });
});

describe('the flag beside the others', () => {
  it('the price flag and the part flag are independent: a confirmation clears only the price flag, an acknowledgement only the part flag', () => {
    const priced = allocationSet(
      S2,
      '2027-07-01',
      [
        [P1, '1/2'],
        [P2, '1/2'],
      ],
      'VALID',
      'PURCHASE_PRICE',
    );
    const sets = [S1_HISTORY, { set: priced, records: [rec('r-s2', 'CREATED', '2028-03-01T10:00:00Z')] }];
    const confirmation = {
      confirmationId: 'c-1',
      loanId: priced.loanId,
      allocationSetId: S2,
      status: 'ACTIVE' as const,
      set: { validFrom: priced.validFrom, basis: priced.basis, allocations: [] },
      reason: 'x',
      advisorPartyId: null,
      confirmedAt: new Date('2029-03-01T10:00:00Z'),
      confirmedBy: 'x',
      withdrawnAt: null,
      withdrawnBy: null,
      withdrawReason: null,
      version: 1,
    };
    const [change] = changesOf(P1, 2027, sets) as [PartChange];
    const confirmed = viewOf(readOf(P1, 2027, sets, { taxConfirmations: new Map([[S2, confirmation]]) }), 2027);
    expect([level(confirmed), level(confirmed, 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY')]).toEqual([
      [true, false],
      [false, true],
    ]);
    const acknowledged = viewOf(readOf(P1, 2027, sets, { acknowledgements: [ackOf(P1, 2027, change)] }), 2027);
    expect([level(acknowledged), level(acknowledged, 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY'), acknowledged.review.final]).toEqual([
      [false, true],
      [true, false],
      false,
    ]);
  });

  it('an item now not attributed carries the item flag in notAttributed; LOAN_INTEREST_NOT_ATTRIBUTED stays open after the acknowledgement', () => {
    // S1 voided after the year while S2 from 2027-07-01 still names P1 (an order §41.3 does not write, the rule alone).
    const sets = [
      {
        set: allocationSet(S1, '2027-02-01', [[P1, '1/1']], 'VOID'),
        records: [rec('a', 'CREATED', '2027-02-01T10:00:00Z'), rec('av', 'VOIDED', '2028-03-01T10:00:00Z')],
      },
      { set: allocationSet(S2, '2027-07-01', [[P1, '1/1']]), records: [rec('b', 'CREATED', '2027-07-01T10:00:00Z')] },
    ];
    const v = viewOf(readOf(P1, 2027, sets), 2027);
    const listed = v.notAttributed.items.find((i) => i.sourceId === D1);
    expect(itemFlag(listed)?.map((e) => [e.kind, (e as unknown as { stateAfter: string }).stateAfter])).toEqual([
      ['LOAN_ALLOCATION_SET_VOIDED', 'NOT_ATTRIBUTED'],
    ]);
    const [change] = changesOf(P1, 2027, sets) as [PartChange];
    const done = viewOf(readOf(P1, 2027, sets, { acknowledgements: [ackOf(P1, 2027, change)] }), 2027);
    expect([level(done), level(done, 'LOAN_INTEREST_NOT_ATTRIBUTED'), done.review.final]).toEqual([[false, true], [true, false], false]);
  });

  it('an inconsistent set history: ATTRIBUTION_HISTORY_INCONSISTENT with LoanAllocationSet, open, not acknowledgeable; no part flag', () => {
    const broken = [S1_HISTORY, { ...(STEP_1[1] as AllocationSetHistory), records: [] }];
    const v = viewOf(readOf(P1, 2027, broken), 2027);
    expect(v.flags.filter((f) => f.code === 'ATTRIBUTION_HISTORY_INCONSISTENT').map((f) => f.details)).toEqual([
      { entityType: 'LoanAllocationSet', entityId: S2 },
    ]);
    expect([entries(v), level(v, 'ATTRIBUTION_HISTORY_INCONSISTENT'), v.review.final]).toEqual([[], [true, false], false]);
  });

  it('flagIsOpen: PROPERTY_PART_CHANGED open with one entry unacknowledged, informative with all; no classification clears it', () => {
    const item = { treatment: 'DEDUCTIBLE', origin: 'CLASSIFICATION', reviewState: 'ADVISOR_CONFIRMED' } as const;
    expect(flagIsOpen('PROPERTY_PART_CHANGED', item, [{ acknowledgement: null }])).toBe(true);
    expect(flagIsOpen('PROPERTY_PART_CHANGED', item, [{ acknowledgement: {} }, { acknowledgement: null }])).toBe(true);
    expect(flagIsOpen('PROPERTY_PART_CHANGED', item, [{ acknowledgement: {} }])).toBe(false);
    expect(flagIsOpen('PROPERTY_PART_CHANGED', item, [])).toBe(true);
  });

  it('no part change without a part input (a read of before VC-X-48), the figures the same', () => {
    const { parts: _parts, ...withoutParts } = readOf(P1, 2027, STEP_1);
    const v = viewOf(withoutParts, 2027);
    expect([entries(v), line(v)?.total.amount]).toEqual([[], '719.01']);
  });
});
