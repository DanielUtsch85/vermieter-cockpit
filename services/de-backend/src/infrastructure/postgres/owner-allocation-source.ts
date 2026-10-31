import { sql, type Kysely } from 'kysely';
import { transferDate, type CostCategory, type OwnerAllocationInput, type OwnerAllocationSource } from '../../domains/acquisition/index.js';
import { addDays, type BusinessDate } from '../../shared/index.js';
import { ownershipQuery, readAcquisitionIn, toConfirmationOwnership } from './acquisition-repository.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

/**
 * The inputs of the owner-level allocation (api-design.md §27.4): the Acquisition, its `VALID` Ownerships, the buyers'
 * `VALID` Ownerships covering the transfer date and the day before (§28.1A), the sums of its `ACTIVE` costs per
 * category and its current land/building allocation, in one `REPEATABLE READ READ ONLY` snapshot, so the parts always
 * come from one state.
 */
export class PostgresOwnerAllocationSource implements OwnerAllocationSource {
  constructor(private readonly db: Kysely<Database>) {}

  read(acquisitionId: string, mreRealmId: string): Promise<OwnerAllocationInput | undefined> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const acquisition = await readAcquisitionIn(trx, acquisitionId, mreRealmId);
        if (acquisition === undefined) return undefined;
        const own = await ownershipQuery(trx).where('acquisition_id', '=', acquisitionId).execute();
        // §28.1A: the buyers' Ownerships covering the transfer date and the day before, for their increases.
        const d = transferDate(acquisition);
        const buyersCovering = (day: BusinessDate) =>
          ownershipQuery(trx)
            .where('property_reference_id', '=', acquisition.propertyReferenceId)
            .where('owner_party_id', 'in', acquisition.buyerPartyIds)
            .where('valid_from', '<=', day)
            .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>=', day)]))
            .execute();
        const onTransferDate = await buyersCovering(d);
        const beforeTransferDate = await buyersCovering(addDays(d, -1));
        const costs = await trx
          .selectFrom('acquisition_cost')
          .select(['category', 'currency', sql<string>`sum(amount)::text`.as('amount')])
          .where('acquisition_id', '=', acquisitionId)
          .where('status', '=', 'ACTIVE')
          .groupBy(['category', 'currency'])
          .execute();
        const allocation = await trx
          .selectFrom('land_building_allocation')
          .select(['id', 'currency', sql<string>`land_amount::text`.as('land'), sql<string>`building_amount::text`.as('building')])
          .where('acquisition_id', '=', acquisitionId)
          .where('superseded_at', 'is', null)
          .executeTakeFirst();
        return {
          acquisition,
          own: own.map(toConfirmationOwnership),
          onTransferDate: onTransferDate.map(toConfirmationOwnership),
          beforeTransferDate: beforeTransferDate.map(toConfirmationOwnership),
          costs: new Map(costs.map((c) => [c.category as CostCategory, fromNumericAmount(c.amount, c.currency)])),
          allocation:
            allocation === undefined
              ? null
              : {
                  id: allocation.id,
                  landAmount: fromNumericAmount(allocation.land, allocation.currency),
                  buildingAmount: fromNumericAmount(allocation.building, allocation.currency),
                },
        };
      });
  }
}
