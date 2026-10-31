import type { Kysely } from 'kysely';
import {
  formatShare,
  ownershipOn,
  planChange,
  type ChangeOwnershipOutcome,
  type ChangeResult,
  type Ownership,
  type OwnershipChange,
  type OwnershipStatus,
} from '../../domains/ownership/index.js';
import { addDays, type AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import {
  ENTITY_TYPE,
  Rejected,
  checkAcquisition,
  checkPredecessors,
  fromSnapshot,
  ownershipsOf,
  toSnapshot,
  type OwnershipSnapshot,
} from './ownership-rows.js';
import type { Database } from './schema.js';

/** The OwnershipChange port (api-design.md §26.2): closes and creates in one change, and its idempotency snapshot. */

const CHANGE_SCOPE = 'ownership.change';

export async function change(
  db: Kysely<Database>,
  change: OwnershipChange,
  actor: AuditActor,
  idempotency?: { readonly key: string; readonly fingerprint: string },
): Promise<ChangeOwnershipOutcome> {
  try {
    return await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<ChangeOwnershipOutcome> => {
        const keyed =
          idempotency === undefined
            ? undefined
            : { ref: { mreRealmId: change.mreRealmId, scope: CHANGE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
        if (keyed !== undefined) {
          const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
          if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
          if (claim.kind === 'REPLAY') return { kind: 'CHANGED', result: fromChangeSnapshot(claim.result), replayed: true };
        }
        // Locks in the order of every Ownership writer (§26.1): PropertyReference, Parties (id order), Ownerships (id order).
        const touched = await trx
          .updateTable('property_reference')
          .set((eb) => ({ version: eb.ref('version') }))
          .where('id', '=', change.propertyReferenceId)
          .where('mre_realm_id', '=', change.mreRealmId)
          .returning('version')
          .executeTakeFirst();
        if (touched === undefined) throw new Rejected<ChangeOwnershipOutcome>({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' });
        const ownerIds = [...new Set(change.create.map((c) => c.ownerPartyId))].sort();
        const owners =
          ownerIds.length === 0
            ? []
            : await trx
                .selectFrom('party')
                .select(['id', 'status'])
                .where('id', 'in', ownerIds)
                .where('mre_realm_id', '=', change.mreRealmId)
                .orderBy('id')
                .forShare()
                .execute();
        if (change.close.length > 0) {
          await trx
            .selectFrom('ownership')
            .select('id')
            .where('id', 'in', [...change.close].sort())
            .where('property_reference_id', '=', change.propertyReferenceId)
            .orderBy('id')
            .forUpdate()
            .execute();
        }
        const existing = await ownershipsOf(trx, change.propertyReferenceId);

        // The checks in the order of §26.2: the listed Ownerships come before the new owners.
        const plan = planChange(existing, change);
        if (plan.kind === 'INVALID_OWNERSHIP') throw new Rejected<ChangeOwnershipOutcome>(plan);
        const status = new Map(owners.map((o) => [o.id, o.status]));
        for (const { ownerPartyId } of change.create) {
          if (!status.has(ownerPartyId)) throw new Rejected<ChangeOwnershipOutcome>({ kind: 'PARTY_NOT_FOUND', partyId: ownerPartyId });
          if (status.get(ownerPartyId) !== 'ACTIVE') throw new Rejected<ChangeOwnershipOutcome>({ kind: 'PARTY_INACTIVE', partyId: ownerPartyId });
        }
        const acquisitionRefusal = await checkAcquisition(trx, change.acquisitionId, change.mreRealmId, change.propertyReferenceId);
        if (acquisitionRefusal !== undefined) throw new Rejected<ChangeOwnershipOutcome>(acquisitionRefusal);
        // §28.1A: a listed Ownership whose end moves must not be the predecessor of a confirmed purchase. The
        // Acquisitions are written after the Ownership locks here, as `checkAcquisition`'s; the PropertyReference
        // taken first serialises every writer of these rows anyway.
        const lastDay = addDays(change.effectiveDate, -1);
        const moving = existing.filter((o) => change.close.includes(o.id) && o.status === 'VALID' && o.validUntil !== null && o.validUntil !== lastDay);
        const predecessorRefusal = await checkPredecessors(trx, moving);
        if (predecessorRefusal !== undefined) throw new Rejected<ChangeOwnershipOutcome>(predecessorRefusal);
        if (plan.kind === 'UNCHANGED') {
          // Nothing written; the key claim is rolled back with it, so a retry with the key answers the same no-op.
          throw new Rejected<ChangeOwnershipOutcome>({ kind: 'UNCHANGED', result: resultOf(change, existing, change.close, []) });
        }
        if (plan.kind !== 'CHANGE') throw new Rejected<ChangeOwnershipOutcome>(plan);

        // Closes first, then creates: the invariant trigger checks each statement immediately (§26.2).
        const metadata = { reason: change.reason, effectiveDate: change.effectiveDate };
        for (const { ownership, validUntil } of plan.closes) {
          await trx
            .updateTable('ownership')
            .set({ valid_until: validUntil, version: ownership.version + 1, updated_at: new Date() })
            .where('id', '=', ownership.id)
            .execute();
          await writeAudit(trx, { type: ENTITY_TYPE, id: ownership.id }, 'CLOSED', actor, {
            previousVersion: ownership.version,
            newVersion: ownership.version + 1,
            metadata: { ...metadata, validUntil: { from: ownership.validUntil, to: validUntil } },
          });
        }
        const createdIds: string[] = [];
        for (const create of change.create) {
          const { id } = await trx
            .insertInto('ownership')
            .values({
              mre_realm_id: change.mreRealmId,
              property_reference_id: change.propertyReferenceId,
              owner_party_id: create.ownerPartyId,
              share_numerator: create.share.numerator,
              share_denominator: create.share.denominator,
              valid_from: change.effectiveDate,
              valid_until: null,
              status: 'VALID' satisfies OwnershipStatus,
              acquisition_id: change.acquisitionId,
              source_references: [...create.sourceReferences],
              notes: create.notes,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          createdIds.push(id);
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CREATED', actor, {
            newVersion: 1,
            metadata: {
              ...metadata,
              propertyReferenceId: change.propertyReferenceId,
              ownerPartyId: create.ownerPartyId,
              share: formatShare(create.share),
              validFrom: change.effectiveDate,
              validUntil: null,
              acquisitionId: change.acquisitionId,
            },
          });
        }
        await writeAudit(trx, { type: 'PropertyReference', id: change.propertyReferenceId }, 'OWNERSHIP_CHANGED', actor, {
          previousVersion: touched.version,
          newVersion: touched.version,
          metadata: { ...metadata, closedOwnershipIds: plan.closes.map((c) => c.ownership.id), createdOwnershipIds: createdIds },
        });

        const result = resultOf(change, await ownershipsOf(trx, change.propertyReferenceId), change.close, createdIds);
        if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, change.propertyReferenceId, toChangeSnapshot(result));
        return { kind: 'CHANGED', result, replayed: false };
      });
  } catch (error) {
    if (error instanceof Rejected) return error.outcome as ChangeOwnershipOutcome;
    throw error;
  }
}

/** The listed and created Ownerships as they are now, in the order given, with the ownership on `effectiveDate`. */
function resultOf(change: OwnershipChange, ownerships: readonly Ownership[], closedIds: readonly string[], createdIds: readonly string[]): ChangeResult {
  const byId = new Map(ownerships.map((o) => [o.id as string, o]));
  const day = ownershipOn(ownerships, change.effectiveDate);
  return {
    propertyReferenceId: change.propertyReferenceId,
    effectiveDate: change.effectiveDate,
    reason: change.reason,
    closed: closedIds.map((id) => byId.get(id) as Ownership),
    created: createdIds.map((id) => byId.get(id) as Ownership),
    completeness: day.completeness,
    shareSum: day.shareSum,
  };
}

/** The change result as JSON for the idempotency store: Ownerships as their snapshots, the sum as `"n/d"`. */
type ChangeSnapshot = Omit<ChangeResult, 'closed' | 'created' | 'shareSum'> & {
  readonly closed: readonly OwnershipSnapshot[];
  readonly created: readonly OwnershipSnapshot[];
  readonly shareSum: string;
};

function toChangeSnapshot(result: ChangeResult): ChangeSnapshot {
  return { ...result, closed: result.closed.map(toSnapshot), created: result.created.map(toSnapshot), shareSum: formatShare(result.shareSum) };
}

function fromChangeSnapshot(value: unknown): ChangeResult {
  const snapshot = value as ChangeSnapshot;
  const [numerator, denominator] = snapshot.shareSum.split('/').map(BigInt) as [bigint, bigint];
  return {
    ...snapshot,
    closed: snapshot.closed.map(fromSnapshot),
    created: snapshot.created.map(fromSnapshot),
    shareSum: { numerator, denominator },
  };
}
