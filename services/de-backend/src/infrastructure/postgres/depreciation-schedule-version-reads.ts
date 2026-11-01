import { sql, type Kysely, type Transaction } from 'kysely';
import type { ScheduleRead, ScheduleVersion, ScheduleVersionStatus } from '../../domains/depreciation/index.js';
import type { RuleRef } from '../../shared/index.js';
import { depreciationSnapshot, readAsset } from './depreciation-asset-reads.js';
import { UUID } from './depreciation-asset-rows.js';
import { HEADER, readVersions } from './depreciation-schedule-version-rows.js';
import type { Database } from './schema.js';

/**
 * The reads of recorded schedule versions (api-design.md §60 "Reads"): the list (stored data only), the single version
 * with the asset's schedule inputs for its comparison, the `CURRENT` version for the schedule read, and the start
 * check's references. Each in one `REPEATABLE READ READ ONLY` snapshot, every one filtered by the caller's Realm.
 */

type Trx = Transaction<Database>;

/** The asset's `CURRENT` version, whole (`depreciation_schedule_version_current`), or `null`. */
export async function currentVersionOf(trx: Trx, assetId: string): Promise<ScheduleVersion | null> {
  const { rows } = await sql<Record<string, unknown>>`
    SELECT ${HEADER} FROM depreciation_schedule_version v WHERE v.asset_id = ${assetId} AND v.status = 'CURRENT'
  `.execute(trx);
  return (await readVersions(trx, rows, true))[0] ?? null;
}

/** The `CURRENT` version locked `FOR UPDATE` (the record command's step 4 of its lock order), or `null`. */
export async function lockCurrentVersion(trx: Trx, assetId: string): Promise<ScheduleVersion | null> {
  await sql`SELECT id FROM depreciation_schedule_version WHERE asset_id = ${assetId} AND status = 'CURRENT' FOR UPDATE`.execute(trx);
  return currentVersionOf(trx, assetId);
}

export async function readVersionById(trx: Trx, versionId: string, full = true): Promise<ScheduleVersion | undefined> {
  const { rows } = await sql<Record<string, unknown>>`SELECT ${HEADER} FROM depreciation_schedule_version v WHERE v.id = ${versionId}`.execute(trx);
  return (await readVersions(trx, rows, full))[0];
}

export function listVersions(
  db: Kysely<Database>,
  assetId: string,
  mreRealmId: string,
  statuses: readonly ScheduleVersionStatus[] | null,
): Promise<readonly ScheduleVersion[] | undefined> {
  if (!UUID.test(assetId)) return Promise.resolve(undefined);
  return depreciationSnapshot(db, async (trx) => {
    if ((await readAsset(trx, assetId, mreRealmId)) === undefined) return undefined;
    const filter = statuses === null ? sql`` : sql`AND v.status = ANY(${[...statuses]}::text[])`;
    const { rows } = await sql<Record<string, unknown>>`
      SELECT ${HEADER} FROM depreciation_schedule_version v
      WHERE v.asset_id = ${assetId} AND v.mre_realm_id = ${mreRealmId} ${filter}
      ORDER BY v.version_number DESC
    `.execute(trx);
    return readVersions(trx, rows, false);
  });
}

/** The version of this asset and Realm with the asset's schedule inputs in the same snapshot; `undefined` when not found. */
export function findVersion(
  db: Kysely<Database>,
  read: (trx: Trx, assetId: string, mreRealmId: string) => Promise<ScheduleRead | undefined>,
  assetId: string,
  mreRealmId: string,
  versionId: string,
): Promise<{ readonly version: ScheduleVersion; readonly schedule: ScheduleRead } | undefined> {
  if (!UUID.test(assetId) || !UUID.test(versionId)) return Promise.resolve(undefined);
  return depreciationSnapshot(db, async (trx) => {
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM depreciation_schedule_version WHERE id = ${versionId} AND asset_id = ${assetId} AND mre_realm_id = ${mreRealmId}
    `.execute(trx);
    if (rows.length === 0) return undefined;
    const schedule = await read(trx, assetId, mreRealmId);
    const version = await readVersionById(trx, versionId);
    if (schedule === undefined || version === undefined) return undefined;
    return { version, schedule };
  });
}

/** The distinct recorded references with their hashes, across Realms (the start check, §58, §60). */
export async function storedRuleVersionHashes(db: Kysely<Database>): Promise<readonly (RuleRef & { readonly ruleVersionHash: string })[]> {
  const { rows } = await sql<{ rule_code: string; rule_version: number; rule_version_hash: string }>`
    SELECT DISTINCT rule_code, rule_version, rule_version_hash FROM depreciation_schedule_version_rule ORDER BY rule_code, rule_version, rule_version_hash
  `.execute(db);
  return rows.map((r) => ({ ruleCode: r.rule_code, version: Number(r.rule_version), ruleVersionHash: r.rule_version_hash }));
}
