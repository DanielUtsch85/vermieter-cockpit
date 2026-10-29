/**
 * Bank import integration: format-specific statement adapters behind the
 * ledger's BankStatementAdapter port (technology.md §13). New formats are added
 * here and registered below; the ledger stays format-agnostic.
 */
import type { BankStatementAdapter } from '../../domains/ledger/index.js';
import { genericCsvAdapter, genericCsvAdapterV2 } from './generic-csv.js';

export {
  GENERIC_CSV_ID,
  GENERIC_CSV_PRESETS,
  GENERIC_CSV_VERSION,
  GENERIC_CSV_VERSION_2,
  MAX_ROWS,
  genericCsvAdapter,
  genericCsvAdapterV2,
  genericCsvOptions,
  genericCsvOptionsV2,
} from './generic-csv.js';
export type { GenericCsvOptions } from './generic-csv.js';

/** All adapters by `${id}@${version}`; an import names both (api-design.md §32.1). */
export const bankStatementAdapters: ReadonlyMap<string, BankStatementAdapter> = new Map(
  [genericCsvAdapter, genericCsvAdapterV2].map((adapter) => [`${adapter.id}@${adapter.version}`, adapter]),
);

export function findBankStatementAdapter(id: string, version: string): BankStatementAdapter | undefined {
  return bankStatementAdapters.get(`${id}@${version}`);
}
