import type { ImportRowDto } from '../api/imports';

/**
 * Which rows of an import result the row table shows by default (Entscheidung des Projektinhabers, 2026-11-11: „nur
 * Zeilen mit Hinweis, Umschalter ‚Alle Zeilen‘, Zähler immer sichtbar“).
 *
 * Without a hint, and so hidden by default, are only the rows that need nothing from the user:
 * - `created`: a new booking;
 * - `duplicate` of a `TRANSACTION`: the row was imported before;
 * - `duplicate` of a `RESOLVED_REVIEW_ITEM`: the row was decided before as a review item.
 *
 * Every other row has a hint: `needs_review` (a review item, of this batch or an earlier one), `error`, `skipped`
 * (no booking from it), and any outcome or duplicate kind the client does not know (§7.4: never hidden silently).
 */
export function rowHasHint(row: ImportRowDto): boolean {
  switch (row.outcome) {
    case 'created':
      return false;
    case 'duplicate': {
      // Read as a string: the server may send a kind this client does not know yet.
      const kind: string = row.duplicateOf;
      return kind !== 'TRANSACTION' && kind !== 'RESOLVED_REVIEW_ITEM';
    }
    default:
      return true;
  }
}
