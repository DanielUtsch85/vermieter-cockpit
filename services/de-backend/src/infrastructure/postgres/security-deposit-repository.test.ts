import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFingerprint, type DepositRequest, type NewDeposit } from '../../domains/security-deposit/index.js';
import { Money } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { waitForLocks } from './rent-reconciliation.test-support.js';
import { PostgresSecurityDepositRepository } from './security-deposit-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-5-01 persistence (api-design.md §47.1): create with its checks, idempotency and the partial unique index under
 * concurrency, amend, void, list; and the database guards of migration 0037 on direct writes. Runs in an isolated,
 * migrated schema.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');
let tenantCounter = 0;
/** A fresh 24-hex Tenant id per test, so the one-per-Tenant rule does not couple tests. */
const nextTenant = () => `6512f0c2a1b2${(++tenantCounter).toString(16).padStart(12, '0')}`;

describe.skipIf(databaseUrl === undefined)('PostgresSecurityDepositRepository', () => {
  const schema = testSchemaName('security_deposit_test');
  let pool: pg.Pool;
  let repository: PostgresSecurityDepositRepository;
  let depositAccount = '';
  let bankAccount = '';
  let foreignDepositAccount = '';

  const account = async (mreRealmId: string, accountType: string, displayName: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, status, created_by) VALUES ($1, $2, $3, 'EUR', 'OPEN', 'seed') RETURNING id`,
        [mreRealmId, accountType, displayName],
      )
    ).rows[0]!.id;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    repository = new PostgresSecurityDepositRepository(createDatabase(pool));
    depositAccount = await account(REALM, 'SECURITY_DEPOSIT', 'Kautionskonto');
    bankAccount = await account(REALM, 'BANK', 'Girokonto');
    foreignDepositAccount = await account(OTHER_REALM, 'SECURITY_DEPOSIT', 'Fremdes Kautionskonto');
  });

  afterAll(async () => {
    await pool.end();
  });

  const request = (overrides: Partial<DepositRequest> = {}): DepositRequest => ({
    mreRealmId: REALM,
    mreTenantId: nextTenant(),
    expectedAmount: eur('3000.00'),
    holdingFinancialAccountId: null,
    interestBearing: true,
    notes: null,
    ...overrides,
  });
  const newDeposit = (r: DepositRequest): NewDeposit => ({ ...r, expectedAmount: r.expectedAmount ?? eur('1.00'), expectedAmountSource: 'REQUEST' });
  const created = async (overrides: Partial<DepositRequest> = {}) => {
    const outcome = await repository.create(newDeposit(request(overrides)), actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.deposit;
  };
  const audits = async (entityId: string) =>
    (
      await pool.query<{ action: string; previous_version: number | null; new_version: number; metadata: unknown }>(
        `SELECT action, previous_version, new_version, metadata FROM audit_record
         WHERE entity_type = 'SecurityDeposit' AND entity_id = $1 ORDER BY new_version`,
        [entityId],
      )
    ).rows;
  const rowsOf = async (mreTenantId: string) =>
    Number((await pool.query('SELECT count(*) FROM security_deposit WHERE mre_tenant_id = $1', [mreTenantId])).rows[0].count);
  const keyed = (key: string, r: DepositRequest) => ({ key, fingerprint: createFingerprint(r) });

  describe('create', () => {
    it('an ACTIVE deposit, version 1, exact amount, one CREATED AuditRecord', async () => {
      const deposit = await created({ expectedAmount: eur('2999.99'), holdingFinancialAccountId: depositAccount, notes: 'Mietvertrag §5' });
      expect(deposit).toMatchObject({
        mreRealmId: REALM,
        status: 'ACTIVE',
        expectedAmountSource: 'REQUEST',
        holdingFinancialAccountId: depositAccount,
        interestBearing: true,
        notes: 'Mietvertrag §5',
        voidedAt: null,
        voidReason: null,
        version: 1,
      });
      expect(deposit.expectedAmount.toJSON()).toEqual({ amount: '2999.99', currency: 'EUR' });
      expect(await repository.findById(deposit.id, REALM)).toEqual({ ...deposit, cash: [] });
      expect(await repository.findById(deposit.id, OTHER_REALM)).toBeUndefined();
      expect(await repository.findById('not-a-uuid', REALM)).toBeUndefined();
      expect(await audits(deposit.id)).toMatchObject([{ action: 'CREATED', previous_version: null, new_version: 1 }]);
    });

    it('precheck and create refuse an unknown, foreign or non-deposit holding account', async () => {
      for (const [id, kind] of [
        ['00000000-0000-4000-8000-000000000000', 'ACCOUNT_NOT_FOUND'],
        [foreignDepositAccount, 'ACCOUNT_NOT_FOUND'],
        [bankAccount, 'NOT_A_SECURITY_DEPOSIT_ACCOUNT'],
      ] as const) {
        const r = request({ holdingFinancialAccountId: id });
        expect(await repository.createPrecheck(r)).toMatchObject({ kind, financialAccountId: id });
        expect(await repository.create(newDeposit(r), actor)).toMatchObject({ kind, financialAccountId: id });
        expect(await rowsOf(r.mreTenantId)).toBe(0);
      }
      expect(await repository.createPrecheck(request({ holdingFinancialAccountId: bankAccount }))).toMatchObject({ accountType: 'BANK' });
    });

    it('one deposit per Tenant that is not VOID: DEPOSIT_EXISTS names it; after a void a new one is allowed', async () => {
      const first = await created();
      const again = request({ mreTenantId: first.mreTenantId });
      expect(await repository.createPrecheck(again)).toEqual({ kind: 'DEPOSIT_EXISTS', securityDepositId: first.id });
      expect(await repository.create(newDeposit(again), actor)).toEqual({ kind: 'DEPOSIT_EXISTS', securityDepositId: first.id });
      // Another Realm's Tenant of the same id is another lease.
      expect((await repository.create(newDeposit({ ...again, mreRealmId: OTHER_REALM }), actor)).kind).toBe('CREATED');
      await repository.void(first.id, REALM, 'Irrtum', new Date(), actor);
      expect(await repository.createPrecheck(again)).toEqual({ kind: 'PROCEED' });
      expect((await repository.create(newDeposit(again), actor)).kind).toBe('CREATED');
    });

    it('concurrent creates for one Tenant: exactly one CREATED, the rest DEPOSIT_EXISTS naming it', async () => {
      const r = request();
      const outcomes = await Promise.all(Array.from({ length: 6 }, () => repository.create(newDeposit(r), actor)));
      const winners = outcomes.filter((o) => o.kind === 'CREATED');
      expect(winners).toHaveLength(1);
      const id = winners[0]!.kind === 'CREATED' ? winners[0]!.deposit.id : '';
      for (const o of outcomes.filter((o) => o.kind !== 'CREATED')) expect(o).toEqual({ kind: 'DEPOSIT_EXISTS', securityDepositId: id });
      expect(await rowsOf(r.mreTenantId)).toBe(1);
    });

    it('Idempotency-Key: a replay answers the deposit as created (also after a void), a changed payload conflicts', async () => {
      const r = request();
      const first = await repository.create(newDeposit(r), actor, keyed('dep-1', r));
      if (first.kind !== 'CREATED') throw new Error(first.kind);
      await repository.void(first.deposit.id, REALM, 'Irrtum', new Date(), actor);
      expect(await repository.createPrecheck(r, keyed('dep-1', r))).toEqual({ kind: 'REPLAYED', deposit: first.deposit });
      expect(await repository.create(newDeposit(r), actor, keyed('dep-1', r))).toEqual({ kind: 'REPLAYED', deposit: first.deposit });
      const changed = { ...r, notes: 'anders' };
      expect(await repository.createPrecheck(changed, keyed('dep-1', changed))).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
      expect(await repository.create(newDeposit(changed), actor, keyed('dep-1', changed))).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
      expect(await rowsOf(r.mreTenantId)).toBe(1);
      expect(await audits(first.deposit.id)).toHaveLength(2);
    });

    it('a refused create keyed with a key leaves the key unclaimed', async () => {
      const r = request({ holdingFinancialAccountId: bankAccount });
      expect((await repository.create(newDeposit(r), actor, keyed('dep-refused', r))).kind).toBe('NOT_A_SECURITY_DEPOSIT_ACCOUNT');
      expect(Number((await pool.query(`SELECT count(*) FROM idempotency_key WHERE key = 'dep-refused'`)).rows[0].count)).toBe(0);
    });

    it('concurrent keyed creates with one key and payload: one row, the others replay it', async () => {
      const r = request();
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => repository.create(newDeposit(r), actor, keyed('dep-race', r))));
      expect(outcomes.filter((o) => o.kind === 'CREATED')).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === 'REPLAYED')).toHaveLength(4);
      expect(await rowsOf(r.mreTenantId)).toBe(1);
    });
  });

  describe('amend', () => {
    it('changes the named fields, version + 1, an amended amount becomes REQUEST, AMENDED with from/to', async () => {
      const r = request();
      const outcome = await repository.create({ ...newDeposit(r), expectedAmountSource: 'MRE_GUARANTY' }, actor);
      if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
      const amended = await repository.amend(outcome.deposit.id, REALM, { expectedAmount: eur('3100'), holdingFinancialAccountId: depositAccount }, actor, [1]);
      expect(amended).toMatchObject({
        kind: 'AMENDED',
        changed: true,
        deposit: { version: 2, expectedAmountSource: 'REQUEST', holdingFinancialAccountId: depositAccount },
      });
      expect((await audits(outcome.deposit.id))[1]).toMatchObject({
        action: 'AMENDED',
        previous_version: 1,
        new_version: 2,
        metadata: {
          changes: {
            expectedAmount: { from: { amount: '3000.00', currency: 'EUR' }, to: { amount: '3100.00', currency: 'EUR' } },
            holdingFinancialAccountId: { from: null, to: depositAccount },
          },
        },
      });
    });

    it('a no-op leaves version and audit alone, even with a stale If-Match; the source stays without an amount change', async () => {
      const deposit = await created();
      await repository.amend(deposit.id, REALM, { notes: 'x' }, actor);
      expect(await repository.amend(deposit.id, REALM, { notes: 'x', expectedAmount: eur('3000') }, actor, [1])).toMatchObject({
        kind: 'AMENDED',
        changed: false,
        deposit: { version: 2, expectedAmountSource: 'REQUEST' },
      });
      expect(await audits(deposit.id)).toHaveLength(2);
    });

    it('refuses: unknown, other Realm, not ACTIVE, a wrong account, a stale version', async () => {
      const deposit = await created();
      expect(await repository.amend('00000000-0000-4000-8000-000000000000', REALM, { notes: 'x' }, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.amend(deposit.id, OTHER_REALM, { notes: 'x' }, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.amend(deposit.id, REALM, { holdingFinancialAccountId: bankAccount }, actor)).toMatchObject({
        kind: 'NOT_A_SECURITY_DEPOSIT_ACCOUNT',
        accountType: 'BANK',
      });
      expect(await repository.amend(deposit.id, REALM, { holdingFinancialAccountId: foreignDepositAccount }, actor)).toMatchObject({
        kind: 'ACCOUNT_NOT_FOUND',
      });
      expect(await repository.amend(deposit.id, REALM, { notes: 'x' }, actor, [7])).toMatchObject({ kind: 'VERSION_CONFLICT', currentVersion: 1 });
      await repository.void(deposit.id, REALM, 'Irrtum', new Date(), actor);
      expect(await repository.amend(deposit.id, REALM, { notes: null }, actor)).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', status: 'VOID' });
    });

    it('concurrent amends with one If-Match: one wins, the other is a VERSION_CONFLICT', async () => {
      const deposit = await created();
      const outcomes = await Promise.all([
        repository.amend(deposit.id, REALM, { notes: 'a' }, actor, [1]),
        repository.amend(deposit.id, REALM, { notes: 'b' }, actor, [1]),
      ]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(['AMENDED', 'VERSION_CONFLICT']);
    });
  });

  describe('void', () => {
    it('ACTIVE → VOID with time, actor and reason; again a no-op; VOIDED once', async () => {
      const deposit = await created();
      const at = new Date('2027-03-01T10:00:00Z');
      expect(await repository.void(deposit.id, REALM, 'Doppelt angelegt', at, actor, [1])).toMatchObject({
        kind: 'VOIDED',
        changed: true,
        deposit: { status: 'VOID', voidedAt: at, voidReason: 'Doppelt angelegt', version: 2 },
      });
      expect((await pool.query('SELECT voided_by FROM security_deposit WHERE id = $1', [deposit.id])).rows[0].voided_by).toBe(actor.actorId);
      expect(await repository.void(deposit.id, REALM, 'anders', new Date(), actor, [1])).toMatchObject({
        kind: 'VOIDED',
        changed: false,
        deposit: { version: 2 },
      });
      expect((await audits(deposit.id)).map((a) => a.action)).toEqual(['CREATED', 'VOIDED']);
    });

    it('refuses an unknown or foreign deposit and a stale version', async () => {
      const deposit = await created();
      expect(await repository.void(deposit.id, OTHER_REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.void('bad', REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.void(deposit.id, REALM, 'x', new Date(), actor, [2])).toMatchObject({ kind: 'VERSION_CONFLICT' });
    });
  });

  describe('list', () => {
    it('filters by status, Tenant and account in the Realm, newest first, with total', async () => {
      const realm = '64b0c0ffee000000000000a1';
      const holding = await account(realm, 'SECURITY_DEPOSIT', 'Kaution L');
      const make = async (holdingFinancialAccountId: string | null) => {
        const o = await repository.create(newDeposit(request({ mreRealmId: realm, holdingFinancialAccountId })), actor);
        if (o.kind !== 'CREATED') throw new Error(o.kind);
        return o.deposit;
      };
      const a = await make(holding);
      const b = await make(null);
      const c = await make(holding);
      await repository.void(b.id, realm, 'x', new Date(), actor);
      const page = { page: 1, pageSize: 50 };
      expect((await repository.list(realm, {}, page)).items.map((d) => d.id)).toEqual([c.id, b.id, a.id]);
      expect(await repository.list(realm, { statuses: ['ACTIVE'] }, page)).toMatchObject({ total: 2 });
      expect((await repository.list(realm, { statuses: ['VOID'] }, page)).items.map((d) => d.id)).toEqual([b.id]);
      expect((await repository.list(realm, { mreTenantId: a.mreTenantId }, page)).items.map((d) => d.id)).toEqual([a.id]);
      expect((await repository.list(realm, { holdingFinancialAccountId: holding }, page)).total).toBe(2);
      expect((await repository.list(realm, { holdingFinancialAccountId: 'bad' }, page)).total).toBe(0);
      expect(await repository.list(realm, {}, { page: 2, pageSize: 2 })).toMatchObject({ items: [{ id: a.id }], total: 3, page: 2, pageSize: 2 });
      expect((await repository.list(OTHER_REALM, { mreTenantId: a.mreTenantId }, page)).total).toBe(0);
    });
  });

  describe('concurrency (§47.1, RC and RR)', () => {
    const rawVoid = `UPDATE security_deposit SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'x', version = version + 1 WHERE id = $1`;
    const rawAmend = `UPDATE security_deposit SET notes = 'raw', version = version + 1 WHERE id = $1`;
    /** `statement` committed on a second connection while `write` waits on its lock. */
    const behind = async <T>(statement: string, id: string, write: () => Promise<T>, end: 'COMMIT' | 'ROLLBACK' = 'COMMIT'): Promise<T> => {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(statement, [id]);
        const waiting = write();
        await waitForLocks(pool);
        await holder.query(end);
        return await waiting;
      } finally {
        holder.release();
      }
    };

    it('void against amend (RC): an amend that waited sees VOID; a void that waited sees the new version (412)', async () => {
      const a = await created();
      expect(await behind(rawVoid, a.id, () => repository.amend(a.id, REALM, { notes: 'x' }, actor, [1]))).toEqual({
        kind: 'DEPOSIT_NOT_ACTIVE',
        status: 'VOID',
      });
      const b = await created();
      expect(await behind(rawAmend, b.id, () => repository.void(b.id, REALM, 'x', new Date(), actor, [1]))).toMatchObject({
        kind: 'VERSION_CONFLICT',
        currentVersion: 2,
      });
      // Without If-Match the void that waited applies on the new version.
      const c = await created();
      expect(await behind(rawAmend, c.id, () => repository.void(c.id, REALM, 'x', new Date(), actor))).toMatchObject({
        kind: 'VOIDED',
        changed: true,
        deposit: { version: 3, notes: 'raw' },
      });
    });

    it('two voids (RC): the one that waited is a no-op', async () => {
      const d = await created();
      expect(await behind(rawVoid, d.id, () => repository.void(d.id, REALM, 'x', new Date(), actor))).toMatchObject({ kind: 'VOIDED', changed: false });
    });

    it('void against amend (RR): the later writer fails to serialise', async () => {
      const d = await created();
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN');
        await two.query(rawVoid, [d.id]);
        const amending = one.query(rawAmend, [d.id]).then(
          () => 'amended',
          (error: { code?: string }) => error.code,
        );
        await waitForLocks(pool);
        await two.query('COMMIT');
        expect(await amending).toBe('40001');
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    });

    it('a void and a new create for the Tenant (RC): the create waits on the index and succeeds; without the void, DEPOSIT_EXISTS', async () => {
      const voided = await created();
      const after = await behind(rawVoid, voided.id, () => repository.create(newDeposit(request({ mreTenantId: voided.mreTenantId })), actor));
      expect(after).toMatchObject({ kind: 'CREATED', deposit: { mreTenantId: voided.mreTenantId, status: 'ACTIVE' } });
      const kept = await created();
      const refused = await behind(rawVoid, kept.id, () => repository.create(newDeposit(request({ mreTenantId: kept.mreTenantId })), actor), 'ROLLBACK');
      expect(refused).toEqual({ kind: 'DEPOSIT_EXISTS', securityDepositId: kept.id });
    });
  });

  describe('database guards (migration 0037)', () => {
    const fails = async (statement: string, params: unknown[], message: RegExp) => {
      await expect(pool.query(statement, params)).rejects.toThrow(message);
    };
    const insert = `INSERT INTO security_deposit (mre_realm_id, status, mre_tenant_id, expected_amount, currency, expected_amount_source, holding_financial_account_id, interest_bearing, created_by, version)
       VALUES ($1, $2, $3, $4, 'EUR', 'REQUEST', $5, true, 'seed', $6)`;

    it('inserts only ACTIVE with version 1, a positive amount of at most two decimals, a 24-hex Tenant, a deposit account', async () => {
      await fails(insert, [REALM, 'VOID', nextTenant(), '1.00', null, 1], /only inserted ACTIVE/);
      await fails(insert, [REALM, 'ACTIVE', nextTenant(), '1.00', null, 2], /only inserted ACTIVE/);
      await fails(insert, [REALM, 'ACTIVE', nextTenant(), '0', null, 1], /check constraint/);
      await fails(insert, [REALM, 'ACTIVE', nextTenant(), '1.001', null, 1], /check constraint/);
      await fails(insert, [REALM, 'ACTIVE', 'ABC', '1.00', null, 1], /check constraint/);
      await fails(insert, [REALM, 'ACTIVE', nextTenant(), '1.00', bankAccount, 1], /NOT_A_SECURITY_DEPOSIT_ACCOUNT/);
      await fails(insert, [REALM, 'ACTIVE', nextTenant(), '1.00', foreignDepositAccount, 1], /foreign key/);
      await fails(insert, [REALM, 'ACTIVE', nextTenant(), '1000000000000000000', null, 1], /check constraint/);
    });

    it('every other CHECK: notes and void_reason lengths, the currency, the amount source', async () => {
      const columns = `mre_realm_id, status, mre_tenant_id, expected_amount, currency, expected_amount_source, interest_bearing, created_by`;
      const row = (currency: string, source: string, notes: string | null) => [REALM, nextTenant(), currency, source, notes];
      const raw = `INSERT INTO security_deposit (${columns}, notes) VALUES ($1, 'ACTIVE', $2, 1, $3, $4, true, 'seed', $5)`;
      // The positive cases pass, so each refusal below is its own CHECK's.
      await pool.query(raw, row('EUR', 'MRE_GUARANTY', 'x'.repeat(2000)));
      await fails(raw, row('EUR', 'REQUEST', ''), /security_deposit_notes_check/);
      await fails(raw, row('EUR', 'REQUEST', 'x'.repeat(2001)), /security_deposit_notes_check/);
      await fails(raw, row('USD', 'REQUEST', null), /security_deposit_currency_check/);
      await fails(raw, row('EUR', 'GUESSED', null), /security_deposit_expected_amount_source_check/);
      const deposit = await created();
      const voidWith = (reason: string) =>
        `UPDATE security_deposit SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = '${reason}', version = version + 1 WHERE id = $1`;
      await fails(voidWith(''), [deposit.id], /security_deposit_void_reason_check/);
      await fails(voidWith('x'.repeat(501)), [deposit.id], /security_deposit_void_reason_check/);
      await pool.query(voidWith('x'.repeat(500)), [deposit.id]);
    });

    it('the Tenant, Realm and creation never change; VOID is final; a void changes nothing else; version + 1 per step', async () => {
      const deposit = await created();
      await fails('UPDATE security_deposit SET mre_tenant_id = $2, version = version + 1 WHERE id = $1', [deposit.id, nextTenant()], /never changes/);
      await fails('UPDATE security_deposit SET notes = $2 WHERE id = $1', [deposit.id, 'x'], /exactly one/);
      // A step since 0039; without the closing columns its close guard refuses it (the 0039 tests cover the rest).
      await fails('UPDATE security_deposit SET status = $2, version = version + 1 WHERE id = $1', [deposit.id, 'CLOSED'], /HELD_AT_CLOSING/);
      await fails(
        `UPDATE security_deposit SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'x', notes = 'y', version = version + 1 WHERE id = $1`,
        [deposit.id],
        /changes nothing else/,
      );
      await fails(`UPDATE security_deposit SET status = 'VOID', version = version + 1 WHERE id = $1`, [deposit.id], /security_deposit_void_fields/);
      // P3-D8's no-op write passes.
      await pool.query('UPDATE security_deposit SET version = version WHERE id = $1', [deposit.id]);
      await repository.void(deposit.id, REALM, 'Irrtum', new Date(), actor);
      await fails('UPDATE security_deposit SET notes = $2, version = version + 1 WHERE id = $1', [deposit.id, 'x'], /VOID is final/);
      await fails('DELETE FROM security_deposit WHERE id = $1', [deposit.id], /never deleted/);
    });

    it('a held account keeps its type while a deposit that is not VOID names it', async () => {
      const held = await account(REALM, 'SECURITY_DEPOSIT', 'Gehalten');
      const deposit = await created({ holdingFinancialAccountId: held });
      await fails(`UPDATE financial_account SET account_type = 'BANK' WHERE id = $1`, [held], /a security deposit holds it/);
      await repository.void(deposit.id, REALM, 'Irrtum', new Date(), actor);
      await pool.query(`UPDATE financial_account SET account_type = 'BANK' WHERE id = $1`, [held]);
    });

    it('an amend to a non-deposit account is refused by the guard too', async () => {
      const deposit = await created();
      await fails(
        'UPDATE security_deposit SET holding_financial_account_id = $2, version = version + 1 WHERE id = $1',
        [deposit.id, bankAccount],
        /NOT_A_SECURITY_DEPOSIT/,
      );
    });
  });
});
