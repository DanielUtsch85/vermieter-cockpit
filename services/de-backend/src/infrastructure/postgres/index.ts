/**
 * PostgreSQL infrastructure adapters (ADR-031). Implements persistence ports for
 * the domains; domain code never imports from here (coding-guidelines §3).
 */
export { fromNumericAmount, toNumericAmount } from './money-column.js';
