import { describe, expect, it } from 'vitest';
import { json, routedFetch } from './fetch.test-support';

/**
 * The shared test fetch of the area tests (review on #339, H2): the Buchungsdetail's rent section reads
 * `GET /transactions/{id}/rent-reconciliations` since step 6; a test that does not script it gets an answer shaped as the
 * backend's `toTransactionDto` (no rent share, no match) instead of a logged read error. Everything else stays strict.
 */
const TX = '2d0b4e3a-5f6c-4d7e-8f90-91a2b3c4d5e6';
const RENT = `/api/v1/transactions/${TX}/rent-reconciliations`;

describe('routedFetch', () => {
  it('answers the unscripted rent read of a Transaction with no rent share and no match, for that Transaction', async () => {
    const { fetch, calls } = routedFetch({});
    const answer = await fetch(RENT, { method: 'GET' });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      transactionId: TX,
      status: 'IMPORTED',
      direction: 'INFLOW',
      correctionRole: null,
      counted: false,
      rentCash: null,
      matchedTotal: { amount: '0.00', currency: 'EUR' },
      available: null,
      reconciliations: [],
    });
    expect(calls.map((call) => call.url)).toEqual([RENT]);
  });

  it('counter-check: a scripted rent read gets only its own answers; an exhausted queue and any other route stay refused', async () => {
    const { fetch } = routedFetch({ [`GET ${RENT}`]: [() => json(200, { scripted: true })] });
    expect(await (await fetch(RENT, { method: 'GET' })).json()).toEqual({ scripted: true });
    await expect(fetch(RENT, { method: 'GET' })).rejects.toThrow(`unexpected call GET ${RENT}`);
    await expect(fetch(`/api/v1/transactions/${TX}`, { method: 'GET' })).rejects.toThrow('unexpected call');
    await expect(routedFetch({}).fetch(RENT, { method: 'POST' })).rejects.toThrow('unexpected call');
  });
});
