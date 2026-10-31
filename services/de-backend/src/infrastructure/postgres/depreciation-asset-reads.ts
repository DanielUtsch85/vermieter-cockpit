import { sql, type Kysely, type Transaction } from 'kysely';
import { sortedItems, type AssetRead, type AssetStatus, type DepreciationAsset, type ItemRef, type ItemSourceType } from '../../domains/depreciation/index.js';
import { ASSET_COLUMNS, UUID, toDomain, type AssetRow } from './depreciation-asset-rows.js';
import type { Database } from './schema.js';

/**
 * The reads of §59: one asset with its entries and items, the per-property list, and the entries whose Acquisition is
 * cancelled now, each in one `REPEATABLE READ READ ONLY` snapshot. `readAsset` and `depreciationSnapshot` also serve the
 * commands and the schedule source (they take the caller's transaction).
 */

export async function findAsset(db: Kysely<Database>, id: string, mreRealmId: string): Promise<AssetRead | undefined> {
  if (!UUID.test(id)) return undefined;
  return depreciationSnapshot(db, async (trx) => {
    const asset = await readAsset(trx, id, mreRealmId);
    if (asset === undefined) return undefined;
    const [read] = await withCancelled(trx, [asset]);
    return read;
  });
}

export async function listForPropertyReference(
  db: Kysely<Database>,
  propertyReferenceId: string,
  mreRealmId: string,
  statuses: readonly AssetStatus[] | null,
): Promise<readonly AssetRead[] | undefined> {
  if (!UUID.test(propertyReferenceId)) return undefined;
  return depreciationSnapshot(db, async (trx) => {
    const pr = await trx
      .selectFrom('property_reference')
      .select('id')
      .where('id', '=', propertyReferenceId)
      .where('mre_realm_id', '=', mreRealmId)
      .executeTakeFirst();
    if (pr === undefined) return undefined;
    let query = trx
      .selectFrom('depreciation_asset')
      .select(ASSET_COLUMNS)
      .where('property_reference_id', '=', propertyReferenceId)
      .where('mre_realm_id', '=', mreRealmId);
    if (statuses !== null) query = query.where('status', 'in', [...statuses]);
    const rows = await query.orderBy('asset_type').orderBy('created_at').orderBy('id').execute();
    return withCancelled(trx, await withEntries(trx, rows));
  });
}

/** One `REPEATABLE READ READ ONLY` snapshot (§59): a read writes nothing. */
export function depreciationSnapshot<T>(db: Kysely<Database>, work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(work);
}

/** The asset with its entries; with `mreRealmId`, only in that Realm. */
export async function readAsset(trx: Transaction<Database>, id: string, mreRealmId?: string): Promise<DepreciationAsset | undefined> {
  let query = trx.selectFrom('depreciation_asset').select(ASSET_COLUMNS).where('id', '=', id);
  if (mreRealmId !== undefined) query = query.where('mre_realm_id', '=', mreRealmId);
  const row = await query.executeTakeFirst();
  if (row === undefined) return undefined;
  return (await withEntries(trx, [row]))[0];
}

async function withEntries(trx: Transaction<Database>, rows: readonly AssetRow[]): Promise<DepreciationAsset[]> {
  if (rows.length === 0) return [];
  // §59B: a separate asset's links (every status: a void asset still lists the items it consisted of).
  const items = await trx
    .selectFrom('depreciation_asset_item')
    .select(['asset_id', 'source_type', 'source_id', 'source_position'])
    .where(
      'asset_id',
      'in',
      rows.map((r) => r.id),
    )
    .execute();
  const entries = await trx
    .selectFrom('depreciation_asset_useful_life')
    .select([
      'asset_id',
      'acquisition_id',
      'useful_life_years',
      'evidence_source',
      sql<string>`to_char(evidence_date, 'YYYY-MM-DD')`.as('evidence_date'),
      'evidence_document_reference',
      'review_state',
      'advisor_party_id',
    ])
    .where(
      'asset_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('acquisition_id')
    .execute();
  return rows.map((row) =>
    toDomain(
      row,
      entries.filter((e) => e.asset_id === row.id),
      sortedItems(
        items
          .filter((i) => i.asset_id === row.id)
          .map((i): ItemRef => ({ sourceType: i.source_type as ItemSourceType, sourceId: i.source_id, sourcePosition: i.source_position })),
      ),
    ),
  );
}

/** The entries whose Acquisition is `CANCELLED` now, per asset (the rate's `ACQUISITION_CANCELLED`). */
async function withCancelled(trx: Transaction<Database>, assets: readonly DepreciationAsset[]): Promise<AssetRead[]> {
  const ids = [...new Set(assets.flatMap((a) => a.shorterUsefulLives.map((e) => e.acquisitionId)))];
  const cancelled =
    ids.length === 0
      ? new Set<string>()
      : new Set((await trx.selectFrom('acquisition').select('id').where('id', 'in', ids).where('status', '=', 'CANCELLED').execute()).map((r) => r.id));
  return assets.map((asset) => ({
    asset,
    cancelledAcquisitionIds: asset.shorterUsefulLives.map((e) => e.acquisitionId).filter((id) => cancelled.has(id)),
  }));
}
