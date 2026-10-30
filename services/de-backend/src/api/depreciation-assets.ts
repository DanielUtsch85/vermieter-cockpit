import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  AMEND_REVIEW_STATES,
  ASSET_REVIEW_STATES,
  ASSET_STATUSES,
  COMPLETION_YEAR_MAX,
  COMPLETION_YEAR_MIN,
  CONFIRM_REVIEW_STATES,
  DEPRECIATION_METHODS,
  MAX_ASSET_SOURCE_REFERENCES,
  MAX_SHORTER_USEFUL_LIVES,
  type AmendDepreciationAsset,
  type AssetRate,
  type ConfirmDepreciationAsset,
  type CreateDepreciationAsset,
  type DepreciationAsset,
  type GetDepreciationAsset,
  type ListPropertyDepreciationAssets,
  type UsefulLifeAmendment,
  type VoidDepreciationAsset,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, optionalText, readId } from './acquisitions.js';
import { RESOURCE_ID, fieldErrors, integerIn, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

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
const references = (values: readonly (string | null)[] | null | undefined) => (values ?? []).filter((reference): reference is string => reference !== null);

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

const assetType = z.string().transform((value, ctx) => {
  if (value === 'BUILDING') return value;
  // VC-8-03 (§59B).
  ctx.addIssue({ code: 'custom', params: { code: value === 'SEPARATE_ASSET' ? 'NOT_SUPPORTED' : 'INVALID_FORMAT' } });
  return z.NEVER;
});

/**
 * §59's create body. Data-model §38's former inputs (`basisAmount`, `startDate`, `depreciationRate`, …) and
 * `jurisdiction` are unknown keys; `documentIds` is `NOT_SUPPORTED`.
 */
const createBody = z
  .object({
    propertyReferenceId: uuid,
    assetType: assetType.optional(),
    buildingCompletionYear: completionYear.nullish(),
    sourceReferences: sourceReferences.nullish(),
    depreciationMethod: z.enum(DEPRECIATION_METHODS).optional(),
    reviewState: reviewStateOf(ASSET_REVIEW_STATES).optional(),
    advisorPartyId: uuid.nullish(),
    shorterUsefulLives: entries.nullish(),
    notes: optionalText(2000).nullish(),
    documentIds: z.unknown().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.documentIds !== undefined) issue(ctx, ['documentIds'], 'NOT_SUPPORTED');
    if (given(body.advisorPartyId) && body.reviewState !== 'ADVISOR_CONFIRMED') issue(ctx, ['advisorPartyId'], 'NOT_ALLOWED');
    // Nobody can confirm a year that is not there.
    if ((body.reviewState === 'CONFIRMED' || body.reviewState === 'ADVISOR_CONFIRMED') && !given(body.buildingCompletionYear)) {
      issue(ctx, ['reviewState'], 'COMPLETION_YEAR_REQUIRED');
    }
  });

/** Fixed after creation (§59): named in an amend, it is `400 NOT_AMENDABLE`, not an unknown key. */
const FIXED = ['propertyReferenceId', 'assetType', 'depreciationMethod'] as const;

const amendBody = z
  .object({
    buildingCompletionYear: completionYear.nullable().optional(),
    sourceReferences: sourceReferences.nullable().optional(),
    notes: optionalText(2000).nullable().optional(),
    shorterUsefulLives: entries.nullable().optional(),
    reviewState: reviewStateOf(AMEND_REVIEW_STATES).optional(),
    ...Object.fromEntries(FIXED.map((field) => [field, z.unknown().optional()])),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Object.keys(body).length === 0) issue(ctx, [], 'REQUIRED');
    for (const field of FIXED) if (field in body) issue(ctx, [field], 'NOT_AMENDABLE');
  });

const confirmBody = z
  .object({ reviewState: reviewStateOf(CONFIRM_REVIEW_STATES), advisorPartyId: uuid.nullish(), note: optionalText(500).nullish() })
  .strict()
  .superRefine((body, ctx) => {
    if (given(body.advisorPartyId) && body.reviewState !== 'ADVISOR_CONFIRMED') issue(ctx, ['advisorPartyId'], 'NOT_ALLOWED');
  });

const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

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
const getQuery = z.object({ year: year.optional() }).strict();
const listQuery = z
  .object({
    status: z
      .string()
      .transform((value) => value.split(','))
      .pipe(z.array(z.enum(ASSET_STATUSES)).min(1))
      .optional(),
    year: year.optional(),
  })
  .strict();

export interface DepreciationAssetCommands {
  readonly create: CreateDepreciationAsset;
  readonly get: GetDepreciationAsset;
  readonly listForPropertyReference: ListPropertyDepreciationAssets;
  readonly amend: AmendDepreciationAsset;
  readonly confirm: ConfirmDepreciationAsset;
  readonly void: VoidDepreciationAsset;
}

const entriesOf = (list: readonly z.infer<typeof entry>[] | null | undefined) =>
  (list ?? []).map(
    (e): UsefulLifeAmendment => ({
      acquisitionId: e.acquisitionId,
      usefulLifeYears: e.usefulLifeYears,
      evidence: { source: e.evidence.source, date: e.evidence.date, documentReference: e.evidence.documentReference ?? null },
      ...(e.reviewState === undefined ? {} : { reviewState: e.reviewState }),
      ...(e.advisorPartyId === undefined ? {} : { advisorPartyId: e.advisorPartyId }),
    }),
  );

/** The DepreciationAsset API (api-design.md §59, backlog VC-8-01). */
export function depreciationAssetRoutes(commands: DepreciationAssetCommands): Router {
  const router = express.Router();

  router.post('/depreciation-assets', express.json({ limit: '64kb' }), (req, res, next) => {
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    commands
      .create({
        principal: principalOf(res),
        propertyReferenceId: body.propertyReferenceId,
        assetType: 'BUILDING',
        buildingCompletionYear: body.buildingCompletionYear ?? null,
        sourceReferences: references(body.sourceReferences),
        depreciationMethod: body.depreciationMethod ?? 'LINEAR_7_4',
        reviewState: body.reviewState ?? 'UNREVIEWED',
        advisorPartyId: body.advisorPartyId ?? null,
        // On create an entry's state defaults to UNREVIEWED and its advisor to none.
        shorterUsefulLives: entriesOf(body.shorterUsefulLives).map((e) => ({
          ...e,
          reviewState: e.reviewState ?? 'UNREVIEWED',
          advisorPartyId: e.advisorPartyId ?? null,
        })),
        notes: body.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ asset, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.setHeader('Location', `/api/v1/depreciation-assets/${asset.id}`);
        sendAsset(res.status(201), asset, null);
      })
      .catch(next);
  });

  router.get('/depreciation-assets/:assetId', (req, res, next) => {
    const assetId = readId(req.params['assetId'], 'assetId', res);
    if (assetId === undefined) return;
    const query = getQuery.safeParse(req.query);
    if (!query.success) {
      sendValidationError(res, fieldErrors(query.error));
      return;
    }
    commands
      .get({ principal: principalOf(res), assetId, ...(query.data.year === undefined ? {} : { year: query.data.year }) })
      .then(({ asset, rate }) => sendAsset(res, asset, rate))
      .catch(next);
  });

  router.get('/property-references/:propertyReferenceId/depreciation-assets', (req, res, next) => {
    const propertyReferenceId = readId(req.params['propertyReferenceId'], 'propertyReferenceId', res);
    if (propertyReferenceId === undefined) return;
    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      sendValidationError(res, fieldErrors(query.error));
      return;
    }
    commands
      .listForPropertyReference({
        principal: principalOf(res),
        propertyReferenceId,
        statuses: query.data.status ?? null,
        ...(query.data.year === undefined ? {} : { year: query.data.year }),
      })
      .then((items) => res.json({ items: items.map(({ asset, rate }) => assetDto(asset, rate)) }))
      .catch(next);
  });

  router.post('/depreciation-assets/:assetId/amend', express.json({ limit: '64kb' }), (req, res, next) => {
    const assetId = readId(req.params['assetId'], 'assetId', res);
    if (assetId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = amendBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    commands
      .amend({
        principal: principalOf(res),
        assetId,
        ...(body.buildingCompletionYear === undefined ? {} : { buildingCompletionYear: body.buildingCompletionYear }),
        ...(body.sourceReferences === undefined ? {} : { sourceReferences: references(body.sourceReferences) }),
        ...(body.notes === undefined ? {} : { notes: body.notes }),
        ...(body.shorterUsefulLives === undefined ? {} : { shorterUsefulLives: entriesOf(body.shorterUsefulLives) }),
        ...(body.reviewState === undefined ? {} : { reviewState: body.reviewState }),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ asset }) => sendAsset(res, asset, null))
      .catch(next);
  });

  router.post('/depreciation-assets/:assetId/confirm', express.json({ limit: '32kb' }), (req, res, next) => {
    const assetId = readId(req.params['assetId'], 'assetId', res);
    if (assetId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = confirmBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .confirm({
        principal: principalOf(res),
        assetId,
        reviewState: parsed.data.reviewState,
        advisorPartyId: parsed.data.advisorPartyId ?? null,
        note: parsed.data.note ?? null,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ asset }) => sendAsset(res, asset, null))
      .catch(next);
  });

  router.post('/depreciation-assets/:assetId/void', express.json({ limit: '32kb' }), (req, res, next) => {
    const assetId = readId(req.params['assetId'], 'assetId', res);
    if (assetId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = voidBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .void({
        principal: principalOf(res),
        assetId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ asset }) => sendAsset(res, asset, null))
      .catch(next);
  });

  return router;
}

/** A single asset with its version as `ETag` for the next `If-Match` (§16.1); a command answers `rate: null` (§59). */
function sendAsset(res: Response, asset: DepreciationAsset, rate: AssetRate | null): void {
  res.setHeader('ETag', `"${asset.version}"`);
  res.json(assetDto(asset, rate));
}

function assetDto(a: DepreciationAsset, rate: AssetRate | null) {
  return {
    assetId: a.id,
    mreRealmId: a.mreRealmId,
    propertyReferenceId: a.propertyReferenceId,
    assetType: a.assetType,
    status: a.status,
    buildingCompletionYear: a.buildingCompletionYear,
    sourceReferences: a.sourceReferences,
    depreciationMethod: a.depreciationMethod,
    reviewState: a.reviewState,
    advisorPartyId: a.advisorPartyId,
    shorterUsefulLives: a.shorterUsefulLives.map((e) => ({
      acquisitionId: e.acquisitionId,
      usefulLifeYears: e.usefulLifeYears,
      evidence: { source: e.evidence.source, date: e.evidence.date, documentReference: e.evidence.documentReference },
      reviewState: e.reviewState,
      advisorPartyId: e.advisorPartyId,
    })),
    notes: a.notes,
    voidedAt: a.voidedAt?.toISOString() ?? null,
    voidReason: a.voidReason,
    createdAt: a.createdAt.toISOString(),
    version: a.version,
    rate: rate === null ? null : rateDto(rate),
  };
}

function rateDto(r: AssetRate) {
  return {
    year: r.year,
    rule: r.rule === null ? null : { ruleCode: r.rule.ruleCode, version: r.rule.version },
    band: r.band,
    ratePercent: r.ratePercent,
    legalBasis: r.legalBasis,
    shorterThanYears: r.shorterThanYears,
    reasons: r.reasons,
    shorterUsefulLives: r.shorterUsefulLives.map((e) => ({
      acquisitionId: e.acquisitionId,
      rate: e.rate,
      ratePercent: e.ratePercent,
      applies: e.applies,
      reasons: e.reasons,
    })),
  };
}
