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

export interface PartyExternalReferenceTable {
  id: Generated<string>;
  party_id: string;
  mre_realm_id: string;
  system: string;
  entity_type: string;
  external_id: string;
  status: string;
  ended_at: Date | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface OwnershipTable {
  id: Generated<string>;
  mre_realm_id: string;
  property_reference_id: string;
  owner_party_id: string;
  share_numerator: number;
  share_denominator: number;
  /** `date` columns: written as `YYYY-MM-DD`, read through `to_char` (the pg driver would make them local Dates). */
  valid_from: string;
  valid_until: string | null;
  status: string;
  voided_at: Date | null;
  acquisition_id: string | null;
  void_reason: string | null;
  source_references: Generated<string[]>;
  notes: string | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface AcquisitionTable {
  id: Generated<string>;
  mre_realm_id: string;
  property_reference_id: string;
  status: string;
  purchase_price: string;
  currency: string;
  acquired_share_numerator: number;
  acquired_share_denominator: number;
  /** `date` columns: written as `YYYY-MM-DD`, read through `to_char`. */
  contract_date: string;
  economic_transfer_date: string | null;
  land_registry_transfer_date: string | null;
  source_references: Generated<string[]>;
  notes: string | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  confirmed_at: Date | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface AcquisitionPartyTable {
  acquisition_id: string;
  mre_realm_id: string;
  party_id: string;
  role: string;
  position: number;
}

export interface AcquisitionCostTable {
  id: Generated<string>;
  mre_realm_id: string;
  acquisition_id: string;
  category: string;
  amount: string;
  currency: string;
  /** `date` column: written as `YYYY-MM-DD`, read through `to_char`. */
  incurred_date: string | null;
  counterparty_party_id: string | null;
  source_references: Generated<string[]>;
  notes: string | null;
  status: string;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface AcquisitionPaymentTable {
  id: Generated<string>;
  mre_realm_id: string;
  acquisition_id: string;
  acquisition_cost_id: string | null;
  transaction_id: string;
  amount: string;
  currency: string;
  unlinked_at: Date | null;
  unlink_reason: string | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface LoanTable {
  id: Generated<string>;
  mre_realm_id: string;
  status: string;
  lender_party_id: string;
  borrower_party_ids: string[];
  principal_original: string;
  currency: string;
  /** `date` columns: written as `YYYY-MM-DD`, read through `to_char`. */
  start_date: string;
  disbursement_date: string | null;
  maturity_date: string | null;
  contract_number: string | null;
  acquisition_id: string | null;
  source_references: Generated<string[]>;
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  closing_date: string | null;
  closing_reason: string | null;
  refinanced_by_loan_id: string | null;
  closing_note: string | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface LoanTermsTable {
  id: Generated<string>;
  mre_realm_id: string;
  loan_id: string;
  status: string;
  /** `date` columns: written as `YYYY-MM-DD`, read through `to_char`. */
  valid_from: string;
  interest_rate: string;
  repayment_model: string;
  scheduled_payment: string | null;
  first_payment_date: string;
  principal_at_start: string | null;
  fixed_rate_until: string | null;
  initial_repayment_rate: string | null;
  special_repayment_limit: string | null;
  currency: string;
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface LoanBalanceStatementTable {
  id: Generated<string>;
  mre_realm_id: string;
  loan_id: string;
  status: string;
  /** `date` columns: written as `YYYY-MM-DD`, read through `to_char`. */
  statement_date: string;
  balance: string;
  currency: string;
  source: string;
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface RentPaymentReconciliationTable {
  id: Generated<string>;
  mre_realm_id: string;
  status: string;
  transaction_id: string;
  mre_tenant_id: string;
  mre_rent_term: string;
  matched_amount: string;
  currency: string;
  confidence: string | null;
  suggestion_reason: string | null;
  confirmed_at: Date | null;
  confirmed_by: string | null;
  released_at: Date | null;
  released_by: string | null;
  release_reason: string | null;
  rejected_at: Date | null;
  rejected_by: string | null;
  reject_reason: string | null;
  notes: string | null;
  mre_write_back_state: Generated<string>;
  mre_write_back_attempt_id: string | null;
  mre_write_back_lease_until: Date | null;
  mre_written_back_at: Date | null;
  mre_written_back_by: string | null;
  mre_payment: unknown;
  mre_write_back_error: string | null;
  mre_write_back_failed_at: Date | null;
  mre_last_lease_until: Date | null;
  mre_removed_at: Date | null;
  mre_removed_by: string | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface LoanAllocationSetTable {
  id: Generated<string>;
  mre_realm_id: string;
  loan_id: string;
  status: string;
  /** `date` columns: written as `YYYY-MM-DD`, read through `to_char`. */
  valid_from: string;
  basis: string;
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  version: Generated<number>;
}

export interface LoanAllocationTable {
  set_id: string;
  mre_realm_id: string;
  position: number;
  property_reference_id: string;
  /** `numeric` integers: written and read as text (exact, unbounded). */
  share_numerator: string;
  share_denominator: string;
  acquisition_id: string | null;
}

export interface LandBuildingAllocationTable {
  id: Generated<string>;
  mre_realm_id: string;
  acquisition_id: string;
  total_allocable_amount: string;
  land_amount: string;
  building_amount: string;
  currency: string;
  method: string;
  review_state: string;
  /** `date` column: written as `YYYY-MM-DD`, read through `to_char`. */
  effective_date: string;
  advisor_party_id: string | null;
  source_references: Generated<string[]>;
  notes: string | null;
  supersedes_id: string | null;
  superseded_at: Date | null;
  created_at: Generated<Date>;
  created_by: string;
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
  /** The bank's running balance after the booking, as imported (§70.6); fixed after creation. */
  source_balance_after: string | null;
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
  /** The continuity report (§70.6); null for a file without a balance column. */
  continuity: Json<unknown> | null;
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
  /** VC-3-05; optional on insert (NULL: no Loan). */
  loan_id: Generated<string | null>;
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
  party_external_reference: PartyExternalReferenceTable;
  ownership: OwnershipTable;
  acquisition: AcquisitionTable;
  acquisition_party: AcquisitionPartyTable;
  acquisition_cost: AcquisitionCostTable;
  acquisition_payment: AcquisitionPaymentTable;
  land_building_allocation: LandBuildingAllocationTable;
  loan: LoanTable;
  loan_terms: LoanTermsTable;
  loan_allocation_set: LoanAllocationSetTable;
  loan_allocation: LoanAllocationTable;
  loan_balance_statement: LoanBalanceStatementTable;
  rent_payment_reconciliation: RentPaymentReconciliationTable;
  ledger_transaction: LedgerTransactionTable;
  import_batch: ImportBatchTable;
  import_review_item: ImportReviewItemTable;
  financial_category: FinancialCategoryTable;
  transaction_split: TransactionSplitTable;
}
