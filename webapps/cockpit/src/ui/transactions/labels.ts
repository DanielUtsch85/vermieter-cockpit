/**
 * German labels for the codes of a Transaction (ui-guide.md §4.4: API keys unchanged in the client, the display
 * translated; §6.3: the status labels of its table). A code the client does not know is shown with the code, never as
 * an empty cell or a guess (§11: an unknown enum gives no empty page).
 */
export type Tone = 'warning' | 'success' | 'neutral' | 'info';

export interface CodeLabel {
  readonly text: string;
  readonly tone: Tone;
  readonly known: boolean;
}

const STATUS: Readonly<Record<string, readonly [text: string, tone: Tone]>> = {
  IMPORTED: ['Importiert · zu prüfen', 'warning'],
  UNREVIEWED: ['Ungeprüft', 'warning'],
  CLASSIFIED: ['Aufgeteilt', 'warning'],
  CONFIRMED: ['Bestätigt', 'success'],
  RECONCILED: ['Abgeglichen', 'success'],
  CORRECTED: ['Korrigiert/storniert', 'neutral'],
  IGNORED: ['Ignoriert', 'neutral'],
};

/** §4.4: the origin said explicitly ("Aus Bankimport"). */
const PROVENANCE: Readonly<Record<string, string>> = {
  MANUAL: 'Manuell erfasst',
  BANK_CSV: 'Aus Bankimport (CSV)',
  BANK_API: 'Aus Bankschnittstelle',
  MIGRATION: 'Aus Datenübernahme',
  CORRECTION: 'Aus Korrektur',
};

const DIRECTION: Readonly<Record<string, string>> = { INFLOW: 'Eingang', OUTFLOW: 'Ausgang' };

const CORRECTION_ROLE: Readonly<Record<string, string>> = { REVERSAL: 'Storno', REPLACEMENT: 'Ersatzbuchung' };

const ACCOUNT_STATUS: Readonly<Record<string, string>> = { OPEN: 'offen', CLOSED: 'geschlossen' };

const lookup = (table: Readonly<Record<string, string>>, code: string, unknown: string): CodeLabel =>
  Object.hasOwn(table, code) ? { text: table[code] ?? code, tone: 'neutral', known: true } : { text: `${unknown} (${code})`, tone: 'info', known: false };

export function statusLabel(code: string): CodeLabel {
  const entry = Object.hasOwn(STATUS, code) ? STATUS[code] : undefined;
  return entry === undefined ? { text: `Unbekannter Status (${code})`, tone: 'info', known: false } : { text: entry[0], tone: entry[1], known: true };
}

export const provenanceLabel = (code: string): CodeLabel => lookup(PROVENANCE, code, 'Unbekannte Herkunft');
export const directionLabel = (code: string): CodeLabel => lookup(DIRECTION, code, 'Unbekannte Richtung');
export const correctionRoleLabel = (code: string): CodeLabel => lookup(CORRECTION_ROLE, code, 'Unbekannte Rolle');
export const accountStatusLabel = (code: string): CodeLabel => lookup(ACCOUNT_STATUS, code, 'unbekannter Status');

/** The statuses and provenances the filter offers, in the order of the API (§30.1). */
export const STATUS_CODES: readonly string[] = Object.keys(STATUS);
export const PROVENANCE_CODES: readonly string[] = Object.keys(PROVENANCE);
