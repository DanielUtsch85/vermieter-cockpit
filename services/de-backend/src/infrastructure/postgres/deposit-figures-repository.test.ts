import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate, Direction, SplitInput } from '../../domains/ledger/index.js';
import type { DepositView, SecurityDeposit } from '../../domains/security-deposit/index.js';
import { Money } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresSecurityDepositRepository } from './security-deposit-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-5-03 reads (api-design.md §47.3): the figures from the cash that counts (current Transactions only), corrections,
 * interest, repayments, cash outside the holding account, `cash` on the single read, the list's `state` filter.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000054';
const OTHER_REALM = '64b0c0ffee00000000000055';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, financialCategoryCode: string, securityDepositId: string | null): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId: null,
  loanId: null,
  securityDepositId,
  description: null,
});
let tenantCounter = 0;
const nextTenant = () => `6512f0c2a1b4${(++tenantCounter).toString(16).padStart(12, '0')}`;
const amounts = (d: DepositView | undefined) =>
  d === undefined
    ? undefined
    : {
        received: d.figures.received.amount,
        interestCredited: d.figures.interestCredited.amount,
        returned: d.figures.returned.amount,
        outstanding: d.figures.outstanding.amount,
        held: d.figures.held.amount,
        state: d.figures.state,
      };

describe.skipIf(databaseUrl === undefined)('Security deposit figures (§47.3)', () => {
  const schema = testSchemaName('deposit_figures_test');
  let pool: pg.Pool;
  let deposits: PostgresSecurityDepositRepository;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let corrections: PostgresCorrectionRepository;
  let giro = '';
  let kaution = '';

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    deposits = new PostgresSecurityDepositRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    giro = await account('BANK', 'Giro');
    kaution = await account('SECURITY_DEPOSIT', 'Kaution');
  });

  afterAll(async () => {
    await pool.end();
  });

  async function account(accountType: 'BANK' | 'SECURITY_DEPOSIT', displayName: string, realm = REALM): Promise<string> {
    const outcome = await accounts.create({ mreRealmId: realm, accountType, displayName, currency: 'EUR', iban: null }, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account.id;
  }
  async function deposit(options: { expected?: string; holding?: string | null; realm?: string } = {}): Promise<SecurityDeposit> {
    const outcome = await deposits.create(
      {
        mreRealmId: options.realm ?? REALM,
        mreTenantId: nextTenant(),
        expectedAmount: eur(options.expected ?? '3000.00'),
        expectedAmountSource: 'REQUEST',
        holdingFinancialAccountId: options.holding === undefined ? kaution : options.holding,
        interestBearing: true,
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.deposit;
  }
  /** A Transaction with the given splits, confirmed unless `confirm` is false. */
  async function booked(
    set: readonly SplitInput[],
    options: { direction?: Direction; on?: string; bookingDate?: string; confirm?: boolean } = {},
  ): Promise<string> {
    const total = Money.sum(
      set.map((s) => s.amount),
      'EUR',
    );
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: options.on ?? kaution,
        amount: total,
        direction: options.direction ?? 'INFLOW',
        bookingDate: day(options.bookingDate ?? '2027-02-01'),
        valueDate: null,
        description: 'Kaution',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const id = created.transaction.id;
    const replaced = await splits.replaceSplits(id, REALM, set, actor);
    if (replaced.kind !== 'REPLACED') throw new Error(replaced.kind);
    if (options.confirm !== false) {
      const confirmed = await transactions.confirm(id, REALM, actor);
      if (confirmed.kind !== 'CONFIRMED') throw new Error(confirmed.kind);
    }
    return id;
  }
  const read = (id: string) => deposits.findById(id, REALM);

  it('a new deposit: zeros, EXPECTED, no flags, no cash; create answers the same', async () => {
    const d = await deposit();
    expect(amounts(d as DepositView)).toEqual({
      received: '0.00',
      interestCredited: '0.00',
      returned: '0.00',
      outstanding: '3000.00',
      held: '0.00',
      state: 'EXPECTED',
    });
    const r = await read(d.id);
    expect([r?.figures.flags, r?.cash]).toEqual([[], []]);
  });

  it('three instalments (§ 551 Abs. 2 BGB): PARTIALLY_RECEIVED, then RECEIVED; cash in booking-date order', async () => {
    const d = await deposit();
    const third = await booked([split('1000.00', 'SECURITY_DEPOSIT', d.id)], { bookingDate: '2027-04-01' });
    const first = await booked([split('1000.00', 'SECURITY_DEPOSIT', d.id)], { bookingDate: '2027-02-01' });
    expect(amounts(await read(d.id))).toMatchObject({ received: '2000.00', outstanding: '1000.00', state: 'PARTIALLY_RECEIVED' });
    const second = await booked([split('1000.00', 'SECURITY_DEPOSIT', d.id)], { bookingDate: '2027-03-01' });
    const r = await read(d.id);
    expect(amounts(r)).toMatchObject({ received: '3000.00', outstanding: '0.00', held: '3000.00', state: 'RECEIVED' });
    expect(r?.cash?.map((c) => [c.transactionId, c.bookingDate, c.kind, c.amount.amount, c.financialAccountId])).toEqual([
      [first, '2027-02-01', 'RECEIPT', '1000.00', kaution],
      [second, '2027-03-01', 'RECEIPT', '1000.00', kaution],
      [third, '2027-04-01', 'RECEIPT', '1000.00', kaution],
    ]);
  });

  it('only current Transactions count: an unconfirmed receipt does not; a correction moves the amount, a reversal removes it', async () => {
    const d = await deposit();
    await booked([split('1500.00', 'SECURITY_DEPOSIT', d.id)], { confirm: false });
    expect(amounts(await read(d.id))).toMatchObject({ received: '0.00', state: 'EXPECTED' });
    const receipt = await booked([split('1500.00', 'SECURITY_DEPOSIT', d.id)]);
    expect(amounts(await read(d.id))).toMatchObject({ received: '1500.00' });
    const corrected = await corrections.correct(
      receipt,
      REALM,
      { reason: 'Betrag', replacement: { amount: eur('1400.00'), splits: [split('1400.00', 'SECURITY_DEPOSIT', d.id)] } },
      actor,
    );
    if (corrected.kind !== 'CORRECTED' || corrected.result.replacement === null) throw new Error(corrected.kind);
    expect(amounts(await read(d.id))).toMatchObject({ received: '1400.00', outstanding: '1600.00' });
    const reversed = await corrections.correct(corrected.result.replacement.id, REALM, { reason: 'doppelt', replacement: null }, actor);
    expect(reversed.kind).toBe('CORRECTED');
    expect(amounts(await read(d.id))).toMatchObject({ received: '0.00', state: 'EXPECTED' });
    expect((await read(d.id))?.cash).toEqual([]);
  });

  it('interest adds to held, not to received; repayments: PARTIALLY_RETURNED, RETURNED, then RETURNED_EXCEEDS_HELD', async () => {
    const d = await deposit();
    await booked([split('3000.00', 'SECURITY_DEPOSIT', d.id)]);
    await booked([split('4.20', 'SECURITY_DEPOSIT_INTEREST', d.id)]);
    expect(amounts(await read(d.id))).toMatchObject({ received: '3000.00', interestCredited: '4.20', held: '3004.20', state: 'RECEIVED' });
    await booked([split('2000.00', 'SECURITY_DEPOSIT', d.id)], { direction: 'OUTFLOW' });
    expect(amounts(await read(d.id))).toMatchObject({ returned: '2000.00', held: '1004.20', state: 'PARTIALLY_RETURNED' });
    await booked([split('1004.20', 'SECURITY_DEPOSIT', d.id)], { direction: 'OUTFLOW' });
    expect(amounts(await read(d.id))).toMatchObject({ held: '0.00', state: 'RETURNED' });
    expect((await read(d.id))?.figures.flags).toEqual([]);
    await booked([split('5.00', 'SECURITY_DEPOSIT', d.id)], { direction: 'OUTFLOW' });
    const r = await read(d.id);
    expect(amounts(r)).toMatchObject({ held: '-5.00', state: 'RETURNED' });
    expect(r?.figures.flags).toEqual([{ code: 'RETURNED_EXCEEDS_HELD', details: { excess: eur('5.00') } }]);
  });

  it('RECEIVED_OUTSIDE_HOLDING_ACCOUNT for a receipt on the Girokonto; RECEIVED_EXCEEDS_EXPECTED; no holding account, no outside flag', async () => {
    const d = await deposit({ expected: '1000.00' });
    await booked([split('600.00', 'SECURITY_DEPOSIT', d.id)]);
    const onGiro = await booked([split('600.00', 'SECURITY_DEPOSIT', d.id)], { on: giro });
    expect((await read(d.id))?.figures.flags).toEqual([
      { code: 'RECEIVED_EXCEEDS_EXPECTED', details: { excess: eur('200.00') } },
      { code: 'RECEIVED_OUTSIDE_HOLDING_ACCOUNT', details: { transactionIds: [onGiro] } },
    ]);
    const none = await deposit({ holding: null });
    await booked([split('600.00', 'SECURITY_DEPOSIT', none.id)], { on: giro });
    expect((await read(none.id))?.figures.flags).toEqual([]);
  });

  it('amend and void answer the figures read in their own transaction', async () => {
    const d = await deposit();
    await booked([split('1000.00', 'SECURITY_DEPOSIT', d.id)]);
    const amended = await deposits.amend(d.id, REALM, { expectedAmount: eur('1000.00') }, actor);
    if (amended.kind !== 'AMENDED') throw new Error(amended.kind);
    expect(amounts(amended.deposit)).toMatchObject({ received: '1000.00', outstanding: '0.00', state: 'RECEIVED' });
    const unchanged = await deposits.amend(d.id, REALM, { expectedAmount: eur('1000') }, actor);
    expect(unchanged.kind === 'AMENDED' ? amounts(unchanged.deposit)?.state : undefined).toBe('RECEIVED');
    const plain = await deposit();
    const voided = await deposits.void(plain.id, REALM, 'Irrtum', new Date(), actor);
    expect(voided.kind === 'VOIDED' ? amounts(voided.deposit)?.state : undefined).toBe('EXPECTED');
  });

  it('the list filters by state before paging, with total; combined with status and Tenant; Realm-isolated; no cash on the list', async () => {
    const realm = '64b0c0ffee000000000000a5';
    const holding = await account('SECURITY_DEPOSIT', 'Kaution L', realm);
    const make = async () => {
      const outcome = await deposits.create(
        {
          mreRealmId: realm,
          mreTenantId: nextTenant(),
          expectedAmount: eur('100.00'),
          expectedAmountSource: 'REQUEST',
          holdingFinancialAccountId: holding,
          interestBearing: true,
          notes: null,
        },
        actor,
      );
      if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
      return outcome.deposit;
    };
    const receiveIn = async (id: string, amount: string) => {
      const created = await transactions.createManual(
        {
          mreRealmId: realm,
          financialAccountId: holding,
          amount: eur(amount),
          direction: 'INFLOW',
          bookingDate: day('2027-02-01'),
          valueDate: null,
          description: null,
          propertyReferenceId: null,
        },
        actor,
      );
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      const replaced = await splits.replaceSplits(created.transaction.id, realm, [split(amount, 'SECURITY_DEPOSIT', id)], actor);
      if (replaced.kind !== 'REPLACED') throw new Error(replaced.kind);
      expect((await transactions.confirm(created.transaction.id, realm, actor)).kind).toBe('CONFIRMED');
    };
    const expected = await make();
    const partial = await make();
    const full = await make();
    const voided = await make();
    await receiveIn(partial.id, '40.00');
    await receiveIn(full.id, '100.00');
    await deposits.void(voided.id, realm, 'x', new Date(), actor);
    const page = { page: 1, pageSize: 50 };
    const ids = async (filter: Parameters<PostgresSecurityDepositRepository['list']>[1], p = page) => {
      const result = await deposits.list(realm, filter, p);
      return { ids: result.items.map((d) => d.id), total: result.total, cash: result.items.some((d) => d.cash !== undefined) };
    };
    expect(await ids({ states: ['EXPECTED'] })).toEqual({ ids: [voided.id, expected.id], total: 2, cash: false });
    expect(await ids({ states: ['EXPECTED'], statuses: ['ACTIVE'] })).toEqual({ ids: [expected.id], total: 1, cash: false });
    expect(await ids({ states: ['PARTIALLY_RECEIVED', 'RECEIVED'] })).toEqual({ ids: [full.id, partial.id], total: 2, cash: false });
    expect(await ids({ states: ['RECEIVED'], mreTenantId: partial.mreTenantId })).toEqual({ ids: [], total: 0, cash: false });
    expect(await ids({ states: ['PARTIALLY_RECEIVED', 'RECEIVED', 'EXPECTED'] }, { page: 2, pageSize: 3 })).toEqual({
      ids: [expected.id],
      total: 4,
      cash: false,
    });
    // Without a state filter: figures on every item, paged in SQL.
    const all = await deposits.list(realm, {}, page);
    expect(all.items.map((d) => d.figures.state)).toEqual(['EXPECTED', 'RECEIVED', 'PARTIALLY_RECEIVED', 'EXPECTED']);
    expect((await deposits.list(OTHER_REALM, { states: ['RECEIVED'] }, page)).total).toBe(0);
  });
});
