import type {
  ChangeRecordOutcome,
  ConfirmStep,
  ConstructionPeriodChanges,
  ConstructionPeriodFacts,
  ConstructionPeriodInterest,
  ConstructionPeriodInterestRepository,
  NamingClassification,
} from '../domains/taxation/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { LoanNotFoundError } from './loans.js';
import { PartyNotFoundError } from './parties.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';

/**
 * The construction-period records of Bauzeitzinsen (api-design.md §59E "Routes", backlog VC-X-36), in the caller's
 * verified Realm, and the errors of a classification naming one. Input arrives validated from the API boundary.
 */

/** Unknown or of another Realm (→ 404). */
export class ConstructionPeriodInterestNotFoundError extends Error {
  override readonly name = 'ConstructionPeriodInterestNotFoundError';

  constructor(readonly constructionPeriodInterestId: string) {
    super(`ConstructionPeriodInterest ${constructionPeriodInterestId} not found`);
  }
}

/** The record is `VOID` (→ 409 CONFLICT, reason `CONSTRUCTION_PERIOD_INTEREST_VOID`). */
export class ConstructionPeriodInterestVoidError extends Error {
  override readonly name = 'ConstructionPeriodInterestVoidError';

  constructor(readonly constructionPeriodInterestId: string) {
    super(`ConstructionPeriodInterest ${constructionPeriodInterestId} is void`);
  }
}

/** The record does not cover the split (→ 409 CONFLICT, reason `CONSTRUCTION_PERIOD_INTEREST_MISMATCH`). */
export class ConstructionPeriodInterestMismatchError extends Error {
  override readonly name = 'ConstructionPeriodInterestMismatchError';

  constructor(
    readonly details: {
      readonly loanId: string | null;
      readonly propertyReferenceId: string | null;
      readonly recordLoanId: string | null;
      readonly recordPropertyReferenceIds: readonly string[];
    },
  ) {
    super('The construction-period record does not cover the split');
  }
}

/** `CAPITALIZED` with a record of deductible interest (→ 409 CONFLICT, reason `CONSTRUCTION_PERIOD_INTEREST_DEDUCTIBLE`). */
export class ConstructionPeriodInterestDeductibleError extends Error {
  override readonly name = 'ConstructionPeriodInterestDeductibleError';

  constructor(readonly constructionPeriodInterestId: string) {
    super(`ConstructionPeriodInterest ${constructionPeriodInterestId} is deductible as vorab entstandene Werbungskosten: no free choice`);
  }
}

/** `constructionPeriodInterestId` on a split that is not interest, or with another treatment (→ 400 NOT_ALLOWED). */
export class ConstructionPeriodInterestNotAllowedError extends Error {
  override readonly name = 'ConstructionPeriodInterestNotAllowedError';

  constructor(readonly reason: 'NOT_INTEREST' | 'TREATMENT') {
    super(`constructionPeriodInterestId is not allowed here (${reason})`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

/** The identity of a create for `Idempotency-Key` replays: the Loan and the facts, the PropertyReferences sorted. */
export function recordFingerprint(input: { readonly loanId: string | null } & ConstructionPeriodFacts): string {
  return JSON.stringify([
    input.loanId,
    [...new Set(input.propertyReferenceIds)].sort(),
    input.measure,
    input.herstellungFrom,
    input.herstellungUntil,
    input.useIntent,
    input.advanceExpenseDeductible,
    `${input.buildingFundsShare.numerator}/${input.buildingFundsShare.denominator}`,
    input.earlierYearsTreatment,
    input.sourceReferences,
    input.notes,
  ]);
}

type Deps = { readonly repository: ConstructionPeriodInterestRepository };

export type CreateConstructionPeriodInterest = (
  input: ConstructionPeriodFacts & { readonly principal: RealmPrincipal; readonly loanId: string | null; readonly idempotencyKey?: string },
) => Promise<{ readonly record: ConstructionPeriodInterest; readonly replayed: boolean }>;

export function createConstructionPeriodInterest(deps: Deps): CreateConstructionPeriodInterest {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const outcome = await deps.repository.create(
      { mreRealmId: principal.mreRealmId, ...fields },
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: recordFingerprint(fields) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { record: outcome.record, replayed: false };
      case 'REPLAYED':
        return { record: outcome.record, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'LOAN_NOT_FOUND':
        throw new LoanNotFoundError(outcome.loanId);
      case 'PROPERTY_REFERENCE_NOT_FOUND':
        throw new PropertyReferenceNotFoundError(outcome.propertyReferenceId);
    }
  };
}

function changed(id: string, outcome: ChangeRecordOutcome): { readonly record: ConstructionPeriodInterest; readonly changed: boolean } {
  switch (outcome.kind) {
    case 'CHANGED':
      return { record: outcome.record, changed: outcome.changed };
    case 'NOT_FOUND':
      throw new ConstructionPeriodInterestNotFoundError(id);
    case 'RECORD_VOID':
      throw new ConstructionPeriodInterestVoidError(id);
    case 'PROPERTY_REFERENCE_NOT_FOUND':
      throw new PropertyReferenceNotFoundError(outcome.propertyReferenceId);
    case 'PARTY_NOT_FOUND':
      throw new PartyNotFoundError(outcome.partyId);
    case 'VERSION_CONFLICT':
      throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
  }
}

type Change<T> = (
  input: T & { readonly principal: RealmPrincipal; readonly id: string; readonly expectedVersions?: readonly number[] },
) => Promise<{ readonly record: ConstructionPeriodInterest; readonly changed: boolean }>;

export type AmendConstructionPeriodInterest = Change<{ readonly changes: ConstructionPeriodChanges }>;
export type ConfirmConstructionPeriodInterest = Change<{ readonly step: ConfirmStep }>;
export type VoidConstructionPeriodInterest = Change<{ readonly reason: string }>;

export function amendConstructionPeriodInterest(deps: Deps): AmendConstructionPeriodInterest {
  return async ({ principal, id, changes, expectedVersions }) =>
    changed(id, await deps.repository.amend(id, principal.mreRealmId, changes, actorOf(principal), expectedVersions));
}

export function confirmConstructionPeriodInterest(deps: Deps): ConfirmConstructionPeriodInterest {
  return async ({ principal, id, step, expectedVersions }) =>
    changed(id, await deps.repository.confirm(id, principal.mreRealmId, step, actorOf(principal), expectedVersions));
}

export function voidConstructionPeriodInterest(deps: Deps): VoidConstructionPeriodInterest {
  return async ({ principal, id, reason, expectedVersions }) =>
    changed(id, await deps.repository.void(id, principal.mreRealmId, reason, actorOf(principal), expectedVersions));
}

export type GetConstructionPeriodInterest = (input: {
  readonly principal: RealmPrincipal;
  readonly id: string;
}) => Promise<{ readonly record: ConstructionPeriodInterest; readonly classifications: readonly NamingClassification[] }>;

export function getConstructionPeriodInterest(deps: Deps): GetConstructionPeriodInterest {
  return async ({ principal, id }) => {
    const found = await deps.repository.find(id, principal.mreRealmId);
    if (found === undefined) throw new ConstructionPeriodInterestNotFoundError(id);
    return found;
  };
}

export type ListConstructionPeriodInterest = (input: {
  readonly principal: RealmPrincipal;
  readonly loanId?: string;
  readonly propertyReferenceId?: string;
}) => Promise<readonly ConstructionPeriodInterest[]>;

export function listConstructionPeriodInterest(deps: Deps): ListConstructionPeriodInterest {
  return ({ principal, loanId, propertyReferenceId }) =>
    deps.repository.list(principal.mreRealmId, {
      ...(loanId === undefined ? {} : { loanId }),
      ...(propertyReferenceId === undefined ? {} : { propertyReferenceId }),
    });
}

/** The six commands of the routes over one repository (the app's wiring and the acceptance tests'). */
export function constructionPeriodInterestCommands(repository: ConstructionPeriodInterestRepository) {
  const deps = { repository };
  return {
    create: createConstructionPeriodInterest(deps),
    get: getConstructionPeriodInterest(deps),
    list: listConstructionPeriodInterest(deps),
    amend: amendConstructionPeriodInterest(deps),
    confirm: confirmConstructionPeriodInterest(deps),
    void: voidConstructionPeriodInterest(deps),
  };
}
