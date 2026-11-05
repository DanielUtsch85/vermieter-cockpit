import { describe, expect, it } from 'vitest';
import { addMonths, centsOf } from '../../shared/index.js';
import { attributionChanges } from './attribution-changes.js';
import type { TermsHistory } from './attribution-history.js';
import { partChangeFingerprint, partChanges, type PartChange, type PartChangeInput } from './attribution-parts.js';
import { ACTIVE_LOAN, loanCase, ofYear, rec, terms, type LoanCase } from './attribution-loan-schedule-parts.test-support.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { deviationOf, interestPeriodOf } from './loan-interest-periods.js';
import { planAcknowledgement } from './tax-statements.js';
import { L, P1, P2, TAX_RULES, day, eur, set } from './tax-year-loan-periods.test-support.js';

/**
 * VC-X-54 (api-design.md §58P; Entscheidung des Projektinhabers, 2026-11-05, §58P Fragen 1–11, alle wie vorgeschlagen):
 * a Loan's terms record or closing recorded after a year's end that moves P's part of an interest split of that year is
 * a part change, `LOAN_TERMS_PART_ADDED`, `LOAN_TERMS_PART_VOIDED` or `LOAN_CLOSED_PART`. Examples 1–3 of §58P with
 * every figure, the edge cases of "Tests the implementation needs", and question 10's closing stub. Synthetic only.
 */

const S1 = set('2027-01-01', [[P1, '1/1']]);
const S2 = set('2027-03-01', [
  [P1, '1/2'],
  [P2, '1/2'],
]);
const SETS = [
  { set: S1, records: [rec('r-s1', 'CREATED', '2027-01-02T10:00:00Z')] },
  { set: S2, records: [rec('r-s2', 'CREATED', '2027-01-02T10:01:00Z')] },
];
const TM = terms('0000dddd-0000-4000-8000-000000000001');
const TQ = terms('0000dddd-0000-4000-8000-000000000002', { paymentIntervalMonths: 3 });
const R0 = rec('r0', 'CREATED', '2027-01-04T10:00:00Z');
const R1 = rec('r1', 'VOIDED', '2028-02-10T09:00:00Z');
const R2 = rec('r2', 'CREATED', '2028-02-10T09:05:00Z');
/** Example 1: Tm monthly (r0, voided by r1), Tq quarterly (r2); the four quarterly debits. */
const EX1_TERMS: TermsHistory[] = [
  { period: TM, validNow: false, records: [R0, R1] },
  { period: TQ, validNow: true, records: [R2] },
];
const EX1_DEBITS = [
  { amount: '900.00', bookingDate: '2027-03-31' },
  { amount: '893.25', bookingDate: '2027-06-30' },
  { amount: '886.45', bookingDate: '2027-09-30' },
  { amount: '879.60', bookingDate: '2027-12-31' },
];
const ex1 = (o: Partial<LoanCase> = {}) => loanCase({ terms: EX1_TERMS, sets: SETS, debits: EX1_DEBITS, ...o });
const changesOf = (input: PartChangeInput, pr: string, year = 2027) =>
  partChanges(input, year, { propertyReferenceId: pr, fingerprinter, registry: TAX_RULES });
/** `[kind, auditRecordId, [sourceId, stateBefore, partBefore, stateAfter, partAfter]…]` per change. */
const shape = (c: PartChange) => [
  c.kind,
  c.auditRecordId,
  c.items.map((i) => [i.sourceId, i.stateBefore, i.partBefore?.amount ?? null, i.stateAfter, i.partAfter?.amount ?? null]),
];
const shapes = (input: PartChangeInput, pr: string, year = 2027) => changesOf(input, pr, year).changes.map(shape);

describe('§58P Example 1: the interval entered after the year end (Loan Q)', () => {
  const c = ex1();
  const [d1] = c.splits.map((s) => s.item.sourceId) as [string];

  it('r2 alone moves d1: P1 450.00 to 745.00, P2 450.00 to 155.00, LOAN_TERMS_PART_ADDED on LoanTerms Tq with its keys', () => {
    expect(shapes(c.input, P1)).toEqual([['LOAN_TERMS_PART_ADDED', 'r2', [[d1, 'ATTRIBUTED', '450.00', 'ATTRIBUTED', '745.00']]]]);
    expect(shapes(c.input, P2)).toEqual([['LOAN_TERMS_PART_ADDED', 'r2', [[d1, 'ATTRIBUTED', '450.00', 'ATTRIBUTED', '155.00']]]]);
    const [change] = changesOf(c.input, P1).changes as [PartChange];
    expect(change).toMatchObject({
      kind: 'LOAN_TERMS_PART_ADDED',
      entityType: 'LoanTerms',
      entityId: TQ.id,
      auditRecordId: 'r2',
      amendedAt: R2.occurredAt,
      keys: { loanId: L, termsId: TQ.id, validFrom: '2027-01-01' },
    });
    expect(change.items).toEqual([
      {
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: d1,
        taxYear: 2027,
        stateBefore: 'ATTRIBUTED',
        partBefore: eur('450.00'),
        stateAfter: 'ATTRIBUTED',
        partAfter: eur('745.00'),
      },
    ]);
  });

  it('each record alone: r0 not after the year end, r1 (void, rule 8 after) moves nothing; voids count but this one leaves every part equal', () => {
    const [onlyR1] = [loanCase({ terms: [{ period: TM, validNow: false, records: [R0, R1] }], sets: SETS, debits: EX1_DEBITS })];
    expect(shapes(onlyR1.input, P1)).toEqual([]);
    expect(changesOf(c.input, P1).changes.map((x) => x.auditRecordId)).toEqual(['r2']);
    // r0 judged in 2026 (it is after 2026's end): no item of 2026 exists (only the sets' own records, §58G, appear there).
    expect(shapes(c.input, P1, 2026).filter((x) => String(x[0]).startsWith('LOAN_TERMS') || x[0] === 'LOAN_CLOSED_PART')).toEqual([]);
  });

  it('no year moves: neither r1 nor r2 is an ATTRIBUTION_INPUT_CHANGED entry, so no CHANGE_AMBIGUOUS', () => {
    const attribution = {
      references: [],
      candidates: [],
      loans: [
        {
          loanId: L,
          loan: ACTIVE_LOAN,
          terms: EX1_TERMS,
          closing: [],
          candidates: c.candidates.map((x) => ({
            sourceId: x.sourceId,
            bookingDate: x.bookingDate,
            financialCategoryCode: 'LOAN_INTEREST',
            taxYearOverride: null,
          })),
          sets: [S1, S2].map((s, i) => ({ ...s, validUntil: i === 0 ? day('2027-02-28') : null })),
        },
      ],
    };
    expect(attributionChanges(attribution, 2027, TAX_RULES, { propertyReferenceId: P1, fingerprinter }).changes).toEqual([]);
  });

  it('counter-check, S2 from 2027-04-01: d1 lies wholly in S1 on every side, d2 wholly in S2: no flag, although Tq changed every period', () => {
    const late = set('2027-04-01', [
      [P1, '1/2'],
      [P2, '1/2'],
    ]);
    const v = ex1({ sets: [SETS[0] as (typeof SETS)[number], { set: late, records: [rec('r-late', 'CREATED', '2027-01-02T10:01:00Z')] }] });
    expect([shapes(v.input, P1), shapes(v.input, P2)]).toEqual([[], []]);
  });

  it('2028: no item of 2028, and r1 and r2 are not after 2028 s end', () => {
    expect(shapes(c.input, P1, 2028)).toEqual([]);
  });

  it('VOIDED judged as a void: the void of the only terms moves d1 by rule 8 after (LOAN_TERMS_PART_VOIDED, P1 745.00 to 450.00)', () => {
    const voidTq = rec('r3', 'VOIDED', '2028-03-01T09:00:00Z');
    const v = loanCase({
      terms: [{ period: TQ, validNow: false, records: [rec('r-q', 'CREATED', '2027-01-04T10:00:00Z'), voidTq] }],
      sets: SETS,
      debits: EX1_DEBITS,
    });
    expect(shapes(v.input, P1)).toEqual([['LOAN_TERMS_PART_VOIDED', 'r3', [[v.splits[0]?.item.sourceId, 'ATTRIBUTED', '745.00', 'ATTRIBUTED', '450.00']]]]);
    // The first terms of a Loan without terms (rule 8 before): the same move the other way, ADDED.
    const first = loanCase({
      terms: [{ period: TQ, validNow: true, records: [rec('r4', 'CREATED', '2028-03-01T09:00:00Z')] }],
      sets: SETS,
      debits: EX1_DEBITS,
    });
    expect(shapes(first.input, P1)).toEqual([
      ['LOAN_TERMS_PART_ADDED', 'r4', [[first.splits[0]?.item.sourceId, 'ATTRIBUTED', '450.00', 'ATTRIBUTED', '745.00']]],
    ]);
  });
});

/** Example 2's Loan C: `INTEREST_ONLY` 3 % from 2027-01-01, monthly from 2027-01-31 (300.00 each), closed 2027-05-20. */
const TC = terms('0000dddd-0000-4000-8000-000000000003', { repaymentModel: 'INTEREST_ONLY', scheduledPayment: null, firstPaymentDate: day('2027-01-31') });
const T1 = set('2027-01-01', [[P1, '1/1']]);
const T2 = set('2027-05-01', [[P2, '1/1']]);
const T_SETS = [
  { set: T1, records: [rec('r-t1', 'CREATED', '2027-01-02T10:00:00Z')] },
  { set: T2, records: [rec('r-t2', 'CREATED', '2027-01-02T10:01:00Z')] },
];
const R3 = rec('r3', 'CLOSED', '2028-01-20T08:00:00Z');
const CLOSED_C = { ...ACTIVE_LOAN, status: 'CLOSED' as const, closingDate: day('2027-05-20'), closingReason: 'REPAID' as const };
const EX2_DEBITS = [
  ...['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'].map((bookingDate) => ({ amount: '300.00', bookingDate })),
  { amount: '190.00', bookingDate: '2027-05-20' },
];
const ex2 = (o: Partial<LoanCase> = {}) =>
  loanCase({
    loan: CLOSED_C,
    terms: [{ period: TC, validNow: true, records: [rec('r-c', 'CREATED', '2027-01-02T09:00:00Z')] }],
    closing: [R3],
    sets: T_SETS,
    debits: EX2_DEBITS,
    ...o,
  });

describe('§58P Example 2: a closing recorded after the year end (Loan C)', () => {
  const c = ex2();
  const stub = c.splits[4]?.item.sourceId as string;

  it('LOAN_CLOSED_PART: the May stub 190.00 moves from P2 (period 2027-05-01 – 05-31) to P1 (2027-04-01 – 04-30)', () => {
    expect(shapes(c.input, P1)).toEqual([['LOAN_CLOSED_PART', 'r3', [[stub, 'NONE', null, 'ATTRIBUTED', '190.00']]]]);
    expect(shapes(c.input, P2)).toEqual([['LOAN_CLOSED_PART', 'r3', [[stub, 'ATTRIBUTED', '190.00', 'NONE', null]]]]);
    expect(changesOf(c.input, P1).changes[0]).toMatchObject({
      entityType: 'Loan',
      entityId: L,
      keys: { loanId: L, closingDate: '2027-05-20', closingReason: 'REPAID' },
    });
    expect(c.splits[4]?.period).toEqual({ from: '2027-04-01', until: '2027-04-30', source: 'LOAN_SCHEDULE' });
  });

  it('the closing judged against the terms as now; a closing recorded on 31 December is no change, on 1 January it is', () => {
    const at = (iso: string) => shapes(ex2({ closing: [rec('r3', 'CLOSED', iso)] }).input, P1).length;
    // Europe/Berlin: 2027-12-31T22:59:59Z is still 31 December, 23:00:00Z is 1 January 2028.
    expect([at('2027-12-31T22:59:59Z'), at('2027-12-31T23:00:00Z')]).toEqual([0, 1]);
  });

  it('question 10: the recorded closing stub 2027-05-01 – 05-20 is used (CLASSIFICATION, no flag): wholly T2 on both sides, no part change', () => {
    const recorded = { from: day('2027-05-01'), until: day('2027-05-20') };
    const withStub = ex2({ debits: [...EX2_DEBITS.slice(0, 4), { amount: '190.00', bookingDate: '2027-05-20', recorded }] });
    expect(withStub.splits[4]?.period).toEqual({ ...recorded, source: 'CLASSIFICATION' });
    expect(shapes(withStub.input, P1)).toEqual([]);
    expect(shapes(withStub.input, P2)).toEqual([]);
    const facts = {
      debtFrom: day('2027-01-01'),
      paymentDates: ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30'].map(day),
      closingDate: day('2027-05-20'),
    };
    expect(deviationOf(day('2027-05-20'), recorded, facts)).toBeNull();
    expect(interestPeriodOf(day('2027-05-20'), recorded, facts)).toEqual({ ...recorded, source: 'CLASSIFICATION' });
    // Counter-check (§58O precedence case 3): a recorded period equal to the plan's reads as the plan's.
    expect(interestPeriodOf(day('2027-04-30'), { from: day('2027-04-01'), until: day('2027-04-30') }, facts)).toMatchObject({ source: 'LOAN_SCHEDULE' });
  });

  it('a closing of a Loan without terms: no schedule on either side, no change; an inconsistent closing history: one entry, the record unused', () => {
    const none = ex2({ terms: [] });
    expect(shapes(none.input, P1)).toEqual([]);
    const twice = ex2({ closing: [R3, rec('r3b', 'CLOSED', '2028-01-21T08:00:00Z')] });
    const out = changesOf(twice.input, P1);
    expect([out.changes, out.inconsistent]).toEqual([[], [{ entityType: 'Loan', entityId: L }]]);
    const notClosed = ex2({ loan: ACTIVE_LOAN });
    expect(changesOf(notClosed.input, P1).inconsistent).toEqual([{ entityType: 'Loan', entityId: L }]);
  });

  it('a terms record reads the closing as now: a terms period voided after the year end on the closed Loan uses the cut plan on both sides', () => {
    // Without the closing on the terms side, the stub would read 2027-05-01 – 05-31 before and fall into T2.
    const voided = ex2({
      terms: [{ period: TC, validNow: false, records: [rec('r-c', 'CREATED', '2027-01-02T09:00:00Z'), rec('r-v', 'VOIDED', '2028-02-01T09:00:00Z')] }],
      closing: [rec('r3', 'CLOSED', '2027-06-01T08:00:00Z')],
    });
    // Before: the cut plan, the stub in April (T1); after: no terms, rule 8 by 2027-05-20 (T2).
    expect(shapes(voided.input, P1)).toEqual([['LOAN_TERMS_PART_VOIDED', 'r-v', [[voided.splits[4]?.item.sourceId, 'ATTRIBUTED', '190.00', 'NONE', null]]]]);
  });
});

/** Example 3: monthly due on the 5th; a second terms period, quarterly from 2027-12-01 (due 2028-02-05), recorded in 2028. */
const T5 = terms('0000dddd-0000-4000-8000-000000000005', { repaymentModel: 'INTEREST_ONLY', scheduledPayment: null, firstPaymentDate: day('2027-02-05') });
const T5Q = terms('0000dddd-0000-4000-8000-000000000006', {
  repaymentModel: 'INTEREST_ONLY',
  scheduledPayment: null,
  validFrom: day('2027-12-01'),
  firstPaymentDate: day('2028-02-05'),
  paymentIntervalMonths: 3,
});
const U1 = set('2027-01-01', [[P1, '1/1']]);
const U2 = set('2027-11-01', [
  [P1, '1/2'],
  [P2, '1/2'],
]);
const R5 = rec('r5', 'CREATED', '2028-02-10T09:00:00Z');
const ex3 = () =>
  loanCase({
    terms: [
      { period: T5, validNow: true, records: [rec('r-5', 'CREATED', '2027-01-02T09:00:00Z')] },
      { period: T5Q, validNow: true, records: [R5] },
    ],
    sets: [
      { set: U1, records: [rec('r-u1', 'CREATED', '2027-01-02T10:00:00Z')] },
      { set: U2, records: [rec('r-u2', 'CREATED', '2027-01-02T10:01:00Z')] },
    ],
    // The ordinary debit of 2027-12-20 and the January debit of 2028-01-03.
    debits: [
      { amount: '310.00', bookingDate: '2027-12-20' },
      { amount: '300.00', bookingDate: '2028-01-03' },
    ],
  });

describe('§58P Example 3: one record, a year change and a part change', () => {
  const c = ex3();
  const [ordinary, january] = c.splits.map((s) => s.item.sourceId) as [string, string];
  const yearInput = {
    references: [],
    candidates: [],
    loans: [
      {
        loanId: L,
        loan: ACTIVE_LOAN,
        terms: ex3().input.loans[0]?.schedule?.terms ?? [],
        closing: [],
        candidates: [{ sourceId: january, bookingDate: day('2028-01-03'), financialCategoryCode: 'LOAN_INTEREST', taxYearOverride: null }],
        sets: [
          { ...U1, validUntil: day('2027-10-31') },
          { ...U2, validUntil: null },
        ],
      },
    ],
  };

  it('in 2027: LOAN_TERMS_ADDED moves the January debit to 2028; LOAN_TERMS_PART_ADDED moves the ordinary one (its period gains a set boundary); the January debit is no part item', () => {
    // Now (after r5) the January debit is in 2028; the ordinary one stays in 2027 on both sides.
    expect(c.splits.map((s) => (s.item as { taxYear: number }).taxYear)).toEqual([2027, 2028]);
    const year = attributionChanges(yearInput, 2027, TAX_RULES, { propertyReferenceId: P1, fingerprinter }).changes;
    expect(year.map((x) => [x.kind, x.auditRecordId, x.items])).toEqual([
      ['LOAN_TERMS_ADDED', 'r5', [{ sourceId: january, yearBefore: 2027, yearAfter: 2028 }]],
    ]);
    // Before: 2027-11-06 – 12-05, wholly U2 (155.00); after: 2027-10-06 – 11-05, 26 days U1 and 5 days U2: 310 × 57/62 = 285.00.
    const all = changesOf(c.input, P1);
    expect(all.changes.map(shape)).toEqual([['LOAN_TERMS_PART_ADDED', 'r5', [[ordinary, 'ATTRIBUTED', '155.00', 'ATTRIBUTED', '285.00']]]]);
    // Even with the January debit among the candidates, its year moves (rule 5): no part item.
    const inYear = ofYear(c, 2027);
    expect(changesOf(inYear.input, P1).changes.map(shape)).toEqual(all.changes.map(shape));
    const without = planAcknowledgement([...year, ...all.changes], { auditRecordId: 'r5', expectedFingerprint: 'x' }, []);
    expect(without).toEqual({ kind: 'AMBIGUOUS', kinds: ['LOAN_TERMS_ADDED', 'LOAN_TERMS_PART_ADDED'] });
    const withKind = planAcknowledgement(
      [...year, ...all.changes],
      { auditRecordId: 'r5', expectedFingerprint: all.changes[0]?.changeFingerprint as string, kind: 'LOAN_TERMS_PART_ADDED' },
      [],
    );
    expect(withKind).toMatchObject({ kind: 'CREATE', change: { kind: 'LOAN_TERMS_PART_ADDED' } });
  });

  it('mutation guard: the January debit taken as a part item would appear; it does not, under a year override it does (the overridden year on both sides)', () => {
    const overridden = loanCase({
      terms: c.input.loans[0]?.schedule?.terms ?? [],
      sets: c.input.loans[0]?.sets ?? [],
      debits: [{ amount: '300.00', bookingDate: '2028-01-03', override: 2027 }],
    });
    // Overridden to 2027 on both sides: a part item if its part moved (before 2027-12-06 – 2028-01-05, U2; after 2027-11-06 – 2028-02-05, U2): equal, none.
    expect(shapes(overridden.input, P1)).toEqual([]);
  });
});

describe('§58P rule 5: a split whose year moves is no part item', () => {
  const U3 = set('2028-01-15', [[P2, '1/1']]);
  /** The January debit of Example 3 with a set from 2028-01-15 (P2) inside its new period; T5Q recorded by `record`. */
  const movingCase = (record = R5, override?: number) =>
    loanCase({
      terms: [
        { period: T5, validNow: true, records: [rec('r-5', 'CREATED', '2027-01-02T09:00:00Z')] },
        { period: T5Q, validNow: true, records: [record] },
      ],
      sets: [
        { set: U1, records: [rec('r-u1', 'CREATED', '2027-01-02T10:00:00Z')] },
        { set: U3, records: [rec('r-u3', 'CREATED', '2027-01-02T10:01:00Z')] },
      ],
      debits: [{ amount: '300.00', bookingDate: '2028-01-03', ...(override === undefined ? {} : { override }) }],
    });

  it('the January debit moves to 2028 and its part would move too (a set from 2028-01-15 inside its new period): no part item, in neither year', () => {
    const c = movingCase();
    // Before 2027-12-06 – 2028-01-05 wholly U1 (P1 300.00, 2027); after 2027-11-06 – 2028-02-05 across U3 (2028): its part moved with its year.
    for (const year of [2027, 2028]) for (const pr of [P1, P2]) expect(shapes(c.input, pr, year), `${pr} ${year}`).toEqual([]);
  });

  it('the before side: a record after the year end of 2028 moves the January debit from 2027 into 2028; in 2028 LOAN_TERMS_ADDED, no part item', () => {
    // T5Q recorded 2029-02-10, after the year end of 2028 as well: the 2028 view judges it.
    const r = rec('r5-2029', 'CREATED', '2029-02-10T09:00:00Z');
    const c = movingCase(r);
    const [january] = c.splits.map((s) => s.item.sourceId) as [string];
    expect(c.splits.map((s) => (s.item as { taxYear: number }).taxYear)).toEqual([2028]);
    const yearInput = {
      references: [],
      candidates: [],
      loans: [
        {
          loanId: L,
          loan: ACTIVE_LOAN,
          terms: c.input.loans[0]?.schedule?.terms ?? [],
          closing: [],
          candidates: [{ sourceId: january, bookingDate: day('2028-01-03'), financialCategoryCode: 'LOAN_INTEREST', taxYearOverride: null }],
          sets: [
            { ...U1, validUntil: day('2028-01-14') },
            { ...U3, validUntil: null },
          ],
        },
      ],
    };
    const year = attributionChanges(yearInput, 2028, TAX_RULES, { propertyReferenceId: P1, fingerprinter }).changes;
    expect(year.map((x) => [x.kind, x.auditRecordId, x.items])).toEqual([
      ['LOAN_TERMS_ADDED', 'r5-2029', [{ sourceId: january, yearBefore: 2027, yearAfter: 2028 }]],
    ]);
    // Its part moves (before wholly U1, after across U3), but its year before is 2027: rule 5 on the before side, no part item.
    for (const pr of [P1, P2]) expect(shapes(c.input, pr, 2028), pr).toEqual([]);
    expect(shapes(ofYear(c, 2028).input, P1, 2028)).toEqual([]);
  });

  it('a taxYear override with a moving part: the January debit overridden to 2027 (timing year 2028 after) is a part item of 2027, of 2028 none', () => {
    const c = movingCase(R5, 2027);
    const [january] = c.splits.map((s) => s.item.sourceId) as [string];
    expect(c.splits.map((s) => (s.item as { taxYear: number }).taxYear)).toEqual([2027]);
    // Overridden to 2027 on both sides, although its timing year after r5 is 2028. Before 2027-12-06 – 2028-01-05 wholly U1:
    // P1 300.00. After 2027-11-06 – 2028-02-05 (92 days): 70 days U1 (P1), 22 days U3 (P2).
    expect(shapes(c.input, P1)).toEqual([['LOAN_TERMS_PART_ADDED', 'r5', [[january, 'ATTRIBUTED', '300.00', 'ATTRIBUTED', '228.26']]]]);
    expect(shapes(c.input, P2)).toEqual([['LOAN_TERMS_PART_ADDED', 'r5', [[january, 'NONE', null, 'ATTRIBUTED', '71.74']]]]);
    for (const pr of [P1, P2]) expect(shapes(c.input, pr, 2028), pr).toEqual([]);
  });
});

describe('§58P edge cases', () => {
  /** Loan L of §58L Example 1: monthly due on the last day; S1 P1, S2 from 2027-03-16 P1/P2 half each. */
  const E1 = set('2027-01-01', [[P1, '1/1']]);
  const E2 = set('2027-03-16', [
    [P1, '1/2'],
    [P2, '1/2'],
  ]);
  const E_SETS = [
    { set: E1, records: [rec('r-e1', 'CREATED', '2027-01-02T10:00:00Z')] },
    { set: E2, records: [rec('r-e2', 'CREATED', '2027-01-02T10:01:00Z')] },
  ];
  const TL = terms('0000dddd-0000-4000-8000-000000000011', { repaymentModel: 'INTEREST_ONLY', scheduledPayment: null, firstPaymentDate: day('2027-01-31') });
  const T15 = terms('0000dddd-0000-4000-8000-000000000012', {
    repaymentModel: 'INTEREST_ONLY',
    scheduledPayment: null,
    validFrom: day('2027-03-01'),
    firstPaymentDate: day('2027-03-15'),
  });
  const base = (records: TermsHistory[], debits = [{ amount: '310.00', bookingDate: '2027-03-31' }], sets = E_SETS) =>
    loanCase({ terms: records, sets, debits });
  const tl = (validNow = true, extra: TermsHistory['records'] = []): TermsHistory => ({
    period: TL,
    validNow,
    records: [rec('r-tl', 'CREATED', '2027-01-02T09:00:00Z'), ...extra],
  });

  it('a new firstPaymentDate (due on the 15th from 2027-03-01, recorded 2028-02-10): P1 230.00 to 155.00, now flagged', () => {
    const v = base([tl(), { period: T15, validNow: true, records: [rec('r15', 'CREATED', '2028-02-10T10:00:00Z')] }]);
    expect(shapes(v.input, P1)).toEqual([['LOAN_TERMS_PART_ADDED', 'r15', [[v.splits[0]?.item.sourceId, 'ATTRIBUTED', '230.00', 'ATTRIBUTED', '155.00']]]]);
  });

  it('a change of the period inside one set: none (rule 7); a one-cent move: flagged', () => {
    const inside = base(
      [tl(), { period: T15, validNow: true, records: [rec('r15', 'CREATED', '2028-02-10T10:00:00Z')] }],
      [{ amount: '300.00', bookingDate: '2027-05-31' }],
    );
    // Before 2027-05-01 – 05-31, after 2027-05-16 – 06-15: both wholly E2.
    expect(shapes(inside.input, P1)).toEqual([]);
    // S2 from 2027-03-31 instead: before 1 day of 31 in E2 (0.50 × 1/31 of 1.00), the cent case.
    const cent = set('2027-03-31', [
      [P1, '1/2'],
      [P2, '1/2'],
    ]);
    const one = base(
      [tl(), { period: T15, validNow: true, records: [rec('r15', 'CREATED', '2028-02-10T10:00:00Z')] }],
      [{ amount: '0.62', bookingDate: '2027-03-31' }],
      [E_SETS[0] as (typeof E_SETS)[number], { set: cent, records: [rec('r-c', 'CREATED', '2027-01-02T10:01:00Z')] }],
    );
    // Before: 2027-03-01 – 03-31 (30 days E1, 1 day cent): P1 0.61; after: 2027-03-16 – 04-15 (15 days E1, 16 cent): 0.62 × 23/31 = 0.46.
    expect(shapes(one.input, P1).map((x) => (x[2] as unknown[][])[0]?.slice(2))).toEqual([['0.61', 'ATTRIBUTED', '0.46']]);
  });

  it('a period reaching a day without a set: ATTRIBUTED to NOT_ATTRIBUTED flagged, NOT_ATTRIBUTED to NONE not', () => {
    // Only E2 (from 2027-03-16): before 2027-03-01 – 03-31 has uncovered days (NOT_ATTRIBUTED for P1 and P2); after wholly E2.
    const only = [{ set: E2, records: [rec('r-e2', 'CREATED', '2027-01-02T10:01:00Z')] }];
    const v = base([tl(), { period: T15, validNow: true, records: [rec('r15', 'CREATED', '2028-02-10T10:00:00Z')] }], undefined, only);
    expect(shapes(v.input, P2)).toEqual([['LOAN_TERMS_PART_ADDED', 'r15', [[v.splits[0]?.item.sourceId, 'NOT_ATTRIBUTED', null, 'ATTRIBUTED', '155.00']]]]);
    // A third PropertyReference named by a set of no side covering the split: NOT_ATTRIBUTED before, NONE after: no change.
    const P3 = '0000aaaa-0000-4000-8000-000000000003';
    const p3 = { set: set('2028-01-01', [[P3, '1/1']]), records: [rec('r-p3', 'CREATED', '2027-01-02T10:02:00Z')] };
    const w = base([tl(), { period: T15, validNow: true, records: [rec('r15', 'CREATED', '2028-02-10T10:00:00Z')] }], undefined, [...only, p3]);
    expect(shapes(w.input, P3)).toEqual([]);
  });

  it('a recorded interestPeriod deviating on both sides: none; equal to the after side s plan: the parts by the plan on both sides', () => {
    const records = [tl(), { period: T15, validNow: true, records: [rec('r15', 'CREATED', '2028-02-10T10:00:00Z')] }];
    const deviating = base(records, [
      { amount: '310.00', bookingDate: '2027-03-31', recorded: { from: day('2027-02-01'), until: day('2027-03-31') } } as never,
    ]);
    expect(shapes(deviating.input, P1)).toEqual([]);
    // Equal to the after side's plan (2027-03-16 – 04-15): it deviates from the before side's (2027-03-01 – 03-31) and wins there.
    const equal = base(records, [{ amount: '310.00', bookingDate: '2027-03-31', recorded: { from: day('2027-03-16'), until: day('2027-04-15') } } as never]);
    expect(shapes(equal.input, P1)).toEqual([]);
    // Counter-check: the same recorded period ignored on the before side would read 230.00 there (the plan's): a change.
    expect(shapes(base(records).input, P1)).toHaveLength(1);
  });

  it('a rate change ending an annuity earlier moves the nearest entry of a late debit', () => {
    // An annuity of 600.00 at 0 % over 1 800.00 ends after three payments (2027-01-31 – 03-31); at 3 % with the same 600.00 it ends later.
    const small = { ...ACTIVE_LOAN, principalOriginal: eur('1800.00') };
    const t0 = terms('0000dddd-0000-4000-8000-000000000021', { interestRate: 0n, scheduledPayment: eur('600.00'), firstPaymentDate: day('2027-01-31') });
    const t3 = terms('0000dddd-0000-4000-8000-000000000022', { interestRate: 3000n, scheduledPayment: eur('600.00'), firstPaymentDate: day('2027-01-31') });
    // A late debit on 2027-04-25: by t3's plan nearest 2027-04-30 (period 2027-04-01 – 04-30, wholly E2, 155.00); by t0's 2027-03-31 (2027-03-01 – 03-31, 230.00).
    const v = loanCase({
      loan: small,
      terms: [
        { period: t3, validNow: false, records: [rec('r-t3', 'CREATED', '2027-01-02T09:00:00Z'), rec('r-t3v', 'VOIDED', '2028-02-10T09:00:00Z')] },
        { period: t0, validNow: true, records: [rec('r-t0', 'CREATED', '2028-02-10T09:01:00Z')] },
      ],
      sets: E_SETS,
      debits: [{ amount: '310.00', bookingDate: '2027-04-25' }],
    });
    // The void of t3 alone: before 155.00, after rule 8 by 2027-04-25 (E2) 155.00, no change; t0's entry: 230.00.
    expect(shapes(v.input, P1)).toEqual([['LOAN_TERMS_PART_ADDED', 'r-t0', [[v.splits[0]?.item.sourceId, 'ATTRIBUTED', '155.00', 'ATTRIBUTED', '230.00']]]]);
  });

  it('a terms record on 31 December (Europe/Berlin) is no change, on 1 January it is; the 31-December rule reads occurred_at, never validFrom', () => {
    const at = (iso: string) => shapes(base([tl(), { period: T15, validNow: true, records: [rec('r15', 'CREATED', iso)] }]).input, P1).length;
    expect([at('2027-12-31T22:59:59Z'), at('2027-12-31T23:00:00Z'), at('2027-06-01T10:00:00Z')]).toEqual([0, 1, 0]);
  });

  it('an inconsistent terms history: ATTRIBUTION_HISTORY_INCONSISTENT with LoanTerms, one entry, its records unused', () => {
    const broken: TermsHistory = {
      period: T15,
      validNow: true,
      records: [rec('r15', 'CREATED', '2028-02-10T10:00:00Z'), rec('r15b', 'CREATED', '2028-02-11T10:00:00Z')],
    };
    const out = changesOf(base([tl(), broken]).input, P1);
    expect([out.changes, out.inconsistent]).toEqual([[], [{ entityType: 'LoanTerms', entityId: T15.id }]]);
  });

  it('without the schedule histories (a read before VC-X-54) nothing is judged; without a registry the judgement refuses to guess', () => {
    const records = [tl(), { period: T15, validNow: true, records: [rec('r15', 'CREATED', '2028-02-10T10:00:00Z')] }];
    expect(
      shapes(loanCase({ terms: records, sets: E_SETS, debits: [{ amount: '310.00', bookingDate: '2027-03-31' }], withoutSchedule: true }).input, P1),
    ).toEqual([]);
    expect(() => partChanges(base(records).input, 2027, { propertyReferenceId: P1, fingerprinter })).toThrow(/rule registry/);
  });
});

describe('§58P the fingerprint and the money sums', () => {
  it('the fingerprint: stable over the order of the items, different for another part, kind or record', () => {
    const input = ex1().input;
    const [c] = changesOf(input, P1).changes as [PartChange];
    const loan = input.loans[0] as PartChangeInput['loans'][number];
    const reversed = { loans: [{ ...loan, candidates: [...loan.candidates].reverse() }] };
    expect((changesOf(reversed, P1).changes[0] as PartChange).changeFingerprint).toBe(c.changeFingerprint);
    // Another part (P2's view of the same record), another record id, another kind.
    expect((changesOf(input, P2).changes[0] as PartChange).changeFingerprint).not.toBe(c.changeFingerprint);
    const schedule = loan.schedule as NonNullable<typeof loan.schedule>;
    const otherRecord = {
      loans: [
        {
          ...loan,
          schedule: { ...schedule, terms: [EX1_TERMS[0] as TermsHistory, { ...(EX1_TERMS[1] as TermsHistory), records: [{ ...R2, auditRecordId: 'r9' }] }] },
        },
      ],
    };
    expect((changesOf(otherRecord, P1).changes[0] as PartChange).changeFingerprint).not.toBe(c.changeFingerprint);
    expect(
      partChangeFingerprint(fingerprinter, { propertyReferenceId: P1, year: 2027, auditRecordId: 'r2', kind: 'LOAN_TERMS_PART_ADDED', items: c.items }),
    ).toBe(c.changeFingerprint);
    expect(
      partChangeFingerprint(fingerprinter, { propertyReferenceId: P1, year: 2027, auditRecordId: 'r2', kind: 'LOAN_ALLOCATION_SET_ADDED', items: c.items }),
    ).not.toBe(c.changeFingerprint);
  });

  it('seeded property: for every split and side the parts of P1 and P2 sum to its amount (attributed) and the change items of both views mirror each other', () => {
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    let moved = 0;
    for (let round = 0; round < 40; round++) {
      const boundary = addMonths(day('2027-01-01'), next(11));
      const k = 1 + next(3);
      const fixed = set(boundary, [
        [P1, `${k}/4`],
        [P2, `${4 - k}/4`],
      ]);
      const sets = [
        { set: set('2027-01-01', [[P1, '1/1']]), records: [rec('r-a', 'CREATED', '2027-01-02T10:00:00Z')] },
        { set: fixed, records: [rec('r-b', 'CREATED', '2027-01-02T10:01:00Z')] },
      ];
      const first = addMonths(day('2027-01-05'), next(3)).slice(0, 8) + String(5 + next(23)).padStart(2, '0');
      const tNew = terms('0000dddd-0000-4000-8000-0000000001' + String(round).padStart(2, '0'), {
        firstPaymentDate: day(first),
        paymentIntervalMonths: [1, 3, 6, 12][next(4)] as 1 | 3 | 6 | 12,
      });
      const debits = Array.from({ length: 4 }, () => ({
        amount: `${100 + next(900)}.${String(next(100)).padStart(2, '0')}`,
        bookingDate: addMonths(day('2027-02-10'), next(10)),
      }));
      const c = ofYear(
        loanCase({
          terms: [
            { period: TM, validNow: false, records: [R0, R1] },
            { period: tNew, validNow: true, records: [R2] },
          ],
          sets,
          debits,
        }),
        2027,
      );
      const [a, b] = [changesOf(c.input, P1).changes, changesOf(c.input, P2).changes];
      for (const x of [...a, ...b]) expect(x.items.every((i) => i.taxYear === 2027)).toBe(true);
      // Where both sides are ATTRIBUTED in both views, the parts sum to the split's amount on each side.
      for (const [x, i] of a.flatMap((x) => x.items.map((i) => [x, i] as const))) {
        const j = b.find((y) => y.auditRecordId === x.auditRecordId)?.items.find((k) => k.sourceId === i.sourceId);
        // A move of P1's part is a move of P2's (both named by every covering set here).
        expect(j).toBeDefined();
        moved++;
        const amount = c.candidates.find((k) => k.sourceId === i.sourceId)?.amount;
        if (j === undefined || amount === undefined) continue;
        const sum = (p: typeof i.partBefore, q: typeof i.partBefore) => (p === null ? 0n : centsOf(p)) + (q === null ? 0n : centsOf(q));
        expect(sum(i.partBefore, j.partBefore)).toBe(centsOf(amount));
        expect(sum(i.partAfter, j.partAfter)).toBe(centsOf(amount));
      }
    }
    // Not vacuous: the seeds move parts.
    expect(moved).toBeGreaterThan(20);
  });
});
