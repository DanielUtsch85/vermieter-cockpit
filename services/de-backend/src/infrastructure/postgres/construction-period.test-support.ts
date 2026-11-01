import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';
import type { AllocationRequest } from '../../domains/financing/index.js';
import type { SplitInput } from '../../domains/ledger/index.js';
import type { ConstructionPeriodInterest, NewTaxClassification } from '../../domains/taxation/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresConstructionPeriodInterestRepository } from './construction-period-interest-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLoanAllocationRepository } from './loan-allocation-repository.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * The fixtures of the construction-period tests (api-design.md §59E, migration 0055): a schema of their own,
 * PropertyReferences, Parties, Ownerships, Loans with their sets, confirmed Transactions with their splits, records and
 * classifications through their repositories. Synthetic data. Test support only.
 */
export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
export const REALM = '64b0c0ffee000000000059e1';
export const OTHER_REALM = '64b0c0ffee000000000059e2';
export const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
export const day = (value: string) => value as BusinessDate;
export const eur = (amount: string) => Money.of(amount, 'EUR');

/** The message a statement fails with, or `accepted`. */
export const messageOf = (statement: Promise<unknown>) =>
  statement.then(
    () => 'accepted',
    (error: { message?: string }) => error.message,
  );

/** A record's facts as a create takes them: a Dachgeschossausbau of the PropertyReferences named. */
export const facts = (propertyReferenceIds: readonly string[], o: Partial<Parameters<PostgresConstructionPeriodInterestRepository['create']>[0]> = {}) => ({
  mreRealmId: REALM,
  loanId: null,
  propertyReferenceIds,
  measure: 'Dachgeschossausbau, zwei neue Wohnungen (synthetisch)',
  herstellungFrom: day('2028-01-15'),
  herstellungUntil: day('2028-10-31'),
  useIntent: 'Vermietung der neuen Wohnungen (synthetisch)',
  advanceExpenseDeductible: false,
  buildingFundsShare: { numerator: 1n, denominator: 1n },
  earlierYearsTreatment: 'Keine Vorjahre betroffen (synthetisch)',
  sourceReferences: ['Darlehensvertrag (synthetisch)'],
  notes: null,
  ...o,
});

export interface ConstructionContext {
  pool: pg.Pool;
  db: Kysely<Database>;
  records: PostgresConstructionPeriodInterestRepository;
  classifications: PostgresTaxClassificationRepository;
  propertyReference(realm?: string): Promise<string>;
  party(name: string, realm?: string): Promise<string>;
  owner(pr: string, partyId: string, share: [number, number], validFrom?: string): Promise<void>;
  /** A Loan of the Realm, with a `MANUAL` set from `validFrom` when shares are given. */
  loan(shares: readonly (readonly [string, bigint, bigint])[] | null, validFrom?: string, realm?: string): Promise<{ loanId: string; setId: string | null }>;
  appendSet(loanId: string, shares: readonly (readonly [string, bigint, bigint])[], validFrom: string, realm?: string): Promise<string>;
  /** A confirmed OUTFLOW with the splits given; the split ids in order. */
  booked(splits: SplitInput[], bookingDate: string, realm?: string): Promise<{ tx: string; splitIds: string[] }>;
  split(amount: string, financialCategoryCode: string, overrides?: Partial<SplitInput>): SplitInput;
  /** A record through the repository (UNREVIEWED), confirmed when asked. */
  record(input: ReturnType<typeof facts>, confirm?: boolean): Promise<ConstructionPeriodInterest>;
  classify(sourceId: string, overrides: Partial<NewTaxClassification>, realm?: string): ReturnType<PostgresTaxClassificationRepository['createClassification']>;
  inTransaction<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T>;
}

export function useConstructionDatabase(name: `${string}_test`): ConstructionContext {
  const schema = testSchemaName(name);
  let counter = 0;
  const ctx = {} as ConstructionContext;
  const giro = new Map<string, string>();
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    const parties = new PostgresPartyRepository(db);
    const loans = new PostgresLoanRepository(db);
    const allocations = new PostgresLoanAllocationRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const splits = new PostgresTransactionSplitRepository(db);
    const ownerships = new PostgresOwnershipRepository(db);
    Object.assign(ctx, {
      pool,
      db,
      records: new PostgresConstructionPeriodInterestRepository(db),
      classifications: new PostgresTaxClassificationRepository(db),
    });
    for (const realm of [REALM, OTHER_REALM]) {
      const created = await new PostgresFinancialAccountRepository(db).create(
        { mreRealmId: realm, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null },
        actor,
      );
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      giro.set(realm, created.account.id);
    }
    ctx.propertyReference = async (realm = REALM) => {
      const mrePropertyId = (0x6512f0c2a1b2c3d4e5e90000n + BigInt(++counter)).toString(16).padStart(24, '0');
      const { rows } = await pool.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
        [realm, mrePropertyId],
      );
      return rows[0].id as string;
    };
    ctx.party = async (displayName, realm = REALM) => {
      const outcome = await parties.create(
        {
          mreRealmId: realm,
          partyType: 'PERSON',
          displayName,
          firstName: null,
          lastName: null,
          legalName: null,
          registrationNumber: null,
          email: null,
          phone: null,
        },
        actor,
      );
      if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
      return outcome.party.id;
    };
    ctx.owner = async (pr, partyId, share, validFrom = '2020-01-01') => {
      const o = await ownerships.create(
        {
          mreRealmId: REALM,
          propertyReferenceId: pr,
          ownerPartyId: partyId,
          share: { numerator: share[0], denominator: share[1] },
          validFrom: day(validFrom),
          validUntil: null,
          acquisitionId: null,
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (o.kind !== 'CREATED') throw new Error(o.kind);
    };
    const manual = (validFrom: string, entries: readonly (readonly [string, bigint, bigint])[]): AllocationRequest => ({
      validFrom: day(validFrom),
      basis: 'MANUAL',
      allocations: entries.map(([propertyReferenceId, numerator, denominator]) => ({
        propertyReferenceId,
        share: { numerator, denominator },
        acquisitionId: null,
      })),
      notes: null,
    });
    ctx.appendSet = async (loanId, shares, validFrom, realm = REALM) => {
      const outcome = await allocations.create(loanId, realm, manual(validFrom, shares), actor);
      if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
      return outcome.set.id;
    };
    ctx.loan = async (shares, validFrom = '2028-01-01', realm = REALM) => {
      const created = await loans.create(
        {
          mreRealmId: realm,
          lenderPartyId: await ctx.party('Bank Beispiel', realm),
          borrowerPartyIds: [await ctx.party('Anna Darlehensnehmerin', realm)],
          principalOriginal: eur('100000.00'),
          startDate: day('2026-01-01'),
          disbursementDate: null,
          maturityDate: null,
          contractNumber: null,
          acquisitionId: null,
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      const setId = shares === null ? null : await ctx.appendSet(created.loan.id, shares, validFrom, realm);
      return { loanId: created.loan.id, setId };
    };
    ctx.split = (amount, financialCategoryCode, overrides = {}) => ({
      amount: eur(amount),
      financialCategoryCode,
      propertyReferenceId: null,
      loanId: null,
      securityDepositId: null,
      description: null,
      ...overrides,
    });
    ctx.booked = async (set, bookingDate, realm = REALM) => {
      const created = await transactions.createManual(
        {
          mreRealmId: realm,
          financialAccountId: giro.get(realm) as string,
          amount: set.reduce((sum, s) => sum.add(s.amount), eur('0.00')),
          direction: 'OUTFLOW',
          bookingDate: day(bookingDate),
          valueDate: null,
          description: 'Buchung (synthetisch)',
          propertyReferenceId: null,
        },
        actor,
      );
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      const tx = created.transaction.id;
      const outcome = await splits.replaceSplits(tx, realm, set, actor);
      if (outcome.kind !== 'REPLACED') throw new Error(JSON.stringify(outcome));
      expect((await transactions.confirm(tx, realm, actor)).kind).toBe('CONFIRMED');
      const { rows } = await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [tx]);
      return { tx, splitIds: rows.map((r) => r.id as string) };
    };
    ctx.record = async (input, confirm = true) => {
      const created = await ctx.records.create(input, actor);
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      if (!confirm) return created.record;
      const confirmed = await ctx.records.confirm(created.record.id, input.mreRealmId, { reviewState: 'CONFIRMED', advisorPartyId: null }, actor);
      if (confirmed.kind !== 'CHANGED') throw new Error(confirmed.kind);
      return confirmed.record;
    };
    ctx.classify = (sourceId, overrides, realm = REALM) =>
      ctx.classifications.createClassification(
        {
          mreRealmId: realm,
          sourceType: 'TRANSACTION_SPLIT',
          sourceId,
          taxCategory: 'LOAN_INTEREST',
          treatment: 'CAPITALIZED',
          reviewState: 'USER_CONFIRMED',
          supersedes: null,
          notes: null,
          sourceReferences: [],
          ...overrides,
        },
        actor,
      );
    ctx.inTransaction = async (work) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
  });
  afterAll(async () => {
    await ctx.pool.end();
  });
  return ctx;
}
