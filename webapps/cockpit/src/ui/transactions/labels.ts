/**
 * German labels for the codes of a Transaction (ui-guide.md §4.4: API keys unchanged in the client, the display
 * translated; §6.3: the status labels of its table). A code the client does not know is shown with the code, never as
 * an empty cell or a guess (§11: an unknown enum gives no empty page).
 */
import { formatMoney, type MoneyValue } from '../../format/money';

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

/**
 * §4.4: the origin said explicitly, in short texts without „Aus“, the same in the table and the filter (Entscheidung des
 * Projektinhabers, 2026-11-13: „#355 F4, Herkunft-Spalte: ja, kurze Texte ohne „Aus“ in Tabelle und Filter“).
 */
const PROVENANCE: Readonly<Record<string, string>> = {
  MANUAL: 'Manuell erfasst',
  BANK_CSV: 'Bankimport (CSV)',
  BANK_API: 'Bankschnittstelle',
  MIGRATION: 'Datenübernahme',
  CORRECTION: 'Korrektur',
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

/**
 * The rent allocation of a confirmed rent payment in the list (api-design.md §30.1A; Entscheidung des Projektinhabers,
 * 2026-11-17: the texts as proposed). „nicht zugeordnet“, not „offen“: „offene Miete“ reads as the tenant's arrear.
 * Open work is `warning` („offen, prüfen“, ui-guide.md §4.1), the full allocation `success`; the text says it either way.
 */
const RENT_ALLOCATION: Readonly<Record<string, readonly [text: string, tone: Tone]>> = {
  NONE: ['Miete nicht zugeordnet', 'warning'],
  PARTIAL: ['Miete teilweise zugeordnet', 'warning'],
  FULL: ['Miete zugeordnet', 'success'],
};

/** The state's text alone (the filter's note names a state the bar does not offer). */
export function rentAllocationStateLabel(state: string): CodeLabel {
  const entry = Object.hasOwn(RENT_ALLOCATION, state) ? RENT_ALLOCATION[state] : undefined;
  return entry === undefined ? { text: `Unbekannte Mietzuordnung (${state})`, tone: 'info', known: false } : { text: entry[0], tone: entry[1], known: true };
}

/** The badge under the status: the state, and for `PARTIAL` the free rest in the list's money format („noch frei 250,00 €“). */
export function rentAllocationLabel(allocation: { readonly state: string; readonly freeAmount: MoneyValue }): CodeLabel {
  const label = rentAllocationStateLabel(allocation.state);
  if (allocation.state !== 'PARTIAL') return label;
  const free = formatMoney(allocation.freeAmount) ?? `${allocation.freeAmount.amount} ${allocation.freeAmount.currency}`;
  return { ...label, text: `${label.text} · noch frei ${free}` };
}

export const provenanceLabel = (code: string): CodeLabel => lookup(PROVENANCE, code, 'Unbekannte Herkunft');
export const directionLabel = (code: string): CodeLabel => lookup(DIRECTION, code, 'Unbekannte Richtung');
export const correctionRoleLabel = (code: string): CodeLabel => lookup(CORRECTION_ROLE, code, 'Unbekannte Rolle');
export const accountStatusLabel = (code: string): CodeLabel => lookup(ACCOUNT_STATUS, code, 'unbekannter Status');

/**
 * Statuses with a label but not offered by the filter: no step sets `RECONCILED` yet (api-design.md §37, P4-D3), so its
 * box could only ever find nothing (Issue #381 part 1: „Abgeglichen“ aus dem Statusfilter der Buchungsliste nehmen; die
 * Beschriftung in labels.ts bleibt für später; Entscheidung des Projektinhabers, 2026-11-16).
 */
const NOT_FILTERED: readonly string[] = ['RECONCILED'];

/** The statuses and provenances the filter offers, in the order of the API (§30.1). */
export const STATUS_CODES: readonly string[] = Object.keys(STATUS).filter((code) => !NOT_FILTERED.includes(code));
export const PROVENANCE_CODES: readonly string[] = Object.keys(PROVENANCE);
