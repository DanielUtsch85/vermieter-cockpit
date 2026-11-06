import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './infrastructure/postgres/database.js';
import { migrateToLatest } from './infrastructure/postgres/migrate.js';
import { migrations } from './infrastructure/postgres/migrations/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { REALM, databaseUrl, useTaxYearDatabase, withMigrationLock } from './infrastructure/postgres/tax-year.test-support.js';

/**
 * Migration 0064 (VC-X-49, api-design.md §58H "In the database") past the repository: `change_kind`, `change_entity_type`
 * and `_kind_entity` widened by `LOAN_CLOSED` on `Loan` and the deposit kinds on `RentPaymentReconciliation`; the part
 * item's `source_type` widened by `DEPOSIT_CLOSING`; the shape guard (`LOAN_CLOSED` year items only, the deposit kinds
 * part items only, a part item's `source_type` its kind's), each with its counter-check; `up`, `down`, and `down`
 * refusing while an acknowledgement of a new kind or a `DEPOSIT_CLOSING` item exists. Synthetic values only.
 */
type Outcome = string | undefined;
const DEPOSIT = { change_kind: `'DEPOSIT_RECONCILIATION_CONFIRMED'`, change_entity_type: `'RentPaymentReconciliation'` };
const CLOSED = { change_kind: `'LOAN_CLOSED'`, change_entity_type: `'Loan'` };
const SET = { change_kind: `'LOAN_ALLOCATION_SET_ADDED'`, change_entity_type: `'LoanAllocationSet'` };

/** An acknowledgement row as SQL: a deposit kind unless overridden. */
const ackRow = (pr: string, o: Record<string, string> = {}) => {
  const v = {
    mre_realm_id: `'${REALM}'`,
    property_reference_id: `'${pr}'`,
    tax_year: '2027',
    audit_record_id: 'gen_random_uuid()',
    ...DEPOSIT,
    change_entity_id: 'gen_random_uuid()',
    change_recorded_at: 'now()',
    change_fingerprint: `repeat('b', 64)`,
    reason: `'Grund'`,
    acknowledged_by: `'anna@example.com'`,
    status: `'ACTIVE'`,
    ...o,
  };
  return `INSERT INTO tax_year_acknowledgement (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')}) RETURNING id`;
};
/** A deposit part item for acknowledgement `$1` (ATTRIBUTED 300.00 → NOT_ATTRIBUTED) unless overridden. */
const partRow = (o: Record<string, string> = {}) => {
  const v = {
    acknowledgement_id: '$1',
    mre_realm_id: `'${REALM}'`,
    source_type: `'DEPOSIT_CLOSING'`,
    source_id: 'gen_random_uuid()',
    tax_year: '2027',
    state_before: `'ATTRIBUTED'`,
    part_before: '300.00',
    state_after: `'NOT_ATTRIBUTED'`,
    part_after: 'NULL',
    ...o,
  };
  return `INSERT INTO tax_year_acknowledgement_part_item (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')})`;
};
const yearRow = `INSERT INTO tax_year_acknowledgement_item VALUES ($1, '${REALM}', gen_random_uuid(), 2027, 2028)`;
const classify = (e: { code?: string; message?: string }): Outcome =>
  e.code === '23505' ? 'duplicate' : e.code === '23514' ? 'check' : /api-design §58[EGH]/.test(e.message ?? '') ? 'guard' : e.code;

describe.skipIf(databaseUrl === undefined)('the schema of 0064 past the repository (§58H)', () => {
  const { ctx, propertyReference } = useTaxYearDatabase('tax_statement_further_schema_test');
  const outcome = async (sql: string): Promise<Outcome> => ctx.pool.query(sql).then(() => 'accepted', classify);
  /** The statement inside one transaction with a fresh acknowledgement (`$1`), rolled back: the item checks alone. */
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

  it('LOAN_CLOSED only on Loan, Loan only with LOAN_CLOSED; counter-check: the valid row and the kinds of 0063', async () => {
    const pr = await propertyReference();
    for (const [name, row] of [
      ['LOAN_CLOSED on LoanTerms', { ...CLOSED, change_entity_type: `'LoanTerms'` }],
      ['LOAN_CLOSED on LoanAllocationSet', { ...CLOSED, change_entity_type: `'LoanAllocationSet'` }],
      ['LOAN_CLOSED on RentPaymentReconciliation', { ...CLOSED, change_entity_type: `'RentPaymentReconciliation'` }],
      ['Loan with LOAN_TERMS_ADDED', { ...CLOSED, change_kind: `'LOAN_TERMS_ADDED'` }],
      ['Loan with LOAN_ALLOCATION_SET_ADDED', { ...CLOSED, change_kind: `'LOAN_ALLOCATION_SET_ADDED'` }],
      ['Loan with a deposit kind', { ...CLOSED, change_kind: `'DEPOSIT_RECONCILIATION_RELEASED'` }],
    ] as const) {
      expect(await outcome(ackRow(pr, row)), name).toBe('check');
    }
    expect(await outcome(ackRow(pr, CLOSED))).toBe('accepted');
    expect(await outcome(ackRow(pr, SET))).toBe('accepted');
    expect(await outcome(ackRow(pr, { change_kind: `'LOAN_TERMS_VOIDED'`, change_entity_type: `'LoanTerms'` }))).toBe('accepted');
  });

  it('the deposit kinds only on RentPaymentReconciliation (with its year kinds); no WEG plan kind; counter-check: all four kinds on it', async () => {
    const pr = await propertyReference();
    for (const [name, row] of [
      ['a deposit kind on LoanAllocationSet', { ...DEPOSIT, change_entity_type: `'LoanAllocationSet'` }],
      ['a deposit kind on Loan', { ...DEPOSIT, change_entity_type: `'Loan'` }],
      ['a deposit kind on LoanTerms', { ...DEPOSIT, change_entity_type: `'LoanTerms'` }],
      ['a deposit kind on RentalContractReference', { change_kind: `'DEPOSIT_RECONCILIATION_RELEASED'`, change_entity_type: `'RentalContractReference'` }],
      ['a WEG plan kind (§58H Frage 1)', { change_kind: `'WEG_ECONOMIC_PLAN_ADDED'`, change_entity_type: `'RentPaymentReconciliation'` }],
      ['a WEG plan entity', { change_kind: `'LOAN_CLOSED'`, change_entity_type: `'WegEconomicPlan'` }],
      ['an unknown kind', { change_kind: `'DEPOSIT_CLOSED'` }],
    ] as const) {
      expect(await outcome(ackRow(pr, row)), name).toBe('check');
    }
    for (const kind of ['RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', 'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED']) {
      expect(await outcome(ackRow(pr, { change_kind: `'${kind}'` })), kind).toBe('accepted');
    }
  });

  it('the shape guard: LOAN_CLOSED year items only, the deposit kinds part items only; counter-check: each in its shape', async () => {
    expect(await inOwnTransaction(partRow(), CLOSED)).toBe('guard');
    expect(await inOwnTransaction(partRow({ source_type: `'TRANSACTION_SPLIT'` }), CLOSED)).toBe('guard');
    expect(await inOwnTransaction(yearRow, DEPOSIT)).toBe('guard');
    expect(await inOwnTransaction(yearRow, { change_kind: `'DEPOSIT_RECONCILIATION_RELEASED'` })).toBe('guard');
    expect(await inOwnTransaction(yearRow, CLOSED)).toBe('accepted');
    expect(await inOwnTransaction(partRow(), DEPOSIT)).toBe('accepted');
    expect(await inOwnTransaction(partRow(), { change_kind: `'DEPOSIT_RECONCILIATION_RELEASED'` })).toBe('accepted');
    // The year kinds of RentPaymentReconciliation keep their year items.
    expect(await inOwnTransaction(yearRow, { change_kind: `'RECONCILIATION_CONFIRMED'` })).toBe('accepted');
    expect(await inOwnTransaction(partRow(), { change_kind: `'RECONCILIATION_CONFIRMED'` })).toBe('guard');
  });

  it('a part item s source_type is its kind s: DEPOSIT_CLOSING under a deposit kind only, TRANSACTION_SPLIT under a set kind only; counter-check: each under its own', async () => {
    const split = { source_type: `'TRANSACTION_SPLIT'` };
    expect(await inOwnTransaction(partRow(), SET)).toBe('guard');
    expect(await inOwnTransaction(partRow(split), DEPOSIT)).toBe('guard');
    expect(await inOwnTransaction(partRow(split), { change_kind: `'DEPOSIT_RECONCILIATION_RELEASED'` })).toBe('guard');
    expect(await inOwnTransaction(partRow({ source_type: `'WEG_RESERVE_WITHDRAWAL'` }), DEPOSIT)).toBe('guard');
    expect(await inOwnTransaction(partRow({ source_type: `'WEG_RESERVE_WITHDRAWAL'` }), SET)).toBe('check');
    expect(await inOwnTransaction(partRow(), DEPOSIT)).toBe('accepted');
    expect(await inOwnTransaction(partRow({ ...split, state_after: `'ATTRIBUTED'`, part_after: '225.00' }), SET)).toBe('accepted');
  });

  it('0063 s item CHECKs hold for a deposit item; counter-check: each step that moves', async () => {
    for (const [name, o] of [
      ['NOT_ATTRIBUTED with a part', { part_after: '300.00' }],
      ['ATTRIBUTED without a part', { part_before: 'NULL' }],
      ['NOT_ATTRIBUTED to NONE', { state_before: `'NOT_ATTRIBUTED'`, part_before: 'NULL', state_after: `'NONE'` }],
      ['NONE to NOT_ATTRIBUTED', { state_before: `'NONE'`, part_before: 'NULL' }],
      ['unmoved', { state_after: `'ATTRIBUTED'`, part_after: '300.00' }],
      ['a negative part', { part_before: '-300.00' }],
    ] as const) {
      expect(await inOwnTransaction(partRow(o)), name).toBe('check');
    }
    for (const [name, o] of [
      ['ATTRIBUTED to NOT_ATTRIBUTED', {}],
      ['NOT_ATTRIBUTED to ATTRIBUTED', { state_before: `'NOT_ATTRIBUTED'`, part_before: 'NULL', state_after: `'ATTRIBUTED'`, part_after: '300.00' }],
      ['ATTRIBUTED to NONE', { state_after: `'NONE'` }],
    ] as const) {
      expect(await inOwnTransaction(partRow(o)), name).toBe('accepted');
    }
  });

  it(
    'up and down under MIGRATION_ADVISORY_LOCK: down refused with a DEPOSIT_CLOSING item or a kind of §58H, else restores 0063 s CHECKs and guard',
    { timeout: 30_000 },
    async () => {
      const downSchema = testSchemaName('tax_statement_further_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        const migration = migrations['0064_tax_year_further_inputs'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
        // 0065 (VC-X-50) builds on 0064: rolled back first, as the Migrator would, and applied again below.
        const movers = migrations['0065_tax_year_deposit_and_correction_movers'] as typeof migration;
        const db = () => createDatabase(downPool) as never;
        const loanParts = migrations['0071_tax_year_loan_schedule_part_kinds'] as typeof migration;
        // 0071 (VC-X-54) widens these CHECKs and patches the shape guard after them: its own down first, up again at the end.
        // 0073 (VC-X-57) patches 0072's passages of acquisition_frozen and 0050's functions: rolled back before 0072, not applied again.
        // 0074 (VC-X-12, an index only) sorts after 0073: its own down first, not applied again.
        await withMigrationLock(() => (migrations['0074_idempotency_key_retention'] as typeof migration).down(db()));
        await withMigrationLock(() => (migrations['0073_ownership_start_on_confirm'] as typeof migration).down(db()));
        // 0072 (VC-X-55) widens the same CHECKs and patches 0067's passage of the shape guard after 0071: rolled back first.
        // It is not applied again below: 0065's up writes its own shape guard, without 0067's passage that 0072 patches.
        await withMigrationLock(() => (migrations['0072_ownership_extend_to_economic_transfer'] as typeof migration).down(db()));
        await withMigrationLock(() => loanParts.down(db()));
        await withMigrationLock(() => movers.down(db()));
        const pr = (
          await downPool.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f6e49f', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          )
        ).rows[0].id as string;
        const inserted = async (ack: Record<string, string>, item: string) => {
          const client = await downPool.connect();
          try {
            await client.query('BEGIN');
            const id = (await client.query(ackRow(pr, ack))).rows[0].id as string;
            await client.query(item, [id]);
            await client.query('COMMIT');
          } finally {
            client.release();
          }
        };
        const refusedWith = async () => {
          let refused: unknown;
          await withMigrationLock(async () => {
            refused = await migration.down(db()).catch((e: unknown) => e);
          });
          return refused;
        };
        const clear = async () => {
          for (const table of ['tax_year_acknowledgement_part_item', 'tax_year_acknowledgement_item', 'tax_year_acknowledgement']) {
            await downPool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
            await downPool.query(`DELETE FROM ${table}`);
            await downPool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
          }
        };
        await inserted(DEPOSIT, partRow());
        expect(await refusedWith()).toMatchObject({ code: '23514' });
        // The item gone, its acknowledgement of a deposit kind still there: refused too.
        await downPool.query(`ALTER TABLE tax_year_acknowledgement_part_item DISABLE TRIGGER USER`);
        await downPool.query(`DELETE FROM tax_year_acknowledgement_part_item`);
        await downPool.query(`ALTER TABLE tax_year_acknowledgement_part_item ENABLE TRIGGER USER`);
        expect(await refusedWith()).toMatchObject({ code: '23514' });
        await clear();
        await inserted(CLOSED, yearRow);
        expect(await refusedWith()).toMatchObject({ code: '23514' });
        // Still 0064's schema and guard after the refusals (nothing changed before the refusal): LOAN_CLOSED and a deposit item accepted.
        expect(await downPool.query(ackRow(pr, CLOSED)).then(() => 'accepted', classify)).toBe('accepted');
        const still = await downPool.connect();
        try {
          await still.query('BEGIN');
          const id = (await still.query(ackRow(pr, DEPOSIT))).rows[0].id as string;
          expect(await still.query(partRow(), [id]).then(() => 'accepted', classify)).toBe('accepted');
        } finally {
          await still.query('ROLLBACK');
          still.release();
        }
        // Counter-check: only acknowledgements of 0063's kinds left, down runs.
        await clear();
        await inserted(SET, partRow({ source_type: `'TRANSACTION_SPLIT'`, state_after: `'ATTRIBUTED'`, part_after: '225.00' }));
        await withMigrationLock(() => migration.down(db()));
        // 0063's CHECKs and guard again: the new kinds, the Loan and DEPOSIT_CLOSING refused, 0063's rows accepted.
        expect(await downPool.query(ackRow(pr, CLOSED)).then(() => 'accepted', classify)).toBe('check');
        expect(await downPool.query(ackRow(pr, DEPOSIT)).then(() => 'accepted', classify)).toBe('check');
        expect(await downPool.query(ackRow(pr, { change_kind: `'LOAN_TERMS_ADDED'`, change_entity_type: `'Loan'` })).then(() => 'accepted', classify)).toBe(
          'check',
        );
        const restored = await downPool.connect();
        try {
          await restored.query('BEGIN');
          const id = (await restored.query(ackRow(pr, SET))).rows[0].id as string;
          expect(await restored.query(partRow({ state_after: `'ATTRIBUTED'`, part_after: '225.00' }), [id]).then(() => 'accepted', classify)).toBe('check');
          await restored.query('ROLLBACK');
          await restored.query('BEGIN');
          const again = (await restored.query(ackRow(pr, SET))).rows[0].id as string;
          const split = partRow({ source_type: `'TRANSACTION_SPLIT'`, state_after: `'ATTRIBUTED'`, part_after: '225.00' });
          expect(await restored.query(split, [again]).then(() => 'accepted', classify)).toBe('accepted');
          await restored.query('ROLLBACK');
        } finally {
          restored.release();
        }
        await withMigrationLock(() => migration.up(db()));
        await withMigrationLock(() => movers.up(db()));
        await withMigrationLock(() => loanParts.up(db()));
        expect(await downPool.query(ackRow(pr, CLOSED)).then(() => 'accepted', classify)).toBe('accepted');
      } finally {
        await downPool.end();
      }
    },
  );
});
