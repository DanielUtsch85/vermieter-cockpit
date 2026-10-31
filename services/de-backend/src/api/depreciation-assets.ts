import express, { type Response, type Router } from 'express';
import type {
  AmendDepreciationAsset,
  AssetRate,
  ConfirmDepreciationAsset,
  CreateDepreciationAsset,
  DepreciationAsset,
  GetDepreciationAsset,
  GetDepreciationSchedule,
  ListPropertyDepreciationAssets,
  VoidDepreciationAsset,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { readId } from './acquisitions.js';
import { amendBody, confirmBody, createBody, entriesOf, getQuery, itemsOf, listQuery, references, voidBody } from './depreciation-asset-dto.js';
import { depreciationScheduleRoutes } from './depreciation-schedule.js';
import { fieldErrors, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

export interface DepreciationAssetCommands {
  readonly create: CreateDepreciationAsset;
  readonly get: GetDepreciationAsset;
  readonly listForPropertyReference: ListPropertyDepreciationAssets;
  readonly amend: AmendDepreciationAsset;
  readonly confirm: ConfirmDepreciationAsset;
  readonly void: VoidDepreciationAsset;
  readonly schedule: GetDepreciationSchedule;
}

/** The DepreciationAsset API (api-design.md §59, §59B; backlogs VC-8-01, VC-8-03). */
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
    const separate = body.assetType === 'SEPARATE_ASSET';
    commands
      .create({
        principal: principalOf(res),
        propertyReferenceId: body.propertyReferenceId,
        assetType: separate ? 'SEPARATE_ASSET' : 'BUILDING',
        buildingCompletionYear: body.buildingCompletionYear ?? null,
        description: body.description ?? null,
        usefulLifeYears: body.usefulLifeYears ?? null,
        usefulLifeBasis: body.usefulLifeBasis ?? null,
        acquiredOn: body.acquiredOn ?? null,
        items: itemsOf(body.items ?? []),
        sourceReferences: references(body.sourceReferences),
        depreciationMethod: separate ? 'LINEAR_7_1' : 'LINEAR_7_4',
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
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.usefulLifeYears === undefined ? {} : { usefulLifeYears: body.usefulLifeYears }),
        ...(body.usefulLifeBasis === undefined ? {} : { usefulLifeBasis: body.usefulLifeBasis }),
        ...(body.acquiredOn === undefined ? {} : { acquiredOn: body.acquiredOn }),
        ...(body.items === undefined ? {} : { items: itemsOf(body.items) }),
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
  router.use(depreciationScheduleRoutes(commands));

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
    // §59B: a separate asset's fields, `null` on a building.
    description: a.description,
    usefulLifeYears: a.usefulLifeYears,
    usefulLifeBasis: a.usefulLifeBasis,
    acquiredOn: a.acquiredOn,
    items: a.assetType === 'SEPARATE_ASSET' ? a.items.map((i) => ({ sourceType: i.sourceType, sourceId: i.sourceId, sourcePosition: i.sourcePosition })) : null,
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
    rate: r.rate,
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
