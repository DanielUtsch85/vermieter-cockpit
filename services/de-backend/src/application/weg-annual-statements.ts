import {
  statementFingerprint,
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
import type { BusinessDate } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
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
