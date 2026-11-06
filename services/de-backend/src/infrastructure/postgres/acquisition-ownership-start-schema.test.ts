import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { REALM, actor, databaseUrl, useAlignSchema } from './align-ownerships.test-support.js';
import { createDatabase } from './database.js';
import { insertConfirmedAsBeforeVcX34 } from './legacy-acquisition.test-support.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { PostgresPartyRepository } from './party-repository.js';
import { CONFIRM, ownershipStartFixtures } from './ownership-start-on-confirm.test-support.js';
import { withMigrationLock } from './tax-year.test-support.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * Migration 0073 (VC-X-57, api-design.md §58R "The guards"; Entscheidung des Projektinhabers, 2026-11-06, Fragen 3, 4,
 * 7, 8) past the repository, each guard with its counter-check: the transition checks requirement 2 on the date of a
 * `DRAFT` dated by §58N and requirement 7, and stores the day; `acquisition_frozen` refuses every write of the column and
 * an alignment after it (the order of Frage 7: a raw confirm of an aligned `DRAFT` is accepted); the CHECK; the trigger
 * order; `down` refused with a confirmation from a recorded date, else restoring every function and CHECK of 0072
 * verbatim, existing rows untouched by both; then `up` again. Synthetic values only.
 */
const FUNCTIONS = ['acquisition_frozen()', 'acquisition_step()', 'acquisition_confirmation_violation(uuid)', 'acquisition_increase_violation(uuid)'];
const ALIGN = `UPDATE acquisition SET ownership_aligned_at = now(), ownership_alignment_source_references = ARRAY['Protokoll (synthetisch)'], version = version + 1 WHERE id = $1`;
/** The refusal as a short word, or `committed`. */
const short = (outcome: string) =>
  outcome === 'committed'
    ? 'committed'
    : /stored by the confirmation only/.test(outcome)
      ? 'frozen'
      : /CONFIRMED_FROM_TRANSFER/.test(outcome)
        ? 'confirmed-from-transfer'
        : /cannot be confirmed \((\w+)\)/.test(outcome)
          ? `refused:${/cannot be confirmed \((\w+)\)/.exec(outcome)?.[1]}`
          : /^23514/.test(outcome)
            ? 'check'
            : outcome;

describe.skipIf(databaseUrl === undefined)('the schema of 0073 past the repository (§58R)', () => {
  const t = useAlignSchema('acquisition_ownership_start_schema_test');
  const { inTransaction, align, acquisitionRow } = t;
  const { scenario } = ownershipStartFixtures(t);
  const raw = async (text: string, id: string) => short(await inTransaction([[text, [id]]]));
  /** One statement with `acquisition_frozen` disabled, rolled back whatever happens (the guard neutralised). */
  const withoutFrozen = async (text: string, id: string): Promise<string> => {
    const client = await t.ctx.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE acquisition DISABLE TRIGGER acquisition_frozen');
      const outcome = await client.query(text, [id]).then(
        () => 'committed',
        (e: { code?: string; message?: string }) => `${e.code}: ${e.message}`,
      );
      return short(outcome);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };

  it('a raw confirm of a DRAFT dated by §58N with rows from c is refused (requirement 2 on t); counter-check: rows on t pass and store the day', async () => {
    const old = await scenario({ rows: 'contract' });
    expect(await raw(CONFIRM, old.n)).toBe('refused:OWNERSHIP_NOT_FROM_TRANSFER_DATE');
    expect((await acquisitionRow(old.n)).status).toBe('DRAFT');
    const n = await scenario({ rows: 'transfer' });
    expect(await raw(CONFIRM, n.n)).toBe('committed');
    const row = await acquisitionRow(n.n);
    expect([row.status, row.confirmed_ownership_start, row.economic_transfer_date]).toEqual(['CONFIRMED', '2025-05-01', '2025-05-01']);
  });

  it('a raw confirm with the seller row ending on c − 1 is refused (requirement 7); counter-check: ending on t − 1 passes; t = c passes', async () => {
    const early = await scenario({ rows: 'sellerEarly' });
    expect(await raw(CONFIRM, early.n)).toBe('refused:SELLER_SHARE_CHANGED_BEFORE_TRANSFER');
    expect((await t.ctx.pool.query(`SELECT acquisition_confirmation_violation($1) AS v`, [early.n])).rows[0].v).toBe('SELLER_SHARE_CHANGED_BEFORE_TRANSFER');
    const n = await scenario({ rows: 'transfer' });
    expect((await t.ctx.pool.query(`SELECT acquisition_confirmation_violation($1) AS v`, [n.n])).rows[0].v).toBeNull();
    // The transfer on the contract date: the seller row on c − 1 = t − 1, and the function compares one day.
    const same = await scenario({ dated: false });
    await t.ctx.pool.query(`UPDATE ownership SET valid_until = '2025-02-28' WHERE id = $1`, [same.oS]);
    await t.own(same.pr, { owner: same.a, from: '2025-03-01', acquisitionId: same.n });
    await t.recordDate(same.n, '2025-03-01');
    expect(await raw(CONFIRM, same.n)).toBe('committed');
  });

  it('acquisition_frozen refuses every write of confirmed_ownership_start: on a DRAFT, on CONFIRMED to another date or to NULL, with the transition', async () => {
    const d = await scenario({ rows: 'transfer' });
    expect(await raw(`UPDATE acquisition SET confirmed_ownership_start = '2025-05-01' WHERE id = $1`, d.n)).toBe('frozen');
    // With the transition: the writer's value is seen before acquisition_step assigns the date, whatever it is.
    expect(
      await raw(
        `UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), version = version + 1, confirmed_ownership_start = '2025-05-01' WHERE id = $1`,
        d.n,
      ),
    ).toBe('frozen');
    expect(
      await raw(
        `UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), version = version + 1, confirmed_ownership_start = '2025-06-01' WHERE id = $1`,
        d.n,
      ),
    ).toBe('frozen');
    expect(await raw(CONFIRM, d.n)).toBe('committed');
    for (const value of [`'2025-06-01'`, 'NULL']) {
      expect(await raw(`UPDATE acquisition SET confirmed_ownership_start = ${value} WHERE id = $1`, d.n)).toBe('frozen');
    }
    expect((await acquisitionRow(d.n)).confirmed_ownership_start).toBe('2025-05-01');
    // Counter-check: the no-op write of every Ownership writer passes on the confirmed row.
    expect(await raw(`UPDATE acquisition SET version = version WHERE id = $1`, d.n)).toBe('committed');
  });

  it('the CHECK, with acquisition_frozen neutralised: another date or a DRAFT refused; counter-check: the date on a CONFIRMED row accepted', async () => {
    const d = await scenario({ rows: 'transfer' });
    expect(await withoutFrozen(`UPDATE acquisition SET confirmed_ownership_start = '2025-05-01' WHERE id = $1`, d.n)).toBe('check');
    expect(await raw(CONFIRM, d.n)).toBe('committed');
    expect(await withoutFrozen(`UPDATE acquisition SET confirmed_ownership_start = '2025-06-01' WHERE id = $1`, d.n)).toBe('check');
    expect(await withoutFrozen(`UPDATE acquisition SET confirmed_ownership_start = economic_transfer_date WHERE id = $1`, d.n)).toBe('committed');
    expect(await withoutFrozen(`UPDATE acquisition SET confirmed_ownership_start = NULL WHERE id = $1`, d.n)).toBe('committed');
  });

  it('the order (Frage 7): a raw confirm of a DRAFT aligned by §58Q is accepted and stores both; counter-check: a raw alignment after the day is stored is refused', async () => {
    const n2 = await scenario({ rows: 'contract' });
    expect((await align(n2.n)).kind).toBe('ALIGNED');
    expect(await raw(CONFIRM, n2.n)).toBe('committed');
    const row = await acquisitionRow(n2.n);
    expect([row.status, row.confirmed_ownership_start, row.ownership_aligned_at !== null]).toEqual(['CONFIRMED', '2025-05-01', true]);
    const n = await scenario({ rows: 'transfer' });
    expect(await raw(CONFIRM, n.n)).toBe('committed');
    expect(await raw(ALIGN, n.n)).toBe('confirmed-from-transfer');
    // Counter-check: the same raw alignment on legacy L (no stored day) passes acquisition_frozen; only 0072's deferred
    // completeness trigger refuses it, the rows not being moved.
    const legacy = await t.example();
    expect(await inTransaction([[ALIGN, [legacy.l]]])).toMatch(/only as a whole \(BUYER_ROW_NOT_MOVED/);
  });

  it('the trigger order: acquisition_frozen fires before acquisition_step (both BEFORE UPDATE, in name order)', async () => {
    const { rows } = await t.ctx.pool.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'acquisition'::regclass AND NOT tgisinternal AND (tgtype & 2) = 2 AND (tgtype & 16) = 16 ORDER BY tgname`,
    );
    expect(rows.map((r) => r.tgname)).toEqual(['acquisition_frozen', 'acquisition_step']);
  });

  it(
    'down refused with a confirmation from a recorded date; else every function and CHECK of 0072 back verbatim, existing rows untouched; then up again',
    { timeout: 60_000 },
    async () => {
      const downSchema = testSchemaName('acquisition_ownership_start_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const down = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 3 });
      try {
        const defs = async () => {
          const fns: string[] = [];
          for (const fn of FUNCTIONS) fns.push((await down.query(`SELECT pg_get_functiondef($1::regprocedure) AS d`, [fn])).rows[0].d as string);
          const { rows } = await down.query(
            `SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'acquisition'::regclass ORDER BY conname`,
          );
          const indexes = (await down.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY 1`, [downSchema])).rows;
          const functions = (
            await down.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 ORDER BY 1`, [downSchema])
          ).rows;
          return [...fns, ...rows.map((r) => `${r.conname}: ${r.d}`), ...indexes.map((r) => r.indexname), ...functions.map((r) => r.proname)];
        };
        const upTo0072 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '0073'));
        await migrateToLatest(down, { migrationTableSchema: downSchema, migrations: upTo0072 });
        const original = await defs();
        const pr = (
          await down.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f57357', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          )
        ).rows[0].id as string;
        const party = async (displayName: string) => {
          const created = await new PostgresPartyRepository(createDatabase(down)).create(
            {
              mreRealmId: REALM,
              partyType: 'PERSON',
              displayName,
              firstName: null,
              lastName: null,
              legalName: null,
              registrationNumber: null,
              email: null,
              phone: null,
            },
            actor,
          );
          if (created.kind !== 'CREATED') throw new Error(created.kind);
          return created.party.id;
        };
        const [s, a] = [await party('S (synthetisch)'), await party('A (synthetisch)')];
        // Existing rows: an undated legacy row and a legacy row dated by §58N; both read the same before and after.
        const undated = await insertConfirmedAsBeforeVcX34(down, {
          mreRealmId: REALM,
          propertyReferenceId: pr,
          contractDate: '2015-06-01',
          buyers: [{ partyId: s, share: [1, 1] }],
        });
        const pr2 = (
          await down.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f57358', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          )
        ).rows[0].id as string;
        const dated = await insertConfirmedAsBeforeVcX34(down, {
          mreRealmId: REALM,
          propertyReferenceId: pr2,
          contractDate: '2025-03-01',
          buyers: [{ partyId: a, share: [1, 1] }],
        });
        await down.query(
          `UPDATE acquisition SET economic_transfer_date = '2025-05-01', economic_transfer_recorded_at = now(), economic_transfer_source_references = ARRAY['x'], version = version + 1 WHERE id = $1`,
          [dated.acquisitionId],
        );
        const rowsOf = async () =>
          (await down.query(`SELECT to_jsonb(a) - 'confirmed_ownership_start' AS r FROM acquisition a ORDER BY id`)).rows.map((r) => r.r);
        const reads = async () =>
          (await down.query(`SELECT id, acquisition_confirmation_violation(id) AS c, acquisition_increase_violation(id) AS i FROM acquisition ORDER BY id`))
            .rows;
        const [rowsBefore, readsBefore] = [await rowsOf(), await reads()];
        await migrateToLatest(down, { migrationTableSchema: downSchema });
        const after = await defs();
        expect(after).not.toEqual(original);
        expect([await rowsOf(), await reads()]).toEqual([rowsBefore, readsBefore]);
        expect((await down.query(`SELECT count(*)::int AS n FROM acquisition WHERE confirmed_ownership_start IS NOT NULL`)).rows[0].n).toBe(0);
        // N: a DRAFT dated by §58N, its row on t, confirmed from the transfer: down refused, nothing changed.
        const n = (
          await down.query(
            `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, created_by)
             VALUES ($1, $2, 'DRAFT', 200000, 'EUR', 1, 1, '2025-03-01', 'x') RETURNING id`,
            [REALM, pr],
          )
        ).rows[0].id as string;
        await down.query(
          `INSERT INTO acquisition_party (acquisition_id, mre_realm_id, party_id, role, position) VALUES ($1, $2, $3, 'BUYER', 1), ($1, $2, $4, 'SELLER', 1)`,
          [n, REALM, a, s],
        );
        await down.query(`UPDATE ownership SET valid_until = '2025-04-30' WHERE id = $1`, [undated.ownershipIds[0]]);
        await down.query(
          `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, acquisition_id, created_by) VALUES ($1, $2, $3, 1, 1, '2025-05-01', 'VALID', $4, 'x')`,
          [REALM, pr, a, n],
        );
        await down.query(
          `UPDATE acquisition SET economic_transfer_date = '2025-05-01', economic_transfer_recorded_at = now(), economic_transfer_source_references = ARRAY['x'], version = version + 1 WHERE id = $1`,
          [n],
        );
        await down.query(CONFIRM, [n]);
        const migration = migrations['0073_ownership_start_on_confirm'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
        let refused: unknown;
        await withMigrationLock(async () => {
          refused = await migration.down(createDatabase(down) as never).catch((e: unknown) => e);
        });
        expect(refused).toMatchObject({ code: '23514' });
        expect(await defs()).toEqual(after);
        // Counter-check: N back to a DRAFT (triggers off), down runs; N's rows from t then fail on the contract date again (§58N's rule).
        await down.query(`ALTER TABLE acquisition DISABLE TRIGGER USER`);
        await down.query(`UPDATE acquisition SET status = 'DRAFT', confirmed_at = NULL, confirmed_ownership_start = NULL WHERE id = $1`, [n]);
        await down.query(`ALTER TABLE acquisition ENABLE TRIGGER USER`);
        // Review on #284: an Acquisition created WITH the date and confirmed under 0073 (confirmed_ownership_start set,
        // economic_transfer_recorded_at NULL) does not block down: after it, branch 5 still gives the date.
        const pr3 = (
          await down.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f57359', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          )
        ).rows[0].id as string;
        const created = (
          await down.query(
            `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, economic_transfer_date, created_by)
             VALUES ($1, $2, 'DRAFT', 200000, 'EUR', 1, 1, '2025-03-01', '2025-05-01', 'x') RETURNING id`,
            [REALM, pr3],
          )
        ).rows[0].id as string;
        await down.query(`INSERT INTO acquisition_party (acquisition_id, mre_realm_id, party_id, role, position) VALUES ($1, $2, $3, 'BUYER', 1)`, [
          created,
          REALM,
          a,
        ]);
        await down.query(
          `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, acquisition_id, created_by) VALUES ($1, $2, $3, 1, 1, '2025-05-01', 'VALID', $4, 'x')`,
          [REALM, pr3, a, created],
        );
        await down.query(CONFIRM, [created]);
        expect(
          (
            await down.query(
              `SELECT to_char(confirmed_ownership_start, 'YYYY-MM-DD') AS c, economic_transfer_recorded_at AS r FROM acquisition WHERE id = $1`,
              [created],
            )
          ).rows[0],
        ).toEqual({ c: '2025-05-01', r: null });
        await withMigrationLock(() => migration.down(createDatabase(down) as never));
        expect(await defs()).toEqual(original);
        // Its start is unchanged after down (branch 5): the row still meets requirements 1–6 on the date.
        expect((await down.query(`SELECT status, acquisition_confirmation_violation(id) AS v FROM acquisition WHERE id = $1`, [created])).rows[0]).toEqual({
          status: 'CONFIRMED',
          v: null,
        });
        expect((await down.query(`SELECT acquisition_confirmation_violation($1) AS v`, [n])).rows[0].v).toBe('OWNERSHIP_NOT_FROM_TRANSFER_DATE');
        expect((await down.query(`SELECT to_jsonb(a) AS r FROM acquisition a WHERE id = $1`, [dated.acquisitionId])).rows[0].r).toEqual(
          rowsBefore.find((r: { id: string }) => r.id === dated.acquisitionId),
        );
        // up again: the same state as after the first up; a second up fails and changes nothing.
        await withMigrationLock(() => migration.up(createDatabase(down) as never));
        expect(await defs()).toEqual(after);
        let again: unknown;
        await withMigrationLock(async () => {
          again = await migration.up(createDatabase(down) as never).catch((e: unknown) => e);
        });
        expect(String(again)).toMatch(/already exists/);
        expect(await defs()).toEqual(after);
      } finally {
        await down.end();
      }
    },
  );
});
