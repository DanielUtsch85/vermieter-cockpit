import {
  createFingerprint,
  type AccountType,
  type FinancialAccount,
  type FinancialAccountId,
  type FinancialAccountRepository,
} from '../domains/ledger/index.js';
import type { CurrencyCode } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError } from './errors.js';

/**
 * FinancialAccount commands (api-design.md §29, backlog VC-1-03). The account
 * is created in the caller's verified Realm; input arrives validated and
 * normalized from the API boundary.
 */

export class FinancialAccountNotFoundError extends Error {
  override readonly name = 'FinancialAccountNotFoundError';

  constructor(readonly financialAccountId: string) {
    super(`FinancialAccount ${financialAccountId} not found`);
  }
}

export interface CreateFinancialAccountInput {
  readonly principal: RealmPrincipal;
  readonly accountType: AccountType;
  readonly displayName: string;
  readonly currency: CurrencyCode;
  /** Normalized IBAN or null. */
  readonly iban: string | null;
  readonly idempotencyKey?: string;
}

export interface CreateFinancialAccountResult {
  readonly account: FinancialAccount;
  /** true when an earlier request with the same key and payload created it. */
  readonly replayed: boolean;
}

export type CreateFinancialAccount = (input: CreateFinancialAccountInput) => Promise<CreateFinancialAccountResult>;

export function createFinancialAccount(deps: { readonly repository: FinancialAccountRepository }): CreateFinancialAccount {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const account = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.create(
      account,
      { actorType: 'USER', actorId: principal.email },
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: createFingerprint(account) },
    );
    if (outcome.kind === 'IDEMPOTENCY_CONFLICT') {
      throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
    }
    return { account: outcome.account, replayed: outcome.kind === 'REPLAYED' };
  };
}

export interface CloseFinancialAccountInput {
  readonly principal: RealmPrincipal;
  readonly financialAccountId: string;
}

export type CloseFinancialAccount = (input: CloseFinancialAccountInput) => Promise<FinancialAccount>;

export function closeFinancialAccount(deps: {
  readonly repository: FinancialAccountRepository;
  readonly now?: () => Date;
}): CloseFinancialAccount {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, financialAccountId }) => {
    const closed = await deps.repository.close(
      financialAccountId as FinancialAccountId,
      principal.mreRealmId,
      now(),
      { actorType: 'USER', actorId: principal.email },
    );
    // Unknown and other-Realm accounts look the same, so existence does not leak.
    if (closed === undefined) throw new FinancialAccountNotFoundError(financialAccountId);
    return closed;
  };
}
