/**
 * Shared kernel: Money, Percentage, IDs, dates, result types. No business logic.
 * See docs/development/coding-guidelines.md §3–5.
 */
export { ExactDecimal, ExactDecimalError, RoundingMode } from './exact-decimal.js';
export type { ExactDecimalErrorCode } from './exact-decimal.js';
export { Money, MoneyError, MAX_INTEGER_DIGITS, currencyScale, isSupportedCurrency } from './money.js';
export type { CurrencyCode, MoneyErrorCode, MoneyJson } from './money.js';
export type { AuditActor } from './audit.js';
