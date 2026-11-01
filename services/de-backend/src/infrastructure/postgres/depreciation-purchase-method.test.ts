import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PurchaseMethod, PurchaseMethodAmendment } from '../../domains/depreciation/index.js';
import { createDatabase } from './database.js';
import type { PostgresDepreciationAssetRepository } from './depreciation-asset-repository.js';
import {
  OTHER_REALM,
  REALM,
  actor,
  codeOf,
  databaseUrl,
  messageOf,
  useDepreciationAssetDatabase,
  waitUntil,
  withMigrationLock,
  type Queryable,
} from './depreciation-asset.test-support.js';
import { standardMethod } from './depreciation-method.test-support.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-X-37 persistence (api-design.md §59C "In the database", migration 0053): the purchase method entries written with
 * the asset's create and amend as a difference (the reset, `changedPurchaseMethods`), checked with the shorter lives in
 * one step; past the repository each guard and CHECK with a counter-check; the concurrency of §59's shorter life (an
 * entry against a cancel of its DRAFT, amend against void); `up` refusing with a recorded version, `down` with an entry.
 * Synthetic data.
 */
describe.skipIf(databaseUrl === undefined)('the purchase method entries (§59C, migration 0053)', () => {
  const { ctx, propertyReference, party, acquisition, cancel, life, building, created, audit, insertAsset, blockedBy, holding } =
    useDepreciationAssetDatabase('purchase_method_test');
  let pool: pg.Pool;
  let assets: PostgresDepreciationAssetRepository;
  beforeAll(() => {
    ({ pool, assets } = ctx);
  });
  /** An entry as an amend names it (its review state kept unless named). */
  const named = (e: PurchaseMethod, overrides: Partial<PurchaseMethodAmendment> = {}): PurchaseMethodAmendment => {
    const { reviewState: _r, advisorPartyId: _a, ...rest } = e;
    return { ...rest, ...overrides };
  };
  const xminOf = async (assetId: string, acquisitionId: string) =>
    (await pool.query(`SELECT xmin::text AS x FROM depreciation_asset_purchase_method WHERE asset_id = $1 AND acquisition_id = $2`, [assetId, acquisitionId]))
      .rows[0]?.x as string | undefined;
  /** A raw insert past the repository, a standard UNREVIEWED entry by default. */
  const insertMethod = (values: Record<string, unknown>, q: Queryable = pool) => {
    const v: Record<string, unknown> = {
      mre_realm_id: REALM,
      consideration: 'PAID',
      method: 'LINEAR_7_4',
      special_depreciation: [],
      subsidies_received: false,
      new_building_by_conversion: false,
      other_special_case: false,
      evidence_source: 'Kaufvertrag (synthetisch)',
      evidence_date: '2026-06-15',
      review_state: 'UNREVIEWED',
      ...values,
    };
    const columns = Object.keys(v);
    return q.query(
      `INSERT INTO depreciation_asset_purchase_method (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(v),
    );
  };

  it('create: the entries stored in acquisitionId order, read back with their start years; AuditRecord CREATED lists them', async () => {
    const pr = await propertyReference();
    const [a1, a2] = (await Promise.all([acquisition(pr), acquisition(pr)])).sort();
    const advisor = await party();
    const asset = await created(
      building(pr, {
        purchaseMethods: [
          standardMethod(a2, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor, specialDepreciation: ['INCREASED_7I', 'SPECIAL_7B'] }),
          standardMethod(a1, { otherSpecialCase: true, otherSpecialCaseNote: 'Denkmal (synthetisch)', notes: 'laut Anlage V' }),
        ],
      }),
    );
    expect(asset.purchaseMethods).toEqual([
      standardMethod(a1, { otherSpecialCase: true, otherSpecialCaseNote: 'Denkmal (synthetisch)', notes: 'laut Anlage V' }),
      standardMethod(a2, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor, specialDepreciation: ['INCREASED_7I', 'SPECIAL_7B'] }),
    ]);
    const [record] = await audit(asset.id);
    expect(record?.metadata['purchaseMethods']).toEqual(JSON.parse(JSON.stringify(asset.purchaseMethods)));
    const read = await assets.find(asset.id, REALM);
    expect(read?.asset.purchaseMethods).toEqual(asset.purchaseMethods);
    expect(read?.purchaseStartYears).toEqual({ [a1]: 2026, [a2]: 2026 });
  });

  it('amend: added, changed (the fact resets the state) and removed as a difference, an unchanged row untouched (xmin); changedPurchaseMethods', async () => {
    const pr = await propertyReference();
    const [a1, a2, a3] = (await Promise.all([acquisition(pr), acquisition(pr), acquisition(pr)])).sort();
    const asset = await created(building(pr, { purchaseMethods: [standardMethod(a1), standardMethod(a2)] }));
    const untouched = await xminOf(asset.id, a2);
    const amended = await assets.amend(
      asset.id,
      REALM,
      { purchaseMethods: [named(standardMethod(a2)), named(standardMethod(a3)), named(standardMethod(a1, { method: 'DEGRESSIVE_7_5' }))] },
      actor,
    );
    expect(amended).toMatchObject({ kind: 'AMENDED', changed: true });
    expect(await xminOf(asset.id, a2)).toBe(untouched);
    const after = (await assets.find(asset.id, REALM))?.asset.purchaseMethods;
    expect(after?.map((e) => [e.acquisitionId, e.method, e.reviewState])).toEqual([
      [a1, 'DEGRESSIVE_7_5', 'UNREVIEWED'],
      [a2, 'LINEAR_7_4', 'CONFIRMED'],
      [a3, 'LINEAR_7_4', 'UNREVIEWED'],
    ]);
    const changes = (await audit(asset.id))[1]?.metadata['changedPurchaseMethods'] as { acquisitionId: string; change: string; from: unknown; to: unknown }[];
    expect(changes.map((c) => [c.acquisitionId, c.change])).toEqual([
      [a1, 'CHANGED'],
      [a3, 'ADDED'],
    ]);
    expect([(changes[0]?.from as PurchaseMethod).reviewState, (changes[0]?.to as PurchaseMethod).reviewState]).toEqual(['CONFIRMED', 'UNREVIEWED']);
    // A changed note or evidence alone keeps the state; the confirm is amend's (a state named).
    const quiet = await assets.amend(
      asset.id,
      REALM,
      {
        purchaseMethods: [
          named(standardMethod(a1, { method: 'DEGRESSIVE_7_5' }), { reviewState: 'CONFIRMED', notes: 'geprüft' }),
          named(standardMethod(a2), { notes: 'x' }),
        ],
      },
      actor,
    );
    expect(quiet.kind === 'AMENDED' && quiet.asset.purchaseMethods.map((e) => [e.acquisitionId, e.reviewState, e.notes])).toEqual([
      [a1, 'CONFIRMED', 'geprüft'],
      [a2, 'CONFIRMED', 'x'],
    ]);
    // null in the body is [] here: every entry removed.
    expect(await assets.amend(asset.id, REALM, { purchaseMethods: [] }, actor)).toMatchObject({ kind: 'AMENDED', asset: { purchaseMethods: [] } });
  });

  it('the checks with the shorter lives in one step, shorter lives first; Realm isolation; an unchanged entry of a later-cancelled DRAFT does not block', async () => {
    const pr = await propertyReference();
    const [mine, cancelled] = await Promise.all([acquisition(pr), acquisition(pr)]);
    const elsewhere = await acquisition(await propertyReference());
    const foreign = await acquisition(await propertyReference(OTHER_REALM), OTHER_REALM);
    const unknown = '0000ffff-0000-4000-8000-0000000000aa';
    await cancel(cancelled);
    const asset = (overrides: Parameters<typeof building>[1]) => assets.create(building(pr, overrides), actor);
    // Each check over all entries before the next: the method's unknown Acquisition (404) before the shorter life's 422.
    expect(await asset({ shorterUsefulLives: [life(elsewhere)], purchaseMethods: [standardMethod(unknown)] })).toEqual({
      kind: 'ACQUISITION_NOT_FOUND',
      acquisitionId: unknown,
    });
    // Within one check, the shorter lives first.
    expect(await asset({ shorterUsefulLives: [life(unknown)], purchaseMethods: [standardMethod(foreign)] })).toEqual({
      kind: 'ACQUISITION_NOT_FOUND',
      acquisitionId: unknown,
    });
    expect(await asset({ purchaseMethods: [standardMethod(foreign)] })).toEqual({ kind: 'ACQUISITION_NOT_FOUND', acquisitionId: foreign });
    expect(await asset({ purchaseMethods: [standardMethod(elsewhere)] })).toMatchObject({ kind: 'ACQUISITION_NOT_OF_PROPERTY', acquisitionId: elsewhere });
    expect(await asset({ purchaseMethods: [standardMethod(cancelled)] })).toEqual({ kind: 'ACQUISITION_CANCELLED', acquisitionId: cancelled });
    const otherAdvisor = await party('Beratung', OTHER_REALM);
    expect(await asset({ purchaseMethods: [standardMethod(mine, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: otherAdvisor })] })).toEqual({
      kind: 'PARTY_NOT_FOUND',
      partyId: otherAdvisor,
    });
    expect((await pool.query(`SELECT count(*)::int AS n FROM depreciation_asset WHERE property_reference_id = $1`, [pr])).rows[0].n).toBe(0);
    // A DRAFT's entry stays when the DRAFT is cancelled later; only a changed entry of it is checked again.
    const later = await acquisition(pr);
    const a = await created(building(pr, { purchaseMethods: [standardMethod(mine), standardMethod(later)] }));
    await cancel(later);
    const before = await xminOf(a.id, later);
    expect(
      await assets.amend(a.id, REALM, { purchaseMethods: [named(standardMethod(mine), { notes: 'x' }), named(standardMethod(later))] }, actor),
    ).toMatchObject({
      kind: 'AMENDED',
    });
    expect(await xminOf(a.id, later)).toBe(before);
    expect(
      await assets.amend(a.id, REALM, { purchaseMethods: [named(standardMethod(mine)), named(standardMethod(later, { subsidiesReceived: true }))] }, actor),
    ).toEqual({
      kind: 'ACQUISITION_CANCELLED',
      acquisitionId: later,
    });
  });

  it('past the repository, each refused with a counter-check: CANCELLED, VOID, SEPARATE_ASSET, a 21st entry, a move, the note, an unknown or duplicate value', async () => {
    const pr = await propertyReference();
    const asset = await created(building(pr));
    const ok = await acquisition(pr);
    const entry = (acquisitionId: string, values: Record<string, unknown> = {}) =>
      insertMethod({ asset_id: asset.id, property_reference_id: pr, acquisition_id: acquisitionId, ...values });
    const inRollback = async (work: (client: pg.PoolClient) => Promise<unknown>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        return await work(client);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    const probe = (acquisitionId: string, values: Record<string, unknown> = {}) =>
      inRollback((client) => codeOf(insertMethod({ asset_id: asset.id, property_reference_id: pr, acquisition_id: acquisitionId, ...values }, client)));
    expect(await probe(ok)).toBe('accepted');
    // The note exactly with the flag; the values; the special depreciations a subset, each once.
    expect(await probe(ok, { other_special_case_note: 'x' })).toBe('23514');
    expect(await probe(ok, { other_special_case: true })).toBe('23514');
    expect(await probe(ok, { other_special_case: true, other_special_case_note: 'Denkmal' })).toBe('accepted');
    expect(await probe(ok, { consideration: 'UNKNOWN' })).toBe('23514');
    expect(await probe(ok, { method: 'UNKNOWN' })).toBe('23514');
    expect(await probe(ok, { special_depreciation: ['SPECIAL_7X'] })).toBe('23514');
    expect(await probe(ok, { special_depreciation: ['SPECIAL_7B', 'SPECIAL_7B'] })).toBe('23514');
    expect(await probe(ok, { special_depreciation: ['SPECIAL_7B', 'OTHER'] })).toBe('accepted');
    expect(await probe(ok, { review_state: 'SUGGESTED' })).toBe('23514');
    expect(await probe(ok, { advisor_party_id: await party() })).toBe('23514');
    // A CANCELLED Acquisition takes no new entry.
    const gone = await acquisition(pr);
    await cancel(gone);
    expect(await inRollback((client) => messageOf(insertMethod({ asset_id: asset.id, property_reference_id: pr, acquisition_id: gone }, client)))).toContain(
      'ACQUISITION_CANCELLED',
    );
    // At most 20 per asset.
    const twenty = await Promise.all(Array.from({ length: 21 }, () => acquisition(pr)));
    for (const id of twenty.slice(0, 20)) await entry(id);
    expect(await messageOf(entry(twenty[20] as string))).toContain('at most 20');
    // Never moved to another Acquisition (counter-check: a fact changes).
    expect(
      await messageOf(
        pool.query(`UPDATE depreciation_asset_purchase_method SET acquisition_id = $2 WHERE asset_id = $1 AND acquisition_id = $3`, [asset.id, ok, twenty[0]]),
      ),
    ).toContain('never moves');
    expect(
      await codeOf(
        pool.query(`UPDATE depreciation_asset_purchase_method SET method = 'OTHER' WHERE asset_id = $1 AND acquisition_id = $2`, [asset.id, twenty[0]]),
      ),
    ).toBe('accepted');
    // A separate asset takes none (raw: the guard), a VOID building none (counter-check: an ACTIVE building above).
    const separate = (
      await insertAsset({
        property_reference_id: await propertyReference(),
        asset_type: 'SEPARATE_ASSET',
        depreciation_method: 'LINEAR_7_1',
        description: 'Küche',
        useful_life_years: 10,
        useful_life_basis: 'B8',
        acquired_on: '2027-04-20',
      })
    ).rows[0].id as string;
    const separatePr = (await pool.query(`SELECT property_reference_id FROM depreciation_asset WHERE id = $1`, [separate])).rows[0]
      .property_reference_id as string;
    expect(await messageOf(insertMethod({ asset_id: separate, property_reference_id: separatePr, acquisition_id: await acquisition(separatePr) }))).toContain(
      'has no purchase method',
    );
    const voided = await created(building(await propertyReference()));
    expect((await assets.void(voided.id, REALM, 'falsch', new Date('2026-10-30T10:00:00Z'), actor)).kind).toBe('VOIDED');
    expect(
      await messageOf(
        insertMethod({ asset_id: voided.id, property_reference_id: voided.propertyReferenceId, acquisition_id: await acquisition(voided.propertyReferenceId) }),
      ),
    ).toContain('ASSET_NOT_ACTIVE');
  });

  it('an entry against a cancel of its DRAFT: cancel first, the create waits and sees ACQUISITION_CANCELLED; entry first, the cancel waits and cancels', async () => {
    const pr = await propertyReference();
    const draft = await acquisition(pr);
    await holding(async (holder) => {
      await holder.query(`UPDATE property_reference SET version = version WHERE id = $1`, [pr]);
      await holder.query(
        `UPDATE acquisition SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'Rücktritt', version = version + 1, updated_at = now() WHERE id = $1`,
        [draft],
      );
      const blocked = await blockedBy(holder);
      const create = assets.create(building(pr, { purchaseMethods: [standardMethod(draft)] }), actor);
      await waitUntil(async () => (await blocked()).some((q) => q.startsWith('update "property_reference"')));
      await holder.query('COMMIT');
      expect(await create).toEqual({ kind: 'ACQUISITION_CANCELLED', acquisitionId: draft });
    });
    const second = await acquisition(pr);
    let assetId = '';
    await holding(async (holder) => {
      await holder.query(`UPDATE property_reference SET version = version WHERE id = $1`, [pr]);
      await holder.query(`SELECT 1 FROM acquisition WHERE id = $1 FOR SHARE`, [second]);
      assetId = (await insertAsset({ property_reference_id: pr }, holder)).rows[0].id as string;
      await insertMethod({ asset_id: assetId, property_reference_id: pr, acquisition_id: second }, holder);
      const blocked = await blockedBy(holder);
      const cancelling = ctx.acquisitions.cancel(second, REALM, 'Rücktritt', new Date('2026-10-30T10:00:00Z'), actor);
      await waitUntil(async () => (await blocked()).length > 0);
      await holder.query('COMMIT');
      expect((await cancelling).kind).toBe('CANCELLED');
    });
    // The entry stays (a person's statement); the schedule does not list a CANCELLED purchase.
    expect((await assets.find(assetId, REALM))?.asset.purchaseMethods.map((e) => e.acquisitionId)).toEqual([second]);
  });

  it('amend against void (RC): void first, the amend waits and sees VOID; counter-check: the VOID asset refuses a late raw entry', async () => {
    const pr = await propertyReference();
    const purchase = await acquisition(pr);
    const asset = await created(building(pr));
    await holding(async (holder) => {
      await holder.query(`UPDATE property_reference SET version = version WHERE id = $1`, [pr]);
      await holder.query(`UPDATE depreciation_asset SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [
        asset.id,
      ]);
      const blocked = await blockedBy(holder);
      const amend = assets.amend(asset.id, REALM, { purchaseMethods: [named(standardMethod(purchase))] }, actor);
      await waitUntil(async () => (await blocked()).length > 0);
      await holder.query('COMMIT');
      expect(await amend).toEqual({ kind: 'ASSET_NOT_ACTIVE', status: 'VOID' });
    });
    expect(await messageOf(insertMethod({ asset_id: asset.id, property_reference_id: pr, acquisition_id: purchase }))).toContain('ASSET_NOT_ACTIVE');
  });

  it(
    '0053 up refuses while a recorded version exists, else creates; down refuses while an entry exists, else drops the table and the columns',
    { timeout: 60_000 },
    async () => {
      const schema = testSchemaName('purchase_method_migration_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.end();
      const own = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
      try {
        await migrateToLatest(own, {
          migrations: Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '0053')),
          migrationTableSchema: schema,
        });
        const migration = migrations['0053_depreciation_purchase_method'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
        const run = (step: 'up' | 'down') => {
          let outcome: unknown = 'accepted';
          return withMigrationLock(async () => {
            outcome = await migration[step](createDatabase(own) as never).then(
              () => 'accepted',
              (e: unknown) => e,
            );
          }).then(() => outcome);
        };
        const exists = async () =>
          Number(
            (
              await own.query(
                `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'depreciation_asset_purchase_method'`,
                [schema],
              )
            ).rows[0].n,
          );
        const columns = async () =>
          Number(
            (
              await own.query(
                `SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'depreciation_schedule_version_component' AND column_name LIKE 'method%'`,
                [schema],
              )
            ).rows[0].n,
          );
        // A recorded version (the header alone, its guards disabled for the fixture only).
        await own.query(`ALTER TABLE depreciation_schedule_version DISABLE TRIGGER USER`);
        await own.query(`ALTER TABLE depreciation_schedule_version DROP CONSTRAINT depreciation_schedule_version_asset_fk`);
        await own.query(
          `INSERT INTO depreciation_schedule_version (mre_realm_id, asset_id, property_reference_id, version_number, status, from_year, through_year, computed_on,
           calculation_version, currency, asset_type, depreciation_method, asset_review_state, asset_version, input_fingerprint, output_fingerprint, reason, recorded_by)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), 1, 'CURRENT', 2026, 2026, '2028-01-20', 1, 'EUR', 'BUILDING', 'LINEAR_7_4', 'CONFIRMED', 1, repeat('a', 64), repeat('b', 64), 'x', 'x')`,
          [REALM],
        );
        expect(await run('up')).toMatchObject({ code: '23514' });
        expect([await exists(), await columns()]).toEqual([0, 0]);
        await own.query(`DELETE FROM depreciation_schedule_version`);
        expect(await run('up')).toBe('accepted');
        expect([await exists(), await columns()]).toEqual([1, 7]);
        // An entry present: down refused, nothing dropped.
        const pr = (
          await own.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          )
        ).rows[0].id as string;
        const acq = (
          await own.query(
            `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, created_by)
           VALUES ($1, $2, 'DRAFT', 1000, 'EUR', 1, 1, '2026-01-01', 'x') RETURNING id`,
            [REALM, pr],
          )
        ).rows[0].id as string;
        const assetId = (
          await own.query(
            `INSERT INTO depreciation_asset (mre_realm_id, property_reference_id, asset_type, status, depreciation_method, review_state, created_by) VALUES ($1, $2, 'BUILDING', 'ACTIVE', 'LINEAR_7_4', 'UNREVIEWED', 'x') RETURNING id`,
            [REALM, pr],
          )
        ).rows[0].id as string;
        await own.query(
          `INSERT INTO depreciation_asset_purchase_method (asset_id, mre_realm_id, property_reference_id, acquisition_id, consideration, method, special_depreciation,
           subsidies_received, new_building_by_conversion, other_special_case, evidence_source, evidence_date, review_state)
         VALUES ($1, $2, $3, $4, 'PAID', 'LINEAR_7_4', '{}', false, false, false, 'Kaufvertrag', '2026-06-15', 'UNREVIEWED')`,
          [assetId, REALM, pr, acq],
        );
        expect(await run('down')).toMatchObject({ code: '23514' });
        expect([await exists(), await columns()]).toEqual([1, 7]);
        await own.query(`DELETE FROM depreciation_asset_purchase_method`);
        expect(await run('down')).toBe('accepted');
        expect([await exists(), await columns()]).toEqual([0, 0]);
      } finally {
        await own.end();
      }
    },
  );
});
