import {
  createFingerprint,
  resolveNew,
  type DepositChanges,
  type DepositFilter,
  type DepositPage,
  type DepositRefusal,
  type DepositRequest,
  type DepositStatus,
  type DepositView,
  type SecurityDepositRepository,
} from '../domains/security-deposit/index.js';
import type { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { MreTenantNotFoundError } from './party-external-references.js';

/**
 * SecurityDeposit commands and reads (api-design.md §47.1, §47.3, backlog VC-5-01, VC-5-03), in the caller's verified Realm. Input
 * arrives validated and normalized from the API boundary (`mreTenantId` a 24-hex MRE id, amounts > 0, texts trimmed).
 */

/**
 * One MRE Tenant's deposit fields, read with the caller's own MRE credentials (so MRE enforces Realm isolation);
 * undefined when the Realm has no such Tenant. Throws AccessError when MRE refuses the caller and MreUnavailableError
 * when MRE cannot be asked.
 */
export type MreTenantDepositReader = (
  authorizationHeader: string,
  mreRealmId: string,
  mreTenantId: string,
) => Promise<{ readonly guaranty: Money | null; readonly guarantyPayback: Money | null } | undefined>;

export class SecurityDepositNotFoundError extends Error {
  override readonly name = 'SecurityDepositNotFoundError';

  constructor(readonly securityDepositId: string) {
    super(`Security deposit ${securityDepositId} not found`);
  }
}

/** The holding account is unknown or of another Realm (→ 404 with `details.financialAccountId`). */
export class HoldingAccountNotFoundError extends Error {
  override readonly name = 'HoldingAccountNotFoundError';

  constructor(readonly financialAccountId: string) {
    super(`FinancialAccount ${financialAccountId} not found`);
  }
}

/** The holding account is not a `SECURITY_DEPOSIT` account (→ 422 NOT_A_SECURITY_DEPOSIT_ACCOUNT, P5-D4). */
export class NotASecurityDepositAccountError extends Error {
  override readonly name = 'NotASecurityDepositAccountError';

  constructor(
    readonly financialAccountId: string,
    readonly accountType: string,
  ) {
    super(`FinancialAccount ${financialAccountId} is ${accountType}, not a SECURITY_DEPOSIT account`);
  }
}

/** The Tenant has a deposit that is not `VOID` (→ 409 DEPOSIT_EXISTS, P5-D1). */
export class DepositExistsError extends Error {
  override readonly name = 'DepositExistsError';

  constructor(readonly securityDepositId: string) {
    super(`The Tenant already has security deposit ${securityDepositId}`);
  }
}

/** No `expectedAmount` and MRE's `guaranty` is not set (→ 422 EXPECTED_AMOUNT_REQUIRED, P5-D1). */
export class ExpectedAmountRequiredError extends Error {
  override readonly name = 'ExpectedAmountRequiredError';

  constructor(readonly mreTenantId: string) {
    super(`No expectedAmount, and MRE has no guaranty for Tenant ${mreTenantId}`);
  }
}

/** Not `ACTIVE`: no amend, a no-op included (→ 409 DEPOSIT_NOT_ACTIVE). */
export class DepositNotActiveError extends Error {
  override readonly name = 'DepositNotActiveError';

  constructor(
    readonly securityDepositId: string,
    readonly status: DepositStatus,
  ) {
    super(`Security deposit ${securityDepositId} is ${status}`);
  }
}

/** A closed deposit is not voided (→ 409 DEPOSIT_CLOSED). */
export class DepositClosedError extends Error {
  override readonly name = 'DepositClosedError';

  constructor(readonly securityDepositId: string) {
    super(`Security deposit ${securityDepositId} is closed`);
  }
}

/** Splits reference the deposit (→ 409 DEPOSIT_HAS_SPLITS; from VC-5-02). */
export class DepositHasSplitsError extends Error {
  override readonly name = 'DepositHasSplitsError';

  constructor(
    readonly securityDepositId: string,
    readonly transactionIds: readonly string[],
  ) {
    super(`Security deposit ${securityDepositId} is referenced by splits of ${transactionIds.join(', ')}`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

function refusal(outcome: DepositRefusal): Error {
  switch (outcome.kind) {
    case 'ACCOUNT_NOT_FOUND':
      return new HoldingAccountNotFoundError(outcome.financialAccountId);
    case 'NOT_A_SECURITY_DEPOSIT_ACCOUNT':
      return new NotASecurityDepositAccountError(outcome.financialAccountId, outcome.accountType);
    case 'DEPOSIT_EXISTS':
      return new DepositExistsError(outcome.securityDepositId);
  }
}

export interface CreateDepositInput extends Omit<DepositRequest, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  readonly authorizationHeader: string;
  readonly idempotencyKey?: string;
}

export type CreateDeposit = (input: CreateDepositInput) => Promise<{ readonly deposit: DepositView; readonly replayed: boolean }>;

/**
 * §47.1's create: DE's checks first (a replay, a key conflict or a refusal never asks MRE), then the MRE Tenant outside
 * any database transaction, then the write repeating DE's checks under its locks.
 */
export function createDeposit(deps: { readonly repository: SecurityDepositRepository; readonly readMreTenant: MreTenantDepositReader }): CreateDeposit {
  return async ({ principal, authorizationHeader, idempotencyKey, ...fields }) => {
    const request: DepositRequest = { mreRealmId: principal.mreRealmId, ...fields };
    const idempotency = idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: createFingerprint(request) };
    const pre = await deps.repository.createPrecheck(request, idempotency);
    if (pre.kind === 'REPLAYED') return { deposit: pre.deposit, replayed: true };
    if (pre.kind === 'IDEMPOTENCY_CONFLICT') throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
    if (pre.kind !== 'PROCEED') throw refusal(pre);
    const tenant = await deps.readMreTenant(authorizationHeader, request.mreRealmId, request.mreTenantId);
    if (tenant === undefined) throw new MreTenantNotFoundError(request.mreTenantId);
    const deposit = resolveNew(request, tenant.guaranty);
    if (deposit === undefined) throw new ExpectedAmountRequiredError(request.mreTenantId);
    const outcome = await deps.repository.create(deposit, actorOf(principal), idempotency);
    switch (outcome.kind) {
      case 'CREATED':
        return { deposit: outcome.deposit, replayed: false };
      case 'REPLAYED':
        return { deposit: outcome.deposit, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      default:
        throw refusal(outcome);
    }
  };
}

export type GetDeposit = (input: { readonly principal: RealmPrincipal; readonly securityDepositId: string }) => Promise<DepositView>;

export function getDeposit(deps: { readonly repository: SecurityDepositRepository }): GetDeposit {
  return async ({ principal, securityDepositId }) => {
    const deposit = await deps.repository.findById(securityDepositId, principal.mreRealmId);
    // Unknown and other-Realm deposits look the same, so existence does not leak.
    if (deposit === undefined) throw new SecurityDepositNotFoundError(securityDepositId);
    return deposit;
  };
}

export type ListDeposits = (input: {
  readonly principal: RealmPrincipal;
  readonly filter: DepositFilter;
  readonly page: { readonly page: number; readonly pageSize: number };
}) => Promise<DepositPage>;

export function listDeposits(deps: { readonly repository: SecurityDepositRepository }): ListDeposits {
  return ({ principal, filter, page }) => deps.repository.list(principal.mreRealmId, filter, page);
}

export type AmendDeposit = (input: {
  readonly principal: RealmPrincipal;
  readonly securityDepositId: string;
  readonly changes: DepositChanges;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly deposit: DepositView; readonly changed: boolean }>;

/** §47.1's amend; never calls MRE. */
export function amendDeposit(deps: { readonly repository: SecurityDepositRepository }): AmendDeposit {
  return async ({ principal, securityDepositId, changes, expectedVersions }) => {
    const outcome = await deps.repository.amend(securityDepositId, principal.mreRealmId, changes, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'AMENDED':
        return { deposit: outcome.deposit, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new SecurityDepositNotFoundError(securityDepositId);
      case 'DEPOSIT_NOT_ACTIVE':
        throw new DepositNotActiveError(securityDepositId, outcome.status);
      case 'ACCOUNT_NOT_FOUND':
      case 'NOT_A_SECURITY_DEPOSIT_ACCOUNT':
        throw refusal(outcome);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type VoidDeposit = (input: {
  readonly principal: RealmPrincipal;
  readonly securityDepositId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly deposit: DepositView; readonly changed: boolean }>;

export function voidDeposit(deps: { readonly repository: SecurityDepositRepository; readonly now?: () => Date }): VoidDeposit {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, securityDepositId, reason, expectedVersions }) => {
    const outcome = await deps.repository.void(securityDepositId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'VOIDED':
        return { deposit: outcome.deposit, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new SecurityDepositNotFoundError(securityDepositId);
      case 'DEPOSIT_CLOSED':
        throw new DepositClosedError(securityDepositId);
      case 'DEPOSIT_HAS_SPLITS':
        throw new DepositHasSplitsError(securityDepositId, outcome.transactionIds);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}
