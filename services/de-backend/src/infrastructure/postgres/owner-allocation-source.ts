import { sql, type Kysely } from 'kysely';
import type { CostCategory, OwnerAllocationInput, OwnerAllocationSource } from '../../domains/acquisition/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { readAcquisitionIn } from './acquisition-repository.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

/**
 * The inputs of the owner-level allocation (api-design.md §27.4): the Acquisition, its `VALID` Ownerships, the sums of
 * its `ACTIVE` costs per category and its current land/building allocation, in one `REPEATABLE READ READ ONLY`
 * snapshot, so the parts always come from one state.
 */
export class PostgresOwnerAllocationSource implements OwnerAllocationSource {
  constructor(private readonly db: Kysely<Database>) {}

  read(acquisitionId: string, mreRealmId: string): Promise<OwnerAllocationInput | undefined> {
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      const acquisition = await readAcquisitionIn(trx, acquisitionId, mreRealmId);
      if (acquisition === undefined) return undefined;
      const own = await trx
        .selectFrom('ownership')
        .select(['id', 'owner_party_id', 'share_numerator', 'share_denominator', sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from')])
        .where('acquisition_id', '=', acquisitionId)
        .where('status', '=', 'VALID')
        .execute();
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
        own: own.map((o) => ({
          id: o.id,
          ownerPartyId: o.owner_party_id,
          share: { numerator: o.share_numerator, denominator: o.share_denominator },
          validFrom: o.valid_from as BusinessDate,
        })),
        costs: new Map(costs.map((c) => [c.category as CostCategory, fromNumericAmount(c.amount, c.currency)])),
        allocation:
          allocation === undefined
            ? null
            : { id: allocation.id, landAmount: fromNumericAmount(allocation.land, allocation.currency), buildingAmount: fromNumericAmount(allocation.building, allocation.currency) },
      };
    });
  }
}
