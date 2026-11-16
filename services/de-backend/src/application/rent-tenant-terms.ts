import { coverageOf, matchedTotalOf, type Coverage, type RentTenantPage, type RentTenantTermQueries } from '../domains/rent-reconciliation/index.js';
import type { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { MreUnavailableError } from './errors.js';
import type { MreTenantLookup } from './party-external-references.js';
import type { MreMonthReader, MreStatus } from './rent-reconciliations.js';

/**
 * Choosing the Tenant and the term (api-design.md §37.7, #364, backlog VC-X-72): the Realm's Tenants from its
 * reconciliations, and one Tenant's terms in a window from MRE's month reads beside DE's matches. Reads only, never a
 * write; no name of a Tenant is read or kept (mre-integration.md §20.1).
 */

export type ListRentTenants = (input: {
  readonly principal: RealmPrincipal;
  readonly page: { readonly page: number; readonly pageSize: number };
}) => Promise<RentTenantPage>;

/** §37.7 (a): DE alone, never MRE; a Realm without reconciliations is an empty page. */
export function listRentTenants(deps: { readonly queries: RentTenantTermQueries }): ListRentTenants {
  return ({ principal, page }) => deps.queries.tenants(principal.mreRealmId, page);
}

export interface TenantTermItem {
  readonly mreRentTerm: string;
  /** `YYYY-MM`, the key's first six digits. */
  readonly month: string;
  /** Whether MRE's month read listed the term; `null` unless `AVAILABLE`. */
  readonly inMre: boolean | null;
  readonly amountDue: Money | null;
  readonly matchedTotal: Money;
  readonly reconciliationCount: number;
  readonly coverage: Coverage | null;
  readonly openAmount: Money | null;
}

export interface TenantTerms {
  readonly mreTenantId: string;
  readonly from: string;
  readonly to: string;
  readonly mreStatus: MreStatus;
  readonly items: readonly TenantTermItem[];
}

export type GetTenantTerms = (input: {
  readonly principal: RealmPrincipal;
  readonly authorizationHeader: string;
  readonly mreTenantId: string;
  /** `YYYY-MM`, validated at the API (from ≤ to, at most 12 months). */
  readonly from: string;
  readonly to: string;
}) => Promise<TenantTerms>;

/** `YYYY-MM` as a month count from year 0, and back as the first term key of that month (`YYYYMM0000`). */
const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const monthOf = (i: number) => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });
const firstKeyOf = (i: number) => `${monthOf(i).year}${String(monthOf(i).month).padStart(2, '0')}0000`;

type MreSide = { readonly status: 'AVAILABLE'; readonly due: ReadonlyMap<string, Money> } | { readonly status: Exclude<MreStatus, 'AVAILABLE'> };

/**
 * §37.7 (b): MRE's side, read live outside any database transaction: the Tenant checked against the Realm's list, then
 * each month of the window. Any call MRE cannot answer is `UNAVAILABLE`, a single month included (no partial list); a
 * refused token or caller stays an error.
 */
async function readMreSide(
  deps: { readonly lookupMreTenant: MreTenantLookup; readonly readMreMonth: MreMonthReader },
  input: { readonly authorizationHeader: string; readonly mreRealmId: string; readonly mreTenantId: string; readonly first: number; readonly last: number },
): Promise<MreSide> {
  try {
    if (!(await deps.lookupMreTenant(input.authorizationHeader, input.mreRealmId, input.mreTenantId))) return { status: 'NOT_RETURNED' };
    const due = new Map<string, Money>();
    for (let i = input.first; i <= input.last; i++) {
      const { year, month } = monthOf(i);
      const key = firstKeyOf(i).slice(0, 6);
      for (const rent of await deps.readMreMonth(input.authorizationHeader, input.mreRealmId, year, month)) {
        // Only the Tenant's own terms of this month; the other Tenants' rents are dropped unread.
        if (rent.mreTenantId === input.mreTenantId && rent.term.startsWith(key)) due.set(rent.term, rent.amountDue);
      }
    }
    return { status: 'AVAILABLE', due };
  } catch (error) {
    if (error instanceof MreUnavailableError) return { status: 'UNAVAILABLE' };
    throw error;
  }
}

/**
 * §37.7 (b): one item per term key found on either side, newest first. DE's side is answered whatever `mreStatus` is
 * (BR-MRE-004): an outage or a Tenant MRE does not list never hides DE's matches.
 */
export function getTenantTerms(deps: {
  readonly queries: RentTenantTermQueries;
  readonly lookupMreTenant: MreTenantLookup;
  readonly readMreMonth: MreMonthReader;
}): GetTenantTerms {
  return async ({ principal, authorizationHeader, mreTenantId, from, to }) => {
    const first = monthIndex(from);
    const last = monthIndex(to);
    const mre = await readMreSide(deps, { authorizationHeader, mreRealmId: principal.mreRealmId, mreTenantId, first, last });
    const de = await deps.queries.tenantTerms(principal.mreRealmId, mreTenantId, firstKeyOf(first), firstKeyOf(last + 1));
    const keys = new Set([...de.map((r) => r.mreRentTerm), ...(mre.status === 'AVAILABLE' ? mre.due.keys() : [])]);
    const items = [...keys]
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
      .map((term): TenantTermItem => {
        const own = de.filter((r) => r.mreRentTerm === term);
        const matchedTotal = matchedTotalOf(own);
        const amountDue = mre.status === 'AVAILABLE' ? (mre.due.get(term) ?? null) : null;
        const covered = amountDue === null ? null : coverageOf(amountDue, matchedTotal);
        return {
          mreRentTerm: term,
          month: `${term.slice(0, 4)}-${term.slice(4, 6)}`,
          inMre: mre.status === 'AVAILABLE' ? mre.due.has(term) : null,
          amountDue,
          matchedTotal,
          reconciliationCount: own.length,
          coverage: covered?.coverage ?? null,
          openAmount: covered?.openAmount ?? null,
        };
      });
    return { mreTenantId, from, to, mreStatus: mre.status, items };
  };
}
