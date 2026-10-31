import type { BusinessDate, Money } from '../../shared/index.js';

/**
 * A capitalised item as Depreciation reads it (api-design.md §59B, P8-D11): plain data, filled in
 * `infrastructure/postgres/capitalized-items.ts` from Taxation's derivation (`capitalizedItemsOf`), so Depreciation
 * never imports Taxation. Only a classification moves the basis; Depreciation never changes one.
 */

export const ITEM_SOURCE_TYPES = ['TRANSACTION_SPLIT', 'WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE'] as const;
export type ItemSourceType = (typeof ITEM_SOURCE_TYPES)[number];

/** A source as a link names it: `sourcePosition` for the two WEG sources, `null` for a split (§58B). */
export interface ItemRef {
  readonly sourceType: ItemSourceType;
  readonly sourceId: string;
  readonly sourcePosition: number | null;
}

/** §58C's per-item part: a Party (or `NOT_OWNED`) on the item's share date with its exact share and its cents. */
export interface CapitalizedItemPart {
  /** The Party, or `NOT_OWNED`. */
  readonly participant: string;
  readonly ownershipIds: readonly string[];
  readonly share: { readonly numerator: bigint; readonly denominator: bigint };
  readonly amount: Money;
}

export interface CapitalizedItem extends ItemRef {
  readonly propertyReferenceId: string;
  /** The date that decides the start (booking, withdrawal or use date; P8-D6), and its kind as §55/§58B name it. */
  readonly date: BusinessDate;
  readonly dateSource: string;
  readonly taxYear: number;
  /** The signed `lineAmount` of §58C's `capitalized` (a refund negative), gross. */
  readonly lineAmount: Money;
  /** For the GWG hint of a separate asset only (§59B); never the basis. */
  readonly netAmount: Money | null;
  readonly classificationId: string | null;
  readonly reviewState: string;
  readonly taxCategory: string;
  readonly anschaffungsnaheAcquisitionId: string | null;
  readonly counts: boolean;
  readonly treatment: string | null;
  /** §58C's parts, summing to `lineAmount`; empty for a linked item that is no longer capitalised. */
  readonly parts: readonly CapitalizedItemPart[];
  /** The item's own flags as Taxation gives them (date flags, `ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE`). */
  readonly flags: readonly { readonly code: string; readonly details: Readonly<Record<string, unknown>> }[];
}

export const NOT_OWNED_PART = 'NOT_OWNED';

/** `{sourceType}:{sourceId}` for a split, `{sourceType}:{sourceId}:{sourcePosition}` for a WEG source (§59B). */
export const componentIdOf = (ref: ItemRef) =>
  ref.sourcePosition === null ? `${ref.sourceType}:${ref.sourceId}` : `${ref.sourceType}:${ref.sourceId}:${ref.sourcePosition}`;

export const sameItem = (a: ItemRef, b: ItemRef) => a.sourceType === b.sourceType && a.sourceId === b.sourceId && a.sourcePosition === b.sourcePosition;

/** Whether an item is in a basis at all (§59B): it counts and its current classification is `CAPITALIZED`. */
export const isCapitalized = (item: Pick<CapitalizedItem, 'counts' | 'treatment'>) => item.counts && item.treatment === 'CAPITALIZED';
