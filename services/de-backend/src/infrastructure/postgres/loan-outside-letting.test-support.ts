import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import type { Loan } from '../../domains/financing/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresLoanAllocationRepository } from './loan-allocation-repository.js';
import { PostgresLoanDebtRepository } from './loan-debt-repository.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * The shared setup of §58V's database tests (VC-X-43, migration 0077): one migrated schema per test file, a Loan (debt
 * from 2027-01-01) and PropertyReferences per call, the evidence of the section's example. Figures, names and texts are
 * synthetic. Test support only.
 */
export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
export const REALM = '64b0c0ffee0000000000430a';
export const OTHER_REALM = '64b0c0ffee0000000000430b';
export const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
export const day = (value: string) => value as BusinessDate;
export const f = (n: bigint, d: bigint) => ({ numerator: n, denominator: d });
export const EVIDENCE = ['Auszahlungsbeleg der Bank vom 2027-01-04 (synthetisch)', 'Kaufvertrag Pkw vom 2027-01-05 (synthetisch)'];

export interface OutsideLettingContext {
  pool: pg.Pool;
  loans: PostgresLoanRepository;
  allocations: PostgresLoanAllocationRepository;
  debt: PostgresLoanDebtRepository;
}

export async function createSchema(name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${name}"`);
  await admin.end();
}

/** Registers the schema's `beforeAll`/`afterAll` in the calling `describe` and returns the context and the helpers. */
export function useOutsideLettingDatabase(name: `${string}_test`) {
  const schema = testSchemaName(name);
  const ctx = {} as OutsideLettingContext;
  let parties: PostgresPartyRepository;
  let counter = 0;

  beforeAll(async () => {
    await createSchema(schema);
    ctx.pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
    await migrateToLatest(ctx.pool, { migrationTableSchema: schema });
    const db = createDatabase(ctx.pool);
    parties = new PostgresPartyRepository(db);
    ctx.loans = new PostgresLoanRepository(db);
    ctx.allocations = new PostgresLoanAllocationRepository(db);
    ctx.debt = new PostgresLoanDebtRepository(db);
  });

  afterAll(async () => {
    await ctx.pool.end();
  });

  async function party(displayName: string, realm: string): Promise<string> {
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
  }

  async function loan(realm = REALM, principal = '200000.00'): Promise<Loan> {
    const outcome = await ctx.loans.create(
      {
        mreRealmId: realm,
        lenderPartyId: await party('Bank Beispiel', realm),
        borrowerPartyIds: [await party('Anna Beispiel', realm)],
        principalOriginal: Money.of(principal, 'EUR'),
        startDate: day('2027-01-01'),
        disbursementDate: null,
        maturityDate: null,
        contractNumber: null,
        acquisitionId: null,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.loan;
  }

  /** PropertyReferences of the Realm, sorted by id (P1 < P2 as in §58V's example). */
  async function properties(count: number, realm = REALM): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const mrePropertyId = (0x6512f0c2a1b2c3d4e5f43000n + BigInt(++counter)).toString(16).padStart(24, '0');
      const { rows } = await ctx.pool.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
        [realm, mrePropertyId],
      );
      ids.push(rows[0].id as string);
    }
    return ids.sort();
  }

  async function acquisition(propertyReferenceId: string, realm = REALM): Promise<string> {
    const { rows } = await ctx.pool.query(
      `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, economic_transfer_date, created_by)
       VALUES ($1, $2, 'DRAFT', 300000, 'EUR', 1, 1, '2026-06-15', '2026-06-15', 'x') RETURNING id`,
      [realm, propertyReferenceId],
    );
    return rows[0].id as string;
  }

  return { ctx, loan, properties, acquisition };
}
