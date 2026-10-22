import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFingerprint, type NewParty } from '../../domains/party/index.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-2-01 persistence (api-design.md §19.1): Parties with AuditRecords, Idempotency-Key replay and conflict, Realm
 * scope, amend and deactivate with If-Match and no-ops, the literal name filter, and the schema's own type rules.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const person = (overrides: Partial<NewParty> = {}): NewParty => ({
  mreRealmId: REALM,
  partyType: 'PERSON',
  displayName: 'Anna Schmidt',
  firstName: 'Anna',
  lastName: 'Schmidt',
  legalName: null,
  registrationNumber: null,
  email: 'anna@example.com',
  phone: null,
  ...overrides,
});
const organization = (overrides: Partial<NewParty> = {}): NewParty => ({
  ...person(),
  partyType: 'ORGANIZATION',
  displayName: 'Hausverwaltung GmbH',
  firstName: null,
  lastName: null,
  legalName: 'Hausverwaltung GmbH',
  registrationNumber: 'HRB 1234',
  ...overrides,
});

describe.skipIf(databaseUrl === undefined)('PostgresPartyRepository', () => {
  const schema = testSchemaName('party_test');
  let pool: pg.Pool;
  let repository: PostgresPartyRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    repository = new PostgresPartyRepository(createDatabase(pool));
  });

  afterAll(async () => {
    await pool.end();
  });

  async function created(party: NewParty = person()) {
    const outcome = await repository.create(party, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party;
  }
  const audits = async (id: string) =>
    (await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_type = 'Party' AND entity_id = $1 ORDER BY occurred_at, id`, [id])).rows;

  it('creates an ACTIVE Party in the Realm with an AuditRecord; another Realm does not see it', async () => {
    const party = await created();
    expect(party).toMatchObject({ partyType: 'PERSON', displayName: 'Anna Schmidt', status: 'ACTIVE', version: 1, deactivatedAt: null });
    expect(await repository.findById(party.id, REALM)).toEqual(party);
    expect(await repository.findById(party.id, OTHER_REALM)).toBeUndefined();
    expect(await repository.findById('nope', REALM)).toBeUndefined();
    expect(await audits(party.id)).toEqual([{ action: 'CREATED', metadata: { partyType: 'PERSON' } }]);
  });

  it('Idempotency-Key: the same payload replays the recorded Party, another payload conflicts, concurrent ones create one', async () => {
    const party = person({ displayName: 'Bea Keller' });
    const key = { key: 'party-1', fingerprint: createFingerprint(party) };
    const first = await repository.create(party, actor, key);
    if (first.kind !== 'CREATED') throw new Error(first.kind);
    await repository.amend(first.party.id, REALM, { phone: '0171' }, actor);
    // The original answer, not the current state.
    expect(await repository.create(party, actor, key)).toEqual({ kind: 'REPLAYED', party: first.party });
    const other = person({ displayName: 'Carl Keller' });
    expect(await repository.create(other, actor, { key: 'party-1', fingerprint: createFingerprint(other) })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });

    const racing = person({ displayName: 'Dora Racing' });
    const raced = await Promise.all(
      Array.from({ length: 5 }, () => repository.create(racing, actor, { key: 'party-race', fingerprint: createFingerprint(racing) })),
    );
    expect(new Set(raced.map((o) => (o.kind === 'IDEMPOTENCY_CONFLICT' ? o.kind : o.party.id))).size).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM party WHERE display_name = 'Dora Racing'`)).rows[0].n).toBe(1);
  });

  it('two Parties with one name are allowed: nothing deduplicates (data-model §7.7)', async () => {
    const a = await created(person({ displayName: 'Erik Zwilling' }));
    const b = await created(person({ displayName: 'Erik Zwilling' }));
    expect(a.id).not.toBe(b.id);
  });

  it('amend: changes and audits only what differs; a no-op keeps the version whatever If-Match says', async () => {
    const party = await created();
    const amended = await repository.amend(party.id, REALM, { email: 'anna.schmidt@example.com', phone: null, lastName: 'Schmidt' }, actor, [1]);
    expect(amended).toMatchObject({ kind: 'AMENDED', changed: true, party: { email: 'anna.schmidt@example.com', version: 2 } });
    expect((await audits(party.id))[1]).toEqual({
      action: 'AMENDED',
      metadata: { changes: { email: { from: 'anna@example.com', to: 'anna.schmidt@example.com' } } },
    });
    // Same values, stale version: answered as a no-op (RFC 9110 §13.2.2).
    expect(await repository.amend(party.id, REALM, { email: 'anna.schmidt@example.com' }, actor, [1])).toMatchObject({
      kind: 'AMENDED',
      changed: false,
      party: { version: 2 },
    });
    expect(await repository.amend(party.id, REALM, { phone: '0171' }, actor, [1])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [1], currentVersion: 2 });
    expect(await repository.amend(party.id, REALM, { legalName: 'X GmbH' }, actor)).toEqual({
      kind: 'NOT_ALLOWED_FOR_TYPE',
      partyType: 'PERSON',
      fields: ['legalName'],
    });
    expect(await repository.amend(party.id, OTHER_REALM, { phone: '0171' }, actor)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('deactivate: once, with its reason; a repeat is a no-op keeping the first reason, whatever If-Match says; amend still works', async () => {
    const party = await created();
    const at = new Date('2026-10-22T08:00:00Z');
    const deactivated = await repository.deactivate(party.id, REALM, 'verstorben', at, actor, [1]);
    expect(deactivated).toMatchObject({
      kind: 'DEACTIVATED',
      changed: true,
      party: { status: 'INACTIVE', deactivatedAt: at, deactivationReason: 'verstorben', version: 2 },
    });
    expect(await repository.deactivate(party.id, REALM, 'anderer Grund', new Date(), actor, [1])).toMatchObject({
      kind: 'DEACTIVATED',
      changed: false,
      party: { deactivationReason: 'verstorben', deactivatedAt: at, version: 2 },
    });
    // A deceased owner's misspelt name stays correctable (§19.1); the status stays INACTIVE.
    expect(await repository.amend(party.id, REALM, { lastName: 'Schmid' }, actor)).toMatchObject({
      kind: 'AMENDED',
      party: { lastName: 'Schmid', status: 'INACTIVE', version: 3 },
    });
    expect((await audits(party.id)).map((a) => a.action)).toEqual(['CREATED', 'DEACTIVATED', 'AMENDED']);

    const other = await created();
    expect(await repository.deactivate(other.id, REALM, 'x', at, actor, [7])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [7], currentVersion: 1 });
    expect(await repository.deactivate(other.id, OTHER_REALM, 'x', at, actor)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('list: by displayName case-insensitively, then id; filters by type, status and a literal name substring', async () => {
    const realm = '64b0c0ffee0000000000000c';
    const mk = (overrides: Partial<NewParty>) => created({ ...person(), mreRealmId: realm, ...overrides });
    const zora = await mk({ displayName: 'zora Weber', firstName: 'Zora', lastName: 'Weber' });
    const percent = await mk({ ...organization(), mreRealmId: realm, displayName: '100% Haus GmbH', legalName: '100% Haus GmbH' });
    const underscore = await mk({ ...organization(), mreRealmId: realm, displayName: 'A_B Verwaltung', legalName: 'A_B Verwaltung' });
    const mueller = await mk({ displayName: 'Herr Müller', firstName: 'Hans', lastName: 'Müller' });
    await repository.deactivate(mueller.id, realm, 'weggezogen', new Date(), actor);
    await created(person({ displayName: 'Aaron Fremd' })); // another Realm

    const list = (filter: Parameters<typeof repository.list>[1], page = { page: 1, pageSize: 50 }) => repository.list(realm, filter, page);
    expect((await list({})).items.map((p) => p.id)).toEqual([percent.id, underscore.id, mueller.id, zora.id]);
    expect(await list({}, { page: 2, pageSize: 3 })).toMatchObject({ items: [{ id: zora.id }], total: 4 });
    expect((await list({ partyType: 'ORGANIZATION' })).items.map((p) => p.id)).toEqual([percent.id, underscore.id]);
    expect((await list({ status: 'INACTIVE' })).items.map((p) => p.id)).toEqual([mueller.id]);
    // Literal: % and _ match themselves, not every Party or any one character (§19.1).
    expect((await list({ name: '%' })).items.map((p) => p.id)).toEqual([percent.id]);
    expect((await list({ name: '_' })).items.map((p) => p.id)).toEqual([underscore.id]);
    expect((await list({ name: 'a_b' })).items.map((p) => p.id)).toEqual([underscore.id]);
    expect((await list({ name: '\\' })).total).toBe(0);
    // Case-insensitive over displayName, legalName, firstName and lastName; no ß/ss or umlaut folding.
    expect((await list({ name: 'WEBER' })).items.map((p) => p.id)).toEqual([zora.id]);
    expect((await list({ name: 'hans' })).items.map((p) => p.id)).toEqual([mueller.id]);
    expect((await list({ name: 'muller' })).total).toBe(0);
  });

  it('the schema refuses fields of the other type and inconsistent deactivation (also past the repository)', async () => {
    const insert = (columns: string, values: string) =>
      pool.query(`INSERT INTO party (mre_realm_id, party_type, display_name, status, created_by${columns}) VALUES ($1, $2, 'X', $3, 'x'${values})`, [
        REALM,
        'PERSON',
        'ACTIVE',
      ]);
    await expect(insert(', legal_name', ", 'X GmbH'")).rejects.toThrow(/party_type_fields/);
    await expect(insert(', deactivated_at', ', now()')).rejects.toThrow(/party_deactivation/);
    await expect(
      pool.query(`INSERT INTO party (mre_realm_id, party_type, display_name, status, created_by) VALUES ($1, 'COMPANY', 'X', 'ACTIVE', 'x')`, [REALM]),
    ).rejects.toThrow(/party_party_type_check/);
  });
});
