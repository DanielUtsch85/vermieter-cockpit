import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import { linkPropertyReference, refreshPropertyReference } from './application/index.js';
import {
  PostgresPropertyReferenceRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier, mrePropertyLookup } from './wiring.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';

/**
 * VC-1-01 / VC-1-02 end to end, wired as in main.ts: real HTTP app, MRE client and
 * PostgreSQL repository against a fake MRE that mirrors the pinned baseline.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000000a';
const REALM_B = '64b0c0ffee0000000000000b';
const PROPERTY_A = '6512f0c2a1b2c3d4e5f60718';
const PROPERTY_B = '6512f0c2a1b2c3d4e5f60719';

/** Mutated by the refresh tests, like a landlord editing the Property in MRE. */
const realmAProperties: Record<string, unknown>[] = [
  { _id: PROPERTY_A, name: 'Wohnung 1', price: 950, surface: 64.5, address: { city: 'Berlin' } },
];

/**
 * Where the MRE price (950) shows up in a response: a key `price`, or the value as
 * a number or decimal string (Money and decimals serialize as strings, §86), at
 * any depth. Values, not a substring of the JSON text: a random UUID may contain "950".
 */
function mrePriceLeaks(body: unknown): unknown[] {
  const found: unknown[] = [];
  JSON.stringify(body, (key, value: unknown) => {
    if (key === 'price' || value === 950 || (typeof value === 'string' && /^950(\.0+)?$/.test(value))) found.push(key || value);
    return value;
  });
  return found;
}

describe('mrePriceLeaks', () => {
  it('finds the price as key, number or decimal string at any depth, but not inside an id', () => {
    expect(mrePriceLeaks({ price: 1 })).toEqual(['price']);
    for (const leak of [{ rent: 950 }, { rent: '950' }, { rent: '950.00' }, { cachedRent: { amount: '950.00', currency: 'EUR' } }]) {
      expect(mrePriceLeaks(leak)).not.toEqual([]);
    }
    expect(mrePriceLeaks({ id: 'f1e2b0f0-eeeb-4cda-950d-473995cb97c3', surface: '64.5', amount: '9500.00' })).toEqual([]);
  });
});

describe.skipIf(databaseUrl === undefined)('property-references link + refresh end to end', () => {
  const schema = testSchemaName('link_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });

    mre = await startFakeMre([
      {
        _id: REALM_A,
        name: 'A',
        members: [{ name: 'Anna', email: 'anna@example.com', role: 'administrator', registered: true }],
        applications: [],
        properties: realmAProperties,
      },
      {
        _id: REALM_B,
        name: 'B',
        members: [{ name: 'Anna', email: 'anna@example.com', role: 'administrator', registered: true }],
        applications: [],
        properties: [{ _id: PROPERTY_B, name: 'Wohnung B' }],
      },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const deps = {
      repository: new PostgresPropertyReferenceRepository(createDatabase(pool)),
      lookupMreProperty: mrePropertyLookup(client),
    };
    server = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({ propertyReferences: { link: linkPropertyReference(deps), refresh: refreshPropertyReference(deps) } }),
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
    await pool.end();
  });

  const link = (realmHeader: string, body: unknown) =>
    fetch(`${base}/api/v1/property-references/link`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signJwt({ account: { email: 'anna@example.com' } })}`,
        organizationid: realmHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  const count = async (table: string) => Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

  it('links once (201), then returns the same reference (200) without asking MRE again', async () => {
    const first = await link(REALM_A, { mreRealmId: REALM_A, mrePropertyId: PROPERTY_A });
    expect(first.status).toBe(201);
    const created = (await first.json()) as Record<string, unknown>;
    expect(created).toMatchObject({
      mreRealmId: REALM_A,
      mrePropertyId: PROPERTY_A,
      externalReferenceState: 'ACTIVE',
      displayName: 'Wohnung 1',
      cachedAddress: { city: 'Berlin' },
    });
    expect(mrePriceLeaks(created)).toEqual([]); // MRE price is never cached

    const propertyCalls = () => mre.requests.filter((r) => r.path === '/api/v2/properties').length;
    const before = propertyCalls();
    const repeat = await link(REALM_A, { mreRealmId: REALM_A, mrePropertyId: PROPERTY_A });
    expect(repeat.status).toBe(200);
    const repeated = (await repeat.json()) as { propertyReferenceId: string };
    expect(repeated.propertyReferenceId).toBe(created['propertyReferenceId']);
    expect(propertyCalls()).toBe(before);
    expect(await count('property_reference')).toBe(1);
    expect(await count('audit_record')).toBe(1);
  });

  it('a Property of another Realm is not found in this Realm (404), nothing written', async () => {
    const res = await link(REALM_A, { mreRealmId: REALM_A, mrePropertyId: PROPERTY_B });
    expect(res.status).toBe(404);
    expect(await count('property_reference')).toBe(1);
  });

  it('a body Realm other than the organizationid header → 403', async () => {
    const res = await link(REALM_A, { mreRealmId: REALM_B, mrePropertyId: PROPERTY_B });
    expect(res.status).toBe(403);
    expect(await count('property_reference')).toBe(1);
  });

  it('a malformed mrePropertyId → 400 without calling MRE /properties', async () => {
    const before = mre.requests.filter((r) => r.path === '/api/v2/properties').length;
    const res = await link(REALM_A, { mreRealmId: REALM_A, mrePropertyId: 'abc' });
    expect(res.status).toBe(400);
    expect(mre.requests.filter((r) => r.path === '/api/v2/properties').length).toBe(before);
  });

  describe('refresh', () => {
    let id = '';
    const refresh = (realmHeader: string, referenceId: string) =>
      fetch(`${base}/api/v1/property-references/${referenceId}/refresh`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${signJwt({ account: { email: 'anna@example.com' } })}`,
          organizationid: realmHeader,
        },
      });
    const auditActions = async () =>
      (
        await pool.query<{ action: string; previous_version: number | null; new_version: number }>(
          `SELECT action, previous_version, new_version FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, new_version`,
          [id],
        )
      ).rows;

    beforeAll(async () => {
      const linked = await link(REALM_A, { mreRealmId: REALM_A, mrePropertyId: PROPERTY_A });
      id = ((await linked.json()) as { propertyReferenceId: string }).propertyReferenceId;
    });

    it('takes over changed MRE values exactly, bumps the version and audits the change', async () => {
      Object.assign(realmAProperties[0] ?? {}, { name: 'Wohnung 1 (EG)', surface: 65.25 });
      const res = await refresh(REALM_A, id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        propertyReferenceId: id,
        externalReferenceState: 'ACTIVE',
        displayName: 'Wohnung 1 (EG)',
        cachedSurface: '65.25',
        cachedAddress: { city: 'Berlin' },
        version: 2,
      });
      expect(await auditActions()).toEqual([
        { action: 'LINKED', previous_version: null, new_version: 1 },
        { action: 'REFRESHED', previous_version: 1, new_version: 2 },
      ]);
    });

    it('without news: lastRefreshedAt moves, version and audit trail stay', async () => {
      const before = (await (await refresh(REALM_A, id)).json()) as { lastRefreshedAt: string; version: number };
      await new Promise((resolve) => setTimeout(resolve, 5));
      const after = (await (await refresh(REALM_A, id)).json()) as { lastRefreshedAt: string; version: number };
      expect(after.version).toBe(before.version);
      expect(after.lastRefreshedAt > before.lastRefreshedAt).toBe(true);
      expect(await auditActions()).toHaveLength(2);
    });

    it('a Property gone from MRE marks the reference MISSING, keeping its data; back in MRE it is ACTIVE again', async () => {
      const removed = realmAProperties.splice(0, 1);
      const missing = await refresh(REALM_A, id);
      expect(missing.status).toBe(200);
      expect(await missing.json()).toMatchObject({
        externalReferenceState: 'MISSING',
        displayName: 'Wohnung 1 (EG)',
        cachedSurface: '65.25',
        version: 3,
      });
      expect(await count('property_reference')).toBe(1);

      realmAProperties.push(...removed);
      const back = await refresh(REALM_A, id);
      expect(await back.json()).toMatchObject({ externalReferenceState: 'ACTIVE', version: 4 });
      expect((await auditActions()).map((a) => a.action)).toEqual(['LINKED', 'REFRESHED', 'MARKED_MISSING', 'REFRESHED']);
    });

    it("another Realm's reference and an unknown id are 404", async () => {
      expect((await refresh(REALM_B, id)).status).toBe(404);
      expect((await refresh(REALM_A, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    });
  });
});
