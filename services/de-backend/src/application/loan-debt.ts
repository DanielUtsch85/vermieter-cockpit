import {
  paymentsInYear,
  remainingDebt,
  statementFingerprint,
  statementViews,
  type LoanDebtRepository,
  type PropertyPayments,
  type RemainingDebt,
  type RemainingDebtPerProperty,
  type StatementData,
  type StatementStatus,
  type StatementView,
  type YearPayments,
} from '../domains/financing/index.js';
import { businessDayOf } from '../domains/ledger/index.js';
import type { BusinessDate } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { LoanNotActiveError, LoanNotFoundError } from './loans.js';

/**
 * Remaining debt, payments and lender statements (api-design.md §41.6, backlog VC-3-06), in the caller's verified
 * Realm. Every value is derived on read from one snapshot; nothing here is stored but the statements.
 */

/** Per property and no set covers the day (→ 409 LOAN_NOT_ALLOCATED, BR-FIN-009). */
export class LoanNotAllocatedError extends Error {
  override readonly name = 'LoanNotAllocatedError';

  constructor(
    readonly loanId: string,
    readonly details: { readonly asOf: BusinessDate } | { readonly bookingDate: BusinessDate },
  ) {
    super(`Loan ${loanId} has no allocation set on ${'asOf' in details ? details.asOf : details.bookingDate}`);
  }
}

/** The statement date is before the debt starts (→ 422 STATEMENT_BEFORE_DEBT). */
export class StatementBeforeDebtError extends Error {
  override readonly name = 'StatementBeforeDebtError';

  constructor(readonly debtFrom: BusinessDate) {
    super(`The statement is before the debt starts on ${debtFrom}`);
  }
}

export class LoanBalanceStatementNotFoundError extends Error {
  override readonly name = 'LoanBalanceStatementNotFoundError';

  constructor(readonly statementId: string) {
    super(`LoanBalanceStatement ${statementId} not found`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

type Deps = { readonly repository: LoanDebtRepository; readonly now?: () => Date };

export type GetRemainingDebt = (input: {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  /** Defaults to today in Europe/Berlin. */
  readonly asOf?: BusinessDate;
  readonly perProperty: boolean;
}) => Promise<RemainingDebt | RemainingDebtPerProperty>;

export function getRemainingDebt(deps: Deps): GetRemainingDebt {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, loanId, asOf, perProperty }) => {
    const inputs = await deps.repository.debtInputs(loanId, principal.mreRealmId);
    if (inputs === undefined) throw new LoanNotFoundError(loanId);
    const outcome = remainingDebt(inputs, asOf ?? businessDayOf(now()), perProperty);
    switch (outcome.kind) {
      case 'LOAN_LEVEL':
      case 'PER_PROPERTY':
        return outcome.debt;
      case 'LOAN_NOT_ACTIVE':
        throw new LoanNotActiveError(loanId, outcome.status);
      case 'LOAN_NOT_ALLOCATED':
        throw new LoanNotAllocatedError(loanId, { asOf: outcome.asOf });
    }
  };
}

export type GetLoanPayments = (input: {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly year: number;
  readonly perProperty: boolean;
}) => Promise<YearPayments & { readonly items?: readonly PropertyPayments[] }>;

export function getLoanPayments(deps: Deps): GetLoanPayments {
  return async ({ principal, loanId, year, perProperty }) => {
    const inputs = await deps.repository.debtInputs(loanId, principal.mreRealmId);
    if (inputs === undefined) throw new LoanNotFoundError(loanId);
    const outcome = paymentsInYear(inputs, year, perProperty);
    switch (outcome.kind) {
      case 'LOAN_LEVEL':
        return outcome.payments;
      case 'PER_PROPERTY':
        return { ...outcome.payments, items: outcome.items };
      case 'LOAN_NOT_ACTIVE':
        throw new LoanNotActiveError(loanId, outcome.status);
      case 'LOAN_NOT_ALLOCATED':
        throw new LoanNotAllocatedError(loanId, { bookingDate: outcome.bookingDate });
    }
  };
}

export interface CreateBalanceStatementInput extends StatementData {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly idempotencyKey?: string;
}

export type CreateBalanceStatement = (input: CreateBalanceStatementInput) => Promise<{ readonly statement: StatementView; readonly replayed: boolean }>;

export function createBalanceStatement(deps: Deps): CreateBalanceStatement {
  return async ({ principal, loanId, idempotencyKey, ...data }) => {
    const outcome = await deps.repository.createStatement(
      loanId,
      principal.mreRealmId,
      data,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: statementFingerprint(loanId, data) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { statement: outcome.statement, replayed: false };
      case 'REPLAYED':
        return { statement: outcome.statement, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'LOAN_NOT_FOUND':
        throw new LoanNotFoundError(loanId);
      case 'LOAN_NOT_ACTIVE':
        throw new LoanNotActiveError(loanId, outcome.status);
      case 'STATEMENT_BEFORE_DEBT':
        throw new StatementBeforeDebtError(outcome.debtFrom);
    }
  };
}

export type VoidBalanceStatement = (input: {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly statementId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly statement: StatementView; readonly changed: boolean }>;

export function voidBalanceStatement(deps: Deps): VoidBalanceStatement {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, loanId, statementId, reason, expectedVersions }) => {
    const outcome = await deps.repository.voidStatement(loanId, statementId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'VOIDED':
        return { statement: outcome.statement, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new LoanBalanceStatementNotFoundError(statementId);
      case 'LOAN_NOT_ACTIVE':
        throw new LoanNotActiveError(loanId, outcome.status);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type ListBalanceStatements = (input: { readonly principal: RealmPrincipal; readonly loanId: string; readonly status?: StatementStatus }) => Promise<readonly StatementView[]>;

export function listBalanceStatements(deps: Deps): ListBalanceStatements {
  return async ({ principal, loanId, status }) => {
    const inputs = await deps.repository.debtInputs(loanId, principal.mreRealmId);
    if (inputs === undefined) throw new LoanNotFoundError(loanId);
    if (inputs.loan.status === 'VOID') throw new LoanNotActiveError(loanId, inputs.loan.status);
    return statementViews(inputs, status);
  };
}
