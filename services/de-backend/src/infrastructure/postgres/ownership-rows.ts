import { sql, type Transaction } from 'kysely';
import { type AcquisitionRefusal, type Ownership, type OwnershipId, type OwnershipStatus, type PredecessorRefusal } from '../../domains/ownership/index.js';
import { addDays, type BusinessDate } from '../../shared/index.js';
import type { Database } from './schema.js';

/**
 * The Ownership rows of the Ownership ports (api-design.md §26.1, §26.2): columns, mapping, the idempotency snapshot,
 * the reads and locks every writer shares, and the Acquisition guards of §27.1 and §28.1A.
 */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ENTITY_TYPE = 'Ownership';

/** Every column, the dates as `YYYY-MM-DD` text. */
export const COLUMNS = [
  'id',
  'mre_realm_id',
  'property_reference_id',
  'owner_party_id',
  'share_numerator',
  'share_denominator',
  sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from'),
  sql<string | null>`to_char(valid_until, 'YYYY-MM-DD')`.as('valid_until'),
  'status',
  'voided_at',
  'void_reason',
  'source_references',
  'acquisition_id',
  'notes',
  'created_at',
  'version',
] as const;

export interface OwnershipRow {
  id: string;
  mre_realm_id: string;
  property_reference_id: string;
  owner_party_id: string;
  share_numerator: number;
  share_denominator: number;
  valid_from: string;
  valid_until: string | null;
  status: string;
  voided_at: Date | null;
  void_reason: string | null;
  acquisition_id: string | null;
  source_references: string[];
  notes: string | null;
  created_at: Date;
  version: number;
}

/** Thrown inside the transaction to roll back the key claim and every write together. */
export class Rejected<T extends { readonly kind: string }> extends Error {
  constructor(readonly outcome: T) {
    super(outcome.kind);
  }
}

/**
 * The Acquisition an Ownership is to link (§27.1): of this Realm and PropertyReference, and a `DRAFT`. Written (a no-op)
 * after the PropertyReference and the Parties (the lock order of every writer), so a concurrent cancel or confirm, which
 * takes it `FOR UPDATE`, either commits first and is seen here, or waits for this transaction; a write rather than
 * `FOR SHARE`, as the trigger does from 0022, so no lock is upgraded and a stale REPEATABLE READ confirm fails to
 * serialise (review on #50).
 */
export async function checkAcquisition(
  trx: Transaction<Database>,
  acquisitionId: string | null,
  mreRealmId: string,
  propertyReferenceId: string,
): Promise<AcquisitionRefusal | undefined> {
  if (acquisitionId === null) return undefined;
  const acquisition = await trx
    .updateTable('acquisition')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', acquisitionId)
    .where('mre_realm_id', '=', mreRealmId)
    .where('property_reference_id', '=', propertyReferenceId)
    .returning('status')
    .executeTakeFirst();
  if (acquisition === undefined) return { kind: 'ACQUISITION_NOT_FOUND', acquisitionId };
  if (acquisition.status !== 'DRAFT') return { kind: 'ACQUISITION_NOT_DRAFT', acquisitionId, status: acquisition.status };
  return undefined;
}

/**
 * §28.1A guard, as the trigger `ownership_predecessor_of_confirmed` of 0050: a `VALID` row of an owner ending on a day
 * is the predecessor of that owner's `VALID` Ownership starting the next day. When that one carries an Acquisition, the
 * Acquisition's row is written (the no-op of 0022, in id order), so a concurrent confirm is waited for and seen, and a
 * `CONFIRMED` one refuses the void, shortening or creation of the predecessor. A `DRAFT` one is touched and allowed.
 */
export async function checkPredecessors(
  trx: Transaction<Database>,
  rows: readonly Pick<Ownership, 'propertyReferenceId' | 'ownerPartyId' | 'validUntil' | 'status'>[],
): Promise<PredecessorRefusal | undefined> {
  const ends = rows.filter((r) => r.status === 'VALID' && r.validUntil !== null);
  if (ends.length === 0) return undefined;
  const successors = await trx
    .selectFrom('ownership')
    .select(['id', 'acquisition_id'])
    .where('status', '=', 'VALID')
    .where('acquisition_id', 'is not', null)
    .where((eb) =>
      eb.or(
        ends.map((r) =>
          eb.and([
            eb('property_reference_id', '=', r.propertyReferenceId),
            eb('owner_party_id', '=', r.ownerPartyId),
            eb('valid_from', '=', addDays(r.validUntil as BusinessDate, 1)),
          ]),
        ),
      ),
    )
    .orderBy('acquisition_id')
    .orderBy('id')
    .execute();
  let refusal: PredecessorRefusal | undefined;
  for (const successor of successors) {
    const acquisitionId = successor.acquisition_id as string;
    const acquisition = await trx
      .updateTable('acquisition')
      .set((eb) => ({ version: eb.ref('version') }))
      .where('id', '=', acquisitionId)
      .returning('status')
      .executeTakeFirst();
    if (refusal === undefined && acquisition?.status === 'CONFIRMED') refusal = { kind: 'PREDECESSOR_OF_CONFIRMED', acquisitionId, ownershipId: successor.id };
  }
  return refusal;
}

/** The Ownership as committed, without a lock; `[]` for an unknown or foreign id. */
export async function unlockedRow(trx: Transaction<Database>, id: string, mreRealmId: string): Promise<Ownership[]> {
  const row = await trx.selectFrom('ownership').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
  return row === undefined ? [] : [toOwnership(row)];
}

/** The PropertyReference's Ownerships, `VOID` ones included (the domain ignores them); a new statement each call. */
export async function ownershipsOf(trx: Transaction<Database>, propertyReferenceId: string): Promise<Ownership[]> {
  return (await trx.selectFrom('ownership').select(COLUMNS).where('property_reference_id', '=', propertyReferenceId).execute()).map(toOwnership);
}

export async function propertyReferenceExists(trx: Transaction<Database>, id: string, mreRealmId: string): Promise<boolean> {
  return (await trx.selectFrom('property_reference').select('id').where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst()) !== undefined;
}

/**
 * The no-op write of the Ownership's PropertyReference that `create` and the trigger do too: every writer takes the
 * PropertyReference first, then the Party, then the Ownership row, one order on every path, so no two of them can
 * deadlock (review on #43; `ownership-changes` of VC-2-04 locks both). Nothing happens for an unknown or foreign id.
 */
export async function touchPropertyReferenceOf(trx: Transaction<Database>, ownershipId: string, mreRealmId: string): Promise<void> {
  await trx
    .updateTable('property_reference')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', (eb) => eb.selectFrom('ownership').select('property_reference_id').where('id', '=', ownershipId).where('mre_realm_id', '=', mreRealmId))
    .execute();
}

/** Locks the Ownership row, then reads it in that same statement. */
export async function lockAndRead(trx: Transaction<Database>, id: string, mreRealmId: string): Promise<Ownership | undefined> {
  const row = await trx.selectFrom('ownership').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).forUpdate().executeTakeFirst();
  return row === undefined ? undefined : toOwnership(row);
}

export async function readOne(trx: Transaction<Database>, id: string): Promise<Ownership> {
  return toOwnership(await trx.selectFrom('ownership').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

export function toOwnership(row: OwnershipRow): Ownership {
  return {
    id: row.id as OwnershipId,
    mreRealmId: row.mre_realm_id,
    propertyReferenceId: row.property_reference_id,
    ownerPartyId: row.owner_party_id,
    share: { numerator: row.share_numerator, denominator: row.share_denominator },
    validFrom: row.valid_from as BusinessDate,
    validUntil: row.valid_until as BusinessDate | null,
    status: row.status as OwnershipStatus,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    acquisitionId: row.acquisition_id,
    sourceReferences: row.source_references,
    notes: row.notes,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created Ownership as JSON for the idempotency store; timestamps as ISO strings. */
export type OwnershipSnapshot = Omit<Ownership, 'createdAt' | 'voidedAt'> & { readonly createdAt: string; readonly voidedAt: string | null };

export function toSnapshot(ownership: Ownership): OwnershipSnapshot {
  return { ...ownership, createdAt: ownership.createdAt.toISOString(), voidedAt: ownership.voidedAt?.toISOString() ?? null };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
export function fromSnapshot(result: unknown): Ownership {
  const snapshot = result as OwnershipSnapshot;
  return {
    ...snapshot,
    id: snapshot.id,
    createdAt: new Date(snapshot.createdAt),
    voidedAt: snapshot.voidedAt === null ? null : new Date(snapshot.voidedAt),
  };
}
