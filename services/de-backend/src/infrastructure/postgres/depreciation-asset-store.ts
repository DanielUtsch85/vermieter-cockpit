import type { Kysely, Transaction } from 'kysely';
import {
  addedItems,
  advisorsOf,
  amendFieldsNotAllowed,
  entryAcquisitionRefusal,
  planAssetAmend,
  planAssetConfirm,
  writtenEntries,
  writtenPurchaseMethods,
  type AmendAssetOutcome,
  type AssetAmendment,
  type ConfirmAssetOutcome,
  type ConfirmReviewState,
  type CreateAssetOutcome,
  type DepreciationAsset,
  type EntryAcquisition,
  type NewDepreciationAsset,
  type PurchaseMethod,
  type ShorterUsefulLife,
  type VoidAssetOutcome,
} from '../../domains/depreciation/index.js';
import { checkVersion, type AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import type { CapitalizedSourcesReader } from './capitalized-items.js';
import { UUID, fromSnapshot, isUniqueViolation, storedFields, toSnapshot } from './depreciation-asset-rows.js';
import { readAsset } from './depreciation-asset-reads.js';
import * as separateAssets from './depreciation-separate-assets.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import type { Database } from './schema.js';

/**
 * The commands of §59 (create, amend, confirm, void), each one READ COMMITTED transaction in the lock order of every
 * writer of a PropertyReference (§26.1, §28.1), with the shorter useful lives (the entries) and the purchase methods
 * (§59C) written as a difference.
 * A separate asset's items are checked and linked through `depreciation-separate-assets.ts`.
 */

const ENTITY_TYPE = 'DepreciationAsset';
const CREATE_SCOPE = 'depreciation-asset.create';

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateAssetOutcome | AmendAssetOutcome) {
    super(outcome.kind);
  }
}

export async function create(
  db: Kysely<Database>,
  capitalizedSources: CapitalizedSourcesReader | undefined,
  now: () => Date,
  asset: NewDepreciationAsset,
  actor: AuditActor,
  idempotency?: { readonly key: string; readonly fingerprint: string },
): Promise<CreateAssetOutcome> {
  if (!UUID.test(asset.propertyReferenceId)) return { kind: 'PROPERTY_REFERENCE_NOT_FOUND' };
  try {
    return await db
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
        // §59C: the method entries' Acquisitions in the same step as the shorter lives', shorter lives first.
        const named = [...asset.shorterUsefulLives, ...asset.purchaseMethods];
        const acquisitions = await entryAcquisitions(trx, named, asset.mreRealmId);
        const refusal = entryAcquisitionRefusal(named, acquisitions, asset.propertyReferenceId);
        if (refusal !== undefined) throw new Rejected(refusal);
        const itemRefusal = await separateAssets.itemRefusal(trx, capitalizedSources, now, asset.items, asset.mreRealmId, asset.propertyReferenceId, null);
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
        for (const entry of asset.purchaseMethods) await insertMethod(trx, id, asset, entry);
        for (const item of asset.items) await separateAssets.insertItem(trx, id, asset, item, actor);
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
      const existing = await activeBuilding(db, asset.propertyReferenceId);
      if (existing !== undefined) return { kind: 'BUILDING_ASSET_EXISTS', assetId: existing };
    }
    const taken = await separateAssets.takenItem(db, error, asset.items, asset.mreRealmId, null);
    if (taken !== undefined) return taken;
    throw error;
  }
}

export async function amend(
  db: Kysely<Database>,
  capitalizedSources: CapitalizedSourcesReader | undefined,
  now: () => Date,
  id: string,
  mreRealmId: string,
  amendment: AssetAmendment,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<AmendAssetOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  try {
    return await db
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
        const beforePlan = planAssetAmend(before, amendment);
        const written = [...writtenEntries(beforePlan), ...writtenPurchaseMethods(beforePlan)];
        const party = await missingParty(trx, [...new Set(written.flatMap((e) => (e.advisorPartyId === null ? [] : [e.advisorPartyId])))], mreRealmId);
        if (party !== undefined) return { kind: 'PARTY_NOT_FOUND', partyId: party };
        const refusal = entryAcquisitionRefusal(written, await entryAcquisitions(trx, written, mreRealmId), before.propertyReferenceId);
        if (refusal !== undefined) return refusal as AmendAssetOutcome;
        // Only items new to the list are checked (§59B): an unchanged link of a since-reclassified item does not block.
        const itemRefusal = await separateAssets.itemRefusal(
          trx,
          capitalizedSources,
          now,
          addedItems(planAssetAmend(before, amendment)),
          mreRealmId,
          before.propertyReferenceId,
          id,
        );
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
        // §59C: the method entries as a difference too, under the same guard pattern (0053).
        for (const entry of plan.changedPurchaseMethods) {
          if (entry.change === 'ADDED') await insertMethod(trx, id, current, entry.to as PurchaseMethod);
          else if (entry.change === 'REMOVED') {
            await trx.deleteFrom('depreciation_asset_purchase_method').where('asset_id', '=', id).where('acquisition_id', '=', entry.acquisitionId).execute();
          } else {
            await trx
              .updateTable('depreciation_asset_purchase_method')
              .set(methodColumns(entry.to as PurchaseMethod))
              .where('asset_id', '=', id)
              .where('acquisition_id', '=', entry.acquisitionId)
              .execute();
          }
        }
        // The links as a difference too (§59B): an unchanged link's row is not touched.
        for (const { item, change } of plan.changedItems) {
          if (change === 'ADDED') await separateAssets.insertItem(trx, id, current, item, actor);
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
            ...(plan.changedPurchaseMethods.length === 0 ? {} : { changedPurchaseMethods: plan.changedPurchaseMethods }),
            ...(plan.changedItems.length === 0 ? {} : { changedItems: plan.changedItems }),
            ...(plan.reviewStateReset === null ? {} : { reviewStateReset: plan.reviewStateReset }),
          },
        });
        return { kind: 'AMENDED', asset: amended, changed: true };
      });
  } catch (error) {
    if (error instanceof Rejected) return error.outcome as AmendAssetOutcome;
    const taken = await separateAssets.takenItem(db, error, amendment.items ?? [], mreRealmId, id);
    if (taken !== undefined) return taken;
    throw error;
  }
}

export async function confirm(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  request: { readonly reviewState: ConfirmReviewState; readonly advisorPartyId: string | null; readonly note: string | null },
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<ConfirmAssetOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
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

export async function voidAsset(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  reason: string,
  at: Date,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<VoidAssetOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
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

/** A method entry's own columns (§59C, 0053). */
function methodColumns(entry: PurchaseMethod) {
  return {
    consideration: entry.consideration,
    method: entry.method,
    special_depreciation: [...entry.specialDepreciation],
    subsidies_received: entry.subsidiesReceived,
    new_building_by_conversion: entry.newBuildingByConversion,
    other_special_case: entry.otherSpecialCase,
    other_special_case_note: entry.otherSpecialCaseNote,
    evidence_source: entry.evidence.source,
    evidence_date: entry.evidence.date,
    evidence_document_reference: entry.evidence.documentReference,
    review_state: entry.reviewState,
    advisor_party_id: entry.advisorPartyId,
    notes: entry.notes,
  };
}

async function insertMethod(
  trx: Transaction<Database>,
  assetId: string,
  asset: { readonly mreRealmId: string; readonly propertyReferenceId: string },
  entry: PurchaseMethod,
): Promise<void> {
  await trx
    .insertInto('depreciation_asset_purchase_method')
    .values({
      asset_id: assetId,
      mre_realm_id: asset.mreRealmId,
      property_reference_id: asset.propertyReferenceId,
      acquisition_id: entry.acquisitionId,
      ...methodColumns(entry),
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
