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

/** The day `days` after `date` (negative: before), as a business date. */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(0);
  shifted.setUTCFullYear(y, m - 1, d + days);
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(shifted.getUTCDate(), 2)}` as BusinessDate;
}

/**
 * The same day `months` later, clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). Always counted from
 * the original date, so a series from the 31st keeps the 31st where the month has it.
 */
export function addMonths(date: BusinessDate, months: number): BusinessDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12;
  const last = new Date(Date.UTC(2000, month + 1, 0)).getUTCDate();
  const leap = month === 1 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const day = Math.min(d, month === 1 ? (leap ? 29 : 28) : last);
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month + 1, 2)}-${pad(day, 2)}` as BusinessDate;
}
