import { describe, expect, it } from 'vitest';
import {
  DE_RECORDING_STAGES_V1,
  deriveSchedule,
  inputFingerprint,
  liveSchedule,
  planRecord,
  yearStages,
  type RecordingStage,
  type ScheduleRead,
  type StageRule,
} from '../../domains/depreciation/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { centsOf } from '../../shared/index.js';
import { sha256Fingerprinter } from '../hashing/index.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { databaseUrl } from './depreciation-asset.test-support.js';
import { PostgresScheduleVersionRepository } from './depreciation-schedule-version-repository.js';
import { AT, NOW, OTHER_REALM, REALM, actor, day, eur, useSeparateAssetDatabase } from './depreciation-separate-asset.test-support.js';
import { PostgresLandBuildingAllocationRepository } from './land-building-allocation-repository.js';

/**
 * The owner's decision 3 of the third round on `SEVERAL_PURCHASES_PARTIAL_SALE` against PostgreSQL (Entscheidung des
 * Projektinhabers, 2026-11-02; api-design.md §60A "As implemented" 9), on the row model the database enforces (one row
 * per owner and day, §26.1, §28.1A), synthetic data only: A buys W (2020), sells 2/5 to B (Y, 2022: one purchase
 * active), buys them back (X, 2024) and sells 1/5 to C (Z, 2026: W and X active). The criterion starts in 2026 only; the
 * record command refuses 2026 at stage 1 (naming the criterion in 2026 only) with nothing written, a read writes nothing, and it records 2025 there, the same figures at stage 3; another
 * Realm sees and records nothing.
 */
const TODAY = day('2027-10-30');
const STAGE_TABLES = ['depreciation_schedule_version', 'depreciation_schedule_version_year', 'depreciation_schedule_entry', 'audit_record', 'idempotency_key'];

describe.skipIf(databaseUrl === undefined)('decision 3: the partial-sale criterion with several active purchases (PostgreSQL)', () => {
  const t = useSeparateAssetDatabase('recording_stage_layers_test');

  const read = async (assetId: string) => (await t.ctx.source.read(assetId, REALM, null)) as ScheduleRead;
  const counts = async () =>
    Object.fromEntries(
      await Promise.all(STAGE_TABLES.map(async (table) => [table, Number((await t.ctx.pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n)])),
    );
  const record = async (assetId: string, throughYear: number, releasedStage: RecordingStage, realm = REALM) => {
    const versions = new PostgresScheduleVersionRepository(t.ctx.db, t.ctx.classifications.capitalizedSources, NOW);
    const r = await t.ctx.source.read(assetId, REALM, null);
    const fingerprint =
      r === undefined
        ? '0'.repeat(64)
        : inputFingerprint(liveSchedule(r, TAX_RULES, sha256Fingerprinter, TODAY, throughYear).inputs, throughYear, sha256Fingerprinter);
    const request = { throughYear, reason: 'AfA laut Einkommensteuererklärung (synthetisch)', expectedInputFingerprint: fingerprint, acceptChangedYears: [] };
    return versions.record({
      assetId,
      mreRealmId: realm,
      actor,
      decide: (x) =>
        planRecord(x, request, { registry: TAX_RULES, fingerprinter: sha256Fingerprinter, today: TODAY, recordedBy: actor.actorId, releasedStage }),
    });
  };

  /** A DRAFT purchase of `pr` on `date` (contract and transfer), confirmed later by `confirm`. */
  async function draft(pr: string, date: string, share: [number, number], buyers: string[], sellers: string[]) {
    const created = await new PostgresAcquisitionRepository(t.ctx.db).create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        purchasePrice: eur('240000.00'),
        acquiredShare: { numerator: share[0], denominator: share[1] },
        contractDate: day(date),
        economicTransferDate: day(date),
        landRegistryTransferDate: null,
        buyerPartyIds: buyers,
        sellerPartyIds: sellers,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.acquisition.id;
  }
  async function confirm(id: string) {
    const outcome = await new PostgresAcquisitionRepository(t.ctx.db).confirm(id, REALM, AT, actor);
    if (outcome.kind !== 'CONFIRMED') throw new Error(JSON.stringify(outcome));
    const allocated = await new PostgresLandBuildingAllocationRepository(t.ctx.db).create(
      {
        mreRealmId: REALM,
        acquisitionId: id,
        totalAllocableAmount: eur('264000.00'),
        landAmount: eur('66000.00'),
        buildingAmount: eur('198000.00'),
        method: 'PURCHASE_CONTRACT',
        reviewState: 'CONFIRMED',
        effectiveDate: null,
        advisorPartyId: null,
        sourceReferences: [],
        notes: null,
        supersedes: null,
      },
      actor,
    );
    if (allocated.kind !== 'CREATED') throw new Error(allocated.kind);
  }
  async function row(pr: string, owner: string, share: [number, number], from: string, until: string | null, acquisitionId: string | null) {
    await t.ctx.pool.query(
      `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, valid_until, status, acquisition_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'VALID', $8, 'x')`,
      [REALM, pr, owner, share[0], share[1], from, until, acquisitionId],
    );
  }
  /** The layers; with `laterReduction` A also sells 1/5 to C in 2026. */
  async function layers(laterReduction: boolean) {
    const pr = await t.propertyReference();
    const [a, b, c] = [await t.party(), await t.party(), await t.party()];
    const w = await draft(pr, '2020-07-01', [1, 1], [a], []);
    const y = await draft(pr, '2022-07-01', [2, 5], [b], [a]);
    const x = await draft(pr, '2024-07-01', [2, 5], [a], [b]);
    const z = laterReduction ? await draft(pr, '2026-07-01', [1, 5], [c], [a]) : null;
    await row(pr, a, [1, 1], '2020-07-01', '2022-06-30', w);
    await row(pr, a, [3, 5], '2022-07-01', '2024-06-30', null);
    await row(pr, b, [2, 5], '2022-07-01', '2024-06-30', y);
    await row(pr, a, [1, 1], '2024-07-01', z === null ? null : '2026-06-30', x);
    if (z !== null) {
      await row(pr, a, [4, 5], '2026-07-01', null, null);
      await row(pr, c, [1, 5], '2026-07-01', null, z);
    }
    for (const id of [w, y, x, ...(z === null ? [] : [z])]) await confirm(id);
    const buildingId = await t.created(t.building(pr, [w, x, y, ...(z === null ? [] : [z])]));
    return { buildingId, w, x };
  }
  const severalIn = async (assetId: string, years: readonly number[]) => {
    const r = await read(assetId);
    const schedule = deriveSchedule({ ...r, today: TODAY, from: Math.min(...years), to: Math.max(...years), ownerPartyId: null }, TAX_RULES);
    return yearStages(schedule, r, years, DE_RECORDING_STAGES_V1 as StageRule).map((s) => [
      s.year,
      s.stage,
      s.components.filter((c) => c.criteria.includes('SEVERAL_PURCHASES_PARTIAL_SALE')).map((c) => c.componentId),
    ]);
  };
  const YEARS = [2021, 2022, 2023, 2024, 2025, 2026, 2027];

  it('a reduction with one purchase (2022) and a second purchase (2024), no later reduction: never; with one in 2026 from 2026 on', async () => {
    const once = await layers(false);
    expect(await severalIn(once.buildingId, YEARS)).toEqual(YEARS.map((year) => [year, 1, []]));
    const twice = await layers(true);
    const both = [`ACQUISITION:${twice.w}`, `ACQUISITION:${twice.x}`].sort();
    expect(await severalIn(twice.buildingId, YEARS)).toEqual([
      ...[2021, 2022, 2023, 2024, 2025].map((year) => [year, 1, []]),
      [2026, 3, both],
      [2027, 3, both],
    ]);
  });

  it('history: through 2026 refused at stage 1 with nothing written; through 2025 recorded at 1; 2026 at 3 with the same figures', async () => {
    const s = await layers(true);
    const before = await counts();
    const refused = await record(s.buildingId, 2026, 1);
    expect(refused).toMatchObject({ kind: 'REFUSED', refusal: { kind: 'STAGE_NOT_RELEASED', details: { releasedStage: 1 } } });
    // The refusal names the criterion only in its year: 2026 alone, on the two purchases of A.
    if (refused.kind !== 'REFUSED' || refused.refusal.kind !== 'STAGE_NOT_RELEASED') throw new Error(refused.kind);
    const named = (
      refused.refusal.details as { years: { year: number; stage: number; components: { componentId: string; criteria: string[] }[] }[] }
    ).years.map((y) => [y.year, y.stage, y.components.filter((c) => c.criteria.includes('SEVERAL_PURCHASES_PARTIAL_SALE')).map((c) => c.componentId)]);
    expect(named).toEqual([[2026, 3, [`ACQUISITION:${s.w}`, `ACQUISITION:${s.x}`].sort()]]);
    expect(await counts()).toEqual(before);
    // A read writes nothing either (no AuditRecord).
    await severalIn(s.buildingId, YEARS);
    expect(await counts()).toEqual(before);
    expect((await record(s.buildingId, 2025, 1)).kind).toBe('RECORDED');
    const v2 = await record(s.buildingId, 2026, 3);
    if (v2.kind !== 'RECORDED') throw new Error(v2.kind);
    const live = liveSchedule(await read(s.buildingId), TAX_RULES, sha256Fingerprinter, TODAY, 2026);
    const derived = live.schedule.years.filter((y) => y.year <= 2026).map((y) => [y.year, centsOf(y.amount as NonNullable<typeof y.amount>)]);
    expect(v2.version.years.map((y) => [y.year, y.amount])).toEqual(derived);
    expect(v2.version.years.reduce((sum, y) => sum + y.amount, 0n)).toBeGreaterThan(0n);
  });

  it('Realm isolation: another Realm sees nothing of the layers and cannot record them at any stage', async () => {
    const s = await layers(true);
    expect(await t.ctx.source.read(s.buildingId, OTHER_REALM, null)).toBeUndefined();
    const before = await counts();
    for (const stage of [1, 3] as const) expect((await record(s.buildingId, 2026, stage, OTHER_REALM)).kind).toBe('NOT_FOUND');
    expect(await counts()).toEqual(before);
  });
});
