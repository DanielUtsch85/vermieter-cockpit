import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  ALLOCATION_METHODS,
  ALLOCATION_REVIEW_STATES,
  AcquisitionCancelledError,
  AcquisitionNotFoundError,
  CurrentAllocationChangedError,
  IdempotencyKeyConflictError,
  PartyNotFoundError,
  shareOf,
  type CreateLandBuildingAllocation,
  type LandBuildingAllocation,
  type ListLandBuildingAllocations,
  type RealmPrincipal,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { businessDate, optionalText, readId } from './acquisitions.js';
import { sendError } from './errors.js';
import { RESOURCE_ID, fieldErrors, money, readIdempotencyKey, sendValidationError } from './validation.js';

const uuid = z.string().regex(RESOURCE_ID).transform((id) => id.toLowerCase());

const body = z
  .object({
    totalAllocableAmount: money,
    landAmount: money,
    buildingAmount: money,
    method: z.enum(ALLOCATION_METHODS),
    reviewState: z.enum(ALLOCATION_REVIEW_STATES).optional(),
    effectiveDate: businessDate.nullish(),
    advisorPartyId: uuid.nullish(),
    sourceReferences: z.array(optionalText(500)).max(10).optional(),
    notes: optionalText(2000).nullish(),
    supersedes: uuid.nullable(),
    // Documents do not exist yet: refused, never stored unchecked (as §33.2).
    documentIds: z.unknown().optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.documentIds !== undefined) ctx.addIssue({ code: 'custom', path: ['documentIds'], params: { code: 'NOT_SUPPORTED' } });
    // Refinements run even after a field failed to parse: only check what parsed.
    const [total, land, building] = [b.totalAllocableAmount, b.landAmount, b.buildingAmount];
    if (total instanceof Money && !total.isPositive()) ctx.addIssue({ code: 'custom', path: ['totalAllocableAmount', 'amount'], params: { code: 'NOT_POSITIVE' } });
    if (total instanceof Money && land instanceof Money && building instanceof Money) {
      if (land.currency !== total.currency || building.currency !== total.currency) {
        ctx.addIssue({ code: 'custom', path: ['totalAllocableAmount', 'currency'], params: { code: 'CURRENCY_MISMATCH' } });
      } else if (!land.add(building).equals(total)) {
        ctx.addIssue({ code: 'custom', path: ['totalAllocableAmount'], params: { code: 'ALLOCATION_SUM_MISMATCH' } });
      }
    }
  });

export interface LandBuildingAllocationCommands {
  readonly create: CreateLandBuildingAllocation;
  readonly list: ListLandBuildingAllocations;
}

/** Land/building allocation (api-design.md §27.3, backlog VC-2-08). */
export function landBuildingAllocationRoutes(commands: LandBuildingAllocationCommands): Router {
  const router = express.Router();
  const principalOf = (res: Response) => res.locals['principal'] as RealmPrincipal;

  router.post('/acquisitions/:acquisitionId/land-building-allocation', express.json({ limit: '32kb' }), (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
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
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ allocation, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.status(201).json(toDto(allocation));
      })
      .catch((error: unknown) => {
        if (!sendAllocationError(res, error)) next(error);
      });
  });

  router.get('/acquisitions/:acquisitionId/land-building-allocations', (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const query = z.object({}).strict().safeParse(req.query);
    if (!query.success) {
      sendValidationError(res, fieldErrors(query.error));
      return;
    }
    commands
      .list({ principal: principalOf(res), acquisitionId })
      .then(({ current, items }) => res.json({ current: current === null ? null : toDto(current), items: items.map(toDto) }))
      .catch((error: unknown) => {
        if (!sendAllocationError(res, error)) next(error);
      });
  });

  return router;
}

/** The refusals of §27.3; false for anything else (→ the error handler). */
function sendAllocationError(res: Response, error: unknown): boolean {
  if (error instanceof AcquisitionNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Acquisition not found.', { acquisitionId: error.acquisitionId });
  } else if (error instanceof PartyNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Party not found.', { partyId: error.partyId });
  } else if (error instanceof AcquisitionCancelledError) {
    sendError(res, 409, 'CONFLICT', 'A cancelled Acquisition takes no allocation.', { reason: 'ACQUISITION_CANCELLED', acquisitionId: error.acquisitionId });
  } else if (error instanceof CurrentAllocationChangedError) {
    sendError(res, 409, 'CONFLICT', 'supersedes does not name the current allocation.', {
      reason: 'CURRENT_ALLOCATION_CHANGED',
      currentAllocationId: error.currentAllocationId,
    });
  } else if (error instanceof IdempotencyKeyConflictError) {
    sendError(res, 409, 'CONFLICT', 'Idempotency-Key was already used with a different payload.');
  } else {
    return false;
  }
  return true;
}

function toDto(a: LandBuildingAllocation) {
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
  };
}
