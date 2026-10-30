import { businessDayOf } from '../domains/ledger/index.js';
import {
  assessmentFingerprint,
  type AssessmentContent,
  type AssessmentFilter,
  type AssessmentUse,
  type AssessmentView,
  type NewSpecialAssessment,
  type Page,
  type PageRequest,
  type WegSpecialAssessmentRepository,
} from '../domains/weg/index.js';
import type { BusinessDate } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { AssessmentNotActiveError } from './transaction-splits.js';
import { MembershipNotActiveError, WegMembershipNotFoundError } from './wegs.js';

/**
 * The Sonderumlage (api-design.md §51A, backlog VC-6-05), in the caller's verified Realm. Input arrives validated from
 * the API boundary; the reads derive their figures at `asOf`, by default today in Europe/Berlin. No MRE call (P6-D9).
 */

export class SpecialAssessmentNotFoundError extends Error {
  override readonly name = 'SpecialAssessmentNotFoundError';

  constructor(readonly assessmentId: string) {
    super(`Special assessment ${assessmentId} not found`);
  }
}

/** The resolution date lies outside the membership (→ 422 ASSESSMENT_OUTSIDE_MEMBERSHIP). */
export class AssessmentOutsideMembershipError extends Error {
  override readonly name = 'AssessmentOutsideMembershipError';

  constructor(
    readonly validFrom: BusinessDate,
    readonly validUntil: BusinessDate | null,
  ) {
    super(`The resolution date lies outside the membership ${validFrom} – ${validUntil ?? 'open'}`);
  }
}

/** Splits name the Sonderumlage, a reversal's included (→ 409 ASSESSMENT_HAS_SPLITS). */
export class AssessmentHasSplitsError extends Error {
  override readonly name = 'AssessmentHasSplitsError';

  constructor(
    readonly assessmentId: string,
    readonly transactionIds: readonly string[],
  ) {
    super(`Special assessment ${assessmentId} is named by splits of ${transactionIds.join(', ')}`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

type Clock = { readonly now?: () => Date };
const todayOf = (deps: Clock) => businessDayOf((deps.now ?? (() => new Date()))());

export interface CreateSpecialAssessmentInput extends Omit<NewSpecialAssessment, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  readonly idempotencyKey?: string;
}

export type CreateSpecialAssessment = (input: CreateSpecialAssessmentInput) => Promise<{ readonly assessment: AssessmentView; readonly replayed: boolean }>;

export function createSpecialAssessment(deps: { readonly repository: WegSpecialAssessmentRepository } & Clock): CreateSpecialAssessment {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const assessment = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.createAssessment(
      assessment,
      actorOf(principal),
      todayOf(deps),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: assessmentFingerprint(assessment) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { assessment: outcome.assessment, replayed: false };
      case 'REPLAYED':
        return { assessment: outcome.assessment, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'MEMBERSHIP_NOT_FOUND':
        throw new WegMembershipNotFoundError(fields.membershipId);
      case 'MEMBERSHIP_NOT_ACTIVE':
        throw new MembershipNotActiveError(outcome.membershipId);
      case 'ASSESSMENT_OUTSIDE_MEMBERSHIP':
        throw new AssessmentOutsideMembershipError(outcome.validFrom, outcome.validUntil);
    }
  };
}

type Change<T> = (input: {
  readonly principal: RealmPrincipal;
  readonly assessmentId: string;
  readonly value: T;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly assessment: AssessmentView; readonly changed: boolean }>;

export type AmendSpecialAssessment = Change<AssessmentContent>;
export type ReplaceAssessmentUses = Change<readonly AssessmentUse[]>;

export function amendSpecialAssessment(deps: { readonly repository: WegSpecialAssessmentRepository } & Clock): AmendSpecialAssessment {
  return async ({ principal, assessmentId, value, expectedVersions }) =>
    answerChange(
      assessmentId,
      await deps.repository.amendAssessment(assessmentId, principal.mreRealmId, value, actorOf(principal), todayOf(deps), expectedVersions),
    );
}

export function replaceAssessmentUses(deps: { readonly repository: WegSpecialAssessmentRepository } & Clock): ReplaceAssessmentUses {
  return async ({ principal, assessmentId, value, expectedVersions }) =>
    answerChange(
      assessmentId,
      await deps.repository.replaceUses(assessmentId, principal.mreRealmId, value, actorOf(principal), todayOf(deps), expectedVersions),
    );
}

function answerChange(
  assessmentId: string,
  outcome: Awaited<ReturnType<WegSpecialAssessmentRepository['amendAssessment']>>,
): { readonly assessment: AssessmentView; readonly changed: boolean } {
  switch (outcome.kind) {
    case 'AMENDED':
      return { assessment: outcome.assessment, changed: outcome.changed };
    case 'NOT_FOUND':
      throw new SpecialAssessmentNotFoundError(assessmentId);
    case 'ASSESSMENT_NOT_ACTIVE':
      throw new AssessmentNotActiveError(assessmentId, 'VOID');
    case 'VERSION_CONFLICT':
      throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
  }
}

export type VoidSpecialAssessment = Change<string>;

export function voidSpecialAssessment(deps: { readonly repository: WegSpecialAssessmentRepository } & Clock): VoidSpecialAssessment {
  return async ({ principal, assessmentId, value: reason, expectedVersions }) => {
    const now = (deps.now ?? (() => new Date()))();
    const outcome = await deps.repository.voidAssessment(
      assessmentId,
      principal.mreRealmId,
      reason,
      now,
      actorOf(principal),
      businessDayOf(now),
      expectedVersions,
    );
    switch (outcome.kind) {
      case 'VOIDED':
        return { assessment: outcome.assessment, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new SpecialAssessmentNotFoundError(assessmentId);
      case 'ASSESSMENT_HAS_SPLITS':
        throw new AssessmentHasSplitsError(assessmentId, outcome.transactionIds);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type GetSpecialAssessment = (input: {
  readonly principal: RealmPrincipal;
  readonly assessmentId: string;
  readonly asOf?: BusinessDate;
}) => Promise<AssessmentView>;

export function getSpecialAssessment(deps: { readonly repository: WegSpecialAssessmentRepository } & Clock): GetSpecialAssessment {
  return async ({ principal, assessmentId, asOf }) => {
    const assessment = await deps.repository.findAssessment(assessmentId, principal.mreRealmId, asOf ?? todayOf(deps));
    if (assessment === undefined) throw new SpecialAssessmentNotFoundError(assessmentId);
    return assessment;
  };
}

export type ListSpecialAssessments = (input: {
  readonly principal: RealmPrincipal;
  readonly membershipId: string;
  readonly filter: AssessmentFilter;
  readonly page: PageRequest;
  readonly asOf?: BusinessDate;
}) => Promise<Page<AssessmentView>>;

export function listSpecialAssessments(deps: { readonly repository: WegSpecialAssessmentRepository } & Clock): ListSpecialAssessments {
  return async ({ principal, membershipId, filter, page, asOf }) => {
    const result = await deps.repository.listAssessments(membershipId, principal.mreRealmId, filter, page, asOf ?? todayOf(deps));
    if (result === undefined) throw new WegMembershipNotFoundError(membershipId);
    return result;
  };
}
