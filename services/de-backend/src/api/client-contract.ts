/**
 * The types a DE client (`webapps/cockpit`) takes from the backend (ui-guide.md §7.1, technology.md §7.1: the DTO
 * types come from the backend's schemas, so the API has one source of truth). Exported to the workspace as
 * `@vermieter-cockpit/de-backend/client-contract` (package.json `exports`, `types` only).
 *
 * Types only, never a value: `export type` is erased at compile time, so nothing of the backend reaches a browser
 * bundle and this file changes no behaviour. A type is added here when a client slice first uses it.
 */
import type { toDto as toFinancialAccountDto } from './financial-accounts.js';
import type { toDto as toFinancialCategoryDto } from './financial-categories.js';
import type { metadataSchema, resolveBody, toConflictDto, toDto as toImportBatchDto, toItemDto } from './imports.js';
import type { toDto as toPropertyReferenceDto } from './property-references.js';
import type { z } from 'zod';
import type { correctBody, split, toDto as toTransactionDto, toSplitDto } from './transaction-dto.js';
import type { toSplitsDto } from './transaction-splits.js';

export type { FieldError } from './validation.js';

/**
 * A DTO as it arrives as JSON. The backend brands some strings (ids, business dates) for its own type checks; on the
 * wire they are plain strings, so a client reads them as `string`. Literal unions (`'INFLOW' | 'OUTFLOW'`) stay.
 */
export type Wire<T> = T extends { readonly __brand: unknown }
  ? string
  : T extends readonly (infer E)[]
    ? readonly Wire<E>[]
    : T extends object
      ? { readonly [K in keyof T]: Wire<T[K]> }
      : T;

/** A page of a list (api-design.md §11, §41.1). */
export interface PageDto<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** `GET /transactions` items and `GET /transactions/{id}` without `splits` (api-design.md §30.1, §31.2). */
export type TransactionDto = Wire<ReturnType<typeof toTransactionDto>>;
/** One split of `GET /transactions/{id}` (api-design.md §33.2), in position order. */
export type TransactionSplitDto = Wire<ReturnType<typeof toSplitDto>>;
/** `GET /transactions/{id}` (api-design.md §30.1). */
export type TransactionDetailDto = TransactionDto & { readonly splits: readonly TransactionSplitDto[] };
/** `GET /financial-accounts` items (api-design.md §29.3). */
export type FinancialAccountDto = Wire<ReturnType<typeof toFinancialAccountDto>>;
/** `GET /property-references` items (api-design.md §23.3). */
export type PropertyReferenceDto = Wire<ReturnType<typeof toPropertyReferenceDto>>;
/** `GET /financial-categories` items (api-design.md §36). */
export type FinancialCategoryDto = Wire<ReturnType<typeof toFinancialCategoryDto>>;
/** One split of the `PUT /transactions/{id}/splits` request, as the backend's schema reads it (api-design.md §33.2). */
export type SplitInputDto = z.input<typeof split>;
/** The answer of `PUT /transactions/{id}/splits` (api-design.md §33.2); its `ETag` is the next `If-Match`. */
export type TransactionSplitsDto = Wire<ReturnType<typeof toSplitsDto>>;
/** The request of `POST /transactions/{id}/correct` (api-design.md §35.2), as the backend's schema reads it. */
export type CorrectInputDto = z.input<typeof correctBody>;
/**
 * The `201` answer of `POST /transactions/{id}/correct` (api-design.md §35.1, §35.4; `transaction-lifecycle.ts`): the
 * original (now `CORRECTED`), its reversal and its replacement, each as `toDto` maps it and with its own `version`; no
 * `ETag`. `replacement` is `null` only for `…/reverse` (§35.9), which shares the route's answer shape.
 */
export interface CorrectionResultDto {
  readonly original: TransactionDto;
  readonly reversal: TransactionDto;
  readonly replacement: TransactionDto | null;
}

/** The `201` answer of `POST /imports/bank-transactions` and the answer of `GET /imports/{id}` (api-design.md §32.1a). */
export type ImportBatchDto = Wire<ReturnType<typeof toImportBatchDto>>;
/** One row result of a batch (`created`, `duplicate`, `needs_review`, `error`, `skipped`; api-design.md §32.1, §32.1a). */
export type ImportRowDto = ImportBatchDto['rows'][number];
/** A review item as `GET /imports/{id}/review-items` lists it and `…/resolve` answers it (api-design.md §32.3a). */
export type ReviewItemDto = Wire<ReturnType<typeof toItemDto>>;
/** A Transaction a review item may duplicate, listed next to the row (api-design.md §32.3a). */
export type ConflictingTransactionDto = Wire<ReturnType<typeof toConflictDto>>;
/** The request of `POST /imports/{importBatchId}/review-items/{reviewItemId}/resolve` (api-design.md §32.2). */
export type ResolveInputDto = z.input<typeof resolveBody>;
/** The fixed part of the upload's `metadata` part (api-design.md §32.1a); the adapter's options sit at the same level. */
export type ImportMetadataDto = Pick<z.input<typeof metadataSchema>, 'financialAccountId' | 'adapterId' | 'adapterVersion'>;
