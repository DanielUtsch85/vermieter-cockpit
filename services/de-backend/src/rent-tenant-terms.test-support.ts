import type { Kysely } from 'kysely';
import { getTenantTerms, listRentTenants } from './application/index.js';
import { PostgresRentTenantTermQueries } from './infrastructure/postgres/index.js';
import type { Database } from './infrastructure/postgres/schema.js';
import type { MreClient } from './integrations/mre/index.js';
import { mreMonthReader, mreTenantLookup } from './wiring.js';

/** §37.7's two reads (#364, VC-X-72) wired as in main.ts, for the acceptance suites' full command sets. Test support only. */
export function rentTenantTermCommands(db: Kysely<Database>, client: MreClient) {
  const queries = new PostgresRentTenantTermQueries(db);
  return {
    tenants: listRentTenants({ queries }),
    tenantTerms: getTenantTerms({ queries, lookupMreTenant: mreTenantLookup(client), readMreMonth: mreMonthReader(client) }),
  };
}
