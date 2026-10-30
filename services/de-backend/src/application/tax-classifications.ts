import { businessDayOf } from '../domains/ledger/index.js';
import {
  TAX_RULES,
  classificationFingerprint,
  type NewTaxClassification,
  type ReviewStep,
  type RuleRegistry,
  type RuleStatus,
  type RuleVersion,
  type SourceType,
  type TaxClassification,
  type DepositTaxMeaning,
  type TaxClassificationRepository,
  type TaxListItem,
  type TaxMeaning,
  type TaxMeaningFilter,
  type TaxPage,
  type TaxPageRequest,
  type TaxCategory,
  type Treatment,
} from '../domains/taxation/index.js';
import type { BusinessDate, Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { PartyNotFoundError } from './parties.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import { SecurityDepositNotFoundError } from './security-deposits.js';

/**
 * Tax classification and tax rules (api-design.md §55–§58, backlog VC-7-01), in the caller's verified Realm; the rule
 * registry is the same for everyone. Input arrives validated from the API boundary. Taxation never writes cash.
 */

export class TaxClassificationNotFoundError extends Error {
  override readonly name = 'TaxClassificationNotFoundError';

  constructor(readonly classificationId: string) {
    super(`Tax classification ${classificationId} not found`);
  }
}

/** The source of a classification, unknown or of another Realm (→ 404). */
export class TaxSourceNotFoundError extends Error {
  override readonly name = 'TaxSourceNotFoundError';

  constructor(
    readonly sourceType: SourceType,
    readonly sourceId: string,
  ) {
    super(`${sourceType} ${sourceId} not found`);
  }
}

/** The split's Transaction is not current (→ 409 SOURCE_NOT_COUNTED). */
export class SourceNotCountedError extends Error {
  override readonly name = 'SourceNotCountedError';

  constructor(
    readonly transactionStatus: string,
    readonly correctionRole: string | null,
  ) {
    super(`The source's Transaction is ${transactionStatus}${correctionRole === null ? '' : ` (${correctionRole})`}, not current`);
  }
}

/** A retained deposit that does not count (→ 409 SOURCE_NOT_COUNTED, §58A). */
export class DepositNotCountedError extends Error {
  override readonly name = 'DepositNotCountedError';

  constructor(
    readonly depositStatus: string,
    readonly retainedAmount: Money,
    readonly reason: string,
  ) {
    super(`The security deposit is ${depositStatus} with ${retainedAmount.amount} retained (${reason}), not counted`);
  }
}

/** The category refuses the treatment, or the deposit the line (→ 422 TREATMENT_NOT_ALLOWED). */
export class TreatmentNotAllowedError extends Error {
  override readonly name = 'TreatmentNotAllowedError';

  constructor(
    /** `null` for a retained deposit (§58A), whose lines are `taxCategories`. */
    readonly categoryType: string | null,
    readonly allowed: readonly Treatment[],
    readonly taxCategories?: readonly TaxCategory[],
  ) {
    super(`${categoryType === null ? 'A retained deposit' : `A ${categoryType} split`} allows only ${allowed.join(', ')}`);
  }
}

/** `taxYear` is not the booking year ± 1 (→ 422 TAX_YEAR_OUT_OF_RANGE, §58A). */
export class TaxYearOutOfRangeError extends Error {
  override readonly name = 'TaxYearOutOfRangeError';

  constructor(
    readonly taxYear: number,
    readonly bookingYear: number,
  ) {
    super(`taxYear ${taxYear} is not within the booking year ${bookingYear} ± 1`);
  }
}

/** `refundOfYear` lies after the tax year (→ 422 REFUND_YEAR_OUT_OF_RANGE, §58A). */
export class RefundYearOutOfRangeError extends Error {
  override readonly name = 'RefundYearOutOfRangeError';

  constructor(
    readonly refundOfYear: number,
    readonly taxYear: number,
  ) {
    super(`refundOfYear ${refundOfYear} lies after the tax year ${taxYear}`);
  }
}

/** The source has a current classification and `supersedes` was not given (→ 409 CLASSIFICATION_EXISTS). */
export class ClassificationExistsError extends Error {
  override readonly name = 'ClassificationExistsError';

  constructor(readonly currentClassificationId: string) {
    super(`The source has the current classification ${currentClassificationId}`);
  }
}

/** `supersedes` does not name the current classification (→ 409 NOT_CURRENT_CLASSIFICATION). */
export class NotCurrentClassificationError extends Error {
  override readonly name = 'NotCurrentClassificationError';

  constructor(readonly currentClassificationId: string | null) {
    super(`supersedes does not name the current classification ${currentClassificationId ?? '(none)'}`);
  }
}

/** Only the current classification moves (→ 409 CLASSIFICATION_SUPERSEDED). */
export class ClassificationSupersededError extends Error {
  override readonly name = 'ClassificationSupersededError';

  constructor(readonly supersededBy: string) {
    super(`The classification is superseded by ${supersededBy}`);
  }
}

/** A user cannot lower an advisor's confirmation (→ 409 ADVISOR_CONFIRMED). */
export class AdvisorConfirmedError extends Error {
  override readonly name = 'AdvisorConfirmedError';
}

/** The classification names a rule version the registry does not know (→ 409 RULE_NOT_REGISTERED). */
export class TaxRuleNotRegisteredError extends Error {
  override readonly name = 'TaxRuleNotRegisteredError';

  constructor(
    readonly ruleCode: string,
    readonly version: number,
  ) {
    super(`Tax rule ${ruleCode}@${version} is not registered`);
  }
}

/** No version of the rule applies on the source's date (→ 409 NO_APPLICABLE_RULE). */
export class NoApplicableTaxRuleError extends Error {
  override readonly name = 'NoApplicableTaxRuleError';

  constructor(
    readonly ruleCode: string,
    readonly date: BusinessDate,
  ) {
    super(`No version of ${ruleCode} applies on ${date}`);
  }
}

export class TaxRuleNotFoundError extends Error {
  override readonly name = 'TaxRuleNotFoundError';

  constructor(readonly ruleCode: string) {
    super(`Tax rule ${ruleCode} not found`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

type Clock = { readonly now?: () => Date };
const todayOf = (deps: Clock) => businessDayOf((deps.now ?? (() => new Date()))());
type Deps = { readonly repository: TaxClassificationRepository } & Clock;

export interface CreateTaxClassificationInput extends Omit<NewTaxClassification, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  readonly idempotencyKey?: string;
}

export type CreateTaxClassification = (
  input: CreateTaxClassificationInput,
) => Promise<{ readonly classification: TaxClassification; readonly replayed: boolean }>;

export function createTaxClassification(deps: Deps): CreateTaxClassification {
  return async ({ principal, idempotencyKey, ...fields }) => {
    const classification = { mreRealmId: principal.mreRealmId, ...fields };
    const outcome = await deps.repository.createClassification(
      classification,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: classificationFingerprint(classification) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { classification: outcome.classification, replayed: false };
      case 'REPLAYED':
        return { classification: outcome.classification, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'SOURCE_NOT_FOUND':
        throw new TaxSourceNotFoundError(fields.sourceType, fields.sourceId);
      case 'SOURCE_NOT_COUNTED':
        throw new SourceNotCountedError(outcome.transactionStatus, outcome.correctionRole);
      case 'DEPOSIT_NOT_COUNTED':
        throw new DepositNotCountedError(outcome.depositStatus, outcome.retainedAmount, outcome.reason);
      case 'NO_APPLICABLE_RULE':
        throw new NoApplicableTaxRuleError(outcome.ruleCode, outcome.date);
      case 'TREATMENT_NOT_ALLOWED':
        throw new TreatmentNotAllowedError(outcome.categoryType, outcome.allowed, outcome.taxCategories);
      case 'TAX_YEAR_OUT_OF_RANGE':
        throw new TaxYearOutOfRangeError(outcome.taxYear, outcome.bookingYear);
      case 'REFUND_YEAR_OUT_OF_RANGE':
        throw new RefundYearOutOfRangeError(outcome.refundOfYear, outcome.taxYear);
      case 'CLASSIFICATION_EXISTS':
        throw new ClassificationExistsError(outcome.currentClassificationId);
      case 'NOT_CURRENT_CLASSIFICATION':
        throw new NotCurrentClassificationError(outcome.currentClassificationId);
    }
  };
}

export type ReviewTaxClassification = (input: {
  readonly principal: RealmPrincipal;
  readonly classificationId: string;
  readonly step: ReviewStep;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly classification: TaxClassification; readonly changed: boolean }>;

/** §57's steps: confirm, advisor-confirm and mark-needs-review, each by its `step`. */
export function reviewTaxClassification(deps: Deps): ReviewTaxClassification {
  return async ({ principal, classificationId, step, expectedVersions }) => {
    const outcome = await deps.repository.reviewClassification(classificationId, principal.mreRealmId, step, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'REVIEWED':
        return { classification: outcome.classification, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new TaxClassificationNotFoundError(classificationId);
      case 'PARTY_NOT_FOUND':
        throw new PartyNotFoundError(outcome.partyId);
      case 'CLASSIFICATION_SUPERSEDED':
        throw new ClassificationSupersededError(outcome.supersededBy);
      case 'ADVISOR_CONFIRMED':
        throw new AdvisorConfirmedError('A user cannot lower an advisor confirmation; supersede the classification instead');
      case 'SOURCE_NOT_COUNTED':
        throw new SourceNotCountedError(outcome.transactionStatus, outcome.correctionRole);
      case 'DEPOSIT_NOT_COUNTED':
        throw new DepositNotCountedError(outcome.depositStatus, outcome.retainedAmount, outcome.reason);
      case 'RULE_NOT_REGISTERED':
        throw new TaxRuleNotRegisteredError(outcome.ruleCode, outcome.version);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type GetTaxClassification = (input: { readonly principal: RealmPrincipal; readonly classificationId: string }) => Promise<TaxClassification>;

export function getTaxClassification(deps: Deps): GetTaxClassification {
  return async ({ principal, classificationId }) => {
    const found = await deps.repository.findClassification(classificationId, principal.mreRealmId);
    if (found === undefined) throw new TaxClassificationNotFoundError(classificationId);
    return found;
  };
}

export type ListTaxClassificationHistory = (input: {
  readonly principal: RealmPrincipal;
  readonly sourceType: SourceType;
  readonly sourceId: string;
}) => Promise<readonly TaxClassification[]>;

export function listTaxClassificationHistory(deps: Deps): ListTaxClassificationHistory {
  return async ({ principal, sourceType, sourceId }) => {
    const history = await deps.repository.listHistory(sourceType, sourceId, principal.mreRealmId);
    if (history === undefined) throw new TaxSourceNotFoundError(sourceType, sourceId);
    return history;
  };
}

export type GetTaxMeaning = (input: { readonly principal: RealmPrincipal; readonly splitId: string }) => Promise<TaxMeaning>;

export function getTaxMeaning(deps: Deps): GetTaxMeaning {
  return async ({ principal, splitId }) => {
    const meaning = await deps.repository.findTaxMeaning(splitId, principal.mreRealmId, todayOf(deps));
    if (meaning === undefined) throw new TaxSourceNotFoundError('TRANSACTION_SPLIT', splitId);
    return meaning;
  };
}

export type GetDepositTaxMeaning = (input: { readonly principal: RealmPrincipal; readonly depositId: string }) => Promise<DepositTaxMeaning>;

/** The retained amount of a deposit at its closing (§58A). */
export function getDepositTaxMeaning(deps: Deps): GetDepositTaxMeaning {
  return async ({ principal, depositId }) => {
    const meaning = await deps.repository.findDepositTaxMeaning(depositId, principal.mreRealmId, todayOf(deps));
    if (meaning === undefined) throw new SecurityDepositNotFoundError(depositId);
    return meaning;
  };
}

export type ListTaxMeanings = (input: {
  readonly principal: RealmPrincipal;
  readonly propertyReferenceId: string;
  readonly year: number;
  readonly filter: TaxMeaningFilter;
  readonly page: TaxPageRequest;
}) => Promise<TaxPage<TaxListItem>>;

export function listTaxMeanings(deps: Deps): ListTaxMeanings {
  return async ({ principal, propertyReferenceId, year, filter, page }) => {
    const result = await deps.repository.listTaxMeanings(propertyReferenceId, principal.mreRealmId, year, filter, page, todayOf(deps));
    if (result === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);
    return result;
  };
}

/** A rule with its versions and their status today (§58). */
export interface TaxRuleView {
  readonly ruleCode: string;
  readonly versions: readonly (RuleVersion & { readonly status: RuleStatus })[];
}

export type ListTaxRules = () => Promise<readonly TaxRuleView[]>;
export type GetTaxRule = (input: { readonly ruleCode: string }) => Promise<TaxRuleView>;

const viewOf = (registry: RuleRegistry, ruleCode: string, today: BusinessDate): TaxRuleView => ({
  ruleCode,
  versions: registry.versions(ruleCode).map((v) => ({ ...v, status: registry.status(v, today) })),
});

export function listTaxRules(deps: { readonly registry?: RuleRegistry } & Clock = {}): ListTaxRules {
  const registry = deps.registry ?? TAX_RULES;
  return () => Promise.resolve(registry.codes().map((code) => viewOf(registry, code, todayOf(deps))));
}

export function getTaxRule(deps: { readonly registry?: RuleRegistry } & Clock = {}): GetTaxRule {
  const registry = deps.registry ?? TAX_RULES;
  return ({ ruleCode }) => {
    if (registry.versions(ruleCode).length === 0) return Promise.reject(new TaxRuleNotFoundError(ruleCode));
    return Promise.resolve(viewOf(registry, ruleCode, todayOf(deps)));
  };
}
