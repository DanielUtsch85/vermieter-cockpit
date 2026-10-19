import type { Kysely, Selectable } from 'kysely';
import type {
  CachedAddress,
  ExternalReferenceState,
  LinkOutcome,
  NewPropertyReference,
  PropertyReference,
  PropertyReferenceId,
  PropertyReferenceRepository,
} from '../../domains/property-reference/index.js';
import type { AuditActor } from '../../shared/index.js';
import type { Database, PropertyReferenceTable } from './schema.js';

/** PostgreSQL implementation of the PropertyReference persistence port. */
export class PostgresPropertyReferenceRepository implements PropertyReferenceRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findByMreIdentity(mreRealmId: string, mrePropertyId: string): Promise<PropertyReference | undefined> {
    const row = await this.db
      .selectFrom('property_reference')
      .selectAll()
      .where('mre_realm_id', '=', mreRealmId)
      .where('mre_property_id', '=', mrePropertyId)
      .executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }

  async linkOnce(reference: NewPropertyReference, actor: AuditActor): Promise<LinkOutcome> {
    // READ COMMITTED explicitly, never the session default: ON CONFLICT DO NOTHING
    // waits for a concurrent insert of the same key to commit, and only under READ
    // COMMITTED does the SELECT below (a new statement, new snapshot) then see it.
    // Under REPEATABLE READ the insert fails with a serialization error instead.
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
      const inserted = await trx
        .insertInto('property_reference')
        .values({
          mre_realm_id: reference.mreRealmId,
          mre_property_id: reference.mrePropertyId,
          external_reference_state: 'ACTIVE' satisfies ExternalReferenceState,
          display_name: reference.displayName,
          cached_address: reference.cachedAddress === null ? null : JSON.stringify(reference.cachedAddress),
          last_refreshed_at: reference.refreshedAt,
          created_by: actor.actorId,
        })
        .onConflict((oc) => oc.columns(['mre_realm_id', 'mre_property_id']).doNothing())
        .returningAll()
        .executeTakeFirst();

      if (inserted !== undefined) {
        await trx
          .insertInto('audit_record')
          .values({
            entity_type: 'PropertyReference',
            entity_id: inserted.id,
            action: 'LINKED',
            actor_type: actor.actorType,
            actor_id: actor.actorId,
            metadata: JSON.stringify({ mreRealmId: inserted.mre_realm_id, mrePropertyId: inserted.mre_property_id }),
          })
          .execute();
        return { reference: toDomain(inserted), created: true };
      }

      const existing = await trx
        .selectFrom('property_reference')
        .selectAll()
        .where('mre_realm_id', '=', reference.mreRealmId)
        .where('mre_property_id', '=', reference.mrePropertyId)
        .executeTakeFirstOrThrow();
      return { reference: toDomain(existing), created: false };
    });
  }
}

function toDomain(row: Selectable<PropertyReferenceTable>): PropertyReference {
  return {
    id: row.id as PropertyReferenceId,
    mreRealmId: row.mre_realm_id,
    mrePropertyId: row.mre_property_id,
    externalReferenceState: row.external_reference_state as ExternalReferenceState,
    displayName: row.display_name,
    cachedAddress: row.cached_address as CachedAddress | null,
    lastRefreshedAt: row.last_refreshed_at,
    createdAt: row.created_at,
  };
}
