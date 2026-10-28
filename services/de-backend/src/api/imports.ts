import busboy from 'busboy';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import {
  type ConflictingTransaction,
  type GetImportBatch,
  type ImportBankStatement,
  type ImportBatch,
  type ListReviewItems,
  type ResolveReviewItem,
  type ReviewItem,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { sendError } from './errors.js';
import { RESOURCE_ID, fieldErrors, sendValidationError } from './validation.js';

/** Upper bound of an uploaded statement, enforced while streaming, before any parsing. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
/** Boundaries and part headers of a two-part upload, generously. */
const MULTIPART_OVERHEAD_BYTES = 16 * 1024;

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

const listQuery = z.object({ status: z.enum(['PENDING', 'RESOLVED']).optional() });
const resolveBody = z.object({ resolution: z.enum(['CREATE', 'SKIP']) });

export interface ImportCommands {
  readonly importStatement: ImportBankStatement;
  readonly getBatch: GetImportBatch;
  readonly listReviewItems: ListReviewItems;
  readonly resolveReviewItem: ResolveReviewItem;
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
          // The rest of the body is not read: end the connection instead of draining it.
          res.setHeader('Connection', 'close');
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
            principal: principalOf(res),
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
      .catch(next);
  });

  router.get('/imports/:importBatchId', (req, res, next) => {
    const id = req.params['importBatchId'] ?? '';
    if (!RESOURCE_ID.test(id)) {
      sendValidationError(res, [{ field: 'importBatchId', code: 'INVALID_FORMAT' }]);
      return;
    }
    commands
      .getBatch({
        principal: principalOf(res),
        importBatchId: id.toLowerCase(),
      })
      .then((batch) => {
        res.json(toDto(batch));
      })
      .catch(next);
  });

  router.get('/imports/:importBatchId/review-items', (req, res, next) => {
    const id = req.params['importBatchId'] ?? '';
    const query = listQuery.safeParse(req.query);
    if (!RESOURCE_ID.test(id) || !query.success) {
      sendValidationError(res, [
        ...(RESOURCE_ID.test(id) ? [] : [{ field: 'importBatchId', code: 'INVALID_FORMAT' }]),
        ...(query.success ? [] : fieldErrors(query.error)),
      ]);
      return;
    }
    commands
      .listReviewItems({
        principal: principalOf(res),
        importBatchId: id.toLowerCase(),
        ...(query.data.status === undefined ? {} : { status: query.data.status }),
      })
      .then(({ items, conflicting }) => {
        const byId = new Map(conflicting.map((t) => [t.id, t]));
        res.json({ importBatchId: id.toLowerCase(), items: items.map((item) => toItemDto(item, byId)) });
      })
      .catch(next);
  });

  router.post('/imports/:importBatchId/review-items/:reviewItemId/resolve', express.json({ limit: '1kb' }), (req, res, next) => {
    const batchId = req.params['importBatchId'] ?? '';
    const itemId = req.params['reviewItemId'] ?? '';
    const ids = [
      ...(RESOURCE_ID.test(batchId) ? [] : [{ field: 'importBatchId', code: 'INVALID_FORMAT' }]),
      ...(RESOURCE_ID.test(itemId) ? [] : [{ field: 'reviewItemId', code: 'INVALID_FORMAT' }]),
    ];
    if (ids.length > 0) {
      sendValidationError(res, ids);
      return;
    }
    const body = resolveBody.safeParse(req.body);
    if (!body.success) {
      // An invalid resolution value is a validation issue of the request content (api-design.md §32.2 → 422).
      sendError(res, 422, 'VALIDATION_ERROR', 'Validation failed.', { fields: fieldErrors(body.error) });
      return;
    }
    commands
      .resolveReviewItem({
        principal: principalOf(res),
        importBatchId: batchId.toLowerCase(),
        reviewItemId: itemId.toLowerCase(),
        resolution: body.data.resolution,
      })
      .then(({ item, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.json(toItemDto(item, new Map()));
      })
      .catch(next);
  });

  return router;
}

/**
 * Reads the multipart body: one `metadata` field and one `file` part. The file
 * is capped while streaming, so an oversized upload is never held in memory.
 */
function readUpload(req: Request): Promise<Upload> {
  return new Promise((resolve) => {
    // A declared length beyond file + metadata + multipart framing is refused before reading anything.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_IMPORT_FILE_BYTES + MAX_METADATA_BYTES + MULTIPART_OVERHEAD_BYTES) {
      resolve({ kind: 'TOO_LARGE' });
      return;
    }
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
      stream.on('limit', () => {
        // Stop at the limit; reading on would only hold the connection for bytes we discard.
        req.unpipe(parser);
        resolve({ kind: 'TOO_LARGE' });
      });
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

function toItemDto(item: ReviewItem, transactions: ReadonlyMap<string, ConflictingTransaction>) {
  return {
    reviewItemId: item.id,
    importBatchId: item.importBatchId,
    financialAccountId: item.financialAccountId,
    adapterId: item.adapterId,
    adapterVersion: item.adapterVersion,
    status: item.status,
    ambiguityReason: item.ambiguityReason,
    normalizedRow: item.normalizedRow,
    conflictingTransactionIds: item.conflictingTransactionIds,
    // The other side of the decision, next to the row (only in the list).
    ...(transactions.size === 0
      ? {}
      : {
          conflictingTransactions: item.conflictingTransactionIds.flatMap((id) => {
            const t = transactions.get(id);
            return t === undefined ? [] : [toConflictDto(t)];
          }),
        }),
    priorReviewItemIds: item.priorReviewItemIds,
    resolution: item.resolution,
    resolvedByAccountId: item.resolvedBy,
    resolvedAt: item.resolvedAt?.toISOString() ?? null,
    createdTransactionId: item.createdTransactionId,
    createdAt: item.createdAt.toISOString(),
  };
}

function toConflictDto(t: ConflictingTransaction) {
  return {
    transactionId: t.id,
    importBatchId: t.importBatchId,
    bookingDate: t.bookingDate,
    valueDate: t.valueDate,
    amount: t.amount.toJSON(),
    direction: t.direction,
    counterpartyNameRaw: t.counterpartyNameRaw,
    counterpartyIbanRaw: t.counterpartyIbanRaw,
    description: t.description,
    externalTransactionId: t.externalTransactionId,
  };
}
