import { sql, type Kysely, type Transaction } from 'kysely';
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
  type OwnershipId,
  type OwnershipPage,
  type OwnershipRepository,
  type OwnershipStatus,
  type VoidOwnershipOutcome,
} from '../../domains/ownership/index.js';
import { checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'Ownership';
const CREATE_SCOPE = 'ownership.create';

/** Every column, the dates as `YYYY-MM-DD` text. */
const COLUMNS = [
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
  'notes',
  'created_at',
  'version',
] as const;

interface OwnershipRow {
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
  source_references: string[];
  notes: string | null;
  created_at: Date;
  version: number;
}

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: Exclude<CreateOwnershipOutcome, { kind: 'CREATED' | 'REPLAYED' }>) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the Ownership port (api-design.md §26.1). */
export class PostgresOwnershipRepository implements OwnershipRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(
    ownership: NewOwnership,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateOwnershipOutcome> {
    try {
      // READ COMMITTED explicitly: the key claim and the re-read after the PropertyReference touch rely on it.
      return await this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<CreateOwnershipOutcome> => {
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
        if (touched === undefined) throw new Rejected({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' });
        // FOR SHARE conflicts with deactivate's FOR UPDATE: the owner cannot turn inactive before this commits.
        const owner = await trx
          .selectFrom('party')
          .select('status')
          .where('id', '=', ownership.ownerPartyId)
          .where('mre_realm_id', '=', ownership.mreRealmId)
          .forShare()
          .executeTakeFirst();
        if (owner === undefined) throw new Rejected({ kind: 'PARTY_NOT_FOUND' });
        if (owner.status !== 'ACTIVE') throw new Rejected({ kind: 'PARTY_INACTIVE' });
        const violation = checkInvariants(await ownershipsOf(trx, ownership.propertyReferenceId), ownership);
        if (violation !== undefined) throw new Rejected(violation);

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
          },
        });
        return { kind: 'CREATED', ownership: created };
      });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  async findById(id: string, mreRealmId: string): Promise<Ownership | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.selectFrom('ownership').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
    return row === undefined ? undefined : toOwnership(row);
  }

  async close(
    id: string,
    mreRealmId: string,
    validUntil: BusinessDate,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<CloseOwnershipOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<CloseOwnershipOutcome> => {
      await touchPropertyReferenceOf(trx, id, mreRealmId);
      const current = await lockAndRead(trx, id, mreRealmId);
      if (current === undefined) return { kind: 'NOT_FOUND' };
      const plan = planClose(current, validUntil);
      if (plan.kind === 'UNCHANGED') return { kind: 'CLOSED', ownership: current, changed: false };
      if (plan.kind === 'INVALID_OWNERSHIP') return plan;
      const conflict = checkVersion(current.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      // Shortening never raises a sum; the invariant trigger checks (and serialises) anyway.
      await trx
        .updateTable('ownership')
        .set({ valid_until: validUntil, version: plan.next.version, updated_at: new Date() })
        .where('id', '=', id)
        .execute();
      const closed = await readOne(trx, id);
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CLOSED', actor, {
        previousVersion: current.version,
        newVersion: closed.version,
        metadata: { validUntil: { from: current.validUntil, to: closed.validUntil } },
      });
      return { kind: 'CLOSED', ownership: closed, changed: true };
    });
  }

  async void(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidOwnershipOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<VoidOwnershipOutcome> => {
      await touchPropertyReferenceOf(trx, id, mreRealmId);
      const current = await lockAndRead(trx, id, mreRealmId);
      if (current === undefined) return { kind: 'NOT_FOUND' };
      const plan = planVoid(current, reason, at);
      if (plan.kind === 'UNCHANGED') return { kind: 'VOIDED', ownership: current, changed: false };
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

  async on(propertyReferenceId: string, mreRealmId: string, asOf: BusinessDate): Promise<OwnershipDay | undefined> {
    if (!UUID.test(propertyReferenceId)) return undefined;
    // The PropertyReference and its Ownerships in one snapshot.
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
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

  async history(
    propertyReferenceId: string,
    mreRealmId: string,
    page: { readonly page: number; readonly pageSize: number },
  ): Promise<OwnershipPage | undefined> {
    if (!UUID.test(propertyReferenceId)) return undefined;
    // PropertyReference, count and page in one snapshot, so `total` and `items` agree.
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
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
}

/** The PropertyReference's Ownerships, `VOID` ones included (the domain ignores them); a new statement each call. */
async function ownershipsOf(trx: Transaction<Database>, propertyReferenceId: string): Promise<Ownership[]> {
  return (await trx.selectFrom('ownership').select(COLUMNS).where('property_reference_id', '=', propertyReferenceId).execute()).map(toOwnership);
}

async function propertyReferenceExists(trx: Transaction<Database>, id: string, mreRealmId: string): Promise<boolean> {
  return (await trx.selectFrom('property_reference').select('id').where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst()) !== undefined;
}

/**
 * The no-op write of the Ownership's PropertyReference that `create` and the trigger do too: every writer takes the
 * PropertyReference first, then the Party, then the Ownership row, one order on every path, so no two of them can
 * deadlock (review on #43; `ownership-changes` of VC-2-04 locks both). Nothing happens for an unknown or foreign id.
 */
async function touchPropertyReferenceOf(trx: Transaction<Database>, ownershipId: string, mreRealmId: string): Promise<void> {
  await trx
    .updateTable('property_reference')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', (eb) =>
      eb.selectFrom('ownership').select('property_reference_id').where('id', '=', ownershipId).where('mre_realm_id', '=', mreRealmId),
    )
    .execute();
}

/** Locks the Ownership row, then reads it in that same statement. */
async function lockAndRead(trx: Transaction<Database>, id: string, mreRealmId: string): Promise<Ownership | undefined> {
  const row = await trx.selectFrom('ownership').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).forUpdate().executeTakeFirst();
  return row === undefined ? undefined : toOwnership(row);
}

async function readOne(trx: Transaction<Database>, id: string): Promise<Ownership> {
  return toOwnership(await trx.selectFrom('ownership').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

function toOwnership(row: OwnershipRow): Ownership {
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
    acquisitionId: null,
    sourceReferences: row.source_references,
    notes: row.notes,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created Ownership as JSON for the idempotency store; timestamps as ISO strings. */
type OwnershipSnapshot = Omit<Ownership, 'createdAt' | 'voidedAt'> & { readonly createdAt: string; readonly voidedAt: string | null };

function toSnapshot(ownership: Ownership): OwnershipSnapshot {
  return { ...ownership, createdAt: ownership.createdAt.toISOString(), voidedAt: ownership.voidedAt?.toISOString() ?? null };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): Ownership {
  const snapshot = result as OwnershipSnapshot;
  return {
    ...snapshot,
    id: snapshot.id as OwnershipId,
    createdAt: new Date(snapshot.createdAt),
    voidedAt: snapshot.voidedAt === null ? null : new Date(snapshot.voidedAt),
  };
}
