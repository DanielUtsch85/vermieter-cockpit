import { sql, type Kysely } from 'kysely';
import type { BusinessDate } from '../../domains/ledger/index.js';
import type { Database } from './schema.js';

/** The booking dates of a batch's rows, duplicates included (api-design.md §32.6, VC-X-75); both `null` when no row counts. */
export interface BookingRange {
  readonly firstBookingDate: BusinessDate | null;
  readonly lastBookingDate: BusinessDate | null;
}

export const NO_BOOKING_RANGE: BookingRange = { firstBookingDate: null, lastBookingDate: null };

/**
 * The earliest and latest booking date of each batch in `batchIds` (api-design.md §32.6, VC-X-75), from the rows the
 * batch stored:
 * - the booking date of the Transaction each `created` row and each `duplicate` row of an imported Transaction names
 *   (`rows[].transactionId`; a booking date of an imported Transaction is fixed, §31.3), read by its primary key;
 * - `normalizedRow.bookingDate` of the resolved review item each `duplicate` row of a review item names
 *   (`rows[].reviewItemId`, owned by an earlier batch), read by its primary key (Entscheidung des Projektinhabers,
 *   2026-11-16: „Duplikatzeilen zählen über das Buchungsdatum der Buchung oder des Klärfalls, den sie nennen.“);
 * - `normalizedRow.bookingDate` of each review item the batch owns, `PENDING` or `RESOLVED`, read through
 *   `import_review_item_batch_idx` (a `CREATE` resolution books that same date).
 * Not counted: rows re-presenting another batch's `PENDING` item (counted there, as `needsReviewCount`), `error` and
 * `skipped` rows (no parsed row is stored).
 *
 * One statement, so it reads the caller's snapshot when `db` is its transaction. Every table is held to the Realm.
 * No index of its own: the batches by primary key, the Transactions and named review items by primary key, the own
 * review items by their batch.
 */
export async function bookingRanges(db: Kysely<Database>, mreRealmId: string, batchIds: readonly string[]): Promise<Map<string, BookingRange>> {
  if (batchIds.length === 0) return new Map();
  const { rows } = await sql<{ batch_id: string; first: string | null; last: string | null }>`
    SELECT d.batch_id, to_char(min(d.booking_date), 'YYYY-MM-DD') AS first, to_char(max(d.booking_date), 'YYYY-MM-DD') AS last
    FROM (
      SELECT b.id AS batch_id, t.booking_date
      FROM import_batch b
      CROSS JOIN LATERAL jsonb_array_elements(b.rows) AS r(outcome)
      JOIN ledger_transaction t ON t.id = (r.outcome->>'transactionId')::uuid AND t.mre_realm_id = b.mre_realm_id
      WHERE b.id = ANY(${[...batchIds]}::uuid[]) AND b.mre_realm_id = ${mreRealmId}
        AND (r.outcome->>'outcome' = 'created' OR (r.outcome->>'outcome' = 'duplicate' AND r.outcome->>'duplicateOf' = 'TRANSACTION'))
      UNION ALL
      SELECT b.id, (i.normalized_row->>'bookingDate')::date
      FROM import_batch b
      CROSS JOIN LATERAL jsonb_array_elements(b.rows) AS r(outcome)
      JOIN import_review_item i ON i.id = (r.outcome->>'reviewItemId')::uuid AND i.mre_realm_id = b.mre_realm_id
      WHERE b.id = ANY(${[...batchIds]}::uuid[]) AND b.mre_realm_id = ${mreRealmId}
        AND r.outcome->>'outcome' = 'duplicate' AND r.outcome->>'duplicateOf' = 'RESOLVED_REVIEW_ITEM'
      UNION ALL
      SELECT i.import_batch_id, (i.normalized_row->>'bookingDate')::date
      FROM import_review_item i
      WHERE i.import_batch_id = ANY(${[...batchIds]}::uuid[]) AND i.mre_realm_id = ${mreRealmId}
    ) d
    GROUP BY d.batch_id
  `.execute(db);
  return new Map(rows.map((r) => [r.batch_id, { firstBookingDate: r.first as BusinessDate | null, lastBookingDate: r.last as BusinessDate | null }]));
}
