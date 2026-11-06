import { describe, expect, it } from 'vitest';
import { allocationFingerprint, type NewAllocation } from '../../domains/acquisition/index.js';
import { COMPARISON, OTHER_REALM, REALM, REASON, actor, databaseUrl, eur, usePlausibilityDatabase } from './land-building-plausibility.test-support.js';

/**
 * §58T rule 3 as decided on 2026-11-06 (VC-X-44; Entscheidung des Projektinhabers, 2026-11-06) through the repository:
 * a supersede that sends `ADVISOR_CONFIRMED` over an `ADVISOR_CONFIRMED` row and differs from it only in the reason is
 * refused (`REVIEW_STATE_NOT_ALLOWED`), inside the transaction that reads the superseded row, and nothing is written:
 * no row, no AuditRecord, no idempotency key, the history unchanged. Changed amounts or a changed comparison are a
 * genuine re-confirmation and stored as sent; `CONFIRMED` passes; a `CONFIRMED` row superseded is not refused. Realm
 * isolation. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('the advisor reason-only supersede refused (§58T rule 3, decided 2026-11-06)', () => {
  const { ctx, party, acquisition, entered, created } = usePlausibilityDatabase('allocation_advisor_reason_guard_test');

  /** E1 advisor-confirmed with the comparison, no reason; and the reason-only supersede of it. */
  async function advisorConfirmed(realm = REALM) {
    const a = await acquisition(realm);
    const advisor = await party('Steuerberaterin S (synthetisch)', realm);
    const e1 = await created({ ...entered(a, null, { comparison: COMPARISON, reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor }), mreRealmId: realm });
    const reasonOnly: NewAllocation = {
      ...entered(a, e1.id, { comparison: COMPARISON, deviationReason: REASON, reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor }),
      mreRealmId: realm,
    };
    return { a, advisor, e1, reasonOnly };
  }
  const rowsOf = async (a: string) =>
    (
      await ctx.pool.query(
        `SELECT id, review_state, superseded_at IS NULL AS current, deviation_reason FROM land_building_allocation WHERE acquisition_id = $1 ORDER BY created_at, id`,
        [a],
      )
    ).rows;
  const auditsOf = async (a: string) =>
    (
      await ctx.pool.query(
        `SELECT entity_id, action, new_version FROM audit_record WHERE entity_type = 'LandBuildingAllocation'
           AND entity_id IN (SELECT id::text FROM land_building_allocation WHERE acquisition_id = $1) ORDER BY occurred_at, action`,
        [a],
      )
    ).rows;
  const auditCount = async () => Number((await ctx.pool.query(`SELECT count(*) FROM audit_record WHERE entity_type = 'LandBuildingAllocation'`)).rows[0].count);

  it('the narrow case: ADVISOR_CONFIRMED over ADVISOR_CONFIRMED, only the reason added, is REVIEW_STATE_NOT_ALLOWED and writes nothing', async () => {
    const { a, e1, reasonOnly } = await advisorConfirmed();
    const [rows, audits, all] = [await rowsOf(a), await auditsOf(a), await auditCount()];
    expect(await ctx.allocations.create(reasonOnly, actor)).toEqual({ kind: 'REVIEW_STATE_NOT_ALLOWED', supersededAllocationId: e1.id });
    // No row, no AuditRecord (neither CREATED nor SUPERSEDED), E1 still current.
    expect(await rowsOf(a)).toEqual(rows);
    expect(rows).toEqual([{ id: e1.id, review_state: 'ADVISOR_CONFIRMED', current: true, deviation_reason: null }]);
    expect(await auditsOf(a)).toEqual(audits);
    expect(await auditCount()).toBe(all);
    // Also with the effectiveDate sent explicitly (the resolved date is compared) and another advisor or other sources.
    for (const change of [{ effectiveDate: e1.effectiveDate }, { advisorPartyId: null }, { sourceReferences: ['anders (synthetisch)'] }, { notes: 'n' }]) {
      expect((await ctx.allocations.create({ ...reasonOnly, ...change }, actor)).kind).toBe('REVIEW_STATE_NOT_ALLOWED');
    }
    expect(await rowsOf(a)).toEqual(rows);
    expect(await auditCount()).toBe(all);
  });

  it('the history is unchanged after the 422, and the idempotency key is not claimed: the same key then takes CONFIRMED', async () => {
    const { a, reasonOnly } = await advisorConfirmed();
    const before = await ctx.allocations.list(a, REALM);
    const key = 'x44-guard-1';
    expect((await ctx.allocations.create(reasonOnly, actor, { key, fingerprint: allocationFingerprint(reasonOnly) })).kind).toBe('REVIEW_STATE_NOT_ALLOWED');
    // A retry with the same key and body is refused again, never replayed.
    expect((await ctx.allocations.create(reasonOnly, actor, { key, fingerprint: allocationFingerprint(reasonOnly) })).kind).toBe('REVIEW_STATE_NOT_ALLOWED');
    expect(await ctx.allocations.list(a, REALM)).toEqual(before);
    expect((await ctx.pool.query(`SELECT count(*) FROM idempotency_key WHERE key = $1`, [key])).rows[0].count).toBe('0');
    // Counter-check: the same key with CONFIRMED (the fallback) is a fresh create, not a conflict.
    const fallback = { ...reasonOnly, reviewState: 'CONFIRMED' as const, advisorPartyId: null };
    expect((await ctx.allocations.create(fallback, actor, { key, fingerprint: allocationFingerprint(fallback) })).kind).toBe('CREATED');
  });

  it.each([
    ['the amounts', { landAmount: eur('40000.01'), buildingAmount: eur('359999.99') }],
    ['the total', { totalAllocableAmount: eur('400000.01'), buildingAmount: eur('360000.01') }],
    ['the comparison values', { comparison: { ...COMPARISON, landValue: eur('125000.00') } }],
    ['the comparison method', { comparison: { ...COMPARISON, method: 'APPRAISAL' as const } }],
  ])('counter-check: %s changed with ADVISOR_CONFIRMED and a reason is a re-confirmation, stored as ADVISOR_CONFIRMED', async (_what, change) => {
    const { a, advisor, e1, reasonOnly } = await advisorConfirmed();
    const outcome = await ctx.allocations.create({ ...reasonOnly, ...change }, actor);
    expect(outcome.kind).toBe('CREATED');
    const e2 = outcome.kind === 'CREATED' ? outcome.allocation : undefined;
    expect([e2?.reviewState, e2?.advisorPartyId, e2?.deviationReason, e2?.supersedesId]).toEqual(['ADVISOR_CONFIRMED', advisor, REASON, e1.id]);
    expect((await rowsOf(a)).map((r) => [r.review_state, r.current])).toEqual([
      ['ADVISOR_CONFIRMED', false],
      ['ADVISOR_CONFIRMED', true],
    ]);
    expect((await auditsOf(a)).map((r) => r.action).sort()).toEqual(['CREATED', 'CREATED', 'SUPERSEDED']);
  });

  it('the same reason-only supersede with CONFIRMED goes through, stored CONFIRMED with its reason', async () => {
    const { a, e1, reasonOnly } = await advisorConfirmed();
    const e2 = await created({ ...reasonOnly, reviewState: 'CONFIRMED', advisorPartyId: null });
    expect([e2.reviewState, e2.advisorPartyId, e2.deviationReason, e2.supersedesId]).toEqual(['CONFIRMED', null, REASON, e1.id]);
    // Counter-check: the identical body with ADVISOR_CONFIRMED was the refused one.
    expect((await rowsOf(a)).map((r) => r.review_state)).toEqual(['ADVISOR_CONFIRMED', 'CONFIRMED']);
  });

  it('a CONFIRMED row superseded with ADVISOR_CONFIRMED and a reason is not refused (the advisor confirms the user split)', async () => {
    const a = await acquisition();
    const advisor = await party('Steuerberater T (synthetisch)');
    const e1 = await created(entered(a, null, { comparison: COMPARISON }));
    const e2 = await created(entered(a, e1.id, { comparison: COMPARISON, deviationReason: REASON, reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor }));
    expect([e1.reviewState, e2.reviewState, e2.deviationReason]).toEqual(['CONFIRMED', 'ADVISOR_CONFIRMED', REASON]);
    // Counter-check: superseding that ADVISOR_CONFIRMED row with only another reason is refused.
    const again = entered(a, e2.id, {
      comparison: COMPARISON,
      deviationReason: 'ein anderer Grund (synthetisch)',
      reviewState: 'ADVISOR_CONFIRMED',
      advisorPartyId: advisor,
    });
    expect(await ctx.allocations.create(again, actor)).toEqual({ kind: 'REVIEW_STATE_NOT_ALLOWED', supersededAllocationId: e2.id });
  });

  it('Realm isolation: Realm B cannot probe the guard on Realm A; its own narrow case is refused within B, A untouched', async () => {
    const { a, reasonOnly } = await advisorConfirmed();
    const rowsA = await rowsOf(a);
    // Realm B against A's Acquisition: not found, before any check of the superseded row.
    expect((await ctx.allocations.create({ ...reasonOnly, mreRealmId: OTHER_REALM, advisorPartyId: null }, actor)).kind).toBe('ACQUISITION_NOT_FOUND');
    const b = await advisorConfirmed(OTHER_REALM);
    expect((await ctx.allocations.create(b.reasonOnly, actor)).kind).toBe('REVIEW_STATE_NOT_ALLOWED');
    expect(await ctx.allocations.list(b.a, REALM)).toBeUndefined();
    expect(await rowsOf(a)).toEqual(rowsA);
    expect((await rowsOf(b.a)).map((r) => r.review_state)).toEqual(['ADVISOR_CONFIRMED']);
  });
});
