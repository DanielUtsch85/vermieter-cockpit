import { ApiError, type FieldError } from '../../api/errors';
import type { ImportRowDto } from '../../api/imports';
import { describeFieldError } from '../error-text';

/**
 * German texts for the codes of the bank import (ui-guide.md §4.4, §7.4; api-design.md §32.1a–§32.5). A code the
 * client does not know is shown with its code, never swallowed and never an empty cell (§11).
 */

const known = (table: Readonly<Record<string, string>>, code: string): string | undefined => (Object.hasOwn(table, code) ? table[code] : undefined);

const BATCH_STATUS: Readonly<Record<string, string>> = { COMPLETED: 'Abgeschlossen', NEEDS_REVIEW: 'Klärfälle offen' };
export const batchStatusText = (code: string) => known(BATCH_STATUS, code) ?? `Unbekannter Status (${code})`;

const AMBIGUITY: Readonly<Record<string, string>> = {
  AMBIGUOUS_CROSS_FILE_MATCH: 'Gleicher Inhalt wie eine Buchung aus einer anderen Datei',
  ADAPTER_VERSION_CONFLICT: 'Dieselbe Zeile wurde schon mit einer anderen Adapterversion eingelesen',
  EXTERNAL_ID_CONTENT_CONFLICT: 'Gleiche Bankreferenz wie eine vorhandene Buchung, aber anderer Inhalt',
  BALANCE_IDENTITY_CONTENT_CONFLICT: 'Gleicher Tag, Betrag und Saldo wie eine vorhandene Buchung, aber anderer Inhalt',
};
export const ambiguityText = (code: string) => known(AMBIGUITY, code) ?? `Unbekannter Grund (${code})`;

const RESOLUTION: Readonly<Record<string, string>> = {
  CREATE: 'Als eigenständige Buchung übernommen',
  SKIP: 'Nicht als neue Buchung übernommen',
};
export const resolutionText = (code: string) => known(RESOLUTION, code) ?? `Unbekannte Entscheidung (${code})`;

const ORDER: Readonly<Record<string, string>> = { OLDEST_FIRST: 'älteste Buchung zuerst', NEWEST_FIRST: 'neueste Buchung zuerst' };
export const orderText = (code: string) => known(ORDER, code) ?? `unbekannte Reihenfolge (${code})`;

const PREVIOUS_EXPORT: Readonly<Record<string, string>> = {
  OVERLAPS: 'Überschneidet sich mit einem früheren Import: die älteste Zeile ist schon mit ihrem Saldo eingelesen.',
  CHAINS: 'Schließt an einen bekannten früheren Saldo des Kontos an.',
  GAP: 'Lücke: frühere Salden sind bekannt, aber die Datei schließt an keinen an. Dazwischen fehlen möglicherweise Buchungen.',
  NO_EARLIER_BALANCE: 'Kein früherer Saldo des Kontos bekannt.',
};
export const previousExportText = (code: string) => known(PREVIOUS_EXPORT, code) ?? `Unbekanntes Ergebnis (${code})`;

/** Row error codes of the adapter (§32.4) beyond the general field codes of error-text.ts. */
const ROW_CODES: Readonly<Record<string, string>> = {
  TOO_LONG: 'zu lang (über 2.000 Zeichen)',
  COLUMN_COUNT: 'Spaltenzahl passt nicht zur Kopfzeile',
  ACCOUNT_CLOSED: 'nach dem Schließtag des Kontos',
  ZERO_AMOUNT: 'Betrag 0',
};
/**
 * The fields a row error names (the adapter's `generic-csv`, §32.4), in the words of the page (Issue #363 des
 * Projektinhabers, 2026-11-16, point 2: no English field names). An unknown name is shown with its code.
 */
const ROW_FIELDS: Readonly<Record<string, string>> = {
  '(row)': 'Zeile',
  bookingDate: 'Buchungstag',
  valueDate: 'Wertstellung',
  amount: 'Betrag',
  currency: 'Währung',
  balanceAfter: 'Saldo nach Buchung',
  counterpartyNameRaw: 'Gegenseite',
  description: 'Verwendungszweck',
  externalTransactionId: 'Bankreferenz',
};
export const rowFieldText = (field: string) => known(ROW_FIELDS, field) ?? `Unbekanntes Feld (${field})`;

export function rowErrorText(entry: FieldError): { readonly name: string; readonly text: string } {
  const own = known(ROW_CODES, entry.code);
  return { name: rowFieldText(entry.field), text: own ?? describeFieldError(entry).text };
}

/** A row that became or matched a booking: only such a row can carry a balance the continuity report reads (§70.6). */
const BOOKING_OUTCOMES: ReadonlySet<string> = new Set(['created', 'duplicate', 'needs_review']);

/**
 * Why there is no continuity report (`continuity: null`). The server sends `null` both for a file without a balance
 * column and for one whose rows carry no balance it could read (api-design.md §32.1a); the result does not tell them
 * apart, so the text claims neither (Issue #363 des Projektinhabers, 2026-11-16, point 3). A file without a single
 * booking row says so: whatever balances it has, none was evaluable.
 */
export function noContinuityText(rows: readonly Pick<ImportRowDto, 'outcome'>[]): string {
  if (rows.length === 0) return 'Die Datei enthielt keine Datenzeile; die Lückenlosigkeit wurde nicht geprüft.';
  return rows.some((row) => BOOKING_OUTCOMES.has(row.outcome))
    ? 'Keine gültige Zeile der Datei hat einen Saldo nach Buchung (keine Saldo-Spalte, oder sie ist leer); die Lückenlosigkeit wurde nicht geprüft.'
    : 'Keine Zeile der Datei hat einen auswertbaren Saldo: keine Zeile wurde zu einer Buchung (nur Zeilen mit Fehler oder mit Betrag 0). Die Lückenlosigkeit wurde nicht geprüft.';
}

const IMPORT_ERROR: Readonly<Record<string, string>> = {
  INVALID_OPTIONS: 'Die Importoptionen wurden nicht angenommen (Vorlage oder Format).',
  UNSUPPORTED_ENCODING: 'Die Datei ist nicht in der gewählten Zeichenkodierung gespeichert. Bitte die andere Zeichenkodierung wählen.',
  UNPARSEABLE: 'Die Datei ist keine lesbare CSV-Datei.',
  EMPTY: 'Die Datei hat keine Kopfzeile.',
  MISSING_COLUMN: 'Eine Spalte der Vorlage fehlt in der Datei. Passt die Vorlage zum Export der Bank?',
  AMBIGUOUS_COLUMN: 'Eine Spalte der Vorlage kommt in der Datei mehrfach vor.',
  TOO_MANY_ROWS: 'Die Datei hat mehr als 10.000 Zeilen. Bitte den Export in kürzere Zeiträume teilen.',
};

const IBAN_REASONS: Readonly<Record<string, string>> = {
  ACCOUNT_IBAN_MISMATCH: 'Die Datei gehört zu einem anderen Konto als dem gewählten.',
  MIXED_ACCOUNT_IBANS: 'Die Datei enthält Buchungen mehrerer Konten.',
  ACCOUNT_IBAN_MISSING: 'Die Spalte „IBAN Auftragskonto“ der Datei ist leer.',
  ACCOUNT_HAS_NO_IBAN: 'Das gewählte Konto hat keine IBAN; die Vorlage prüft die IBAN der Datei gegen das Konto.',
};

const list = (value: unknown) => (Array.isArray(value) ? value.map(String).join(', ') : '');

/**
 * What a refused upload means, beyond the general text of its status (error-text.ts). Only definite refusals of the
 * whole file say that no Transaction was created; a lost answer never does (ui-guide.md §6.5).
 */
export function importRefusalText(error: unknown): readonly string[] {
  if (!(error instanceof ApiError)) return [];
  const details = error.details ?? {};
  const reason = typeof details['reason'] === 'string' ? details['reason'] : undefined;
  const nothing = 'Die Datei wurde abgelehnt; es wurde keine Buchung angelegt.';
  if (error.code === 'IMPORT_ERROR') {
    const text = reason === undefined ? 'Die Datei konnte nicht gelesen werden.' : (known(IMPORT_ERROR, reason) ?? `Grund ${reason}.`);
    return [text, `Hinweis des Servers: ${error.message}`, nothing];
  }
  if (error.code === 'ACCOUNT_IBAN_MISMATCH') {
    const text = reason === undefined ? 'Die Datei passt nicht zum gewählten Konto.' : (known(IBAN_REASONS, reason) ?? `Grund ${reason}.`);
    const ibans = [
      typeof details['accountIban'] === 'string' ? `IBAN des Kontos: ${details['accountIban']}` : '',
      list(details['fileIbans']) === '' ? '' : `IBAN in der Datei: ${list(details['fileIbans'])}`,
    ].filter((part) => part !== '');
    return [text, ...(ibans.length === 0 ? [] : [ibans.join('; ')]), nothing];
  }
  if (error.status === 413)
    return ['Der Server nimmt höchstens 5 MiB an. Bitte den Export in kürzere Zeiträume teilen; die Datei wird nicht automatisch zerlegt.', nothing];
  if (error.status === 400 || error.status === 404 || error.status === 422) return [nothing];
  return [];
}

/** `409`/`422`/`404` of a resolve (api-design.md §32.3a) in German; an unknown reason with its code. */
export function resolveRefusalText(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const details = error.details ?? {};
  const reason = details['reason'];
  if (typeof reason !== 'string') return undefined;
  switch (reason) {
    case 'ALREADY_RESOLVED':
      return `Der Klärfall ist bereits anders entschieden („${resolutionText(String(details['resolution']))}“). Eine Entscheidung wird nicht umgekehrt.`;
    case 'ACCOUNT_CLOSED':
      return 'Die Zeile liegt nach dem Schließtag des Kontos und kann nicht als Buchung übernommen werden. „Nicht als neue Buchung übernehmen“ bleibt möglich.';
    default:
      return `Grund ${reason}.`;
  }
}
