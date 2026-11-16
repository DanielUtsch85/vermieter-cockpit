import { ApiError } from '../../api/errors';
import type { AccountProblem } from '../../setup/account-draft';

/** The form's own checks (setup/account-draft.ts), in German. */
export const ACCOUNT_PROBLEM_TEXTS: Readonly<Record<AccountProblem, string>> = {
  NAME_MISSING: 'Bitte einen Namen für das Konto angeben.',
  NAME_TOO_LONG: 'Der Name ist zu lang: höchstens 200 Zeichen.',
  IBAN_MISSING: 'Für diese Kontoart ist die IBAN Pflicht: der Import prüft die IBAN der Datei gegen das Konto.',
  IBAN_INVALID: 'Keine gültige IBAN: Aufbau oder Prüfziffer stimmen nicht. Bitte mit dem Kontoauszug vergleichen.',
};

/**
 * A refusal of `POST /financial-accounts` (api-design.md §29.1, §29.2) beyond the general text of error-text.ts: what it
 * means for the account. Field errors (`400 VALIDATION_ERROR`) are bound to their inputs by the form.
 */
export function accountRefusalText(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.status === 400) return 'Kein Konto angelegt: der Server hat die Angaben abgelehnt.';
  if (error.status === 409) {
    return 'Kein neues Konto angelegt: derselbe Vorgang wurde schon mit anderen Angaben gesendet. Bitte die Kontenliste prüfen und das Konto bei Bedarf neu erfassen.';
  }
  if (error.status === 403) return 'Kein Konto angelegt.';
  return undefined;
}

/**
 * A refusal of `POST /property-references/link` (api-design.md §23.1): `404` the property is not in MRE's list of this
 * Realm (any more), `403` MRE no longer grants the Realm, `503` MRE is unavailable. Nothing was linked in each case.
 */
export function linkRefusalText(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  switch (error.status) {
    case 404:
      return 'Nicht verknüpft: das Objekt ist in MicroRealEstate in diesem Bestand nicht (mehr) vorhanden. Bitte die Liste neu laden.';
    case 403:
      return 'Nicht verknüpft: MicroRealEstate gewährt diesem Konto den Bestand nicht (mehr).';
    case 503:
      return 'Nicht verknüpft: MicroRealEstate ist nicht erreichbar. Bitte später erneut versuchen.';
    case 400:
      return 'Nicht verknüpft: der Server hat die Angaben abgelehnt.';
    default:
      return undefined;
  }
}
