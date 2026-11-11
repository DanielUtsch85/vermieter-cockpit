import { ApiError } from '../../api/errors';
import { formatDecimal } from '../../format/money';
import { formatTimestamp } from '../../format/dates';
import type { CodeLabel, Tone } from '../transactions/labels';

/**
 * German labels of step 6 (ui-guide.md §4.4, §6.6). Status and write-back state are two separate badges; a code the
 * client does not know is shown with its code and never unlocks an action (§7.4, §11: an unknown enum gives no empty
 * page).
 */

const table =
  (entries: Readonly<Record<string, readonly [string, Tone]>>, unknown: string) =>
  (code: string): CodeLabel => {
    const entry = Object.hasOwn(entries, code) ? entries[code] : undefined;
    return entry === undefined ? { text: `${unknown} (${code})`, tone: 'info', known: false } : { text: entry[0], tone: entry[1], known: true };
  };

/** The reconciliation's own status (§37.1, §37.3). */
export const reconciliationStatusLabel = table(
  {
    SUGGESTED: ['Vorschlag · zu prüfen', 'warning'],
    CONFIRMED: ['Zuordnung bestätigt', 'success'],
    REJECTED: ['Abgelehnt', 'neutral'],
    RELEASED: ['Zuordnung aufgehoben', 'neutral'],
  },
  'Unbekannter Status',
);

/** `mreWriteBackState` (§37.4, §37.5): what DE knows about its payment in MRE, separate from the status. */
export const writeBackStateLabel = table(
  {
    NOT_WRITTEN: ['MRE: nicht übertragen', 'neutral'],
    PENDING: ['MRE: Übertragung läuft', 'info'],
    WRITTEN: ['MRE: übertragen', 'success'],
    FAILED: ['MRE: Übertragung fehlgeschlagen', 'warning'],
    REMOVAL_REQUIRED: ['MRE: Entfernen erforderlich', 'warning'],
    REMOVING: ['MRE: Entfernen läuft', 'info'],
    REMOVED: ['MRE: entfernt', 'neutral'],
    REMOVAL_FAILED: ['MRE: Entfernen fehlgeschlagen', 'warning'],
  },
  'MRE: unbekannter Stand',
);

export const STATUS_FILTERS: readonly (readonly [code: string | undefined, label: string])[] = [
  ['SUGGESTED', 'Offene Vorschläge'],
  ['CONFIRMED', 'Bestätigt'],
  ['RELEASED', 'Aufgehoben'],
  ['REJECTED', 'Abgelehnt'],
  [undefined, 'Alle'],
];

const CONFIDENCE: Readonly<Record<string, string>> = { HIGH: 'hoch', MEDIUM: 'mittel' };
const SUGGESTION_REASON: Readonly<Record<string, string>> = {
  EXACT_AMOUNT: 'Betrag stimmt genau, einziger passender Termin',
  EXACT_AMOUNT_IBAN_HISTORY: 'Betrag stimmt genau, dieselbe IBAN wurde dem Mieter schon zugeordnet',
  EXACT_AMOUNT_PURPOSE_MONTH: 'Betrag stimmt genau, der Verwendungszweck nennt den Monat',
  EXACT_AMOUNT_IN_ORDER: 'Betrag stimmt genau, zugeordnet in Zahlungsreihenfolge (bitte prüfen)',
};

export const confidenceText = (code: string | null): string =>
  code === null ? 'keine (manuelle Zuordnung)' : Object.hasOwn(CONFIDENCE, code) ? (CONFIDENCE[code] ?? code) : `unbekannt (${code})`;
export const suggestionReasonText = (code: string | null): string =>
  code === null
    ? 'Kein Vorschlag (manuelle Zuordnung)'
    : Object.hasOwn(SUGGESTION_REASON, code)
      ? (SUGGESTION_REASON[code] ?? code)
      : `Unbekannter Grund (${code})`;

/** MRE's side of a term (§37.2). */
export function mreStatusText(code: string): string {
  switch (code) {
    case 'AVAILABLE':
      return 'MRE hat den Termin geliefert.';
    case 'NOT_RETURNED':
      return 'MRE hat diesen Termin nicht geliefert (unbekannter oder gelöschter Mieter oder Termin, oder ein Lesefehler in MRE).';
    case 'UNAVAILABLE':
      return 'MRE war nicht erreichbar oder antwortete unerwartet. Die Zuordnungen von DE stehen trotzdem unten.';
    default:
      return `Unbekannter MRE-Stand (${code}).`;
  }
}

export function coverageText(code: string | null): string {
  switch (code) {
    case null:
      return 'Keine Aussage möglich: ohne den Sollbetrag aus MRE lässt sich nicht sagen, ob der Termin gedeckt ist.';
    case 'UNMATCHED':
      return 'Nicht zugeordnet: keine bestätigte Zahlung für diesen Termin.';
    case 'PARTIALLY_MATCHED':
      return 'Teilweise zugeordnet.';
    case 'MATCHED':
      return 'Vollständig zugeordnet (bestätigte Zuordnungen = Sollbetrag).';
    case 'OVERPAID':
      return 'Überzahlt: die bestätigten Zuordnungen liegen über dem Sollbetrag.';
    default:
      return `Unbekannte Deckung (${code}).`;
  }
}

const WRITE_BACK_ERRORS: Readonly<Record<string, string>> = {
  MRE_RENT_TERM_NOT_FOUND: 'MRE hat den Termin nicht geliefert',
  MRE_UNAVAILABLE: 'MRE war nicht erreichbar',
  MRE_FORBIDDEN: 'MRE hat den Zugriff verweigert',
  MRE_WRITE_REFUSED: 'MRE hat die Zahlung nicht angenommen',
  MRE_PAYMENT_CHANGED: 'Die Zahlung von DE wurde in MRE von Hand geändert',
  MRE_TERM_CHANGED: 'Der Termin wurde in MRE zwischendurch geändert',
  LEASE_EXPIRED: 'Der Versuch wurde abgebrochen und von einem anderen abgelöst',
};

export const writeBackErrorText = (code: string): string => (Object.hasOwn(WRITE_BACK_ERRORS, code) ? (WRITE_BACK_ERRORS[code] ?? code) : `Fehler ${code}`);

const money = (value: unknown): string => {
  if (typeof value !== 'object' || value === null) return 'nicht angegeben';
  const amount = (value as Record<string, unknown>)['amount'];
  return typeof amount === 'string' ? `${formatDecimal(amount) ?? amount} €` : 'nicht angegeben';
};

/**
 * The reasons of a refused step-6 command (api-design.md §37.1–§37.5) in German; an unknown one with its code. `412`,
 * `404` and field errors are said by `ErrorState`; this adds what the reason means and what to do.
 */
export function rentRefusalText(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code === 'ABOVE_SUGGESTION')
    return `Der Betrag liegt über dem Vorschlag (${money(error.details?.['suggested'])}). Bestätigt werden kann nur weniger oder gleich viel.`;
  if (error.code === 'MRE_RENT_TERM_NOT_FOUND') return 'MRE hat diesen Mietertermin nicht geliefert. Bitte den Mieter und den Termin in MRE prüfen.';
  if (error.code === 'NO_RENT_CASH') return 'Die Buchung hat keinen Anteil in einer Mietkategorie.';
  if (error.code === 'TRANSACTION_NOT_INFLOW') return 'Miete wird nur einem Zahlungseingang zugeordnet.';
  const details = error.details ?? {};
  const reason = details['reason'];
  if (typeof reason !== 'string') return undefined;
  switch (reason) {
    case 'NOT_CONFIRMABLE':
      return `Der Vorschlag hat den Status „${reconciliationStatusLabel(String(details['status'])).text}“ und kann so nicht bestätigt werden.`;
    case 'NOT_REJECTABLE':
      return `Der Vorschlag hat den Status „${reconciliationStatusLabel(String(details['status'])).text}“ und kann nicht abgelehnt werden.`;
    case 'NOT_RELEASABLE':
      return `Die Zuordnung hat den Status „${reconciliationStatusLabel(String(details['status'])).text}“ und kann nicht aufgehoben werden.`;
    case 'NOT_WRITABLE':
      return 'Nur eine bestätigte Zuordnung kann an MRE übertragen werden.';
    case 'NOT_REMOVABLE':
      return 'Hier gibt es in MRE nichts zu entfernen (nicht aufgehoben oder nie übertragen).';
    case 'TRANSACTION_NOT_COUNTED':
      return 'Die Buchung ist nicht (mehr) bestätigt oder wurde korrigiert; sie zählt nicht als Zahlungseingang.';
    case 'NOT_PROPOSABLE':
      return 'Einen Aufteilungsvorschlag gibt es nur für einen noch nicht bestätigten Zahlungseingang; die gespeicherte Aufteilung einer bestätigten Buchung ist eingefroren.';
    case 'ALREADY_MATCHED':
      return 'Diese Buchung ist diesem Termin schon zugeordnet.';
    case 'RENT_CASH_EXCEEDED':
      return `Der Betrag übersteigt den noch freien Mietanteil der Buchung (frei: ${money(details['available'])}).`;
    case 'SUGGESTION_STALE':
      return `Der Termin wurde inzwischen anders zugeordnet; offen sind nur noch ${money(details['openAmount'])}. Bitte den Vorschlag ablehnen oder einen geringeren Betrag bestätigen.`;
    case 'WRITE_BACK_IN_PROGRESS':
      return 'Für diesen Mieter läuft gerade eine Übertragung an MRE. Der Stand wird neu geladen; erneut versuchen erst nach der Wartezeit.';
    case 'REMOVAL_TOO_EARLY': {
      const notBefore = details['notBefore'];
      const at = typeof notBefore === 'string' ? (formatTimestamp(notBefore) ?? notBefore) : 'später';
      return `Eine verspätete Übertragung könnte noch in MRE ankommen. Entfernen ist frühestens ab ${at} möglich.`;
    }
    case 'MRE_PAYMENT_CHANGED':
    case 'MRE_TERM_CHANGED':
      return `${writeBackErrorText(reason)}. DE repariert in MRE nichts; bitte den Termin in MRE prüfen.`;
    case 'MRE_TERM_NOT_ROUND_TRIPPABLE':
      return 'Wegen Umsatzsteuer mit Nachlass oder Zuschlag würde MRE den Termin verändern. Bitte die Zahlung in MRE von Hand erfassen bzw. entfernen.';
    case 'MRE_UNAVAILABLE':
    case 'MRE_WRITE_REFUSED':
      return `${writeBackErrorText(reason)}. Die Zuordnung bleibt bestehen; die Übertragung kann später erneut ausgelöst werden.`;
    default:
      return `Grund ${reason}.`;
  }
}
