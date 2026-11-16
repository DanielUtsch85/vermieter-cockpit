import type { Money } from '../../shared/index.js';
import type { ReconciliationStatus } from './reconciliation.js';

/**
 * The DE side of choosing the Tenant and the term (api-design.md §37.7, #364, backlog VC-X-72): the port the
 * application reads through and PostgreSQL implements. Reads only; no name of a Tenant is part of it.
 */

/** One distinct `mreTenantId` of the Realm's reconciliations, any status (§37.7 (a), open question 2). */
export interface RentTenantSummary {
  readonly mreTenantId: string;
  /** The highest term key among the Tenant's reconciliations. */
  readonly latestMreRentTerm: string;
  readonly reconciliationCount: number;
  readonly latestCreatedAt: Date;
}

export interface RentTenantPage {
  readonly items: readonly RentTenantSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** What the term list reads of one reconciliation: its term, status and amount. */
export interface TenantTermReconciliation {
  readonly mreRentTerm: string;
  readonly status: ReconciliationStatus;
  readonly matchedAmount: Money;
}

/** Each read in one `REPEATABLE READ READ ONLY` snapshot, filtered to the Realm. */
export interface RentTenantTermQueries {
  /** The distinct Tenants, `latestCreatedAt` descending, then `mreTenantId`; `total` and `items` in one snapshot. */
  tenants(mreRealmId: string, page: { readonly page: number; readonly pageSize: number }): Promise<RentTenantPage>;
  /** The Tenant's reconciliations whose term key lies in [`fromTerm`, `beforeTerm`), any status. */
  tenantTerms(mreRealmId: string, mreTenantId: string, fromTerm: string, beforeTerm: string): Promise<readonly TenantTermReconciliation[]>;
}
