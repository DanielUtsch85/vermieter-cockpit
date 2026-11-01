import type { Kysely } from 'kysely';
import {
  checkInvariants,
  ownershipOn,
  planClose,
  planVoid,
  type CloseOwnershipOutcome,
  type CreateOwnershipOutcome,
  type NewOwnership,
  type Ownership,
  type OwnershipDay,
  type OwnershipPage,
  type OwnershipStatus,
  type VoidOwnershipOutcome,
} from '../../domains/ownership/index.js';
import { checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import {
  COLUMNS,
  ENTITY_TYPE,
  Rejected,
  UUID,
  checkAcquisition,
  checkPredecessors,
  fromSnapshot,
  lockAndRead,
  ownershipsOf,
  propertyReferenceExists,
  readOne,
  toOwnership,
  toSnapshot,
  touchPropertyReferenceOf,
  unlockedRow,
} from './ownership-rows.js';
import type { Database } from './schema.js';

/** The Ownership port (api-design.md §26.1): create, find, close, void, the ownership on a day and the history. */

const CREATE_SCOPE = 'ownership.create';

export async function create(
  db: Kysely<Database>,
  ownership: NewOwnership,
  actor: AuditActor,
  idempotency?: { readonly key: string; readonly fingerprint: string },
): Promise<CreateOwnershipOutcome> {
  try {
    // READ COMMITTED explicitly: the key claim and the re-read after the PropertyReference touch rely on it.
    return await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<CreateOwnershipOutcome> => {
        const keyed =
          idempotency === undefined
            ? undefined
            : { ref: { mreRealmId: ownership.mreRealmId, scope: CREATE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
        if (keyed !== undefined) {
          const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
          if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
          // The Ownership as the first request created it, not as it is now (idempotency.ts).
          if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', ownership: fromSnapshot(claim.result) };
        }
        // The same no-op write the trigger does first: writers of one PropertyReference serialise here, so the
        // Ownerships read below already include a concurrent writer's committed rows (§26.1).
        const touched = await trx
          .updateTable('property_reference')
          .set((eb) => ({ version: eb.ref('version') }))
          .where('id', '=', ownership.propertyReferenceId)
          .where('mre_realm_id', '=', ownership.mreRealmId)
          .returning('id')
          .executeTakeFirst();
        if (touched === undefined) throw new Rejected<CreateOwnershipOutcome>({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' });
        // FOR SHARE conflicts with deactivate's FOR UPDATE: the owner cannot turn inactive before this commits.
        const owner = await trx
          .selectFrom('party')
          .select('status')
          .where('id', '=', ownership.ownerPartyId)
          .where('mre_realm_id', '=', ownership.mreRealmId)
          .forShare()
          .executeTakeFirst();
        if (owner === undefined) throw new Rejected<CreateOwnershipOutcome>({ kind: 'PARTY_NOT_FOUND' });
        if (owner.status !== 'ACTIVE') throw new Rejected<CreateOwnershipOutcome>({ kind: 'PARTY_INACTIVE' });
        const acquisitionRefusal = await checkAcquisition(trx, ownership.acquisitionId, ownership.mreRealmId, ownership.propertyReferenceId);
        if (acquisitionRefusal !== undefined) throw new Rejected<CreateOwnershipOutcome>(acquisitionRefusal);
        const predecessorRefusal = await checkPredecessors(trx, [{ ...ownership, status: 'VALID' }]);
        if (predecessorRefusal !== undefined) throw new Rejected<CreateOwnershipOutcome>(predecessorRefusal);
        const violation = checkInvariants(await ownershipsOf(trx, ownership.propertyReferenceId), ownership);
        if (violation !== undefined) throw new Rejected<CreateOwnershipOutcome>(violation);

        const { id } = await trx
          .insertInto('ownership')
          .values({
            mre_realm_id: ownership.mreRealmId,
            property_reference_id: ownership.propertyReferenceId,
            owner_party_id: ownership.ownerPartyId,
            share_numerator: ownership.share.numerator,
            share_denominator: ownership.share.denominator,
            valid_from: ownership.validFrom,
            valid_until: ownership.validUntil,
            status: 'VALID' satisfies OwnershipStatus,
            acquisition_id: ownership.acquisitionId,
            source_references: [...ownership.sourceReferences],
            notes: ownership.notes,
            created_by: actor.actorId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const created = toOwnership(await trx.selectFrom('ownership').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
        if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, id, toSnapshot(created));
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CREATED', actor, {
          newVersion: created.version,
          metadata: {
            propertyReferenceId: created.propertyReferenceId,
            ownerPartyId: created.ownerPartyId,
            share: `${created.share.numerator}/${created.share.denominator}`,
            validFrom: created.validFrom,
            validUntil: created.validUntil,
            acquisitionId: created.acquisitionId,
          },
        });
        return { kind: 'CREATED', ownership: created };
      });
  } catch (error) {
    if (error instanceof Rejected) return error.outcome as CreateOwnershipOutcome;
    throw error;
  }
}

export async function findById(db: Kysely<Database>, id: string, mreRealmId: string): Promise<Ownership | undefined> {
  if (!UUID.test(id)) return undefined;
  const row = await db.selectFrom('ownership').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
  return row === undefined ? undefined : toOwnership(row);
}

export async function close(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  validUntil: BusinessDate,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<CloseOwnershipOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx): Promise<CloseOwnershipOutcome> => {
      await touchPropertyReferenceOf(trx, id, mreRealmId);
      // §28.1A: the Acquisition of the owner's next Ownership is written before the row is locked (PropertyReference
      // → Acquisition → Ownership); the row's owner and PropertyReference never change, and its end changes only
      // under the PropertyReference held here.
      const predecessorRefusal = await checkPredecessors(trx, await unlockedRow(trx, id, mreRealmId));
      const current = await lockAndRead(trx, id, mreRealmId);
      if (current === undefined) return { kind: 'NOT_FOUND' };
      const plan = planClose(current, validUntil);
      if (plan.kind === 'UNCHANGED') return { kind: 'CLOSED', ownership: current, changed: false };
      if (plan.kind === 'INVALID_OWNERSHIP') return plan;
      if (predecessorRefusal !== undefined) return predecessorRefusal;
      const conflict = checkVersion(current.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      // Shortening never raises a sum; the invariant trigger checks (and serialises) anyway.
      await trx.updateTable('ownership').set({ valid_until: validUntil, version: plan.next.version, updated_at: new Date() }).where('id', '=', id).execute();
      const closed = await readOne(trx, id);
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CLOSED', actor, {
        previousVersion: current.version,
        newVersion: closed.version,
        metadata: { validUntil: { from: current.validUntil, to: closed.validUntil } },
      });
      return { kind: 'CLOSED', ownership: closed, changed: true };
    });
}

export async function voidOwnership(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  reason: string,
  at: Date,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<VoidOwnershipOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx): Promise<VoidOwnershipOutcome> => {
      await touchPropertyReferenceOf(trx, id, mreRealmId);
      // Lock order PropertyReference → Acquisition → Ownership (§28.1): its Acquisition is written (a no-op) before the
      // row is locked, so a running confirm is waited for and seen; its id never changes, so reading it first is safe.
      const linked = await trx.selectFrom('ownership').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
      const acquisitionId = linked?.acquisition_id ?? null;
      const acquisition =
        acquisitionId === null
          ? undefined
          : await trx
              .updateTable('acquisition')
              .set((eb) => ({ version: eb.ref('version') }))
              .where('id', '=', acquisitionId)
              .returning('status')
              .executeTakeFirst();
      // §28.1A: then the Acquisition of the owner's next Ownership, still before the row lock.
      const predecessorRefusal = await checkPredecessors(trx, linked === undefined ? [] : [toOwnership(linked)]);
      const current = await lockAndRead(trx, id, mreRealmId);
      if (current === undefined) return { kind: 'NOT_FOUND' };
      const plan = planVoid(current, reason, at);
      if (plan.kind === 'UNCHANGED') return { kind: 'VOIDED', ownership: current, changed: false };
      if (acquisitionId !== null && acquisition?.status === 'CONFIRMED') return { kind: 'ACQUISITION_CONFIRMED', acquisitionId };
      if (predecessorRefusal !== undefined) return predecessorRefusal;
      const conflict = checkVersion(current.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      await trx
        .updateTable('ownership')
        .set({ status: plan.next.status, voided_at: at, void_reason: reason, version: plan.next.version, updated_at: at })
        .where('id', '=', id)
        .execute();
      const voided = await readOne(trx, id);
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'VOIDED', actor, {
        previousVersion: current.version,
        newVersion: voided.version,
        metadata: { reason },
      });
      return { kind: 'VOIDED', ownership: voided, changed: true };
    });
}

export async function on(db: Kysely<Database>, propertyReferenceId: string, mreRealmId: string, asOf: BusinessDate): Promise<OwnershipDay | undefined> {
  if (!UUID.test(propertyReferenceId)) return undefined;
  // The PropertyReference and its Ownerships in one snapshot.
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      if (!(await propertyReferenceExists(trx, propertyReferenceId, mreRealmId))) return undefined;
      const rows = await trx
        .selectFrom('ownership')
        .select(COLUMNS)
        .where('property_reference_id', '=', propertyReferenceId)
        .where('mre_realm_id', '=', mreRealmId)
        .where('status', '=', 'VALID')
        .where('valid_from', '<=', asOf)
        .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>=', asOf)]))
        .execute();
      return ownershipOn(rows.map(toOwnership), asOf);
    });
}

export async function history(
  db: Kysely<Database>,
  propertyReferenceId: string,
  mreRealmId: string,
  page: { readonly page: number; readonly pageSize: number },
): Promise<OwnershipPage | undefined> {
  if (!UUID.test(propertyReferenceId)) return undefined;
  // PropertyReference, count and page in one snapshot, so `total` and `items` agree.
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      if (!(await propertyReferenceExists(trx, propertyReferenceId, mreRealmId))) return undefined;
      const filtered = () => trx.selectFrom('ownership').where('property_reference_id', '=', propertyReferenceId).where('mre_realm_id', '=', mreRealmId);
      const { n } = await filtered()
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const rows = await filtered()
        .select(COLUMNS)
        .orderBy('valid_from')
        .orderBy('created_at')
        .orderBy('id')
        .limit(page.pageSize)
        .offset((page.page - 1) * page.pageSize)
        .execute();
      return { items: rows.map(toOwnership), page: page.page, pageSize: page.pageSize, total: Number(n) };
    });
}
