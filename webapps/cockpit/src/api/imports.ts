import type { ConflictingTransactionDto, ImportBatchDto, ImportRowDto, ResolveInputDto, ReviewItemDto } from '@vermieter-cockpit/de-backend/client-contract';
import { importForm, type ImportUpload } from '../imports/import-config';
import { apiPath, type DeClient } from './client';
import { ApiError, CLIENT_CODES } from './errors';
import { checkRealm } from './transactions';

export type { ConflictingTransactionDto, ImportBatchDto, ImportRowDto, ResolveInputDto, ReviewItemDto };

/**
 * Step 5 of the first slice (ui-guide.md §6.5, §10): the bank import and its review items (api-design.md §32). No
 * `Idempotency-Key`: the import is deduplicated by the identity of its file and rows, the resolve by the review item
 * (§7.3: the header is not glued to every route). No route outside `USED_ROUTES` (gate/backend-pin.ts) is called.
 */

const same = (a: string | null | undefined, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

function unexpected(message: string): ApiError {
  return new ApiError(200, CLIENT_CODES.unexpected, message);
}

/** A batch belongs to the Realm asked for and is the one asked for; anything else is refused, never shown. */
function checkBatch(client: DeClient, batch: ImportBatchDto, importBatchId?: string): ImportBatchDto {
  checkRealm(client.realmId, [batch]);
  if (importBatchId !== undefined && !same(batch.importBatchId, importBatchId)) throw unexpected('The answer names another ImportBatch.');
  return batch;
}

/**
 * `POST /imports/bank-transactions` (api-design.md §32.1a): `multipart/form-data` with exactly the `metadata` and the
 * `file` part of the upload, the boundary set by the browser. The answer is the batch of this Realm, for the account
 * and adapter sent; anything else is refused. No answer is an error with status 0: whether the file was imported is
 * unknown, and the caller offers the same upload again (ui-guide.md §6.5).
 */
export async function importBankTransactions(client: DeClient, upload: ImportUpload, signal?: AbortSignal): Promise<ImportBatchDto> {
  const { data } = await client.post<ImportBatchDto>('/imports/bank-transactions', {
    form: importForm(upload),
    ...(signal === undefined ? {} : { signal }),
  });
  checkBatch(client, data);
  const { sent } = upload;
  if (!same(data.financialAccountId, sent.financialAccountId) || data.adapterId !== sent.adapterId || data.adapterVersion !== sent.adapterVersion) {
    throw unexpected('The answer names another account or adapter than the one sent.');
  }
  return data;
}

/** `GET /imports/{importBatchId}` (api-design.md §32.1a): the batch again, as stored. */
export async function getImportBatch(client: DeClient, importBatchId: string, signal?: AbortSignal): Promise<ImportBatchDto> {
  const { data } = await client.get<ImportBatchDto>(apiPath`/imports/${importBatchId}`, signal === undefined ? {} : { signal });
  return checkBatch(client, data, importBatchId);
}

/**
 * `GET /imports/{importBatchId}/review-items` (api-design.md §32.3a): the items **owned by** the batch, all statuses.
 * Review items name no Realm; they are accepted only as items of the batch read for this Realm: its id and its account.
 * An item of another batch or account is refused as an answer of another context, never shown (ui-guide.md §7.3).
 */
export async function listReviewItems(client: DeClient, batch: ImportBatchDto, signal?: AbortSignal): Promise<readonly ReviewItemDto[]> {
  const { data } = await client.get<{ importBatchId: string; items: readonly ReviewItemDto[] }>(
    apiPath`/imports/${batch.importBatchId}/review-items`,
    signal === undefined ? {} : { signal },
  );
  if (!same(data.importBatchId, batch.importBatchId) || data.items.some((item) => !same(item.importBatchId, batch.importBatchId))) {
    throw unexpected('The answer lists review items of another ImportBatch.');
  }
  if (data.items.some((item) => !same(item.financialAccountId, batch.financialAccountId))) {
    throw new ApiError(200, CLIENT_CODES.realmMismatch, 'A review item belongs to another account than its batch.');
  }
  return data.items;
}

/**
 * `POST /imports/{importBatchId}/review-items/{reviewItemId}/resolve` (api-design.md §32.2, §32.3a) with
 * `{ resolution }`. The path is the item's **owning** batch, as the item names it, never the batch that merely referenced
 * it (§6.5). The same resolution again is a `200` no-op, so a retry after a lost answer sends the same request. The
 * answer must be this item, resolved as asked, in the same batch and account; anything else is refused.
 */
export async function resolveReviewItem(
  client: DeClient,
  item: Pick<ReviewItemDto, 'reviewItemId' | 'importBatchId' | 'financialAccountId'>,
  resolution: ResolveInputDto['resolution'],
  signal?: AbortSignal,
): Promise<ReviewItemDto> {
  const body: ResolveInputDto = { resolution };
  const { data } = await client.post<ReviewItemDto>(apiPath`/imports/${item.importBatchId}/review-items/${item.reviewItemId}/resolve`, {
    body,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!same(data.reviewItemId, item.reviewItemId) || !same(data.importBatchId, item.importBatchId)) {
    throw unexpected('The answer names another review item.');
  }
  if (!same(data.financialAccountId, item.financialAccountId)) throw new ApiError(200, CLIENT_CODES.realmMismatch, 'The answer belongs to another account.');
  if (data.status !== 'RESOLVED' || data.resolution !== resolution) throw unexpected('The answer is not the resolution sent.');
  return data;
}
