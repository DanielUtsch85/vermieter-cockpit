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
import { databaseUrl } from './depreciation-asset.test-support.js';
import { purchaseChecksIn } from './depreciation-purchase-checks.js';
import { PostgresScheduleVersionRepository } from './depreciation-schedule-version-repository.js';
import { NOW, OTHER_REALM, REALM, actor, day, useSeparateAssetDatabase } from './depreciation-separate-asset.test-support.js';

/**
 * The owner's decisions 236-1 and 236-4 on the release stage against PostgreSQL (Entscheidung des Projektinhabers,
 * 2026-11-02; api-design.md §60A "As implemented"), synthetic data only: the summed sources of the anschaffungsnahe
 * check read in the snapshot (`purchaseChecksIn`, `effectsOf` after VC-X-38), the stage they give before and after the
 * proposal is followed, a building whose kitchen is held by an ACTIVE separate asset, the record command refused at
 * stage 1 with nothing written (history untouched) and recorded at 2 with the same figures, and Realm isolation.
 */
const TODAY = day('2027-10-30');
const STAGE_TABLES = ['depreciation_schedule_version', 'depreciation_schedule_version_year', 'depreciation_schedule_entry', 'audit_record', 'idempotency_key'];

describe.skipIf(databaseUrl === undefined)('recording stages per the decisions 236-1 and 236-4 (PostgreSQL)', () => {
  const t = useSeparateAssetDatabase('recording_stage_decisions_test');

  const read = async (assetId: string, realm = REALM) => (await t.ctx.source.read(assetId, realm, null)) as ScheduleRead;
  const stages = async (assetId: string, years = [2026, 2027, 2028]) => {
    const r = await read(assetId);
    const schedule = deriveSchedule({ ...r, today: TODAY, from: 2026, to: 2028, ownerPartyId: null }, TAX_RULES);
    return yearStages(schedule, r, years, DE_RECORDING_STAGES_V1 as StageRule).map((y) => [y.year, y.stage, y.components.map((c) => [c.kind, c.criteria])]);
  };
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
  /** A building of a fresh purchase (transfer 2026-03-15, 15 % of 180,000.00 = 27,000.00) with a 30,000.00 repair of 2027, DEDUCTIBLE. */
  async function aboveThreshold() {
    const pr = await t.propertyReference();
    const { acquisitionId } = await t.purchase(pr);
    const buildingId = await t.created(t.building(pr, [acquisitionId]));
    const repair = await t.splitOf(pr, '30000.00', '2027-04-28');
    const deductible = await t.classify(repair, { treatment: 'DEDUCTIBLE' });
    return { pr, acquisitionId, buildingId, repair, deductible };
  }

  it('236-4: the summed source is read with its treatment; DEDUCTIBLE above the threshold is 2 from 2027 on, followed the item carries 2 itself', async () => {
    const s = await aboveThreshold();
    expect((await read(s.buildingId)).purchaseChecks).toEqual([
      {
        acquisitionId: s.acquisitionId,
        status: 'ABOVE_THRESHOLD',
        wegHausgeldMaintenanceNotCounted: false,
        summedSources: [{ taxYear: 2027, treatment: 'DEDUCTIBLE' }],
      },
    ]);
    expect(await stages(s.buildingId)).toEqual([
      [2026, 1, [['ACQUISITION', ['PURCHASE']]]],
      [2027, 2, [['ACQUISITION', ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN']]]],
      [2028, 2, [['ACQUISITION', ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN']]]],
    ]);
    // The proposal followed: the source capitalised on the check.
    await t.classify(s.repair, { treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: s.acquisitionId, supersedes: s.deductible });
    expect((await read(s.buildingId)).purchaseChecks?.[0]?.summedSources).toEqual([{ taxYear: 2027, treatment: 'CAPITALIZED' }]);
    expect(await stages(s.buildingId)).toEqual([
      [2026, 1, [['ACQUISITION', ['PURCHASE']]]],
      [
        2027,
        2,
        [
          ['ACQUISITION', ['PURCHASE']],
          ['CAPITALIZED_ITEM', ['CAPITALIZED_ITEM', 'ANSCHAFFUNGSNAHE_CAPITALIZATION']],
        ],
      ],
      [
        2028,
        2,
        [
          ['ACQUISITION', ['PURCHASE']],
          ['CAPITALIZED_ITEM', ['CAPITALIZED_ITEM', 'ANSCHAFFUNGSNAHE_CAPITALIZATION']],
        ],
      ],
    ]);
  });

  it('236-4 history: refused at stage 1 for the whole run with nothing written; an earlier throughYear and stage 2 record, the same figures', async () => {
    const s = await aboveThreshold();
    const before = await counts();
    const refused = await record(s.buildingId, 2027, 1);
    expect(refused).toMatchObject({
      kind: 'REFUSED',
      refusal: {
        kind: 'STAGE_NOT_RELEASED',
        details: {
          releasedStage: 1,
          years: [{ year: 2027, stage: 2, components: [{ kind: 'ACQUISITION', stage: 2, criteria: ['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN'] }] }],
        },
      },
    });
    expect(await counts()).toEqual(before);
    // 2026 is before the first summed source: stage 1 records it.
    expect((await record(s.buildingId, 2026, 1)).kind).toBe('RECORDED');
    const v2 = await record(s.buildingId, 2027, 2);
    if (v2.kind !== 'RECORDED') throw new Error(v2.kind);
    const live = liveSchedule(await read(s.buildingId), TAX_RULES, sha256Fingerprinter, TODAY, 2027);
    const derived = live.schedule.years.filter((y) => y.year <= 2027).map((y) => [y.year, centsOf(y.amount as NonNullable<typeof y.amount>)]);
    expect(v2.version.years.map((y) => [y.year, y.amount])).toEqual(derived);
    expect(v2.version.years.reduce((sum, y) => sum + y.amount, 0n)).toBeGreaterThan(0n);
  });

  it('236-1: the kitchen held by an ACTIVE separate asset raises nothing on the building; the separate asset is 2', async () => {
    const pr = await t.propertyReference();
    const { acquisitionId } = await t.purchase(pr);
    const buildingId = await t.created(t.building(pr, [acquisitionId]));
    const kitchenSplit = await t.capitalizedSplit(pr, '6000.00', '2027-04-28');
    const kitchenId = await t.created(t.kitchen(pr, [t.split(kitchenSplit)]));
    expect(await stages(buildingId, [2027, 2028])).toEqual([
      [2027, 1, [['ACQUISITION', ['PURCHASE']]]],
      [2028, 1, [['ACQUISITION', ['PURCHASE']]]],
    ]);
    expect(await stages(kitchenId, [2027, 2028])).toEqual([
      [2027, 2, [['CAPITALIZED_ITEM', ['MOVABLE_ASSET']]]],
      [2028, 2, [['CAPITALIZED_ITEM', ['MOVABLE_ASSET']]]],
    ]);
    expect((await record(buildingId, 2028, 1)).kind).toBe('RECORDED');
  });

  it('Realm isolation: another Realm sees neither the asset nor its checks, and cannot record it at any stage', async () => {
    const s = await aboveThreshold();
    expect(await t.ctx.source.read(s.buildingId, OTHER_REALM, null)).toBeUndefined();
    const ours = await read(s.buildingId);
    const theirs = await t.ctx.db.transaction().execute((trx) => purchaseChecksIn(trx, ours, OTHER_REALM, TODAY));
    expect(theirs).toEqual([]);
    const before = await counts();
    for (const stage of [1, 3] as const) expect((await record(s.buildingId, 2027, stage, OTHER_REALM)).kind).toBe('NOT_FOUND');
    expect(await counts()).toEqual(before);
  });
});
