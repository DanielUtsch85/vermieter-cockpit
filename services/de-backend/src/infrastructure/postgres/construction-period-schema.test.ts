import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { OTHER_REALM, REALM, databaseUrl, facts, messageOf, useConstructionDatabase } from './construction-period.test-support.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * Migration 0055 past the repository (api-design.md §59E "In the database"), each CHECK, key and guard with a
 * counter-check that the valid variant is accepted: the record's value CHECKs; frozen (never deleted, a VOID record never
 * changes, the Loan never changes, version + 1); its PropertyReferences only while VALID and 1–50 at commit; on
 * `tax_classification` the link only on a split with CAPITALIZED or DEDUCTIBLE, `DE_CONSTRUCTION_PERIOD_INTEREST@1`
 * literally (CAPITALIZED interest without a record), the record VALID, of the split's Loan, naming its PropertyReference,
 * not deductible under CAPITALIZED, only on interest, the link frozen; `down` refusing with a record (the recorded component's
 * Loan columns: `depreciation-schedule-version-schema.test.ts`). Synthetic data.
 */
async function withMigrationLock(work: () => Promise<unknown>): Promise<void> {
  const lock = new pg.Client({ connectionString: databaseUrl });
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    await work();
  } finally {
    await lock.end().catch(() => undefined);
  }
}

describe.skipIf(databaseUrl === undefined)('migration 0055 past the repository (§59E)', () => {
  const ctx = useConstructionDatabase('construction_period_schema_test');
  /** A raw record (with one PropertyReference unless `properties` is given) in a transaction of its own; its message or `accepted`. */
  const rawRecord = (pr: string, set: Record<string, unknown> = {}, properties: readonly string[] = [pr]) =>
    messageOf(
      ctx.inTransaction(async (c) => {
        const base: Record<string, unknown> = {
          mre_realm_id: REALM,
          loan_id: null,
          measure: 'Ausbau (synthetisch)',
          herstellung_from: '2028-01-15',
          use_intent: 'Vermietung',
          advance_expense_deductible: false,
          building_funds_share_numerator: 1,
          building_funds_share_denominator: 1,
          earlier_years_treatment: 'keine',
          source_references: ['Vertrag'],
          review_state: 'UNREVIEWED',
          created_by: 'x',
          ...set,
        };
        const keys = Object.keys(base);
        const { rows } = await c.query(
          `INSERT INTO construction_period_interest (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          keys.map((k) => base[k]),
        );
        for (const p of properties) {
          await c.query(`INSERT INTO construction_period_interest_property (record_id, mre_realm_id, property_reference_id) VALUES ($1, $2, $3)`, [
            rows[0].id,
            base['mre_realm_id'],
            p,
          ]);
        }
        return rows[0].id as string;
      }),
    );
  const sql = (text: string, values: unknown[] = []) => messageOf(ctx.pool.query(text, values));

  it('the record’s CHECKs: the funds share 0 < n ≤ d ≤ 10000, the period ordered, an advisor only ADVISOR_CONFIRMED, VOID with its date and reason, 1–20 references', async () => {
    const pr = await ctx.propertyReference();
    expect(await rawRecord(pr, { building_funds_share_numerator: 0 })).toMatch(/construction_period_interest_funds_share/);
    expect(await rawRecord(pr, { building_funds_share_numerator: 2 })).toMatch(/construction_period_interest_funds_share/);
    expect(await rawRecord(pr, { building_funds_share_numerator: 1, building_funds_share_denominator: 10001 })).toMatch(
      /construction_period_interest_funds_share/,
    );
    expect(await rawRecord(pr, { herstellung_until: '2028-01-14' })).toMatch(/construction_period_interest_period/);
    expect(await rawRecord(pr, { advisor_party_id: await ctx.party('Beraterin') })).toMatch(/construction_period_interest_advisor_state/);
    expect(await rawRecord(pr, { status: 'VOID' })).toMatch(/construction_period_interest_void/);
    expect(await rawRecord(pr, { source_references: [] })).toMatch(/check/i);
    expect(await rawRecord(pr, { review_state: 'SUGGESTED' })).toMatch(/check/i);
    // Counter-checks: the edges accepted.
    expect(await rawRecord(pr, { building_funds_share_numerator: 10000, building_funds_share_denominator: 10000, herstellung_until: '2028-01-15' })).toBe(
      'accepted',
    );
    expect(await rawRecord(pr, { building_funds_share_numerator: 1, building_funds_share_denominator: 10000 })).toBe('accepted');
  });

  it('frozen: never deleted; a VOID record never changes; the Loan and the creation never change; version + 1', async () => {
    const pr = await ctx.propertyReference();
    const { loanId } = await ctx.loan([[pr, 1n, 1n]]);
    const record = await ctx.record(facts([pr], { loanId }), false);
    expect(await sql(`DELETE FROM construction_period_interest WHERE id = $1`, [record.id])).toMatch(/never deleted/);
    const other = await ctx.loan(null);
    expect(await sql(`UPDATE construction_period_interest SET loan_id = $2, version = version + 1 WHERE id = $1`, [record.id, other.loanId])).toMatch(
      /the Loan, the Realm and the creation never change/,
    );
    expect(await sql(`UPDATE construction_period_interest SET measure = 'x' WHERE id = $1`, [record.id])).toMatch(/version \+ 1/);
    // Counter-checks: a change with version + 1, and the serialising no-op, are accepted.
    expect(await sql(`UPDATE construction_period_interest SET measure = 'Anbau', version = version + 1 WHERE id = $1`, [record.id])).toBe('accepted');
    expect(await sql(`UPDATE construction_period_interest SET version = version WHERE id = $1`, [record.id])).toBe('accepted');
    expect(
      await sql(`UPDATE construction_period_interest SET status = 'VOID', voided_at = now(), void_reason = 'falsch', version = version + 1 WHERE id = $1`, [
        record.id,
      ]),
    ).toBe('accepted');
    expect(await sql(`UPDATE construction_period_interest SET notes = 'x', version = version + 1 WHERE id = $1`, [record.id])).toMatch(
      /a void record never changes/,
    );
  });

  it('its PropertyReferences: changed only while VALID, never updated, 1 to 50 at commit, of the Realm', async () => {
    const [pr, pr2] = [await ctx.propertyReference(), await ctx.propertyReference()];
    expect(await rawRecord(pr, {}, [])).toMatch(/0 PropertyReferences; 1 to 50/);
    const many = [];
    for (let i = 0; i < 51; i++) many.push(await ctx.propertyReference());
    expect(await rawRecord(pr, {}, many)).toMatch(/51 PropertyReferences; 1 to 50/);
    expect(await rawRecord(pr, {}, many.slice(0, 50))).toBe('accepted');
    expect(await rawRecord(pr, {}, [await ctx.propertyReference(OTHER_REALM)])).toMatch(/construction_period_interest_property_reference_fk/);
    const record = await ctx.record(facts([pr]), false);
    expect(await sql(`UPDATE construction_period_interest_property SET property_reference_id = $2 WHERE record_id = $1`, [record.id, pr2])).toMatch(
      /never changed/,
    );
    // The last one removed: refused at commit; a second added and the first removed in one transaction: accepted.
    expect(await sql(`DELETE FROM construction_period_interest_property WHERE record_id = $1`, [record.id])).toMatch(/0 PropertyReferences/);
    expect(
      await messageOf(
        ctx.inTransaction(async (c) => {
          await c.query(`INSERT INTO construction_period_interest_property VALUES ($1, $2, $3)`, [record.id, REALM, pr2]);
          await c.query(`DELETE FROM construction_period_interest_property WHERE record_id = $1 AND property_reference_id = $2`, [record.id, pr]);
        }),
      ),
    ).toBe('accepted');
    expect((await ctx.records.void(record.id, REALM, 'falsch erfasst', { actorType: 'USER', actorId: 'x' })).kind).toBe('CHANGED');
    expect(await sql(`INSERT INTO construction_period_interest_property VALUES ($1, $2, $3)`, [record.id, REALM, pr])).toMatch(/only while it is VALID/);
    expect(await sql(`DELETE FROM construction_period_interest_property WHERE record_id = $1`, [record.id])).toMatch(/only while it is VALID/);
  });

  /** A raw classification of a split (past the repository); its message or `accepted`. */
  const rawClassify = (
    splitId: string,
    treatment: string,
    taxCategory: string,
    recordId: string | null,
    realm = REALM,
    rule: string | null = recordId === null ? null : 'DE_CONSTRUCTION_PERIOD_INTEREST',
  ) =>
    sql(
      `INSERT INTO tax_classification (mre_realm_id, source_type, transaction_split_id, tax_category, treatment, review_state, rule_code, rule_version, created_by,
         construction_period_interest_id, treatment_rule_code, treatment_rule_version)
       VALUES ($1, 'TRANSACTION_SPLIT', $2, $3, $4, 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x', $5, $6, $7)`,
      [realm, splitId, taxCategory, treatment, recordId, rule, rule === null ? null : 1],
    );

  it('DE_CONSTRUCTION_PERIOD_INTEREST@1 literally: CAPITALIZED interest without a record refused, by category or by line', async () => {
    const pr = await ctx.propertyReference();
    const { loanId } = await ctx.loan([[pr, 1n, 1n]]);
    const {
      splitIds: [loanSplit, prInterest, repair, repairAsInterest],
    } = await ctx.booked(
      [
        ctx.split('100.00', 'LOAN_INTEREST', { loanId }),
        ctx.split('50.00', 'LOAN_INTEREST', { propertyReferenceId: pr }),
        ctx.split('70.00', 'MAINTENANCE', { propertyReferenceId: pr }),
        ctx.split('80.00', 'MAINTENANCE', { propertyReferenceId: pr }),
      ],
      '2028-03-31',
    );
    expect(await rawClassify(loanSplit as string, 'CAPITALIZED', 'LOAN_INTEREST', null)).toMatch(/CONSTRUCTION_PERIOD_INTEREST_REQUIRED/);
    expect(await rawClassify(prInterest as string, 'CAPITALIZED', 'MAINTENANCE', null)).toMatch(/CONSTRUCTION_PERIOD_INTEREST_REQUIRED/);
    expect(await rawClassify(repairAsInterest as string, 'CAPITALIZED', 'FINANCING_COSTS', null)).toMatch(/CONSTRUCTION_PERIOD_INTEREST_REQUIRED/);
    // Counter-checks: DEDUCTIBLE interest without a record, and a repair capitalised, are accepted.
    expect(await rawClassify(loanSplit as string, 'DEDUCTIBLE', 'LOAN_INTEREST', null)).toBe('accepted');
    expect(await rawClassify(repair as string, 'CAPITALIZED', 'MAINTENANCE', null)).toBe('accepted');
  });

  it('the link: VALID, the split’s Loan, its PropertyReference named, not deductible under CAPITALIZED, interest only, a split with CAPITALIZED or DEDUCTIBLE only', async () => {
    const [pr, elsewhere] = [await ctx.propertyReference(), await ctx.propertyReference()];
    const { loanId } = await ctx.loan([[pr, 1n, 1n]]);
    const other = await ctx.loan([[pr, 1n, 1n]]);
    const booked = await ctx.booked(
      [
        ctx.split('100.00', 'LOAN_INTEREST', { loanId }),
        ctx.split('50.00', 'LOAN_INTEREST', { propertyReferenceId: pr }),
        ctx.split('70.00', 'MAINTENANCE', { propertyReferenceId: pr }),
        ctx.split('60.00', 'LOAN_INTEREST', { loanId }),
        ctx.split('40.00', 'LOAN_INTEREST', { propertyReferenceId: pr }),
      ],
      '2028-03-31',
    );
    const [loanSplit, prSplit, repair, loanSplit2, prSplit2] = booked.splitIds as [string, string, string, string, string];
    const ofLoan = await ctx.record(facts([pr], { loanId }), false);
    const ofOtherLoan = await ctx.record(facts([pr], { loanId: other.loanId }), false);
    const ofProperty = await ctx.record(facts([pr]), false);
    const ofElsewhere = await ctx.record(facts([elsewhere]), false);
    const deductible = await ctx.record(facts([pr], { loanId, advanceExpenseDeductible: true }), false);
    expect(await rawClassify(loanSplit, 'CAPITALIZED', 'LOAN_INTEREST', ofOtherLoan.id)).toMatch(/CONSTRUCTION_PERIOD_INTEREST_MISMATCH/);
    expect(await rawClassify(loanSplit, 'CAPITALIZED', 'LOAN_INTEREST', ofProperty.id)).toMatch(/CONSTRUCTION_PERIOD_INTEREST_MISMATCH/);
    expect(await rawClassify(prSplit, 'CAPITALIZED', 'LOAN_INTEREST', ofElsewhere.id)).toMatch(/CONSTRUCTION_PERIOD_INTEREST_MISMATCH/);
    expect(await rawClassify(prSplit, 'CAPITALIZED', 'LOAN_INTEREST', ofLoan.id)).toMatch(/CONSTRUCTION_PERIOD_INTEREST_MISMATCH/);
    expect(await rawClassify(loanSplit, 'CAPITALIZED', 'LOAN_INTEREST', deductible.id)).toMatch(/CONSTRUCTION_PERIOD_INTEREST_DEDUCTIBLE/);
    expect(await rawClassify(repair, 'CAPITALIZED', 'MAINTENANCE', ofProperty.id)).toMatch(/only on interest/);
    expect(await rawClassify(loanSplit, 'NOT_RELEVANT', 'NOT_RELEVANT', ofLoan.id)).toMatch(/tax_classification_construction_period_treatment/);
    expect(await rawClassify(loanSplit, 'CAPITALIZED', 'LOAN_INTEREST', ofLoan.id, OTHER_REALM)).toMatch(/foreign key|tax_classification_/);
    // 0047's treatment_rule as amended: a link without DE_CONSTRUCTION_PERIOD_INTEREST, or that rule without a link, refused.
    expect(await rawClassify(loanSplit, 'CAPITALIZED', 'LOAN_INTEREST', ofLoan.id, REALM, null)).toMatch(/tax_classification_treatment_rule/);
    expect(await rawClassify(loanSplit, 'CAPITALIZED', 'LOAN_INTEREST', ofLoan.id, REALM, 'DE_ANSCHAFFUNGSNAHE')).toMatch(/tax_classification_treatment_rule/);
    expect(await rawClassify(loanSplit, 'DEDUCTIBLE', 'LOAN_INTEREST', null, REALM, 'DE_CONSTRUCTION_PERIOD_INTEREST')).toMatch(
      /tax_classification_treatment_rule/,
    );
    // Counter-checks: a match is accepted (CAPITALIZED, and DEDUCTIBLE under a deductible record: case A).
    expect(await rawClassify(loanSplit, 'CAPITALIZED', 'LOAN_INTEREST', ofLoan.id)).toBe('accepted');
    expect(await rawClassify(prSplit, 'CAPITALIZED', 'LOAN_INTEREST', ofProperty.id)).toBe('accepted');
    expect(await rawClassify(loanSplit2, 'DEDUCTIBLE', 'LOAN_INTEREST', deductible.id)).toBe('accepted');
    // VOID: refused for a new link; the link already stored stays.
    expect((await ctx.records.void(ofProperty.id, REALM, 'falsch', { actorType: 'USER', actorId: 'x' })).kind).toBe('CHANGED');
    expect(await rawClassify(prSplit2, 'CAPITALIZED', 'LOAN_INTEREST', ofProperty.id)).toMatch(/CONSTRUCTION_PERIOD_INTEREST_VOID/);
    // The link never changes.
    expect(await sql(`UPDATE tax_classification SET construction_period_interest_id = NULL WHERE transaction_split_id = $1`, [prSplit])).toMatch(
      /its construction-period record never changes/,
    );
  });

  it('the indexes of the conditions’ reads: the current classifications naming a record (partial), every classification naming one', async () => {
    const { rows } = await ctx.pool.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname LIKE 'tax_classification_construction_period%' ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual(['tax_classification_construction_period_current', 'tax_classification_construction_period_idx']);
    expect(rows[0].indexdef).toMatch(
      /\(construction_period_interest_id\) WHERE \(\(construction_period_interest_id IS NOT NULL\) AND \(superseded_at IS NULL\)\)/,
    );
    expect(rows[1].indexdef).toMatch(/\(construction_period_interest_id\) WHERE \(construction_period_interest_id IS NOT NULL\)$/);
  });

  it(
    'down refuses while a record exists; without one it drops the tables, the columns and the functions (under MIGRATION_ADVISORY_LOCK)',
    { timeout: 30_000 },
    async () => {
      const downSchema = testSchemaName('construction_period_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema} -c application_name=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        const down = async () => (await import('./migrations/0055_construction_period_interest.js')).down(createDatabase(downPool) as never);
        const { rows } = await downPool.query(
          `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5e9ffff', 'ACTIVE', 'x') RETURNING id`,
          [REALM],
        );
        await downPool.query('BEGIN');
        const created = await downPool.query(
          `INSERT INTO construction_period_interest (mre_realm_id, measure, herstellung_from, use_intent, advance_expense_deductible, building_funds_share_numerator,
           building_funds_share_denominator, earlier_years_treatment, source_references, review_state, created_by)
         VALUES ($1, 'x', '2028-01-01', 'x', false, 1, 1, 'x', ARRAY['x'], 'UNREVIEWED', 'x') RETURNING id`,
          [REALM],
        );
        await downPool.query(`INSERT INTO construction_period_interest_property VALUES ($1, $2, $3)`, [created.rows[0].id, REALM, rows[0].id]);
        await downPool.query('COMMIT');
        let refused = '';
        await withMigrationLock(async () => {
          refused = await messageOf(down()).then((m) => m ?? '');
        });
        expect(refused).toMatch(/a record exists; it is never dropped silently/);
        await downPool.query(`ALTER TABLE construction_period_interest_property DISABLE TRIGGER USER`);
        await downPool.query(`DELETE FROM construction_period_interest_property`);
        await downPool.query(`ALTER TABLE construction_period_interest DISABLE TRIGGER USER`);
        await downPool.query(`DELETE FROM construction_period_interest`);
        await withMigrationLock(down);
        expect((await downPool.query(`SELECT to_regclass('construction_period_interest') AS t`)).rows[0].t).toBeNull();
        const columns = await downPool.query(
          `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name IN ('construction_period_interest_id', 'loan_id', 'allocation_set_id')
           AND table_name IN ('tax_classification', 'depreciation_schedule_version_component')`,
          [downSchema],
        );
        expect(columns.rows).toEqual([]);
        const functions = await downPool.query(
          `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = $1 AND proname LIKE '%construction_period%'`,
          [downSchema],
        );
        expect(functions.rows).toEqual([]);
      } finally {
        await downPool.end();
      }
    },
  );
});
