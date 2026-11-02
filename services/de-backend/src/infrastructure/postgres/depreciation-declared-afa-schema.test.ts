import pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { DeclaredAfa } from '../../domains/depreciation/index.js';
import { createDatabase } from './database.js';
import {
  OTHER_REALM,
  REALM,
  actor,
  codeOf,
  databaseUrl,
  day,
  eur,
  evidence,
  useDepreciationAssetDatabase,
  withMigrationLock,
} from './depreciation-asset.test-support.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * Migration 0061 (VC-X-41 Part 2, api-design.md §59G; Entscheidung des Projektinhabers, 2026-11-02, open question 11)
 * past the repository, each guard with its counter-check: the declared AfA per owner (`declared_afa`) names a Party of the
 * entry's Realm, each once, a non-negative amount with two places, a year 2000–2100 and an evidence reference of 1–500,
 * no other key, at most 20, and only on an entry whose Stichtag lies after its contract year; on insert and on update.
 * Then the repository: the round trip, the review state reset by a change, the AuditRecords, the refusals. Synthetic.
 */
describe.skipIf(databaseUrl === undefined)('migration 0061: the declared AfA of a late evidence (§59G Part 2)', () => {
  const { ctx, propertyReference, party, acquisition, insertAsset, insertLife, life, building, created, audit } =
    useDepreciationAssetDatabase('declared_afa_test');
  /** The fixture's Acquisition is contracted 2026-03-01: a Stichtag of 2027 can be a late evidence, one of 2026 cannot. */
  const fixture = async () => {
    const pr = await propertyReference();
    const acquisitionId = await acquisition(pr);
    const assetId = (await insertAsset({ property_reference_id: pr })).rows[0].id as string;
    const owner = await party('Käuferin A');
    return { pr, acquisitionId, assetId, owner };
  };
  const row = (partyId: string, extra: Record<string, unknown> = {}) => ({
    partyId,
    throughYear: 2026,
    amount: '1526.40',
    evidenceReference: 'Steuerbescheid 2026 (synthetisch)',
    ...extra,
  });
  const late = (f: Awaited<ReturnType<typeof fixture>>, declared: unknown, values: Record<string, unknown> = {}) =>
    codeOf(
      insertLife({
        asset_id: f.assetId,
        property_reference_id: f.pr,
        acquisition_id: f.acquisitionId,
        evidence_date: '2027-06-15',
        valuation_date: '2027-05-20',
        declared_afa: JSON.stringify(declared),
        ...values,
      }),
    );

  it('a valid declared AfA is accepted, and none ([]) on any entry (counter-checks); the amount: negative or not two places refused (23514)', async () => {
    const f = await fixture();
    expect(await late(f, [row(f.owner)])).toBe('accepted');
    const g = await fixture();
    expect(await late(g, [row(g.owner, { amount: '-0.01' })])).toBe('23514');
    expect(await late(g, [row(g.owner, { amount: '1526.4' })])).toBe('23514');
    expect(await late(g, [row(g.owner, { amount: 1526.4 })])).toBe('23514');
    expect(await late(g, [row(g.owner, { amount: '0.00' })])).toBe('accepted');
    const h = await fixture();
    expect(await late(h, [], { valuation_date: '2026-06-15', evidence_date: '2026-06-15' })).toBe('accepted');
  });

  it('the owner: a Party of another Realm or none refused (23503); one owner twice refused (23505); counter-check: two owners accepted', async () => {
    const f = await fixture();
    const foreign = await party('Käufer B', OTHER_REALM);
    expect(await late(f, [row(foreign)])).toBe('23503');
    expect(await late(f, [row('00000000-0000-4000-8000-000000000000')])).toBe('23503');
    expect(await late(f, [row(f.owner), row(f.owner, { amount: '0.00' })])).toBe('23505');
    expect(await late(f, [row(f.owner), row(await party('Käufer B'))])).toBe('accepted');
  });

  it('the evidence reference 1–500, the year 2000–2100, no other key, an array of at most 20 (23514); counter-check: 1 and 500 accepted', async () => {
    const f = await fixture();
    for (const bad of [
      [row(f.owner, { evidenceReference: '' })],
      [row(f.owner, { evidenceReference: 'x'.repeat(501) })],
      [row(f.owner, { throughYear: 1999 })],
      [row(f.owner, { throughYear: 2026.5 })],
      [{ ...row(f.owner), note: 'x' }],
      [{ partyId: f.owner, throughYear: 2026, amount: '1.00' }],
      { partyId: f.owner },
      Array.from({ length: 21 }, () => row(f.owner)),
    ]) {
      expect(await late(f, bad)).toBe('23514');
    }
    expect(await late(f, [row(f.owner, { evidenceReference: 'x' })])).toBe('accepted');
    const g = await fixture();
    expect(await late(g, [row(g.owner, { evidenceReference: 'x'.repeat(500) })])).toBe('accepted');
  });

  it('only on an entry whose Stichtag lies after its contract year (23514), also on update; counter-check: the year after the contract accepted', async () => {
    const f = await fixture();
    expect(await late(f, [row(f.owner)], { valuation_date: '2026-12-31', evidence_date: '2026-12-31' })).toBe('23514');
    expect(await late(f, [row(f.owner)], { valuation_date: '2027-01-01', evidence_date: '2027-01-01' })).toBe('accepted');
    const update = (set: string, values: unknown[] = []) =>
      codeOf(ctx.pool.query(`UPDATE depreciation_asset_useful_life SET ${set} WHERE asset_id = $1`, [f.assetId, ...values]));
    expect(await update(`valuation_date = '2026-06-15', evidence_date = '2026-06-15'`)).toBe('23514');
    expect(await update(`declared_afa = $2::jsonb`, [JSON.stringify([row(f.owner, { amount: '-1.00' })])])).toBe('23514');
    expect(await update(`declared_afa = '[]'::jsonb, valuation_date = '2026-06-15', evidence_date = '2026-06-15'`)).toBe('accepted');
  });

  it('up keeps every row without a declared AfA ([]), up refused with a recorded version, down refused with a stated row', { timeout: 60_000 }, async () => {
    const schema = testSchemaName('declared_afa_down_test');
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
    const migration = migrations['0061_shorter_life_declared_afa'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
    const failure = async (step: 'up' | 'down') => {
      let error: unknown;
      await withMigrationLock(async () => {
        error = await migration[step](createDatabase(pool) as never).then(
          () => undefined,
          (e: unknown) => e,
        );
      });
      return (error as { code?: string } | undefined)?.code;
    };
    const run = (step: 'up' | 'down') => withMigrationLock(() => migration[step](createDatabase(pool) as never));
    try {
      await migrateToLatest(pool, { migrationTableSchema: schema });
      await run('down');
      const { rows } = await pool.query(
        `WITH pr AS (INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by)
                        VALUES ($1, 'aaaaaaaaaaaaaaaaaaaa0061', 'ACTIVE', 'x') RETURNING id),
                acq AS (INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator,
                          acquired_share_denominator, contract_date, created_by)
                        SELECT $1, id, 'DRAFT', 1000, 'EUR', 1, 1, '2024-02-10', 'x' FROM pr RETURNING id, property_reference_id),
                asset AS (INSERT INTO depreciation_asset (mre_realm_id, property_reference_id, asset_type, status, depreciation_method, review_state,
                          building_completion_year, created_by)
                        SELECT $1, property_reference_id, 'BUILDING', 'ACTIVE', 'LINEAR_7_4', 'CONFIRMED', 1965, 'x' FROM acq RETURNING id, property_reference_id)
           INSERT INTO depreciation_asset_useful_life (asset_id, mre_realm_id, property_reference_id, acquisition_id, useful_life_years, evidence_source,
             evidence_date, valuation_date, review_state)
           SELECT asset.id, $1, asset.property_reference_id, acq.id, 33, 'Gutachten (synthetisch)', '2027-06-15', '2027-05-20', 'CONFIRMED' FROM asset, acq
           RETURNING asset_id`,
        [REALM],
      );
      expect(rows).toHaveLength(1);
      await run('up');
      expect((await pool.query(`SELECT declared_afa FROM depreciation_asset_useful_life`)).rows).toEqual([{ declared_afa: [] }]);
      // A stated declared AfA: down refused, nothing dropped.
      const ownerRow = await pool.query(
        `INSERT INTO party (mre_realm_id, party_type, display_name, status, created_by) VALUES ($1, 'PERSON', 'Käuferin A', 'ACTIVE', 'x') RETURNING id`,
        [REALM],
      );
      await pool.query(`UPDATE depreciation_asset_useful_life SET declared_afa = $1::jsonb`, [JSON.stringify([row(ownerRow.rows[0].id as string)])]);
      expect(await failure('down')).toBe('23514');
      await pool.query(`UPDATE depreciation_asset_useful_life SET declared_afa = '[]'::jsonb`);
      await run('down');
      await pool.query(`ALTER TABLE depreciation_schedule_version DISABLE TRIGGER USER`);
      await pool.query(`ALTER TABLE depreciation_schedule_version DROP CONSTRAINT depreciation_schedule_version_asset_fk`);
      await pool.query(
        `INSERT INTO depreciation_schedule_version (mre_realm_id, asset_id, property_reference_id, version_number, status, from_year, through_year, computed_on,
           calculation_version, currency, asset_type, depreciation_method, asset_review_state, asset_version, input_fingerprint, output_fingerprint, reason, recorded_by)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), 1, 'CURRENT', 2026, 2026, '2028-01-20', 1, 'EUR', 'BUILDING', 'LINEAR_7_4', 'CONFIRMED', 1, repeat('a', 64), repeat('b', 64), 'x', 'x')`,
        [REALM],
      );
      expect(await failure('up')).toBe('23514');
      // Counter-check: without the version row, up passes.
      await pool.query(`DELETE FROM depreciation_schedule_version`);
      await run('up');
    } finally {
      await pool.end();
    }
  });

  describe('the repository (create, amend, history, Realm)', () => {
    const declaredOf = (partyId: string, value: string, throughYear = 2026): DeclaredAfa => ({
      partyId,
      throughYear,
      amount: eur(value),
      evidenceReference: 'Steuerbescheid 2026 (synthetisch)',
    });
    const lateEvidence = { ...evidence, date: day('2027-06-15'), valuationDate: day('2027-05-20') };

    it('create stores the declared AfA and reads it back; an amend changing it resets the review state and names it in the AuditRecord', async () => {
      const pr = await propertyReference();
      const acquisitionId = await acquisition(pr);
      const owner = await party('Käuferin A');
      const asset = await created(
        building(pr, {
          shorterUsefulLives: [life(acquisitionId, { evidence: lateEvidence, reviewState: 'CONFIRMED', declaredAfa: [declaredOf(owner, '1526.40')] })],
        }),
      );
      const read = await ctx.assets.find(asset.id, REALM);
      expect(read?.asset.shorterUsefulLives[0]?.declaredAfa.map((r) => [r.partyId, r.throughYear, r.amount.amount, r.evidenceReference])).toEqual([
        [owner, 2026, '1526.40', 'Steuerbescheid 2026 (synthetisch)'],
      ]);
      const amended = await ctx.assets.amend(
        asset.id,
        REALM,
        { shorterUsefulLives: [{ acquisitionId, usefulLifeYears: 30, evidence: lateEvidence, declaredAfa: [declaredOf(owner, '1526.41')] }] },
        actor,
      );
      expect(amended.kind).toBe('AMENDED');
      const after = await ctx.assets.find(asset.id, REALM);
      expect([after?.asset.shorterUsefulLives[0]?.reviewState, after?.asset.shorterUsefulLives[0]?.declaredAfa[0]?.amount.amount]).toEqual([
        'UNREVIEWED',
        '1526.41',
      ]);
      const records = await audit(asset.id);
      expect(records.map((r) => r.action)).toEqual(['CREATED', 'AMENDED']);
      const createdEntry = (records[0]?.metadata['shorterUsefulLives'] as { declaredAfa: unknown[] }[])[0];
      expect(createdEntry?.declaredAfa).toEqual([
        { partyId: owner, throughYear: 2026, amount: { amount: '1526.40', currency: 'EUR' }, evidenceReference: 'Steuerbescheid 2026 (synthetisch)' },
      ]);
      const change = (
        records[1]?.metadata['changedEntries'] as { from: { declaredAfa: { amount: unknown }[] }; to: { declaredAfa: { amount: unknown }[] } }[]
      )[0];
      expect([change?.from.declaredAfa[0]?.amount, change?.to.declaredAfa[0]?.amount]).toEqual([
        { amount: '1526.40', currency: 'EUR' },
        { amount: '1526.41', currency: 'EUR' },
      ]);
      // Counter-check: the same declared AfA again is a no-op (no AuditRecord).
      await ctx.assets.amend(
        asset.id,
        REALM,
        {
          shorterUsefulLives: [
            { acquisitionId, usefulLifeYears: 30, evidence: lateEvidence, reviewState: 'UNREVIEWED', declaredAfa: [declaredOf(owner, '1526.41')] },
          ],
        },
        actor,
      );
      expect((await audit(asset.id)).length).toBe(2);
    });

    it('refusals: an owner of another Realm is PARTY_NOT_FOUND; a Stichtag in the contract year is DECLARED_AFA_NOT_APPLICABLE; nothing written; another Realm’s asset NOT_FOUND', async () => {
      const pr = await propertyReference();
      const acquisitionId = await acquisition(pr);
      const foreign = await party('Käufer B', OTHER_REALM);
      const owner = await party('Käuferin A');
      const count = async () => (await ctx.pool.query(`SELECT count(*)::int AS n FROM depreciation_asset WHERE property_reference_id = $1`, [pr])).rows[0].n;
      const create = (declaredAfa: DeclaredAfa[], valuation = lateEvidence) =>
        ctx.assets.create(building(pr, { shorterUsefulLives: [life(acquisitionId, { evidence: valuation, declaredAfa })] }), actor);
      expect(await create([declaredOf(foreign, '1.00')])).toEqual({ kind: 'PARTY_NOT_FOUND', partyId: foreign });
      const inContractYear = { ...evidence, date: day('2026-12-31'), valuationDate: day('2026-12-31') };
      expect(await create([declaredOf(owner, '1.00')], inContractYear)).toEqual({
        kind: 'DECLARED_AFA_NOT_APPLICABLE',
        index: 0,
        acquisitionId,
        valuationDate: '2026-12-31',
        contractDate: '2026-03-01',
      });
      expect(await count()).toBe(0);
      // Counter-check: the same entry without a declared AfA, and the late one with it, are created.
      const asset = (await create([declaredOf(owner, '1.00')])) as { kind: string; asset: { id: string } };
      expect(asset.kind).toBe('CREATED');
      expect(await ctx.assets.find(asset.asset.id, OTHER_REALM)).toBeUndefined();
      expect((await ctx.assets.amend(asset.asset.id, OTHER_REALM, { notes: 'x' }, actor)).kind).toBe('NOT_FOUND');
      const amend = await ctx.assets.amend(
        asset.asset.id,
        REALM,
        { shorterUsefulLives: [{ acquisitionId, usefulLifeYears: 30, evidence: inContractYear, declaredAfa: [declaredOf(owner, '1.00')] }] },
        actor,
      );
      expect(amend.kind).toBe('DECLARED_AFA_NOT_APPLICABLE');
    });
  });
});
