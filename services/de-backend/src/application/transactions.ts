import {
  manualTransactionFingerprint,
  type TransactionStatus,
  type BusinessDate,
  type Direction,
  type Transaction,
  type TransactionRepository,
} from '../domains/ledger/index.js';
import type { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { CurrencyMismatchError, IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { FinancialAccountNotFoundError } from './financial-accounts.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import { SplitSumMismatchError, TransactionNotFoundError } from './transaction-splits.js';

export { CurrencyMismatchError } from './errors.js';

/**
 * Create Manual Transaction (api-design.md §31, backlog VC-1-04): a cash-only
 * Transaction with provenance MANUAL and status UNREVIEWED, in the caller's
 * verified Realm. Input arrives validated from the API boundary (Money already
 * rejects negative-scale and unsupported-currency amounts).
 */

/** No new Transactions on a closed FinancialAccount (→ 409). */
export class FinancialAccountClosedError extends Error {
  override readonly name = 'FinancialAccountClosedError';

  constructor(readonly financialAccountId: string) {
    super(`FinancialAccount ${financialAccountId} is closed`);
  }
}

export interface CreateManualTransactionInput {
  readonly principal: RealmPrincipal;
  readonly financialAccountId: string;
  readonly amount: Money;
  readonly direction: Direction;
  readonly bookingDate: BusinessDate;
  readonly valueDate: BusinessDate | null;
  readonly description: string | null;
  readonly propertyReferenceId: string | null;
  readonly idempotencyKey?: string;
}

export interface CreateManualTransactionResult {
  readonly transaction: Transaction;
  /** true when an earlier request with the same key and payload created it. */
  readonly replayed: boolean;
}

export type CreateManualTransaction = (input: CreateManualTransactionInput) => Promise<CreateManualTransactionResult>;

export function createManualTransaction(deps: { readonly repository: TransactionRepository }): CreateManualTransaction {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const transaction = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.createManual(
      transaction,
      { actorType: 'USER', actorId: principal.email },
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: manualTransactionFingerprint(transaction) },
    );
    switch (outcome.kind) {
      case 'CREATED':
      case 'REPLAYED':
        return { transaction: outcome.transaction, replayed: outcome.kind === 'REPLAYED' };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'REJECTED':
        switch (outcome.reason) {
          case 'ACCOUNT_NOT_FOUND':
            throw new FinancialAccountNotFoundError(fields.financialAccountId);
          case 'ACCOUNT_CLOSED':
            throw new FinancialAccountClosedError(fields.financialAccountId);
          case 'CURRENCY_MISMATCH':
            throw new CurrencyMismatchError('Transaction currency differs from the account currency');
          case 'PROPERTY_REFERENCE_NOT_FOUND':
            throw new PropertyReferenceNotFoundError(fields.propertyReferenceId ?? '');
        }
    }
  };
}

/** CORRECTED or IGNORED: not confirmable (→ 409). */
export class TransactionNotConfirmableError extends Error {
  override readonly name = 'TransactionNotConfirmableError';

  constructor(
    readonly transactionId: string,
    readonly status: TransactionStatus,
  ) {
    super(`Transaction ${transactionId} is ${status} and cannot be confirmed`);
  }
}

/** Confirmation needs a complete split set (→ 409, domain-model.md §24). */
export class SplitsMissingError extends Error {
  override readonly name = 'SplitsMissingError';

  constructor(readonly transactionId: string) {
    super(`Transaction ${transactionId} has no splits yet`);
  }
}

/** A split's category was deactivated: the classification must be reviewed first (→ 422). */
export class InactiveCategoryError extends Error {
  override readonly name = 'InactiveCategoryError';

  constructor(readonly codes: readonly string[]) {
    super(`Inactive financial categories: ${codes.join(', ')}`);
  }
}

export interface ConfirmTransactionResult {
  readonly transaction: Transaction;
  /** true when it was already confirmed (a 200 no-op). */
  readonly replayed: boolean;
}

export type ConfirmTransaction = (input: {
  readonly principal: RealmPrincipal;
  readonly transactionId: string;
  /** From `If-Match` (api-design §16); omitted = no version check. */
  readonly expectedVersions?: readonly number[];
}) => Promise<ConfirmTransactionResult>;

/** Confirm Transaction (api-design.md §34, backlog VC-1-08). */
export function confirmTransaction(deps: { readonly repository: TransactionRepository }): ConfirmTransaction {
  return async ({ principal, transactionId, expectedVersions }) => {
    const outcome = await deps.repository.confirm(transactionId, principal.mreRealmId, { actorType: 'USER', actorId: principal.email }, expectedVersions);
    switch (outcome.kind) {
      case 'CONFIRMED':
        return { transaction: outcome.transaction, replayed: outcome.replayed };
      case 'NOT_FOUND':
        throw new TransactionNotFoundError(transactionId);
      case 'NOT_CONFIRMABLE':
        throw new TransactionNotConfirmableError(transactionId, outcome.status);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
      case 'SPLITS_MISSING':
        throw new SplitsMissingError(transactionId);
      case 'SUM_MISMATCH':
        throw new SplitSumMismatchError(outcome.expected, outcome.actual);
      case 'INACTIVE_CATEGORY':
        throw new InactiveCategoryError(outcome.codes);
    }
  };
}
