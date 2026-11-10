/**
 * Amounts of the split editor (ui-guide.md §5.2, §6.4, §11 "Splits unterscheiden sich nicht durch Browserrundung").
 *
 * An amount is typed in German (`1.234,56`) and normalised explicitly to the API's decimal string (`1234.56`); a form
 * that could mean two things is refused, never guessed. Sums and the rest are computed on whole cents written as digit
 * strings: no `parseFloat`, no `Number`, no `BigInt`, no floating point. 18 digits before the comma (the backend's limit)
 * are 20 digits of cents, beyond 2^53, and stay exact.
 */

/** Why a typed amount is not read. */
export type AmountProblem = 'EMPTY' | 'NEGATIVE' | 'TOO_MANY_DECIMALS' | 'AMBIGUOUS' | 'INVALID' | 'TOO_LARGE';

export type ParsedAmount =
  | {
      readonly ok: true;
      /** The API's decimal string, always two places: `1234.56`. */ readonly amount: string;
      /** Whole cents as digits. */ readonly cents: string;
    }
  | { readonly ok: false; readonly problem: AmountProblem };

/** The backend's limit (api-design.md §86): at most 18 digits before the decimal point. */
export const MAX_INTEGER_DIGITS = 18;

/** `1234`, `1234,5`, `1234,56`: digits, optionally a comma and one or two places. */
const PLAIN = /^(\d+)(?:,(\d{1,2}))?$/;
/** `1.234,56`: thousands separated by points in groups of three, then the comma and one or two places. */
const GROUPED = /^(\d{1,3}(?:\.\d{3})+),(\d{1,2})$/;

/**
 * The amount a person typed, or why it is not one. Surrounding spaces are ignored; inside the number nothing but digits,
 * the thousands points and one decimal comma is read.
 * - `1,5` → `1.50`; `1.234,56` → `1234.56`; `0012` → `12.00`.
 * - `0,001` → too many decimals (the currency has two; nothing is rounded).
 * - `1.234` and `1234.56` → ambiguous: a point may be the German thousands separator or an English decimal point, so the
 *   amount is written with a comma instead (`1.234,00` or `1234,56`).
 * - A minus is refused: a split is never negative, the direction belongs to the Transaction (§5.2, §6.4).
 */
export function parseAmountInput(text: string): ParsedAmount {
  const value = text.trim();
  if (value === '') return { ok: false, problem: 'EMPTY' };
  if (/^[-\u2212]/.test(value)) return { ok: false, problem: 'NEGATIVE' };
  const match = PLAIN.exec(value) ?? GROUPED.exec(value);
  if (match === null) return { ok: false, problem: classify(value) };
  const integer = stripLeadingZeros((match[1] ?? '').replace(/\./g, ''));
  if (integer.length > MAX_INTEGER_DIGITS) return { ok: false, problem: 'TOO_LARGE' };
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return { ok: true, amount: `${integer}.${fraction}`, cents: stripLeadingZeros(integer + fraction) };
}

function classify(value: string): AmountProblem {
  if (/^(\d+|\d{1,3}(\.\d{3})+),\d{3,}$/.test(value)) return 'TOO_MANY_DECIMALS';
  if (/^\d{1,3}(\.\d{3})+$/.test(value) || /^\d+\.\d+$/.test(value)) return 'AMBIGUOUS';
  return 'INVALID';
}

const stripLeadingZeros = (digits: string): string => digits.replace(/^0+(?=\d)/, '');

/** The API's decimal string (`850.00`, `850.5`, `850`) as whole cents; undefined for anything else or a third place. */
export function decimalToCents(amount: string): string | undefined {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  if (match === null) return undefined;
  return stripLeadingZeros(`${match[1] ?? ''}${(match[2] ?? '').padEnd(2, '0')}`);
}

/** Whole cents as the API's decimal string, with a leading minus when negative: `123456` → `1234.56`. */
export function centsToDecimal(cents: string, negative = false): string {
  const digits = cents.padStart(3, '0');
  const text = `${stripLeadingZeros(digits.slice(0, -2))}.${digits.slice(-2)}`;
  return negative && /[1-9]/.test(cents) ? `-${text}` : text;
}

/** The API's decimal string as the editor's input text: `1234.5` → `1234,50`. Undefined when it is not one. */
export function decimalToInput(amount: string): string | undefined {
  const cents = decimalToCents(amount);
  return cents === undefined ? undefined : centsToDecimal(cents).replace('.', ',');
}

/** -1, 0 or 1 for two cent digit strings without leading zeros. */
export function compareCents(a: string, b: string): -1 | 0 | 1 {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** a + b, digit by digit. */
export function addCents(a: string, b: string): string {
  let result = '';
  let carry = 0;
  for (let i = 1; i <= Math.max(a.length, b.length); i += 1) {
    const sum = digitAt(a, i) + digitAt(b, i) + carry;
    result = String(sum % 10) + result;
    carry = sum >= 10 ? 1 : 0;
  }
  return stripLeadingZeros(carry === 1 ? `1${result}` : result || '0');
}

/** a − b as a signed decimal string of the API (`-0.01`, `0.00`, `12.50`). */
export function differenceAsDecimal(a: string, b: string): string {
  const order = compareCents(a, b);
  if (order === 0) return '0.00';
  const [large, small] = order > 0 ? [a, b] : [b, a];
  let result = '';
  let borrow = 0;
  for (let i = 1; i <= large.length; i += 1) {
    let digit = digitAt(large, i) - digitAt(small, i) - borrow;
    borrow = digit < 0 ? 1 : 0;
    if (digit < 0) digit += 10;
    result = String(digit) + result;
  }
  return centsToDecimal(stripLeadingZeros(result), order < 0);
}

/** The i-th digit from the right (1-based), 0 beyond the start. One character at a time: no number is ever parsed whole. */
function digitAt(digits: string, i: number): number {
  const char = digits.charAt(digits.length - i);
  return char === '' ? 0 : '0123456789'.indexOf(char);
}
