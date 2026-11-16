import type { RentTenantDto, TenantTermsDto, TermWindow } from '../api/rent-reconciliations';
import { formatBusinessDate } from '../format/dates';
import { formatMoney, type MoneyValue } from '../format/money';
import { termDate } from './reconciliation-rules';

/**
 * Choosing the Tenant and the term (#364; api-design.md §37.7; Entscheidung des Projektinhabers, 2026-11-16): the window
 * of months around a booking date and the texts of the two lists. Pure functions; the Tenant is named by its MRE id
 * only, never by a name, and the term by its date with the key.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const monthOf = (index: number) => `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;

/**
 * The months the term list asks for: from the second month before the booking date to the month after it (§37.7;
 * Entscheidung des Projektinhabers, 2026-11-16, on #375: „Zeitfenster: ändern auf zwei Monate davor bis einen Monat
 * danach. Nachzahler sind häufiger als Vorauszahler; vier MRE-Monatsreads sind vertretbar.“), so a late payer's last
 * two terms and an early payer's next one are in it: four months, within the route's twelve. Undefined for a date that
 * is none.
 */
export function termWindow(bookingDate: string): TermWindow | undefined {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(bookingDate);
  if (match === null) return undefined;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  const index = Number(match[1]) * 12 + month - 1;
  return { from: monthOf(index - 2), to: monthOf(index + 1) };
}

/** `2026-10` → `10.2026`, for the window's text. */
export const monthText = (ym: string): string => `${ym.slice(5, 7)}.${ym.slice(0, 4)}`;

const termText = (term: string): string => {
  const date = termDate(term);
  return date === undefined ? `Termin ${term}` : `Termin ${formatBusinessDate(date) ?? date} (${term})`;
};
const money = (value: MoneyValue): string => formatMoney(value) ?? `${value.amount} ${value.currency}`;

/** One Tenant of the list: the MRE id, the latest term and how many reconciliations name it; no name. */
export function tenantOptionText(t: RentTenantDto): string {
  const date = termDate(t.latestMreRentTerm);
  const latest = date === undefined ? t.latestMreRentTerm : (formatBusinessDate(date) ?? date);
  return `${t.mreTenantId} · zuletzt Termin ${latest} · ${t.reconciliationCount} ${t.reconciliationCount === 1 ? 'Zuordnung' : 'Zuordnungen'}`;
}

/**
 * One term of the list: its date and key, and what MRE and DE say of it. MRE's amount due and the open amount when MRE
 * lists it; a term only DE knows says so; without MRE only DE's matched total.
 */
export function termOptionText(item: TenantTermsDto['items'][number]): string {
  const matched = `zugeordnet ${money(item.matchedTotal)}`;
  if (item.inMre === true && item.amountDue !== null) {
    const open = item.openAmount === null ? '' : ` · offen ${money(item.openAmount)}`;
    return `${termText(item.mreRentTerm)} · Soll ${money(item.amountDue)}${open}`;
  }
  if (item.inMre === false) return `${termText(item.mreRentTerm)} · in MRE nicht mehr geführt · ${matched}`;
  return `${termText(item.mreRentTerm)} · ${matched}`;
}

/** What the list says about MRE's side, or undefined when there is nothing to say. */
export function termListNote(terms: TenantTermsDto): string | undefined {
  const window = `${monthText(terms.from)} bis ${monthText(terms.to)}`;
  switch (terms.mreStatus) {
    case 'AVAILABLE':
      return terms.items.length === 0 ? `MRE führt für diesen Mieter von ${window} keinen Termin.` : undefined;
    case 'NOT_RETURNED':
      return 'MRE führt diesen Mieter im Bestand nicht (mehr). Gezeigt sind nur die Zuordnungen in DE; den Terminschlüssel bitte prüfen oder eintippen.';
    case 'UNAVAILABLE':
      return 'MRE war nicht erreichbar. Gezeigt sind nur die Zuordnungen in DE; der Terminschlüssel kann eingetippt werden.';
    default:
      return `Stand in MRE: ${terms.mreStatus}.`;
  }
}
