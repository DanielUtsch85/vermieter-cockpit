import { sql, type Kysely } from 'kysely';
import type { ReconciliationStatus, RentTenantPage, RentTenantTermQueries, TenantTermReconciliation } from '../../domains/rent-reconciliation/index.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

/**
 * DE's side of api-design.md §37.7 (#364, VC-X-72): the Realm's Tenants grouped from its reconciliations and one
 * Tenant's reconciliations in a window of term keys, each in one `REPEATABLE READ READ ONLY` snapshot and filtered to
 * the Realm. Served by `rent_payment_reconciliation_term_idx (mre_realm_id, mre_tenant_id, mre_rent_term)`; no write.
 */
export class PostgresRentTenantTermQueries implements RentTenantTermQueries {
  constructor(private readonly db: Kysely<Database>) {}

  tenants(mreRealmId: string, page: { readonly page: number; readonly pageSize: number }): Promise<RentTenantPage> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const { n } = await trx
          .selectFrom('rent_payment_reconciliation')
          .where('mre_realm_id', '=', mreRealmId)
          .select(sql<string>`count(DISTINCT mre_tenant_id)`.as('n'))
          .executeTakeFirstOrThrow();
        const rows = await trx
          .selectFrom('rent_payment_reconciliation')
          .where('mre_realm_id', '=', mreRealmId)
          .groupBy('mre_tenant_id')
          .select((eb) => [
            'mre_tenant_id',
            eb.fn.max('mre_rent_term').as('latest_term'),
            eb.fn.countAll<string>().as('count'),
            eb.fn.max('created_at').as('latest_created_at'),
          ])
          // The Tenant matched last first; the id breaks a tie, so pages are stable.
          .orderBy('latest_created_at', 'desc')
          .orderBy('mre_tenant_id', 'asc')
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize)
          .execute();
        return {
          items: rows.map((r) => ({
            mreTenantId: r.mre_tenant_id,
            latestMreRentTerm: r.latest_term,
            reconciliationCount: Number(r.count),
            latestCreatedAt: r.latest_created_at,
          })),
          page: page.page,
          pageSize: page.pageSize,
          total: Number(n),
        };
      });
  }

  async tenantTerms(mreRealmId: string, mreTenantId: string, fromTerm: string, beforeTerm: string): Promise<readonly TenantTermReconciliation[]> {
    const rows = await this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute((trx) =>
        trx
          .selectFrom('rent_payment_reconciliation')
          .select(['mre_rent_term', 'status', sql<string>`matched_amount::text`.as('matched_amount'), 'currency'])
          .where('mre_realm_id', '=', mreRealmId)
          .where('mre_tenant_id', '=', mreTenantId)
          .where('mre_rent_term', '>=', fromTerm)
          .where('mre_rent_term', '<', beforeTerm)
          .orderBy('mre_rent_term')
          .orderBy('created_at')
          .orderBy('id')
          .execute(),
      );
    return rows.map((r) => ({
      mreRentTerm: r.mre_rent_term,
      status: r.status as ReconciliationStatus,
      matchedAmount: fromNumericAmount(r.matched_amount, r.currency),
    }));
  }
}
