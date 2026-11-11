import { describe, expect, it } from 'vitest';
import { correctionAnswer, REALM_A, REALM_B, transaction, TX, TX_REPLACEMENT, TX_REVERSAL } from '../transactions/fixtures.test-support';
import { createDeClient } from './client';
import { CLIENT_CODES } from './errors';
import { countingTokens, envelope, json, scriptedFetch } from './fetch.test-support';
import { confirmTransaction, correctTransaction, type CorrectInputDto } from './transactions';

/**
 * Client contract of step 4 (ui-guide.md §12 point 2): the requests of `confirm` and `correct` as they leave the
 * browser and the answers the client accepts (api-design.md §16.1, §34, §35).
 */

function client(...answers: Parameters<typeof scriptedFetch>) {
  const { fetch, calls } = scriptedFetch(...answers);
  return { client: createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch }), calls };
}

const CONFIRMED = () => transaction({ status: 'CONFIRMED', version: 4, confirmedAt: '2026-03-05T10:00:00.000Z', confirmedBy: 'vermieter@example.invalid' });
const BODY: CorrectInputDto = { reason: 'Falsche Kategorie', replacement: { description: 'Korrigierter Verwendungszweck' } };

describe('step 4: POST /transactions/{transactionId}/confirm (api-design.md §34, §16.1)', () => {
  it('sends no body with If-Match, the Realm and the token; no Idempotency-Key (the route takes none)', async () => {
    const { client: de, calls } = client(json(200, CONFIRMED(), { etag: '"4"' }));
    const confirmed = await confirmTransaction(de, TX, '"3"');
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`/api/v1/transactions/${TX}/confirm`);
    expect(call?.headers.get('if-match')).toBe('"3"');
    expect(call?.headers.get('organizationid')).toBe(REALM_A);
    expect(call?.headers.get('authorization')).toBe('Bearer token-1');
    expect(call?.headers.has('idempotency-key')).toBe(false);
    expect(call?.headers.has('content-type')).toBe(false);
    expect(call?.body).toBeUndefined();
    expect(confirmed).toMatchObject({ etag: '"4"', transaction: { status: 'CONFIRMED', version: 4 } });
  });

  it('without an ETag header, the version of the answer is the next entity tag', async () => {
    const { client: de } = client(json(200, CONFIRMED()));
    expect((await confirmTransaction(de, TX, '"3"')).etag).toBe('"4"');
  });

  it('an answer of another Realm or for another Transaction is refused, never shown', async () => {
    const { client: de } = client(
      json(200, transaction({ status: 'CONFIRMED', mreRealmId: REALM_B }), { etag: '"4"' }),
      json(200, transaction({ transactionId: TX_REVERSAL })),
    );
    await expect(confirmTransaction(de, TX, '"3"')).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    await expect(confirmTransaction(de, TX, '"3"')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });

  it('refusals keep status, code and details: 409 SPLITS_MISSING, 412 with the versions, 422 INACTIVE_CATEGORY', async () => {
    const { client: de, calls } = client(
      envelope(409, 'INVARIANT_VIOLATION', { reason: 'SPLITS_MISSING' }),
      envelope(412, 'VERSION_CONFLICT', { expectedVersions: [3], currentVersion: 4 }),
      envelope(422, 'REVIEW_REQUIRED', { reason: 'INACTIVE_CATEGORY', financialCategoryCodes: ['OLD_FEE'] }),
    );
    await expect(confirmTransaction(de, TX, '"3"')).rejects.toMatchObject({ status: 409, details: { reason: 'SPLITS_MISSING' } });
    await expect(confirmTransaction(de, TX, '"3"')).rejects.toMatchObject({ status: 412, details: { currentVersion: 4 } });
    await expect(confirmTransaction(de, TX, '"3"')).rejects.toMatchObject({ status: 422, code: 'REVIEW_REQUIRED' });
    expect(calls).toHaveLength(3);
  });

  it('a weak entity tag is never sent; no answer is status 0 and not repeated by the client', async () => {
    const { client: de, calls } = client(new TypeError('network down'));
    await expect(confirmTransaction(de, TX, 'W/"3"')).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
    await expect(confirmTransaction(de, TX, '"3"')).rejects.toMatchObject({ status: 0, code: CLIENT_CODES.network });
    expect(calls).toHaveLength(1);
  });
});

describe('step 4: POST /transactions/{transactionId}/correct (api-design.md §35, §15, §16.1)', () => {
  it('sends the body as given with If-Match, Idempotency-Key, the Realm and the token', async () => {
    const { client: de, calls } = client(json(201, correctionAnswer({ description: 'Korrigierter Verwendungszweck' })));
    const result = await correctTransaction(de, TX, BODY, '"4"', 'absicht-1');
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe(`/api/v1/transactions/${TX}/correct`);
    expect(call?.headers.get('if-match')).toBe('"4"');
    expect(call?.headers.get('idempotency-key')).toBe('absicht-1');
    expect(call?.headers.get('organizationid')).toBe(REALM_A);
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.body).toBe(JSON.stringify(BODY));
    expect(result.original).toMatchObject({ transactionId: TX, status: 'CORRECTED' });
    expect(result.reversal).toMatchObject({ transactionId: TX_REVERSAL, correctionRole: 'REVERSAL' });
    expect(result.replacement).toMatchObject({ transactionId: TX_REPLACEMENT, correctionRole: 'REPLACEMENT', description: 'Korrigierter Verwendungszweck' });
  });

  it('a chain with any member of another Realm is refused, never shown', async () => {
    for (const member of ['original', 'reversal', 'replacement'] as const) {
      const answer = correctionAnswer();
      const { client: de } = client(json(201, { ...answer, [member]: { ...answer[member], mreRealmId: REALM_B } }));
      await expect(correctTransaction(de, TX, BODY, '"4"', 'k'), member).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    }
  });

  it('an answer that is not the chain of this Transaction is refused: other original, unlinked or missing members, wrong roles', async () => {
    const answer = correctionAnswer();
    const wrong = [
      { ...answer, original: { ...answer.original, transactionId: TX_REVERSAL } },
      { ...answer, reversal: { ...answer.reversal, correctionOfTransactionId: TX_REPLACEMENT } },
      { ...answer, replacement: { ...answer.replacement, correctionOfTransactionId: null } },
      { ...answer, replacement: null },
      { ...answer, reversal: { ...answer.reversal, correctionRole: 'REPLACEMENT' } },
    ];
    for (const body of wrong) {
      const { client: de } = client(json(201, body));
      await expect(correctTransaction(de, TX, BODY, '"4"', 'k')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    }
  });

  it('refusals keep reason and details; field errors keep their dotted names in the server order', async () => {
    const fields = [
      { field: 'replacement.splits.1.amount.amount', code: 'SCALE_EXCEEDED' },
      { field: 'reason', code: 'REQUIRED' },
    ];
    const { client: de } = client(
      envelope(409, 'CONFLICT', { reason: 'TRANSACTION_RENT_RECONCILED', reconciliationIds: ['r1'] }),
      envelope(400, 'VALIDATION_ERROR', { fields }),
    );
    await expect(correctTransaction(de, TX, BODY, '"4"', 'k')).rejects.toMatchObject({
      status: 409,
      details: { reason: 'TRANSACTION_RENT_RECONCILED', reconciliationIds: ['r1'] },
    });
    await expect(correctTransaction(de, TX, BODY, '"4"', 'k')).rejects.toMatchObject({ status: 400, fields });
  });

  it('a key outside the backend format is never sent; no answer is status 0 and not repeated by the client', async () => {
    const { client: de, calls } = client(new TypeError('network down'));
    await expect(correctTransaction(de, TX, BODY, '"4"', 'mit leerzeichen')).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
    await expect(correctTransaction(de, TX, BODY, '"4"', 'k')).rejects.toMatchObject({ status: 0, code: CLIENT_CODES.network });
    expect(calls).toHaveLength(1);
  });
});
