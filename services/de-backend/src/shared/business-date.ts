/** Business date `YYYY-MM-DD` (api-design.md §88); never a timestamp. */
export type BusinessDate = string & { readonly __brand: 'BusinessDate' };

const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Plausible years for a cash movement (api-design.md §88). A typo like `0202`
 * would otherwise book silently into the year 202 and distort every period.
 */
export const BUSINESS_DATE_MIN_YEAR = 1900;
export const BUSINESS_DATE_MAX_YEAR = 2100;

export type BusinessDateError = 'INVALID_FORMAT' | 'OUT_OF_RANGE';

/** A real calendar date `YYYY-MM-DD` within the plausible years, or why not. */
export function checkBusinessDate(value: string): { readonly date: BusinessDate } | { readonly error: BusinessDateError } {
  const match = BUSINESS_DATE.exec(value);
  if (match === null) return { error: 'INVALID_FORMAT' };
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0–99 to 1900–1999.
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return { error: 'INVALID_FORMAT' };
  if (y < BUSINESS_DATE_MIN_YEAR || y > BUSINESS_DATE_MAX_YEAR) return { error: 'OUT_OF_RANGE' };
  return { date: value as BusinessDate };
}

/** A valid, plausible business date, or undefined (see checkBusinessDate for the reason). */
export function parseBusinessDate(value: string): BusinessDate | undefined {
  const result = checkBusinessDate(value);
  return 'date' in result ? result.date : undefined;
}

