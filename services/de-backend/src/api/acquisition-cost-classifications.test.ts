import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcquisitionCancelledError,
  AcquisitionCostNotFoundError,
  AcquisitionCostVoidError,
  AcquisitionNotFoundError,
  ClassificationPartsSumMismatchError,
  ClassificationPurposeNotAllowedError,
  CurrentClassificationChangedError,
  IdempotencyKeyConflictError,
  PartyNotFoundError,
  type AcquisitionCostClassification,
  type PrincipalVerifier,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-X-42 HTTP contract (api-design.md §59D "API"): the body, the field errors, the answers, the list. Synthetic data. */
const REALM = '64b0c0ffee0000000000000a';
const ACQ = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
const COST = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
const CLS = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
const PARTY = '3b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
const eur = (amount: string) => Money.of(amount, 'EUR');
const classification: AcquisitionCostClassification = {
  id: CLS,
  mreRealmId: REALM,
  acquisitionId: ACQ,
  costId: COST,
  parts: [
    { purpose: 'OWNERSHIP_TRANSFER', amount: eur('1800.00') },
    { purpose: 'FINANCING', amount: eur('700.00') },
  ],
  description: 'Notar: Kaufvertrag und Grundschuld',
  sourceReferences: ['Rechnung 0000-SYN'],
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  notes: null,
  supersedesId: null,
  supersededAt: null,
  supersededById: null,
  current: true,
  createdAt: new Date('2026-11-01T08:00:00Z'),
};
const dto = {
  classificationId: CLS,
  acquisitionId: ACQ,
  costId: COST,
  parts: [
    { purpose: 'OWNERSHIP_TRANSFER', amount: { amount: '1800.00', currency: 'EUR' } },
    { purpose: 'FINANCING', amount: { amount: '700.00', currency: 'EUR' } },
  ],
  description: 'Notar: Kaufvertrag und Grundschuld',
  sourceReferences: ['Rechnung 0000-SYN'],
  reviewState: 'CONFIRMED',
  advisorPartyId: null,
  notes: null,
  supersedesId: null,
  supersededAt: null,
  supersededById: null,
  current: true,
  createdAt: '2026-11-01T08:00:00.000Z',
};

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
const path = `/acquisitions/${ACQ}/costs/${COST}/classifications`;
const body = {
  parts: [
    { purpose: 'OWNERSHIP_TRANSFER', amount: { amount: '1800.00', currency: 'EUR' } },
    { purpose: 'FINANCING', amount: { amount: '700.00', currency: 'EUR' } },
  ],
  description: ' Notar: Kaufvertrag und Grundschuld ',
  sourceReferences: [' Rechnung 0000-SYN ', ''],
  supersedes: null,
};

describe('POST /api/v1/acquisitions/{id}/costs/{costId}/classifications (§59D)', () => {
  it('201 with the classification, ETag and Location; the input normalized (UNREVIEWED by default); a replay is marked', async () => {
    const seen: unknown[] = [];
    const base = await start({
      costClassifications: {
        create: async (input) => {
          seen.push(input);
          return { classification, replayed: seen.length > 1 };
        },
      },
    });
    const res = await call(base, 'POST', path.replace(ACQ, ACQ.toUpperCase()), body, { 'idempotency-key': 'k1' });
    expect([res.status, res.headers.get('etag'), res.headers.get('location')]).toEqual([201, '"1"', `/api/v1${path}`]);
    expect(await res.json()).toEqual(dto);
    expect(seen[0]).toMatchObject({
      acquisitionId: ACQ,
      costId: COST,
      description: 'Notar: Kaufvertrag und Grundschuld',
      sourceReferences: ['Rechnung 0000-SYN'],
      reviewState: 'UNREVIEWED',
      advisorPartyId: null,
      notes: null,
      supersedes: null,
      idempotencyKey: 'k1',
    });
    const again = await call(base, 'POST', path, body, { 'idempotency-key': 'k1' });
    expect(again.headers.get('idempotent-replayed')).toBe('true');
  });

  it('400, all field errors at once: NOT_POSITIVE, an unknown purpose, more than 5 parts or none, SUGGESTED and an advisor without ADVISOR_CONFIRMED', async () => {
    const base = await start({});
    const fields = async (b: unknown) => ((await errorOf(await call(base, 'POST', path, b))).details as { fields: unknown[] }).fields;
    const part = (amount: string, purpose = 'OWNERSHIP_TRANSFER') => ({ purpose, amount: { amount, currency: 'EUR' } });
    expect(await fields({ ...body, parts: [part('0.00'), part('1.00', 'PURCHASE_PRICE')], reviewState: 'SUGGESTED', advisorPartyId: PARTY })).toEqual([
      { field: 'parts.0.amount.amount', code: 'NOT_POSITIVE' },
      { field: 'parts.1.purpose', code: 'INVALID_FORMAT' },
      { field: 'reviewState', code: 'NOT_ALLOWED' },
      { field: 'advisorPartyId', code: 'NOT_ALLOWED' },
    ]);
    expect(await fields({ ...body, parts: Array.from({ length: 6 }, () => part('1.00')) })).toEqual([{ field: 'parts', code: 'OUT_OF_RANGE' }]);
    expect(await fields({ ...body, parts: [] })).toEqual([{ field: 'parts', code: 'OUT_OF_RANGE' }]);
    expect(await fields({ ...body, reviewState: 'MAYBE' })).toEqual([{ field: 'reviewState', code: 'INVALID_FORMAT' }]);
    expect(await fields({ ...body, description: ' ' })).toEqual([{ field: 'description', code: 'INVALID_FORMAT' }]);
    const { supersedes: _s, ...withoutSupersedes } = body;
    expect(await fields(withoutSupersedes)).toEqual([{ field: 'supersedes', code: 'REQUIRED' }]);
    expect(await fields({ ...body, inputVat: 'DEDUCTIBLE' })).toEqual([{ field: '(body)', code: 'INVALID_FORMAT' }]);
    // Counter-check: an advisor with ADVISOR_CONFIRMED and five parts pass validation (the command is not wired: 500 is not a 400).
    expect(
      (
        await call(base, 'POST', path, {
          ...body,
          parts: Array.from({ length: 5 }, () => part('1.00')),
          reviewState: 'ADVISOR_CONFIRMED',
          advisorPartyId: PARTY,
        })
      ).status,
    ).not.toBe(400);
    expect((await call(base, 'POST', `/acquisitions/${ACQ}/costs/x/classifications`, body)).status).toBe(400);
  });

  it('the answers: 404 Acquisition, cost, advisor; 409 ACQUISITION_CANCELLED, COST_VOID, CURRENT_CLASSIFICATION_CHANGED, idempotency; 422 PARTS_SUM_MISMATCH, PURPOSE_NOT_ALLOWED', async () => {
    const errors: Error[] = [
      new AcquisitionNotFoundError(ACQ),
      new AcquisitionCostNotFoundError(COST),
      new PartyNotFoundError(PARTY),
      new AcquisitionCancelledError(ACQ),
      new AcquisitionCostVoidError(COST),
      new CurrentClassificationChangedError(CLS),
      new IdempotencyKeyConflictError('x'),
      new ClassificationPartsSumMismatchError(eur('2500.00'), eur('2499.99')),
      new ClassificationPurposeNotAllowedError('FINANCING_RELATED', 'OWNERSHIP_TRANSFER'),
    ];
    const base = await start({
      costClassifications: {
        create: async () => {
          throw errors.shift();
        },
      },
    });
    const answers = [];
    for (let i = 0; i < 9; i++) {
      const res = await call(base, 'POST', path, body);
      const e = await errorOf(res);
      answers.push([res.status, e.code, e.details]);
    }
    expect(answers).toEqual([
      [404, 'NOT_FOUND', { acquisitionId: ACQ }],
      [404, 'NOT_FOUND', { acquisitionCostId: COST }],
      [404, 'NOT_FOUND', { partyId: PARTY }],
      [409, 'CONFLICT', { reason: 'ACQUISITION_CANCELLED', acquisitionId: ACQ }],
      [409, 'CONFLICT', { reason: 'COST_VOID' }],
      [409, 'CONFLICT', { reason: 'CURRENT_CLASSIFICATION_CHANGED', currentClassificationId: CLS }],
      [409, expect.any(String), undefined],
      [422, 'PARTS_SUM_MISMATCH', { costAmount: { amount: '2500.00', currency: 'EUR' }, partsSum: { amount: '2499.99', currency: 'EUR' } }],
      [422, 'PURPOSE_NOT_ALLOWED', { category: 'FINANCING_RELATED', purpose: 'OWNERSHIP_TRANSFER' }],
    ]);
  });
});

describe('GET /api/v1/acquisitions/{id}/costs/{costId}/classifications (§59D)', () => {
  it('{ current, items }; 404s passed on; 400 for any query parameter', async () => {
    const errors = [new AcquisitionCostNotFoundError(COST)];
    let calls = 0;
    const base = await start({
      costClassifications: {
        list: async (input) => {
          calls += 1;
          expect(input).toMatchObject({ acquisitionId: ACQ, costId: COST });
          if (calls === 2) throw errors.shift();
          return { current: classification, items: [classification] };
        },
      },
    });
    const res = await call(base, 'GET', path);
    expect([res.status, await res.json()]).toEqual([200, { current: dto, items: [dto] }]);
    expect((await call(base, 'GET', path)).status).toBe(404);
    expect((await call(base, 'GET', `${path}?limit=1`)).status).toBe(400);
  });
});
