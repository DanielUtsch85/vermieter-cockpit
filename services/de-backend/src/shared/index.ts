/**
 * Shared kernel: Money, Percentage, IDs, dates, result types. No business logic.
 * See docs/development/coding-guidelines.md §3–5.
 */
export { ExactDecimal, ExactDecimalError, RoundingMode } from './exact-decimal.js';
export type { ExactDecimalErrorCode } from './exact-decimal.js';
export { Money, MoneyError, MAX_INTEGER_DIGITS, currencyScale, isSupportedCurrency } from './money.js';
export type { CurrencyCode, MoneyErrorCode, MoneyJson } from './money.js';
export type { AuditActor } from './audit.js';
export { normalizeIban } from './iban.js';
export { checkVersion } from './version.js';
export type { VersionConflict } from './version.js';
export { BUSINESS_DATE_MAX_YEAR, BUSINESS_DATE_MIN_YEAR, addDays, addMonths, checkBusinessDate, parseBusinessDate } from './business-date.js';
export type { BusinessDate, BusinessDateError } from './business-date.js';
