import type { CreateFinancialAccountInputDto } from '@vermieter-cockpit/de-backend/client-contract';

/**
 * The rules of „Konto anlegen“ (Issue #365; api-design.md §29.1, §29.2). The IBAN is checked here as the backend checks
 * it (`shared/iban.ts`: spaces removed, upper case, ISO 13616 structure, ISO 7064 mod-97), so a typo is named at the
 * input before anything is sent; the server checks it again and its refusal is shown as well.
 *
 * Which account needs an IBAN (Entscheidung des Projektinhabers, 2026-11-16): „Im Formular „Konto anlegen“ ist die
 * IBAN für Bankkonten ein Pflichtfeld, nur für Kassen oder Verrechnungskonten optional.“ and, on #372, „`OTHER` ohne
 * IBAN-Pflicht: ja, Zahlungsdienste haben keine. `SECURITY_DEPOSIT` bleibt Pflicht, ein Kautionskonto ist ein
 * Bankkonto.“ So it is required for `BANK` and `SECURITY_DEPOSIT` only, and optional for `CASH` (Kasse),
 * `LOAN_SETTLEMENT` (Verrechnungskonto) and `OTHER` (Sonstiges Konto, e.g. a payment service). The backend itself keeps
 * it optional for all types; the rule is the form's, so an account without IBAN that the import refuses
 * (`ACCOUNT_HAS_NO_IBAN`) does not come from the cockpit, and no endpoint to add an IBAN later is needed.
 */

export type AccountType = CreateFinancialAccountInputDto['accountType'];

/** The five types of api-design.md §29, in the order the form offers them, with their German names. */
export const ACCOUNT_TYPES: readonly { readonly code: AccountType; readonly label: string; readonly ibanRequired: boolean }[] = [
  { code: 'BANK', label: 'Bankkonto', ibanRequired: true },
  { code: 'SECURITY_DEPOSIT', label: 'Kautionskonto', ibanRequired: true },
  { code: 'OTHER', label: 'Sonstiges Konto', ibanRequired: false },
  { code: 'CASH', label: 'Kasse', ibanRequired: false },
  { code: 'LOAN_SETTLEMENT', label: 'Verrechnungskonto (Darlehen)', ibanRequired: false },
];

/** The German name of an account type; an unknown code is shown with its code. */
export function accountTypeLabel(code: string): string {
  return ACCOUNT_TYPES.find((type) => type.code === code)?.label ?? `Unbekannte Kontoart (${code})`;
}

export function ibanRequired(code: AccountType): boolean {
  return ACCOUNT_TYPES.find((type) => type.code === code)?.ibanRequired ?? true;
}

/** Country code, two check digits, 11–30 alphanumeric BBAN characters (15–34 in total), as `shared/iban.ts`. */
const IBAN_STRUCTURE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;

/** The canonical form of an IBAN (no spaces, upper case), or undefined when it is not a valid IBAN. */
export function normalizeIban(input: string): string | undefined {
  const iban = input.replace(/ /g, '').toUpperCase();
  if (!IBAN_STRUCTURE.test(iban)) return undefined;
  return mod97(`${iban.slice(4)}${iban.slice(0, 4)}`) === 1 ? iban : undefined;
}

/** Remainder of the IBAN's numeric form modulo 97, digit by digit (no big numbers). */
function mod97(rearranged: string): number {
  let remainder = 0;
  for (const char of rearranged) {
    const digits = char >= 'A' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

/** The longest name the backend takes (`displayName` trimmed, 1–200 characters, §29.2). */
export const NAME_MAX = 200;

export interface AccountDraft {
  readonly accountType: AccountType;
  readonly displayName: string;
  readonly iban: string;
}

export type AccountProblem = 'NAME_MISSING' | 'NAME_TOO_LONG' | 'IBAN_MISSING' | 'IBAN_INVALID';

export type CheckedAccount =
  { readonly ok: true; readonly body: CreateFinancialAccountInputDto } | { readonly ok: false; readonly problems: readonly AccountProblem[] };

/**
 * The request body of a draft, or what is wrong with it. The body is the one the backend reads: the trimmed name, the
 * currency `EUR` (the only one it supports, §29.2), and the IBAN in its canonical form; an empty optional IBAN is left
 * out, never sent as `""` (which the backend refuses).
 */
export function checkAccount(draft: AccountDraft): CheckedAccount {
  const problems: AccountProblem[] = [];
  const name = draft.displayName.trim();
  if (name === '') problems.push('NAME_MISSING');
  else if (name.length > NAME_MAX) problems.push('NAME_TOO_LONG');
  const typed = draft.iban.trim() !== '';
  const iban = typed ? normalizeIban(draft.iban) : undefined;
  if (!typed && ibanRequired(draft.accountType)) problems.push('IBAN_MISSING');
  if (typed && iban === undefined) problems.push('IBAN_INVALID');
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, body: { accountType: draft.accountType, displayName: name, currency: 'EUR', ...(iban === undefined ? {} : { iban }) } };
}
