import type { AuditActor, CurrencyCode } from '../../shared/index.js';

/**
 * FinancialAccount (data-model.md §16, domain-model.md §26): a bank, cash or
 * other account cash moves from or to. Not MRE `Account` (an application user)
 * and not a Loan. It belongs to a Realm, never to a single PropertyReference
 * (property associations live on Transactions/Splits, api-design.md §29.1).
 */

export type FinancialAccountId = string & { readonly __brand: 'FinancialAccountId' };

export const ACCOUNT_TYPES = ['BANK', 'SECURITY_DEPOSIT', 'LOAN_SETTLEMENT', 'CASH', 'OTHER'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_STATUSES = ['OPEN', 'CLOSED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface FinancialAccount {
  readonly id: FinancialAccountId;
  readonly mreRealmId: string;
  readonly accountType: AccountType;
  readonly displayName: string;
  readonly currency: CurrencyCode;
  /** Normalized IBAN; an external identifier only (data-model.md §6.5). */
  readonly iban: string | null;
  readonly status: AccountStatus;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
  readonly version: number;
}

/** A validated, normalized account about to be created. */
export interface NewFinancialAccount {
  readonly mreRealmId: string;
  readonly accountType: AccountType;
  readonly displayName: string;
  readonly currency: CurrencyCode;
  readonly iban: string | null;
}

/**
 * Identity of a create request for `Idempotency-Key` replays: the normalized
 * payload, so "DE89 3704…" and "de8937…" are the same request.
 */
export function createFingerprint(account: NewFinancialAccount): string {
  return JSON.stringify([account.accountType, account.displayName, account.currency, account.iban]);
}

export type CreateOutcome =
  | { readonly kind: 'CREATED'; readonly account: FinancialAccount }
  /** Same key, same payload: the account the first request created. */
  | { readonly kind: 'REPLAYED'; readonly account: FinancialAccount }
  /** Same key, different payload (api-design.md §29.1 → 409). */
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' };

export interface ClosePlan {
  readonly next: FinancialAccount;
  /** false when the account was already closed: nothing changes, nothing is audited. */
  readonly changed: boolean;
}

/**
 * Closing keeps the account and its history (historical Transactions remain
 * valid, data-model.md §16). Closing a closed account is a no-op, so a retried
 * close is safe.
 */
export function planClose(current: FinancialAccount, at: Date): ClosePlan {
  if (current.status === 'CLOSED') return { next: current, changed: false };
  return { next: { ...current, status: 'CLOSED', closedAt: at, version: current.version + 1 }, changed: true };
}

/** Persistence port, implemented in infrastructure/postgres. */
export interface FinancialAccountRepository {
  /**
   * Creates the account and writes its AuditRecord in one transaction. With an
   * idempotency key, the key is claimed in the same transaction: a concurrent or
   * later request with the same key never creates a second account.
   */
  create(
    account: NewFinancialAccount,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateOutcome>;
  /** Only within the given Realm: another Realm's account is not found. */
  findById(id: string, mreRealmId: string): Promise<FinancialAccount | undefined>;
  /**
   * Applies `planClose` under a row lock and audits a change in the same
   * transaction. Resolves undefined if the account does not exist in the Realm.
   */
  close(id: FinancialAccountId, mreRealmId: string, at: Date, actor: AuditActor): Promise<FinancialAccount | undefined>;
}
