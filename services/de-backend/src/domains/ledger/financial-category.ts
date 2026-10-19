/**
 * FinancialCategory (data-model.md §19): the economic classification of a
 * split, independent of tax treatment. A global, seeded catalog in Phase 1;
 * codes are stable once used and are deactivated, never reused.
 */

export const CATEGORY_TYPES = [
  'INCOME',
  'OPERATING_EXPENSE',
  'FINANCING',
  'CAPITAL_MOVEMENT',
  'SECURITY_DEPOSIT',
  'TRANSFER',
  'OTHER',
] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];

/** Upper-case code, e.g. `LOAN_INTEREST`. */
export const CATEGORY_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export interface FinancialCategory {
  readonly code: string;
  readonly name: string;
  readonly categoryType: CategoryType;
  readonly active: boolean;
}

export interface FinancialCategoryRepository {
  /** All categories, active first, then by code. */
  list(): Promise<readonly FinancialCategory[]>;
  findByCode(code: string): Promise<FinancialCategory | undefined>;
}
