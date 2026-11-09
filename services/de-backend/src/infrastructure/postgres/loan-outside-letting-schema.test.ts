import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { withMigrationLock } from './depreciation-asset.test-support.js';
import { databaseUrl, EVIDENCE, OTHER_REALM, REALM, actor, createSchema, day, f, useOutsideLettingDatabase } from './loan-outside-letting.test-support.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { COMPLETE_0077, SET_FROZEN_0026 } from './migrations/0077_loan_allocation_outside_letting.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * Migration 0077 (VC-X-43, api-design.md §58V; Entscheidung des Projektinhabers, 2026-11-07, questions 2–5) past the
 * repository, each rule with a counter-check that turns it off in a rolled-back transaction (the CHECK or the index
 * dropped, the function replaced without the rule) and accepts the same rows: the use and its PropertyReference, one
 * part per set, no Acquisition on the part, MANUAL only, at least one PropertyReference, the evidence with the part,
 * the sum of `1/1` over every row, a part added to a committed set, the part frozen, `use_evidence` frozen (the column
 * list of `loan_allocation_set_frozen`) and its CHECK; then `down` (refused with a part or evidence, else 0076's schema
 * restored) and `up` again under MIGRATION_ADVISORY_LOCK. Synthetic rows only.
 */
const migration = migrations['0077_loan_allocation_outside_letting'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
const here = dirname(fileURLToPath(import.meta.url));
const body0026 = (name: string) => {
  const source = readFileSync(join(here, 'migrations', '0026_loan_allocation.ts'), 'utf8');
  const start = source.indexOf(`CREATE FUNCTION ${name}()`);
  const open = source.indexOf('$$', start) + 2;
  return source.slice(open, source.indexOf('$$', open));
};
const replaced = (name: string, body: string) => `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$${body}$$`;
/** 0077's sum function without one of its blocks (the text from `IF <condition>` to its `END IF;`). */
const without = (condition: string) => {
  const at = COMPLETE_0077.indexOf(`IF ${condition}`);
  if (at < 0) throw new Error(condition);
  return replaced('loan_allocation_complete', COMPLETE_0077.slice(0, at) + COMPLETE_0077.slice(COMPLETE_0077.indexOf('END IF;', at) + 'END IF;'.length));
};
const texts = (values: readonly string[]) => `ARRAY[${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')}]::text[]`;

describe.skipIf(databaseUrl === undefined)('the schema of 0077 (§58V)', () => {
  const { ctx, loan, properties, acquisition } = useOutsideLettingDatabase('loan_outside_letting_schema_test');

  /** Statements in a rolled-back transaction after `setup`, the deferred triggers fired: `accepted`, else the reason. */
  async function attempt(statements: readonly string[], setup: readonly string[] = []): Promise<string> {
    const client = await ctx.pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of setup) await client.query(s);
      for (const s of statements) await client.query(s);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      return 'accepted';
    } catch (error) {
      const e = error as { constraint?: string; code?: string; message?: string };
      return e.constraint ?? /\(([A-Z_]+)[,)]/.exec(e.message ?? '')?.[1] ?? /never (updated|edited|deleted)/.exec(e.message ?? '')?.[0] ?? e.code ?? 'unknown';
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
  const setRow = (id: string, loanId: string, o: { basis?: string; evidence?: string; realm?: string } = {}) =>
    `INSERT INTO loan_allocation_set (id, mre_realm_id, loan_id, status, valid_from, basis, use_evidence, created_by)
     VALUES ('${id}', '${o.realm ?? REALM}', '${loanId}', 'VALID', '2027-01-01', '${o.basis ?? 'MANUAL'}', ${o.evidence ?? texts(EVIDENCE)}, 'x')`;
  const row = (setId: string, position: number, share: string, o: { pr?: string | null; use?: string; acq?: string; realm?: string } = {}) => {
    const [n, d] = share.split('/');
    const pr = o.pr === undefined || o.pr === null ? 'NULL' : `'${o.pr}'`;
    return `INSERT INTO loan_allocation (set_id, mre_realm_id, position, property_reference_id, use, share_numerator, share_denominator, acquisition_id)
            VALUES ('${setId}', '${o.realm ?? REALM}', ${position}, ${pr}, '${o.use ?? 'LETTING'}', ${n}, ${d}, ${o.acq === undefined ? 'NULL' : `'${o.acq}'`})`;
  };
  /** The example's set: P1 1/2, P2 3/10 and the part outside letting 1/5, with its evidence. */
  async function example(o: { basis?: string; evidence?: string } = {}) {
    const l = await loan();
    const [p1, p2] = (await properties(2)) as [string, string];
    const id = randomUUID();
    const rows = [setRow(id, l.id, o), row(id, 0, '1/2', { pr: p1 }), row(id, 1, '3/10', { pr: p2 }), row(id, 2, '1/5', { use: 'OUTSIDE_LETTING' })];
    return { l, p1, p2, id, rows };
  }
  const drop = (constraint: string) => `ALTER TABLE loan_allocation DROP CONSTRAINT ${constraint}`;

  it('the columns: use NOT NULL default LETTING, property_reference_id nullable, use_evidence nullable; the example set is accepted', async () => {
    const { rows } = await ctx.pool.query(
      `SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND ((table_name = 'loan_allocation' AND column_name IN ('use', 'property_reference_id')) OR (table_name = 'loan_allocation_set' AND column_name = 'use_evidence'))
        ORDER BY table_name, column_name`,
    );
    expect(rows).toEqual([
      { table_name: 'loan_allocation', column_name: 'property_reference_id', is_nullable: 'YES', column_default: null },
      { table_name: 'loan_allocation', column_name: 'use', is_nullable: 'NO', column_default: "'LETTING'::text" },
      { table_name: 'loan_allocation_set', column_name: 'use_evidence', is_nullable: 'YES', column_default: null },
    ]);
    expect(await attempt((await example()).rows)).toBe('accepted');
    // A row written as before 0077 (no use) reads LETTING and passes.
    const l = await loan();
    const [p] = (await properties(1)) as [string];
    const id = randomUUID();
    expect(
      await attempt([
        setRow(id, l.id, { evidence: 'NULL' }),
        `INSERT INTO loan_allocation (set_id, mre_realm_id, position, property_reference_id, share_numerator, share_denominator) VALUES ('${id}', '${REALM}', 0, '${p}', 1, 1)`,
      ]),
    ).toBe('accepted');
  });

  it('loan_allocation_use refuses another use; counter-check: dropped, accepted', async () => {
    const { id, rows } = await example();
    const other = [...rows.slice(0, 3), row(id, 2, '1/5', { use: 'PRIVATE' })];
    expect(await attempt(other)).toBe('loan_allocation_use');
    expect(await attempt(other, [drop('loan_allocation_use')])).toBe('accepted');
  });

  it('loan_allocation_use_property refuses an outside row with a PropertyReference and a LETTING row without one; counter-check: dropped, accepted', async () => {
    const { id, p1, rows } = await example();
    const [p3] = (await properties(1)) as [string];
    const named = [...rows.slice(0, 3), row(id, 2, '1/5', { use: 'OUTSIDE_LETTING', pr: p3 })];
    expect(await attempt(named)).toBe('loan_allocation_use_property');
    expect(await attempt(named, [drop('loan_allocation_use_property')])).toBe('accepted');
    const unnamed = [rows[0] as string, row(id, 0, '1/2', { pr: p1 }), row(id, 1, '1/2', { pr: null })];
    expect(await attempt(unnamed)).toBe('loan_allocation_use_property');
    expect(await attempt(unnamed, [drop('loan_allocation_use_property')])).toBe('accepted');
  });

  it('loan_allocation_outside_letting_once refuses two parts in one set; counter-check: the index dropped, accepted', async () => {
    const { id, p1, rows } = await example();
    const twice = [
      rows[0] as string,
      row(id, 0, '1/2', { pr: p1 }),
      row(id, 1, '1/4', { use: 'OUTSIDE_LETTING' }),
      row(id, 2, '1/4', { use: 'OUTSIDE_LETTING' }),
    ];
    expect(await attempt(twice)).toBe('loan_allocation_outside_letting_once');
    expect(await attempt(twice, ['DROP INDEX loan_allocation_outside_letting_once'])).toBe('accepted');
  });

  it('loan_allocation_outside_letting_no_acquisition refuses an Acquisition on the part; counter-check: dropped, accepted', async () => {
    const { id, p1, rows } = await example();
    const acq = await acquisition(p1);
    const withAcquisition = [...rows.slice(0, 3), row(id, 2, '1/5', { use: 'OUTSIDE_LETTING', acq })];
    expect(await attempt(withAcquisition)).toBe('loan_allocation_outside_letting_no_acquisition');
    expect(await attempt(withAcquisition, [drop('loan_allocation_outside_letting_no_acquisition')])).toBe('accepted');
  });

  it('the deferred check refuses a part on a PURCHASE_PRICE set (OUTSIDE_LETTING_NOT_ALLOWED_FOR_BASIS); counter-check: the same rows MANUAL, accepted', async () => {
    const l = await loan();
    const [p1, p2] = (await properties(2)) as [string, string];
    const [a1, a2] = [await acquisition(p1), await acquisition(p2)];
    const id = randomUUID();
    const rows = (basis: string) => [
      setRow(id, l.id, { basis }),
      row(id, 0, '2/5', { pr: p1, ...(basis === 'PURCHASE_PRICE' ? { acq: a1 } : {}) }),
      row(id, 1, '2/5', { pr: p2, ...(basis === 'PURCHASE_PRICE' ? { acq: a2 } : {}) }),
      row(id, 2, '1/5', { use: 'OUTSIDE_LETTING' }),
    ];
    expect(await attempt(rows('PURCHASE_PRICE'))).toBe('OUTSIDE_LETTING_NOT_ALLOWED_FOR_BASIS');
    expect(await attempt(rows('MANUAL'))).toBe('accepted');
  });

  it('the deferred check refuses a set of only the part (OUTSIDE_LETTING_ONLY); counter-check: without the rule, accepted', async () => {
    const l = await loan();
    const id = randomUUID();
    const only = [setRow(id, l.id), row(id, 0, '1/1', { use: 'OUTSIDE_LETTING' })];
    expect(await attempt(only)).toBe('OUTSIDE_LETTING_ONLY');
    expect(await attempt(only, [without('letting = 0')])).toBe('accepted');
  });

  it('the deferred check refuses the part without use_evidence (USE_EVIDENCE_REQUIRED); counter-check: without the rule, accepted', async () => {
    const { rows } = await example({ evidence: 'NULL' });
    expect(await attempt(rows)).toBe('USE_EVIDENCE_REQUIRED');
    expect(await attempt(rows, [without('outside > 0 AND set_evidence IS NULL')])).toBe('accepted');
    // Evidence without a part is allowed (optional for any set).
    const l = await loan();
    const [p] = (await properties(1)) as [string];
    const id = randomUUID();
    expect(await attempt([setRow(id, l.id), row(id, 0, '1/1', { pr: p })])).toBe('accepted');
  });

  it('the sum runs over every row, the part included: below and above 1/1 refused (SHARE_SUM_NOT_ONE); exactly 1/1 accepted', async () => {
    const { id, rows } = await example();
    expect(await attempt([...rows.slice(0, 3), row(id, 2, '1/10', { use: 'OUTSIDE_LETTING' })])).toBe('SHARE_SUM_NOT_ONE');
    expect(await attempt([...rows.slice(0, 3), row(id, 2, '3/10', { use: 'OUTSIDE_LETTING' })])).toBe('SHARE_SUM_NOT_ONE');
    expect(await attempt(rows)).toBe('accepted');
  });

  it('a committed set takes no part afterwards; the part is never updated or deleted; use_evidence never changes (counter-check: 0026 s column list)', async () => {
    const l = await loan();
    const [p1, p2] = (await properties(2)) as [string, string];
    const plain = await ctx.allocations.create(
      l.id,
      REALM,
      { validFrom: day('2027-01-01'), basis: 'MANUAL', allocations: [{ propertyReferenceId: p1, share: f(1n, 1n), acquisitionId: null }], notes: null },
      actor,
    );
    if (plain.kind !== 'CREATED') throw new Error(plain.kind);
    expect(await attempt([row(plain.set.id, 1, '1/5', { use: 'OUTSIDE_LETTING' })])).toBe('SHARE_SUM_NOT_ONE');
    const l2 = await loan();
    const mixed = await ctx.allocations.create(
      l2.id,
      REALM,
      {
        validFrom: day('2027-01-01'),
        basis: 'MANUAL',
        allocations: [
          { propertyReferenceId: p1, share: f(1n, 2n), acquisitionId: null },
          { propertyReferenceId: p2, share: f(3n, 10n), acquisitionId: null },
        ],
        notes: null,
        outsideLetting: f(1n, 5n),
        useEvidence: EVIDENCE,
      },
      actor,
    );
    if (mixed.kind !== 'CREATED') throw new Error(mixed.kind);
    const s = mixed.set.id;
    expect(await attempt([`UPDATE loan_allocation SET share_numerator = 1, share_denominator = 4 WHERE set_id = '${s}' AND use = 'OUTSIDE_LETTING'`])).toBe(
      'never updated',
    );
    expect(await attempt([`DELETE FROM loan_allocation WHERE set_id = '${s}' AND use = 'OUTSIDE_LETTING'`])).toBe('never updated');
    // With the one allowed step (the void), so 0026's function judges the column list alone.
    for (const change of [`use_evidence = ${texts(['anderer Beleg (synthetisch)'])}`, 'use_evidence = NULL']) {
      const update = `UPDATE loan_allocation_set SET ${change}, status = 'VOID', voided_at = now(), void_reason = 'x', version = 2 WHERE id = '${s}'`;
      expect(await attempt([update]), change).toBe('never edited');
      expect(await attempt([update], [replaced('loan_allocation_set_frozen', SET_FROZEN_0026)]), change).toBe('accepted');
    }
    // The void stays the one step (use_evidence kept).
    expect(await attempt([`UPDATE loan_allocation_set SET status = 'VOID', voided_at = now(), void_reason = 'x', version = 2 WHERE id = '${s}'`])).toBe(
      'accepted',
    );
  });

  it('loan_allocation_set_use_evidence refuses 0 and 11 entries, an empty, a blank, a NULL and a 501-character entry; counter-check: dropped, accepted', async () => {
    const cases = [
      `ARRAY[]::text[]`,
      texts(Array.from({ length: 11 }, (_, i) => `Beleg ${i + 1} (synthetisch)`)),
      texts(['']),
      texts(['   ']),
      `ARRAY[NULL]::text[]`,
      `ARRAY[repeat('x', 501)]`,
    ];
    for (const evidence of cases) {
      const { rows } = await example({ evidence });
      expect(await attempt(rows), evidence.slice(0, 30)).toBe('loan_allocation_set_use_evidence');
      expect(await attempt(rows, ['ALTER TABLE loan_allocation_set DROP CONSTRAINT loan_allocation_set_use_evidence']), evidence.slice(0, 30)).toBe('accepted');
    }
    expect(await attempt((await example({ evidence: texts(Array.from({ length: 10 }, (_, i) => `${'x'.repeat(490)} Beleg ${i}`)) })).rows)).toBe('accepted');
  });

  it('Realm: the part keeps its set s Realm (loan_allocation_set_fk on (set_id, mre_realm_id))', async () => {
    const { id, rows } = await example();
    expect(await attempt([...rows.slice(0, 3), row(id, 2, '1/5', { use: 'OUTSIDE_LETTING', realm: OTHER_REALM })])).toBe('loan_allocation_set_fk');
  });

  it('counter-check of the trigger texts: 0077 replaced both functions of 0026', async () => {
    const prosrc = async (name: string) =>
      (
        await ctx.pool.query(`SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = current_schema() AND proname = $1`, [
          name,
        ])
      ).rows[0].prosrc as string;
    expect(await prosrc('loan_allocation_set_frozen')).not.toBe(body0026('loan_allocation_set_frozen'));
    expect(await prosrc('loan_allocation_complete')).toBe(COMPLETE_0077);
  });
});

describe.skipIf(databaseUrl === undefined)('the down of 0077 (§58V)', () => {
  it(
    'refused with a part or with evidence alone; else restores 0076 s schema (functions verbatim, CHECKs, index, columns, NOT NULL); up again',
    { timeout: 90_000 },
    async () => {
      const downSchema = testSchemaName('loan_outside_letting_down_test');
      const beforeSchema = testSchemaName('loan_outside_letting_before_test');
      await createSchema(downSchema);
      await createSchema(beforeSchema);
      const down = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      const before = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${beforeSchema}`, max: 2 });
      try {
        await migrateToLatest(down, { migrationTableSchema: downSchema });
        // 0076's schema for the comparison: every migration but 0077.
        const upTo0076 = Object.fromEntries(Object.entries(migrations).filter(([n]) => n !== '0077_loan_allocation_outside_letting'));
        await migrateToLatest(before, { migrationTableSchema: beforeSchema, migrations: upTo0076 });
        const db = () => createDatabase(down) as never;
        const defs = async (pool: pg.Pool, schema: string) => ({
          columns: (
            await pool.query(
              `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
                WHERE table_schema = $1 AND table_name IN ('loan_allocation', 'loan_allocation_set') ORDER BY table_name, column_name`,
              [schema],
            )
          ).rows,
          constraints: (
            await pool.query(
              `SELECT conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
                WHERE nspname = $1 AND relname IN ('loan_allocation', 'loan_allocation_set') ORDER BY conname`,
              [schema],
            )
          ).rows,
          indexes: (
            await pool.query(
              `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename IN ('loan_allocation', 'loan_allocation_set') ORDER BY indexname`,
              [schema],
            )
          ).rows.map((r: { indexname: string; indexdef: string }) => ({ ...r, indexdef: r.indexdef.replace(`${schema}.`, '') })),
          functions: (
            await pool.query(
              `SELECT proname, prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = $1 AND proname LIKE 'loan_allocation%' ORDER BY proname`,
              [schema],
            )
          ).rows,
        });
        const original = await defs(before, beforeSchema);
        expect(original.functions.map((r: { proname: string; prosrc: string }) => r.prosrc)).toContain(body0026('loan_allocation_complete'));
        // Counter-check of the comparison: under 0077 the definitions differ.
        expect(await defs(down, downSchema)).not.toEqual(original);

        const pr = (
          await down.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f43d01', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          )
        ).rows[0].id as string;
        const party = async (displayName: string) =>
          (
            await down.query(
              `INSERT INTO party (mre_realm_id, party_type, display_name, status, created_by) VALUES ($1, 'PERSON', $2, 'ACTIVE', 'x') RETURNING id`,
              [REALM, displayName],
            )
          ).rows[0].id as string;
        const [bank, anna] = [await party('Bank Beispiel'), await party('Anna Beispiel')];
        const loanId = (
          await down.query(
            `INSERT INTO loan (mre_realm_id, lender_party_id, borrower_party_ids, principal_original, currency, start_date, status, created_by)
             VALUES ($1, $2, ARRAY[$3]::uuid[], 1000, 'EUR', '2027-01-01', 'ACTIVE', 'x') RETURNING id`,
            [REALM, bank, anna],
          )
        ).rows[0].id as string;
        const insertSet = async (validFrom: string, outside: boolean, evidence: boolean) => {
          const client = await down.connect();
          try {
            await client.query('BEGIN');
            const id = (
              await client.query(
                `INSERT INTO loan_allocation_set (mre_realm_id, loan_id, status, valid_from, basis, use_evidence, created_by) VALUES ($1, $2, 'VALID', $3, 'MANUAL', $4, 'x') RETURNING id`,
                [REALM, loanId, validFrom, evidence ? EVIDENCE : null],
              )
            ).rows[0].id as string;
            await client.query(
              `INSERT INTO loan_allocation (set_id, mre_realm_id, position, property_reference_id, share_numerator, share_denominator) VALUES ($1, $2, 0, $3, $4, $5)`,
              [id, REALM, pr, outside ? 4 : 1, outside ? 5 : 1],
            );
            if (outside)
              await client.query(
                `INSERT INTO loan_allocation (set_id, mre_realm_id, position, property_reference_id, use, share_numerator, share_denominator) VALUES ($1, $2, 1, NULL, 'OUTSIDE_LETTING', 1, 5)`,
                [id, REALM],
              );
            await client.query('COMMIT');
            return id;
          } finally {
            client.release();
          }
        };
        const plain = await insertSet('2027-01-01', false, false);
        const mixed = await insertSet('2027-02-01', true, true);
        const refused = async () => {
          let error: unknown;
          await withMigrationLock(async () => {
            error = await migration.down(db()).catch((e: unknown) => e);
          });
          return error;
        };
        expect(await refused()).toMatchObject({ code: '23514' });
        // The part removed (triggers off), the evidence alone still refuses.
        await down.query(`ALTER TABLE loan_allocation DISABLE TRIGGER USER`);
        await down.query(`DELETE FROM loan_allocation WHERE use = 'OUTSIDE_LETTING'`);
        await down.query(`UPDATE loan_allocation SET share_numerator = 1, share_denominator = 1 WHERE set_id = $1`, [mixed]);
        await down.query(`ALTER TABLE loan_allocation ENABLE TRIGGER USER`);
        expect(await refused()).toMatchObject({ code: '23514' });
        // Counter-check: the evidence removed (triggers off), down runs.
        await down.query(`ALTER TABLE loan_allocation_set DISABLE TRIGGER USER`);
        await down.query(`UPDATE loan_allocation_set SET use_evidence = NULL`);
        await down.query(`ALTER TABLE loan_allocation_set ENABLE TRIGGER USER`);
        const rows = async () =>
          (
            await down.query(
              `SELECT set_id, position, property_reference_id, share_numerator::text, share_denominator::text FROM loan_allocation ORDER BY set_id, position`,
            )
          ).rows;
        const kept = await rows();
        await withMigrationLock(() => migration.down(db()));
        expect(await defs(down, downSchema)).toEqual(original);
        expect(await rows()).toEqual(kept);
        expect(kept.map((r: { set_id: string }) => r.set_id).sort()).toEqual([plain, mixed].sort());
        await withMigrationLock(() => migration.up(db()));
        expect(await defs(down, downSchema)).not.toEqual(original);
        expect((await down.query(`SELECT DISTINCT use FROM loan_allocation`)).rows).toEqual([{ use: 'LETTING' }]);
      } finally {
        await down.end();
        await before.end();
      }
    },
  );
});
