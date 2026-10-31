import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocationFingerprint, type NewAllocation } from '../../domains/acquisition/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { PostgresLandBuildingAllocationRepository } from './land-building-allocation-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-2-08 persistence (api-design.md §27.3): allocations as entered, the supersede chain with its optimistic check,
 * the reads, the schema's own rules past the repository, and the serialisation on the Acquisition row.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;
let counter = 0;

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresLandBuildingAllocationRepository', () => {
  const schema = testSchemaName('allocation_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let acquisitions: PostgresAcquisitionRepository;
  let allocations: PostgresLandBuildingAllocationRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    acquisitions = new PostgresAcquisitionRepository(db);
    allocations = new PostgresLandBuildingAllocationRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function party(name: string, realm = REALM): Promise<string> {
    const outcome = await parties.create(
      {
        mreRealmId: realm,
        partyType: 'PERSON',
        displayName: name,
        firstName: null,
        lastName: null,
        legalName: null,
        registrationNumber: null,
        email: null,
        phone: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party.id;
  }
  /** A DRAFT with the transfer date 2026-08-01. */
  async function acquisition(realm = REALM): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fb0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    const outcome = await acquisitions.create(
      {
        mreRealmId: realm,
        propertyReferenceId: rows[0].id as string,
        purchasePrice: eur('300000.00'),
        acquiredShare: { numerator: 1, denominator: 1 },
        contractDate: day('2026-06-15'),
        economicTransferDate: day('2026-08-01'),
        landRegistryTransferDate: null,
        buyerPartyIds: [await party('Käufer', realm)],
        sellerPartyIds: [],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.acquisition.id;
  }
  const entered = (acquisitionId: string, supersedes: string | null, overrides: Partial<NewAllocation> = {}): NewAllocation => ({
    mreRealmId: REALM,
    acquisitionId,
    totalAllocableAmount: eur('330500.00'),
    landAmount: eur('66100.00'),
    buildingAmount: eur('264400.00'),
    method: 'BMF_TOOL',
    reviewState: 'UNREVIEWED',
    effectiveDate: null,
    advisorPartyId: null,
    sourceReferences: [],
    notes: null,
    supersedes,
    ...overrides,
  });
  async function created(allocation: NewAllocation) {
    const outcome = await allocations.create(allocation, actor);
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome));
    return outcome.allocation;
  }
  const rawInsert = (client: pg.Pool | pg.PoolClient, acquisitionId: string, supersedesId: string | null = null, set: Record<string, string> = {}) => {
    const values: Record<string, unknown> = {
      mre_realm_id: REALM,
      acquisition_id: acquisitionId,
      total_allocable_amount: '100',
      land_amount: '20',
      building_amount: '80',
      currency: 'EUR',
      method: 'OTHER',
      review_state: 'UNREVIEWED',
      effective_date: '2026-08-01',
      supersedes_id: supersedesId,
      created_by: 'x',
      ...set,
    };
    const keys = Object.keys(values);
    return client
      .query(
        `INSERT INTO land_building_allocation (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        Object.values(values),
      )
      .then((r) => r.rows[0].id as string);
  };
  const rawSupersede = async (client: pg.PoolClient, acquisitionId: string, oldId: string) => {
    await client.query(`UPDATE land_building_allocation SET superseded_at = now() WHERE id = $1`, [oldId]);
    return rawInsert(client, acquisitionId, oldId);
  };
  async function inTransaction<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }
  const waitForLock = (text: string) =>
    waitUntil(
      async () =>
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = current_setting('application_name') AND query LIKE $1`,
              [`%${text}%`],
            )
          ).rows[0].count,
        ) >= 1,
    );
  async function whileHeld<T>(hold: (client: pg.PoolClient) => Promise<unknown>, waiter: () => Promise<T>, lockText: string): Promise<T> {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await hold(holder);
      const waiting = waiter();
      await waitForLock(lockText);
      await holder.query('COMMIT');
      return await waiting;
    } finally {
      holder.release();
    }
  }

  describe('through the repository', () => {
    it('the first allocation: exact amounts, the transfer date as default effective date, current, an AuditRecord', async () => {
      const a = await acquisition();
      const advisor = await party('Steuerberaterin');
      const first = await created(entered(a, null, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor, notes: 'Arbeitshilfe 2026' }));
      expect(first).toMatchObject({
        acquisitionId: a,
        method: 'BMF_TOOL',
        reviewState: 'ADVISOR_CONFIRMED',
        effectiveDate: '2026-08-01',
        advisorPartyId: advisor,
        supersedesId: null,
        supersededAt: null,
        supersededById: null,
        current: true,
      });
      expect([first.totalAllocableAmount.amount, first.landAmount.amount, first.buildingAmount.amount]).toEqual(['330500.00', '66100.00', '264400.00']);
      expect((await pool.query(`SELECT action, metadata->>'supersedes' AS supersedes FROM audit_record WHERE entity_id = $1`, [first.id])).rows).toEqual([
        { action: 'CREATED', supersedes: null },
      ]);
      expect((await created(entered(await acquisition(), null, { effectiveDate: day('2026-09-01') }))).effectiveDate).toBe('2026-09-01');
    });

    it('a correction supersedes the current one, which keeps its data; the history newest first', async () => {
      const a = await acquisition();
      const first = await created(entered(a, null));
      const second = await created(entered(a, first.id, { landAmount: eur('70000.00'), buildingAmount: eur('260500.00'), reviewState: 'CONFIRMED' }));
      expect(second).toMatchObject({ supersedesId: first.id, current: true });
      const listed = await allocations.list(a, REALM);
      expect(listed?.current?.id).toBe(second.id);
      expect(listed?.items.map((x) => [x.id, x.current, x.supersededById])).toEqual([
        [second.id, true, null],
        [first.id, false, second.id],
      ]);
      expect(listed?.items[1]?.landAmount.amount).toBe('66100.00');
      expect((await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at`, [first.id])).rows.at(-1)).toEqual({
        action: 'SUPERSEDED',
        metadata: { supersededById: second.id },
      });
    });

    it('the optimistic check: supersedes must name the current allocation, null only while there is none', async () => {
      const a = await acquisition();
      expect(await allocations.create(entered(a, '00000000-0000-4000-8000-000000000001'), actor)).toEqual({
        kind: 'CURRENT_ALLOCATION_CHANGED',
        currentAllocationId: null,
      });
      const first = await created(entered(a, null));
      expect(await allocations.create(entered(a, null), actor)).toEqual({ kind: 'CURRENT_ALLOCATION_CHANGED', currentAllocationId: first.id });
      const second = await created(entered(a, first.id));
      expect(await allocations.create(entered(a, first.id), actor)).toEqual({ kind: 'CURRENT_ALLOCATION_CHANGED', currentAllocationId: second.id });
    });

    it('the order of checks: Acquisition, advisor, CANCELLED, supersedes; CONFIRMED takes one', async () => {
      const a = await acquisition();
      const foreignAdvisor = await party('Fremd', OTHER_REALM);
      expect(await allocations.create(entered(await acquisition(OTHER_REALM), null), actor)).toEqual({ kind: 'ACQUISITION_NOT_FOUND' });
      expect(await allocations.create(entered(a, 'x', { advisorPartyId: foreignAdvisor }), actor)).toEqual({
        kind: 'PARTY_NOT_FOUND',
        partyId: foreignAdvisor,
      });
      await acquisitions.cancel(a, REALM, 'x', new Date(), actor);
      expect(await allocations.create(entered(a, 'x'), actor)).toEqual({ kind: 'ACQUISITION_CANCELLED' });
      const confirmed = await acquisition();
      await pool.query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, acquisition_id, created_by)
         SELECT a.mre_realm_id, a.property_reference_id, ap.party_id, 1, 1, a.economic_transfer_date, 'VALID', a.id, 'x'
           FROM acquisition a JOIN acquisition_party ap ON ap.acquisition_id = a.id AND ap.role = 'BUYER' WHERE a.id = $1`,
        [confirmed],
      );
      await acquisitions.confirm(confirmed, REALM, new Date(), actor);
      expect((await allocations.create(entered(confirmed, null), actor)).kind).toBe('CREATED');
    });

    it('with an Idempotency-Key: a replay answers the recorded allocation; without one a retry is refused by supersedes', async () => {
      const a = await acquisition();
      const request = entered(a, null);
      const key = { key: 'alloc-1', fingerprint: allocationFingerprint(request) };
      const first = await allocations.create(request, actor, key);
      expect(first.kind).toBe('CREATED');
      expect(await allocations.create(request, actor, key)).toEqual({ ...first, kind: 'REPLAYED' });
      expect((await allocations.create(request, actor)).kind).toBe('CURRENT_ALLOCATION_CHANGED');
    });

    it('list: undefined for an unknown or foreign Acquisition, an empty history with current null', async () => {
      const a = await acquisition();
      expect(await allocations.list(a, REALM)).toEqual({ current: null, items: [] });
      expect(await allocations.list(a, OTHER_REALM)).toBeUndefined();
      expect(await allocations.list('nope', REALM)).toBeUndefined();
    });
  });

  describe('the database past the repository', () => {
    it('refuses a wrong sum, a second current row, an insert already superseded, an insert on a CANCELLED Acquisition', async () => {
      const a = await acquisition();
      await expect(rawInsert(pool, a, null, { land_amount: '20.01' })).rejects.toThrow(/land_building_allocation_sum/);
      await expect(rawInsert(pool, a, null, { total_allocable_amount: '0', land_amount: '0', building_amount: '0' })).rejects.toThrow(
        /total_allocable_amount_check/,
      );
      await rawInsert(pool, a);
      await expect(rawInsert(pool, a)).rejects.toThrow(/land_building_allocation_current/);
      await expect(rawInsert(pool, await acquisition(), null, { superseded_at: new Date().toISOString() })).rejects.toThrow(/only inserted current/);
      const cancelled = await acquisition();
      await pool.query(`UPDATE acquisition SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'x', version = version + 1 WHERE id = $1`, [
        cancelled,
      ]);
      await expect(rawInsert(pool, cancelled)).rejects.toThrow(/ACQUISITION_CANCELLED/);
    });

    it('keeps the chain consistent: no supersede without a successor (at commit), no successor in another Acquisition, none of a current row', async () => {
      const a = await acquisition();
      const first = await rawInsert(pool, a);
      await expect(inTransaction((c) => c.query(`UPDATE land_building_allocation SET superseded_at = now() WHERE id = $1`, [first]))).rejects.toThrow(
        /superseded without a successor/,
      );
      // The successor must be in the same Acquisition (composite key) ...
      const b = await acquisition();
      await expect(
        inTransaction(async (c) => {
          await c.query(`UPDATE land_building_allocation SET superseded_at = now() WHERE id = $1`, [first]);
          return rawInsert(c, b, first);
        }),
      ).rejects.toThrow(/land_building_allocation_supersedes_fk/);
      // ... and cannot name a row that is still current: the current index refuses it at once; the deferred check is
      // the second line behind it.
      await expect(rawInsert(pool, a, first)).rejects.toThrow(/land_building_allocation_current/);
      // One successor at most.
      await inTransaction((c) => rawSupersede(c, a, first));
      await expect(inTransaction((c) => rawInsert(c, a, first))).rejects.toThrow(/land_building_allocation_current|land_building_allocation_supersedes_key/);
    });

    it('keeps data fixed and rows undeleted; superseded is final', async () => {
      const a = await acquisition();
      const first = await rawInsert(pool, a);
      await expect(pool.query(`UPDATE land_building_allocation SET land_amount = 21, building_amount = 79 WHERE id = $1`, [first])).rejects.toThrow(
        /never changes/,
      );
      await expect(pool.query(`UPDATE land_building_allocation SET review_state = 'CONFIRMED' WHERE id = $1`, [first])).rejects.toThrow(/never changes/);
      await expect(pool.query(`DELETE FROM land_building_allocation WHERE id = $1`, [first])).rejects.toThrow(/never deleted/);
      await inTransaction((c) => rawSupersede(c, a, first));
      await expect(pool.query(`UPDATE land_building_allocation SET superseded_at = NULL WHERE id = $1`, [first])).rejects.toThrow(/superseded is final/);
    });
  });

  describe('concurrency', () => {
    it('two allocations of one Acquisition serialise on its row (RC): the second gets CURRENT_ALLOCATION_CHANGED', async () => {
      const a = await acquisition();
      const outcome = await whileHeld(
        (h) => rawInsert(h, a),
        () => allocations.create(entered(a, null), actor),
        '"acquisition"',
      );
      expect(outcome.kind).toBe('CURRENT_ALLOCATION_CHANGED');
    });

    it('an allocation against a cancel, both orders (RC)', async () => {
      const a = await acquisition();
      const cancelFirst = await whileHeld(
        (h) =>
          h.query(`UPDATE acquisition SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'x', version = version + 1 WHERE id = $1`, [a]),
        () => allocations.create(entered(a, null), actor),
        '"acquisition"',
      );
      expect(cancelFirst).toEqual({ kind: 'ACQUISITION_CANCELLED' });
      const b = await acquisition();
      const cancelled = await whileHeld(
        (h) => rawInsert(h, b),
        () => acquisitions.cancel(b, REALM, 'x', new Date(), actor),
        '"acquisition"',
      );
      expect(cancelled.kind).toBe('CANCELLED');
    });

    it('two raw allocations under REPEATABLE READ: the later one fails to serialise, for the first and for a supersede', async () => {
      async function race(first: (c: pg.PoolClient) => Promise<unknown>, second: (c: pg.PoolClient) => Promise<unknown>): Promise<string> {
        const [one, two] = [await pool.connect(), await pool.connect()];
        try {
          await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await two.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await one.query('SELECT count(*) FROM land_building_allocation');
          await two.query('SELECT count(*) FROM land_building_allocation');
          await first(one);
          const late = second(two).then(
            () => 'written',
            (error: { code?: string }) => error.code ?? 'error',
          );
          await waitForLock('land_building_allocation');
          await one.query('COMMIT');
          const result = await late;
          await two.query('ROLLBACK');
          return result;
        } finally {
          one.release();
          two.release();
        }
      }
      const a = await acquisition();
      expect(
        await race(
          (x) => rawInsert(x, a),
          (y) => rawInsert(y, a),
        ),
      ).toBe('40001');
      const current = (await pool.query(`SELECT id FROM land_building_allocation WHERE acquisition_id = $1`, [a])).rows[0].id as string;
      expect(
        await race(
          (x) => rawSupersede(x, a, current),
          (y) => rawSupersede(y, a, current),
        ),
      ).toBe('40001');
    });
  });
});
