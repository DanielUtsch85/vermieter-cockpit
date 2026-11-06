import { describe, expect, it } from 'vitest';
import { allocationFingerprint, plausibilityFlags, type LandBuildingAllocation } from '../../domains/acquisition/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { COMPARISON, OTHER_REALM, REALM, REASON, actor, databaseUrl, eur, usePlausibilityDatabase } from './land-building-plausibility.test-support.js';

/**
 * §58T (VC-X-44, migration 0075) through the repository: the round trip of every new column, the history judged row by
 * row in one snapshot (E1 `OPEN`, E2 `INFORMATIVE`), the replacement without `reviewState` (E2′, stored `UNREVIEWED`),
 * question 5 (an `ADVISOR_CONFIRMED` split closed without a reason; a replacement adding the reason stored as sent: the
 * fallback to `CONFIRMED` is the caller's, `ADVISOR_CONFIRMED` over that fallback is kept as asserted; the refusal of a
 * reason-only `ADVISOR_CONFIRMED` over `ADVISOR_CONFIRMED` is in land-building-advisor-reason-guard.test.ts), the AuditRecords, the
 * idempotency (a snapshot stored before §58T still replays) and Realm isolation. Synthetic data only.
 */
const levelOf = (a: LandBuildingAllocation) =>
  plausibilityFlags({ ...a, comparison: a.comparison ?? null, deviationReason: a.deviationReason ?? null }, TAX_RULES).map((f) => [
    f.code,
    f.level,
    f.details['closedBy'] ?? null,
  ]);
const DEVIATES = 'ALLOCATION_DEVIATES_FROM_COMPARISON';

describe.skipIf(databaseUrl === undefined)('the plausibility warning through the repository (§58T)', () => {
  const { ctx, party, acquisition, entered, created } = usePlausibilityDatabase('allocation_plausibility_repository_test');

  it('the round trip of every new column: the comparison exact, its sources, the reason; without them null', async () => {
    const a = await acquisition();
    const plain = await created(entered(a, null));
    expect([plain.comparison, plain.deviationReason]).toEqual([null, null]);
    expect(levelOf(plain)).toEqual([['ALLOCATION_PLAUSIBILITY_NOT_CHECKED', 'INFORMATIVE', null]]);
    const comparison = { ...COMPARISON, landValue: eur('120000.01'), buildingValue: eur('279999.99'), sourceReferences: ['Quelle A', 'Quelle B'] };
    const e = await created(entered(a, plain.id, { comparison, deviationReason: REASON }));
    const [read] = (await ctx.allocations.list(a, REALM))?.items ?? [];
    for (const row of [e, read]) {
      expect(row?.comparison?.method).toBe('BMF_TOOL');
      expect([row?.comparison?.landValue.toJSON(), row?.comparison?.buildingValue.toJSON(), row?.comparison?.sourceReferences]).toEqual([
        { amount: '120000.01', currency: 'EUR' },
        { amount: '279999.99', currency: 'EUR' },
        ['Quelle A', 'Quelle B'],
      ]);
      expect(row?.deviationReason).toBe(REASON);
    }
    // Every figure as entered; nothing derived is stored.
    expect([e.totalAllocableAmount.amount, e.landAmount.amount, e.buildingAmount.amount]).toEqual(['400000.00', '40000.00', '360000.00']);
  });

  it('the history in one snapshot: E1 OPEN, E2 with the reason INFORMATIVE; each judged by its own data; AuditRecords', async () => {
    const a = await acquisition();
    const e1 = await created(entered(a, null, { comparison: COMPARISON }));
    expect(levelOf(e1)).toEqual([[DEVIATES, 'OPEN', null]]);
    const e2 = await created(entered(a, e1.id, { comparison: COMPARISON, deviationReason: REASON }));
    const list = await ctx.allocations.list(a, REALM);
    expect(list?.current?.id).toBe(e2.id);
    expect(list?.items.map((i) => [i.id, i.current, ...levelOf(i)])).toEqual([
      [e2.id, true, [DEVIATES, 'INFORMATIVE', 'DEVIATION_REASON']],
      [e1.id, false, [DEVIATES, 'OPEN', null]],
    ]);
    const audits = async (id: string) =>
      (await ctx.pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, action`, [id])).rows;
    expect(await audits(e2.id)).toEqual([
      {
        action: 'CREATED',
        metadata: expect.objectContaining({
          supersedes: e1.id,
          comparison: {
            method: 'BMF_TOOL',
            landValue: { amount: '120000.00', currency: 'EUR' },
            buildingValue: { amount: '280000.00', currency: 'EUR' },
            sourceReferences: COMPARISON.sourceReferences,
          },
          deviationReason: REASON,
        }),
      },
    ]);
    expect((await audits(e1.id)).map((r) => [r.action, r.metadata.supersededById ?? null, r.metadata.deviationReason ?? null])).toEqual([
      ['CREATED', null, null],
      ['SUPERSEDED', e2.id, null],
    ]);
    // A plain allocation's AuditRecord names both as null.
    const plain = await created(entered(await acquisition(), null));
    expect((await audits(plain.id))[0]?.metadata).toMatchObject({ comparison: null, deviationReason: null });
  });

  it('E2′: the replacement with the reason but without reviewState is stored UNREVIEWED (§27.3 default), its flag INFORMATIVE', async () => {
    const a = await acquisition();
    const e1 = await created(entered(a, null, { comparison: COMPARISON }));
    // The API passes UNREVIEWED when the body omits reviewState (api/land-building-allocations.ts); nothing is inherited.
    const e2 = await created(entered(a, e1.id, { comparison: COMPARISON, deviationReason: REASON, reviewState: 'UNREVIEWED' }));
    expect([e1.reviewState, e2.reviewState]).toEqual(['CONFIRMED', 'UNREVIEWED']);
    expect(levelOf(e2)).toEqual([[DEVIATES, 'INFORMATIVE', 'DEVIATION_REASON']]);
  });

  it('question 5: ADVISOR_CONFIRMED without a reason INFORMATIVE; a replacement adding a reason falls back to CONFIRMED unless re-confirmed', async () => {
    const a = await acquisition();
    const advisor = await party('Steuerberaterin S (synthetisch)');
    const e1 = await created(entered(a, null, { comparison: COMPARISON, reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor }));
    expect(levelOf(e1)).toEqual([[DEVIATES, 'INFORMATIVE', 'ADVISOR_CONFIRMED']]);
    // The fallback: the user repeats every field but the advisor's confirmation, so the row is CONFIRMED by the user.
    const e2 = await created(entered(a, e1.id, { comparison: COMPARISON, deviationReason: REASON, reviewState: 'CONFIRMED' }));
    expect([e2.reviewState, e2.advisorPartyId, ...levelOf(e2)]).toEqual(['CONFIRMED', null, [DEVIATES, 'INFORMATIVE', 'DEVIATION_REASON']]);
    // The re-confirmation: a replacement sending ADVISOR_CONFIRMED is stored as sent. DE does not verify that the advisor
    // gave it (as for every allocation since §27.3); the row closes by the review state, the reason is kept.
    const e3 = await created(entered(a, e2.id, { comparison: COMPARISON, deviationReason: REASON, reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor }));
    expect([e3.reviewState, e3.advisorPartyId, ...levelOf(e3)]).toEqual(['ADVISOR_CONFIRMED', advisor, [DEVIATES, 'INFORMATIVE', 'ADVISOR_CONFIRMED']]);
    // Counter-check: the history still shows each row as it was.
    expect((await ctx.allocations.list(a, REALM))?.items.map((i) => i.reviewState)).toEqual(['ADVISOR_CONFIRMED', 'CONFIRMED', 'ADVISOR_CONFIRMED']);
  });

  it('idempotency: a replay keeps the comparison; another reason under the same key is a conflict; a snapshot stored before 0075 replays with null', async () => {
    const a = await acquisition();
    const request = entered(a, null, { comparison: COMPARISON, deviationReason: REASON });
    const key = { key: 'x44-1', fingerprint: allocationFingerprint(request) };
    const first = await ctx.allocations.create(request, actor, key);
    expect(await ctx.allocations.create(request, actor, key)).toEqual({ ...first, kind: 'REPLAYED' });
    const other = { ...request, deviationReason: 'ein anderer Grund (synthetisch)' };
    expect((await ctx.allocations.create(other, actor, { key: 'x44-1', fingerprint: allocationFingerprint(other) })).kind).toBe('IDEMPOTENCY_CONFLICT');
    // A key stored before §58T: neither field in the snapshot; its fingerprint as before (no comparison in the body).
    const b = await acquisition();
    const old = entered(b, null);
    const oldKey = { key: 'x44-old', fingerprint: allocationFingerprint(old) };
    const stored = await ctx.allocations.create(old, actor, oldKey);
    await ctx.pool.query(`UPDATE idempotency_key SET result = result - 'comparison' - 'deviationReason' WHERE key = 'x44-old'`);
    const replay = await ctx.allocations.create(old, actor, oldKey);
    expect(replay).toEqual({ ...stored, kind: 'REPLAYED' });
    expect(replay.kind === 'REPLAYED' ? [replay.allocation.comparison, replay.allocation.deviationReason] : []).toEqual([null, null]);
  });

  it.each([
    ['landValue', { landValue: eur('120000.01') }],
    ['buildingValue', { buildingValue: eur('280000.01') }],
    ['sourceReferences', { sourceReferences: ['Gutachten 2026-09-01 (synthetisch)'] }],
  ] as const)('idempotency: the same key with another comparison %s is a conflict, nothing written', async (field, change) => {
    const a = await acquisition();
    const request = entered(a, null, { comparison: COMPARISON });
    const key = `x44-${field}`;
    const first = await ctx.allocations.create(request, actor, { key, fingerprint: allocationFingerprint(request) });
    expect(first.kind).toBe('CREATED');
    const other = { ...request, comparison: { ...COMPARISON, ...change } };
    expect((await ctx.allocations.create(other, actor, { key, fingerprint: allocationFingerprint(other) })).kind).toBe('IDEMPOTENCY_CONFLICT');
    expect((await ctx.allocations.list(a, REALM))?.items).toHaveLength(1);
  });

  it('Realm isolation: another Realm reads nothing and writes nothing on this Acquisition', async () => {
    const a = await acquisition();
    await created(entered(a, null, { comparison: COMPARISON }));
    expect(await ctx.allocations.list(a, OTHER_REALM)).toBeUndefined();
    const foreign = await ctx.allocations.create({ ...entered(a, null, { comparison: COMPARISON }), mreRealmId: OTHER_REALM }, actor);
    expect(foreign.kind).toBe('ACQUISITION_NOT_FOUND');
    const other = await acquisition(OTHER_REALM);
    expect(await ctx.allocations.list(other, REALM)).toBeUndefined();
    expect((await ctx.allocations.list(a, REALM))?.items).toHaveLength(1);
  });
});
