import type { Migration } from 'kysely/migration';
import * as m0001 from './0001_baseline.js';
import * as m0002 from './0002_property_reference.js';
import * as m0003 from './0003_property_reference_refresh.js';
import * as m0004 from './0004_financial_account.js';
import * as m0005 from './0005_ledger_transaction.js';
import * as m0006 from './0006_bank_import.js';
import * as m0007 from './0007_import_review.js';
import * as m0008 from './0008_transaction_split.js';
import * as m0009 from './0009_confirm_transaction.js';
import * as m0010 from './0010_confirm_split_invariant.js';
import * as m0011 from './0011_correct_transaction.js';
import * as m0012 from './0012_reverse_transaction.js';
import * as m0013 from './0013_freeze_transaction_version.js';
import * as m0014 from './0014_reversal_mirrors_splits.js';
import * as m0015 from './0015_transaction_page_index.js';
import * as m0016 from './0016_party.js';
import * as m0017 from './0017_party_external_reference.js';
import * as m0018 from './0018_party_guards.js';
import * as m0019 from './0019_ownership.js';
import * as m0020 from './0020_acquisition.js';
import * as m0021 from './0021_acquisition_cost.js';
import * as m0022 from './0022_acquisition_confirm.js';
import * as m0023 from './0023_land_building_allocation.js';
import * as m0024 from './0024_loan.js';
import * as m0025 from './0025_loan_terms.js';
import * as m0026 from './0026_loan_allocation.js';
import * as m0027 from './0027_loan_payment.js';
import * as m0028 from './0028_loan_balance_statement.js';
import * as m0029 from './0029_loan_close.js';
import * as m0030 from './0030_rent_payment_reconciliation.js';
import * as m0031 from './0031_rent_reconciliation_suggestions.js';
import * as m0032 from './0032_rent_reconciliation_write_back.js';
import * as m0033 from './0033_rent_reconciliation_removal.js';
import * as m0034 from './0034_import_balance_identity.js';
import * as m0035 from './0035_correction_counterparty.js';
import * as m0036 from './0036_rent_suggestion_reasons.js';
import * as m0037 from './0037_security_deposit.js';
import * as m0038 from './0038_security_deposit_split.js';
import * as m0039 from './0039_security_deposit_close.js';
import * as m0040 from './0040_weg.js';
import * as m0041 from './0041_weg_plan_and_splits.js';
import * as m0042 from './0042_weg_annual_statement.js';
import * as m0043 from './0043_weg_statement_settlement.js';
import * as m0044 from './0044_weg_special_assessment.js';
import * as m0045 from './0045_tax_classification.js';
import * as m0046 from './0046_tax_year_and_income.js';
import * as m0047 from './0047_tax_weg_spending.js';
import * as m0048 from './0048_tax_year_view.js';

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
  '0005_ledger_transaction': m0005,
  '0006_bank_import': m0006,
  '0007_import_review': m0007,
  '0008_transaction_split': m0008,
  '0009_confirm_transaction': m0009,
  '0010_confirm_split_invariant': m0010,
  '0011_correct_transaction': m0011,
  '0012_reverse_transaction': m0012,
  '0013_freeze_transaction_version': m0013,
  '0014_reversal_mirrors_splits': m0014,
  '0015_transaction_page_index': m0015,
  '0016_party': m0016,
  '0017_party_external_reference': m0017,
  '0018_party_guards': m0018,
  '0019_ownership': m0019,
  '0020_acquisition': m0020,
  '0021_acquisition_cost': m0021,
  '0022_acquisition_confirm': m0022,
  '0023_land_building_allocation': m0023,
  '0024_loan': m0024,
  '0025_loan_terms': m0025,
  '0026_loan_allocation': m0026,
  '0027_loan_payment': m0027,
  '0028_loan_balance_statement': m0028,
  '0029_loan_close': m0029,
  '0030_rent_payment_reconciliation': m0030,
  '0031_rent_reconciliation_suggestions': m0031,
  '0032_rent_reconciliation_write_back': m0032,
  '0033_rent_reconciliation_removal': m0033,
  '0034_import_balance_identity': m0034,
  '0035_correction_counterparty': m0035,
  '0036_rent_suggestion_reasons': m0036,
  '0037_security_deposit': m0037,
  '0038_security_deposit_split': m0038,
  '0039_security_deposit_close': m0039,
  '0040_weg': m0040,
  '0041_weg_plan_and_splits': m0041,
  '0042_weg_annual_statement': m0042,
  '0043_weg_statement_settlement': m0043,
  '0044_weg_special_assessment': m0044,
  '0045_tax_classification': m0045,
  '0046_tax_year_and_income': m0046,
  '0047_tax_weg_spending': m0047,
  '0048_tax_year_view': m0048,
};
