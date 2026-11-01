import type { Kysely } from 'kysely';
import type { DepreciationAssetCommandsWithVersions } from './api/depreciation-assets.js';
import {
  amendDepreciationAsset,
  confirmDepreciationAsset,
  createDepreciationAsset,
  getDepreciationAsset,
  getDepreciationSchedule,
  getScheduleVersion,
  listPropertyDepreciationAssets,
  listScheduleVersions,
  recordScheduleVersion,
  voidDepreciationAsset,
} from './application/index.js';
import { sha256Fingerprinter } from './infrastructure/hashing/index.js';
import {
  PostgresDepreciationAssetRepository,
  PostgresDepreciationScheduleSource,
  PostgresScheduleVersionRepository,
  PostgresTaxClassificationRepository,
} from './infrastructure/postgres/index.js';
import type { Database } from './infrastructure/postgres/schema.js';

/**
 * The DepreciationAsset commands wired as `main.ts` wires them (api-design.md §59–§60), for the end-to-end tests. The
 * recording switch is stated by the test (§60 "Tests while it is off, and with it on": no environment variable is set
 * in a test); off by default, as the shipped installation. Test support only.
 */
export function depreciationCommands(
  db: Kysely<Database>,
  options: { readonly recordingEnabled?: boolean; readonly now?: () => Date } = {},
): DepreciationAssetCommandsWithVersions {
  const recordingEnabled = options.recordingEnabled ?? false;
  const clock = options.now === undefined ? {} : { now: options.now };
  const capitalizedSources = new PostgresTaxClassificationRepository(db).capitalizedSources;
  const assets = new PostgresDepreciationAssetRepository(db, { capitalizedSources, ...clock });
  const versions = new PostgresScheduleVersionRepository(db, capitalizedSources, options.now);
  return {
    create: createDepreciationAsset({ repository: assets }),
    get: getDepreciationAsset({ repository: assets, ...clock }),
    listForPropertyReference: listPropertyDepreciationAssets({ repository: assets, ...clock }),
    amend: amendDepreciationAsset({ repository: assets }),
    confirm: confirmDepreciationAsset({ repository: assets }),
    void: voidDepreciationAsset({ repository: assets, ...clock }),
    schedule: getDepreciationSchedule({
      source: new PostgresDepreciationScheduleSource(db, capitalizedSources, options.now),
      recordingEnabled,
      fingerprinter: sha256Fingerprinter,
      ...clock,
    }),
    recordVersion: recordScheduleVersion({ repository: versions, recordingEnabled, fingerprinter: sha256Fingerprinter, ...clock }),
    listVersions: listScheduleVersions({ repository: versions }),
    getVersion: getScheduleVersion({ repository: versions, fingerprinter: sha256Fingerprinter, ...clock }),
  };
}
