import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFingerprint, type NewFinancialAccount } from '../../domains/ledger/index.js';
import { createFingerprint as depositFingerprint, type DepositRequest, type NewDeposit } from '../../domains/security-deposit/index.js';
import { Money } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { claimIdempotencyKey, recordIdempotentResult, type IdempotencyKeyRef } from './idempotency.js';
import { isIdempotencyKeyExpired, purgeExpiredIdempotencyKeys } from './idempotency-retention.js';
import { migrateToLatest } from './migrate.js';
import { waitForLocks } from './rent-reconciliation.test-support.js';
import type { Database } from './schema.js';
import { PostgresSecurityDepositRepository } from './security-deposit-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-X-12 persistence (api-design.md §15 "Retention"; Entscheidung des Projektinhabers, 2026-11-06): the cleanup
 * deletes exactly the expired keys and answers the count; at request time an expired key still in the table is a new
 * request (it executes again, also with another payload), a key not yet expired replays its snapshot and writes
 * nothing; Realm and scope isolation; concurrency on an expired key (interleaved by hand and in a burst, also against
 * the cleanup); the read-only precheck of a deposit. Synthetic data only, in an isolated, migrated schema.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'retention@example.com' } as const;
const DAY = 24 * 60 * 60 * 1000;
const account = (displayName: string, mreRealmId = REALM): NewFinancialAccount => ({
  mreRealmId,
  accountType: 'BANK',
  displayName,
  currency: 'EUR',
  iban: 'DE89370400440532013000',
});
const keyed = (key: string, a: NewFinancialAccount) => ({ key, fingerprint: createFingerprint(a) });

describe.skipIf(databaseUrl === undefined)('Idempotency-Key retention (VC-X-12)', () => {
  const schema = testSchemaName('idempotency_retention_test');
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let accounts: PostgresFinancialAccountRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 12 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    db = createDatabase(pool);
    accounts = new PostgresFinancialAccountRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Moves a key's creation `ms` into the past, on the database's clock (as the claim reads it). */
  const age = async (key: string, ms: number, mreRealmId = REALM) =>
    pool.query(`UPDATE idempotency_key SET created_at = now() - make_interval(secs => $3::double precision) WHERE key = $1 AND mre_realm_id = $2`, [
      key,
      mreRealmId,
      ms / 1000,
    ]);
  const keyRow = async (key: string, mreRealmId = REALM, scope = 'financial-account.create') =>
    (
      await pool.query(`SELECT resource_id, request_fingerprint, result, created_at FROM idempotency_key WHERE key = $1 AND mre_realm_id = $2 AND scope = $3`, [
        key,
        mreRealmId,
        scope,
      ])
    ).rows[0] as { resource_id: string; request_fingerprint: string; result: unknown; created_at: Date } | undefined;
  const named = async (displayName: string) =>
    (await pool.query(`SELECT id FROM financial_account WHERE display_name = $1 ORDER BY created_at, id`, [displayName])).rows.map((r) => r.id as string);
  const auditsOf = async (id: string) =>
    (await pool.query(`SELECT action FROM audit_record WHERE entity_type = 'FinancialAccount' AND entity_id = $1`, [id])).rows.map((r) => r.action);
  /** Row counts of every table a create or a replay could write. */
  const counts = async () =>
    (
      await pool.query(
        `SELECT (SELECT count(*)::int FROM audit_record) AS audits, (SELECT count(*)::int FROM financial_account) AS accounts, (SELECT count(*)::int FROM idempotency_key) AS keys`,
      )
    ).rows[0];
  const created = async (a: NewFinancialAccount, key: string) => {
    const outcome = await accounts.create(a, actor, keyed(key, a));
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account;
  };

  describe('the cleanup', () => {
    it('deletes only the expired keys, in every Realm and scope, and answers the count', async () => {
      // An injected clock in 2020: every key the other tests create (today) is younger and stays.
      const now = new Date('2020-03-10T12:00:00.000Z');
      const rows: [string, string, string, number][] = [
        [REALM, 'retention.a', 'exactly-7d', 7 * DAY],
        [REALM, 'retention.a', '7d-minus-1ms', 7 * DAY - 1],
        [REALM, 'retention.a', '7d-plus-1ms', 7 * DAY + 1],
        [REALM, 'retention.a', 'fresh', 0],
        [OTHER_REALM, 'retention.a', 'other-realm-30d', 30 * DAY],
        [REALM, 'retention.b', 'other-scope-8d', 8 * DAY],
        [REALM, 'retention.b', 'other-scope-6d', 6 * DAY],
      ];
      for (const [realm, scope, key, ms] of rows) {
        await pool.query(
          `INSERT INTO idempotency_key (mre_realm_id, scope, key, request_fingerprint, resource_id, result, created_at) VALUES ($1, $2, $3, 'fp', 'r', '{"n": 1}', $4)`,
          [realm, scope, key, new Date(now.getTime() - ms)],
        );
      }
      const before = await counts();
      expect(await purgeExpiredIdempotencyKeys(db, now)).toBe(4);
      const left = (await pool.query(`SELECT key FROM idempotency_key WHERE scope LIKE 'retention.%' ORDER BY key`)).rows.map((r) => r.key);
      expect(left).toEqual(['7d-minus-1ms', 'fresh', 'other-scope-6d']);
      // The SQL reads the pure rule: deleted exactly when isIdempotencyKeyExpired says so.
      for (const [, , key, ms] of rows) expect([key, !left.includes(key)]).toEqual([key, isIdempotencyKeyExpired(new Date(now.getTime() - ms), now)]);
      expect(await counts()).toEqual({ ...before, keys: before.keys - 4 });
      // A second run finds nothing more.
      expect(await purgeExpiredIdempotencyKeys(db, now)).toBe(0);
      await pool.query(`DELETE FROM idempotency_key WHERE scope LIKE 'retention.%'`);
    });

    it('leaves the created resources and their AuditRecords untouched and writes no AuditRecord', async () => {
      const first = await created(account('Cleanup leaves resource'), 'cleanup-1');
      await age('cleanup-1', 8 * DAY);
      const before = await counts();
      expect(await purgeExpiredIdempotencyKeys(db, new Date())).toBeGreaterThanOrEqual(1);
      expect(await keyRow('cleanup-1')).toBeUndefined();
      expect(await accounts.findById(first.id, REALM)).toEqual(first);
      expect(await auditsOf(first.id)).toEqual(['CREATED']);
      const after = await counts();
      expect([after.audits, after.accounts]).toEqual([before.audits, before.accounts]);
    });
  });

  describe('at request time', () => {
    it('an expired key still in the table is a new request: the create executes again with its own AuditRecord', async () => {
      const a = account('Expired executes again');
      const first = await created(a, 'expired-1');
      await age('expired-1', 7 * DAY + 60_000);
      const again = await accounts.create(a, actor, keyed('expired-1', a));
      if (again.kind !== 'CREATED') throw new Error(again.kind);
      expect(again.account.id).not.toBe(first.id);
      expect(await named('Expired executes again')).toEqual([first.id, again.account.id]);
      expect([await auditsOf(first.id), await auditsOf(again.account.id)]).toEqual([['CREATED'], ['CREATED']]);
      // The key now belongs to the new request: fresh, with the new result; the next retry replays that.
      const row = await keyRow('expired-1');
      expect(row?.resource_id).toBe(again.account.id);
      expect(Date.now() - (row?.created_at.getTime() ?? 0)).toBeLessThan(60_000);
      expect(await accounts.create(a, actor, keyed('expired-1', a))).toEqual({ kind: 'REPLAYED', account: again.account });
    });

    it('an expired key with another payload is a new request, not a conflict', async () => {
      const a = account('Expired other payload A');
      await created(a, 'expired-2');
      await age('expired-2', 7 * DAY + 60_000);
      const b = account('Expired other payload B');
      expect((await accounts.create(b, actor, keyed('expired-2', b))).kind).toBe('CREATED');
      expect((await keyRow('expired-2'))?.request_fingerprint).toBe(createFingerprint(b));
      // Counter-check: the same while the key is not expired is a conflict.
      await created(a, 'expired-2b');
      expect(await accounts.create(b, actor, keyed('expired-2b', b))).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    });

    it('a key not yet expired replays its snapshot, also after the resource changed, and the replay writes nothing', async () => {
      const a = account('Kept replays');
      const first = await created(a, 'kept-1');
      await age('kept-1', 7 * DAY - 60_000);
      await accounts.close(first.id, REALM, new Date('2026-12-31T12:00:00Z'), actor);
      const [before, rowBefore] = [await counts(), await keyRow('kept-1')];
      expect(await accounts.create(a, actor, keyed('kept-1', a))).toEqual({ kind: 'REPLAYED', account: first });
      expect([await counts(), await keyRow('kept-1')]).toEqual([before, rowBefore]);
      expect(await auditsOf(first.id)).toEqual(['CREATED', 'CLOSED']);
      expect(await named('Kept replays')).toEqual([first.id]);
    });

    it('Realm and scope isolation: an expired key is replaced only in its own Realm and scope', async () => {
      const a = account('Isolated A');
      const b = account('Isolated B', OTHER_REALM);
      await created(a, 'iso-1');
      const inB = await created(b, 'iso-1');
      await age('iso-1', 8 * DAY);
      await age('iso-1', 8 * DAY, OTHER_REALM);
      await pool.query(
        `INSERT INTO idempotency_key (mre_realm_id, scope, key, request_fingerprint, resource_id, result, created_at) VALUES ($1, 'retention.other-scope', 'iso-1', 'fp', 'r', '{"n": 1}', now() - interval '8 days')`,
        [REALM],
      );
      const [otherRealm, otherScope] = [await keyRow('iso-1', OTHER_REALM), await keyRow('iso-1', REALM, 'retention.other-scope')];
      expect((await accounts.create(a, actor, keyed('iso-1', a))).kind).toBe('CREATED');
      expect([await keyRow('iso-1', OTHER_REALM), await keyRow('iso-1', REALM, 'retention.other-scope')]).toEqual([otherRealm, otherScope]);
      // Realm B's own key: expired there too, so its retry is new there as well; A's new account is not visible in B.
      const againB = await accounts.create(b, actor, keyed('iso-1', b));
      if (againB.kind !== 'CREATED') throw new Error(againB.kind);
      expect(againB.account.id).not.toBe(inB.id);
      expect(await named('Isolated A')).toHaveLength(2);
      for (const id of await named('Isolated A')) expect(await accounts.findById(id, OTHER_REALM)).toBeUndefined();
      await pool.query(`DELETE FROM idempotency_key WHERE scope = 'retention.other-scope'`);
    });
  });

  describe('concurrency on an expired key', () => {
    const ref = (key: string): IdempotencyKeyRef => ({ mreRealmId: REALM, scope: 'retention.race', key });
    const seed = async (key: string) =>
      pool.query(
        `INSERT INTO idempotency_key (mre_realm_id, scope, key, request_fingerprint, resource_id, result, created_at) VALUES ($1, 'retention.race', $2, 'fp', 'old', '{"n": "old"}', now() - interval '8 days')`,
        [REALM, key],
      );
    /** A claim held open until `release` resolves: it claims and records `{ n: "first" }`, then commits or rolls back. */
    const held = (key: string, outcome: 'commit' | 'rollback') => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let claimed: (kind: string) => void = () => undefined;
      const claimedKind = new Promise<string>((resolve) => (claimed = resolve));
      const done = db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          const claim = await claimIdempotencyKey(trx, ref(key), 'fp');
          claimed(claim.kind);
          await recordIdempotentResult(trx, ref(key), 'first', { n: 'first' });
          await gate;
          if (outcome === 'rollback') throw new Error('rolled back (synthetisch)');
        })
        .catch((e: unknown) => {
          if (!String(e).includes('synthetisch')) throw e;
        });
      return { claimedKind, release, done };
    };
    const claimIn = (key: string) =>
      db
        .transaction()
        .setIsolationLevel('read committed')
        .execute((trx) => claimIdempotencyKey(trx, ref(key), 'fp'));

    it('the second claim waits on the first, then replays the first result; nothing of the old row survives', async () => {
      await seed('race-commit');
      const first = held('race-commit', 'commit');
      expect(await first.claimedKind).toBe('CLAIMED');
      const second = claimIn('race-commit');
      await waitForLocks(pool);
      first.release();
      await first.done;
      expect(await second).toEqual({ kind: 'REPLAY', result: { n: 'first' } });
      expect((await pool.query(`SELECT resource_id FROM idempotency_key WHERE scope = 'retention.race' AND key = 'race-commit'`)).rows).toEqual([
        { resource_id: 'first' },
      ]);
    });

    it('counter-check: when the first rolls back, the waiting claim deletes the expired row itself and claims', async () => {
      await seed('race-rollback');
      const first = held('race-rollback', 'rollback');
      expect(await first.claimedKind).toBe('CLAIMED');
      const second = claimIn('race-rollback');
      await waitForLocks(pool);
      first.release();
      await first.done;
      expect(await second).toEqual({ kind: 'CLAIMED' });
      // claimIn committed without recording: the row is the second claim's, fresh and without a result.
      const row = (
        await pool.query(`SELECT resource_id, result, created_at > now() - interval '1 minute' AS fresh FROM idempotency_key WHERE key = 'race-rollback'`)
      ).rows[0];
      expect(row).toEqual({ resource_id: null, result: null, fresh: true });
    });

    it('under REPEATABLE READ the waiting claim fails with a serialization failure, never a second claim', async () => {
      await seed('race-rr');
      const first = held('race-rr', 'commit');
      expect(await first.claimedKind).toBe('CLAIMED');
      const second = db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute((trx) => claimIdempotencyKey(trx, ref('race-rr'), 'fp'))
        .catch((e: { code?: string }) => e.code);
      await waitForLocks(pool);
      first.release();
      await first.done;
      expect(await second).toBe('40001');
      expect((await pool.query(`SELECT resource_id FROM idempotency_key WHERE key = 'race-rr'`)).rows).toEqual([{ resource_id: 'first' }]);
    });

    it('the cleanup racing a claim on the same expired row: the claim still claims, the count is right', async () => {
      await seed('race-cleanup');
      const first = held('race-cleanup', 'commit');
      expect(await first.claimedKind).toBe('CLAIMED');
      const purge = purgeExpiredIdempotencyKeys(db, new Date());
      await waitForLocks(pool);
      first.release();
      await first.done;
      // The claim deleted the old row; the cleanup, after waiting, finds it gone and the fresh row too young.
      expect(await purge).toBe(0);
      expect((await pool.query(`SELECT resource_id FROM idempotency_key WHERE key = 'race-cleanup'`)).rows).toEqual([{ resource_id: 'first' }]);
    });

    it('a burst of eight creates with one expired key, with the cleanup in between: exactly one executes, seven replay it', async () => {
      const a = account('Expired burst');
      const old = await created(a, 'burst-1');
      await age('burst-1', 8 * DAY);
      const [outcomes] = await Promise.all([
        Promise.all(Array.from({ length: 8 }, () => accounts.create(a, actor, keyed('burst-1', a)))),
        purgeExpiredIdempotencyKeys(db, new Date()),
      ]);
      const winners = outcomes.filter((o) => o.kind === 'CREATED');
      expect(winners).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === 'REPLAYED')).toHaveLength(7);
      const id = winners[0]?.kind === 'CREATED' ? winners[0].account.id : '';
      for (const o of outcomes) expect(o.kind === 'IDEMPOTENCY_CONFLICT' ? '' : o.account.id).toBe(id);
      expect(await named('Expired burst')).toEqual([old.id, id]);
      expect(await auditsOf(id)).toEqual(['CREATED']);
    });
  });

  describe('the read-only precheck of a deposit (before MRE is asked)', () => {
    it('an expired key is not replayed and not a conflict; counter-check: a kept key replays', async () => {
      const deposits = new PostgresSecurityDepositRepository(db);
      const request: DepositRequest = {
        mreRealmId: REALM,
        mreTenantId: '6512f0c2a1b2000000012001',
        expectedAmount: Money.of('900.00', 'EUR'),
        holdingFinancialAccountId: null,
        interestBearing: false,
        notes: null,
      };
      const key = (r: DepositRequest) => ({ key: 'deposit-expired', fingerprint: depositFingerprint(r) });
      const deposit: NewDeposit = { ...request, expectedAmount: Money.of('900.00', 'EUR'), expectedAmountSource: 'REQUEST' };
      const first = await deposits.create(deposit, actor, key(request));
      if (first.kind !== 'CREATED') throw new Error(first.kind);
      expect(await deposits.createPrecheck(request, key(request))).toEqual({ kind: 'REPLAYED', deposit: first.deposit });
      const other = { ...request, notes: 'anders (synthetisch)' };
      expect(await deposits.createPrecheck(other, key(other))).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
      await pool.query(`UPDATE idempotency_key SET created_at = now() - interval '7 days 1 minute' WHERE key = 'deposit-expired'`);
      // A new request: the precheck goes on to its checks (the Tenant already holds a deposit), with either payload.
      expect(await deposits.createPrecheck(request, key(request))).toEqual({ kind: 'DEPOSIT_EXISTS', securityDepositId: first.deposit.id });
      expect(await deposits.createPrecheck(other, key(other))).toEqual({ kind: 'DEPOSIT_EXISTS', securityDepositId: first.deposit.id });
    });
  });
});
