import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './infrastructure/postgres/database.js';
import { migrateToLatest } from './infrastructure/postgres/migrate.js';
import { migrations } from './infrastructure/postgres/migrations/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { REALM, databaseUrl, useTaxYearDatabase, withMigrationLock } from './infrastructure/postgres/tax-year.test-support.js';

/**
 * Migration 0071 (VC-X-54, api-design.md §58P "Migration") past the repository: `change_kind` widened by
 * `LOAN_TERMS_PART_ADDED`, `LOAN_TERMS_PART_VOIDED`, `LOAN_CLOSED_PART`; `_kind_entity`'s `Loan` clause widened by
 * `LOAN_CLOSED_PART`, the terms kinds bound to `LoanTerms` by elimination (no clause of their own, pinned here); the
 * shape guard (the three kinds take `TRANSACTION_SPLIT` part items only), each with its counter-check; `up` (the passage
 * found exactly once), `down` refusing while an acknowledgement of a new kind exists (`ACTIVE` or `WITHDRAWN`), else
 * restoring 0067's CHECKs and function verbatim. Synthetic values only.
 */
type Outcome = string | undefined;
const ADDED = { change_kind: `'LOAN_TERMS_PART_ADDED'`, change_entity_type: `'LoanTerms'` };
const VOIDED = { change_kind: `'LOAN_TERMS_PART_VOIDED'`, change_entity_type: `'LoanTerms'` };
const CLOSED_PART = { change_kind: `'LOAN_CLOSED_PART'`, change_entity_type: `'Loan'` };
const LOAN_CLOSED = { change_kind: `'LOAN_CLOSED'`, change_entity_type: `'Loan'` };
const TERMS_ADDED = { change_kind: `'LOAN_TERMS_ADDED'`, change_entity_type: `'LoanTerms'` };
const OTHER_ENTITIES = ['RentalContractReference', 'RentPaymentReconciliation', 'LoanAllocationSet', 'SecurityDeposit', 'Transaction', 'Acquisition'];

const ackRow = (pr: string, o: Record<string, string> = {}) => {
  const v = {
    mre_realm_id: `'${REALM}'`,
    property_reference_id: `'${pr}'`,
    tax_year: '2027',
    audit_record_id: 'gen_random_uuid()',
    ...ADDED,
    change_entity_id: 'gen_random_uuid()',
    change_recorded_at: 'now()',
    change_fingerprint: `repeat('c', 64)`,
    reason: `'Grund'`,
    acknowledged_by: `'anna@example.com'`,
    status: `'ACTIVE'`,
    ...o,
  };
  return `INSERT INTO tax_year_acknowledgement (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')}) RETURNING id`;
};
const yearRow = (before: string, after: string) => `INSERT INTO tax_year_acknowledgement_item VALUES ($1, '${REALM}', gen_random_uuid(), ${before}, ${after})`;
const partRow = (o: Record<string, string> = {}) => {
  const v = {
    acknowledgement_id: '$1',
    mre_realm_id: `'${REALM}'`,
    source_type: `'TRANSACTION_SPLIT'`,
    source_id: 'gen_random_uuid()',
    tax_year: '2027',
    state_before: `'ATTRIBUTED'`,
    part_before: '450.00',
    state_after: `'ATTRIBUTED'`,
    part_after: '745.00',
    ...o,
  };
  return `INSERT INTO tax_year_acknowledgement_part_item (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')})`;
};
const classify = (e: { code?: string; message?: string }): Outcome =>
  e.code === '23514' ? 'check' : e.code === '23502' ? 'not-null' : /api-design §58[EGHIN]/.test(e.message ?? '') ? 'guard' : e.code;

describe.skipIf(databaseUrl === undefined)('the schema of 0071 past the repository (§58P)', () => {
  const { ctx, propertyReference } = useTaxYearDatabase('tax_statement_loan_schedule_schema_test');
  const outcome = async (statement: string): Promise<Outcome> => ctx.pool.query(statement).then(() => 'accepted', classify);
  async function inOwnTransaction(statement: string, ack: Record<string, string>): Promise<Outcome> {
    const pr = await propertyReference();
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      const id = (await client.query(ackRow(pr, ack))).rows[0].id as string;
      return await client.query(statement, [id]).then(() => 'accepted', classify);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('the three kinds with their entities accepted; LOAN_CLOSED with Loan still accepted; an unknown kind refused', async () => {
    const pr = await propertyReference();
    for (const row of [ADDED, VOIDED, CLOSED_PART, LOAN_CLOSED, TERMS_ADDED]) expect(await outcome(ackRow(pr, row)), row.change_kind).toBe('accepted');
    expect(await outcome(ackRow(pr, { change_kind: `'LOAN_SCHEDULE_PART_CHANGED'`, change_entity_type: `'LoanTerms'` }))).toBe('check');
    expect(await outcome(ackRow(pr, { change_kind: `'LOAN_TERMS_PART_CHANGED'`, change_entity_type: `'LoanTerms'` }))).toBe('check');
  });

  it('the elimination pinned: the terms kinds only on LoanTerms, LOAN_CLOSED_PART only on Loan; counter-check above', async () => {
    const pr = await propertyReference();
    for (const kind of [ADDED, VOIDED]) {
      for (const entity of ['Loan', ...OTHER_ENTITIES]) {
        expect(await outcome(ackRow(pr, { ...kind, change_entity_type: `'${entity}'` })), `${kind.change_kind} on ${entity}`).toBe('check');
      }
    }
    for (const entity of ['LoanTerms', ...OTHER_ENTITIES]) {
      expect(await outcome(ackRow(pr, { ...CLOSED_PART, change_entity_type: `'${entity}'` })), `LOAN_CLOSED_PART on ${entity}`).toBe('check');
    }
    // LoanTerms with any other kind, and Loan with a terms kind.
    for (const kind of ['LOAN_CLOSED', 'LOAN_ALLOCATION_SET_ADDED', 'TRANSACTION_CORRECTED', 'DEPOSIT_RECONCILIATION_CONFIRMED']) {
      expect(await outcome(ackRow(pr, { change_kind: `'${kind}'`, change_entity_type: `'LoanTerms'` })), `LoanTerms with ${kind}`).toBe('check');
    }
  });

  it('the shape guard: TRANSACTION_SPLIT part items under each new kind accepted; a DEPOSIT_CLOSING part item and a year item refused; counter-check: a year item under LOAN_TERMS_ADDED', async () => {
    for (const kind of [ADDED, VOIDED, CLOSED_PART]) {
      expect(await inOwnTransaction(partRow(), kind), kind.change_kind).toBe('accepted');
      expect(await inOwnTransaction(partRow({ state_before: `'NONE'`, part_before: 'NULL', state_after: `'ATTRIBUTED'`, part_after: '190.00' }), kind)).toBe(
        'accepted',
      );
      expect(await inOwnTransaction(partRow({ source_type: `'DEPOSIT_CLOSING'` }), kind), `${kind.change_kind} deposit`).toBe('guard');
      expect(await inOwnTransaction(yearRow('2027', '2028'), kind), `${kind.change_kind} year item`).toBe('guard');
    }
    expect(await inOwnTransaction(yearRow('2027', '2028'), TERMS_ADDED)).toBe('accepted');
    expect(await inOwnTransaction(partRow(), TERMS_ADDED)).toBe('guard');
    expect(await inOwnTransaction(yearRow('2027', '2028'), LOAN_CLOSED)).toBe('accepted');
  });

  it(
    'up patches the guard once (refused when the passage is missing); down refused with an ACTIVE or a WITHDRAWN acknowledgement of a new kind, else 0067 s CHECKs and function verbatim, then up again',
    { timeout: 60_000 },
    async () => {
      const downSchema = testSchemaName('tax_statement_loan_schedule_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      try {
        const defs = async () => {
          const fn = (await downPool.query(`SELECT pg_get_functiondef('tax_year_acknowledgement_item_shape()'::regprocedure) AS d`)).rows[0].d as string;
          const { rows } = await downPool.query(
            `SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'tax_year_acknowledgement'::regclass AND contype = 'c' ORDER BY conname`,
          );
          return [fn, ...rows.map((r) => `${r.conname}: ${r.d}`)];
        };
        // The schema before 0071: every migration up to 0070.
        const upTo0070 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '0071'));
        await migrateToLatest(downPool, { migrationTableSchema: downSchema, migrations: upTo0070 });
        const before = await defs();
        expect(before.join('\n')).not.toContain('LOAN_CLOSED_PART');
        // The schema up to 0071 only: 0072 (VC-X-55) widens the same CHECKs and patches the same guard after 0071.
        const upTo0071 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '0072'));
        await migrateToLatest(downPool, { migrationTableSchema: downSchema, migrations: upTo0071 });
        const after = await defs();
        expect(after).not.toEqual(before);
        expect(after[0]).toContain(`'TRANSACTION_REVERSED', 'LOAN_TERMS_PART_ADDED', 'LOAN_TERMS_PART_VOIDED', 'LOAN_CLOSED_PART'`);
        const migration = migrations['0071_tax_year_loan_schedule_part_kinds'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
        const db = () => createDatabase(downPool) as never;
        // up on the patched function: the passage of 0065 is gone, the migration fails and changes nothing.
        let again: unknown;
        await withMigrationLock(async () => {
          again = await migration.up(db()).catch((e: unknown) => e);
        });
        expect(String(again)).toContain('holds the passage to replace 0 times, expected once');
        expect(await defs()).toEqual(after);
        const pr = (
          await downPool.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f6e71f', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          )
        ).rows[0].id as string;
        const refusedWith = async () => {
          let refused: unknown;
          await withMigrationLock(async () => {
            refused = await migration.down(db()).catch((e: unknown) => e);
          });
          return refused;
        };
        const clear = async () => {
          await downPool.query(`ALTER TABLE tax_year_acknowledgement DISABLE TRIGGER USER`);
          await downPool.query(`DELETE FROM tax_year_acknowledgement`);
          await downPool.query(`ALTER TABLE tax_year_acknowledgement ENABLE TRIGGER USER`);
        };
        for (const row of [ADDED, VOIDED, CLOSED_PART]) {
          await downPool.query(ackRow(pr, row));
          expect(await refusedWith(), row.change_kind).toMatchObject({ code: '23514' });
          expect(await defs()).toEqual(after);
          await clear();
        }
        // Withdrawn (the statement stays stored): refused too.
        const withdrawn = (await downPool.query(ackRow(pr, CLOSED_PART))).rows[0].id as string;
        await downPool.query(
          `UPDATE tax_year_acknowledgement SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_by = 'anna@example.com', withdraw_reason = 'Irrtum', version = 2 WHERE id = $1`,
          [withdrawn],
        );
        expect(await refusedWith()).toMatchObject({ code: '23514' });
        expect(await defs()).toEqual(after);
        // Counter-check: only a year kind's acknowledgement left, down runs and restores 0067's state verbatim.
        await clear();
        await downPool.query(ackRow(pr, TERMS_ADDED));
        await withMigrationLock(() => migration.down(db()));
        expect(await defs()).toEqual(before);
        expect(await downPool.query(ackRow(pr, CLOSED_PART)).then(() => 'accepted', classify)).toBe('check');
        // up again: the three kinds back.
        await withMigrationLock(() => migration.up(db()));
        expect(await defs()).toEqual(after);
        expect(await downPool.query(ackRow(pr, CLOSED_PART)).then(() => 'accepted', classify)).toBe('accepted');
      } finally {
        await downPool.end();
      }
    },
  );
});
