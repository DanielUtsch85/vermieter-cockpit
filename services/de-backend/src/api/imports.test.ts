import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FinancialAccountClosedError,
  FinancialAccountNotFoundError,
  ImportBatchNotFoundError,
  ImportFileError,
  ReviewItemNotFoundError,
  ReviewResolutionConflictError,
  UnsupportedAdapterError,
  type ConflictingTransaction,
  type ImportBankStatementInput,
  type ImportBatch,
  type PrincipalVerifier,
  type ReviewItem,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';
import { MAX_IMPORT_FILE_BYTES } from './imports.js';

const REALM = '64b0c0ffee0000000000000a';
const ACCOUNT = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const BATCH = '5d4c3b2a-1f0e-4d9c-8b7a-695847362514';
const batch = {
  id: BATCH,
  mreRealmId: REALM,
  financialAccountId: ACCOUNT,
  adapterId: 'generic-csv',
  adapterVersion: '1',
  sourceFilename: 'umsatz.csv',
  contentHash: 'abc',
  status: 'COMPLETED',
  transactionCount: 1,
  duplicateCount: 0,
  needsReviewCount: 0,
  errorCount: 0,
  skippedCount: 0,
  importedAt: new Date('2026-10-19T08:00:00Z'),
  importedBy: 'anna@example.com',
  rows: [{ outcome: 'created', position: 1, transactionId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }],
} as unknown as ImportBatch;

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({
  email: 'anna@example.com',
  mreRealmId: mreRealmId ?? '',
  mreRole: 'administrator',
});

let server: Server | undefined;

async function start(commands: CommandOverrides): Promise<string> {
  server = createApp({
    isReady: async () => true,
    verifyPrincipal: admin,
    ...commandsWith(commands),
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const auth = { authorization: 'Bearer a.b.c', organizationid: REALM };
const metadata = {
  financialAccountId: ACCOUNT.toUpperCase(),
  adapterId: 'generic-csv',
  adapterVersion: '1',
  columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag' },
};
const csv = 'Buchungstag;Betrag\n01.09.2026;1.250,00\n';

function form(parts: { metadata?: unknown; file?: string | Uint8Array; extra?: [string, string] }): FormData {
  const data = new FormData();
  if (parts.metadata !== undefined) {
    data.append('metadata', typeof parts.metadata === 'string' ? parts.metadata : JSON.stringify(parts.metadata));
  }
  if (parts.file !== undefined) data.append('file', new Blob([parts.file]), 'umsatz.csv');
  if (parts.extra !== undefined) data.append(...parts.extra);
  return data;
}
/** The error envelope of a response (api-design.md §12). */
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; details: { fields?: unknown } } }).error;
const upload = (base: string, body: FormData | string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/imports/bank-transactions`, { method: 'POST', headers: { ...auth, ...headers }, body });

describe('POST /api/v1/imports/bank-transactions', () => {
  it('201 with the batch; the use case gets the file bytes, filename and the remaining metadata as options', async () => {
    const seen: ImportBankStatementInput[] = [];
    const base = await start({
      imports: {
        importStatement: async (input) => {
          seen.push(input);
          return batch;
        },
      },
    });
    const res = await upload(base, form({ metadata, file: csv }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      importBatchId: BATCH,
      mreRealmId: REALM,
      financialAccountId: ACCOUNT,
      adapterId: 'generic-csv',
      adapterVersion: '1',
      sourceFilename: 'umsatz.csv',
      contentHash: 'abc',
      status: 'COMPLETED',
      transactionCount: 1,
      duplicateCount: 0,
      needsReviewCount: 0,
      errorCount: 0,
      skippedCount: 0,
      importedAt: '2026-10-19T08:00:00.000Z',
      importedBy: 'anna@example.com',
      rows: [{ outcome: 'created', position: 1, transactionId: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }],
    });
    expect(seen).toHaveLength(1);
    const [input] = seen;
    expect(input).toMatchObject({
      principal: { mreRealmId: REALM, email: 'anna@example.com' },
      financialAccountId: ACCOUNT,
      adapterId: 'generic-csv',
      adapterVersion: '1',
      options: { columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag' } },
      sourceFilename: 'umsatz.csv',
    });
    expect(Buffer.from(input?.file ?? []).toString('utf8')).toBe(csv);
  });

  it('400 for a missing part, non-JSON or invalid metadata, an unexpected part or a non-multipart body', async () => {
    const base = await start({ imports: { importStatement: async () => batch } });
    const cases: [FormData | string, unknown][] = [
      [form({ file: csv }), [{ field: 'metadata', code: 'REQUIRED' }]],
      [form({ metadata }), [{ field: 'file', code: 'REQUIRED' }]],
      [form({ metadata: '{nope', file: csv }), [{ field: 'metadata', code: 'INVALID_FORMAT' }]],
      [form({ metadata: { ...metadata, financialAccountId: 'x' }, file: csv }), [{ field: 'financialAccountId', code: 'INVALID_FORMAT' }]],
      [form({ metadata: { ...metadata, adapterId: undefined }, file: csv }), [{ field: 'adapterId', code: 'REQUIRED' }]],
    ];
    for (const [body, fields] of cases) {
      const res = await upload(base, body);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatchObject({ code: 'VALIDATION_ERROR', details: { fields } });
    }
    const extra = await upload(base, form({ metadata, file: csv, extra: ['other', 'x'] }));
    expect(extra.status).toBe(400);
    const json = await upload(base, JSON.stringify(metadata), { 'content-type': 'application/json' });
    expect(json.status).toBe(400);
    expect((await errorOf(json)).code).toBe('VALIDATION_ERROR');
  });

  it('413 for a file over the limit, without calling the use case', async () => {
    let called = false;
    const base = await start({
      imports: {
        importStatement: async () => {
          called = true;
          return batch;
        },
      },
    });
    // Just over the limit: caught while streaming.
    const res = await upload(base, form({ metadata, file: new Uint8Array(MAX_IMPORT_FILE_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect(res.headers.get('connection')).toBe('close');
    expect(await errorOf(res)).toMatchObject({ code: 'VALIDATION_ERROR', details: { maxBytes: MAX_IMPORT_FILE_BYTES } });
    // Far over the limit: refused from the declared length, before reading the body.
    const huge = await upload(base, form({ metadata, file: new Uint8Array(4 * MAX_IMPORT_FILE_BYTES) }));
    expect(huge.status).toBe(413);
    expect(called).toBe(false);
  });

  it('maps use-case errors: 404 account, 400 adapter, 400 IMPORT_ERROR with the file-level reason', async () => {
    const errors = [
      [new FinancialAccountNotFoundError(ACCOUNT), 404, { code: 'NOT_FOUND', details: { financialAccountId: ACCOUNT } }],
      [new UnsupportedAdapterError('mt940', '1'), 400, { code: 'VALIDATION_ERROR', details: { fields: [{ field: 'adapterId', code: 'NOT_SUPPORTED' }] } }],
      [
        new ImportFileError({ code: 'MISSING_COLUMN', message: 'Column "Betrag" not found' }),
        400,
        { code: 'IMPORT_ERROR', message: 'Column "Betrag" not found', details: { reason: 'MISSING_COLUMN' } },
      ],
    ] as const;
    for (const [error, status, body] of errors) {
      const base = await start({ imports: { importStatement: () => Promise.reject(error) } });
      const res = await upload(base, form({ metadata, file: csv }));
      expect(res.status).toBe(status);
      expect(await errorOf(res)).toMatchObject(body);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });
});

describe('GET /api/v1/imports/{importBatchId}', () => {
  it('200 with the batch; 400 for a non-UUID; 404 when not in the Realm', async () => {
    const base = await start({
      imports: {
        getBatch: async ({ importBatchId, principal }) => {
          if (importBatchId === BATCH && principal.mreRealmId === REALM) return batch;
          throw new ImportBatchNotFoundError(importBatchId);
        },
      },
    });
    const ok = await fetch(`${base}/api/v1/imports/${BATCH.toUpperCase()}`, { headers: auth });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ importBatchId: BATCH, status: 'COMPLETED' });

    const invalid = await fetch(`${base}/api/v1/imports/nope`, { headers: auth });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).details.fields).toEqual([{ field: 'importBatchId', code: 'INVALID_FORMAT' }]);

    const unknown = await fetch(`${base}/api/v1/imports/${ACCOUNT}`, { headers: auth });
    expect(unknown.status).toBe(404);
  });
});

const ITEM = '9c8b7a6f-5e4d-4c3b-8a29-18f7e6d5c4b3';
const TX = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const item = {
  id: ITEM,
  importBatchId: BATCH,
  mreRealmId: REALM,
  financialAccountId: ACCOUNT,
  adapterId: 'generic-csv',
  adapterVersion: '1',
  sourceStatementKey: 'sha256:abc',
  sourceRowKey: 'pos:2',
  normalizedRow: { bookingDate: '2026-09-01', amount: { amount: '980.00', currency: 'EUR' }, direction: 'INFLOW', position: 2 },
  ambiguityReason: 'AMBIGUOUS_CROSS_FILE_MATCH',
  conflictingTransactionIds: [TX],
  priorReviewItemIds: [],
  status: 'PENDING',
  resolution: null,
  resolvedBy: null,
  resolvedAt: null,
  createdTransactionId: null,
  createdAt: new Date('2026-10-19T08:00:00Z'),
} as unknown as ReviewItem;
const conflicting = {
  id: TX,
  bookingDate: '2026-09-01',
  valueDate: null,
  amount: Money.of('980.00', 'EUR'),
  direction: 'INFLOW',
  description: 'Miete',
  counterpartyNameRaw: 'Max Mieter',
  counterpartyIbanRaw: null,
  externalTransactionId: null,
  importBatchId: '11111111-2222-4333-8444-555555555555',
} as unknown as ConflictingTransaction;

describe('GET /api/v1/imports/{importBatchId}/review-items', () => {
  it('200 with the owned items, each next to the Transactions it conflicts with; the status filter is passed on', async () => {
    const seen: unknown[] = [];
    const base = await start({
      imports: {
        listReviewItems: async (input) => {
          seen.push(input.status);
          return { items: [item], conflicting: [conflicting] };
        },
      },
    });
    const res = await fetch(`${base}/api/v1/imports/${BATCH}/review-items?status=PENDING`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      importBatchId: BATCH,
      items: [
        {
          reviewItemId: ITEM,
          importBatchId: BATCH,
          financialAccountId: ACCOUNT,
          adapterId: 'generic-csv',
          adapterVersion: '1',
          status: 'PENDING',
          ambiguityReason: 'AMBIGUOUS_CROSS_FILE_MATCH',
          normalizedRow: { bookingDate: '2026-09-01', amount: { amount: '980.00', currency: 'EUR' }, direction: 'INFLOW', position: 2 },
          conflictingTransactionIds: [TX],
          conflictingTransactions: [
            {
              transactionId: TX,
              importBatchId: '11111111-2222-4333-8444-555555555555',
              bookingDate: '2026-09-01',
              valueDate: null,
              amount: { amount: '980.00', currency: 'EUR' },
              direction: 'INFLOW',
              counterpartyNameRaw: 'Max Mieter',
              counterpartyIbanRaw: null,
              description: 'Miete',
              externalTransactionId: null,
            },
          ],
          priorReviewItemIds: [],
          resolution: null,
          resolvedByAccountId: null,
          resolvedAt: null,
          createdTransactionId: null,
          createdAt: '2026-10-19T08:00:00.000Z',
        },
      ],
    });
    expect(seen).toEqual(['PENDING']);
  });

  it('400 for a non-UUID or an unknown status; 404 for an unknown batch', async () => {
    const base = await start({
      imports: { listReviewItems: ({ importBatchId }) => Promise.reject(new ImportBatchNotFoundError(importBatchId)) },
    });
    const invalid = await fetch(`${base}/api/v1/imports/nope/review-items?status=OPEN`, { headers: auth });
    expect(invalid.status).toBe(400);
    expect((await errorOf(invalid)).details.fields).toEqual([
      { field: 'importBatchId', code: 'INVALID_FORMAT' },
      { field: 'status', code: 'INVALID_FORMAT' },
    ]);
    expect((await fetch(`${base}/api/v1/imports/${BATCH}/review-items`, { headers: auth })).status).toBe(404);
  });
});

describe('POST /api/v1/imports/{importBatchId}/review-items/{reviewItemId}/resolve', () => {
  const resolveAt = (base: string, body: unknown, batch = BATCH, reviewItem = ITEM) =>
    fetch(`${base}/api/v1/imports/${batch}/review-items/${reviewItem}/resolve`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('200 with the resolved item; a replay is marked', async () => {
    const resolved = {
      ...item,
      status: 'RESOLVED',
      resolution: 'CREATE',
      resolvedBy: 'anna@example.com',
      resolvedAt: new Date('2026-10-19T09:00:00Z'),
      createdTransactionId: TX,
    } as unknown as ReviewItem;
    const seen: unknown[] = [];
    let replayed = false;
    const base = await start({
      imports: {
        resolveReviewItem: async (input) => {
          seen.push(input);
          const result = { item: resolved, replayed };
          replayed = true;
          return result;
        },
      },
    });
    const first = await resolveAt(base, { resolution: 'CREATE' }, BATCH.toUpperCase());
    expect(first.status).toBe(200);
    expect(first.headers.get('idempotent-replayed')).toBeNull();
    expect(await first.json()).toMatchObject({
      reviewItemId: ITEM,
      status: 'RESOLVED',
      resolution: 'CREATE',
      resolvedByAccountId: 'anna@example.com',
      resolvedAt: '2026-10-19T09:00:00.000Z',
      createdTransactionId: TX,
    });
    expect(seen[0]).toMatchObject({ importBatchId: BATCH, reviewItemId: ITEM, resolution: 'CREATE' });
    const again = await resolveAt(base, { resolution: 'CREATE' });
    expect(again.headers.get('idempotent-replayed')).toBe('true');
  });

  it('422 for an invalid or missing resolution, 400 for malformed ids', async () => {
    const base = await start({});
    for (const body of [{ resolution: 'MERGE' }, {}]) {
      const res = await resolveAt(base, body);
      expect(res.status).toBe(422);
      expect((await errorOf(res)).code).toBe('VALIDATION_ERROR');
    }
    expect((await resolveAt(base, { resolution: 'SKIP' }, 'x', 'y')).status).toBe(400);
  });

  it('maps 404 not owned/unknown, 409 resolved differently, 409 account closed', async () => {
    const errors = [
      [new ReviewItemNotFoundError(ITEM), 404, { code: 'NOT_FOUND' }],
      [
        new ReviewResolutionConflictError({ ...item, resolution: 'SKIP' } as ReviewItem),
        409,
        { code: 'CONFLICT', details: { reason: 'ALREADY_RESOLVED', resolution: 'SKIP' } },
      ],
      [new FinancialAccountClosedError(ACCOUNT), 409, { code: 'CONFLICT', details: { reason: 'ACCOUNT_CLOSED' } }],
    ] as const;
    for (const [error, status, body] of errors) {
      const base = await start({ imports: { resolveReviewItem: () => Promise.reject(error) } });
      const res = await resolveAt(base, { resolution: 'CREATE' });
      expect(res.status).toBe(status);
      expect(await errorOf(res)).toMatchObject(body);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });
});
