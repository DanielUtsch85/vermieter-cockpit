import { sql, type Kysely, type Transaction } from 'kysely';
import { componentIdOf, itemLinkRefusal, type FoundItem, type ItemRef, type ItemSourceType } from '../../domains/depreciation/index.js';
import { businessDayOf } from '../../domains/ledger/index.js';
import type { AuditActor } from '../../shared/index.js';
import { capitalizedItemsIn, type CapitalizedSourcesReader } from './capitalized-items.js';
import { UUID, isUniqueViolation } from './depreciation-asset-rows.js';
import type { Database } from './schema.js';

/**
 * A separate asset's items (§59B, migration 0051): the checks of the items a command writes (found, of the
 * PropertyReference, capitalised now through Taxation's reader, not anschaffungsnah, free), the link rows, and the
 * partial unique index's violation read as `ITEM_IN_OTHER_ASSET`.
 */

/** Steps 4–5 of §59B for the items written: found, of the PropertyReference, capitalised now, not anschaffungsnah, free. */
export async function itemRefusal(
  trx: Transaction<Database>,
  capitalizedSources: CapitalizedSourcesReader | undefined,
  now: () => Date,
  items: readonly ItemRef[],
  mreRealmId: string,
  propertyReferenceId: string,
  assetId: string | null,
) {
  if (items.length === 0) return undefined;
  if (capitalizedSources === undefined) throw new Error('PostgresDepreciationAssetRepository: no capitalizedSources reader wired (api-design §59B)');
  const found = await foundItems(trx, items, mreRealmId);
  const own = items.filter((i) => found.get(componentIdOf(i))?.propertyReferenceId === propertyReferenceId);
  const meanings = await capitalizedItemsIn(trx, mreRealmId, propertyReferenceId, businessDayOf(now()), capitalizedSources, own);
  for (const item of own) {
    const key = componentIdOf(item);
    const meaning = meanings.find((m) => componentIdOf(m) === key);
    const entry = found.get(key) as { propertyReferenceId: string | null };
    found.set(key, meaning === undefined ? entry : { ...entry, meaning });
  }
  const linked = await linkedElsewhere(trx, items, mreRealmId, assetId);
  return itemLinkRefusal(
    items,
    (i) => found.get(componentIdOf(i)),
    propertyReferenceId,
    (i) => linked.get(componentIdOf(i)),
  );
}

/** The partial unique index of 0051 is the guarantee for any other writer: its violation is `ITEM_IN_OTHER_ASSET`. */
export async function takenItem(db: Kysely<Database>, error: unknown, items: readonly ItemRef[], mreRealmId: string, assetId: string | null) {
  if (!isUniqueViolation(error, 'depreciation_asset_item_active')) return undefined;
  const linked = await db.transaction().execute((trx) => linkedElsewhere(trx, items, mreRealmId, assetId));
  const item = items.find((i) => linked.has(componentIdOf(i)));
  return item === undefined ? undefined : ({ kind: 'ITEM_IN_OTHER_ASSET', item, assetId: linked.get(componentIdOf(item)) as string } as const);
}

export async function insertItem(
  trx: Transaction<Database>,
  assetId: string,
  asset: { readonly mreRealmId: string; readonly propertyReferenceId: string },
  item: ItemRef,
  actor: AuditActor,
): Promise<void> {
  await trx
    .insertInto('depreciation_asset_item')
    .values({
      asset_id: assetId,
      mre_realm_id: asset.mreRealmId,
      property_reference_id: asset.propertyReferenceId,
      asset_status: 'ACTIVE',
      source_type: item.sourceType,
      source_id: item.sourceId,
      source_position: item.sourcePosition,
      created_by: actor.actorId,
    })
    .execute();
}

/**
 * Steps 4's first two checks (§59B): each item's source in the Realm with its PropertyReference; a WEG source only
 * where its position names a withdrawal (a reserve line of kind `WITHDRAWAL`) resp. a use. Not found: absent.
 */
async function foundItems(trx: Transaction<Database>, items: readonly ItemRef[], mreRealmId: string): Promise<Map<string, FoundItem>> {
  const found = new Map<string, FoundItem>();
  const splits = items.filter((i) => i.sourceType === 'TRANSACTION_SPLIT' && UUID.test(i.sourceId)).map((i) => i.sourceId);
  if (splits.length > 0) {
    const rows = await trx
      .selectFrom('transaction_split')
      .select(['id', 'property_reference_id'])
      .where('id', 'in', splits)
      .where('mre_realm_id', '=', mreRealmId)
      .execute();
    for (const r of rows)
      found.set(componentIdOf({ sourceType: 'TRANSACTION_SPLIT', sourceId: r.id, sourcePosition: null }), { propertyReferenceId: r.property_reference_id });
  }
  for (const item of items.filter((i) => i.sourceType !== 'TRANSACTION_SPLIT' && UUID.test(i.sourceId))) {
    const withdrawal = item.sourceType === 'WEG_RESERVE_WITHDRAWAL';
    const row = await sql<{ property_reference_id: string }>`
      SELECT m.property_reference_id FROM ${sql.table(withdrawal ? 'weg_annual_statement' : 'weg_special_assessment')} src
        JOIN weg_membership m ON m.id = src.membership_id
        CROSS JOIN LATERAL jsonb_array_elements(${withdrawal ? sql`coalesce(src.reserve -> 'lines', '[]'::jsonb)` : sql`src.uses`}) AS e
       WHERE src.id = ${item.sourceId} AND src.mre_realm_id = ${mreRealmId} AND (e ->> 'position')::integer = ${item.sourcePosition}
         ${withdrawal ? sql`AND e ->> 'kind' = 'WITHDRAWAL'` : sql``}
    `.execute(trx);
    const pr = row.rows[0]?.property_reference_id;
    if (pr !== undefined) found.set(componentIdOf(item), { propertyReferenceId: pr });
  }
  return found;
}

/** The `ACTIVE` asset (other than `assetId`) that links each item, if any (step 5, `ITEM_IN_OTHER_ASSET`). */
async function linkedElsewhere(
  trx: Transaction<Database>,
  items: readonly ItemRef[],
  mreRealmId: string,
  assetId: string | null,
): Promise<Map<string, string>> {
  const ids = [...new Set(items.filter((i) => UUID.test(i.sourceId)).map((i) => i.sourceId))];
  if (ids.length === 0) return new Map();
  let query = trx
    .selectFrom('depreciation_asset_item')
    .select(['asset_id', 'source_type', 'source_id', 'source_position'])
    .where('mre_realm_id', '=', mreRealmId)
    .where('asset_status', '=', 'ACTIVE')
    .where('source_id', 'in', ids);
  if (assetId !== null) query = query.where('asset_id', '<>', assetId);
  const rows = await query.execute();
  return new Map(
    rows.map((r) => [componentIdOf({ sourceType: r.source_type as ItemSourceType, sourceId: r.source_id, sourcePosition: r.source_position }), r.asset_id]),
  );
}
