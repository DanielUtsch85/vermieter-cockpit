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
import type { toDto as toPropertyReferenceDto } from './property-references.js';
import type { z } from 'zod';
import type { split, toDto as toTransactionDto, toSplitDto } from './transaction-dto.js';
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
