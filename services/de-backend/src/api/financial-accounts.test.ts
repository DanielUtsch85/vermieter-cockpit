import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FinancialAccountNotFoundError,
  IdempotencyKeyConflictError,
  type CloseFinancialAccount,
  type CreateFinancialAccount,
  type CreateFinancialAccountInput,
  type FinancialAccount,
  type PrincipalVerifier,
} from '../application/index.js';
import { createApp } from './app.js';
import { unusedCommands } from './app.test-support.js';

const REALM = '64b0c0ffee0000000000000a';
const ID = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const account = {
  id: ID,
  mreRealmId: REALM,
  accountType: 'BANK',
  displayName: 'Girokonto',
  currency: 'EUR',
  iban: 'DE89370400440532013000',
  status: 'OPEN',
  createdAt: new Date('2026-10-19T08:00:00Z'),
  closedAt: null,
  version: 1,
} as FinancialAccount;

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({
  email: 'anna@example.com',
  mreRealmId: mreRealmId ?? '',
  mreRole: 'administrator',
});

let server: Server | undefined;

async function start(commands: { create?: CreateFinancialAccount; close?: CloseFinancialAccount }): Promise<string> {
  server = createApp({
    isReady: async () => true,
    verifyPrincipal: admin,
    ...unusedCommands,
    ...(commands.create === undefined ? {} : { createFinancialAccount: commands.create }),
    ...(commands.close === undefined ? {} : { closeFinancialAccount: commands.close }),
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const headers = { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json' };
const post = (base: string, body: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/financial-accounts`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });

describe('POST /api/v1/financial-accounts', () => {
  it('201 with the account; the use case gets normalized input and the key', async () => {
    const seen: CreateFinancialAccountInput[] = [];
    const base = await start({ create: async (input) => (seen.push(input), { account, replayed: false }) });
    const res = await post(
      base,
      { accountType: 'BANK', displayName: '  Girokonto ', currency: 'EUR', iban: 'de89 3704 0044 0532 0130 00' },
      { 'idempotency-key': 'k-1' },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    expect(await res.json()).toEqual({
      financialAccountId: ID,
      mreRealmId: REALM,
      accountType: 'BANK',
      displayName: 'Girokonto',
      currency: 'EUR',
      iban: 'DE89370400440532013000',
      status: 'OPEN',
      createdAt: '2026-10-19T08:00:00.000Z',
      closedAt: null,
      version: 1,
    });
    expect(seen).toEqual([
      {
        principal: { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' },
        accountType: 'BANK',
        displayName: 'Girokonto',
        currency: 'EUR',
        iban: 'DE89370400440532013000',
        idempotencyKey: 'k-1',
      },
    ]);
  });

  it('without iban and key: iban null, no key passed', async () => {
    const seen: CreateFinancialAccountInput[] = [];
    const base = await start({ create: async (input) => (seen.push(input), { account, replayed: false }) });
    expect((await post(base, { accountType: 'CASH', displayName: 'Kasse', currency: 'EUR' })).status).toBe(201);
    expect(seen[0]).toMatchObject({ accountType: 'CASH', iban: null });
    expect(seen[0]).not.toHaveProperty('idempotencyKey');
  });

  it('a replay answers 201 like the original, marked Idempotent-Replayed', async () => {
    const base = await start({ create: async () => ({ account, replayed: true }) });
    const res = await post(base, { accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR' }, { 'idempotency-key': 'k-1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('idempotent-replayed')).toBe('true');
  });

  it('409 CONFLICT for a key reused with another payload', async () => {
    const base = await start({ create: () => Promise.reject(new IdempotencyKeyConflictError('x')) });
    const res = await post(base, { accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR' }, { 'idempotency-key': 'k-1' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it.each([
    ['missing accountType', { displayName: 'x', currency: 'EUR' }, [{ field: 'accountType', code: 'REQUIRED' }]],
    ['unknown accountType', { accountType: 'LOAN', displayName: 'x', currency: 'EUR' }, [{ field: 'accountType', code: 'INVALID_FORMAT' }]],
    ['missing displayName', { accountType: 'BANK', currency: 'EUR' }, [{ field: 'displayName', code: 'REQUIRED' }]],
    ['blank displayName', { accountType: 'BANK', displayName: '   ', currency: 'EUR' }, [{ field: 'displayName', code: 'INVALID_FORMAT' }]],
    ['unsupported currency', { accountType: 'BANK', displayName: 'x', currency: 'USD' }, [{ field: 'currency', code: 'INVALID_FORMAT' }]],
    ['missing currency', { accountType: 'BANK', displayName: 'x' }, [{ field: 'currency', code: 'REQUIRED' }]],
    ['invalid IBAN checksum', { accountType: 'BANK', displayName: 'x', currency: 'EUR', iban: 'DE88370400440532013000' }, [{ field: 'iban', code: 'INVALID_FORMAT' }]],
  ])('400 VALIDATION_ERROR: %s — the use case is not called', async (_label, body, fields) => {
    let called = false;
    const base = await start({ create: async () => ((called = true), { account, replayed: false }) });
    const res = await post(base, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed.', details: { fields } } });
    expect(called).toBe(false);
  });

  it.each([
    ['too long', 'k'.repeat(256)],
    ['with a space', 'my key'],
  ])('400 for an Idempotency-Key %s', async (_label, key) => {
    const base = await start({ create: async () => ({ account, replayed: false }) });
    const res = await post(base, { accountType: 'BANK', displayName: 'x', currency: 'EUR' }, { 'idempotency-key': key });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/financial-accounts/{id}/close', () => {
  const close = (base: string, id: string) =>
    fetch(`${base}/api/v1/financial-accounts/${id}/close`, { method: 'POST', headers });

  it('200 with the closed account', async () => {
    const closedAt = new Date('2026-12-31T12:00:00Z');
    const base = await start({ close: async () => ({ ...account, status: 'CLOSED', closedAt, version: 2 }) });
    const res = await close(base, ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'CLOSED', closedAt: '2026-12-31T12:00:00.000Z', version: 2 });
  });

  it('400 for an id that is not a UUID', async () => {
    const base = await start({ close: async () => account });
    expect((await close(base, 'nope')).status).toBe(400);
  });

  it('404 for an unknown or other-Realm account', async () => {
    const base = await start({ close: () => Promise.reject(new FinancialAccountNotFoundError(ID)) });
    const res = await close(base, ID);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND', details: { financialAccountId: ID } } });
  });
});
