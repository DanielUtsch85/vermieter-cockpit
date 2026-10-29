import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessError,
  DepositCashAfterClosingDateError,
  DepositClosedError,
  DepositExistsError,
  DepositHasSplitsError,
  DepositNotActiveError,
  DepositNotClosedError,
  DepositStillHeldError,
  ExpectedAmountRequiredError,
  HoldingAccountNotFoundError,
  IdempotencyKeyConflictError,
  MreTenantNotFoundError,
  MreUnavailableError,
  NotASecurityDepositAccountError,
  NothingRetainedError,
  SecurityDepositNotFoundError,
  UnconfirmedDepositCashError,
  VersionConflictError,
  type CreateDepositInput,
  type DepositChanges,
  type PrincipalVerifier,
  type DepositView,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-5-01 HTTP contract (api-design.md §47.1). */
const REALM = '64b0c0ffee0000000000000a';
const ID = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const ACCOUNT = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';
const TX = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
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
  closing: null,
  createdAt: new Date('2027-01-15T10:00:00Z'),
  version: 1,
  figures: {
    received: Money.of('1500.00', 'EUR'),
    interestCredited: Money.of('1.20', 'EUR'),
    returned: Money.of('0.00', 'EUR'),
    outstanding: Money.of('1500.00', 'EUR'),
    held: Money.of('1501.20', 'EUR'),
    state: 'PARTIALLY_RECEIVED',
    flags: [{ code: 'RECEIVED_OUTSIDE_HOLDING_ACCOUNT', details: { transactionIds: [TX] } }],
  },
} as unknown as DepositView;

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
  closing: null,
  createdAt: '2027-01-15T10:00:00.000Z',
  version: 1,
  received: { amount: '1500.00', currency: 'EUR' },
  interestCredited: { amount: '1.20', currency: 'EUR' },
  returned: { amount: '0.00', currency: 'EUR' },
  outstanding: { amount: '1500.00', currency: 'EUR' },
  held: { amount: '1501.20', currency: 'EUR' },
  state: 'PARTIALLY_RECEIVED',
  flags: [{ code: 'RECEIVED_OUTSIDE_HOLDING_ACCOUNT', details: { transactionIds: [TX] } }],
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
      securityDeposits: { amend: async (input) => (seen.push(input), { deposit: { ...deposit, version: 2 } as DepositView, changed: true }) },
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
          deposit: { ...deposit, status: 'VOID', voidReason: reason, voidedAt: new Date('2027-02-01T00:00:00Z'), version: 2 } as DepositView,
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

describe('derived figures (§47.3)', () => {
  it('the single read adds cash; a flag with an amount is Money; the list passes the state filter', async () => {
    const withCash = {
      ...deposit,
      figures: { ...deposit.figures, flags: [{ code: 'RETURNED_EXCEEDS_HELD', details: { excess: Money.of('10.00', 'EUR') } }] },
      cash: [{ transactionId: TX, bookingDate: '2027-02-01', financialAccountId: ACCOUNT, kind: 'RECEIPT', amount: Money.of('1500.00', 'EUR') }],
    } as unknown as DepositView;
    const seen: unknown[] = [];
    const base = await start({
      securityDeposits: {
        get: async () => withCash,
        list: async (input) => (seen.push(input), { items: [deposit], page: 1, pageSize: 50, total: 1 }),
      },
    });
    const one = (await (await call(base, 'GET', `/security-deposits/${ID}`)).json()) as Record<string, unknown>;
    expect(one['cash']).toEqual([
      { transactionId: TX, bookingDate: '2027-02-01', financialAccountId: ACCOUNT, kind: 'RECEIPT', amount: { amount: '1500.00', currency: 'EUR' } },
    ]);
    expect(one['flags']).toEqual([{ code: 'RETURNED_EXCEEDS_HELD', details: { excess: { amount: '10.00', currency: 'EUR' } } }]);
    const listed = (await (await call(base, 'GET', '/security-deposits?state=RECEIVED,PARTIALLY_RECEIVED')).json()) as { items: Record<string, unknown>[] };
    expect(listed.items[0]).not.toHaveProperty('cash');
    expect(seen[0]).toMatchObject({ filter: { states: ['RECEIVED', 'PARTIALLY_RECEIVED'] } });
    for (const query of ['state=HELD', 'state=', 'state=OFFSET']) expect((await call(base, 'GET', `/security-deposits?${query}`)).status, query).toBe(400);
  });
});

describe('close, reopen and checkMre (§47.4)', () => {
  const closedDeposit = {
    ...deposit,
    status: 'CLOSED',
    closing: { closingDate: '2027-06-30', reason: 'RETAINED', closingNote: 'Nebenkosten', heldAtClosing: Money.of('500.00', 'EUR') },
    figures: {
      ...deposit.figures,
      state: 'CLOSED',
      flags: [{ code: 'HELD_CHANGED_AFTER_CLOSING', details: { heldAtClosing: Money.of('500.00', 'EUR'), held: Money.of('1501.20', 'EUR') } }],
    },
    version: 2,
  } as unknown as DepositView;

  it('close: the body passed, closing on the response with retainedAmount, Money in the flag; If-Match carries the versions', async () => {
    const seen: unknown[] = [];
    let answer = closedDeposit;
    const base = await start({ securityDeposits: { close: async (input) => (seen.push(input), { deposit: answer, changed: true }) } });
    const res = await call(
      base,
      'POST',
      `/security-deposits/${ID}/close`,
      { closingDate: '2027-06-30', reason: 'RETAINED', closingNote: ' Nebenkosten ' },
      { 'if-match': '"1"' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"2"');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['closing']).toEqual({
      closingDate: '2027-06-30',
      reason: 'RETAINED',
      closingNote: 'Nebenkosten',
      heldAtClosing: { amount: '500.00', currency: 'EUR' },
      retainedAmount: { amount: '500.00', currency: 'EUR' },
    });
    expect(body['flags']).toEqual([
      { code: 'HELD_CHANGED_AFTER_CLOSING', details: { heldAtClosing: { amount: '500.00', currency: 'EUR' }, held: { amount: '1501.20', currency: 'EUR' } } },
    ]);
    expect(seen[0]).toMatchObject({
      securityDepositId: ID,
      request: { closingDate: '2027-06-30', reason: 'RETAINED', closingNote: 'Nebenkosten' },
      expectedVersions: [1],
    });
    await call(base, 'POST', `/security-deposits/${ID}/close`, { closingDate: '2027-06-30', reason: 'RETURNED' });
    expect(seen[1]).toMatchObject({ request: { reason: 'RETURNED', closingNote: null } });
    expect(seen[1]).not.toHaveProperty('expectedVersions');
    // RETURNED: nothing retained.
    answer = {
      ...closedDeposit,
      closing: { closingDate: '2027-06-30', reason: 'RETURNED', closingNote: null, heldAtClosing: Money.of('0.00', 'EUR') },
    } as unknown as DepositView;
    const json = (await (await call(base, 'POST', `/security-deposits/${ID}/close`, { closingDate: '2027-06-30', reason: 'RETURNED' })).json()) as Record<
      string,
      unknown
    >;
    expect(json['closing']).toMatchObject({ retainedAmount: { amount: '0.00', currency: 'EUR' } });
  });

  it('close: every 400', async () => {
    const base = await start({ securityDeposits: { close: async () => ({ deposit: closedDeposit, changed: true }) } });
    const cases: [unknown, string, string][] = [
      [{ reason: 'RETURNED' }, 'closingDate', 'REQUIRED'],
      [{ closingDate: '2027-02-30', reason: 'RETURNED' }, 'closingDate', ''],
      [{ closingDate: '2027-06-30' }, 'reason', ''],
      [{ closingDate: '2027-06-30', reason: 'REFINANCED' }, 'reason', ''],
      [{ closingDate: '2027-06-30', reason: 'RETAINED' }, 'closingNote', 'REQUIRED'],
      [{ closingDate: '2027-06-30', reason: 'OTHER', closingNote: '  ' }, 'closingNote', 'REQUIRED'],
      [{ closingDate: '2027-06-30', reason: 'OTHER', closingNote: 'x'.repeat(501) }, 'closingNote', ''],
      [{ closingDate: '2027-06-30', reason: 'RETURNED', heldAtClosing: { amount: '0.00', currency: 'EUR' } }, '', ''],
    ];
    for (const [body, field, code] of cases) {
      const res = await call(base, 'POST', `/security-deposits/${ID}/close`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const fields = ((await errorOf(res)).details as { fields: { field: string; code: string }[] }).fields;
      if (field !== '')
        expect(
          fields.map((f) => f.field),
          JSON.stringify(body),
        ).toContain(field);
      if (code !== '') expect(fields.find((f) => f.field === field)?.code, JSON.stringify(body)).toBe(code);
    }
    expect((await call(base, 'POST', `/security-deposits/nope/close`, { closingDate: '2027-06-30', reason: 'RETURNED' })).status).toBe(400);
  });

  it.each([
    [new DepositNotActiveError(ID, 'CLOSED'), 409, { reason: 'DEPOSIT_NOT_ACTIVE', securityDepositId: ID, status: 'CLOSED' }],
    [new DepositCashAfterClosingDateError([TX]), 409, { reason: 'CASH_AFTER_CLOSING_DATE', transactionIds: [TX] }],
    [new UnconfirmedDepositCashError([TX]), 409, { reason: 'UNCONFIRMED_CASH', transactionIds: [TX] }],
    [new DepositStillHeldError(Money.of('-5.00', 'EUR')), 409, { reason: 'DEPOSIT_STILL_HELD', held: { amount: '-5.00', currency: 'EUR' } }],
    [new NothingRetainedError(Money.of('0.00', 'EUR')), 409, { reason: 'NOTHING_RETAINED', held: { amount: '0.00', currency: 'EUR' } }],
    [new VersionConflictError([1], 2), 412, { currentVersion: 2 }],
  ])('close: %s → %i', async (error, status, details) => {
    const base = await start({ securityDeposits: { close: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', `/security-deposits/${ID}/close`, { closingDate: '2027-06-30', reason: 'RETURNED' });
    expect(res.status).toBe(status);
    expect((await errorOf(res)).details).toMatchObject(details);
  });

  it('reopen: an empty body or {}; anything else 400; DEPOSIT_NOT_CLOSED and 412 mapped', async () => {
    const seen: unknown[] = [];
    let failure: Error | undefined;
    const base = await start({
      securityDeposits: { reopen: async (input) => (failure === undefined ? (seen.push(input), { deposit, changed: true }) : Promise.reject(failure)) },
    });
    const empty = await fetch(`${base}/api/v1/security-deposits/${ID}/reopen`, {
      method: 'POST',
      headers: { authorization: 'Bearer a.b.c', organizationid: REALM, 'if-match': '"2"' },
    });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as Record<string, unknown>)['closing']).toBeNull();
    expect((await call(base, 'POST', `/security-deposits/${ID}/reopen`, {})).status).toBe(200);
    expect(seen).toMatchObject([{ securityDepositId: ID, expectedVersions: [2] }, { securityDepositId: ID }]);
    expect((await call(base, 'POST', `/security-deposits/${ID}/reopen`, { reason: 'x' })).status).toBe(400);
    for (const [error, status, details] of [
      [new DepositNotClosedError(ID, 'VOID'), 409, { reason: 'DEPOSIT_NOT_CLOSED', status: 'VOID' }],
      [new VersionConflictError([1], 2), 412, { currentVersion: 2 }],
    ] as const) {
      failure = error;
      const res = await call(base, 'POST', `/security-deposits/${ID}/reopen`, {});
      expect(res.status).toBe(status);
      expect((await errorOf(res)).details).toMatchObject(details);
    }
  });

  it('checkMre: only true asks for the comparison with the bearer token; mre and its flags on the response; anything else 400', async () => {
    const seen: unknown[] = [];
    const compared = {
      ...deposit,
      mre: { guaranty: Money.of('2500.00', 'EUR'), guarantyPayback: null },
      figures: {
        ...deposit.figures,
        flags: [{ code: 'EXPECTED_DIFFERS_FROM_MRE', details: { guaranty: Money.of('2500.00', 'EUR'), expectedAmount: Money.of('3000.00', 'EUR') } }],
      },
    } as unknown as DepositView;
    let mreDown = false;
    const unavailable = { ...deposit, mre: null, figures: { ...deposit.figures, flags: [{ code: 'MRE_UNAVAILABLE', details: {} }] } } as unknown as DepositView;
    const base = await start({
      securityDeposits: { get: async (input) => (seen.push(input), input.checkMre === undefined ? deposit : mreDown ? unavailable : compared) },
    });
    expect(await (await call(base, 'GET', `/security-deposits/${ID}`)).json()).not.toHaveProperty('mre');
    expect(await (await call(base, 'GET', `/security-deposits/${ID}?checkMre=false`)).json()).not.toHaveProperty('mre');
    const body = (await (await call(base, 'GET', `/security-deposits/${ID}?checkMre=true`)).json()) as Record<string, unknown>;
    expect(body['mre']).toEqual({ guaranty: { amount: '2500.00', currency: 'EUR' }, guarantyPayback: null });
    expect(body['flags']).toEqual([
      {
        code: 'EXPECTED_DIFFERS_FROM_MRE',
        details: { guaranty: { amount: '2500.00', currency: 'EUR' }, expectedAmount: { amount: '3000.00', currency: 'EUR' } },
      },
    ]);
    expect(seen).toMatchObject([{}, {}, { checkMre: { authorizationHeader: 'Bearer a.b.c' } }]);
    expect(seen[0]).not.toHaveProperty('checkMre');
    for (const query of ['checkMre=yes', 'checkMre=', 'other=1'])
      expect((await call(base, 'GET', `/security-deposits/${ID}?${query}`)).status, query).toBe(400);
    mreDown = true;
    const answer = (await (await call(base, 'GET', `/security-deposits/${ID}?checkMre=true`)).json()) as Record<string, unknown>;
    expect([answer['mre'], answer['flags']]).toEqual([null, [{ code: 'MRE_UNAVAILABLE', details: {} }]]);
  });
});
