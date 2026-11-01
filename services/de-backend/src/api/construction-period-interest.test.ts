import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConstructionPeriodInterestDeductibleError,
  ConstructionPeriodInterestMismatchError,
  ConstructionPeriodInterestNotAllowedError,
  ConstructionPeriodInterestNotFoundError,
  ConstructionPeriodInterestVoidError,
  TreatmentNotAllowedError,
  VersionConflictError,
  type ConstructionPeriodInterest,
  type PrincipalVerifier,
} from '../application/index.js';
import type { BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/**
 * VC-X-36 HTTP contract (api-design.md §59E "Routes", "Order of checks on create"): the record's six routes, their
 * bodies and field errors, `If-Match`, the DTO; the classification's `constructionPeriodInterestId` and the answers of
 * its refusals. Synthetic data.
 */
const REALM = '64b0c0ffee0000000000000a';
const R = '0c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
const L = '1c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
const [P1, P2] = ['2c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c', '3c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c'];
const PARTY = '4c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
const SPLIT = '5c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
const record: ConstructionPeriodInterest = {
  id: R,
  mreRealmId: REALM,
  loanId: L,
  propertyReferenceIds: [P1, P2],
  measure: 'Dachgeschossausbau (synthetisch)',
  herstellungFrom: '2028-01-15' as BusinessDate,
  herstellungUntil: '2028-10-31' as BusinessDate,
  useIntent: 'Vermietung',
  advanceExpenseDeductible: false,
  buildingFundsShare: { numerator: 4n, denominator: 5n },
  earlierYearsTreatment: 'keine Vorjahre',
  sourceReferences: ['Darlehensvertrag'],
  notes: null,
  reviewState: 'UNREVIEWED',
  advisorPartyId: null,
  status: 'VALID',
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2028-01-20T08:00:00Z'),
  createdBy: 'anna@example.com',
  updatedAt: new Date('2028-01-20T08:00:00Z'),
  version: 1,
};
const body = {
  loanId: L,
  propertyReferenceIds: [P1, P2],
  measure: ' Dachgeschossausbau (synthetisch) ',
  herstellungFrom: '2028-01-15',
  herstellungUntil: '2028-10-31',
  useIntent: 'Vermietung',
  advanceExpenseDeductible: false,
  buildingFundsShare: '8/10',
  earlierYearsTreatment: 'keine Vorjahre',
  sourceReferences: ['Darlehensvertrag'],
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
const call = (base: string, method: string, path: string, b?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/v1${path}`, { method, headers: { ...headers, ...extra }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; details?: Record<string, unknown> } }).error;
const fieldsOf = async (res: Response) => ((await errorOf(res)).details as { fields: unknown[] }).fields;

describe('the construction-period record’s routes (§59E)', () => {
  it('POST 201 with the DTO, ETag and Location; the share kept reduced; the key passed; GET one with the classifications naming it', async () => {
    const seen: unknown[] = [];
    const base = await start({
      constructionPeriodInterest: {
        create: async (input) => {
          seen.push(input);
          return { record, replayed: false };
        },
        get: async () => ({
          record,
          classifications: [{ classificationId: PARTY, splitId: SPLIT, treatment: 'CAPITALIZED', reviewState: 'USER_CONFIRMED', current: true }],
        }),
      },
    });
    const res = await call(base, 'POST', '/construction-period-interest', body, { 'idempotency-key': 'k1' });
    expect([res.status, res.headers.get('etag'), res.headers.get('location')]).toEqual([201, '"1"', `/api/v1/construction-period-interest/${R}`]);
    expect(await res.json()).toMatchObject({
      constructionPeriodInterestId: R,
      buildingFundsShare: '4/5',
      status: 'VALID',
      reviewState: 'UNREVIEWED',
      version: 1,
    });
    expect(seen[0]).toMatchObject({
      loanId: L,
      measure: 'Dachgeschossausbau (synthetisch)',
      buildingFundsShare: { numerator: 4n, denominator: 5n },
      notes: null,
      idempotencyKey: 'k1',
    });
    const one = await call(base, 'GET', `/construction-period-interest/${R}`);
    expect(one.headers.get('etag')).toBe('"1"');
    expect(((await one.json()) as { classifications: unknown }).classifications).toEqual([
      { classificationId: PARTY, sourceType: 'TRANSACTION_SPLIT', sourceId: SPLIT, treatment: 'CAPITALIZED', reviewState: 'USER_CONFIRMED', current: true },
    ]);
  });

  it('400, field errors: the share, duplicates, the period, the counts, unknown fields; the Loan never in an amend; the advisor only with ADVISOR_CONFIRMED', async () => {
    const base = await start({});
    expect(
      await fieldsOf(
        await call(base, 'POST', '/construction-period-interest', {
          ...body,
          buildingFundsShare: '6/5',
          propertyReferenceIds: [P1, P1],
          herstellungUntil: '2028-01-14',
          sourceReferences: [],
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        { field: 'buildingFundsShare', code: 'OUT_OF_RANGE' },
        { field: 'propertyReferenceIds.1', code: 'DUPLICATE' },
        { field: 'herstellungUntil', code: 'OUT_OF_RANGE' },
      ]),
    );
    expect((await call(base, 'POST', '/construction-period-interest', { ...body, buildingFundsShare: '0/5' })).status).toBe(400);
    expect((await call(base, 'POST', '/construction-period-interest', { ...body, propertyReferenceIds: [] })).status).toBe(400);
    expect((await call(base, 'POST', `/construction-period-interest/${R}/amend`, { loanId: L })).status).toBe(400);
    expect(await fieldsOf(await call(base, 'POST', `/construction-period-interest/${R}/confirm`, { reviewState: 'ADVISOR_CONFIRMED' }))).toEqual([
      { field: 'advisorPartyId', code: 'REQUIRED' },
    ]);
    expect(await fieldsOf(await call(base, 'POST', `/construction-period-interest/${R}/confirm`, { reviewState: 'CONFIRMED', advisorPartyId: PARTY }))).toEqual(
      [{ field: 'advisorPartyId', code: 'NOT_ALLOWED' }],
    );
    expect((await call(base, 'POST', `/construction-period-interest/${R}/confirm`, { reviewState: 'UNREVIEWED' })).status).toBe(400);
    expect((await call(base, 'POST', `/construction-period-interest/${R}/void`, {})).status).toBe(400);
    expect((await call(base, 'GET', '/construction-period-interest?year=2028')).status).toBe(400);
  });

  it('amend, confirm, void with If-Match; the list by Loan and PropertyReference; 404, 412 on a version conflict, 409 CONSTRUCTION_PERIOD_INTEREST_VOID', async () => {
    const seen: unknown[] = [];
    const base = await start({
      constructionPeriodInterest: {
        amend: async (input) => {
          seen.push(input);
          return { record: { ...record, version: 2 }, changed: true };
        },
        confirm: async (input) => {
          seen.push(input);
          throw new VersionConflictError([1], 2);
        },
        void: async () => {
          throw new ConstructionPeriodInterestVoidError(R);
        },
        list: async (input) => {
          seen.push(input);
          return [record];
        },
        get: async () => {
          throw new ConstructionPeriodInterestNotFoundError(R);
        },
      },
    });
    const amended = await call(base, 'POST', `/construction-period-interest/${R}/amend`, { buildingFundsShare: '1/1', notes: 'x' }, { 'if-match': '"1"' });
    expect([amended.status, amended.headers.get('etag')]).toEqual([200, '"2"']);
    expect(seen[0]).toMatchObject({ id: R, expectedVersions: [1], changes: { buildingFundsShare: { numerator: 1n, denominator: 1n }, notes: 'x' } });
    const confirmed = await call(base, 'POST', `/construction-period-interest/${R}/confirm`, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: PARTY });
    expect(confirmed.status).toBe(412);
    expect(seen[1]).toMatchObject({ step: { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: PARTY } });
    const voided = await call(base, 'POST', `/construction-period-interest/${R}/void`, { reason: 'doppelt' });
    expect([voided.status, (await errorOf(voided)).details?.['reason']]).toEqual([409, 'CONSTRUCTION_PERIOD_INTEREST_VOID']);
    expect((await call(base, 'GET', `/construction-period-interest/${R}`)).status).toBe(404);
    const listed = await call(base, 'GET', `/construction-period-interest?loanId=${L}&propertyReferenceId=${P1}`);
    expect([listed.status, ((await listed.json()) as { items: unknown[] }).items.length]).toEqual([200, 1]);
    expect(seen[2]).toMatchObject({ loanId: L, propertyReferenceId: P1 });
  });
});

describe('a classification naming a record (§59E "Order of checks on create")', () => {
  const classify = {
    sourceType: 'TRANSACTION_SPLIT',
    sourceId: SPLIT,
    taxCategory: 'LOAN_INTEREST',
    treatment: 'CAPITALIZED',
    supersedes: null,
    constructionPeriodInterestId: R,
  };

  it('400 NOT_ALLOWED at once: another treatment, a WEG source, with an anschaffungsnahe link; the id passed through otherwise', async () => {
    const seen: unknown[] = [];
    const base = await start({ taxation: { create: async (input) => (seen.push(input), Promise.reject(new ConstructionPeriodInterestNotFoundError(R))) } });
    for (const b of [
      { ...classify, taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' },
      { ...classify, sourceType: 'WEG_RESERVE_WITHDRAWAL', sourcePosition: 1, taxCategory: 'WEG_SPENDING' },
      { ...classify, taxCategory: 'MAINTENANCE', anschaffungsnaheAcquisitionId: PARTY },
    ]) {
      expect(await fieldsOf(await call(base, 'POST', '/tax-classifications', b)), JSON.stringify(b)).toContainEqual({
        field: 'constructionPeriodInterestId',
        code: 'NOT_ALLOWED',
      });
    }
    expect(seen).toEqual([]);
    const passed = await call(base, 'POST', '/tax-classifications', classify);
    expect([passed.status, (await errorOf(passed)).details]).toEqual([404, { constructionPeriodInterestId: R }]);
    expect(seen[0]).toMatchObject({ constructionPeriodInterestId: R });
  });

  it.each([
    [
      new TreatmentNotAllowedError('FINANCING', ['DEDUCTIBLE', 'NOT_RELEVANT'], undefined, undefined, 'CONSTRUCTION_PERIOD_INTEREST_REQUIRED'),
      422,
      'TREATMENT_NOT_ALLOWED',
      'CONSTRUCTION_PERIOD_INTEREST_REQUIRED',
    ],
    [new ConstructionPeriodInterestVoidError(R), 409, 'CONFLICT', 'CONSTRUCTION_PERIOD_INTEREST_VOID'],
    [
      new ConstructionPeriodInterestMismatchError({ loanId: L, propertyReferenceId: null, recordLoanId: null, recordPropertyReferenceIds: [P1] }),
      409,
      'CONFLICT',
      'CONSTRUCTION_PERIOD_INTEREST_MISMATCH',
    ],
    [new ConstructionPeriodInterestDeductibleError(R), 409, 'CONFLICT', 'CONSTRUCTION_PERIOD_INTEREST_DEDUCTIBLE'],
  ] as const)('%s answers %i %s', async (error, status, code, reason) => {
    const base = await start({ taxation: { create: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', '/tax-classifications', classify);
    const answered = await errorOf(res);
    expect([res.status, answered.code, answered.details?.['reason']]).toEqual([status, code, reason]);
  });

  it('NOT_INTEREST from the checks answers 400 NOT_ALLOWED at the field', async () => {
    const base = await start({ taxation: { create: async () => Promise.reject(new ConstructionPeriodInterestNotAllowedError('NOT_INTEREST')) } });
    expect(await fieldsOf(await call(base, 'POST', '/tax-classifications', classify))).toEqual([
      { field: 'constructionPeriodInterestId', code: 'NOT_ALLOWED' },
    ]);
  });
});
