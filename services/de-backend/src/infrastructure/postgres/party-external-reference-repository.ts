import type { Kysely, Selectable, Transaction } from 'kysely';
import {
  planClaim,
  planEnd,
  type ClaimCheck,
  type ClaimOutcome,
  type EndOutcome,
  type ExternalEntityType,
  type ExternalReferenceId,
  type ExternalReferenceKey,
  type ExternalReferencePage,
  type ExternalReferenceStatus,
  type ExternalSystem,
  type PartyExternalReference,
  type PartyExternalReferenceRepository,
  type PartyId,
} from '../../domains/party/index.js';
import { checkVersion, type AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { toParty } from './party-repository.js';
import type { Database, PartyExternalReferenceTable } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'PartyExternalReference';
/** A claim that lost to another Party re-reads the winner; if that one was ended meanwhile, it tries again. */
const CLAIM_ATTEMPTS = 3;

/** PostgreSQL implementation of the external-reference port (api-design.md §20.1). */
export class PostgresPartyExternalReferenceRepository implements PartyExternalReferenceRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async checkClaim(partyId: string, key: ExternalReferenceKey): Promise<ClaimCheck> {
    if (!UUID.test(partyId)) return { kind: 'NOT_FOUND' };
    const row = await this.db.selectFrom('party').selectAll().where('id', '=', partyId).where('mre_realm_id', '=', key.mreRealmId).executeTakeFirst();
    if (row === undefined) return { kind: 'NOT_FOUND' };
    return planClaim(toParty(row), await activeFor(this.db, key));
  }

  async claim(partyId: string, key: ExternalReferenceKey, actor: AuditActor): Promise<ClaimOutcome> {
    if (!UUID.test(partyId)) return { kind: 'NOT_FOUND' };
    // READ COMMITTED explicitly: the re-read after a lost insert must see the winner's commit (a new snapshot).
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<ClaimOutcome> => {
        // The Party's lock serialises this claim with `deactivate` and with other claims of this Party.
        const row = await trx
          .selectFrom('party')
          .selectAll()
          .where('id', '=', partyId)
          .where('mre_realm_id', '=', key.mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const party = toParty(row);
        for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt++) {
          const plan = planClaim(party, await activeFor(trx, key));
          if (plan.kind !== 'CLAIM') return plan;
          // Claims of other Parties are not under this lock; the active-key index decides. ON CONFLICT names its
          // predicate, so the partial index is the arbiter: a concurrent insert of the key is waited for and then
          // yields no row, instead of a unique violation that would abort the transaction (§20.1).
          const inserted = await trx
            .insertInto('party_external_reference')
            .values({
              party_id: party.id,
              mre_realm_id: key.mreRealmId,
              system: key.system,
              entity_type: key.entityType,
              external_id: key.externalId,
              status: 'ACTIVE' satisfies ExternalReferenceStatus,
              created_by: actor.actorId,
            })
            .onConflict((oc) => oc.columns(['system', 'mre_realm_id', 'entity_type', 'external_id']).where('status', '=', 'ACTIVE').doNothing())
            .returningAll()
            .executeTakeFirst();
          if (inserted === undefined) continue; // the next statement sees the committed winner
          await writeAudit(trx, { type: ENTITY_TYPE, id: inserted.id }, 'CREATED', actor, {
            newVersion: inserted.version,
            metadata: { partyId: party.id, system: key.system, entityType: key.entityType, externalId: key.externalId },
          });
          return { kind: 'CREATED', reference: toReference(inserted) };
        }
        return { kind: 'CONTENDED' };
      });
  }

  async end(partyId: string, referenceId: string, mreRealmId: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<EndOutcome> {
    if (!UUID.test(partyId) || !UUID.test(referenceId)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<EndOutcome> => {
        const row = await trx
          .selectFrom('party_external_reference')
          .selectAll()
          .where('id', '=', referenceId)
          .where('party_id', '=', partyId)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = toReference(row);
        const plan = planEnd(current, at);
        if (plan.kind === 'UNCHANGED') return { kind: 'ENDED', reference: current, changed: false };
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        const updated = await trx
          .updateTable('party_external_reference')
          .set({ status: plan.next.status, ended_at: plan.next.endedAt, version: plan.next.version, updated_at: at })
          .where('id', '=', referenceId)
          .returningAll()
          .executeTakeFirstOrThrow();
        await writeAudit(trx, { type: ENTITY_TYPE, id: referenceId }, 'ENDED', actor, {
          previousVersion: current.version,
          newVersion: plan.next.version,
          metadata: { partyId, externalId: current.externalId },
        });
        return { kind: 'ENDED', reference: toReference(updated), changed: true };
      });
  }

  async list(
    partyId: string,
    mreRealmId: string,
    filter: { readonly status?: ExternalReferenceStatus },
    page: { readonly page: number; readonly pageSize: number },
  ): Promise<ExternalReferencePage | undefined> {
    if (!UUID.test(partyId)) return undefined;
    // Party, count and page in one snapshot, so `total` and `items` agree.
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const party = await trx.selectFrom('party').select('id').where('id', '=', partyId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
        if (party === undefined) return undefined;
        const filtered = () => {
          let query = trx.selectFrom('party_external_reference').where('party_id', '=', partyId).where('mre_realm_id', '=', mreRealmId);
          if (filter.status !== undefined) query = query.where('status', '=', filter.status);
          return query;
        };
        const { n } = await filtered()
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        const rows = await filtered()
          .selectAll()
          .orderBy('created_at')
          .orderBy('id')
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize)
          .execute();
        return { items: rows.map(toReference), page: page.page, pageSize: page.pageSize, total: Number(n) };
      });
  }
}

/** The active reference holding the key, if any; a new statement, so under READ COMMITTED it sees the latest commit. */
async function activeFor(db: Kysely<Database> | Transaction<Database>, key: ExternalReferenceKey): Promise<PartyExternalReference | undefined> {
  const row = await db
    .selectFrom('party_external_reference')
    .selectAll()
    .where('system', '=', key.system)
    .where('mre_realm_id', '=', key.mreRealmId)
    .where('entity_type', '=', key.entityType)
    .where('external_id', '=', key.externalId)
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst();
  return row === undefined ? undefined : toReference(row);
}

function toReference(row: Selectable<PartyExternalReferenceTable>): PartyExternalReference {
  return {
    id: row.id as ExternalReferenceId,
    partyId: row.party_id as PartyId,
    system: row.system as ExternalSystem,
    mreRealmId: row.mre_realm_id,
    entityType: row.entity_type as ExternalEntityType,
    externalId: row.external_id,
    status: row.status as ExternalReferenceStatus,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    version: row.version,
  };
}
