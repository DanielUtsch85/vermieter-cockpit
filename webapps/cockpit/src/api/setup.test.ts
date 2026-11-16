import { describe, expect, it } from 'vitest';
import { USED_ROUTES } from '../gate/backend-pin';
import { account, property, REALM_A, REALM_B } from '../transactions/fixtures.test-support';
import { createDeClient } from './client';
import { CLIENT_CODES } from './errors';
import { countingTokens, envelope, json, scriptedFetch, type Call } from './fetch.test-support';
import { createFinancialAccount, linkPropertyReference, listMreProperties } from './setup';

/**
 * Client contract of the setup (Issue #365): the two DE commands and MRE's property list as they leave the browser, and
 * the answers the client accepts (api-design.md §23.1, §29.1, §29.2; mre-integration.md §21.1). Synthetic data only.
 */

function client(...answers: Parameters<typeof scriptedFetch>) {
  const { fetch, calls } = scriptedFetch(...answers);
  return { client: createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch }), calls };
}

const IBAN = 'DE89370400440532013000';
const BODY = { accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR', iban: IBAN } as const;
const MRE_PROPERTY = '64b7f0c2a1b2c3d4e5f60721';
const created = account({ financialAccountId: 'c2be5b4a-6d7f-4a89-9bac-4c5d6e7f8091', displayName: 'Girokonto', iban: IBAN });

describe('POST /financial-accounts (api-design.md §29.1, §29.2)', () => {
  it('one JSON request with the Realm, the token and the Idempotency-Key of the intent; no If-Match', async () => {
    const { client: de, calls } = client(json(201, created));
    expect(await createFinancialAccount(de, BODY, 'key-1')).toEqual(created);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/api/v1/financial-accounts');
    expect(call?.body).toBe(JSON.stringify(BODY));
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.headers.get('idempotency-key')).toBe('key-1');
    expect(call?.headers.get('organizationid')).toBe(REALM_A);
    expect(call?.headers.get('authorization')).toBe('Bearer token-1');
    expect(call?.headers.has('if-match')).toBe(false);
  });

  it('a replay answers the account of the first request and is accepted as it', async () => {
    const { client: de } = client(json(201, created, { 'idempotent-replayed': 'true' }));
    expect(await createFinancialAccount(de, BODY, 'key-1')).toEqual(created);
  });

  it('an account of another Realm or another account is refused, never shown', async () => {
    const { client: de } = client(
      json(201, { ...created, mreRealmId: REALM_B }),
      json(201, { ...created, displayName: 'Anderes Konto' }),
      json(201, { ...created, iban: null }),
      json(201, { ...created, accountType: 'CASH' }),
    );
    await expect(createFinancialAccount(de, BODY, 'k')).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    for (let i = 0; i < 3; i += 1) await expect(createFinancialAccount(de, BODY, 'k')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });

  it('refusals keep their status, code and field errors', async () => {
    const { client: de } = client(
      envelope(400, 'VALIDATION_ERROR', { fields: [{ field: 'iban', code: 'INVALID_FORMAT' }] }),
      envelope(409, 'CONFLICT'),
      new TypeError('network down'),
    );
    await expect(createFinancialAccount(de, BODY, 'k')).rejects.toMatchObject({ status: 400, fields: [{ field: 'iban', code: 'INVALID_FORMAT' }] });
    await expect(createFinancialAccount(de, BODY, 'k')).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    await expect(createFinancialAccount(de, BODY, 'k')).rejects.toMatchObject({ status: 0, code: CLIENT_CODES.network });
  });
});

describe('POST /property-references/link (api-design.md §23.1)', () => {
  const linked = property({ mrePropertyId: MRE_PROPERTY, displayName: 'Testhaus Wohnung 2' });

  it('the body names the Realm of the client and the MRE property; no Idempotency-Key, no If-Match', async () => {
    const { client: de, calls } = client(json(201, linked));
    expect(await linkPropertyReference(de, MRE_PROPERTY)).toEqual(linked);
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/api/v1/property-references/link');
    expect(call?.body).toBe(JSON.stringify({ mreRealmId: REALM_A, mrePropertyId: MRE_PROPERTY }));
    expect(call?.headers.get('organizationid')).toBe(REALM_A);
    expect(call?.headers.has('idempotency-key')).toBe(false);
    expect(call?.headers.has('if-match')).toBe(false);
  });

  it('a repeat is a 200 with the existing reference and accepted', async () => {
    const { client: de } = client(json(200, linked));
    expect(await linkPropertyReference(de, MRE_PROPERTY)).toEqual(linked);
  });

  it('a reference of another Realm or another MRE property is refused, never shown', async () => {
    const { client: de } = client(json(201, { ...linked, mreRealmId: REALM_B }), json(201, { ...linked, mrePropertyId: '64b7f0c2a1b2c3d4e5f60722' }));
    await expect(linkPropertyReference(de, MRE_PROPERTY)).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    await expect(linkPropertyReference(de, MRE_PROPERTY)).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });

  it('404, 403 and 503 keep their status', async () => {
    const { client: de } = client(envelope(404, 'NOT_FOUND'), envelope(403, 'FORBIDDEN'), envelope(503, 'EXTERNAL_SYSTEM_ERROR'));
    for (const status of [404, 403, 503]) await expect(linkPropertyReference(de, MRE_PROPERTY)).rejects.toMatchObject({ status });
  });
});

describe('MRE property list (mre-integration.md §21, §21.1)', () => {
  it('GET /api/v2/properties with organizationid and the token; only id and name are read', async () => {
    const { fetch, calls } = scriptedFetch(
      json(200, [
        { _id: MRE_PROPERTY, name: ' Testhaus Wohnung 2 ', price: 700, address: { street1: 'Teststraße 1' } },
        { _id: '64b7f0c2a1b2c3d4e5f60723' },
        { _id: 'not-an-object-id', name: 'Kaputt' },
        { name: 'Ohne ID' },
        null,
      ]),
    );
    const list = await listMreProperties(countingTokens(), REALM_A, fetch);
    expect(list).toEqual([
      { id: MRE_PROPERTY, name: 'Testhaus Wohnung 2' },
      { id: '64b7f0c2a1b2c3d4e5f60723', name: '' },
    ]);
    const call = calls[0];
    expect(call?.method).toBe('GET');
    expect(call?.url).toBe('/api/v2/properties');
    expect(call?.headers.get('organizationid')).toBe(REALM_A);
    expect(call?.headers.get('authorization')).toBe('Bearer token-1');
  });

  it('an answer that is not a list is unexpected; a refusal keeps its status; a 401 renews once', async () => {
    const tokens = countingTokens();
    const { fetch, calls } = scriptedFetch(json(200, { items: [] }), envelope(404, 'NOT_FOUND'), json(401, {}), json(200, []));
    await expect(listMreProperties(tokens, REALM_A, fetch)).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(listMreProperties(tokens, REALM_A, fetch)).rejects.toMatchObject({ status: 404 });
    expect(await listMreProperties(tokens, REALM_A, fetch)).toEqual([]);
    expect(calls.map((call) => call.headers.get('authorization'))).toEqual(['Bearer token-1', 'Bearer token-1', 'Bearer token-1', 'Bearer token-2']);
  });
});

/** The inventory route a call reached: its path matched against the `:parameter` templates of `USED_ROUTES`. */
function routeOf(call: Pick<Call, 'url' | 'method'>): string | undefined {
  const path = new URL(call.url, 'https://cockpit.internal').pathname;
  const used = USED_ROUTES.find(([method, template]) => method === call.method && new RegExp(`^${template.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path));
  return used === undefined ? undefined : `${used[0]} ${used[1]}`;
}

describe('integration gate: the setup calls only routes of the pinned inventory', () => {
  it('both DE commands are routes of USED_ROUTES', async () => {
    const { client: de, calls } = client(json(201, created), json(201, property({ mrePropertyId: MRE_PROPERTY })));
    await createFinancialAccount(de, BODY, 'k');
    await linkPropertyReference(de, MRE_PROPERTY);
    expect(calls.map(routeOf)).toEqual(['POST /api/v1/financial-accounts', 'POST /api/v1/property-references/link']);
  });

  it('counter-check: closing an account or refreshing a reference is not a route the cockpit calls', () => {
    expect(routeOf({ url: `/api/v1/financial-accounts/${created.financialAccountId}/close`, method: 'POST' })).toBeUndefined();
    expect(routeOf({ url: `/api/v1/property-references/${created.financialAccountId}/refresh`, method: 'POST' })).toBeUndefined();
  });
});
