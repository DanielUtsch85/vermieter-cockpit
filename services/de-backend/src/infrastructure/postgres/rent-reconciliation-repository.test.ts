import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate, SplitInput } from '../../domains/ledger/index.js';
import type { NewMatch } from '../../domains/rent-reconciliation/index.js';
import { Money } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresRentReconciliationRepository } from './rent-reconciliation-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-4-01 persistence (api-design.md §37.1): the cash rules and their order of checks, the precheck and idempotency,
 * release, the correction rule, the locks against concurrent creates and corrections (RC and RR, P4-D8), and the
 * schema's rules past the repository (migration 0030).
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000014';
const OTHER_REALM = '64b0c0ffee00000000000015';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';
const TENANT_2 = '6512f0c2a1b2c3d4e5f60a02';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, financialCategoryCode = 'RENT_BASE'): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId: null,
  loanId: null,
  description: null,
});

async function waitForLocks(pool: pg.Pool, count = 1): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Number((await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].count) < count) {
    if (Date.now() > deadline) throw new Error(`fewer than ${count} sessions wait on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The trigger's own reason, the constraint's name, or the error code. */
function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return error.constraint ?? /\(([A-Z_]+)\)|never deleted|fixed after creation|is not a step|only inserted SUGGESTED or CONFIRMED with version 1|only lowered when a suggestion is confirmed|only inserted NOT_WRITTEN|released with write-back|with write-back [A-Z_]+|mre_last_lease_until changed outside a claim|a claim sets mre_last_lease_until to the latest lease/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error';
}

describe.skipIf(databaseUrl === undefined)('RentPaymentReconciliation (§37.1)', () => {
  const schema = testSchemaName('rent_reconciliation_test');
  let pool: pg.Pool;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let corrections: PostgresCorrectionRepository;
  let repository: PostgresRentReconciliationRepository;
  let account: string;
  let otherAccount: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    repository = new PostgresRentReconciliationRepository(db);
    const created = await accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    const other = await accounts.create({ mreRealmId: OTHER_REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (created.kind !== 'CREATED' || other.kind !== 'CREATED') throw new Error('account');
    account = created.account.id;
    otherAccount = other.account.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  /** A Transaction with the given splits, confirmed unless told otherwise. */
  async function transaction(set: readonly SplitInput[] = [split('800.00')], options: { direction?: 'INFLOW' | 'OUTFLOW'; confirm?: boolean; realm?: string; bookingDate?: string; iban?: string } = {}): Promise<string> {
    const realm = options.realm ?? REALM;
    const total = set.reduce((sum, s) => sum.add(s.amount), eur('0'));
    const created = await transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: realm === REALM ? account : otherAccount,
        amount: total,
        direction: options.direction ?? 'INFLOW',
        bookingDate: day(options.bookingDate ?? '2027-01-03'),
        valueDate: null,
        description: 'Miete',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const id = created.transaction.id;
    const replaced = await splits.replaceSplits(id, realm, set, actor);
    if (replaced.kind !== 'REPLACED') throw new Error(JSON.stringify(replaced));
    if (options.iban !== undefined) await pool.query(`UPDATE ledger_transaction SET counterparty_iban_raw = $1 WHERE id = $2`, [options.iban, id]);
    if (options.confirm ?? true) {
      const confirmed = await transactions.confirm(id, realm, actor);
      if (confirmed.kind !== 'CONFIRMED') throw new Error(confirmed.kind);
    }
    return id;
  }
  const match = (transactionId: string, amount = '800.00', term = '2027010100', tenant = TENANT): NewMatch => ({
    mreRealmId: REALM,
    transactionId,
    mreTenantId: tenant,
    mreRentTerm: term,
    matchedAmount: eur(amount),
    notes: null,
  });
  const created = async (m: NewMatch) => {
    const outcome = await repository.create(m, actor);
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome));
    return outcome.reconciliation;
  };
  const rawInsert = (transactionId: string, amount: string, term = '2027010100', status = 'CONFIRMED') =>
    `INSERT INTO rent_payment_reconciliation (mre_realm_id, status, transaction_id, mre_tenant_id, mre_rent_term, matched_amount, currency,
       confidence, suggestion_reason, confirmed_at, confirmed_by, created_by)
     VALUES ('${REALM}', '${status}', '${transactionId}', '${TENANT}', '${term}', ${amount}, 'EUR',
       ${status === 'SUGGESTED' ? `'MEDIUM', 'EXACT_AMOUNT', NULL, NULL` : `NULL, NULL, now(), 'x'`}, 'x')`;

  describe('create: the cash rules in their order (P4-D3)', () => {
    it('unknown or foreign Transaction; not counted (unconfirmed, a reversal, a CORRECTED original); OUTFLOW; no rent cash', async () => {
      const foreign = await transaction([split('800.00')], { realm: OTHER_REALM });
      expect(await repository.create(match(foreign), actor)).toEqual({ kind: 'TRANSACTION_NOT_FOUND' });
      expect(await repository.create(match('00000000-0000-4000-8000-000000000000'), actor)).toEqual({ kind: 'TRANSACTION_NOT_FOUND' });
      const unconfirmed = await transaction([split('800.00')], { confirm: false });
      expect(await repository.create(match(unconfirmed), actor)).toEqual({ kind: 'TRANSACTION_NOT_COUNTED', status: 'CLASSIFIED', correctionRole: null });
      const original = await transaction();
      const reversed = await corrections.correct(original, REALM, { reason: 'Doppelt', replacement: null }, actor);
      if (reversed.kind !== 'CORRECTED') throw new Error(reversed.kind);
      expect(await repository.create(match(original), actor)).toEqual({ kind: 'TRANSACTION_NOT_COUNTED', status: 'CORRECTED', correctionRole: null });
      expect(await repository.create(match(reversed.result.reversal.id), actor)).toEqual({ kind: 'TRANSACTION_NOT_COUNTED', status: 'CONFIRMED', correctionRole: 'REVERSAL' });
      expect(await repository.create(match(await transaction([split('800.00')], { direction: 'OUTFLOW' })), actor)).toEqual({ kind: 'TRANSACTION_NOT_INFLOW' });
      expect(await repository.create(match(await transaction([split('800.00', 'INSURANCE')])), actor)).toEqual({ kind: 'NO_RENT_CASH' });
    });

    it('rent cash is the RENT_* splits only; available = rent cash − CONFIRMED; the same term twice is ALREADY_MATCHED', async () => {
      const t = await transaction([split('700.00'), split('100.00', 'RENT_OPERATING_COST_ADVANCE'), split('50.00', 'BANK_FEES')]);
      const first = await created(match(t, '500.00'));
      expect(first).toMatchObject({ status: 'CONFIRMED', matchedAmount: eur('500.00'), confirmedBy: actor.actorId, mreWriteBackState: 'NOT_WRITTEN', version: 1 });
      expect(await repository.create(match(t, '1.00'), actor)).toEqual({ kind: 'ALREADY_MATCHED', reconciliationId: first.id });
      expect(await repository.create(match(t, '300.01', '2027020100'), actor)).toEqual({ kind: 'RENT_CASH_EXCEEDED', rentCash: eur('800.00'), available: eur('300.00') });
      expect((await created(match(t, '300.00', '2027020100'))).mreRentTerm).toBe('2027020100');
      expect(await repository.create(match(t, '0.01', '2027030100'), actor)).toEqual({ kind: 'RENT_CASH_EXCEEDED', rentCash: eur('800.00'), available: eur('0.00') });
    });

    it('several Transactions per term, one Transaction over several Tenants; a release makes its cash available again', async () => {
      const [a, b] = [await transaction([split('400.00')]), await transaction([split('400.00')])];
      await created(match(a, '400.00'));
      await created(match(b, '400.00'));
      const c = await transaction([split('1000.00')]);
      const toFirst = await created(match(c, '600.00'));
      await created(match(c, '400.00', '2027010100', TENANT_2));
      expect((await repository.create(match(c, '1.00', '2027020100'), actor)).kind).toBe('RENT_CASH_EXCEEDED');
      expect((await repository.release(toFirst.id, REALM, 'falscher Monat', new Date(), actor)).kind).toBe('RELEASED');
      expect((await created(match(c, '600.00', '2027020100'))).matchedAmount).toEqual(eur('600.00'));
      // The released one no longer holds the term: the same match can be made again.
      expect((await repository.create(match(c, '1.00'), actor)).kind).toBe('RENT_CASH_EXCEEDED');
    });

    it('writes AuditRecords CONFIRMED (manual) and RELEASED; the Transaction is never changed', async () => {
      const t = await transaction();
      const before = (await pool.query(`SELECT status, version, updated_at FROM ledger_transaction WHERE id = $1`, [t])).rows[0];
      const r = await created(match(t));
      const released = await repository.release(r.id, REALM, 'Irrtum', new Date(), actor);
      expect(released).toMatchObject({ kind: 'RELEASED', changed: true, reconciliation: { status: 'RELEASED', releasedBy: actor.actorId, releaseReason: 'Irrtum', version: 2 } });
      const audit = await pool.query(`SELECT action, previous_version, new_version, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, new_version`, [r.id]);
      expect(audit.rows).toEqual([
        { action: 'CONFIRMED', previous_version: null, new_version: 1, metadata: { transactionId: t, mreTenantId: TENANT, mreRentTerm: '2027010100', matchedAmount: { amount: '800.00', currency: 'EUR' }, manual: true } },
        { action: 'RELEASED', previous_version: 1, new_version: 2, metadata: {
            transactionId: t,
            reason: 'Irrtum',
            matchedAmount: { amount: '800.00', currency: 'EUR' },
            mreWriteBackState: { from: 'NOT_WRITTEN', to: 'NOT_WRITTEN' },
          },
        },
      ]);
      expect((await pool.query(`SELECT status, version, updated_at FROM ledger_transaction WHERE id = $1`, [t])).rows[0]).toEqual(before);
    });
  });

  describe('precheck and idempotency', () => {
    it('precheck answers the refusals and PROCEED, and writes nothing', async () => {
      const t = await transaction();
      expect(await repository.precheck(match(t))).toEqual({ kind: 'PROCEED' });
      expect(await repository.precheck(match(t, '800.01'))).toEqual({ kind: 'RENT_CASH_EXCEEDED', rentCash: eur('800.00'), available: eur('800.00') });
      expect((await pool.query(`SELECT count(*)::int AS n FROM rent_payment_reconciliation WHERE transaction_id = $1`, [t])).rows[0].n).toBe(0);
    });

    it('a key replays the recorded result (also in the precheck, so MRE is not asked); another payload is a conflict', async () => {
      const t = await transaction();
      const key = { key: `k-${t}`, fingerprint: 'f1' };
      const first = await repository.create(match(t), actor, key);
      if (first.kind !== 'CREATED') throw new Error(first.kind);
      expect(await repository.create(match(t), actor, key)).toEqual({ kind: 'REPLAYED', reconciliation: first.reconciliation });
      expect(await repository.precheck(match(t), key)).toEqual({ kind: 'REPLAYED', reconciliation: first.reconciliation });
      expect(await repository.precheck(match(t), { ...key, fingerprint: 'f2' })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
      expect(await repository.create(match(t), actor, { ...key, fingerprint: 'f2' })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
      // A refused create rolls its key back: the same key works once the refusal is gone.
      const u = await transaction([split('100.00')]);
      const refusedKey = { key: `k-${u}`, fingerprint: 'f3' };
      expect((await repository.create(match(u, '200.00'), actor, refusedKey)).kind).toBe('RENT_CASH_EXCEEDED');
      expect((await repository.create(match(u, '100.00'), actor, { ...refusedKey, fingerprint: 'f4' })).kind).toBe('CREATED');
    });
  });

  describe('release and reads', () => {
    it('unknown or foreign → NOT_FOUND; a repeat is a no-op; If-Match; SUGGESTED or REJECTED → NOT_RELEASABLE', async () => {
      const t = await transaction();
      const r = await created(match(t));
      expect(await repository.release(r.id, OTHER_REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.release('nope', REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.release(r.id, REALM, 'x', new Date(), actor, [7])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [7], currentVersion: 1 });
      const first = await repository.release(r.id, REALM, 'erster Grund', new Date(), actor, [1]);
      if (first.kind !== 'RELEASED') throw new Error(first.kind);
      expect(await repository.release(r.id, REALM, 'zweiter Grund', new Date(), actor, [1])).toEqual({ kind: 'RELEASED', reconciliation: first.reconciliation, changed: false });
      const { rows } = await pool.query(`${rawInsert(t, '1.00', '2027050100', 'SUGGESTED')} RETURNING id`);
      expect(await repository.release(rows[0].id as string, REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_RELEASABLE', status: 'SUGGESTED' });
    });

    it('findById and list in the Realm, newest first, with every filter', async () => {
      const t = await transaction([split('300.00')]);
      const a = await created(match(t, '100.00', '2027060100'));
      const b = await created(match(t, '100.00', '2027070100', TENANT_2));
      await repository.release(a.id, REALM, 'x', new Date(), actor);
      expect(await repository.findById(a.id, OTHER_REALM)).toBeUndefined();
      expect((await repository.findById(b.id, REALM))?.mreTenantId).toBe(TENANT_2);
      const page = { page: 1, pageSize: 50 };
      expect((await repository.list(REALM, { transactionId: t }, page)).items.map((r) => r.id)).toEqual([b.id, a.id]);
      expect((await repository.list(REALM, { transactionId: t, status: ['RELEASED'] }, page)).items.map((r) => r.id)).toEqual([a.id]);
      expect((await repository.list(REALM, { transactionId: t, mreTenantId: TENANT_2 }, page)).items.map((r) => r.id)).toEqual([b.id]);
      expect((await repository.list(REALM, { transactionId: t, mreRentTerm: '2027060100' }, page)).items.map((r) => r.id)).toEqual([a.id]);
      expect((await repository.list(OTHER_REALM, { transactionId: t }, page)).total).toBe(0);
      const paged = await repository.list(REALM, { transactionId: t }, { page: 2, pageSize: 1 });
      expect(paged).toMatchObject({ total: 2, page: 2, pageSize: 1, items: [{ id: a.id }] });
    });
  });

  describe('coverage reads, DE side (§37.2)', () => {
    it('termSide: every status of the Tenant and term in the Realm, in createdAt order', async () => {
      const [a, b] = [await transaction([split('400.00')]), await transaction([split('401.00')])];
      const first = await created(match(a, '400.00', '2027080100'));
      const second = await created(match(b, '400.00', '2027080100'));
      await created(match(b, '1.00', '2027090100'));
      await repository.release(first.id, REALM, 'x', new Date(), actor);
      const side = await repository.termSide(REALM, TENANT, '2027080100');
      expect(side.map((r) => [r.id, r.status])).toEqual([
        [first.id, 'RELEASED'],
        [second.id, 'CONFIRMED'],
      ]);
      expect(await repository.termSide(OTHER_REALM, TENANT, '2027080100')).toEqual([]);
      expect(await repository.termSide(REALM, TENANT_2, '2027080100')).toEqual([]);
    });

    it('transactionSide: the cash view and every reconciliation; unknown or foreign is undefined; not rent has no rent cash', async () => {
      const t = await transaction([split('700.00'), split('100.00', 'BANK_FEES')]);
      const r = await created(match(t, '300.00', '2027100100'));
      await repository.release((await created(match(t, '100.00', '2027110100'))).id, REALM, 'x', new Date(), actor);
      const side = await repository.transactionSide(t, REALM);
      expect(side).toMatchObject({ transactionId: t, status: 'CONFIRMED', direction: 'INFLOW', correctionRole: null, rentCash: eur('700.00') });
      expect(side?.reconciliations.map((x) => x.status)).toEqual(['CONFIRMED', 'RELEASED']);
      expect(side?.reconciliations[0]?.id).toBe(r.id);
      expect(await repository.transactionSide(t, OTHER_REALM)).toBeUndefined();
      expect(await repository.transactionSide('nope', REALM)).toBeUndefined();
      expect(await repository.transactionSide(await transaction([split('80.00', 'INSURANCE')]), REALM)).toMatchObject({ rentCash: null, reconciliations: [] });
      const unconfirmed = await transaction([split('80.00')], { confirm: false });
      expect(await repository.transactionSide(unconfirmed, REALM)).toMatchObject({ status: 'CLASSIFIED', rentCash: eur('80.00') });
    });
  });

  describe('suggestions (§37.3)', () => {
    const SUG_REALM_TENANT = '6512f0c2a1b2c3d4e5f60b01';
    const suggestion = (transactionId: string, amount = '800.00', term = '2027050100', tenant = SUG_REALM_TENANT) => ({
      transactionId,
      mreTenantId: tenant,
      mreRentTerm: term,
      matchedAmount: eur(amount),
      confidence: 'MEDIUM' as const,
      suggestionReason: 'EXACT_AMOUNT' as const,
    });
    const suggested = async (transactionId: string, amount = '800.00', term = '2027050100', tenant = SUG_REALM_TENANT) => {
      const [written] = await repository.writeSuggestions(REALM, [suggestion(transactionId, amount, term, tenant)], actor);
      if (written === undefined) throw new Error('not written');
      return written;
    };

    it('suggestionSnapshot: counted INFLOW with available cash in the window; term sums; handled and open pairs; the IBAN history', async () => {
      const inWindow = await transaction([split('800.00')], { bookingDate: '2027-05-03', iban: 'DE11' });
      const consumed = await transaction([split('800.00')], { bookingDate: '2027-05-04' });
      await created(match(consumed, '800.00', '2027040100', SUG_REALM_TENANT));
      const late = await transaction([split('800.00')], { bookingDate: '2027-07-01' });
      const open = await transaction([split('800.00')], { bookingDate: '2027-05-06', confirm: false });
      const outflow = await transaction([split('800.00')], { bookingDate: '2027-05-07', direction: 'OUTFLOW' });
      const partly = await transaction([split('900.00')], { bookingDate: '2027-05-08', iban: 'DE22' });
      await created(match(partly, '100.00', '2027050100', SUG_REALM_TENANT));
      const pending = await suggested(inWindow, '800.00', '2027060100');
      const snapshot = await repository.suggestionSnapshot(REALM, [{ mreTenantId: SUG_REALM_TENANT, mreRentTerm: '2027050100' }], day('2027-04-15'), day('2027-06-30'));
      const ids = snapshot.candidates.map((c) => c.transactionId);
      expect(ids).toContain(inWindow);
      expect(ids).toContain(partly);
      for (const excluded of [consumed, late, open, outflow]) expect(ids).not.toContain(excluded);
      expect(snapshot.candidates.find((c) => c.transactionId === partly)).toMatchObject({ available: eur('800.00'), counterpartyIban: 'DE22', bookingDate: '2027-05-08' });
      expect(snapshot.confirmedByTerm.get(`${SUG_REALM_TENANT}/2027050100`)).toEqual(eur('100.00'));
      expect(snapshot.open).toContainEqual({ transactionId: pending.transactionId, mreTenantId: SUG_REALM_TENANT, mreRentTerm: '2027060100' });
      expect(snapshot.handled).toContainEqual({ transactionId: partly, mreTenantId: SUG_REALM_TENANT, mreRentTerm: '2027050100' });
      expect(snapshot.history).toContainEqual({ mreTenantId: SUG_REALM_TENANT, counterpartyIban: 'DE22' });
      expect((await repository.suggestionSnapshot(OTHER_REALM, [], day('2027-04-15'), day('2027-06-30'))).candidates).toEqual([]);
    });

    it('writeSuggestions: SUGGESTED with an AuditRecord; a pair changed in between or already handled is skipped', async () => {
      const t = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const changed = await transaction([split('800.00')], { bookingDate: '2027-05-04' });
      await created(match(changed, '100.00', '2027010100'));
      const written = await repository.writeSuggestions(REALM, [suggestion(t), suggestion(changed)], actor);
      expect(written.map((w) => [w.transactionId, w.status, w.confidence, w.suggestionReason, w.version])).toEqual([[t, 'SUGGESTED', 'MEDIUM', 'EXACT_AMOUNT', 1]]);
      expect(await repository.writeSuggestions(REALM, [suggestion(t)], actor)).toEqual([]);
      const audit = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1`, [written[0]?.id]);
      expect(audit.rows).toEqual([
        { action: 'SUGGESTED', metadata: { transactionId: t, mreTenantId: SUG_REALM_TENANT, mreRentTerm: '2027050100', matchedAmount: { amount: '800.00', currency: 'EUR' }, confidence: 'MEDIUM', suggestionReason: 'EXACT_AMOUNT' } },
      ]);
      // A suggestion never counts: the whole cash stays available for a manual match.
      expect((await repository.precheck(match(t, '800.00', '2027090100'))).kind).toBe('PROCEED');
    });

    it('confirm: lowers the amount, a repeat is a no-op, the refusals in order; AuditRecord CONFIRMED with manual = false', async () => {
      const t = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const s1 = await suggested(t, '800.00', '2027110100');
      expect(await repository.confirmPrecheck(s1.id, OTHER_REALM, undefined)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.confirmPrecheck(s1.id, REALM, eur('800.01'))).toEqual({ kind: 'ABOVE_SUGGESTION', suggested: eur('800.00') });
      expect(await repository.confirmPrecheck(s1.id, REALM, eur('700.00'))).toMatchObject({ kind: 'PROCEED', amount: eur('700.00') });
      expect(await repository.confirm(s1.id, REALM, eur('700.00'), eur('600.00'), actor)).toEqual({ kind: 'SUGGESTION_STALE', openAmount: eur('600.00') });
      expect(await repository.confirm(s1.id, REALM, eur('700.00'), eur('800.00'), actor, [9])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [9], currentVersion: 1 });
      const done = await repository.confirm(s1.id, REALM, eur('700.00'), eur('800.00'), actor, [1]);
      expect(done).toMatchObject({ kind: 'CONFIRMED', changed: true, reconciliation: { status: 'CONFIRMED', matchedAmount: eur('700.00'), confirmedBy: actor.actorId, confidence: 'MEDIUM', version: 2 } });
      expect(await repository.confirm(s1.id, REALM, undefined, eur('800.00'), actor, [1])).toMatchObject({ kind: 'CONFIRMED', changed: false });
      expect(await repository.confirmPrecheck(s1.id, REALM, eur('600.00'))).toEqual({ kind: 'NOT_CONFIRMABLE', status: 'CONFIRMED' });
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'CONFIRMED'`, [s1.id]);
      expect(audit.rows[0].metadata).toMatchObject({ manual: false, suggestedAmount: { amount: '800.00', currency: 'EUR' }, matchedAmount: { amount: '700.00', currency: 'EUR' } });
      // The cash rules: a second suggestion over the rest of t confirms only within the available 100.00.
      const s2 = await suggested(t, '100.00', '2027060100');
      expect(await repository.confirmPrecheck(s2.id, REALM, undefined)).toMatchObject({ kind: 'PROCEED' });
      await created(match(t, '50.00', '2027070100'));
      expect(await repository.confirm(s2.id, REALM, undefined, eur('800.00'), actor)).toEqual({ kind: 'RENT_CASH_EXCEEDED', rentCash: eur('800.00'), available: eur('50.00') });
    });

    it('reject: final with the reason; a repeat is a no-op; CONFIRMED and RELEASED not rejectable; If-Match', async () => {
      const t = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const s1 = await suggested(t);
      expect(await repository.reject(s1.id, OTHER_REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.reject(s1.id, REALM, 'x', new Date(), actor, [5])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [5], currentVersion: 1 });
      const first = await repository.reject(s1.id, REALM, 'anderer Mieter', new Date(), actor, [1]);
      expect(first).toMatchObject({ kind: 'REJECTED', changed: true, reconciliation: { status: 'REJECTED', rejectReason: 'anderer Mieter', rejectedBy: actor.actorId, version: 2 } });
      expect(await repository.reject(s1.id, REALM, 'zweiter', new Date(), actor)).toMatchObject({ kind: 'REJECTED', changed: false, reconciliation: { rejectReason: 'anderer Mieter' } });
      const audit = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at`, [s1.id]);
      expect(audit.rows.map((r) => r.action)).toEqual(['SUGGESTED', 'REJECTED']);
      // A rejected pair is handled: in the snapshot, and never written again while its cash is still all available.
      const snapshot = await repository.suggestionSnapshot(REALM, [], day('2027-05-01'), day('2027-05-31'));
      expect(snapshot.handled).toContainEqual({ transactionId: t, mreTenantId: SUG_REALM_TENANT, mreRentTerm: '2027050100' });
      expect(snapshot.open).not.toContainEqual({ transactionId: t, mreTenantId: SUG_REALM_TENANT, mreRentTerm: '2027050100' });
      expect(await repository.writeSuggestions(REALM, [suggestion(t)], actor)).toEqual([]);
      const s2 = await suggested(t, '800.00', '2027060100');
      await repository.confirm(s2.id, REALM, undefined, eur('800.00'), actor);
      expect(await repository.reject(s2.id, REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_REJECTABLE', status: 'CONFIRMED' });
    });

    it('concurrency: a run waiting on another run\'s pair skips it; a confirm waiting on a manual match of the same cash (RC), RR 40001', async () => {
      const t = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const raw = `INSERT INTO rent_payment_reconciliation (mre_realm_id, status, transaction_id, mre_tenant_id, mre_rent_term, matched_amount, currency, confidence, suggestion_reason, created_by)
        VALUES ('${REALM}', 'SUGGESTED', '${t}', '${SUG_REALM_TENANT}', '2027050100', 800, 'EUR', 'MEDIUM', 'EXACT_AMOUNT', 'x')`;
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(raw);
        const writing = repository.writeSuggestions(REALM, [suggestion(t)], actor);
        await waitForLocks(pool);
        await holder.query('COMMIT');
        expect(await writing).toEqual([]);
      } finally {
        holder.release();
      }
      const [s1] = (await repository.list(REALM, { transactionId: t, status: ['SUGGESTED'] }, { page: 1, pageSize: 5 })).items;
      const holder2 = await pool.connect();
      try {
        await holder2.query('BEGIN');
        await holder2.query(rawInsert(t, '800.00', '2027080100'));
        const confirming = repository.confirm(s1?.id ?? '', REALM, undefined, eur('800.00'), actor);
        await waitForLocks(pool);
        await holder2.query('COMMIT');
        expect(await confirming).toEqual({ kind: 'RENT_CASH_EXCEEDED', rentCash: eur('800.00'), available: eur('0.00') });
      } finally {
        holder2.release();
      }
      const u = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const s2 = await suggested(u);
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await two.query(rawInsert(u, '800.00', '2027080100'));
        const later = one
          .query(`UPDATE rent_payment_reconciliation SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', version = version + 1 WHERE id = '${s2.id}'`)
          .then(() => 'written', (e: { code?: string }) => e.code);
        await waitForLocks(pool);
        await two.query('COMMIT');
        expect(await later).toBe('40001');
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    });

    it('concurrency: a confirm against a reversal of its Transaction (RC: the reversal wins); RR, the step to CORRECTED after a confirm: 40001', async () => {
      const t = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const s1 = await suggested(t);
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM ledger_transaction WHERE id = $1 FOR UPDATE`, [t]);
        const reversing = corrections.correct(t, REALM, { reason: 'x', replacement: null }, actor);
        await waitForLocks(pool, 1);
        const confirming = repository.confirm(s1.id, REALM, undefined, eur('800.00'), actor);
        await waitForLocks(pool, 2);
        await holder.query('ROLLBACK');
        expect((await reversing).kind).toBe('CORRECTED');
        expect(await confirming).toEqual({ kind: 'TRANSACTION_NOT_COUNTED', status: 'CORRECTED', correctionRole: null });
      } finally {
        holder.release();
      }
      const u = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const s2 = await suggested(u);
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await two.query(`UPDATE rent_payment_reconciliation SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', version = version + 1 WHERE id = '${s2.id}'`);
        const later = one
          .query(`UPDATE ledger_transaction SET status = 'CORRECTED', version = version + 1 WHERE id = '${u}'`)
          .then(() => 'written', (e: { code?: string }) => e.code);
        await waitForLocks(pool);
        await two.query('COMMIT');
        expect(await later).toBe('40001');
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    });

    it('schema (0031): suggestion fields, rejected fields, the SUGGESTED index, the amount only lowered on confirm, SUGGESTED only on counted INFLOW rent cash', async () => {
      const attempt = (query: string) => pool.query(query).then(() => 'accepted', reasonOf);
      // 900.00 of rent cash: a raise to 800.01 passes the cash guard and meets the frozen rule.
      const t = await transaction([split('900.00')], { bookingDate: '2027-05-03' });
      const sug = (tx: string, extra = `'MEDIUM', 'EXACT_AMOUNT'`, term = '2027050100') =>
        `INSERT INTO rent_payment_reconciliation (mre_realm_id, status, transaction_id, mre_tenant_id, mre_rent_term, matched_amount, currency, confidence, suggestion_reason, created_by)
         VALUES ('${REALM}', 'SUGGESTED', '${tx}', '${SUG_REALM_TENANT}', '${term}', 800, 'EUR', ${extra}, 'x') RETURNING id`;
      expect(await attempt(sug(t, 'NULL, NULL'))).toBe('rent_payment_reconciliation_suggestion_fields');
      expect(await attempt(sug(t, `'MEDIUM', 'GUESS'`))).toBe('rent_payment_reconciliation_suggestion_fields');
      expect(await attempt(sug(await transaction([split('800.00')], { confirm: false })))).toBe('(TRANSACTION_NOT_COUNTED)');
      expect(await attempt(sug(await transaction([split('800.00')], { direction: 'OUTFLOW' })))).toBe('(TRANSACTION_NOT_INFLOW)');
      expect(await attempt(sug(await transaction([split('800.00', 'INSURANCE')])))).toBe('(NO_RENT_CASH)');
      const { rows } = await pool.query(sug(t));
      const id = rows[0].id as string;
      expect(await attempt(sug(t))).toBe('rent_payment_reconciliation_suggested_key');
      const set = (assignment: string) => attempt(`UPDATE rent_payment_reconciliation SET ${assignment} WHERE id = '${id}'`);
      expect(await set(`status = 'REJECTED', version = version + 1`)).toBe('rent_payment_reconciliation_rejected_fields');
      expect(await set(`status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', matched_amount = 800.01, version = version + 1`)).toBe(
        'only lowered when a suggestion is confirmed',
      );
      expect(await set(`matched_amount = 700, version = version + 1`)).toBe('only lowered when a suggestion is confirmed');
      expect(await set(`status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', matched_amount = 700, version = version + 1`)).toBe('accepted');
      expect(await set(`status = 'RELEASED', released_at = now(), released_by = 'x', release_reason = 'x', matched_amount = 600, version = version + 1`)).toBe(
        'only lowered when a suggestion is confirmed',
      );
    });
  });

  describe('write-back to MRE (§37.4)', () => {
    let next = 0;
    /** A Tenant of its own per case: a PENDING row of one case never blocks another's claim. */
    const tenant = () => `6512f0c2a1b2c3d4e5f6${(0xc100 + next++).toString(16)}`;
    const written = { date: '03/01/2027', amount: eur('800.00'), type: 'transfer', reference: 'DE-RPR-x' };
    const confirmedFor = async (tenantId: string, term = '2027010100') => created(match(await transaction(), '800.00', term, tenantId));
    const claimed = async (id: string, leaseMs = 60_000) => {
      const outcome = await repository.claimWriteBack(id, REALM, leaseMs, actor);
      if (outcome.kind !== 'CLAIMED') throw new Error(JSON.stringify(outcome));
      return outcome;
    };
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('claim → PENDING with a lease and the booking date; record WRITTEN under the attempt; a repeat is UNCHANGED; AuditRecords', async () => {
      const r = await confirmedFor(tenant());
      const before = Date.now();
      const claim = await claimed(r.id);
      expect(claim).toMatchObject({ bookingDate: '2027-01-03', reconciliation: { mreWriteBackState: 'PENDING', mreWriteBackAttemptId: claim.attemptId, version: 2 } });
      const lease = claim.reconciliation.mreWriteBackLeaseUntil?.getTime() ?? 0;
      expect(lease).toBeGreaterThanOrEqual(before + 59_000);
      expect(await repository.claimWriteBack(r.id, REALM, 60_000, actor)).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: r.id });
      expect(await repository.recordWriteBack(r.id, REALM, '00000000-0000-4000-8000-000000000000', { kind: 'FAILED', error: 'MRE_UNAVAILABLE' }, actor)).toEqual({ kind: 'LEASE_LOST' });
      const recorded = await repository.recordWriteBack(r.id, REALM, claim.attemptId, { kind: 'WRITTEN', payment: written, patched: true }, actor);
      expect(recorded).toMatchObject({
        kind: 'RECORDED',
        reconciliation: { mreWriteBackState: 'WRITTEN', mreWrittenBackBy: actor.actorId, mrePayment: written, mreWriteBackAttemptId: null, mreWriteBackLeaseUntil: null, version: 3 },
      });
      expect(await repository.claimWriteBack(r.id, REALM, 60_000, actor)).toMatchObject({ kind: 'UNCHANGED', reconciliation: { version: 3 } });
      expect((await repository.findById(r.id, REALM))?.mrePayment?.amount).toEqual(eur('800.00'));
      const audit = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, action`, [r.id]);
      expect(audit.rows.map((a) => a.action)).toEqual(['CONFIRMED', 'WRITE_BACK_STARTED', 'WRITE_BACK_WRITTEN']);
      expect(audit.rows[2].metadata).toMatchObject({ attemptId: claim.attemptId, patched: true, payment: { reference: 'DE-RPR-x', amount: { amount: '800.00', currency: 'EUR' } } });
    });

    it('refusals: unknown or foreign, not CONFIRMED, If-Match; FAILED and NOT_WRITTEN outcomes; a FAILED one is claimed again', async () => {
      const r = await confirmedFor(tenant());
      expect(await repository.claimWriteBack(r.id, OTHER_REALM, 60_000, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.claimWriteBack('x', REALM, 60_000, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.claimWriteBack(r.id, REALM, 60_000, actor, [7])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [7], currentVersion: 1 });
      const first = await claimed(r.id);
      expect(await repository.recordWriteBack(r.id, REALM, first.attemptId, { kind: 'FAILED', error: 'MRE_UNAVAILABLE' }, actor)).toMatchObject({
        reconciliation: { mreWriteBackState: 'FAILED', mreWriteBackError: 'MRE_UNAVAILABLE' },
      });
      const second = await claimed(r.id);
      expect(second.reconciliation).toMatchObject({ mreWriteBackState: 'PENDING', mreWriteBackError: null, mreWriteBackFailedAt: null });
      expect(await repository.recordWriteBack(r.id, REALM, second.attemptId, { kind: 'NOT_WRITTEN' }, actor)).toMatchObject({ reconciliation: { mreWriteBackState: 'NOT_WRITTEN', version: 5 } });
      await repository.release(r.id, REALM, 'x', new Date(), actor);
      expect(await repository.claimWriteBack(r.id, REALM, 60_000, actor)).toEqual({ kind: 'NOT_WRITABLE', status: 'RELEASED' });
    });

    it('takeover after an expired lease: by the same reconciliation (the old attempt records nothing), and by another one of the Tenant (the expired row FAILED, LEASE_EXPIRED)', async () => {
      const t1 = tenant();
      const r = await confirmedFor(t1);
      const old = await claimed(r.id, 1);
      await pause(20);
      const retry = await claimed(r.id);
      expect(retry.attemptId).not.toBe(old.attemptId);
      expect(await repository.recordWriteBack(r.id, REALM, old.attemptId, { kind: 'WRITTEN', payment: written, patched: true }, actor)).toEqual({ kind: 'LEASE_LOST' });
      // A live lease of another reconciliation of the same Tenant refuses; once expired it is failed and taken over.
      const other = await confirmedFor(t1, '2027020100');
      expect(await repository.claimWriteBack(other.id, REALM, 60_000, actor)).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: r.id });
      await repository.recordWriteBack(r.id, REALM, retry.attemptId, { kind: 'FAILED', error: 'MRE_UNAVAILABLE' }, actor);
      const expiring = await claimed(r.id, 1);
      await pause(20);
      const taken = await claimed(other.id);
      expect(taken.reconciliation.mreWriteBackState).toBe('PENDING');
      expect(await repository.findById(r.id, REALM)).toMatchObject({ mreWriteBackState: 'FAILED', mreWriteBackError: 'LEASE_EXPIRED', mreWriteBackAttemptId: null });
      expect(await repository.recordWriteBack(r.id, REALM, expiring.attemptId, { kind: 'WRITTEN', payment: written, patched: true }, actor)).toEqual({ kind: 'LEASE_LOST' });
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'WRITE_BACK_ABANDONED'`, [r.id]);
      expect(audit.rows).toEqual([{ metadata: expect.objectContaining({ attemptId: expiring.attemptId, takenOverBy: other.id }) }]);
      // Other Tenants and Realms are not affected by the Tenant's lease.
      expect((await repository.claimWriteBack((await confirmedFor(tenant())).id, REALM, 60_000, actor)).kind).toBe('CLAIMED');
    });

    it('release (P4-D7): NOT_WRITTEN stays; WRITTEN keeps its payment as REMOVAL_REQUIRED; FAILED and an expired PENDING become REMOVAL_REQUIRED; a live lease refuses', async () => {
      const release = (id: string) => repository.release(id, REALM, 'falscher Monat', new Date(), actor);
      const plain = await confirmedFor(tenant());
      expect(await release(plain.id)).toMatchObject({ reconciliation: { mreWriteBackState: 'NOT_WRITTEN' } });
      const w = await confirmedFor(tenant());
      await repository.recordWriteBack(w.id, REALM, (await claimed(w.id)).attemptId, { kind: 'WRITTEN', payment: written, patched: true }, actor);
      expect(await release(w.id)).toMatchObject({ reconciliation: { status: 'RELEASED', mreWriteBackState: 'REMOVAL_REQUIRED', mrePayment: written } });
      const f = await confirmedFor(tenant());
      await repository.recordWriteBack(f.id, REALM, (await claimed(f.id)).attemptId, { kind: 'FAILED', error: 'MRE_UNAVAILABLE' }, actor);
      expect(await release(f.id)).toMatchObject({ reconciliation: { mreWriteBackState: 'REMOVAL_REQUIRED', mreWriteBackError: null, mrePayment: null } });
      const live = await confirmedFor(tenant());
      await claimed(live.id);
      expect(await release(live.id)).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: live.id });
      const expired = await confirmedFor(tenant());
      await claimed(expired.id, 1);
      await pause(20);
      expect(await release(expired.id)).toMatchObject({ reconciliation: { mreWriteBackState: 'REMOVAL_REQUIRED', mreWriteBackAttemptId: null, mreWriteBackLeaseUntil: null } });
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'RELEASED'`, [w.id]);
      expect(audit.rows[0].metadata.mreWriteBackState).toEqual({ from: 'WRITTEN', to: 'REMOVAL_REQUIRED' });
    });

    const pendingStep = (id: string) =>
      `UPDATE rent_payment_reconciliation SET mre_write_back_state = 'PENDING', mre_write_back_attempt_id = gen_random_uuid(),
         mre_write_back_lease_until = now() + interval '1 hour', mre_last_lease_until = greatest(mre_last_lease_until, now() + interval '1 hour'),
         version = version + 1 WHERE id = '${id}'`;
    const releaseStep = (id: string) =>
      `UPDATE rent_payment_reconciliation SET status = 'RELEASED', released_at = now(), released_by = 'x', release_reason = 'x', version = version + 1 WHERE id = '${id}'`;
    async function heldThen<T>(first: string, second: () => Promise<T>): Promise<T> {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await holder.query(first);
        const waiting = second();
        await waitForLocks(pool);
        await holder.query('COMMIT');
        return await waiting;
      } finally {
        holder.release();
      }
    }
    async function repeatableRead(first: string, second: string): Promise<string | undefined> {
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await two.query(first);
        const later = one.query(second).then(
          () => 'written',
          (error: { code?: string; message?: string }) => error.code ?? error.message,
        );
        await waitForLocks(pool);
        await two.query('COMMIT');
        return await later;
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    }

    it('concurrency (RC): two write-backs of one reconciliation; two of one Tenant (the index); a claim waiting on a release', async () => {
      const r = await confirmedFor(tenant());
      expect(await heldThen(pendingStep(r.id), () => repository.claimWriteBack(r.id, REALM, 60_000, actor))).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: r.id });
      const t2 = tenant();
      const a = await confirmedFor(t2);
      const b = await confirmedFor(t2, '2027020100');
      expect(await heldThen(pendingStep(a.id), () => repository.claimWriteBack(b.id, REALM, 60_000, actor))).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: a.id });
      expect((await repository.findById(b.id, REALM))?.mreWriteBackState).toBe('NOT_WRITTEN');
      const c = await confirmedFor(tenant());
      expect(await heldThen(releaseStep(c.id), () => repository.claimWriteBack(c.id, REALM, 60_000, actor))).toEqual({ kind: 'NOT_WRITABLE', status: 'RELEASED' });
    });

    it('concurrency (RR past the repository): a second claim, and a claim after a release, fail to serialise', async () => {
      const r = await confirmedFor(tenant());
      expect(await repeatableRead(pendingStep(r.id), pendingStep(r.id))).toBe('40001');
      const c = await confirmedFor(tenant());
      expect(await repeatableRead(releaseStep(c.id), pendingStep(c.id))).toBe('40001');
    });

    it('schema (0032): the field sets, the states per status, the steps, the release rule, the Tenant index', async () => {
      const attempt = (query: string) => pool.query(query).then(() => 'accepted', reasonOf);
      const t = tenant();
      const r = await confirmedFor(t);
      const set = (assignment: string, id = r.id) => attempt(`UPDATE rent_payment_reconciliation SET ${assignment} WHERE id = '${id}'`);
      expect(await set(`mre_write_back_state = 'PENDING', version = version + 1`)).toBe('rent_payment_reconciliation_write_back_fields');
      expect(await set(`mre_write_back_state = 'REMOVAL_REQUIRED', version = version + 1`)).toBe('is not a step');
      // The CHECK behind the trigger, in a rolled-back transaction without the frozen trigger.
      const unguarded = async (query: string) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('ALTER TABLE rent_payment_reconciliation DISABLE TRIGGER rent_payment_reconciliation_frozen');
          return await client.query(query).then(() => 'accepted', reasonOf);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };
      expect(await unguarded(`UPDATE rent_payment_reconciliation SET mre_write_back_state = 'REMOVAL_REQUIRED', mre_last_lease_until = now() WHERE id = '${r.id}'`)).toBe(
        'rent_payment_reconciliation_write_back_state',
      );
      expect(
        await unguarded(`UPDATE rent_payment_reconciliation SET status = 'RELEASED', released_at = now(), released_by = 'x', release_reason = 'x', mre_write_back_state = 'FAILED',
          mre_write_back_error = 'MRE_UNAVAILABLE', mre_write_back_failed_at = now(), mre_last_lease_until = now() WHERE id = '${r.id}'`),
      ).toBe('rent_payment_reconciliation_write_back_state');
      expect(await unguarded(`UPDATE rent_payment_reconciliation SET mre_written_back_at = now() WHERE id = '${r.id}'`)).toBe('rent_payment_reconciliation_write_back_fields');
      // WRITTEN with a time and actor but without the payment snapshot.
      expect(await unguarded(`UPDATE rent_payment_reconciliation SET mre_write_back_state = 'WRITTEN', mre_written_back_at = now(), mre_written_back_by = 'x' WHERE id = '${r.id}'`)).toBe(
        'rent_payment_reconciliation_write_back_fields',
      );
      expect(
        await unguarded(`UPDATE rent_payment_reconciliation SET mre_write_back_state = 'FAILED', mre_write_back_error = 'GUESS', mre_write_back_failed_at = now() WHERE id = '${r.id}'`),
      ).toBe('rent_payment_reconciliation_mre_write_back_error_check');
      expect(await set(`mre_write_back_state = 'WRITTEN', mre_written_back_at = now(), mre_written_back_by = 'x', mre_payment = '{}', version = version + 1`)).toBe('is not a step');
      expect(await set(`mre_write_back_state = 'FAILED', mre_write_back_error = 'MRE_UNAVAILABLE', mre_write_back_failed_at = now(), version = version + 1`)).toBe('is not a step');
      expect(await set(pendingStep(r.id).replace(/^UPDATE rent_payment_reconciliation SET /, '').replace(/ WHERE id = .*$/s, '').replace('version = version + 1', 'version = version'))).toBe('is not a step');
      expect(await set(`${pendingStep(r.id).replace(/^UPDATE rent_payment_reconciliation SET /, '').replace(/ WHERE id = .*$/s, '')}, confirmed_by = 'y'`)).toBe('is not a step');
      expect(await attempt(pendingStep(r.id))).toBe('accepted');
      // A live lease: no second PENDING step on the row, no release, no second PENDING of the Tenant.
      expect(await attempt(pendingStep(r.id))).toBe('is not a step');
      expect(await attempt(releaseStep(r.id))).toBe('(WRITE_BACK_IN_PROGRESS)');
      const other = await confirmedFor(t, '2027020100');
      expect(await attempt(pendingStep(other.id))).toBe('rent_payment_reconciliation_write_back_tenant_key');
      expect(
        await set(
          `mre_write_back_state = 'WRITTEN', mre_write_back_attempt_id = NULL, mre_write_back_lease_until = NULL, mre_written_back_at = now(), mre_written_back_by = 'x', mre_payment = '{}', version = version + 1`,
        ),
      ).toBe('accepted');
      expect(await attempt(pendingStep(r.id))).toBe('is not a step');
      // The release must carry the state to REMOVAL_REQUIRED, and keep the snapshot.
      expect(await attempt(releaseStep(r.id))).toBe('released with write-back');
      expect(await attempt(releaseStep(r.id).replace('version = version + 1', `mre_write_back_state = 'REMOVAL_REQUIRED', mre_payment = NULL, mre_written_back_at = NULL, mre_written_back_by = NULL, version = version + 1`))).toBe('released with write-back');
      expect(await attempt(releaseStep(r.id).replace('version = version + 1', `mre_write_back_state = 'REMOVAL_REQUIRED', version = version + 1`))).toBe('accepted');
      // Other status steps keep NOT_WRITTEN; a row is born NOT_WRITTEN.
      const s = (await pool.query(`${rawInsert(await transaction(), '800.00', '2027030100', 'SUGGESTED').replace(`'${TENANT}'`, `'${tenant()}'`)} RETURNING id`)).rows[0].id as string;
      expect(await attempt(`UPDATE rent_payment_reconciliation SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', mre_write_back_state = 'REMOVAL_REQUIRED', version = version + 1 WHERE id = '${s}'`)).toBe(
        'with write-back REMOVAL_REQUIRED',
      );
    });
  });

  describe('removal from MRE (§37.5)', () => {
    let next = 0;
    const tenant = () => `6512f0c2a1b2c3d4e5f6${(0xd100 + next++).toString(16)}`;
    const written = { date: '03/01/2027', amount: eur('800.00'), type: 'transfer', reference: 'DE-RPR-x' };
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const confirmedFor = async (tenantId: string, term = '2027010100') => created(match(await transaction(), '800.00', term, tenantId));
    /** Written back under a lease of `leaseMs` (its end is the last lease), then released: REMOVAL_REQUIRED. */
    const releasedWritten = async (tenantId: string, leaseMs = 1, term = '2027010100') => {
      const r = await confirmedFor(tenantId, term);
      const claim = await repository.claimWriteBack(r.id, REALM, leaseMs, actor);
      if (claim.kind !== 'CLAIMED') throw new Error(claim.kind);
      await repository.recordWriteBack(r.id, REALM, claim.attemptId, { kind: 'WRITTEN', payment: written, patched: true }, actor);
      const released = await repository.release(r.id, REALM, 'falscher Monat', new Date(), actor);
      if (released.kind !== 'RELEASED') throw new Error(released.kind);
      return released.reconciliation;
    };
    const removing = async (id: string, leaseMs = 60_000) => {
      const outcome = await repository.claimRemoval(id, REALM, leaseMs, 0, actor);
      if (outcome.kind !== 'CLAIMED') throw new Error(JSON.stringify(outcome));
      return outcome;
    };

    it('claim → REMOVING; record REMOVED with its actor and time, the payment snapshot and the last lease kept; a repeat is UNCHANGED; AuditRecords', async () => {
      const r = await releasedWritten(tenant());
      const lastLease = r.mreLastLeaseUntil;
      expect(lastLease).not.toBeNull();
      const claim = await removing(r.id);
      expect(claim).toMatchObject({ bookingDate: '2027-01-03', reconciliation: { mreWriteBackState: 'REMOVING', mreWriteBackAttemptId: claim.attemptId } });
      expect(claim.reconciliation.mreLastLeaseUntil).toEqual(claim.reconciliation.mreWriteBackLeaseUntil);
      expect(await repository.recordRemoval(r.id, REALM, '00000000-0000-4000-8000-000000000000', { kind: 'REMOVED', patched: true }, actor)).toEqual({ kind: 'LEASE_LOST' });
      const done = await repository.recordRemoval(r.id, REALM, claim.attemptId, { kind: 'REMOVED', patched: true }, actor);
      expect(done).toMatchObject({
        kind: 'RECORDED',
        reconciliation: { status: 'RELEASED', mreWriteBackState: 'REMOVED', mreRemovedBy: actor.actorId, mrePayment: written, mreWriteBackAttemptId: null, mreWriteBackLeaseUntil: null },
      });
      if (done.kind !== 'RECORDED') throw new Error(done.kind);
      expect(done.reconciliation.mreLastLeaseUntil).toEqual(claim.reconciliation.mreLastLeaseUntil);
      expect(await repository.claimRemoval(r.id, REALM, 60_000, 0, actor)).toMatchObject({ kind: 'UNCHANGED' });
      const audit = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 AND action IN ('REMOVAL_STARTED', 'REMOVED') ORDER BY occurred_at`, [r.id]);
      expect(audit.rows.map((a) => a.action)).toEqual(['REMOVAL_STARTED', 'REMOVED']);
      expect(audit.rows[1].metadata).toMatchObject({ attemptId: claim.attemptId, patched: true });
    });

    it('refusals: unknown or foreign, CONFIRMED, NOT_WRITTEN, too early, If-Match; REMOVAL_FAILED claimed again; NOT_REMOVED back to REMOVAL_REQUIRED', async () => {
      const r = await releasedWritten(tenant());
      expect(await repository.claimRemoval(r.id, OTHER_REALM, 60_000, 0, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.claimRemoval((await confirmedFor(tenant())).id, REALM, 60_000, 0, actor)).toEqual({ kind: 'NOT_REMOVABLE', status: 'CONFIRMED', mreWriteBackState: 'NOT_WRITTEN' });
      const plain = await confirmedFor(tenant());
      await repository.release(plain.id, REALM, 'x', new Date(), actor);
      expect(await repository.claimRemoval(plain.id, REALM, 60_000, 0, actor)).toEqual({ kind: 'NOT_REMOVABLE', status: 'RELEASED', mreWriteBackState: 'NOT_WRITTEN' });
      expect(await repository.claimRemoval(r.id, REALM, 60_000, 0, actor, [1])).toMatchObject({ kind: 'VERSION_CONFLICT' });
      // The margin past the last lease (review on #82).
      const tooEarly = await repository.claimRemoval(r.id, REALM, 60_000, 3_600_000, actor);
      expect(tooEarly).toEqual({ kind: 'REMOVAL_TOO_EARLY', notBefore: new Date((r.mreLastLeaseUntil?.getTime() ?? 0) + 3_600_000) });
      const first = await removing(r.id);
      expect(await repository.recordRemoval(r.id, REALM, first.attemptId, { kind: 'FAILED', error: 'MRE_UNAVAILABLE' }, actor)).toMatchObject({
        reconciliation: { mreWriteBackState: 'REMOVAL_FAILED', mreWriteBackError: 'MRE_UNAVAILABLE' },
      });
      // The second claim waits for the first removal's lease: its last lease end is now an hour ahead.
      expect((await repository.claimRemoval(r.id, REALM, 60_000, 0, actor)).kind).toBe('REMOVAL_TOO_EARLY');
      const r2 = await releasedWritten(tenant());
      const shortClaim = await removing(r2.id, 1);
      await repository.recordRemoval(r2.id, REALM, shortClaim.attemptId, { kind: 'FAILED', error: 'MRE_UNAVAILABLE' }, actor);
      await pause(10);
      const again = await removing(r2.id, 1);
      expect(again.reconciliation).toMatchObject({ mreWriteBackState: 'REMOVING', mreWriteBackError: null });
      expect(await repository.recordRemoval(r2.id, REALM, again.attemptId, { kind: 'NOT_REMOVED' }, actor)).toMatchObject({ reconciliation: { mreWriteBackState: 'REMOVAL_REQUIRED' } });
    });

    it('takeovers: its own expired REMOVING; another removal of the Tenant fails it (REMOVAL_FAILED); a write-back of the Tenant fails it too (review on #84); a live one blocks both', async () => {
      const t = tenant();
      const r = await releasedWritten(t);
      const old = await removing(r.id, 1);
      await pause(20);
      const retry = await removing(r.id, 1);
      expect(retry.attemptId).not.toBe(old.attemptId);
      expect(await repository.recordRemoval(r.id, REALM, old.attemptId, { kind: 'REMOVED', patched: true }, actor)).toEqual({ kind: 'LEASE_LOST' });
      await pause(20);
      // A write-back of another reconciliation of the Tenant: the expired removal is failed in its claim.
      const other = await confirmedFor(t, '2027020100');
      const wb = await repository.claimWriteBack(other.id, REALM, 60_000, actor);
      expect(wb.kind).toBe('CLAIMED');
      expect(await repository.findById(r.id, REALM)).toMatchObject({ mreWriteBackState: 'REMOVAL_FAILED', mreWriteBackError: 'LEASE_EXPIRED', mreWriteBackAttemptId: null });
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'WRITE_BACK_ABANDONED'`, [r.id]);
      expect(audit.rows).toEqual([{ metadata: expect.objectContaining({ attemptId: retry.attemptId, takenOverBy: other.id, from: 'REMOVING' }) }]);
      // That write-back's live lease blocks a removal of the Tenant, and the reverse.
      expect(await repository.claimRemoval(r.id, REALM, 60_000, 0, actor)).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: other.id });
      const t2 = tenant();
      const live = await releasedWritten(t2);
      await removing(live.id);
      const blocked = await confirmedFor(t2, '2027030100');
      expect(await repository.claimWriteBack(blocked.id, REALM, 60_000, actor)).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: live.id });
      // Another removal of the Tenant fails an expired REMOVING.
      const t3 = tenant();
      const a = await releasedWritten(t3);
      const b = await releasedWritten(t3, 1, '2027020100');
      await removing(a.id, 1);
      await pause(20);
      expect((await removing(b.id)).reconciliation.mreWriteBackState).toBe('REMOVING');
      expect(await repository.findById(a.id, REALM)).toMatchObject({ mreWriteBackState: 'REMOVAL_FAILED', mreWriteBackError: 'LEASE_EXPIRED' });
    });

    it('release on the database clock (review on #83): an application clock running ahead does not turn a live lease into a 500', async () => {
      const r = await confirmedFor(tenant());
      await repository.claimWriteBack(r.id, REALM, 60_000, actor);
      const ahead = new Date(Date.now() + 3_600_000);
      expect(await repository.release(r.id, REALM, 'x', ahead, actor)).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: r.id });
    });

    it('schema (0033): the removal steps, the last lease end, the removed fields, the states per status, the Tenant index over REMOVING', async () => {
      const attempt = (query: string) => pool.query(query).then(() => 'accepted', reasonOf);
      const t = tenant();
      const r = await releasedWritten(t, 60_000);
      const set = (assignment: string, id = r.id) => attempt(`UPDATE rent_payment_reconciliation SET ${assignment} WHERE id = '${id}'`);
      const removingStep = `mre_write_back_state = 'REMOVING', mre_write_back_attempt_id = gen_random_uuid(), mre_write_back_lease_until = now() + interval '1 hour',
        mre_last_lease_until = greatest(mre_last_lease_until, now() + interval '1 hour'), version = version + 1`;
      // Before the last lease end the database refuses the claim.
      expect(await set(removingStep)).toBe('is not a step');
      expect(await set(`mre_last_lease_until = now() - interval '1 second', version = version + 1`)).toBe('mre_last_lease_until changed outside a claim');
      const p = await releasedWritten(t, 1, '2027020100');
      const q = await releasedWritten(t, 1, '2027030100');
      expect(await set(removingStep.replace("mre_last_lease_until = greatest(mre_last_lease_until, now() + interval '1 hour')", 'mre_last_lease_until = now()'), p.id)).toBe(
        'a claim sets mre_last_lease_until to the latest lease',
      );
      expect(await set(`${removingStep}, mre_payment = NULL, mre_written_back_at = NULL, mre_written_back_by = NULL`, p.id)).toBe('is not a step');
      expect(await set(removingStep, p.id)).toBe('accepted');
      // A second REMOVING of the Tenant: the index.
      expect(await set(removingStep, q.id)).toBe('rent_payment_reconciliation_write_back_tenant_key');
      expect(await set(`mre_write_back_state = 'REMOVED', mre_write_back_attempt_id = NULL, mre_write_back_lease_until = NULL, version = version + 1`, p.id)).toBe(
        'rent_payment_reconciliation_write_back_fields',
      );
      expect(await set(`mre_write_back_state = 'WRITTEN', mre_write_back_attempt_id = NULL, mre_write_back_lease_until = NULL, version = version + 1`, p.id)).toBe('is not a step');
      expect(
        await set(`mre_write_back_state = 'REMOVED', mre_removed_at = now(), mre_removed_by = 'x', mre_write_back_attempt_id = NULL, mre_write_back_lease_until = NULL, version = version + 1`, p.id),
      ).toBe('accepted');
      expect(await set(removingStep, p.id)).toBe('is not a step');
      // REMOVING on a CONFIRMED row: not a step.
      const c = await confirmedFor(tenant());
      expect(await set(removingStep, c.id)).toBe('is not a step');
      // Past the trigger: a REMOVAL_REQUIRED without its last lease end, and REMOVING on a CONFIRMED row (review on #84).
      const unguarded = async (query: string) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('ALTER TABLE rent_payment_reconciliation DISABLE TRIGGER rent_payment_reconciliation_frozen');
          return await client.query(query).then(() => 'accepted', reasonOf);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };
      expect(await unguarded(`UPDATE rent_payment_reconciliation SET mre_last_lease_until = NULL WHERE id = '${r.id}'`)).toBe('rent_payment_reconciliation_write_back_fields');
      expect(
        await unguarded(`UPDATE rent_payment_reconciliation SET mre_write_back_state = 'REMOVING', mre_write_back_attempt_id = gen_random_uuid(), mre_write_back_lease_until = now(),
          mre_last_lease_until = now() WHERE id = '${c.id}'`),
      ).toBe('rent_payment_reconciliation_write_back_state');
    });

    it('concurrency: a removal waiting on a write-back of the same Tenant (RC, the index); two removals of one reconciliation (RR past the repository: 40001)', async () => {
      const t = tenant();
      const wb = await confirmedFor(t);
      const r = await releasedWritten(t, 1, '2027020100');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `UPDATE rent_payment_reconciliation SET mre_write_back_state = 'PENDING', mre_write_back_attempt_id = gen_random_uuid(), mre_write_back_lease_until = now() + interval '1 hour',
             mre_last_lease_until = greatest(mre_last_lease_until, now() + interval '1 hour'), version = version + 1 WHERE id = '${wb.id}'`,
        );
        const removal = repository.claimRemoval(r.id, REALM, 60_000, 0, actor);
        await waitForLocks(pool);
        await holder.query('COMMIT');
        expect(await removal).toEqual({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: wb.id });
      } finally {
        holder.release();
      }
      const s2 = await releasedWritten(tenant());
      const step = `UPDATE rent_payment_reconciliation SET mre_write_back_state = 'REMOVING', mre_write_back_attempt_id = gen_random_uuid(),
        mre_write_back_lease_until = now() + interval '1 hour', mre_last_lease_until = greatest(mre_last_lease_until, now() + interval '1 hour'), version = version + 1 WHERE id = '${s2.id}'`;
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await two.query(step);
        const later = one.query(step).then(() => 'written', (e: { code?: string }) => e.code);
        await waitForLocks(pool);
        await two.query('COMMIT');
        expect(await later).toBe('40001');
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    });
  });

  describe('corrections of a matched Transaction (P4-D7)', () => {
    it('correct and reverse are refused while CONFIRMED, allowed after release; the trigger refuses past the repository', async () => {
      const t = await transaction();
      const r = await created(match(t));
      expect(await corrections.correct(t, REALM, { reason: 'x', replacement: { description: 'neu' } }, actor)).toEqual({ kind: 'TRANSACTION_RENT_RECONCILED', reconciliationIds: [r.id] });
      expect(await corrections.correct(t, REALM, { reason: 'x', replacement: null }, actor)).toEqual({ kind: 'TRANSACTION_RENT_RECONCILED', reconciliationIds: [r.id] });
      const raw = `UPDATE ledger_transaction SET status = 'CORRECTED', version = version + 1 WHERE id = '${t}'`;
      expect(await pool.query(raw).then(() => 'accepted', reasonOf)).toBe('(TRANSACTION_RENT_RECONCILED)');
      await repository.release(r.id, REALM, 'Korrektur folgt', new Date(), actor);
      expect((await corrections.correct(t, REALM, { reason: 'x', replacement: null }, actor)).kind).toBe('CORRECTED');
    });
  });

  describe('concurrency (P4-D8)', () => {
    /** Two raw writes in two connections, the second under REPEATABLE READ with a snapshot taken first. */
    async function repeatableRead(first: string, second: string): Promise<string | undefined> {
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await two.query(first);
        const later = one.query(second).then(
          () => 'written',
          (error: { code?: string; message?: string }) => error.code ?? error.message,
        );
        await waitForLocks(pool);
        await two.query('COMMIT');
        return await later;
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    }
    /** `first` held in an open transaction while `second` runs and waits, then committed. */
    async function heldThen<T>(first: string, second: () => Promise<T>): Promise<T> {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await holder.query(first);
        const waiting = second();
        await waitForLocks(pool);
        await holder.query('COMMIT');
        return await waiting;
      } finally {
        holder.release();
      }
    }

    it('READ COMMITTED, two creates on one Transaction exceeding its rent cash: the second sees the first', async () => {
      const t = await transaction();
      expect(await heldThen(rawInsert(t, '500.00'), () => repository.create(match(t, '400.00', '2027020100'), actor))).toEqual({
        kind: 'RENT_CASH_EXCEEDED',
        rentCash: eur('800.00'),
        available: eur('300.00'),
      });
    });

    it('READ COMMITTED, the same match twice: the second is ALREADY_MATCHED', async () => {
      const t = await transaction();
      const outcome = await heldThen(rawInsert(t, '100.00'), () => repository.create(match(t, '100.00'), actor));
      expect(outcome.kind).toBe('ALREADY_MATCHED');
    });

    it('REPEATABLE READ past the repository, two creates exceeding the rent cash: the later one fails to serialise', async () => {
      const t = await transaction();
      expect(await repeatableRead(rawInsert(t, '500.00'), rawInsert(t, '400.00', '2027020100'))).toBe('40001');
    });

    it('create against a reversal, both orders (READ COMMITTED): the second sees the first', async () => {
      const a = await transaction();
      expect(await heldThen(rawInsert(a, '800.00'), () => corrections.correct(a, REALM, { reason: 'x', replacement: null }, actor))).toMatchObject({
        kind: 'TRANSACTION_RENT_RECONCILED',
      });
      // The reversal queues first behind a held lock on the Transaction, then the create; the reversal wins.
      const b = await transaction();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM ledger_transaction WHERE id = $1 FOR UPDATE`, [b]);
        const reversing = corrections.correct(b, REALM, { reason: 'x', replacement: null }, actor);
        await waitForLocks(pool, 1);
        const creating = repository.create(match(b), actor);
        await waitForLocks(pool, 2);
        await holder.query('ROLLBACK');
        expect((await reversing).kind).toBe('CORRECTED');
        expect(await creating).toEqual({ kind: 'TRANSACTION_NOT_COUNTED', status: 'CORRECTED', correctionRole: null });
      } finally {
        holder.release();
      }
    });

    it('REPEATABLE READ past the repository, a create against the step to CORRECTED: the later one fails to serialise', async () => {
      const t = await transaction();
      expect(await repeatableRead(rawInsert(t, '800.00'), `UPDATE ledger_transaction SET status = 'CORRECTED', version = version + 1 WHERE id = '${t}'`)).toBe('40001');
    });

    it('READ COMMITTED, a release lets a waiting create use the cash', async () => {
      const t = await transaction();
      const r = await created(match(t));
      const release = `UPDATE rent_payment_reconciliation SET status = 'RELEASED', released_at = now(), released_by = 'x', release_reason = 'x', version = version + 1 WHERE id = '${r.id}'`;
      const holder = await pool.connect();
      try {
        // As the repository does: the Transaction row first, then the release.
        await holder.query('BEGIN');
        await holder.query(`UPDATE ledger_transaction SET version = version WHERE id = $1`, [t]);
        await holder.query(release);
        const creating = repository.create(match(t, '800.00', '2027020100'), actor);
        await waitForLocks(pool);
        await holder.query('COMMIT');
        expect((await creating).kind).toBe('CREATED');
      } finally {
        holder.release();
      }
    });
  });

  describe('schema past the repository (migration 0030)', () => {
    const attempt = (query: string) => pool.query(query).then(() => 'accepted', reasonOf);

    it('the cash guard: not counted, not INFLOW, no rent cash, exceeded; the unique index', async () => {
      expect(await attempt(rawInsert(await transaction([split('800.00')], { confirm: false }), '1.00'))).toBe('(TRANSACTION_NOT_COUNTED)');
      expect(await attempt(rawInsert(await transaction([split('800.00')], { direction: 'OUTFLOW' }), '1.00'))).toBe('(TRANSACTION_NOT_INFLOW)');
      expect(await attempt(rawInsert(await transaction([split('800.00', 'INSURANCE')]), '1.00'))).toBe('(NO_RENT_CASH)');
      // A reversal is CONFIRMED but never counts; its mirrored rent split does not make it rent cash.
      const reversed = await corrections.correct(await transaction(), REALM, { reason: 'Doppelt', replacement: null }, actor);
      if (reversed.kind !== 'CORRECTED') throw new Error(reversed.kind);
      expect(await attempt(rawInsert(reversed.result.reversal.id, '1.00'))).toBe('(TRANSACTION_NOT_COUNTED)');
      const t = await transaction();
      expect(await attempt(rawInsert(t, '800.01'))).toBe('(RENT_CASH_EXCEEDED)');
      expect(await attempt(rawInsert(t, '100.00'))).toBe('accepted');
      expect(await attempt(rawInsert(t, '100.00'))).toBe('rent_payment_reconciliation_confirmed_key');
      // A SUGGESTED row is not checked until it is confirmed, and then it is.
      const { rows } = await pool.query(`${rawInsert(t, '800.00', '2027020100', 'SUGGESTED')} RETURNING id`);
      expect(await attempt(`UPDATE rent_payment_reconciliation SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', version = version + 1 WHERE id = '${rows[0].id}'`)).toBe(
        '(RENT_CASH_EXCEEDED)',
      );
    });

    it('CHECKs: term and tenant form, amount > 0, the status fields', async () => {
      const t = await transaction();
      expect(await attempt(rawInsert(t, '0.00'))).toBe('rent_payment_reconciliation_matched_amount_check');
      expect(await attempt(rawInsert(t, '1.00', '202701'))).toBe('rent_payment_reconciliation_mre_rent_term_check');
      expect(await attempt(rawInsert(t, '1.00').replace(TENANT, 'not-a-tenant'))).toBe('rent_payment_reconciliation_mre_tenant_id_check');
      expect(await attempt(rawInsert(t, '1.00', '2027010100', 'SUGGESTED').replace(`'EXACT_AMOUNT', NULL, NULL`, `'EXACT_AMOUNT', now(), 'x'`))).toBe('rent_payment_reconciliation_confirmed_fields');
      // A release without its fields is a valid step, so the CHECK decides.
      const { rows } = await pool.query(`${rawInsert(t, '1.00', '2027040100')} RETURNING id`);
      expect(await attempt(`UPDATE rent_payment_reconciliation SET status = 'RELEASED', version = version + 1 WHERE id = '${rows[0].id}'`)).toBe(
        'rent_payment_reconciliation_released_fields',
      );
      expect(await attempt(rawInsert(t, '1.00').replace("'EUR'", "'USD'"))).toBe('rent_payment_reconciliation_currency_check');
    });

    it('born only SUGGESTED or CONFIRMED with version 1: RELEASED, REJECTED or another version refused at the insert (review on #77)', async () => {
      const t = await transaction();
      const born = 'only inserted SUGGESTED or CONFIRMED with version 1';
      // RELEASED with every release field and an amount above the rent cash: never passes the cash guard.
      const released = rawInsert(t, '900.00', '2027010100', 'CONFIRMED')
        .replace('confirmed_by, created_by)', 'confirmed_by, created_by, released_at, released_by, release_reason)')
        .replace(`'CONFIRMED'`, `'RELEASED'`)
        .replace(`'x', 'x')`, `'x', 'x', now(), 'x', 'x')`);
      expect(await attempt(released)).toBe(born);
      expect(await attempt(rawInsert(t, '5000.00', '2027020100', 'SUGGESTED').replace(`'SUGGESTED'`, `'REJECTED'`))).toBe(born);
      expect(await attempt(rawInsert(t, '1.00', '2027030100').replace('confirmed_by, created_by)', 'confirmed_by, created_by, version)').replace(`'x', 'x')`, `'x', 'x', 7)`))).toBe(born);
      expect((await pool.query(`SELECT count(*)::int AS n FROM rent_payment_reconciliation WHERE transaction_id = $1`, [t])).rows[0].n).toBe(0);
    });

    it('fixed fields, status steps with version + 1, never deleted', async () => {
      const t = await transaction();
      const r = await created(match(t, '100.00'));
      const set = (assignment: string) => attempt(`UPDATE rent_payment_reconciliation SET ${assignment} WHERE id = '${r.id}'`);
      expect(await set(`matched_amount = 99`)).toBe('only lowered when a suggestion is confirmed');
      expect(await set(`mre_rent_term = '2027020100'`)).toBe('fixed after creation');
      expect(await set(`transaction_id = '${await transaction()}'`)).toBe('fixed after creation');
      expect(await set(`status = 'REJECTED', version = version + 1`)).toBe('is not a step');
      expect(await set(`status = 'RELEASED', released_at = now(), released_by = 'x', release_reason = 'x'`)).toBe('is not a step');
      expect(await set(`version = version`)).toBe('accepted');
      expect(await set(`status = 'RELEASED', released_at = now(), released_by = 'x', release_reason = 'x', version = version + 1`)).toBe('accepted');
      expect(await set(`status = 'CONFIRMED', released_at = NULL, released_by = NULL, release_reason = NULL, version = version + 1`)).toBe('is not a step');
      expect(await attempt(`DELETE FROM rent_payment_reconciliation WHERE id = '${r.id}'`)).toBe('never deleted');
      // Born NOT_WRITTEN (0032): a write-back state is reached only by its steps (api-design §37.4).
      const born = (state: string) =>
        attempt(rawInsert(t, '1.00', '2027020100').replace('confirmed_by, created_by)', 'confirmed_by, created_by, mre_write_back_state)').replace(`'x', 'x')`, `'x', 'x', '${state}')`));
      expect(await born('WRITTEN')).toBe('only inserted NOT_WRITTEN');
      expect(await born('BOGUS')).toBe('only inserted NOT_WRITTEN');
    });
  });
});
