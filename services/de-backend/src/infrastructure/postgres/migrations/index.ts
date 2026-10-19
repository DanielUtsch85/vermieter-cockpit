import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_baseline.js';

/**
 * All DE migrations, in order. Listed statically (instead of scanning the
 * directory at runtime) so the same set runs from `src/` in tests and from the
 * compiled `dist/` in containers. Names are permanent once released — never
 * rename or edit an applied migration; add a new one.
 */
export const migrations: Record<string, Migration> = {
  '0001_baseline': m0001,
};
