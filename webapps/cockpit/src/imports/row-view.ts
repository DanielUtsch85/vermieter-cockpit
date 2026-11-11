/**
 * The toggle „Alle Zeilen“ of the import result's row table, in the URL (Entscheidung des Projektinhabers, 2026-11-11,
 * zu #344: „„Alle Zeilen“ als URL-Parameter: ja, kleiner Folge-PR“; the name as proposed in the review of #344).
 *
 *   …/import/<importBatchId>?zeilen=alle   every row
 *   …/import/<importBatchId>               only the rows with a hint (`rowHasHint`), the default
 *
 * Only exactly `alle` shows every row; any other value, an empty one and an absent parameter are the default. The
 * parameter is never carried into another URL: the links of the cockpit build their paths without it, so another
 * import, another page or another Realm opens in its default view. Not free text, no id (routing.ts, ui-guide.md §3.2).
 */
export const ROWS_PARAM = 'zeilen';
export const ALL_ROWS = 'alle';

/** Whether the URL's search part asks for every row. */
export function showsAllRows(search: string): boolean {
  return new URLSearchParams(search).get(ROWS_PARAM) === ALL_ROWS;
}

/** The name of one `name=value` piece of a search part, as `URLSearchParams` reads it. */
const nameOf = (piece: string) => [...new URLSearchParams(piece).keys()][0];

/**
 * The search part with the toggle set (`zeilen=alle`, last) or removed. Every other parameter is kept byte for byte
 * and in its place, so a value is never re-encoded. The default view has no parameter at all: an unknown value, and a
 * repeated one, is dropped when the toggle is pressed.
 */
export function withAllRows(search: string, all: boolean): string {
  const pieces = search
    .replace(/^\?/, '')
    .split('&')
    .filter((piece) => piece !== '' && nameOf(piece) !== ROWS_PARAM);
  if (all) pieces.push(`${ROWS_PARAM}=${ALL_ROWS}`);
  return pieces.length === 0 ? '' : `?${pieces.join('&')}`;
}
