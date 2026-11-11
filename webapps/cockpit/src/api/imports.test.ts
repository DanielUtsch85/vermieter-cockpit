import { describe, expect, it } from 'vitest';
import { USED_ROUTES } from '../gate/backend-pin';
import { batch, BATCH, csvFile, EARLIER_BATCH, EARLIER_ITEM, ITEM, resolved, reviewItem, TX_CREATED } from '../imports/fixtures.test-support';
import { importMetadata, importUpload } from '../imports/import-config';
import { ACCOUNT, REALM_A, REALM_B } from '../transactions/fixtures.test-support';
import { createDeClient } from './client';
import { CLIENT_CODES } from './errors';
import { countingTokens, envelope, json, scriptedFetch, type Call } from './fetch.test-support';
import { getImportBatch, importBankTransactions, listReviewItems, resolveReviewItem } from './imports';

/**
 * Client contract of step 5 (ui-guide.md §12 point 2): the requests of the import, its reads and the resolve as they
 * leave the browser, and the answers the client accepts (api-design.md §32.1a–§32.3a).
 */

function client(...answers: Parameters<typeof scriptedFetch>) {
  const { fetch, calls } = scriptedFetch(...answers);
  return { client: createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch }), calls };
}

const upload = (encoding: 'utf-8' | 'windows-1252' = 'utf-8') => importUpload(csvFile(), importMetadata(ACCOUNT, 'vr-banking', encoding));
const OTHER_ACCOUNT = 'b1ad4a3f-5c6e-4f78-8a9b-3b4c5d6e7f80';

/** The body as a browser would send it: the boundary is chosen when the form is serialised, never by the client. */
async function serialised(call: Call | undefined) {
  if (call?.form === undefined) throw new Error('no form sent');
  const request = new Request('https://cockpit.internal/', { method: 'POST', body: call.form });
  return { contentType: request.headers.get('content-type') ?? '', text: await request.text() };
}

describe('step 5: POST /imports/bank-transactions (api-design.md §32.1a, ui-guide.md §6.5)', () => {
  it('one multipart request: a metadata part and a file part, no Content-Type of its own, no Idempotency-Key', async () => {
    const sent = upload();
    const { client: de, calls } = client(json(201, batch()));
    const answer = await importBankTransactions(de, sent);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('/api/v1/imports/bank-transactions');
    expect(call?.headers.has('content-type')).toBe(false);
    expect(call?.headers.has('idempotency-key')).toBe(false);
    expect(call?.headers.has('if-match')).toBe(false);
    expect(call?.headers.get('organizationid')).toBe(REALM_A);
    expect(call?.headers.get('authorization')).toBe('Bearer token-1');
    expect(call?.body).toBeUndefined();
    expect([...(call?.form?.keys() ?? [])]).toEqual(['metadata', 'file']);
    expect(call?.form?.get('file')).toBe(sent.file);
    expect(JSON.parse(String(call?.form?.get('metadata')))).toEqual({
      financialAccountId: ACCOUNT,
      adapterId: 'generic-csv',
      adapterVersion: '2',
      preset: 'vr-banking',
    });
    expect(answer).toEqual(batch());
  });

  it('serialised, the body has exactly two parts and the boundary of its own Content-Type', async () => {
    const { client: de, calls } = client(json(201, batch()));
    await importBankTransactions(de, upload('windows-1252'));
    const { contentType, text } = await serialised(calls[0]);
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(contentType)?.[1];
    expect(boundary).toBeDefined();
    const parts = text.split(`--${boundary ?? ''}`).slice(1, -1);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('Content-Disposition: form-data; name="metadata"');
    expect(parts[0]).toContain('"encoding":"windows-1252"');
    expect(parts[0]).not.toContain('columnMapping');
    expect(parts[1]).toContain('Content-Disposition: form-data; name="file"; filename="umsaetze-oktober.csv"');
    expect(parts[1]).toContain('Miete Oktober Testwohnung;850,00;EUR');
  });

  it('a batch of another Realm, account or adapter is refused, never shown', async () => {
    const { client: de } = client(
      json(201, batch({ mreRealmId: REALM_B })),
      json(201, batch({ financialAccountId: OTHER_ACCOUNT })),
      json(201, batch({ adapterVersion: '1' })),
    );
    await expect(importBankTransactions(de, upload())).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    await expect(importBankTransactions(de, upload())).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(importBankTransactions(de, upload())).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });

  it('refusals keep status, code, reason and fields: 400 IMPORT_ERROR, 413, 422 ACCOUNT_IBAN_MISMATCH, 400 fields', async () => {
    const fields = [
      { field: 'metadata', code: 'INVALID_FORMAT' },
      { field: '(body)', code: 'INVALID_FORMAT' },
    ];
    const { client: de, calls } = client(
      envelope(400, 'IMPORT_ERROR', { reason: 'MISSING_COLUMN' }),
      envelope(413, 'VALIDATION_ERROR', { maxBytes: 5242880 }),
      envelope(422, 'ACCOUNT_IBAN_MISMATCH', { reason: 'ACCOUNT_HAS_NO_IBAN', accountIban: null, fileIbans: ['DE00000000000000000001'] }),
      envelope(400, 'VALIDATION_ERROR', { fields }),
    );
    await expect(importBankTransactions(de, upload())).rejects.toMatchObject({ status: 400, code: 'IMPORT_ERROR', details: { reason: 'MISSING_COLUMN' } });
    await expect(importBankTransactions(de, upload())).rejects.toMatchObject({ status: 413 });
    await expect(importBankTransactions(de, upload())).rejects.toMatchObject({ status: 422, details: { reason: 'ACCOUNT_HAS_NO_IBAN' } });
    await expect(importBankTransactions(de, upload())).rejects.toMatchObject({ status: 400, fields });
    expect(calls).toHaveLength(4);
  });

  it('no answer is status 0 and not repeated by the client; a JSON body and a form together are never sent', async () => {
    const { client: de, calls } = client(new TypeError('network down'));
    await expect(importBankTransactions(de, upload())).rejects.toMatchObject({ status: 0, code: CLIENT_CODES.network });
    expect(calls).toHaveLength(1);
    await expect(de.post('/imports/bank-transactions', { body: {}, form: new FormData() })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(1);
  });
});

describe('step 5: GET /imports/{id} and GET /imports/{id}/review-items (api-design.md §32.1a, §32.3a)', () => {
  it('reads the batch with no query; a batch of another Realm or another id is refused', async () => {
    const { client: de, calls } = client(json(200, batch()), json(200, batch({ mreRealmId: REALM_B })), json(200, batch({ importBatchId: EARLIER_BATCH })));
    expect(await getImportBatch(de, BATCH)).toEqual(batch());
    expect(calls[0]?.url).toBe(`/api/v1/imports/${BATCH}`);
    expect(calls[0]?.method).toBe('GET');
    await expect(getImportBatch(de, BATCH)).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    await expect(getImportBatch(de, BATCH)).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });

  it('lists the items of the batch read; an item of another batch or account is refused', async () => {
    const { client: de, calls } = client(
      json(200, { importBatchId: BATCH, items: [reviewItem()] }),
      json(200, { importBatchId: BATCH, items: [reviewItem({ importBatchId: EARLIER_BATCH })] }),
      json(200, { importBatchId: EARLIER_BATCH, items: [] }),
      json(200, { importBatchId: BATCH, items: [reviewItem({ financialAccountId: OTHER_ACCOUNT })] }),
    );
    expect(await listReviewItems(de, batch())).toEqual([reviewItem()]);
    expect(calls[0]?.url).toBe(`/api/v1/imports/${BATCH}/review-items`);
    await expect(listReviewItems(de, batch())).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(listReviewItems(de, batch())).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(listReviewItems(de, batch())).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
  });
});

describe('step 5: POST /imports/{importBatchId}/review-items/{reviewItemId}/resolve (api-design.md §32.2, §32.3a)', () => {
  it('sends exactly { resolution } as JSON under the owning batch of the item; no Idempotency-Key', async () => {
    const item = reviewItem({ reviewItemId: EARLIER_ITEM, importBatchId: EARLIER_BATCH });
    const { client: de, calls } = client(json(200, resolved('CREATE', { reviewItemId: EARLIER_ITEM, importBatchId: EARLIER_BATCH })));
    const answer = await resolveReviewItem(de, item, 'CREATE');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`/api/v1/imports/${EARLIER_BATCH}/review-items/${EARLIER_ITEM}/resolve`);
    expect(calls[0]?.body).toBe('{"resolution":"CREATE"}');
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.headers.has('idempotency-key')).toBe(false);
    expect(calls[0]?.headers.get('organizationid')).toBe(REALM_A);
    expect(answer.createdTransactionId).toBe(TX_CREATED);
  });

  it('an answer for another item, batch or account, or not resolved as sent, is refused', async () => {
    const { client: de } = client(
      json(200, resolved('SKIP', { reviewItemId: EARLIER_ITEM })),
      json(200, resolved('SKIP', { importBatchId: EARLIER_BATCH })),
      json(200, resolved('SKIP', { financialAccountId: OTHER_ACCOUNT })),
      json(200, resolved('CREATE')),
      json(200, reviewItem()),
    );
    await expect(resolveReviewItem(de, reviewItem(), 'SKIP')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(resolveReviewItem(de, reviewItem(), 'SKIP')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(resolveReviewItem(de, reviewItem(), 'SKIP')).rejects.toMatchObject({ code: CLIENT_CODES.realmMismatch });
    await expect(resolveReviewItem(de, reviewItem(), 'SKIP')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
    await expect(resolveReviewItem(de, reviewItem(), 'SKIP')).rejects.toMatchObject({ code: CLIENT_CODES.unexpected });
  });

  it('refusals keep reason and details: 409 ALREADY_RESOLVED, 409 ACCOUNT_CLOSED, 404, 422', async () => {
    const { client: de } = client(
      envelope(409, 'CONFLICT', { reason: 'ALREADY_RESOLVED', resolution: 'SKIP' }),
      envelope(409, 'CONFLICT', { reason: 'ACCOUNT_CLOSED' }),
      envelope(404, 'NOT_FOUND', { reviewItemId: ITEM }),
      envelope(422, 'VALIDATION_ERROR', { fields: [{ field: 'resolution', code: 'INVALID_FORMAT' }] }),
    );
    await expect(resolveReviewItem(de, reviewItem(), 'CREATE')).rejects.toMatchObject({
      status: 409,
      details: { reason: 'ALREADY_RESOLVED', resolution: 'SKIP' },
    });
    await expect(resolveReviewItem(de, reviewItem(), 'CREATE')).rejects.toMatchObject({ status: 409, details: { reason: 'ACCOUNT_CLOSED' } });
    await expect(resolveReviewItem(de, reviewItem(), 'CREATE')).rejects.toMatchObject({ status: 404 });
    await expect(resolveReviewItem(de, reviewItem(), 'CREATE')).rejects.toMatchObject({ status: 422, fields: [{ field: 'resolution' }] });
  });
});

/** The inventory route a call reached: its path matched against the `:parameter` templates of `USED_ROUTES`. */
function routeOf(call: Pick<Call, 'url' | 'method'>): string | undefined {
  const path = new URL(call.url, 'https://cockpit.internal').pathname;
  const used = USED_ROUTES.find(([method, template]) => method === call.method && new RegExp(`^${template.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path));
  return used === undefined ? undefined : `${used[0]} ${used[1]}`;
}

describe('integration gate: step 5 calls only routes of the pinned inventory', () => {
  it('every request of the import is a route of USED_ROUTES, and every import route there is used', async () => {
    const { client: de, calls } = client(
      json(201, batch()),
      json(200, batch()),
      json(200, { importBatchId: BATCH, items: [reviewItem()] }),
      json(200, resolved('SKIP')),
    );
    await importBankTransactions(de, upload());
    await getImportBatch(de, BATCH);
    await listReviewItems(de, batch());
    await resolveReviewItem(de, reviewItem(), 'SKIP');
    const reached = calls.map(routeOf);
    expect(reached).not.toContain(undefined);
    const imports = USED_ROUTES.filter(([, path]) => path.startsWith('/api/v1/imports')).map(([method, path]) => `${method} ${path}`);
    expect(new Set(reached)).toEqual(new Set(imports));
    expect(imports).toHaveLength(4);
  });

  it('counter-check: an import route outside USED_ROUTES is found', () => {
    expect(routeOf({ url: `/api/v1/imports/${BATCH}/review-items/${ITEM}/resolve`, method: 'PUT' })).toBeUndefined();
    expect(routeOf({ url: `/api/v1/imports/${BATCH}/review-items/${ITEM}`, method: 'GET' })).toBeUndefined();
    expect(routeOf({ url: '/api/v1/imports', method: 'GET' })).toBeUndefined();
  });
});
