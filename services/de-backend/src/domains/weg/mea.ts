/**
 * The Miteigentumsanteil (MEA) of a unit in its WEG (api-design.md §49.2, phase-6-plan P6-D1): a fraction `n/d` as the
 * Verwalter prints it, each part a decimal with at most three places (the real statements print `x,xxx/10.000,000`).
 * Kept as printed, never reduced and never as a percentage, so each statement line can be compared with it. It is not
 * the Ownership share (data-model §28): the MEA divides the WEG's costs among units, the share divides one unit among owners.
 */
export interface Mea {
  /** `> 0`, at most 9 integer digits and 3 decimals, without trailing zeros (`"125.5"`). */
  readonly numerator: string;
  /** `≥ numerator`, same form. */
  readonly denominator: string;
}

export type MeaError = 'INVALID_FORMAT' | 'NOT_POSITIVE' | 'OUT_OF_RANGE';

const PART = '(\\d{1,9}(?:\\.\\d{1,3})?)';
const MEA = new RegExp(`^${PART}/${PART}$`);

/** A part in thousandths, exact. */
const thousandths = (part: string): bigint => {
  const [whole, fraction = ''] = part.split('.') as [string, string?];
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
};

/** The shortest form of a part: no leading zeros before the point, no trailing zeros after it. */
const normalize = (part: string): string => {
  const units = thousandths(part);
  const whole = (units / 1000n).toString();
  const fraction = (units % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction === '' ? whole : `${whole}.${fraction}`;
};

/** `"n/d"` with a decimal point → the MEA as printed, trailing zeros dropped; or why not. */
export function parseMea(text: string): { readonly mea: Mea } | { readonly error: MeaError } {
  const match = MEA.exec(text);
  if (match === null) return { error: 'INVALID_FORMAT' };
  const [, numerator, denominator] = match as unknown as [string, string, string];
  const n = thousandths(numerator);
  if (n === 0n) return { error: 'NOT_POSITIVE' };
  if (n > thousandths(denominator)) return { error: 'OUT_OF_RANGE' };
  return { mea: { numerator: normalize(numerator), denominator: normalize(denominator) } };
}

export function formatMea(mea: Mea): string {
  return `${mea.numerator}/${mea.denominator}`;
}

/** A part as stored in a `numeric(12,3)` column (`"125.500"`), back to its shortest form. */
export function meaFromColumns(numerator: string, denominator: string): Mea {
  return { numerator: normalize(numerator), denominator: normalize(denominator) };
}
