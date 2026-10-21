import {
  correctionFingerprint,
  type CorrectionRepository,
  type CorrectionResult,
  type ReplacementInput,
  type TransactionStatus,
} from '../domains/ledger/index.js';
import type { RealmPrincipal } from './access.js';
import { FinancialAccountNotFoundError, IdempotencyKeyConflictError } from './financial-accounts.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import { FinancialCategoryNotFoundError, SplitSumMismatchError, TransactionNotFoundError } from './transaction-splits.js';
import { CurrencyMismatchError, FinancialAccountClosedError, InactiveCategoryError, VersionConflictError } from './transactions.js';

/**
 * Correct Transaction (api-design.md §35, backlog VC-1-11): a confirmed
 * Transaction is superseded by a confirmed reversal and a confirmed
 * replacement in one step; the original becomes CORRECTED (ADR-037). Input
 * arrives validated from the API boundary.
 */

/** Already corrected (→ 409); carries the existing correction so a retry can find it (§35.5). */
export class TransactionAlreadyCorrectedError extends Error {
  override readonly name = 'TransactionAlreadyCorrectedError';

  constructor(
    readonly transactionId: string,
    readonly reversalTransactionId: string,
    readonly replacementTransactionId: string,
  ) {
    super(`Transaction ${transactionId} is already corrected`);
  }
}

/** Not confirmed, IGNORED, RECONCILED (until Phase 4), or a reversal (→ 409). */
export class TransactionNotCorrectableError extends Error {
  override readonly name = 'TransactionNotCorrectableError';

  constructor(
    readonly transactionId: string,
    readonly status: TransactionStatus,
    readonly correctionRole?: 'REVERSAL',
  ) {
    super(`Transaction ${transactionId} (${correctionRole ?? status}) cannot be corrected`);
  }
}

/** The replacement equals the original in every field and split (→ 409). */
export class CorrectionNoChangeError extends Error {
  override readonly name = 'CorrectionNoChangeError';
}

export interface CorrectTransactionInput {
  readonly principal: RealmPrincipal;
  readonly transactionId: string;
  readonly reason: string;
  readonly replacement: ReplacementInput;
  readonly idempotencyKey?: string;
  /** From `If-Match` (api-design §16); omitted = no version check. */
  readonly expectedVersions?: readonly number[];
}

export interface CorrectTransactionResult extends CorrectionResult {
  /** true when an earlier request with the same key and payload made the correction. */
  readonly replayed: boolean;
}

export type CorrectTransaction = (input: CorrectTransactionInput) => Promise<CorrectTransactionResult>;

export function correctTransaction(deps: { readonly repository: CorrectionRepository }): CorrectTransaction {
  return async ({ principal, transactionId, reason, replacement, idempotencyKey, expectedVersions }) => {
    const request = { reason, replacement };
    const outcome = await deps.repository.correct(
      transactionId,
      principal.mreRealmId,
      request,
      { actorType: 'USER', actorId: principal.email },
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: correctionFingerprint(transactionId, request) },
      expectedVersions,
    );
    switch (outcome.kind) {
      case 'CORRECTED':
        return { ...outcome.result, replayed: outcome.replayed };
      case 'NOT_FOUND':
        throw new TransactionNotFoundError(transactionId);
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'ALREADY_CORRECTED':
        throw new TransactionAlreadyCorrectedError(transactionId, outcome.reversalTransactionId, outcome.replacementTransactionId);
      case 'NOT_CORRECTABLE':
        throw new TransactionNotCorrectableError(transactionId, outcome.status, outcome.correctionRole);
      case 'NO_CHANGE':
        throw new CorrectionNoChangeError('The replacement equals the original');
      case 'ACCOUNT_NOT_FOUND':
        throw new FinancialAccountNotFoundError(outcome.financialAccountId);
      case 'ACCOUNT_CLOSED':
        throw new FinancialAccountClosedError(outcome.financialAccountId);
      case 'CURRENCY_MISMATCH':
        throw new CurrencyMismatchError('Replacement currency differs from the account currency');
      case 'PROPERTY_REFERENCE_NOT_FOUND':
        throw new PropertyReferenceNotFoundError(outcome.propertyReferenceIds[0] ?? '');
      case 'UNKNOWN_CATEGORY':
        throw new FinancialCategoryNotFoundError(outcome.codes);
      case 'INACTIVE_CATEGORY':
        throw new InactiveCategoryError(outcome.codes);
      case 'SUM_MISMATCH':
        throw new SplitSumMismatchError(outcome.expected, outcome.actual);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}
