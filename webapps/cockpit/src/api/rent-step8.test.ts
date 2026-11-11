import { describe, expect, it } from 'vitest';
import { confirmed, splitProposal, TENANT, TERM } from '../rent/fixtures.test-support';
import { REALM_A, REALM_B, TX } from '../transactions/fixtures.test-support';
import { createDeClient } from './client';
import { ApiError, CLIENT_CODES } from './errors';
import { countingTokens, envelope, json, scriptedFetch } from './fetch.test-support';
import { createReconciliation, getSplitProposal, type CreateReconciliationInputDto } from './rent-reconciliations';

/**
 * Client contract of step 8 (Entscheidung des Projektinhabers, 2026-11-11; ui-guide.md §12 point 2): the split proposal
 * (api-design.md §37.6) and the manual match (§37.1) as they leave the browser, and the answers the client accepts.
 */

function client(...answers: Parameters<typeof scriptedFetch>) {
  const { fetch, calls } = scriptedFetch(...answers);
  return { client: createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch }), calls };
}
const EUR = (amount: string) => ({ amount, currency: 'EUR' });
const TERM_REF = { mreTenantId: TENANT, mreRentTerm: TERM };
const refused = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
};

describe('step 8: GET /rent-reconciliations/split-proposal (api-design.md §37.6)', () => {
  it('a read with exactly the three query parameters; no If-Match, no Idempotency-Key, no body', async () => {
    const answer = splitProposal({ amount: '800.00' });
    const { client: de, calls } = client(json(200, answer));
    expect(await getSplitProposal(de, TX, TERM_REF)).toEqual(answer);
    const url = new URL(calls[0]?.url ?? '', 'https://cockpit.internal');
    expect([calls[0]?.method, url.pathname]).toEqual(['GET', '/api/v1/rent-reconciliations/split-proposal']);
    expect([...url.searchParams.entries()]).toEqual([
      ['transactionId', TX],
      ['mreTenantId', TENANT],
      ['mreRentTerm', TERM],
    ]);
    expect(calls[0]?.headers.get('organizationid')).toBe(REALM_A);
    expect(calls[0]?.headers.has('if-match')).toBe(false);
    expect(calls[0]?.headers.has('idempotency-key')).toBe(false);
    expect(calls[0]?.body).toBeUndefined();
  });

  it('an answer for another Transaction, Tenant or term is refused, never shown', async () => {
    for (const other of [
      { transactionId: '00000000-0000-4000-8000-000000000000' },
      { mreTenantId: '64b7f0c2a1b2c3d4e5f60799' },
      { mreRentTerm: '2026040100' },
    ]) {
      const { client: de } = client(json(200, splitProposal({}, other)));
      expect((await refused(getSplitProposal(de, TX, TERM_REF))).code).toBe(CLIENT_CODES.unexpected);
    }
  });

  it('unchanged money: splits plus unallocated must be the amount to the cent; one cent off or another currency is refused', async () => {
    const off = splitProposal({ amount: '900.00' }, { unallocated: EUR('50.01') });
    const { client: a } = client(json(200, off));
    expect((await refused(getSplitProposal(a, TX, TERM_REF))).code).toBe(CLIENT_CODES.unexpected);
    const currency = splitProposal({}, { unallocated: { amount: '0.00', currency: 'CHF' } });
    const { client: b } = client(json(200, currency));
    expect((await refused(getSplitProposal(b, TX, TERM_REF))).code).toBe(CLIENT_CODES.unexpected);
    const { client: c } = client(json(200, splitProposal({ amount: '900.00' })));
    expect((await getSplitProposal(c, TX, TERM_REF)).unallocated).toEqual(EUR('50.00'));
  });

  it('refusals reach the caller with code and details: NOT_PROPOSABLE, MRE_RENT_TERM_NOT_FOUND, 503, 404', async () => {
    const { client: de } = client(
      envelope(409, 'CONFLICT', { reason: 'NOT_PROPOSABLE', direction: 'INFLOW', status: 'CONFIRMED' }),
      envelope(422, 'MRE_RENT_TERM_NOT_FOUND', { mreTenantId: TENANT, mreRentTerm: TERM }),
      envelope(503, 'EXTERNAL_SYSTEM_ERROR', undefined, { 'retry-after': '10' }),
      envelope(404, 'NOT_FOUND', { transactionId: TX }),
    );
    const answers = [];
    for (let i = 0; i < 4; i += 1) answers.push(await refused(getSplitProposal(de, TX, TERM_REF)));
    expect(answers.map((e) => [e.status, e.code, e.details?.['reason'] ?? null])).toEqual([
      [409, 'CONFLICT', 'NOT_PROPOSABLE'],
      [422, 'MRE_RENT_TERM_NOT_FOUND', null],
      [503, 'EXTERNAL_SYSTEM_ERROR', null],
      [404, 'NOT_FOUND', null],
    ]);
    expect(answers[2]?.retryAfterSeconds).toBe(10);
  });
});

describe('step 8: POST /rent-reconciliations, the manual match (api-design.md §37.1)', () => {
  const body: CreateReconciliationInputDto = { transactionId: TX, mreTenantId: TENANT, mreRentTerm: TERM, matchedAmount: EUR('800.00') };
  const created = (overrides = {}) => confirmed('800.00', { confidence: null, suggestionReason: null, version: 1, ...overrides });

  it('sends exactly the body with the intent key; no If-Match; answers the CONFIRMED match with its ETag', async () => {
    const { client: de, calls } = client(json(201, created(), { etag: '"1"' }));
    const result = await createReconciliation(de, body, 'intent-1');
    expect(result).toEqual({ reconciliation: created(), etag: '"1"' });
    expect([calls[0]?.method, calls[0]?.url]).toEqual(['POST', '/api/v1/rent-reconciliations']);
    expect(JSON.parse(calls[0]?.body ?? 'null')).toEqual({ transactionId: TX, mreTenantId: TENANT, mreRentTerm: TERM, matchedAmount: EUR('800.00') });
    expect(calls[0]?.headers.get('idempotency-key')).toBe('intent-1');
    expect(calls[0]?.headers.has('if-match')).toBe(false);
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  it('realm isolation: an answer of another Realm is refused, never shown', async () => {
    const { client: de } = client(json(201, created({ mreRealmId: REALM_B })));
    expect((await refused(createReconciliation(de, body, 'k'))).code).toBe(CLIENT_CODES.realmMismatch);
  });

  it('an answer that is not the match sent is refused: other amount, term, Tenant, Transaction, status or MRE state', async () => {
    const wrong = [
      created({ matchedAmount: EUR('800.01') }),
      created({ mreRentTerm: '2026040100' }),
      created({ mreTenantId: '64b7f0c2a1b2c3d4e5f60799' }),
      created({ transactionId: '00000000-0000-4000-8000-000000000000' }),
      created({ status: 'SUGGESTED' }),
      created({ mreWriteBackState: 'WRITTEN' }),
    ];
    for (const answer of wrong) {
      const { client: de } = client(json(201, answer));
      expect((await refused(createReconciliation(de, body, 'k'))).code).toBe(CLIENT_CODES.unexpected);
    }
  });

  it('every refusal code of §37.1 reaches the caller with its details', async () => {
    const answers = [
      envelope(409, 'CONFLICT', { reason: 'TRANSACTION_NOT_COUNTED', status: 'CLASSIFIED', correctionRole: null }),
      envelope(422, 'TRANSACTION_NOT_INFLOW'),
      envelope(422, 'NO_RENT_CASH'),
      envelope(409, 'CONFLICT', { reason: 'ALREADY_MATCHED', reconciliationId: '8d6b0e9f-1a2c-4d34-8f56-f708192a3b4c' }),
      envelope(409, 'CONFLICT', { reason: 'RENT_CASH_EXCEEDED', rentCash: EUR('850.00'), available: EUR('50.00') }),
      envelope(422, 'MRE_RENT_TERM_NOT_FOUND', { mreTenantId: TENANT, mreRentTerm: TERM }),
      envelope(400, 'VALIDATION_ERROR', { fields: [{ field: 'matchedAmount.amount', code: 'NOT_POSITIVE' }] }),
      envelope(409, 'IDEMPOTENCY_KEY_CONFLICT'),
    ];
    const { client: de } = client(...answers);
    const codes = [];
    for (let i = 0; i < answers.length; i += 1) {
      const e = await refused(createReconciliation(de, body, 'k'));
      codes.push(String(e.details?.['reason'] ?? e.code));
    }
    expect(codes).toEqual([
      'TRANSACTION_NOT_COUNTED',
      'TRANSACTION_NOT_INFLOW',
      'NO_RENT_CASH',
      'ALREADY_MATCHED',
      'RENT_CASH_EXCEEDED',
      'MRE_RENT_TERM_NOT_FOUND',
      'VALIDATION_ERROR',
      'IDEMPOTENCY_KEY_CONFLICT',
    ]);
  });
});
