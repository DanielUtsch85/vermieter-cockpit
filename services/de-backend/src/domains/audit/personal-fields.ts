/**
 * VC-X-24 (api-design.md §58U; Entscheidung des Projektinhabers, 2026-11-06): the personal values in the history of
 * `AMENDED` AuditRecords, kept as written for ten years from the end of the record's creation year (§ 147 Abs. 4 AO) and
 * then pseudonymised: each value is replaced by the fixed marker `[entfernt:v1]`. No key exists, so nothing can be
 * recovered; the record keeps its keys and field names, so it still says which field changed and when. Never deleted.
 *
 * The allow-list is fixed here and, written out again, in the guard of migration 0076 (`audit_metadata_pseudonymised`):
 * only a Party's seven fields (decision 2), only in `AMENDED` records (decision 3). A Party field added later is not
 * listed by itself; it needs a decision and a migration of its own.
 */

/** The marker that replaces a personal value. `v1` lets the guard's pattern carry a version. */
export const AUDIT_MARKER = '[entfernt:v1]';
/** The guard's pattern (0076): `[entfernt:v<n>]`. */
export const AUDIT_MARKER_PATTERN = /^\[entfernt:v[1-9][0-9]*\]$/;

/** The one action whose history is pseudonymised. */
export const AUDIT_PSEUDONYMISABLE_ACTION = 'AMENDED';
/** The action of the record that documents a pseudonymisation (decision 7). */
export const AUDIT_PSEUDONYMISED_ACTION = 'AUDIT_PSEUDONYMISED';

/** Per `entity_type`: the fields under `changes.<field>.{from,to}` whose values are personal. */
export const AUDIT_PERSONAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Party: ['displayName', 'firstName', 'lastName', 'legalName', 'registrationNumber', 'email', 'phone'],
};
export const AUDIT_PSEUDONYMISABLE_ENTITY_TYPES = Object.keys(AUDIT_PERSONAL_FIELDS);

/** Ten years of § 147 Abs. 4 AO, from the end of the creation year (decision 1). */
export const AUDIT_RETENTION_YEARS = 10;
const ZONE = 'Europe/Berlin';

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The wall clock in Europe/Berlin at `instant`, read as if it were UTC (milliseconds dropped). */
function berlinWallClock(instant: Date): { year: number; asUtc: number } {
  const part = (type: string) => Number(PARTS.formatToParts(instant).find((p) => p.type === type)?.value);
  const year = part('year');
  return { year, asUtc: Date.UTC(year, part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) };
}

/** The calendar year of `instant` in Europe/Berlin: the record's creation year (`2026-12-31T23:30:00Z` is 2027). */
export function berlinYear(instant: Date): number {
  return berlinWallClock(instant).year;
}

/** `01.01.year 00:00` in Europe/Berlin as an instant (the offset read from the zone, not assumed). */
export function berlinStartOfYear(year: number): Date {
  const midnightUtc = Date.UTC(year, 0, 1);
  let guess = midnightUtc;
  for (let i = 0; i < 2; i += 1) guess = midnightUtc - (berlinWallClock(new Date(guess)).asUtc - guess);
  return new Date(guess);
}

/** The last day of retention of a record created at `occurredAt`: `31.12.(Y + 10)`. */
export function auditRetentionEndsOn(occurredAt: Date): string {
  return `${berlinYear(occurredAt) + AUDIT_RETENTION_YEARS}-12-31`;
}

/** The instant from which a record created at `occurredAt` is due: `01.01.(Y + 11) 00:00` Europe/Berlin. */
export function auditDueFrom(occurredAt: Date): Date {
  return berlinStartOfYear(berlinYear(occurredAt) + AUDIT_RETENTION_YEARS + 1);
}

/**
 * At `now`, every record created before this instant is due: `01.01.(N − 10) 00:00` Europe/Berlin with `N` the year of
 * `now` in Europe/Berlin. (`Y + 11 <= N` iff `Y < N − 10`.)
 */
export function auditRetentionCutoff(now: Date): Date {
  return berlinStartOfYear(berlinYear(now) - AUDIT_RETENTION_YEARS);
}

/** Due exactly at `01.01.(Y + 11) 00:00` Europe/Berlin, not one millisecond before. */
export function isAuditRecordDue(occurredAt: Date, now: Date): boolean {
  return occurredAt.getTime() < auditRetentionCutoff(now).getTime();
}

export interface PseudonymisedMetadata {
  readonly metadata: Record<string, unknown>;
  /** The replaced paths, `changes.<field>.<from|to>`, in allow-list order. */
  readonly paths: readonly string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The metadata of an `AMENDED` record with every personal value replaced by the marker, and the replaced paths; or
 * `undefined` when there is nothing to replace (another entity type, no listed field, only `null` values or markers):
 * such a record is left unchanged and not marked. `null` stays `null` (it is no personal value); every key, every other
 * value and the order of the keys stay as they are. The input is not changed.
 */
export function pseudonymiseAuditMetadata(entityType: string, metadata: unknown): PseudonymisedMetadata | undefined {
  const fields = AUDIT_PERSONAL_FIELDS[entityType];
  if (fields === undefined || !isObject(metadata) || !isObject(metadata['changes'])) return undefined;
  const changes: Record<string, unknown> = { ...metadata['changes'] };
  const paths: string[] = [];
  for (const field of fields) {
    const change = changes[field];
    if (!isObject(change)) continue;
    const replaced: Record<string, unknown> = { ...change };
    for (const side of ['from', 'to'] as const) {
      if (!Object.hasOwn(change, side)) continue;
      const value = change[side];
      if (value === null || value === AUDIT_MARKER) continue;
      replaced[side] = AUDIT_MARKER;
      paths.push(`changes.${field}.${side}`);
    }
    changes[field] = replaced;
  }
  if (paths.length === 0) return undefined;
  return { metadata: { ...metadata, changes }, paths };
}
