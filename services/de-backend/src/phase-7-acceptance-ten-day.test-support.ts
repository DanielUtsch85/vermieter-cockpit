import type pg from 'pg';
import { expect } from 'vitest';
import { cents, codes, figures, placed, type Money, type View } from './phase-7-acceptance.test-support.js';

/**
 * ACC7's step for §58F (VC-X-39; owner decision 2026-11-02, „ACC7 um einen Fall ohne Fälligkeit und dessen
 * ausdrückliche Auflösung ergänzen“): on a PropertyReference and Tenant of their own, so the figures ACC7 asserts stay
 * as they are, a January 2028 rent of 700.00 and its advance of 100.00, paid on 2027-12-29 without a recorded due date.
 * It counts in 2027, the year paid, with `PROPOSED_BY_10_DAY_RULE` open on each item; 2028 carries the year flag with
 * both splits and their amounts, unsummed. A confirmation without `taxYear` decides nothing. Then the explicit
 * resolutions: a confirmed `taxYear` 2028 for the base rent, and the Tenant's recorded due day 3 with its
 * `evidenceReference` for the advance. The amounts count in exactly one year at every step. Synthetic data only.
 */
export interface TenDayStep {
  readonly pool: pg.Pool;
  readonly realm: string;
  readonly mrePropertyId: string;
  readonly tenant: string;
  readonly term: string;
  readonly A: (method: string, path: string, body?: unknown, extra?: Record<string, string>) => Promise<Response>;
  readonly json: <T>(res: Response, status: number) => Promise<T>;
  readonly booked: (
    direction: 'INFLOW' | 'OUTFLOW',
    bookingDate: string,
    splits: Record<string, unknown>[],
  ) => Promise<{ transactionId: string; splitIds: string[] }>;
  readonly reconciles: (v: View) => void;
  readonly traceable: (v: View) => void;
}

const eur = (amount: string): Money => ({ amount, currency: 'EUR' });
const PROPOSED = 'PROPOSED_BY_10_DAY_RULE';
/** The 10-day proposal's counts in `review.open` and `review.info` (item flags and the year flag together). */
const levels = (v: View) => {
  const review = v.review as View['review'] & { info: { code: string; count: number }[] };
  return [review.open, review.info].map((l) => l.find((o) => o.code === PROPOSED)?.count ?? 0);
};
type Proposed = { count: number; items: { sourceId: string; amount: Money; countedInYear: number; proposedYear: number; open: boolean }[] };
const yearFlagOf = (v: View) => v.flags.find((f) => f.code === PROPOSED)?.details as Proposed | undefined;

export async function tenDayProposalStep(s: TenDayStep): Promise<void> {
  const { A, json } = s;
  const flat = (
    await json<{ propertyReferenceId: string }>(await A('POST', '/property-references/link', { mreRealmId: s.realm, mrePropertyId: s.mrePropertyId }), 201)
  ).propertyReferenceId;
  const view = async (year: number) => json<View>(await A('GET', `/property-references/${flat}/tax-years/${year}`), 200);
  const on = (amount: string, financialCategoryCode: string) => ({ amount: eur(amount), financialCategoryCode, propertyReferenceId: flat });
  const rent = await s.booked('INFLOW', '2027-12-29', [on('700.00', 'RENT_BASE'), on('100.00', 'RENT_OPERATING_COST_ADVANCE')]);
  const [baseSplit, advanceSplit] = rent.splitIds as [string, string];
  await json(
    await A('POST', '/rent-reconciliations', { transactionId: rent.transactionId, mreTenantId: s.tenant, mreRentTerm: s.term, matchedAmount: eur('800.00') }),
    201,
  );
  const ours = (v: View) => placed(v).filter((i) => rent.splitIds.includes(i.sourceId));
  const both = async () => {
    const [y2027, y2028] = [await view(2027), await view(2028)];
    // Counted once at every step: the two years together hold exactly 800.00 of income.
    expect(cents(y2027.einnahmen.total) + cents(y2028.einnahmen.total)).toBe(80000n);
    for (const v of [y2027, y2028]) {
      s.traceable(v);
      s.reconciles(v);
    }
    return [y2027, y2028] as const;
  };

  // 1. No due date: 2027 counts both splits, each with the open proposal; 2028 names them with their amounts, unsummed.
  const [open2027, open2028] = await both();
  expect([figures(open2027).einnahmen, figures(open2028).einnahmen]).toEqual([
    ['800.00', { RENT: '700.00', OPERATING_COST_ADVANCES: '100.00' }],
    ['0.00', {}],
  ]);
  expect(ours(open2027).map((i) => [i.sourceId, i.taxYear, codes(i.flags)])).toEqual([
    [baseSplit, 2027, ['DUE_DATE_ASSUMED', PROPOSED]],
    [advanceSplit, 2027, ['DUE_DATE_ASSUMED', PROPOSED]],
  ]);
  expect(ours(open2027)[0]?.flags[1]?.details).toMatchObject({ dueDate: '2028-01-01', dueDateSource: 'PERIOD_START', proposedYear: 2028 });
  expect(ours(open2028)).toEqual([]);
  const named = yearFlagOf(open2028);
  // Sorted by sourceId.
  const expected = [
    [baseSplit, eur('700.00'), 2027, 2028, true],
    [advanceSplit, eur('100.00'), 2027, 2028, true],
  ].sort((a, b) => ((a[0] as string) < (b[0] as string) ? -1 : 1));
  expect(named?.items.map((i) => [i.sourceId, i.amount, i.countedInYear, i.proposedYear, i.open])).toEqual(expected);
  expect([levels(open2027), levels(open2028), open2027.review.final, open2028.review.final]).toEqual([[2, 0], [1, 0], false, false]);

  // 2. A classification confirmed without taxYear decides nothing: both years still show the proposal open.
  const classify = (body: Record<string, unknown>) =>
    A('POST', '/tax-classifications', { sourceType: 'TRANSACTION_SPLIT', taxCategory: 'RENT', treatment: 'INCOME', reviewState: 'USER_CONFIRMED', ...body });
  const plain = await json<{ classificationId: string }>(await classify({ sourceId: baseSplit, supersedes: null }), 201);
  const [plain2027, plain2028] = await both();
  expect([levels(plain2027), levels(plain2028)]).toEqual([
    [2, 0],
    [1, 0],
  ]);

  // 3a. The explicit decision: the base rent's taxYear 2028, confirmed. It counts in 2028; its proposal is informative.
  await json(await classify({ sourceId: baseSplit, supersedes: plain.classificationId, taxYear: 2028 }), 201);
  const [mid2027, mid2028] = await both();
  expect([figures(mid2027).einnahmen, figures(mid2028).einnahmen]).toEqual([
    ['100.00', { OPERATING_COST_ADVANCES: '100.00' }],
    ['700.00', { RENT: '700.00' }],
  ]);
  // 2027: the advance's item flag open, the base rent's year flag informative; 2028: the advance's year flag open, the base's item flag informative.
  expect([levels(mid2027), levels(mid2028)]).toEqual([
    [1, 1],
    [1, 1],
  ]);
  expect(yearFlagOf(mid2028)?.items.map((i) => [i.sourceId, i.open])).toEqual([[advanceSplit, true]]);
  expect(yearFlagOf(mid2027)?.items.map((i) => [i.sourceId, i.open])).toEqual([[baseSplit, false]]);

  // 3b. The recorded due day 3: enough as the person's statement; its evidence recommended, then named in an amend.
  const reference = await json<{ rentalContractReferenceId: string; evidenceRecommended: boolean }>(
    await A('POST', '/rental-contract-references', { mreTenantId: s.tenant, rentDueDays: [{ validFrom: '2027-01-01', day: 3 }] }),
    201,
  );
  expect(reference.evidenceRecommended).toBe(true);
  const evidence = 'Mietvertrag Beispiel, § 4 Abs. 1 (synthetisch)';
  const amended = await json<{ evidenceRecommended: boolean; version: number; rentDueDays: unknown[] }>(
    await A(
      'POST',
      `/rental-contract-references/${reference.rentalContractReferenceId}/amend`,
      { rentDueDays: [{ validFrom: '2027-01-01', day: 3, evidenceReference: evidence }] },
      { 'if-match': '"1"' },
    ),
    200,
  );
  expect(amended).toMatchObject({ evidenceRecommended: false, version: 2, rentDueDays: [{ validFrom: '2027-01-01', day: 3, evidenceReference: evidence }] });
  // The history: the evidence change is recorded, and it is no attribution input (no changedEntries).
  const audit = await s.pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY new_version`, [
    reference.rentalContractReferenceId,
  ]);
  expect(
    audit.rows.map((r: { action: string; metadata: Record<string, unknown> }) => [
      r.action,
      r.metadata['changedFields'] ?? null,
      r.metadata['changedEntries'] ?? null,
    ]),
  ).toEqual([
    ['CREATED', null, null],
    ['AMENDED', ['rentDueDays'], null],
  ]);
  expect(audit.rows[1]?.metadata.changedEvidence).toEqual([{ validFrom: '2027-01-01', from: null, to: evidence }]);

  // Afterwards: both splits in 2028, by the decision and by the recorded due date; no proposal left in either year.
  const [end2027, end2028] = await both();
  expect([figures(end2027).einnahmen, figures(end2028).einnahmen]).toEqual([
    ['0.00', {}],
    ['800.00', { RENT: '700.00', OPERATING_COST_ADVANCES: '100.00' }],
  ]);
  expect(ours(end2028).map((i) => [i.sourceId, codes(i.flags)])).toEqual([
    [baseSplit, ['ATTRIBUTED_BY_10_DAY_RULE']],
    [advanceSplit, ['ATTRIBUTED_BY_10_DAY_RULE']],
  ]);
  expect(ours(end2028)[1]?.flags[0]?.details).toMatchObject({ dueDate: '2028-01-03', dueDateSource: 'RENTAL_CONTRACT_REFERENCE', dueDateEvidence: evidence });
  expect([levels(end2027), levels(end2028), yearFlagOf(end2027), yearFlagOf(end2028)]).toEqual([[0, 0], [0, 0], undefined, undefined]);
}
