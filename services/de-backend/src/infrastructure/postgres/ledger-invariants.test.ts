import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';

/**
 * VC-1-09, schema level: the ledger invariants hold in the database itself, so
 * no code path — present or future, nor a hand-written statement — can break
 * them. Each test writes straight SQL past the repositories. See
 * docs/development/invariant-suite.md for where each invariant is tested.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('ledger invariants in the schema', () => {
  const schema = testSchemaName('ledger_invariants_test');
  let pool: pg.Pool;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let properties: PostgresPropertyReferenceRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    properties = new PostgresPropertyReferenceRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function account(mreRealmId = REALM): Promise<string> {
    const outcome = await accounts.create({ mreRealmId, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account.id;
  }
  async function transaction(mreRealmId = REALM, amount = '1200.00'): Promise<string> {
    const created = await transactions.createManual(
      {
        mreRealmId,
        financialAccountId: await account(mreRealmId),
        amount: Money.of(amount, 'EUR'),
        direction: 'OUTFLOW',
        bookingDate: '2026-09-30' as BusinessDate,
        valueDate: null,
        description: null,
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  async function property(mreRealmId: string, mrePropertyId: string): Promise<string> {
    const linked = await properties.linkOnce(
      { mreRealmId, mrePropertyId, displayName: null, cachedAddress: null, cachedSurface: null, refreshedAt: new Date() },
      actor,
    );
    return linked.reference.id;
  }
  const category = async (code: string) => (await pool.query(`SELECT id FROM financial_category WHERE code = $1`, [code])).rows[0].id as string;
  const addSplit = async (transactionId: string, position: number, amount: string) =>
    pool.query(
      `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, created_by)
       VALUES ($1, $2, $3, $4, 'EUR', $5, 'x')`,
      [transactionId, REALM, position, amount, await category('OTHER')],
    );
  const confirmBySql = (id: string) =>
    pool.query(`UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x' WHERE id = $1`, [id]);

  describe('split totals: a confirmed Transaction is covered exactly by its splits (§18, §24)', () => {
    it('no confirmation without splits, or with a sum one cent off in either direction', async () => {
      const unsplit = await transaction();
      await expect(confirmBySql(unsplit)).rejects.toThrow(/cannot be confirmed/);

      const short = await transaction();
      await addSplit(short, 1, '600.00');
      await addSplit(short, 2, '599.99');
      await expect(confirmBySql(short)).rejects.toThrow(/cannot be confirmed/);

      const over = await transaction();
      await addSplit(over, 1, '1200.01');
      await expect(confirmBySql(over)).rejects.toThrow(/cannot be confirmed/);
    });

    it('an exact split set can be confirmed, and stays exact: its splits are frozen', async () => {
      const id = await transaction();
      await addSplit(id, 1, '600.00');
      await addSplit(id, 2, '600');
      await confirmBySql(id);
      await expect(pool.query(`UPDATE transaction_split SET amount = 599.99 WHERE transaction_id = $1 AND position = 2`, [id])).rejects.toThrow(/ADR-037/);
    });

    const lockWait = (fragment: string) => async () =>
      (
        await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = current_setting('application_name') AND query LIKE $1`,
          [`%${fragment}%`],
        )
      ).rowCount !== 0;

    it('two writers: a confirmation waits for an uncommitted split and is refused (no 150 on 100)', async () => {
      const id = await transaction(REALM, '100.00');
      await addSplit(id, 1, '100.00');
      const writer = await pool.connect();
      try {
        // Session A adds a split but has not committed yet ...
        await writer.query('BEGIN');
        await writer.query(
          `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, created_by)
           VALUES ($1, $2, 2, 50, 'EUR', $3, 'x')`,
          [id, REALM, await category('OTHER')],
        );
        // ... session B confirms: it must wait for A instead of summing only the committed splits.
        // The expectation is attached at once: the refusal can arrive before the COMMIT below resolves,
        // and a rejection without a handler for that moment fails the run even though the test passes.
        // READ COMMITTED re-reads the splits and refuses; REPEATABLE READ refuses with a serialization error.
        const confirming = expect(confirmBySql(id)).rejects.toThrow(/sum 150.*amount 100|could not serialize/);
        await waitUntil(lockWait("SET status = 'CONFIRMED'"));
        await writer.query('COMMIT');
        await confirming;
        const row = await pool.query(`SELECT status FROM ledger_transaction WHERE id = $1`, [id]);
        expect(row.rows).toEqual([{ status: 'UNREVIEWED' }]);
      } finally {
        writer.release();
      }
    });

    it('two writers: a split waits for an uncommitted confirmation and is then refused as frozen', async () => {
      const id = await transaction(REALM, '100.00');
      await addSplit(id, 1, '100.00');
      const confirmer = await pool.connect();
      try {
        await confirmer.query('BEGIN');
        await confirmer.query(`UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x' WHERE id = $1`, [id]);
        // Expectation attached at once, as above.
        const adding = expect(addSplit(id, 2, '50.00')).rejects.toThrow(/frozen|could not serialize/);
        await waitUntil(lockWait('INSERT INTO transaction_split'));
        await confirmer.query('COMMIT');
        await adding;
        const splits = await pool.query(`SELECT sum(amount)::text AS total FROM transaction_split WHERE transaction_id = $1`, [id]);
        expect(splits.rows).toEqual([{ total: '100.00' }]);
      } finally {
        confirmer.release();
      }
    });

    it('no Transaction is inserted already confirmed', async () => {
      const accountId = await account();
      await expect(
        pool.query(
          `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status,
             created_by, confirmed_at, confirmed_by)
           VALUES ($1, $2, 1, 'EUR', 'INFLOW', '2026-09-01', 'MANUAL', 'CONFIRMED', 'x', now(), 'x')`,
          [REALM, accountId],
        ),
      ).rejects.toThrow(/not inserted confirmed/);
    });
  });

  describe('non-negative amount, sign only in direction, supported currency and scale (§17.4)', () => {
    const insert = async (amount: string, currency: string, direction: string) =>
      pool.query(
        `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by)
         VALUES ($1, $2, $3, $4, $5, '2026-09-01', 'MANUAL', 'UNREVIEWED', 'x')`,
        [REALM, await account(), amount, currency, direction],
      );

    it.each([
      ['a negative amount', '-1.00', 'EUR', 'OUTFLOW', /ledger_transaction_amount_check/],
      ['more decimals than EUR allows', '1.005', 'EUR', 'INFLOW', /ledger_transaction_amount_check/],
      ['an unsupported currency', '1.00', 'USD', 'INFLOW', /ledger_transaction_currency_check/],
      ['a direction other than INFLOW/OUTFLOW', '1.00', 'EUR', 'REFUND', /ledger_transaction_direction_check/],
    ])('refuses %s', async (_case, amount, currency, direction, error) => {
      await expect(insert(amount, currency, direction)).rejects.toThrow(error);
    });
  });

  describe('Realm isolation: nothing references another Realm’s rows (composite foreign keys)', () => {
    it('a Transaction cannot point at another Realm’s PropertyReference', async () => {
      const foreign = await property(OTHER_REALM, '6512f0c2a1b2c3d4e5f60801');
      const id = await transaction();
      await expect(pool.query(`UPDATE ledger_transaction SET property_reference_id = $2 WHERE id = $1`, [id, foreign])).rejects.toThrow(
        /ledger_transaction_property_reference_fk/,
      );
    });

    it('a split cannot point at another Realm’s PropertyReference', async () => {
      const foreign = await property(OTHER_REALM, '6512f0c2a1b2c3d4e5f60802');
      const id = await transaction();
      await addSplit(id, 1, '1200.00');
      await expect(pool.query(`UPDATE transaction_split SET property_reference_id = $2 WHERE transaction_id = $1`, [id, foreign])).rejects.toThrow(
        /transaction_split_property_reference_fk/,
      );
    });

    it('import batches, imported Transactions and review items stay in their Realm', async () => {
      const foreignAccount = await account(OTHER_REALM);
      const batchInsert = (realm: string, accountId: string) =>
        pool.query(
          `INSERT INTO import_batch (id, mre_realm_id, financial_account_id, adapter_id, adapter_version, content_hash, provenance, status,
             transaction_count, duplicate_count, needs_review_count, error_count, skipped_count, rows, imported_by)
           VALUES (gen_random_uuid(), $1, $2, 'generic-csv', '1', 'h', 'BANK_CSV', 'COMPLETED', 0, 0, 0, 0, 0, '[]', 'x') RETURNING id`,
          [realm, accountId],
        );
      await expect(batchInsert(REALM, foreignAccount)).rejects.toThrow(/import_batch_account_fk/);

      const foreignBatch = (await batchInsert(OTHER_REALM, foreignAccount)).rows[0].id as string;
      const id = await transaction();
      await expect(
        pool.query(
          `UPDATE ledger_transaction SET import_batch_id = $2, adapter_id = 'generic-csv', adapter_version = '1',
             source_statement_key = 's', source_row_key = 'pos:1', content_fingerprint = 'f' WHERE id = $1`,
          [id, foreignBatch],
        ),
      ).rejects.toThrow(/ledger_transaction_import_batch_fk/);

      const ownAccount = await account();
      await expect(
        pool.query(
          `INSERT INTO import_review_item (id, import_batch_id, mre_realm_id, financial_account_id, adapter_id, adapter_version,
             source_statement_key, source_row_key, content_fingerprint, normalized_row, ambiguity_reason, conflicting_transaction_ids,
             prior_review_item_ids, status)
           VALUES (gen_random_uuid(), $1, $2, $3, 'generic-csv', '1', 's', 'pos:1', 'f', '{}', 'AMBIGUOUS_CROSS_FILE_MATCH', '{}', '{}', 'PENDING')`,
          [foreignBatch, REALM, ownAccount],
        ),
      ).rejects.toThrow(/import_review_item_batch_fk/);
    });
  });

  describe('correction chain (VC-1-11, api-design §35.6, data-model §17.8)', () => {
    /** A confirmed Transaction with one split, written past the repositories. */
    async function confirmed(mreRealmId = REALM): Promise<string> {
      const id = await transaction(mreRealmId);
      await pool.query(
        `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, created_by)
         VALUES ($1, $2, 1, 1200.00, 'EUR', $3, 'x')`,
        [id, mreRealmId, await category('OTHER')],
      );
      await confirmBySql(id);
      return id;
    }

    /** Runs statements in one transaction, so the deferred chain check fires at its commit. */
    async function inTransaction(statements: (client: pg.PoolClient) => Promise<void>): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await statements(client);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    interface Linked {
      readonly role: 'REVERSAL' | 'REPLACEMENT';
      readonly amount?: string;
      readonly sameDirection?: boolean;
      readonly confirm?: boolean;
      /** Its splits; default one split of `amount` in OTHER. */
      readonly splits?: readonly { readonly amount: string; readonly code?: string; readonly propertyReferenceId?: string; readonly description?: string }[];
    }
    /** A reversal or replacement of `originalId` (a copy of it, opposite direction for a reversal), confirmed by default. */
    async function insertLinked(client: pg.PoolClient, originalId: string, linked: Linked): Promise<string> {
      const amount = linked.amount ?? '1200.00';
      const flip = linked.role === 'REVERSAL' && linked.sameDirection !== true;
      const { rows } = await client.query(
        `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, value_date,
           provenance, status, created_by, correction_of_transaction_id, correction_role)
         SELECT mre_realm_id, financial_account_id, $3, currency,
                CASE WHEN $4 THEN (CASE direction WHEN 'INFLOW' THEN 'OUTFLOW' ELSE 'INFLOW' END) ELSE direction END,
                booking_date, value_date, 'CORRECTION', 'CLASSIFIED', 'x', id, $2
         FROM ledger_transaction WHERE id = $1 RETURNING id`,
        [originalId, linked.role, amount, flip],
      );
      const id = rows[0].id as string;
      for (const [i, split] of (linked.splits ?? [{ amount }]).entries()) {
        await client.query(
          `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id,
             description, created_by)
           VALUES ($1, $2, $3, $4, 'EUR', $5, $6, $7, 'x')`,
          [id, REALM, i + 1, split.amount, await category(split.code ?? 'OTHER'), split.propertyReferenceId ?? null, split.description ?? null],
        );
      }
      if (linked.confirm !== false) {
        await client.query(`UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x' WHERE id = $1`, [id]);
      }
      return id;
    }
    const markCorrected = (client: pg.PoolClient, id: string) =>
      client.query(`UPDATE ledger_transaction SET status = 'CORRECTED', version = version + 1 WHERE id = $1`, [id]);

    it('a complete chain commits; the reversal may come before or after the status change, the replacement before it', async () => {
      const original = await confirmed();
      await inTransaction(async (c) => {
        await insertLinked(c, original, { role: 'REPLACEMENT', amount: '1100.00' });
        await markCorrected(c, original);
        await insertLinked(c, original, { role: 'REVERSAL' });
      });
      const { rows } = await pool.query(`SELECT status FROM ledger_transaction WHERE id = $1`, [original]);
      expect(rows[0].status).toBe('CORRECTED');
    });

    it('CORRECTED exactly when its reversal exists (the replacement is optional, VC-X-15), checked at commit', async () => {
      const alone = await confirmed();
      await expect(inTransaction((c) => markCorrected(c, alone).then(() => undefined))).rejects.toThrow(/without its reversal/);
      const replacementOnly = await confirmed();
      await expect(
        inTransaction(async (c) => {
          await insertLinked(c, replacementOnly, { role: 'REPLACEMENT', amount: '1100.00' });
          await markCorrected(c, replacementOnly);
        }),
      ).rejects.toThrow(/without its reversal/);
      // Reverse only: the original and its reversal cancel, nothing replaces it (api-design §35.9).
      const reversed = await confirmed();
      await inTransaction(async (c) => {
        await insertLinked(c, reversed, { role: 'REVERSAL' });
        await markCorrected(c, reversed);
      });
      // Linked records without the original becoming CORRECTED.
      const untouched = await confirmed();
      await expect(
        inTransaction(async (c) => {
          await insertLinked(c, untouched, { role: 'REVERSAL' });
          await insertLinked(c, untouched, { role: 'REPLACEMENT', amount: '1100.00' });
        }),
      ).rejects.toThrow(/not CORRECTED/);
    });

    it('a reversed Transaction never gets a replacement later; it is written only with its correction (VC-X-15)', async () => {
      const reversed = await confirmed();
      await inTransaction(async (c) => {
        await insertLinked(c, reversed, { role: 'REVERSAL' });
        await markCorrected(c, reversed);
      });
      await expect(inTransaction((c) => insertLinked(c, reversed, { role: 'REPLACEMENT', amount: '1100.00' }).then(() => undefined))).rejects.toThrow(
        /already CORRECTED/,
      );
      // Writing the original first does not open a gap (review on #27, case B): the rule is the order, not the writer.
      // (A real `updated_at` touch is refused by itself since VC-X-22; a no-op write still makes a new row version.)
      await expect(
        inTransaction(async (c) => {
          await c.query(`UPDATE ledger_transaction SET updated_at = updated_at WHERE id = $1`, [reversed]);
          await insertLinked(c, reversed, { role: 'REPLACEMENT', amount: '1100.00' });
        }),
      ).rejects.toThrow(/already CORRECTED/);
      // Nor within the correcting transaction itself, once the original is CORRECTED.
      const late = await confirmed();
      await expect(
        inTransaction(async (c) => {
          await insertLinked(c, late, { role: 'REVERSAL' });
          await markCorrected(c, late);
          await insertLinked(c, late, { role: 'REPLACEMENT', amount: '1100.00' });
        }),
      ).rejects.toThrow(/already CORRECTED/);
      // A replacement of an original corrected with one is still part of the chain later: its own correction works.
      const original = await confirmed();
      let replacement = '';
      await inTransaction(async (c) => {
        await insertLinked(c, original, { role: 'REVERSAL' });
        replacement = await insertLinked(c, original, { role: 'REPLACEMENT', amount: '1200.00' });
        await markCorrected(c, original);
      });
      await inTransaction(async (c) => {
        await insertLinked(c, replacement, { role: 'REVERSAL' });
        await markCorrected(c, replacement);
      });
    });

    it('a correction inside a savepoint commits like any other (review on #27, case C)', async () => {
      const original = await confirmed();
      await inTransaction(async (c) => {
        await c.query('SAVEPOINT correction');
        await insertLinked(c, original, { role: 'REVERSAL' });
        await insertLinked(c, original, { role: 'REPLACEMENT', amount: '1100.00' });
        await markCorrected(c, original);
        await c.query('RELEASE SAVEPOINT correction');
      });
      const { rows } = await pool.query(`SELECT count(*) FROM ledger_transaction WHERE correction_of_transaction_id = $1`, [original]);
      expect(rows).toEqual([{ count: '2' }]);
    });

    it('a replacement racing a reversal waits for it and is then refused', async () => {
      const original = await confirmed();
      const reverser = await pool.connect();
      const replacer = await pool.connect();
      try {
        await reverser.query('BEGIN');
        await insertLinked(reverser, original, { role: 'REVERSAL' });
        await markCorrected(reverser, original);
        await replacer.query('BEGIN');
        // The expectation is attached at once (see the two-writer tests above).
        const replacing = expect(insertLinked(replacer, original, { role: 'REPLACEMENT', amount: '1100.00' })).rejects.toThrow(
          /already CORRECTED|could not serialize/,
        );
        // The replacer's INSERT waits in its trigger's FOR SHARE on the reverser's uncommitted status change.
        await waitUntil(
          async () =>
            Number(
              (
                await pool.query(
                  `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = current_setting('application_name')
                 AND query LIKE 'INSERT INTO ledger_transaction%'`,
                )
              ).rows[0].count,
            ) === 1,
        );
        await reverser.query('COMMIT');
        await replacing;
        await replacer.query('ROLLBACK');
      } finally {
        reverser.release();
        replacer.release();
      }
    });

    it('CORRECTED only from CONFIRMED/RECONCILED: a covered CLASSIFIED row cannot jump to it (review counterexample on #21)', async () => {
      const id = await transaction();
      await addSplit(id, 1, '1200.00');
      await expect(
        pool.query(`UPDATE ledger_transaction SET status = 'CORRECTED', confirmed_at = now(), confirmed_by = 'x' WHERE id = $1`, [id]),
      ).rejects.toThrow(/cannot become CORRECTED/);
      await expect(
        pool.query(
          `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance,
             status, created_by, confirmed_at, confirmed_by)
           VALUES ($1, $2, 1, 'EUR', 'INFLOW', '2026-09-01', 'MANUAL', 'CORRECTED', 'x', now(), 'x')`,
          [REALM, await account()],
        ),
      ).rejects.toThrow(/not inserted confirmed/);
    });

    it('link and role go together, exactly with provenance CORRECTION', async () => {
      const original = await confirmed();
      const accountId = (await pool.query(`SELECT financial_account_id FROM ledger_transaction WHERE id = $1`, [original])).rows[0]
        .financial_account_id as string;
      const insert = (provenance: string, link: string | null, role: string | null) =>
        pool.query(
          `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance,
             status, created_by, correction_of_transaction_id, correction_role)
           VALUES ($1, $2, 1, 'EUR', 'INFLOW', '2026-09-01', $3, 'CLASSIFIED', 'x', $4, $5)`,
          [REALM, accountId, provenance, link, role],
        );
      await expect(insert('CORRECTION', null, null)).rejects.toThrow(/ledger_transaction_correction_link/);
      await expect(insert('CORRECTION', original, null)).rejects.toThrow(/ledger_transaction_correction_link/);
      await expect(insert('CORRECTION', null, 'REVERSAL')).rejects.toThrow(/ledger_transaction_correction_link/);
      await expect(insert('MANUAL', original, 'REPLACEMENT')).rejects.toThrow(/ledger_transaction_correction_link/);
      await expect(insert('CORRECTION', original, 'OTHER')).rejects.toThrow(/check constraint/);
    });

    it('a correction links only within its Realm', async () => {
      const foreign = await confirmed(OTHER_REALM);
      await expect(
        pool.query(
          `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance,
             status, created_by, correction_of_transaction_id, correction_role)
           VALUES ($1, $2, 1, 'EUR', 'INFLOW', '2026-09-01', 'CORRECTION', 'CLASSIFIED', 'x', $3, 'REVERSAL')`,
          [REALM, await account(), foreign],
        ),
      ).rejects.toThrow(/ledger_transaction_correction_fk/);
    });

    it('at most one reversal and one replacement per original', async () => {
      const original = await confirmed();
      await expect(
        inTransaction(async (c) => {
          await insertLinked(c, original, { role: 'REVERSAL' });
          await insertLinked(c, original, { role: 'REVERSAL' });
        }),
      ).rejects.toThrow(/ledger_transaction_correction_key/);
    });

    it('a reversal matches its original: same amount, opposite direction; and it is confirmed', async () => {
      const cases: Linked[] = [
        { role: 'REVERSAL', amount: '1199.99' },
        { role: 'REVERSAL', sameDirection: true },
      ];
      for (const reversal of cases) {
        const original = await confirmed();
        await expect(
          inTransaction(async (c) => {
            await insertLinked(c, original, reversal);
            await insertLinked(c, original, { role: 'REPLACEMENT', amount: '1100.00' });
            await markCorrected(c, original);
          }),
          JSON.stringify(reversal),
        ).rejects.toThrow(/does not match/);
      }
      const unconfirmed = await confirmed();
      await expect(
        inTransaction(async (c) => {
          await insertLinked(c, unconfirmed, { role: 'REVERSAL' });
          await insertLinked(c, unconfirmed, { role: 'REPLACEMENT', amount: '1100.00', confirm: false });
          await markCorrected(c, unconfirmed);
        }),
      ).rejects.toThrow(/not confirmed/);
    });

    it('a reversal mirrors the splits of its original: category, PropertyReference and amount, as a multiset (VC-X-17)', async () => {
      const reference = await property(REALM, '64b0c0ffee00000000000c17');
      const original = await transaction();
      await addSplit(original, 1, '700.00');
      await pool.query(
        `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, created_by)
         VALUES ($1, $2, 2, 500.00, 'EUR', $3, $4, 'x')`,
        [original, REALM, await category('RENT_BASE'), reference],
      );
      await confirmBySql(original);
      const reverse = (splits: NonNullable<Linked['splits']>) =>
        inTransaction(async (c) => {
          await insertLinked(c, original, { role: 'REVERSAL', splits });
          await markCorrected(c, original);
        });
      // The header matches in each case; only the splits differ.
      for (const splits of [
        [{ amount: '1200.00' }],
        [{ amount: '700.00' }, { amount: '500.00', code: 'RENT_OPERATING_COST_ADVANCE', propertyReferenceId: reference }],
        [{ amount: '700.00' }, { amount: '500.00', code: 'RENT_BASE' }],
        [{ amount: '600.00' }, { amount: '100.00' }, { amount: '500.00', code: 'RENT_BASE', propertyReferenceId: reference }],
      ]) {
        await expect(reverse(splits), JSON.stringify(splits)).rejects.toThrow(/does not mirror the splits/);
      }
      // Another order of the same splits, with other descriptions, mirrors them.
      await reverse([{ amount: '500', code: 'RENT_BASE', propertyReferenceId: reference, description: 'Storno' }, { amount: '700.00' }]);
      const { rows } = await pool.query(`SELECT status FROM ledger_transaction WHERE id = $1`, [original]);
      expect(rows[0].status).toBe('CORRECTED');
    });

    it('the mirror is checked at commit: splits may follow the reversal row', async () => {
      const original = await confirmed();
      await expect(
        inTransaction(async (c) => {
          const reversal = await insertLinked(c, original, { role: 'REVERSAL', confirm: false, splits: [{ amount: '600.00' }, { amount: '600.00' }] });
          await c.query(`DELETE FROM transaction_split WHERE transaction_id = $1 AND position = 2`, [reversal]);
          await c.query(`UPDATE transaction_split SET amount = 1200.00 WHERE transaction_id = $1 AND position = 1`, [reversal]);
          await c.query(`UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x' WHERE id = $1`, [reversal]);
          await markCorrected(c, original);
        }),
      ).resolves.toBeUndefined();
    });

    it('no correction links to a reversal', async () => {
      const original = await confirmed();
      let reversal = '';
      await inTransaction(async (c) => {
        reversal = await insertLinked(c, original, { role: 'REVERSAL' });
        await insertLinked(c, original, { role: 'REPLACEMENT', amount: '1100.00' });
        await markCorrected(c, original);
      });
      await expect(
        inTransaction(async (c) => {
          await insertLinked(c, reversal, { role: 'REVERSAL' });
          await insertLinked(c, reversal, { role: 'REPLACEMENT', amount: '1100.00' });
          await markCorrected(c, reversal);
        }),
      ).rejects.toThrow(/is a reversal and cannot be corrected/);
    });

    it('PropertyReference, description and the link of a confirmed Transaction are frozen (review counterexample on #21)', async () => {
      const id = await confirmed();
      const reference = await property(REALM, '64b0c0ffee00000000000c11');
      for (const [statement, value] of [
        [`UPDATE ledger_transaction SET property_reference_id = $2 WHERE id = $1`, reference],
        [`UPDATE ledger_transaction SET description = $2 WHERE id = $1`, 'anders'],
        [`UPDATE ledger_transaction SET correction_role = $2 WHERE id = $1`, 'REPLACEMENT'],
      ] as const) {
        await expect(pool.query(statement, [id, value]), statement).rejects.toThrow(/ADR-037/);
      }
    });
  });

  describe('version and updated_at of a confirmed Transaction (VC-X-22, api-design §16.1)', () => {
    async function confirmedAt(): Promise<{ id: string; version: number; updatedAt: Date }> {
      const id = await transaction();
      await addSplit(id, 1, '1200.00');
      await confirmBySql(id);
      return { id, ...(await stamp(id)) };
    }
    const stamp = async (id: string) => {
      const { rows } = await pool.query(`SELECT version, updated_at FROM ledger_transaction WHERE id = $1`, [id]);
      return { version: rows[0].version as number, updatedAt: rows[0].updated_at as Date };
    };

    it('without a status step, version and updated_at stay; a no-op write is fine', async () => {
      const { id, version, updatedAt } = await confirmedAt();
      for (const statement of [
        `UPDATE ledger_transaction SET version = version + 1 WHERE id = $1`,
        `UPDATE ledger_transaction SET version = version - 1 WHERE id = $1`,
        `UPDATE ledger_transaction SET updated_at = now() + interval '1 second' WHERE id = $1`,
        `UPDATE ledger_transaction SET status = 'CONFIRMED', version = version + 1, updated_at = now() WHERE id = $1`,
      ]) {
        await expect(pool.query(statement, [id]), statement).rejects.toThrow(/change only with a status step/);
      }
      // The split trigger's touch (0010) and other no-op writes still pass.
      await pool.query(`UPDATE ledger_transaction SET version = version, updated_at = updated_at WHERE id = $1`, [id]);
      expect(await stamp(id)).toEqual({ version, updatedAt });
    });

    it('a status step raises version by exactly one; updated_at may move with it; then both are frozen again', async () => {
      const { id, version } = await confirmedAt();
      const step = (raise: string) =>
        pool.query(`UPDATE ledger_transaction SET status = 'RECONCILED', version = version ${raise}, updated_at = now() WHERE id = $1`, [id]);
      await expect(step('+ 0')).rejects.toThrow(/must raise version/);
      await expect(step('+ 2')).rejects.toThrow(/must raise version/);
      await step('+ 1');
      expect((await stamp(id)).version).toBe(version + 1);
      await expect(pool.query(`UPDATE ledger_transaction SET updated_at = now() + interval '1 second' WHERE id = $1`, [id])).rejects.toThrow(
        /change only with a status step/,
      );
    });

    it('the step into CONFIRMED starts from an unconfirmed row and is not covered', async () => {
      const id = await transaction();
      await addSplit(id, 1, '1200.00');
      const before = await stamp(id);
      await confirmBySql(id);
      expect((await stamp(id)).version).toBe(before.version);
    });
  });
});
