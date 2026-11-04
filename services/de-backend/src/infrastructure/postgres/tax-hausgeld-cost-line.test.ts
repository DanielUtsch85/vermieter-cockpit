import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import type { NewStatementCostLine } from '../../domains/weg/index.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { type PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { effectsOf } from './tax-treatment-effects.js';
import { testSchemaName } from './test-schema.test-support.js';
import { actor, databaseUrl, day, eur, OTHER_REALM, reasonOf, REALM, UNKNOWN, useTaxWegDatabase, withMigrationLock } from './tax-weg.test-support.js';
import type { NewTaxClassification } from '../../domains/taxation/index.js';

/**
 * VC-X-27 persistence (api-design.md §58M, migration 0068; Entscheidung des Projektinhabers, 2026-11-04): the
 * classification of a WEG statement cost line through the repository (the order of checks, every refusal, supersede,
 * history, §57), the check reading it in one snapshot, and 0068 past the repository (each guard with its counter-check,
 * `down`). Realm isolation throughout. Figures and names are synthetic.
 */

const cost = (
  position: number,
  account: string,
  group: 'RECOVERABLE' | 'NON_RECOVERABLE',
  unitShare: string,
  classification: NewStatementCostLine['classification'] = null,
): NewStatementCostLine => ({
  position,
  account,
  group,
  allocationKey: 'MEA',
  allocationTotal: null,
  allocationShare: null,
  totalAmount: eur(unitShare),
  unitShare: eur(unitShare),
  classification,
});
/** The statement of 2027: Hausmeister (RECOVERABLE), Fassade 2,000.00 and Verwaltung 600.00 (NON_RECOVERABLE), Rücklage (RESERVE), a credit. */
const LINES = [
  cost(1, 'Hausmeister', 'RECOVERABLE', '1800.00'),
  cost(3, 'Instandsetzung Fassade', 'NON_RECOVERABLE', '2000.00'),
  cost(4, 'Verwaltervergütung', 'NON_RECOVERABLE', '600.00'),
  cost(5, 'Zuführung Erhaltungsrücklage', 'NON_RECOVERABLE', '1200.00', 'RESERVE'),
  cost(6, 'Gutschrift Versicherung', 'NON_RECOVERABLE', '-500.00'),
  cost(7, 'Rundung', 'NON_RECOVERABLE', '0.00'),
];
const YEAR_2027 = { financialYear: 2027, periodFrom: day('2027-01-01'), periodUntil: day('2027-12-31'), costLines: LINES } as const;

describe.skipIf(databaseUrl === undefined)('a WEG statement cost line as a source of the check (§58M, migration 0068)', () => {
  const { ctx, member, statement, acquisition } = useTaxWegDatabase('tax_hausgeld_cost_line_test');
  let pool: pg.Pool;
  let classifications: PostgresTaxClassificationRepository;
  beforeAll(() => {
    ({ pool, classifications } = ctx);
  });

  const request = (sourceId: string, sourcePosition: number, overrides: Partial<NewTaxClassification> = {}): NewTaxClassification => ({
    mreRealmId: REALM,
    sourceType: 'WEG_STATEMENT_COST_LINE',
    sourceId,
    sourcePosition,
    taxCategory: 'MAINTENANCE',
    treatment: 'DEDUCTIBLE',
    reviewState: 'USER_CONFIRMED',
    supersedes: null,
    notes: null,
    sourceReferences: [],
    ...overrides,
  });
  const create = (r: NewTaxClassification) => classifications.createClassification(r, actor);
  const kindOf = async (r: NewTaxClassification) => {
    const outcome = await create(r);
    return outcome.kind === 'WEG_SOURCE_NOT_COUNTED' ? `${outcome.kind}:${outcome.reason}` : outcome.kind;
  };
  const counts = async () =>
    (await pool.query(`SELECT (SELECT count(*) FROM tax_classification)::int AS c, (SELECT count(*) FROM audit_record)::int AS a`)).rows[0] as {
      c: number;
      a: number;
    };

  describe('through the repository', () => {
    it('creates a MAINTENANCE classification with net, performance and the printed unit share; rule DE_ANSCHAFFUNGSNAHE@1; TAX_CLASSIFIED', async () => {
      const { membershipId } = await member();
      const st = await statement(membershipId, YEAR_2027);
      const performance = { from: day('2027-06-01'), until: day('2027-07-15'), progress: [], progressEstimated: null };
      const outcome = await create(request(st, 3, { netAmount: eur('1680.67'), performance }));
      if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
      expect(outcome.classification).toMatchObject({
        sourceType: 'WEG_STATEMENT_COST_LINE',
        sourceId: st,
        sourcePosition: 3,
        costLine: { unitShare: eur('2000.00') },
        rule: { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 },
        treatmentRule: null,
        netAmount: eur('1680.67'),
        performance,
        reserveWithdrawal: null,
      });
      const audit = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1`, [outcome.classification.id]);
      expect(audit.rows).toEqual([
        {
          action: 'TAX_CLASSIFIED',
          metadata: expect.objectContaining({
            sourceType: 'WEG_STATEMENT_COST_LINE',
            sourcePosition: 3,
            costLineUnitShare: { amount: '2000.00', currency: 'EUR' },
          }),
        },
      ]);
      // A credit line: its negative unit share as classified, the net amount against its absolute value.
      expect((await create(request(st, 6, { netAmount: eur('500.01') }))).kind).toBe('NET_AMOUNT_EXCEEDS_GROSS');
      const credit = await create(request(st, 6, { netAmount: eur('420.17') }));
      expect(credit).toMatchObject({ kind: 'CREATED', classification: { costLine: { unitShare: eur('-500.00') } } });
    });

    it('the order of checks and every refusal: 404, the line before the statement, the rule, the line and treatment, the net amount, the performance, supersedes', async () => {
      const { membershipId } = await member();
      const st = await statement(membershipId, YEAR_2027);
      const draft = await statement((await member()).membershipId, YEAR_2027, false);
      const foreign = await statement((await member({ realm: OTHER_REALM })).membershipId, YEAR_2027, true, OTHER_REALM);
      const before = await counts();
      expect(await kindOf(request(UNKNOWN, 3))).toBe('SOURCE_NOT_FOUND');
      expect(await kindOf(request(st, 9))).toBe('SOURCE_NOT_FOUND');
      expect(await kindOf(request(foreign, 3))).toBe('SOURCE_NOT_FOUND');
      expect(await kindOf(request(st, 1))).toBe('WEG_SOURCE_NOT_COUNTED:COST_LINE_NOT_NON_RECOVERABLE');
      expect(await kindOf(request(st, 5))).toBe('WEG_SOURCE_NOT_COUNTED:COST_LINE_NOT_NON_RECOVERABLE');
      expect(await kindOf(request(st, 7))).toBe('WEG_SOURCE_NOT_COUNTED:COST_LINE_NOT_NON_RECOVERABLE');
      // The line is decided before the statement's status (as a reserve line's NOT_A_WITHDRAWAL, §58B).
      expect(await kindOf(request(draft, 1))).toBe('WEG_SOURCE_NOT_COUNTED:COST_LINE_NOT_NON_RECOVERABLE');
      expect(await kindOf(request(draft, 3))).toBe('WEG_SOURCE_NOT_COUNTED:STATEMENT_NOT_CONFIRMED');
      // NO_APPLICABLE_RULE (a statement ending before 2004) is the domain's (cost-line-classification.test.ts).
      expect(await kindOf(request(st, 3, { taxCategory: 'WEG_SPENDING' }))).toBe('TREATMENT_NOT_ALLOWED');
      expect(await kindOf(request(st, 3, { treatment: 'CAPITALIZED' }))).toBe('TREATMENT_NOT_ALLOWED');
      expect(await kindOf(request(st, 3, { netAmount: eur('2000.01') }))).toBe('NET_AMOUNT_EXCEEDS_GROSS');
      const far = { from: day('2031-01-01'), until: day('2031-01-31'), progress: [], progressEstimated: null };
      expect(await kindOf(request(st, 3, { performance: far }))).toBe('PERFORMANCE_OUT_OF_RANGE');
      const points = {
        from: day('2027-06-01'),
        until: day('2027-07-15'),
        progress: [{ through: day('2027-06-30'), amount: eur('900.00') }],
        progressEstimated: false,
      };
      expect(await kindOf(request(st, 3, { performance: points }))).toBe('PERFORMANCE_EVIDENCE_REQUIRED');
      // Nothing written by any refusal.
      expect(await counts()).toEqual(before);
      const first = await create(request(st, 4, { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' }));
      if (first.kind !== 'CREATED') throw new Error(first.kind);
      expect(await kindOf(request(st, 4))).toBe('CLASSIFICATION_EXISTS');
      expect(await kindOf(request(st, 4, { supersedes: UNKNOWN }))).toBe('NOT_CURRENT_CLASSIFICATION');
    });

    it('supersede and the history by position: TAX_CLASSIFICATION_SUPERSEDED; another line and a withdrawal of the statement apart', async () => {
      const { membershipId } = await member();
      const st = await statement(membershipId, YEAR_2027);
      const first = await create(request(st, 4, { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' }));
      if (first.kind !== 'CREATED') throw new Error(first.kind);
      const second = await create(request(st, 4, { supersedes: first.classification.id, netAmount: eur('504.20') }));
      if (second.kind !== 'CREATED') throw new Error(second.kind);
      await create(request(st, 3));
      const history = await classifications.listHistory('WEG_STATEMENT_COST_LINE', st, REALM, 4);
      expect(history?.map((c) => [c.taxCategory, c.supersededBy])).toEqual([
        ['NOT_RELEVANT', second.classification.id],
        ['MAINTENANCE', null],
      ]);
      expect(await classifications.listHistory('WEG_RESERVE_WITHDRAWAL', st, REALM, 4)).toEqual([]);
      expect(await classifications.listHistory('WEG_STATEMENT_COST_LINE', st, OTHER_REALM, 4)).toBeUndefined();
      const audit = await pool.query(`SELECT action FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [first.classification.id]);
      expect(audit.rows.map((r) => r.action)).toEqual(['TAX_CLASSIFIED', 'TAX_CLASSIFICATION_SUPERSEDED']);
      expect(await classifications.findClassification(second.classification.id, OTHER_REALM)).toBeUndefined();
    });

    it('§57: confirm validates the source; a superseded statement refuses it (STATEMENT_SUPERSEDED), mark-needs-review does not; the successor starts unjudged', async () => {
      const { membershipId } = await member();
      const st = await statement(membershipId, YEAR_2027);
      const created = await create(request(st, 3, { reviewState: 'NEEDS_REVIEW' }));
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      const successor = await statement(membershipId, { ...YEAR_2027, supersedes: st });
      const confirm = await classifications.reviewClassification(created.classification.id, REALM, { kind: 'CONFIRM' }, actor);
      expect(confirm).toMatchObject({ kind: 'WEG_SOURCE_NOT_COUNTED', reason: 'STATEMENT_SUPERSEDED', details: { supersededBy: successor } });
      const mark = await classifications.reviewClassification(
        created.classification.id,
        REALM,
        { kind: 'MARK_NEEDS_REVIEW', reason: 'Neue Abrechnung' },
        actor,
      );
      expect(mark.kind).toBe('REVIEWED');
      expect(await kindOf(request(st, 4))).toBe('WEG_SOURCE_NOT_COUNTED:STATEMENT_SUPERSEDED');
      expect(await classifications.listHistory('WEG_STATEMENT_COST_LINE', successor, REALM, 3)).toEqual([]);
    });
  });

  describe('the check reads the lines (one snapshot, writes nothing, Realm isolation)', () => {
    it('a judged line summed, an unjudged one flagged, VOID and DRAFT statements missing; a read writes no row and no AuditRecord', async () => {
      const { pr, membershipId } = await member();
      const acq = await acquisition(pr);
      const st = await statement(membershipId, YEAR_2027);
      await statement(membershipId, { ...YEAR_2027, financialYear: 2028, periodFrom: day('2028-01-01'), periodUntil: day('2028-12-31') }, false);
      const performance = { from: day('2027-06-01'), until: day('2027-07-15'), progress: [], progressEstimated: null };
      expect((await create(request(st, 3, { netAmount: eur('1680.67'), performance }))).kind).toBe('CREATED');
      // Another Realm's statement and classification on a PropertyReference of its own: in no check of this Realm.
      const other = await member({ realm: OTHER_REALM });
      const foreign = await statement(other.membershipId, YEAR_2027, true, OTHER_REALM);
      expect((await create(request(foreign, 3, { mreRealmId: OTHER_REALM }))).kind).toBe('CREATED');
      const before = await counts();
      const check = await classifications.anschaffungsnaheCheck(acq, REALM, day('2031-08-01'));
      expect(await counts()).toEqual(before);
      expect(check?.sources.map((e) => [e.sourceType, e.sourceId, e.sourcePosition, e.amountUsed.amount])).toEqual([
        ['WEG_STATEMENT_COST_LINE', st, 3, '1680.67'],
      ]);
      const unjudged = check?.flags.find((f) => f.code === 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED')?.details as unknown as {
        statementIds: string[];
        lines: { position: number }[];
      };
      expect([unjudged.statementIds, unjudged.lines.map((l) => l.position)]).toEqual([[st], [4, 6]]);
      const missing = check?.flags.find((f) => f.code === 'WEG_STATEMENT_MISSING')?.details as unknown as { missing: { financialYear: number }[] };
      expect(missing.missing.map((m) => m.financialYear)).toEqual([2026, 2028, 2029, 2030]);
      expect(await classifications.anschaffungsnaheCheck(acq, OTHER_REALM, day('2031-08-01'))).toBeUndefined();
    });

    it('one snapshot: a classification committed between two reads of one check is not seen', async () => {
      const { pr, membershipId } = await member();
      const acq = await acquisition(pr);
      const st = await statement(membershipId, YEAR_2027);
      const db = createDatabase(pool);
      const [first, second] = await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute(async (trx) => {
          const a = await effectsOf(trx, TAX_RULES, REALM, pr, day('2031-08-01'));
          expect((await create(request(st, 3))).kind).toBe('CREATED');
          const b = await effectsOf(trx, TAX_RULES, REALM, pr, day('2031-08-01'));
          return [a, b];
        });
      expect(first.checks.find((c) => c.acquisitionId === acq)?.undetermined).toEqual([]);
      expect(second.checks.find((c) => c.acquisitionId === acq)?.undetermined).toEqual([]);
      expect((await classifications.anschaffungsnaheCheck(acq, REALM, day('2031-08-01')))?.undetermined).toHaveLength(1);
    });
  });

  describe('0068 past the repository', () => {
    const insert = (values: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        mre_realm_id: REALM,
        source_type: 'WEG_STATEMENT_COST_LINE',
        tax_category: 'MAINTENANCE',
        treatment: 'DEDUCTIBLE',
        review_state: 'USER_CONFIRMED',
        rule_code: 'DE_ANSCHAFFUNGSNAHE',
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
    const lineRow = (st: string, position: number, share: string, extra: Record<string, unknown> = {}) =>
      insert({ weg_annual_statement_id: st, weg_cost_line_position: position, weg_cost_line_unit_share: share, ...extra });
    const UUID_RE = /^[0-9a-f-]{36}$/;

    it('the guard: CONFIRMED only, NON_RECOVERABLE only, the printed unit share; each accepted for a valid row', async () => {
      const st = await statement((await member()).membershipId, YEAR_2027);
      const draft = await statement((await member()).membershipId, YEAR_2027, false);
      expect(await lineRow(draft, 3, '2000.00')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await lineRow(st, 1, '1800.00')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await lineRow(st, 5, '1200.00')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await lineRow(st, 3, '1999.99')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await lineRow(st, 9, '1.00')).toBe('tax_classification_cost_line_fk');
      const foreign = await statement((await member({ realm: OTHER_REALM })).membershipId, YEAR_2027, true, OTHER_REALM);
      expect(await lineRow(foreign, 3, '2000.00')).toBe('tax_classification_statement_fk');
      // Counter-checks: the same rows on a confirmed statement's NON_RECOVERABLE lines with their shares are accepted.
      expect(await lineRow(st, 3, '2000.00')).toMatch(UUID_RE);
      expect(await lineRow(st, 6, '-500.00')).toMatch(UUID_RE);
      // One current classification per line.
      expect(await lineRow(st, 3, '2000.00')).toBe('tax_classification_current_cost_line');
    });

    it('the fit: CAPITALIZED, the link, a partial treatment, the § 82b fields, tax_year, another rule, net on NOT_RELEVANT refused; both positions refused', async () => {
      const st = await statement((await member()).membershipId, YEAR_2027);
      const { pr } = await member();
      const acq = await acquisition(pr);
      const refused = [
        { treatment: 'CAPITALIZED' },
        { treatment: 'CAPITALIZED', anschaffungsnahe_acquisition_id: acq, treatment_rule_code: 'DE_ANSCHAFFUNGSNAHE', treatment_rule_version: 1 },
        { tax_category: 'WEG_SPENDING' },
        { tax_year: 2027 },
        { rule_code: 'DE_WEG_SPENDING' },
        { tax_category: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', net_amount: '1.00' },
        { tax_category: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', annually_recurring: true },
        {
          treatment: 'DISTRIBUTED_82B',
          distribution_years: 3,
          mostly_residential_confirmed: true,
          treatment_rule_code: 'DE_82B_DISTRIBUTION',
          treatment_rule_version: 1,
        },
      ];
      for (const extra of refused) {
        expect([extra, await lineRow(st, 3, '2000.00', extra)]).toEqual([extra, expect.not.stringMatching(UUID_RE)]);
      }
      expect(await lineRow(st, 3, '2000.00', { tax_year: 2027 })).toBe('tax_classification_cost_line_fit');
      expect(await lineRow(st, 3, '2000.00', { treatment: 'CAPITALIZED' })).toBe('tax_classification_cost_line_fit');
      expect(await lineRow(st, 3, '2000.00', { weg_reserve_position: 1, weg_withdrawal_unit_share: '1000.00' })).toBe('tax_classification_weg_source_fields');
      expect(await lineRow(st, 3, '2000.00', { net_amount: '2000.01' })).toBe('tax_classification_erhaltung_fields');
      expect(await lineRow(st, 6, '-500.00', { net_amount: '500.01' })).toBe('tax_classification_erhaltung_fields');
      // Counter-checks: NOT_RELEVANT without fields, and MAINTENANCE with net and recurring, are accepted.
      expect(await lineRow(st, 4, '600.00', { tax_category: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' })).toMatch(UUID_RE);
      expect(await lineRow(st, 3, '2000.00', { net_amount: '2000.00', annually_recurring: true })).toMatch(UUID_RE);
      const id = (await pool.query(`SELECT id FROM tax_classification WHERE weg_annual_statement_id = $1 AND weg_cost_line_position = 3`, [st])).rows[0].id;
      // The frozen guard covers the new columns.
      // With version + 1, so 0045's frozen guard lets it pass and 0068's version of the WEG source guard decides.
      for (const set of ['weg_cost_line_unit_share = 1999.99', 'weg_cost_line_position = 4']) {
        const changed = await pool.query(`UPDATE tax_classification SET ${set}, version = version + 1 WHERE id = $1`, [id]).then(
          () => 'accepted',
          (error: { message?: string }) => error.message ?? '',
        );
        expect([set, changed]).toEqual([set, expect.stringContaining('the WEG source and the fields of §58B and §59F never change')]);
      }
      // A withdrawal of the same statement still classifies (0047's guard returns early without a cost line).
      expect(
        await insert({
          source_type: 'WEG_RESERVE_WITHDRAWAL',
          tax_category: 'WEG_SPENDING',
          rule_code: 'DE_WEG_SPENDING',
          weg_annual_statement_id: st,
          weg_reserve_position: 1,
          weg_withdrawal_unit_share: '1000.00',
        }),
      ).toMatch(UUID_RE);
    });

    it('down refuses while a cost-line classification exists (in a transaction rolled back either way)', { timeout: 30_000 }, async () => {
      const st = await statement((await member()).membershipId, YEAR_2027);
      expect(await lineRow(st, 4, '600.00', { tax_category: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' })).toMatch(UUID_RE);
      const migration = migrations['0068_hausgeld_cost_line_classification'] as { down: (db: never) => Promise<void> };
      let outcome = '';
      await withMigrationLock(async () => {
        outcome = await createDatabase(pool)
          .transaction()
          .execute(async (trx) => {
            await migration.down(trx as never);
            throw new Error('accepted');
          })
          .then(
            () => 'accepted',
            (error: { message?: string }) => error.message ?? '',
          );
      });
      expect(outcome).toContain('down 0068');
      expect((await pool.query(`SELECT count(*)::int AS n FROM tax_classification WHERE source_type = 'WEG_STATEMENT_COST_LINE'`)).rows[0].n).toBeGreaterThan(
        0,
      );
    });

    it('down without a cost-line classification restores 0067; up again (under MIGRATION_ADVISORY_LOCK)', { timeout: 30_000 }, async () => {
      const downSchema = testSchemaName('tax_hausgeld_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema} -c application_name=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        const migration = migrations['0068_hausgeld_cost_line_classification'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
        const db = createDatabase(downPool) as never;
        await withMigrationLock(() => migration.down(db));
        const columns = await downPool.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tax_classification' AND column_name LIKE 'weg_cost_line%'`,
          [downSchema],
        );
        expect(columns.rows).toEqual([]);
        const check = await downPool.query(
          `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'tax_classification_source_type_check' AND connamespace = $1::regnamespace`,
          [downSchema],
        );
        expect(check.rows[0].d).not.toContain('WEG_STATEMENT_COST_LINE');
        await withMigrationLock(() => migration.up(db));
        expect(
          (
            await downPool.query(
              `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'tax_classification'::regclass AND tgname = 'tax_classification_cost_line_counts'`,
            )
          ).rows[0].n,
        ).toBe(1);
      } finally {
        await downPool.end();
      }
    });
  });
});
