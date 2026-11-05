import type { BusinessDate } from '../../shared/index.js';

/**
 * Named bank formats of a loan debit's purpose text (api-design.md §58O open question 12 (a); Entscheidung des
 * Projektinhabers, 2026-11-05, question 12, condition 1): the split a lender states in the Transaction's `description`,
 * read by a parser chosen by its name, as the CSV import's presets are (`GENERIC_CSV_PRESETS`). A format is part of
 * its name: it never changes under that name, a changed one is a new name; others are added when real data shows them.
 * A text no format recognises is no error: the proposal then takes the plan's split, silently.
 */

/** What a format read from a purpose text; amounts in cents. */
export type PurposeReading =
  /** The format's pattern is not in the text (another bank, another kind of debit): the format says nothing. */
  | { readonly kind: 'NOT_RECOGNISED' }
  /** The pattern is there but an amount or the date is not readable as the format writes it. */
  | { readonly kind: 'UNREADABLE'; readonly format: string }
  | { readonly kind: 'SPLIT'; readonly format: string; readonly interest: bigint; readonly principal: bigint; readonly statedDate: BusinessDate };

export interface PurposeFormat {
  readonly name: string;
  readonly read: (text: string) => PurposeReading;
}

/** A German amount as the bank writes it: `1.234,56` or `234,56`, two decimals, thousands by `.` at every third digit. */
const GERMAN_AMOUNT = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})$/;

/** Cents of a German amount; undefined when not one. */
export function germanAmountCents(raw: string): bigint | undefined {
  const match = GERMAN_AMOUNT.exec(raw);
  if (match === null) return undefined;
  return BigInt((match[1] as string).replace(/\./g, '')) * 100n + BigInt(match[2] as string);
}

/** `DD.MM.YYYY` as a business date; undefined when not a calendar day. */
function germanDate(raw: string): BusinessDate | undefined {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);
  if (match === null) return undefined;
  const [, d, m, y] = match as unknown as [string, string, string, string];
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) return undefined;
  return `${y}-${m}-${d}` as BusinessDate;
}

/**
 * BBBank's loan debit (version 1 of the name): `RECHN.ZINS <interest> TILG./ENTG. <principal> TILGUNG PER <date>`, the
 * tokens in that order and case, any whitespace between them, the amounts German (`1.234,56`), the date `DD.MM.YYYY`.
 */
const BBBANK = /RECHN\.ZINS\s+(\S+)\s+TILG\.\/ENTG\.\s+(\S+)\s+TILGUNG\s+PER\s+(\S+)/;

const BBBANK_NAME = 'BBBANK_LOAN_DEBIT';

export const BBBANK_LOAN_DEBIT: PurposeFormat = {
  name: BBBANK_NAME,
  read: (text) => {
    const match = BBBANK.exec(text);
    if (match === null) return { kind: 'NOT_RECOGNISED' };
    const [, interestText, principalText, dateText] = match as unknown as [string, string, string, string];
    const interest = germanAmountCents(interestText);
    const principal = germanAmountCents(principalText);
    const statedDate = germanDate(dateText);
    if (interest === undefined || principal === undefined || statedDate === undefined) return { kind: 'UNREADABLE', format: BBBANK_NAME };
    return { kind: 'SPLIT', format: BBBANK_NAME, interest, principal, statedDate };
  },
};

/** Every format, by name, tried in this order; the first that recognises the text reads it. */
export const LOAN_PURPOSE_FORMATS: ReadonlyMap<string, PurposeFormat> = new Map([[BBBANK_LOAN_DEBIT.name, BBBANK_LOAN_DEBIT]]);

/** The first format's reading of `text` that recognises it; `NOT_RECOGNISED` for none or no text. */
export function readPurpose(text: string | null, formats: ReadonlyMap<string, PurposeFormat> = LOAN_PURPOSE_FORMATS): PurposeReading {
  if (text === null) return { kind: 'NOT_RECOGNISED' };
  for (const format of formats.values()) {
    const reading = format.read(text);
    if (reading.kind !== 'NOT_RECOGNISED') return reading;
  }
  return { kind: 'NOT_RECOGNISED' };
}
