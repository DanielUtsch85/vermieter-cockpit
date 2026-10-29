import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMea, type Mea, type NewMembership, type NewWeg } from '../../domains/weg/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresWegRepository } from './weg-repository.js';

/**
 * VC-6-01 persistence (api-design.md §49.1–§49.2): WEG create, amend, void; membership create with its order of
 * checks, amend, end, void; the reads; the schema's own rules past the repository; the serialisation of two writers
 * of one unit and of a WEG void against a membership create under RC and RR; and `down`.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000060';
const OTHER_REALM = '64b0c0ffee00000000000061';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const mea = (text: string): Mea => {
  const parsed = parseMea(text);
  if (!('mea' in parsed)) throw new Error(text);
  return parsed.mea;
};
let counter = 0;

/** Runs `work` under the session advisory lock that migrations and schema teardown take (migrate.ts). */
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

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The trigger's own reason or the constraint's name, to tell guards apart that share an error code. */
function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return (
    error.constraint ??
    /\(([A-Z_]+)\)|VOID is final|never extended|never change|nothing else|exactly one|never deleted|only inserted/.exec(error.message ?? '')?.[0] ??
    error.code ??
    'error'
  );
}

describe.skipIf(databaseUrl === undefined)('PostgresWegRepository', () => {
  const schema = testSchemaName('weg_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let wegs: PostgresWegRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    wegs = new PostgresWegRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function unit(realm = REALM): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f60000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function party(realm = REALM): Promise<string> {
    const outcome = await parties.create(
      {
        mreRealmId: realm,
        partyType: 'ORGANIZATION',
        displayName: `Verwaltung ${++counter}`,
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
  const newWeg = (overrides: Partial<NewWeg> = {}): NewWeg => ({
    mreRealmId: REALM,
    displayName: `WEG ${++counter}`,
    administratorPartyId: null,
    financialYearStartMonth: 1,
    notes: null,
    ...overrides,
  });
  async function weg(overrides: Partial<NewWeg> = {}) {
    const outcome = await wegs.createWeg(newWeg(overrides), actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.weg;
  }
  const newMembership = (overrides: Partial<NewMembership> & Pick<NewMembership, 'wegId' | 'propertyReferenceId'>): NewMembership => ({
    mreRealmId: REALM,
    mea: mea('125.5/10000'),
    validFrom: day('2024-01-01'),
    validUntil: null,
    sourceReferences: [],
    notes: null,
    ...overrides,
  });
  async function membership(overrides: Partial<NewMembership> & Pick<NewMembership, 'wegId' | 'propertyReferenceId'>) {
    const outcome = await wegs.createMembership(newMembership(overrides), actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.membership;
  }
  const audit = async (id: string) =>
    (await pool.query(`SELECT entity_type, action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [id])).rows;

  describe('WEG', () => {
    it('create: ACTIVE, version 1, the administrator and an AuditRecord; a replay answers the first WEG', async () => {
      const administrator = await party();
      const outcome = await wegs.createWeg(newWeg({ displayName: 'Musterstraße 1', administratorPartyId: administrator, financialYearStartMonth: 7 }), actor, {
        key: 'k-weg-1',
        fingerprint: 'f1',
      });
      expect(outcome).toMatchObject({
        kind: 'CREATED',
        weg: { status: 'ACTIVE', version: 1, displayName: 'Musterstraße 1', administratorPartyId: administrator, financialYearStartMonth: 7 },
      });
      if (outcome.kind !== 'CREATED') return;
      expect(await audit(outcome.weg.id)).toEqual([
        {
          entity_type: 'Weg',
          action: 'CREATED',
          metadata: { displayName: 'Musterstraße 1', administratorPartyId: administrator, financialYearStartMonth: 7 },
        },
      ]);
      expect(await wegs.createWeg(newWeg(), actor, { key: 'k-weg-1', fingerprint: 'f1' })).toMatchObject({ kind: 'REPLAYED', weg: { id: outcome.weg.id } });
      expect(await wegs.createWeg(newWeg(), actor, { key: 'k-weg-1', fingerprint: 'other' })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    });

    it('create: an unknown or foreign administrator is PARTY_NOT_FOUND, an inactive one PARTY_INACTIVE; nothing is written', async () => {
      const foreign = await party(OTHER_REALM);
      expect(await wegs.createWeg(newWeg({ administratorPartyId: foreign }), actor)).toEqual({ kind: 'PARTY_NOT_FOUND', partyId: foreign });
      const inactive = await party();
      await parties.deactivate(inactive, REALM, 'aufgelöst', new Date(), actor);
      expect(await wegs.createWeg(newWeg({ administratorPartyId: inactive, displayName: 'Nie' }), actor)).toEqual({
        kind: 'PARTY_INACTIVE',
        partyId: inactive,
      });
      expect((await pool.query(`SELECT count(*)::int AS n FROM weg WHERE display_name = 'Nie'`)).rows[0].n).toBe(0);
    });

    it('amend: changed fields with version + 1 and an AuditRecord; the same values are a no-op; a stale If-Match is 412', async () => {
      const w = await weg();
      expect(await wegs.amendWeg(w.id, REALM, { displayName: w.displayName }, actor, [7])).toMatchObject({
        kind: 'AMENDED',
        changed: false,
        weg: { version: 1 },
      });
      expect(await wegs.amendWeg(w.id, REALM, { notes: 'Beirat: 3 Personen' }, actor, [7])).toEqual({
        kind: 'VERSION_CONFLICT',
        expectedVersions: [7],
        currentVersion: 1,
      });
      expect(await wegs.amendWeg(w.id, REALM, { notes: 'Beirat: 3 Personen', financialYearStartMonth: 4 }, actor, [1])).toMatchObject({
        kind: 'AMENDED',
        changed: true,
        weg: { version: 2, notes: 'Beirat: 3 Personen', financialYearStartMonth: 4 },
      });
      expect((await audit(w.id)).at(-1)).toEqual({
        entity_type: 'Weg',
        action: 'AMENDED',
        metadata: { changes: { financialYearStartMonth: { from: 1, to: 4 }, notes: { from: null, to: 'Beirat: 3 Personen' } } },
      });
    });

    it('amend: a newly named administrator is checked, after WEG_NOT_ACTIVE', async () => {
      const w = await weg();
      const inactive = await party();
      await parties.deactivate(inactive, REALM, 'aufgelöst', new Date(), actor);
      expect(await wegs.amendWeg(w.id, REALM, { administratorPartyId: inactive }, actor)).toEqual({ kind: 'PARTY_INACTIVE', partyId: inactive });
      await wegs.voidWeg(w.id, REALM, 'Fehler', new Date(), actor);
      expect(await wegs.amendWeg(w.id, REALM, { administratorPartyId: inactive }, actor)).toEqual({ kind: 'WEG_NOT_ACTIVE', status: 'VOID' });
      expect(await wegs.amendWeg(w.id, OTHER_REALM, { notes: 'x' }, actor)).toEqual({ kind: 'NOT_FOUND' });
    });

    it('void: refused while a membership is ACTIVE; allowed once it is voided; a second void keeps the first reason', async () => {
      const w = await weg();
      const m = await membership({ wegId: w.id, propertyReferenceId: await unit() });
      expect(await wegs.voidWeg(w.id, REALM, 'Fehler', new Date(), actor)).toEqual({ kind: 'WEG_HAS_MEMBERSHIPS', membershipIds: [m.id] });
      await wegs.voidMembership(m.id, REALM, 'falsche Einheit', new Date(), actor);
      const voided = await wegs.voidWeg(w.id, REALM, 'Fehler', new Date(), actor, [1]);
      expect(voided).toMatchObject({ kind: 'VOIDED', changed: true, weg: { status: 'VOID', voidReason: 'Fehler', version: 2 } });
      expect(await wegs.voidWeg(w.id, REALM, 'anders', new Date(), actor, [9])).toMatchObject({
        kind: 'VOIDED',
        changed: false,
        weg: { voidReason: 'Fehler' },
      });
    });

    it('list: by displayName, filtered by status, administrator and unit; Realm-scoped; a malformed filter id is an empty page', async () => {
      const administrator = await party();
      const pr = await unit();
      const b = await weg({ displayName: 'ZZ-B', administratorPartyId: administrator });
      const a = await weg({ displayName: 'ZZ-A', administratorPartyId: administrator });
      await membership({ wegId: b.id, propertyReferenceId: pr });
      await weg({ displayName: 'ZZ-other', mreRealmId: OTHER_REALM });
      const byAdministrator = await wegs.listWegs(REALM, { administratorPartyId: administrator }, { page: 1, pageSize: 50 });
      expect(byAdministrator.items.map((w) => w.id)).toEqual([a.id, b.id]);
      expect(byAdministrator.total).toBe(2);
      expect((await wegs.listWegs(REALM, { propertyReferenceId: pr }, { page: 1, pageSize: 50 })).items.map((w) => w.id)).toEqual([b.id]);
      expect((await wegs.listWegs(REALM, { administratorPartyId: 'nope' }, { page: 1, pageSize: 50 })).total).toBe(0);
      const paged = await wegs.listWegs(REALM, { administratorPartyId: administrator }, { page: 2, pageSize: 1 });
      expect(paged).toMatchObject({ page: 2, pageSize: 1, total: 2 });
      expect(paged.items.map((w) => w.id)).toEqual([b.id]);
      expect(await wegs.findWeg(a.id, OTHER_REALM)).toBeUndefined();
    });
  });

  describe('membership', () => {
    it('create: ACTIVE with the MEA as printed, two AuditRecords; a replay answers the first membership', async () => {
      const w = await weg();
      const pr = await unit();
      const outcome = await wegs.createMembership(
        newMembership({ wegId: w.id, propertyReferenceId: pr, mea: mea('125.500/10000.000'), sourceReferences: ['TE Nr. 4'] }),
        actor,
        { key: 'k-m-1', fingerprint: 'f' },
      );
      expect(outcome).toMatchObject({
        kind: 'CREATED',
        membership: { wegId: w.id, propertyReferenceId: pr, mea: { numerator: '125.5', denominator: '10000' }, status: 'ACTIVE', version: 1 },
      });
      if (outcome.kind !== 'CREATED') return;
      expect((await pool.query(`SELECT mea_numerator::text AS n FROM weg_membership WHERE id = $1`, [outcome.membership.id])).rows[0].n).toBe('125.500');
      expect(await audit(outcome.membership.id)).toEqual([
        {
          entity_type: 'WegMembership',
          action: 'CREATED',
          metadata: { wegId: w.id, propertyReferenceId: pr, miteigentumsanteil: '125.5/10000', validFrom: '2024-01-01', validUntil: null },
        },
      ]);
      expect((await audit(w.id)).at(-1)).toEqual({ entity_type: 'Weg', action: 'MEMBERSHIP_ADDED', metadata: { membershipId: outcome.membership.id } });
      expect(await wegs.createMembership(newMembership({ wegId: w.id, propertyReferenceId: pr }), actor, { key: 'k-m-1', fingerprint: 'f' })).toMatchObject({
        kind: 'REPLAYED',
        membership: { id: outcome.membership.id },
      });
    });

    it('create: the order of checks, WEG before unit; foreign ids are not found; nothing is written', async () => {
      const w = await weg();
      const foreignWeg = await weg({ mreRealmId: OTHER_REALM });
      const foreignUnit = await unit(OTHER_REALM);
      expect(await wegs.createMembership(newMembership({ wegId: foreignWeg.id, propertyReferenceId: foreignUnit }), actor)).toEqual({ kind: 'WEG_NOT_FOUND' });
      expect(await wegs.createMembership(newMembership({ wegId: w.id, propertyReferenceId: foreignUnit }), actor)).toEqual({
        kind: 'PROPERTY_REFERENCE_NOT_FOUND',
      });
      await wegs.voidWeg(w.id, REALM, 'Fehler', new Date(), actor);
      expect(await wegs.createMembership(newMembership({ wegId: w.id, propertyReferenceId: foreignUnit }), actor)).toEqual({
        kind: 'WEG_NOT_ACTIVE',
        status: 'VOID',
      });
      expect((await pool.query(`SELECT count(*)::int AS n FROM weg_membership WHERE weg_id = $1`, [w.id])).rows[0].n).toBe(0);
    });

    it('one WEG per unit: an overlap in the same WEG and across WEGs is refused; the day after an end is free', async () => {
      const [w1, w2] = [await weg(), await weg()];
      const pr = await unit();
      const first = await membership({ wegId: w1.id, propertyReferenceId: pr, validFrom: day('2020-01-01') });
      expect(await wegs.createMembership(newMembership({ wegId: w1.id, propertyReferenceId: pr, validFrom: day('2030-01-01') }), actor)).toEqual({
        kind: 'OVERLAPPING_WEG_MEMBERSHIP',
        membershipId: first.id,
        wegId: w1.id,
      });
      expect(await wegs.createMembership(newMembership({ wegId: w2.id, propertyReferenceId: pr, validFrom: day('2025-01-01') }), actor)).toMatchObject({
        kind: 'OVERLAPPING_WEG_MEMBERSHIP',
        wegId: w1.id,
      });
      await wegs.endMembership(first.id, REALM, day('2024-12-31'), actor);
      expect(await wegs.createMembership(newMembership({ wegId: w2.id, propertyReferenceId: pr, validFrom: day('2024-12-31') }), actor)).toMatchObject({
        kind: 'OVERLAPPING_WEG_MEMBERSHIP',
      });
      const second = await membership({ wegId: w2.id, propertyReferenceId: pr, validFrom: day('2025-01-01') });
      expect(await wegs.unitOn(pr, REALM, day('2024-12-31'))).toMatchObject({ id: first.id });
      expect(await wegs.unitOn(pr, REALM, day('2025-01-01'))).toMatchObject({ id: second.id });
      expect(await wegs.unitOn(pr, REALM, day('2019-12-31'))).toBeNull();
      expect(await wegs.unitOn(pr, OTHER_REALM, day('2025-01-01'))).toBeUndefined();
      expect((await wegs.unitHistory(pr, REALM, { page: 1, pageSize: 50 }))?.items.map((m) => m.id)).toEqual([first.id, second.id]);
    });

    it('a VOID membership leaves its period free', async () => {
      const w = await weg();
      const pr = await unit();
      const wrong = await membership({ wegId: w.id, propertyReferenceId: pr });
      await wegs.voidMembership(wrong.id, REALM, 'falscher MEA', new Date(), actor);
      const right = await membership({ wegId: w.id, propertyReferenceId: pr, mea: mea('130/10000') });
      expect(await wegs.unitOn(pr, REALM, day('2024-06-01'))).toMatchObject({ id: right.id });
      const listed = await wegs.listMemberships(w.id, REALM, { statuses: ['VOID'] }, { page: 1, pageSize: 50 });
      expect(listed?.items.map((m) => m.id)).toEqual([wrong.id]);
      expect(await wegs.listMemberships(w.id, OTHER_REALM, {}, { page: 1, pageSize: 50 })).toBeUndefined();
    });

    it('amend: references and notes; a no-op; 412; VOID refused; with AuditRecords', async () => {
      const w = await weg();
      const m = await membership({ wegId: w.id, propertyReferenceId: await unit(), sourceReferences: ['TE'] });
      expect(await wegs.amendMembership(m.id, REALM, { sourceReferences: ['TE'] }, actor, [5])).toMatchObject({ kind: 'AMENDED', changed: false });
      expect(await wegs.amendMembership(m.id, REALM, { notes: 'x' }, actor, [5])).toMatchObject({ kind: 'VERSION_CONFLICT' });
      expect(await wegs.amendMembership(m.id, REALM, { sourceReferences: [], notes: 'Stellplatz inklusive' }, actor, [1])).toMatchObject({
        kind: 'AMENDED',
        changed: true,
        membership: { sourceReferences: [], notes: 'Stellplatz inklusive', version: 2 },
      });
      expect((await audit(m.id)).at(-1)).toEqual({
        entity_type: 'WegMembership',
        action: 'AMENDED',
        metadata: { changes: { sourceReferences: { from: ['TE'], to: [] }, notes: { from: null, to: 'Stellplatz inklusive' } } },
      });
      await wegs.voidMembership(m.id, REALM, 'Fehler', new Date(), actor);
      expect(await wegs.amendMembership(m.id, REALM, { notes: 'y' }, actor)).toEqual({ kind: 'MEMBERSHIP_NOT_ACTIVE' });
    });

    it('end: shortens, never extends, a no-op on the same day; refusals; the AuditRecord keeps both dates', async () => {
      const w = await weg();
      const m = await membership({ wegId: w.id, propertyReferenceId: await unit() });
      expect(await wegs.endMembership(m.id, REALM, day('2023-12-31'), actor)).toEqual({ kind: 'INVALID_MEMBERSHIP', reason: 'STARTS_AFTER_END' });
      expect(await wegs.endMembership(m.id, REALM, day('2025-06-30'), actor, [1])).toMatchObject({
        kind: 'ENDED',
        changed: true,
        membership: { validUntil: '2025-06-30' },
      });
      expect(await wegs.endMembership(m.id, REALM, day('2025-06-30'), actor, [9])).toMatchObject({ kind: 'ENDED', changed: false });
      expect(await wegs.endMembership(m.id, REALM, day('2025-07-01'), actor)).toEqual({ kind: 'INVALID_MEMBERSHIP', reason: 'ALREADY_ENDED' });
      expect((await audit(m.id)).at(-1)).toEqual({ entity_type: 'WegMembership', action: 'ENDED', metadata: { validUntil: { from: null, to: '2025-06-30' } } });
      expect(await wegs.endMembership(m.id, OTHER_REALM, day('2025-01-01'), actor)).toEqual({ kind: 'NOT_FOUND' });
    });
  });

  describe('schema past the repository', () => {
    async function rows() {
      const w = await weg();
      const pr = await unit();
      const m = await membership({ wegId: w.id, propertyReferenceId: pr });
      return { w, pr, m };
    }
    const update = (table: string, set: string, id: string) => pool.query(`UPDATE ${table} SET ${set} WHERE id = $1`, [id]).then(() => 'accepted', reasonOf);
    const insertMembership = (values: string, params: unknown[]) =>
      pool
        .query(
          `INSERT INTO weg_membership (mre_realm_id, weg_id, property_reference_id, mea_numerator, mea_denominator, valid_from, valid_until, status, created_by)
           VALUES ${values}`,
          params,
        )
        .then(() => 'accepted', reasonOf);

    it('CHECKs: the MEA, the period, the void fields, the name, the month', async () => {
      const { w, pr } = await rows();
      const other = await unit();
      expect(await insertMembership(`($1, $2, $3, 0, 1, '2024-01-01', NULL, 'ACTIVE', 'x')`, [REALM, w.id, other])).toBe('weg_membership_mea');
      expect(await insertMembership(`($1, $2, $3, 2, 1, '2024-01-01', NULL, 'ACTIVE', 'x')`, [REALM, w.id, other])).toBe('weg_membership_mea');
      expect(await insertMembership(`($1, $2, $3, 1, 1000000000, '2024-01-01', NULL, 'ACTIVE', 'x')`, [REALM, w.id, other])).toBe('22003');
      expect(await insertMembership(`($1, $2, $3, 1, 2, '2024-01-01', '2023-12-31', 'ACTIVE', 'x')`, [REALM, w.id, other])).toBe('weg_membership_period');
      expect(await insertMembership(`($1, $2, $3, 1, 2, '2024-01-01', NULL, 'ACTIVE', 'x')`, [OTHER_REALM, w.id, pr])).toBe('weg_membership_weg_fk');
      // A WEG without memberships, so the void guard does not answer first.
      const bare = await weg();
      expect(await update('weg', `status = 'VOID', version = version + 1`, bare.id)).toBe('weg_void_fields');
      expect(await update('weg', `display_name = '', version = version + 1`, w.id)).toBe('weg_display_name_check');
      expect(await update('weg', `financial_year_start_month = 13, version = version + 1`, w.id)).toBe('weg_financial_year_start_month_check');
    });

    it('membership frozen: fixed fields, validUntil never later or cleared, VOID final, version + 1, no delete, only inserted ACTIVE', async () => {
      const { m } = await rows();
      expect(await update('weg_membership', `mea_numerator = 126, version = version + 1`, m.id)).toBe('never change');
      expect(await update('weg_membership', `valid_from = '2023-01-01', version = version + 1`, m.id)).toBe('never change');
      expect(await update('weg_membership', `notes = 'x'`, m.id)).toBe('exactly one');
      expect(await update('weg_membership', `valid_until = '2025-12-31', version = version + 1`, m.id)).toBe('accepted');
      expect(await update('weg_membership', `valid_until = '2026-01-01', version = version + 1`, m.id)).toBe('never extended');
      expect(await update('weg_membership', `valid_until = NULL, version = version + 1`, m.id)).toBe('never extended');
      expect(await update('weg_membership', `version = version`, m.id)).toBe('accepted');
      expect(
        await update('weg_membership', `status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', notes = 'n', version = version + 1`, m.id),
      ).toBe('nothing else');
      expect(await update('weg_membership', `status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1`, m.id)).toBe(
        'accepted',
      );
      expect(await update('weg_membership', `notes = 'later', version = version + 1`, m.id)).toBe('VOID is final');
      expect(await pool.query(`DELETE FROM weg_membership WHERE id = $1`, [m.id]).then(() => 'accepted', reasonOf)).toBe('never deleted');
      const { w } = await rows();
      expect(await insertMembership(`($1, $2, $3, 1, 2, '2024-01-01', NULL, 'VOID', 'x')`, [REALM, w.id, await unit()])).toBe('only inserted');
    });

    it('the overlap trigger refuses a second ACTIVE membership of the unit in any WEG, and a membership of a VOID WEG', async () => {
      const { pr } = await rows();
      const other = await weg();
      expect(await insertMembership(`($1, $2, $3, 1, 2, '2030-01-01', NULL, 'ACTIVE', 'x')`, [REALM, other.id, pr])).toBe('(OVERLAPPING_WEG_MEMBERSHIP)');
      const voided = await weg();
      await wegs.voidWeg(voided.id, REALM, 'Fehler', new Date(), actor);
      expect(await insertMembership(`($1, $2, $3, 1, 2, '2024-01-01', NULL, 'ACTIVE', 'x')`, [REALM, voided.id, await unit()])).toBe('(WEG_NOT_ACTIVE)');
    });

    it('weg frozen: no void while a membership is ACTIVE, VOID final, a void changes nothing else, no delete', async () => {
      const { w, m } = await rows();
      const voidSet = `status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1`;
      expect(await update('weg', voidSet, w.id)).toBe('(WEG_HAS_MEMBERSHIPS)');
      await wegs.voidMembership(m.id, REALM, 'Fehler', new Date(), actor);
      expect(await update('weg', `${voidSet}, notes = 'n'`, w.id)).toBe('nothing else');
      expect(await update('weg', voidSet, w.id)).toBe('accepted');
      expect(await update('weg', `notes = 'n', version = version + 1`, w.id)).toBe('VOID is final');
      expect(await pool.query(`DELETE FROM weg WHERE id = $1`, [w.id]).then(() => 'accepted', reasonOf)).toBe('never deleted');
    });

    it('down drops both tables and their functions', async () => {
      const downSchema = testSchemaName('weg_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        // 0042 and 0041 build on 0040's tables: they go first. Dropping tables while another worker's Migrator introspects
        // the database breaks it, so the downs hold the migration lock as every schema change of the tests does.
        await withMigrationLock(async () => {
          await (await import('./migrations/0042_weg_annual_statement.js')).down(createDatabase(downPool) as never);
          await (await import('./migrations/0041_weg_plan_and_splits.js')).down(createDatabase(downPool) as never);
          await (await import('./migrations/0040_weg.js')).down(createDatabase(downPool) as never);
        });
        const { rows: tables } = await downPool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'weg%'`, [
          downSchema,
        ]);
        expect(tables).toEqual([]);
        const { rows: functions } = await downPool.query(
          `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = $1 AND proname LIKE 'weg%'`,
          [downSchema],
        );
        expect(functions).toEqual([]);
      } finally {
        await downPool.end();
      }
    });
  });

  describe('concurrency', () => {
    /** Waits until a session waits for a lock in a statement containing `text`. */
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

    it('RC: two memberships of one unit in two WEGs serialise on the unit; the second sees the first and is refused', async () => {
      const [w1, w2] = [await weg(), await weg()];
      const pr = await unit();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `INSERT INTO weg_membership (mre_realm_id, weg_id, property_reference_id, mea_numerator, mea_denominator, valid_from, status, created_by)
           VALUES ($1, $2, $3, 1, 2, '2024-01-01', 'ACTIVE', 'x')`,
          [REALM, w1.id, pr],
        );
        const second = wegs.createMembership(newMembership({ wegId: w2.id, propertyReferenceId: pr }), actor);
        await waitForLock('"property_reference"');
        await holder.query('COMMIT');
        expect(await second).toMatchObject({ kind: 'OVERLAPPING_WEG_MEMBERSHIP', wegId: w1.id });
      } finally {
        holder.release();
      }
    });

    it('RR: two memberships of one unit; exactly one commits, the other fails to serialise', async () => {
      const [w1, w2] = [await weg(), await weg()];
      const pr = await unit();
      const [first, second] = [await pool.connect(), await pool.connect()];
      const insert = (client: pg.PoolClient, wegId: string) =>
        client.query(
          `INSERT INTO weg_membership (mre_realm_id, weg_id, property_reference_id, mea_numerator, mea_denominator, valid_from, status, created_by)
           VALUES ($1, $2, $3, 1, 2, '2024-01-01', 'ACTIVE', 'x')`,
          [REALM, wegId, pr],
        );
      try {
        await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await first.query('SELECT count(*) FROM weg_membership');
        await second.query('SELECT count(*) FROM weg_membership');
        await insert(first, w1.id);
        const late = insert(second, w2.id).then(
          () => 'inserted',
          (error: { code?: string }) => error.code,
        );
        await waitForLock('INSERT INTO weg_membership');
        await first.query('COMMIT');
        expect(await late).toBe('40001');
        await second.query('ROLLBACK');
      } finally {
        first.release();
        second.release();
      }
      expect((await pool.query(`SELECT count(*)::int AS n FROM weg_membership WHERE property_reference_id = $1`, [pr])).rows[0].n).toBe(1);
    });

    it('RC: a WEG void waiting on a membership create sees the membership and is refused', async () => {
      const w = await weg();
      const pr = await unit();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `INSERT INTO weg_membership (mre_realm_id, weg_id, property_reference_id, mea_numerator, mea_denominator, valid_from, status, created_by)
           VALUES ($1, $2, $3, 1, 2, '2024-01-01', 'ACTIVE', 'x')`,
          [REALM, w.id, pr],
        );
        const voiding = wegs.voidWeg(w.id, REALM, 'Fehler', new Date(), actor);
        await waitForLock('"weg"');
        await holder.query('COMMIT');
        expect(await voiding).toMatchObject({ kind: 'WEG_HAS_MEMBERSHIPS' });
      } finally {
        holder.release();
      }
    });

    it('RC: a membership create waiting on a WEG void sees VOID and is refused', async () => {
      const w = await weg();
      const pr = await unit();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE weg SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1 WHERE id = $1`, [
          w.id,
        ]);
        const creating = wegs.createMembership(newMembership({ wegId: w.id, propertyReferenceId: pr }), actor);
        await waitForLock('"weg"');
        await holder.query('COMMIT');
        expect(await creating).toEqual({ kind: 'WEG_NOT_ACTIVE', status: 'VOID' });
      } finally {
        holder.release();
      }
      expect((await pool.query(`SELECT count(*)::int AS n FROM weg_membership WHERE weg_id = $1`, [w.id])).rows[0].n).toBe(0);
    });

    it('RR: a WEG void and a membership create of one WEG; one of them fails to serialise', async () => {
      const w = await weg();
      const pr = await unit();
      const [first, second] = [await pool.connect(), await pool.connect()];
      try {
        await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await first.query('SELECT count(*) FROM weg');
        await second.query('SELECT count(*) FROM weg_membership');
        await first.query(
          `INSERT INTO weg_membership (mre_realm_id, weg_id, property_reference_id, mea_numerator, mea_denominator, valid_from, status, created_by)
           VALUES ($1, $2, $3, 1, 2, '2024-01-01', 'ACTIVE', 'x')`,
          [REALM, w.id, pr],
        );
        const late = second
          .query(`UPDATE weg SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1 WHERE id = $1`, [w.id])
          .then(
            () => 'voided',
            (error: { code?: string }) => error.code,
          );
        await waitForLock('UPDATE weg SET');
        await first.query('COMMIT');
        expect(await late).toBe('40001');
        await second.query('ROLLBACK');
      } finally {
        first.release();
        second.release();
      }
      expect((await wegs.findWeg(w.id, REALM))?.status).toBe('ACTIVE');
    });

    it('end against void of one membership: they serialise on the row; the one that waited sees the other', async () => {
      const w = await weg();
      const m = await membership({ wegId: w.id, propertyReferenceId: await unit() });
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `UPDATE weg_membership SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1 WHERE id = $1`,
          [m.id],
        );
        const ending = wegs.endMembership(m.id, REALM, day('2025-06-30'), actor, [1]);
        await waitForLock('"property_reference"');
        await holder.query('COMMIT');
        expect(await ending).toEqual({ kind: 'MEMBERSHIP_NOT_ACTIVE' });
      } finally {
        holder.release();
      }
    });
  });
});
