/**
 * Shared kernel: Money, Percentage, IDs, dates, result types. No business logic.
 * See docs/development/coding-guidelines.md §3–5.
 */
export {
  Money,
  MoneyError,
  RoundingMode,
  MAX_FACTOR_DIGITS,
  MAX_INTEGER_DIGITS,
  currencyScale,
  isSupportedCurrency,
} from './money.js';
export type { CurrencyCode, MoneyErrorCode, MoneyJson } from './money.js';
