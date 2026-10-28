import express, { type Router } from 'express';
import { z } from 'zod';
import {
  AcquisitionCancelledError,
  AcquisitionNotFoundError,
  OwnershipBasisIncompleteError,
  formatShare,
  type GetOwnerAllocation,
  type OwnerPart,
} from '../application/index.js';
import type { Money } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { readId, violationDto } from './acquisitions.js';
import { sendError } from './errors.js';
import { fieldErrors, sendValidationError } from './validation.js';

export interface OwnerAllocationCommands {
  readonly get: GetOwnerAllocation;
}

/** Owner-level allocation read (api-design.md §27.4, backlog VC-2-09). */
export function ownerAllocationRoutes(commands: OwnerAllocationCommands): Router {
  const router = express.Router();

  router.get('/acquisitions/:acquisitionId/owner-allocation', (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const query = z.object({}).strict().safeParse(req.query);
    if (!query.success) {
      sendValidationError(res, fieldErrors(query.error));
      return;
    }
    commands
      .get({ principal: principalOf(res), acquisitionId })
      .then((plan) =>
        res.json({
          acquisitionId,
          basis: plan.basis,
          allocationId: plan.allocationId,
          owners: plan.owners.map(ownerDto),
          totals: {
            purchasePrice: plan.totals.purchasePrice.toJSON(),
            costs: costsDto(plan.totals.costs),
            costsTotal: plan.totals.costsTotal.toJSON(),
            landAmount: plan.totals.landAmount?.toJSON() ?? null,
            buildingAmount: plan.totals.buildingAmount?.toJSON() ?? null,
            totalAllocableAmount: plan.totals.totalAllocableAmount?.toJSON() ?? null,
          },
        }),
      )
      .catch((error: unknown) => {
        if (error instanceof AcquisitionNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'Acquisition not found.', { acquisitionId: error.acquisitionId });
        } else if (error instanceof AcquisitionCancelledError) {
          sendError(res, 409, 'CONFLICT', 'A cancelled Acquisition is allocated to nobody.', {
            reason: 'ACQUISITION_CANCELLED',
            acquisitionId: error.acquisitionId,
          });
        } else if (error instanceof OwnershipBasisIncompleteError) {
          sendError(res, 409, 'CONFLICT', "The draft's Ownerships do not yet form a complete basis.", {
            reason: 'OWNERSHIP_BASIS_INCOMPLETE',
            violations: error.violations.map(violationDto),
          });
        } else {
          next(error);
        }
      });
  });

  return router;
}

function costsDto(costs: ReadonlyMap<string, Money>) {
  return Object.fromEntries([...costs].map(([category, amount]) => [category, amount.toJSON()]));
}

function ownerDto(o: OwnerPart) {
  return {
    ownerPartyId: o.ownerPartyId,
    ownershipId: o.ownershipId,
    share: formatShare(o.share),
    weight: formatShare(o.weight),
    purchasePrice: o.purchasePrice.toJSON(),
    costs: costsDto(o.costs),
    costsTotal: o.costsTotal.toJSON(),
    landAmount: o.landAmount?.toJSON() ?? null,
    buildingAmount: o.buildingAmount?.toJSON() ?? null,
    totalAllocableAmount: o.totalAllocableAmount?.toJSON() ?? null,
  };
}
