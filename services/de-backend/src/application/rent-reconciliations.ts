import {
  matchFingerprint,
  type CreateMatchOutcome,
  type NewMatch,
  type ReconciliationFilter,
  type ReconciliationPage,
  type ReconciliationStatus,
  type RentPaymentReconciliation,
  type RentReconciliationRepository,
} from '../domains/rent-reconciliation/index.js';
import type { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { TransactionNotFoundError } from './transaction-splits.js';

/**
 * Rent reconciliation commands and reads (api-design.md §37.1, backlog VC-4-01), in the caller's verified Realm. Input
 * arrives validated from the API boundary (ids, the term key's form, an amount > 0, texts trimmed).
 */

/**
 * Whether MRE returns the rent term `mreRentTerm` of the Tenant in the Realm, asked with the caller's own MRE
 * credentials (P4-D1). Throws AccessError when MRE refuses the caller and MreUnavailableError when MRE cannot be asked.
 */
export type MreRentTermLookup = (authorizationHeader: string, mreRealmId: string, mreTenantId: string, mreRentTerm: string) => Promise<boolean>;

export class ReconciliationNotFoundError extends Error {
  override readonly name = 'ReconciliationNotFoundError';

  constructor(readonly reconciliationId: string) {
    super(`Rent reconciliation ${reconciliationId} not found`);
  }
}

/** Not `CONFIRMED`/`RECONCILED`, or a reversal (→ 409 TRANSACTION_NOT_COUNTED). */
export class TransactionNotCountedError extends Error {
  override readonly name = 'TransactionNotCountedError';

  constructor(
    readonly status: string,
    readonly correctionRole: string | null,
  ) {
    super(`The Transaction is ${status}${correctionRole === null ? '' : ` (${correctionRole})`} and does not count`);
  }
}

/** `OUTFLOW` (→ 422 TRANSACTION_NOT_INFLOW). */
export class TransactionNotInflowError extends Error {
  override readonly name = 'TransactionNotInflowError';
}

/** No split in the rent categories (→ 422 NO_RENT_CASH). */
export class NoRentCashError extends Error {
  override readonly name = 'NoRentCashError';
}

/** A `CONFIRMED` reconciliation for the same Transaction and term exists (→ 409 ALREADY_MATCHED). */
export class AlreadyMatchedError extends Error {
  override readonly name = 'AlreadyMatchedError';

  constructor(readonly reconciliationId: string) {
    super(`Already matched by rent reconciliation ${reconciliationId}`);
  }
}

/** `matchedAmount` above the available rent cash (→ 409 RENT_CASH_EXCEEDED). */
export class RentCashExceededError extends Error {
  override readonly name = 'RentCashExceededError';

  constructor(
    readonly rentCash: Money,
    readonly available: Money,
  ) {
    super(`Only ${available.amount} of ${rentCash.amount} rent cash is available`);
  }
}

/** MRE did not return the term (→ 422 MRE_RENT_TERM_NOT_FOUND). */
export class MreRentTermNotFoundError extends Error {
  override readonly name = 'MreRentTermNotFoundError';

  constructor(
    readonly mreTenantId: string,
    readonly mreRentTerm: string,
  ) {
    super(`MRE did not return term ${mreRentTerm} of Tenant ${mreTenantId}`);
  }
}

/** `SUGGESTED` or `REJECTED` (→ 409 NOT_RELEASABLE). */
export class NotReleasableError extends Error {
  override readonly name = 'NotReleasableError';

  constructor(readonly status: ReconciliationStatus) {
    super(`A ${status} reconciliation cannot be released`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

function refusal(outcome: Exclude<CreateMatchOutcome, { kind: 'CREATED' | 'REPLAYED' }>, transactionId: string): Error {
  switch (outcome.kind) {
    case 'IDEMPOTENCY_CONFLICT':
      return new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
    case 'TRANSACTION_NOT_FOUND':
      return new TransactionNotFoundError(transactionId);
    case 'TRANSACTION_NOT_COUNTED':
      return new TransactionNotCountedError(outcome.status, outcome.correctionRole);
    case 'TRANSACTION_NOT_INFLOW':
      return new TransactionNotInflowError('The Transaction is not an INFLOW');
    case 'NO_RENT_CASH':
      return new NoRentCashError('The Transaction has no split in a rent category');
    case 'ALREADY_MATCHED':
      return new AlreadyMatchedError(outcome.reconciliationId);
    case 'RENT_CASH_EXCEEDED':
      return new RentCashExceededError(outcome.rentCash, outcome.available);
  }
}

export interface CreateReconciliationInput extends Omit<NewMatch, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  /** The caller's `Authorization` header, forwarded to MRE for the term read. */
  readonly authorizationHeader: string;
  readonly idempotencyKey?: string;
}

export type CreateReconciliation = (input: CreateReconciliationInput) => Promise<{ readonly reconciliation: RentPaymentReconciliation; readonly replayed: boolean }>;

/** §37.1's manual match: DE's checks, then MRE outside any transaction, then DE's checks again under the locks. */
export function createReconciliation(deps: { readonly repository: RentReconciliationRepository; readonly lookupMreRentTerm: MreRentTermLookup }): CreateReconciliation {
  return async ({ principal, authorizationHeader, idempotencyKey, ...fields }) => {
    const match: NewMatch = { mreRealmId: principal.mreRealmId, ...fields };
    const idempotency = idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: matchFingerprint(match) };
    const settle = (outcome: CreateMatchOutcome) => {
      if (outcome.kind === 'CREATED') return { reconciliation: outcome.reconciliation, replayed: false };
      if (outcome.kind === 'REPLAYED') return { reconciliation: outcome.reconciliation, replayed: true };
      throw refusal(outcome, match.transactionId);
    };
    // Checks 2–7 from DE alone, so a replay or a refusal never asks MRE.
    const pre = await deps.repository.precheck(match, idempotency);
    if (pre.kind !== 'PROCEED') return settle(pre);
    if (!(await deps.lookupMreRentTerm(authorizationHeader, match.mreRealmId, match.mreTenantId, match.mreRentTerm))) {
      throw new MreRentTermNotFoundError(match.mreTenantId, match.mreRentTerm);
    }
    return settle(await deps.repository.create(match, actorOf(principal), idempotency));
  };
}

export type GetReconciliation = (input: { readonly principal: RealmPrincipal; readonly reconciliationId: string }) => Promise<RentPaymentReconciliation>;

export function getReconciliation(deps: { readonly repository: RentReconciliationRepository }): GetReconciliation {
  return async ({ principal, reconciliationId }) => {
    const found = await deps.repository.findById(reconciliationId, principal.mreRealmId);
    // Unknown and other-Realm reconciliations look the same, so existence does not leak.
    if (found === undefined) throw new ReconciliationNotFoundError(reconciliationId);
    return found;
  };
}

export type ListReconciliations = (input: {
  readonly principal: RealmPrincipal;
  readonly filter: ReconciliationFilter;
  readonly page: { readonly page: number; readonly pageSize: number };
}) => Promise<ReconciliationPage>;

export function listReconciliations(deps: { readonly repository: RentReconciliationRepository }): ListReconciliations {
  return ({ principal, filter, page }) => deps.repository.list(principal.mreRealmId, filter, page);
}

export type ReleaseReconciliation = (input: {
  readonly principal: RealmPrincipal;
  readonly reconciliationId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly reconciliation: RentPaymentReconciliation; readonly changed: boolean }>;

/** §37.1's release: DE-only, never calls MRE (P4-D7). */
export function releaseReconciliation(deps: { readonly repository: RentReconciliationRepository; readonly now?: () => Date }): ReleaseReconciliation {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, reconciliationId, reason, expectedVersions }) => {
    const outcome = await deps.repository.release(reconciliationId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'RELEASED':
        return { reconciliation: outcome.reconciliation, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new ReconciliationNotFoundError(reconciliationId);
      case 'NOT_RELEASABLE':
        throw new NotReleasableError(outcome.status);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}
