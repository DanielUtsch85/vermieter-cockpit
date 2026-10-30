import type { AuditActor, BusinessDate, Money, VersionConflict } from '../../shared/index.js';
import type { CategoryType, Direction, TransactionStatus } from '../ledger/index.js';
import { CATEGORY_DEFAULTS, type CategoryDefault, type CategoryDefaultsParameters } from './rules/de-category-defaults.js';
import type { RuleRegistry } from './rules/registry.js';
import type { RuleRef, RuleVersion } from './rules/rule-version.js';
import type { CreateReviewState, Origin, ReviewState, SourceType, StoredReviewState, TaxCategory, Treatment } from './vocabulary.js';

/**
 * TaxClassification (data-model.md §36, api-design.md §55–§57, phase-7-plan P7-D2): the stored interpretation of a
 * split, made when a user confirms or changes the default of its category. It never changes the split, its amount,
 * category or Transaction (ADR-006). One current classification per source; a change supersedes it.
 */

export type TaxClassificationId = string & { readonly __brand: 'TaxClassificationId' };

export interface TaxClassification {
  readonly id: TaxClassificationId;
  readonly mreRealmId: string;
  readonly sourceType: SourceType;
  readonly sourceId: string;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: StoredReviewState;
  readonly rule: RuleRef;
  readonly advisorPartyId: string | null;
  readonly notes: string | null;
  readonly sourceReferences: readonly string[];
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
  readonly supersededAt: Date | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly version: number;
}

/** What a create carries (§56). */
export interface NewTaxClassification {
  readonly mreRealmId: string;
  readonly sourceType: 'TRANSACTION_SPLIT';
  readonly sourceId: string;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: CreateReviewState;
  readonly supersedes: string | null;
  readonly notes: string | null;
  readonly sourceReferences: readonly string[];
}

/** A split as tax reads it: its cash, its category and its Transaction's state. */
export interface SplitFacts {
  readonly splitId: string;
  readonly transactionId: string;
  readonly position: number;
  readonly bookingDate: BusinessDate;
  readonly direction: Direction;
  readonly amount: Money;
  readonly financialCategoryCode: string;
  readonly categoryType: CategoryType;
  readonly propertyReferenceId: string | null;
  readonly transactionStatus: TransactionStatus;
  readonly correctionRole: 'REVERSAL' | 'REPLACEMENT' | null;
}

/** A split counts for tax when its Transaction is current: `CONFIRMED` or `RECONCILED`, not a reversal (§55). */
export const splitCounts = (facts: Pick<SplitFacts, 'transactionStatus' | 'correctionRole'>) =>
  (facts.transactionStatus === 'CONFIRMED' || facts.transactionStatus === 'RECONCILED') && facts.correctionRole !== 'REVERSAL';

export type TaxMeaningFlag =
  | { readonly code: 'NOT_COUNTED'; readonly details: { readonly transactionStatus: TransactionStatus; readonly correctionRole: string | null } }
  | {
      readonly code: 'CLASSIFICATION_ON_CORRECTED_SPLIT';
      readonly details: { readonly originalTransactionId: string; readonly classificationIds: readonly string[] };
    }
  | { readonly code: 'RULE_SUPERSEDED'; readonly details: { readonly ruleCode: string; readonly version: number; readonly applicableVersion: number } };

export interface TaxMeaning extends SplitFacts {
  readonly counts: boolean;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: ReviewState;
  readonly origin: Origin;
  /** `null` only for a default on a date no version of the rule covers (before 2000). */
  readonly rule: RuleRef | null;
  readonly classificationId: string | null;
  readonly flags: readonly TaxMeaningFlag[];
}

/** The original of a replacement whose splits had classifications (P7-D2: nothing moves silently). */
export interface CorrectedOriginal {
  readonly originalTransactionId: string;
  readonly classificationIds: readonly string[];
}

/** The category defaults applicable on `date`, typed. */
export function categoryDefaultsOn(registry: RuleRegistry, date: BusinessDate): RuleVersion<CategoryDefaultsParameters> | undefined {
  return registry.select(CATEGORY_DEFAULTS, date) as RuleVersion<CategoryDefaultsParameters> | undefined;
}

/** The default of a category code; a code the rule does not list reads as `OTHER` (§55). */
export const defaultOf = (rule: RuleVersion<CategoryDefaultsParameters>, code: string): CategoryDefault =>
  rule.parameters.defaults[code] ?? rule.parameters.unlisted;

const NO_RULE_DEFAULT: CategoryDefault = { taxCategory: 'UNCLASSIFIED', treatment: null, reviewState: 'NEEDS_REVIEW' };

/**
 * The tax meaning of a split (§55): its current classification, else the default of its category by the rule version
 * applicable on its booking date. `today` decides `RULE_SUPERSEDED` (informational: it never changes the meaning).
 */
export function deriveTaxMeaning(
  facts: SplitFacts,
  classification: TaxClassification | null,
  correctedOriginal: CorrectedOriginal | null,
  registry: RuleRegistry,
  today: BusinessDate,
): TaxMeaning {
  const counts = splitCounts(facts);
  const flags: TaxMeaningFlag[] = [];
  if (!counts) flags.push({ code: 'NOT_COUNTED', details: { transactionStatus: facts.transactionStatus, correctionRole: facts.correctionRole } });
  if (classification !== null) {
    const applicable = registry.select(classification.rule.ruleCode, today);
    if (applicable !== undefined && applicable.version > classification.rule.version) {
      flags.push({
        code: 'RULE_SUPERSEDED',
        details: { ruleCode: classification.rule.ruleCode, version: classification.rule.version, applicableVersion: applicable.version },
      });
    }
    return {
      ...facts,
      counts,
      taxCategory: classification.taxCategory,
      treatment: classification.treatment,
      reviewState: classification.reviewState,
      origin: 'CLASSIFICATION',
      rule: classification.rule,
      classificationId: classification.id,
      flags,
    };
  }
  if (correctedOriginal !== null && correctedOriginal.classificationIds.length > 0) {
    flags.push({
      code: 'CLASSIFICATION_ON_CORRECTED_SPLIT',
      details: { originalTransactionId: correctedOriginal.originalTransactionId, classificationIds: [...correctedOriginal.classificationIds].sort() },
    });
  }
  const rule = categoryDefaultsOn(registry, facts.bookingDate);
  const meaning = rule === undefined ? NO_RULE_DEFAULT : defaultOf(rule, facts.financialCategoryCode);
  return {
    ...facts,
    counts,
    ...meaning,
    origin: 'DEFAULT',
    rule: rule === undefined ? null : { ruleCode: rule.ruleCode, version: rule.version },
    classificationId: null,
    flags,
  };
}

/** `TREATMENT_NOT_ALLOWED` (§56): the hard rules by the split's category type and code; `undefined` when allowed. */
export function treatmentRefusal(
  rule: RuleVersion<CategoryDefaultsParameters>,
  category: { readonly code: string; readonly categoryType: string },
  treatment: Treatment | null,
): { readonly categoryType: string; readonly allowed: readonly Treatment[] } | undefined {
  const p = rule.parameters;
  if (p.notRelevantOnlyCategoryTypes.includes(category.categoryType)) {
    return treatment === 'NOT_RELEVANT' ? undefined : { categoryType: category.categoryType, allowed: ['NOT_RELEVANT'] };
  }
  const forbidden = p.forbiddenTreatmentsByCode[category.code] ?? [];
  if (treatment !== null && forbidden.includes(treatment)) {
    return { categoryType: category.categoryType, allowed: p.treatments.filter((t) => !forbidden.includes(t)) };
  }
  return undefined;
}

export type CreateRefusal =
  | { readonly kind: 'SOURCE_NOT_COUNTED'; readonly transactionStatus: TransactionStatus; readonly correctionRole: string | null }
  | { readonly kind: 'NO_APPLICABLE_RULE'; readonly ruleCode: string; readonly date: BusinessDate }
  | { readonly kind: 'TREATMENT_NOT_ALLOWED'; readonly categoryType: string; readonly allowed: readonly Treatment[] }
  | { readonly kind: 'CLASSIFICATION_EXISTS'; readonly currentClassificationId: string }
  | { readonly kind: 'NOT_CURRENT_CLASSIFICATION'; readonly currentClassificationId: string | null };

/**
 * The checks of a create after the source was found (§56, in order): the source counts, a rule version applies on
 * its booking date, the treatment is allowed, `supersedes` names the current classification. Returns the rule the
 * classification records, or the refusal.
 */
export function planClassification(
  facts: SplitFacts,
  currentId: string | null,
  request: Pick<NewTaxClassification, 'treatment' | 'supersedes'>,
  registry: RuleRegistry,
): { readonly kind: 'CLASSIFY'; readonly rule: RuleRef } | CreateRefusal {
  if (!splitCounts(facts)) return { kind: 'SOURCE_NOT_COUNTED', transactionStatus: facts.transactionStatus, correctionRole: facts.correctionRole };
  const rule = categoryDefaultsOn(registry, facts.bookingDate);
  if (rule === undefined) return { kind: 'NO_APPLICABLE_RULE', ruleCode: CATEGORY_DEFAULTS, date: facts.bookingDate };
  const refusal = treatmentRefusal(rule, { code: facts.financialCategoryCode, categoryType: facts.categoryType }, request.treatment);
  if (refusal !== undefined) return { kind: 'TREATMENT_NOT_ALLOWED', ...refusal };
  if (currentId !== null && request.supersedes === null) return { kind: 'CLASSIFICATION_EXISTS', currentClassificationId: currentId };
  if (request.supersedes !== null && request.supersedes !== currentId) return { kind: 'NOT_CURRENT_CLASSIFICATION', currentClassificationId: currentId };
  return { kind: 'CLASSIFY', rule: { ruleCode: rule.ruleCode, version: rule.version } };
}

/** §57's three steps. */
export type ReviewStep =
  | { readonly kind: 'CONFIRM' }
  | { readonly kind: 'ADVISOR_CONFIRM'; readonly advisorPartyId: string | null; readonly note: string | null }
  | { readonly kind: 'MARK_NEEDS_REVIEW'; readonly reason: string };

export type ReviewRefusal =
  | { readonly kind: 'CLASSIFICATION_SUPERSEDED'; readonly supersededBy: string }
  | { readonly kind: 'ADVISOR_CONFIRMED' }
  | { readonly kind: 'SOURCE_NOT_COUNTED'; readonly transactionStatus: TransactionStatus; readonly correctionRole: string | null }
  | { readonly kind: 'RULE_NOT_REGISTERED'; readonly ruleCode: string; readonly version: number };

/** What a step writes: the target state and advisor; `changed: false` is a `200` no-op. */
export interface ReviewPlan {
  readonly reviewState: StoredReviewState;
  readonly advisorPartyId: string | null;
  readonly changed: boolean;
}

/**
 * §57's state checks, in order: only the current classification moves; confirm does not lower an advisor's
 * confirmation; the source still counts and the rule version still resolves; then the target, or the no-op.
 */
export function planReview(
  current: TaxClassification,
  step: ReviewStep,
  source: Pick<SplitFacts, 'transactionStatus' | 'correctionRole'>,
  registry: RuleRegistry,
): ReviewPlan | ReviewRefusal {
  if (current.supersededBy !== null) return { kind: 'CLASSIFICATION_SUPERSEDED', supersededBy: current.supersededBy };
  if (step.kind === 'CONFIRM' && current.reviewState === 'ADVISOR_CONFIRMED') return { kind: 'ADVISOR_CONFIRMED' };
  if (!splitCounts(source)) return { kind: 'SOURCE_NOT_COUNTED', transactionStatus: source.transactionStatus, correctionRole: source.correctionRole };
  if (!registry.isRegistered(current.rule.ruleCode, current.rule.version)) {
    return { kind: 'RULE_NOT_REGISTERED', ruleCode: current.rule.ruleCode, version: current.rule.version };
  }
  const target: { reviewState: StoredReviewState; advisorPartyId: string | null } =
    step.kind === 'CONFIRM'
      ? { reviewState: 'USER_CONFIRMED', advisorPartyId: null }
      : step.kind === 'ADVISOR_CONFIRM'
        ? { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: step.advisorPartyId }
        : { reviewState: 'NEEDS_REVIEW', advisorPartyId: null };
  const changed = target.reviewState !== current.reviewState || target.advisorPartyId !== current.advisorPartyId;
  return { ...target, changed };
}

/** Identity of a create for `Idempotency-Key` replays. */
export function classificationFingerprint(c: NewTaxClassification): string {
  return JSON.stringify([c.sourceType, c.sourceId, c.taxCategory, c.treatment, c.reviewState, c.supersedes, c.notes, c.sourceReferences]);
}

export type CreateClassificationOutcome =
  | { readonly kind: 'CREATED'; readonly classification: TaxClassification }
  | { readonly kind: 'REPLAYED'; readonly classification: TaxClassification }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'SOURCE_NOT_FOUND' }
  | CreateRefusal;

export type ReviewClassificationOutcome =
  | { readonly kind: 'REVIEWED'; readonly classification: TaxClassification; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | ReviewRefusal
  | VersionConflict;

export interface TaxMeaningFilter {
  readonly reviewStates?: readonly ReviewState[];
  readonly origins?: readonly Origin[];
  readonly taxCategories?: readonly TaxCategory[];
}

export interface TaxPageRequest {
  readonly page: number;
  readonly pageSize: number;
}

export interface TaxPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface TaxClassificationRepository {
  /** Claims the key, writes the split's Transaction (no-op), locks the current classification, checks §56's order. */
  createClassification(
    classification: NewTaxClassification,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateClassificationOutcome>;
  /** One of §57's steps; the classification row `FOR UPDATE` only. */
  reviewClassification(
    id: string,
    mreRealmId: string,
    step: ReviewStep,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ReviewClassificationOutcome>;
  findClassification(id: string, mreRealmId: string): Promise<TaxClassification | undefined>;
  /** Every classification of a source, by creation; undefined for an unknown source. */
  listHistory(sourceType: SourceType, sourceId: string, mreRealmId: string): Promise<readonly TaxClassification[] | undefined>;
  /** One `REPEATABLE READ READ ONLY` snapshot; undefined for an unknown split. */
  findTaxMeaning(splitId: string, mreRealmId: string, today: BusinessDate): Promise<TaxMeaning | undefined>;
  /** The counting splits of a PropertyReference booked in `year`, derived, filtered and paged; undefined for an unknown one. */
  listTaxMeanings(
    propertyReferenceId: string,
    mreRealmId: string,
    year: number,
    filter: TaxMeaningFilter,
    page: TaxPageRequest,
    today: BusinessDate,
  ): Promise<TaxPage<TaxMeaning> | undefined>;
  /** Every distinct stored `ruleCode@version`, across Realms (the start check, §58). */
  storedRuleReferences(): Promise<readonly RuleRef[]>;
}
