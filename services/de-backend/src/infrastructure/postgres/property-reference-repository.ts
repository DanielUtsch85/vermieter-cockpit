import type { Kysely, Selectable } from 'kysely';
import {
  planRefresh,
  type CachedAddress,
  type ExternalReferenceState,
  type LinkOutcome,
  type MreObservation,
  type NewPropertyReference,
  type PropertyReference,
  type PropertyReferenceId,
  type PropertyReferenceRepository,
} from '../../domains/property-reference/index.js';
import { ExactDecimal, type AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import type { Database, PropertyReferenceTable } from './schema.js';

/** `id` is a PostgreSQL uuid; anything else cannot match and must not reach the query. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  async findById(id: string, mreRealmId: string): Promise<PropertyReference | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db
      .selectFrom('property_reference')
      .selectAll()
      .where('id', '=', id)
      .where('mre_realm_id', '=', mreRealmId)
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
          cached_address: toJson(reference.cachedAddress),
          cached_surface: reference.cachedSurface?.toString() ?? null,
          last_refreshed_at: reference.refreshedAt,
          last_observed_at: reference.refreshedAt,
          created_by: actor.actorId,
        })
        .onConflict((oc) => oc.columns(['mre_realm_id', 'mre_property_id']).doNothing())
        .returningAll()
        .executeTakeFirst();

      if (inserted !== undefined) {
        await writeAudit(trx, { type: 'PropertyReference', id: inserted.id }, 'LINKED', actor, {
          newVersion: inserted.version,
          metadata: { mreRealmId: inserted.mre_realm_id, mrePropertyId: inserted.mre_property_id },
        });
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

  async refresh(
    id: PropertyReferenceId,
    mreRealmId: string,
    observation: MreObservation,
    actor: AuditActor,
  ): Promise<PropertyReference | undefined> {
    if (!UUID.test(id)) return undefined;
    // The row lock serializes concurrent refreshes; each plans against the
    // version the previous one committed (READ COMMITTED re-reads it after the wait).
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
      const row = await trx
        .selectFrom('property_reference')
        .selectAll()
        .where('id', '=', id)
        .where('mre_realm_id', '=', mreRealmId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return undefined;

      const current = toDomain(row);
      const { next, stale, change } = planRefresh(current, observation);
      if (stale) return current;
      const updated = await trx
        .updateTable('property_reference')
        .set({
          external_reference_state: next.externalReferenceState,
          display_name: next.displayName,
          cached_address: toJson(next.cachedAddress),
          cached_surface: next.cachedSurface?.toString() ?? null,
          last_refreshed_at: next.lastRefreshedAt,
          last_observed_at: next.lastObservedAt,
          version: next.version,
          ...(change === undefined ? {} : { updated_at: new Date() }),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();

      if (change !== undefined) {
        await writeAudit(trx, { type: 'PropertyReference', id }, change.action, actor, {
          previousVersion: current.version,
          newVersion: next.version,
          metadata: {
            fields: change.fields,
            previousState: current.externalReferenceState,
            newState: next.externalReferenceState,
          },
        });
      }
      return toDomain(updated);
    });
  }
}

function toJson(address: CachedAddress | null): string | null {
  return address === null ? null : JSON.stringify(address);
}

function toDomain(row: Selectable<PropertyReferenceTable>): PropertyReference {
  return {
    id: row.id as PropertyReferenceId,
    mreRealmId: row.mre_realm_id,
    mrePropertyId: row.mre_property_id,
    externalReferenceState: row.external_reference_state as ExternalReferenceState,
    displayName: row.display_name,
    cachedAddress: row.cached_address as CachedAddress | null,
    cachedSurface: row.cached_surface === null ? null : ExactDecimal.of(row.cached_surface),
    lastRefreshedAt: row.last_refreshed_at,
    lastObservedAt: row.last_observed_at,
    createdAt: row.created_at,
    version: row.version,
  };
}
