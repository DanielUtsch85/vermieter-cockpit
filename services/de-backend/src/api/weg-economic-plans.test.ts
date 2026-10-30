import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EconomicPlanNotFoundError,
  EffectiveFromOutsideYearError,
  HausgeldNotProposableError,
  MembershipHasPlansError,
  MembershipHasSplitsError,
  NoEconomicPlanError,
  NoWegMembershipError,
  PlanExistsError,
  PlanOutsideMembershipError,
  WegHasYearsError,
  type CreateEconomicPlanInput,
  type HausgeldProposal,
  type PlanView,
  type PrincipalVerifier,
} from '../application/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-6-02 HTTP contract (api-design.md §49.3–§49.6). Figures are invented. */
const REALM = '64b0c0ffee0000000000000a';
const MEMBERSHIP = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const PLAN = '4b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const UNIT = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const TX = '5b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const WEG = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const eur = (amount: string) => Money.of(amount, 'EUR');
const money = (amount: string) => ({ amount, currency: 'EUR' });

const plan = {
  id: PLAN,
  mreRealmId: REALM,
  membershipId: MEMBERSHIP,
  financialYear: 2026,
  effectiveFrom: '2026-03-01',
  resolutionDate: null,
  monthlyHausgeld: eur('300.00'),
  monthlyReserveContribution: eur('60.00'),
  recoverableCosts: eur('2400.00'),
  nonRecoverableCosts: eur('1200.00'),
  income: null,
  annualReserveContribution: eur('720.00'),
  costLines: [],
  components: { recoverable: eur('200.00'), nonRecoverable: eur('100.00'), reserve: eur('60.00') },
  flags: [{ code: 'HAUSGELD_DIFFERS_FROM_PLAN', details: { annual: eur('3600.00'), planned: eur('3480.00') } }],
  status: 'ACTIVE',
  voidedAt: null,
  voidReason: null,
  sourceReferences: [],
  notes: null,
  createdAt: new Date('2026-10-29T10:00:00Z'),
  version: 1,
} as unknown as PlanView;

const body = {
  financialYear: 2026,
  effectiveFrom: '2026-03-01',
  monthlyHausgeld: money('300.00'),
  monthlyReserveContribution: money('60.00'),
  recoverableCosts: money('2400.00'),
  nonRecoverableCosts: money('1200.00'),
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
const plansPath = `/weg-memberships/${MEMBERSHIP}/economic-plans`;

describe('POST /weg-memberships/{id}/economic-plans', () => {
  it('201 with the plan, its components and flags (Money as JSON); defaults passed; a replay is marked', async () => {
    const seen: CreateEconomicPlanInput[] = [];
    let replayed = false;
    const base = await start({
      wegEconomicPlans: {
        create: async (input) => {
          seen.push(input);
          const answer = { plan, replayed };
          replayed = true;
          return answer;
        },
      },
    });
    const res = await call(base, 'POST', plansPath, body, { 'idempotency-key': 'k' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(await res.json()).toMatchObject({
      economicPlanId: PLAN,
      monthlyHausgeld: money('300.00'),
      income: null,
      annualReserveContribution: money('720.00'),
      components: { recoverable: money('200.00'), nonRecoverable: money('100.00'), reserve: money('60.00') },
      flags: [{ code: 'HAUSGELD_DIFFERS_FROM_PLAN', details: { annual: money('3600.00'), planned: money('3480.00') } }],
    });
    expect(seen[0]).toMatchObject({ membershipId: MEMBERSHIP, resolutionDate: null, income: null, costLines: [], sourceReferences: [], idempotencyKey: 'k' });
    expect((await call(base, 'POST', plansPath, body, { 'idempotency-key': 'k' })).headers.get('idempotent-replayed')).toBe('true');
  });

  it('400: both monthly amounts 0, a duplicate position, a document NOT_SUPPORTED, a negative amount, unknown keys', async () => {
    const base = await start({});
    const fieldsOf = async (payload: unknown) => {
      const res = await call(base, 'POST', plansPath, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    expect(await fieldsOf({ ...body, monthlyHausgeld: money('0.00'), monthlyReserveContribution: money('0.00') })).toEqual([
      { field: 'monthlyHausgeld.amount', code: 'NOT_POSITIVE' },
    ]);
    const line = {
      position: 1,
      description: 'Hausmeister',
      allocationKey: 'Miteigentumsanteile',
      totalAmount: money('100.00'),
      unitShare: money('1.00'),
      group: 'RECOVERABLE',
    };
    expect(await fieldsOf({ ...body, costLines: [line, line] })).toEqual([{ field: 'costLines.1.position', code: 'DUPLICATE' }]);
    expect(await fieldsOf({ ...body, documentId: PLAN })).toEqual([{ field: 'documentId', code: 'NOT_SUPPORTED' }]);
    expect(await fieldsOf({ ...body, recoverableCosts: money('-1.00') })).toEqual([{ field: 'recoverableCosts.amount', code: 'NEGATIVE_AMOUNT' }]);
    await fieldsOf({ ...body, totalPlannedAmount: money('1.00') });
    await fieldsOf({ ...body, costLines: [{ ...line, group: 'RESERVE' }] });
  });

  it.each([
    [
      new EffectiveFromOutsideYearError('2026-01-01' as BusinessDate, '2026-12-31' as BusinessDate),
      400,
      'VALIDATION_ERROR',
      { fields: [{ field: 'effectiveFrom', code: 'OUT_OF_RANGE' }] },
    ],
    [new PlanOutsideMembershipError('2026-04-01' as BusinessDate, null), 422, 'PLAN_OUTSIDE_MEMBERSHIP', { validFrom: '2026-04-01', validUntil: null }],
    [new PlanExistsError(PLAN), 409, 'CONFLICT', { reason: 'PLAN_EXISTS', economicPlanId: PLAN }],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ wegEconomicPlans: { create: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', plansPath, body);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});

describe('plan reads and void', () => {
  it('GET list with filters, GET one, 404, void with If-Match', async () => {
    const seen: unknown[] = [];
    const base = await start({
      wegEconomicPlans: {
        list: async (input) => (seen.push(input), { items: [plan], page: 1, pageSize: 50, total: 1 }),
        get: async ({ economicPlanId }) => (economicPlanId === PLAN ? plan : Promise.reject(new EconomicPlanNotFoundError(economicPlanId))),
        void: async (input) => (seen.push(input), { plan, changed: true }),
      },
    });
    expect(((await (await call(base, 'GET', `${plansPath}?status=ACTIVE&financialYear=2026`)).json()) as { total: number }).total).toBe(1);
    expect(seen[0]).toMatchObject({ membershipId: MEMBERSHIP, filter: { statuses: ['ACTIVE'], financialYear: 2026 } });
    expect((await call(base, 'GET', `/weg-economic-plans/${PLAN}`)).headers.get('etag')).toBe('"1"');
    expect(await errorOf(await call(base, 'GET', `/weg-economic-plans/${TX}`))).toMatchObject({ code: 'NOT_FOUND', details: { economicPlanId: TX } });
    await call(base, 'POST', `/weg-economic-plans/${PLAN}/void`, { reason: 'Tippfehler' }, { 'if-match': '"1"' });
    expect(seen[1]).toMatchObject({ economicPlanId: PLAN, reason: 'Tippfehler', expectedVersions: [1] });
  });
});

describe('GET /transactions/{id}/hausgeld-proposal', () => {
  const proposal: HausgeldProposal = {
    transactionId: TX,
    bookingDate: '2026-03-02' as BusinessDate,
    amount: eur('60.00'),
    propertyReferenceId: UNIT,
    membershipId: MEMBERSHIP,
    economicPlanId: PLAN,
    case: 'RESERVE_ONLY',
    splits: [{ financialCategoryCode: 'WEG_RESERVE_CONTRIBUTION', propertyReferenceId: UNIT, amount: eur('60.00') }],
    flags: [{ code: 'PLAN_OF_EARLIER_YEAR', details: { financialYear: 2025 } }],
  };

  it('200 with the case, the splits and the flags; the unit passed from the query', async () => {
    const seen: unknown[] = [];
    const base = await start({ wegEconomicPlans: { hausgeldProposal: async (input) => (seen.push(input), proposal) } });
    const res = await call(base, 'GET', `/transactions/${TX}/hausgeld-proposal?propertyReferenceId=${UNIT}`);
    expect(await res.json()).toEqual({
      transactionId: TX,
      bookingDate: '2026-03-02',
      amount: money('60.00'),
      propertyReferenceId: UNIT,
      membershipId: MEMBERSHIP,
      economicPlanId: PLAN,
      case: 'RESERVE_ONLY',
      splits: [{ financialCategoryCode: 'WEG_RESERVE_CONTRIBUTION', propertyReferenceId: UNIT, amount: money('60.00') }],
      flags: [{ code: 'PLAN_OF_EARLIER_YEAR', details: { financialYear: 2025 } }],
    });
    await call(base, 'GET', `/transactions/${TX}/hausgeld-proposal`);
    expect(seen).toMatchObject([{ propertyReferenceId: UNIT }, { propertyReferenceId: null }]);
    expect((await call(base, 'GET', `/transactions/${TX}/hausgeld-proposal?propertyReferenceId=x`)).status).toBe(400);
    expect((await call(base, 'GET', `/transactions/${TX}/hausgeld-proposal?foo=1`)).status).toBe(400);
  });

  it.each([
    [new HausgeldNotProposableError('INFLOW', 'IMPORTED'), 409, 'CONFLICT', { reason: 'NOT_PROPOSABLE', direction: 'INFLOW', status: 'IMPORTED' }],
    [new NoWegMembershipError(null, 'NO_UNIT'), 422, 'NO_WEG_MEMBERSHIP', { reason: 'NO_UNIT' }],
    [
      new NoWegMembershipError(null, 'NO_MEMBERSHIP', UNIT, '2026-03-02'),
      422,
      'NO_WEG_MEMBERSHIP',
      { reason: 'NO_MEMBERSHIP', propertyReferenceId: UNIT, bookingDate: '2026-03-02' },
    ],
    [new NoEconomicPlanError(MEMBERSHIP, '2026-03-02' as BusinessDate), 422, 'NO_ECONOMIC_PLAN', { membershipId: MEMBERSHIP, bookingDate: '2026-03-02' }],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ wegEconomicPlans: { hausgeldProposal: async () => Promise.reject(error) } });
    const res = await call(base, 'GET', `/transactions/${TX}/hausgeld-proposal`);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toEqual(expect.objectContaining({ code, details }));
  });
});

describe('the rules VC-6-02 adds elsewhere', () => {
  it.each([
    ['splits', new NoWegMembershipError(2, 'NO_UNIT'), 422, 'NO_WEG_MEMBERSHIP', { position: 2, reason: 'NO_UNIT' }],
    [
      'end',
      new MembershipHasSplitsError(MEMBERSHIP, [TX]),
      409,
      'CONFLICT',
      { reason: 'MEMBERSHIP_HAS_SPLITS', membershipId: MEMBERSHIP, transactionIds: [TX] },
    ],
    [
      'end',
      new MembershipHasPlansError(MEMBERSHIP, [PLAN]),
      409,
      'CONFLICT',
      { reason: 'MEMBERSHIP_HAS_PLANS', membershipId: MEMBERSHIP, economicPlanIds: [PLAN] },
    ],
    ['amend', new WegHasYearsError(WEG), 409, 'CONFLICT', { reason: 'WEG_HAS_YEARS', wegId: WEG }],
  ])('%s: %s → %i %s', async (route, error, status, code, details) => {
    const reject = async () => Promise.reject(error);
    const base = await start({ transactions: { setSplits: reject }, wegs: { endMembership: reject, amendWeg: reject } });
    const res =
      route === 'splits'
        ? await call(base, 'PUT', `/transactions/${TX}/splits`, { splits: [{ amount: money('360.00'), financialCategoryCode: 'WEG_RECOVERABLE' }] })
        : route === 'end'
          ? await call(base, 'POST', `/weg-memberships/${MEMBERSHIP}/end`, { validUntil: '2026-06-30' })
          : await call(base, 'POST', `/wegs/${WEG}/amend`, { financialYearStartMonth: 7 });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});
