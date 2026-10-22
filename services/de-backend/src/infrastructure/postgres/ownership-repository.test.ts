import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFingerprint, parseShare, type NewOwnership, type Share } from '../../domains/ownership/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-2-03 persistence (api-design.md §26.1): create with its order of checks and the invariants, close, void, the
 * reads, the schema's own rules, and the serialisation of two writers of one PropertyReference under RC and RR.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const share = (text: string): Share => {
  const parsed = parseShare(text);
  if (!('share' in parsed)) throw new Error(text);
  return parsed.share;
};
let counter = 0;

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresOwnershipRepository', () => {
  const schema = testSchemaName('ownership_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let ownerships: PostgresOwnershipRepository;

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
  });

  afterAll(async () => {
    await pool.end();
  });

  async function propertyReference(realm = REALM): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f60000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function owner(name = 'Anna Schmidt', realm = REALM): Promise<string> {
    const outcome = await parties.create(
      { mreRealmId: realm, partyType: 'PERSON', displayName: name, firstName: null, lastName: null, legalName: null, registrationNumber: null, email: null, phone: null },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party.id;
  }
  const draft = (overrides: Partial<NewOwnership> & Pick<NewOwnership, 'propertyReferenceId' | 'ownerPartyId'>): NewOwnership => ({
    mreRealmId: REALM,
    share: share('1/2'),
    validFrom: day('2026-08-01'),
    validUntil: null,
    sourceReferences: [],
    notes: null,
    ...overrides,
  });
  async function created(ownership: NewOwnership) {
    const outcome = await ownerships.create(ownership, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.ownership;
  }

  it('create: a VALID Ownership with its share reduced, dates as given, and an AuditRecord', async () => {
    const pr = await propertyReference();
    const anna = await owner();
    const ownership = await created(
      draft({ propertyReferenceId: pr, ownerPartyId: anna, share: share('2/4'), validUntil: day('2035-03-31'), sourceReferences: ['Grundbuch Blatt 1234'], notes: 'Kauf' }),
    );
    expect(ownership).toMatchObject({
      mreRealmId: REALM,
      propertyReferenceId: pr,
      ownerPartyId: anna,
      share: { numerator: 1, denominator: 2 },
      validFrom: '2026-08-01',
      validUntil: '2035-03-31',
      status: 'VALID',
      voidedAt: null,
      acquisitionId: null,
      sourceReferences: ['Grundbuch Blatt 1234'],
      notes: 'Kauf',
      version: 1,
    });
    expect(await ownerships.findById(ownership.id, REALM)).toEqual(ownership);
    expect(await ownerships.findById(ownership.id, OTHER_REALM)).toBeUndefined();
    expect((await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_type = 'Ownership' AND entity_id = $1`, [ownership.id])).rows).toEqual([
      {
        action: 'CREATED',
        metadata: { propertyReferenceId: pr, ownerPartyId: anna, share: '1/2', validFrom: '2026-08-01', validUntil: '2035-03-31' },
      },
    ]);
  });

  it('create: the order of checks; a refusal writes nothing, not even the key claim', async () => {
    const pr = await propertyReference();
    const anna = await owner();
    const foreignPr = await propertyReference(OTHER_REALM);
    const foreignParty = await owner('Fremd', OTHER_REALM);
    const key = (o: NewOwnership) => ({ key: `k-${o.propertyReferenceId}-${o.ownerPartyId}`, fingerprint: createFingerprint(o) });
    const attempt = (o: NewOwnership) => ownerships.create(o, actor, key(o));
    expect(await attempt(draft({ propertyReferenceId: foreignPr, ownerPartyId: foreignParty }))).toEqual({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' });
    expect(await attempt(draft({ propertyReferenceId: pr, ownerPartyId: foreignParty }))).toEqual({ kind: 'PARTY_NOT_FOUND' });
    await parties.deactivate(anna, REALM, 'verstorben', new Date(), actor);
    expect(await attempt(draft({ propertyReferenceId: pr, ownerPartyId: anna }))).toEqual({ kind: 'PARTY_INACTIVE' });
    expect((await pool.query(`SELECT count(*)::int AS n FROM ownership WHERE property_reference_id = $1`, [pr])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM idempotency_key WHERE scope = 'ownership.create' AND key LIKE $1`, [`k-${pr}%`])).rows[0].n).toBe(0);
  });

  it('create: Idempotency-Key replays the recorded Ownership, another payload conflicts; without a key a repeat overlaps', async () => {
    const pr = await propertyReference();
    const anna = await owner();
    const ownership = draft({ propertyReferenceId: pr, ownerPartyId: anna });
    const key = { key: 'own-1', fingerprint: createFingerprint(ownership) };
    const first = await ownerships.create(ownership, actor, key);
    if (first.kind !== 'CREATED') throw new Error(first.kind);
    await ownerships.close(first.ownership.id, REALM, day('2030-12-31'), actor);
    expect(await ownerships.create(ownership, actor, key)).toEqual({ kind: 'REPLAYED', ownership: first.ownership });
    const other = { ...ownership, share: share('1/3') };
    expect(await ownerships.create(other, actor, { key: 'own-1', fingerprint: createFingerprint(other) })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    expect(await ownerships.create(ownership, actor)).toEqual({ kind: 'OVERLAPPING_OWNERSHIP', ownershipId: first.ownership.id });
  });

  it('invariants: no overlap per owner; no day above 1, exactly; VOID counts nowhere', async () => {
    const pr = await propertyReference();
    const [anna, ben, carl] = [await owner('Anna'), await owner('Ben'), await owner('Carl')];
    const a = await created(draft({ propertyReferenceId: pr, ownerPartyId: anna, share: share('1/3'), validUntil: day('2030-12-31') }));
    // The same owner again, adjacent: allowed; overlapping by one day: refused.
    await created(draft({ propertyReferenceId: pr, ownerPartyId: anna, share: share('1/3'), validFrom: day('2031-01-01') }));
    expect(await ownerships.create(draft({ propertyReferenceId: pr, ownerPartyId: anna, validFrom: day('2030-12-31'), validUntil: day('2030-12-31') }), actor)).toEqual({
      kind: 'OVERLAPPING_OWNERSHIP',
      ownershipId: a.id,
    });
    // Three thirds are exactly complete; a fourth share is above 1 on its first day.
    const b = await created(draft({ propertyReferenceId: pr, ownerPartyId: ben, share: share('1/3') }));
    await created(draft({ propertyReferenceId: pr, ownerPartyId: carl, share: share('1/3'), validFrom: day('2027-01-01') }));
    const dora = await owner('Dora');
    expect(await ownerships.create(draft({ propertyReferenceId: pr, ownerPartyId: dora, share: share('1/10000') }), actor)).toEqual({
      kind: 'OWNERSHIP_TOTAL_EXCEEDS_ONE',
      date: '2027-01-01',
      shareSum: { numerator: 10001n, denominator: 10000n },
    });
    // Before Carl starts, there is room: a period ending the day before is allowed.
    await created(draft({ propertyReferenceId: pr, ownerPartyId: dora, share: share('1/3'), validUntil: day('2026-12-31') }));
    // Voiding Ben frees his third.
    await ownerships.void(b.id, REALM, '1/3 statt 1/2 erfasst', new Date(), actor);
    await created(draft({ propertyReferenceId: pr, ownerPartyId: ben, share: share('1/3'), validFrom: day('2027-01-01') }));
  });

  it('close: sets or shortens validUntil, never extends; the same day is a no-op whatever If-Match says; refusals as P2-D5', async () => {
    const pr = await propertyReference();
    const anna = await owner();
    const o = await created(draft({ propertyReferenceId: pr, ownerPartyId: anna, validUntil: day('2040-12-31') }));
    expect(await ownerships.close(o.id, REALM, day('2026-07-31'), actor)).toEqual({ kind: 'INVALID_OWNERSHIP', reason: 'STARTS_ON_OR_AFTER_EFFECTIVE_DATE' });
    expect(await ownerships.close(o.id, REALM, day('2035-03-31'), actor, [7])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [7], currentVersion: 1 });
    const closed = await ownerships.close(o.id, REALM, day('2035-03-31'), actor, [1]);
    expect(closed).toMatchObject({ kind: 'CLOSED', changed: true, ownership: { validUntil: '2035-03-31', version: 2 } });
    expect(await ownerships.close(o.id, REALM, day('2035-03-31'), actor, [1])).toMatchObject({ kind: 'CLOSED', changed: false, ownership: { version: 2 } });
    expect(await ownerships.close(o.id, REALM, day('2036-01-01'), actor)).toEqual({ kind: 'INVALID_OWNERSHIP', reason: 'ALREADY_ENDED' });
    // A one-day period is allowed.
    expect(await ownerships.close(o.id, REALM, day('2026-08-01'), actor)).toMatchObject({ kind: 'CLOSED', ownership: { validUntil: '2026-08-01' } });
    expect((await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [o.id])).rows.slice(1)).toEqual([
      { action: 'CLOSED', metadata: { validUntil: { from: '2040-12-31', to: '2035-03-31' } } },
      { action: 'CLOSED', metadata: { validUntil: { from: '2035-03-31', to: '2026-08-01' } } },
    ]);
    // An inactive owner's Ownership can still be closed (inheritance).
    const ben = await owner('Ben');
    const inherited = await created(draft({ propertyReferenceId: pr, ownerPartyId: ben, validFrom: day('2027-01-01') }));
    await parties.deactivate(ben, REALM, 'verstorben', new Date(), actor);
    expect(await ownerships.close(inherited.id, REALM, day('2030-06-30'), actor)).toMatchObject({ kind: 'CLOSED', changed: true });
    expect(await ownerships.close(o.id, OTHER_REALM, day('2026-08-01'), actor)).toEqual({ kind: 'NOT_FOUND' });
    expect(await ownerships.close('nope', REALM, day('2026-08-01'), actor)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('void: once, with its reason; a repeat keeps the first reason whatever If-Match says; a VOID one cannot be closed', async () => {
    const pr = await propertyReference();
    const anna = await owner();
    const o = await created(draft({ propertyReferenceId: pr, ownerPartyId: anna }));
    const at = new Date('2026-10-22T10:00:00Z');
    expect(await ownerships.void(o.id, REALM, 'x', at, actor, [9])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [9], currentVersion: 1 });
    expect(await ownerships.void(o.id, REALM, 'falscher Anteil', at, actor, [1])).toMatchObject({
      kind: 'VOIDED',
      changed: true,
      ownership: { status: 'VOID', voidedAt: at, voidReason: 'falscher Anteil', version: 2 },
    });
    expect(await ownerships.void(o.id, REALM, 'anders', new Date(), actor, [1])).toMatchObject({
      kind: 'VOIDED',
      changed: false,
      ownership: { voidReason: 'falscher Anteil', voidedAt: at, version: 2 },
    });
    expect(await ownerships.close(o.id, REALM, day('2030-01-01'), actor)).toEqual({ kind: 'INVALID_OWNERSHIP', reason: 'VOID' });
    expect(await ownerships.void(o.id, OTHER_REALM, 'x', at, actor)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('reads: asOf with derived completeness and the exact shareSum; the history pages with VOID included', async () => {
    const pr = await propertyReference();
    const [anna, ben] = [await owner('Anna'), await owner('Ben')];
    const a1 = await created(draft({ propertyReferenceId: pr, ownerPartyId: anna, validUntil: day('2035-03-31') }));
    const b1 = await created(draft({ propertyReferenceId: pr, ownerPartyId: ben, validUntil: day('2035-03-31') }));
    const wrong = await created(draft({ propertyReferenceId: pr, ownerPartyId: ben, share: share('1/3'), validFrom: day('2040-01-01'), validUntil: day('2040-12-31') }));
    await ownerships.void(wrong.id, REALM, 'Tippfehler', new Date(), actor);
    // Voided, it no longer counts: Anna's whole share from 2035 fits.
    const a2 = await created(draft({ propertyReferenceId: pr, ownerPartyId: anna, share: share('1/1'), validFrom: day('2035-04-01') }));

    // data-model §78: a 2030 report uses 50/50, a 2036 report 100/0.
    expect(await ownerships.on(pr, REALM, day('2030-06-30'))).toMatchObject({
      completeness: 'COMPLETE',
      shareSum: { numerator: 1n, denominator: 1n },
      items: [{ id: a1.id < b1.id ? a1.id : b1.id }, { id: a1.id < b1.id ? b1.id : a1.id }],
    });
    expect(await ownerships.on(pr, REALM, day('2036-01-01'))).toMatchObject({ completeness: 'COMPLETE', items: [{ id: a2.id }] });
    expect(await ownerships.on(pr, REALM, day('2026-07-31'))).toMatchObject({ completeness: 'NONE', shareSum: { numerator: 0n, denominator: 1n }, items: [] });
    await ownerships.close(b1.id, REALM, day('2030-12-31'), actor);
    expect(await ownerships.on(pr, REALM, day('2031-01-01'))).toMatchObject({ completeness: 'INCOMPLETE', shareSum: { numerator: 1n, denominator: 2n } });
    expect(await ownerships.on(pr, OTHER_REALM, day('2030-06-30'))).toBeUndefined();

    const history = await ownerships.history(pr, REALM, { page: 1, pageSize: 50 });
    expect(history?.items.map((o) => [o.validFrom, o.status])).toEqual([
      ['2026-08-01', 'VALID'],
      ['2026-08-01', 'VALID'],
      ['2035-04-01', 'VALID'],
      ['2040-01-01', 'VOID'],
    ]);
    expect(await ownerships.history(pr, REALM, { page: 2, pageSize: 3 })).toMatchObject({ items: [{ id: wrong.id }], total: 4 });
    expect(await ownerships.history(pr, OTHER_REALM, { page: 1, pageSize: 50 })).toBeUndefined();
  });

  it('the schema: Realm-bound keys, reduced shares, periods, VOID consistency, frozen fields, and the invariant trigger past the repository', async () => {
    const pr = await propertyReference();
    const [anna, ben] = [await owner('Anna'), await owner('Ben')];
    const insert = (values: { realm?: string; owner?: string; n?: number; d?: number; from?: string; until?: string | null; status?: string }) =>
      pool.query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, valid_until, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'x') RETURNING id`,
        [values.realm ?? REALM, pr, values.owner ?? anna, values.n ?? 1, values.d ?? 2, values.from ?? '2026-08-01', values.until ?? null, values.status ?? 'VALID'],
      );
    await expect(insert({ realm: OTHER_REALM })).rejects.toThrow(/ownership_property_reference_fk/);
    await expect(insert({ n: 2, d: 4 })).rejects.toThrow(/ownership_share/);
    await expect(insert({ n: 3, d: 2 })).rejects.toThrow(/ownership_share/);
    await expect(insert({ n: 1, d: 10001 })).rejects.toThrow(/ownership_share/);
    await expect(insert({ until: '2026-07-31' })).rejects.toThrow(/ownership_period/);
    await expect(insert({ status: 'VOID' })).rejects.toThrow(/ownership_void/);

    const { rows } = await insert({ until: '2030-12-31' });
    const id = rows[0].id as string;
    await expect(insert({ from: '2030-12-31' })).rejects.toThrow(/OVERLAPPING_OWNERSHIP/);
    await insert({ owner: ben });
    await expect(insert({ owner: (await owner('Carl')), n: 1, d: 10000 })).rejects.toThrow(/OWNERSHIP_TOTAL_EXCEEDS_ONE/);

    const update = (set: string) => pool.query(`UPDATE ownership SET ${set} WHERE id = $1`, [id]);
    await expect(update(`share_numerator = 1, share_denominator = 3`)).rejects.toThrow(/never change/);
    await expect(update(`owner_party_id = '${ben}'`)).rejects.toThrow(/never change/);
    await expect(update(`valid_from = '2026-09-01'`)).rejects.toThrow(/never change/);
    await expect(update(`valid_until = '2031-01-01'`)).rejects.toThrow(/never extended/);
    await expect(update(`valid_until = NULL`)).rejects.toThrow(/never extended/);
    await update(`valid_until = '2029-12-31'`);
    await update(`status = 'VOID', voided_at = now(), void_reason = 'x'`);
    await expect(update(`status = 'VALID', voided_at = NULL, void_reason = NULL`)).rejects.toThrow(/VOID is final/);
  });

  it('the Party guards (0018): party_type is fixed, INACTIVE is final with its time and reason', async () => {
    const anna = await owner('Anna Guard');
    await expect(pool.query(`UPDATE party SET party_type = 'ORGANIZATION', first_name = NULL, last_name = NULL WHERE id = $1`, [anna])).rejects.toThrow(
      /party_type is fixed/,
    );
    await parties.deactivate(anna, REALM, 'verstorben', new Date(), actor);
    await expect(
      pool.query(`UPDATE party SET status = 'ACTIVE', deactivated_at = NULL, deactivation_reason = NULL WHERE id = $1`, [anna]),
    ).rejects.toThrow(/INACTIVE is final/);
    await expect(pool.query(`UPDATE party SET deactivation_reason = 'anders' WHERE id = $1`, [anna])).rejects.toThrow(/INACTIVE is final/);
    // Amending an inactive Party's data stays allowed (§19.1).
    expect(await parties.amend(anna, REALM, { displayName: 'Anna G.' }, actor)).toMatchObject({ kind: 'AMENDED', changed: true });
  });

  it('two writers of one PropertyReference serialise: under READ COMMITTED the second sees the first and is refused', async () => {
    const pr = await propertyReference();
    const [anna, ben, carl] = [await owner('Anna'), await owner('Ben'), await owner('Carl')];
    await created(draft({ propertyReferenceId: pr, ownerPartyId: anna }));
    // Ben's 1/2 is in flight (uncommitted, its trigger holds the PropertyReference) when Carl's 1/2 arrives.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, created_by)
         VALUES ($1, $2, $3, 1, 2, '2026-08-01', 'VALID', 'x')`,
        [REALM, pr, ben],
      );
      const carls = ownerships.create(draft({ propertyReferenceId: pr, ownerPartyId: carl }), actor);
      await waitUntil(async () =>
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"property_reference"%'`,
            )
          ).rows[0].count,
        ) >= 1,
      );
      await holder.query('COMMIT');
      expect(await carls).toEqual({ kind: 'OWNERSHIP_TOTAL_EXCEEDS_ONE', date: '2026-08-01', shareSum: { numerator: 3n, denominator: 2n } });
    } finally {
      holder.release();
    }
  });

  it('two writers of one PropertyReference under REPEATABLE READ: exactly one commits, the other fails to serialise', async () => {
    const pr = await propertyReference();
    const [anna, ben, carl] = [await owner('Anna'), await owner('Ben'), await owner('Carl')];
    await created(draft({ propertyReferenceId: pr, ownerPartyId: anna }));
    const [first, second] = [await pool.connect(), await pool.connect()];
    const insert = (client: pg.PoolClient, party: string) =>
      client.query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, created_by)
         VALUES ($1, $2, $3, 1, 2, '2026-08-01', 'VALID', 'x')`,
        [REALM, pr, party],
      );
    try {
      await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      // Both snapshots are taken before either writes: each alone sees only Anna's 1/2.
      await first.query('SELECT count(*) FROM ownership');
      await second.query('SELECT count(*) FROM ownership');
      await insert(first, ben);
      const late = insert(second, carl).then(
        () => 'inserted',
        (error: { code?: string }) => error.code,
      );
      await waitUntil(async () =>
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%INSERT INTO ownership%'`,
            )
          ).rows[0].count,
        ) >= 1,
      );
      await first.query('COMMIT');
      expect(await late).toBe('40001');
      await second.query('ROLLBACK');
    } finally {
      first.release();
      second.release();
    }
    const holders = (await pool.query(`SELECT count(*)::int AS n FROM ownership WHERE property_reference_id = $1 AND status = 'VALID'`, [pr])).rows[0].n;
    expect(holders).toBe(2);
  });

  it('a new owner racing deactivate: once the deactivation commits, the create sees PARTY_INACTIVE', async () => {
    const pr = await propertyReference();
    const anna = await owner();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM party WHERE id = $1 FOR UPDATE`, [anna]);
      const create = ownerships.create(draft({ propertyReferenceId: pr, ownerPartyId: anna }), actor);
      await waitUntil(async () =>
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%from "party"%for share%'`,
            )
          ).rows[0].count,
        ) >= 1,
      );
      await holder.query(`UPDATE party SET status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'x', version = version + 1 WHERE id = $1`, [anna]);
      await holder.query('COMMIT');
      expect(await create).toEqual({ kind: 'PARTY_INACTIVE' });
    } finally {
      holder.release();
    }
  });
});
