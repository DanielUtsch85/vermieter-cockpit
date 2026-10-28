import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExternalReferenceKey, NewParty, Party } from '../../domains/party/index.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyExternalReferenceRepository } from './party-external-reference-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-2-02 persistence (api-design.md §20.1): claim with its order of checks, the active-key index as the arbiter of
 * concurrent claims (no aborted transaction), end with If-Match and no-op, list, the Party list filter, and the schema.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
let counter = 0;
/** A fresh MRE Tenant id per test, so tests do not share keys. */
const tenantId = () => (0x6512f0c2a1b2c3d4e5f60000n + BigInt(++counter)).toString(16).padStart(24, '0');
const keyOf = (externalId: string, mreRealmId = REALM): ExternalReferenceKey => ({ system: 'MRE', mreRealmId, entityType: 'tenant', externalId });

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresPartyExternalReferenceRepository', () => {
  const schema = testSchemaName('party_ref_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let references: PostgresPartyExternalReferenceRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    references = new PostgresPartyExternalReferenceRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function party(overrides: Partial<NewParty> = {}): Promise<Party> {
    const outcome = await parties.create(
      {
        mreRealmId: REALM,
        partyType: 'PERSON',
        displayName: 'Anna Schmidt',
        firstName: 'Anna',
        lastName: 'Schmidt',
        legalName: null,
        registrationNumber: null,
        email: null,
        phone: null,
        ...overrides,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party;
  }
  async function claimed(holder: Party, key: ExternalReferenceKey) {
    const outcome = await references.claim(holder.id, key, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.reference;
  }
  /** Waits until `n` sessions wait for a lock in a statement on `table`. */
  const waitForLockWaiters = (table: string, n = 1) =>
    waitUntil(
      async () =>
        Number(
          (
            await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [
              `%"${table}"%`,
            ])
          ).rows[0].count,
        ) >= n,
    );

  it('claim: creates an ACTIVE reference with an AuditRecord; a repeat is EXISTING; another Party is IN_USE', async () => {
    const anna = await party();
    const ben = await party({ displayName: 'Ben Keller', firstName: 'Ben', lastName: 'Keller' });
    const key = keyOf(tenantId());
    expect(await references.checkClaim(anna.id, key)).toEqual({ kind: 'CLAIM' });
    const reference = await claimed(anna, key);
    expect(reference).toMatchObject({ partyId: anna.id, ...key, status: 'ACTIVE', endedAt: null, version: 1 });
    expect(
      (await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_type = 'PartyExternalReference' AND entity_id = $1`, [reference.id])).rows,
    ).toEqual([{ action: 'CREATED', metadata: { partyId: anna.id, system: 'MRE', entityType: 'tenant', externalId: key.externalId } }]);
    expect(await references.checkClaim(anna.id, key)).toEqual({ kind: 'EXISTING', reference });
    expect(await references.claim(anna.id, key, actor)).toEqual({ kind: 'EXISTING', reference });
    expect(await references.claim(ben.id, key, actor)).toEqual({ kind: 'IN_USE', partyId: anna.id });
    // A Party may hold several references (one person, several MRE Tenant records).
    await claimed(anna, keyOf(tenantId()));
  });

  it('claim: an inactive Party gets no new reference but keeps and repeats its own; unknown, foreign or malformed is NOT_FOUND', async () => {
    const anna = await party();
    const held = keyOf(tenantId());
    const reference = await claimed(anna, held);
    await parties.deactivate(anna.id, REALM, 'verstorben', new Date(), actor);
    expect(await references.claim(anna.id, keyOf(tenantId()), actor)).toEqual({ kind: 'PARTY_INACTIVE' });
    expect(await references.claim(anna.id, held, actor)).toEqual({ kind: 'EXISTING', reference });
    expect(await references.claim(anna.id, keyOf(tenantId(), OTHER_REALM), actor)).toEqual({ kind: 'NOT_FOUND' });
    expect(await references.checkClaim('nope', held)).toEqual({ kind: 'NOT_FOUND' });
    expect(await references.claim('0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b', held, actor)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('two different Parties claim one key at once: one reference, the other IN_USE, no aborted transaction', async () => {
    const anna = await party();
    const ben = await party({ displayName: 'Ben Keller' });
    const key = keyOf(tenantId());
    // Anna's insert is in flight (uncommitted) when Ben's claim reaches the index.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO party_external_reference (party_id, mre_realm_id, system, entity_type, external_id, status, created_by)
         VALUES ($1, $2, 'MRE', 'tenant', $3, 'ACTIVE', 'x')`,
        [anna.id, REALM, key.externalId],
      );
      const bens = references.claim(ben.id, key, actor);
      await waitForLockWaiters('party_external_reference');
      await holder.query('COMMIT');
      expect(await bens).toEqual({ kind: 'IN_USE', partyId: anna.id });
    } finally {
      holder.release();
    }
    // The winner rolls back: the waiting claim inserts after all.
    const other = keyOf(tenantId());
    const rollback = await pool.connect();
    try {
      await rollback.query('BEGIN');
      await rollback.query(
        `INSERT INTO party_external_reference (party_id, mre_realm_id, system, entity_type, external_id, status, created_by)
         VALUES ($1, $2, 'MRE', 'tenant', $3, 'ACTIVE', 'x')`,
        [anna.id, REALM, other.externalId],
      );
      const bens = references.claim(ben.id, other, actor);
      await waitForLockWaiters('party_external_reference');
      await rollback.query('ROLLBACK');
      expect(await bens).toMatchObject({ kind: 'CREATED', reference: { partyId: ben.id } });
    } finally {
      rollback.release();
    }
    // Many Parties at once, end to end through the repository.
    const racers = await Promise.all(Array.from({ length: 5 }, (_, i) => party({ displayName: `Racer ${i}` })));
    const raced = keyOf(tenantId());
    const outcomes = await Promise.all(racers.map((p) => references.claim(p.id, raced, actor)));
    expect(outcomes.filter((o) => o.kind === 'CREATED')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'IN_USE')).toHaveLength(4);
    expect((await pool.query(`SELECT count(*)::int AS n FROM party_external_reference WHERE external_id = $1`, [raced.externalId])).rows[0].n).toBe(1);
  });

  it('a claim racing deactivate: once the deactivation commits, the claim sees PARTY_INACTIVE', async () => {
    const anna = await party();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM party WHERE id = $1 FOR UPDATE`, [anna.id]);
      const claim = references.claim(anna.id, keyOf(tenantId()), actor);
      await waitForLockWaiters('party');
      await holder.query(`UPDATE party SET status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'x', version = version + 1 WHERE id = $1`, [
        anna.id,
      ]);
      await holder.query('COMMIT');
      expect(await claim).toEqual({ kind: 'PARTY_INACTIVE' });
    } finally {
      holder.release();
    }
  });

  it('end: once, with an AuditRecord; a repeat keeps the first endedAt whatever If-Match says; the key is free again', async () => {
    const anna = await party();
    const ben = await party({ displayName: 'Ben Keller' });
    const key = keyOf(tenantId());
    const reference = await claimed(anna, key);
    const at = new Date('2026-10-22T10:00:00Z');
    expect(await references.end(anna.id, reference.id, REALM, at, actor, [7])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [7], currentVersion: 1 });
    const ended = await references.end(anna.id, reference.id, REALM, at, actor, [1]);
    expect(ended).toMatchObject({ kind: 'ENDED', changed: true, reference: { status: 'ENDED', endedAt: at, version: 2 } });
    expect(await references.end(anna.id, reference.id, REALM, new Date(), actor, [1])).toMatchObject({
      kind: 'ENDED',
      changed: false,
      reference: { endedAt: at, version: 2 },
    });
    expect((await pool.query(`SELECT action FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at`, [reference.id])).rows.map((r) => r.action)).toEqual([
      'CREATED',
      'ENDED',
    ]);
    // Ended: the key resolves to nobody and can be claimed again, by any Party, as a new row.
    expect(await references.checkClaim(ben.id, key)).toEqual({ kind: 'CLAIM' });
    expect((await claimed(ben, key)).id).not.toBe(reference.id);
    // Ending stays allowed for an inactive Party (P2-D1).
    const kept = await claimed(anna, keyOf(tenantId()));
    await parties.deactivate(anna.id, REALM, 'verstorben', new Date(), actor);
    expect(await references.end(anna.id, kept.id, REALM, at, actor)).toMatchObject({ kind: 'ENDED', changed: true });
  });

  it('end: another Party, another Realm, or a malformed id is NOT_FOUND', async () => {
    const anna = await party();
    const ben = await party({ displayName: 'Ben Keller' });
    const reference = await claimed(anna, keyOf(tenantId()));
    expect(await references.end(ben.id, reference.id, REALM, new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
    expect(await references.end(anna.id, reference.id, OTHER_REALM, new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
    expect(await references.end(anna.id, 'nope', REALM, new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('list: oldest first, by status, paged; undefined for an unknown or foreign Party; the Party list finds active holders only', async () => {
    const anna = await party({ displayName: 'Anna Liste' });
    const first = await claimed(anna, keyOf(tenantId()));
    const second = await claimed(anna, keyOf(tenantId()));
    await references.end(anna.id, first.id, REALM, new Date(), actor);
    const page = { page: 1, pageSize: 50 };
    expect((await references.list(anna.id, REALM, {}, page))?.items.map((r) => r.id)).toEqual([first.id, second.id]);
    expect((await references.list(anna.id, REALM, { status: 'ACTIVE' }, page))?.items.map((r) => r.id)).toEqual([second.id]);
    expect(await references.list(anna.id, REALM, {}, { page: 2, pageSize: 1 })).toMatchObject({ items: [{ id: second.id }], total: 2 });
    expect(await references.list(anna.id, OTHER_REALM, {}, page)).toBeUndefined();
    expect(await references.list('nope', REALM, {}, page)).toBeUndefined();

    const byKey = (externalId: string) => parties.list(REALM, { externalReference: { system: 'MRE', externalId } }, page);
    expect((await byKey(second.externalId)).items.map((p) => p.id)).toEqual([anna.id]);
    expect((await byKey(first.externalId)).total).toBe(0);
    expect((await parties.list(OTHER_REALM, { externalReference: { system: 'MRE', externalId: second.externalId } }, page)).total).toBe(0);
  });

  it('the schema: a reference stays in its Party Realm, one active holder per key, status and endedAt agree, ENDED is final', async () => {
    const anna = await party();
    const insert = (values: { realm?: string; status?: string; endedAt?: string | null; externalId?: string }) =>
      pool.query(
        `INSERT INTO party_external_reference (party_id, mre_realm_id, system, entity_type, external_id, status, ended_at, created_by)
         VALUES ($1, $2, 'MRE', 'tenant', $3, $4, $5, 'x') RETURNING id`,
        [anna.id, values.realm ?? REALM, values.externalId ?? tenantId(), values.status ?? 'ACTIVE', values.endedAt ?? null],
      );
    await expect(insert({ realm: OTHER_REALM })).rejects.toThrow(/party_external_reference_party_fk/);
    await expect(insert({ status: 'ENDED' })).rejects.toThrow(/party_external_reference_ended/);
    await expect(insert({ endedAt: '2026-10-22' })).rejects.toThrow(/party_external_reference_ended/);
    await expect(insert({ externalId: 'not-an-object-id' })).rejects.toThrow(/party_external_reference_external_id_check/);
    const externalId = tenantId();
    await insert({ externalId });
    await expect(insert({ externalId })).rejects.toThrow(/party_external_reference_active_key/);
    // Ended rows do not count: the same key may be ended any number of times.
    await insert({ externalId, status: 'ENDED', endedAt: '2026-10-22' });

    const reference = await claimed(anna, keyOf(tenantId()));
    await expect(pool.query(`UPDATE party_external_reference SET external_id = $2 WHERE id = $1`, [reference.id, tenantId()])).rejects.toThrow(/never change/);
    await references.end(anna.id, reference.id, REALM, new Date(), actor);
    await expect(pool.query(`UPDATE party_external_reference SET status = 'ACTIVE', ended_at = NULL WHERE id = $1`, [reference.id])).rejects.toThrow(
      /ENDED is final/,
    );
    // A no-op write passes.
    await pool.query(`UPDATE party_external_reference SET status = status WHERE id = $1`, [reference.id]);
  });
});
