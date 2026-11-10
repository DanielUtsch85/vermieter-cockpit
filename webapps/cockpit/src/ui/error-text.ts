import { ApiError, CLIENT_CODES } from '../api/errors';

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
