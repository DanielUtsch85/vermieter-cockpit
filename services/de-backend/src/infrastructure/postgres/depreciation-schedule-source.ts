import { sql, type Kysely } from 'kysely';
import type {
  AssetLink,
  DepreciationScheduleSource,
  ItemSourceType,
  ScheduleAcquisition,
  ScheduleOwnership,
  ScheduleRead,
} from '../../domains/depreciation/index.js';
import { paymentStatusOf } from '../../domains/acquisition/index.js';
import { businessDayOf } from '../../domains/ledger/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { COUNTING } from './acquisition-cost-repository.js';
import { capitalizedItemsIn, type CapitalizedSourcesReader } from './capitalized-items.js';
import { depreciationSnapshot, readAsset } from './depreciation-asset-repository.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The inputs of the schedule (api-design.md §59A "One snapshot"): the asset with its shorter useful lives, the
 * Acquisitions of its PropertyReference that are not `CANCELLED` with their parties, `ACTIVE` costs, counting payments
 * and current allocation, and every `VALID` Ownership of the PropertyReference, all in one `REPEATABLE READ READ ONLY`
 * transaction (P8-D14), one query per input on existing indexes, every one filtered by the caller's Realm. It writes
 * nothing; a write inside the transaction fails (`25006`). No MRE call. §59B adds, in the same snapshot, the capitalised
 * items of the PropertyReference (Taxation's derivation through `capitalized-items.ts`) and the links of its `ACTIVE`
 * separate assets.
 */
export class PostgresDepreciationScheduleSource implements DepreciationScheduleSource {
  /** `capitalizedSources` is the tax repository's reader (§59B), passed by the composition root; `now` gives `today`. */
  constructor(
    private readonly db: Kysely<Database>,
    private readonly capitalizedSources: CapitalizedSourcesReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  read(assetId: string, mreRealmId: string, ownerPartyId: string | null): Promise<ScheduleRead | undefined> {
    if (!UUID.test(assetId)) return Promise.resolve(undefined);
    return depreciationSnapshot(this.db, async (trx) => {
      const asset = await readAsset(trx, assetId, mreRealmId);
      if (asset === undefined) return undefined;
      const ownerPartyFound =
        ownerPartyId === null
          ? null
          : UUID.test(ownerPartyId) &&
            (await trx.selectFrom('party').select('id').where('id', '=', ownerPartyId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst()) !== undefined;
      const rows = await trx
        .selectFrom('acquisition')
        .select([
          'id',
          'status',
          sql<string>`purchase_price::text`.as('purchase_price'),
          'currency',
          'acquired_share_numerator',
          'acquired_share_denominator',
          sql<string>`to_char(contract_date, 'YYYY-MM-DD')`.as('contract_date'),
          sql<string | null>`to_char(economic_transfer_date, 'YYYY-MM-DD')`.as('economic_transfer_date'),
        ])
        .where('property_reference_id', '=', asset.propertyReferenceId)
        .where('mre_realm_id', '=', mreRealmId)
        .where('status', '<>', 'CANCELLED')
        .orderBy('id')
        .execute();
      const ids = rows.map((r) => r.id);
      const sellers =
        ids.length === 0
          ? []
          : await trx
              .selectFrom('acquisition_party')
              .select(['acquisition_id', 'party_id'])
              .where('acquisition_id', 'in', ids)
              .where('mre_realm_id', '=', mreRealmId)
              .where('role', '=', 'SELLER')
              .orderBy('acquisition_id')
              .orderBy('position')
              .execute();
      const costs =
        ids.length === 0
          ? []
          : await trx
              .selectFrom('acquisition_cost')
              .select(['id', 'acquisition_id', 'category', 'currency', sql<string>`amount::text`.as('amount')])
              .where('acquisition_id', 'in', ids)
              .where('mre_realm_id', '=', mreRealmId)
              .where('status', '=', 'ACTIVE')
              .orderBy('id')
              .execute();
      // The counting payments per cost (§27.2), for `ACQUISITION_COST_UNPAID`; the basis uses the expected amounts.
      const paid =
        ids.length === 0
          ? []
          : await trx
              .selectFrom('acquisition_payment as p')
              .innerJoin('ledger_transaction as t', 't.id', 'p.transaction_id')
              .select(['p.acquisition_cost_id', sql<string>`sum(p.amount)::text`.as('paid')])
              .where('p.acquisition_id', 'in', ids)
              .where('p.mre_realm_id', '=', mreRealmId)
              .where('p.acquisition_cost_id', 'is not', null)
              .where(COUNTING)
              .groupBy('p.acquisition_cost_id')
              .execute();
      const allocations =
        ids.length === 0
          ? []
          : await trx
              .selectFrom('land_building_allocation')
              .select([
                'id',
                'acquisition_id',
                'method',
                'review_state',
                'currency',
                sql<string>`total_allocable_amount::text`.as('total'),
                sql<string>`building_amount::text`.as('building'),
              ])
              .where('acquisition_id', 'in', ids)
              .where('mre_realm_id', '=', mreRealmId)
              .where('superseded_at', 'is', null)
              .execute();
      const ownerships = await trx
        .selectFrom('ownership')
        .select([
          'id',
          'owner_party_id',
          'share_numerator',
          'share_denominator',
          sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from'),
          sql<string | null>`to_char(valid_until, 'YYYY-MM-DD')`.as('valid_until'),
          'acquisition_id',
        ])
        .where('property_reference_id', '=', asset.propertyReferenceId)
        .where('mre_realm_id', '=', mreRealmId)
        .where('status', '=', 'VALID')
        .orderBy('valid_from')
        .orderBy('id')
        .execute();

      const paidOf = new Map(paid.map((p) => [p.acquisition_cost_id as string, p.paid]));
      // At most one current allocation per Acquisition (§27.3, the index `land_building_allocation_current`): checked
      // here too, so a read that saw a superseded one fails instead of taking whichever row comes first.
      const current = new Set<string>();
      for (const a of allocations) {
        if (current.has(a.acquisition_id)) throw new Error(`two current allocations for acquisition ${a.acquisition_id}`);
        current.add(a.acquisition_id);
      }
      const acquisitions = rows.map((r): ScheduleAcquisition => {
        const allocation = allocations.find((a) => a.acquisition_id === r.id);
        return {
          id: r.id,
          status: r.status,
          purchasePrice: fromNumericAmount(r.purchase_price, r.currency),
          acquiredShare: { numerator: r.acquired_share_numerator, denominator: r.acquired_share_denominator },
          contractDate: r.contract_date as BusinessDate,
          economicTransferDate: r.economic_transfer_date as BusinessDate | null,
          sellerPartyIds: sellers.filter((s) => s.acquisition_id === r.id).map((s) => s.party_id),
          costs: costs
            .filter((c) => c.acquisition_id === r.id)
            .map((c) => {
              const amount = fromNumericAmount(c.amount, c.currency);
              return {
                id: c.id,
                category: c.category,
                amount,
                paymentStatus: paymentStatusOf(amount, fromNumericAmount(paidOf.get(c.id) ?? '0', c.currency)),
              };
            }),
          allocation:
            allocation === undefined
              ? null
              : {
                  id: allocation.id,
                  method: allocation.method,
                  reviewState: allocation.review_state,
                  totalAllocableAmount: fromNumericAmount(allocation.total, allocation.currency),
                  buildingAmount: fromNumericAmount(allocation.building, allocation.currency),
                },
        };
      });
      // §59B: the links of the PropertyReference's ACTIVE separate assets (the building excludes their items).
      const linkRows = await trx
        .selectFrom('depreciation_asset_item')
        .select(['asset_id', 'source_type', 'source_id', 'source_position'])
        .where('property_reference_id', '=', asset.propertyReferenceId)
        .where('mre_realm_id', '=', mreRealmId)
        .where('asset_status', '=', 'ACTIVE')
        .execute();
      const links: AssetLink[] = linkRows.map((r) => ({
        assetId: r.asset_id,
        sourceType: r.source_type as ItemSourceType,
        sourceId: r.source_id,
        sourcePosition: r.source_position,
      }));
      const capitalizedItems = await capitalizedItemsIn(
        trx,
        mreRealmId,
        asset.propertyReferenceId,
        businessDayOf(this.now()),
        this.capitalizedSources,
        asset.items,
      );
      return {
        asset,
        acquisitions,
        capitalizedItems,
        links,
        ownerships: ownerships.map(
          (o): ScheduleOwnership => ({
            id: o.id,
            partyId: o.owner_party_id,
            share: { numerator: o.share_numerator, denominator: o.share_denominator },
            validFrom: o.valid_from as BusinessDate,
            validUntil: o.valid_until as BusinessDate | null,
            acquisitionId: o.acquisition_id,
          }),
        ),
        ownerPartyFound,
      };
    });
  }
}
