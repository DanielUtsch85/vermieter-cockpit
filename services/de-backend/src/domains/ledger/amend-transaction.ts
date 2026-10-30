import type { WegSplitRefusal } from './transaction-split.js';
import type { AuditActor, Money } from '../../shared/index.js';
import type { BusinessDate, Direction, Provenance, Transaction, TransactionStatus, VersionConflict } from './transaction.js';

/**
 * Changing an unconfirmed Transaction (api-design.md §31.3–31.4, backlog
 * VC-X-16): `amend` its fields, `ignore` it (domain-model.md §21: before
 * CONFIRMED any state may move to IGNORED) or `restore` an ignored one. A
 * confirmed Transaction is never changed this way; it is corrected (§35).
 */

/** States that may still change (the same as the splittable ones). */
export const AMENDABLE_STATUSES = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'] as const satisfies readonly TransactionStatus[];

/**
 * Fields an imported Transaction takes from its bank row: fixed there, it keeps the statement's values (§31.3).
 * `description` is the bank's Verwendungszweck — its only copy, which review items compare and rent matching reads.
 */
export const SOURCE_FIELDS = ['financialAccountId', 'amount', 'direction', 'bookingDate', 'valueDate', 'description'] as const;
export type SourceField = (typeof SOURCE_FIELDS)[number];

/** The fields to change; `undefined` = keep, `null` clears an optional one. */
export interface TransactionChanges {
  readonly financialAccountId?: string;
  readonly amount?: Money;
  readonly direction?: Direction;
  readonly bookingDate?: BusinessDate;
  readonly valueDate?: BusinessDate | null;
  readonly description?: string | null;
  readonly propertyReferenceId?: string | null;
}

export type AmendedField = SourceField | 'propertyReferenceId';

/** The values after the amendment. */
export interface AmendedValues {
  readonly financialAccountId: string;
  readonly amount: Money;
  readonly direction: Direction;
  readonly bookingDate: BusinessDate;
  readonly valueDate: BusinessDate | null;
  readonly description: string | null;
  readonly propertyReferenceId: string | null;
}

export type AmendPlan =
  | {
      readonly kind: 'AMEND';
      readonly values: AmendedValues;
      readonly changed: readonly AmendedField[];
      /** A changed amount invalidates a split set: it is dropped and the Transaction returns to its entry status. */
      readonly dropSplits: boolean;
      readonly nextStatus: TransactionStatus;
    }
  /** Every given value equals the current one: a 200 no-op (naturally idempotent). */
  | { readonly kind: 'UNCHANGED' }
  | { readonly kind: 'NOT_AMENDABLE'; readonly status: TransactionStatus }
  | { readonly kind: 'IMPORTED_FIELDS_FIXED'; readonly fields: readonly SourceField[] };

/** Where an unconfirmed Transaction starts (domain-model.md §21): IMPORTED from a source, UNREVIEWED by hand. */
export function entryStatus(provenance: Provenance): 'IMPORTED' | 'UNREVIEWED' {
  return provenance === 'MANUAL' ? 'UNREVIEWED' : 'IMPORTED';
}

export function planAmend(transaction: Transaction, changes: TransactionChanges): AmendPlan {
  if (!(AMENDABLE_STATUSES as readonly TransactionStatus[]).includes(transaction.status)) {
    return { kind: 'NOT_AMENDABLE', status: transaction.status };
  }
  const values: AmendedValues = {
    financialAccountId: changes.financialAccountId ?? transaction.financialAccountId,
    amount: changes.amount ?? transaction.amount,
    direction: changes.direction ?? transaction.direction,
    bookingDate: changes.bookingDate ?? transaction.bookingDate,
    valueDate: changes.valueDate === undefined ? transaction.valueDate : changes.valueDate,
    description: changes.description === undefined ? transaction.description : changes.description,
    propertyReferenceId: changes.propertyReferenceId === undefined ? transaction.propertyReferenceId : changes.propertyReferenceId,
  };
  const changed: AmendedField[] = [];
  if (values.financialAccountId !== transaction.financialAccountId) changed.push('financialAccountId');
  const amountChanged = !values.amount.equals(transaction.amount);
  if (amountChanged) changed.push('amount');
  if (values.direction !== transaction.direction) changed.push('direction');
  if (values.bookingDate !== transaction.bookingDate) changed.push('bookingDate');
  if (values.valueDate !== transaction.valueDate) changed.push('valueDate');
  if (values.description !== transaction.description) changed.push('description');
  if (values.propertyReferenceId !== transaction.propertyReferenceId) changed.push('propertyReferenceId');
  if (changed.length === 0) return { kind: 'UNCHANGED' };

  if (transaction.provenance !== 'MANUAL') {
    const fixed = changed.filter((f): f is SourceField => (SOURCE_FIELDS as readonly string[]).includes(f));
    if (fixed.length > 0) return { kind: 'IMPORTED_FIELDS_FIXED', fields: fixed };
  }
  const dropSplits = amountChanged && transaction.status === 'CLASSIFIED';
  return { kind: 'AMEND', values, changed, dropSplits, nextStatus: dropSplits ? entryStatus(transaction.provenance) : transaction.status };
}

export type IgnorePlan =
  | { readonly kind: 'IGNORE' }
  | { readonly kind: 'ALREADY_IGNORED' }
  | { readonly kind: 'NOT_IGNORABLE'; readonly status: TransactionStatus };

export function planIgnore(status: TransactionStatus): IgnorePlan {
  if (status === 'IGNORED') return { kind: 'ALREADY_IGNORED' };
  if ((AMENDABLE_STATUSES as readonly TransactionStatus[]).includes(status)) return { kind: 'IGNORE' };
  return { kind: 'NOT_IGNORABLE', status };
}

export type RestorePlan =
  | { readonly kind: 'RESTORE'; readonly nextStatus: TransactionStatus }
  | { readonly kind: 'NOT_IGNORED'; readonly status: TransactionStatus };

/**
 * Back from IGNORED: CLASSIFIED if it kept its split set (they still cover the amount, which cannot change while
 * IGNORED), else its entry status.
 */
export function planRestore(transaction: Pick<Transaction, 'status' | 'provenance'>, hasSplits: boolean): RestorePlan {
  if (transaction.status !== 'IGNORED') return { kind: 'NOT_IGNORED', status: transaction.status };
  return { kind: 'RESTORE', nextStatus: hasSplits ? 'CLASSIFIED' : entryStatus(transaction.provenance) };
}

export type AmendOutcome =
  /** `splitsDropped`: a changed amount discarded the split set (also in the response, §31.3). */
  | { readonly kind: 'AMENDED'; readonly transaction: Transaction; readonly changed: boolean; readonly splitsDropped: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | VersionConflict
  | Exclude<AmendPlan, { kind: 'AMEND' } | { kind: 'UNCHANGED' }>
  | { readonly kind: 'ACCOUNT_NOT_FOUND'; readonly financialAccountId: string }
  /** Moving to a different, closed account; its own closed account is fine (§31.3). */
  | { readonly kind: 'ACCOUNT_CLOSED'; readonly financialAccountId: string }
  | { readonly kind: 'CURRENCY_MISMATCH' }
  /** A split names a `CLOSED` Loan whose closing date is before the new booking date (§41.7). */
  | { readonly kind: 'LOAN_CLOSED'; readonly loanId: string; readonly closingDate: BusinessDate }
  /** A kept WEG split's unit has no membership on the new booking date (§49.3, review on #147). */
  | WegSplitRefusal
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND'; readonly propertyReferenceId: string };

export type IgnoreOutcome =
  | { readonly kind: 'IGNORED'; readonly transaction: Transaction; readonly replayed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | VersionConflict
  | Extract<IgnorePlan, { kind: 'NOT_IGNORABLE' }>;

export type RestoreOutcome =
  | { readonly kind: 'RESTORED'; readonly transaction: Transaction }
  | { readonly kind: 'NOT_FOUND' }
  | VersionConflict
  | Extract<RestorePlan, { kind: 'NOT_IGNORED' }>;

/** Persistence port, implemented in infrastructure/postgres. */
export interface UnconfirmedTransactionRepository {
  /**
   * Under the Transaction's row lock (then the account(s) `FOR SHARE` in id order, §35.5): applies `planAmend`
   * and the reference checks, writes the values, drops an invalidated split set, bumps the version and writes
   * the AuditRecord `AMENDED`. UNCHANGED answers the current state without a write.
   */
  amend(id: string, mreRealmId: string, changes: TransactionChanges, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendOutcome>;
  /** Under the row lock: IGNORED with an AuditRecord carrying the reason; already IGNORED is a no-op. */
  ignore(id: string, mreRealmId: string, reason: string, actor: AuditActor, expectedVersions?: readonly number[]): Promise<IgnoreOutcome>;
  /** Under the row lock: back from IGNORED per `planRestore`, with an AuditRecord. */
  restore(id: string, mreRealmId: string, actor: AuditActor, expectedVersions?: readonly number[]): Promise<RestoreOutcome>;
}
