import { ApiError, CLIENT_CODES, type FieldError } from '../api/errors';

export interface ErrorText {
  readonly title: string;
  readonly text: string;
}

/**
 * A refusal in German (ui-guide.md §4.4, §7.4): from status and code, never from the backend's English message alone.
 * An unknown code still gets a safe general text with the code, never an empty page.
 */
export function describeError(error: unknown): ErrorText {
  if (!(error instanceof ApiError)) return { title: 'Unerwarteter Fehler', text: 'Die Anfrage konnte nicht ausgeführt werden.' };
  const code = `Code ${error.code}`;
  if (error.code === CLIENT_CODES.network) {
    return { title: 'Keine Antwort', text: 'Der Server hat nicht geantwortet. Ob die Anfrage ausgeführt wurde, ist unklar.' };
  }
  if (error.code === CLIENT_CODES.sessionExpired) return { title: 'Sitzung abgelaufen', text: 'Bitte melden Sie sich erneut an.' };
  if (error.code === CLIENT_CODES.realmMismatch) {
    return { title: 'Antwort eines anderen Bestands', text: 'Die Antwort gehört nicht zu diesem Bestand und wird nicht angezeigt. Bitte die Seite neu laden.' };
  }
  switch (error.status) {
    case 400:
    case 422:
      return { title: 'Eingaben prüfen', text: `Die Anfrage wurde abgelehnt (${code}).` };
    case 401:
      return { title: 'Nicht angemeldet', text: 'Die Anmeldung wurde nicht anerkannt. Bitte melden Sie sich erneut an.' };
    case 403:
      return { title: 'Kein Zugriff', text: 'Für diesen Bestand haben Sie keinen Zugriff auf die Fachdaten (nur Administratoren des Bestands).' };
    case 404:
      return { title: 'Nicht gefunden', text: 'Der Eintrag wurde nicht gefunden oder ist nicht zugänglich.' };
    case 409:
      return { title: 'Konflikt', text: `Die Aktion passt nicht zum aktuellen Stand (${code}).` };
    case 412:
      return { title: 'Inzwischen geändert', text: 'Der Eintrag wurde inzwischen geändert. Bitte neu laden und erneut entscheiden.' };
    case 413:
      return { title: 'Zu groß', text: 'Die Datei oder Anfrage ist zu groß.' };
    case 502:
    case 503:
    case 504: {
      const wait = error.retryAfterSeconds === undefined ? '' : ` Frühestens in ${error.retryAfterSeconds} Sekunden erneut versuchen.`;
      return { title: 'Dienst nicht erreichbar', text: `MicroRealEstate oder das Cockpit-Backend ist nicht erreichbar (${code}).${wait}` };
    }
    default:
      return { title: 'Unerwartete Antwort', text: `HTTP ${error.status}, ${code}.` };
  }
}

/** German texts for the field codes of §90 the backend sends today (validation.ts); any other code is shown as it is. */
const FIELD_CODE_TEXTS: Readonly<Record<string, string>> = {
  REQUIRED: 'fehlt',
  INVALID_FORMAT: 'ungültig oder nicht vorgesehen',
  OUT_OF_RANGE: 'außerhalb des zulässigen Bereichs',
  NEGATIVE_AMOUNT: 'darf nicht negativ sein',
  SCALE_EXCEEDED: 'zu viele Nachkommastellen',
  AMOUNT_OUT_OF_RANGE: 'Betrag außerhalb des zulässigen Bereichs',
  UNSUPPORTED_CURRENCY: 'Währung wird nicht unterstützt',
  CURRENCY_MISMATCH: 'Währungen passen nicht zusammen',
  INVALID_RANGE: 'Ende liegt vor dem Beginn',
};

/** The names that are no input of the request: the whole body, the whole query, the empty name of `?=1` or `{"":1}`. */
const SPECIAL_FIELD_NAMES: Readonly<Record<string, string>> = {
  '(body)': 'Anfrageinhalt',
  '(query)': 'Abfrage',
  '': 'Feld ohne Namen',
};

/**
 * One entry of `details.fields` for the summary of a refusal (ui-guide.md §7.4: bound to an input where a form knows the
 * name, otherwise shown, never swallowed). The name stays as the server sent it, a dotted path with its index
 * (`splits.0.amount.zzz`, §58X) included, so the user and a report name the same field; only the names that are no
 * input get a German label. The code is translated where known and kept where not.
 */
export function describeFieldError(entry: FieldError): { readonly name: string; readonly text: string } {
  const special = Object.hasOwn(SPECIAL_FIELD_NAMES, entry.field) ? SPECIAL_FIELD_NAMES[entry.field] : undefined;
  const known = Object.hasOwn(FIELD_CODE_TEXTS, entry.code) ? FIELD_CODE_TEXTS[entry.code] : undefined;
  return { name: special ?? entry.field, text: known ?? `Code ${entry.code}` };
}
