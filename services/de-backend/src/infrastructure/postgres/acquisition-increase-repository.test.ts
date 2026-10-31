import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planOwnerAllocation, type NewAcquisition } from '../../domains/acquisition/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { PostgresOwnerAllocationSource } from './owner-allocation-source.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-X-30 persistence (api-design.md §28.1A, migration 0050): an existing owner buying a further share. The
 * confirmation through the repository and past it (0050's `acquisition_confirmation_violation`), the owner-level
 * allocation's source, the guard `ownership_predecessor_of_confirmed` with its counter-checks (the trigger disabled),
 * its lock order, the concurrency under READ COMMITTED and REPEATABLE READ, the legacy notice, and `down`/`up`. Every
 * name and figure is synthetic.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000a30';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const AT = new Date('2026-10-31T10:00:00Z');
/** X's transfer date and the day before. */
const D = '2026-08-01';
const BEFORE = '2026-07-31';
/** W's transfer date (A's first half). */
const W_D = '2024-03-01';
const f = (numerator: bigint, denominator: bigint) => ({ numerator, denominator });
let counter = 0;

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withMigrationLock(work: () => Promise<unknown>): Promise<void> {
  const lock = new pg.Client({ connectionString: databaseUrl });
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    await work();
  } finally {
    await lock.end().catch(() => undefined);
  }
}

/** The message a statement fails with, or `accepted`. */
const outcomeOf = (statement: Promise<unknown>) =>
  statement.then(
    () => 'accepted',
    (error: { message?: string }) => error.message ?? 'error',
  );

describe.skipIf(databaseUrl === undefined)('VC-X-30: an existing owner buying a further share (migration 0050)', () => {
  const schema = testSchemaName('acquisition_increase_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let ownerships: PostgresOwnershipRepository;
  let acquisitions: PostgresAcquisitionRepository;
  let source: PostgresOwnerAllocationSource;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    ownerships = new PostgresOwnershipRepository(db);
    acquisitions = new PostgresAcquisitionRepository(db);
    source = new PostgresOwnerAllocationSource(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function propertyReference(): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fd0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [REALM, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function party(name: string): Promise<string> {
    const outcome = await parties.create(
      {
        mreRealmId: REALM,
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
  async function acquisition(pr: string, buyers: string[], overrides: Partial<NewAcquisition> = {}): Promise<string> {
    const outcome = await acquisitions.create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        purchasePrice: Money.of('200000.00', 'EUR'),
        acquiredShare: { numerator: 1, denominator: 2 },
        contractDate: day('2026-06-15'),
        economicTransferDate: day(D),
        landRegistryTransferDate: null,
        buyerPartyIds: buyers,
        sellerPartyIds: [],
        sourceReferences: [],
        notes: null,
        ...overrides,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.acquisition.id;
  }
  type Client = pg.Pool | pg.PoolClient;
  /** A raw Ownership insert (the triggers apply, the repository does not). */
  const insertOwnership = (
    client: Client,
    o: { pr: string; owner: string; share: [number, number]; from: string; until?: string | null; acquisitionId?: string | null },
  ) =>
    client
      .query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, valid_until, status, acquisition_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'VALID', $8, 'x') RETURNING id`,
        [REALM, o.pr, o.owner, o.share[0], o.share[1], o.from, o.until ?? null, o.acquisitionId ?? null],
      )
      .then((r) => r.rows[0].id as string);
  const rawConfirm = (client: Client, id: string) =>
    client.query(`UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), version = version + 1 WHERE id = $1`, [id]);
  const rawVoid = (client: Client, ownershipId: string) =>
    client.query(`UPDATE ownership SET status = 'VOID', voided_at = now(), void_reason = 'Tippfehler', version = version + 1 WHERE id = $1`, [ownershipId]);
  const rawClose = (client: Client, ownershipId: string, until: string) =>
    client.query(`UPDATE ownership SET valid_until = $2, version = version + 1 WHERE id = $1`, [ownershipId, until]);
  const statusOf = async (id: string) => (await pool.query(`SELECT status FROM acquisition WHERE id = $1`, [id])).rows[0].status as string;
  const increaseViolation = async (id: string) => (await pool.query(`SELECT acquisition_increase_violation($1) AS v`, [id])).rows[0].v as string | null;
  /** The counter-check of the guard: the same write with the trigger disabled in this file's schema. */
  async function withoutGuard<T>(work: () => Promise<T>): Promise<T> {
    await pool.query('ALTER TABLE ownership DISABLE TRIGGER ownership_predecessor_of_confirmed');
    try {
      return await work();
    } finally {
      await pool.query('ALTER TABLE ownership ENABLE TRIGGER ownership_predecessor_of_confirmed');
    }
  }

  /**
   * The row model of §28.1A: A holds 1/2 from W's transfer date (O1, carrying W when `w`), B the other 1/2 (O2); X (A
   * buys B's half, `acquiredShare` as given) is recorded by one §26.2 change at D: O1 and O2 closed on D − 1, O3 = A 1/1.
   */
  async function rowModel(options: { w?: boolean; acquired?: [number, number] } = {}) {
    const pr = await propertyReference();
    const [a, b] = [await party('Anna'), await party('Bernd')];
    const w = options.w === true ? await acquisition(pr, [a], { contractDate: day('2024-02-01'), economicTransferDate: day(W_D) }) : null;
    const o1 = await insertOwnership(pool, { pr, owner: a, share: [1, 2], from: W_D, acquisitionId: w });
    const o2 = await insertOwnership(pool, { pr, owner: b, share: [1, 2], from: W_D });
    if (w !== null) expect((await acquisitions.confirm(w, REALM, AT, actor)).kind).toBe('CONFIRMED');
    const [n, d] = options.acquired ?? [1, 2];
    const x = await acquisition(pr, [a], { sellerPartyIds: [b], acquiredShare: { numerator: n, denominator: d } });
    const changed = await ownerships.change(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        effectiveDate: day(D),
        reason: 'Kauf des Anteils von Bernd',
        close: [o1, o2],
        create: [{ ownerPartyId: a, share: { numerator: 1, denominator: 1 }, sourceReferences: [], notes: null }],
        acquisitionId: x,
      },
      actor,
    );
    if (changed.kind !== 'CHANGED') throw new Error(changed.kind);
    const o3 = changed.result.created[0]?.id ?? '';
    return { pr, a, b, w, x, o1, o2, o3 };
  }

  describe('confirmation (§28.1 requirement 5 as §28.1A replaces it)', () => {
    it('through the repository: A 1/2 (W) → 1/1 confirms X of 1/2; W stays confirmed and untouched', async () => {
      const s = await rowModel({ w: true });
      expect(await acquisitions.confirm(s.x, REALM, AT, actor)).toMatchObject({ kind: 'CONFIRMED', changed: true, ownershipIds: [s.o3] });
      expect(await statusOf(s.w ?? '')).toBe('CONFIRMED');
    });

    it('through the repository: X of 1/1 for A 1/2 → 1/1 is SHARE_SUM_MISMATCH with byBuyer', async () => {
      const s = await rowModel({ acquired: [1, 1] });
      expect(await acquisitions.confirm(s.x, REALM, AT, actor)).toEqual({
        kind: 'CONFIRMATION_BLOCKED',
        violations: [
          {
            code: 'SHARE_SUM_MISMATCH',
            expected: f(1n, 1n),
            actual: f(1n, 2n),
            byBuyer: [{ partyId: s.a, shareBefore: f(1n, 2n), share: f(1n, 1n), acquired: f(1n, 2n) }],
          },
        ],
      });
    });

    it('through the repository: a buyer whose share stays (A 1/2 → 1/2 beside new C 1/2) is BUYER_SHARE_NOT_INCREASED alone', async () => {
      const pr = await propertyReference();
      const [a, b, c] = [await party('Anna'), await party('Bernd'), await party('Clara')];
      const oa = await insertOwnership(pool, { pr, owner: a, share: [1, 2], from: W_D, until: BEFORE });
      await insertOwnership(pool, { pr, owner: b, share: [1, 2], from: W_D, until: BEFORE });
      const x = await acquisition(pr, [a, c], { sellerPartyIds: [b] });
      await insertOwnership(pool, { pr, owner: a, share: [1, 2], from: D, acquisitionId: x });
      await insertOwnership(pool, { pr, owner: c, share: [1, 2], from: D, acquisitionId: x });
      expect(await acquisitions.confirm(x, REALM, AT, actor)).toEqual({
        kind: 'CONFIRMATION_BLOCKED',
        violations: [{ code: 'BUYER_SHARE_NOT_INCREASED', partyId: a, shareBefore: f(1n, 2n), share: f(1n, 2n) }],
      });
      // A VOID predecessor counts nowhere: A's full 1/2 is bought, so 1/2 + 1/2 is not the acquired 1/2.
      await rawVoid(pool, oa);
      expect(await acquisitions.confirm(x, REALM, AT, actor)).toMatchObject({ violations: [{ code: 'SHARE_SUM_MISMATCH', actual: f(1n, 1n) }] });
    });

    it('past the repository: A 1/2 → 1/1 allowed for X of 1/2; X of 1/1 SHARE_SUM_MISMATCH; A 1/2 → 1/2 BUYER_SHARE_NOT_INCREASED', async () => {
      const ok = await rowModel();
      await rawConfirm(pool, ok.x);
      expect(await statusOf(ok.x)).toBe('CONFIRMED');
      const full = await rowModel({ acquired: [1, 1] });
      await expect(rawConfirm(pool, full.x)).rejects.toThrow(/SHARE_SUM_MISMATCH/);

      const pr = await propertyReference();
      const [a, b, c] = [await party('Anna'), await party('Bernd'), await party('Clara')];
      await insertOwnership(pool, { pr, owner: a, share: [1, 2], from: W_D, until: BEFORE });
      await insertOwnership(pool, { pr, owner: b, share: [1, 2], from: W_D, until: BEFORE });
      const x = await acquisition(pr, [a, c], { sellerPartyIds: [b] });
      await insertOwnership(pool, { pr, owner: a, share: [1, 2], from: D, acquisitionId: x });
      await insertOwnership(pool, { pr, owner: c, share: [1, 2], from: D, acquisitionId: x });
      await expect(rawConfirm(pool, x)).rejects.toThrow(/BUYER_SHARE_NOT_INCREASED/);
    });

    it('past the repository: a decrease recorded as a purchase is BUYER_SHARE_NOT_INCREASED; a VOID predecessor counts nothing', async () => {
      const pr = await propertyReference();
      const [a, b, c] = [await party('Anna'), await party('Bernd'), await party('Clara')];
      await insertOwnership(pool, { pr, owner: a, share: [1, 2], from: W_D, until: BEFORE });
      await insertOwnership(pool, { pr, owner: b, share: [1, 2], from: W_D, until: BEFORE });
      const x = await acquisition(pr, [a, c], { sellerPartyIds: [b] });
      await insertOwnership(pool, { pr, owner: a, share: [1, 4], from: D, acquisitionId: x });
      await insertOwnership(pool, { pr, owner: c, share: [3, 4], from: D, acquisitionId: x });
      await expect(rawConfirm(pool, x)).rejects.toThrow(/BUYER_SHARE_NOT_INCREASED/);

      // A's 1/2 before D was a recording error and is VOID: A — → 1/1, the full share is bought.
      const pr2 = await propertyReference();
      const [a2, b2] = [await party('Anna'), await party('Bernd')];
      const wrong = await insertOwnership(pool, { pr: pr2, owner: a2, share: [1, 2], from: W_D, until: BEFORE });
      await rawVoid(pool, wrong);
      await insertOwnership(pool, { pr: pr2, owner: b2, share: [1, 1], from: W_D, until: BEFORE });
      const x2 = await acquisition(pr2, [a2], { sellerPartyIds: [b2], acquiredShare: { numerator: 1, denominator: 1 } });
      await insertOwnership(pool, { pr: pr2, owner: a2, share: [1, 1], from: D, acquisitionId: x2 });
      await rawConfirm(pool, x2);
      expect(await statusOf(x2)).toBe('CONFIRMED');
    });

    it('a seller’s row is never required: B’s row ending before D − 1 (a gap) still confirms X', async () => {
      const pr = await propertyReference();
      const [a, b, c] = [await party('Anna'), await party('Bernd'), await party('Clara')];
      await insertOwnership(pool, { pr, owner: c, share: [1, 2], from: W_D });
      await insertOwnership(pool, { pr, owner: b, share: [1, 2], from: W_D, until: '2026-06-30' });
      const x = await acquisition(pr, [a], { sellerPartyIds: [b] });
      await insertOwnership(pool, { pr, owner: a, share: [1, 2], from: D, acquisitionId: x });
      expect((await acquisitions.confirm(x, REALM, AT, actor)).kind).toBe('CONFIRMED');
    });
  });

  describe('owner-level allocation (§27.4 as amended)', () => {
    it('the source reads the buyers’ VALID rows on D and D − 1 (a VOID row and other owners left out): A weight 1/1', async () => {
      const s = await rowModel({ w: true });
      // A recording error of A covering D − 1, voided: it must not count.
      await pool.query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, valid_until, status, voided_at, void_reason, created_by)
         VALUES ($1, $2, $3, 1, 4, '2026-07-01', $4, 'VOID', now(), 'Tippfehler', 'x')`,
        [REALM, s.pr, s.a, BEFORE],
      );
      await acquisitions.confirm(s.x, REALM, AT, actor);
      const input = await source.read(s.x, REALM);
      if (input === undefined) throw new Error('no input');
      expect(input.onTransferDate.map((o) => o.id)).toEqual([s.o3]);
      expect(input.beforeTransferDate.map((o) => [o.id, o.validUntil])).toEqual([[s.o1, BEFORE]]);
      const plan = planOwnerAllocation(input);
      if (plan.kind !== 'ALLOCATED') throw new Error(plan.kind);
      expect(plan).toMatchObject({ basis: 'CONFIRMED' });
      expect(plan.owners.map((o) => [o.ownerPartyId, o.share, o.shareBefore, o.acquiredShare, o.weight, o.purchasePrice.amount])).toEqual([
        [s.a, f(1n, 1n), f(1n, 2n), f(1n, 2n), f(1n, 1n), '200000.00'],
      ]);
    });

    it('a CONFIRMED legacy workaround (A 1/2 → 1/1 confirmed as 1/1 under 0022’s rule) answers OWNERSHIP_BASIS_INCOMPLETE', async () => {
      const s = await rowModel({ acquired: [1, 1] });
      // Confirmed as before 0050: the old rule is in force for this one statement (the guard trigger stays as it is).
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE acquisition DISABLE TRIGGER acquisition_step`);
        await rawConfirm(client, s.x);
        await client.query(`ALTER TABLE acquisition ENABLE TRIGGER acquisition_step`);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const input = await source.read(s.x, REALM);
      if (input === undefined) throw new Error('no input');
      expect(planOwnerAllocation(input)).toMatchObject({
        kind: 'OWNERSHIP_BASIS_INCOMPLETE',
        violations: [{ code: 'SHARE_SUM_MISMATCH', expected: f(1n, 1n), actual: f(1n, 2n) }],
      });
      expect(await increaseViolation(s.x)).toBe('SHARE_SUM_MISMATCH');
    });
  });

  describe('the guard ownership_predecessor_of_confirmed (each with its counter-check: the trigger disabled)', () => {
    it('after X’s confirmation: a raw void and a raw shortening of A’s predecessor are refused', async () => {
      const s = await rowModel();
      await rawConfirm(pool, s.x);
      expect(await outcomeOf(rawVoid(pool, s.o1))).toMatch(/next Ownership .* CONFIRMED Acquisition .*\(ACQUISITION_CONFIRMED\)/);
      expect(await outcomeOf(rawClose(pool, s.o1, '2026-07-30'))).toMatch(/\(ACQUISITION_CONFIRMED\)/);
      // Counter-check: without the guard both writes pass, and the confirmed increase moves (1/2 → 1/1).
      await withoutGuard(async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          expect(await outcomeOf(rawClose(client, s.o1, '2026-07-30'))).toBe('accepted');
          expect(await outcomeOf(rawVoid(client, s.o1))).toBe('accepted');
          expect((await client.query(`SELECT acquisition_increase_violation($1) AS v`, [s.x])).rows[0].v).toBe('SHARE_SUM_MISMATCH');
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      });
      expect(await increaseViolation(s.x)).toBeNull();
    });

    it('after X’s confirmation: a raw insert of a row of A ending on D − 1 (after A’s gap) is refused', async () => {
      const pr = await propertyReference();
      const [a, b, c] = [await party('Anna'), await party('Bernd'), await party('Clara')];
      await insertOwnership(pool, { pr, owner: a, share: [1, 4], from: '2020-01-01', until: '2025-12-31' });
      await insertOwnership(pool, { pr, owner: b, share: [1, 4], from: '2020-01-01', until: BEFORE });
      await insertOwnership(pool, { pr, owner: c, share: [1, 2], from: '2020-01-01' });
      const x = await acquisition(pr, [a], { sellerPartyIds: [b] });
      await insertOwnership(pool, { pr, owner: a, share: [1, 2], from: D, acquisitionId: x });
      await rawConfirm(pool, x);
      const late = () => insertOwnership(pool, { pr, owner: a, share: [1, 4], from: '2026-07-01', until: BEFORE });
      expect(await outcomeOf(late())).toMatch(/\(ACQUISITION_CONFIRMED\)/);
      // A row of A ending earlier is no predecessor and is allowed (it changes nothing on D − 1).
      expect(await outcomeOf(insertOwnership(pool, { pr, owner: a, share: [1, 4], from: '2026-06-01', until: '2026-06-30' }))).toBe('accepted');
      expect(await withoutGuard(() => outcomeOf(late()))).toBe('accepted');
      expect(await increaseViolation(x)).toBe('SHARE_SUM_MISMATCH');
    });

    it('the same three on a DRAFT X are allowed (the DRAFT is touched, not refused)', async () => {
      const s = await rowModel();
      expect(await outcomeOf(rawClose(pool, s.o1, '2026-07-30'))).toBe('accepted');
      expect(await outcomeOf(rawVoid(pool, s.o1))).toBe('accepted');
      expect(await outcomeOf(insertOwnership(pool, { pr: s.pr, owner: s.a, share: [1, 4], from: '2026-07-31', until: BEFORE }))).toBe('accepted');
      expect(await statusOf(s.x)).toBe('DRAFT');
    });

    it('after X’s confirmation: a void of another owner’s row (the seller’s recording error) and a close of O3 are allowed', async () => {
      const s = await rowModel();
      await rawConfirm(pool, s.x);
      expect(await outcomeOf(rawVoid(pool, s.o2))).toBe('accepted');
      expect(await outcomeOf(rawClose(pool, s.o3, '2030-12-31'))).toBe('accepted');
    });

    it('through the repository: 409 ACQUISITION_CONFIRMED with the next Ownership on void, close, §26.2 change and create; a close to the same day is a no-op', async () => {
      const s = await rowModel();
      await acquisitions.confirm(s.x, REALM, AT, actor);
      const refusal = { kind: 'PREDECESSOR_OF_CONFIRMED', acquisitionId: s.x, ownershipId: s.o3 };
      expect(await ownerships.void(s.o1, REALM, 'Tippfehler', AT, actor)).toEqual(refusal);
      expect(await ownerships.close(s.o1, REALM, day('2026-07-30'), actor)).toEqual(refusal);
      expect(await ownerships.close(s.o1, REALM, day(BEFORE), actor)).toMatchObject({ kind: 'CLOSED', changed: false });
      expect(
        await ownerships.change(
          { mreRealmId: REALM, propertyReferenceId: s.pr, effectiveDate: day('2026-07-15'), reason: 'früher', close: [s.o1], create: [], acquisitionId: null },
          actor,
        ),
      ).toEqual(refusal);
      // A gap of A, then a row ending on D − 1: refused on create.
      const pr = await propertyReference();
      const [a, b] = [await party('Anna'), await party('Bernd')];
      await insertOwnership(pool, { pr, owner: b, share: [1, 2], from: '2020-01-01', until: BEFORE });
      const x = await acquisition(pr, [a], { sellerPartyIds: [b] });
      const next = await insertOwnership(pool, { pr, owner: a, share: [1, 2], from: D, acquisitionId: x });
      await insertOwnership(pool, { pr, owner: await party('Clara'), share: [1, 2], from: '2020-01-01' });
      await acquisitions.confirm(x, REALM, AT, actor);
      expect(
        await ownerships.create(
          {
            mreRealmId: REALM,
            propertyReferenceId: pr,
            ownerPartyId: a,
            share: { numerator: 1, denominator: 4 },
            validFrom: day('2026-07-01'),
            validUntil: day(BEFORE),
            acquisitionId: null,
            sourceReferences: [],
            notes: null,
          },
          actor,
        ),
      ).toEqual({ kind: 'PREDECESSOR_OF_CONFIRMED', acquisitionId: x, ownershipId: next });
    });

    it('trigger order: BEFORE triggers fire in name order, ownership_invariants (0019) is AFTER, so the guard writes the PropertyReference itself first', async () => {
      const { rows } = await pool.query(
        `SELECT tgname, (tgtype & 2) <> 0 AS before FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = 'ownership' AND NOT t.tgisinternal ORDER BY tgname`,
        [schema],
      );
      expect(rows).toEqual([
        { tgname: 'ownership_acquisition_confirmed', before: true },
        { tgname: 'ownership_acquisition_draft', before: true },
        { tgname: 'ownership_frozen', before: true },
        { tgname: 'ownership_invariants', before: false },
        { tgname: 'ownership_predecessor_of_confirmed', before: true },
      ]);
      // Behaviour: while another session holds the PropertyReference, a raw void of the predecessor waits there and has
      // not yet written X's row (X can still be locked NOWAIT): PropertyReference → Acquisition.
      const s = await rowModel();
      const [holder, writer, probe] = [await pool.connect(), await pool.connect(), await pool.connect()];
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE property_reference SET version = version WHERE id = $1`, [s.pr]);
        await writer.query('BEGIN');
        const voiding = rawVoid(writer, s.o1).then(
          () => 'done',
          (e: Error) => e.message,
        );
        await waitUntil(
          async () =>
            Number(
              (
                await pool.query(
                  `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = current_setting('application_name') AND query LIKE '%SET status = ''VOID''%'`,
                )
              ).rows[0].count,
            ) >= 1,
        );
        await probe.query('BEGIN');
        expect(await outcomeOf(probe.query(`SELECT 1 FROM acquisition WHERE id = $1 FOR UPDATE NOWAIT`, [s.x]))).toBe('accepted');
        await probe.query('ROLLBACK');
        await holder.query('COMMIT');
        expect(await voiding).toBe('done');
        await writer.query('ROLLBACK');
      } finally {
        // A failed assertion must not leave a transaction (and its locks) on a pooled connection.
        for (const c of [probe, holder, writer]) {
          await c.query('ROLLBACK').catch(() => undefined);
          c.release();
        }
      }
    });

    it('the lookup is served by an existing index of 0019 (no new index; the planner takes the owner’s)', async () => {
      const s = await rowModel();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const { rows } = await client.query(
          `EXPLAIN (FORMAT JSON) SELECT o.id, o.acquisition_id FROM ownership o
            WHERE o.property_reference_id = $1 AND o.owner_party_id = $2 AND o.status = 'VALID' AND o.valid_from = $3::date + 1 AND o.acquisition_id IS NOT NULL`,
          [s.pr, s.a, BEFORE],
        );
        const plan = JSON.stringify(rows[0]['QUERY PLAN']);
        expect(plan).not.toContain('Seq Scan');
        expect(plan).toMatch(/"Index Name":"(ownership_owner_idx|ownership_property_reference_idx)"/);
        const { rows: indexes } = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'ownership' ORDER BY 1`, [schema]);
        expect(indexes.map((r) => r.indexname)).toEqual([
          'ownership_acquisition_idx',
          'ownership_owner_idx',
          'ownership_pkey',
          'ownership_property_reference_idx',
        ]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('concurrency through the repository (READ COMMITTED: whichever comes second sees the first)', () => {
    async function whileHeld<T>(hold: (client: pg.PoolClient) => Promise<unknown>, waiter: () => Promise<T>, lockText: string): Promise<T> {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await hold(holder);
        const waiting = waiter();
        await waitUntil(
          async () =>
            Number(
              (
                await pool.query(
                  `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = current_setting('application_name') AND query LIKE $1`,
                  [`%${lockText}%`],
                )
              ).rows[0].count,
            ) >= 1,
        );
        await holder.query('COMMIT');
        return await waiting;
      } finally {
        holder.release();
      }
    }

    it('confirm X waits for a void, a close and a create of A’s predecessor and sees each', async () => {
      const voided = await rowModel();
      expect(
        await whileHeld(
          (h) => rawVoid(h, voided.o1),
          () => acquisitions.confirm(voided.x, REALM, AT, actor),
          '"property_reference"',
        ),
      ).toMatchObject({ kind: 'CONFIRMATION_BLOCKED', violations: [{ code: 'SHARE_SUM_MISMATCH', actual: f(1n, 1n) }] });
      const closed = await rowModel();
      expect(
        await whileHeld(
          (h) => rawClose(h, closed.o1, '2026-07-30'),
          () => acquisitions.confirm(closed.x, REALM, AT, actor),
          '"property_reference"',
        ),
      ).toMatchObject({ kind: 'CONFIRMATION_BLOCKED', violations: [{ code: 'SHARE_SUM_MISMATCH', actual: f(1n, 1n) }] });
      // A — → 1/2 (X of 1/2): a predecessor of A created meanwhile makes the increase 1/4.
      const pr = await propertyReference();
      const [a, b, c] = [await party('Anna'), await party('Bernd'), await party('Clara')];
      await insertOwnership(pool, { pr, owner: b, share: [1, 4], from: '2020-01-01', until: BEFORE });
      await insertOwnership(pool, { pr, owner: c, share: [1, 2], from: '2020-01-01' });
      const x = await acquisition(pr, [a], { sellerPartyIds: [b] });
      await insertOwnership(pool, { pr, owner: a, share: [1, 2], from: D, acquisitionId: x });
      expect(
        await whileHeld(
          (h) => insertOwnership(h, { pr, owner: a, share: [1, 4], from: '2026-07-01', until: BEFORE }),
          () => acquisitions.confirm(x, REALM, AT, actor),
          '"property_reference"',
        ),
      ).toMatchObject({ kind: 'CONFIRMATION_BLOCKED', violations: [{ code: 'SHARE_SUM_MISMATCH', actual: f(1n, 4n) }] });
    });

    it('a void, a close and a create of the predecessor wait for a confirm in flight and are then refused', async () => {
      const s = await rowModel();
      const refusal = { kind: 'PREDECESSOR_OF_CONFIRMED', acquisitionId: s.x, ownershipId: s.o3 };
      expect(
        await whileHeld(
          (h) => rawConfirm(h, s.x),
          () => ownerships.void(s.o1, REALM, 'Tippfehler', AT, actor),
          '"acquisition"',
        ),
      ).toEqual(refusal);
      const t = await rowModel();
      expect(
        await whileHeld(
          (h) => rawConfirm(h, t.x),
          () => ownerships.close(t.o1, REALM, day('2026-07-30'), actor),
          '"acquisition"',
        ),
      ).toEqual({ ...refusal, acquisitionId: t.x, ownershipId: t.o3 });
      const pr = await propertyReference();
      const [a, b] = [await party('Anna'), await party('Bernd')];
      await insertOwnership(pool, { pr, owner: b, share: [1, 2], from: '2020-01-01', until: BEFORE });
      await insertOwnership(pool, { pr, owner: await party('Clara'), share: [1, 2], from: '2020-01-01' });
      const x = await acquisition(pr, [a], { sellerPartyIds: [b] });
      const next = await insertOwnership(pool, { pr, owner: a, share: [1, 2], from: D, acquisitionId: x });
      const created = await whileHeld(
        (h) => rawConfirm(h, x),
        () =>
          ownerships.create(
            {
              mreRealmId: REALM,
              propertyReferenceId: pr,
              ownerPartyId: a,
              share: { numerator: 1, denominator: 4 },
              validFrom: day('2026-07-01'),
              validUntil: day(BEFORE),
              acquisitionId: null,
              sourceReferences: [],
              notes: null,
            },
            actor,
          ),
        '"acquisition"',
      );
      expect(created).toEqual({ kind: 'PREDECESSOR_OF_CONFIRMED', acquisitionId: x, ownershipId: next });
    });
  });

  describe('concurrency past the repository (REPEATABLE READ: a raw confirm and a raw predecessor write fail to serialise)', () => {
    async function race(first: (c: pg.PoolClient) => Promise<unknown>, second: (c: pg.PoolClient) => Promise<unknown>): Promise<string> {
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await two.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT count(*) FROM ownership');
        await two.query('SELECT count(*) FROM ownership');
        await first(one);
        const late = second(two).then(
          async () => {
            await two.query('COMMIT');
            return 'committed';
          },
          (error: { code?: string }) => error.code ?? 'error',
        );
        // The second either waits on the row the first wrote, or (without the touch) finishes on its own.
        await Promise.race([
          late,
          waitUntil(
            async () =>
              Number(
                (
                  await pool.query(
                    `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = current_setting('application_name')`,
                  )
                ).rows[0].count,
              ) >= 1,
          ),
        ]);
        await one.query('COMMIT');
        const result = await late;
        await two.query('ROLLBACK');
        return result;
      } finally {
        one.release();
        two.release();
      }
    }

    it('a raw void of the predecessor against a raw confirm: 40001; counter-check without the touch: both commit, the increase is wrong', async () => {
      const s = await rowModel();
      expect(
        await race(
          (x) => rawVoid(x, s.o1),
          (y) => rawConfirm(y, s.x),
        ),
      ).toBe('40001');
      const t = await rowModel();
      expect(
        await withoutGuard(() =>
          race(
            (x) => rawVoid(x, t.o1),
            (y) => rawConfirm(y, t.x),
          ),
        ),
      ).toBe('committed');
      expect(await statusOf(t.x)).toBe('CONFIRMED');
      expect(await increaseViolation(t.x)).toBe('SHARE_SUM_MISMATCH');
    });

    it('a raw insert ending on D − 1 against a raw confirm: 40001; counter-check without the touch: both commit', async () => {
      const gapCase = async () => {
        const pr = await propertyReference();
        const [a, b] = [await party('Anna'), await party('Bernd')];
        await insertOwnership(pool, { pr, owner: b, share: [1, 4], from: '2020-01-01', until: BEFORE });
        await insertOwnership(pool, { pr, owner: await party('Clara'), share: [1, 2], from: '2020-01-01' });
        const x = await acquisition(pr, [a], { sellerPartyIds: [b] });
        await insertOwnership(pool, { pr, owner: a, share: [1, 2], from: D, acquisitionId: x });
        return { pr, a, x };
      };
      const s = await gapCase();
      expect(
        await race(
          (x) => insertOwnership(x, { pr: s.pr, owner: s.a, share: [1, 4], from: '2026-07-01', until: BEFORE }),
          (y) => rawConfirm(y, s.x),
        ),
      ).toBe('40001');
      const t = await gapCase();
      expect(
        await withoutGuard(() =>
          race(
            (x) => insertOwnership(x, { pr: t.pr, owner: t.a, share: [1, 4], from: '2026-07-01', until: BEFORE }),
            (y) => rawConfirm(y, t.x),
          ),
        ),
      ).toBe('committed');
      expect(await increaseViolation(t.x)).toBe('SHARE_SUM_MISMATCH');
    });
  });

  describe('migration 0050: the legacy notice, down and up', () => {
    it(
      'up reports a CONFIRMED workaround confirmed under 0049’s schema; down restores 0022’s rule; up again (under MIGRATION_ADVISORY_LOCK)',
      { timeout: 30_000 },
      async () => {
        const legacySchema = testSchemaName('acquisition_increase_legacy_test');
        const admin = new pg.Client({ connectionString: databaseUrl });
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${legacySchema}"`);
        await admin.end();
        const notices: string[] = [];
        const legacyPool = new pg.Pool({
          connectionString: databaseUrl,
          options: `-c search_path=${legacySchema} -c application_name=${legacySchema}`,
          max: 2,
        });
        legacyPool.on('connect', (client) => client.on('notice', (notice) => notices.push(notice.message ?? '')));
        try {
          const before0050 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '0050'));
          await migrateToLatest(legacyPool, { migrations: before0050, migrationTableSchema: legacySchema });
          const db = createDatabase(legacyPool);
          const legacyParties = new PostgresPartyRepository(db);
          const legacyAcquisitions = new PostgresAcquisitionRepository(db);
          const person = async (name: string) => {
            const p = await legacyParties.create(
              {
                mreRealmId: REALM,
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
            if (p.kind !== 'CREATED') throw new Error(p.kind);
            return p.party.id;
          };
          const { rows } = await legacyPool.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5fe0001', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          );
          const pr = rows[0].id as string;
          const [a, b] = [await person('Anna'), await person('Bernd')];
          const add = (owner: string, share: [number, number], from: string, until: string | null, acquisitionId: string | null) =>
            legacyPool.query(
              `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, valid_until, status, acquisition_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'VALID', $8, 'x')`,
              [REALM, pr, owner, share[0], share[1], from, until, acquisitionId],
            );
          await add(a, [1, 2], W_D, BEFORE, null);
          await add(b, [1, 2], W_D, BEFORE, null);
          const newX = async (n: number, d: number) => {
            const x = await legacyAcquisitions.create(
              {
                mreRealmId: REALM,
                propertyReferenceId: pr,
                purchasePrice: Money.of('200000.00', 'EUR'),
                acquiredShare: { numerator: n, denominator: d },
                contractDate: day('2026-06-15'),
                economicTransferDate: day(D),
                landRegistryTransferDate: null,
                buyerPartyIds: [a],
                sellerPartyIds: [b],
                sourceReferences: [],
                notes: null,
              },
              actor,
            );
            if (x.kind !== 'CREATED') throw new Error(x.kind);
            return x.acquisition.id;
          };
          // The 1/1 workaround: A's 1/2 → 1/1 confirmed as a purchase of 1/1, accepted by 0022's full-share rule (raw:
          // the repository's domain check is already §28.1A's).
          const workaround = await newX(1, 1);
          await add(a, [1, 1], D, null, workaround);
          await legacyPool.query(`UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), version = version + 1 WHERE id = $1`, [workaround]);
          // The truthful one (1/2) under 0022 is refused.
          const pr2Rows = await legacyPool.query(
            `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5fe0002', 'ACTIVE', 'x') RETURNING id`,
            [REALM],
          );
          const pr2 = pr2Rows.rows[0].id as string;
          const add2 = (owner: string, share: [number, number], from: string, until: string | null, acquisitionId: string | null) =>
            legacyPool.query(
              `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, valid_until, status, acquisition_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'VALID', $8, 'x')`,
              [REALM, pr2, owner, share[0], share[1], from, until, acquisitionId],
            );
          const truthful = await legacyAcquisitions.create(
            {
              mreRealmId: REALM,
              propertyReferenceId: pr2,
              purchasePrice: Money.of('200000.00', 'EUR'),
              acquiredShare: { numerator: 1, denominator: 2 },
              contractDate: day('2026-06-15'),
              economicTransferDate: day(D),
              landRegistryTransferDate: null,
              buyerPartyIds: [a],
              sellerPartyIds: [b],
              sourceReferences: [],
              notes: null,
            },
            actor,
          );
          if (truthful.kind !== 'CREATED') throw new Error(truthful.kind);
          const t = truthful.acquisition.id;
          await add2(a, [1, 2], W_D, BEFORE, null);
          await add2(b, [1, 2], W_D, BEFORE, null);
          await add2(a, [1, 1], D, null, t);
          const rawT = () => legacyPool.query(`UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), version = version + 1 WHERE id = $1`, [t]);
          await expect(rawT()).rejects.toThrow(/SHARE_SUM_MISMATCH/);

          notices.length = 0;
          await migrateToLatest(legacyPool, { migrationTableSchema: legacySchema });
          expect(notices.filter((n) => n.startsWith('VC-X-30'))).toEqual([
            `VC-X-30: CONFIRMED Acquisition ${workaround} fails requirement 5 of api-design §28.1A (SHARE_SUM_MISMATCH); it stays confirmed`,
          ]);
          expect((await legacyPool.query(`SELECT status FROM acquisition WHERE id = $1`, [workaround])).rows[0].status).toBe('CONFIRMED');

          // down: 0022's rule again (the truthful confirm refused), the trigger and the helper gone; the workaround stays.
          const migration = await import('./migrations/0050_acquisition_increase.js');
          await withMigrationLock(() => migration.down(createDatabase(legacyPool) as never));
          await expect(rawT()).rejects.toThrow(/SHARE_SUM_MISMATCH/);
          const objects = async () =>
            (
              await legacyPool.query(
                `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = $1 AND p.proname IN ('acquisition_increase_violation', 'ownership_predecessor_of_confirmed', 'acquisition_confirmation_violation')
               UNION ALL SELECT tgname FROM pg_trigger WHERE tgname = 'ownership_predecessor_of_confirmed' AND tgrelid = $2::regclass ORDER BY 1`,
                [legacySchema, `"${legacySchema}".ownership`],
              )
            ).rows.map((r) => r.name as string);
          expect(await objects()).toEqual(['acquisition_confirmation_violation']);
          expect((await legacyPool.query(`SELECT status FROM acquisition WHERE id = $1`, [workaround])).rows[0].status).toBe('CONFIRMED');

          // up again: the truthful one confirms.
          await withMigrationLock(() => migration.up(createDatabase(legacyPool) as never));
          expect(await objects()).toEqual([
            'acquisition_confirmation_violation',
            'acquisition_increase_violation',
            'ownership_predecessor_of_confirmed',
            'ownership_predecessor_of_confirmed',
          ]);
          await rawT();
          expect((await legacyPool.query(`SELECT status FROM acquisition WHERE id = $1`, [t])).rows[0].status).toBe('CONFIRMED');
        } finally {
          await legacyPool.end();
        }
      },
    );
  });
});
