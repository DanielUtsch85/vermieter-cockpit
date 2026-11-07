import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import { stageAudit } from './audit-stage.test-support.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import type { Database } from './schema.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * The shared setup of VC-X-24's database tests (api-design.md §58U, migration 0076): one migrated schema per test file,
 * Parties created and amended through the repository (so the `AMENDED` records are the service's own), the raw record
 * insert past the repository, and the reads of a record. Names, addresses and numbers are synthetic. Test support only.
 */
export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

export const REALM = '64b0c0ffee00000000002401';
export const OTHER_REALM = '64b0c0ffee00000000002402';
export const actor = { actorType: 'USER', actorId: 'verwalterin@example.org' } as const;
/** Today in the tests: no record written in 2026 is due before 2037. */
export const NOW_2037 = new Date('2037-01-01T00:00:00+01:00');

export interface AuditContext {
  pool: pg.Pool;
  db: Kysely<Database>;
  parties: PostgresPartyRepository;
}

export function useAuditDatabase(name: `${string}_test`) {
  const schema = testSchemaName(name);
  const ctx = {} as AuditContext;
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    ctx.pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 });
    await migrateToLatest(ctx.pool, { migrationTableSchema: schema });
    ctx.db = createDatabase(ctx.pool);
    ctx.parties = new PostgresPartyRepository(ctx.db);
  });
  afterAll(async () => {
    await ctx.pool.end();
  });

  /** A PERSON Party with e-mail and phone; its id. */
  const person = async (displayName: string, mreRealmId = REALM): Promise<string> => {
    const created = await ctx.parties.create(
      {
        mreRealmId,
        partyType: 'PERSON',
        displayName,
        firstName: 'Erika',
        lastName: 'Beispiel',
        legalName: null,
        registrationNumber: null,
        email: 'erika.alt@example.org',
        phone: '+49 30 0000000',
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.party.id;
  };
  /** Amends the Party through the repository; the id of its new `AMENDED` record. */
  const amend = async (partyId: string, changes: Record<string, string | null>, mreRealmId = REALM): Promise<string> => {
    const outcome = await ctx.parties.amend(partyId, mreRealmId, changes, actor);
    if (outcome.kind !== 'AMENDED') throw new Error(outcome.kind);
    const { rows } = await ctx.pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = 'AMENDED' AND new_version = $2`, [
      partyId,
      outcome.party.version,
    ]);
    return rows[0].id as string;
  };
  /** A record inserted past the repository (the guard lets every insert through). */
  const raw = async (r: { entityType: string; entityId: string; action: string; occurredAt: string; metadata: unknown }): Promise<string> =>
    (
      await ctx.pool.query(
        `INSERT INTO audit_record (entity_type, entity_id, action, occurred_at, actor_type, actor_id, previous_version, new_version, metadata)
         VALUES ($1, $2, $3, $4, 'USER', 'verwalterin@example.org', 1, 2, $5) RETURNING id`,
        [r.entityType, r.entityId, r.action, r.occurredAt, JSON.stringify(r.metadata)],
      )
    ).rows[0].id as string;
  /** One record as stored: every column, `occurred_at` and `pseudonymised_at` as ISO text. */
  const record = async (id: string) =>
    (
      await ctx.pool.query(
        `SELECT id, entity_type, entity_id, action, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS occurred_at, actor_type,
           actor_id, previous_version, new_version, metadata, pseudonymised_at FROM audit_record WHERE id = $1`,
        [id],
      )
    ).rows[0];
  /** The `AUDIT_PSEUDONYMISED` records of an entity, oldest first. */
  const documenting = async (entityId: string) =>
    (
      await ctx.pool.query(
        `SELECT entity_type, entity_id, actor_type, actor_id, previous_version, new_version, metadata FROM audit_record
         WHERE entity_id = $1 AND action = 'AUDIT_PSEUDONYMISED' ORDER BY occurred_at, metadata->>'auditRecordId'`,
        [entityId],
      )
    ).rows;
  /** Moves records' `occurred_at` back (by `stageAudit`, as the 14 staging tests do). */
  const backdate = async (ids: readonly string[], iso: string) =>
    stageAudit(ctx.pool, `UPDATE audit_record SET occurred_at = $2 WHERE id = ANY($1::uuid[])`, [ids, iso]);
  /** A checksum of the whole table (row count and every row's text). */
  const checksum = async () =>
    (await ctx.pool.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(to_jsonb(a)::text, '|' ORDER BY id), '')) AS sum FROM audit_record a`)).rows[0];

  return { ctx, person, amend, raw, record, documenting, backdate, checksum };
}
