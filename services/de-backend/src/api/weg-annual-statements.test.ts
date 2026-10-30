import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnnualStatementNotFoundError,
  InvalidSupersedesError,
  MembershipHasStatementsError,
  InvalidWegStatementSplitError,
  MembershipNotActiveError,
  NothingToSettleError,
  PeriodOutsideYearError,
  SettlementDirectionMismatchError,
  SettlementNotProposableError,
  StatementNotConfirmedError,
  StatementNotCurrentError,
  TransactionNotFoundError,
  WegStatementNotFoundError,
  type SettlementProposal,
  type StatementComparison,
  StatementExistsError,
  StatementNotDraftError,
  StatementOutsideMembershipError,
  VersionConflictError,
  type AnnualStatementView,
  type CreateAnnualStatementInput,
  type PrincipalVerifier,
} from '../application/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-6-03 HTTP contract (api-design.md §50). Figures are invented. */
const REALM = '64b0c0ffee0000000000000b';
const MEMBERSHIP = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
const STATEMENT = '6b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
const OLD = '7b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
const eur = (amount: string) => Money.of(amount, 'EUR');
const money = (amount: string) => ({ amount, currency: 'EUR' });

const statement = {
  id: STATEMENT,
  mreRealmId: REALM,
  membershipId: MEMBERSHIP,
  financialYear: 2025,
  periodFrom: '2025-01-01',
  periodUntil: '2025-12-31',
  documentDate: null,
  resolutionDate: null,
  dueDate: null,
  supersedes: OLD,
  supersededBy: null,
  costLines: [
    {
      position: 1,
      account: 'Zinserträge',
      group: 'NON_RECOVERABLE',
      allocationKey: 'Miteigentumsanteile',
      allocationTotal: '10000',
      allocationShare: '250',
      totalAmount: eur('-40.00'),
      unitShare: eur('-1.00'),
      classification: 'NON_RECOVERABLE',
      classificationSource: 'PREVIOUS_STATEMENT',
    },
  ],
  recoverableSubtotal: eur('0.00'),
  nonRecoverableSubtotal: eur('-1.00'),
  totalCosts: eur('-1.00'),
  hausgeldRequested: eur('240.00'),
  hausgeldPaid: eur('240.00'),
  reserveRequested: null,
  reservePaid: null,
  settlementPeak: eur('-241.00'),
  settlementResult: null,
  reserve: {
    source: 'ASSET_REPORT',
    lines: [{ position: 1, description: 'Rücklage', kind: 'OPENING', opening: eur('100.00'), addition: null, withdrawal: null, closing: eur('100.01') }],
    unitShareOpening: null,
    unitShareClosing: null,
  },
  byClassification: { RECOVERABLE: eur('0.00'), NON_RECOVERABLE: eur('-1.00'), RESERVE: eur('0.00') },
  flags: [{ code: 'RESERVE_DIFFERS', details: { position: 1, derived: eur('100.00'), printed: eur('100.01') } }],
  status: 'DRAFT',
  confirmedAt: null,
  voidedAt: null,
  voidReason: null,
  sourceReferences: [],
  notes: null,
  createdAt: new Date('2026-10-29T10:00:00Z'),
  version: 1,
} as unknown as AnnualStatementView;

const line = {
  position: 1,
  account: 'Zinserträge',
  group: 'NON_RECOVERABLE',
  allocationKey: 'Miteigentumsanteile',
  allocationTotal: '10000.000',
  allocationShare: '250',
  totalAmount: money('-40.00'),
  unitShare: money('-1.00'),
};
const body = {
  financialYear: 2025,
  periodFrom: '2025-01-01',
  periodUntil: '2025-12-31',
  costLines: [line],
  recoverableSubtotal: money('0.00'),
  nonRecoverableSubtotal: money('-1.00'),
  totalCosts: money('-1.00'),
  hausgeldRequested: money('240.00'),
  hausgeldPaid: money('240.00'),
  settlementPeak: money('-241.00'),
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
const statementsPath = `/weg-memberships/${MEMBERSHIP}/annual-statements`;

describe('POST /weg-memberships/{id}/annual-statements', () => {
  it('201 with the statement, signed Money, flags and sums as JSON; quantities in shortest form; defaults passed; a replay is marked', async () => {
    const seen: CreateAnnualStatementInput[] = [];
    let replayed = false;
    const base = await start({
      wegAnnualStatements: {
        create: async (input) => {
          seen.push(input);
          const answer = { statement, replayed };
          replayed = true;
          return answer;
        },
      },
    });
    const res = await call(base, 'POST', statementsPath, body, { 'idempotency-key': 'k' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(await res.json()).toMatchObject({
      statementId: STATEMENT,
      supersedes: OLD,
      settlementPeak: money('-241.00'),
      reserveRequested: null,
      costLines: [{ position: 1, unitShare: money('-1.00'), allocationTotal: '10000', classificationSource: 'PREVIOUS_STATEMENT' }],
      reserve: { source: 'ASSET_REPORT', lines: [{ kind: 'OPENING', withdrawal: null, closing: money('100.01') }], unitShareOpening: null },
      byClassification: { RECOVERABLE: money('0.00'), NON_RECOVERABLE: money('-1.00'), RESERVE: money('0.00') },
      flags: [{ code: 'RESERVE_DIFFERS', details: { position: 1, derived: money('100.00'), printed: money('100.01') } }],
      status: 'DRAFT',
    });
    expect(seen[0]).toMatchObject({
      membershipId: MEMBERSHIP,
      documentDate: null,
      supersedes: null,
      reserve: null,
      settlementResult: null,
      sourceReferences: [],
      notes: null,
      idempotencyKey: 'k',
      costLines: [{ allocationTotal: '10000', allocationShare: '250', classification: null }],
    });
    expect(seen[0]?.settlementPeak).toEqual(eur('-241.00'));
    // VC-7-03 (§58B): a withdrawal's date passed; absent it is null.
    await call(base, 'POST', statementsPath, {
      ...body,
      reserve: {
        source: 'ANNUAL_STATEMENT',
        lines: [
          { position: 1, description: 'Dach', kind: 'WITHDRAWAL', withdrawal: money('3000.00'), date: '2025-06-15' },
          { position: 2, description: 'Fenster', kind: 'WITHDRAWAL', withdrawal: money('1000.00') },
        ],
      },
    });
    expect(seen[1]?.reserve?.lines.map((l) => l.date)).toEqual(['2025-06-15', null]);
    expect((await call(base, 'POST', statementsPath, body, { 'idempotency-key': 'k' })).headers.get('idempotent-replayed')).toBe('true');
  });

  it('400: no lines, a reversed period, duplicate positions, a share above the total, a quantity format, a document, unknown keys', async () => {
    const base = await start({});
    const fieldsOf = async (payload: unknown) => {
      const res = await call(base, 'POST', statementsPath, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    expect(await fieldsOf({ ...body, costLines: [] })).toEqual([{ field: 'costLines', code: expect.any(String) }]);
    expect(await fieldsOf({ ...body, periodUntil: '2024-12-31' })).toEqual([{ field: 'periodUntil', code: 'INVALID_RANGE' }]);
    expect(await fieldsOf({ ...body, costLines: [line, line] })).toEqual([{ field: 'costLines.1.position', code: 'DUPLICATE' }]);
    const reserveLine = { position: 1, description: 'x', kind: 'OTHER' };
    expect(await fieldsOf({ ...body, reserve: { source: 'ANNUAL_STATEMENT', lines: [reserveLine, reserveLine] } })).toEqual([
      { field: 'reserve.lines.1.position', code: 'DUPLICATE' },
    ]);
    expect(await fieldsOf({ ...body, costLines: [{ ...line, allocationShare: '10000.001' }] })).toEqual([
      { field: 'costLines.0.allocationShare', code: 'OUT_OF_RANGE' },
    ]);
    await fieldsOf({ ...body, costLines: [{ ...line, allocationTotal: '1,5' }] });
    await fieldsOf({ ...body, costLines: [{ ...line, allocationTotal: '1.2345' }] });
    expect(await fieldsOf({ ...body, documentId: STATEMENT })).toEqual([{ field: 'documentId', code: 'NOT_SUPPORTED' }]);
    // VC-7-03 (§58B): a withdrawal's date inside the period; another kind of line takes none.
    const withdrawal = { position: 1, description: 'Dach', kind: 'WITHDRAWAL', withdrawal: money('3000.00') };
    expect(await fieldsOf({ ...body, reserve: { source: 'ANNUAL_STATEMENT', lines: [{ ...withdrawal, date: '2026-01-01' }] } })).toEqual([
      { field: 'reserve.lines.0.date', code: 'OUT_OF_RANGE' },
    ]);
    expect(await fieldsOf({ ...body, reserve: { source: 'ANNUAL_STATEMENT', lines: [{ ...withdrawal, date: '2024-12-31' }] } })).toEqual([
      { field: 'reserve.lines.0.date', code: 'OUT_OF_RANGE' },
    ]);
    expect(await fieldsOf({ ...body, reserve: { source: 'ANNUAL_STATEMENT', lines: [{ ...withdrawal, kind: 'OTHER', date: '2025-06-01' }] } })).toEqual([
      { field: 'reserve.lines.0.date', code: 'NOT_ALLOWED' },
    ]);
    expect(await fieldsOf({ ...body, reserve: { source: 'ANNUAL_STATEMENT', lines: [{ ...withdrawal, date: '2025-02-30' }] } })).toEqual([
      { field: 'reserve.lines.0.date', code: 'INVALID_FORMAT' },
    ]);
    expect(await fieldsOf({ ...body, totalCosts: money('1.001') })).toEqual([{ field: 'totalCosts.amount', code: 'SCALE_EXCEEDED' }]);
    await fieldsOf({ ...body, costLines: [{ ...line, classification: 'OTHER' }] });
    await fieldsOf({ ...body, costLines: [{ ...line, description: 'x' }] });
    await fieldsOf({ ...body, supersedes: 'not-an-id' });
    await fieldsOf({ ...body, status: 'CONFIRMED' });
    expect((await call(base, 'POST', '/weg-memberships/x/annual-statements', body)).status).toBe(400);
  });

  it.each([
    [
      new PeriodOutsideYearError('periodUntil', '2025-01-01' as BusinessDate, '2025-12-31' as BusinessDate),
      400,
      'VALIDATION_ERROR',
      { fields: [{ field: 'periodUntil', code: 'OUT_OF_RANGE' }] },
    ],
    [new MembershipNotActiveError(MEMBERSHIP), 409, 'CONFLICT', { reason: 'MEMBERSHIP_NOT_ACTIVE', membershipId: MEMBERSHIP }],
    [
      new StatementOutsideMembershipError('2025-03-01' as BusinessDate, null),
      422,
      'STATEMENT_OUTSIDE_MEMBERSHIP',
      { validFrom: '2025-03-01', validUntil: null },
    ],
    [new InvalidSupersedesError(OLD, 'OTHER_YEAR'), 422, 'INVALID_SUPERSEDES', { supersedes: OLD, reason: 'OTHER_YEAR' }],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ wegAnnualStatements: { create: async () => Promise.reject(error) } });
    const res = await call(base, 'POST', statementsPath, body);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});

describe('statement reads, replace, confirm, void', () => {
  it('GET list with filters and without lines, GET one with ETag, 404', async () => {
    const seen: unknown[] = [];
    const base = await start({
      wegAnnualStatements: {
        list: async (input) => (seen.push(input), { items: [statement], page: 1, pageSize: 50, total: 1 }),
        get: async ({ statementId }) => (statementId === STATEMENT ? statement : Promise.reject(new AnnualStatementNotFoundError(statementId))),
      },
    });
    const list = (await (await call(base, 'GET', `${statementsPath}?status=DRAFT,CONFIRMED&financialYear=2025`)).json()) as {
      total: number;
      items: Record<string, unknown>[];
    };
    expect(list.total).toBe(1);
    expect(list.items[0]).not.toHaveProperty('costLines');
    expect(list.items[0]).toMatchObject({ statementId: STATEMENT, flags: [{ code: 'RESERVE_DIFFERS' }] });
    expect(seen[0]).toMatchObject({ membershipId: MEMBERSHIP, filter: { statuses: ['DRAFT', 'CONFIRMED'], financialYear: 2025 } });
    expect((await call(base, 'GET', `${statementsPath}?status=OPEN`)).status).toBe(400);
    const one = await call(base, 'GET', `/weg-annual-statements/${STATEMENT}`);
    expect(one.headers.get('etag')).toBe('"1"');
    expect(await one.json()).toHaveProperty('costLines');
    expect(await errorOf(await call(base, 'GET', `/weg-annual-statements/${OLD}`))).toMatchObject({ code: 'NOT_FOUND', details: { statementId: OLD } });
  });

  it('PUT replaces with If-Match; confirm and void pass the versions; their refusals', async () => {
    const seen: unknown[] = [];
    const base = await start({
      wegAnnualStatements: {
        replace: async (input) => (seen.push(input), { statement, changed: true }),
        confirm: async (input) => (seen.push(input), { statement, changed: true }),
        void: async (input) => (seen.push(input), { statement, changed: true }),
      },
    });
    expect((await call(base, 'PUT', `/weg-annual-statements/${STATEMENT}`, body, { 'if-match': '"1"' })).status).toBe(200);
    expect(seen[0]).toMatchObject({ statementId: STATEMENT, expectedVersions: [1], content: { financialYear: 2025, supersedes: null } });
    expect((await call(base, 'PUT', `/weg-annual-statements/${STATEMENT}`, { ...body, costLines: [] })).status).toBe(400);
    expect((await call(base, 'POST', `/weg-annual-statements/${STATEMENT}/confirm`, undefined, { 'if-match': '"2"' })).status).toBe(200);
    expect(seen[1]).toMatchObject({ statementId: STATEMENT, expectedVersions: [2] });
    expect((await call(base, 'POST', `/weg-annual-statements/${STATEMENT}/confirm`, { supersedes: OLD })).status).toBe(400);
    await call(base, 'POST', `/weg-annual-statements/${STATEMENT}/void`, { reason: 'Tippfehler' }, { 'if-match': '"1"' });
    expect(seen[2]).toMatchObject({ statementId: STATEMENT, reason: 'Tippfehler', expectedVersions: [1] });
    expect((await call(base, 'POST', `/weg-annual-statements/${STATEMENT}/void`, {})).status).toBe(400);
  });

  it.each([
    ['confirm', new StatementExistsError(OLD), 409, 'CONFLICT', { reason: 'STATEMENT_EXISTS', statementId: OLD }],
    [
      'confirm',
      new StatementNotDraftError(STATEMENT, 'SUPERSEDED'),
      409,
      'CONFLICT',
      { reason: 'STATEMENT_NOT_DRAFT', statementId: STATEMENT, status: 'SUPERSEDED' },
    ],
    ['confirm', new InvalidSupersedesError(OLD, 'NOT_CONFIRMED'), 422, 'INVALID_SUPERSEDES', { supersedes: OLD, reason: 'NOT_CONFIRMED' }],
    ['replace', new VersionConflictError([1], 2), 412, 'VERSION_CONFLICT', {}],
    ['void', new StatementNotDraftError(STATEMENT, 'CONFIRMED'), 409, 'CONFLICT', { reason: 'STATEMENT_NOT_DRAFT', status: 'CONFIRMED' }],
  ])('%s: %s → %i %s', async (route, error, status, code, details) => {
    const reject = async () => Promise.reject(error);
    const base = await start({ wegAnnualStatements: { replace: reject, confirm: reject, void: reject } });
    const res =
      route === 'replace'
        ? await call(base, 'PUT', `/weg-annual-statements/${STATEMENT}`, body)
        : await call(base, 'POST', `/weg-annual-statements/${STATEMENT}/${route}`, route === 'void' ? { reason: 'x' } : undefined);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});

describe('the rules VC-6-03 adds elsewhere', () => {
  it('end: MEMBERSHIP_HAS_STATEMENTS → 409 with the statement ids', async () => {
    const base = await start({ wegs: { endMembership: async () => Promise.reject(new MembershipHasStatementsError(MEMBERSHIP, [STATEMENT])) } });
    const res = await call(base, 'POST', `/weg-memberships/${MEMBERSHIP}/end`, { validUntil: '2025-06-30' });
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'MEMBERSHIP_HAS_STATEMENTS', membershipId: MEMBERSHIP, statementIds: [STATEMENT] },
    });
  });
});

describe('§51: the comparison and the settlement proposal', () => {
  const TX = '8b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
  const UNIT = '9b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3c';
  const comparison = {
    statementId: STATEMENT,
    membershipId: MEMBERSHIP,
    propertyReferenceId: UNIT,
    financialYear: 2025,
    periodFrom: '2025-01-01',
    periodUntil: '2025-12-31',
    status: 'CONFIRMED',
    classes: {
      RECOVERABLE: { paid: eur('1200.00'), actual: eur('1000.00'), difference: eur('-200.00') },
      NON_RECOVERABLE: { paid: eur('600.00'), actual: eur('500.00'), difference: eur('-100.00') },
      RESERVE: { paid: eur('600.00'), actual: eur('600.00'), difference: eur('0.00') },
    },
    advances: { requested: eur('2400.00'), counted: eur('2400.00'), unpaidAdvances: eur('0.00') },
    settlementPeak: eur('-300.00'),
    settlement: {
      settledBy: [{ transactionId: TX, statementId: OLD, bookingDate: '2026-05-02', amount: eur('-300.00') }],
      settled: eur('-300.00'),
      open: eur('0.00'),
    },
    reserveWithdrawals: [{ position: 1, description: 'Dach', withdrawal: eur('3000.00'), unitShare: eur('75.00') }],
    flags: [{ code: 'SETTLED_AGAINST_SUPERSEDED', details: { transactionIds: [TX] } }],
  } as unknown as StatementComparison;
  const proposal = {
    transactionId: TX,
    statementId: STATEMENT,
    amount: eur('300.00'),
    direction: 'INFLOW',
    settlementPeak: eur('-300.00'),
    splits: [{ financialCategoryCode: 'WEG_RECOVERABLE', propertyReferenceId: UNIT, wegAnnualStatementId: STATEMENT, amount: eur('200.00') }],
    flags: [{ code: 'AMOUNT_DIFFERS_FROM_PEAK', details: { difference: eur('0.01') } }],
  } as unknown as SettlementProposal;

  it('GET …/comparison: signed Money as JSON, flags, withdrawals', async () => {
    const seen: unknown[] = [];
    const base = await start({ wegAnnualStatements: { comparison: async (input) => (seen.push(input), comparison) } });
    const res = await call(base, 'GET', `/weg-annual-statements/${STATEMENT}/comparison`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      classes: { RECOVERABLE: { paid: money('1200.00'), actual: money('1000.00'), difference: money('-200.00') } },
      advances: { unpaidAdvances: money('0.00') },
      settlementPeak: money('-300.00'),
      settlement: { settledBy: [{ transactionId: TX, statementId: OLD, amount: money('-300.00') }], open: money('0.00') },
      reserveWithdrawals: [{ position: 1, withdrawal: money('3000.00'), unitShare: money('75.00') }],
      flags: [{ code: 'SETTLED_AGAINST_SUPERSEDED', details: { transactionIds: [TX] } }],
    });
    expect(seen[0]).toMatchObject({ statementId: STATEMENT });
    expect((await call(base, 'GET', '/weg-annual-statements/x/comparison')).status).toBe(400);
  });

  it('GET …/settlement-proposal: the splits name the statement; statementId required', async () => {
    const seen: unknown[] = [];
    const base = await start({ wegAnnualStatements: { settlementProposal: async (input) => (seen.push(input), proposal) } });
    const res = await call(base, 'GET', `/transactions/${TX}/settlement-proposal?statementId=${STATEMENT.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      direction: 'INFLOW',
      splits: [{ financialCategoryCode: 'WEG_RECOVERABLE', wegAnnualStatementId: STATEMENT, amount: money('200.00') }],
      flags: [{ code: 'AMOUNT_DIFFERS_FROM_PEAK', details: { difference: money('0.01') } }],
    });
    expect(seen[0]).toMatchObject({ transactionId: TX, statementId: STATEMENT });
    expect((await call(base, 'GET', `/transactions/${TX}/settlement-proposal`)).status).toBe(400);
    expect((await call(base, 'GET', `/transactions/${TX}/settlement-proposal?statementId=x`)).status).toBe(400);
    expect((await call(base, 'GET', `/transactions/${TX}/settlement-proposal?statementId=${STATEMENT}&extra=1`)).status).toBe(400);
  });

  it.each([
    ['comparison', new StatementNotConfirmedError(STATEMENT, 'DRAFT'), 409, 'CONFLICT', { reason: 'STATEMENT_NOT_CONFIRMED', status: 'DRAFT' }],
    ['comparison', new AnnualStatementNotFoundError(STATEMENT), 404, 'NOT_FOUND', { statementId: STATEMENT }],
    ['proposal', new TransactionNotFoundError(TX), 404, 'NOT_FOUND', { transactionId: TX }],
    ['proposal', new SettlementNotProposableError('CONFIRMED'), 409, 'CONFLICT', { reason: 'NOT_PROPOSABLE', status: 'CONFIRMED' }],
    [
      'proposal',
      new StatementNotCurrentError(STATEMENT, 'SUPERSEDED', OLD),
      409,
      'CONFLICT',
      { reason: 'STATEMENT_NOT_CURRENT', wegAnnualStatementId: STATEMENT, status: 'SUPERSEDED', supersededBy: OLD },
    ],
    ['proposal', new NothingToSettleError(STATEMENT), 409, 'CONFLICT', { reason: 'NOTHING_TO_SETTLE', statementId: STATEMENT }],
    ['proposal', new SettlementDirectionMismatchError('INFLOW'), 422, 'SETTLEMENT_DIRECTION_MISMATCH', { expected: 'INFLOW' }],
  ])('%s: %s → %i %s', async (route, error, status, code, details) => {
    const reject = async () => Promise.reject(error);
    const base = await start({ wegAnnualStatements: { comparison: reject, settlementProposal: reject } });
    const res =
      route === 'comparison'
        ? await call(base, 'GET', `/weg-annual-statements/${STATEMENT}/comparison`)
        : await call(base, 'GET', `/transactions/${TX}/settlement-proposal?statementId=${STATEMENT}`);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });

  it.each([
    [new WegStatementNotFoundError(STATEMENT), 404, 'NOT_FOUND', { wegAnnualStatementId: STATEMENT }],
    [new InvalidWegStatementSplitError(2, 'UNIT'), 422, 'INVALID_WEG_STATEMENT_SPLIT', { position: 2, reason: 'UNIT' }],
    [new StatementNotCurrentError(STATEMENT, 'DRAFT', null), 409, 'CONFLICT', { reason: 'STATEMENT_NOT_CURRENT', status: 'DRAFT' }],
  ])('splits: %s → %i %s', async (error, status, code, details) => {
    const base = await start({ transactions: { setSplits: async () => Promise.reject(error) } });
    const res = await call(base, 'PUT', `/transactions/${TX}/splits`, {
      splits: [{ amount: money('300.00'), financialCategoryCode: 'WEG_NON_RECOVERABLE', propertyReferenceId: UNIT, wegAnnualStatementId: STATEMENT }],
    });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});
