import {
  manualTransactionFingerprint,
  type BusinessDate,
  type Direction,
  type Transaction,
  type TransactionRepository,
} from '../domains/ledger/index.js';
import type { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { FinancialAccountNotFoundError, IdempotencyKeyConflictError } from './financial-accounts.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';

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

/** The Transaction's currency differs from its account's; there is no FX handling (data-model.md §17.7). */
export class CurrencyMismatchError extends Error {
  override readonly name = 'CurrencyMismatchError';
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
