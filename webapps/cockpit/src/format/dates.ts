/**
 * Dates in German (ui-guide.md §5.2). A business date (`YYYY-MM-DD`) is a calendar day without a time zone: it is
 * rearranged as text, never through `Date`, so it cannot move a day when the browser's zone changes. A technical
 * timestamp (ISO with zone) is shown in Europe/Berlin.
 */
const BUSINESS_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `2026-03-01` → `01.03.2026`; undefined for anything else. */
export function formatBusinessDate(value: string): string | undefined {
  const match = BUSINESS_DATE.exec(value);
  if (match === null) return undefined;
  const [, year, month, day] = match;
  return `${day}.${month}.${year}`;
}

const berlin = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' });

/** `2026-03-31T23:30:00.000Z` → `01.04.2026, 01:30` (Europe/Berlin); undefined when unreadable. */
export function formatTimestamp(value: string): string | undefined {
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : berlin.format(time);
}
