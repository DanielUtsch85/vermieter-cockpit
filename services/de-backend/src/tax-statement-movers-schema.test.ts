import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './infrastructure/postgres/database.js';
import { migrateToLatest } from './infrastructure/postgres/migrate.js';
import { migrations } from './infrastructure/postgres/migrations/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { REALM, databaseUrl, useTaxYearDatabase, withMigrationLock } from './infrastructure/postgres/tax-year.test-support.js';

/**
 * Migration 0065 (VC-X-50, api-design.md §58I "In the database") past the repository: `change_kind`,
 * `change_entity_type` and `_kind_entity` widened by the deposit kinds on `SecurityDeposit` and the correction kinds on
 * `Transaction`; the year item's years nullable with `_moved` as `IS DISTINCT FROM` and `_some_year`; the shape guard
 * (the deposit kinds year items only, the correction kinds `TRANSACTION_SPLIT` part items only, a `null` year only under
 * a deposit kind), each with its counter-check; `up`, `down`, and `down` refusing while an acknowledgement of a new kind
 * or a year item with a `null` year exists. Synthetic values only.
 */
type Outcome = string | undefined;
const REOPENED = { change_kind: `'DEPOSIT_REOPENED'`, change_entity_type: `'SecurityDeposit'` };
const CLOSED = { change_kind: `'DEPOSIT_CLOSED'`, change_entity_type: `'SecurityDeposit'` };
const CORRECTED = { change_kind: `'TRANSACTION_CORRECTED'`, change_entity_type: `'Transaction'` };
const REVERSED = { change_kind: `'TRANSACTION_REVERSED'`, change_entity_type: `'Transaction'` };
const RECONCILIATION = { change_kind: `'RECONCILIATION_CONFIRMED'`, change_entity_type: `'RentPaymentReconciliation'` };

/** An acknowledgement row as SQL: `DEPOSIT_REOPENED` unless overridden. */
const ackRow = (pr: string, o: Record<string, string> = {}) => {
  const v = {
    mre_realm_id: `'${REALM}'`,
    property_reference_id: `'${pr}'`,
    tax_year: '2027',
    audit_record_id: 'gen_random_uuid()',
    ...REOPENED,
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
/** A year item for acknowledgement `$1`. */
const yearRow = (before: string, after: string) => `INSERT INTO tax_year_acknowledgement_item VALUES ($1, '${REALM}', gen_random_uuid(), ${before}, ${after})`;
/** A split part item for acknowledgement `$1` (ATTRIBUTED 950.00 → NONE) unless overridden. */
const partRow = (o: Record<string, string> = {}) => {
  const v = {
    acknowledgement_id: '$1',
    mre_realm_id: `'${REALM}'`,
    source_type: `'TRANSACTION_SPLIT'`,
    source_id: 'gen_random_uuid()',
    tax_year: '2027',
    state_before: `'ATTRIBUTED'`,
    part_before: '950.00',
    state_after: `'NONE'`,
    part_after: 'NULL',
    ...o,
  };
  return `INSERT INTO tax_year_acknowledgement_part_item (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')})`;
};
const classify = (e: { code?: string; message?: string }): Outcome =>
  e.code === '23514' ? 'check' : e.code === '23502' ? 'not-null' : /api-design §58[EGHI]/.test(e.message ?? '') ? 'guard' : e.code;

describe.skipIf(databaseUrl === undefined)('the schema of 0065 past the repository (§58I)', () => {
  const { ctx, propertyReference } = useTaxYearDatabase('tax_statement_movers_schema_test');
  const outcome = async (statement: string): Promise<Outcome> => ctx.pool.query(statement).then(() => 'accepted', classify);
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

  /** The violated constraint's name of the statement in its own transaction (`undefined` when accepted). */
  async function constraintOf(statement: string, ack: Record<string, string>, before?: string): Promise<string | undefined> {
    const pr = await propertyReference();
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      if (before !== undefined) await client.query(before);
      const id = (await client.query(ackRow(pr, ack))).rows[0].id as string;
      return await client.query(statement, [id]).then(
        () => undefined,
        (e: { constraint?: string }) => e.constraint,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('the deposit kinds only on SecurityDeposit, SecurityDeposit only with them; counter-check: both kinds and the kinds of 0064 accepted', async () => {
    const pr = await propertyReference();
    for (const [name, row] of [
      ['DEPOSIT_REOPENED on RentPaymentReconciliation', { ...REOPENED, change_entity_type: `'RentPaymentReconciliation'` }],
      ['DEPOSIT_CLOSED on Loan', { ...CLOSED, change_entity_type: `'Loan'` }],
      ['DEPOSIT_CLOSED on Transaction', { ...CLOSED, change_entity_type: `'Transaction'` }],
      ['SecurityDeposit with LOAN_CLOSED', { ...REOPENED, change_kind: `'LOAN_CLOSED'` }],
      ['SecurityDeposit with a deposit part kind', { ...REOPENED, change_kind: `'DEPOSIT_RECONCILIATION_CONFIRMED'` }],
      ['SecurityDeposit with a correction kind', { ...REOPENED, change_kind: `'TRANSACTION_CORRECTED'` }],
      ['an unknown entity', { ...REOPENED, change_entity_type: `'Deposit'` }],
      // LoanTerms has no binding of its own: only SecurityDeposit's refuses these two.
      ['DEPOSIT_REOPENED on LoanTerms', { ...REOPENED, change_entity_type: `'LoanTerms'` }],
      ['SecurityDeposit with LOAN_TERMS_VOIDED', { ...REOPENED, change_kind: `'LOAN_TERMS_VOIDED'` }],
    ] as const) {
      expect(await outcome(ackRow(pr, row)), name).toBe('check');
    }
    expect(await outcome(ackRow(pr, REOPENED))).toBe('accepted');
    expect(await outcome(ackRow(pr, CLOSED))).toBe('accepted');
    expect(await outcome(ackRow(pr, { change_kind: `'LOAN_CLOSED'`, change_entity_type: `'Loan'` }))).toBe('accepted');
    expect(await outcome(ackRow(pr, { change_kind: `'DEPOSIT_RECONCILIATION_RELEASED'`, change_entity_type: `'RentPaymentReconciliation'` }))).toBe('accepted');
  });

  it('the correction kinds only on Transaction, Transaction only with them; counter-check: both kinds accepted', async () => {
    const pr = await propertyReference();
    for (const [name, row] of [
      ['TRANSACTION_CORRECTED on LoanAllocationSet', { ...CORRECTED, change_entity_type: `'LoanAllocationSet'` }],
      ['TRANSACTION_REVERSED on SecurityDeposit', { ...REVERSED, change_entity_type: `'SecurityDeposit'` }],
      ['Transaction with RECONCILIATION_RELEASED', { ...CORRECTED, change_kind: `'RECONCILIATION_RELEASED'` }],
      ['Transaction with LOAN_ALLOCATION_SET_ADDED', { ...CORRECTED, change_kind: `'LOAN_ALLOCATION_SET_ADDED'` }],
      ['an unknown kind (§58I Frage 5: no code of its own)', { ...CORRECTED, change_kind: `'LEDGER_CORRECTED_AFTER_YEAR_END'` }],
      // Only Transaction's binding refuses these two.
      ['TRANSACTION_REVERSED on LoanTerms', { ...REVERSED, change_entity_type: `'LoanTerms'` }],
      ['Transaction with LOAN_TERMS_ADDED', { ...CORRECTED, change_kind: `'LOAN_TERMS_ADDED'` }],
    ] as const) {
      expect(await outcome(ackRow(pr, row)), name).toBe('check');
    }
    expect(await outcome(ackRow(pr, CORRECTED))).toBe('accepted');
    expect(await outcome(ackRow(pr, REVERSED))).toBe('accepted');
  });

  it('the shape guard: the deposit kinds year items only, the correction kinds TRANSACTION_SPLIT part items only; counter-check: each in its shape', async () => {
    expect(await inOwnTransaction(partRow(), REOPENED)).toBe('guard');
    expect(await inOwnTransaction(partRow({ source_type: `'DEPOSIT_CLOSING'` }), CLOSED)).toBe('guard');
    expect(await inOwnTransaction(yearRow('2027', '2028'), CORRECTED)).toBe('guard');
    expect(await inOwnTransaction(yearRow('2027', 'NULL'), REVERSED)).toBe('guard');
    expect(await inOwnTransaction(partRow({ source_type: `'DEPOSIT_CLOSING'` }), CORRECTED)).toBe('guard');
    expect(await inOwnTransaction(yearRow('2027', 'NULL'), REOPENED)).toBe('accepted');
    expect(await inOwnTransaction(yearRow('2027', '2028'), CLOSED)).toBe('accepted');
    expect(await inOwnTransaction(partRow(), CORRECTED)).toBe('accepted');
    expect(await inOwnTransaction(partRow({ state_before: `'NONE'`, part_before: 'NULL', state_after: `'ATTRIBUTED'`, part_after: '950.00' }), REVERSED)).toBe(
      'accepted',
    );
  });

  it('a null year only under a deposit kind; never both null, never equal; counter-check: null on either side under a deposit kind, two years under any year kind', async () => {
    expect(await inOwnTransaction(yearRow('2027', 'NULL'), RECONCILIATION)).toBe('guard');
    expect(await inOwnTransaction(yearRow('NULL', '2027'), { change_kind: `'LOAN_CLOSED'`, change_entity_type: `'Loan'` })).toBe('guard');
    expect(await inOwnTransaction(yearRow('NULL', 'NULL'), REOPENED)).toBe('check');
    // `_moved` (IS DISTINCT FROM) refuses NULL/NULL first; `_some_year` stands on its own once `_moved` is gone (rolled back).
    expect(await constraintOf(yearRow('NULL', 'NULL'), REOPENED)).toBe('tax_year_acknowledgement_item_moved');
    expect(
      await constraintOf(yearRow('NULL', 'NULL'), REOPENED, 'ALTER TABLE tax_year_acknowledgement_item DROP CONSTRAINT tax_year_acknowledgement_item_moved'),
    ).toBe('tax_year_acknowledgement_item_some_year');
    expect(await constraintOf(yearRow('2027', '2027'), CLOSED)).toBe('tax_year_acknowledgement_item_moved');
    expect(await inOwnTransaction(yearRow('2027', '2027'), CLOSED)).toBe('check');
    expect(await inOwnTransaction(yearRow('1999', 'NULL'), REOPENED)).toBe('check');
    expect(await inOwnTransaction(yearRow('NULL', '2101'), CLOSED)).toBe('check');
    expect(await inOwnTransaction(yearRow('2027', 'NULL'), REOPENED)).toBe('accepted');
    expect(await inOwnTransaction(yearRow('NULL', '2027'), CLOSED)).toBe('accepted');
    expect(await inOwnTransaction(yearRow('2027', '2028'), RECONCILIATION)).toBe('accepted');
  });

  it(
    'up and down under MIGRATION_ADVISORY_LOCK: down refused with a kind of §58I or a null year, else restores 0064 s CHECKs, guard and NOT NULL',
    { timeout: 30_000 },
    async () => {
      const downSchema = testSchemaName('tax_statement_movers_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        const migration = migrations['0065_tax_year_deposit_and_correction_movers'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
        const db = () => createDatabase(downPool) as never;
        // 0071 (VC-X-54) widens these CHECKs and patches the shape guard after them: its own down first, up again at the end.
        const loanParts = migrations['0071_tax_year_loan_schedule_part_kinds'] as typeof migration;
        // 0073 (VC-X-57) patches 0072's passages of acquisition_frozen and 0050's functions: rolled back before 0072, not applied again.
        // 0074 (VC-X-12, an index only) sorts after 0073: its own down first, not applied again.
        await withMigrationLock(() => (migrations['0074_idempotency_key_retention'] as typeof migration).down(db()));
        await withMigrationLock(() => (migrations['0073_ownership_start_on_confirm'] as typeof migration).down(db()));
        // 0072 (VC-X-55) widens the same CHECKs and patches 0067's passage of the shape guard after 0071: rolled back first.
        // It is not applied again below: 0065's up writes its own shape guard, without 0067's passage that 0072 patches.
        await withMigrationLock(() => (migrations['0072_ownership_extend_to_economic_transfer'] as typeof migration).down(db()));
        await withMigrationLock(() => loanParts.down(db()));
        const pr = (
          await downPool.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f6e50f', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          )
        ).rows[0].id as string;
        const inserted = async (ack: Record<string, string>, item: string, guarded = true) => {
          const client = await downPool.connect();
          try {
            await client.query('BEGIN');
            if (!guarded) await client.query(`ALTER TABLE tax_year_acknowledgement_item DISABLE TRIGGER USER`);
            const id = (await client.query(ackRow(pr, ack))).rows[0].id as string;
            await client.query(item, [id]);
            if (!guarded) await client.query(`ALTER TABLE tax_year_acknowledgement_item ENABLE TRIGGER USER`);
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
        const query = (statement: string) => downPool.query(statement).then(() => 'accepted', classify);
        await inserted(REOPENED, yearRow('2027', 'NULL'));
        expect(await refusedWith()).toMatchObject({ code: '23514' });
        await clear();
        await inserted(CORRECTED, partRow());
        expect(await refusedWith()).toMatchObject({ code: '23514' });
        await clear();
        // A null year alone (written past the guard under a kind of 0064): refused too.
        await inserted(RECONCILIATION, yearRow('2027', 'NULL'), false);
        expect(await refusedWith()).toMatchObject({ code: '23514' });
        // Still 0065's schema after the refusals (nothing changed before them): the new kinds accepted.
        expect(await query(ackRow(pr, REOPENED))).toBe('accepted');
        expect(await query(ackRow(pr, CORRECTED))).toBe('accepted');
        // Counter-check: only acknowledgements of 0064's kinds with two years left, down runs.
        await clear();
        await inserted(RECONCILIATION, yearRow('2027', '2028'));
        await withMigrationLock(() => migration.down(db()));
        // 0064's CHECKs, guard and NOT NULL again.
        for (const row of [REOPENED, CLOSED, CORRECTED, REVERSED]) expect(await query(ackRow(pr, row))).toBe('check');
        const restored = await downPool.connect();
        try {
          await restored.query('BEGIN');
          const id = (await restored.query(ackRow(pr, RECONCILIATION))).rows[0].id as string;
          expect(await restored.query(yearRow('2027', 'NULL'), [id]).then(() => 'accepted', classify)).toBe('not-null');
          await restored.query('ROLLBACK');
          await restored.query('BEGIN');
          const again = (await restored.query(ackRow(pr, RECONCILIATION))).rows[0].id as string;
          expect(await restored.query(yearRow('2027', '2028'), [again]).then(() => 'accepted', classify)).toBe('accepted');
          await restored.query('ROLLBACK');
          await restored.query('BEGIN');
          const deposit = (
            await restored.query(ackRow(pr, { change_kind: `'DEPOSIT_RECONCILIATION_CONFIRMED'`, change_entity_type: `'RentPaymentReconciliation'` }))
          ).rows[0].id as string;
          const item = partRow({ source_type: `'DEPOSIT_CLOSING'`, state_after: `'NOT_ATTRIBUTED'` });
          expect(await restored.query(item, [deposit]).then(() => 'accepted', classify)).toBe('accepted');
          await restored.query('ROLLBACK');
        } finally {
          restored.release();
        }
        await withMigrationLock(() => migration.up(db()));
        await withMigrationLock(() => loanParts.up(db()));
        expect(await query(ackRow(pr, REOPENED))).toBe('accepted');
      } finally {
        await downPool.end();
      }
    },
  );
});
