import { describe, expect, it } from 'vitest';
import { partChanges, type PartChange } from './attribution-parts.js';
import { ACTIVE_LOAN, loanCase, ofYear, rec, terms, type LoanCase } from './attribution-loan-schedule-parts.test-support.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import type { TaxYearAcknowledgement } from './tax-statements.js';
import type { TaxYearItem, TaxYearView } from './tax-year-view.js';
import { A, B, C, L, P1, P2, TAX_RULES, day, flagOf, interestLine, parts, readOf, set, viewOf, views } from './tax-year-loan-periods.test-support.js';

/**
 * VC-X-54 (api-design.md §58P; Entscheidung des Projektinhabers, 2026-11-05, §58P Fragen 1–11) in the view, pure:
 * Examples 1 and 2 in both PropertyReferences' views at both levels with every figure, the flag entry and the item flag,
 * the levels (open, informative once acknowledged, open again after a withdraw), `final`, and the figures with the new
 * kinds byte-identical to those without them (only `flags` and `review` differ). Synthetic values only.
 */

const S1 = set('2027-01-01', [[P1, '1/1']]);
const S2 = set('2027-03-01', [
  [P1, '1/2'],
  [P2, '1/2'],
]);
const TM = terms('0000dddd-0000-4000-8000-000000000101');
const TQ = terms('0000dddd-0000-4000-8000-000000000102', { paymentIntervalMonths: 3 });
const R2 = rec('r2', 'CREATED', '2028-02-10T09:05:00Z');
const EX1: LoanCase = {
  terms: [
    { period: TM, validNow: false, records: [rec('r0', 'CREATED', '2027-01-04T10:00:00Z'), rec('r1', 'VOIDED', '2028-02-10T09:00:00Z')] },
    { period: TQ, validNow: true, records: [R2] },
  ],
  sets: [
    { set: S1, records: [rec('r-s1', 'CREATED', '2027-01-02T10:00:00Z')] },
    { set: S2, records: [rec('r-s2', 'CREATED', '2027-01-02T10:01:00Z')] },
  ],
  debits: [
    { amount: '900.00', bookingDate: '2027-03-31' },
    { amount: '893.25', bookingDate: '2027-06-30' },
    { amount: '886.45', bookingDate: '2027-09-30' },
    { amount: '879.60', bookingDate: '2027-12-31' },
  ],
};
const ex1 = ofYear(loanCase(EX1), 2027);
const D1 = ex1.splits[0]?.item.sourceId as string;
const SETS = views([S1, S2]);

type Entry = { kind: string; entityType: string; auditRecordId: string; changeFingerprint: string; acknowledgement: unknown; items: unknown[] };
const entries = (v: TaxYearView) => (flagOf(v, 'PROPERTY_PART_CHANGED') ?? []) as Entry[];
const itemFlag = (i: TaxYearItem | undefined) => i?.flags.find((f) => f.code === 'PROPERTY_PART_CHANGED')?.details as Entry[] | undefined;
const level = (v: TaxYearView) => [
  v.review.open.some((o) => o.code === 'PROPERTY_PART_CHANGED'),
  v.review.info.some((o) => o.code === 'PROPERTY_PART_CHANGED'),
];
const viewWith = (pr: string, c = ex1, extra: Parameters<typeof readOf>[3] = {}, owner: string | null = null) =>
  viewOf(readOf(pr, c.splits, views(c.input.loans[0]?.sets.map((h) => h.set) ?? []), { parts: c.input, ...extra }), 2027, owner);
const changeOf = (pr: string, c = ex1) => partChanges(c.input, 2027, { propertyReferenceId: pr, fingerprinter, registry: TAX_RULES }).changes[0] as PartChange;
const ackOf = (pr: string, c: PartChange, o: Partial<TaxYearAcknowledgement> = {}): TaxYearAcknowledgement => ({
  acknowledgementId: `ack-${pr.slice(-1)}-${c.kind}`,
  propertyReferenceId: pr,
  year: 2027,
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
/** The view without its `flags` (the year's and every item's) and `review`: every figure, item and section. */
const figures = (v: TaxYearView) => {
  const { flags: _f, review: _r, ...rest } = v;
  return JSON.stringify(rest, (k, x: unknown) => (k === 'flags' ? undefined : typeof x === 'bigint' ? x.toString() : x));
};
/** The open codes of the view other than §58P's (the fixtures' AfA is not available, so `final` stays false there). */
const otherOpen = (v: TaxYearView) => v.review.open.filter((o) => o.code !== 'PROPERTY_PART_CHANGED');

describe('§58P Example 1 in the views', () => {
  it('P1 2027: PROPERTY_PART_CHANGED open with one entry (LOAN_TERMS_PART_ADDED, d1 450.00 to 745.00), the item flag on d1 only; P2 the same with 155.00', () => {
    const [v1, v2] = [viewWith(P1), viewWith(P2)];
    for (const [v, after] of [
      [v1, '745.00'],
      [v2, '155.00'],
    ] as const) {
      expect(entries(v).map((e) => [e.kind, e.entityType, e.auditRecordId, e.acknowledgement])).toEqual([['LOAN_TERMS_PART_ADDED', 'LoanTerms', 'r2', null]]);
      expect(entries(v)[0]).toMatchObject({
        entityId: TQ.id,
        loanId: L,
        termsId: TQ.id,
        validFrom: '2027-01-01',
        items: [
          {
            sourceType: 'TRANSACTION_SPLIT',
            sourceId: D1,
            taxYear: 2027,
            stateBefore: 'ATTRIBUTED',
            partBefore: { amount: '450.00', currency: 'EUR' },
            stateAfter: 'ATTRIBUTED',
            partAfter: { amount: after, currency: 'EUR' },
          },
        ],
      });
      expect((interestLine(v)?.items ?? []).map((i) => [i.sourceId === D1, itemFlag(i)?.length ?? 0])).toEqual([
        [true, 1],
        [false, 0],
        [false, 0],
        [false, 0],
      ]);
      expect([level(v), v.review.final, v.flags.some((f) => f.code === 'ATTRIBUTION_INPUT_CHANGED')]).toEqual([[true, false], false, false]);
      expect(v.review.open).toContainEqual({ code: 'PROPERTY_PART_CHANGED', count: 2 });
    }
  });

  it('the figures as now: P1 2 074.66 (d1 745.00, A 372.50, B 372.50), P2 1 484.64 (C); before r2 1 779.66 and 1 779.64; the sum 3 559.30 on both sides', () => {
    expect([interestLine(viewWith(P1))?.total.amount, interestLine(viewWith(P2))?.total.amount]).toEqual(['2074.66', '1484.64']);
    expect(parts(viewWith(P1, ex1, {}, A))[0]).toEqual([D1, '372.50']);
    expect(parts(viewWith(P1, ex1, {}, B))[0]).toEqual([D1, '372.50']);
    expect(interestLine(viewWith(P2, ex1, {}, C))?.total.amount).toBe('1484.64');
    // Before r2 (Tm valid, r1 and r2 not yet recorded): the monthly periods.
    const before = ofYear(loanCase({ ...EX1, terms: [{ period: TM, validNow: true, records: [rec('r0', 'CREATED', '2027-01-04T10:00:00Z')] }] }), 2027);
    expect([interestLine(viewWith(P1, before))?.total.amount, interestLine(viewWith(P2, before))?.total.amount]).toEqual(['1779.66', '1779.64']);
    expect(entries(viewWith(P1, before))).toEqual([]);
    const cents = (s: string | undefined) => BigInt((s ?? '0').replace('.', ''));
    for (const c of [ex1, before]) {
      expect(cents(interestLine(viewWith(P1, c))?.total.amount) + cents(interestLine(viewWith(P2, c))?.total.amount)).toBe(355_930n);
    }
  });

  it('every figure byte-identical with and without the new kinds; only flags and review differ', () => {
    // The same splits and sets, the read without the terms and closing histories (as before VC-X-54).
    const without = { ...ex1, input: { loans: ex1.input.loans.map(({ schedule: _s, ...l }) => l) } };
    for (const pr of [P1, P2]) {
      expect(figures(viewWith(pr))).toBe(figures(viewWith(pr, without)));
      expect(entries(viewWith(pr, without))).toEqual([]);
      for (const owner of pr === P1 ? [A, B] : [C]) expect(figures(viewWith(pr, ex1, {}, owner))).toBe(figures(viewWith(pr, without, {}, owner)));
    }
    // And the figures equal the plain view's of §58L/§58O (no parts read at all).
    expect(figures(viewWith(P1))).toBe(figures(viewOf(readOf(P1, ex1.splits, SETS), 2027)));
  });

  it('acknowledged in P1: informative and final there, the figures unchanged; P2 still open; withdrawn or another fingerprint: open again', () => {
    const change = changeOf(P1);
    const done = viewWith(P1, ex1, { acknowledgements: [ackOf(P1, change)] });
    // `final` exactly when nothing else is open: here the fixtures' AfA stays open, so the open list is the one without §58P.
    expect([level(done), done.review.open, done.review.final]).toEqual([[false, true], otherOpen(viewWith(P1)), otherOpen(viewWith(P1)).length === 0]);
    expect(entries(done)[0]?.acknowledgement).toEqual({
      acknowledgementId: 'ack-1-LOAN_TERMS_PART_ADDED',
      acknowledgedAt: '2029-03-01T10:00:00.000Z',
      acknowledgedBy: 'anna@example.com',
    });
    expect(figures(done)).toBe(figures(viewWith(P1)));
    const p2 = viewWith(P2, ex1, { acknowledgements: [ackOf(P2, change)] });
    expect([level(p2), p2.review.final]).toEqual([[true, false], false]);
    for (const ack of [ackOf(P1, change, { status: 'WITHDRAWN' }), ackOf(P1, { ...change, changeFingerprint: 'f'.repeat(64) })]) {
      expect(level(viewWith(P1, ex1, { acknowledgements: [ack] }))).toEqual([true, false]);
    }
    // P2 acknowledged with its own change: informative there too.
    expect(level(viewWith(P2, ex1, { acknowledgements: [ackOf(P2, changeOf(P2))] }))).toEqual([false, true]);
  });
});

describe('§58P Example 2 in the views', () => {
  const TC = terms('0000dddd-0000-4000-8000-000000000103', { repaymentModel: 'INTEREST_ONLY', scheduledPayment: null, firstPaymentDate: day('2027-01-31') });
  const T1 = set('2027-01-01', [[P1, '1/1']]);
  const T2 = set('2027-05-01', [[P2, '1/1']]);
  const base: LoanCase = {
    loan: { ...ACTIVE_LOAN, status: 'CLOSED', closingDate: day('2027-05-20'), closingReason: 'REPAID' },
    terms: [{ period: TC, validNow: true, records: [rec('r-c', 'CREATED', '2027-01-02T09:00:00Z')] }],
    closing: [rec('r3', 'CLOSED', '2028-01-20T08:00:00Z')],
    sets: [
      { set: T1, records: [rec('r-t1', 'CREATED', '2027-01-02T10:00:00Z')] },
      { set: T2, records: [rec('r-t2', 'CREATED', '2027-01-02T10:01:00Z')] },
    ],
    debits: [
      ...['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'].map((bookingDate) => ({ amount: '300.00', bookingDate })),
      { amount: '190.00', bookingDate: '2027-05-20' },
    ],
  };
  const ex2 = loanCase(base);

  it('the figures as now: P1 1 390.00 (A 695.00, B 695.00), P2 0.00 (no item); before r3 P1 1 200.00 and P2 190.00; both views flagged open', () => {
    expect([interestLine(viewWith(P1, ex2))?.total.amount, interestLine(viewWith(P2, ex2))?.total.amount, interestLine(viewWith(P2, ex2))?.items]).toEqual([
      '1390.00',
      '0.00',
      [],
    ]);
    expect([interestLine(viewWith(P1, ex2, {}, A))?.total.amount, interestLine(viewWith(P1, ex2, {}, B))?.total.amount]).toEqual(['695.00', '695.00']);
    const open = loanCase({ ...base, loan: ACTIVE_LOAN, closing: [] });
    expect([interestLine(viewWith(P1, open))?.total.amount, interestLine(viewWith(P2, open))?.total.amount]).toEqual(['1200.00', '190.00']);
    for (const pr of [P1, P2]) {
      const v = viewWith(pr, ex2);
      expect([entries(v).map((e) => [e.kind, e.entityType, e.auditRecordId]), level(v), v.review.final]).toEqual([
        [['LOAN_CLOSED_PART', 'Loan', 'r3']],
        [true, false],
        false,
      ]);
    }
    // P2's entry names the stub it lost: no item of P2's view carries the item flag (the stub is in P1's view now).
    expect(entries(viewWith(P2, ex2))[0]?.items).toMatchObject([
      { stateBefore: 'ATTRIBUTED', partBefore: { amount: '190.00' }, stateAfter: 'NONE', partAfter: null },
    ]);
    const stub = (interestLine(viewWith(P1, ex2))?.items ?? []).find((i) => i.amount.amount === '190.00');
    expect(itemFlag(stub)?.map((e) => e.kind)).toEqual(['LOAN_CLOSED_PART']);
  });

  it('question 10: the stub recorded on the classification goes to P2 (190.00, CLASSIFICATION) and no part change is flagged', () => {
    const recorded = { from: day('2027-05-01'), until: day('2027-05-20') };
    const fixed = loanCase({ ...base, debits: [...base.debits.slice(0, 4), { amount: '190.00', bookingDate: '2027-05-20', recorded }] });
    expect([interestLine(viewWith(P1, fixed))?.total.amount, interestLine(viewWith(P2, fixed))?.total.amount]).toEqual(['1200.00', '190.00']);
    expect(interestLine(viewWith(P2, fixed))?.items[0]?.loanAllocation?.interestPeriod).toEqual({ ...recorded, source: 'CLASSIFICATION' });
    expect(interestLine(viewWith(P2, fixed))?.items[0]?.flags.map((f) => f.code)).not.toContain('INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE');
    expect([entries(viewWith(P1, fixed)), entries(viewWith(P2, fixed))]).toEqual([[], []]);
  });
});
