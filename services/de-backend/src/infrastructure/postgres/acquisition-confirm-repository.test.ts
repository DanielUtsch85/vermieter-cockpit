import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewAcquisition } from '../../domains/acquisition/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-2-07 persistence (api-design.md §28.1): confirmation with its six requirements, all reported; the status rules
 * around it; what confirmation does to the Acquisition's Ownerships; the database's own check past the repository;
 * and the locks (READ COMMITTED through the repository, REPEATABLE READ past it).
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const AT = new Date('2026-10-26T10:00:00Z');
/** The transfer date of every draft here (`economicTransferDate`). */
const D = '2026-08-01';
let counter = 0;

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresAcquisitionRepository.confirm', () => {
  const schema = testSchemaName('acquisition_confirm_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let ownerships: PostgresOwnershipRepository;
  let acquisitions: PostgresAcquisitionRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    ownerships = new PostgresOwnershipRepository(db);
    acquisitions = new PostgresAcquisitionRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function propertyReference(): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fa0000n + BigInt(++counter)).toString(16).padStart(24, '0');
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
        purchasePrice: Money.of('300000.00', 'EUR'),
        acquiredShare: { numerator: 1, denominator: 1 },
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
  /** A raw Ownership insert (the triggers apply, the repository does not). */
  const insertOwnership = (
    client: pg.Pool | pg.PoolClient,
    o: { pr: string; owner: string; share?: [number, number]; from?: string; until?: string | null; acquisitionId?: string | null },
  ) =>
    client
      .query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, valid_until, status, acquisition_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'VALID', $8, 'x') RETURNING id`,
        [REALM, o.pr, o.owner, o.share?.[0] ?? 1, o.share?.[1] ?? 1, o.from ?? D, o.until ?? null, o.acquisitionId ?? null],
      )
      .then((r) => r.rows[0].id as string);
  const rawConfirm = (client: pg.Pool | pg.PoolClient, id: string) =>
    client.query(`UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), version = version + 1 WHERE id = $1`, [id]);
  const rawVoid = (client: pg.Pool | pg.PoolClient, ownershipId: string) =>
    client.query(`UPDATE ownership SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [ownershipId]);
  const rawDeactivate = (client: pg.Pool | pg.PoolClient, partyId: string) =>
    client.query(`UPDATE party SET status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'x', version = version + 1 WHERE id = $1`, [partyId]);
  const waitForLock = (text: string) =>
    waitUntil(
      async () =>
        Number(
          (
            await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [
              `%${text}%`,
            ])
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
  /** Two buyers with 1/2 each from the transfer date: ready to confirm. */
  async function ready() {
    const pr = await propertyReference();
    const [anna, ben] = [await party('Anna'), await party('Ben')];
    const id = await acquisition(pr, [anna, ben]);
    const own = [
      await insertOwnership(pool, { pr, owner: anna, share: [1, 2], acquisitionId: id }),
      await insertOwnership(pool, { pr, owner: ben, share: [1, 2], acquisitionId: id }),
    ];
    return { pr, anna, ben, id, own };
  }

  describe('through the repository', () => {
    it('confirms: status, confirmedAt, version + 1, and an AuditRecord with the transfer date and its Ownerships; a repeat is a no-op', async () => {
      const { id, own } = await ready();
      const outcome = await acquisitions.confirm(id, REALM, AT, actor, [1]);
      expect(outcome).toMatchObject({ kind: 'CONFIRMED', changed: true, acquisition: { status: 'CONFIRMED', confirmedAt: AT, version: 2 } });
      expect(
        (await pool.query(`SELECT action, metadata, previous_version, new_version FROM audit_record WHERE entity_id = $1 AND action = 'CONFIRMED'`, [id])).rows,
      ).toEqual([{ action: 'CONFIRMED', metadata: { transferDate: D, ownershipIds: [...own].sort() }, previous_version: 1, new_version: 2 }]);
      expect(await acquisitions.confirm(id, REALM, new Date(), actor, [9])).toMatchObject({
        kind: 'CONFIRMED',
        changed: false,
        acquisition: { confirmedAt: AT, version: 2 },
      });
    });

    it('the order of checks: unknown, CANCELLED before a stale If-Match, then If-Match, then the requirements', async () => {
      const pr = await propertyReference();
      const anna = await party('Anna');
      expect(await acquisitions.confirm('nope', REALM, AT, actor)).toEqual({ kind: 'NOT_FOUND' });
      const cancelled = await acquisition(pr, [anna]);
      await acquisitions.cancel(cancelled, REALM, 'x', AT, actor);
      expect(await acquisitions.confirm(cancelled, REALM, AT, actor, [1])).toEqual({ kind: 'ACQUISITION_CANCELLED' });
      const blocked = await acquisition(pr, [anna]);
      expect(await acquisitions.confirm(blocked, OTHER_REALM, AT, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await acquisitions.confirm(blocked, REALM, AT, actor, [5])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [5], currentVersion: 1 });
      expect((await acquisitions.confirm(blocked, REALM, AT, actor, [1])).kind).toBe('CONFIRMATION_BLOCKED');
    });

    it('reports every failed requirement at once, in their order', async () => {
      const pr = await propertyReference();
      const [anna, ben, carl] = [await party('Anna'), await party('Ben'), await party('Carl')];
      const id = await acquisition(pr, [anna, ben], { acquiredShare: { numerator: 1, denominator: 2 } });
      const late = await insertOwnership(pool, { pr, owner: anna, share: [1, 4], from: '2026-08-02', acquisitionId: id });
      const stranger = await insertOwnership(pool, { pr, owner: carl, share: [1, 8], acquisitionId: id });
      await rawDeactivate(pool, anna);
      const zero = { numerator: 0n, denominator: 1n };
      expect(await acquisitions.confirm(id, REALM, AT, actor)).toEqual({
        kind: 'CONFIRMATION_BLOCKED',
        violations: [
          { code: 'BUYER_INACTIVE', partyId: anna },
          { code: 'OWNERSHIP_NOT_FROM_TRANSFER_DATE', ownershipId: late, validFrom: '2026-08-02', transferDate: D },
          { code: 'OWNER_NOT_A_BUYER', ownershipId: stranger, ownerPartyId: carl },
          { code: 'BUYER_WITHOUT_OWNERSHIP', partyId: ben },
          // §28.1A: Anna's only row starts the day after, so she holds nothing on the transfer date (5a, 5b with 0).
          { code: 'BUYER_SHARE_NOT_INCREASED', partyId: anna, shareBefore: zero, share: zero },
          {
            code: 'SHARE_SUM_MISMATCH',
            expected: { numerator: 1n, denominator: 2n },
            actual: zero,
            byBuyer: [{ partyId: anna, shareBefore: zero, share: zero, acquired: zero }],
          },
          { code: 'OWNERSHIP_INCOMPLETE', date: D, shareSum: { numerator: 1n, denominator: 8n } },
        ],
      });
      expect((await pool.query(`SELECT status, version FROM acquisition WHERE id = $1`, [id])).rows[0]).toEqual({ status: 'DRAFT', version: 1 });
    });

    it('a partial acquisition: the other owners count toward COMPLETE on the transfer date, not toward the share', async () => {
      const pr = await propertyReference();
      const [seller, ben, keeper] = [await party('Verkäufer'), await party('Ben'), await party('Bleibt')];
      // The seller's half ends the day before; the keeper keeps the other half.
      await insertOwnership(pool, { pr, owner: seller, share: [1, 2], from: '2020-01-01', until: '2026-07-31' });
      await insertOwnership(pool, { pr, owner: keeper, share: [1, 2], from: '2020-01-01' });
      const id = await acquisition(pr, [ben], { acquiredShare: { numerator: 1, denominator: 2 }, sellerPartyIds: [seller] });
      await insertOwnership(pool, { pr, owner: ben, share: [1, 2], acquisitionId: id });
      expect((await acquisitions.confirm(id, REALM, AT, actor)).kind).toBe('CONFIRMED');
    });

    it('after confirmation: its Ownerships close but do not void, others still void, cancel is refused', async () => {
      const { pr, id, own } = await ready();
      const other = await party('Andere');
      const otherPr = await propertyReference();
      const foreign = await insertOwnership(pool, { pr: otherPr, owner: other });
      await acquisitions.confirm(id, REALM, AT, actor);
      expect(await ownerships.void(own[0] ?? '', REALM, 'x', AT, actor)).toEqual({ kind: 'ACQUISITION_CONFIRMED', acquisitionId: id });
      expect((await ownerships.close(own[0] ?? '', REALM, day('2030-12-31'), actor)).kind).toBe('CLOSED');
      expect((await ownerships.void(foreign, REALM, 'x', AT, actor)).kind).toBe('VOIDED');
      expect(await acquisitions.cancel(id, REALM, 'x', AT, actor)).toEqual({ kind: 'ACQUISITION_CONFIRMED' });
      expect(pr).toBeDefined();
    });
  });

  describe('the database past the repository', () => {
    it('refuses a raw confirmation for each requirement 1–6 with its code', async () => {
      const one = await ready();
      await rawDeactivate(pool, one.anna);
      await expect(rawConfirm(pool, one.id)).rejects.toThrow(/BUYER_INACTIVE/);

      const two = await ready();
      await rawVoid(pool, two.own[1] ?? '');
      await insertOwnership(pool, { pr: two.pr, owner: two.ben, share: [1, 2], from: '2026-08-02', acquisitionId: two.id });
      await expect(rawConfirm(pool, two.id)).rejects.toThrow(/OWNERSHIP_NOT_FROM_TRANSFER_DATE/);

      const three = await ready();
      await rawVoid(pool, three.own[1] ?? '');
      await insertOwnership(pool, { pr: three.pr, owner: await party('Fremd'), share: [1, 2], acquisitionId: three.id });
      await expect(rawConfirm(pool, three.id)).rejects.toThrow(/OWNER_NOT_A_BUYER/);

      const four = await ready();
      await rawVoid(pool, four.own[1] ?? '');
      await expect(rawConfirm(pool, four.id)).rejects.toThrow(/BUYER_WITHOUT_OWNERSHIP/);

      const pr5 = await propertyReference();
      const b5 = await party('Fünf');
      const five = await acquisition(pr5, [b5]);
      await insertOwnership(pool, { pr: pr5, owner: b5, share: [1, 2], acquisitionId: five });
      await expect(rawConfirm(pool, five)).rejects.toThrow(/SHARE_SUM_MISMATCH/);

      const pr6 = await propertyReference();
      const b6 = await party('Sechs');
      const six = await acquisition(pr6, [b6], { acquiredShare: { numerator: 1, denominator: 2 } });
      await insertOwnership(pool, { pr: pr6, owner: b6, share: [1, 2], acquisitionId: six });
      await expect(rawConfirm(pool, six)).rejects.toThrow(/OWNERSHIP_INCOMPLETE/);

      const fine = await ready();
      await rawConfirm(pool, fine.id);
    });

    it('a status step raises version by exactly one; a raw void of a confirmed Ownership is refused, a raw close allowed', async () => {
      const { id, own } = await ready();
      await expect(pool.query(`UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now() WHERE id = $1`, [id])).rejects.toThrow(/must raise version/);
      await expect(pool.query(`UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), version = version + 2 WHERE id = $1`, [id])).rejects.toThrow(
        /must raise version/,
      );
      await rawConfirm(pool, id);
      await expect(rawVoid(pool, own[0] ?? '')).rejects.toThrow(/ACQUISITION_CONFIRMED/);
      await pool.query(`UPDATE ownership SET valid_until = '2030-12-31', version = version + 1 WHERE id = $1`, [own[0]]);
      const draft = await acquisition(await propertyReference(), [await party('X')]);
      await expect(
        pool.query(`UPDATE acquisition SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'x', version = version + 2 WHERE id = $1`, [
          draft,
        ]),
      ).rejects.toThrow(/must raise version/);
    });
  });

  describe('concurrency through the repository (READ COMMITTED: the confirm that waits sees the other write)', () => {
    it('against an Ownership create: the missing half arrives and the confirm succeeds', async () => {
      const pr = await propertyReference();
      const [ben, keeper] = [await party('Ben'), await party('Bleibt')];
      const id = await acquisition(pr, [ben], { acquiredShare: { numerator: 1, denominator: 2 } });
      await insertOwnership(pool, { pr, owner: ben, share: [1, 2], acquisitionId: id });
      const outcome = await whileHeld(
        (h) => insertOwnership(h, { pr, owner: keeper, share: [1, 2], from: '2020-01-01' }),
        () => acquisitions.confirm(id, REALM, AT, actor),
        '"property_reference"',
      );
      expect(outcome.kind).toBe('CONFIRMED');
    });

    it('against a close: the co-owner leaves before the transfer date, the confirm sees it INCOMPLETE', async () => {
      const pr = await propertyReference();
      const [ben, keeper] = [await party('Ben'), await party('Bleibt')];
      const keepers = await insertOwnership(pool, { pr, owner: keeper, share: [1, 2], from: '2020-01-01' });
      const id = await acquisition(pr, [ben], { acquiredShare: { numerator: 1, denominator: 2 } });
      await insertOwnership(pool, { pr, owner: ben, share: [1, 2], acquisitionId: id });
      const outcome = await whileHeld(
        (h) => h.query(`UPDATE ownership SET valid_until = '2026-07-31', version = version + 1 WHERE id = $1`, [keepers]),
        () => acquisitions.confirm(id, REALM, AT, actor),
        '"property_reference"',
      );
      expect(outcome).toMatchObject({ kind: 'CONFIRMATION_BLOCKED', violations: [{ code: 'OWNERSHIP_INCOMPLETE' }] });
    });

    it('against a void of its Ownership, a deactivate of a buyer, and a cancel', async () => {
      const a = await ready();
      expect(
        await whileHeld(
          (h) => rawVoid(h, a.own[0] ?? ''),
          () => acquisitions.confirm(a.id, REALM, AT, actor),
          '"property_reference"',
        ),
      ).toMatchObject({
        kind: 'CONFIRMATION_BLOCKED',
        violations: [{ code: 'BUYER_WITHOUT_OWNERSHIP', partyId: a.anna }, { code: 'SHARE_SUM_MISMATCH' }, { code: 'OWNERSHIP_INCOMPLETE' }],
      });
      const b = await ready();
      expect(
        await whileHeld(
          (h) => rawDeactivate(h, b.ben),
          () => acquisitions.confirm(b.id, REALM, AT, actor),
          '"party"',
        ),
      ).toMatchObject({
        kind: 'CONFIRMATION_BLOCKED',
        violations: [{ code: 'BUYER_INACTIVE', partyId: b.ben }],
      });
      // A cancellable draft carries no VALID Ownerships (§27.1): the cancel commits, the confirm that waited sees it.
      const c = await acquisition(await propertyReference(), [await party('Carl')]);
      const cancelled = await whileHeld(
        (h) =>
          h.query(`UPDATE acquisition SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'x', version = version + 1 WHERE id = $1`, [c]),
        () => acquisitions.confirm(c, REALM, AT, actor),
        '"acquisition"',
      );
      expect(cancelled).toEqual({ kind: 'ACQUISITION_CANCELLED' });
    });

    it('a void of its Ownership waits for a confirm in flight and is then refused', async () => {
      const { id, own } = await ready();
      const outcome = await whileHeld(
        (h) => rawConfirm(h, id),
        () => ownerships.void(own[0] ?? '', REALM, 'x', AT, actor),
        '"acquisition"',
      );
      expect(outcome).toEqual({ kind: 'ACQUISITION_CONFIRMED', acquisitionId: id });
    });
  });

  describe('concurrency past the repository (REPEATABLE READ: a forbidden write fails to serialise, an allowed one commits)', () => {
    /** `lockText` null: the second is not expected to wait at all. */
    async function race(
      first: (c: pg.PoolClient) => Promise<unknown>,
      second: (c: pg.PoolClient) => Promise<unknown>,
      lockText: string | null,
    ): Promise<string> {
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
        // A waiter must be seen waiting first; a non-waiter finishes on its own before the first commits.
        if (lockText === null) await late;
        else await waitForLock(lockText);
        await one.query('COMMIT');
        const result = await late;
        await two.query('ROLLBACK');
        return result;
      } finally {
        one.release();
        two.release();
      }
    }

    it('a raw confirm against a void of its Ownership, an insert carrying its id, a deactivate of a buyer: 40001', async () => {
      const a = await ready();
      expect(
        await race(
          (x) => rawVoid(x, a.own[0] ?? ''),
          (y) => rawConfirm(y, a.id),
          'UPDATE acquisition SET status',
        ),
      ).toBe('40001');
      const pr = await propertyReference();
      const [ben, carl] = [await party('Ben'), await party('Carl')];
      const b = await acquisition(pr, [ben], { acquiredShare: { numerator: 1, denominator: 2 } });
      await insertOwnership(pool, { pr, owner: ben, share: [1, 2], acquisitionId: b });
      await insertOwnership(pool, { pr, owner: carl, share: [1, 4], from: '2020-01-01' });
      // A buyer-less extra Ownership carrying the id would make OWNER_NOT_A_BUYER; the stale confirm must not miss it.
      const dora = await party('Dora');
      expect(
        await race(
          (x) => insertOwnership(x, { pr, owner: dora, share: [1, 4], acquisitionId: b }),
          (y) => rawConfirm(y, b),
          'UPDATE acquisition SET status',
        ),
      ).toBe('40001');
      const c = await ready();
      expect(
        await race(
          (x) => rawDeactivate(x, c.anna),
          (y) => rawConfirm(y, c.id),
          'UPDATE acquisition SET status',
        ),
      ).toBe('40001');
    });

    it('a raw confirm against a raw close of another owner: both commit (serially equivalent)', async () => {
      const pr = await propertyReference();
      const [ben, keeper] = [await party('Ben'), await party('Bleibt')];
      const keepers = await insertOwnership(pool, { pr, owner: keeper, share: [1, 2], from: '2020-01-01' });
      const id = await acquisition(pr, [ben], { acquiredShare: { numerator: 1, denominator: 2 } });
      await insertOwnership(pool, { pr, owner: ben, share: [1, 2], acquisitionId: id });
      expect(
        await race(
          (x) => x.query(`UPDATE ownership SET valid_until = '2030-12-31', version = version + 1 WHERE id = $1`, [keepers]),
          (y) => rawConfirm(y, id),
          null,
        ),
      ).toBe('committed');
      expect((await pool.query(`SELECT status FROM acquisition WHERE id = $1`, [id])).rows[0].status).toBe('CONFIRMED');
    });
  });
});
