import express, { type Router } from 'express';
import { formatShare, type GetOwnerAllocation, type OwnerPart } from '../application/index.js';
import type { Money } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { readId } from './acquisitions.js';
import { NO_QUERY, readQuery, refuseQuery } from './validation.js';

export interface OwnerAllocationCommands {
  readonly get: GetOwnerAllocation;
}

/** Owner-level allocation read (api-design.md §27.4, backlog VC-2-09). */
export function ownerAllocationRoutes(commands: OwnerAllocationCommands): Router {
  const router = express.Router();

  router.get('/acquisitions/:acquisitionId/owner-allocation', (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    if (refuseQuery(res, query)) return;
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
      .catch(next);
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
    shareBefore: formatShare(o.shareBefore),
    acquiredShare: formatShare(o.acquiredShare),
    weight: formatShare(o.weight),
    purchasePrice: o.purchasePrice.toJSON(),
    costs: costsDto(o.costs),
    costsTotal: o.costsTotal.toJSON(),
    landAmount: o.landAmount?.toJSON() ?? null,
    buildingAmount: o.buildingAmount?.toJSON() ?? null,
    totalAllocableAmount: o.totalAllocableAmount?.toJSON() ?? null,
  };
}
