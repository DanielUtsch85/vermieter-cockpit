import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessError,
  DepositClosedError,
  DepositExistsError,
  DepositHasSplitsError,
  DepositNotActiveError,
  ExpectedAmountRequiredError,
  HoldingAccountNotFoundError,
  IdempotencyKeyConflictError,
  MreTenantNotFoundError,
  MreUnavailableError,
  NotASecurityDepositAccountError,
  SecurityDepositNotFoundError,
  VersionConflictError,
  type CreateDepositInput,
  type DepositChanges,
  type PrincipalVerifier,
  type SecurityDeposit,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-5-01 HTTP contract (api-design.md §47.1). */
const REALM = '64b0c0ffee0000000000000a';
const ID = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const ACCOUNT = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';
const deposit = {
  id: ID,
  mreRealmId: REALM,
  status: 'ACTIVE',
  mreTenantId: TENANT,
  expectedAmount: Money.of('3000.00', 'EUR'),
  expectedAmountSource: 'MRE_GUARANTY',
  holdingFinancialAccountId: ACCOUNT,
  interestBearing: true,
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2027-01-15T10:00:00Z'),
  version: 1,
} as unknown as SecurityDeposit;

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });
let server: Server | undefined;

async function start(commands: CommandOverrides): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith(commands) }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const headers = { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json' };
const call = (base: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/v1${path}`, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; details?: unknown } }).error;
const dto = {
  securityDepositId: ID,
  mreRealmId: REALM,
  status: 'ACTIVE',
  mreTenantId: TENANT,
  expectedAmount: { amount: '3000.00', currency: 'EUR' },
  expectedAmountSource: 'MRE_GUARANTY',
  holdingFinancialAccountId: ACCOUNT,
  interestBearing: true,
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: '2027-01-15T10:00:00.000Z',
  version: 1,
};

describe('POST /api/v1/security-deposits', () => {
  it('201 with the deposit and ETag; defaults (no amount, interest-bearing), the bearer token passed; a replay is marked', async () => {
    const seen: CreateDepositInput[] = [];
    let replayed = false;
    const base = await start({
      securityDeposits: {
        create: async (input) => {
          seen.push(input);
          const answer = { deposit, replayed };
          replayed = true;
          return answer;
        },
      },
    });
    const res = await call(
      base,
      'POST',
      '/security-deposits',
      { mreTenantId: TENANT, holdingFinancialAccountId: ACCOUNT.toUpperCase() },
      { 'idempotency-key': 'k1' },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    expect(await res.json()).toEqual(dto);
    expect(seen[0]).toMatchObject({
      authorizationHeader: 'Bearer a.b.c',
      mreTenantId: TENANT,
      expectedAmount: null,
      holdingFinancialAccountId: ACCOUNT,
      interestBearing: true,
      notes: null,
      idempotencyKey: 'k1',
    });
    const again = await call(base, 'POST', '/security-deposits', { mreTenantId: TENANT }, { 'idempotency-key': 'k1' });
    expect(again.headers.get('idempotent-replayed')).toBe('true');
  });

  it('passes an amount, interestBearing false and trimmed notes', async () => {
    const seen: CreateDepositInput[] = [];
    const base = await start({ securityDeposits: { create: async (input) => (seen.push(input), { deposit, replayed: false }) } });
    await call(base, 'POST', '/security-deposits', {
      mreTenantId: TENANT,
      expectedAmount: { amount: '2500', currency: 'EUR' },
      interestBearing: false,
      notes: ' Gewerbe ',
    });
    expect(seen[0]?.expectedAmount?.toJSON()).toEqual({ amount: '2500.00', currency: 'EUR' });
    expect(seen[0]).toMatchObject({ interestBearing: false, notes: 'Gewerbe', holdingFinancialAccountId: null });
  });

  it('400: a missing or malformed Tenant, a non-positive amount, unknown and derived keys', async () => {
    const base = await start({});
    const fieldsOf = async (payload: unknown) => {
      const res = await call(base, 'POST', '/security-deposits', payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    expect(await fieldsOf({})).toEqual([{ field: 'mreTenantId', code: 'REQUIRED' }]);
    expect(await fieldsOf({ mreTenantId: 'ABC' })).toEqual([{ field: 'mreTenantId', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf({ mreTenantId: TENANT, expectedAmount: { amount: '0.00', currency: 'EUR' } })).toEqual([
      { field: 'expectedAmount.amount', code: 'NOT_POSITIVE' },
    ]);
    // A negative amount is §31's general Money rule.
    expect(await fieldsOf({ mreTenantId: TENANT, expectedAmount: { amount: '-1.00', currency: 'EUR' } })).toEqual([
      { field: 'expectedAmount.amount', code: 'NEGATIVE_AMOUNT' },
    ]);
    // Data-model §26's fields that P5-D1 dropped or P5-D2 derives are unknown keys.
    for (const key of ['status', 'propertyReferenceId', 'receivedAmount', 'leaseStartDate']) await fieldsOf({ mreTenantId: TENANT, [key]: 'x' });
    await fieldsOf({ mreTenantId: TENANT, holdingFinancialAccountId: 'x' });
  });

  it.each([
    [new HoldingAccountNotFoundError(ACCOUNT), 404, 'NOT_FOUND', { financialAccountId: ACCOUNT }],
    [new NotASecurityDepositAccountError(ACCOUNT, 'BANK'), 422, 'NOT_A_SECURITY_DEPOSIT_ACCOUNT', { financialAccountId: ACCOUNT, accountType: 'BANK' }],
    [new DepositExistsError(ID), 409, 'CONFLICT', { reason: 'DEPOSIT_EXISTS', securityDepositId: ID }],
    [new MreTenantNotFoundError(TENANT), 404, 'NOT_FOUND', { externalId: TENANT }],
    [new ExpectedAmountRequiredError(TENANT), 422, 'EXPECTED_AMOUNT_REQUIRED', undefined],
    [new AccessError('FORBIDDEN', 'x'), 403, 'FORBIDDEN', undefined],
    [new MreUnavailableError('x'), 503, 'EXTERNAL_SYSTEM_ERROR', undefined],
    [new IdempotencyKeyConflictError('x'), 409, 'CONFLICT', undefined],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ securityDeposits: { create: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', '/security-deposits', { mreTenantId: TENANT });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject(details === undefined ? { code } : { code, details });
  });
});

describe('GET /api/v1/security-deposits', () => {
  it('passes the filters (a comma list of statuses) and the page; items as DTOs', async () => {
    const seen: unknown[] = [];
    const base = await start({
      securityDeposits: { list: async (input) => (seen.push(input), { items: [deposit], page: 2, pageSize: 10, total: 11 }) },
    });
    const res = await call(
      base,
      'GET',
      `/security-deposits?status=ACTIVE,CLOSED&mreTenantId=${TENANT}&holdingFinancialAccountId=${ACCOUNT}&page=2&pageSize=10`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [dto], page: 2, pageSize: 10, total: 11 });
    expect(seen[0]).toMatchObject({
      filter: { statuses: ['ACTIVE', 'CLOSED'], mreTenantId: TENANT, holdingFinancialAccountId: ACCOUNT },
      page: { page: 2, pageSize: 10 },
    });
  });

  it('defaults to page 1 of 50 without filters; 400 for an unknown status, a malformed Tenant or an unknown parameter', async () => {
    const seen: unknown[] = [];
    const base = await start({ securityDeposits: { list: async (input) => (seen.push(input), { items: [], page: 1, pageSize: 50, total: 0 }) } });
    expect((await call(base, 'GET', '/security-deposits')).status).toBe(200);
    expect(seen[0]).toMatchObject({ filter: {}, page: { page: 1, pageSize: 50 } });
    for (const query of ['status=OPEN', 'status=', 'mreTenantId=x', 'propertyReferenceId=x', 'pageSize=201']) {
      expect((await call(base, 'GET', `/security-deposits?${query}`)).status, query).toBe(400);
    }
  });
});

describe('GET /api/v1/security-deposits/{id}', () => {
  it('200 with ETag; 404 when unknown', async () => {
    const base = await start({
      securityDeposits: {
        get: async ({ securityDepositId }) => (securityDepositId === ID ? deposit : Promise.reject(new SecurityDepositNotFoundError(securityDepositId))),
      },
    });
    const res = await call(base, 'GET', `/security-deposits/${ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(await res.json()).toEqual(dto);
    const missing = await call(base, 'GET', `/security-deposits/${ACCOUNT}`);
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toMatchObject({ code: 'NOT_FOUND', details: { securityDepositId: ACCOUNT } });
  });
});

describe('POST /api/v1/security-deposits/{id}/amend', () => {
  it('passes only the given fields; null clears; If-Match carries the versions', async () => {
    const seen: { changes: DepositChanges; expectedVersions?: readonly number[] }[] = [];
    const base = await start({
      securityDeposits: { amend: async (input) => (seen.push(input), { deposit: { ...deposit, version: 2 } as SecurityDeposit, changed: true }) },
    });
    const res = await call(base, 'POST', `/security-deposits/${ID}/amend`, { holdingFinancialAccountId: null, notes: '' }, { 'if-match': '"1"' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"2"');
    expect(seen[0]).toEqual(expect.objectContaining({ changes: { holdingFinancialAccountId: null, notes: null }, expectedVersions: [1] }));
  });

  it('400: the Tenant NOT_AMENDABLE, an empty body REQUIRED, a non-positive amount, unknown keys', async () => {
    const base = await start({});
    const fieldsOf = async (payload: unknown) => {
      const res = await call(base, 'POST', `/security-deposits/${ID}/amend`, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    expect(await fieldsOf({ mreTenantId: TENANT })).toEqual([{ field: 'mreTenantId', code: 'NOT_AMENDABLE' }]);
    expect(await fieldsOf({})).toEqual([{ field: '(body)', code: 'REQUIRED' }]);
    expect(await fieldsOf({ expectedAmount: { amount: '0', currency: 'EUR' } })).toEqual([{ field: 'expectedAmount.amount', code: 'NOT_POSITIVE' }]);
    await fieldsOf({ status: 'VOID' });
    await fieldsOf({ expectedAmountSource: 'REQUEST' });
  });

  it.each([
    [new SecurityDepositNotFoundError(ID), 404, 'NOT_FOUND', { securityDepositId: ID }],
    [new DepositNotActiveError(ID, 'VOID'), 409, 'CONFLICT', { reason: 'DEPOSIT_NOT_ACTIVE', status: 'VOID' }],
    [new HoldingAccountNotFoundError(ACCOUNT), 404, 'NOT_FOUND', { financialAccountId: ACCOUNT }],
    [new NotASecurityDepositAccountError(ACCOUNT, 'CASH'), 422, 'NOT_A_SECURITY_DEPOSIT_ACCOUNT', { accountType: 'CASH' }],
    [new VersionConflictError([1], 2), 412, 'VERSION_CONFLICT', { expectedVersions: [1], currentVersion: 2 }],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ securityDeposits: { amend: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', `/security-deposits/${ID}/amend`, { notes: 'x' });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});

describe('POST /api/v1/security-deposits/{id}/void', () => {
  it('200 with the deposit; the reason trimmed and required', async () => {
    const base = await start({
      securityDeposits: {
        void: async ({ reason }) => ({
          deposit: { ...deposit, status: 'VOID', voidReason: reason, voidedAt: new Date('2027-02-01T00:00:00Z'), version: 2 } as SecurityDeposit,
          changed: true,
        }),
      },
    });
    const res = await call(base, 'POST', `/security-deposits/${ID}/void`, { reason: ' Doppelt ' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"2"');
    expect(await res.json()).toMatchObject({ status: 'VOID', voidReason: 'Doppelt', voidedAt: '2027-02-01T00:00:00.000Z' });
    expect((await call(base, 'POST', `/security-deposits/${ID}/void`, { reason: ' ' })).status).toBe(400);
    expect((await call(base, 'POST', `/security-deposits/${ID}/void`, {})).status).toBe(400);
    expect((await call(base, 'POST', `/security-deposits/${ID}/void`, { reason: 'x'.repeat(501) })).status).toBe(400);
  });

  it.each([
    [new SecurityDepositNotFoundError(ID), 404, 'NOT_FOUND', { securityDepositId: ID }],
    [new DepositClosedError(ID), 409, 'CONFLICT', { reason: 'DEPOSIT_CLOSED', securityDepositId: ID }],
    [new DepositHasSplitsError(ID, [ACCOUNT]), 409, 'CONFLICT', { reason: 'DEPOSIT_HAS_SPLITS', transactionIds: [ACCOUNT] }],
    [new VersionConflictError([1], 2), 412, 'VERSION_CONFLICT', { currentVersion: 2 }],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ securityDeposits: { void: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', `/security-deposits/${ID}/void`, { reason: 'x' });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});
