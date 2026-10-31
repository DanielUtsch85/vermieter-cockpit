import pg from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';
import type { Direction, SplitInput } from '../../domains/ledger/index.js';
import type { NewRentalContractReference, RentDueDay } from '../../domains/rental-contract-reference/index.js';
import type { NewTaxClassification, TaxListItem, TaxMeaning, TaxPage } from '../../domains/taxation/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { PostgresLoanTermsRepository } from './loan-terms-repository.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { PostgresRentReconciliationRepository } from './rent-reconciliation-repository.js';
import { PostgresRentalContractReferenceRepository } from './rental-contract-reference-repository.js';
import { PostgresSecurityDepositRepository } from './security-deposit-repository.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresWegAnnualStatementRepository } from './weg-annual-statement-repository.js';
import { PostgresWegEconomicPlanRepository } from './weg-economic-plan-repository.js';
import { PostgresWegRepository } from './weg-repository.js';

/**
 * The shared setup of the VC-7-02 persistence tests (api-design.md §58A, migration 0046): one migrated schema per test
 * file with a Giro account, the fixtures (PropertyReferences, booked and reconciled splits, RentalContractReferences,
 * retained deposits) and the read helpers. Figures and names are invented. Test support only.
 */

export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

export const REALM = '64b0c0ffee000000000000c1';
export const OTHER_REALM = '64b0c0ffee000000000000c2';
export const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
export const day = (value: string) => value as BusinessDate;
export const eur = (amount: string) => Money.of(amount, 'EUR');
export const today = day('2027-10-30');
export const UNKNOWN = '00000000-0000-4000-8000-000000000000';
export const due = (entries: [string, number][]): RentDueDay[] => entries.map(([validFrom, d]) => ({ validFrom: day(validFrom), day: d }));
export const splitsOf = (page: TaxPage<TaxListItem> | undefined): TaxMeaning[] =>
  (page?.items ?? []).filter((m): m is TaxMeaning & TaxListItem => m.sourceType === 'TRANSACTION_SPLIT');
export const codes = (flags: readonly { code: string }[] | undefined) => (flags ?? []).map((f) => f.code);
let counter = 0;
export const nextTenant = () => `6512f0c2a1c7${(++counter).toString(16).padStart(12, '0')}`;

export async function withMigrationLock(work: () => Promise<unknown>): Promise<void> {
  const lock = new pg.Client({ connectionString: databaseUrl });
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    await work();
  } finally {
    await lock.end().catch(() => undefined);
  }
}

export function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return (
    error.constraint ??
    /\(([A-Z_]+)\)|never change|never deleted|exactly one|only inserted with version 1/.exec(error.message ?? '')?.[0] ??
    error.code ??
    'error'
  );
}

export interface TaxYearContext {
  pool: pg.Pool;
  classifications: PostgresTaxClassificationRepository;
  references: PostgresRentalContractReferenceRepository;
  accounts: PostgresFinancialAccountRepository;
  transactions: PostgresTransactionRepository;
  splits: PostgresTransactionSplitRepository;
  reconciliations: PostgresRentReconciliationRepository;
  deposits: PostgresSecurityDepositRepository;
  wegs: PostgresWegRepository;
  plans: PostgresWegEconomicPlanRepository;
  statements: PostgresWegAnnualStatementRepository;
  loans: PostgresLoanRepository;
  terms: PostgresLoanTermsRepository;
  parties: PostgresPartyRepository;
}

/**
 * Registers the schema's `beforeAll`/`afterAll` in the calling `describe` and returns the context (filled once
 * `beforeAll` has run) with the helpers bound to it.
 */
export function useTaxYearDatabase(name: `${string}_test`) {
  const schema = testSchemaName(name);
  const ctx = {} as TaxYearContext;
  let pool: pg.Pool;
  let classifications: PostgresTaxClassificationRepository;
  let references: PostgresRentalContractReferenceRepository;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let reconciliations: PostgresRentReconciliationRepository;
  let deposits: PostgresSecurityDepositRepository;
  let wegs: PostgresWegRepository;
  let plans: PostgresWegEconomicPlanRepository;
  let statements: PostgresWegAnnualStatementRepository;
  let loans: PostgresLoanRepository;
  let terms: PostgresLoanTermsRepository;
  let parties: PostgresPartyRepository;
  let giro = '';

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    classifications = new PostgresTaxClassificationRepository(db);
    references = new PostgresRentalContractReferenceRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    reconciliations = new PostgresRentReconciliationRepository(db);
    deposits = new PostgresSecurityDepositRepository(db);
    wegs = new PostgresWegRepository(db);
    plans = new PostgresWegEconomicPlanRepository(db);
    statements = new PostgresWegAnnualStatementRepository(db);
    loans = new PostgresLoanRepository(db);
    terms = new PostgresLoanTermsRepository(db);
    parties = new PostgresPartyRepository(db);
    const created = await accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    giro = created.account.id;
    Object.assign(ctx, {
      pool,
      classifications,
      references,
      accounts,
      transactions,
      splits,
      reconciliations,
      deposits,
      wegs,
      plans,
      statements,
      loans,
      terms,
      parties,
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  async function propertyReference(realm = REALM) {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fc0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  const split = (amount: string, financialCategoryCode: string, overrides: Partial<SplitInput> = {}): SplitInput => ({
    amount: eur(amount),
    financialCategoryCode,
    propertyReferenceId: null,
    loanId: null,
    securityDepositId: null,
    description: null,
    ...overrides,
  });
  /** A confirmed Transaction with its splits; returns it and its split ids by position. */
  async function booked(set: SplitInput[], options: { direction?: Direction; bookingDate?: string }): Promise<{ tx: string; splitIds: string[] }> {
    const total = set.reduce((sum, s) => sum.add(s.amount), eur('0.00'));
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: giro,
        amount: total,
        direction: options.direction ?? 'OUTFLOW',
        bookingDate: day(options.bookingDate ?? '2026-06-01'),
        valueDate: null,
        description: 'Buchung',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const tx = created.transaction.id;
    const outcome = await splits.replaceSplits(tx, REALM, set, actor);
    if (outcome.kind !== 'REPLACED') throw new Error(JSON.stringify(outcome));
    expect((await transactions.confirm(tx, REALM, actor)).kind).toBe('CONFIRMED');
    const { rows } = await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [tx]);
    return { tx, splitIds: rows.map((r) => r.id as string) };
  }
  /** A rent of 900 on `pr`, booked on `bookingDate` and matched to `term` of `tenant`. */
  async function rent(pr: string, tenant: string, bookingDate: string, term: string) {
    const { tx, splitIds } = await booked([split('900.00', 'RENT_BASE', { propertyReferenceId: pr })], { direction: 'INFLOW', bookingDate });
    const matched = await reconciliations.create(
      { mreRealmId: REALM, transactionId: tx, mreTenantId: tenant, mreRentTerm: term, matchedAmount: eur('900.00'), notes: null },
      actor,
    );
    if (matched.kind !== 'CREATED') throw new Error(matched.kind);
    return splitIds[0] as string;
  }
  const newReference = (mreTenantId: string, rentDueDays: RentDueDay[] = [], realm = REALM): NewRentalContractReference => ({
    mreRealmId: realm,
    mreTenantId,
    rentDueDays,
    notes: null,
    sourceReferences: [],
  });
  async function reference(mreTenantId: string, rentDueDays: RentDueDay[]) {
    const created = await references.createReference(newReference(mreTenantId, rentDueDays), actor);
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.reference;
  }
  const request = (sourceId: string, overrides: Partial<NewTaxClassification> = {}): NewTaxClassification => ({
    mreRealmId: REALM,
    sourceType: 'TRANSACTION_SPLIT',
    sourceId,
    taxCategory: 'RENT',
    treatment: 'INCOME',
    reviewState: 'USER_CONFIRMED',
    supersedes: null,
    notes: null,
    sourceReferences: [],
    ...overrides,
  });
  const list = (pr: string, year: number) => classifications.listTaxMeanings(pr, REALM, year, {}, { page: 1, pageSize: 200 }, today);
  const meaning = (splitId: string) => classifications.findTaxMeaning(splitId, REALM, today);

  /** A deposit of `tenant` with a receipt of 3000 and a repayment of 2600, closed RETAINED on 30 June 2027 (400 kept). */
  async function retained(tenant: string, realm = REALM) {
    const created = await deposits.create(
      {
        mreRealmId: realm,
        mreTenantId: tenant,
        expectedAmount: eur('3000.00'),
        expectedAmountSource: 'REQUEST',
        holdingFinancialAccountId: null,
        interestBearing: false,
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const id = created.deposit.id;
    if (realm === REALM) {
      await booked([split('3000.00', 'SECURITY_DEPOSIT', { securityDepositId: id })], { direction: 'INFLOW', bookingDate: '2026-01-02' });
      await booked([split('2600.00', 'SECURITY_DEPOSIT', { securityDepositId: id })], { direction: 'OUTFLOW', bookingDate: '2027-06-20' });
      const closed = await deposits.close(id, REALM, { closingDate: day('2027-06-30'), reason: 'RETAINED', closingNote: 'Mietrückstand Mai' }, actor);
      if (closed.kind !== 'CLOSED') throw new Error(JSON.stringify(closed));
    }
    return id;
  }
  const depositRequest = (depositId: string, overrides: Partial<NewTaxClassification> = {}) =>
    request(depositId, { sourceType: 'DEPOSIT_CLOSING', taxCategory: 'RETAINED_DEPOSIT_RENT', treatment: 'INCOME', ...overrides });

  return { ctx, propertyReference, split, booked, rent, newReference, reference, request, list, meaning, retained, depositRequest };
}
