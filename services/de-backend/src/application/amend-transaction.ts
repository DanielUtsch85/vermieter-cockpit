import type {
  CashField,
  Transaction,
  TransactionChanges,
  TransactionStatus,
  UnconfirmedTransactionRepository,
} from '../domains/ledger/index.js';
import type { RealmPrincipal } from './access.js';
import { FinancialAccountNotFoundError } from './financial-accounts.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import { TransactionNotFoundError } from './transaction-splits.js';
import { CurrencyMismatchError, FinancialAccountClosedError } from './transactions.js';

/**
 * Amend, ignore and restore an unconfirmed Transaction (api-design.md §31.3–31.4, backlog VC-X-16). A confirmed
 * Transaction is corrected instead (§35). Input arrives validated from the API boundary.
 */

/** Confirmed or IGNORED: not amendable (→ 409). */
export class TransactionNotAmendableError extends Error {
  override readonly name = 'TransactionNotAmendableError';

  constructor(
    readonly transactionId: string,
    readonly status: TransactionStatus,
  ) {
    super(`Transaction ${transactionId} is ${status} and cannot be amended`);
  }
}

/** An imported Transaction keeps the bank statement's cash fields (→ 409). */
export class ImportedFieldsFixedError extends Error {
  override readonly name = 'ImportedFieldsFixedError';

  constructor(readonly fields: readonly CashField[]) {
    super(`Fields of an imported Transaction cannot be amended: ${fields.join(', ')}`);
  }
}

/** Confirmed (or later): not ignorable (→ 409). */
export class TransactionNotIgnorableError extends Error {
  override readonly name = 'TransactionNotIgnorableError';

  constructor(
    readonly transactionId: string,
    readonly status: TransactionStatus,
  ) {
    super(`Transaction ${transactionId} is ${status} and cannot be ignored`);
  }
}

/** Restore needs an IGNORED Transaction (→ 409). */
export class TransactionNotIgnoredError extends Error {
  override readonly name = 'TransactionNotIgnoredError';

  constructor(
    readonly transactionId: string,
    readonly status: TransactionStatus,
  ) {
    super(`Transaction ${transactionId} is ${status}, not IGNORED`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

export type AmendTransaction = (input: {
  readonly principal: RealmPrincipal;
  readonly transactionId: string;
  readonly changes: TransactionChanges;
}) => Promise<{ readonly transaction: Transaction; readonly changed: boolean }>;

export function amendTransaction(deps: { readonly repository: UnconfirmedTransactionRepository }): AmendTransaction {
  return async ({ principal, transactionId, changes }) => {
    const outcome = await deps.repository.amend(transactionId, principal.mreRealmId, changes, actorOf(principal));
    switch (outcome.kind) {
      case 'AMENDED':
        return { transaction: outcome.transaction, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new TransactionNotFoundError(transactionId);
      case 'NOT_AMENDABLE':
        throw new TransactionNotAmendableError(transactionId, outcome.status);
      case 'IMPORTED_FIELDS_FIXED':
        throw new ImportedFieldsFixedError(outcome.fields);
      case 'ACCOUNT_NOT_FOUND':
        throw new FinancialAccountNotFoundError(outcome.financialAccountId);
      case 'ACCOUNT_CLOSED':
        throw new FinancialAccountClosedError(outcome.financialAccountId);
      case 'CURRENCY_MISMATCH':
        throw new CurrencyMismatchError('Transaction currency differs from the account currency');
      case 'PROPERTY_REFERENCE_NOT_FOUND':
        throw new PropertyReferenceNotFoundError(outcome.propertyReferenceId);
    }
  };
}

export type IgnoreTransaction = (input: {
  readonly principal: RealmPrincipal;
  readonly transactionId: string;
  readonly reason: string;
}) => Promise<{ readonly transaction: Transaction; readonly replayed: boolean }>;

export function ignoreTransaction(deps: { readonly repository: UnconfirmedTransactionRepository }): IgnoreTransaction {
  return async ({ principal, transactionId, reason }) => {
    const outcome = await deps.repository.ignore(transactionId, principal.mreRealmId, reason, actorOf(principal));
    switch (outcome.kind) {
      case 'IGNORED':
        return { transaction: outcome.transaction, replayed: outcome.replayed };
      case 'NOT_FOUND':
        throw new TransactionNotFoundError(transactionId);
      case 'NOT_IGNORABLE':
        throw new TransactionNotIgnorableError(transactionId, outcome.status);
    }
  };
}

export type RestoreTransaction = (input: {
  readonly principal: RealmPrincipal;
  readonly transactionId: string;
}) => Promise<{ readonly transaction: Transaction }>;

export function restoreTransaction(deps: { readonly repository: UnconfirmedTransactionRepository }): RestoreTransaction {
  return async ({ principal, transactionId }) => {
    const outcome = await deps.repository.restore(transactionId, principal.mreRealmId, actorOf(principal));
    switch (outcome.kind) {
      case 'RESTORED':
        return { transaction: outcome.transaction };
      case 'NOT_FOUND':
        throw new TransactionNotFoundError(transactionId);
      case 'NOT_IGNORED':
        throw new TransactionNotIgnoredError(transactionId, outcome.status);
    }
  };
}
