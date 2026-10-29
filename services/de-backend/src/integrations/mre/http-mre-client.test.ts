import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExactDecimal, Money } from '../../shared/index.js';
import { HttpMreClient, decimalText } from './http-mre-client.js';
import { MreClientError, type MreClientErrorCode } from './mre-client.js';
import { signJwt, startFakeMre, type FakeMre } from './fake-mre.test-support.js';

async function expectCode(promise: Promise<unknown>, code: MreClientErrorCode): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(MreClientError);
  await expect(promise).rejects.toMatchObject({ code });
}

/** Serves one fixed response for every request. */
async function startStub(status: number, body: string, delayMs = 0): Promise<{ url: string; close: () => void }> {
  const server = createServer((_req, res) => {
    setTimeout(() => res.writeHead(status, { 'content-type': 'application/json' }).end(body), delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/v2`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const PROPERTY_A = '6512f0c2a1b2c3d4e5f60718';
const PROPERTY_B = '6512f0c2a1b2c3d4e5f60719';
const TENANT_A = '6512f0c2a1b2c3d4e5f60a01';

describe('HttpMreClient against a fake MRE', () => {
  let mre: FakeMre;
  let client: HttpMreClient;

  beforeAll(async () => {
    mre = await startFakeMre([
      {
        _id: 'realm-a',
        name: 'Landlord A',
        members: [
          { name: 'Anna', email: 'anna@example.com', role: 'administrator', registered: true },
          { name: 'Ralf', email: 'ralf@example.com', role: 'renter', registered: true },
        ],
        applications: [{ clientId: 'x' }],
        bankInfo: { iban: 'DE00' },
        properties: [
          {
            _id: PROPERTY_A,
            name: 'Wohnung 1',
            surface: 64.5,
            price: 950,
            address: { street1: 'Musterstraße 1', street2: '', zipCode: '10115', city: 'Berlin', country: 'DE' },
          },
          { _id: PROPERTY_B, name: 'Stellplatz' },
        ],
        // A float `guaranty` and no `guarantyPayback`, as MRE keeps a Tenant before its lease ends (§47.1).
        tenants: [{ _id: TENANT_A, name: 'Tina Mieterin', contacts: [{ email: 'tina@example.com' }], guaranty: 2999.995 }],
        rents: { [TENANT_A]: [2027010100, 2027020100] },
        rentTerms: {
          [`${TENANT_A}/2027020100`]: {
            totalWithoutBalanceAmount: 799.9999999999999,
            payments: [
              { date: '03/02/2027', amount: 500, type: 'transfer', reference: 'DE-RPR-x', description: 'Tina zahlt' },
              { date: 'gestern', amount: 0.1 + 0.2, type: 'cash' },
            ],
          },
        },
      },
      {
        _id: 'realm-b',
        name: 'Landlord B',
        members: [{ name: 'Bert', email: 'bert@example.com', role: 'administrator', registered: true }],
        applications: [],
      },
    ]);
    client = new HttpMreClient({ apiBaseUrl: `${mre.apiBaseUrl}/`, timeoutMs: 2000 });
  });

  afterAll(async () => {
    await mre.close();
  });

  it('forwards the bearer token to GET /api/v2/realms and maps only the needed fields', async () => {
    const token = signJwt({ account: { email: 'anna@example.com', firstname: 'Anna' } });
    const realms = await client.listRealms(token);
    expect(realms).toEqual([
      {
        mreRealmId: 'realm-a',
        name: 'Landlord A',
        members: [
          { email: 'anna@example.com', role: 'administrator' },
          { email: 'ralf@example.com', role: 'renter' },
        ],
      },
    ]);
    expect(mre.requests.at(-1)).toEqual({ path: '/api/v2/realms', authorization: `Bearer ${token}`, organizationid: undefined });
  });

  it('lists the Realm properties via GET /properties with organizationid, mapping only cached fields', async () => {
    const token = signJwt({ account: { email: 'anna@example.com' } });
    const properties = await client.listProperties(token, 'realm-a');
    expect(properties).toEqual([
      {
        mrePropertyId: PROPERTY_A,
        name: 'Wohnung 1',
        address: { street1: 'Musterstraße 1', zipCode: '10115', city: 'Berlin', country: 'DE' },
        surface: ExactDecimal.of('64.5'),
      },
      { mrePropertyId: PROPERTY_B, name: 'Stellplatz', address: null, surface: null },
    ]);
    expect(mre.requests.at(-1)).toEqual({ path: '/api/v2/properties', authorization: `Bearer ${token}`, organizationid: 'realm-a' });
  });

  it('listProperties maps 401 to UNAUTHENTICATED and a foreign Realm (404 upstream) to FORBIDDEN', async () => {
    await expectCode(client.listProperties(signJwt({ account: { email: 'anna@example.com' } }, 'wrong-secret'), 'realm-a'), 'UNAUTHENTICATED');
    await expectCode(client.listProperties(signJwt({ account: { email: 'anna@example.com' } }), 'realm-b'), 'FORBIDDEN');
  });

  it("listTenantIds returns only the Tenants' _id of the Realm; a foreign Realm is FORBIDDEN", async () => {
    const token = signJwt({ account: { email: 'anna@example.com' } });
    expect(await client.listTenantIds(token, 'realm-a')).toEqual([TENANT_A]);
    expect(mre.requests.at(-1)).toMatchObject({ path: '/api/v2/tenants', organizationid: 'realm-a' });
    await expectCode(client.listTenantIds(token, 'realm-b'), 'FORBIDDEN');
  });

  it('readTenantDeposit reads the Realm list: guaranty half-up to the cent, a missing payback null, an unknown Tenant undefined', async () => {
    const token = signJwt({ account: { email: 'anna@example.com' } });
    expect(await client.readTenantDeposit(token, 'realm-a', TENANT_A)).toEqual({ guaranty: Money.of('3000.00', 'EUR'), guarantyPayback: null });
    expect(mre.requests.at(-1)).toMatchObject({ path: '/api/v2/tenants', organizationid: 'realm-a' });
    expect(await client.readTenantDeposit(token, 'realm-a', '6512f0c2a1b2c3d4e5f60aff')).toBeUndefined();
    await expectCode(client.readTenantDeposit(token, 'realm-b', TENANT_A), 'FORBIDDEN');
  });

  it.each([
    ["MRE's default guaranty 0 → null; a payback 0 is a value", '[{"_id":"6512f0c2a1b2c3d4e5f60a01","guaranty":0,"guarantyPayback":0}]', null, '0.00'],
    ['both present', '[{"_id":"6512f0c2a1b2c3d4e5f60a01","guaranty":1500,"guarantyPayback":1234.565}]', '1500.00', '1234.57'],
    ['text values are no values', '[{"_id":"6512f0c2a1b2c3d4e5f60a01","guaranty":"1500","guarantyPayback":"x"}]', null, null],
  ])('readTenantDeposit: %s', async (_label, body, guaranty, payback) => {
    const stub = await startStub(200, body);
    try {
      expect(await new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).readTenantDeposit('a.b.c', 'r', TENANT_A)).toEqual({
        guaranty: guaranty === null ? null : Money.of(guaranty, 'EUR'),
        guarantyPayback: payback === null ? null : Money.of(payback, 'EUR'),
      });
    } finally {
      stub.close();
    }
  });

  it('readTenantDeposit: an unexpected list shape → UNAVAILABLE, without the body in the message', async () => {
    const stub = await startStub(200, '[{"name":"Tina"}]');
    try {
      const read = new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).readTenantDeposit('a.b.c', 'r', TENANT_A);
      await expectCode(read, 'UNAVAILABLE');
      await expect(read).rejects.not.toThrow(/Tina/);
    } finally {
      stub.close();
    }
  });

  it('rentTermExists reads GET /rents/tenant/:id/:term of the Realm; an unknown term, Tenant or Realm is false', async () => {
    const token = signJwt({ account: { email: 'anna@example.com' } });
    expect(await client.rentTermExists(token, 'realm-a', TENANT_A, '2027010100')).toBe(true);
    expect(mre.requests.at(-1)).toEqual({ path: `/api/v2/rents/tenant/${TENANT_A}/2027010100`, authorization: `Bearer ${token}`, organizationid: 'realm-a' });
    expect(await client.rentTermExists(token, 'realm-a', TENANT_A, '2027030100')).toBe(false);
    expect(await client.rentTermExists(token, 'realm-a', '6512f0c2a1b2c3d4e5f60aff', '2027010100')).toBe(false);
    expect(await client.rentTermExists(signJwt({ account: { email: 'bert@example.com' } }), 'realm-b', TENANT_A, '2027010100')).toBe(false);
    await expectCode(
      client.rentTermExists(signJwt({ account: { email: 'anna@example.com' } }, 'wrong-secret'), 'realm-a', TENANT_A, '2027010100'),
      'UNAUTHENTICATED',
    );
  });

  it('readRentTerm parses the amount due and the payments only; floats rounded half-up to the cent', async () => {
    const token = signJwt({ account: { email: 'anna@example.com' } });
    const read = await client.readRentTerm(token, 'realm-a', TENANT_A, '2027020100');
    expect(read).toEqual({
      amountDue: Money.of('800.00', 'EUR'),
      payments: [
        { date: '2027-02-03', amount: Money.of('500.00', 'EUR'), type: 'transfer', reference: 'DE-RPR-x' },
        { date: null, amount: Money.of('0.30', 'EUR'), type: 'cash', reference: null },
      ],
    });
    // The Tenant's name, contacts and the payment's description leave no trace.
    expect(JSON.stringify(read)).not.toMatch(/Tina|tenant@example.com|not read by DE/);
    expect(await client.readRentTerm(token, 'realm-a', TENANT_A, '2027030100')).toBeUndefined();
  });

  it('listRentTerms reads GET /rents/:year/:month of the Realm: Tenant, term and amount due only; a foreign Realm is FORBIDDEN', async () => {
    const token = signJwt({ account: { email: 'anna@example.com' } });
    const rents = await client.listRentTerms(token, 'realm-a', 2027, 2);
    expect(rents).toEqual([{ mreTenantId: TENANT_A, term: '2027020100', amountDue: Money.of('800.00', 'EUR') }]);
    expect(mre.requests.at(-1)).toMatchObject({ path: '/api/v2/rents/2027/02', organizationid: 'realm-a' });
    expect(JSON.stringify(rents)).not.toMatch(/not read by DE|tenant@example.com/);
    expect(await client.listRentTerms(token, 'realm-a', 2027, 3)).toEqual([]);
    await expectCode(client.listRentTerms(token, 'realm-b', 2027, 2), 'FORBIDDEN');
  });

  it('readRentTermForWriteBack keeps the raw values and drops the occupant; writeRentTermPayments PATCHes with _id in the body (§37.4)', async () => {
    const token = signJwt({ account: { email: 'anna@example.com' } });
    const read = await client.readRentTermForWriteBack(token, 'realm-a', TENANT_A, '2027020100');
    expect(read).toEqual({
      mreTenantId: TENANT_A,
      term: '2027020100',
      vatRatio: 0,
      payments: [
        { date: '03/02/2027', amount: 500, type: 'transfer', reference: 'DE-RPR-x', description: 'Tina zahlt' },
        { date: 'gestern', amount: 0.1 + 0.2, type: 'cash', reference: undefined, description: undefined },
      ],
      promo: 0,
      notepromo: '',
      extracharge: 0,
      noteextracharge: '',
      description: '',
    });
    expect(JSON.stringify(read)).not.toMatch(/not read by DE|tenant@example.com/);
    expect(await client.readRentTermForWriteBack(token, 'realm-a', TENANT_A, '2027030100')).toBeUndefined();
    const write = {
      payments: [{ date: '03/01/2027', amount: 800.1, type: 'transfer', reference: 'DE-RPR-y', description: '' }],
      promo: 20,
      notepromo: 'Rabatt',
      extracharge: 0,
      noteextracharge: '',
      description: 'Januar',
    };
    const result = await client.writeRentTermPayments(token, 'realm-a', TENANT_A, '2027010100', write);
    expect(mre.patches.at(-1)).toEqual({ _id: TENANT_A, ...write });
    expect(mre.requests.at(-1)).toEqual({ path: `/api/v2/rents/payment/${TENANT_A}/2027010100`, authorization: `Bearer ${token}`, organizationid: 'realm-a' });
    expect(result).toEqual({
      kind: 'ANSWERED',
      term: {
        mreTenantId: TENANT_A,
        term: '2027010100',
        vatRatio: 0,
        payments: write.payments,
        promo: 20,
        notepromo: 'Rabatt\n',
        extracharge: 0,
        noteextracharge: '',
        description: 'Januar',
      },
    });
    // A Realm the caller is not a member of: checkOrganization's 404, FORBIDDEN. A Tenant of another Realm under the
    // caller's own Realm: findOne finds nothing and MRE answers 500. Nothing is written either way.
    const before = mre.patches.length;
    await expectCode(client.writeRentTermPayments(signJwt({ account: { email: 'bert@example.com' } }), 'realm-a', TENANT_A, '2027010100', write), 'FORBIDDEN');
    expect(await client.writeRentTermPayments(signJwt({ account: { email: 'bert@example.com' } }), 'realm-b', TENANT_A, '2027010100', write)).toEqual({
      kind: 'REFUSED',
      status: 500,
    });
    expect(mre.patches.length).toBe(before);
    await expectCode(
      client.writeRentTermPayments(signJwt({ account: { email: 'anna@example.com' } }, 'wrong-secret'), 'realm-a', TENANT_A, '2027010100', write),
      'UNAUTHENTICATED',
    );
    // A dropped answer: MRE saved it, DE does not know.
    mre.faults.push('DROP_ANSWER');
    expect(await client.writeRentTermPayments(token, 'realm-a', TENANT_A, '2027010100', write)).toMatchObject({ kind: 'NO_ANSWER' });
    expect(mre.patches.length).toBe(before + 1);
    mre.faults.push('FAIL');
    expect(await client.writeRentTermPayments(token, 'realm-a', TENANT_A, '2027010100', write)).toEqual({ kind: 'REFUSED', status: 500 });
    expect(mre.patches.length).toBe(before + 1);
  });

  it('maps 401 (bad signature or expired) to UNAUTHENTICATED', async () => {
    await expectCode(client.listRealms(signJwt({ account: { email: 'anna@example.com' } }, 'wrong-secret')), 'UNAUTHENTICATED');
    await expectCode(client.listRealms(signJwt({ account: { email: 'anna@example.com' } }, undefined, -1)), 'UNAUTHENTICATED');
  });

  it('maps 403 (tenant session token) to FORBIDDEN', async () => {
    await expectCode(client.listRealms(signJwt({ account: { email: 'tom@example.com', role: 'tenant' } })), 'FORBIDDEN');
  });
});

describe('HttpMreClient failure handling', () => {
  it.each([
    [500, '{"status":500}'],
    [404, ''],
    [200, 'not json'],
    [200, '{"realms":[]}'],
    [200, '[{"_id":"","name":"n","members":[]}]'],
    [200, '[{"_id":"r","name":"n","members":{}}]'],
    [302, ''],
  ])('status %i with body %j → UNAVAILABLE', async (status, body) => {
    const stub = await startStub(status, body);
    try {
      await expectCode(new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listRealms('a.b.c'), 'UNAVAILABLE');
    } finally {
      stub.close();
    }
  });

  it.each([
    ['not an array', '{"properties":[]}'],
    ['a property without _id', '[{"_id":"6512f0c2a1b2c3d4e5f60718","name":"a"},{"name":"b"}]'],
    ['an empty _id', '[{"_id":""}]'],
  ])('listProperties: %s → UNAVAILABLE (never a silent "not found")', async (_label, body) => {
    const stub = await startStub(200, body);
    try {
      await expectCode(new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listProperties('a.b.c', 'r'), 'UNAVAILABLE');
    } finally {
      stub.close();
    }
  });

  it.each([
    ['not an array', '{"tenants":[]}'],
    ['a tenant without _id', '[{"_id":"6512f0c2a1b2c3d4e5f60a01"},{"name":"Tina"}]'],
    ['an empty _id', '[{"_id":""}]'],
  ])('listTenantIds: %s → UNAVAILABLE (never a silent "not found"), without the body in the message', async (_label, body) => {
    const stub = await startStub(200, body);
    try {
      const listing = new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listTenantIds('a.b.c', 'r');
      await expectCode(listing, 'UNAVAILABLE');
      await expect(listing).rejects.not.toThrow(/Tina/);
    } finally {
      stub.close();
    }
  });

  it.each([
    ['not an object', '[]'],
    ['no term', '{"month":1}'],
    ['another term', '{"term":2027020100}'],
    ['a term as text', '{"term":"2027010100"}'],
  ])('rentTermExists: %s → UNAVAILABLE (never a silent "found"), without the body in the message', async (_label, body) => {
    const stub = await startStub(200, body);
    try {
      const reading = new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).rentTermExists('a.b.c', 'r', TENANT_A, '2027010100');
      await expectCode(reading, 'UNAVAILABLE');
      await expect(reading).rejects.not.toThrow(/month/);
    } finally {
      stub.close();
    }
  });

  it.each([
    [799.9999999999999, '800.00'],
    [0.1 + 0.2, '0.30'],
    [2.831068712794149e-15, '0.00'],
    [-1e-14, '0.00'],
    [0.005, '0.01'],
    [-0.005, '-0.01'],
    [1e21, '1000000000000000000000.00'],
    [-120.5, '-120.50'],
  ])('readRentTerm takes the MRE float %j as %s (review on #78: exponent notation included, no -0.00)', async (amount, expected) => {
    const stub = await startStub(200, JSON.stringify({ term: 2027010100, totalWithoutBalanceAmount: amount, payments: [] }));
    try {
      const read = new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).readRentTerm('a.b.c', 'r', TENANT_A, '2027010100');
      if (expected.length > 22) await expectCode(read, 'UNAVAILABLE');
      else expect((await read)?.amountDue.amount).toBe(expected);
    } finally {
      stub.close();
    }
  });

  it.each([
    ['a missing amount due', '{"term":2027010100,"payments":[]}'],
    ['payments not an array', '{"term":2027010100,"totalWithoutBalanceAmount":800,"payments":{}}'],
    ['a payment without an amount', '{"term":2027010100,"totalWithoutBalanceAmount":800,"payments":[{"date":"01/01/2027","reference":"Tina"}]}'],
    ['an amount as text', '{"term":2027010100,"totalWithoutBalanceAmount":"800","payments":[]}'],
  ])('readRentTerm: %s → UNAVAILABLE, without the body in the message', async (_label, body) => {
    const stub = await startStub(200, body);
    try {
      const read = new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).readRentTerm('a.b.c', 'r', TENANT_A, '2027010100');
      await expectCode(read, 'UNAVAILABLE');
      await expect(read).rejects.not.toThrow(/Tina/);
    } finally {
      stub.close();
    }
  });

  it.each([
    ['not an object with rents', '[]'],
    ['a rent without _id', '{"rents":[{"term":2027010100,"totalWithoutBalanceAmount":800,"occupant":{"name":"Tina"}}]}'],
    ['an amount as text', '{"rents":[{"_id":"6512f0c2a1b2c3d4e5f60a01","term":2027010100,"totalWithoutBalanceAmount":"800","occupant":{"name":"Tina"}}]}'],
    ['a non-finite amount', '{"rents":[{"_id":"6512f0c2a1b2c3d4e5f60a01","term":2027010100,"totalWithoutBalanceAmount":1e400,"occupant":{"name":"Tina"}}]}'],
  ])('listRentTerms: %s → UNAVAILABLE, without the body in the message', async (_label, body) => {
    const stub = await startStub(200, body);
    try {
      const listing = new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listRentTerms('a.b.c', 'r', 2027, 1);
      await expectCode(listing, 'UNAVAILABLE');
      await expect(listing).rejects.not.toThrow(/Tina/);
    } finally {
      stub.close();
    }
  });

  it.each([
    ['not an object', '[]'],
    [
      'another Tenant',
      '{"_id":"6512f0c2a1b2c3d4e5f60a09","term":2027010100,"payments":[],"promo":0,"notepromo":"","extracharge":0,"noteextracharge":"","occupant":{"name":"Tina"}}',
    ],
    [
      'another term',
      '{"_id":"6512f0c2a1b2c3d4e5f60a01","term":2027020100,"payments":[],"promo":0,"notepromo":"","extracharge":0,"noteextracharge":"","occupant":{"name":"Tina"}}',
    ],
    [
      'promo missing',
      '{"_id":"6512f0c2a1b2c3d4e5f60a01","term":2027010100,"payments":[],"notepromo":"","extracharge":0,"noteextracharge":"","occupant":{"name":"Tina"}}',
    ],
  ])('readRentTermForWriteBack: %s → UNAVAILABLE, without the body in the message', async (_label, body) => {
    const stub = await startStub(200, body);
    try {
      const read = new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).readRentTermForWriteBack('a.b.c', 'r', TENANT_A, '2027010100');
      await expectCode(read, 'UNAVAILABLE');
      await expect(read).rejects.not.toThrow(/Tina/);
    } finally {
      stub.close();
    }
  });

  it('writeRentTermPayments: an error status is REFUSED; no answer, a timeout or an unreadable body is NO_ANSWER; 403 throws', async () => {
    const write = { payments: [], promo: 0, notepromo: '', extracharge: 0, noteextracharge: '', description: '' };
    const outcome = async (status: number, body: string, delayMs = 0) => {
      const stub = await startStub(status, body, delayMs);
      try {
        return await new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 200 }).writeRentTermPayments('a.b.c', 'r', TENANT_A, '2027010100', write);
      } finally {
        stub.close();
      }
    };
    expect(await outcome(500, '{}')).toEqual({ kind: 'REFUSED', status: 500 });
    expect(await outcome(200, 'not json')).toMatchObject({ kind: 'NO_ANSWER' });
    expect(await outcome(200, '{"term":1}')).toMatchObject({ kind: 'NO_ANSWER' });
    expect(await outcome(200, '{}', 500)).toMatchObject({ kind: 'NO_ANSWER' });
    await expectCode(outcome(403, ''), 'FORBIDDEN');
    expect(
      await new HttpMreClient({ apiBaseUrl: 'http://127.0.0.1:1/api/v2', timeoutMs: 200 }).writeRentTermPayments('a.b.c', 'r', TENANT_A, '2027010100', write),
    ).toMatchObject({
      kind: 'NO_ANSWER',
    });
  });

  it.each([
    [1e21, '1000000000000000000000'],
    [2.831068712794149e-15, '0.000000000000002831068712794149'],
    [-1.5e-7, '-0.00000015'],
    [1.25e25, '12500000000000000000000000'],
    [64.5, '64.5'],
  ])('decimalText(%j) is %s', (value, expected) => {
    expect(decimalText(value)).toBe(expected);
  });

  it('decimalText: not finite → undefined', () => {
    expect(decimalText(Number.NaN)).toBeUndefined();
    expect(decimalText(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it.each([
    [500, '{"status":500}'],
    [403, ''],
  ])('rentTermExists: status %i is no "not found"', async (status, body) => {
    const stub = await startStub(status, body);
    try {
      await expectCode(
        new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).rentTermExists('a.b.c', 'r', TENANT_A, '2027010100'),
        status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE',
      );
    } finally {
      stub.close();
    }
  });

  it.each([
    [64.5, '64.5'],
    [0, '0'],
    [120, '120'],
    [0.1, '0.1'],
    [33.333333333333336, '33.333333333333336'],
    [-5, null],
    [1e-7, null],
    [1e21, null],
    ['64.5', null],
    [null, null],
  ])('listProperties takes surface %j exactly as %j (no float arithmetic)', async (surface, expected) => {
    const stub = await startStub(200, JSON.stringify([{ _id: 'p1', surface }]));
    try {
      const [property] = await new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listProperties('a.b.c', 'r');
      expect(property?.surface?.toString() ?? null).toBe(expected);
    } finally {
      stub.close();
    }
  });

  it('listProperties keeps a property whose display fields are malformed, without them', async () => {
    const body = JSON.stringify([
      { _id: 'p1', name: 42, address: 'Berlin' },
      { _id: 'p2', name: 'ok', address: { street1: 7, city: 'Köln' } },
      { _id: 'p3', name: '' },
    ]);
    const stub = await startStub(200, body);
    try {
      expect(await new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listProperties('a.b.c', 'r')).toEqual([
        { mrePropertyId: 'p1', name: null, address: null, surface: null },
        { mrePropertyId: 'p2', name: 'ok', address: { city: 'Köln' }, surface: null },
        { mrePropertyId: 'p3', name: null, address: null, surface: null },
      ]);
    } finally {
      stub.close();
    }
  });

  it('drops members with unknown roles or shape individually, keeping the rest', async () => {
    const body = JSON.stringify([
      {
        _id: 'r1',
        name: 'n',
        members: [{ email: 'a@b', role: 'owner' }, { email: '', role: 'administrator' }, 'garbage', { email: 'c@d', role: 'renter' }],
      },
      { _id: 'r2', name: 'm', members: [{ email: 'a@b', role: 'administrator' }] },
    ]);
    const stub = await startStub(200, body);
    try {
      const realms = await new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 2000 }).listRealms('a.b.c');
      expect(realms).toEqual([
        { mreRealmId: 'r1', name: 'n', members: [{ email: 'c@d', role: 'renter' }] },
        { mreRealmId: 'r2', name: 'm', members: [{ email: 'a@b', role: 'administrator' }] },
      ]);
    } finally {
      stub.close();
    }
  });

  it('does not follow redirects with the caller token', async () => {
    const target = await startStub(200, '[]');
    const server = createServer((_req, res) => res.writeHead(302, { location: `${target.url}/realms` }).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expectCode(new HttpMreClient({ apiBaseUrl: `http://127.0.0.1:${port}/api/v2`, timeoutMs: 2000 }).listRealms('a.b.c'), 'UNAVAILABLE');
    } finally {
      server.close();
      target.close();
    }
  });

  it('times out → UNAVAILABLE', async () => {
    const stub = await startStub(200, '[]', 500);
    try {
      await expectCode(new HttpMreClient({ apiBaseUrl: stub.url, timeoutMs: 50 }).listRealms('a.b.c'), 'UNAVAILABLE');
    } finally {
      stub.close();
    }
  });

  it('connection refused → UNAVAILABLE', async () => {
    await expectCode(new HttpMreClient({ apiBaseUrl: 'http://127.0.0.1:9/api/v2', timeoutMs: 2000 }).listRealms('a.b.c'), 'UNAVAILABLE');
  });
});
