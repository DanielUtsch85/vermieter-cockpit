import express, { type Router } from 'express';
import { z } from 'zod';
import {
  ALLOCATION_METHODS,
  ALLOCATION_REVIEW_STATES,
  COMPARISON_METHODS,
  MAX_COMPARISON_SOURCE_REFERENCES,
  MAX_DEVIATION_REASON_LENGTH,
  allocationFlagsOf,
  comparisonLandShare,
  shareOf,
  type CreateLandBuildingAllocation,
  type LandBuildingAllocation,
  type ListLandBuildingAllocations,
} from '../application/index.js';
import { Money, zod3 } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, optionalText, readId } from './acquisitions.js';
import { money, NO_QUERY, readBody, readIdempotencyKey, readQuery, refuseQuery, RESOURCE_ID, sendValidationError } from './validation.js';

const uuid = zod3.transform(z.string().regex(RESOURCE_ID), (id) => id.toLowerCase());

/**
 * §58T rule 1 (VC-X-44): the values of land and building by another method, with at least one source; only their ratio
 * is compared, so they need not sum to the total.
 */
const comparison = z
  .object({
    method: z.enum(COMPARISON_METHODS),
    landValue: money,
    buildingValue: money,
    sourceReferences: zod3.array(z.string().trim().min(1).max(500)).max(MAX_COMPARISON_SOURCE_REFERENCES),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (Array.isArray(c.sourceReferences) && c.sourceReferences.length === 0)
      ctx.addIssue({ code: 'custom', path: ['sourceReferences'], params: { code: 'REQUIRED' } });
    if (c.landValue instanceof Money && c.buildingValue instanceof Money) {
      if (c.landValue.currency !== c.buildingValue.currency)
        ctx.addIssue({ code: 'custom', path: ['buildingValue', 'currency'], params: { code: 'CURRENCY_MISMATCH' } });
      else if (!c.landValue.add(c.buildingValue).isPositive()) ctx.addIssue({ code: 'custom', path: ['landValue'], params: { code: 'NOT_POSITIVE' } });
    }
  });

const body = z
  .object({
    totalAllocableAmount: money,
    landAmount: money,
    buildingAmount: money,
    method: z.enum(ALLOCATION_METHODS),
    reviewState: z.enum(ALLOCATION_REVIEW_STATES).optional(),
    effectiveDate: businessDate.nullish(),
    advisorPartyId: uuid.nullish(),
    sourceReferences: zod3.array(optionalText(500)).max(10).optional(),
    notes: optionalText(2000).nullish(),
    supersedes: uuid.nullable(),
    comparison: comparison.nullish(),
    deviationReason: optionalText(MAX_DEVIATION_REASON_LENGTH).nullish(),
    // Documents do not exist yet: refused, never stored unchecked (as §33.2).
    documentIds: z.unknown().optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.documentIds !== undefined) ctx.addIssue({ code: 'custom', path: ['documentIds'], params: { code: 'NOT_SUPPORTED' } });
    // Refinements run even after a field failed to parse: only check what parsed.
    const [total, land, building] = [b.totalAllocableAmount, b.landAmount, b.buildingAmount];
    if (total instanceof Money && !total.isPositive())
      ctx.addIssue({ code: 'custom', path: ['totalAllocableAmount', 'amount'], params: { code: 'NOT_POSITIVE' } });
    if (total instanceof Money && land instanceof Money && building instanceof Money) {
      if (land.currency !== total.currency || building.currency !== total.currency) {
        ctx.addIssue({ code: 'custom', path: ['totalAllocableAmount', 'currency'], params: { code: 'CURRENCY_MISMATCH' } });
      } else if (!land.add(building).equals(total)) {
        ctx.addIssue({ code: 'custom', path: ['totalAllocableAmount'], params: { code: 'ALLOCATION_SUM_MISMATCH' } });
      }
    }
    // §58T: the comparison in the allocation's currency; a reason only explains a comparison.
    const c = b.comparison;
    if (c != null && total instanceof Money && c.landValue instanceof Money && c.landValue.currency !== total.currency)
      ctx.addIssue({ code: 'custom', path: ['comparison', 'landValue', 'currency'], params: { code: 'CURRENCY_MISMATCH' } });
    if (b.deviationReason != null && b.comparison == null) ctx.addIssue({ code: 'custom', path: ['deviationReason'], params: { code: 'NOT_SUPPORTED' } });
  });

export interface LandBuildingAllocationCommands {
  readonly create: CreateLandBuildingAllocation;
  readonly list: ListLandBuildingAllocations;
}

/** Land/building allocation (api-design.md §27.3, backlog VC-2-08). */
export function landBuildingAllocationRoutes(commands: LandBuildingAllocationCommands): Router {
  const router = express.Router();

  router.post('/acquisitions/:acquisitionId/land-building-allocation', express.json({ limit: '32kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(body, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }
    const b = parsed.data;
    commands
      .create({
        principal: principalOf(res),
        acquisitionId,
        totalAllocableAmount: b.totalAllocableAmount,
        landAmount: b.landAmount,
        buildingAmount: b.buildingAmount,
        method: b.method,
        reviewState: b.reviewState ?? 'UNREVIEWED',
        effectiveDate: b.effectiveDate ?? null,
        advisorPartyId: b.advisorPartyId ?? null,
        sourceReferences: (b.sourceReferences ?? []).filter((reference): reference is string => reference !== null),
        notes: b.notes ?? null,
        supersedes: b.supersedes,
        comparison:
          b.comparison == null
            ? null
            : {
                method: b.comparison.method,
                landValue: b.comparison.landValue,
                buildingValue: b.comparison.buildingValue,
                sourceReferences: b.comparison.sourceReferences,
              },
        deviationReason: b.deviationReason ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ allocation, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.status(201).json(toDto(allocation));
      })
      .catch(next);
  });

  router.get('/acquisitions/:acquisitionId/land-building-allocations', (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    if (refuseQuery(res, query)) return;
    commands
      .list({ principal: principalOf(res), acquisitionId })
      .then(({ current, items }) => res.json({ current: current === null ? null : toDto(current), items: items.map((a) => toDto(a)) }))
      .catch(next);
  });

  return router;
}

/**
 * The allocation as §27.3 answers it, with §58T's `comparison`, `deviationReason` and `flags` (derived on read, each
 * allocation by its own data and the version of `DE_LAND_BUILDING_PLAUSIBILITY` on its own `effectiveDate`).
 */
export function toDto(a: LandBuildingAllocation) {
  const c = a.comparison ?? null;
  const deviationReason = a.deviationReason ?? null;
  return {
    allocationId: a.id,
    acquisitionId: a.acquisitionId,
    totalAllocableAmount: a.totalAllocableAmount.toJSON(),
    landAmount: a.landAmount.toJSON(),
    buildingAmount: a.buildingAmount.toJSON(),
    landShare: shareOf(a.landAmount, a.totalAllocableAmount),
    buildingShare: shareOf(a.buildingAmount, a.totalAllocableAmount),
    method: a.method,
    reviewState: a.reviewState,
    effectiveDate: a.effectiveDate,
    advisorPartyId: a.advisorPartyId,
    sourceReferences: a.sourceReferences,
    notes: a.notes,
    supersedesId: a.supersedesId,
    supersededAt: a.supersededAt?.toISOString() ?? null,
    supersededById: a.supersededById,
    current: a.current,
    createdAt: a.createdAt.toISOString(),
    comparison:
      c === null
        ? null
        : {
            method: c.method,
            landValue: c.landValue.toJSON(),
            buildingValue: c.buildingValue.toJSON(),
            sourceReferences: c.sourceReferences,
            landShare: comparisonLandShare(c),
          },
    deviationReason,
    flags: allocationFlagsOf(a),
  };
}
