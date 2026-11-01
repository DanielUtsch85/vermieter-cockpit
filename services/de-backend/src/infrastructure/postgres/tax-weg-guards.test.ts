import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { RuleRegistry } from '../../domains/taxation/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { checkStoredRuleReferences } from './tax-rule-check.js';
import { testSchemaName } from './test-schema.test-support.js';
import { actor, AT, databaseUrl, day, eur, OTHER_REALM, reasonOf, REALM, useTaxWegDatabase, withMigrationLock } from './tax-weg.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import type { PostgresWegAnnualStatementRepository } from './weg-annual-statement-repository.js';

/**
 * VC-7-03 persistence (api-design.md §58B, migration 0047) past the repository: every new CHECK and guard, the VC-X-26
 * indexes, the start check, `down`, and the locks under RC and RR (P7-D9). The classifications through the repository
 * are in `tax-weg-repository.test.ts`; the setup is in `tax-weg.test-support.ts`. Figures and names are synthetic.
 */

describe.skipIf(databaseUrl === undefined)('WEG spending, Erhaltungsaufwand and § 82b (§58B): guards, start check, down and locks', () => {
  const { ctx, member, line, statement, assessment, request, split, booked, acquisition, propertyReference, withdrawalMeaning, useMeaning } =
    useTaxWegDatabase('tax_weg_guards_test');
  let pool: pg.Pool;
  let classifications: PostgresTaxClassificationRepository;
  let statements: PostgresWegAnnualStatementRepository;
  beforeAll(() => {
    ({ pool, classifications, statements } = ctx);
  });

  /** A confirmed MAINTENANCE split of 900.00 in a schema of its own (the start check and `down`). */
  async function confirmedSplitIn(target: pg.Pool): Promise<string> {
    const targetDb = createDatabase(target);
    const pr = (
      await target.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f6aa01', 'ACTIVE', 'x') RETURNING id`,
        [REALM],
      )
    ).rows[0].id as string;
    const account = (
      await target.query(
        `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, status, created_by) VALUES ($1, 'BANK', 'G', 'EUR', 'OPEN', 'x') RETURNING id`,
        [REALM],
      )
    ).rows[0].id as string;
    const targetTransactions = new PostgresTransactionRepository(targetDb);
    const created = await targetTransactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: account,
        amount: eur('900.00'),
        direction: 'OUTFLOW',
        bookingDate: day('2026-06-01'),
        valueDate: null,
        description: 'x',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    await new PostgresTransactionSplitRepository(targetDb).replaceSplits(created.transaction.id, REALM, [split('900.00', 'MAINTENANCE', pr)], actor);
    await targetTransactions.confirm(created.transaction.id, REALM, actor);
    return (await target.query(`SELECT id FROM transaction_split`)).rows[0].id as string;
  }

  describe('schema past the repository (0047)', () => {
    const insert = (values: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        mre_realm_id: REALM,
        tax_category: 'WEG_SPENDING',
        treatment: 'DEDUCTIBLE',
        review_state: 'USER_CONFIRMED',
        rule_code: 'DE_WEG_SPENDING',
        rule_version: 1,
        created_by: 'x',
        ...values,
      };
      const columns = Object.keys(row);
      return pool
        .query(
          `INSERT INTO tax_classification (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          Object.values(row),
        )
        .then(
          (r) => r.rows[0].id as string,
          (error) => reasonOf(error),
        );
    };
    const withdrawalRow = (st: string, position: number, share: string, extra: Record<string, unknown> = {}) =>
      insert({
        source_type: 'WEG_RESERVE_WITHDRAWAL',
        weg_annual_statement_id: st,
        weg_reserve_position: position,
        weg_withdrawal_unit_share: share,
        ...extra,
      });
    const useRow = (a: string, position: number, date: string, share: string, extra: Record<string, unknown> = {}) =>
      insert({
        source_type: 'WEG_ASSESSMENT_USE',
        weg_special_assessment_id: a,
        weg_use_position: position,
        weg_use_date: date,
        weg_use_unit_share: share,
        ...extra,
      });

    it('the withdrawal guard: confirmed only, a withdrawal line, the exact unit share (one cent off either way, the half), tax_year of an undated line', async () => {
      const { membershipId } = await member();
      const st = await statement(membershipId, {
        reserve: {
          source: 'ANNUAL_STATEMENT',
          // 0.04 × 125/1000 = 0.005: the exact half, rounded up to 0.01.
          lines: [line(1, 'WITHDRAWAL', '8000.00', '2026-06-15'), line(2, 'WITHDRAWAL', '0.04'), line(3, 'CONTRIBUTION', null)],
          unitShareOpening: null,
          unitShareClosing: null,
        },
      });
      expect(await withdrawalRow(st, 1, '999.99')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await withdrawalRow(st, 1, '1000.01')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await withdrawalRow(st, 3, '1.00')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await withdrawalRow(st, 9, '1.00')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await withdrawalRow(st, 1, '1000.00', { tax_year: 2026 })).toBe('(TAX_YEAR_OUT_OF_RANGE)');
      expect(await withdrawalRow(st, 2, '0.01', { tax_year: 2025 })).toBe('(TAX_YEAR_OUT_OF_RANGE)');
      expect(await withdrawalRow(st, 2, '0.01', { tax_year: 2026 })).toMatch(/^[0-9a-f-]{36}$/);
      expect(await withdrawalRow(st, 1, '1000.00')).toMatch(/^[0-9a-f-]{36}$/);
      expect(await withdrawalRow(st, 1, '1000.00')).toBe('tax_classification_current_withdrawal');
      const draft = await statement((await member()).membershipId, {}, false);
      expect(await withdrawalRow(draft, 1, '1000.00')).toBe('(SOURCE_NOT_COUNTED)');
      const foreign = await statement((await member({ realm: OTHER_REALM })).membershipId, {}, true, OTHER_REALM);
      expect(await withdrawalRow(foreign, 1, '1000.00')).toBe('tax_classification_statement_fk');
      // A superseded statement takes none.
      const { membershipId: m2 } = await member();
      const old = await statement(m2);
      await statement(m2, { supersedes: old });
      expect(await withdrawalRow(old, 1, '1000.00')).toBe('(SOURCE_NOT_COUNTED)');
    });

    it('the lines (DE_WEG_SPENDING@1), the fit, the distribution, the fields; the use guard; net above gross on each source; the split guard', async () => {
      const { pr, membershipId } = await member();
      const st = await statement(membershipId);
      expect(await withdrawalRow(st, 1, '1000.00', { tax_category: 'NOT_RELEVANT', treatment: 'DEDUCTIBLE' })).toBe('tax_classification_fit');
      expect(await withdrawalRow(st, 1, '1000.00', { tax_category: 'MAINTENANCE' })).toBe('tax_classification_weg_lines');
      expect(
        await withdrawalRow(st, 1, '1000.00', {
          treatment: 'DISTRIBUTED_82B',
          distribution_years: 1,
          mostly_residential_confirmed: true,
          treatment_rule_code: 'DE_82B_DISTRIBUTION',
          treatment_rule_version: 1,
        }),
      ).toBe('tax_classification_distribution');
      expect(
        await withdrawalRow(st, 1, '1000.00', {
          treatment: 'DISTRIBUTED_82B',
          distribution_years: 6,
          mostly_residential_confirmed: true,
          treatment_rule_code: 'DE_82B_DISTRIBUTION',
          treatment_rule_version: 1,
        }),
      ).toBe('tax_classification_distribution');
      expect(
        await withdrawalRow(st, 1, '1000.00', {
          treatment: 'DISTRIBUTED_82B',
          distribution_years: 3,
          treatment_rule_code: 'DE_82B_DISTRIBUTION',
          treatment_rule_version: 1,
        }),
      ).toBe('tax_classification_distribution');
      expect(await withdrawalRow(st, 1, '1000.00', { treatment: 'DISTRIBUTED_82B', distribution_years: 3, mostly_residential_confirmed: true })).toBe(
        'tax_classification_treatment_rule',
      );
      expect(await withdrawalRow(st, 1, '1000.00', { net_amount: '1000.01' })).toBe('tax_classification_erhaltung_fields');
      expect(await withdrawalRow(st, 1, '1000.00', { refund_of_year: 2026 })).toBe('tax_classification_weg_source_fields');
      const a = await assessment(membershipId, [{ position: 1, date: '2026-09-01', unitShare: '3000.00' }]);
      expect(await useRow(a, 1, '2026-09-02', '3000.00')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await useRow(a, 1, '2026-09-01', '2999.99')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await useRow(a, 1, '2026-09-01', '3000.00', { net_amount: '3000.01' })).toBe('tax_classification_erhaltung_fields');
      expect(await useRow(a, 1, '2026-09-01', '3000.00', { tax_year: 2026 })).toBe('tax_classification_weg_source_fields');
      const ok = await useRow(a, 1, '2026-09-01', '3000.00', { net_amount: '3000.00' });
      expect(ok).toMatch(/^[0-9a-f-]{36}$/);
      expect(await useRow(a, 1, '2026-09-01', '3000.00')).toBe('tax_classification_current_use');
      // A use of a VOID assessment counts nowhere (ASSESSMENT_VOID, review on #169), however well position, date and share fit.
      const voided = await assessment(membershipId, [{ position: 1, date: '2026-09-01', unitShare: '3000.00' }]);
      await pool.query(
        `UPDATE weg_special_assessment SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1 WHERE id = $1`,
        [voided],
      );
      expect(await useRow(voided, 1, '2026-09-01', '3000.00')).toBe('(SOURCE_NOT_COUNTED)');
      // A change of a new column.
      expect(await pool.query(`UPDATE tax_classification SET net_amount = 1, version = version + 1 WHERE id = $1`, [ok]).then(() => 'accepted', reasonOf)).toBe(
        'never change',
      );
      // The position without its source (on a split row): the WEG source fields hold together.
      // On a split: WEG_SPENDING refused; net above gross; DISTRIBUTED_82B only on an OUTFLOW; the WEG_FUNDS hard rule.
      const { splitIds } = await booked([split('500.00', 'MAINTENANCE', pr), split('100.00', 'WEG_SPECIAL_ASSESSMENT', pr)], '2026-06-01');
      const [repair, funds] = splitIds as [string, string];
      const splitRow = (splitId: string, extra: Record<string, unknown> = {}) =>
        insert({ source_type: 'TRANSACTION_SPLIT', transaction_split_id: splitId, tax_category: 'MAINTENANCE', rule_code: 'DE_CATEGORY_DEFAULTS', ...extra });
      expect(await splitRow(repair, { tax_category: 'WEG_SPENDING' })).toBe('tax_classification_weg_lines');
      expect(await splitRow(repair, { weg_reserve_position: 1 })).toBe('tax_classification_weg_source_fields');
      expect(await splitRow(repair, { net_amount: '500.01' })).toBe('(NET_AMOUNT_EXCEEDS_GROSS)');
      expect(await splitRow(repair, { annually_recurring: true, tax_category: 'INSURANCE' })).toBe('tax_classification_erhaltung_fields');
      expect(
        await splitRow(repair, {
          tax_category: 'INSURANCE',
          treatment: 'DISTRIBUTED_82B',
          distribution_years: 2,
          mostly_residential_confirmed: true,
          treatment_rule_code: 'DE_82B_DISTRIBUTION',
          treatment_rule_version: 1,
        }),
      ).toBe('tax_classification_fit');
      expect(await splitRow(funds, { tax_category: 'MAINTENANCE', treatment: 'DEDUCTIBLE' })).toBe('(TREATMENT_NOT_ALLOWED)');
      const refund = await booked([split('50.00', 'MAINTENANCE', pr)], '2026-06-02', 'INFLOW');
      expect(
        await splitRow(refund.splitIds[0] as string, {
          treatment: 'DISTRIBUTED_82B',
          distribution_years: 2,
          mostly_residential_confirmed: true,
          treatment_rule_code: 'DE_82B_DISTRIBUTION',
          treatment_rule_version: 1,
        }),
      ).toBe('(DISTRIBUTION_NOT_ALLOWED)');
      expect(await splitRow(repair, { net_amount: '500.00' })).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('the anschaffungsnahe guard: confirmed, the source’s PropertyReference, inside the three years (literally)', async () => {
      const pr = await propertyReference();
      const acq = await acquisition(pr);
      const draftPr = await propertyReference();
      const draft = await acquisition(draftPr, { confirm: false });
      const row = async (date: string, acquisitionId: string, on = pr) => {
        const { splitIds } = await booked([split('100.00', 'MAINTENANCE', on)], date);
        return insert({
          source_type: 'TRANSACTION_SPLIT',
          transaction_split_id: splitIds[0],
          tax_category: 'MAINTENANCE',
          treatment: 'CAPITALIZED',
          rule_code: 'DE_CATEGORY_DEFAULTS',
          anschaffungsnahe_acquisition_id: acquisitionId,
          treatment_rule_code: 'DE_ANSCHAFFUNGSNAHE',
          treatment_rule_version: 1,
        });
      };
      expect(await row('2029-03-16', acq)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
      expect(await row('2026-03-14', acq)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
      expect(await row('2027-01-01', draft, draftPr)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
      expect(await row('2029-03-15', acq)).toMatch(/^[0-9a-f-]{36}$/);
      const otherPr = await propertyReference();
      const { splitIds } = await booked([split('100.00', 'MAINTENANCE', otherPr)], '2027-01-01');
      expect(
        await insert({
          source_type: 'TRANSACTION_SPLIT',
          transaction_split_id: splitIds[0],
          tax_category: 'MAINTENANCE',
          treatment: 'CAPITALIZED',
          rule_code: 'DE_CATEGORY_DEFAULTS',
          anschaffungsnahe_acquisition_id: acq,
          treatment_rule_code: 'DE_ANSCHAFFUNGSNAHE',
          treatment_rule_version: 1,
        }),
      ).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
    });

    it('the VC-X-26 indexes serve the first page of both name-ordered lists (the plan)', async () => {
      const sent: CompiledQuery[] = [];
      const logged = new Kysely<Database>({
        dialect: new PostgresDialect({ pool }),
        log: (event) => {
          if (event.level === 'query') sent.push(event.query);
        },
      });
      const realms = 60;
      await pool.query(
        `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, status, created_by)
         SELECT 'plan-' || r, 'BANK', 'Konto ' || g, 'EUR', 'OPEN', 'x' FROM generate_series(1, $1::int) r, generate_series(1, 40) g`,
        [realms],
      );
      await pool.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, display_name, created_by)
         SELECT 'plan-' || r, lpad(to_hex(r * 1000 + g), 24, '0'), 'ACTIVE', 'Wohnung ' || g, 'x' FROM generate_series(1, $1::int) r, generate_series(1, 40) g`,
        [realms],
      );
      await pool.query(`ANALYZE financial_account; ANALYZE property_reference`);
      const planOf = async (query: CompiledQuery | undefined) => {
        if (query === undefined) throw new Error('the page query was not sent');
        const { rows } = await pool.query(`EXPLAIN (FORMAT JSON) ${query.sql}`, [...query.parameters]);
        return JSON.stringify(rows[0]['QUERY PLAN']);
      };
      sent.length = 0;
      await new PostgresFinancialAccountRepository(logged).list('plan-7', {}, { page: 1, pageSize: 10 });
      const accountPlan = await planOf(sent.find((q) => q.sql.includes('order by')));
      expect(accountPlan).toContain('financial_account_realm_name_idx');
      expect(accountPlan).not.toContain('"Sort"');
      sent.length = 0;
      await new PostgresPropertyReferenceRepository(logged).list('plan-7', {}, { page: 1, pageSize: 10 });
      const referencePlan = await planOf(sent.find((q) => q.sql.includes('order by')));
      expect(referencePlan).toContain('property_reference_realm_name_idx');
      expect(referencePlan).not.toContain('"Sort"');
    });

    // Migrates a schema of its own in the test body: waits for MIGRATION_ADVISORY_LOCK like a beforeAll (vitest.config.ts).
    it('the start check resolves the treatmentRule too: a stored unknown one stops the start', { timeout: 30_000 }, async () => {
      const startSchema = testSchemaName('tax_weg_start_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${startSchema}"`);
      await admin.end();
      const startPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${startSchema} -c application_name=${startSchema}`, max: 2 });
      try {
        await migrateToLatest(startPool, { migrationTableSchema: startSchema });
        const startDb = createDatabase(startPool);
        const splitId = await confirmedSplitIn(startPool);
        const repository = new PostgresTaxClassificationRepository(startDb);
        const elected = await repository.createClassification(
          {
            mreRealmId: REALM,
            sourceType: 'TRANSACTION_SPLIT',
            sourceId: splitId,
            taxCategory: 'MAINTENANCE',
            treatment: 'DISTRIBUTED_82B',
            reviewState: 'USER_CONFIRMED',
            supersedes: null,
            notes: null,
            sourceReferences: [],
            distributionYears: 3,
            mostlyResidentialConfirmed: true,
          },
          actor,
        );
        expect(elected.kind).toBe('CREATED');
        expect(await checkStoredRuleReferences(startDb)).toEqual([
          { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 },
          { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
        ]);
        // A registry without DE_82B_DISTRIBUTION@1: the stored treatmentRule no longer resolves.
        const without = new RuleRegistry(
          TAX_RULES.codes()
            .filter((c) => c !== 'DE_82B_DISTRIBUTION')
            .flatMap((c) => TAX_RULES.versions(c)),
        );
        await expect(checkStoredRuleReferences(startDb, without)).rejects.toThrow('Stored tax rule references are not registered: DE_82B_DISTRIBUTION@1');
      } finally {
        await startPool.end();
      }
    });

    it(
      'down refuses while a WEG classification exists; then restores 0046 and drops the columns, guards and indexes (under MIGRATION_ADVISORY_LOCK)',
      { timeout: 30_000 },
      async () => {
        const downSchema = testSchemaName('tax_weg_down_test');
        const admin = new pg.Client({ connectionString: databaseUrl });
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${downSchema}"`);
        await admin.end();
        const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema} -c application_name=${downSchema}`, max: 2 });
        try {
          await migrateToLatest(downPool, { migrationTableSchema: downSchema });
          const down = async () => (await import('./migrations/0047_tax_weg_spending.js')).down(createDatabase(downPool) as never);
          // A classification with a field of §58B: down refuses and changes nothing; once it is gone, down proceeds.
          const startDb = createDatabase(downPool);
          const splitId = await confirmedSplitIn(downPool);
          const created = await new PostgresTaxClassificationRepository(startDb).createClassification(
            {
              mreRealmId: REALM,
              sourceType: 'TRANSACTION_SPLIT',
              sourceId: splitId,
              taxCategory: 'MAINTENANCE',
              treatment: 'DEDUCTIBLE',
              reviewState: 'USER_CONFIRMED',
              supersedes: null,
              notes: null,
              sourceReferences: [],
              annuallyRecurring: true,
            },
            actor,
          );
          expect(created.kind).toBe('CREATED');
          let refused = '';
          await withMigrationLock(async () => {
            refused = await down().then(
              () => 'accepted',
              (error: { message?: string }) => error.message ?? '',
            );
          });
          expect(refused).toContain('down 0047');
          expect((await downPool.query(`SELECT count(*)::int AS n FROM tax_classification WHERE annually_recurring`)).rows[0].n).toBe(1);
          await downPool.query(`ALTER TABLE tax_classification DISABLE TRIGGER USER`);
          await downPool.query(`DELETE FROM tax_classification`);
          await downPool.query(`ALTER TABLE tax_classification ENABLE TRIGGER USER`);
          await withMigrationLock(down);
          const columns = await downPool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tax_classification'
             AND column_name IN ('weg_annual_statement_id', 'weg_use_position', 'net_amount', 'annually_recurring', 'distribution_years', 'treatment_rule_code')`,
            [downSchema],
          );
          expect(columns.rows).toEqual([]);
          const indexes = await downPool.query(
            `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname IN ('property_reference_realm_name_idx', 'financial_account_realm_name_idx',
             'tax_classification_current_withdrawal', 'tax_classification_current_use')`,
            [downSchema],
          );
          expect(indexes.rows).toEqual([]);
          const triggers = await downPool.query(
            `SELECT tgname FROM pg_trigger WHERE tgrelid = 'tax_classification'::regclass AND NOT tgisinternal ORDER BY tgname`,
          );
          expect(triggers.rows.map((r) => r.tgname)).toEqual([
            'tax_classification_chain',
            'tax_classification_deposit_counts',
            'tax_classification_deposit_treatment',
            'tax_classification_frozen',
            'tax_classification_initial',
            'tax_classification_source_counts',
            'tax_classification_source_fixed',
            'tax_classification_tax_year',
            'tax_classification_treatment',
          ]);
          const checks = await downPool.query(
            `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
            WHERE nspname = $1 AND conname = 'tax_classification_source_type_check'`,
            [downSchema],
          );
          expect(String(checks.rows[0].def)).not.toContain('WEG_RESERVE_WITHDRAWAL');
        } finally {
          await downPool.end();
        }
      },
    );
  });

  describe('concurrency (P7-D9)', () => {
    const waitForLock = async (text: string) => {
      const deadline = Date.now() + 5_000;
      while (
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = current_setting('application_name') AND query LIKE $1`,
              [`%${text}%`],
            )
          ).rows[0].count,
        ) < 1
      ) {
        if (Date.now() > deadline) throw new Error('no session waits on a lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const insertWithdrawal = `INSERT INTO tax_classification (mre_realm_id, source_type, weg_annual_statement_id, weg_reserve_position, weg_withdrawal_unit_share,
         tax_category, treatment, review_state, rule_code, rule_version, created_by)
       VALUES ($1, 'WEG_RESERVE_WITHDRAWAL', $2, 1, 1000.00, 'WEG_SPENDING', 'DEDUCTIBLE', 'USER_CONFIRMED', 'DE_WEG_SPENDING', 1, 'x')`;
    const insertUse = `INSERT INTO tax_classification (mre_realm_id, source_type, weg_special_assessment_id, weg_use_position, weg_use_date, weg_use_unit_share,
         tax_category, treatment, review_state, rule_code, rule_version, created_by)
       VALUES ($1, 'WEG_ASSESSMENT_USE', $2, 1, '2026-09-01', 3000.00, 'WEG_SPENDING', 'DEDUCTIBLE', 'USER_CONFIRMED', 'DE_WEG_SPENDING', 1, 'x')`;
    const supersede = async (client: pg.PoolClient, old: string, successor: string) => {
      await client.query(`UPDATE weg_annual_statement SET status = 'SUPERSEDED', superseded_by_id = $2, version = version + 1 WHERE id = $1`, [old, successor]);
      await client.query(
        `UPDATE weg_annual_statement SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', version = version + 1 WHERE id = $1`,
        [successor],
      );
    };
    async function pair() {
      const { membershipId } = await member();
      const old = await statement(membershipId);
      const successor = await statement(membershipId, { supersedes: old }, false);
      return { old, successor };
    }

    it('RC: a withdrawal classification waiting on the confirm superseding its statement sees it (repository); the other order proceeds and stops counting', async () => {
      const { old, successor } = await pair();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await supersede(holder, old, successor);
        const creating = classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', old, 1), actor);
        await waitForLock('update "weg_annual_statement"');
        await holder.query('COMMIT');
        expect(await creating).toMatchObject({ kind: 'WEG_SOURCE_NOT_COUNTED', reason: 'STATEMENT_SUPERSEDED' });
      } finally {
        holder.release();
      }
      const second = await pair();
      const classifier = await pool.connect();
      try {
        await classifier.query('BEGIN');
        await classifier.query(insertWithdrawal, [REALM, second.old]);
        const confirming = statements.confirmStatement(second.successor, REALM, AT, actor);
        await waitForLock('"weg_annual_statement"');
        await classifier.query('COMMIT');
        expect((await confirming).kind).toBe('CONFIRMED');
        expect(await withdrawalMeaning(second.old, 1)).toMatchObject({ origin: 'CLASSIFICATION', counts: false, notCountedReason: 'STATEMENT_SUPERSEDED' });
      } finally {
        classifier.release();
      }
    });

    it('RR: a withdrawal classification and the superseding confirm, both orders: the later one fails to serialise', async () => {
      for (const first of ['classify', 'supersede'] as const) {
        const { old, successor } = await pair();
        const [a, b] = [await pool.connect(), await pool.connect()];
        try {
          await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await a.query('SELECT count(*) FROM weg_annual_statement');
          await b.query('SELECT count(*) FROM tax_classification');
          if (first === 'classify') await a.query(insertWithdrawal, [REALM, old]);
          else await supersede(a, old, successor);
          const late = (first === 'classify' ? supersede(b, old, successor) : b.query(insertWithdrawal, [REALM, old])).then(
            () => 'written',
            (error: { code?: string }) => error.code,
          );
          await waitForLock(first === 'classify' ? 'UPDATE weg_annual_statement SET status' : 'INSERT INTO tax_classification');
          await a.query('COMMIT');
          expect(await late, first).toBe('40001');
          await b.query('ROLLBACK');
        } finally {
          a.release();
          b.release();
        }
      }
    });

    it('a use classification against PUT …/uses and against a void: RC sees the other, RR fails to serialise, both orders', async () => {
      const changeUses = `UPDATE weg_special_assessment SET uses = '[{"position":1,"date":"2026-09-02","description":"x","unitShare":{"amount":"3000.00","currency":"EUR"}}]'::jsonb,
           version = version + 1 WHERE id = $1`;
      const voidIt = `UPDATE weg_special_assessment SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1 WHERE id = $1`;
      for (const [writer, reason] of [
        [changeUses, 'USE_CHANGED'],
        [voidIt, 'ASSESSMENT_VOID'],
      ] as const) {
        const fresh = async () => assessment((await member()).membershipId, [{ position: 1, date: '2026-09-01', unitShare: '3000.00' }]);
        // RC: the create waits on the writer and sees it.
        const a1 = await fresh();
        const holder = await pool.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(writer, [a1]);
          const creating = classifications.createClassification(request('WEG_ASSESSMENT_USE', a1, 1), actor);
          await waitForLock('update "weg_special_assessment"');
          await holder.query('COMMIT');
          const outcome = await creating;
          if (reason === 'USE_CHANGED') expect(outcome, reason).toMatchObject({ kind: 'CREATED', classification: { assessmentUse: { date: '2026-09-02' } } });
          else expect(outcome, reason).toMatchObject({ kind: 'WEG_SOURCE_NOT_COUNTED', reason });
        } finally {
          holder.release();
        }
        // RC, the other order: the writer proceeds; the classification stops counting on read.
        const a2 = await fresh();
        const classifier = await pool.connect();
        try {
          await classifier.query('BEGIN');
          await classifier.query(insertUse, [REALM, a2]);
          const writing = pool.query(writer, [a2]).then(() => 'written', reasonOf);
          await waitForLock('UPDATE weg_special_assessment');
          await classifier.query('COMMIT');
          expect(await writing).toBe('written');
          if (reason === 'USE_CHANGED') expect(await useMeaning(a2, 1)).toMatchObject({ counts: false, notCountedReason: 'USE_CHANGED' });
          else expect(await useMeaning(a2, 1)).toMatchObject({ counts: false, notCountedReason: 'ASSESSMENT_VOID' });
        } finally {
          classifier.release();
        }
        // RR: both orders, the later one fails.
        for (const first of ['classify', 'write'] as const) {
          const a3 = await fresh();
          const [x, y] = [await pool.connect(), await pool.connect()];
          try {
            await x.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
            await y.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
            await x.query('SELECT count(*) FROM weg_special_assessment');
            await y.query('SELECT count(*) FROM tax_classification');
            await x.query(first === 'classify' ? insertUse : writer, first === 'classify' ? [REALM, a3] : [a3]);
            const late = (first === 'classify' ? y.query(writer, [a3]) : y.query(insertUse, [REALM, a3])).then(
              () => 'written',
              (error: { code?: string }) => error.code,
            );
            await waitForLock(first === 'classify' ? 'UPDATE weg_special_assessment' : 'INSERT INTO tax_classification');
            await x.query('COMMIT');
            expect(await late, `${reason} ${first}`).toBe('40001');
            await y.query('ROLLBACK');
          } finally {
            x.release();
            y.release();
          }
        }
      }
    });

    it('two creates for one withdrawal: the second waits and sees CLASSIFICATION_EXISTS; never two current', async () => {
      const { membershipId } = await member();
      const st = await statement(membershipId);
      const outcomes = await Promise.all([
        classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1), actor),
        classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1), actor),
      ]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(['CLASSIFICATION_EXISTS', 'CREATED']);
      expect(
        Number((await pool.query(`SELECT count(*) FROM tax_classification WHERE weg_annual_statement_id = $1 AND superseded_at IS NULL`, [st])).rows[0].count),
      ).toBe(1);
    });
  });
});
