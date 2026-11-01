import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { classificationFingerprint } from '../../domains/acquisition/index.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { testSchemaName } from './test-schema.test-support.js';
import { MIGRATION_ADVISORY_LOCK } from './migrate.js';
import { OTHER_REALM, REALM, actor, databaseUrl, entered, eur, useClassificationDatabase } from './acquisition-cost-classification.test-support.js';

/**
 * VC-X-42 persistence (api-design.md §59D "API", "Concurrency and the database", migration 0054) through the repository:
 * the order of checks and each answer, supersede, idempotency, the cost's `classification`, the reads; concurrency on
 * the Acquisition row (two classifications of one cost; against a cancel and a void, both orders); 0054 `up` and
 * `down`. The schema's own rules past the repository are in `acquisition-cost-classification-schema.test.ts`.
 * Synthetic data.
 */
describe.skipIf(databaseUrl === undefined)('PostgresAcquisitionCostClassificationRepository (§59D)', () => {
  const ctx = useClassificationDatabase('cost_classification_test');

  describe('through the repository', () => {
    it('the first classification: parts by position, current, the cost answers it as its classification; AuditRecord CREATED', async () => {
      const a = await ctx.acquisition();
      const cost = await ctx.cost(a, 'NOTARY', '2500.00');
      const advisor = await ctx.party('Steuerberaterin');
      const outcome = await ctx.classifications.create(
        entered(
          a,
          cost,
          null,
          {
            parts: [
              { purpose: 'OWNERSHIP_TRANSFER', amount: eur('1800.00') },
              { purpose: 'FINANCING', amount: eur('700.00') },
            ],
            reviewState: 'ADVISOR_CONFIRMED',
            advisorPartyId: advisor,
            notes: 'Kaufvertrag und Grundschuld auf einer Rechnung',
          },
          '2500.00',
        ),
        actor,
      );
      if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
      const c = outcome.classification;
      expect(c).toMatchObject({ acquisitionId: a, costId: cost, reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor, supersedesId: null, current: true });
      expect(c.parts.map((p) => [p.purpose, p.amount.amount])).toEqual([
        ['OWNERSHIP_TRANSFER', '1800.00'],
        ['FINANCING', '700.00'],
      ]);
      const listed = await ctx.costs.listCosts(a, REALM, {});
      expect(listed?.[0]?.classification).toEqual(c);
      const audit = await ctx.pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1`, [c.id]);
      expect(audit.rows).toEqual([
        {
          action: 'CREATED',
          metadata: {
            acquisitionId: a,
            costId: cost,
            parts: [
              { purpose: 'OWNERSHIP_TRANSFER', amount: { amount: '1800.00', currency: 'EUR' } },
              { purpose: 'FINANCING', amount: { amount: '700.00', currency: 'EUR' } },
            ],
            reviewState: 'ADVISOR_CONFIRMED',
            supersedes: null,
          },
        },
      ]);
    });

    it('a correction or a confirmation supersedes the current one, which keeps its data; the history newest first; AuditRecord SUPERSEDED', async () => {
      const a = await ctx.acquisition();
      const cost = await ctx.cost(a, 'OTHER', '2000.00');
      const first = await ctx.classifications.create(entered(a, cost, null, { reviewState: 'UNREVIEWED' }), actor);
      if (first.kind !== 'CREATED') throw new Error(first.kind);
      const second = await ctx.classifications.create(entered(a, cost, first.classification.id), actor);
      if (second.kind !== 'CREATED') throw new Error(second.kind);
      const listed = await ctx.classifications.list(a, cost, REALM);
      if (listed.kind !== 'FOUND') throw new Error(listed.kind);
      expect(listed.current?.id).toBe(second.classification.id);
      expect(listed.items.map((x) => [x.id, x.current, x.supersededById, x.reviewState])).toEqual([
        [second.classification.id, true, null, 'CONFIRMED'],
        [first.classification.id, false, second.classification.id, 'UNREVIEWED'],
      ]);
      expect(
        (await ctx.pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at`, [first.classification.id])).rows.at(-1),
      ).toEqual({
        action: 'SUPERSEDED',
        metadata: { supersededById: second.classification.id },
      });
      expect((await ctx.costs.listCosts(a, REALM, {}))?.[0]?.classification?.id).toBe(second.classification.id);
    });

    it('the order of checks: Acquisition, cost, advisor 404; CANCELLED, VOID; supersedes; the parts sum; the purpose of a FINANCING_RELATED cost', async () => {
      const a = await ctx.acquisition();
      const cost = await ctx.cost(a, 'NOTARY', '2000.00');
      const foreign = await ctx.acquisition(OTHER_REALM);
      const foreignAdvisor = await ctx.party('Fremd', OTHER_REALM);
      expect(await ctx.classifications.create({ ...entered(foreign, cost, null), mreRealmId: REALM }, actor)).toEqual({ kind: 'ACQUISITION_NOT_FOUND' });
      expect(await ctx.classifications.create(entered('not-a-uuid', cost, null), actor)).toEqual({ kind: 'ACQUISITION_NOT_FOUND' });
      // A cost of another Acquisition is unknown here.
      const other = await ctx.acquisition();
      const otherCost = await ctx.cost(other, 'NOTARY', '2000.00');
      expect(await ctx.classifications.create(entered(a, otherCost, null), actor)).toEqual({ kind: 'COST_NOT_FOUND' });
      expect(await ctx.classifications.create(entered(a, 'nope', null), actor)).toEqual({ kind: 'COST_NOT_FOUND' });
      const advisorFirst = entered(a, cost, 'x', { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: foreignAdvisor, parts: [] });
      expect(await ctx.classifications.create(advisorFirst, actor)).toEqual({ kind: 'PARTY_NOT_FOUND', partyId: foreignAdvisor });
      // Supersedes before the sum, the sum before the purpose.
      expect(await ctx.classifications.create(entered(a, cost, '00000000-0000-4000-8000-000000000001', {}, '1.00'), actor)).toEqual({
        kind: 'CURRENT_CLASSIFICATION_CHANGED',
        currentClassificationId: null,
      });
      expect(await ctx.classifications.create(entered(a, cost, null, {}, '1999.99'), actor)).toEqual({
        kind: 'PARTS_SUM_MISMATCH',
        costAmount: eur('2000.00'),
        partsSum: eur('1999.99'),
      });
      const financing = await ctx.cost(a, 'FINANCING_RELATED', '900.00');
      expect(
        await ctx.classifications.create(
          entered(a, financing, null, {
            parts: [
              { purpose: 'FINANCING', amount: eur('400.00') },
              { purpose: 'OWNERSHIP_TRANSFER', amount: eur('500.00') },
            ],
          }),
          actor,
        ),
      ).toEqual({ kind: 'PURPOSE_NOT_ALLOWED', category: 'FINANCING_RELATED', purpose: 'OWNERSHIP_TRANSFER' });
      expect(await ctx.classifications.create(entered(a, financing, null, { parts: [] }, '0'), actor)).toMatchObject({ kind: 'PARTS_SUM_MISMATCH' });
      expect((await ctx.classifications.create(entered(a, financing, null, {}, '900.00'), actor)).kind).toBe('PURPOSE_NOT_ALLOWED');
      expect((await ctx.classifications.create(entered(a, financing, null, { parts: [{ purpose: 'FINANCING', amount: eur('900.00') }] }), actor)).kind).toBe(
        'CREATED',
      );
      // VOID, then CANCELLED (the Acquisition first).
      const voided = await ctx.cost(a, 'OTHER', '10.00');
      await ctx.costs.voidCost(a, voided, REALM, 'falsch erfasst', new Date(), actor);
      expect(await ctx.classifications.create(entered(a, voided, 'x', {}, '1.00'), actor)).toEqual({ kind: 'COST_VOID' });
      await ctx.acquisitions.cancel(a, REALM, 'x', new Date(), actor);
      expect(await ctx.classifications.create(entered(a, voided, 'x', {}, '1.00'), actor)).toEqual({ kind: 'ACQUISITION_CANCELLED' });
    });

    it('allowed on a CONFIRMED Acquisition (invoices arrive after the transfer)', async () => {
      const a = await ctx.acquisition();
      const cost = await ctx.cost(a, 'LAND_REGISTRY', '1000.00');
      await ctx.confirm(a);
      expect((await ctx.classifications.create(entered(a, cost, null, {}, '1000.00'), actor)).kind).toBe('CREATED');
    });

    it('with an Idempotency-Key a replay answers the recorded classification, another payload is a conflict; without one a retry is CURRENT_CLASSIFICATION_CHANGED', async () => {
      const a = await ctx.acquisition();
      const cost = await ctx.cost(a, 'NOTARY', '2000.00');
      const request = entered(a, cost, null);
      const key = { key: 'class-1', fingerprint: classificationFingerprint(request) };
      const first = await ctx.classifications.create(request, actor, key);
      expect(first.kind).toBe('CREATED');
      expect(await ctx.classifications.create(request, actor, key)).toEqual({ ...first, kind: 'REPLAYED' });
      const changed = { ...request, description: 'anders' };
      expect(await ctx.classifications.create(changed, actor, { key: 'class-1', fingerprint: classificationFingerprint(changed) })).toEqual({
        kind: 'IDEMPOTENCY_CONFLICT',
      });
      expect((await ctx.classifications.create(request, actor)).kind).toBe('CURRENT_CLASSIFICATION_CHANGED');
    });

    it('list: ACQUISITION_NOT_FOUND for an unknown or foreign Acquisition, COST_NOT_FOUND for a cost of another; an empty history', async () => {
      const a = await ctx.acquisition();
      const cost = await ctx.cost(a, 'NOTARY', '2000.00');
      expect(await ctx.classifications.list(a, cost, REALM)).toEqual({ kind: 'FOUND', current: null, items: [] });
      expect(await ctx.classifications.list(a, cost, OTHER_REALM)).toEqual({ kind: 'ACQUISITION_NOT_FOUND' });
      expect(await ctx.classifications.list('nope', cost, REALM)).toEqual({ kind: 'ACQUISITION_NOT_FOUND' });
      expect(await ctx.classifications.list(await ctx.acquisition(), cost, REALM)).toEqual({ kind: 'COST_NOT_FOUND' });
      expect(await ctx.classifications.list(a, 'nope', REALM)).toEqual({ kind: 'COST_NOT_FOUND' });
      expect((await ctx.costs.listCosts(a, REALM, {}))?.[0]?.classification).toBeNull();
    });
  });

  describe('concurrency (one READ COMMITTED transaction, the Acquisition row first)', () => {
    it('two classifications of one cost: the second waits on the Acquisition and gets CURRENT_CLASSIFICATION_CHANGED', async () => {
      const a = await ctx.acquisition();
      const cost = await ctx.cost(a, 'NOTARY', '2000.00');
      const outcome = await ctx.whileHeld(
        async (h) => {
          await h.query(`UPDATE acquisition SET version = version WHERE id = $1`, [a]);
          await ctx.rawClassify(h, a, cost, [['OWNERSHIP_TRANSFER', '2000.00']]);
        },
        () => ctx.classifications.create(entered(a, cost, null), actor),
        '"acquisition"',
      );
      expect(outcome).toMatchObject({ kind: 'CURRENT_CLASSIFICATION_CHANGED' });
    });

    it('against a cancel, both orders: cancel first refuses the classification; a classification first lets the cancel follow', async () => {
      const a = await ctx.acquisition();
      const cost = await ctx.cost(a, 'NOTARY', '2000.00');
      const cancelFirst = await ctx.whileHeld(
        (h) =>
          h.query(`UPDATE acquisition SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'x', version = version + 1 WHERE id = $1`, [a]),
        () => ctx.classifications.create(entered(a, cost, null), actor),
        '"acquisition"',
      );
      expect(cancelFirst).toEqual({ kind: 'ACQUISITION_CANCELLED' });
      const b = await ctx.acquisition();
      const bCost = await ctx.cost(b, 'NOTARY', '2000.00');
      const cancelled = await ctx.whileHeld(
        (h) => ctx.rawClassify(h, b, bCost, [['OWNERSHIP_TRANSFER', '2000.00']]),
        () => ctx.acquisitions.cancel(b, REALM, 'x', new Date(), actor),
        '"acquisition"',
      );
      expect(cancelled.kind).toBe('CANCELLED');
    });

    it('against a void of the cost, both orders: void first refuses with COST_VOID; a classification first lets the void follow', async () => {
      const a = await ctx.acquisition();
      const cost = await ctx.cost(a, 'OTHER', '2000.00');
      const voidFirst = await ctx.whileHeld(
        (h) =>
          h.query(
            `UPDATE acquisition_cost SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1, updated_at = now() WHERE id = $1`,
            [cost],
          ),
        () => ctx.classifications.create(entered(a, cost, null), actor),
        '"acquisition"',
      );
      expect(voidFirst).toEqual({ kind: 'COST_VOID' });
      const second = await ctx.cost(a, 'OTHER', '2000.00');
      const voided = await ctx.whileHeld(
        (h) => ctx.rawClassify(h, a, second, [['OWNERSHIP_TRANSFER', '2000.00']]),
        () => ctx.costs.voidCost(a, second, REALM, 'x', new Date(), actor),
        '"acquisition"',
      );
      expect(voided.kind).toBe('VOIDED');
    });
  });

  it(
    '0054 up refuses while a recorded version exists, else creates; down refuses while a classification exists, else drops the tables and the column',
    { timeout: 60_000 },
    async () => {
      const schema = testSchemaName('cost_classification_migration_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.end();
      const own = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 2 });
      try {
        await migrateToLatest(own, {
          migrations: Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '0054')),
          migrationTableSchema: schema,
        });
        const migration = migrations['0054_acquisition_cost_classification'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
        const run = async (step: 'up' | 'down') => {
          const lock = new pg.Client({ connectionString: databaseUrl });
          await lock.connect();
          try {
            await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
            return await migration[step](createDatabase(own) as never).then(
              () => 'accepted',
              (e: unknown) => e,
            );
          } finally {
            await lock.end().catch(() => undefined);
          }
        };
        const shape = async () =>
          (
            await own.query(
              `SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'acquisition_cost_classification%')::int AS tables,
                    (SELECT count(*) FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'cost_classification_ids')::int AS columns`,
              [schema],
            )
          ).rows[0];
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
        expect(await shape()).toEqual({ tables: 0, columns: 0 });
        await own.query(`DELETE FROM depreciation_schedule_version`);
        expect(await run('up')).toBe('accepted');
        expect(await shape()).toEqual({ tables: 2, columns: 1 });
        // No backfill: an existing cost has no classification after up.
        const pr = (
          await own.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, 'bbbbbbbbbbbbbbbbbbbbbbbb', 'ACTIVE', 'x') RETURNING id`,
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
        const cost = (
          await own.query(
            `INSERT INTO acquisition_cost (mre_realm_id, acquisition_id, category, amount, currency, status, created_by) VALUES ($1, $2, 'NOTARY', 100, 'EUR', 'ACTIVE', 'x') RETURNING id`,
            [REALM, acq],
          )
        ).rows[0].id as string;
        expect((await own.query(`SELECT count(*)::int AS n FROM acquisition_cost_classification`)).rows[0].n).toBe(0);
        const c = await own.connect();
        try {
          await c.query('BEGIN');
          const id = (
            await c.query(
              `INSERT INTO acquisition_cost_classification (mre_realm_id, acquisition_id, cost_id, description, review_state, created_by) VALUES ($1, $2, $3, 'x', 'CONFIRMED', 'x') RETURNING id`,
              [REALM, acq, cost],
            )
          ).rows[0].id as string;
          await c.query(
            `INSERT INTO acquisition_cost_classification_part (classification_id, position, purpose, amount, currency) VALUES ($1, 1, 'FINANCING', 100, 'EUR')`,
            [id],
          );
          await c.query('COMMIT');
        } finally {
          c.release();
        }
        // A classification present: down refused, nothing dropped.
        expect(await run('down')).toMatchObject({ code: '23514' });
        expect(await shape()).toEqual({ tables: 2, columns: 1 });
        await own.query(`ALTER TABLE acquisition_cost_classification_part DISABLE TRIGGER USER`);
        await own.query(`ALTER TABLE acquisition_cost_classification DISABLE TRIGGER USER`);
        await own.query(`DELETE FROM acquisition_cost_classification_part`);
        await own.query(`DELETE FROM acquisition_cost_classification`);
        expect(await run('down')).toBe('accepted');
        expect(await shape()).toEqual({ tables: 0, columns: 0 });
      } finally {
        await own.end();
      }
    },
  );
});
