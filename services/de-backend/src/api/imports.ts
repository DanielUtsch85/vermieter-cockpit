import busboy from 'busboy';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import {
  FinancialAccountNotFoundError,
  ImportBatchNotFoundError,
  ImportFileError,
  UnsupportedAdapterError,
  type GetImportBatch,
  type ImportBankStatement,
  type ImportBatch,
  type RealmPrincipal,
} from '../application/index.js';
import { sendError } from './errors.js';
import { RESOURCE_ID, fieldErrors, sendValidationError } from './validation.js';

/** Upper bound of an uploaded statement, enforced while streaming, before any parsing. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;

/**
 * The `metadata` part: the import target and adapter, plus the adapter's own
 * options (e.g. `columnMapping`) at the same level (api-design.md §32.1).
 */
const metadataSchema = z
  .object({
    financialAccountId: z.string().regex(RESOURCE_ID),
    adapterId: z.string().min(1).max(100),
    adapterVersion: z.string().min(1).max(20),
  })
  .passthrough();

export interface ImportCommands {
  readonly importStatement: ImportBankStatement;
  readonly getBatch: GetImportBatch;
}

type Upload =
  | {
      readonly kind: 'OK';
      readonly metadata: string | undefined;
      readonly file: Buffer | undefined;
      readonly filename: string | null;
    }
  | { readonly kind: 'TOO_LARGE' }
  | { readonly kind: 'INVALID'; readonly message: string };

/** Bank Import API (api-design.md §32). */
export function importRoutes(commands: ImportCommands): Router {
  const router = express.Router();

  router.post('/imports/bank-transactions', (req, res, next) => {
    readUpload(req)
      .then((upload) => {
        if (upload.kind === 'TOO_LARGE') {
          sendError(res, 413, 'VALIDATION_ERROR', 'The uploaded file is too large.', { maxBytes: MAX_IMPORT_FILE_BYTES });
          return undefined;
        }
        if (upload.kind === 'INVALID') {
          sendError(res, 400, 'VALIDATION_ERROR', upload.message);
          return undefined;
        }
        const missing = [
          ...(upload.metadata === undefined ? [{ field: 'metadata', code: 'REQUIRED' }] : []),
          ...(upload.file === undefined ? [{ field: 'file', code: 'REQUIRED' }] : []),
        ];
        if (missing.length > 0 || upload.metadata === undefined || upload.file === undefined) {
          sendValidationError(res, missing);
          return undefined;
        }
        let json: unknown;
        try {
          json = JSON.parse(upload.metadata);
        } catch {
          sendValidationError(res, [{ field: 'metadata', code: 'INVALID_FORMAT' }]);
          return undefined;
        }
        const parsed = metadataSchema.safeParse(json);
        if (!parsed.success) {
          sendValidationError(res, fieldErrors(parsed.error));
          return undefined;
        }
        const { financialAccountId, adapterId, adapterVersion, ...options } = parsed.data;
        return commands
          .importStatement({
            principal: res.locals['principal'] as RealmPrincipal,
            financialAccountId: financialAccountId.toLowerCase(),
            adapterId,
            adapterVersion,
            options,
            file: upload.file,
            sourceFilename: upload.filename,
          })
          .then((batch) => {
            res.status(201).json(toDto(batch));
          });
      })
      .catch((error: unknown) => {
        if (error instanceof FinancialAccountNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'FinancialAccount not found.', {
            financialAccountId: error.financialAccountId,
          });
        } else if (error instanceof UnsupportedAdapterError) {
          sendValidationError(res, [{ field: 'adapterId', code: 'NOT_SUPPORTED' }]);
        } else if (error instanceof ImportFileError) {
          sendError(res, 400, 'IMPORT_ERROR', error.error.message, {
            reason: error.error.code,
          });
        } else {
          next(error);
        }
      });
  });

  router.get('/imports/:importBatchId', (req, res, next) => {
    const id = req.params['importBatchId'] ?? '';
    if (!RESOURCE_ID.test(id)) {
      sendValidationError(res, [{ field: 'importBatchId', code: 'INVALID_FORMAT' }]);
      return;
    }
    commands
      .getBatch({
        principal: res.locals['principal'] as RealmPrincipal,
        importBatchId: id.toLowerCase(),
      })
      .then((batch) => {
        res.json(toDto(batch));
      })
      .catch((error: unknown) => {
        if (error instanceof ImportBatchNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'ImportBatch not found.', {
            importBatchId: error.importBatchId,
          });
        } else {
          next(error);
        }
      });
  });

  return router;
}

/**
 * Reads the multipart body: one `metadata` field and one `file` part. The file
 * is capped while streaming, so an oversized upload is never held in memory.
 */
function readUpload(req: Request): Promise<Upload> {
  return new Promise((resolve) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        // busboy reports `partsLimit` once the count reaches the limit, so 3 flags a third part.
        limits: {
          files: 1,
          fields: 1,
          parts: 3,
          fileSize: MAX_IMPORT_FILE_BYTES,
          fieldSize: MAX_METADATA_BYTES,
        },
      });
    } catch {
      resolve({
        kind: 'INVALID',
        message: 'Expected a multipart/form-data upload.',
      });
      return;
    }
    let metadata: string | undefined;
    let file: Buffer | undefined;
    let filename: string | null = null;
    let failure: Upload | undefined;
    const fail = (upload: Upload) => {
      failure ??= upload;
    };

    parser.on('field', (name, value, info) => {
      if (name !== 'metadata') fail({ kind: 'INVALID', message: `Unexpected part "${name}".` });
      else if (info.valueTruncated) fail({ kind: 'INVALID', message: 'The metadata part is too large.' });
      else metadata = value;
    });
    parser.on('file', (name, stream, info) => {
      if (name !== 'file') {
        fail({ kind: 'INVALID', message: `Unexpected part "${name}".` });
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('limit', () => fail({ kind: 'TOO_LARGE' }));
      stream.on('close', () => {
        file = Buffer.concat(chunks);
        filename = info.filename ? info.filename.slice(0, 255) : null;
      });
    });
    const limited = () =>
      fail({
        kind: 'INVALID',
        message: 'Expected exactly one metadata part and one file part.',
      });
    parser.on('partsLimit', limited);
    parser.on('filesLimit', limited);
    parser.on('fieldsLimit', limited);
    parser.on('error', () => {
      fail({ kind: 'INVALID', message: 'Malformed multipart body.' });
      resolve(failure as Upload);
    });
    parser.on('close', () => {
      resolve(failure ?? { kind: 'OK', metadata, file, filename });
    });
    req.pipe(parser);
  });
}

function toDto(batch: ImportBatch) {
  return {
    importBatchId: batch.id,
    mreRealmId: batch.mreRealmId,
    financialAccountId: batch.financialAccountId,
    adapterId: batch.adapterId,
    adapterVersion: batch.adapterVersion,
    sourceFilename: batch.sourceFilename,
    contentHash: batch.contentHash,
    status: batch.status,
    transactionCount: batch.transactionCount,
    duplicateCount: batch.duplicateCount,
    needsReviewCount: batch.needsReviewCount,
    errorCount: batch.errorCount,
    skippedCount: batch.skippedCount,
    importedAt: batch.importedAt.toISOString(),
    importedBy: batch.importedBy,
    rows: batch.rows,
  };
}
