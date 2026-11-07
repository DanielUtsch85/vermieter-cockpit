import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './infrastructure/postgres/database.js';
import { migrateToLatest } from './infrastructure/postgres/migrate.js';
import { migrations } from './infrastructure/postgres/migrations/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { OTHER_REALM, REALM, databaseUrl, useTaxYearDatabase, withMigrationLock } from './infrastructure/postgres/tax-year.test-support.js';

/**
 * Migration 0063 (VC-X-48, api-design.md §58G "In the database") past the repository: the widened CHECKs of
 * `tax_year_acknowledgement`, the part item table's CHECKs, the append-only guard and the shape guard on both item
 * tables, each with its counter-check; `up`, `down`, and `down` refusing while a part acknowledgement exists.
 */
type Outcome = string | undefined;
const PART = `'LOAN_ALLOCATION_SET_ADDED'`;

/** An acknowledgement row as SQL: a part kind on a set unless overridden. */
const ackRow = (pr: string, o: Record<string, string> = {}) => {
  const v = {
    mre_realm_id: `'${REALM}'`,
    property_reference_id: `'${pr}'`,
    tax_year: '2027',
    audit_record_id: 'gen_random_uuid()',
    change_kind: PART,
    change_entity_type: `'LoanAllocationSet'`,
    change_entity_id: 'gen_random_uuid()',
    change_recorded_at: 'now()',
    change_fingerprint: `repeat('a', 64)`,
    reason: `'Grund'`,
    acknowledged_by: `'anna@example.com'`,
    status: `'ACTIVE'`,
    ...o,
  };
  return `INSERT INTO tax_year_acknowledgement (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')}) RETURNING id`;
};
/** A part item as SQL for acknowledgement `$1`, valid (ATTRIBUTED 269.99 → ATTRIBUTED 225.00) unless overridden. */
const partRow = (o: Record<string, string> = {}) => {
  const v = {
    acknowledgement_id: '$1',
    mre_realm_id: `'${REALM}'`,
    source_type: `'TRANSACTION_SPLIT'`,
    source_id: 'gen_random_uuid()',
    tax_year: '2027',
    state_before: `'ATTRIBUTED'`,
    part_before: '269.99',
    state_after: `'ATTRIBUTED'`,
    part_after: '225.00',
    ...o,
  };
  return `INSERT INTO tax_year_acknowledgement_part_item (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')})`;
};
const yearRow = `INSERT INTO tax_year_acknowledgement_item VALUES ($1, '${REALM}', gen_random_uuid(), 2027, 2028)`;
const classify = (e: { code?: string; message?: string }): Outcome =>
  e.code === '23505' ? 'duplicate' : e.code === '23514' ? 'check' : /api-design §58[EG]/.test(e.message ?? '') ? 'guard' : e.code;

describe.skipIf(databaseUrl === undefined)('the schema of 0063 past the repository (§58G)', () => {
  const { ctx, propertyReference } = useTaxYearDatabase('tax_statement_part_schema_test');
  const outcome = async (sql: string, params: unknown[] = []): Promise<Outcome> => ctx.pool.query(sql, params).then(() => 'accepted', classify);
  /** Each statement inside one transaction with a fresh acknowledgement (`$1`), rolled back: the item checks alone. */
  async function inOwnTransaction(statement: string, ack: Record<string, string> = {}): Promise<Outcome> {
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

  it('tax_year_acknowledgement: the part kinds only on LoanAllocationSet, LoanAllocationSet only with a part kind; counter-check: the valid rows', async () => {
    const pr = await propertyReference();
    expect(await outcome(ackRow(pr, { change_entity_type: `'LoanTerms'` }))).toBe('check');
    expect(await outcome(ackRow(pr, { change_entity_type: `'RentPaymentReconciliation'` }))).toBe('check');
    expect(await outcome(ackRow(pr, { change_kind: `'LOAN_TERMS_ADDED'` }))).toBe('check');
    expect(await outcome(ackRow(pr, { change_kind: `'RECONCILIATION_CONFIRMED'` }))).toBe('check');
    expect(await outcome(ackRow(pr, { change_entity_type: `'Loan'` }))).toBe('check');
    expect(await outcome(ackRow(pr, { change_kind: `'LOAN_ALLOCATION_SET_CHANGED'` }))).toBe('check');
    // Counter-checks: both part kinds on a set; the year kinds as 0060 had them.
    expect(await outcome(ackRow(pr))).toBe('accepted');
    expect(await outcome(ackRow(pr, { change_kind: `'LOAN_ALLOCATION_SET_VOIDED'` }))).toBe('accepted');
    expect(await outcome(ackRow(pr, { change_kind: `'LOAN_TERMS_VOIDED'`, change_entity_type: `'LoanTerms'` }))).toBe('accepted');
    expect(await outcome(ackRow(pr, { change_kind: `'RECONCILIATION_RELEASED'`, change_entity_type: `'RentPaymentReconciliation'` }))).toBe('accepted');
  });

  it('a part item: a part exactly on ATTRIBUTED, moved, not between NOT_ATTRIBUTED and NONE, scale 2 and not negative; counter-check: each step that moves', async () => {
    const refused: [string, Record<string, string>][] = [
      ['NOT_ATTRIBUTED with a part', { state_after: `'NOT_ATTRIBUTED'` }],
      ['ATTRIBUTED without a part', { part_after: 'NULL' }],
      ['NONE with a part', { state_before: `'NONE'` }],
      ['unmoved', { part_after: '269.99' }],
      ['unmoved at another scale', { part_after: '269.990' }],
      ['NOT_ATTRIBUTED to NONE', { state_before: `'NOT_ATTRIBUTED'`, part_before: 'NULL', state_after: `'NONE'`, part_after: 'NULL' }],
      ['NONE to NOT_ATTRIBUTED', { state_before: `'NONE'`, part_before: 'NULL', state_after: `'NOT_ATTRIBUTED'`, part_after: 'NULL' }],
      ['NONE to NONE', { state_before: `'NONE'`, part_before: 'NULL', state_after: `'NONE'`, part_after: 'NULL' }],
      ['a negative part', { part_after: '-1.00' }],
      ['three decimals', { part_after: '225.001' }],
      // DEPOSIT_CLOSING (0064, §58H) under a set kind is the shape guard's: tax-statement-further-schema.test.ts.
      ['another source type', { source_type: `'WEG_RESERVE_WITHDRAWAL'` }],
      ['a year outside', { tax_year: '1999' }],
      ['an unknown state', { state_after: `'PARTLY'` }],
    ];
    for (const [name, o] of refused) expect(await inOwnTransaction(partRow(o)), name).toBe('check');
    expect(await inOwnTransaction(partRow({ mre_realm_id: `'${OTHER_REALM}'` }))).toBe('23503');
    const accepted: [string, Record<string, string>][] = [
      ['ATTRIBUTED to ATTRIBUTED, another amount', {}],
      ['a one-cent move', { part_after: '269.98' }],
      ['ATTRIBUTED to NONE', { state_after: `'NONE'`, part_after: 'NULL' }],
      ['ATTRIBUTED to NOT_ATTRIBUTED', { state_after: `'NOT_ATTRIBUTED'`, part_after: 'NULL' }],
      ['NOT_ATTRIBUTED to ATTRIBUTED', { state_before: `'NOT_ATTRIBUTED'`, part_before: 'NULL' }],
      ['NONE to ATTRIBUTED, zero', { state_before: `'NONE'`, part_before: 'NULL', part_after: '0.00' }],
    ];
    for (const [name, o] of accepted) expect(await inOwnTransaction(partRow(o)), name).toBe('accepted');
  });

  it('the shape guard on both item tables: no part item under a year kind, no year item under a part kind; counter-check: each in its shape', async () => {
    const yearKind = { change_kind: `'RECONCILIATION_CONFIRMED'`, change_entity_type: `'RentPaymentReconciliation'` };
    expect(await inOwnTransaction(partRow(), yearKind)).toBe('guard');
    expect(await inOwnTransaction(yearRow)).toBe('guard');
    expect(await inOwnTransaction(yearRow, { change_kind: `'LOAN_ALLOCATION_SET_VOIDED'` })).toBe('guard');
    expect(await inOwnTransaction(partRow(), { change_kind: `'LOAN_TERMS_ADDED'`, change_entity_type: `'LoanTerms'` })).toBe('guard');
    expect(await inOwnTransaction(partRow())).toBe('accepted');
    expect(await inOwnTransaction(partRow(), { change_kind: `'LOAN_ALLOCATION_SET_VOIDED'` })).toBe('accepted');
    expect(await inOwnTransaction(yearRow, yearKind)).toBe('accepted');
  });

  it('part items only in the transaction of their acknowledgement, never changed or deleted; counter-check: in the same transaction', async () => {
    const pr = await propertyReference();
    const client = await ctx.pool.connect();
    let id = '';
    try {
      await client.query('BEGIN');
      id = (await client.query(ackRow(pr))).rows[0].id as string;
      await client.query(partRow(), [id]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(Number((await ctx.pool.query(`SELECT count(*) AS n FROM tax_year_acknowledgement_part_item WHERE acknowledgement_id = $1`, [id])).rows[0].n)).toBe(
      1,
    );
    expect(await outcome(partRow(), [id])).toBe('guard');
    expect(await outcome(`UPDATE tax_year_acknowledgement_part_item SET part_after = 224.00 WHERE acknowledgement_id = $1`, [id])).toBe('guard');
    expect(await outcome(`DELETE FROM tax_year_acknowledgement_part_item WHERE acknowledgement_id = $1`, [id])).toBe('guard');
    // One item per source of an acknowledgement (the key); counter-check: another source.
    const second = await ctx.pool.connect();
    try {
      await second.query('BEGIN');
      const other = (await second.query(ackRow(pr))).rows[0].id as string;
      const fixed = partRow({ source_id: `'00000000-0000-4000-8000-000000000048'` });
      await second.query(fixed, [other]);
      await second.query(partRow(), [other]);
      expect(await second.query(fixed, [other]).then(() => 'accepted', classify)).toBe('duplicate');
    } finally {
      await second.query('ROLLBACK');
      second.release();
    }
    // Never changed or deleted, not even in the transaction that recorded them (the txid check alone would let it).
    for (const statement of [
      `UPDATE tax_year_acknowledgement_part_item SET part_after = 224.00 WHERE acknowledgement_id = $1`,
      `DELETE FROM tax_year_acknowledgement_part_item WHERE acknowledgement_id = $1`,
    ]) {
      const third = await ctx.pool.connect();
      try {
        await third.query('BEGIN');
        const own = (await third.query(ackRow(pr))).rows[0].id as string;
        await third.query(partRow(), [own]);
        expect(await third.query(statement, [own]).then(() => 'accepted', classify), statement).toBe('guard');
      } finally {
        await third.query('ROLLBACK');
        third.release();
      }
    }
  });

  it(
    'up and down under MIGRATION_ADVISORY_LOCK: down refused with a part item or a part kind present, else drops the table and its functions and restores the CHECKs',
    { timeout: 90_000 },
    async () => {
      const downSchema = testSchemaName('tax_statement_part_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        const migration = migrations['0063_tax_year_part_acknowledgements'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
        // 0064 (VC-X-49) widens 0063's CHECKs and guard: rolled back first, as the Migrator would, and applied again below.
        const further = migrations['0064_tax_year_further_inputs'] as typeof migration;
        // 0065 (VC-X-50) builds on 0064: its own down first.
        const movers = migrations['0065_tax_year_deposit_and_correction_movers'] as typeof migration;
        const db = () => createDatabase(downPool) as never;
        const loanParts = migrations['0071_tax_year_loan_schedule_part_kinds'] as typeof migration;
        // 0071 (VC-X-54) widens these CHECKs and patches the shape guard after them: its own down first, up again at the end.
        // 0073 (VC-X-57) patches 0072's passages of acquisition_frozen and 0050's functions: rolled back before 0072, not applied again.
        // 0074 (VC-X-12, an index only) sorts after 0073: its own down first, not applied again.
        // 0075 (VC-X-44, land_building_allocation only) sorts after 0074: its own down first, not applied again.
        // 0076 (VC-X-24, audit_record only) sorts after 0075: its own down first, not applied again.
        await withMigrationLock(() => (migrations['0076_audit_record_pseudonymisation'] as typeof migration).down(db()));
        await withMigrationLock(() => (migrations['0075_land_building_allocation_plausibility'] as typeof migration).down(db()));
        await withMigrationLock(() => (migrations['0074_idempotency_key_retention'] as typeof migration).down(db()));
        await withMigrationLock(() => (migrations['0073_ownership_start_on_confirm'] as typeof migration).down(db()));
        // 0072 (VC-X-55) widens the same CHECKs and patches 0067's passage of the shape guard after 0071: rolled back first.
        // It is not applied again below: 0065's up writes its own shape guard, without 0067's passage that 0072 patches.
        await withMigrationLock(() => (migrations['0072_ownership_extend_to_economic_transfer'] as typeof migration).down(db()));
        await withMigrationLock(() => loanParts.down(db()));
        await withMigrationLock(() => movers.down(db()));
        await withMigrationLock(() => further.down(db()));
        const table = async () =>
          Number(
            (
              await downPool.query(
                `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'tax_year_acknowledgement_part_item'`,
                [downSchema],
              )
            ).rows[0].n,
          );
        const pr = (
          await downPool.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f6e48f', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          )
        ).rows[0].id as string;
        const client = await downPool.connect();
        try {
          await client.query('BEGIN');
          const id = (await client.query(ackRow(pr))).rows[0].id as string;
          await client.query(partRow(), [id]);
          await client.query('COMMIT');
        } finally {
          client.release();
        }
        const refusedWith = async () => {
          let refused: unknown;
          await withMigrationLock(async () => {
            refused = await migration.down(db()).catch((e: unknown) => e);
          });
          return refused;
        };
        expect(await refusedWith()).toMatchObject({ code: '23514' });
        expect(await table()).toBe(1);
        // The part item gone, its acknowledgement of a part kind still there: refused too.
        await downPool.query(`ALTER TABLE tax_year_acknowledgement_part_item DISABLE TRIGGER USER`);
        await downPool.query(`DELETE FROM tax_year_acknowledgement_part_item`);
        expect(await refusedWith()).toMatchObject({ code: '23514' });
        // Counter-check: only a year acknowledgement left, down runs.
        await downPool.query(`ALTER TABLE tax_year_acknowledgement DISABLE TRIGGER USER`);
        await downPool.query(`DELETE FROM tax_year_acknowledgement`);
        await downPool.query(`ALTER TABLE tax_year_acknowledgement ENABLE TRIGGER USER`);
        await downPool.query(ackRow(pr, { change_kind: `'LOAN_TERMS_ADDED'`, change_entity_type: `'LoanTerms'` }));
        await withMigrationLock(() => migration.down(db()));
        expect(await table()).toBe(0);
        const functions = await downPool.query(
          `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = $1 AND proname IN ('tax_year_acknowledgement_part_item_append_only', 'tax_year_acknowledgement_item_shape')`,
          [downSchema],
        );
        expect(functions.rows).toEqual([]);
        // 0060's CHECKs again: a part kind refused.
        const restored = await downPool.query(ackRow(pr)).then(() => 'accepted', classify);
        expect(restored).toBe('check');
        await withMigrationLock(() => migration.up(db()));
        await withMigrationLock(() => further.up(db()));
        await withMigrationLock(() => movers.up(db()));
        await withMigrationLock(() => loanParts.up(db()));
        expect(await table()).toBe(1);
        expect(await downPool.query(ackRow(pr)).then(() => 'accepted', classify)).toBe('accepted');
      } finally {
        await downPool.end();
      }
    },
  );
});
