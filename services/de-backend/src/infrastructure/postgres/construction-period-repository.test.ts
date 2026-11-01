import { describe, expect, it } from 'vitest';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { buildTaxYearView, type TaxYearView } from '../../domains/taxation/index.js';
import { capitalizedItemsIn } from './capitalized-items.js';
import { REALM, OTHER_REALM, actor, databaseUrl, day, facts, useConstructionDatabase } from './construction-period.test-support.js';
import { capitalizedSources, readTaxYear, taxYearSnapshot } from './tax-year-reads.js';

/**
 * VC-X-36 persistence (api-design.md §59E): the record's commands with their AuditRecords, idempotency, `If-Match` and
 * Realm isolation; a classification's five checks through the repository, each refusal leaving cash, classification and
 * record unchanged; the two disjoint reads of the capitalised sources (a PropertyReference's split and a Loan's split
 * each once, P's part per PropertyReference, a classification superseded twice one source); the adapter refusing a
 * source read twice; the view's one snapshot. Synthetic data.
 */
const today = day('2029-10-15');

describe.skipIf(databaseUrl === undefined)('construction-period records and capitalised Loan interest (§59E)', () => {
  const ctx = useConstructionDatabase('construction_period_repository_test');
  const viewOf = async (pr: string, year: number, ownerPartyId: string | null = null): Promise<TaxYearView> => {
    const read = await ctx.classifications.readTaxYear(pr, REALM, year, ownerPartyId, today);
    if (read === undefined) throw new Error('no PropertyReference');
    const outcome = buildTaxYearView(read, { year, ownerPartyId, today, registry: TAX_RULES });
    if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
    return outcome.view;
  };
  const sourcesOf = (pr: string, realm = REALM) =>
    taxYearSnapshot(ctx.db, (trx) => capitalizedItemsIn(trx, realm, pr, today, (t, r, p, d, also) => capitalizedSources(t, TAX_RULES, r, p, d, also)));
  const audit = async (id: string) =>
    (await ctx.pool.query(`SELECT action, previous_version, new_version FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [id])).rows;

  it('create, find, list, amend (a changed fact resets), confirm, void: AuditRecords, If-Match, idempotency, Realm isolation', async () => {
    const [p1, p2] = [await ctx.propertyReference(), await ctx.propertyReference()];
    const { loanId } = await ctx.loan([[p1, 1n, 1n]]);
    const key = { key: 'cpi-1', fingerprint: 'f1' };
    const created = await ctx.records.create(facts([p2, p1], { loanId }), actor, key);
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const r = created.record;
    expect([r.propertyReferenceIds, r.reviewState, r.status, r.version, r.loanId]).toEqual([[p1, p2].sort(), 'UNREVIEWED', 'VALID', 1, loanId]);
    expect(await ctx.records.create(facts([p1], { loanId }), actor, key)).toEqual({ kind: 'REPLAYED', record: r });
    expect((await ctx.records.create(facts([p1], { loanId }), actor, { key: 'cpi-1', fingerprint: 'f2' })).kind).toBe('IDEMPOTENCY_CONFLICT');
    expect((await ctx.records.create(facts([p1], { loanId: (await ctx.loan(null, '2028-01-01', OTHER_REALM)).loanId }), actor)).kind).toBe('LOAN_NOT_FOUND');
    expect((await ctx.records.create(facts([await ctx.propertyReference(OTHER_REALM)]), actor)).kind).toBe('PROPERTY_REFERENCE_NOT_FOUND');

    const confirmed = await ctx.records.confirm(r.id, REALM, { reviewState: 'CONFIRMED', advisorPartyId: null }, actor, [1]);
    expect(confirmed).toMatchObject({ kind: 'CHANGED', changed: true, record: { reviewState: 'CONFIRMED', version: 2 } });
    expect(await ctx.records.amend(r.id, REALM, { notes: 'Bauvertrag nachgereicht' }, actor, [1])).toMatchObject({
      kind: 'VERSION_CONFLICT',
      currentVersion: 2,
    });
    // notes keep the confirmation; the funds share resets it (never carried under an old confirmation).
    expect(await ctx.records.amend(r.id, REALM, { notes: 'Bauvertrag nachgereicht' }, actor, [2])).toMatchObject({
      record: { reviewState: 'CONFIRMED', version: 3 },
    });
    const amended = await ctx.records.amend(r.id, REALM, { buildingFundsShare: { numerator: 4n, denominator: 5n }, propertyReferenceIds: [p1] }, actor);
    expect(amended).toMatchObject({
      kind: 'CHANGED',
      record: { reviewState: 'UNREVIEWED', propertyReferenceIds: [p1], buildingFundsShare: { numerator: 4n, denominator: 5n } },
    });
    const advisor = await ctx.party('Steuerberaterin (synthetisch)');
    expect(await ctx.records.confirm(r.id, REALM, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor }, actor)).toMatchObject({
      record: { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor },
    });
    expect((await ctx.records.confirm(r.id, REALM, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: await ctx.party('X', OTHER_REALM) }, actor)).kind).toBe(
      'PARTY_NOT_FOUND',
    );
    expect((await ctx.records.amend(r.id, OTHER_REALM, { notes: 'x' }, actor)).kind).toBe('NOT_FOUND');
    expect(await ctx.records.find(r.id, OTHER_REALM)).toBeUndefined();
    expect(await ctx.records.list(OTHER_REALM, {})).toEqual([]);
    expect((await ctx.records.list(REALM, { propertyReferenceId: p2 })).map((x) => x.id)).not.toContain(r.id);
    expect((await ctx.records.list(REALM, { loanId, propertyReferenceId: p1 })).map((x) => x.id)).toEqual([r.id]);
    expect(await ctx.records.void(r.id, REALM, 'doppelt erfasst', actor)).toMatchObject({ record: { status: 'VOID', voidReason: 'doppelt erfasst' } });
    expect((await ctx.records.amend(r.id, REALM, { notes: 'x' }, actor)).kind).toBe('RECORD_VOID');
    expect((await ctx.records.void(r.id, REALM, 'nochmal', actor)).kind).toBe('RECORD_VOID');
    expect((await audit(r.id)).map((a) => a.action)).toEqual(['CREATED', 'CONFIRMED', 'AMENDED', 'AMENDED', 'CONFIRMED', 'VOIDED']);
  });

  it('a classification’s five checks in order through the repository; each refusal leaves cash, classification and record unchanged', async () => {
    const [pr, elsewhere] = [await ctx.propertyReference(), await ctx.propertyReference()];
    const { loanId } = await ctx.loan([[pr, 1n, 1n]]);
    const other = await ctx.loan([[pr, 1n, 1n]]);
    const {
      splitIds: [interest, repair],
    } = await ctx.booked([ctx.split('100.00', 'LOAN_INTEREST', { loanId }), ctx.split('70.00', 'MAINTENANCE', { propertyReferenceId: pr })], '2028-03-31');
    const record = await ctx.record(facts([pr], { loanId }), false);
    const deductible = await ctx.record(facts([pr], { loanId, advanceExpenseDeductible: true }));
    const ofOther = await ctx.record(facts([elsewhere], { loanId: other.loanId }));
    const voided = await ctx.record(facts([pr], { loanId }));
    await ctx.records.void(voided.id, REALM, 'falsch', actor);
    const state = async () => ({
      cash: (await ctx.pool.query(`SELECT to_jsonb(s) AS r FROM transaction_split s WHERE id = $1`, [interest])).rows,
      classifications: (await ctx.pool.query(`SELECT count(*)::int AS n FROM tax_classification WHERE transaction_split_id = $1`, [interest])).rows,
      records: (await ctx.pool.query(`SELECT id, version FROM construction_period_interest ORDER BY id`)).rows,
    });
    const before = await state();
    expect(await ctx.classify(interest as string, {})).toMatchObject({ kind: 'TREATMENT_NOT_ALLOWED', reason: 'CONSTRUCTION_PERIOD_INTEREST_REQUIRED' });
    expect(await ctx.classify(interest as string, { taxCategory: 'MAINTENANCE' })).toMatchObject({ reason: 'CONSTRUCTION_PERIOD_INTEREST_REQUIRED' });
    expect((await ctx.classify(interest as string, { constructionPeriodInterestId: '0000cccc-0000-4000-8000-00000000ffff' })).kind).toBe(
      'CONSTRUCTION_PERIOD_INTEREST_NOT_FOUND',
    );
    expect((await ctx.classify(interest as string, { constructionPeriodInterestId: voided.id })).kind).toBe('CONSTRUCTION_PERIOD_INTEREST_VOID');
    expect(await ctx.classify(interest as string, { constructionPeriodInterestId: ofOther.id })).toMatchObject({
      kind: 'CONSTRUCTION_PERIOD_INTEREST_MISMATCH',
      loanId,
      recordLoanId: other.loanId,
    });
    expect((await ctx.classify(interest as string, { constructionPeriodInterestId: deductible.id })).kind).toBe('CONSTRUCTION_PERIOD_INTEREST_DEDUCTIBLE');
    expect(await ctx.classify(repair as string, { taxCategory: 'MAINTENANCE', constructionPeriodInterestId: record.id })).toMatchObject({
      kind: 'CONSTRUCTION_PERIOD_INTEREST_MISMATCH',
    });
    expect(await state()).toEqual(before);
    // Another Realm's record is unknown here.
    const foreign = await ctx.record({ ...facts([await ctx.propertyReference(OTHER_REALM)]), mreRealmId: OTHER_REALM }, false);
    expect((await ctx.classify(interest as string, { constructionPeriodInterestId: foreign.id })).kind).toBe('CONSTRUCTION_PERIOD_INTEREST_NOT_FOUND');
    // Counter-check: an UNREVIEWED record is enough to classify (not to be a source); the link and DE_CONSTRUCTION_PERIOD_INTEREST@1 stored.
    const created = await ctx.classify(interest as string, { constructionPeriodInterestId: record.id });
    expect(created).toMatchObject({
      kind: 'CREATED',
      classification: { constructionPeriodInterestId: record.id, treatmentRule: { ruleCode: 'DE_CONSTRUCTION_PERIOD_INTEREST', version: 1 } },
    });
    expect((await ctx.records.find(record.id, REALM))?.classifications).toMatchObject([{ splitId: interest, treatment: 'CAPITALIZED', current: true }]);
  });

  it('the two reads are disjoint: a PropertyReference’s and a Loan’s split of one Transaction each once; P’s part per PropertyReference; superseded twice, one source', async () => {
    const [p1, p2] = [await ctx.propertyReference(), await ctx.propertyReference()];
    const [a, b, c] = [await ctx.party('A'), await ctx.party('B'), await ctx.party('C')];
    await ctx.owner(p1, a, [3, 5]);
    await ctx.owner(p1, b, [2, 5]);
    await ctx.owner(p2, c, [1, 1]);
    const { loanId } = await ctx.loan([
      [p1, 3n, 5n],
      [p2, 2n, 5n],
    ]);
    const loanRecord = await ctx.record(facts([p1, p2], { loanId }));
    const prRecord = await ctx.record(facts([p1]));
    const first = await ctx.booked(
      [ctx.split('500.00', 'LOAN_INTEREST', { loanId }), ctx.split('40.00', 'LOAN_INTEREST', { propertyReferenceId: p1 })],
      '2028-03-31',
    );
    const second = await ctx.booked([ctx.split('450.01', 'LOAN_INTEREST', { loanId })], '2028-06-30');
    const [loanSplit, prSplit] = first.splitIds as [string, string];
    const later = second.splitIds[0] as string;
    await ctx.classify(loanSplit, { constructionPeriodInterestId: loanRecord.id });
    await ctx.classify(prSplit, { constructionPeriodInterestId: prRecord.id });
    // Superseded twice: still one source.
    const deductible = await ctx.classify(later, { treatment: 'DEDUCTIBLE', constructionPeriodInterestId: loanRecord.id });
    if (deductible.kind !== 'CREATED') throw new Error(deductible.kind);
    const again = await ctx.classify(later, { treatment: 'DEDUCTIBLE', supersedes: deductible.classification.id });
    if (again.kind !== 'CREATED') throw new Error(again.kind);
    await ctx.classify(later, { constructionPeriodInterestId: loanRecord.id, supersedes: again.classification.id });

    const ofP1 = await sourcesOf(p1);
    // The PropertyReference's own splits first, then the Loans' (two disjoint reads), each once.
    expect(ofP1.map((i) => [i.sourceId, i.lineAmount.amount, i.loan?.share ?? null, i.constructionPeriodInterestId])).toEqual([
      [prSplit, '40.00', null, prRecord.id],
      [loanSplit, '300.00', '3/5', loanRecord.id],
      [later, '270.01', '3/5', loanRecord.id],
    ]);
    expect(ofP1.find((i) => i.sourceId === later)?.parts.map((p) => [p.participant, p.amount.amount])).toEqual([
      [a, '162.01'],
      [b, '108.00'],
    ]);
    const ofP2 = await sourcesOf(p2);
    expect(ofP2.map((i) => [i.sourceId, i.lineAmount.amount])).toEqual([
      [loanSplit, '200.00'],
      [later, '180.00'],
    ]);
    // Over both buildings the Loan's splits once: 950.01.
    const loanTotal = [...ofP1, ...ofP2].filter((i) => i.loan !== null && i.loan !== undefined).reduce((s, i) => s + Number(i.lineAmount.amount), 0);
    expect(loanTotal.toFixed(2)).toBe('950.01');
    // The adapter refuses a source read twice (a constructed reader breaking 0027), never two components.
    await expect(
      taxYearSnapshot(ctx.db, async (trx) =>
        capitalizedItemsIn(trx, REALM, p1, today, async (t, r, p, d, also) => {
          const read = await capitalizedSources(t, TAX_RULES, r, p, d, also);
          return [...read, read[0] as (typeof read)[number]];
        }),
      ),
    ).rejects.toThrow(/read twice/);
    // A set appended from a later validFrom (P1 1/1) leaves the parts by the booking date's set unchanged.
    await ctx.appendSet(loanId, [[p1, 1n, 1n]], '2029-01-01');
    expect((await sourcesOf(p1)).map((i) => i.lineAmount.amount)).toEqual(['40.00', '300.00', '270.01']);
    expect((await sourcesOf(p2)).map((i) => i.lineAmount.amount)).toEqual(['200.00', '180.00']);
    // Realm isolation: another Realm reads nothing of P1.
    expect(await sourcesOf(p1, OTHER_REALM)).toEqual([]);
  });

  it('a classification stored before 0055 (no record) stays readable and flagged CONSTRUCTION_PERIOD_INTEREST_MISSING; a confirmed record without a building: NO_COMPONENT', async () => {
    const pr = await ctx.propertyReference();
    await ctx.owner(pr, await ctx.party('Eigentümerin'), [1, 1]);
    const { loanId } = await ctx.loan([[pr, 1n, 1n]]);
    const {
      splitIds: [old, current],
    } = await ctx.booked([ctx.split('100.00', 'LOAN_INTEREST', { loanId }), ctx.split('50.00', 'LOAN_INTEREST', { loanId })], '2028-03-31');
    // As stored before 0055: the guard did not exist yet.
    await ctx.pool.query(`ALTER TABLE tax_classification DISABLE TRIGGER tax_classification_construction_period`);
    try {
      await ctx.pool.query(
        `INSERT INTO tax_classification (mre_realm_id, source_type, transaction_split_id, tax_category, treatment, review_state, rule_code, rule_version, created_by)
         VALUES ($1, 'TRANSACTION_SPLIT', $2, 'LOAN_INTEREST', 'CAPITALIZED', 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x')`,
        [REALM, old],
      );
    } finally {
      await ctx.pool.query(`ALTER TABLE tax_classification ENABLE TRIGGER tax_classification_construction_period`);
    }
    const record = await ctx.record(facts([pr], { loanId }));
    await ctx.classify(current as string, { constructionPeriodInterestId: record.id });
    const v = await viewOf(pr, 2028);
    const reasons = Object.fromEntries(
      v.capitalized.items.map((i) => [
        i.sourceId,
        (i.flags.find((f) => f.code === 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS')?.details as { reason?: string })?.reason,
      ]),
    );
    expect(reasons).toEqual({ [old as string]: 'CONSTRUCTION_PERIOD_INTEREST_MISSING', [current as string]: 'NO_COMPONENT' });
    expect(v.review.final).toBe(false);
  });

  it('concurrency: a classification’s create waits on a void of its record in progress and is then refused (VOID); a create first holds the void back', async () => {
    const pr = await ctx.propertyReference();
    const { loanId } = await ctx.loan([[pr, 1n, 1n]]);
    const {
      splitIds: [first, second],
    } = await ctx.booked([ctx.split('100.00', 'LOAN_INTEREST', { loanId }), ctx.split('50.00', 'LOAN_INTEREST', { loanId })], '2028-03-31');
    const record = await ctx.record(facts([pr], { loanId }));
    const waiting = async (text: string) => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const { rows } = await ctx.pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`, [`%${text}%`]);
        if (rows.length > 0) return;
        if (Date.now() > deadline) throw new Error('not waiting');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    // The void in progress holds the record's row: the create waits, then sees VOID.
    const holder = await ctx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE construction_period_interest SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [
        record.id,
      ]);
      const create = ctx.classify(first as string, { constructionPeriodInterestId: record.id });
      await waiting('construction_period_interest');
      await holder.query('COMMIT');
      expect((await create).kind).toBe('CONSTRUCTION_PERIOD_INTEREST_VOID');
    } finally {
      holder.release();
    }
    // The other order: a create in progress (its no-op on the record written) holds the void back until it commits.
    const other = await ctx.record(facts([pr], { loanId }));
    const creator = await ctx.pool.connect();
    try {
      await creator.query('BEGIN');
      await creator.query(`UPDATE construction_period_interest SET version = version WHERE id = $1`, [other.id]);
      const voiding = ctx.records.void(other.id, REALM, 'falsch', actor);
      await waiting('construction_period_interest');
      await creator.query(
        `INSERT INTO tax_classification (mre_realm_id, source_type, transaction_split_id, tax_category, treatment, review_state, rule_code, rule_version, created_by,
           construction_period_interest_id, treatment_rule_code, treatment_rule_version)
         VALUES ($1, 'TRANSACTION_SPLIT', $2, 'LOAN_INTEREST', 'CAPITALIZED', 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x', $3, 'DE_CONSTRUCTION_PERIOD_INTEREST', 1)`,
        [REALM, second, other.id],
      );
      await creator.query('COMMIT');
      expect((await voiding).kind).toBe('CHANGED');
    } finally {
      creator.release();
    }
    // The classification committed before the void names a record now VOID: no source (RECORD_VOID).
    expect((await ctx.records.find(other.id, REALM))?.classifications.map((c) => c.splitId)).toEqual([second]);
  });

  it('one snapshot: a record confirmed between the view’s own reads and the AfA’s is seen by neither', async () => {
    const pr = await ctx.propertyReference();
    await ctx.owner(pr, await ctx.party('Eigentümerin'), [1, 1]);
    const { loanId } = await ctx.loan([[pr, 1n, 1n]]);
    const {
      splitIds: [split],
    } = await ctx.booked([ctx.split('100.00', 'LOAN_INTEREST', { loanId })], '2028-03-31');
    const record = await ctx.record(facts([pr], { loanId }), false);
    await ctx.classify(split as string, { constructionPeriodInterestId: record.id });
    const read = await readTaxYear(ctx.db, TAX_RULES, pr, REALM, 2028, null, today, undefined, async () => {
      expect((await ctx.records.confirm(record.id, REALM, { reviewState: 'CONFIRMED', advisorPartyId: null }, actor)).kind).toBe('CHANGED');
    });
    if (read === undefined) throw new Error('no read');
    expect(read.interest?.get(split as string)?.record?.reviewState).toBe('UNREVIEWED');
    const outcome = buildTaxYearView(read, { year: 2028, ownerPartyId: null, today, registry: TAX_RULES });
    if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
    expect(outcome.view.capitalized.items[0]?.flags.find((f) => f.code === 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS')?.details).toMatchObject({
      reason: 'RECORD_NOT_CONFIRMED',
    });
    // After it: the record is confirmed, the source counts (no building: NO_COMPONENT).
    expect((await viewOf(pr, 2028)).capitalized.items[0]?.flags.find((f) => f.code === 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS')?.details).toMatchObject({
      reason: 'NO_COMPONENT',
    });
  });
});
