import type { ColumnType, Generated } from 'kysely';

/**
 * Kysely table types for the DE database, matching the migrations. Snake_case
 * columns stay inside infrastructure; repositories map them to domain types.
 */

/** jsonb: written as a JSON string, read back parsed by `pg`. */
type Json<T> = ColumnType<T, string, string>;

export interface PropertyReferenceTable {
  id: Generated<string>;
  mre_realm_id: string;
  mre_property_id: string;
  external_reference_state: string;
  display_name: string | null;
  cached_address: Json<Record<string, string> | null> | null;
  /** NUMERIC: written and read as a decimal string. */
  cached_surface: string | null;
  last_refreshed_at: Date | null;
  last_observed_at: Date | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface AuditRecordTable {
  id: Generated<string>;
  entity_type: string;
  entity_id: string;
  action: string;
  occurred_at: Generated<Date>;
  actor_type: 'USER' | 'SYSTEM';
  actor_id: string | null;
  metadata: Json<Record<string, unknown> | null> | null;
  previous_version: number | null;
  new_version: number | null;
}

export interface FinancialAccountTable {
  id: Generated<string>;
  mre_realm_id: string;
  account_type: string;
  display_name: string;
  currency: string;
  iban: string | null;
  status: string;
  closed_at: Date | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface PartyTable {
  id: Generated<string>;
  mre_realm_id: string;
  party_type: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  legal_name: string | null;
  registration_number: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  deactivated_at: Date | null;
  deactivation_reason: string | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface IdempotencyKeyTable {
  mre_realm_id: string;
  scope: string;
  key: string;
  request_fingerprint: string;
  resource_id: string | null;
  result: Json<unknown> | null;
  created_at: Generated<Date>;
}

export interface LedgerTransactionTable {
  id: Generated<string>;
  mre_realm_id: string;
  financial_account_id: string;
  /** NUMERIC: written and read as a decimal string (money-column.ts). */
  amount: string;
  currency: string;
  direction: string;
  /** date: always read through to_char as `YYYY-MM-DD` (transaction-repository.ts), never as a JS Date. */
  booking_date: string;
  value_date: string | null;
  description: string | null;
  property_reference_id: string | null;
  provenance: string;
  status: string;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
  /** Import identity (§70); null for manual Transactions. */
  import_batch_id: string | null;
  external_transaction_id: string | null;
  counterparty_name_raw: string | null;
  counterparty_iban_raw: string | null;
  adapter_id: string | null;
  adapter_version: string | null;
  source_statement_key: string | null;
  source_row_key: string | null;
  content_fingerprint: string | null;
  /** Set when a review item's `CREATE` resolution created this Transaction (§20A). */
  import_review_item_id: string | null;
  /** Set exactly for confirmed Transactions (CONFIRMED, RECONCILED, CORRECTED). */
  confirmed_at: Date | null;
  confirmed_by: string | null;
  /** Correction chain (VC-1-11): the original this reversal or replacement belongs to. */
  correction_of_transaction_id: string | null;
  correction_role: string | null;
}

export interface ImportBatchTable {
  id: string;
  mre_realm_id: string;
  financial_account_id: string;
  adapter_id: string;
  adapter_version: string;
  source_filename: string | null;
  content_hash: string;
  provenance: string;
  status: string;
  transaction_count: number;
  duplicate_count: number;
  needs_review_count: number;
  error_count: number;
  skipped_count: number;
  rows: Json<unknown[]>;
  imported_at: Generated<Date>;
  imported_by: string;
}

export interface ImportReviewItemTable {
  id: string;
  import_batch_id: string;
  mre_realm_id: string;
  financial_account_id: string;
  adapter_id: string;
  adapter_version: string;
  source_statement_key: string;
  source_row_key: string;
  content_fingerprint: string;
  normalized_row: Json<Record<string, unknown>>;
  ambiguity_reason: string;
  conflicting_transaction_ids: string[];
  prior_review_item_ids: string[];
  status: string;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_transaction_id: string | null;
  created_at: Generated<Date>;
}

export interface FinancialCategoryTable {
  id: Generated<string>;
  code: string;
  name: string;
  category_type: string;
  active: Generated<boolean>;
}

export interface TransactionSplitTable {
  id: Generated<string>;
  transaction_id: string;
  mre_realm_id: string;
  position: number;
  /** NUMERIC: written and read as a decimal string (money-column.ts). */
  amount: string;
  currency: string;
  financial_category_id: string;
  property_reference_id: string | null;
  description: string | null;
  created_at: Generated<Date>;
  created_by: string;
}

export interface Database {
  property_reference: PropertyReferenceTable;
  audit_record: AuditRecordTable;
  financial_account: FinancialAccountTable;
  idempotency_key: IdempotencyKeyTable;
  party: PartyTable;
  ledger_transaction: LedgerTransactionTable;
  import_batch: ImportBatchTable;
  import_review_item: ImportReviewItemTable;
  financial_category: FinancialCategoryTable;
  transaction_split: TransactionSplitTable;
}
