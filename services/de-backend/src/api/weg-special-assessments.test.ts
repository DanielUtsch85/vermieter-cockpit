import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AssessmentHasSplitsError,
  AssessmentNotActiveError,
  AssessmentOutsideMembershipError,
  InvalidWegAssessmentSplitError,
  MembershipHasAssessmentsError,
  SpecialAssessmentNotFoundError,
  WegAssessmentNotFoundError,
  type AssessmentView,
  type CreateSpecialAssessmentInput,
  type PrincipalVerifier,
} from '../application/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-6-05 HTTP contract (api-design.md §51A). Figures are invented. */
const REALM = '64b0c0ffee0000000000000c';
const MEMBERSHIP = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const ASSESSMENT = '6b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const TX = '8b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const UNIT = '9b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const eur = (amount: string) => Money.of(amount, 'EUR');
const money = (amount: string) => ({ amount, currency: 'EUR' });

const assessment = {
  id: ASSESSMENT,
  mreRealmId: REALM,
  membershipId: MEMBERSHIP,
  description: 'Dachsanierung',
  resolutionDate: '2026-02-10',
  purpose: 'MAINTENANCE',
  totalAmount: null,
  unitShare: eur('900.00'),
  instalments: [],
  instalmentsCovered: [{ position: 1, dueDate: '2026-03-01', amount: eur('900.00'), covered: eur('300.00'), overdue: true }],
  uses: [{ position: 1, date: '2026-08-01', description: 'Dachdecker', unitShare: eur('400.00') }],
  storedStatus: 'ACTIVE',
  status: 'ACTIVE',
  paid: eur('300.00'),
  outstanding: eur('600.00'),
  payments: [{ transactionId: TX, bookingDate: '2026-03-02', amount: eur('300.00') }],
  flags: [{ code: 'USES_EXCEED_PAID', details: { uses: eur('400.00'), paid: eur('300.00') } }],
  voidedAt: null,
  voidReason: null,
  sourceReferences: [],
  notes: null,
  createdAt: new Date('2026-10-30T10:00:00Z'),
  version: 2,
} as unknown as AssessmentView;

const body = {
  description: 'Dachsanierung',
  resolutionDate: '2026-02-10',
  purpose: 'MAINTENANCE',
  unitShare: money('900.00'),
  instalments: [
    { position: 1, dueDate: '2026-03-01', amount: money('300.00') },
    { position: 2, dueDate: '2026-06-01', amount: money('600.00') },
  ],
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
const call = (base: string, method: string, path: string, payload?: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/v1${path}`, { method, headers: { ...headers, ...extra }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; details?: unknown } }).error;
const listPath = `/weg-memberships/${MEMBERSHIP}/special-assessments`;

describe('§51A: the Sonderumlage', () => {
  it('POST 201 with the derived figures as JSON; defaults passed; a replay is marked', async () => {
    const seen: CreateSpecialAssessmentInput[] = [];
    let replayed = false;
    const base = await start({
      wegSpecialAssessments: {
        create: async (input) => {
          seen.push(input);
          const answer = { assessment, replayed };
          replayed = true;
          return answer;
        },
      },
    });
    const res = await call(base, 'POST', listPath, body, { 'idempotency-key': 'k' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"2"');
    expect(await res.json()).toMatchObject({
      assessmentId: ASSESSMENT,
      status: 'ACTIVE',
      paid: money('300.00'),
      outstanding: money('600.00'),
      instalments: [{ position: 1, amount: money('900.00'), covered: money('300.00'), overdue: true }],
      payments: [{ transactionId: TX, amount: money('300.00') }],
      flags: [{ code: 'USES_EXCEED_PAID', details: { uses: money('400.00'), paid: money('300.00') } }],
    });
    expect(seen[0]).toMatchObject({ membershipId: MEMBERSHIP, totalAmount: null, notes: null, sourceReferences: [], idempotencyKey: 'k' });
    expect((await call(base, 'POST', listPath, body, { 'idempotency-key': 'k' })).headers.get('idempotent-replayed')).toBe('true');
  });

  it('400: instalments not summing or out of order, duplicate positions, a share of 0, a document, unknown keys', async () => {
    const base = await start({});
    const fieldsOf = async (payload: unknown, path = listPath, method = 'POST') => {
      const res = await call(base, method, path, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    expect(await fieldsOf({ ...body, unitShare: money('900.01') })).toEqual([{ field: 'instalments', code: 'INSTALMENTS_DO_NOT_SUM' }]);
    const late = { position: 2, dueDate: '2026-02-01', amount: money('600.00') };
    expect(await fieldsOf({ ...body, instalments: [body.instalments[0], late] })).toEqual([{ field: 'instalments', code: 'DUE_DATES_NOT_INCREASING' }]);
    expect(await fieldsOf({ ...body, instalments: [body.instalments[0], { ...body.instalments[1], position: 1 }] })).toEqual([
      { field: 'instalments.1.position', code: 'DUPLICATE' },
    ]);
    expect(await fieldsOf({ ...body, unitShare: money('0.00'), instalments: [{ position: 1, dueDate: '2026-03-01', amount: money('0.00') }] })).toEqual(
      expect.arrayContaining([{ field: 'unitShare', code: 'NOT_POSITIVE' }]),
    );
    expect(await fieldsOf({ ...body, documentId: TX })).toEqual([{ field: 'documentId', code: 'NOT_SUPPORTED' }]);
    await fieldsOf({ ...body, purpose: 'TAX' });
    await fieldsOf({ ...body, instalments: [] });
    await fieldsOf({ ...body, status: 'VOID' });
    const use = { position: 1, date: '2026-08-01', description: 'x', unitShare: money('1.00') };
    expect(await fieldsOf({ uses: [use, use] }, `/weg-special-assessments/${ASSESSMENT}/uses`, 'PUT')).toEqual([
      { field: 'uses.1.position', code: 'DUPLICATE' },
    ]);
    const { resolutionDate: _r, ...amend } = body;
    await fieldsOf({ ...amend, resolutionDate: '2026-02-11' }, `/weg-special-assessments/${ASSESSMENT}/amend`);
  });

  it('GET one with asOf, list with filters and without uses and payments, amend, uses, void with If-Match', async () => {
    const seen: unknown[] = [];
    const base = await start({
      wegSpecialAssessments: {
        get: async (input) => (seen.push(input), assessment),
        list: async (input) => (seen.push(input), { items: [assessment], page: 1, pageSize: 50, total: 1 }),
        amend: async (input) => (seen.push(input), { assessment, changed: true }),
        replaceUses: async (input) => (seen.push(input), { assessment, changed: true }),
        void: async (input) => (seen.push(input), { assessment, changed: true }),
      },
    });
    expect((await call(base, 'GET', `/weg-special-assessments/${ASSESSMENT}?asOf=2026-07-01`)).status).toBe(200);
    expect(seen[0]).toMatchObject({ assessmentId: ASSESSMENT, asOf: '2026-07-01' });
    const list = (await (await call(base, 'GET', `${listPath}?status=ACTIVE,SETTLED&purpose=MAINTENANCE`)).json()) as { items: Record<string, unknown>[] };
    expect(list.items[0]).not.toHaveProperty('uses');
    expect(list.items[0]).not.toHaveProperty('payments');
    expect(seen[1]).toMatchObject({ membershipId: MEMBERSHIP, filter: { statuses: ['ACTIVE', 'SETTLED'], purposes: ['MAINTENANCE'] } });
    const { resolutionDate: _r, ...amend } = body;
    expect((await call(base, 'POST', `/weg-special-assessments/${ASSESSMENT}/amend`, amend, { 'if-match': '"2"' })).status).toBe(200);
    expect(seen[2]).toMatchObject({ assessmentId: ASSESSMENT, expectedVersions: [2], value: { purpose: 'MAINTENANCE', totalAmount: null } });
    const uses = { uses: [{ position: 1, date: '2026-08-01', description: 'Dachdecker', unitShare: money('400.00') }] };
    expect((await call(base, 'PUT', `/weg-special-assessments/${ASSESSMENT}/uses`, uses)).status).toBe(200);
    expect((await call(base, 'POST', `/weg-special-assessments/${ASSESSMENT}/void`, { reason: 'Doppelt' })).status).toBe(200);
    expect(seen[4]).toMatchObject({ value: 'Doppelt' });
  });

  it.each([
    ['get', new SpecialAssessmentNotFoundError(ASSESSMENT), 404, 'NOT_FOUND', { assessmentId: ASSESSMENT }],
    [
      'create',
      new AssessmentOutsideMembershipError('2026-01-01' as BusinessDate, null),
      422,
      'ASSESSMENT_OUTSIDE_MEMBERSHIP',
      { validFrom: '2026-01-01', validUntil: null },
    ],
    ['void', new AssessmentHasSplitsError(ASSESSMENT, [TX]), 409, 'CONFLICT', { reason: 'ASSESSMENT_HAS_SPLITS', transactionIds: [TX] }],
    ['amend', new AssessmentNotActiveError(ASSESSMENT, 'VOID'), 409, 'CONFLICT', { reason: 'ASSESSMENT_NOT_ACTIVE', status: 'VOID' }],
  ])('%s: %s → %i %s', async (route, error, status, code, details) => {
    const reject = async () => Promise.reject(error);
    const base = await start({ wegSpecialAssessments: { get: reject, create: reject, void: reject, amend: reject } });
    const { resolutionDate: _r, ...amend } = body;
    const res =
      route === 'get'
        ? await call(base, 'GET', `/weg-special-assessments/${ASSESSMENT}`)
        : route === 'create'
          ? await call(base, 'POST', listPath, body)
          : route === 'void'
            ? await call(base, 'POST', `/weg-special-assessments/${ASSESSMENT}/void`, { reason: 'x' })
            : await call(base, 'POST', `/weg-special-assessments/${ASSESSMENT}/amend`, amend);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });

  it.each([
    [new WegAssessmentNotFoundError(ASSESSMENT), 404, 'NOT_FOUND', { wegSpecialAssessmentId: ASSESSMENT }],
    [new InvalidWegAssessmentSplitError(1, 'CATEGORY'), 422, 'INVALID_WEG_ASSESSMENT_SPLIT', { position: 1, reason: 'CATEGORY' }],
    [new AssessmentNotActiveError(ASSESSMENT, 'VOID'), 409, 'CONFLICT', { reason: 'ASSESSMENT_NOT_ACTIVE', wegSpecialAssessmentId: ASSESSMENT }],
  ])('splits: %s → %i %s', async (error, status, code, details) => {
    const base = await start({ transactions: { setSplits: async () => Promise.reject(error) } });
    const res = await call(base, 'PUT', `/transactions/${TX}/splits`, {
      splits: [{ amount: money('300.00'), financialCategoryCode: 'WEG_SPECIAL_ASSESSMENT', propertyReferenceId: UNIT, wegSpecialAssessmentId: ASSESSMENT }],
    });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });

  it('end: MEMBERSHIP_HAS_ASSESSMENTS → 409 with the assessment ids', async () => {
    const base = await start({ wegs: { endMembership: async () => Promise.reject(new MembershipHasAssessmentsError(MEMBERSHIP, [ASSESSMENT])) } });
    const res = await call(base, 'POST', `/weg-memberships/${MEMBERSHIP}/end`, { validUntil: '2026-01-31' });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ details: { reason: 'MEMBERSHIP_HAS_ASSESSMENTS', assessmentIds: [ASSESSMENT] } });
  });
});
