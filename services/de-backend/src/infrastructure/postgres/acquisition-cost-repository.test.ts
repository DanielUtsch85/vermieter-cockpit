import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { costFingerprint, paymentFingerprint, type NewAcquisition, type NewAcquisitionCost, type NewAcquisitionPayment } from '../../domains/acquisition/index.js';
import type { SplitInput } from '../../domains/ledger/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionCostRepository } from './acquisition-cost-repository.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-2-06 persistence (api-design.md §27.2): costs and their void, payment links and their unlink, the derived paid
 * state, what a ledger correction or a cancel does to it, the schema's guards past the repository, and the
 * serialisation on the Acquisition and the Transaction rows (READ COMMITTED and REPEATABLE READ).
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;
const AT = new Date('2026-10-01T10:00:00Z');
let counter = 0;

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresAcquisitionCostRepository', () => {
  const schema = testSchemaName('acquisition_cost_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let acquisitions: PostgresAcquisitionRepository;
  let costs: PostgresAcquisitionCostRepository;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let corrections: PostgresCorrectionRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    acquisitions = new PostgresAcquisitionRepository(db);
    costs = new PostgresAcquisitionCostRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    corrections = new PostgresCorrectionRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function party(name: string, realm = REALM): Promise<string> {
    const outcome = await parties.create(
      { mreRealmId: realm, partyType: 'PERSON', displayName: name, firstName: null, lastName: null, legalName: null, registrationNumber: null, email: null, phone: null },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party.id;
  }
  /** A DRAFT of 300000.00 by a fresh buyer, on a fresh PropertyReference. */
  async function acquisition(realm = REALM, overrides: Partial<NewAcquisition> = {}): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f90000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    const outcome = await acquisitions.create(
      {
        mreRealmId: realm,
        propertyReferenceId: rows[0].id as string,
        purchasePrice: eur('300000.00'),
        acquiredShare: { numerator: 1, denominator: 1 },
        contractDate: day('2026-06-15'),
        economicTransferDate: null,
        landRegistryTransferDate: null,
        buyerPartyIds: [await party('Käufer', realm)],
        sellerPartyIds: [],
        sourceReferences: [],
        notes: null,
        ...overrides,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.acquisition.id;
  }
  /** A confirmed Transaction, booked on `ACQUISITION` (split categories are not checked, §27.2). */
  async function transaction(amount: string, options: { realm?: string; direction?: 'OUTFLOW' | 'INFLOW'; confirm?: boolean } = {}): Promise<string> {
    const realm = options.realm ?? REALM;
    const account = await accounts.create({ mreRealmId: realm, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const created = await transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: account.account.id,
        amount: eur(amount),
        direction: options.direction ?? 'OUTFLOW',
        bookingDate: day('2026-08-01'),
        valueDate: null,
        description: 'Kaufpreis',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const id = created.transaction.id;
    const split: SplitInput = { amount: eur(amount), financialCategoryCode: 'ACQUISITION', propertyReferenceId: null, description: null };
    const replaced = await splits.replaceSplits(id, realm, [split], actor);
    if (replaced.kind !== 'REPLACED') throw new Error(replaced.kind);
    if (options.confirm === false) return id;
    const confirmed = await transactions.confirm(id, realm, actor);
    if (confirmed.kind !== 'CONFIRMED') throw new Error(confirmed.kind);
    return id;
  }
  const newCost = (acquisitionId: string, amount: string, overrides: Partial<NewAcquisitionCost> = {}): NewAcquisitionCost => ({
    mreRealmId: REALM,
    acquisitionId,
    category: 'NOTARY',
    amount: eur(amount),
    incurredDate: null,
    counterpartyPartyId: null,
    sourceReferences: [],
    notes: null,
    ...overrides,
  });
  async function cost(acquisitionId: string, amount: string, overrides: Partial<NewAcquisitionCost> = {}): Promise<string> {
    const outcome = await costs.createCost(newCost(acquisitionId, amount, overrides), actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.cost.id;
  }
  const newPayment = (acquisitionId: string, transactionId: string, amount: string, acquisitionCostId: string | null = null): NewAcquisitionPayment => ({
    mreRealmId: REALM,
    acquisitionId,
    transactionId,
    acquisitionCostId,
    amount: eur(amount),
  });
  async function link(acquisitionId: string, transactionId: string, amount: string, acquisitionCostId: string | null = null): Promise<string> {
    const outcome = await costs.linkPayment(newPayment(acquisitionId, transactionId, amount, acquisitionCostId), actor);
    if (outcome.kind !== 'LINKED') throw new Error(JSON.stringify(outcome));
    return outcome.payment.id;
  }
  async function costOf(acquisitionId: string, costId: string) {
    return (await costs.listCosts(acquisitionId, REALM, {}))?.find((c) => c.id === costId);
  }
  const insertPayment = (client: pg.Pool | pg.PoolClient, acquisitionId: string, transactionId: string, amount: string, costId: string | null = null) =>
    client.query(
      `INSERT INTO acquisition_payment (mre_realm_id, acquisition_id, acquisition_cost_id, transaction_id, amount, currency, created_by)
       VALUES ($1, $2, $3, $4, $5, 'EUR', 'x')`,
      [REALM, acquisitionId, costId, transactionId, amount],
    );
  const rawCancel = (client: pg.Pool | pg.PoolClient, acquisitionId: string) =>
    client.query(`UPDATE acquisition SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'x', version = version + 1 WHERE id = $1`, [acquisitionId]);
  const rawVoid = (client: pg.Pool | pg.PoolClient, costId: string) =>
    client.query(`UPDATE acquisition_cost SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [costId]);
  /** Waits until a session waits for a lock in a statement mentioning `text`. */
  const waitForLock = (text: string, sessions = 1) =>
    waitUntil(async () =>
      Number(
        (
          await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [
            `%${text}%`,
          ])
        ).rows[0].count,
      ) >= sessions,
    );
  /** Runs `hold` in an open transaction, starts `waiter`, waits until it waits on `lockText`, then commits. */
  async function whileHeld<T>(hold: (client: pg.PoolClient) => Promise<unknown>, waiter: () => Promise<T>, lockText: string): Promise<T> {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await hold(holder);
      const waiting = waiter();
      await waitForLock(lockText);
      await holder.query('COMMIT');
      return await waiting;
    } finally {
      holder.release();
    }
  }

  describe('costs', () => {
    it('create: ACTIVE and EXPECTED, with the Realm-scoped counterparty, and an AuditRecord', async () => {
      const a = await acquisition();
      const notary = await party('Notar Müller');
      const outcome = await costs.createCost(newCost(a, '2450.10', { incurredDate: day('2026-06-20'), counterpartyPartyId: notary, notes: 'Beurkundung' }), actor);
      expect(outcome).toMatchObject({
        kind: 'CREATED',
        cost: {
          acquisitionId: a,
          category: 'NOTARY',
          incurredDate: '2026-06-20',
          counterpartyPartyId: notary,
          notes: 'Beurkundung',
          status: 'ACTIVE',
          voidedAt: null,
          paymentStatus: 'EXPECTED',
          version: 1,
        },
      });
      if (outcome.kind !== 'CREATED') return;
      expect(outcome.cost.amount.amount).toBe('2450.10');
      expect(outcome.cost.paidAmount.amount).toBe('0.00');
      expect(
        (await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_type = 'AcquisitionCost' AND entity_id = $1`, [outcome.cost.id])).rows,
      ).toEqual([
        {
          action: 'CREATED',
          metadata: {
            acquisitionId: a,
            category: 'NOTARY',
            amount: { amount: '2450.10', currency: 'EUR' },
            incurredDate: '2026-06-20',
            counterpartyPartyId: notary,
          },
        },
      ]);
    });

    it('create: the order of checks (Acquisition, counterparty, CANCELLED)', async () => {
      const a = await acquisition();
      const foreign = await acquisition(OTHER_REALM);
      const foreignParty = await party('Fremd', OTHER_REALM);
      expect(await costs.createCost(newCost(foreign, '1.00'), actor)).toEqual({ kind: 'ACQUISITION_NOT_FOUND' });
      expect(await costs.createCost(newCost('not-a-uuid', '1.00'), actor)).toEqual({ kind: 'ACQUISITION_NOT_FOUND' });
      expect(await costs.createCost(newCost(a, '1.00', { counterpartyPartyId: foreignParty }), actor)).toEqual({ kind: 'PARTY_NOT_FOUND', partyId: foreignParty });
      await acquisitions.cancel(a, REALM, 'geplatzt', AT, actor);
      expect(await costs.createCost(newCost(a, '1.00', { counterpartyPartyId: foreignParty }), actor)).toEqual({ kind: 'PARTY_NOT_FOUND', partyId: foreignParty });
      expect(await costs.createCost(newCost(a, '1.00'), actor)).toEqual({ kind: 'ACQUISITION_CANCELLED' });
    });

    it('create on a CONFIRMED Acquisition is allowed (invoices come after the transfer, P2-D6)', async () => {
      const a = await acquisition();
      await pool.query(`UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), version = version + 1 WHERE id = $1`, [a]);
      expect(await costs.createCost(newCost(a, '1500.00', { category: 'LAND_REGISTRY' }), actor)).toMatchObject({ kind: 'CREATED' });
    });

    it('create with an Idempotency-Key: a replay answers the recorded cost, another payload is a conflict, a refusal frees the key', async () => {
      const a = await acquisition();
      const request = newCost(a, '800.00');
      const key = { key: 'cost-1', fingerprint: costFingerprint(request) };
      const first = await costs.createCost(request, actor, key);
      expect(first.kind).toBe('CREATED');
      expect(await costs.createCost(request, actor, key)).toEqual({ ...first, kind: 'REPLAYED' });
      expect(await costs.createCost(newCost(a, '801.00'), actor, { key: 'cost-1', fingerprint: costFingerprint(newCost(a, '801.00')) })).toEqual({
        kind: 'IDEMPOTENCY_CONFLICT',
      });
      const missing = newCost(a, '1.00', { counterpartyPartyId: '00000000-0000-4000-8000-000000000001' });
      const missingKey = { key: 'cost-2', fingerprint: costFingerprint(missing) };
      expect((await costs.createCost(missing, actor, missingKey)).kind).toBe('PARTY_NOT_FOUND');
      expect((await pool.query(`SELECT count(*)::int AS n FROM idempotency_key WHERE key = 'cost-2'`)).rows[0].n).toBe(0);
    });

    it('void: refused while payments are linked, a no-op when VOID, version-checked, final', async () => {
      const a = await acquisition();
      const c = await cost(a, '500.00');
      const p = await link(a, await transaction('500.00'), '200.00', c);
      expect(await costs.voidCost(a, c, REALM, 'falsch', AT, actor)).toEqual({ kind: 'COST_HAS_PAYMENTS', paymentIds: [p] });
      expect((await costs.unlinkPayment(a, p, REALM, 'falsch', AT, actor)).kind).toBe('UNLINKED');
      expect(await costs.voidCost(a, c, REALM, 'falsch', AT, actor, [7])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [7], currentVersion: 1 });
      const voided = await costs.voidCost(a, c, REALM, 'falsch', AT, actor, [1]);
      expect(voided).toMatchObject({ kind: 'VOIDED', changed: true, cost: { status: 'VOID', voidedAt: AT, voidReason: 'falsch', paymentStatus: null, version: 2 } });
      expect(await costs.voidCost(a, c, REALM, 'anders', new Date(), actor, [99])).toMatchObject({ kind: 'VOIDED', changed: false, cost: { voidReason: 'falsch' } });
      expect(await costs.voidCost(a, c, OTHER_REALM, 'x', AT, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await costs.voidCost(await acquisition(), c, REALM, 'x', AT, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(
        (await pool.query(`SELECT action, previous_version, new_version FROM audit_record WHERE entity_type = 'AcquisitionCost' AND entity_id = $1 ORDER BY occurred_at`, [c]))
          .rows,
      ).toEqual([
        { action: 'CREATED', previous_version: null, new_version: 1 },
        { action: 'VOIDED', previous_version: 1, new_version: 2 },
      ]);
    });

    it('list: in creation order with the filter; an unknown or foreign Acquisition is undefined', async () => {
      const a = await acquisition();
      const [c1, c2] = [await cost(a, '1.00'), await cost(a, '2.00', { category: 'BROKER' })];
      await costs.voidCost(a, c1, REALM, 'x', AT, actor);
      expect((await costs.listCosts(a, REALM, {}))?.map((c) => c.id)).toEqual([c1, c2]);
      expect((await costs.listCosts(a, REALM, { status: 'ACTIVE' }))?.map((c) => c.id)).toEqual([c2]);
      expect(await costs.listCosts(a, OTHER_REALM, {})).toBeUndefined();
      expect(await costs.listCosts('nope', REALM, {})).toBeUndefined();
    });
  });

  describe('payments', () => {
    it('installments: EXPECTED → PARTIALLY_PAID → PAID, for a cost and for the price, with the summary and the filters', async () => {
      const a = await acquisition();
      const c = await cost(a, '1000.00', { category: 'REAL_ESTATE_TRANSFER_TAX' });
      const t1 = await transaction('600.00');
      const p1 = await link(a, t1, '600.00', c);
      expect(await costOf(a, c)).toMatchObject({ paymentStatus: 'PARTIALLY_PAID' });
      expect((await costOf(a, c))?.paidAmount.amount).toBe('600.00');
      const t2 = await transaction('100400.00');
      // One Transaction pays the rest of the tax and part of the price.
      await link(a, t2, '400.00', c);
      const price = await link(a, t2, '100000.00');
      expect(await costOf(a, c)).toMatchObject({ paymentStatus: 'PAID' });
      const listed = await costs.listPayments(a, REALM, {});
      expect(listed?.purchasePrice.paymentStatus).toBe('PARTIALLY_PAID');
      expect(listed?.purchasePrice.paidAmount.amount).toBe('100000.00');
      expect(listed?.items.map((p) => p.id)).toHaveLength(3);
      expect(listed?.items[0]).toMatchObject({ id: p1, acquisitionCostId: c, transactionId: t1, counting: true, notCountingReason: null, transactionStatus: 'CONFIRMED' });
      expect((await costs.listPayments(a, REALM, { acquisitionCostId: null }))?.items.map((p) => p.id)).toEqual([price]);
      expect((await costs.listPayments(a, REALM, { counting: false }))?.items).toEqual([]);
      expect(await costs.listPayments(a, OTHER_REALM, {})).toBeUndefined();
    });

    it('link: the order of checks after the 404s, and the caps', async () => {
      const a = await acquisition();
      const b = await acquisition();
      const c = await cost(a, '100.00');
      const t = await transaction('150.00');
      expect((await costs.linkPayment(newPayment(a, t, '1.00', await cost(b, '1.00')), actor)).kind).toBe('COST_NOT_FOUND');
      expect((await costs.linkPayment(newPayment(a, await transaction('1.00', { realm: OTHER_REALM }), '1.00'), actor)).kind).toBe('TRANSACTION_NOT_FOUND');
      expect((await costs.linkPayment(newPayment(await acquisition(OTHER_REALM), t, '1.00'), actor)).kind).toBe('ACQUISITION_NOT_FOUND');
      expect(await costs.linkPayment(newPayment(a, await transaction('5.00', { confirm: false }), '1.00'), actor)).toEqual({
        kind: 'TRANSACTION_NOT_CURRENT',
        status: 'CLASSIFIED',
        correctionRole: null,
      });
      expect((await costs.linkPayment(newPayment(a, await transaction('5.00', { direction: 'INFLOW' }), '1.00'), actor)).kind).toBe('NOT_OUTFLOW');
      expect(await costs.linkPayment(newPayment(a, t, '100.01', c), actor)).toMatchObject({ kind: 'PAYMENT_EXCEEDS_COST' });
      await link(b, t, '120.00');
      const exceeded = await costs.linkPayment(newPayment(a, t, '30.01', c), actor);
      expect(exceeded.kind).toBe('PAYMENT_EXCEEDS_TRANSACTION');
      if (exceeded.kind === 'PAYMENT_EXCEEDS_TRANSACTION') {
        expect([exceeded.transactionAmount.amount, exceeded.linkedAmount.amount, exceeded.available.amount]).toEqual(['150.00', '120.00', '30.00']);
      }
      await link(a, t, '30.00', c);
      const price = await costs.linkPayment(newPayment(a, await transaction('400000.00'), '300000.01'), actor);
      expect(price.kind).toBe('PAYMENT_EXCEEDS_PRICE');
      if (price.kind === 'PAYMENT_EXCEEDS_PRICE') expect([price.expected.amount, price.paid.amount, price.remaining.amount]).toEqual(['300000.00', '0.00', '300000.00']);
      await costs.voidCost(b, await cost(b, '1.00'), REALM, 'x', AT, actor);
      const voidCost = (await costs.listCosts(b, REALM, { status: 'VOID' }))?.[0]?.id ?? '';
      expect((await costs.linkPayment(newPayment(b, t, '0.01', voidCost), actor)).kind).toBe('COST_VOID');
    });

    it('link with an Idempotency-Key: a replay answers the recorded payment and links nothing twice', async () => {
      const a = await acquisition();
      const t = await transaction('10.00');
      const request = newPayment(a, t, '10.00');
      const key = { key: 'pay-1', fingerprint: paymentFingerprint(request) };
      const first = await costs.linkPayment(request, actor, key);
      expect(first.kind).toBe('LINKED');
      expect(await costs.linkPayment(request, actor, key)).toEqual({ ...first, kind: 'REPLAYED' });
      expect((await costs.linkPayment(request, actor)).kind).toBe('PAYMENT_EXCEEDS_TRANSACTION');
    });

    it('a ledger correction: the payment stops counting, names the replacement, keeps its share of the original; re-link explicitly', async () => {
      const a = await acquisition();
      const c = await cost(a, '1000.00');
      const t = await transaction('1000.00');
      const p = await link(a, t, '1000.00', c);
      const corrected = await corrections.correct(t, REALM, { reason: 'Verwendungszweck', replacement: { description: 'Notarkosten' } }, actor);
      if (corrected.kind !== 'CORRECTED' || corrected.result.replacement === null) throw new Error(corrected.kind);
      const replacement = corrected.result.replacement.id;
      expect((await costs.listPayments(a, REALM, {}))?.items[0]).toMatchObject({
        id: p,
        counting: false,
        notCountingReason: 'TRANSACTION_CORRECTED',
        transactionStatus: 'CORRECTED',
        replacementTransactionId: replacement,
      });
      expect(await costOf(a, c)).toMatchObject({ paymentStatus: 'EXPECTED' });
      // The original can no longer be linked; the replacement can, and the cost's cap counts only the counting payment.
      expect((await costs.linkPayment(newPayment(a, t, '1.00', c), actor)).kind).toBe('TRANSACTION_NOT_CURRENT');
      expect((await costs.linkPayment(newPayment(a, corrected.result.reversal.id, '1.00', c), actor)).kind).toBe('TRANSACTION_NOT_CURRENT');
      expect((await costs.unlinkPayment(a, p, REALM, 'korrigiert', AT, actor)).kind).toBe('UNLINKED');
      await link(a, replacement, '1000.00', c);
      expect(await costOf(a, c)).toMatchObject({ paymentStatus: 'PAID' });

      const reversed = await transaction('5.00');
      const q = await link(a, reversed, '5.00');
      await corrections.correct(reversed, REALM, { reason: 'Fehlbuchung', replacement: null }, actor);
      expect((await costs.listPayments(a, REALM, {}))?.items.find((x) => x.id === q)).toMatchObject({
        notCountingReason: 'TRANSACTION_CORRECTED',
        replacementTransactionId: null,
      });
    });

    it('unlink: a no-op when unlinked, version-checked, final; the Transaction is free again', async () => {
      const a = await acquisition();
      const t = await transaction('50.00');
      const p = await link(a, t, '50.00');
      expect(await costs.unlinkPayment(a, p, REALM, 'x', AT, actor, [3])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [3], currentVersion: 1 });
      expect(await costs.unlinkPayment(a, p, REALM, 'falsch', AT, actor, [1])).toMatchObject({
        kind: 'UNLINKED',
        changed: true,
        payment: { unlinkedAt: AT, unlinkReason: 'falsch', counting: false, notCountingReason: 'UNLINKED', version: 2 },
      });
      expect(await costs.unlinkPayment(a, p, REALM, 'anders', new Date(), actor, [9])).toMatchObject({ kind: 'UNLINKED', changed: false, payment: { unlinkReason: 'falsch' } });
      expect(await costs.unlinkPayment(await acquisition(), p, REALM, 'x', AT, actor)).toEqual({ kind: 'NOT_FOUND' });
      await link(await acquisition(), t, '50.00');
    });

    it('cancel: nothing counts any more, the Transaction is free, and no cost or payment write is taken', async () => {
      const a = await acquisition();
      const c = await cost(a, '100.00');
      const t = await transaction('100.00');
      const p = await link(a, t, '100.00', c);
      expect((await acquisitions.cancel(a, REALM, 'geplatzt', AT, actor)).kind).toBe('CANCELLED');
      expect(await costOf(a, c)).toMatchObject({ paymentStatus: null });
      expect((await costOf(a, c))?.paidAmount.amount).toBe('0.00');
      const listed = await costs.listPayments(a, REALM, {});
      expect(listed?.purchasePrice).toMatchObject({ paymentStatus: null });
      expect(listed?.items[0]).toMatchObject({ id: p, counting: false, notCountingReason: 'ACQUISITION_CANCELLED' });
      expect(await costs.unlinkPayment(a, p, REALM, 'x', AT, actor)).toEqual({ kind: 'ACQUISITION_CANCELLED' });
      expect(await costs.voidCost(a, c, REALM, 'x', AT, actor)).toEqual({ kind: 'ACQUISITION_CANCELLED' });
      expect((await costs.linkPayment(newPayment(a, await transaction('1.00'), '1.00'), actor)).kind).toBe('ACQUISITION_CANCELLED');
      // The payment of the cancelled purchase no longer holds the Transaction.
      await link(await acquisition(), t, '100.00');
    });
  });

  describe('the database past the repository', () => {
    it('refuses what the repository refuses: CANCELLED, VOID cost, not current, not OUTFLOW, the caps, a void with payments', async () => {
      const a = await acquisition();
      const c = await cost(a, '100.00');
      const t = await transaction('150.00');
      await expect(insertPayment(pool, a, await transaction('1.00', { confirm: false }), '1.00')).rejects.toThrow(/TRANSACTION_NOT_CURRENT/);
      await expect(insertPayment(pool, a, await transaction('1.00', { direction: 'INFLOW' }), '1.00')).rejects.toThrow(/NOT_OUTFLOW/);
      await expect(insertPayment(pool, a, t, '100.01', c)).rejects.toThrow(/PAYMENT_EXCEEDS_COST/);
      await expect(insertPayment(pool, a, await transaction('300000.01'), '300000.01')).rejects.toThrow(/PAYMENT_EXCEEDS_PRICE/);
      await insertPayment(pool, await acquisition(), t, '100.00');
      await expect(insertPayment(pool, a, t, '50.01', c)).rejects.toThrow(/PAYMENT_EXCEEDS_TRANSACTION/);
      await insertPayment(pool, a, t, '50.00', c);
      await expect(rawVoid(pool, c)).rejects.toThrow(/COST_HAS_PAYMENTS/);
      const d = await cost(a, '1.00');
      await rawVoid(pool, d);
      await expect(insertPayment(pool, a, await transaction('1.00'), '1.00', d)).rejects.toThrow(/COST_VOID/);
      const e = await acquisition();
      await rawCancel(pool, e);
      await expect(insertPayment(pool, e, await transaction('1.00'), '1.00')).rejects.toThrow(/ACQUISITION_CANCELLED/);
      await expect(
        pool.query(`INSERT INTO acquisition_cost (mre_realm_id, acquisition_id, category, amount, currency, status, created_by) VALUES ($1, $2, 'OTHER', 1, 'EUR', 'ACTIVE', 'x')`, [REALM, e]),
      ).rejects.toThrow(/ACQUISITION_CANCELLED/);
    });

    it('keeps the links in the Realm, the cost in the Acquisition and the currency the Transaction’s (composite keys)', async () => {
      const a = await acquisition();
      const foreignTransaction = await transaction('1.00', { realm: OTHER_REALM });
      await expect(insertPayment(pool, a, foreignTransaction, '1.00')).rejects.toThrow(/acquisition_payment_transaction_fk/);
      await expect(insertPayment(pool, a, await transaction('1.00'), '1.00', await cost(await acquisition(), '1.00'))).rejects.toThrow(/acquisition_payment_cost_fk/);
    });

    it('keeps data fixed and rows undeleted; only the void and the unlink are steps', async () => {
      const a = await acquisition();
      const c = await cost(a, '10.00');
      const p = await link(a, await transaction('10.00'), '5.00', c);
      await expect(pool.query(`UPDATE acquisition_cost SET amount = 11 WHERE id = $1`, [c])).rejects.toThrow(/never changes/);
      await expect(pool.query(`UPDATE acquisition_cost SET version = version + 1 WHERE id = $1`, [c])).rejects.toThrow(/only with the void/);
      await expect(pool.query(`DELETE FROM acquisition_cost WHERE id = $1`, [c])).rejects.toThrow(/never deleted/);
      await expect(pool.query(`UPDATE acquisition_payment SET amount = 4 WHERE id = $1`, [p])).rejects.toThrow(/never changes/);
      await expect(pool.query(`DELETE FROM acquisition_payment WHERE id = $1`, [p])).rejects.toThrow(/never deleted/);
      await pool.query(`UPDATE acquisition_payment SET unlinked_at = now(), unlink_reason = 'x', version = 2 WHERE id = $1`, [p]);
      await expect(pool.query(`UPDATE acquisition_payment SET unlinked_at = NULL, unlink_reason = NULL WHERE id = $1`, [p])).rejects.toThrow(/final/);
      await rawVoid(pool, c);
      await expect(pool.query(`UPDATE acquisition_cost SET status = 'ACTIVE', voided_at = NULL, void_reason = NULL WHERE id = $1`, [c])).rejects.toThrow(/final/);
    });
  });

  describe('concurrency (READ COMMITTED through the repository: the waiter sees the holder’s commit)', () => {
    it('two links of one Transaction from two Acquisitions serialise on the Transaction row', async () => {
      const [a, b] = [await acquisition(), await acquisition()];
      const t = await transaction('100.00');
      const outcome = await whileHeld((h) => insertPayment(h, a, t, '60.00'), () => costs.linkPayment(newPayment(b, t, '60.00'), actor), '"ledger_transaction"');
      expect(outcome.kind).toBe('PAYMENT_EXCEEDS_TRANSACTION');
    });

    it('two links of one cost, and two of the price, serialise on the Acquisition row', async () => {
      const a = await acquisition();
      const c = await cost(a, '100.00');
      const onCost = await whileHeld(
        async (h) => insertPayment(h, a, await transaction('60.00'), '60.00', c),
        async () => costs.linkPayment(newPayment(a, await transaction('60.00'), '60.00', c), actor),
        '"acquisition"',
      );
      expect(onCost.kind).toBe('PAYMENT_EXCEEDS_COST');
      const [t1, t2] = [await transaction('200000.00'), await transaction('200000.00')];
      const onPrice = await whileHeld((h) => insertPayment(h, a, t1, '200000.00'), () => costs.linkPayment(newPayment(a, t2, '200000.00'), actor), '"acquisition"');
      expect(onPrice.kind).toBe('PAYMENT_EXCEEDS_PRICE');
    });

    it('link, unlink and void against a cancel: whichever waits sees the cancel', async () => {
      const a = await acquisition();
      const c = await cost(a, '10.00');
      const p = await link(a, await transaction('5.00'), '5.00', c);
      const t = await transaction('1.00');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await rawCancel(holder, a);
        const linking = costs.linkPayment(newPayment(a, t, '1.00'), actor);
        const unlinking = costs.unlinkPayment(a, p, REALM, 'x', AT, actor);
        const voiding = costs.voidCost(a, c, REALM, 'x', AT, actor);
        await waitForLock('"acquisition"', 3);
        await holder.query('COMMIT');
        expect(await linking).toEqual({ kind: 'ACQUISITION_CANCELLED' });
        expect(await unlinking).toEqual({ kind: 'ACQUISITION_CANCELLED' });
        expect(await voiding).toEqual({ kind: 'ACQUISITION_CANCELLED' });
      } finally {
        holder.release();
      }
    });

    it('a cancel waits for a link in flight and then cancels; the payment counts nowhere', async () => {
      const a = await acquisition();
      const t = await transaction('1.00');
      const outcome = await whileHeld((h) => insertPayment(h, a, t, '1.00'), () => acquisitions.cancel(a, REALM, 'x', AT, actor), '"acquisition"');
      expect(outcome.kind).toBe('CANCELLED');
      expect((await costs.listPayments(a, REALM, {}))?.items[0]).toMatchObject({ notCountingReason: 'ACQUISITION_CANCELLED' });
    });

    it('link against void of the same cost, both ways (review on #48)', async () => {
      const a = await acquisition();
      const c = await cost(a, '10.00');
      const t = await transaction('10.00');
      expect((await whileHeld((h) => rawVoid(h, c), () => costs.linkPayment(newPayment(a, t, '1.00', c), actor), '"acquisition"')).kind).toBe('COST_VOID');
      const d = await cost(a, '10.00');
      const voided = await whileHeld((h) => insertPayment(h, a, t, '1.00', d), () => costs.voidCost(a, d, REALM, 'x', AT, actor), '"acquisition"');
      expect(voided.kind).toBe('COST_HAS_PAYMENTS');
    });

    it('link against a correction of the Transaction: the link that waits sees it CORRECTED; the correction that waits leaves the payment', async () => {
      const a = await acquisition();
      const t = await transaction('10.00');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM ledger_transaction WHERE id = $1 FOR UPDATE`, [t]);
        const correcting = corrections.correct(t, REALM, { reason: 'x', replacement: { description: 'neu' } }, actor);
        await waitForLock('"ledger_transaction"');
        // Queued behind the correction on the same row: it takes the row only after the correction committed.
        const linking = costs.linkPayment(newPayment(a, t, '10.00'), actor);
        await waitForLock('"ledger_transaction"', 2);
        await holder.query('COMMIT');
        expect((await correcting).kind).toBe('CORRECTED');
        expect(await linking).toMatchObject({ kind: 'TRANSACTION_NOT_CURRENT', status: 'CORRECTED' });
      } finally {
        holder.release();
      }
      const u = await transaction('10.00');
      const corrected = await whileHeld(
        (h) => insertPayment(h, a, u, '10.00'),
        () => corrections.correct(u, REALM, { reason: 'x', replacement: { description: 'neu' } }, actor),
        '"ledger_transaction"',
      );
      expect(corrected.kind).toBe('CORRECTED');
      expect((await costs.listPayments(a, REALM, {}))?.items.at(-1)).toMatchObject({ transactionId: u, notCountingReason: 'TRANSACTION_CORRECTED' });
    });
  });

  describe('concurrency (REPEATABLE READ past the repository: the waiter fails to serialise)', () => {
    async function race(first: (c: pg.PoolClient) => Promise<unknown>, second: (c: pg.PoolClient) => Promise<unknown>, lockText: string): Promise<string> {
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await two.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT count(*) FROM acquisition_payment');
        await two.query('SELECT count(*) FROM acquisition_payment');
        await first(one);
        const late = second(two).then(
          () => 'written',
          (error: { code?: string }) => error.code ?? 'error',
        );
        await waitForLock(lockText);
        await one.query('COMMIT');
        const result = await late;
        await two.query('ROLLBACK');
        return result;
      } finally {
        one.release();
        two.release();
      }
    }

    it('two links of one Transaction, two of one cost, link against cancel, unlink against cancel, link against void', async () => {
      const [a, b] = [await acquisition(), await acquisition()];
      const c = await cost(a, '100.00');
      const t = await transaction('100.00');
      expect(await race((x) => insertPayment(x, a, t, '60.00'), (y) => insertPayment(y, b, t, '60.00'), 'INSERT INTO acquisition_payment')).toBe('40001');
      const [t1, t2] = [await transaction('60.00'), await transaction('60.00')];
      expect(await race((x) => insertPayment(x, a, t1, '60.00', c), (y) => insertPayment(y, a, t2, '60.00', c), 'INSERT INTO acquisition_payment')).toBe('40001');
      const d = await acquisition();
      const p = await link(d, await transaction('1.00'), '1.00');
      const t3 = await transaction('1.00');
      expect(await race((x) => insertPayment(x, d, t3, '0.01'), (y) => rawCancel(y, d), 'UPDATE acquisition SET')).toBe('40001');
      expect(await race((x) => rawCancel(x, d), (y) => y.query(`UPDATE acquisition_payment SET unlinked_at = now(), unlink_reason = 'x', version = 2 WHERE id = $1`, [p]), 'UPDATE acquisition_payment')).toBe('40001');
      const e = await cost(a, '10.00');
      expect(await race((x) => rawVoid(x, e), (y) => insertPayment(y, a, t2, '1.00', e), 'INSERT INTO acquisition_payment')).toBe('40001');
    });
  });
});
