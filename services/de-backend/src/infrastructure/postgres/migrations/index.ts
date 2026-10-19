import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_baseline.js';
import * as m0002 from './0002_property_reference.js';
import * as m0003 from './0003_property_reference_refresh.js';
import * as m0004 from './0004_financial_account.js';

/**
 * All DE migrations, in order. Listed statically (instead of scanning the
 * directory at runtime) so the same set runs from `src/` in tests and from the
 * compiled `dist/` in containers. Names are permanent once released — never
 * rename or edit an applied migration; add a new one.
 */
export const migrations: Record<string, Migration> = {
  '0001_baseline': m0001,
  '0002_property_reference': m0002,
  '0003_property_reference_refresh': m0003,
  '0004_financial_account': m0004,
};
