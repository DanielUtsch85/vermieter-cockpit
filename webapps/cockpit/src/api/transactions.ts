import type {
  FinancialAccountDto,
  FinancialCategoryDto,
  PageDto,
  PropertyReferenceDto,
  SplitInputDto,
  TransactionDetailDto,
  TransactionDto,
  TransactionSplitDto,
  TransactionSplitsDto,
} from '@vermieter-cockpit/de-backend/client-contract';
import { apiPath, ifMatchForVersion, type DeClient } from './client';
import { ApiError, CLIENT_CODES } from './errors';

export type {
  FinancialAccountDto,
  FinancialCategoryDto,
  PageDto,
  PropertyReferenceDto,
  SplitInputDto,
  TransactionDetailDto,
  TransactionDto,
  TransactionSplitDto,
  TransactionSplitsDto,
};

/**
 * The reads of step 2 (ui-guide.md §6.3, §10): the transaction list and one Transaction, plus the lists that turn ids
 * into names for the filters and the detail (accounts, PropertyReferences, categories; §5.3, §13). The one write is
 * step 3's `PUT …/splits` (`putSplits`, below). No route outside `USED_ROUTES` (gate/backend-pin.ts) is called.
 */

/**
 * Every Realm-bound DTO names its Realm. One that names another Realm than the one asked for is refused, not shown
 * (ui-guide.md §7.3: no data of another context). The backend never sends one; this holds the rule in the client too.
 */
export function checkRealm<T extends { readonly mreRealmId: string }>(realmId: string, items: readonly T[]): readonly T[] {
  if (items.some((item) => item.mreRealmId !== realmId)) {
    throw new ApiError(200, CLIENT_CODES.realmMismatch, 'The answer belongs to another Realm than the one asked for.');
  }
  return items;
}

/** `GET /transactions` with the list's query (list-params.ts: only supported parameters). */
export async function listTransactions(client: DeClient, query: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<PageDto<TransactionDto>> {
  const { data } = await client.get<PageDto<TransactionDto>>('/transactions', { query, ...(signal === undefined ? {} : { signal }) });
  checkRealm(client.realmId, data.items);
  return data;
}

export interface TransactionRead {
  readonly transaction: TransactionDetailDto;
  /** The `ETag` read with it: the version a later change sends as `If-Match` (ui-guide.md §7.3, step 3). */
  readonly etag: string | undefined;
}

/** `GET /transactions/{transactionId}`: the Transaction with its splits and its `ETag` (§30.1). */
export async function getTransaction(client: DeClient, transactionId: string, signal?: AbortSignal): Promise<TransactionRead> {
  const { data, etag } = await client.get<TransactionDetailDto>(apiPath`/transactions/${transactionId}`, signal === undefined ? {} : { signal });
  checkRealm(client.realmId, [data]);
  return { transaction: data, etag };
}

/**
 * Lists for choosing and naming: the first page at the largest page size (200). A Realm of a private landlord holds a
 * handful of accounts and objects (api-design.md §29.3); when there are more, the page says so (`total`), it does not
 * load every page (ui-guide.md §3.3).
 */
export const PICKER_PAGE_SIZE = 200;
const pickerQuery = { page: 1, pageSize: PICKER_PAGE_SIZE };

export async function listFinancialAccounts(client: DeClient, signal?: AbortSignal): Promise<PageDto<FinancialAccountDto>> {
  const { data } = await client.get<PageDto<FinancialAccountDto>>('/financial-accounts', { query: pickerQuery, ...(signal === undefined ? {} : { signal }) });
  checkRealm(client.realmId, data.items);
  return data;
}

export async function listPropertyReferences(client: DeClient, signal?: AbortSignal): Promise<PageDto<PropertyReferenceDto>> {
  const { data } = await client.get<PageDto<PropertyReferenceDto>>('/property-references', {
    query: pickerQuery,
    ...(signal === undefined ? {} : { signal }),
  });
  checkRealm(client.realmId, data.items);
  return data;
}

/** `GET /financial-categories` (§36): the seeded catalogue, the same for every Realm, no query parameter. */
export async function listFinancialCategories(client: DeClient, signal?: AbortSignal): Promise<readonly FinancialCategoryDto[]> {
  const { data } = await client.get<{ items: readonly FinancialCategoryDto[] }>('/financial-categories', signal === undefined ? {} : { signal });
  return data.items;
}

export interface SplitsSaved {
  readonly result: TransactionSplitsDto;
  /** The new `ETag`: the version the next change sends as `If-Match` (ui-guide.md §8: the newly returned one). */
  readonly etag: string;
}

/**
 * `PUT /transactions/{transactionId}/splits` (api-design.md §33, step 3): replaces the whole split set, with `If-Match`
 * carrying the `ETag` read before (§16.1). No `Idempotency-Key`: the route takes none; it is naturally idempotent, and
 * the same set sent again after a lost answer is a `200` without a new version, whatever the version (§16.1 "Order").
 * The answer names its Transaction; an answer for another one is refused, never shown.
 */
export async function putSplits(
  client: DeClient,
  transactionId: string,
  body: { readonly splits: readonly SplitInputDto[] },
  ifMatch: string,
  signal?: AbortSignal,
): Promise<SplitsSaved> {
  const { data, etag } = await client.put<TransactionSplitsDto>(apiPath`/transactions/${transactionId}/splits`, {
    body,
    ifMatch,
    ...(signal === undefined ? {} : { signal }),
  });
  if (data.transactionId.toLowerCase() !== transactionId.toLowerCase()) {
    throw new ApiError(200, CLIENT_CODES.unexpected, 'The answer names another Transaction than the one changed.');
  }
  return { result: data, etag: etag ?? ifMatchForVersion(data.version) };
}
