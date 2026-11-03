import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AttributionChangeAmbiguousError,
  AttributionChangeDiffersError,
  AttributionChangeNotFlaggedError,
  ConcurrentUpdateError,
  LoanAllocationTaxConfirmationNotFoundError,
  NothingToConfirmError,
  TaxYearAcknowledgementNotFoundError,
  type LoanAllocationTaxConfirmation,
  type PrincipalVerifier,
  type TaxYearAcknowledgement,
} from '../application/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith } from './app.test-support.js';
import type { TaxStatementCommands } from './tax-statements.js';

/**
 * The HTTP layer of §58E's statements (VC-X-28): every `400`, the DTOs, `ETag` and `Location`, the error mapping. The
 * use cases are stubs; the orders of checks are the repository test's. Synthetic values only.
 */
const REALM = '64b0c0ffee0000000000e28c';
const PR = '0000e28c-0000-4000-8000-000000000001';
const ACK = '0000e28c-0000-4000-8000-000000000002';
const AUDIT = '0000e28c-0000-4000-8000-000000000003';
const LOAN = '0000e28c-0000-4000-8000-000000000004';
const SET = '0000e28c-0000-4000-8000-000000000005';
const CONF = '0000e28c-0000-4000-8000-000000000006';
const FP = 'a'.repeat(64);
const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });

const acknowledgement: TaxYearAcknowledgement = {
  acknowledgementId: ACK,
  propertyReferenceId: PR,
  year: 2027,
  status: 'ACTIVE',
  change: {
    auditRecordId: AUDIT,
    kind: 'RECONCILIATION_CONFIRMED',
    entityType: 'RentPaymentReconciliation',
    entityId: SET,
    recordedAt: new Date('2028-01-05T10:00:00Z'),
    fingerprint: FP,
    items: [{ sourceId: CONF, yearBefore: 2027, yearAfter: 2028 }],
  },
  reason: 'Erklärung noch nicht abgegeben',
  acknowledgedAt: new Date('2029-03-01T10:00:00Z'),
  acknowledgedBy: 'anna@example.com',
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawReason: null,
  version: 1,
};
const confirmation: LoanAllocationTaxConfirmation = {
  confirmationId: CONF,
  loanId: LOAN,
  allocationSetId: SET,
  status: 'ACTIVE',
  set: { validFrom: '2027-01-01' as BusinessDate, basis: 'PURCHASE_PRICE', allocations: [{ propertyReferenceId: PR, share: '3/5', acquisitionId: null }] },
  reason: 'Kaufpreise',
  advisorPartyId: null,
  confirmedAt: new Date('2029-03-01T10:00:00Z'),
  confirmedBy: 'anna@example.com',
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawReason: null,
  version: 1,
};

let server: Server | undefined;
const extra: Server[] = [];
const seen: unknown[] = [];
async function start(overrides: Partial<TaxStatementCommands> = {}): Promise<string> {
  const taxStatements: TaxStatementCommands = {
    acknowledge: async (input) => (seen.push(input), { acknowledgement, created: true, replayed: false }),
    listAcknowledgements: async (input) => (seen.push(input), [acknowledgement]),
    withdrawAcknowledgement: async (input) => (seen.push(input), { ...acknowledgement, status: 'WITHDRAWN', version: 2 }),
    confirm: async (input) => (seen.push(input), { confirmation, created: true, replayed: false }),
    listConfirmations: async (input) => (seen.push(input), [confirmation]),
    withdrawConfirmation: async (input) => (seen.push(input), { ...confirmation, version: 2 }),
    ...overrides,
  };
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith({ taxStatements }) }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  for (const s of extra.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
  seen.length = 0;
});
const send = (base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const fields = async (res: Response) => {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: { details: { fields: { field: string; code: string }[] } } }).error.details.fields;
};
const ACKS = `/property-references/${PR}/tax-years/2027/acknowledgements`;
const CONFS = `/loans/${LOAN}/allocations/${SET}/tax-confirmations`;
const body = { auditRecordId: AUDIT, expectedFingerprint: FP, reason: ' Grund ' };

describe('POST, GET and withdraw of acknowledgements (§58E Part 2)', () => {
  it('every 400: the ids, year, the body fields all at once, an unknown key, the status filter', async () => {
    const base = await start();
    expect(await fields(await send(base, 'POST', `/property-references/x/tax-years/20x7/acknowledgements`, body))).toEqual([
      { field: 'propertyReferenceId', code: 'INVALID_FORMAT' },
      { field: 'year', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await send(base, 'POST', `/property-references/${PR}/tax-years/1999/acknowledgements`, body))).toEqual([
      { field: 'year', code: 'OUT_OF_RANGE' },
    ]);
    expect(await fields(await send(base, 'POST', ACKS, { auditRecordId: 'x', expectedFingerprint: FP.toUpperCase(), reason: '  ' }))).toEqual([
      { field: 'auditRecordId', code: 'INVALID_FORMAT' },
      { field: 'expectedFingerprint', code: 'INVALID_FORMAT' },
      { field: 'reason', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await send(base, 'POST', ACKS, {}))).toEqual([
      { field: 'auditRecordId', code: 'REQUIRED' },
      { field: 'expectedFingerprint', code: 'REQUIRED' },
      { field: 'reason', code: 'REQUIRED' },
    ]);
    expect((await fields(await send(base, 'POST', ACKS, { ...body, extra: 1 }))).length).toBe(1);
    expect(await fields(await send(base, 'POST', ACKS, { ...body, reason: 'x'.repeat(501) }))).toEqual([{ field: 'reason', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send(base, 'GET', `${ACKS}?status=OPEN`))).toEqual([{ field: 'status', code: 'INVALID_FORMAT' }]);
    expect((await fields(await send(base, 'GET', `${ACKS}?other=1`))).length).toBe(1);
    expect(await fields(await send(base, 'POST', `${ACKS}/x/withdraw`, { reason: 'x' }))).toEqual([{ field: 'acknowledgementId', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send(base, 'POST', `${ACKS}/${ACK}/withdraw`, {}))).toEqual([{ field: 'reason', code: 'REQUIRED' }]);
    expect(seen).toEqual([]);
  });

  it('201 with ETag, Location and the DTO; the reason trimmed and the ids lower-cased; 200 for the no-op; the list and the withdrawal', async () => {
    const base = await start();
    const res = await send(base, 'POST', ACKS.replace(PR, PR.toUpperCase()), { ...body, auditRecordId: AUDIT.toUpperCase() }, { 'idempotency-key': 'k-1' });
    expect([res.status, res.headers.get('etag'), res.headers.get('location')]).toEqual([201, '"1"', `/api/v1${ACKS}/${ACK}`]);
    expect(await res.json()).toEqual({
      acknowledgementId: ACK,
      propertyReferenceId: PR,
      year: 2027,
      status: 'ACTIVE',
      change: {
        auditRecordId: AUDIT,
        kind: 'RECONCILIATION_CONFIRMED',
        entityType: 'RentPaymentReconciliation',
        entityId: SET,
        recordedAt: '2028-01-05T10:00:00.000Z',
        fingerprint: FP,
        items: [{ sourceId: CONF, yearBefore: 2027, yearAfter: 2028 }],
      },
      reason: 'Erklärung noch nicht abgegeben',
      acknowledgedAt: '2029-03-01T10:00:00.000Z',
      acknowledgedBy: 'anna@example.com',
      withdrawnAt: null,
      withdrawnBy: null,
      withdrawReason: null,
      version: 1,
    });
    expect(seen[0]).toMatchObject({ propertyReferenceId: PR, year: 2027, auditRecordId: AUDIT, reason: 'Grund', idempotencyKey: 'k-1' });
    const noop = await start2({ acknowledge: async () => ({ acknowledgement, created: false, replayed: true }) });
    const again = await send(noop, 'POST', ACKS, body);
    expect([again.status, again.headers.get('idempotent-replayed')]).toEqual([200, 'true']);
    expect(((await (await send(base, 'GET', `${ACKS}?status=ACTIVE,WITHDRAWN`)).json()) as { items: unknown[] }).items).toHaveLength(1);
    expect(seen.at(-1)).toMatchObject({ statuses: ['ACTIVE', 'WITHDRAWN'] });
    const withdrawn = await send(base, 'POST', `${ACKS}/${ACK}/withdraw`, { reason: 'Irrtum' }, { 'if-match': '"1"' });
    expect([withdrawn.status, withdrawn.headers.get('etag')]).toEqual([200, '"2"']);
    expect(seen.at(-1)).toMatchObject({ acknowledgementId: ACK, expectedVersions: [1], reason: 'Irrtum' });
  });

  it('the error mapping: 404, 409 CHANGE_NOT_FLAGGED, 412 ATTRIBUTION_CHANGE_DIFFERS, 503 CONCURRENT_UPDATE with Retry-After', async () => {
    const fail = (error: Error) => async () => Promise.reject(error);
    const cases: [Error, number, string, unknown][] = [
      [new TaxYearAcknowledgementNotFoundError(ACK), 404, 'NOT_FOUND', { acknowledgementId: ACK }],
      [new AttributionChangeNotFlaggedError(AUDIT, 2027), 409, 'CONFLICT', { reason: 'CHANGE_NOT_FLAGGED', auditRecordId: AUDIT, year: 2027 }],
      [
        new AttributionChangeDiffersError(AUDIT, FP, 'b'.repeat(64)),
        412,
        'ATTRIBUTION_CHANGE_DIFFERS',
        { auditRecordId: AUDIT, expectedFingerprint: FP, currentFingerprint: 'b'.repeat(64) },
      ],
      [new ConcurrentUpdateError('x'), 503, 'CONCURRENT_UPDATE', undefined],
    ];
    for (const [error, status, code, details] of cases) {
      const base = await start2({ acknowledge: fail(error) });
      const res = await send(base, 'POST', ACKS, body);
      const answer = (await res.json()) as { error: { code: string; details?: unknown } };
      expect([res.status, answer.error.code, answer.error.details], code).toEqual([status, code, details]);
      if (status === 503) expect(res.headers.get('retry-after')).toBe('1');
    }
  });
});

/** A second server for one case, closed after the test with the others. */
async function start2(overrides: Partial<TaxStatementCommands>): Promise<string> {
  const first = server;
  const base = await start(overrides);
  if (server !== undefined) extra.push(server);
  server = first;
  return base;
}

describe('POST, GET and withdraw of tax confirmations (§58E Part 3)', () => {
  it('every 400, 201 with ETag, Location and the DTO; the error mapping of NOTHING_TO_CONFIRM and a missing confirmation', async () => {
    const base = await start();
    expect(await fields(await send(base, 'POST', `/loans/x/allocations/y/tax-confirmations`, { reason: 'x' }))).toEqual([
      { field: 'loanId', code: 'INVALID_FORMAT' },
      { field: 'allocationSetId', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await send(base, 'POST', CONFS, { reason: '', advisorPartyId: 'x' }))).toEqual([
      { field: 'reason', code: 'INVALID_FORMAT' },
      { field: 'advisorPartyId', code: 'INVALID_FORMAT' },
    ]);
    expect((await fields(await send(base, 'GET', `${CONFS}?status=ACTIVE`))).length).toBe(1);
    const res = await send(base, 'POST', CONFS, { reason: 'Kaufpreise', advisorPartyId: PR.toUpperCase() });
    expect([res.status, res.headers.get('etag'), res.headers.get('location')]).toEqual([201, '"1"', `/api/v1${CONFS}/${CONF}`]);
    expect(await res.json()).toMatchObject({
      confirmationId: CONF,
      set: { basis: 'PURCHASE_PRICE', allocations: [{ share: '3/5' }] },
      confirmedAt: '2029-03-01T10:00:00.000Z',
    });
    expect(seen.at(-1)).toMatchObject({ advisorPartyId: PR });
    expect(((await (await send(base, 'GET', CONFS)).json()) as { items: unknown[] }).items).toHaveLength(1);
    expect((await send(base, 'POST', `${CONFS}/${CONF}/withdraw`, { reason: 'Irrtum' })).headers.get('etag')).toBe('"2"');
    const refused = await start2({ confirm: async () => Promise.reject(new NothingToConfirmError(SET, 'SINGLE_ENTRY')) });
    const answer = (await (await send(refused, 'POST', CONFS, { reason: 'x' })).json()) as { error: { code: string; details: unknown } };
    expect(answer.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'NOTHING_TO_CONFIRM', allocationSetId: SET, cause: 'SINGLE_ENTRY' } });
    const missing = await start2({ withdrawConfirmation: async () => Promise.reject(new LoanAllocationTaxConfirmationNotFoundError(CONF)) });
    const gone = await send(missing, 'POST', `${CONFS}/${CONF}/withdraw`, { reason: 'x' });
    expect([gone.status, ((await gone.json()) as { error: { details: unknown } }).error.details]).toEqual([404, { confirmationId: CONF }]);
  });
});

describe('the part shape and the optional kind (§58G, VC-X-48)', () => {
  const part: TaxYearAcknowledgement = {
    ...acknowledgement,
    change: {
      ...acknowledgement.change,
      kind: 'LOAN_ALLOCATION_SET_ADDED',
      entityType: 'LoanAllocationSet',
      items: [
        {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: CONF,
          taxYear: 2027,
          stateBefore: 'ATTRIBUTED',
          partBefore: Money.of('269.99', 'EUR'),
          stateAfter: 'NONE',
          partAfter: null,
        },
      ],
    },
  };

  it('kind: an unknown value 400 INVALID_FORMAT with the other field errors; each kind of both flags passed on; absent when not sent', async () => {
    const base = await start();
    expect(await fields(await send(base, 'POST', ACKS, { ...body, kind: 'LOAN_ALLOCATION_CHANGED', reason: '' }))).toEqual([
      { field: 'kind', code: 'INVALID_FORMAT' },
      { field: 'reason', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await send(base, 'POST', ACKS, { ...body, kind: 'loan_allocation_set_added' }))).toEqual([{ field: 'kind', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send(base, 'POST', ACKS, { ...body, kind: null }))).toEqual([{ field: 'kind', code: 'INVALID_FORMAT' }]);
    expect(seen).toEqual([]);
    for (const kind of ['LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED', 'RECONCILIATION_CONFIRMED', 'LOAN_TERMS_VOIDED']) {
      expect((await send(base, 'POST', ACKS, { ...body, kind })).status).toBe(201);
      expect(seen.at(-1)).toMatchObject({ kind });
    }
    await send(base, 'POST', ACKS, body);
    expect(Object.keys(seen.at(-1) as object)).not.toContain('kind');
  });

  it('the part DTO: change.items in the part shape with Money or null; the year shape unchanged beside it', async () => {
    const base = await start2({
      acknowledge: async () => ({ acknowledgement: part, created: true, replayed: false }),
      listAcknowledgements: async () => [part, acknowledgement],
    });
    const created = (await (await send(base, 'POST', ACKS, { ...body, kind: 'LOAN_ALLOCATION_SET_ADDED' })).json()) as { change: unknown };
    expect(created.change).toEqual({
      auditRecordId: AUDIT,
      kind: 'LOAN_ALLOCATION_SET_ADDED',
      entityType: 'LoanAllocationSet',
      entityId: SET,
      recordedAt: '2028-01-05T10:00:00.000Z',
      fingerprint: FP,
      items: [
        {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: CONF,
          taxYear: 2027,
          stateBefore: 'ATTRIBUTED',
          partBefore: { amount: '269.99', currency: 'EUR' },
          stateAfter: 'NONE',
          partAfter: null,
        },
      ],
    });
    const list = (await (await send(base, 'GET', ACKS)).json()) as { items: { change: { items: unknown[] } }[] };
    expect(list.items.map((i) => i.change.items[0])).toEqual([
      expect.objectContaining({ stateBefore: 'ATTRIBUTED', partAfter: null }),
      { sourceId: CONF, yearBefore: 2027, yearAfter: 2028 },
    ]);
  });

  it('the error mapping: 409 CHANGE_AMBIGUOUS naming the kinds; CHANGE_NOT_FLAGGED names the kind when given; the 412 keeps its one currentFingerprint', async () => {
    const fail = (error: Error) => async () => Promise.reject(error);
    const cases: [Error, number, unknown][] = [
      [
        new AttributionChangeAmbiguousError(AUDIT, 2027, ['DEPOSIT_RECONCILIATION_CONFIRMED', 'RECONCILIATION_CONFIRMED']),
        409,
        { reason: 'CHANGE_AMBIGUOUS', auditRecordId: AUDIT, year: 2027, kinds: ['DEPOSIT_RECONCILIATION_CONFIRMED', 'RECONCILIATION_CONFIRMED'] },
      ],
      [
        new AttributionChangeNotFlaggedError(AUDIT, 2027, 'LOAN_ALLOCATION_SET_VOIDED'),
        409,
        { reason: 'CHANGE_NOT_FLAGGED', auditRecordId: AUDIT, year: 2027, kind: 'LOAN_ALLOCATION_SET_VOIDED' },
      ],
      [
        new AttributionChangeDiffersError(AUDIT, FP, 'c'.repeat(64)),
        412,
        { auditRecordId: AUDIT, expectedFingerprint: FP, currentFingerprint: 'c'.repeat(64) },
      ],
    ];
    for (const [error, status, details] of cases) {
      const base = await start2({ acknowledge: fail(error) });
      const res = await send(base, 'POST', ACKS, body);
      const answer = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
      expect([res.status, answer.error.details]).toEqual([status, details]);
      if (error instanceof AttributionChangeAmbiguousError)
        expect(answer.error.message).toBe('The record is more than one change of this year; name its kind.');
    }
  });
});

describe('the kinds of §58H (VC-X-49): LOAN_CLOSED in the year shape, the deposit kinds in the part shape', () => {
  const closed: TaxYearAcknowledgement = {
    ...acknowledgement,
    change: { ...acknowledgement.change, kind: 'LOAN_CLOSED', entityType: 'Loan', items: [{ sourceId: CONF, yearBefore: 2027, yearAfter: 2028 }] },
  };
  const deposit: TaxYearAcknowledgement = {
    ...acknowledgement,
    change: {
      ...acknowledgement.change,
      kind: 'DEPOSIT_RECONCILIATION_RELEASED',
      entityType: 'RentPaymentReconciliation',
      items: [
        {
          sourceType: 'DEPOSIT_CLOSING',
          sourceId: CONF,
          taxYear: 2027,
          stateBefore: 'NOT_ATTRIBUTED',
          partBefore: null,
          stateAfter: 'ATTRIBUTED',
          partAfter: Money.of('300.00', 'EUR'),
        },
      ],
    },
  };

  it('each new kind passed on; a WEG plan kind 400 INVALID_FORMAT (no such kind, §58H Frage 1)', async () => {
    const base = await start();
    for (const kind of ['LOAN_CLOSED', 'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED']) {
      expect((await send(base, 'POST', ACKS, { ...body, kind })).status).toBe(201);
      expect(seen.at(-1)).toMatchObject({ kind });
    }
    expect(await fields(await send(base, 'POST', ACKS, { ...body, kind: 'WEG_ECONOMIC_PLAN_ADDED' }))).toEqual([{ field: 'kind', code: 'INVALID_FORMAT' }]);
  });

  it('the DTO: LOAN_CLOSED with year items, a deposit kind with DEPOSIT_CLOSING part items', async () => {
    const base = await start2({ listAcknowledgements: async () => [closed, deposit] });
    const list = (await (await send(base, 'GET', ACKS)).json()) as { items: { change: { kind: string; entityType: string; items: unknown[] } }[] };
    expect(list.items.map((i) => [i.change.kind, i.change.entityType, i.change.items])).toEqual([
      ['LOAN_CLOSED', 'Loan', [{ sourceId: CONF, yearBefore: 2027, yearAfter: 2028 }]],
      [
        'DEPOSIT_RECONCILIATION_RELEASED',
        'RentPaymentReconciliation',
        [
          {
            sourceType: 'DEPOSIT_CLOSING',
            sourceId: CONF,
            taxYear: 2027,
            stateBefore: 'NOT_ATTRIBUTED',
            partBefore: null,
            stateAfter: 'ATTRIBUTED',
            partAfter: { amount: '300.00', currency: 'EUR' },
          },
        ],
      ],
    ]);
  });
});
