import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import {
  PARTY_FIELDS,
  planAmend,
  planDeactivate,
  type AmendPartyOutcome,
  type CreatePartyOutcome,
  type DeactivatePartyOutcome,
  type NewParty,
  type Party,
  type PartyChanges,
  type PartyFilter,
  type PartyId,
  type PartyPage,
  type PartyRepository,
  type PartyStatus,
  type PartyType,
} from '../../domains/party/index.js';
import { checkVersion, type AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import type { Database, PartyTable } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'Party';
const CREATE_SCOPE = 'party.create';

/** Domain field → column, for the fields `amend` writes. */
const COLUMN = {
  displayName: 'display_name',
  firstName: 'first_name',
  lastName: 'last_name',
  legalName: 'legal_name',
  registrationNumber: 'registration_number',
  email: 'email',
  phone: 'phone',
} as const satisfies Record<(typeof PARTY_FIELDS)[number], keyof PartyTable>;

/** PostgreSQL implementation of the Party persistence port (api-design.md §19.1). */
export class PostgresPartyRepository implements PartyRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(
    party: NewParty,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreatePartyOutcome> {
    // READ COMMITTED explicitly: the idempotency claim relies on it (idempotency.ts).
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
      const keyed =
        idempotency === undefined
          ? undefined
          : { ref: { mreRealmId: party.mreRealmId, scope: CREATE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
      if (keyed !== undefined) {
        const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
        if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
        // The Party as the first request created it, not as it is now (idempotency.ts).
        if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', party: fromSnapshot(claim.result) };
      }
      const inserted = await trx
        .insertInto('party')
        .values({
          mre_realm_id: party.mreRealmId,
          party_type: party.partyType,
          ...Object.fromEntries(PARTY_FIELDS.map((field) => [COLUMN[field], party[field]])),
          display_name: party.displayName,
          status: 'ACTIVE' satisfies PartyStatus,
          created_by: actor.actorId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const created = toParty(inserted);
      if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, inserted.id, toSnapshot(created));
      await writeAudit(trx, { type: ENTITY_TYPE, id: inserted.id }, 'CREATED', actor, {
        newVersion: inserted.version,
        metadata: { partyType: inserted.party_type },
      });
      return { kind: 'CREATED', party: created };
    });
  }

  async findById(id: string, mreRealmId: string): Promise<Party | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.selectFrom('party').selectAll().where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
    return row === undefined ? undefined : toParty(row);
  }

  async list(mreRealmId: string, filter: PartyFilter, page: { readonly page: number; readonly pageSize: number }): Promise<PartyPage> {
    const filtered = (db: Kysely<Database>) => {
      let query = db.selectFrom('party').where('mre_realm_id', '=', mreRealmId);
      if (filter.partyType !== undefined) query = query.where('party_type', '=', filter.partyType);
      if (filter.status !== undefined) query = query.where('status', '=', filter.status);
      if (filter.name !== undefined) {
        // Literal substring (§19.1): LIKE's wildcards and its escape character in the input match themselves. Both
        // sides go through PostgreSQL's lower(), so the case folding is the same on each.
        const pattern = `%${filter.name.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        query = query.where((eb) =>
          eb.or(
            (['display_name', 'legal_name', 'first_name', 'last_name'] as const).map(
              (column) => sql<boolean>`lower(${eb.ref(column)}) LIKE lower(${pattern}) ESCAPE '\\'`,
            ),
          ),
        );
      }
      const reference = filter.externalReference;
      if (reference !== undefined) {
        // Active references only (§20.1); entityType tenant is implied in Phase 2.
        query = query.where(({ exists, selectFrom }) =>
          exists(
            selectFrom('party_external_reference as r')
              .select('r.id')
              .whereRef('r.party_id', '=', 'party.id')
              .where('r.mre_realm_id', '=', mreRealmId)
              .where('r.system', '=', reference.system)
              .where('r.entity_type', '=', 'tenant')
              .where('r.external_id', '=', reference.externalId)
              .where('r.status', '=', 'ACTIVE'),
          ),
        );
      }
      return query;
    };
    // Count and page in one snapshot, so `total` and `items` agree.
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      const { n } = await filtered(trx)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const rows = await filtered(trx)
        .selectAll()
        .orderBy(sql`lower(display_name)`)
        .orderBy('id')
        .limit(page.pageSize)
        .offset((page.page - 1) * page.pageSize)
        .execute();
      return { items: rows.map(toParty), page: page.page, pageSize: page.pageSize, total: Number(n) };
    });
  }

  async amend(id: string, mreRealmId: string, changes: PartyChanges, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendPartyOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<AmendPartyOutcome> => {
      const current = await lockAndRead(trx, id, mreRealmId);
      if (current === undefined) return { kind: 'NOT_FOUND' };
      const plan = planAmend(current, changes);
      if (plan.kind === 'UNCHANGED') return { kind: 'AMENDED', party: current, changed: false };
      if (plan.kind !== 'AMEND') return plan;
      const conflict = checkVersion(current.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      const updated = await trx
        .updateTable('party')
        .set((eb) => ({
          ...Object.fromEntries(plan.changed.map((field) => [COLUMN[field], plan.values[field]])),
          version: eb('version', '+', 1),
          updated_at: new Date(),
        }))
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const amended = toParty(updated);
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'AMENDED', actor, {
        previousVersion: current.version,
        newVersion: amended.version,
        metadata: { changes: Object.fromEntries(plan.changed.map((field) => [field, { from: current[field], to: amended[field] }])) },
      });
      return { kind: 'AMENDED', party: amended, changed: true };
    });
  }

  async deactivate(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<DeactivatePartyOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<DeactivatePartyOutcome> => {
      const current = await lockAndRead(trx, id, mreRealmId);
      if (current === undefined) return { kind: 'NOT_FOUND' };
      const plan = planDeactivate(current, reason, at);
      if (plan.kind === 'UNCHANGED') return { kind: 'DEACTIVATED', party: current, changed: false };
      const conflict = checkVersion(current.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      const updated = await trx
        .updateTable('party')
        .set({
          status: plan.next.status,
          deactivated_at: plan.next.deactivatedAt,
          deactivation_reason: plan.next.deactivationReason,
          version: plan.next.version,
          updated_at: at,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'DEACTIVATED', actor, {
        previousVersion: current.version,
        newVersion: plan.next.version,
        metadata: { reason },
      });
      return { kind: 'DEACTIVATED', party: toParty(updated), changed: true };
    });
  }
}

/** Locks the Party row, then reads it in that same statement: nothing else changes it before this transaction ends. */
async function lockAndRead(trx: Transaction<Database>, id: string, mreRealmId: string): Promise<Party | undefined> {
  const row = await trx.selectFrom('party').selectAll().where('id', '=', id).where('mre_realm_id', '=', mreRealmId).forUpdate().executeTakeFirst();
  return row === undefined ? undefined : toParty(row);
}

export function toParty(row: Selectable<PartyTable>): Party {
  return {
    id: row.id as PartyId,
    mreRealmId: row.mre_realm_id,
    partyType: row.party_type as PartyType,
    displayName: row.display_name,
    firstName: row.first_name,
    lastName: row.last_name,
    legalName: row.legal_name,
    registrationNumber: row.registration_number,
    email: row.email,
    phone: row.phone,
    status: row.status as PartyStatus,
    deactivatedAt: row.deactivated_at,
    deactivationReason: row.deactivation_reason,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created Party as JSON for the idempotency store; dates as ISO strings. */
type PartySnapshot = Omit<Party, 'createdAt' | 'deactivatedAt'> & { readonly createdAt: string; readonly deactivatedAt: string | null };

function toSnapshot(party: Party): PartySnapshot {
  return { ...party, createdAt: party.createdAt.toISOString(), deactivatedAt: party.deactivatedAt?.toISOString() ?? null };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): Party {
  const snapshot = result as PartySnapshot;
  return {
    ...snapshot,
    id: snapshot.id,
    createdAt: new Date(snapshot.createdAt),
    deactivatedAt: snapshot.deactivatedAt === null ? null : new Date(snapshot.deactivatedAt),
  };
}
