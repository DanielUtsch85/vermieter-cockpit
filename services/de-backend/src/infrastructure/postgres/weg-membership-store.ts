import { sql, type Kysely, type Transaction } from 'kysely';
import {
  overlappingMembership,
  holdsOutside,
  planMembershipAmend,
  planMembershipEnd,
  planMembershipVoid,
  type AmendMembershipOutcome,
  type CreateMembershipOutcome,
  type EndMembershipOutcome,
  type MembershipChanges,
  type MembershipFilter,
  type MembershipHolds,
  type MembershipStatus,
  type NewMembership,
  type Page,
  type PageRequest,
  type VoidMembershipOutcome,
  type WegMembership,
  type WegStatus,
} from '../../domains/weg/index.js';
import { WEG_SPLIT_CATEGORIES, isWegSplit } from '../../domains/ledger/index.js';
import { checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import type { Database } from './schema.js';
import {
  MEMBERSHIP_COLUMNS,
  MEMBERSHIP_ENTITY,
  Rejected,
  UUID,
  WEG_ENTITY,
  fromMembershipSnapshot,
  readMembership,
  toMembership,
  toMembershipSnapshot,
} from './weg-rows.js';

/** The memberships of a WEG (api-design.md §49.2–§49.3): create, find, list, the unit's history, amend, end and void. */

const MEMBERSHIP_CREATE_SCOPE = 'weg-membership.create';

export async function createMembership(
  db: Kysely<Database>,
  membership: NewMembership,
  actor: AuditActor,
  idempotency?: { readonly key: string; readonly fingerprint: string },
): Promise<CreateMembershipOutcome> {
  try {
    return await db
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

export async function findMembership(db: Kysely<Database>, id: string, mreRealmId: string): Promise<WegMembership | undefined> {
  if (!UUID.test(id)) return undefined;
  const row = await db.selectFrom('weg_membership').select(MEMBERSHIP_COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
  return row === undefined ? undefined : toMembership(row);
}

export async function listMemberships(
  db: Kysely<Database>,
  wegId: string,
  mreRealmId: string,
  filter: MembershipFilter,
  page: PageRequest,
): Promise<Page<WegMembership> | undefined> {
  if (!UUID.test(wegId)) return undefined;
  return db
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

export async function unitHistory(
  db: Kysely<Database>,
  propertyReferenceId: string,
  mreRealmId: string,
  page: PageRequest,
): Promise<Page<WegMembership> | undefined> {
  if (!UUID.test(propertyReferenceId)) return undefined;
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      if (!(await propertyReferenceExists(trx, propertyReferenceId, mreRealmId))) return undefined;
      return pageOf(trx, (q) => q.where('property_reference_id', '=', propertyReferenceId).where('mre_realm_id', '=', mreRealmId), page);
    });
}

export async function unitOn(
  db: Kysely<Database>,
  propertyReferenceId: string,
  mreRealmId: string,
  asOf: BusinessDate,
): Promise<WegMembership | null | undefined> {
  if (!UUID.test(propertyReferenceId)) return undefined;
  return db
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

export async function amendMembership(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  changes: MembershipChanges,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<AmendMembershipOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
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

export async function endMembership(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  validUntil: BusinessDate,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<EndMembershipOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx): Promise<EndMembershipOutcome> => {
      await touchPropertyReferenceOf(trx, id, mreRealmId);
      const current = await lockMembership(trx, id, mreRealmId);
      if (current === undefined) return { kind: 'NOT_FOUND' };
      const plan = planMembershipEnd(current, validUntil);
      if (plan.kind === 'UNCHANGED') return { kind: 'ENDED', membership: current, changed: false };
      if (plan.kind !== 'END') return plan;
      // §49.3, §49.5: read after the unit's write, so a concurrent split or plan writer committed before or waits.
      const held = holdsOutside(current, plan.next, await holdsOf(trx, current));
      if (held !== undefined) return held;
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

export async function voidMembership(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  reason: string,
  at: Date,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<VoidMembershipOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx): Promise<VoidMembershipOutcome> => {
      await touchPropertyReferenceOf(trx, id, mreRealmId);
      const current = await lockMembership(trx, id, mreRealmId);
      if (current === undefined) return { kind: 'NOT_FOUND' };
      const plan = planMembershipVoid(current, reason, at);
      if (plan.kind === 'UNCHANGED') return { kind: 'VOIDED', membership: current, changed: false };
      const held = holdsOutside(current, null, await holdsOf(trx, current));
      if (held !== undefined) return held;
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

/** The unit's WEG splits (any status, reversals included), the membership's `ACTIVE` plans and statements not `VOID` (§49.3, §49.5, §50). */
async function holdsOf(trx: Transaction<Database>, membership: WegMembership): Promise<MembershipHolds> {
  const splits = await trx
    .selectFrom('transaction_split')
    .innerJoin('financial_category', 'financial_category.id', 'transaction_split.financial_category_id')
    .innerJoin('ledger_transaction', 'ledger_transaction.id', 'transaction_split.transaction_id')
    .select(['transaction_split.transaction_id', sql<string>`to_char(ledger_transaction.booking_date, 'YYYY-MM-DD')`.as('booking_date')])
    .where('transaction_split.property_reference_id', '=', membership.propertyReferenceId)
    .where('financial_category.code', 'in', [...WEG_SPLIT_CATEGORIES])
    // A settlement follows its statement, not its booking date (§51, review on #152): the statement holds the period.
    .where('transaction_split.weg_annual_statement_id', 'is', null)
    // Likewise a Sonderumlage's payment follows its assessment (§51A), which holds its resolution date.
    .where('transaction_split.weg_special_assessment_id', 'is', null)
    .execute();
  const plans = await trx
    .selectFrom('weg_economic_plan')
    .select(['id', sql<string>`to_char(effective_from, 'YYYY-MM-DD')`.as('effective_from')])
    .where('membership_id', '=', membership.id)
    .where('status', '=', 'ACTIVE')
    .execute();
  const statements = await trx
    .selectFrom('weg_annual_statement')
    .select(['id', sql<string>`to_char(period_from, 'YYYY-MM-DD')`.as('period_from'), sql<string>`to_char(period_until, 'YYYY-MM-DD')`.as('period_until')])
    .where('membership_id', '=', membership.id)
    .where('status', '<>', 'VOID')
    .execute();
  const assessments = await trx
    .selectFrom('weg_special_assessment')
    .select(['id', sql<string>`to_char(resolution_date, 'YYYY-MM-DD')`.as('resolution_date')])
    .where('membership_id', '=', membership.id)
    .where('status', '<>', 'VOID')
    .execute();
  return {
    splits: splits.map((s) => ({ transactionId: s.transaction_id, bookingDate: s.booking_date as BusinessDate })),
    plans: plans.map((p) => ({ id: p.id, effectiveFrom: p.effective_from as BusinessDate })),
    statements: statements.map((st) => ({ id: st.id, periodFrom: st.period_from as BusinessDate, periodUntil: st.period_until as BusinessDate })),
    assessments: assessments.map((a) => ({ id: a.id, resolutionDate: a.resolution_date as BusinessDate })),
  };
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

/**
 * §49.3 for a split set: the units of its WEG splits, each PropertyReference row written (a no-op) in id order after
 * the Transaction's lock (Transaction → PropertyReference, P6-D9), then the units with an `ACTIVE` membership on the
 * booking date. An end or void of a unit's membership writes the same row first, so it is waited for and seen.
 */
export async function unitsWithMembershipOn(
  trx: Transaction<Database>,
  mreRealmId: string,
  splits: readonly { readonly financialCategoryCode: string; readonly propertyReferenceId: string | null }[],
  bookingDate: BusinessDate,
): Promise<Set<string>> {
  const units = [
    ...new Set(splits.filter(isWegSplit).flatMap((s) => (s.propertyReferenceId !== null && UUID.test(s.propertyReferenceId) ? [s.propertyReferenceId] : []))),
  ].sort();
  for (const unit of units) await touchPropertyReference(trx, unit, mreRealmId);
  if (units.length === 0) return new Set();
  const rows = await trx
    .selectFrom('weg_membership')
    .select('property_reference_id')
    .where('property_reference_id', 'in', units)
    .where('mre_realm_id', '=', mreRealmId)
    .where('status', '=', 'ACTIVE')
    .where('valid_from', '<=', bookingDate)
    .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>=', bookingDate)]))
    .execute();
  return new Set(rows.map((r) => r.property_reference_id));
}
