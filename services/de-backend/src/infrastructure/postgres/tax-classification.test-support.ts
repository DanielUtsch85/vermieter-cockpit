import pg from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';
import type { Direction, SplitInput } from '../../domains/ledger/index.js';
import type { NewTaxClassification } from '../../domains/taxation/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresWegRepository } from './weg-repository.js';

/**
 * The shared setup of the TaxClassification repository tests (VC-7-01): one migrated schema per test file, and the
 * helpers that book counting splits and classify them. Test support only.
 */
export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

export const REALM = '64b0c0ffee000000000000a1';
export const OTHER_REALM = '64b0c0ffee000000000000a2';
export const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
export const day = (value: string) => value as BusinessDate;
export const eur = (amount: string) => Money.of(amount, 'EUR');
export const today = day('2026-10-30');
export const UNKNOWN = '00000000-0000-4000-8000-000000000000';
export const split = (amount: string, financialCategoryCode: string, propertyReferenceId: string | null): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId,
  loanId: null,
  securityDepositId: null,
  description: null,
});

export interface TaxClassificationContext {
  pool: pg.Pool;
  classifications: PostgresTaxClassificationRepository;
  accounts: PostgresFinancialAccountRepository;
  transactions: PostgresTransactionRepository;
  splits: PostgresTransactionSplitRepository;
  corrections: PostgresCorrectionRepository;
  wegs: PostgresWegRepository;
}

/**
 * Registers the schema's `beforeAll`/`afterAll` in the calling `describe` and returns the context (filled once
 * `beforeAll` has run) with the helpers bound to it.
 */
export function useTaxClassificationDatabase(name: `${string}_test`) {
  const schema = testSchemaName(name);
  const ctx = {} as TaxClassificationContext;
  let counter = 0;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    ctx.pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 10 });
    await migrateToLatest(ctx.pool, { migrationTableSchema: schema });
    const db = createDatabase(ctx.pool);
    ctx.classifications = new PostgresTaxClassificationRepository(db);
    ctx.accounts = new PostgresFinancialAccountRepository(db);
    ctx.transactions = new PostgresTransactionRepository(db);
    ctx.splits = new PostgresTransactionSplitRepository(db);
    ctx.corrections = new PostgresCorrectionRepository(db);
    ctx.wegs = new PostgresWegRepository(db);
  });

  afterAll(async () => {
    await ctx.pool.end();
  });

  async function propertyReference(realm = REALM) {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fb0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await ctx.pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function transaction(options: { direction?: Direction; amount?: string; bookingDate?: string; realm?: string } = {}) {
    const realm = options.realm ?? REALM;
    const account = await ctx.accounts.create({ mreRealmId: realm, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const created = await ctx.transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: account.account.id,
        amount: eur(options.amount ?? '120.00'),
        direction: options.direction ?? 'OUTFLOW',
        bookingDate: day(options.bookingDate ?? '2026-03-02'),
        valueDate: null,
        description: 'Handwerker',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  /** A Transaction with its splits, confirmed unless `confirm` is false; returns it and its split ids by position. */
  async function booked(
    set: SplitInput[],
    options: { direction?: Direction; bookingDate?: string; confirm?: boolean; realm?: string } = {},
  ): Promise<{ tx: string; splitIds: string[] }> {
    const total = set.reduce((sum, s) => sum.add(s.amount), eur('0.00'));
    const realm = options.realm ?? REALM;
    const tx = await transaction({ ...options, amount: total.amount });
    const outcome = await ctx.splits.replaceSplits(tx, realm, set, actor);
    if (outcome.kind !== 'REPLACED') throw new Error(JSON.stringify(outcome));
    if (options.confirm !== false) expect((await ctx.transactions.confirm(tx, realm, actor)).kind).toBe('CONFIRMED');
    const { rows } = await ctx.pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [tx]);
    return { tx, splitIds: rows.map((r) => r.id as string) };
  }
  async function oneSplit(code = 'MAINTENANCE', options: Parameters<typeof booked>[1] & { amount?: string } = {}) {
    const pr = await propertyReference(options.realm);
    const { tx, splitIds } = await booked([split(options.amount ?? '120.00', code, pr)], options);
    return { tx, splitId: splitIds[0] as string, pr };
  }
  const request = (sourceId: string, overrides: Partial<NewTaxClassification> = {}): NewTaxClassification => ({
    mreRealmId: REALM,
    sourceType: 'TRANSACTION_SPLIT',
    sourceId,
    taxCategory: 'MAINTENANCE',
    treatment: 'CAPITALIZED',
    reviewState: 'USER_CONFIRMED',
    supersedes: null,
    notes: 'Austausch Thermostatventile',
    sourceReferences: ['Rechnung 2026-117'],
    ...overrides,
  });
  async function classified(sourceId: string, overrides: Partial<NewTaxClassification> = {}) {
    const created = await ctx.classifications.createClassification(request(sourceId, overrides), actor);
    if (created.kind !== 'CREATED') throw new Error(JSON.stringify(created));
    return created.classification;
  }
  const audit = async (id: string) =>
    (
      await ctx.pool.query(`SELECT action, metadata, actor_id, previous_version, new_version FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [
        id,
      ])
    ).rows as { action: string; metadata: Record<string, unknown>; actor_id: string; previous_version: number | null; new_version: number }[];
  /** The Transaction row and its split rows as stored, for the "nothing changes" counter-check. */
  const cashOf = async (tx: string) => ({
    transaction: (await ctx.pool.query(`SELECT row_to_json(t)::text AS j FROM ledger_transaction t WHERE id = $1`, [tx])).rows[0].j as string,
    splits: (await ctx.pool.query(`SELECT row_to_json(s)::text AS j FROM transaction_split s WHERE transaction_id = $1 ORDER BY position`, [tx])).rows.map(
      (r) => r.j as string,
    ),
  });

  return { ctx, propertyReference, transaction, booked, oneSplit, request, classified, audit, cashOf };
}
