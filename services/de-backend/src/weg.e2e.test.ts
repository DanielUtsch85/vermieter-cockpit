import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  amendMembership,
  amendWeg,
  createMembership,
  createParty,
  createWeg,
  deactivateParty,
  endMembership,
  getMembership,
  getWeg,
  listMemberships,
  listWegs,
  readUnitMemberships,
  voidMembership,
  voidWeg,
} from './application/index.js';
import { PostgresPartyRepository, PostgresWegRepository, createDatabase, migrateToLatest } from './infrastructure/postgres/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';

/**
 * VC-6-01 end to end (api-design.md §49.1–§49.2), wired as in main.ts: a WEG with its Verwalter, a unit's membership
 * with the MEA as printed, one WEG per unit at a time across WEGs, the unit's lookup by day, the sale of a unit (end) and
 * its new WEG the day after, a wrong MEA voided and recorded again, the WEG void guarded by its memberships, and
 * Realm isolation on every §49 route. No MRE call besides the caller's verification (P6-D9).
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000006a';
const REALM_B = '64b0c0ffee0000000000006b';

describe.skipIf(databaseUrl === undefined)('WEG and membership (VC-6-01) end to end', () => {
  const schema = testSchemaName('weg_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let server: Server;
  let base: string;
  const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    mre = await startFakeMre([
      { _id: REALM_A, name: 'A', members: member, applications: [] },
      { _id: REALM_B, name: 'B', members: member, applications: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const wegs = new PostgresWegRepository(db);
    const parties = new PostgresPartyRepository(db);
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        parties: { create: createParty({ repository: parties }), deactivate: deactivateParty({ repository: parties }) },
        wegs: {
          createWeg: createWeg({ repository: wegs }),
          getWeg: getWeg({ repository: wegs }),
          listWegs: listWegs({ repository: wegs }),
          amendWeg: amendWeg({ repository: wegs }),
          voidWeg: voidWeg({ repository: wegs }),
          createMembership: createMembership({ repository: wegs }),
          getMembership: getMembership({ repository: wegs }),
          listMemberships: listMemberships({ repository: wegs }),
          readUnitMemberships: readUnitMemberships({ repository: wegs }),
          amendMembership: amendMembership({ repository: wegs }),
          endMembership: endMembership({ repository: wegs }),
          voidMembership: voidMembership({ repository: wegs }),
        },
      }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
    await pool.end();
  });

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 300);
  const call = (realm: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
  const B = (method: string, path: string, body?: unknown) => call(REALM_B, method, path, body);
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const errorOf = async (res: Response, status: number) => (await json<{ error: { code: string; details?: Record<string, unknown> } }>(res, status)).error;
  type Weg = { wegId: string; status: string; displayName: string; administratorPartyId: string | null; version: number };
  type Membership = {
    membershipId: string;
    wegId: string;
    miteigentumsanteil: string;
    validFrom: string;
    validUntil: string | null;
    status: string;
    version: number;
  };
  let units = 0;
  const unit = async (realm = REALM_A) => {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f66000n + BigInt(++units)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  };
  const verwalter = async (name: string) =>
    (await json<{ partyId: string }>(await A('POST', '/parties', { partyType: 'ORGANIZATION', displayName: name }), 201)).partyId;

  it('a WEG, a membership as printed, a sale with a new WEG the day after, a wrong MEA corrected, and the void guard', async () => {
    const hv = await verwalter('Hausverwaltung Muster');
    const created = await A('POST', '/wegs', { displayName: 'WEG Musterstraße 1', administratorPartyId: hv }, { 'idempotency-key': 'e2e-weg' });
    const weg = await json<Weg>(created, 201);
    expect(created.headers.get('etag')).toBe('"1"');
    expect(weg).toMatchObject({ status: 'ACTIVE', administratorPartyId: hv, version: 1 });
    const replay = await A('POST', '/wegs', { displayName: 'WEG Musterstraße 1', administratorPartyId: hv }, { 'idempotency-key': 'e2e-weg' });
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(await json<Weg>(replay, 201)).toEqual(weg);

    const flat = await unit();
    // The MEA as the Verwalter prints it, with three decimals over 10.000,000; stored and answered as printed.
    const membership = await json<Membership>(
      await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '125.500/10000.000', validFrom: '2023-01-01' }),
      201,
    );
    expect(membership).toMatchObject({ miteigentumsanteil: '125.5/10000', validFrom: '2023-01-01', validUntil: null, status: 'ACTIVE' });

    // One WEG per unit at a time, also across WEGs.
    const other = await json<Weg>(await A('POST', '/wegs', { displayName: 'WEG Nebenstraße 2' }), 201);
    expect(
      await errorOf(
        await A('POST', `/wegs/${other.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '1/3', validFrom: '2025-07-01' }),
        409,
      ),
    ).toMatchObject({ details: { reason: 'OVERLAPPING_WEG_MEMBERSHIP', membershipId: membership.membershipId, wegId: weg.wegId } });

    // The unit leaves the first WEG on 30 June; from 1 July it belongs to the other one.
    const ended = await json<Membership>(
      await A('POST', `/weg-memberships/${membership.membershipId}/end`, { validUntil: '2025-06-30' }, { 'if-match': '"1"' }),
      200,
    );
    expect(ended).toMatchObject({ validUntil: '2025-06-30', version: 2 });
    expect(await errorOf(await A('POST', `/weg-memberships/${membership.membershipId}/end`, { validUntil: '2025-07-31' }), 422)).toMatchObject({
      code: 'INVALID_MEMBERSHIP',
      details: { reason: 'ALREADY_ENDED' },
    });
    const next = await json<Membership>(
      await A('POST', `/wegs/${other.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '1/3', validFrom: '2025-07-01' }),
      201,
    );
    const on = async (asOf: string) =>
      (await json<{ membership: Membership | null }>(await A('GET', `/property-references/${flat}/weg-memberships?asOf=${asOf}`), 200)).membership;
    expect((await on('2025-06-30'))?.membershipId).toBe(membership.membershipId);
    expect((await on('2025-07-01'))?.membershipId).toBe(next.membershipId);
    expect(await on('2022-12-31')).toBeNull();
    const history = await json<{ items: Membership[]; total: number }>(await A('GET', `/property-references/${flat}/weg-memberships`), 200);
    expect(history.items.map((m) => m.membershipId)).toEqual([membership.membershipId, next.membershipId]);

    // A wrong MEA is voided and recorded again with the original dates.
    const wrong = await json<Membership>(
      await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: await unit(), miteigentumsanteil: '12.55/10000', validFrom: '2023-01-01' }),
      201,
    );
    expect(await errorOf(await A('POST', `/weg-memberships/${wrong.membershipId}/amend`, { miteigentumsanteil: '125.5/10000' }), 400)).toMatchObject({
      details: { fields: [{ field: 'miteigentumsanteil', code: 'NOT_AMENDABLE' }] },
    });
    await json<Membership>(await A('POST', `/weg-memberships/${wrong.membershipId}/void`, { reason: 'Komma verrutscht' }), 200);

    // The WEG cannot be voided while a membership hangs off it.
    expect(await errorOf(await A('POST', `/wegs/${weg.wegId}/void`, { reason: 'Fehler' }), 409)).toMatchObject({
      details: { reason: 'WEG_HAS_MEMBERSHIPS', membershipIds: [membership.membershipId] },
    });
    const listed = await json<{ items: Membership[] }>(await A('GET', `/wegs/${weg.wegId}/memberships?status=VOID`), 200);
    expect(listed.items.map((m) => m.membershipId)).toEqual([wrong.membershipId]);
  });

  it('the administrator must be active; a voided WEG takes no membership', async () => {
    const hv = await verwalter('Alte Verwaltung');
    await json(await A('POST', `/parties/${hv}/deactivate`, { reason: 'aufgelöst' }), 200);
    expect(await errorOf(await A('POST', '/wegs', { displayName: 'x', administratorPartyId: hv }), 409)).toMatchObject({
      details: { reason: 'PARTY_INACTIVE', partyId: hv },
    });
    const weg = await json<Weg>(await A('POST', '/wegs', { displayName: 'Irrtum' }), 201);
    const voided = await json<Weg>(await A('POST', `/wegs/${weg.wegId}/void`, { reason: 'doppelt angelegt' }, { 'if-match': '"1"' }), 200);
    expect(voided).toMatchObject({ status: 'VOID', version: 2 });
    expect(
      await errorOf(
        await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: await unit(), miteigentumsanteil: '1/2', validFrom: '2024-01-01' }),
        409,
      ),
    ).toMatchObject({ details: { reason: 'WEG_NOT_ACTIVE', status: 'VOID' } });
    expect(await errorOf(await A('POST', `/wegs/${weg.wegId}/amend`, { notes: 'x' }), 409)).toMatchObject({ details: { reason: 'WEG_NOT_ACTIVE' } });
  });

  it('Realm isolation on every §49 route', async () => {
    const weg = await json<Weg>(await A('POST', '/wegs', { displayName: 'Nur A' }), 201);
    const flat = await unit();
    const membership = await json<Membership>(
      await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '1/2', validFrom: '2024-01-01' }),
      201,
    );
    expect((await B('GET', `/wegs/${weg.wegId}`)).status).toBe(404);
    expect((await json<{ items: Weg[] }>(await B('GET', '/wegs'), 200)).items.map((w) => w.wegId)).not.toContain(weg.wegId);
    expect((await B('POST', `/wegs/${weg.wegId}/amend`, { notes: 'x' })).status).toBe(404);
    expect((await B('POST', `/wegs/${weg.wegId}/void`, { reason: 'x' })).status).toBe(404);
    expect((await B('GET', `/wegs/${weg.wegId}/memberships`)).status).toBe(404);
    expect((await B('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '1/2', validFrom: '2030-01-01' })).status).toBe(
      404,
    );
    expect((await B('GET', `/weg-memberships/${membership.membershipId}`)).status).toBe(404);
    expect((await B('POST', `/weg-memberships/${membership.membershipId}/amend`, { notes: 'x' })).status).toBe(404);
    expect((await B('POST', `/weg-memberships/${membership.membershipId}/end`, { validUntil: '2025-01-01' })).status).toBe(404);
    expect((await B('POST', `/weg-memberships/${membership.membershipId}/void`, { reason: 'x' })).status).toBe(404);
    expect((await B('GET', `/property-references/${flat}/weg-memberships?asOf=2024-06-01`)).status).toBe(404);
    expect((await B('GET', `/property-references/${flat}/weg-memberships`)).status).toBe(404);
    // B's own WEG cannot take A's unit.
    const bWeg = await json<Weg>(await B('POST', '/wegs', { displayName: 'Nur B' }), 201);
    expect(
      await errorOf(await B('POST', `/wegs/${bWeg.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '1/2', validFrom: '2030-01-01' }), 404),
    ).toMatchObject({
      details: { propertyReferenceId: flat },
    });
    expect((await json<Membership>(await A('GET', `/weg-memberships/${membership.membershipId}`), 200)).version).toBe(1);
  });
});
