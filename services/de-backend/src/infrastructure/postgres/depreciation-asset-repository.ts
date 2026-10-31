import { sql, type Kysely, type Transaction } from 'kysely';
import {
  addedItems,
  advisorsOf,
  amendFieldsNotAllowed,
  componentIdOf,
  entryAcquisitionRefusal,
  itemLinkRefusal,
  planAssetAmend,
  planAssetConfirm,
  sortedItems,
  writtenEntries,
  type AmendAssetOutcome,
  type AssetAmendment,
  type AssetRead,
  type AssetReviewState,
  type AssetStatus,
  type ConfirmAssetOutcome,
  type ConfirmReviewState,
  type CreateAssetOutcome,
  type DepreciationAsset,
  type DepreciationAssetId,
  type DepreciationAssetRepository,
  type DepreciationMethod,
  type EntryAcquisition,
  type FoundItem,
  type ItemRef,
  type ItemSourceType,
  type NewDepreciationAsset,
  type ShorterUsefulLife,
  type SupportedAssetType,
  type VoidAssetOutcome,
} from '../../domains/depreciation/index.js';
import { businessDayOf } from '../../domains/ledger/index.js';
import { checkVersion, type AuditActor, type BusinessDate, type RuleRef } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { capitalizedItemsIn, type CapitalizedSourcesReader } from './capitalized-items.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'DepreciationAsset';
const CREATE_SCOPE = 'depreciation-asset.create';
const ASSET_COLUMNS = [
  'id',
  'mre_realm_id',
  'property_reference_id',
  'asset_type',
  'status',
  'building_completion_year',
  'description',
  'useful_life_years',
  'useful_life_basis',
  sql<string | null>`to_char(acquired_on, 'YYYY-MM-DD')`.as('acquired_on'),
  'source_references',
  'depreciation_method',
  'review_state',
  'advisor_party_id',
  'notes',
  'voided_at',
  'void_reason',
  'created_at',
  'version',
] as const;

interface AssetRow {
  id: string;
  mre_realm_id: string;
  property_reference_id: string;
  asset_type: string;
  status: string;
  building_completion_year: number | null;
  description: string | null;
  useful_life_years: number | null;
  useful_life_basis: string | null;
  acquired_on: string | null;
  source_references: string[];
  depreciation_method: string;
  review_state: string;
  advisor_party_id: string | null;
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
  version: number;
}

interface EntryRow {
  asset_id: string;
  acquisition_id: string;
  useful_life_years: number;
  evidence_source: string;
  evidence_date: string;
  evidence_document_reference: string | null;
  review_state: string;
  advisor_party_id: string | null;
}

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateAssetOutcome | AmendAssetOutcome) {
    super(outcome.kind);
  }
}

/**
 * PostgreSQL implementation of the DepreciationAsset port (api-design.md §59, §59B, migrations 0049, 0051). Every command
 * is one READ COMMITTED transaction in the lock order of every writer of a PropertyReference (§26.1, §28.1): the key, the
 * PropertyReference (no-op write), the advisors (no lock), the entries' Acquisitions `FOR SHARE` in id order, a
 * separate asset's new items (read and derived through Taxation's derivation, no lock), the asset (`FOR UPDATE`, or the
 * `ACTIVE` building on create). An amend writes its entries and its items as a difference. The reads run in one
 * `REPEATABLE READ READ ONLY` snapshot. Nothing outside the three tables and the AuditRecords is written (P8-D14).
 */
export class PostgresDepreciationAssetRepository implements DepreciationAssetRepository {
  private readonly capitalizedSources: CapitalizedSourcesReader | undefined;
  private readonly now: () => Date;

  /**
   * `capitalizedSources` is the tax repository's reader (§59B), passed by the composition root: without it an item of a
   * separate asset cannot be checked, and a command naming one fails loudly instead of linking it unchecked.
   */
  constructor(
    private readonly db: Kysely<Database>,
    options: { readonly capitalizedSources?: CapitalizedSourcesReader; readonly now?: () => Date } = {},
  ) {
    this.capitalizedSources = options.capitalizedSources;
    this.now = options.now ?? (() => new Date());
  }

  /** Steps 4–5 of §59B for the items written: found, of the PropertyReference, capitalised now, not anschaffungsnah, free. */
  private async itemRefusal(trx: Transaction<Database>, items: readonly ItemRef[], mreRealmId: string, propertyReferenceId: string, assetId: string | null) {
    if (items.length === 0) return undefined;
    if (this.capitalizedSources === undefined) throw new Error('PostgresDepreciationAssetRepository: no capitalizedSources reader wired (api-design §59B)');
    const found = await foundItems(trx, items, mreRealmId);
    const own = items.filter((i) => found.get(componentIdOf(i))?.propertyReferenceId === propertyReferenceId);
    const meanings = await capitalizedItemsIn(trx, mreRealmId, propertyReferenceId, businessDayOf(this.now()), this.capitalizedSources, own);
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

  async create(
    asset: NewDepreciationAsset,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateAssetOutcome> {
    if (!UUID.test(asset.propertyReferenceId)) return { kind: 'PROPERTY_REFERENCE_NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateAssetOutcome> => {
          const ref = { mreRealmId: asset.mreRealmId, scope: CREATE_SCOPE, key: idempotency?.key ?? '' };
          if (idempotency !== undefined) {
            const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', asset: fromSnapshot(claim.result) };
          }
          // A second create for the PropertyReference waits here, then sees the first one's asset (READ COMMITTED).
          if (!(await touchPropertyReference(trx, asset.propertyReferenceId, asset.mreRealmId))) {
            throw new Rejected({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' });
          }
          const party = await missingParty(trx, advisorsOf(asset), asset.mreRealmId);
          if (party !== undefined) throw new Rejected({ kind: 'PARTY_NOT_FOUND', partyId: party });
          const acquisitions = await entryAcquisitions(trx, asset.shorterUsefulLives, asset.mreRealmId);
          const refusal = entryAcquisitionRefusal(asset.shorterUsefulLives, acquisitions, asset.propertyReferenceId);
          if (refusal !== undefined) throw new Rejected(refusal);
          const itemRefusal = await this.itemRefusal(trx, asset.items, asset.mreRealmId, asset.propertyReferenceId, null);
          if (itemRefusal !== undefined) throw new Rejected(itemRefusal);
          // Several separate assets per PropertyReference are allowed (§59B): only a building is unique.
          const existing = asset.assetType === 'BUILDING' ? await activeBuilding(trx, asset.propertyReferenceId) : undefined;
          if (existing !== undefined) throw new Rejected({ kind: 'BUILDING_ASSET_EXISTS', assetId: existing });

          const { id } = await trx
            .insertInto('depreciation_asset')
            .values({
              mre_realm_id: asset.mreRealmId,
              property_reference_id: asset.propertyReferenceId,
              asset_type: asset.assetType,
              status: 'ACTIVE',
              building_completion_year: asset.buildingCompletionYear,
              description: asset.description,
              useful_life_years: asset.usefulLifeYears,
              useful_life_basis: asset.usefulLifeBasis,
              acquired_on: asset.acquiredOn,
              source_references: [...asset.sourceReferences],
              depreciation_method: asset.depreciationMethod,
              review_state: asset.reviewState,
              advisor_party_id: asset.advisorPartyId,
              notes: asset.notes,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          for (const entry of asset.shorterUsefulLives) await insertEntry(trx, id, asset, entry);
          for (const item of asset.items) await insertItem(trx, id, asset, item, actor);
          const created = await readAsset(trx, id);
          if (created === undefined) throw new Error(`DepreciationAsset ${id} vanished`);
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CREATED', actor, { newVersion: created.version, metadata: storedFields(created) });
          if (idempotency !== undefined) await recordIdempotentResult(trx, ref, id, toSnapshot(created));
          return { kind: 'CREATED', asset: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome as CreateAssetOutcome;
      // The partial unique index is the guarantee for any other writer (§59): its violation is the same answer.
      if (isUniqueViolation(error, 'depreciation_asset_building_active')) {
        const existing = await activeBuilding(this.db, asset.propertyReferenceId);
        if (existing !== undefined) return { kind: 'BUILDING_ASSET_EXISTS', assetId: existing };
      }
      const taken = await this.takenItem(error, asset.items, asset.mreRealmId, null);
      if (taken !== undefined) return taken;
      throw error;
    }
  }

  /** The partial unique index of 0051 is the guarantee for any other writer: its violation is `ITEM_IN_OTHER_ASSET`. */
  private async takenItem(error: unknown, items: readonly ItemRef[], mreRealmId: string, assetId: string | null) {
    if (!isUniqueViolation(error, 'depreciation_asset_item_active')) return undefined;
    const linked = await this.db.transaction().execute((trx) => linkedElsewhere(trx, items, mreRealmId, assetId));
    const item = items.find((i) => linked.has(componentIdOf(i)));
    return item === undefined ? undefined : ({ kind: 'ITEM_IN_OTHER_ASSET', item, assetId: linked.get(componentIdOf(item)) as string } as const);
  }

  async amend(id: string, mreRealmId: string, amendment: AssetAmendment, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendAssetOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<AmendAssetOutcome> => {
          await touchPropertyReferenceOf(trx, id, mreRealmId);
          // Every writer of the asset writes its PropertyReference first, so this read holds until the lock below.
          const before = await readAsset(trx, id, mreRealmId);
          if (before === undefined) return { kind: 'NOT_FOUND' };
          if (before.status !== 'ACTIVE') return { kind: 'ASSET_NOT_ACTIVE', status: before.status };
          const notAllowed = amendFieldsNotAllowed(before.assetType, amendment);
          if (notAllowed.length > 0) return { kind: 'FIELDS_NOT_ALLOWED', fields: notAllowed };
          // Only new or changed entries are checked again: an unchanged one of a later-cancelled DRAFT does not block.
          const written = writtenEntries(planAssetAmend(before, amendment));
          const party = await missingParty(
            trx,
            written.flatMap((e) => (e.advisorPartyId === null ? [] : [e.advisorPartyId])),
            mreRealmId,
          );
          if (party !== undefined) return { kind: 'PARTY_NOT_FOUND', partyId: party };
          const refusal = entryAcquisitionRefusal(written, await entryAcquisitions(trx, written, mreRealmId), before.propertyReferenceId);
          if (refusal !== undefined) return refusal as AmendAssetOutcome;
          // Only items new to the list are checked (§59B): an unchanged link of a since-reclassified item does not block.
          const itemRefusal = await this.itemRefusal(trx, addedItems(planAssetAmend(before, amendment)), mreRealmId, before.propertyReferenceId, id);
          if (itemRefusal !== undefined) return itemRefusal;

          const current = await lockAsset(trx, id);
          const plan = planAssetAmend(current, amendment);
          if (!plan.changed) return { kind: 'AMENDED', asset: current, changed: false };
          const conflict = checkVersion(current.version, expectedVersions);
          if (conflict !== undefined) return conflict;
          // The asset row first (its version rises): the entries change only under the asset's lock.
          await trx
            .updateTable('depreciation_asset')
            .set({
              building_completion_year: plan.next.buildingCompletionYear,
              description: plan.next.description,
              useful_life_years: plan.next.usefulLifeYears,
              useful_life_basis: plan.next.usefulLifeBasis,
              acquired_on: plan.next.acquiredOn,
              source_references: [...plan.next.sourceReferences],
              review_state: plan.next.reviewState,
              advisor_party_id: plan.next.advisorPartyId,
              notes: plan.next.notes,
              version: current.version + 1,
            })
            .where('id', '=', id)
            .execute();
          // The difference, never the whole list: an unchanged entry's row is not touched (§59, the guard of 0049).
          for (const entry of plan.changedEntries) {
            if (entry.change === 'ADDED') await insertEntry(trx, id, current, entry.to as ShorterUsefulLife);
            else if (entry.change === 'REMOVED') {
              await trx.deleteFrom('depreciation_asset_useful_life').where('asset_id', '=', id).where('acquisition_id', '=', entry.acquisitionId).execute();
            } else {
              const to = entry.to as ShorterUsefulLife;
              await trx
                .updateTable('depreciation_asset_useful_life')
                .set({
                  useful_life_years: to.usefulLifeYears,
                  evidence_source: to.evidence.source,
                  evidence_date: to.evidence.date,
                  evidence_document_reference: to.evidence.documentReference,
                  review_state: to.reviewState,
                  advisor_party_id: to.advisorPartyId,
                })
                .where('asset_id', '=', id)
                .where('acquisition_id', '=', entry.acquisitionId)
                .execute();
            }
          }
          // The links as a difference too (§59B): an unchanged link's row is not touched.
          for (const { item, change } of plan.changedItems) {
            if (change === 'ADDED') await insertItem(trx, id, current, item, actor);
            else {
              const link = trx
                .deleteFrom('depreciation_asset_item')
                .where('asset_id', '=', id)
                .where('source_type', '=', item.sourceType)
                .where('source_id', '=', item.sourceId);
              await (
                item.sourcePosition === null ? link.where('source_position', 'is', null) : link.where('source_position', '=', item.sourcePosition)
              ).execute();
            }
          }
          const amended = await readAsset(trx, id);
          if (amended === undefined) throw new Error(`DepreciationAsset ${id} vanished`);
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'AMENDED', actor, {
            previousVersion: current.version,
            newVersion: amended.version,
            metadata: {
              changes: plan.changes,
              ...(plan.changedEntries.length === 0 ? {} : { changedEntries: plan.changedEntries }),
              ...(plan.changedItems.length === 0 ? {} : { changedItems: plan.changedItems }),
              ...(plan.reviewStateReset === null ? {} : { reviewStateReset: plan.reviewStateReset }),
            },
          });
          return { kind: 'AMENDED', asset: amended, changed: true };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome as AmendAssetOutcome;
      const taken = await this.takenItem(error, amendment.items ?? [], mreRealmId, id);
      if (taken !== undefined) return taken;
      throw error;
    }
  }

  async confirm(
    id: string,
    mreRealmId: string,
    request: { readonly reviewState: ConfirmReviewState; readonly advisorPartyId: string | null; readonly note: string | null },
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ConfirmAssetOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<ConfirmAssetOutcome> => {
        await touchPropertyReferenceOf(trx, id, mreRealmId);
        // The advisor before the asset's lock (§59's lock order), reported in the order of checks.
        const party = request.advisorPartyId === null ? undefined : await missingParty(trx, [request.advisorPartyId], mreRealmId);
        if ((await readAsset(trx, id, mreRealmId)) === undefined) return { kind: 'NOT_FOUND' };
        const current = await lockAsset(trx, id);
        const plan = planAssetConfirm(current, request.reviewState, request.advisorPartyId);
        if (plan.kind !== 'CONFIRM') return plan;
        if (party !== undefined) return { kind: 'PARTY_NOT_FOUND', partyId: party };
        if (!plan.changed) return { kind: 'CONFIRMED', asset: current, changed: false };
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('depreciation_asset')
          .set({ review_state: request.reviewState, advisor_party_id: request.advisorPartyId, version: current.version + 1 })
          .where('id', '=', id)
          .execute();
        const confirmed = await readAsset(trx, id);
        if (confirmed === undefined) throw new Error(`DepreciationAsset ${id} vanished`);
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CONFIRMED', actor, {
          previousVersion: current.version,
          newVersion: confirmed.version,
          metadata: { from: current.reviewState, to: confirmed.reviewState, advisorPartyId: confirmed.advisorPartyId, note: request.note },
        });
        return { kind: 'CONFIRMED', asset: confirmed, changed: true };
      });
  }

  async void(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidAssetOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<VoidAssetOutcome> => {
        await touchPropertyReferenceOf(trx, id, mreRealmId);
        if ((await readAsset(trx, id, mreRealmId)) === undefined) return { kind: 'NOT_FOUND' };
        const current = await lockAsset(trx, id);
        // A repeated void keeps the first reason and time, whatever If-Match says.
        if (current.status === 'VOID') return { kind: 'VOIDED', asset: current, changed: false };
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('depreciation_asset')
          .set({ status: 'VOID', voided_at: at, void_reason: reason, version: current.version + 1 })
          .where('id', '=', id)
          .execute();
        const voided = await readAsset(trx, id);
        if (voided === undefined) throw new Error(`DepreciationAsset ${id} vanished`);
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'VOIDED', actor, {
          previousVersion: current.version,
          newVersion: voided.version,
          // §59B: the items a separate asset frees (its links stay as history, their status follows to VOID).
          metadata: { reason, ...(voided.items.length === 0 ? {} : { items: voided.items }) },
        });
        return { kind: 'VOIDED', asset: voided, changed: true };
      });
  }

  async find(id: string, mreRealmId: string): Promise<AssetRead | undefined> {
    if (!UUID.test(id)) return undefined;
    return depreciationSnapshot(this.db, async (trx) => {
      const asset = await readAsset(trx, id, mreRealmId);
      if (asset === undefined) return undefined;
      const [read] = await withCancelled(trx, [asset]);
      return read;
    });
  }

  async listForPropertyReference(
    propertyReferenceId: string,
    mreRealmId: string,
    statuses: readonly AssetStatus[] | null,
  ): Promise<readonly AssetRead[] | undefined> {
    if (!UUID.test(propertyReferenceId)) return undefined;
    return depreciationSnapshot(this.db, async (trx) => {
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

  /** VC-8-01 stores no rule reference: the rate is derived (P8-D1). VC-8-04's recorded versions will. */
  storedRuleReferences(): Promise<readonly RuleRef[]> {
    return Promise.resolve([]);
  }
}

/** One `REPEATABLE READ READ ONLY` snapshot (§59): a read writes nothing. */
export function depreciationSnapshot<T>(db: Kysely<Database>, work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(work);
}

/** The no-op write of the PropertyReference every writer of it does first; false for an unknown or foreign one. */
async function touchPropertyReference(trx: Transaction<Database>, id: string, mreRealmId: string): Promise<boolean> {
  const touched = await trx
    .updateTable('property_reference')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('mre_realm_id', '=', mreRealmId)
    .returning('id')
    .executeTakeFirst();
  return touched !== undefined;
}

/** The same no-op write for the PropertyReference of an asset; nothing happens for an unknown or foreign asset. */
async function touchPropertyReferenceOf(trx: Transaction<Database>, assetId: string, mreRealmId: string): Promise<void> {
  await trx
    .updateTable('property_reference')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', (eb) =>
      eb.selectFrom('depreciation_asset').select('property_reference_id').where('id', '=', assetId).where('mre_realm_id', '=', mreRealmId),
    )
    .execute();
}

/** The first named Party that is unknown or foreign; any status is allowed (§27.3). Read without a lock. */
async function missingParty(trx: Transaction<Database>, partyIds: readonly string[], mreRealmId: string): Promise<string | undefined> {
  if (partyIds.length === 0) return undefined;
  const found = await trx
    .selectFrom('party')
    .select('id')
    .where('id', 'in', [...partyIds])
    .where('mre_realm_id', '=', mreRealmId)
    .execute();
  const known = new Set(found.map((p) => p.id));
  return partyIds.find((id) => !known.has(id));
}

/** The entries' Acquisitions of the Realm, `FOR SHARE` in id order: a concurrent cancel waits, or this waits for it. */
async function entryAcquisitions(
  trx: Transaction<Database>,
  entries: readonly { readonly acquisitionId: string }[],
  mreRealmId: string,
): Promise<Map<string, EntryAcquisition>> {
  const ids = [...new Set(entries.map((e) => e.acquisitionId))].sort();
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('acquisition')
    .select(['id', 'property_reference_id', 'status'])
    .where('id', 'in', ids)
    .where('mre_realm_id', '=', mreRealmId)
    .orderBy('id')
    .forShare()
    .execute();
  return new Map(rows.map((r) => [r.id, { id: r.id, propertyReferenceId: r.property_reference_id, status: r.status }]));
}

async function activeBuilding(db: Kysely<Database> | Transaction<Database>, propertyReferenceId: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('depreciation_asset')
    .select('id')
    .where('property_reference_id', '=', propertyReferenceId)
    .where('asset_type', '=', 'BUILDING')
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst();
  return row?.id;
}

async function insertItem(
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

async function insertEntry(
  trx: Transaction<Database>,
  assetId: string,
  asset: { readonly mreRealmId: string; readonly propertyReferenceId: string },
  entry: ShorterUsefulLife,
): Promise<void> {
  await trx
    .insertInto('depreciation_asset_useful_life')
    .values({
      asset_id: assetId,
      mre_realm_id: asset.mreRealmId,
      property_reference_id: asset.propertyReferenceId,
      acquisition_id: entry.acquisitionId,
      useful_life_years: entry.usefulLifeYears,
      evidence_source: entry.evidence.source,
      evidence_date: entry.evidence.date,
      evidence_document_reference: entry.evidence.documentReference,
      review_state: entry.reviewState,
      advisor_party_id: entry.advisorPartyId,
    })
    .execute();
}

/** The asset `FOR UPDATE` and read afresh under the lock (§16.1). */
async function lockAsset(trx: Transaction<Database>, id: string): Promise<DepreciationAsset> {
  await trx.selectFrom('depreciation_asset').select('id').where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
  const asset = await readAsset(trx, id);
  if (asset === undefined) throw new Error(`DepreciationAsset ${id} vanished`);
  return asset;
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

function toDomain(row: AssetRow, entries: readonly EntryRow[], items: readonly ItemRef[]): DepreciationAsset {
  return {
    id: row.id as DepreciationAssetId,
    mreRealmId: row.mre_realm_id,
    propertyReferenceId: row.property_reference_id,
    // Checked by the table's CHECKs.
    assetType: row.asset_type as SupportedAssetType,
    status: row.status as AssetStatus,
    buildingCompletionYear: row.building_completion_year,
    description: row.description,
    usefulLifeYears: row.useful_life_years,
    usefulLifeBasis: row.useful_life_basis,
    acquiredOn: row.acquired_on as BusinessDate | null,
    items,
    sourceReferences: row.source_references,
    depreciationMethod: row.depreciation_method as DepreciationMethod,
    reviewState: row.review_state as AssetReviewState,
    advisorPartyId: row.advisor_party_id,
    shorterUsefulLives: entries.map((e) => ({
      acquisitionId: e.acquisition_id,
      usefulLifeYears: e.useful_life_years,
      evidence: { source: e.evidence_source, date: e.evidence_date as BusinessDate, documentReference: e.evidence_document_reference },
      reviewState: e.review_state as AssetReviewState,
      advisorPartyId: e.advisor_party_id,
    })),
    notes: row.notes,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The CREATED record (§59): every stored field and each entry. */
function storedFields(asset: DepreciationAsset): Record<string, unknown> {
  return {
    propertyReferenceId: asset.propertyReferenceId,
    assetType: asset.assetType,
    buildingCompletionYear: asset.buildingCompletionYear,
    ...(asset.assetType === 'SEPARATE_ASSET'
      ? {
          description: asset.description,
          usefulLifeYears: asset.usefulLifeYears,
          usefulLifeBasis: asset.usefulLifeBasis,
          acquiredOn: asset.acquiredOn,
          items: asset.items,
        }
      : {}),
    sourceReferences: asset.sourceReferences,
    depreciationMethod: asset.depreciationMethod,
    reviewState: asset.reviewState,
    advisorPartyId: asset.advisorPartyId,
    shorterUsefulLives: asset.shorterUsefulLives,
    notes: asset.notes,
  };
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === constraint;
}

type AssetSnapshot = Omit<DepreciationAsset, 'voidedAt' | 'createdAt'> & { readonly voidedAt: string | null; readonly createdAt: string };

function toSnapshot(asset: DepreciationAsset): AssetSnapshot {
  return { ...asset, voidedAt: asset.voidedAt?.toISOString() ?? null, createdAt: asset.createdAt.toISOString() };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): DepreciationAsset {
  const snapshot = result as AssetSnapshot;
  return { ...snapshot, voidedAt: snapshot.voidedAt === null ? null : new Date(snapshot.voidedAt), createdAt: new Date(snapshot.createdAt) };
}
