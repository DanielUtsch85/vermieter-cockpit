import { formatBusinessDate, formatTimestamp } from '../format/dates';
import { formatMoney, formatTransactionAmount, type MoneyValue } from '../format/money';

/**
 * MoneyText and DateText (ui-guide.md §4.3): numbers right-aligned by the table, `tabular-nums` here (§4.2). A value
 * that cannot be read is said to be so, with the raw text; a missing one is "Nicht verfügbar" (§4.4: never an invented
 * 0,00 €).
 */
export function MoneyText({ money, direction }: { readonly money: MoneyValue | null | undefined; readonly direction?: string }) {
  if (money === null || money === undefined) return <span className="text-muted">Nicht verfügbar</span>;
  const text = direction === undefined ? formatMoney(money) : formatTransactionAmount(money, direction);
  if (text === undefined) return <span className="text-danger-text">{`Betrag nicht lesbar (${money.amount} ${money.currency})`}</span>;
  return <span className="whitespace-nowrap tabular-nums">{text}</span>;
}

export function DateText({ value }: { readonly value: string | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-muted">Nicht verfügbar</span>;
  const text = formatBusinessDate(value);
  return text === undefined ? <span className="text-danger-text">{`Datum nicht lesbar (${value})`}</span> : <time dateTime={value}>{text}</time>;
}

export function TimestampText({ value }: { readonly value: string | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-muted">Nicht verfügbar</span>;
  const text = formatTimestamp(value);
  return text === undefined ? <span className="text-danger-text">{`Zeitpunkt nicht lesbar (${value})`}</span> : <time dateTime={value}>{text}</time>;
}
