import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FinancialAccountNotFoundError,
  ImportBatchNotFoundError,
  ImportFileError,
  UnsupportedAdapterError,
  type GetImportBatch,
  type ImportBankStatement,
  type ImportBankStatementInput,
  type ImportBatch,
  type PrincipalVerifier,
} from '../application/index.js';
import { createApp } from './app.js';
import { unusedCommands } from './app.test-support.js';
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

async function start(commands: { importStatement?: ImportBankStatement; getBatch?: GetImportBatch }): Promise<string> {
  server = createApp({
    isReady: async () => true,
    verifyPrincipal: admin,
    ...unusedCommands,
    ...(commands.importStatement === undefined ? {} : { importBankStatement: commands.importStatement }),
    ...(commands.getBatch === undefined ? {} : { getImportBatch: commands.getBatch }),
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
      importStatement: async (input) => {
        seen.push(input);
        return batch;
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
    const base = await start({ importStatement: async () => batch });
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
      importStatement: async () => {
        called = true;
        return batch;
      },
    });
    const res = await upload(base, form({ metadata, file: new Uint8Array(MAX_IMPORT_FILE_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toMatchObject({ code: 'VALIDATION_ERROR', details: { maxBytes: MAX_IMPORT_FILE_BYTES } });
    expect(called).toBe(false);
  });

  it('maps use-case errors: 404 account, 400 adapter, 400 IMPORT_ERROR with the file-level reason', async () => {
    const errors = [
      [new FinancialAccountNotFoundError(ACCOUNT), 404, { code: 'NOT_FOUND', details: { financialAccountId: ACCOUNT } }],
      [
        new UnsupportedAdapterError('mt940', '1'),
        400,
        { code: 'VALIDATION_ERROR', details: { fields: [{ field: 'adapterId', code: 'NOT_SUPPORTED' }] } },
      ],
      [
        new ImportFileError({ code: 'MISSING_COLUMN', message: 'Column "Betrag" not found' }),
        400,
        { code: 'IMPORT_ERROR', message: 'Column "Betrag" not found', details: { reason: 'MISSING_COLUMN' } },
      ],
    ] as const;
    for (const [error, status, body] of errors) {
      const base = await start({ importStatement: () => Promise.reject(error) });
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
      getBatch: async ({ importBatchId, principal }) => {
        if (importBatchId === BATCH && principal.mreRealmId === REALM) return batch;
        throw new ImportBatchNotFoundError(importBatchId);
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
