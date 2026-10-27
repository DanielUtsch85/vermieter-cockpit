import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcquisitionNotFoundError,
  ClosingBeforeDebtError,
  IdempotencyKeyConflictError,
  LoanClosedError,
  LoanFieldsInvalidError,
  LoanHasSplitsError,
  LoanNotActiveError,
  LoanNotFoundError,
  LoanRefinancesError,
  OwnerInactiveError,
  PartyNotFoundError,
  RefinancingLoanNotActiveError,
  RefinancingLoanNotFoundError,
  RemainingDebtNotZeroError,
  SplitsAfterClosingError,
  VersionConflictError,
  type CreateLoanInput,
  type Loan,
  type LoanChanges,
  type PrincipalVerifier,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp, type AppDependencies } from './app.js';
import { unusedCommands } from './app.test-support.js';

/** VC-3-01 HTTP contract (api-design.md §41.1). */
const REALM = '64b0c0ffee0000000000000a';
const ID = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const BANK = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const ANNA = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const BEN = '3b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const loan = {
  id: ID,
  mreRealmId: REALM,
  status: 'ACTIVE',
  lenderPartyId: BANK,
  borrowerPartyIds: [ANNA, BEN],
  principalOriginal: Money.of('250000.00', 'EUR'),
  startDate: '2026-08-15',
  disbursementDate: null,
  maturityDate: null,
  contractNumber: 'D-4711',
  acquisitionId: null,
  sourceReferences: [],
  notes: null,
  voidedAt: null,
  voidReason: null,
  closingDate: null,
  closingReason: null,
  refinancedByLoanId: null,
  closingNote: null,
  createdAt: new Date('2026-08-15T10:00:00Z'),
  version: 1,
} as unknown as Loan;

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });
let server: Server | undefined;

async function start(commands: Partial<AppDependencies>): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...unusedCommands, ...commands }).listen(0, '127.0.0.1');
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
const body = {
  lenderPartyId: BANK,
  borrowerPartyIds: [ANNA.toUpperCase(), BEN],
  principalOriginal: { amount: '250000.00', currency: 'EUR' },
  startDate: '2026-08-15',
  contractNumber: '  D-4711 ',
};

describe('POST /api/v1/loans', () => {
  it('201 with the Loan, its debtFrom and ETag; ids lowercased, texts trimmed; a replay is marked', async () => {
    const seen: CreateLoanInput[] = [];
    let replayed = false;
    const base = await start({
      createLoan: async (input) => {
        seen.push(input);
        const answer = { loan, replayed };
        replayed = true;
        return answer;
      },
    });
    const res = await call(base, 'POST', '/loans', body, { 'idempotency-key': 'l1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(await res.json()).toEqual({
      loanId: ID,
      mreRealmId: REALM,
      status: 'ACTIVE',
      lenderPartyId: BANK,
      borrowerPartyIds: [ANNA, BEN],
      principalOriginal: { amount: '250000.00', currency: 'EUR' },
      startDate: '2026-08-15',
      disbursementDate: null,
      debtFrom: '2026-08-15',
      maturityDate: null,
      contractNumber: 'D-4711',
      acquisitionId: null,
      sourceReferences: [],
      notes: null,
      voidedAt: null,
      voidReason: null,
      closingDate: null,
      closingReason: null,
      refinancedByLoanId: null,
      closingNote: null,
      createdAt: '2026-08-15T10:00:00.000Z',
      version: 1,
    });
    expect(seen[0]).toMatchObject({
      borrowerPartyIds: [ANNA, BEN],
      contractNumber: 'D-4711',
      disbursementDate: null,
      maturityDate: null,
      acquisitionId: null,
      sourceReferences: [],
      notes: null,
      idempotencyKey: 'l1',
    });
    expect((await call(base, 'POST', '/loans', body, { 'idempotency-key': 'l1' })).headers.get('idempotent-replayed')).toBe('true');
  });

  it('400 with the field codes', async () => {
    const base = await start({});
    const fieldsOf = async (payload: unknown) => {
      const res = await call(base, 'POST', '/loans', payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    expect(await fieldsOf({ ...body, principalOriginal: { amount: '0.00', currency: 'EUR' } })).toEqual([{ field: 'principalOriginal.amount', code: 'NOT_POSITIVE' }]);
    expect(await fieldsOf({ ...body, disbursementDate: '2026-08-14' })).toEqual([{ field: 'disbursementDate', code: 'BEFORE_START_DATE' }]);
    expect(await fieldsOf({ ...body, maturityDate: '2026-08-15' })).toEqual([{ field: 'maturityDate', code: 'NOT_AFTER_DISBURSEMENT' }]);
    expect(await fieldsOf({ ...body, disbursementDate: '2026-09-01', maturityDate: '2026-08-31' })).toEqual([{ field: 'maturityDate', code: 'NOT_AFTER_DISBURSEMENT' }]);
    expect(await fieldsOf({ ...body, borrowerPartyIds: [ANNA, BANK] })).toEqual([{ field: 'borrowerPartyIds.1', code: 'LENDER_IS_BORROWER' }]);
    expect(await fieldsOf({ ...body, borrowerPartyIds: [ANNA, ANNA] })).toEqual([{ field: 'borrowerPartyIds.1', code: 'DUPLICATE' }]);
    expect(await fieldsOf({ ...body, borrowerPartyIds: [] })).toEqual([{ field: 'borrowerPartyIds', code: 'INVALID_FORMAT' }]);
    expect(await fieldsOf({ ...body, documentIds: [ID] })).toEqual([{ field: 'documentIds', code: 'NOT_SUPPORTED' }]);
    // data-model §21's terms fields belong to the terms (P3-D2): unknown keys here.
    for (const key of ['repaymentType', 'paymentFrequency', 'currentTermsId']) await fieldsOf({ ...body, [key]: 'x' });
    for (const bad of [{ ...body, startDate: 'x' }, { ...body, principalOriginal: 1000 }, { ...body, lenderPartyId: 'x' }]) await fieldsOf(bad);
  });

  it.each([
    [new PartyNotFoundError(ANNA), 404, 'NOT_FOUND', { partyId: ANNA }],
    [new AcquisitionNotFoundError(ID), 404, 'NOT_FOUND', { acquisitionId: ID }],
    [new OwnerInactiveError(BANK), 422, 'PARTY_INACTIVE', { partyId: BANK }],
    [new IdempotencyKeyConflictError('x'), 409, 'CONFLICT', undefined],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ createLoan: async () => Promise.reject(error) });
    const res = await call(base, 'POST', '/loans', body);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, ...(details === undefined ? {} : { details }) });
  });
});

describe('POST /api/v1/loans/{id}/amend', () => {
  it('passes only the given fields; null clears; If-Match carries the versions', async () => {
    const seen: { changes: LoanChanges; expectedVersions?: readonly number[] }[] = [];
    const base = await start({
      amendLoan: async (input) => {
        seen.push(input);
        return { loan, changed: true };
      },
    });
    const res = await call(base, 'POST', `/loans/${ID}/amend`, { borrowerPartyIds: [BEN], maturityDate: null, notes: '' }, { 'if-match': '"1"' });
    expect(res.status).toBe(200);
    expect(seen[0]).toEqual(expect.objectContaining({ changes: { borrowerPartyIds: [BEN], maturityDate: null, notes: null }, expectedVersions: [1] }));
  });

  it('400: fixed fields NOT_AMENDABLE, an empty body REQUIRED, unknown keys, and the merged rules from the domain', async () => {
    const base = await start({ amendLoan: async () => Promise.reject(new LoanFieldsInvalidError([{ field: 'borrowerPartyIds.0', code: 'LENDER_IS_BORROWER' }])) });
    const fieldsOf = async (payload: unknown) => {
      const res = await call(base, 'POST', `/loans/${ID}/amend`, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      return ((await errorOf(res)).details as { fields: unknown[] }).fields;
    };
    expect(await fieldsOf({ principalOriginal: { amount: '1.00', currency: 'EUR' }, startDate: '2026-01-01' })).toEqual([
      { field: 'principalOriginal', code: 'NOT_AMENDABLE' },
      { field: 'startDate', code: 'NOT_AMENDABLE' },
    ]);
    expect(await fieldsOf({ disbursementDate: null })).toEqual([{ field: 'disbursementDate', code: 'NOT_AMENDABLE' }]);
    expect(await fieldsOf({ acquisitionId: ID })).toEqual([{ field: 'acquisitionId', code: 'NOT_AMENDABLE' }]);
    expect(await fieldsOf({})).toEqual([{ field: '(body)', code: 'REQUIRED' }]);
    await fieldsOf({ status: 'VOID' });
    expect(await fieldsOf({ lenderPartyId: ANNA })).toEqual([{ field: 'borrowerPartyIds.0', code: 'LENDER_IS_BORROWER' }]);
  });

  it.each([
    [new LoanNotFoundError(ID), 404, 'NOT_FOUND', { loanId: ID }],
    [new LoanNotActiveError(ID, 'VOID'), 409, 'CONFLICT', { reason: 'LOAN_NOT_ACTIVE', status: 'VOID' }],
    [new PartyNotFoundError(BEN), 404, 'NOT_FOUND', { partyId: BEN }],
    [new OwnerInactiveError(BEN), 422, 'PARTY_INACTIVE', { partyId: BEN }],
    [new VersionConflictError([1], 2), 412, 'VERSION_CONFLICT', { expectedVersions: [1], currentVersion: 2 }],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ amendLoan: async () => Promise.reject(error) });
    const res = await call(base, 'POST', `/loans/${ID}/amend`, { notes: 'x' });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});

describe('POST /api/v1/loans/{id}/void', () => {
  it('200 with the Loan; the reason is required', async () => {
    const base = await start({ voidLoan: async ({ reason }) => ({ loan: { ...loan, status: 'VOID', voidReason: reason, version: 2 } as Loan, changed: true }) });
    const res = await call(base, 'POST', `/loans/${ID}/void`, { reason: ' Doppelt ' });
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"2"');
    expect(await res.json()).toMatchObject({ status: 'VOID', voidReason: 'Doppelt' });
    expect((await call(base, 'POST', `/loans/${ID}/void`, { reason: ' ' })).status).toBe(400);
    expect((await call(base, 'POST', `/loans/${ID}/void`, {})).status).toBe(400);
  });

  it.each([
    [new LoanNotFoundError(ID), 404, 'NOT_FOUND', { loanId: ID }],
    [new LoanClosedError(ID), 409, 'CONFLICT', { reason: 'LOAN_CLOSED' }],
    [new LoanHasSplitsError(ID, [BEN]), 409, 'CONFLICT', { reason: 'LOAN_HAS_SPLITS', transactionIds: [BEN] }],
    [new VersionConflictError([1], 2), 412, 'VERSION_CONFLICT', { currentVersion: 2 }],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ voidLoan: async () => Promise.reject(error) });
    const res = await call(base, 'POST', `/loans/${ID}/void`, { reason: 'x' });
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });
});

describe('POST /api/v1/loans/{id}/close (§41.7)', () => {
  const body = { closingDate: '2027-06-30', reason: 'REFINANCED', refinancedByLoanId: BEN.toUpperCase() };

  it('200 with the closed Loan and ETag; the request reaches the command normalized; If-Match passed', async () => {
    const seen: unknown[] = [];
    const base = await start({
      closeLoan: async (input) => {
        seen.push(input);
        return {
          loan: { ...loan, status: 'CLOSED', closingDate: '2027-06-30', closingReason: 'REFINANCED', refinancedByLoanId: BEN, closingNote: null, version: 2 } as unknown as Loan,
          changed: true,
        };
      },
    });
    const res = await call(base, 'POST', `/loans/${ID}/close`, body, { 'if-match': '"1"' });
    expect([res.status, res.headers.get('etag')]).toEqual([200, '"2"']);
    expect(await res.json()).toMatchObject({ status: 'CLOSED', closingDate: '2027-06-30', closingReason: 'REFINANCED', refinancedByLoanId: BEN, closingNote: null });
    expect(seen[0]).toMatchObject({ loanId: ID, closingDate: '2027-06-30', reason: 'REFINANCED', refinancedByLoanId: BEN, closingNote: null, expectedVersions: [1] });
    await call(base, 'POST', `/loans/${ID}/close`, { closingDate: '2027-06-30', reason: 'OTHER', closingNote: ' Vergleich ' });
    expect(seen[1]).toMatchObject({ reason: 'OTHER', refinancedByLoanId: null, closingNote: 'Vergleich' });
  });

  it('400: strict body, the reason, refinancedByLoanId required exactly for REFINANCED and not the Loan itself, a note for OTHER', async () => {
    const base = await start({});
    const fields = async (b: unknown) => ((await errorOf(await call(base, 'POST', `/loans/${ID}/close`, b))).details as { fields: unknown[] }).fields;
    expect(await fields({ ...body, extra: 1 })).toHaveLength(1);
    expect(await fields({ closingDate: '2027-06-30', reason: 'SOLD' })).toEqual([{ field: 'reason', code: 'INVALID_FORMAT' }]);
    expect(await fields({ closingDate: '2027-06-30', reason: 'REFINANCED' })).toEqual([{ field: 'refinancedByLoanId', code: 'REQUIRED' }]);
    expect(await fields({ closingDate: '2027-06-30', reason: 'REPAID', refinancedByLoanId: BEN })).toEqual([{ field: 'refinancedByLoanId', code: 'NOT_ALLOWED_FOR_REASON' }]);
    expect(await fields({ closingDate: '2027-06-30', reason: 'OTHER', closingNote: '  ' })).toEqual([{ field: 'closingNote', code: 'REQUIRED' }]);
    expect(await fields({ closingDate: '2027-06-30', reason: 'REFINANCED', refinancedByLoanId: ID.toUpperCase() })).toEqual([{ field: 'refinancedByLoanId', code: 'SELF_REFERENCE' }]);
    expect((await fields({ reason: 'REPAID' }))[0]).toMatchObject({ field: 'closingDate' });
  });

  it.each([
    [new LoanNotFoundError(ID), 404, 'NOT_FOUND', { loanId: ID }],
    [new LoanNotActiveError(ID, 'CLOSED'), 409, 'CONFLICT', { reason: 'LOAN_NOT_ACTIVE', status: 'CLOSED' }],
    [new ClosingBeforeDebtError('2027-01-01' as never), 422, 'CLOSING_BEFORE_DEBT', { debtFrom: '2027-01-01' }],
    [new RefinancingLoanNotFoundError(BEN), 404, 'NOT_FOUND', { refinancedByLoanId: BEN }],
    [new RefinancingLoanNotActiveError('VOID'), 422, 'REFINANCING_LOAN_NOT_ACTIVE', { status: 'VOID' }],
    [new SplitsAfterClosingError([BANK]), 409, 'CONFLICT', { reason: 'SPLITS_AFTER_CLOSING', transactionIds: [BANK] }],
    [new RemainingDebtNotZeroError(-1n), 409, 'CONFLICT', { reason: 'REMAINING_DEBT_NOT_ZERO', actual: { amount: '-0.01', currency: 'EUR' } }],
    [new RemainingDebtNotZeroError(12_345n), 409, 'CONFLICT', { reason: 'REMAINING_DEBT_NOT_ZERO', actual: { amount: '123.45', currency: 'EUR' } }],
    [new VersionConflictError([1], 2), 412, 'VERSION_CONFLICT', { currentVersion: 2 }],
  ])('%s → %i %s', async (error, status, code, details) => {
    const base = await start({ closeLoan: async () => Promise.reject(error) });
    const res = await call(base, 'POST', `/loans/${ID}/close`, body);
    expect(res.status).toBe(status);
    expect(await errorOf(res)).toMatchObject({ code, details });
  });

  it('void of a successor: 409 LOAN_REFINANCES', async () => {
    const base = await start({ voidLoan: async () => Promise.reject(new LoanRefinancesError(ID, [BEN])) });
    const res = await call(base, 'POST', `/loans/${ID}/void`, { reason: 'x' });
    expect([res.status, await errorOf(res)]).toMatchObject([409, { code: 'CONFLICT', details: { reason: 'LOAN_REFINANCES', loanIds: [BEN] } }]);
  });
});

describe('reads', () => {
  it('GET /loans/{id}: the Loan with ETag; malformed id 400; unknown 404', async () => {
    const base = await start({
      getLoan: async ({ loanId }) => {
        if (loanId !== ID) throw new LoanNotFoundError(loanId);
        return loan;
      },
    });
    const res = await call(base, 'GET', `/loans/${ID.toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"1"');
    expect((await call(base, 'GET', '/loans/x')).status).toBe(400);
    expect((await call(base, 'GET', `/loans/${BEN}`)).status).toBe(404);
  });

  it('GET /loans: the filters and paging reach the read; unknown parameters are 400', async () => {
    const seen: unknown[] = [];
    const base = await start({
      listLoans: async (input) => {
        seen.push(input);
        return { items: [loan], page: input.page.page, pageSize: input.page.pageSize, total: 1 };
      },
    });
    const res = await call(base, 'GET', `/loans?status=ACTIVE&partyId=${ANNA.toUpperCase()}&acquisitionId=${ID}&page=2&pageSize=10`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [{ loanId: ID }], page: 2, pageSize: 10, total: 1 });
    expect(seen[0]).toMatchObject({ filter: { status: 'ACTIVE', partyId: ANNA, acquisitionId: ID }, page: { page: 2, pageSize: 10 } });
    expect((await call(base, 'GET', '/loans?propertyReferenceId=x')).status).toBe(400);
    expect((await call(base, 'GET', '/loans?status=OPEN')).status).toBe(400);
  });
});
