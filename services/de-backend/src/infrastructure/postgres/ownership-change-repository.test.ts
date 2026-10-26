import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeFingerprint, parseShare, type NewOwner, type OwnershipChange, type Share } from '../../domains/ownership/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-2-04 persistence (api-design.md §26.2): the atomic change with its order of checks, closes written before
 * creates, completeness kept, the no-op, idempotency, AuditRecords, and serialisation with other writers.
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
const owner = (ownerPartyId: string, text = '1/2'): NewOwner => ({ ownerPartyId, share: share(text), sourceReferences: [], notes: null });
let counter = 0;

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresOwnershipRepository.change', () => {
  const schema = testSchemaName('ownership_change_test');
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
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f70000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function party(name: string, realm = REALM): Promise<string> {
    const outcome = await parties.create(
      { mreRealmId: realm, partyType: 'PERSON', displayName: name, firstName: null, lastName: null, legalName: null, registrationNumber: null, email: null, phone: null },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party.id;
  }
  async function holding(pr: string, ownerPartyId: string, text = '1/2', from = '2026-08-01', until: string | null = null) {
    const outcome = await ownerships.create(
      { mreRealmId: REALM, propertyReferenceId: pr, ownerPartyId, share: share(text), validFrom: day(from), validUntil: until === null ? null : day(until), acquisitionId: null, sourceReferences: [], notes: null },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.ownership;
  }
  const change = (pr: string, close: string[], create: NewOwner[], overrides: Partial<OwnershipChange> = {}): OwnershipChange => ({
    mreRealmId: REALM,
    propertyReferenceId: pr,
    effectiveDate: day('2030-01-01'),
    reason: 'Verkauf',
    close,
    create,
    acquisitionId: null,
    ...overrides,
  });
  /** A complete 50/50 ownership of Anna and Ben. */
  async function halves() {
    const pr = await propertyReference();
    const [anna, ben] = [await party('Anna'), await party('Ben')];
    const [a, b] = [await holding(pr, anna), await holding(pr, ben)];
    return { pr, anna, ben, a, b };
  }
  const auditsOf = async (id: string) =>
    (await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [id])).rows as { action: string; metadata: Record<string, unknown> }[];

  it('a sale to a third party at complete ownership: Anna ends the day before, Dora starts; complete before and after; AuditRecords', async () => {
    const { pr, ben, a, b } = await halves();
    const dora = await party('Dora');
    const outcome = await ownerships.change(change(pr, [a.id], [owner(dora)]), actor);
    expect(outcome).toMatchObject({
      kind: 'CHANGED',
      replayed: false,
      result: {
        effectiveDate: '2030-01-01',
        reason: 'Verkauf',
        closed: [{ id: a.id, validUntil: '2029-12-31', version: 2 }],
        created: [{ ownerPartyId: dora, validFrom: '2030-01-01', validUntil: null, share: { numerator: 1, denominator: 2 } }],
        completeness: 'COMPLETE',
        shareSum: { numerator: 1n, denominator: 1n },
      },
    });
    expect((await ownerships.on(pr, REALM, day('2029-12-31')))?.items.map((o) => o.id).sort()).toEqual([a.id, b.id].sort());
    expect((await ownerships.on(pr, REALM, day('2030-01-01')))?.items.map((o) => o.ownerPartyId).sort()).toEqual([ben, dora].sort());
    if (outcome.kind !== 'CHANGED') throw new Error(outcome.kind);
    const created = outcome.result.created[0]?.id ?? '';
    expect((await auditsOf(a.id)).at(-1)).toEqual({
      action: 'CLOSED',
      metadata: { reason: 'Verkauf', effectiveDate: '2030-01-01', validUntil: { from: null, to: '2029-12-31' } },
    });
    expect(await auditsOf(created)).toMatchObject([{ action: 'CREATED', metadata: { reason: 'Verkauf', ownerPartyId: dora, share: '1/2', validFrom: '2030-01-01' } }]);
    expect(await auditsOf(pr)).toEqual([
      {
        action: 'OWNERSHIP_CHANGED',
        metadata: { reason: 'Verkauf', effectiveDate: '2030-01-01', closedOwnershipIds: [a.id], createdOwnershipIds: [created] },
      },
    ]);
  });

  it('a share change of the same owner: Anna buys Ben\'s half; closes are written before the create, so it does not overlap', async () => {
    const { pr, anna, a, b } = await halves();
    const outcome = await ownerships.change(change(pr, [b.id, a.id], [owner(anna, '1/1')]), actor);
    expect(outcome).toMatchObject({
      kind: 'CHANGED',
      result: { closed: [{ id: b.id }, { id: a.id }], created: [{ ownerPartyId: anna, share: { numerator: 1, denominator: 1 } }], completeness: 'COMPLETE' },
    });
  });

  it('an inheritance: the deceased (inactive) owner is closed, the heirs take over', async () => {
    const { pr, anna, b, a } = await halves();
    await parties.deactivate(anna, REALM, 'verstorben', new Date(), actor);
    const [carl, dora] = [await party('Carl'), await party('Dora')];
    expect(await ownerships.change(change(pr, [a.id], [owner(carl, '1/4'), owner(dora, '1/4')], { reason: 'Erbfall' }), actor)).toMatchObject({
      kind: 'CHANGED',
      result: { closed: [{ id: a.id }], created: [{ ownerPartyId: carl }, { ownerPartyId: dora }], completeness: 'COMPLETE' },
    });
    expect((await ownerships.findById(b.id, REALM))?.validUntil).toBeNull();
  });

  it('refusals in the order of §26.2; none writes anything, not even an AuditRecord or the key claim', async () => {
    const { pr, ben, a, b } = await halves();
    const [dora, eve] = [await party('Dora'), await party('Eve')];
    const otherPr = await propertyReference();
    const foreign = await holding(otherPr, await party('Fremd'), '1/1');
    const refused = (c: OwnershipChange) => ownerships.change(c, actor, { key: `k-${++counter}`, fingerprint: changeFingerprint(c) });

    expect(await refused(change(await propertyReference(OTHER_REALM), [], [owner(dora)]))).toEqual({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' });
    // Listed Ownerships come before the new owners.
    expect(await refused(change(pr, [foreign.id], [owner('0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b')]))).toEqual({
      kind: 'INVALID_OWNERSHIP',
      ownershipId: foreign.id,
      reason: 'NOT_FOUND',
    });
    expect(await refused(change(pr, [a.id], [owner('0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b')]))).toEqual({
      kind: 'PARTY_NOT_FOUND',
      partyId: '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b',
    });
    await parties.deactivate(eve, REALM, 'x', new Date(), actor);
    expect(await refused(change(pr, [a.id], [owner(eve)]))).toEqual({ kind: 'PARTY_INACTIVE', partyId: eve });
    expect(await refused(change(pr, [a.id], [owner(dora), owner(ben)]))).toEqual({ kind: 'OVERLAPPING_OWNERSHIP', ownershipId: b.id, createIndex: 1 });
    expect(await refused(change(pr, [], [owner(dora)]))).toEqual({
      kind: 'OWNERSHIP_TOTAL_EXCEEDS_ONE',
      date: '2030-01-01',
      shareSum: { numerator: 3n, denominator: 2n },
      createIndex: 0,
    });
    expect(await refused(change(pr, [a.id], [owner(dora, '1/3')]))).toEqual({
      kind: 'OWNERSHIP_INCOMPLETE',
      date: '2030-01-01',
      shareSum: { numerator: 5n, denominator: 6n },
    });
    expect(await refused(change(pr, [a.id], [owner(dora)], { effectiveDate: day('2026-08-01') }))).toEqual({
      kind: 'INVALID_OWNERSHIP',
      ownershipId: a.id,
      reason: 'STARTS_ON_OR_AFTER_EFFECTIVE_DATE',
    });

    expect(await ownerships.findById(a.id, REALM)).toMatchObject({ validUntil: null, version: 1 });
    expect(await auditsOf(pr)).toEqual([]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM ownership WHERE property_reference_id = $1`, [pr])).rows[0].n).toBe(2);
    expect((await pool.query(`SELECT count(*)::int AS n FROM idempotency_key WHERE scope = 'ownership.change'`)).rows[0].n).toBe(0);
  });

  it('a VOID or already ended Ownership cannot be closed; a planned later end is shortened, one ending the day before stays', async () => {
    const pr = await propertyReference();
    const [anna, ben, carl] = [await party('Anna'), await party('Ben'), await party('Carl')];
    const planned = await holding(pr, anna, '1/4', '2026-08-01', '2040-12-31');
    const ending = await holding(pr, ben, '1/4', '2026-08-01', '2029-12-31');
    const ended = await holding(pr, carl, '1/4', '2026-08-01', '2028-12-31');
    const voided = await holding(pr, carl, '1/4', '2029-01-01');
    await ownerships.void(voided.id, REALM, 'Tippfehler', new Date(), actor);
    expect(await ownerships.change(change(pr, [voided.id], []), actor)).toEqual({ kind: 'INVALID_OWNERSHIP', ownershipId: voided.id, reason: 'VOID' });
    expect(await ownerships.change(change(pr, [ended.id], []), actor)).toEqual({ kind: 'INVALID_OWNERSHIP', ownershipId: ended.id, reason: 'ALREADY_ENDED' });

    const outcome = await ownerships.change(change(pr, [planned.id, ending.id], [owner(carl, '1/1')]), actor);
    expect(outcome).toMatchObject({
      kind: 'CHANGED',
      result: { closed: [{ id: planned.id, validUntil: '2029-12-31', version: 2 }, { id: ending.id, validUntil: '2029-12-31', version: 1 }] },
    });
    // Only the shortened one gets a CLOSED record.
    expect((await auditsOf(ending.id)).map((r) => r.action)).toEqual(['CREATED']);
  });

  it('a close-only change of nothing is a no-op: UNCHANGED, no AuditRecord; with a key it stays a no-op', async () => {
    const pr = await propertyReference();
    const anna = await party('Anna');
    const o = await holding(pr, anna, '1/2', '2026-08-01', '2029-12-31');
    const c = change(pr, [o.id], []);
    expect(await ownerships.change(c, actor)).toMatchObject({ kind: 'UNCHANGED', result: { closed: [{ id: o.id, version: 1 }], created: [] } });
    expect(await ownerships.change(c, actor, { key: 'noop', fingerprint: changeFingerprint(c) })).toMatchObject({ kind: 'UNCHANGED' });
    expect(await auditsOf(pr)).toEqual([]);
  });

  it('Idempotency-Key: a retry replays the recorded result, another payload conflicts; without a key a retry overlaps', async () => {
    const { pr, a } = await halves();
    const dora = await party('Dora');
    const c = change(pr, [a.id], [owner(dora)]);
    const key = { key: 'change-1', fingerprint: changeFingerprint(c) };
    const first = await ownerships.change(c, actor, key);
    if (first.kind !== 'CHANGED') throw new Error(first.kind);
    expect(await ownerships.change(c, actor, key)).toEqual({ kind: 'CHANGED', result: first.result, replayed: true });
    const other = { ...c, reason: 'Erbfall' };
    expect(await ownerships.change(other, actor, { key: 'change-1', fingerprint: changeFingerprint(other) })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    expect(await ownerships.change(c, actor)).toMatchObject({ kind: 'OVERLAPPING_OWNERSHIP' });
  });

  it('serialises with a concurrent close of a listed Ownership (one lock order, no deadlock): the change then sees it ended', async () => {
    const { pr, a } = await halves();
    const dora = await party('Dora');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // A close past the repository: the trigger takes the PropertyReference, the row ends before the change's day.
      await holder.query(`UPDATE ownership SET valid_until = '2028-12-31', version = version + 1 WHERE id = $1`, [a.id]);
      const changing = ownerships.change(change(pr, [a.id], [owner(dora)]), actor);
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
      expect(await changing).toEqual({ kind: 'INVALID_OWNERSHIP', ownershipId: a.id, reason: 'ALREADY_ENDED' });
    } finally {
      holder.release();
    }
  });
});
