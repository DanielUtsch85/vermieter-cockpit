import { sql, type Kysely, type Transaction } from 'kysely';
import {
  planWegAmend,
  planWegVoid,
  type AdministratorRefusal,
  type AmendWegOutcome,
  type CreateWegOutcome,
  type NewWeg,
  type Page,
  type PageRequest,
  type VoidWegOutcome,
  type Weg,
  type WegChanges,
  type WegFilter,
  type WegStatus,
} from '../../domains/weg/index.js';
import { checkVersion, type AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import type { Database } from './schema.js';
import { Rejected, UUID, WEG_COLUMNS, WEG_ENTITY, fromWegSnapshot, readWeg, toWeg, toWegSnapshot } from './weg-rows.js';

/** The WEG itself (api-design.md §49.1): create, find, list, amend and void. */

const WEG_CREATE_SCOPE = 'weg.create';

export async function createWeg(
  db: Kysely<Database>,
  weg: NewWeg,
  actor: AuditActor,
  idempotency?: { readonly key: string; readonly fingerprint: string },
): Promise<CreateWegOutcome> {
  try {
    // READ COMMITTED explicitly: the idempotency claim relies on it.
    return await db
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

export async function findWeg(db: Kysely<Database>, id: string, mreRealmId: string): Promise<Weg | undefined> {
  if (!UUID.test(id)) return undefined;
  const row = await db.selectFrom('weg').select(WEG_COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
  return row === undefined ? undefined : toWeg(row);
}

export async function listWegs(db: Kysely<Database>, mreRealmId: string, filter: WegFilter, page: PageRequest): Promise<Page<Weg>> {
  // Count and page in one snapshot, so `total` and `items` agree.
  return db
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

export async function amendWeg(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  changes: WegChanges,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<AmendWegOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
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
      // §49.5, §50: plans and statements are filed by financial year; weg_financial_year_held and _statements are the backstop.
      if (plan.changed.includes('financialYearStartMonth') && (await hasYears(trx, id))) return { kind: 'WEG_HAS_YEARS' };
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

export async function voidWeg(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  reason: string,
  at: Date,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<VoidWegOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
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

/** §49.1 check 2: the administrator of this Realm, read `FOR SHARE` (deactivate takes it `FOR UPDATE`), and `ACTIVE`. */
async function administratorRefusalOf(trx: Transaction<Database>, partyId: string | null, mreRealmId: string): Promise<AdministratorRefusal | undefined> {
  if (partyId === null) return undefined;
  const party = await trx.selectFrom('party').select('status').where('id', '=', partyId).where('mre_realm_id', '=', mreRealmId).forShare().executeTakeFirst();
  if (party === undefined) return { kind: 'PARTY_NOT_FOUND', partyId };
  if (party.status !== 'ACTIVE') return { kind: 'PARTY_INACTIVE', partyId };
  return undefined;
}

/** Whether a membership of the WEG has an `ACTIVE` plan or a statement that is not `VOID` (§49.5, §50). */
async function hasYears(trx: Transaction<Database>, wegId: string): Promise<boolean> {
  const plan = await trx
    .selectFrom('weg_economic_plan')
    .innerJoin('weg_membership', 'weg_membership.id', 'weg_economic_plan.membership_id')
    .select('weg_economic_plan.id')
    .where('weg_membership.weg_id', '=', wegId)
    .where('weg_economic_plan.status', '=', 'ACTIVE')
    .executeTakeFirst();
  if (plan !== undefined) return true;
  const statement = await trx
    .selectFrom('weg_annual_statement')
    .innerJoin('weg_membership', 'weg_membership.id', 'weg_annual_statement.membership_id')
    .select('weg_annual_statement.id')
    .where('weg_membership.weg_id', '=', wegId)
    .where('weg_annual_statement.status', '<>', 'VOID')
    .executeTakeFirst();
  return statement !== undefined;
}
