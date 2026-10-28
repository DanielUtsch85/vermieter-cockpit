import { Money } from '../../shared/index.js';
import type { NormalizedBankRow, ParsedRow } from './bank-statement.js';
import type { BusinessDate, Direction } from './transaction.js';

/**
 * Balance identity and continuity of a bank file (ADR-043, data-model.md §70.6): the bank's running balance after
 * each booking identifies the booking across overlapping exports, and the balances should chain from row to row.
 */

type DataRow = Extract<ParsedRow, { kind: 'ROW' }>;
type BalanceRow = DataRow & { readonly row: NormalizedBankRow & { readonly balanceAfter: string } };

/** `(bookingDate, amount, direction, balanceAfter)`; realm and account are the import's scope. */
export function balanceIdentityKey(row: {
  readonly bookingDate: BusinessDate;
  readonly amount: Money;
  readonly direction: Direction;
  readonly balanceAfter: string;
}): string {
  return JSON.stringify([row.bookingDate, row.amount.amount, row.direction, canonicalBalance(row.balanceAfter, row.amount.currency)]);
}

/** A balance as text in the currency's scale, so that a file's `"5.1"` and the database's `"5.10"` compare equal. */
export function canonicalBalance(balance: string, currency: string): string {
  const money = Money.of(balance, currency);
  return money.isZero() ? Money.zero(currency).amount : money.amount;
}

function withBalance(rows: readonly ParsedRow[]): BalanceRow[] {
  return rows.filter((r): r is BalanceRow => r.kind === 'ROW' && r.row.balanceAfter !== null);
}

/**
 * The positions whose balance identity is unique in the file (§70.6 "in-file uniqueness"). A repeated identity (a
 * debit, its return and the same debit again on one day) is used by none of its rows: they keep the fallback.
 */
export function uniqueBalanceIdentities(rows: readonly ParsedRow[]): ReadonlySet<number> {
  const byKey = new Map<string, number[]>();
  for (const r of withBalance(rows)) {
    const key = balanceIdentityKey({ ...r.row, balanceAfter: r.row.balanceAfter });
    byKey.set(key, [...(byKey.get(key) ?? []), r.position]);
  }
  return new Set([...byKey.values()].flatMap((positions) => (positions.length === 1 ? positions : [])));
}

export type FileOrder = 'OLDEST_FIRST' | 'NEWEST_FIRST';

/** How the file relates to the account's earlier balances (§70.6 "cross-file continuity"). */
export type PreviousExport =
  /** The oldest row continues from a known balance of an earlier day or the same day. */
  | 'CHAINS'
  /** The oldest row is a booking already imported with the same balance identity. */
  | 'OVERLAPS'
  /** Earlier balances exist, but none the oldest row continues from: bookings may be missing in between. */
  | 'GAP'
  /** No balance of the account up to the oldest row's day is known. */
  | 'NO_EARLIER_BALANCE';

export interface ChainBreak {
  readonly position: number;
  /** The previous row's balance plus this row's signed amount. */
  readonly expectedBalanceAfter: string;
  readonly balanceAfter: string;
}

/** The batch's continuity report (§70.6): reported, never a reason to refuse a file or change a row's outcome. */
export interface ContinuityReport {
  readonly order: FileOrder;
  readonly breaks: readonly ChainBreak[];
  readonly previousExport: PreviousExport;
}

/** The oldest booking of the file and the balance before it, for the cross-file check. */
export interface OldestBooking {
  readonly position: number;
  readonly bookingDate: BusinessDate;
  readonly identityKey: string;
  readonly balanceBefore: string;
}

export interface InFileContinuity {
  readonly order: FileOrder;
  readonly breaks: readonly ChainBreak[];
  readonly oldest: OldestBooking;
}

const signed = (row: NormalizedBankRow) => (row.direction === 'OUTFLOW' ? row.amount.negate() : row.amount);

/**
 * The in-file chain of the rows with a balance, in the file's own order (§70.6): oldest-first or newest-first, from the
 * dates; on equal first and last dates the order with fewer breaks. Undefined when no row has a balance.
 */
export function inFileContinuity(rows: readonly ParsedRow[]): InFileContinuity | undefined {
  const balanced = withBalance(rows);
  const [first] = balanced;
  const last = balanced.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const chronological = (order: FileOrder) => (order === 'OLDEST_FIRST' ? balanced : [...balanced].reverse());
  const breaksIn = (order: FileOrder) => chainBreaks(chronological(order));
  let order: FileOrder;
  if (first.row.bookingDate < last.row.bookingDate) order = 'OLDEST_FIRST';
  else if (first.row.bookingDate > last.row.bookingDate) order = 'NEWEST_FIRST';
  else order = breaksIn('NEWEST_FIRST').length < breaksIn('OLDEST_FIRST').length ? 'NEWEST_FIRST' : 'OLDEST_FIRST';
  const oldest = chronological(order)[0] ?? first;
  const currency = oldest.row.amount.currency;
  return {
    order,
    breaks: breaksIn(order),
    oldest: {
      position: oldest.position,
      bookingDate: oldest.row.bookingDate,
      identityKey: balanceIdentityKey({ ...oldest.row, balanceAfter: oldest.row.balanceAfter }),
      balanceBefore: Money.of(oldest.row.balanceAfter, currency).subtract(signed(oldest.row)).amount,
    },
  };
}

function chainBreaks(chronological: readonly BalanceRow[]): ChainBreak[] {
  const breaks: ChainBreak[] = [];
  for (let i = 1; i < chronological.length; i++) {
    const previous = chronological[i - 1];
    const current = chronological[i];
    if (previous === undefined || current === undefined) continue;
    const currency = current.row.amount.currency;
    const expected = Money.of(previous.row.balanceAfter, currency).add(signed(current.row));
    const actual = Money.of(current.row.balanceAfter, currency);
    if (!expected.equals(actual)) breaks.push({ position: current.position, expectedBalanceAfter: expected.amount, balanceAfter: actual.amount });
  }
  return breaks;
}

/** What the account already holds that the cross-file check needs; looked up by the repository. */
export interface KnownBalances {
  /** The oldest row's balance identity matches an imported Transaction. */
  readonly oldestImported: boolean;
  /** A Transaction of the account up to the oldest row's day has the oldest row's balance before as its balance after. */
  readonly continuesFromKnown: boolean;
  /** Any Transaction of the account up to the oldest row's day carries a balance. */
  readonly anyEarlierBalance: boolean;
}

export function previousExport(known: KnownBalances): PreviousExport {
  if (known.oldestImported) return 'OVERLAPS';
  if (known.continuesFromKnown) return 'CHAINS';
  return known.anyEarlierBalance ? 'GAP' : 'NO_EARLIER_BALANCE';
}
