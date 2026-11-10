/**
 * Money as the API sends it, `{ "amount": "850.00", "currency": "EUR" }` (ui-guide.md §5.2, api-design.md §86), shown in
 * German (`850,00 €`). The amount is a decimal string and stays one: no `parseFloat`, no `Number`, no floating point,
 * so 18 integer digits (the backend's limit) are shown exactly and nothing is rounded. A digit the API sends is shown;
 * a missing one is padded to the currency's two places, never invented beyond that.
 */
export interface MoneyValue {
  readonly amount: string;
  readonly currency: string;
}

/** The backend's decimal string: an optional minus, digits, optionally a point and digits. Nothing else is read. */
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const CURRENCY = /^[A-Z]{3}$/;
/** Minor-unit places shown at least (EUR, the only currency today; ui-guide.md §5.2). */
const MIN_FRACTION_DIGITS = 2;
const NBSP = '\u00a0';

/** `-1234.5` → `-1.234,50`; undefined for anything that is not a decimal string. Pure string work. */
export function formatDecimal(amount: string, minFractionDigits = MIN_FRACTION_DIGITS): string | undefined {
  const match = DECIMAL.exec(amount);
  if (match === null) return undefined;
  const [, sign = '', integerDigits = '', fractionDigits = ''] = match;
  const integer = integerDigits.replace(/^0+(?=\d)/, '');
  const fraction = fractionDigits.padEnd(minFractionDigits, '0');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const isZero = /^0*$/.test(integerDigits + fractionDigits);
  return `${sign === '-' && !isZero ? '-' : ''}${grouped}${fraction === '' ? '' : `,${fraction}`}`;
}

/** The amount with the opposite sign, as a string (`850.00` → `-850.00`). */
export function negateDecimal(amount: string): string {
  return amount.startsWith('-') ? amount.slice(1) : `-${amount}`;
}

/** `1.234,50 €` (no line break before the symbol); other currencies by their code. Undefined when unreadable. */
export function formatMoney(money: MoneyValue): string | undefined {
  const number = formatDecimal(money.amount);
  if (number === undefined || !CURRENCY.test(money.currency)) return undefined;
  return `${number}${NBSP}${money.currency === 'EUR' ? '€' : money.currency}`;
}

/**
 * A Transaction's amount with the sign of its direction (ui-guide.md §5.2: the amount is not negative, the direction is
 * `INFLOW`/`OUTFLOW`, the sign is added for display only; §4.1: a minus sign marks money going out).
 */
export function formatTransactionAmount(money: MoneyValue, direction: string): string | undefined {
  return formatMoney(direction === 'OUTFLOW' ? { amount: negateDecimal(money.amount), currency: money.currency } : money);
}
