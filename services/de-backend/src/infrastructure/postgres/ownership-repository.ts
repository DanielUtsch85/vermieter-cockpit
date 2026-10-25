import { sql, type Kysely, type Transaction } from 'kysely';
import {
  checkInvariants,
  formatShare,
  ownershipOn,
  planChange,
  planClose,
  planVoid,
  type AcquisitionRefusal,
  type ChangeOwnershipOutcome,
  type ChangeResult,
  type CloseOwnershipOutcome,
  type CreateOwnershipOutcome,
  type NewOwnership,
  type Ownership,
  type OwnershipChange,
  type OwnershipChangeRepository,
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
const CHANGE_SCOPE = 'ownership.change';

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
  'acquisition_id',
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
  acquisition_id: string | null;
  source_references: string[];
  notes: string | null;
  created_at: Date;
  version: number;
}

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected<T extends { readonly kind: string }> extends Error {
  constructor(readonly outcome: T) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the Ownership ports (api-design.md §26.1, §26.2). */
export class PostgresOwnershipRepository implements OwnershipRepository, OwnershipChangeRepository {
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

  async change(
    change: OwnershipChange,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<ChangeOwnershipOutcome> {
    try {
      return await this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<ChangeOwnershipOutcome> => {
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

/**
 * The Acquisition an Ownership is to link (§27.1): of this Realm and PropertyReference, and a `DRAFT`. Read `FOR SHARE`
 * after the PropertyReference and the Parties (the lock order of every writer), so a concurrent cancel, which takes it
 * `FOR UPDATE`, either commits first and is seen here, or waits for this transaction.
 */
async function checkAcquisition(
  trx: Transaction<Database>,
  acquisitionId: string | null,
  mreRealmId: string,
  propertyReferenceId: string,
): Promise<AcquisitionRefusal | undefined> {
  if (acquisitionId === null) return undefined;
  const acquisition = await trx
    .selectFrom('acquisition')
    .select('status')
    .where('id', '=', acquisitionId)
    .where('mre_realm_id', '=', mreRealmId)
    .where('property_reference_id', '=', propertyReferenceId)
    .forShare()
    .executeTakeFirst();
  if (acquisition === undefined) return { kind: 'ACQUISITION_NOT_FOUND', acquisitionId };
  if (acquisition.status !== 'DRAFT') return { kind: 'ACQUISITION_NOT_DRAFT', acquisitionId, status: acquisition.status };
  return undefined;
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
    acquisitionId: row.acquisition_id,
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
