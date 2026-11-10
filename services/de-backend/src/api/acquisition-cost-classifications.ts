import express, { type Router } from 'express';
import { z } from 'zod';
import {
  CLASSIFICATION_PURPOSES,
  CLASSIFICATION_REVIEW_STATES,
  MAX_CLASSIFICATION_PARTS,
  type AcquisitionCostClassification,
  type CreateCostClassification,
  type ListCostClassifications,
} from '../application/index.js';
import { Money, zod3 } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { optionalText, readId } from './acquisitions.js';
import { jsonBody, money, NO_QUERY, readBody, readIdempotencyKey, readQuery, refuseQuery, RESOURCE_ID, sendValidationError } from './validation.js';

const uuid = zod3.transform(z.string().regex(RESOURCE_ID), (id) => id.toLowerCase());

const issue = (ctx: z.RefinementCtx, path: (string | number)[], code: string) => ctx.addIssue({ code: 'custom', path, params: { code } });

/** A review state the command takes; `SUGGESTED` (reserved for machine suggestions) is `NOT_ALLOWED`, another `INVALID_FORMAT`. */
const reviewState = zod3.transform(z.string(), (value, ctx) => {
  if ((CLASSIFICATION_REVIEW_STATES as readonly string[]).includes(value)) return value as (typeof CLASSIFICATION_REVIEW_STATES)[number];
  issue(ctx, [], value === 'SUGGESTED' ? 'NOT_ALLOWED' : 'INVALID_FORMAT');
  return z.NEVER;
});

const part = z
  .object({ purpose: z.enum(CLASSIFICATION_PURPOSES), amount: money })
  .strict()
  .superRefine((p, ctx) => {
    // Refinements run even after a field failed to parse: only check what parsed.
    if (p.amount instanceof Money && !p.amount.isPositive()) issue(ctx, ['amount', 'amount'], 'NOT_POSITIVE');
  });

const body = z
  .object({
    parts: zod3.array(part).superRefine((list, ctx) => {
      if (list.length < 1 || list.length > MAX_CLASSIFICATION_PARTS) issue(ctx, [], 'OUT_OF_RANGE');
    }),
    description: z.string().trim().min(1).max(500),
    sourceReferences: zod3.array(optionalText(500)).max(10).optional(),
    reviewState: reviewState.optional(),
    advisorPartyId: uuid.nullish(),
    notes: optionalText(2000).nullish(),
    supersedes: uuid.nullable(),
  })
  .strict();

/**
 * An advisor only with `ADVISOR_CONFIRMED` (§59D order 1), read off the raw body so it is reported with every other
 * field error at once (zod skips an object's refinement once a field failed).
 */
const advisorNotAllowed = (raw: unknown): boolean => {
  if (typeof raw !== 'object' || raw === null) return false;
  const b = raw as { advisorPartyId?: unknown; reviewState?: unknown };
  return b.advisorPartyId !== undefined && b.advisorPartyId !== null && b.reviewState !== 'ADVISOR_CONFIRMED';
};

export interface CostClassificationCommands {
  readonly create: CreateCostClassification;
  readonly list: ListCostClassifications;
}

/** The classification of an acquisition cost (api-design.md §59D, backlog VC-X-42). */
export function costClassificationRoutes(commands: CostClassificationCommands): Router {
  const router = express.Router();

  router.post('/acquisitions/:acquisitionId/costs/:costId/classifications', jsonBody('32kb'), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const costId = readId(req.params['costId'], 'costId', res);
    if (costId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(body, req, (raw) => (advisorNotAllowed(raw) ? [{ field: 'advisorPartyId', code: 'NOT_ALLOWED' }] : []));
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }
    const b = parsed.data;
    commands
      .create({
        principal: principalOf(res),
        acquisitionId,
        costId,
        parts: b.parts,
        description: b.description,
        sourceReferences: (b.sourceReferences ?? []).filter((reference): reference is string => reference !== null),
        reviewState: b.reviewState ?? 'UNREVIEWED',
        advisorPartyId: b.advisorPartyId ?? null,
        notes: b.notes ?? null,
        supersedes: b.supersedes,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ classification, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        // A classification is never changed (§59D): its version is 1; its Location is the cost's history (no single read).
        res.setHeader('ETag', '"1"');
        res.setHeader('Location', `/api/v1/acquisitions/${acquisitionId}/costs/${costId}/classifications`);
        res.status(201).json(classificationDto(classification));
      })
      .catch(next);
  });

  router.get('/acquisitions/:acquisitionId/costs/:costId/classifications', (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const costId = readId(req.params['costId'], 'costId', res);
    if (costId === undefined) return;
    if (refuseQuery(res, query)) return;
    commands
      .list({ principal: principalOf(res), acquisitionId, costId })
      .then(({ current, items }) => res.json({ current: current === null ? null : classificationDto(current), items: items.map(classificationDto) }))
      .catch(next);
  });

  return router;
}

/** A classification as the API shows it; also the cost's `classification` (§27.2, amended by §59D). */
export function classificationDto(c: AcquisitionCostClassification) {
  return {
    classificationId: c.id,
    acquisitionId: c.acquisitionId,
    costId: c.costId,
    parts: c.parts.map((p) => ({ purpose: p.purpose, amount: p.amount.toJSON() })),
    description: c.description,
    sourceReferences: c.sourceReferences,
    reviewState: c.reviewState,
    advisorPartyId: c.advisorPartyId,
    notes: c.notes,
    supersedesId: c.supersedesId,
    supersededAt: c.supersededAt?.toISOString() ?? null,
    supersededById: c.supersededById,
    current: c.current,
    createdAt: c.createdAt.toISOString(),
  };
}
