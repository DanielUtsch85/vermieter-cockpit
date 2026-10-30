import {
  deriveComparison,
  proposeSettlement,
  statementFingerprint,
  type Comparison,
  type ProposedSettlementSplit,
  type SettlementFlag,
  type InvalidSupersedesReason,
  type NewAnnualStatement,
  type Page,
  type PageRequest,
  type StatementContent,
  type StatementFilter,
  type StatementRefusal,
  type StatementStatus,
  type StatementView,
  type WegAnnualStatementRepository,
} from '../domains/weg/index.js';
import type { BusinessDate, Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { StatementNotCurrentError, TransactionNotFoundError } from './transaction-splits.js';
import { MembershipNotActiveError, WegMembershipNotFoundError } from './wegs.js';

/**
 * The Jahresabrechnung (api-design.md §50, backlog VC-6-03), in the caller's verified Realm. Input arrives validated
 * from the API boundary. No MRE call (P6-D9).
 */

export class AnnualStatementNotFoundError extends Error {
  override readonly name = 'AnnualStatementNotFoundError';

  constructor(readonly statementId: string) {
    super(`Annual statement ${statementId} not found`);
  }
}

/** The period is not inside the financial year (→ 400 OUT_OF_RANGE at `periodFrom` or `periodUntil`, §50). */
export class PeriodOutsideYearError extends Error {
  override readonly name = 'PeriodOutsideYearError';

  constructor(
    readonly field: 'periodFrom' | 'periodUntil',
    readonly from: BusinessDate,
    readonly until: BusinessDate,
  ) {
    super(`${field} lies outside the financial year ${from} – ${until}`);
  }
}

/** The period is not inside the membership's (→ 422 STATEMENT_OUTSIDE_MEMBERSHIP). */
export class StatementOutsideMembershipError extends Error {
  override readonly name = 'StatementOutsideMembershipError';

  constructor(
    readonly validFrom: BusinessDate,
    readonly validUntil: BusinessDate | null,
  ) {
    super(`The statement's period lies outside the membership ${validFrom} – ${validUntil ?? 'open'}`);
  }
}

/** `supersedes` names no `CONFIRMED` statement of the same membership and year (→ 422 INVALID_SUPERSEDES). */
export class InvalidSupersedesError extends Error {
  override readonly name = 'InvalidSupersedesError';

  constructor(
    readonly supersedes: string,
    readonly reason: InvalidSupersedesReason,
  ) {
    super(`Statement ${supersedes} cannot be superseded: ${reason}`);
  }
}

/** Only a `DRAFT` is replaced, confirmed or voided (→ 409 STATEMENT_NOT_DRAFT). */
export class StatementNotDraftError extends Error {
  override readonly name = 'StatementNotDraftError';

  constructor(
    readonly statementId: string,
    readonly status: StatementStatus,
  ) {
    super(`Annual statement ${statementId} is ${status}`);
  }
}

/** Another statement of the membership and year is `CONFIRMED`; supersede it instead (→ 409 STATEMENT_EXISTS). */
export class StatementExistsError extends Error {
  override readonly name = 'StatementExistsError';

  constructor(readonly statementId: string) {
    super(`Statement ${statementId} is confirmed for the year`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

function throwRefusal(outcome: StatementRefusal, membershipId: string): never {
  switch (outcome.kind) {
    case 'MEMBERSHIP_NOT_FOUND':
      throw new WegMembershipNotFoundError(membershipId);
    case 'PERIOD_OUTSIDE_YEAR':
      throw new PeriodOutsideYearError(outcome.field, outcome.from, outcome.until);
    case 'MEMBERSHIP_NOT_ACTIVE':
      throw new MembershipNotActiveError(outcome.membershipId);
    case 'STATEMENT_OUTSIDE_MEMBERSHIP':
      throw new StatementOutsideMembershipError(outcome.validFrom, outcome.validUntil);
    case 'INVALID_SUPERSEDES':
      throw new InvalidSupersedesError(outcome.supersedes, outcome.reason);
  }
}

export interface CreateAnnualStatementInput extends Omit<NewAnnualStatement, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  readonly idempotencyKey?: string;
}

export type CreateAnnualStatement = (input: CreateAnnualStatementInput) => Promise<{ readonly statement: StatementView; readonly replayed: boolean }>;

export function createAnnualStatement(deps: { readonly repository: WegAnnualStatementRepository }): CreateAnnualStatement {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const statement = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.createStatement(
      statement,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: statementFingerprint(statement) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { statement: outcome.statement, replayed: false };
      case 'REPLAYED':
        return { statement: outcome.statement, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      default:
        return throwRefusal(outcome, fields.membershipId);
    }
  };
}

export type ReplaceAnnualStatement = (input: {
  readonly principal: RealmPrincipal;
  readonly statementId: string;
  readonly content: StatementContent;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly statement: StatementView; readonly changed: boolean }>;

export function replaceAnnualStatement(deps: { readonly repository: WegAnnualStatementRepository }): ReplaceAnnualStatement {
  return async ({ principal, statementId, content, expectedVersions }) => {
    const outcome = await deps.repository.replaceStatement(statementId, principal.mreRealmId, content, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'REPLACED':
        return { statement: outcome.statement, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new AnnualStatementNotFoundError(statementId);
      case 'STATEMENT_NOT_DRAFT':
        throw new StatementNotDraftError(statementId, outcome.status);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
      case 'MEMBERSHIP_NOT_FOUND':
        // The statement's membership exists (foreign key): only reachable through a foreign Realm, which is not found.
        throw new AnnualStatementNotFoundError(statementId);
      default:
        return throwRefusal(outcome, statementId);
    }
  };
}

export type ConfirmAnnualStatement = (input: {
  readonly principal: RealmPrincipal;
  readonly statementId: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly statement: StatementView; readonly changed: boolean }>;

export function confirmAnnualStatement(deps: { readonly repository: WegAnnualStatementRepository; readonly now?: () => Date }): ConfirmAnnualStatement {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, statementId, expectedVersions }) => {
    const outcome = await deps.repository.confirmStatement(statementId, principal.mreRealmId, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'CONFIRMED':
        return { statement: outcome.statement, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new AnnualStatementNotFoundError(statementId);
      case 'STATEMENT_NOT_DRAFT':
        throw new StatementNotDraftError(statementId, outcome.status);
      case 'INVALID_SUPERSEDES':
        throw new InvalidSupersedesError(outcome.supersedes, outcome.reason);
      case 'STATEMENT_EXISTS':
        throw new StatementExistsError(outcome.statementId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type VoidAnnualStatement = (input: {
  readonly principal: RealmPrincipal;
  readonly statementId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly statement: StatementView; readonly changed: boolean }>;

export function voidAnnualStatement(deps: { readonly repository: WegAnnualStatementRepository; readonly now?: () => Date }): VoidAnnualStatement {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, statementId, reason, expectedVersions }) => {
    const outcome = await deps.repository.voidStatement(statementId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'VOIDED':
        return { statement: outcome.statement, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new AnnualStatementNotFoundError(statementId);
      case 'STATEMENT_NOT_DRAFT':
        throw new StatementNotDraftError(statementId, outcome.status);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type GetAnnualStatement = (input: { readonly principal: RealmPrincipal; readonly statementId: string }) => Promise<StatementView>;

export function getAnnualStatement(deps: { readonly repository: WegAnnualStatementRepository }): GetAnnualStatement {
  return async ({ principal, statementId }) => {
    const statement = await deps.repository.findStatement(statementId, principal.mreRealmId);
    if (statement === undefined) throw new AnnualStatementNotFoundError(statementId);
    return statement;
  };
}

export type ListAnnualStatements = (input: {
  readonly principal: RealmPrincipal;
  readonly membershipId: string;
  readonly filter: StatementFilter;
  readonly page: PageRequest;
}) => Promise<Page<StatementView>>;

export function listAnnualStatements(deps: { readonly repository: WegAnnualStatementRepository }): ListAnnualStatements {
  return async ({ principal, membershipId, filter, page }) => {
    const result = await deps.repository.listStatements(membershipId, principal.mreRealmId, filter, page);
    if (result === undefined) throw new WegMembershipNotFoundError(membershipId);
    return result;
  };
}

/** The comparison reads a `CONFIRMED` or `SUPERSEDED` statement (§51 → 409 STATEMENT_NOT_CONFIRMED). */
export class StatementNotConfirmedError extends Error {
  override readonly name = 'StatementNotConfirmedError';

  constructor(
    readonly statementId: string,
    readonly status: string,
  ) {
    super(`Annual statement ${statementId} is ${status}`);
  }
}

/** Only an unconfirmed Transaction gets a settlement proposal (§51 → 409 NOT_PROPOSABLE). */
export class SettlementNotProposableError extends Error {
  override readonly name = 'SettlementNotProposableError';

  constructor(readonly status: string) {
    super(`A Transaction in ${status} gets no settlement proposal`);
  }
}

/** The statement's Abrechnungsspitze is 0 (§51 → 409 NOTHING_TO_SETTLE). */
export class NothingToSettleError extends Error {
  override readonly name = 'NothingToSettleError';

  constructor(readonly statementId: string) {
    super(`Annual statement ${statementId} has nothing to settle`);
  }
}

/** A back-payment is an OUTFLOW, a refund an INFLOW (§51 → 422 SETTLEMENT_DIRECTION_MISMATCH). */
export class SettlementDirectionMismatchError extends Error {
  override readonly name = 'SettlementDirectionMismatchError';

  constructor(readonly expected: 'INFLOW' | 'OUTFLOW') {
    super(`The settlement is an ${expected}`);
  }
}

export interface StatementComparison extends Comparison {
  readonly statementId: string;
  readonly membershipId: string;
  readonly propertyReferenceId: string;
  readonly financialYear: number;
  readonly periodFrom: BusinessDate;
  readonly periodUntil: BusinessDate;
  readonly status: string;
}

export type GetStatementComparison = (input: { readonly principal: RealmPrincipal; readonly statementId: string }) => Promise<StatementComparison>;

/** §51: a read, never a write. */
export function getStatementComparison(deps: { readonly repository: WegAnnualStatementRepository }): GetStatementComparison {
  return async ({ principal, statementId }) => {
    const context = await deps.repository.comparisonContext(statementId, principal.mreRealmId);
    if (context.kind === 'NOT_FOUND') throw new AnnualStatementNotFoundError(statementId);
    if (context.kind === 'STATEMENT_NOT_CONFIRMED') throw new StatementNotConfirmedError(statementId, context.status);
    const { statement } = context;
    return {
      statementId: statement.id,
      membershipId: statement.membershipId,
      propertyReferenceId: context.propertyReferenceId,
      financialYear: statement.financialYear,
      periodFrom: statement.periodFrom,
      periodUntil: statement.periodUntil,
      status: statement.status,
      ...deriveComparison(context),
    };
  };
}

export type SettlementProposalFlag =
  | SettlementFlag
  | { readonly code: 'ALREADY_SPLIT'; readonly details: Record<string, never> }
  | { readonly code: 'ALREADY_SETTLED'; readonly details: { readonly transactionIds: readonly string[] } };

export interface SettlementProposal {
  readonly transactionId: string;
  readonly statementId: string;
  readonly amount: Money;
  readonly direction: 'INFLOW' | 'OUTFLOW';
  readonly settlementPeak: Money;
  readonly splits: readonly (ProposedSettlementSplit & { readonly propertyReferenceId: string; readonly wegAnnualStatementId: string })[];
  readonly flags: readonly SettlementProposalFlag[];
}

export type GetSettlementProposal = (input: {
  readonly principal: RealmPrincipal;
  readonly transactionId: string;
  readonly statementId: string;
}) => Promise<SettlementProposal>;

/** §51: a read, never a write; the client applies it through `PUT …/splits`. */
export function getSettlementProposal(deps: { readonly repository: WegAnnualStatementRepository }): GetSettlementProposal {
  return async ({ principal, transactionId, statementId }) => {
    const context = await deps.repository.settlementContext(transactionId, statementId, principal.mreRealmId);
    switch (context.kind) {
      case 'TRANSACTION_NOT_FOUND':
        throw new TransactionNotFoundError(transactionId);
      case 'STATEMENT_NOT_FOUND':
        throw new AnnualStatementNotFoundError(statementId);
      case 'NOT_PROPOSABLE':
        throw new SettlementNotProposableError(context.status);
      case 'STATEMENT_NOT_CURRENT':
        throw new StatementNotCurrentError(statementId, context.status, context.supersededBy);
      case 'FOUND': {
        const comparison = deriveComparison(context.comparison);
        const peak = comparison.settlementPeak;
        if (peak.isZero()) throw new NothingToSettleError(statementId);
        const expected = peak.isNegative() ? 'INFLOW' : 'OUTFLOW';
        if (context.direction !== expected) throw new SettlementDirectionMismatchError(expected);
        const proposal = proposeSettlement(context.amount, context.direction, comparison);
        const flags: SettlementProposalFlag[] = [...proposal.flags];
        if (context.alreadySplit) flags.push({ code: 'ALREADY_SPLIT', details: {} });
        const settled = [...new Set(comparison.settlement.settledBy.map((s) => s.transactionId))].sort();
        if (settled.length > 0) flags.push({ code: 'ALREADY_SETTLED', details: { transactionIds: settled } });
        return {
          transactionId: context.transactionId,
          statementId,
          amount: context.amount,
          direction: context.direction,
          settlementPeak: peak,
          splits: proposal.splits.map((s) => ({ ...s, propertyReferenceId: context.comparison.propertyReferenceId, wegAnnualStatementId: statementId })),
          flags,
        };
      }
    }
  };
}
