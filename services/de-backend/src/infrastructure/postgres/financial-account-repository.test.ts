import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFingerprint, type FinancialAccountId, type NewFinancialAccount } from '../../domains/ledger/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-1-03 persistence: accounts with AuditRecords, Idempotency-Key replay and
 * conflict (also under concurrency), Realm scope, idempotent close. Runs in an
 * isolated, migrated schema.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const girokonto: NewFinancialAccount = {
  mreRealmId: REALM,
  accountType: 'BANK',
  displayName: 'Girokonto',
  currency: 'EUR',
  iban: 'DE89370400440532013000',
};
const keyed = (key: string, account = girokonto) => ({ key, fingerprint: createFingerprint(account) });

describe.skipIf(databaseUrl === undefined)('PostgresFinancialAccountRepository', () => {
  const schema = testSchemaName('financial_account_test');
  let pool: pg.Pool;
  let repository: PostgresFinancialAccountRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    repository = new PostgresFinancialAccountRepository(createDatabase(pool));
  });

  afterAll(async () => {
    await pool.end();
  });

  const audits = async (entityId: string) =>
    (
      await pool.query<{ action: string; previous_version: number | null; new_version: number }>(
        `SELECT action, previous_version, new_version FROM audit_record
         WHERE entity_type = 'FinancialAccount' AND entity_id = $1 ORDER BY new_version`,
        [entityId],
      )
    ).rows;
  const accountsNamed = async (displayName: string) =>
    Number((await pool.query('SELECT count(*) FROM financial_account WHERE display_name = $1', [displayName])).rows[0].count);

  it('creates an OPEN account with a generated id and one AuditRecord', async () => {
    const outcome = await repository.create(girokonto, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    expect(outcome.account).toMatchObject({ ...girokonto, status: 'OPEN', closedAt: null, version: 1 });
    expect(outcome.account.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await repository.findById(outcome.account.id, REALM)).toEqual(outcome.account);
    expect(await audits(outcome.account.id)).toEqual([{ action: 'CREATED', previous_version: null, new_version: 1 }]);
  });

  it('same key and payload replays the original account', async () => {
    const account = { ...girokonto, displayName: 'Replay' };
    const first = await repository.create(account, actor, keyed('replay-1', account));
    const again = await repository.create(account, actor, keyed('replay-1', account));
    if (first.kind !== 'CREATED') throw new Error(first.kind);
    expect(again).toEqual({ kind: 'REPLAYED', account: first.account });
    expect(await accountsNamed('Replay')).toBe(1);
    expect(await audits(first.account.id)).toHaveLength(1);
  });

  it('a replay after close answers with the account as created (OPEN, v1), not its current state', async () => {
    const account = { ...girokonto, displayName: 'Replay after close' };
    const first = await repository.create(account, actor, keyed('replay-close-1', account));
    if (first.kind !== 'CREATED') throw new Error(first.kind);
    await repository.close(first.account.id, REALM, new Date('2026-12-31T12:00:00Z'), actor);

    const replay = await repository.create(account, actor, keyed('replay-close-1', account));
    expect(replay).toEqual({ kind: 'REPLAYED', account: first.account });
    expect(first.account).toMatchObject({ status: 'OPEN', closedAt: null, version: 1 });
    expect(await repository.findById(first.account.id, REALM)).toMatchObject({ status: 'CLOSED', version: 2 });
  });

  it('same key, different payload is a conflict and creates nothing', async () => {
    const account = { ...girokonto, displayName: 'Conflict' };
    await repository.create(account, actor, keyed('conflict-1', account));
    const changed = { ...account, accountType: 'CASH' as const };
    expect(await repository.create(changed, actor, keyed('conflict-1', changed))).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    expect(await accountsNamed('Conflict')).toBe(1);
  });

  it('concurrent requests with the same key create exactly one account', async () => {
    const account = { ...girokonto, displayName: 'Concurrent' };
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => repository.create(account, actor, keyed('race-1', account))));
    expect(outcomes.filter((o) => o.kind === 'CREATED')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'REPLAYED')).toHaveLength(7);
    expect(new Set(outcomes.map((o) => (o.kind === 'IDEMPOTENCY_CONFLICT' ? '' : o.account.id))).size).toBe(1);
    expect(await accountsNamed('Concurrent')).toBe(1);
  });

  it('keys are scoped to the Realm: the same key in another Realm creates its own account', async () => {
    const account = { ...girokonto, displayName: 'Scoped' };
    const other = { ...account, mreRealmId: OTHER_REALM };
    const a = await repository.create(account, actor, keyed('scoped-1', account));
    const b = await repository.create(other, actor, keyed('scoped-1', other));
    expect([a.kind, b.kind]).toEqual(['CREATED', 'CREATED']);
    if (a.kind !== 'CREATED') throw new Error(a.kind);
    expect(await repository.findById(a.account.id, OTHER_REALM)).toBeUndefined();
  });

  it('close: OPEN → CLOSED with closedAt and an AuditRecord; a repeat changes nothing', async () => {
    const created = await repository.create({ ...girokonto, displayName: 'Close' }, actor);
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const at = new Date('2026-12-31T12:00:00Z');
    const closed = await repository.close(created.account.id, REALM, at, actor);
    expect(closed).toMatchObject({ status: 'CLOSED', closedAt: at, version: 2 });
    expect(await repository.close(created.account.id, REALM, new Date('2027-01-01T00:00:00Z'), actor)).toEqual(closed);
    expect(await audits(created.account.id)).toEqual([
      { action: 'CREATED', previous_version: null, new_version: 1 },
      { action: 'CLOSED', previous_version: 1, new_version: 2 },
    ]);
  });

  it('close is scoped to the Realm and ignores ids that are not UUIDs', async () => {
    const created = await repository.create({ ...girokonto, displayName: 'Scope close' }, actor);
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    expect(await repository.close(created.account.id, OTHER_REALM, new Date(), actor)).toBeUndefined();
    expect(await repository.close('not-a-uuid' as FinancialAccountId, REALM, new Date(), actor)).toBeUndefined();
    expect((await repository.findById(created.account.id, REALM))?.status).toBe('OPEN');
  });

  it('the database rejects what the boundary must never let through', async () => {
    const insert = (columns: string) =>
      pool.query(
        `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, iban, status, closed_at, created_by)
         VALUES ${columns}`,
      );
    await expect(insert(`('r', 'LOAN', 'x', 'EUR', NULL, 'OPEN', NULL, 'a')`)).rejects.toThrow(/check constraint/);
    await expect(insert(`('r', 'BANK', 'x', 'USD', NULL, 'OPEN', NULL, 'a')`)).rejects.toThrow(/check constraint/);
    await expect(insert(`('r', 'BANK', 'x', 'EUR', 'de89 3704', 'OPEN', NULL, 'a')`)).rejects.toThrow(/check constraint/);
    await expect(insert(`('r', 'BANK', 'x', 'EUR', NULL, 'CLOSED', NULL, 'a')`)).rejects.toThrow(/check constraint/);
    await expect(insert(`('r', 'BANK', '', 'EUR', NULL, 'OPEN', NULL, 'a')`)).rejects.toThrow(/check constraint/);
  });
});
