import {
  inFinancialYear,
  planFingerprint,
  proposeHausgeld,
  type HausgeldCase,
  type NewEconomicPlan,
  type Page,
  type PageRequest,
  type PlanFilter,
  type PlanView,
  type ProposalFlag,
  type ProposedSplit,
  type WegEconomicPlanRepository,
} from '../domains/weg/index.js';
import type { BusinessDate, Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import { NoWegMembershipError, TransactionNotFoundError } from './transaction-splits.js';
import { MembershipNotActiveError, WegMembershipNotFoundError } from './wegs.js';

/**
 * The Wirtschaftsplan and the Hausgeld split proposal (api-design.md §49.5–§49.6, backlog VC-6-02), in the caller's
 * verified Realm. Input arrives validated from the API boundary. No MRE call (P6-D9).
 */

export class EconomicPlanNotFoundError extends Error {
  override readonly name = 'EconomicPlanNotFoundError';

  constructor(readonly economicPlanId: string) {
    super(`Economic plan ${economicPlanId} not found`);
  }
}

/** `effectiveFrom` is not inside the plan's financial year (→ 400 OUT_OF_RANGE at `effectiveFrom`, §49.5). */
export class EffectiveFromOutsideYearError extends Error {
  override readonly name = 'EffectiveFromOutsideYearError';

  constructor(
    readonly from: BusinessDate,
    readonly until: BusinessDate,
  ) {
    super(`effectiveFrom lies outside the financial year ${from} – ${until}`);
  }
}

/** `effectiveFrom` is outside the membership's period (→ 422 PLAN_OUTSIDE_MEMBERSHIP). */
export class PlanOutsideMembershipError extends Error {
  override readonly name = 'PlanOutsideMembershipError';

  constructor(
    readonly validFrom: BusinessDate,
    readonly validUntil: BusinessDate | null,
  ) {
    super(`The plan starts outside the membership ${validFrom} – ${validUntil ?? 'open'}`);
  }
}

/** An `ACTIVE` plan of the membership starts on the same day (→ 409 PLAN_EXISTS). */
export class PlanExistsError extends Error {
  override readonly name = 'PlanExistsError';

  constructor(readonly economicPlanId: string) {
    super(`Plan ${economicPlanId} starts on the same day`);
  }
}

/** Only an unconfirmed OUTFLOW gets a Hausgeld proposal (→ 409 NOT_PROPOSABLE, §49.6). */
export class HausgeldNotProposableError extends Error {
  override readonly name = 'HausgeldNotProposableError';

  constructor(
    readonly direction: string,
    readonly status: string,
  ) {
    super(`A ${direction} Transaction in ${status} gets no Hausgeld proposal`);
  }
}

/** The membership has no `ACTIVE` plan in force on the booking date (→ 422 NO_ECONOMIC_PLAN). */
export class NoEconomicPlanError extends Error {
  override readonly name = 'NoEconomicPlanError';

  constructor(
    readonly membershipId: string,
    readonly bookingDate: BusinessDate,
  ) {
    super(`WEG membership ${membershipId} has no plan in force on ${bookingDate}`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

export interface CreateEconomicPlanInput extends Omit<NewEconomicPlan, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  readonly idempotencyKey?: string;
}

export type CreateEconomicPlan = (input: CreateEconomicPlanInput) => Promise<{ readonly plan: PlanView; readonly replayed: boolean }>;

export function createEconomicPlan(deps: { readonly repository: WegEconomicPlanRepository }): CreateEconomicPlan {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const plan = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.createPlan(
      plan,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: planFingerprint(plan) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { plan: outcome.plan, replayed: false };
      case 'REPLAYED':
        return { plan: outcome.plan, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'MEMBERSHIP_NOT_FOUND':
        throw new WegMembershipNotFoundError(fields.membershipId);
      case 'MEMBERSHIP_NOT_ACTIVE':
        throw new MembershipNotActiveError(fields.membershipId);
      case 'EFFECTIVE_FROM_OUTSIDE_YEAR':
        throw new EffectiveFromOutsideYearError(outcome.from, outcome.until);
      case 'PLAN_OUTSIDE_MEMBERSHIP':
        throw new PlanOutsideMembershipError(outcome.validFrom, outcome.validUntil);
      case 'PLAN_EXISTS':
        throw new PlanExistsError(outcome.economicPlanId);
    }
  };
}

export type GetEconomicPlan = (input: { readonly principal: RealmPrincipal; readonly economicPlanId: string }) => Promise<PlanView>;

export function getEconomicPlan(deps: { readonly repository: WegEconomicPlanRepository }): GetEconomicPlan {
  return async ({ principal, economicPlanId }) => {
    const plan = await deps.repository.findPlan(economicPlanId, principal.mreRealmId);
    if (plan === undefined) throw new EconomicPlanNotFoundError(economicPlanId);
    return plan;
  };
}

export type ListEconomicPlans = (input: {
  readonly principal: RealmPrincipal;
  readonly membershipId: string;
  readonly filter: PlanFilter;
  readonly page: PageRequest;
}) => Promise<Page<PlanView>>;

export function listEconomicPlans(deps: { readonly repository: WegEconomicPlanRepository }): ListEconomicPlans {
  return async ({ principal, membershipId, filter, page }) => {
    const result = await deps.repository.listPlans(membershipId, principal.mreRealmId, filter, page);
    if (result === undefined) throw new WegMembershipNotFoundError(membershipId);
    return result;
  };
}

export type VoidEconomicPlan = (input: {
  readonly principal: RealmPrincipal;
  readonly economicPlanId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly plan: PlanView; readonly changed: boolean }>;

export function voidEconomicPlan(deps: { readonly repository: WegEconomicPlanRepository; readonly now?: () => Date }): VoidEconomicPlan {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, economicPlanId, reason, expectedVersions }) => {
    const outcome = await deps.repository.voidPlan(economicPlanId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'VOIDED':
        return { plan: outcome.plan, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new EconomicPlanNotFoundError(economicPlanId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type HausgeldProposalFlag =
  | ProposalFlag
  | { readonly code: 'PLAN_OF_EARLIER_YEAR'; readonly details: { readonly financialYear: number } }
  | { readonly code: 'ALREADY_SPLIT'; readonly details: Record<string, never> };

export interface HausgeldProposal {
  readonly transactionId: string;
  readonly bookingDate: BusinessDate;
  readonly amount: Money;
  readonly propertyReferenceId: string;
  readonly membershipId: string;
  readonly economicPlanId: string;
  readonly case: HausgeldCase;
  readonly splits: readonly (ProposedSplit & { readonly propertyReferenceId: string })[];
  readonly flags: readonly HausgeldProposalFlag[];
}

export type GetHausgeldProposal = (input: {
  readonly principal: RealmPrincipal;
  readonly transactionId: string;
  readonly propertyReferenceId: string | null;
}) => Promise<HausgeldProposal>;

/** §49.6: a read, never a write; the client applies it through `PUT …/splits`. */
export function getHausgeldProposal(deps: { readonly repository: WegEconomicPlanRepository }): GetHausgeldProposal {
  return async ({ principal, transactionId, propertyReferenceId }) => {
    const context = await deps.repository.proposalContext(transactionId, principal.mreRealmId, propertyReferenceId);
    switch (context.kind) {
      case 'TRANSACTION_NOT_FOUND':
        throw new TransactionNotFoundError(transactionId);
      case 'PROPERTY_REFERENCE_NOT_FOUND':
        throw new PropertyReferenceNotFoundError(propertyReferenceId ?? '');
      case 'NOT_PROPOSABLE':
        throw new HausgeldNotProposableError(context.direction, context.status);
      case 'NO_UNIT':
        throw new NoWegMembershipError(null, 'NO_UNIT');
      case 'NO_MEMBERSHIP':
        throw new NoWegMembershipError(null, 'NO_MEMBERSHIP', context.propertyReferenceId, context.bookingDate);
      case 'NO_ECONOMIC_PLAN':
        throw new NoEconomicPlanError(context.membershipId, context.bookingDate);
      case 'FOUND': {
        const proposal = proposeHausgeld(context.amount, context.plan.components);
        const flags: HausgeldProposalFlag[] = [...proposal.flags];
        if (!inFinancialYear(context.bookingDate, context.plan.financialYear, context.financialYearStartMonth)) {
          flags.push({ code: 'PLAN_OF_EARLIER_YEAR', details: { financialYear: context.plan.financialYear } });
        }
        if (context.alreadySplit) flags.push({ code: 'ALREADY_SPLIT', details: {} });
        return {
          transactionId: context.transactionId,
          bookingDate: context.bookingDate,
          amount: context.amount,
          propertyReferenceId: context.propertyReferenceId,
          membershipId: context.membershipId,
          economicPlanId: context.plan.id,
          case: proposal.case,
          splits: proposal.splits.map((s) => ({ ...s, propertyReferenceId: context.propertyReferenceId })),
          flags,
        };
      }
    }
  };
}
