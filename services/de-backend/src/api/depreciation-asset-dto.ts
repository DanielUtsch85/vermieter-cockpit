import { z } from 'zod';
import {
  AMEND_REVIEW_STATES,
  ASSET_REVIEW_STATES,
  ASSET_STATUSES,
  COMPLETION_YEAR_MAX,
  COMPLETION_YEAR_MIN,
  CONFIRM_REVIEW_STATES,
  CONSIDERATIONS,
  DEPRECIATION_METHODS,
  ITEM_SOURCE_TYPES,
  MAX_ASSET_ITEMS,
  MAX_ASSET_SOURCE_REFERENCES,
  MAX_PURCHASE_METHODS,
  MAX_SHORTER_USEFUL_LIVES,
  PURCHASE_METHODS,
  SPECIAL_DEPRECIATIONS,
  USEFUL_LIFE_MAX_YEARS,
  USEFUL_LIFE_MIN_YEARS,
  type ItemRef,
  type PurchaseMethodAmendment,
  type UsefulLifeAmendment,
} from '../application/index.js';
import { businessDate, optionalText } from './acquisitions.js';
import { RESOURCE_ID, integerIn } from './validation.js';

/** The DepreciationAsset API's request schemas and their mapping to the commands, shared by its route files (api-design.md §59–§59B). */

const uuid = z
  .string()
  .regex(RESOURCE_ID)
  .transform((id) => id.toLowerCase());

const issue = (ctx: z.RefinementCtx, path: (string | number)[], code: string) => ctx.addIssue({ code: 'custom', path, params: { code } });
const given = (value: unknown) => value !== undefined && value !== null;

/** A review state of data-model §6.7 that this command takes; another known one (or `SUGGESTED`) is `NOT_ALLOWED`. */
const reviewStateOf = <T extends string>(allowed: readonly T[]) =>
  z.string().transform((value, ctx) => {
    if ((allowed as readonly string[]).includes(value)) return value as T;
    const known = value === 'SUGGESTED' || (ASSET_REVIEW_STATES as readonly string[]).includes(value);
    ctx.addIssue({ code: 'custom', params: { code: known ? 'NOT_ALLOWED' : 'INVALID_FORMAT' } });
    return z.NEVER;
  });

const completionYear = integerIn(COMPLETION_YEAR_MIN, COMPLETION_YEAR_MAX);
/** Trimmed; an empty one is absent (§49.1). */
const sourceReferences = z.array(optionalText(500)).max(MAX_ASSET_SOURCE_REFERENCES);
export const references = (values: readonly (string | null)[] | null | undefined) =>
  (values ?? []).filter((reference): reference is string => reference !== null);

/** `documentId` waits for documents (§33.2): `NOT_SUPPORTED`. */
const evidence = z
  .object({ source: z.string().trim().min(1).max(500), date: businessDate, documentReference: optionalText(500).nullish(), documentId: z.unknown().optional() })
  .strict()
  .superRefine((value, ctx) => {
    if (value.documentId !== undefined) issue(ctx, ['documentId'], 'NOT_SUPPORTED');
  });

const entry = z
  .object({
    acquisitionId: uuid,
    usefulLifeYears: integerIn(1, 99),
    evidence,
    reviewState: reviewStateOf(ASSET_REVIEW_STATES).optional(),
    advisorPartyId: uuid.nullish(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (given(value.advisorPartyId) && value.reviewState !== 'ADVISOR_CONFIRMED') issue(ctx, ['advisorPartyId'], 'NOT_ALLOWED');
  });

/** At most one entry per Acquisition (`DUPLICATE`), at most 20 (`OUT_OF_RANGE`). */
const entries = z.array(entry).superRefine((list, ctx) => {
  if (list.length > MAX_SHORTER_USEFUL_LIVES) issue(ctx, [], 'OUT_OF_RANGE');
  const seen = new Set<unknown>();
  list.forEach((e, index) => {
    // Refinements run even after an entry failed to parse: only compare ids that parsed.
    if (typeof e?.acquisitionId !== 'string') return;
    if (seen.has(e.acquisitionId)) issue(ctx, [index, 'acquisitionId'], 'DUPLICATE');
    seen.add(e.acquisitionId);
  });
});

/**
 * §59C: a purchase's method entry. Every fact is required (a missing one `REQUIRED`, an unknown value `INVALID_FORMAT`);
 * the special depreciations each once (`DUPLICATE`); the note exactly with `otherSpecialCase` (`REQUIRED`, else
 * `NOT_ALLOWED`); the review state and advisor as a shorter life's entry.
 */
const purchaseMethod = z
  .object({
    acquisitionId: uuid,
    consideration: z.enum(CONSIDERATIONS),
    method: z.enum(PURCHASE_METHODS),
    specialDepreciation: z.array(z.enum(SPECIAL_DEPRECIATIONS)).superRefine((list, ctx) => {
      list.forEach((value, index) => {
        if (list.indexOf(value) !== index) issue(ctx, [index], 'DUPLICATE');
      });
    }),
    subsidiesReceived: z.boolean(),
    newBuildingByConversion: z.boolean(),
    otherSpecialCase: z.boolean(),
    otherSpecialCaseNote: optionalText(500).nullish(),
    evidence,
    reviewState: reviewStateOf(ASSET_REVIEW_STATES).optional(),
    advisorPartyId: uuid.nullish(),
    notes: optionalText(2000).nullish(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (given(value.advisorPartyId) && value.reviewState !== 'ADVISOR_CONFIRMED') issue(ctx, ['advisorPartyId'], 'NOT_ALLOWED');
    if (value.otherSpecialCase === true && !given(value.otherSpecialCaseNote)) issue(ctx, ['otherSpecialCaseNote'], 'REQUIRED');
    if (value.otherSpecialCase !== true && given(value.otherSpecialCaseNote)) issue(ctx, ['otherSpecialCaseNote'], 'NOT_ALLOWED');
  });

/** At most one entry per Acquisition (`DUPLICATE`), at most 20 (`OUT_OF_RANGE`), as the shorter lives. */
const purchaseMethods = z.array(purchaseMethod).superRefine((list, ctx) => {
  if (list.length > MAX_PURCHASE_METHODS) issue(ctx, [], 'OUT_OF_RANGE');
  const seen = new Set<unknown>();
  list.forEach((e, index) => {
    if (typeof e?.acquisitionId !== 'string') return;
    if (seen.has(e.acquisitionId)) issue(ctx, [index, 'acquisitionId'], 'DUPLICATE');
    seen.add(e.acquisitionId);
  });
});

const assetType = z.string().transform((value, ctx) => {
  if (value === 'BUILDING' || value === 'SEPARATE_ASSET') return value;
  ctx.addIssue({ code: 'custom', params: { code: 'INVALID_FORMAT' } });
  return z.NEVER;
});

/** §59B: a separate asset's description (1–200) and the basis of its useful life (1–500), trimmed. */
const description = z.string().trim().min(1).max(200);
const usefulLifeBasis = z.string().trim().min(1).max(500);
const usefulLifeYears = integerIn(USEFUL_LIFE_MIN_YEARS, USEFUL_LIFE_MAX_YEARS);

/** A source as §58B names it; a deposit closing is never a capitalised item (`NOT_ALLOWED`). */
const itemSourceType = z.string().transform((value, ctx) => {
  if ((ITEM_SOURCE_TYPES as readonly string[]).includes(value)) return value as ItemRef['sourceType'];
  ctx.addIssue({ code: 'custom', params: { code: value === 'DEPOSIT_CLOSING' ? 'NOT_ALLOWED' : 'INVALID_FORMAT' } });
  return z.NEVER;
});
const item = z
  .object({ sourceType: itemSourceType, sourceId: uuid, sourcePosition: z.number().int().nullish() })
  .strict()
  .superRefine((value, ctx) => {
    // Refinements run even after the source type failed to parse: the position is judged only against a valid one.
    if (!(ITEM_SOURCE_TYPES as readonly unknown[]).includes(value.sourceType)) return;
    const split = value.sourceType === 'TRANSACTION_SPLIT';
    if (split && given(value.sourcePosition)) issue(ctx, ['sourcePosition'], 'NOT_ALLOWED');
    if (!split && !given(value.sourcePosition)) issue(ctx, ['sourcePosition'], 'REQUIRED');
    if (!split && given(value.sourcePosition) && (value.sourcePosition < 1 || value.sourcePosition > 1000)) {
      issue(ctx, ['sourcePosition'], 'OUT_OF_RANGE');
    }
  });
const itemKey = (i: { sourceType: string; sourceId: string; sourcePosition?: number | null | undefined }) =>
  `${i.sourceType}:${i.sourceId}:${i.sourcePosition ?? ''}`;
/** At most 50 items (`OUT_OF_RANGE`), each once (`DUPLICATE`). */
const items = z.array(item).superRefine((list, ctx) => {
  if (list.length > MAX_ASSET_ITEMS) issue(ctx, [], 'OUT_OF_RANGE');
  const seen = new Set<string>();
  list.forEach((i, index) => {
    if (typeof i?.sourceId !== 'string') return;
    const key = itemKey(i);
    if (seen.has(key)) issue(ctx, [index], 'DUPLICATE');
    seen.add(key);
  });
});
export const itemsOf = (list: readonly z.infer<typeof item>[]): ItemRef[] =>
  list.map((i) => ({ sourceType: i.sourceType, sourceId: i.sourceId, sourcePosition: i.sourcePosition ?? null }));

/** The fields of each type (§59B): named on the other, they are `NOT_ALLOWED`. */
const BUILDING_FIELDS = ['buildingCompletionYear', 'shorterUsefulLives', 'purchaseMethods'] as const;
const SEPARATE_FIELDS = ['description', 'usefulLifeYears', 'usefulLifeBasis', 'acquiredOn', 'items'] as const;
const SEPARATE_REQUIRED = ['description', 'usefulLifeYears', 'usefulLifeBasis', 'acquiredOn'] as const;

/**
 * §59's create body, and a separate asset's (§59B). Data-model §38's former inputs (`basisAmount`, `startDate`,
 * `depreciationRate`, …) and `jurisdiction` are unknown keys; `documentIds` is `NOT_SUPPORTED`.
 */
export const createBody = z
  .object({
    propertyReferenceId: uuid,
    assetType: assetType.optional(),
    buildingCompletionYear: completionYear.nullish(),
    description: description.nullish(),
    usefulLifeYears: usefulLifeYears.nullish(),
    usefulLifeBasis: usefulLifeBasis.nullish(),
    acquiredOn: businessDate.nullish(),
    items: items.nullish(),
    sourceReferences: sourceReferences.nullish(),
    depreciationMethod: z.enum(DEPRECIATION_METHODS).optional(),
    reviewState: reviewStateOf(ASSET_REVIEW_STATES).optional(),
    advisorPartyId: uuid.nullish(),
    shorterUsefulLives: entries.nullish(),
    purchaseMethods: purchaseMethods.nullish(),
    notes: optionalText(2000).nullish(),
    documentIds: z.unknown().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.documentIds !== undefined) issue(ctx, ['documentIds'], 'NOT_SUPPORTED');
    if (given(body.advisorPartyId) && body.reviewState !== 'ADVISOR_CONFIRMED') issue(ctx, ['advisorPartyId'], 'NOT_ALLOWED');
    const separate = body.assetType === 'SEPARATE_ASSET';
    for (const field of separate ? BUILDING_FIELDS : SEPARATE_FIELDS) if (given(body[field])) issue(ctx, [field], 'NOT_ALLOWED');
    if (body.depreciationMethod !== undefined && body.depreciationMethod !== (separate ? 'LINEAR_7_1' : 'LINEAR_7_4')) {
      issue(ctx, ['depreciationMethod'], 'NOT_ALLOWED');
    }
    if (separate) {
      // Every fact of a separate asset is required: no useful life and no date is ever guessed (§59B).
      for (const field of SEPARATE_REQUIRED) if (!given(body[field])) issue(ctx, [field], 'REQUIRED');
    } else if ((body.reviewState === 'CONFIRMED' || body.reviewState === 'ADVISOR_CONFIRMED') && !given(body.buildingCompletionYear)) {
      // Nobody can confirm a year that is not there.
      issue(ctx, ['reviewState'], 'COMPLETION_YEAR_REQUIRED');
    }
  });

/** Fixed after creation (§59): named in an amend, it is `400 NOT_AMENDABLE`, not an unknown key. */
const FIXED = ['propertyReferenceId', 'assetType', 'depreciationMethod'] as const;

export const amendBody = z
  .object({
    buildingCompletionYear: completionYear.nullable().optional(),
    // §59B: a separate asset's facts are required, so an amend replaces them and never clears them.
    description: description.optional(),
    usefulLifeYears: usefulLifeYears.optional(),
    usefulLifeBasis: usefulLifeBasis.optional(),
    acquiredOn: businessDate.optional(),
    items: items.optional(),
    sourceReferences: sourceReferences.nullable().optional(),
    notes: optionalText(2000).nullable().optional(),
    shorterUsefulLives: entries.nullable().optional(),
    purchaseMethods: purchaseMethods.nullable().optional(),
    reviewState: reviewStateOf(AMEND_REVIEW_STATES).optional(),
    ...Object.fromEntries(FIXED.map((field) => [field, z.unknown().optional()])),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Object.keys(body).length === 0) issue(ctx, [], 'REQUIRED');
    for (const field of FIXED) if (field in body) issue(ctx, [field], 'NOT_AMENDABLE');
  });

export const confirmBody = z
  .object({ reviewState: reviewStateOf(CONFIRM_REVIEW_STATES), advisorPartyId: uuid.nullish(), note: optionalText(500).nullish() })
  .strict()
  .superRefine((body, ctx) => {
    if (given(body.advisorPartyId) && body.reviewState !== 'ADVISOR_CONFIRMED') issue(ctx, ['advisorPartyId'], 'NOT_ALLOWED');
  });

export const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

/** `year` as §58C: digits only (`INVALID_FORMAT`), 2000–2100 (`OUT_OF_RANGE`). */
const year = z.string().transform((value, ctx) => {
  if (!/^\d{1,9}$/.test(value)) {
    ctx.addIssue({ code: 'custom', params: { code: 'INVALID_FORMAT' } });
    return z.NEVER;
  }
  const parsed = Number(value);
  if (parsed < 2000 || parsed > 2100) {
    ctx.addIssue({ code: 'custom', params: { code: 'OUT_OF_RANGE' } });
    return z.NEVER;
  }
  return parsed;
});
export const getQuery = z.object({ year: year.optional() }).strict();
/** §59A: `from` and `to` as `year`, `ownerPartyId` a UUID; any other parameter is `400`. */
export const scheduleQuery = z.object({ from: year.optional(), to: year.optional(), ownerPartyId: uuid.optional() }).strict();
export const listQuery = z
  .object({
    status: z
      .string()
      .transform((value) => value.split(','))
      .pipe(z.array(z.enum(ASSET_STATUSES)).min(1))
      .optional(),
    year: year.optional(),
  })
  .strict();

export const entriesOf = (list: readonly z.infer<typeof entry>[] | null | undefined) =>
  (list ?? []).map(
    (e): UsefulLifeAmendment => ({
      acquisitionId: e.acquisitionId,
      usefulLifeYears: e.usefulLifeYears,
      evidence: { source: e.evidence.source, date: e.evidence.date, documentReference: e.evidence.documentReference ?? null },
      ...(e.reviewState === undefined ? {} : { reviewState: e.reviewState }),
      ...(e.advisorPartyId === undefined ? {} : { advisorPartyId: e.advisorPartyId }),
    }),
  );

/** §59C: the method entries of a body; `null` (an amend's "remove every entry") is `[]`. */
export const purchaseMethodsOf = (list: readonly z.infer<typeof purchaseMethod>[] | null | undefined) =>
  (list ?? []).map(
    (e): PurchaseMethodAmendment => ({
      acquisitionId: e.acquisitionId,
      consideration: e.consideration,
      method: e.method,
      specialDepreciation: e.specialDepreciation,
      subsidiesReceived: e.subsidiesReceived,
      newBuildingByConversion: e.newBuildingByConversion,
      otherSpecialCase: e.otherSpecialCase,
      otherSpecialCaseNote: e.otherSpecialCaseNote ?? null,
      evidence: { source: e.evidence.source, date: e.evidence.date, documentReference: e.evidence.documentReference ?? null },
      notes: e.notes ?? null,
      ...(e.reviewState === undefined ? {} : { reviewState: e.reviewState }),
      ...(e.advisorPartyId === undefined ? {} : { advisorPartyId: e.advisorPartyId }),
    }),
  );
