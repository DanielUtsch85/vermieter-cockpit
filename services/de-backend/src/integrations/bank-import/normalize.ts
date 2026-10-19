import { checkBusinessDate, type BusinessDate, type BusinessDateError } from '../../domains/ledger/index.js';

/**
 * Normalization of raw CSV cell values (data-model.md §70.3). Every rule here is
 * part of the adapter version: changing one is a new adapter version.
 */

export type DecimalSeparator = ',' | '.';

/** A signed source amount split into the ledger's sign model (§17.4), as an exact decimal string. */
export interface SignedAmount {
  /** Canonical non-negative decimal string, e.g. "1250.00". */
  readonly magnitude: string;
  readonly negative: boolean;
}

/**
 * Parses a bank amount such as `-1.250,00` (decimal comma) or `1,250.00`
 * (decimal point). Only a leading `+`/`-` is a sign; thousands separators must
 * sit at every third digit. Anything else is rejected, never guessed — a
 * misread separator would change the amount by orders of magnitude.
 */
export function parseSignedAmount(raw: string, decimalSeparator: DecimalSeparator): SignedAmount | undefined {
  const value = raw.replace(/[\s ]/g, '');
  const thousands = decimalSeparator === ',' ? '\\.' : ',';
  const decimal = decimalSeparator === ',' ? ',' : '\\.';
  const pattern = new RegExp(`^([+-]?)((?:\\d{1,3}(?:${thousands}\\d{3})+)|\\d+)(?:${decimal}(\\d+))?$`);
  const match = pattern.exec(value);
  if (match === null) return undefined;
  const [, sign = '', integerPart = '', fraction] = match;
  const integer = integerPart.replace(/[.,]/g, '').replace(/^0+(?=\d)/, '');
  return { magnitude: fraction === undefined ? integer : `${integer}.${fraction}`, negative: sign === '-' };
}

export type DateFormat = 'DD.MM.YYYY' | 'DD.MM.YY' | 'YYYY-MM-DD';

/**
 * A source date in the configured format, as a plausible business date (§88),
 * or why not. `DD.MM.YY` (e.g. Sparkasse CSV-CAMT) is only read when configured,
 * with one fixed rule: `YY` means `20YY`. Nothing is inferred per row.
 */
export function parseSourceDate(
  raw: string,
  format: DateFormat,
): { readonly date: BusinessDate } | { readonly error: BusinessDateError } {
  const value = raw.trim();
  if (format === 'YYYY-MM-DD') return checkBusinessDate(value);
  const match = format === 'DD.MM.YY' ? /^(\d{2})\.(\d{2})\.(\d{2})$/.exec(value) : /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (match === null) return { error: 'INVALID_FORMAT' };
  const year = format === 'DD.MM.YY' ? `20${match[3]}` : match[3];
  return checkBusinessDate(`${year}-${match[2]}-${match[1]}`);
}

/** Trims and collapses whitespace (§70.3); empty becomes null. */
export function normalizeText(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

/** Strips presentation formatting from an IBAN and upper-cases it (§70.3); not validated. */
export function normalizeIbanRaw(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const iban = raw.replace(/[\s -]/g, '').toUpperCase();
  return iban === '' ? null : iban;
}
