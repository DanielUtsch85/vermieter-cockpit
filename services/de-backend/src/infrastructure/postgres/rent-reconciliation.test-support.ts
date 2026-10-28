import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
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
 * The shared setup of the rent reconciliation repository tests (#104): one migrated schema per test file, two
 * accounts in two Realms, and the helpers that build confirmed Transactions and matches. Test support only.
 */
export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

export const REALM = '64b0c0ffee00000000000014';
export const OTHER_REALM = '64b0c0ffee00000000000015';
export const TENANT = '6512f0c2a1b2c3d4e5f60a01';
export const TENANT_2 = '6512f0c2a1b2c3d4e5f60a02';
export const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
export const day = (value: string) => value as BusinessDate;
export const eur = (amount: string) => Money.of(amount, 'EUR');
export const split = (amount: string, financialCategoryCode = 'RENT_BASE'): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId: null,
  loanId: null,
  description: null,
});

export async function waitForLocks(pool: pg.Pool, count = 1): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (
    Number((await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].count) < count
  ) {
    if (Date.now() > deadline) throw new Error(`fewer than ${count} sessions wait on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The trigger's own reason, the constraint's name, or the error code. */
export function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return (
    error.constraint ??
    /\(([A-Z_]+)\)|never deleted|fixed after creation|is not a step|only inserted SUGGESTED or CONFIRMED with version 1|only lowered when a suggestion is confirmed|only inserted NOT_WRITTEN|released with write-back|with write-back [A-Z_]+|mre_last_lease_until changed outside a claim|a claim sets mre_last_lease_until to the latest lease/.exec(
      error.message ?? '',
    )?.[0] ??
    error.code ??
    'error'
  );
}

export interface RentReconciliationContext {
  pool: pg.Pool;
  accounts: PostgresFinancialAccountRepository;
  transactions: PostgresTransactionRepository;
  splits: PostgresTransactionSplitRepository;
  corrections: PostgresCorrectionRepository;
  repository: PostgresRentReconciliationRepository;
  account: string;
  otherAccount: string;
}

/**
 * Registers the schema's `beforeAll`/`afterAll` in the calling `describe` and returns the context (filled once
 * `beforeAll` has run) with the helpers bound to it.
 */
export function useRentReconciliationDatabase(name: `${string}_test`) {
  const schema = testSchemaName(name);
  const ctx = {} as RentReconciliationContext;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    ctx.pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(ctx.pool, { migrationTableSchema: schema });
    const db = createDatabase(ctx.pool);
    ctx.accounts = new PostgresFinancialAccountRepository(db);
    ctx.transactions = new PostgresTransactionRepository(db);
    ctx.splits = new PostgresTransactionSplitRepository(db);
    ctx.corrections = new PostgresCorrectionRepository(db);
    ctx.repository = new PostgresRentReconciliationRepository(db);
    const created = await ctx.accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    const other = await ctx.accounts.create({ mreRealmId: OTHER_REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (created.kind !== 'CREATED' || other.kind !== 'CREATED') throw new Error('account');
    ctx.account = created.account.id;
    ctx.otherAccount = other.account.id;
  });

  afterAll(async () => {
    await ctx.pool.end();
  });

  /** A Transaction with the given splits, confirmed unless told otherwise. */
  async function transaction(
    set: readonly SplitInput[] = [split('800.00')],
    options: { direction?: 'INFLOW' | 'OUTFLOW'; confirm?: boolean; realm?: string; bookingDate?: string; iban?: string } = {},
  ): Promise<string> {
    const realm = options.realm ?? REALM;
    const total = set.reduce((sum, s) => sum.add(s.amount), eur('0'));
    const created = await ctx.transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: realm === REALM ? ctx.account : ctx.otherAccount,
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
    const replaced = await ctx.splits.replaceSplits(id, realm, set, actor);
    if (replaced.kind !== 'REPLACED') throw new Error(JSON.stringify(replaced));
    if (options.iban !== undefined) await ctx.pool.query(`UPDATE ledger_transaction SET counterparty_iban_raw = $1 WHERE id = $2`, [options.iban, id]);
    if (options.confirm ?? true) {
      const confirmed = await ctx.transactions.confirm(id, realm, actor);
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
    const outcome = await ctx.repository.create(m, actor);
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome));
    return outcome.reconciliation;
  };
  const rawInsert = (transactionId: string, amount: string, term = '2027010100', status = 'CONFIRMED') =>
    `INSERT INTO rent_payment_reconciliation (mre_realm_id, status, transaction_id, mre_tenant_id, mre_rent_term, matched_amount, currency,
       confidence, suggestion_reason, confirmed_at, confirmed_by, created_by)
     VALUES ('${REALM}', '${status}', '${transactionId}', '${TENANT}', '${term}', ${amount}, 'EUR',
       ${status === 'SUGGESTED' ? `'MEDIUM', 'EXACT_AMOUNT', NULL, NULL` : `NULL, NULL, now(), 'x'`}, 'x')`;

  return { ctx, transaction, match, created, rawInsert };
}
