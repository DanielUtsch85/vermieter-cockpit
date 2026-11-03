import pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { NewTaxClassification, Performance } from '../../domains/taxation/index.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { testSchemaName } from './test-schema.test-support.js';
import { actor, databaseUrl, day, eur, OTHER_REALM, reasonOf, REALM, useTaxWegDatabase, withMigrationLock } from './tax-weg.test-support.js';

/**
 * VC-X-38 Part 2, migration 0062 (api-design.md §59F "As implemented (VC-X-38 Part 2)"; Entscheidung des
 * Projektinhabers, 2026-11-02, 239-2): the partial treatment of a straddling source through the repository (its parts
 * derived from the evidenced points, stored with the classification, recorded in the AuditRecords, superseded and
 * re-classified; no cash row changed; Realm isolation), and each guard past the repository with its counter-check.
 * Acquisition: transfer 2026-03-15, window to 2029-03-15. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('migration 0062: the partial treatment of a straddling source (§59F, 239-2)', () => {
  const { ctx, split, booked, propertyReference, acquisition, member, statement } = useTaxWegDatabase('classification_partial_treatment_test');
  const UUID = /^[0-9a-f-]{36}$/;
  const S3: Performance = {
    from: day('2029-02-01'),
    until: day('2029-04-15'),
    progress: [{ through: day('2029-03-15'), amount: eur('5600.00') }],
    progressEstimated: false,
  };
  const setup = async () => {
    const pr = await propertyReference();
    const acq = await acquisition(pr);
    const { splitIds } = await booked([split('8400.00', 'MAINTENANCE', pr)], '2029-04-30');
    return { pr, acq, splitId: splitIds[0] as string };
  };
  const request = (splitId: string, acq: string, overrides: Partial<NewTaxClassification> = {}): NewTaxClassification => ({
    mreRealmId: REALM,
    sourceType: 'TRANSACTION_SPLIT',
    sourceId: splitId,
    taxCategory: 'MAINTENANCE',
    treatment: 'CAPITALIZED',
    reviewState: 'USER_CONFIRMED',
    supersedes: null,
    notes: null,
    sourceReferences: ['Leistungsstand des Unternehmers zum 15.03.2029 (synthetisch)'],
    anschaffungsnaheAcquisitionId: acq,
    performance: S3,
    partialTreatment: true,
    ...overrides,
  });
  const cashOf = async (splitId: string) =>
    (
      await ctx.pool.query(
        `SELECT to_jsonb(s) AS split, to_jsonb(t) AS tx FROM transaction_split s JOIN ledger_transaction t ON t.id = s.transaction_id WHERE s.id = $1`,
        [splitId],
      )
    ).rows;

  describe('through the repository', () => {
    it('created with its parts (5,600.00 CAPITALIZED, 2,800.00 DEDUCTIBLE); history: create, withdraw by a DEDUCTIBLE classification, partial again; cash unchanged', async () => {
      const { acq, splitId } = await setup();
      const cashBefore = await cashOf(splitId);
      const created = await ctx.classifications.createClassification(request(splitId, acq), actor);
      if (created.kind !== 'CREATED') throw new Error(JSON.stringify(created));
      const parts = (c: { treatmentParts?: readonly { position: number; treatment: string; amount: { amount: string } }[] | null }) =>
        (c.treatmentParts ?? []).map((p) => [p.position, p.treatment, p.amount.amount]);
      expect([created.classification.treatment, parts(created.classification)]).toEqual([
        'CAPITALIZED',
        [
          [1, 'CAPITALIZED', '5600.00'],
          [2, 'DEDUCTIBLE', '2800.00'],
        ],
      ]);
      expect(parts((await ctx.classifications.findClassification(created.classification.id, REALM)) ?? {})).toEqual(parts(created.classification));
      // Withdrawn: superseded by a DEDUCTIBLE classification with the same performance (no parts).
      const { partialTreatment: _whole, ...deductible } = request(splitId, acq, {
        treatment: 'DEDUCTIBLE',
        anschaffungsnaheAcquisitionId: null,
        supersedes: created.classification.id,
      });
      const withdrawn = await ctx.classifications.createClassification(deductible, actor);
      if (withdrawn.kind !== 'CREATED') throw new Error(JSON.stringify(withdrawn));
      expect(withdrawn.classification.treatmentParts ?? null).toBeNull();
      // Re-classified: partial again (a correction is a new classification; the old rows never change).
      const again = await ctx.classifications.createClassification(request(splitId, acq, { supersedes: withdrawn.classification.id }), actor);
      if (again.kind !== 'CREATED') throw new Error(JSON.stringify(again));
      const history = (await ctx.classifications.listHistory('TRANSACTION_SPLIT', splitId, REALM)) ?? [];
      expect(history.map((c) => [c.treatment, parts(c).length, c.supersededBy === null])).toEqual([
        ['CAPITALIZED', 2, false],
        ['DEDUCTIBLE', 0, false],
        ['CAPITALIZED', 2, true],
      ]);
      const audits = await ctx.pool.query(
        `SELECT action, metadata FROM audit_record WHERE entity_type = 'TaxClassification'
           AND entity_id IN (SELECT id::text FROM tax_classification WHERE transaction_split_id = $1) ORDER BY occurred_at, action`,
        [splitId],
      );
      const classified = audits.rows.filter((r) => r.action === 'TAX_CLASSIFIED').map((r) => r.metadata.treatmentParts ?? null);
      const partsJson = [
        { position: 1, treatment: 'CAPITALIZED', amount: { amount: '5600.00', currency: 'EUR' } },
        { position: 2, treatment: 'DEDUCTIBLE', amount: { amount: '2800.00', currency: 'EUR' } },
      ];
      expect(classified).toEqual([partsJson, null, partsJson]);
      expect(audits.rows.filter((r) => r.action === 'TAX_CLASSIFICATION_SUPERSEDED')).toHaveLength(2);
      // No cash correction: the split and its Transaction are byte for byte as before.
      expect(await cashOf(splitId)).toEqual(cashBefore);
    });

    it('refused where the evidenced points leave the part open, an estimated point included; nothing written', async () => {
      const { acq, splitId } = await setup();
      const open = await ctx.classifications.createClassification(
        request(splitId, acq, { performance: { ...S3, progress: [{ through: day('2029-03-31'), amount: eur('6500.00') }] } }),
        actor,
      );
      expect(open).toMatchObject({ kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE', reason: 'PERFORMANCE_REQUIRED', cause: 'SPLIT_NOT_EVIDENCED' });
      const estimated = await ctx.classifications.createClassification(request(splitId, acq, { performance: { ...S3, progressEstimated: true } }), actor);
      expect(estimated).toMatchObject({ cause: 'SPLIT_NOT_EVIDENCED' });
      expect((await ctx.classifications.listHistory('TRANSACTION_SPLIT', splitId, REALM)) ?? []).toEqual([]);
    });

    it('a WEG withdrawal across the transfer date: the parts of its unit share (1,000.00), no cash to correct', async () => {
      const { pr, membershipId } = await member();
      const acq = await acquisition(pr);
      const statementId = await statement(membershipId);
      const created = await ctx.classifications.createClassification(
        {
          mreRealmId: REALM,
          sourceType: 'WEG_RESERVE_WITHDRAWAL',
          sourceId: statementId,
          sourcePosition: 1,
          taxCategory: 'WEG_SPENDING',
          treatment: 'CAPITALIZED',
          reviewState: 'USER_CONFIRMED',
          supersedes: null,
          notes: null,
          sourceReferences: ['Abrechnung des Verwalters (synthetisch)'],
          anschaffungsnaheAcquisitionId: acq,
          performance: {
            from: day('2026-03-01'),
            until: day('2026-04-30'),
            progress: [{ through: day('2026-03-14'), amount: eur('400.00') }],
            progressEstimated: false,
          },
          partialTreatment: true,
        },
        actor,
      );
      if (created.kind !== 'CREATED') throw new Error(JSON.stringify(created));
      expect((created.classification.treatmentParts ?? []).map((p) => [p.treatment, p.amount.amount])).toEqual([
        ['CAPITALIZED', '600.00'],
        ['DEDUCTIBLE', '400.00'],
      ]);
    });

    it('Realm isolation: another Realm cannot classify the split, nor read the classification', async () => {
      const { acq, splitId } = await setup();
      expect(await ctx.classifications.createClassification({ ...request(splitId, acq), mreRealmId: OTHER_REALM }, actor)).toMatchObject({
        kind: 'SOURCE_NOT_FOUND',
      });
      const created = await ctx.classifications.createClassification(request(splitId, acq), actor);
      if (created.kind !== 'CREATED') throw new Error(JSON.stringify(created));
      expect(await ctx.classifications.findClassification(created.classification.id, OTHER_REALM)).toBeUndefined();
    });
  });

  describe('the guards past the repository', () => {
    const insertSql = (columns: string[]) =>
      `INSERT INTO tax_classification (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`;
    const row = (values: Record<string, unknown>) => {
      const all: Record<string, unknown> = {
        mre_realm_id: REALM,
        source_type: 'TRANSACTION_SPLIT',
        tax_category: 'MAINTENANCE',
        treatment: 'CAPITALIZED',
        review_state: 'USER_CONFIRMED',
        rule_code: 'DE_CATEGORY_DEFAULTS',
        rule_version: 1,
        treatment_rule_code: 'DE_ANSCHAFFUNGSNAHE',
        treatment_rule_version: 1,
        created_by: 'x',
        performed_from: '2029-02-01',
        performed_until: '2029-04-15',
        partial_treatment: true,
        ...values,
      };
      return { columns: Object.keys(all), values: Object.values(all) };
    };
    /** One transaction: the classification and its parts, committed; the id, or the refusal's reason. */
    const classify = async (values: Record<string, unknown>, parts: readonly [number, string, string][] = []): Promise<string> => {
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        const { columns, values: params } = row(values);
        const id = (await client.query(insertSql(columns), params)).rows[0].id as string;
        for (const [position, treatment, amount] of parts) {
          await client.query(`INSERT INTO tax_classification_treatment_part (classification_id, position, treatment, amount) VALUES ($1, $2, $3, $4)`, [
            id,
            position,
            treatment,
            amount,
          ]);
        }
        await client.query('COMMIT');
        return id;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        return reasonOf(error as { message?: string });
      } finally {
        client.release();
      }
    };
    /** The CHECKs alone: the guards (triggers) disabled inside a transaction that is rolled back. */
    const checkOnly = async (values: Record<string, unknown>): Promise<string> => {
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE tax_classification DISABLE TRIGGER USER');
        const { columns, values: params } = row(values);
        await client.query(insertSql(columns), params);
        return 'accepted';
      } catch (error) {
        return reasonOf(error as { message?: string });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    const PARTS: [number, string, string][] = [
      [1, 'CAPITALIZED', '5600.00'],
      [2, 'DEDUCTIBLE', '2800.00'],
    ];
    const fresh = async () => {
      const { acq, splitId } = await setup();
      return { transaction_split_id: splitId, anschaffungsnahe_acquisition_id: acq };
    };

    it('tax_classification_partial_treatment: only CAPITALIZED with the link and a performance on MAINTENANCE/WEG_SPENDING, no election; counter-check accepted', async () => {
      const base = await fresh();
      const noLink = { anschaffungsnahe_acquisition_id: null, treatment_rule_code: null, treatment_rule_version: null };
      // Only this CHECK refuses these two: no performance; and DEDUCTIBLE without a link (a plain classification).
      expect(await checkOnly({ ...base, performed_from: null, performed_until: null })).toBe('tax_classification_partial_treatment');
      expect(await checkOnly({ ...base, ...noLink, treatment: 'DEDUCTIBLE' })).toBe('tax_classification_partial_treatment');
      // CAPITALIZED without a link, and another line: refused (0047's CHECKs on the link may refuse first).
      expect(await checkOnly({ ...base, ...noLink })).toBe('tax_classification_partial_treatment');
      expect(await checkOnly({ ...base, tax_category: 'INSURANCE' })).not.toBe('accepted');
      // Counter-checks: the partial treatment as the repository writes it; the same rows without the flag.
      expect(await checkOnly(base)).toBe('accepted');
      expect(await checkOnly({ ...base, ...noLink, treatment: 'DEDUCTIBLE', partial_treatment: false })).toBe('accepted');
    });

    it('the parts at commit: exactly both, summing to the split amount; none without a partial treatment; counter-check: both summing accepted', async () => {
      const refused = '23000';
      expect(await classify(await fresh())).toBe(refused);
      expect(await classify(await fresh(), [[1, 'CAPITALIZED', '5600.00']])).toBe(refused);
      expect(
        await classify(await fresh(), [
          [1, 'CAPITALIZED', '5600.00'],
          [2, 'DEDUCTIBLE', '2799.99'],
        ]),
      ).toBe(refused);
      expect(await classify({ ...(await fresh()), partial_treatment: false, performed_from: '2028-11-02', performed_until: '2028-12-20' }, PARTS)).toBe(
        refused,
      );
      expect(
        await classify(await fresh(), [
          [1, 'DEDUCTIBLE', '5600.00'],
          [2, 'CAPITALIZED', '2800.00'],
        ]),
      ).toBe('tax_classification_treatment_part_kind');
      expect(
        await classify(await fresh(), [
          [1, 'CAPITALIZED', '8400.00'],
          [2, 'DEDUCTIBLE', '0.00'],
        ]),
      ).toBe('tax_classification_treatment_part_amount_check');
      expect(await classify(await fresh(), PARTS)).toMatch(UUID);
    });

    it('the link of a partial treatment: the work overlapping the window and straddling it; counter-check: a straddling one accepted only as partial', async () => {
      const at = async (from: string, until: string, partial: boolean) =>
        classify({ ...(await fresh()), performed_from: from, performed_until: until, partial_treatment: partial }, partial ? PARTS : []);
      expect(await at('2028-11-02', '2028-12-20', true)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
      expect(await at('2029-03-16', '2029-04-15', true)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
      expect(await at('2025-12-01', '2026-03-14', true)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
      expect(await at('2029-02-01', '2029-04-15', false)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
      expect(await at('2029-02-01', '2029-04-15', true)).toMatch(UUID);
      expect(await at('2026-03-01', '2026-04-30', true)).toMatch(UUID);
      expect(await at('2028-11-02', '2028-12-20', false)).toMatch(UUID);
    });

    it('a part added later, changed or deleted is refused; partial_treatment never changes; counter-check: a review step still writes', async () => {
      const id = await classify(await fresh(), PARTS);
      expect(id).toMatch(UUID);
      const run = (sql: string, params: unknown[]) =>
        ctx.pool.query(sql, params).then(
          () => 'accepted',
          (e) => (e as { code: string }).code,
        );
      expect(
        await run(`INSERT INTO tax_classification_treatment_part (classification_id, position, treatment, amount) VALUES ($1, 2, 'DEDUCTIBLE', 1)`, [id]),
      ).toBe('23000');
      expect(await run(`UPDATE tax_classification_treatment_part SET amount = 5600.01 WHERE classification_id = $1 AND position = 1`, [id])).toBe('23000');
      expect(await run(`DELETE FROM tax_classification_treatment_part WHERE classification_id = $1`, [id])).toBe('23000');
      expect(await run(`UPDATE tax_classification SET partial_treatment = false, version = version + 1 WHERE id = $1`, [id])).toBe('23000');
      expect(await run(`UPDATE tax_classification SET review_state = 'NEEDS_REVIEW', version = version + 1 WHERE id = $1`, [id])).toBe('accepted');
    });
  });

  it('down refused with a partial treatment; counter-check: passes without, the column and the table gone', { timeout: 60_000 }, async () => {
    const schema = testSchemaName('classification_partial_down_test');
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
    const migration = migrations['0062_classification_partial_treatment'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
    const failure = async (step: 'up' | 'down') => {
      let error: unknown;
      await withMigrationLock(async () => {
        error = await migration[step](createDatabase(pool) as never).then(
          () => undefined,
          (e: unknown) => e,
        );
      });
      return (error as { code?: string } | undefined)?.code ?? 'accepted';
    };
    try {
      await migrateToLatest(pool, { migrationTableSchema: schema });
      // A partial treatment written past the guards (triggers off; the source and the link's foreign key dropped in this
      // throwaway schema): they are not what is checked here.
      await pool.query(`ALTER TABLE tax_classification DISABLE TRIGGER USER`);
      await pool.query(`ALTER TABLE tax_classification DROP CONSTRAINT tax_classification_one_source`);
      const fk = await pool.query(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'tax_classification'::regclass AND contype = 'f'
           AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'tax_classification'::regclass AND attname = 'anschaffungsnahe_acquisition_id')]`,
      );
      for (const r of fk.rows) await pool.query(`ALTER TABLE tax_classification DROP CONSTRAINT "${r.conname as string}"`);
      await pool.query(
        `INSERT INTO tax_classification (mre_realm_id, source_type, tax_category, treatment, review_state, rule_code, rule_version, created_by, performed_from,
           performed_until, partial_treatment, anschaffungsnahe_acquisition_id, treatment_rule_code, treatment_rule_version)
         VALUES ($1, 'TRANSACTION_SPLIT', 'MAINTENANCE', 'CAPITALIZED', 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x', '2029-02-01', '2029-04-15', true,
           gen_random_uuid(), 'DE_ANSCHAFFUNGSNAHE', 1)`,
        [REALM],
      );
      expect(await failure('down')).toBe('23514');
      expect((await pool.query(`SELECT count(*)::int AS n FROM tax_classification WHERE partial_treatment`)).rows[0].n).toBe(1);
      await pool.query(`DELETE FROM tax_classification`);
      await pool.query(`ALTER TABLE tax_classification ENABLE TRIGGER USER`);
      expect(await failure('down')).toBe('accepted');
      const gone = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name IN ('tax_classification', 'tax_classification_treatment_part')
           AND column_name IN ('partial_treatment', 'position')`,
        [schema],
      );
      expect(gone.rows).toEqual([]);
      expect(await failure('up')).toBe('accepted');
    } finally {
      await pool.end();
    }
  });
});
