import { sql, type Kysely, type Transaction } from 'kysely';
import {
  meaFromColumns,
  overlappingMembership,
  planMembershipAmend,
  planMembershipEnd,
  planMembershipVoid,
  planWegAmend,
  planWegVoid,
  type AdministratorRefusal,
  type AmendMembershipOutcome,
  type AmendWegOutcome,
  type CreateMembershipOutcome,
  type CreateWegOutcome,
  type EndMembershipOutcome,
  type MembershipChanges,
  type MembershipFilter,
  type MembershipStatus,
  type NewMembership,
  type NewWeg,
  type Page,
  type PageRequest,
  type VoidMembershipOutcome,
  type VoidWegOutcome,
  type Weg,
  type WegChanges,
  type WegFilter,
  type WegId,
  type WegMembership,
  type WegMembershipId,
  type WegRepository,
  type WegStatus,
} from '../../domains/weg/index.js';
import { checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEG_ENTITY = 'Weg';
const MEMBERSHIP_ENTITY = 'WegMembership';
const WEG_CREATE_SCOPE = 'weg.create';
const MEMBERSHIP_CREATE_SCOPE = 'weg-membership.create';

const WEG_COLUMNS = [
  'id',
  'mre_realm_id',
  'status',
  'display_name',
  'administrator_party_id',
  'financial_year_start_month',
  'notes',
  'voided_at',
  'void_reason',
  'created_at',
  'version',
] as const;

interface WegRow {
  id: string;
  mre_realm_id: string;
  status: string;
  display_name: string;
  administrator_party_id: string | null;
  financial_year_start_month: number;
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
  version: number;
}

/** Every column, the MEA as exact text and the dates as `YYYY-MM-DD`. */
const MEMBERSHIP_COLUMNS = [
  'id',
  'mre_realm_id',
  'weg_id',
  'property_reference_id',
  sql<string>`mea_numerator::text`.as('mea_numerator'),
  sql<string>`mea_denominator::text`.as('mea_denominator'),
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

interface MembershipRow {
  id: string;
  mre_realm_id: string;
  weg_id: string;
  property_reference_id: string;
  mea_numerator: string;
  mea_denominator: string;
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
class Rejected<T extends { readonly kind: string }> extends Error {
  constructor(readonly outcome: T) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the WEG port (api-design.md §49.1–§49.2). */
export class PostgresWegRepository implements WegRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createWeg(weg: NewWeg, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateWegOutcome> {
    try {
      // READ COMMITTED explicitly: the idempotency claim relies on it.
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateWegOutcome> => {
          const keyed =
            idempotency === undefined
              ? undefined
              : { ref: { mreRealmId: weg.mreRealmId, scope: WEG_CREATE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
          if (keyed !== undefined) {
            const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', weg: fromWegSnapshot(claim.result) };
          }
          const refusal = await administratorRefusalOf(trx, weg.administratorPartyId, weg.mreRealmId);
          if (refusal !== undefined) throw new Rejected<CreateWegOutcome>(refusal);
          const { id } = await trx
            .insertInto('weg')
            .values({
              mre_realm_id: weg.mreRealmId,
              status: 'ACTIVE' satisfies WegStatus,
              display_name: weg.displayName,
              administrator_party_id: weg.administratorPartyId,
              financial_year_start_month: weg.financialYearStartMonth,
              notes: weg.notes,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const created = await readWeg(trx, id);
          if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, id, toWegSnapshot(created));
          await writeAudit(trx, { type: WEG_ENTITY, id }, 'CREATED', actor, {
            newVersion: created.version,
            metadata: {
              displayName: created.displayName,
              administratorPartyId: created.administratorPartyId,
              financialYearStartMonth: created.financialYearStartMonth,
            },
          });
          return { kind: 'CREATED', weg: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome as CreateWegOutcome;
      throw error;
    }
  }

  async findWeg(id: string, mreRealmId: string): Promise<Weg | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.selectFrom('weg').select(WEG_COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
    return row === undefined ? undefined : toWeg(row);
  }

  async listWegs(mreRealmId: string, filter: WegFilter, page: PageRequest): Promise<Page<Weg>> {
    // Count and page in one snapshot, so `total` and `items` agree.
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const filtered = () => {
          let query = trx.selectFrom('weg').where('mre_realm_id', '=', mreRealmId);
          if (filter.statuses !== undefined && filter.statuses.length > 0) query = query.where('status', 'in', [...filter.statuses]);
          // A malformed filter id matches nothing, as an unknown one (§30.1: a read filter, never 404).
          const administrator = filter.administratorPartyId;
          if (administrator !== undefined) {
            query = UUID.test(administrator) ? query.where('administrator_party_id', '=', administrator) : query.where(sql<boolean>`false`);
          }
          const unit = filter.propertyReferenceId;
          if (unit !== undefined) {
            query = UUID.test(unit)
              ? query.where((eb) =>
                  eb.exists(
                    eb
                      .selectFrom('weg_membership')
                      .select('weg_membership.id')
                      .whereRef('weg_membership.weg_id', '=', 'weg.id')
                      .where('weg_membership.property_reference_id', '=', unit),
                  ),
                )
              : query.where(sql<boolean>`false`);
          }
          return query;
        };
        const { n } = await filtered()
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        const rows = await filtered()
          .select(WEG_COLUMNS)
          .orderBy('display_name')
          .orderBy('id')
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize)
          .execute();
        return { items: rows.map(toWeg), page: page.page, pageSize: page.pageSize, total: Number(n) };
      });
  }

  async amendWeg(id: string, mreRealmId: string, changes: WegChanges, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendWegOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<AmendWegOutcome> => {
        // Party → WEG: a newly named administrator FOR SHARE first, so a concurrent deactivate comes first or waits.
        const named = changes.administratorPartyId ?? null;
        const refusal = named === null ? undefined : await administratorRefusalOf(trx, named, mreRealmId);
        const row = await trx.selectFrom('weg').select(WEG_COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).forUpdate().executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = toWeg(row);
        const plan = planWegAmend(current, changes);
        if (plan.kind === 'UNCHANGED') return { kind: 'AMENDED', weg: current, changed: false };
        if (plan.kind !== 'AMEND') return plan;
        if (plan.newAdministratorId !== null && refusal !== undefined) return refusal;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('weg')
          .set((eb) => ({
            display_name: plan.values.displayName,
            administrator_party_id: plan.values.administratorPartyId,
            financial_year_start_month: plan.values.financialYearStartMonth,
            notes: plan.values.notes,
            version: eb('version', '+', 1),
            updated_at: new Date(),
          }))
          .where('id', '=', id)
          .execute();
        const amended = await readWeg(trx, id);
        await writeAudit(trx, { type: WEG_ENTITY, id }, 'AMENDED', actor, {
          previousVersion: current.version,
          newVersion: amended.version,
          metadata: { changes: Object.fromEntries(plan.changed.map((field) => [field, { from: current[field], to: amended[field] }])) },
        });
        return { kind: 'AMENDED', weg: amended, changed: true };
      });
  }

  async voidWeg(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidWegOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<VoidWegOutcome> => {
        const row = await trx.selectFrom('weg').select(WEG_COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).forUpdate().executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = toWeg(row);
        // Read after the WEG's lock: a membership write also writes the WEG (a no-op), so it committed before or waits.
        const active = await trx.selectFrom('weg_membership').select('id').where('weg_id', '=', id).where('status', '=', 'ACTIVE').execute();
        const plan = planWegVoid(
          current,
          reason,
          at,
          active.map((m) => m.id),
        );
        if (plan.kind === 'UNCHANGED') return { kind: 'VOIDED', weg: current, changed: false };
        if (plan.kind !== 'VOID') return plan;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('weg')
          .set({ status: plan.next.status, voided_at: at, voided_by: actor.actorId, void_reason: reason, version: plan.next.version, updated_at: at })
          .where('id', '=', id)
          .execute();
        const voided = await readWeg(trx, id);
        await writeAudit(trx, { type: WEG_ENTITY, id }, 'VOIDED', actor, {
          previousVersion: current.version,
          newVersion: voided.version,
          metadata: { reason },
        });
        return { kind: 'VOIDED', weg: voided, changed: true };
      });
  }

  async createMembership(
    membership: NewMembership,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateMembershipOutcome> {
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateMembershipOutcome> => {
          const keyed =
            idempotency === undefined
              ? undefined
              : { ref: { mreRealmId: membership.mreRealmId, scope: MEMBERSHIP_CREATE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
          if (keyed !== undefined) {
            const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', membership: fromMembershipSnapshot(claim.result) };
          }
          // The order of checks (§49.2) is the WEG before the unit; the locks are the unit first (P6-D9), so the WEG is
          // read plainly here, then written (a no-op) after the unit's lock.
          const weg = await trx
            .selectFrom('weg')
            .select('id')
            .where('id', '=', membership.wegId)
            .where('mre_realm_id', '=', membership.mreRealmId)
            .executeTakeFirst();
          if (weg === undefined) throw new Rejected<CreateMembershipOutcome>({ kind: 'WEG_NOT_FOUND' });
          // The no-op write the trigger does first: writers of one unit serialise here, so the memberships read below
          // include a concurrent writer's committed row.
          const touched = await touchPropertyReference(trx, membership.propertyReferenceId, membership.mreRealmId);
          // The same no-op write of the WEG the trigger does: a void waits for this transaction, or this one for it.
          const locked = await trx
            .updateTable('weg')
            .set((eb) => ({ version: eb.ref('version') }))
            .where('id', '=', membership.wegId)
            .returning(['status', 'version'])
            .executeTakeFirstOrThrow();
          if (locked.status !== 'ACTIVE') throw new Rejected<CreateMembershipOutcome>({ kind: 'WEG_NOT_ACTIVE', status: locked.status as WegStatus });
          if (!touched) throw new Rejected<CreateMembershipOutcome>({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' });
          const overlap = overlappingMembership(await membershipsOfUnit(trx, membership.propertyReferenceId), membership);
          if (overlap !== undefined)
            throw new Rejected<CreateMembershipOutcome>({ kind: 'OVERLAPPING_WEG_MEMBERSHIP', membershipId: overlap.id, wegId: overlap.wegId });
          const { id } = await trx
            .insertInto('weg_membership')
            .values({
              mre_realm_id: membership.mreRealmId,
              weg_id: membership.wegId,
              property_reference_id: membership.propertyReferenceId,
              mea_numerator: membership.mea.numerator,
              mea_denominator: membership.mea.denominator,
              valid_from: membership.validFrom,
              valid_until: membership.validUntil,
              status: 'ACTIVE' satisfies MembershipStatus,
              source_references: [...membership.sourceReferences],
              notes: membership.notes,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const created = await readMembership(trx, id);
          if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, id, toMembershipSnapshot(created));
          await writeAudit(trx, { type: MEMBERSHIP_ENTITY, id }, 'CREATED', actor, {
            newVersion: created.version,
            metadata: {
              wegId: created.wegId,
              propertyReferenceId: created.propertyReferenceId,
              miteigentumsanteil: `${created.mea.numerator}/${created.mea.denominator}`,
              validFrom: created.validFrom,
              validUntil: created.validUntil,
            },
          });
          // The WEG itself is unchanged: its version stays, the record only marks the event on it.
          await writeAudit(trx, { type: WEG_ENTITY, id: created.wegId }, 'MEMBERSHIP_ADDED', actor, {
            newVersion: locked.version,
            metadata: { membershipId: id },
          });
          return { kind: 'CREATED', membership: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome as CreateMembershipOutcome;
      throw error;
    }
  }

  async findMembership(id: string, mreRealmId: string): Promise<WegMembership | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db
      .selectFrom('weg_membership')
      .select(MEMBERSHIP_COLUMNS)
      .where('id', '=', id)
      .where('mre_realm_id', '=', mreRealmId)
      .executeTakeFirst();
    return row === undefined ? undefined : toMembership(row);
  }

  async listMemberships(wegId: string, mreRealmId: string, filter: MembershipFilter, page: PageRequest): Promise<Page<WegMembership> | undefined> {
    if (!UUID.test(wegId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const weg = await trx.selectFrom('weg').select('id').where('id', '=', wegId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
        if (weg === undefined) return undefined;
        return pageOf(
          trx,
          (q) => {
            let query = q.where('weg_id', '=', wegId).where('mre_realm_id', '=', mreRealmId);
            if (filter.statuses !== undefined && filter.statuses.length > 0) query = query.where('status', 'in', [...filter.statuses]);
            const unit = filter.propertyReferenceId;
            if (unit !== undefined) query = UUID.test(unit) ? query.where('property_reference_id', '=', unit) : query.where(sql<boolean>`false`);
            return query;
          },
          page,
        );
      });
  }

  async unitHistory(propertyReferenceId: string, mreRealmId: string, page: PageRequest): Promise<Page<WegMembership> | undefined> {
    if (!UUID.test(propertyReferenceId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        if (!(await propertyReferenceExists(trx, propertyReferenceId, mreRealmId))) return undefined;
        return pageOf(trx, (q) => q.where('property_reference_id', '=', propertyReferenceId).where('mre_realm_id', '=', mreRealmId), page);
      });
  }

  async unitOn(propertyReferenceId: string, mreRealmId: string, asOf: BusinessDate): Promise<WegMembership | null | undefined> {
    if (!UUID.test(propertyReferenceId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        if (!(await propertyReferenceExists(trx, propertyReferenceId, mreRealmId))) return undefined;
        const row = await trx
          .selectFrom('weg_membership')
          .select(MEMBERSHIP_COLUMNS)
          .where('property_reference_id', '=', propertyReferenceId)
          .where('mre_realm_id', '=', mreRealmId)
          .where('status', '=', 'ACTIVE')
          .where('valid_from', '<=', asOf)
          .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>=', asOf)]))
          .executeTakeFirst();
        return row === undefined ? null : toMembership(row);
      });
  }

  async amendMembership(
    id: string,
    mreRealmId: string,
    changes: MembershipChanges,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<AmendMembershipOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<AmendMembershipOutcome> => {
        // The trigger writes the unit on every update: take it first here too, one lock order on every path (P6-D9).
        await touchPropertyReferenceOf(trx, id, mreRealmId);
        const current = await lockMembership(trx, id, mreRealmId);
        if (current === undefined) return { kind: 'NOT_FOUND' };
        const plan = planMembershipAmend(current, changes);
        if (plan.kind === 'UNCHANGED') return { kind: 'AMENDED', membership: current, changed: false };
        if (plan.kind !== 'AMEND') return plan;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('weg_membership')
          .set((eb) => ({
            source_references: [...plan.values.sourceReferences],
            notes: plan.values.notes,
            version: eb('version', '+', 1),
            updated_at: new Date(),
          }))
          .where('id', '=', id)
          .execute();
        const amended = await readMembership(trx, id);
        await writeAudit(trx, { type: MEMBERSHIP_ENTITY, id }, 'AMENDED', actor, {
          previousVersion: current.version,
          newVersion: amended.version,
          metadata: { changes: Object.fromEntries(plan.changed.map((field) => [field, { from: current[field], to: amended[field] }])) },
        });
        return { kind: 'AMENDED', membership: amended, changed: true };
      });
  }

  async endMembership(
    id: string,
    mreRealmId: string,
    validUntil: BusinessDate,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<EndMembershipOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<EndMembershipOutcome> => {
        await touchPropertyReferenceOf(trx, id, mreRealmId);
        const current = await lockMembership(trx, id, mreRealmId);
        if (current === undefined) return { kind: 'NOT_FOUND' };
        const plan = planMembershipEnd(current, validUntil);
        if (plan.kind === 'UNCHANGED') return { kind: 'ENDED', membership: current, changed: false };
        if (plan.kind !== 'END') return plan;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('weg_membership')
          .set({ valid_until: validUntil, version: plan.next.version, updated_at: new Date() })
          .where('id', '=', id)
          .execute();
        const ended = await readMembership(trx, id);
        await writeAudit(trx, { type: MEMBERSHIP_ENTITY, id }, 'ENDED', actor, {
          previousVersion: current.version,
          newVersion: ended.version,
          metadata: { validUntil: { from: current.validUntil, to: ended.validUntil } },
        });
        return { kind: 'ENDED', membership: ended, changed: true };
      });
  }

  async voidMembership(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidMembershipOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<VoidMembershipOutcome> => {
        await touchPropertyReferenceOf(trx, id, mreRealmId);
        const current = await lockMembership(trx, id, mreRealmId);
        if (current === undefined) return { kind: 'NOT_FOUND' };
        const plan = planMembershipVoid(current, reason, at);
        if (plan.kind === 'UNCHANGED') return { kind: 'VOIDED', membership: current, changed: false };
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('weg_membership')
          .set({ status: plan.next.status, voided_at: at, voided_by: actor.actorId, void_reason: reason, version: plan.next.version, updated_at: at })
          .where('id', '=', id)
          .execute();
        const voided = await readMembership(trx, id);
        await writeAudit(trx, { type: MEMBERSHIP_ENTITY, id }, 'VOIDED', actor, {
          previousVersion: current.version,
          newVersion: voided.version,
          metadata: { reason },
        });
        return { kind: 'VOIDED', membership: voided, changed: true };
      });
  }
}

/** §49.1 check 2: the administrator of this Realm, read `FOR SHARE` (deactivate takes it `FOR UPDATE`), and `ACTIVE`. */
async function administratorRefusalOf(trx: Transaction<Database>, partyId: string | null, mreRealmId: string): Promise<AdministratorRefusal | undefined> {
  if (partyId === null) return undefined;
  const party = await trx.selectFrom('party').select('status').where('id', '=', partyId).where('mre_realm_id', '=', mreRealmId).forShare().executeTakeFirst();
  if (party === undefined) return { kind: 'PARTY_NOT_FOUND', partyId };
  if (party.status !== 'ACTIVE') return { kind: 'PARTY_INACTIVE', partyId };
  return undefined;
}

/** The no-op write of a unit that the trigger does too; false for an unknown or foreign PropertyReference. */
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

/** The same no-op write for the unit of a membership; nothing happens for an unknown or foreign membership. */
async function touchPropertyReferenceOf(trx: Transaction<Database>, membershipId: string, mreRealmId: string): Promise<void> {
  await trx
    .updateTable('property_reference')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', (eb) =>
      eb.selectFrom('weg_membership').select('property_reference_id').where('id', '=', membershipId).where('mre_realm_id', '=', mreRealmId),
    )
    .execute();
}

/** The unit's memberships in every WEG, `VOID` ones included (the domain ignores them); a new statement each call. */
async function membershipsOfUnit(trx: Transaction<Database>, propertyReferenceId: string): Promise<WegMembership[]> {
  return (await trx.selectFrom('weg_membership').select(MEMBERSHIP_COLUMNS).where('property_reference_id', '=', propertyReferenceId).execute()).map(
    toMembership,
  );
}

async function propertyReferenceExists(trx: Transaction<Database>, id: string, mreRealmId: string): Promise<boolean> {
  return (await trx.selectFrom('property_reference').select('id').where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst()) !== undefined;
}

function baseMembershipQuery(trx: Transaction<Database>) {
  return trx.selectFrom('weg_membership');
}

type MembershipQuery = ReturnType<typeof baseMembershipQuery>;

/** Count and page of memberships, by `validFrom`, `createdAt`, id (§49.2), inside the caller's snapshot. */
async function pageOf(trx: Transaction<Database>, where: (query: MembershipQuery) => MembershipQuery, page: PageRequest): Promise<Page<WegMembership>> {
  const filtered = () => where(baseMembershipQuery(trx));
  const { n } = await filtered()
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  const rows = await filtered()
    .select(MEMBERSHIP_COLUMNS)
    .orderBy('valid_from')
    .orderBy('created_at')
    .orderBy('id')
    .limit(page.pageSize)
    .offset((page.page - 1) * page.pageSize)
    .execute();
  return { items: rows.map(toMembership), page: page.page, pageSize: page.pageSize, total: Number(n) };
}

/** Locks the membership row, then reads it in that same statement. */
async function lockMembership(trx: Transaction<Database>, id: string, mreRealmId: string): Promise<WegMembership | undefined> {
  const row = await trx
    .selectFrom('weg_membership')
    .select(MEMBERSHIP_COLUMNS)
    .where('id', '=', id)
    .where('mre_realm_id', '=', mreRealmId)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? undefined : toMembership(row);
}

async function readWeg(trx: Transaction<Database>, id: string): Promise<Weg> {
  return toWeg(await trx.selectFrom('weg').select(WEG_COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

async function readMembership(trx: Transaction<Database>, id: string): Promise<WegMembership> {
  return toMembership(await trx.selectFrom('weg_membership').select(MEMBERSHIP_COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

function toWeg(row: WegRow): Weg {
  return {
    id: row.id as WegId,
    mreRealmId: row.mre_realm_id,
    status: row.status as WegStatus,
    displayName: row.display_name,
    administratorPartyId: row.administrator_party_id,
    financialYearStartMonth: row.financial_year_start_month,
    notes: row.notes,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    version: row.version,
  };
}

function toMembership(row: MembershipRow): WegMembership {
  return {
    id: row.id as WegMembershipId,
    mreRealmId: row.mre_realm_id,
    wegId: row.weg_id,
    propertyReferenceId: row.property_reference_id,
    mea: meaFromColumns(row.mea_numerator, row.mea_denominator),
    validFrom: row.valid_from as BusinessDate,
    validUntil: row.valid_until as BusinessDate | null,
    status: row.status as MembershipStatus,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    sourceReferences: row.source_references,
    notes: row.notes,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** A created record as JSON for the idempotency store; timestamps as ISO strings. */
type Snapshot<T extends { readonly createdAt: Date; readonly voidedAt: Date | null }> = Omit<T, 'createdAt' | 'voidedAt'> & {
  readonly createdAt: string;
  readonly voidedAt: string | null;
};

function toWegSnapshot(weg: Weg): Snapshot<Weg> {
  return { ...weg, createdAt: weg.createdAt.toISOString(), voidedAt: weg.voidedAt?.toISOString() ?? null };
}

/** Written by toWegSnapshot in the same codebase, so its shape is trusted. */
function fromWegSnapshot(result: unknown): Weg {
  const snapshot = result as Snapshot<Weg>;
  return { ...snapshot, createdAt: new Date(snapshot.createdAt), voidedAt: snapshot.voidedAt === null ? null : new Date(snapshot.voidedAt) };
}

function toMembershipSnapshot(membership: WegMembership): Snapshot<WegMembership> {
  return { ...membership, createdAt: membership.createdAt.toISOString(), voidedAt: membership.voidedAt?.toISOString() ?? null };
}

function fromMembershipSnapshot(result: unknown): WegMembership {
  const snapshot = result as Snapshot<WegMembership>;
  return { ...snapshot, createdAt: new Date(snapshot.createdAt), voidedAt: snapshot.voidedAt === null ? null : new Date(snapshot.voidedAt) };
}
