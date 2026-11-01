import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ItemComponent, ItemRef, ScheduleRead } from '../../domains/depreciation/index.js';
import { createDatabase } from './database.js';
import type { PostgresDepreciationAssetRepository } from './depreciation-asset-repository.js';
import { codeOf, databaseUrl, waitUntil, withMigrationLock, type Queryable } from './depreciation-asset.test-support.js';
import { PostgresDepreciationScheduleSource } from './depreciation-schedule-source.js';
import { AT, NOW, OTHER_REALM, REALM, actor, useSeparateAssetDatabase } from './depreciation-separate-asset.test-support.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-8-03 persistence (api-design.md §59B, migration 0051): a separate asset's commands in their order of checks with
 * their AuditRecords, its links as rows written as a difference, the guard and the CHECKs of 0051 past the repository
 * (each with a counter-check), the concurrency of two links and of a link against a reclassification, the schedule read
 * with the capitalised items in its one snapshot (and the query plan), "no cash mutated", and `up`/`down`. Figures,
 * names and texts are synthetic.
 * The setup is in `depreciation-separate-asset.test-support.ts`.
 */
let counter = 0;

describe.skipIf(databaseUrl === undefined)('a separate asset and its items (§59B, migration 0051)', () => {
  const {
    ctx,
    propertyReference,
    purchase,
    splitOf,
    classify,
    capitalizedSplit,
    wegSources,
    split,
    withdrawal,
    use,
    kitchen,
    building,
    created,
    audits,
    links,
    schedule,
    itemIds,
    blockedBy,
    snapshot,
  } = useSeparateAssetDatabase('depreciation_items_test');
  let pool: pg.Pool;
  let classifications: PostgresTaxClassificationRepository;
  let assets: PostgresDepreciationAssetRepository;
  let source: PostgresDepreciationScheduleSource;
  beforeAll(() => {
    ({ pool, classifications, assets, source } = ctx);
  });

  // ——— Commands ———

  describe('create (§59B "Changes to §59\'s commands")', () => {
    it('creates the separate asset with its links; AuditRecord CREATED with its fields and items; several per PropertyReference', async () => {
      const pr = await propertyReference();
      await created(building(pr));
      const s1 = await capitalizedSplit(pr);
      const s2 = await capitalizedSplit(pr, '300.00');
      const outcome = await assets.create(kitchen(pr, [split(s1)]), actor);
      if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
      expect(outcome.asset).toMatchObject({
        assetType: 'SEPARATE_ASSET',
        depreciationMethod: 'LINEAR_7_1',
        buildingCompletionYear: null,
        description: 'Einbauküche, Wohnung 3 (synthetisch)',
        usefulLifeYears: 10,
        acquiredOn: '2027-04-20',
        items: [split(s1)],
        status: 'ACTIVE',
        version: 1,
      });
      expect((await links(outcome.asset.id)).map((l) => [l.source_type, l.source_id, l.asset_status])).toEqual([['TRANSACTION_SPLIT', s1, 'ACTIVE']]);
      const [record] = await audits(outcome.asset.id);
      expect(record?.action).toBe('CREATED');
      expect(record?.metadata).toMatchObject({ assetType: 'SEPARATE_ASSET', usefulLifeYears: 10, acquiredOn: '2027-04-20', items: [split(s1)] });
      // A second separate asset on the same PropertyReference (no unique index on the type).
      expect((await assets.create(kitchen(pr, [split(s2)]), actor)).kind).toBe('CREATED');
      expect((await assets.listForPropertyReference(pr, REALM, null))?.map((r) => r.asset.assetType)).toEqual(['BUILDING', 'SEPARATE_ASSET', 'SEPARATE_ASSET']);
    });

    it('the order of checks, each over all items: 404, 422 ITEM_NOT_OF_PROPERTY, ITEM_NOT_CAPITALIZED, ITEM_ANSCHAFFUNGSNAHE, ITEM_IN_OTHER_ASSET', async () => {
      const pr = await propertyReference();
      const other = await propertyReference();
      const { acquisitionId } = await purchase(pr);
      const { statementId, assessmentId } = await wegSources(pr);
      const unknown = '0000eeee-0000-4000-8000-00000000dead';
      const foreign = await splitOf(other, '100.00');
      const otherRealm = await splitOf(await propertyReference(OTHER_REALM), '100.00', '2027-04-28', OTHER_REALM);
      const deductible = await splitOf(pr, '100.00');
      await classify(deductible, { treatment: 'DEDUCTIBLE' });
      const defaulted = await splitOf(pr, '100.00');
      const anschaffungsnah = await splitOf(pr, '5000.00', '2027-02-02');
      await classify(anschaffungsnah, { anschaffungsnaheAcquisitionId: acquisitionId });
      const taken = await capitalizedSplit(pr);
      const holder = await created(kitchen(pr, [split(taken)]));
      const ok = await capitalizedSplit(pr);
      const refuse = async (items: ItemRef[]) => assets.create(kitchen(pr, items), actor);

      expect(await refuse([split(foreign), split(unknown)])).toEqual({ kind: 'ITEM_NOT_FOUND', item: split(unknown) });
      expect(await refuse([split(otherRealm)])).toEqual({ kind: 'ITEM_NOT_FOUND', item: split(otherRealm) });
      // A position naming a contribution, a use that does not exist: not found.
      expect(await refuse([withdrawal(statementId, 3)])).toEqual({ kind: 'ITEM_NOT_FOUND', item: withdrawal(statementId, 3) });
      expect(await refuse([use(assessmentId, 2)])).toEqual({ kind: 'ITEM_NOT_FOUND', item: use(assessmentId, 2) });
      expect(await refuse([split(deductible), split(foreign)])).toEqual({ kind: 'ITEM_NOT_OF_PROPERTY', item: split(foreign), propertyReferenceId: other });
      expect(await refuse([split(anschaffungsnah), split(deductible)])).toEqual({
        kind: 'ITEM_NOT_CAPITALIZED',
        item: split(deductible),
        counts: true,
        treatment: 'DEDUCTIBLE',
        reviewState: 'USER_CONFIRMED',
      });
      // A default is never CAPITALIZED: an unclassified split cannot be linked; neither can the WEG sources (DEDUCTIBLE default).
      expect(await refuse([split(defaulted)])).toMatchObject({ kind: 'ITEM_NOT_CAPITALIZED', item: split(defaulted) });
      expect(await refuse([use(assessmentId)])).toMatchObject({ kind: 'ITEM_NOT_CAPITALIZED', item: use(assessmentId) });
      expect(await refuse([split(taken), split(anschaffungsnah)])).toEqual({ kind: 'ITEM_ANSCHAFFUNGSNAHE', item: split(anschaffungsnah), acquisitionId });
      expect(await refuse([split(ok), split(taken)])).toEqual({ kind: 'ITEM_IN_OTHER_ASSET', item: split(taken), assetId: holder });
      // Nothing was written by a refusal.
      expect((await assets.listForPropertyReference(pr, REALM, null))?.length).toBe(1);
      // A capitalised WEG use is linkable.
      await classify(assessmentId, { sourceType: 'WEG_ASSESSMENT_USE', sourcePosition: 1, taxCategory: 'WEG_SPENDING' });
      expect((await refuse([use(assessmentId), split(ok)])).kind).toBe('CREATED');
    });

    it('Idempotency-Key: the replay answers the first asset; another payload under the same key is IDEMPOTENCY_CONFLICT', async () => {
      const pr = await propertyReference();
      const item = await capitalizedSplit(pr);
      const key = { key: `k-${++counter}`, fingerprint: 'f1' };
      const first = await assets.create(kitchen(pr, [split(item)]), actor, key);
      const replay = await assets.create(kitchen(pr, [split(item)]), actor, key);
      expect(replay.kind).toBe('REPLAYED');
      expect(replay.kind === 'REPLAYED' && first.kind === 'CREATED' && replay.asset.id === first.asset.id).toBe(true);
      expect((await assets.create(kitchen(pr, [split(item)]), actor, { ...key, fingerprint: 'f2' })).kind).toBe('IDEMPOTENCY_CONFLICT');
    });
  });

  describe('amend, confirm, void', () => {
    it('amend: the links as a difference (an unchanged link keeps its xmin), changedItems, the reset; only new items are checked', async () => {
      const pr = await propertyReference();
      const [s1, s2] = [await capitalizedSplit(pr), await capitalizedSplit(pr, '200.00')];
      const id = await created(kitchen(pr, [split(s1)], { reviewState: 'NEEDS_REVIEW' }));
      expect((await assets.confirm(id, REALM, { reviewState: 'CONFIRMED', advisorPartyId: null, note: null }, actor)).kind).toBe('CONFIRMED');
      const [before] = await links(id);
      // The linked item is reclassified since: the unchanged link does not block the amend.
      const current = (await pool.query(`SELECT id FROM tax_classification WHERE transaction_split_id = $1 AND superseded_at IS NULL`, [s1])).rows[0]
        .id as string;
      await classify(s1, { treatment: 'DEDUCTIBLE', supersedes: current });
      const amended = await assets.amend(id, REALM, { items: [split(s1), split(s2)] }, actor);
      expect(amended).toMatchObject({ kind: 'AMENDED', changed: true, asset: { reviewState: 'UNREVIEWED', version: 3 } });
      const after = await links(id);
      expect(after.find((l) => l.source_id === s1)?.xmin).toBe(before?.xmin);
      const record = (await audits(id)).at(-1);
      expect(record?.action).toBe('AMENDED');
      expect(record?.metadata).toMatchObject({
        changedItems: [{ item: split(s2), change: 'ADDED' }],
        reviewStateReset: { from: 'CONFIRMED', to: 'UNREVIEWED' },
      });
      // A new item that is not capitalised is refused; removing one is a difference too.
      const fresh = await splitOf(pr, '50.00');
      expect(await assets.amend(id, REALM, { items: [split(s1), split(s2), split(fresh)] }, actor)).toMatchObject({
        kind: 'ITEM_NOT_CAPITALIZED',
        item: split(fresh),
      });
      expect(await assets.amend(id, REALM, { items: [split(s2)] }, actor)).toMatchObject({ kind: 'AMENDED', changed: true });
      expect((await links(id)).map((l) => l.source_id)).toEqual([s2]);
      // The fields of the other type; a no-op without a record.
      expect(await assets.amend(id, REALM, { buildingCompletionYear: 1995 }, actor)).toEqual({
        kind: 'FIELDS_NOT_ALLOWED',
        fields: ['buildingCompletionYear'],
      });
      const count = (await audits(id)).length;
      expect(await assets.amend(id, REALM, { items: [split(s2)], usefulLifeYears: 10 }, actor)).toMatchObject({ kind: 'AMENDED', changed: false });
      expect((await audits(id)).length).toBe(count);
      const b = await created(building(pr));
      expect(await assets.amend(b, REALM, { usefulLifeYears: 10, items: [] }, actor)).toEqual({
        kind: 'FIELDS_NOT_ALLOWED',
        fields: ['usefulLifeYears', 'items'],
      });
    });

    it('void: the links follow to VOID (the cascade), VOIDED lists the items; the item is back in the building and can be linked again', async () => {
      const pr = await propertyReference();
      await purchase(pr);
      const b = await created(building(pr));
      const item = await capitalizedSplit(pr);
      const id = await created(kitchen(pr, [split(item)]));
      expect(itemIds(await schedule(b))).toEqual([]);
      expect((await schedule(b)).excludedItems).toEqual([{ componentId: `TRANSACTION_SPLIT:${item}`, separateAssetId: id }]);
      expect((await assets.void(id, REALM, 'falsch erfasst', AT, actor)).kind).toBe('VOIDED');
      expect((await links(id)).map((l) => l.asset_status)).toEqual(['VOID']);
      expect((await audits(id)).at(-1)).toMatchObject({ action: 'VOIDED', metadata: { reason: 'falsch erfasst', items: [split(item)] } });
      expect(itemIds(await schedule(b))).toEqual([`TRANSACTION_SPLIT:${item}`]);
      expect((await assets.create(kitchen(pr, [split(item)]), actor)).kind).toBe('CREATED');
    });
  });

  // ——— The schema past the repository (0051), each with a counter-check ———

  describe('the schema past the repository (0051)', () => {
    async function rawLink(assetId: string, pr: string, item: ItemRef, client: Queryable = pool, status = 'ACTIVE', realm = REALM) {
      return client.query(
        `INSERT INTO depreciation_asset_item (asset_id, mre_realm_id, property_reference_id, asset_status, source_type, source_id, source_position, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'x')`,
        [assetId, realm, pr, status, item.sourceType, item.sourceId, item.sourcePosition],
      );
    }

    it('an item in two ACTIVE assets is refused (23505); allowed again after a void; counter-check: one active link is accepted', async () => {
      const pr = await propertyReference();
      const item = await capitalizedSplit(pr);
      const first = await created(kitchen(pr, []));
      const second = await created(kitchen(pr, []));
      expect(await codeOf(rawLink(first, pr, split(item)))).toBe('accepted');
      const refused = await rawLink(second, pr, split(item)).catch((e: { code: string; constraint: string }) => e);
      expect(refused).toMatchObject({ code: '23505', constraint: 'depreciation_asset_item_active' });
      await assets.void(first, REALM, 'ersetzt', AT, actor);
      expect(await codeOf(rawLink(second, pr, split(item)))).toBe('accepted');
    });

    it('a link to another PropertyReference’s split, withdrawal or use, to another Realm’s source, to a position naming none is refused', async () => {
      const pr = await propertyReference();
      const other = await propertyReference();
      const asset = await created(kitchen(pr, []));
      const own = await wegSources(pr);
      const foreign = await wegSources(other);
      const foreignSplit = await splitOf(other, '10.00');
      const otherRealmSplit = await splitOf(await propertyReference(OTHER_REALM), '10.00', '2027-04-28', OTHER_REALM);
      for (const item of [
        split(foreignSplit),
        withdrawal(foreign.statementId),
        use(foreign.assessmentId),
        split(otherRealmSplit),
        withdrawal(own.statementId, 3),
        use(own.assessmentId, 2),
      ]) {
        expect(await codeOf(rawLink(asset, pr, item)), JSON.stringify(item)).toBe('23000');
      }
      // Counter-check: the own split, withdrawal and use are accepted by the guard (Taxation's meaning is the repository's check).
      for (const item of [split(await splitOf(pr, '10.00')), withdrawal(own.statementId), use(own.assessmentId)])
        expect(await codeOf(rawLink(asset, pr, item))).toBe('accepted');
    });

    it('a link inserted or deleted on a VOID asset or a building, updated other than by the cascade, or a 51st, is refused', async () => {
      const pr = await propertyReference();
      const b = await created(building(pr));
      const voided = await created(kitchen(pr, []));
      await assets.void(voided, REALM, 'x', AT, actor);
      const live = await created(kitchen(pr, []));
      const item = await splitOf(pr, '1.00');
      expect(await codeOf(rawLink(b, pr, split(item)))).toBe('23000');
      expect(await codeOf(rawLink(voided, pr, split(item), pool, 'VOID'))).toBe('23000');
      await rawLink(live, pr, split(item));
      expect(await codeOf(pool.query(`UPDATE depreciation_asset_item SET source_id = gen_random_uuid() WHERE asset_id = $1`, [live]))).toBe('23000');
      expect(await codeOf(pool.query(`UPDATE depreciation_asset_item SET asset_status = 'VOID' WHERE asset_id = $1`, [live]))).toBe('23503');
      const withLink = await created(kitchen(pr, []));
      const linked = await splitOf(pr, '2.00');
      await rawLink(withLink, pr, split(linked));
      await assets.void(withLink, REALM, 'x', AT, actor);
      expect(await codeOf(pool.query(`DELETE FROM depreciation_asset_item WHERE asset_id = $1`, [withLink]))).toBe('23000');
      // Counter-check: a delete on the ACTIVE asset passes.
      expect(await codeOf(pool.query(`DELETE FROM depreciation_asset_item WHERE asset_id = $1`, [live]))).toBe('accepted');
      const many = await created(kitchen(pr, []));
      for (let i = 0; i < 50; i++) await rawLink(many, pr, split(await splitOf(pr, '1.00')));
      expect(await codeOf(rawLink(many, pr, split(await splitOf(pr, '1.00'))))).toBe('23000');
    }, 60_000);

    it('the CHECKs: a separate asset without useful_life_years or acquired_on, a building with a description, a LINEAR_7_4 separate asset, an entry on it', async () => {
      const pr = await propertyReference();
      const insert = (columns: Record<string, unknown>) => {
        const row = {
          mre_realm_id: REALM,
          property_reference_id: pr,
          asset_type: 'SEPARATE_ASSET',
          status: 'ACTIVE',
          depreciation_method: 'LINEAR_7_1',
          review_state: 'UNREVIEWED',
          description: 'Küche',
          useful_life_years: 10,
          useful_life_basis: 'B8',
          acquired_on: '2027-04-20',
          created_by: 'x',
          ...columns,
        };
        const keys = Object.keys(row);
        return pool.query(
          `INSERT INTO depreciation_asset (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          Object.values(row),
        );
      };
      expect(await codeOf(insert({}))).toBe('accepted');
      for (const broken of [
        { useful_life_years: null },
        { acquired_on: null },
        { depreciation_method: 'LINEAR_7_4' },
        { building_completion_year: 1995 },
        { asset_type: 'BUILDING', depreciation_method: 'LINEAR_7_4', building_completion_year: 1995 },
        { useful_life_years: 100 },
        { description: 'x'.repeat(201) },
      ]) {
        expect(await codeOf(insert(broken)), JSON.stringify(broken)).toBe('23514');
      }
      const separate = (await insert({})).rows[0].id as string;
      const { acquisitionId } = await purchase(pr);
      const entry = pool.query(
        `INSERT INTO depreciation_asset_useful_life (asset_id, mre_realm_id, property_reference_id, acquisition_id, useful_life_years, evidence_source, evidence_date, review_state)
         VALUES ($1, $2, $3, $4, 30, 'Gutachten', '2026-06-15', 'UNREVIEWED')`,
        [separate, REALM, pr, acquisitionId],
      );
      expect(await codeOf(entry)).toBe('23000');
      // A void keeps the separate asset's fields: a void that changes the useful life is refused.
      expect(
        await codeOf(
          pool.query(`UPDATE depreciation_asset SET status = 'VOID', voided_at = now(), void_reason = 'x', useful_life_years = 9, version = 2 WHERE id = $1`, [
            separate,
          ]),
        ),
      ).toBe('23000');
    });

    it(
      'up and down under MIGRATION_ADVISORY_LOCK: down refused with a SEPARATE_ASSET row, then drops the links and restores 0049',
      { timeout: 30_000 },
      async () => {
        const downSchema = testSchemaName('depreciation_items_down_test');
        const admin = new pg.Client({ connectionString: databaseUrl });
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${downSchema}"`);
        await admin.end();
        const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
        try {
          await migrateToLatest(downPool, { migrationTableSchema: downSchema });
          const migration = migrations['0051_depreciation_separate_asset'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
          const columns = async () =>
            (
              await downPool.query(
                `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'depreciation_asset' ORDER BY ordinal_position`,
                [downSchema],
              )
            ).rows.map((r) => r.column_name as string);
          const table = async () =>
            (
              await downPool.query(
                `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'depreciation_asset_item'`,
                [downSchema],
              )
            ).rows[0].n as number;
          const { rows } = await downPool.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5ff0001', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          );
          await downPool.query(
            `INSERT INTO depreciation_asset (mre_realm_id, property_reference_id, asset_type, status, depreciation_method, review_state, description, useful_life_years, useful_life_basis, acquired_on, created_by)
           VALUES ($1, $2, 'SEPARATE_ASSET', 'ACTIVE', 'LINEAR_7_1', 'UNREVIEWED', 'Küche', 10, 'B8', '2027-04-20', 'x')`,
            [REALM, rows[0].id],
          );
          let refused: unknown;
          await withMigrationLock(async () => {
            refused = await migration.down(createDatabase(downPool) as never).catch((e: unknown) => e);
          });
          expect(refused).toMatchObject({ code: '23514' });
          // Nothing was dropped by the refused down.
          expect([await table(), (await columns()).includes('acquired_on')]).toEqual([1, true]);
          await downPool.query(`DELETE FROM depreciation_asset WHERE asset_type = 'SEPARATE_ASSET'`).catch(() => undefined);
          // A separate asset is never deleted (0049's guard): disable it for the fixture only, then down proceeds.
          await downPool.query(`ALTER TABLE depreciation_asset DISABLE TRIGGER depreciation_asset_frozen`);
          await downPool.query(`DELETE FROM depreciation_asset WHERE asset_type = 'SEPARATE_ASSET'`);
          await downPool.query(`ALTER TABLE depreciation_asset ENABLE TRIGGER depreciation_asset_frozen`);
          await withMigrationLock(() => migration.down(createDatabase(downPool) as never));
          expect(await table()).toBe(0);
          expect(await columns()).not.toContain('acquired_on');
          expect(
            await codeOf(
              downPool.query(
                `INSERT INTO depreciation_asset (mre_realm_id, property_reference_id, asset_type, status, depreciation_method, review_state, created_by) VALUES ($1, $2, 'SEPARATE_ASSET', 'ACTIVE', 'LINEAR_7_4', 'UNREVIEWED', 'x')`,
                [REALM, rows[0].id],
              ),
            ),
          ).toBe('23514');
          await withMigrationLock(() => migration.up(createDatabase(downPool) as never));
          expect(await table()).toBe(1);
        } finally {
          await downPool.end();
        }
      },
    );
  });

  // ——— The schedule read ———

  describe('the schedule read (§59B "Concurrency and locks", "Performance")', () => {
    it('the building’s items from Taxation’s derivation: a split and a WEG use, another PropertyReference’s capitalised split never', async () => {
      const pr = await propertyReference();
      const { acquisitionId } = await purchase(pr);
      const b = await created(building(pr, [acquisitionId]));
      const item = await capitalizedSplit(pr, '12000.00', '2027-04-28');
      const { assessmentId } = await wegSources(pr);
      await classify(assessmentId, { sourceType: 'WEG_ASSESSMENT_USE', sourcePosition: 1, taxCategory: 'WEG_SPENDING' });
      await capitalizedSplit(await propertyReference(), '777.00');
      const s = await schedule(b);
      expect(itemIds(s)).toEqual([`TRANSACTION_SPLIT:${item}`, `WEG_ASSESSMENT_USE:${assessmentId}:1`]);
      const amounts = s.components.filter((c): c is ItemComponent => c.kind === 'CAPITALIZED_ITEM').map((c) => c.years.map((y) => y.amount?.amount));
      // 2 % of 12,000.00 and of the use's 9,000.00 (its own date 2027-09-02, START_OF_YEAR).
      expect(amounts).toEqual([
        ['240.00', '240.00'],
        ['180.00', '180.00'],
      ]);
    });

    it('a NEEDS_REVIEW capitalised item is listed, not computed; a link against a reclassification: the read flags it, nothing deadlocks', async () => {
      const pr = await propertyReference();
      await purchase(pr);
      const b = await created(building(pr));
      const pending = await splitOf(pr, '500.00');
      await classify(pending, { reviewState: 'NEEDS_REVIEW' });
      expect((await schedule(b)).components.find((c) => c.componentId === `TRANSACTION_SPLIT:${pending}`)?.reasons.map((r) => r.code)).toEqual([
        'ITEM_CLASSIFICATION_NEEDS_REVIEW',
      ]);
      const item = await capitalizedSplit(pr);
      const current = (await pool.query(`SELECT id FROM tax_classification WHERE transaction_split_id = $1 AND superseded_at IS NULL`, [item])).rows[0]
        .id as string;
      const [linked] = await Promise.all([
        assets.create(kitchen(pr, [split(item)]), actor),
        classifications.createClassification(
          {
            mreRealmId: REALM,
            sourceType: 'TRANSACTION_SPLIT',
            sourceId: item,
            taxCategory: 'MAINTENANCE',
            treatment: 'DEDUCTIBLE',
            reviewState: 'USER_CONFIRMED',
            supersedes: current,
            notes: null,
            sourceReferences: [],
          },
          actor,
        ),
      ]);
      if (linked.kind === 'CREATED') {
        const s = await schedule(linked.asset.id);
        expect(s.components[0]?.reasons.map((r) => r.code)).toEqual(['LINKED_ITEM_NOT_CAPITALIZED']);
        expect(itemIds(await schedule(b))).not.toContain(`TRANSACTION_SPLIT:${item}`);
      } else {
        expect(linked.kind).toBe('ITEM_NOT_CAPITALIZED');
      }
    });

    it('one snapshot: a classification committed between two statements of the read is not seen', async () => {
      const pr = await propertyReference();
      await purchase(pr);
      const b = await created(building(pr));
      const late = await splitOf(pr, '1000.00');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        // The links are read after the snapshot is taken and before the capitalised items.
        await holder.query('LOCK TABLE depreciation_asset_item IN ACCESS EXCLUSIVE MODE');
        const reading = source.read(b, REALM, null);
        await waitUntil(async () => (await (await blockedBy(holder))()).length > 0);
        await classify(late);
        await holder.query('COMMIT');
        const read = (await reading) as ScheduleRead;
        expect(read.capitalizedItems.map((i) => i.sourceId)).not.toContain(late);
        expect((await source.read(b, REALM, null))?.capitalizedItems.map((i) => i.sourceId)).toContain(late);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it('the plan of the capitalised split query: transaction_split_property_reference_idx and the current classification per source', async () => {
      const pr = await propertyReference();
      await purchase(pr);
      const b = await created(building(pr));
      await capitalizedSplit(pr);
      const sent: CompiledQuery[] = [];
      const logged = new Kysely<Database>({
        dialect: new PostgresDialect({ pool }),
        log: (event) => {
          if (event.level === 'query') sent.push(event.query);
        },
      });
      await new PostgresDepreciationScheduleSource(logged, new PostgresTaxClassificationRepository(logged).capitalizedSources, NOW).read(b, REALM, null);
      const query = sent.find((q) => q.sql.includes('"treatment" = $') && q.sql.includes('"s"."property_reference_id" = $'));
      if (query === undefined) throw new Error('no capitalised split query');
      const client = await pool.connect();
      try {
        await client.query('SET enable_seqscan = off');
        const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${query.sql}`, [...query.parameters]);
        const plan = JSON.stringify(rows[0]['QUERY PLAN']);
        expect(plan).toContain('transaction_split_property_reference_idx');
        expect(plan).toContain('tax_classification_current');
      } finally {
        client.release();
      }
    });
  });

  // ——— Concurrency (§59B "Concurrency and locks") ———

  describe('concurrency', () => {
    it('two assets linking one item, RC: the second waits on the PropertyReference row, then sees the first’s link (ITEM_IN_OTHER_ASSET)', async () => {
      const pr = await propertyReference();
      const item = await capitalizedSplit(pr);
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        const first = (
          await holder.query(
            `INSERT INTO depreciation_asset (mre_realm_id, property_reference_id, asset_type, status, depreciation_method, review_state, description, useful_life_years, useful_life_basis, acquired_on, created_by)
             VALUES ($1, $2, 'SEPARATE_ASSET', 'ACTIVE', 'LINEAR_7_1', 'UNREVIEWED', 'Küche', 10, 'B8', '2027-04-20', 'x') RETURNING id`,
            [REALM, pr],
          )
        ).rows[0].id as string;
        await holder.query(
          `INSERT INTO depreciation_asset_item (asset_id, mre_realm_id, property_reference_id, asset_status, source_type, source_id, created_by) VALUES ($1, $2, $3, 'ACTIVE', 'TRANSACTION_SPLIT', $4, 'x')`,
          [first, REALM, pr, item],
        );
        const blocked = await blockedBy(holder);
        const second = assets.create(kitchen(pr, [split(item)]), actor);
        await waitUntil(async () => (await blocked()).some((q) => q.startsWith('update "property_reference"')));
        await holder.query('COMMIT');
        expect(await second).toEqual({ kind: 'ITEM_IN_OTHER_ASSET', item: split(item), assetId: first });
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it('RR: a link written after another’s committed link of the PropertyReference fails to serialise (40001)', async () => {
      const pr = await propertyReference();
      const [a, b] = [await created(kitchen(pr, [])), await created(kitchen(pr, []))];
      const [i1, i2] = [await splitOf(pr, '1.00'), await splitOf(pr, '2.00')];
      const late = await pool.connect();
      try {
        await late.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await late.query('SELECT 1 FROM depreciation_asset_item LIMIT 1');
        await pool.query(
          `INSERT INTO depreciation_asset_item (asset_id, mre_realm_id, property_reference_id, asset_status, source_type, source_id, created_by) VALUES ($1, $2, $3, 'ACTIVE', 'TRANSACTION_SPLIT', $4, 'x')`,
          [a, REALM, pr, i1],
        );
        const write = late.query(
          `INSERT INTO depreciation_asset_item (asset_id, mre_realm_id, property_reference_id, asset_status, source_type, source_id, created_by) VALUES ($1, $2, $3, 'ACTIVE', 'TRANSACTION_SPLIT', $4, 'x')`,
          [b, REALM, pr, i2],
        );
        expect(await codeOf(write)).toBe('40001');
      } finally {
        await late.query('ROLLBACK').catch(() => undefined);
        late.release();
      }
    });
  });

  it(
    'no cash mutated: every command of a separate asset and every schedule read leave the cash, the classifications and the Ownerships as they are',
    { timeout: 30_000 },
    async () => {
      const pr = await propertyReference();
      await purchase(pr);
      const b = await created(building(pr));
      const [s1, s2] = [await capitalizedSplit(pr), await capitalizedSplit(pr, '100.00')];
      const before = await snapshot();
      const id = await created(kitchen(pr, [split(s1)]));
      await assets.amend(id, REALM, { items: [split(s1), split(s2)], description: 'Küche' }, actor);
      await assets.confirm(id, REALM, { reviewState: 'CONFIRMED', advisorPartyId: null, note: null }, actor);
      await schedule(id);
      await schedule(b);
      await assets.find(id, REALM);
      await assets.void(id, REALM, 'x', AT, actor);
      const after = await snapshot();
      // The PropertyReference's no-op writes leave its row and version as they are.
      expect(after).toEqual(before);
    },
  );
});
