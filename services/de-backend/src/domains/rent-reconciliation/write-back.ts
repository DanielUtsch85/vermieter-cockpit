import type { BusinessDate, Money } from '../../shared/index.js';

/**
 * The write-back to MRE (api-design.md §37.4, phase-4-plan P4-D6): one MRE payment per `CONFIRMED` reconciliation,
 * marked with DE's identity, read before it is written and verified after. The term's whole settlement goes back as
 * read, because MRE's PATCH replaces it.
 */

export const WRITE_BACK_ERRORS = [
  'MRE_RENT_TERM_NOT_FOUND',
  'MRE_UNAVAILABLE',
  'MRE_FORBIDDEN',
  'MRE_WRITE_REFUSED',
  'MRE_PAYMENT_CHANGED',
  'MRE_TERM_CHANGED',
  'LEASE_EXPIRED',
] as const;
export type WriteBackError = (typeof WRITE_BACK_ERRORS)[number];

/** A payment of a term as MRE answered it; every value raw. */
export interface TermPayment {
  readonly date: unknown;
  readonly amount: unknown;
  readonly type: unknown;
  readonly reference: unknown;
  readonly description: unknown;
}

/** An MRE rent term as the write-back reads it: the Tenant, the VAT ratio and the whole settlement, raw. */
export interface WriteBackTerm {
  readonly mreTenantId: string;
  readonly term: string;
  readonly vatRatio: number;
  readonly payments: readonly TermPayment[];
  readonly promo: number;
  readonly notepromo: string;
  readonly extracharge: number;
  readonly noteextracharge: string;
  readonly description: string;
}

/** A payment in the form MRE's `_updateByTerm` stores it. */
export interface StoredPayment {
  readonly date: unknown;
  readonly amount: number;
  readonly type: unknown;
  readonly reference: unknown;
  readonly description: unknown;
}

/** The PATCH body without `_id`: the term's whole settlement. */
export interface TermWrite {
  readonly payments: readonly StoredPayment[];
  readonly promo: number;
  readonly notepromo: string;
  readonly extracharge: number;
  readonly noteextracharge: string;
  readonly description: string;
}

/** DE's payment as MRE stores it, kept on the reconciliation once `WRITTEN`. */
export interface MrePaymentSnapshot {
  readonly date: string;
  readonly amount: Money;
  readonly type: string;
  readonly reference: string;
}

/** DE's payment identity in MRE's `reference` (P4-D6, MRE-OPEN-003). */
export function markerOf(reconciliationId: string): string {
  return `DE-RPR-${reconciliationId.toLowerCase()}`;
}

/**
 * Payments as MRE's `_updateByTerm` stores them (review on #82): `amount` missing or ≤ 0 dropped (MRE drops them on
 * every save), `date || ''`, `Number(amount)`, `type || ''`, `reference || ''`, `description || ''`. A payment that never
 * went through MRE's save (an import, a seed) compares equal once it has.
 */
export function storedPayments(payments: readonly TermPayment[]): StoredPayment[] {
  return payments
    .filter((p) => Boolean(p.amount) && Number(p.amount) > 0)
    .map((p) => ({ date: p.date || '', amount: Number(p.amount), type: p.type || '', reference: p.reference || '', description: p.description || '' }));
}

/**
 * DE's payment: the booking date as `DD/MM/YYYY`, `matchedAmount` as a number written from its decimal text
 * (`"800.10"` → `800.1`, never float arithmetic on cents), `transfer` and the marker.
 */
export function dePayment(reconciliationId: string, matchedAmount: Money, bookingDate: BusinessDate): StoredPayment {
  const [year, month, day] = bookingDate.split('-');
  return { date: `${day}/${month}/${year}`, amount: Number(matchedAmount.amount), type: 'transfer', reference: markerOf(reconciliationId), description: '' };
}

/**
 * Under a VAT ratio MRE divides `promo` and `extracharge` on the way in and multiplies and rounds them on the way out,
 * so sending them back could change them (§37.4's `MRE_TERM_NOT_ROUND_TRIPPABLE`).
 */
export function isRoundTrippable(term: WriteBackTerm): boolean {
  return term.vatRatio === 0 || (term.promo === 0 && term.extracharge === 0);
}

/**
 * The PATCH body: every payment read, as MRE stores it, then DE's; `promo`, `extracharge` and `description` as read;
 * each note without the trailing `\n` the read adds.
 */
export function writeBody(read: WriteBackTerm, payment: StoredPayment): TermWrite {
  return {
    payments: [...storedPayments(read.payments), payment],
    promo: read.promo,
    notepromo: read.notepromo.replace(/\n$/, ''),
    extracharge: read.extracharge,
    noteextracharge: read.noteextracharge.replace(/\n$/, ''),
    description: read.description,
  };
}

/**
 * The marker in a term: `ABSENT`; `PRESENT` once with DE's date and amount (an earlier attempt wrote it); or
 * `CHANGED`, more than once or with another date or amount (edited in MRE by hand).
 */
export function markerIn(term: WriteBackTerm, payment: StoredPayment): 'ABSENT' | 'PRESENT' | 'CHANGED' {
  const marked = storedPayments(term.payments).filter((p) => p.reference === payment.reference);
  if (marked.length === 0) return 'ABSENT';
  const [only] = marked;
  return marked.length === 1 && only !== undefined && only.date === payment.date && only.amount === payment.amount && only.type === payment.type ? 'PRESENT' : 'CHANGED';
}

/**
 * Step 4: the term after the PATCH holds DE's payment once, every payment read (as MRE stores them) in its order,
 * and the settlement's other fields as read. `MARKER_ABSENT` when DE's payment is not there at all.
 */
export function verifyWritten(read: WriteBackTerm, after: WriteBackTerm, payment: StoredPayment): 'OK' | 'MARKER_ABSENT' | 'CHANGED' {
  const marker = markerIn(after, payment);
  if (marker === 'ABSENT') return 'MARKER_ABSENT';
  if (marker === 'CHANGED') return 'CHANGED';
  const others = (term: WriteBackTerm) => JSON.stringify(storedPayments(term.payments).filter((p) => p.reference !== payment.reference));
  const settlement = (term: WriteBackTerm) => JSON.stringify([term.promo, term.notepromo, term.extracharge, term.noteextracharge, term.description]);
  return others(after) === others(read) && settlement(after) === settlement(read) ? 'OK' : 'CHANGED';
}
