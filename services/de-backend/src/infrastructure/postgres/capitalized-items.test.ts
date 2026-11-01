import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaxMeaning } from '../../domains/taxation/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { capitalizedItemsIn, type CapitalizedSourcesReader } from './capitalized-items.js';
import { createDatabase } from './database.js';
import { depreciationSnapshot } from './depreciation-asset-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-8-03 persistence (api-design.md §59B): the parts of a capitalised item are shared over the `VALID` Ownerships of
 * the caller's Realm only. Figures, names and texts are synthetic.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000831';
const OTHER_REALM = '64b0c0ffee00000000000832';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;

/** A split classified `CAPITALIZED` by the user, booked 2027-03-10 on the PropertyReference. */
function capitalizedSplit(propertyReferenceId: string): TaxMeaning {
  const sourceId = '0000dddd-0000-4000-8000-000000000001';
  return {
    splitId: sourceId,
    sourceId,
    sourceType: 'TRANSACTION_SPLIT',
    transactionId: '0000dddd-0000-4000-8000-000000000002',
    position: 1,
    bookingDate: day('2027-03-10'),
    direction: 'OUTFLOW',
    amount: Money.of('1000.00', 'EUR'),
    financialCategoryCode: 'MAINTENANCE',
    categoryType: 'OPERATING_EXPENSE',
    propertyReferenceId,
    transactionStatus: 'CONFIRMED',
    correctionRole: null,
    counts: true,
    taxCategory: 'MAINTENANCE',
    treatment: 'CAPITALIZED',
    reviewState: 'USER_CONFIRMED',
    origin: 'CLASSIFICATION',
    rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
    classificationId: '0000dddd-0000-4000-8000-000000000003',
    taxYear: 2027,
    attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: 2027, proposedYear: 2027, overridden: false },
    refund: null,
    netAmount: null,
    treatmentRule: null,
    distribution: null,
    suggestion: null,
    flags: [],
  };
}

describe.skipIf(databaseUrl === undefined)('capitalizedItemsIn: the Ownership query filtered by the Realm (§59B)', () => {
  // Another Realm's Ownership on this PropertyReference cannot be written while the composite foreign key holds; this
  // schema drops it, so the query without its Realm filter would read it (the mutation "the Realm filter dropped").
  const schema = testSchemaName('capitalized_items_realm_test');
  let pool: pg.Pool;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('another Realm’s Ownership on the same PropertyReference takes no part', async () => {
    const db = createDatabase(pool);
    const parties = new PostgresPartyRepository(db);
    const party = async (name: string, realm: string) => {
      const outcome = await parties.create(
        {
          mreRealmId: realm,
          partyType: 'PERSON',
          displayName: name,
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
    const a = await party('Eigentümerin A', REALM);
    const foreign = await party('Fremd', OTHER_REALM);
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5fd0831', 'ACTIVE', 'x') RETURNING id`,
      [REALM],
    );
    const pr = rows[0].id as string;
    await pool.query(`ALTER TABLE ownership DROP CONSTRAINT ownership_property_reference_fk`);
    await pool.query(`ALTER TABLE ownership DISABLE TRIGGER USER`);
    const own = async (realm: string, owner: string) =>
      (
        await pool.query(
          `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, created_by)
           VALUES ($1, $2, $3, 1, 1, '2026-07-01', 'VALID', 'x') RETURNING id`,
          [realm, pr, owner],
        )
      ).rows[0].id as string;
    const mine = await own(REALM, a);
    await own(OTHER_REALM, foreign);
    const reader: CapitalizedSourcesReader = async () => [{ meaning: capitalizedSplit(pr), anschaffungsnaheAcquisitionId: null }];
    const items = await depreciationSnapshot(db, (trx) => capitalizedItemsIn(trx, REALM, pr, day('2027-10-30'), reader));
    expect(items.map((i) => i.parts.map((p) => [p.participant, p.ownershipIds, `${p.share.numerator}/${p.share.denominator}`, p.amount.amount]))).toEqual([
      [[a, [mine], '1/1', '1000.00']],
    ]);
    expect(items[0]?.flags).toEqual([]);
  });
});
