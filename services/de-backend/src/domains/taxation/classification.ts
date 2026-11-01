import type { AuditActor, BusinessDate, Money, RuleRef, VersionConflict } from '../../shared/index.js';
import type { AnschaffungsnaheCheck } from './anschaffungsnahe.js';
import type { CreateRefusal } from './classification-checks.js';
import type { ReviewRefusal, ReviewStep } from './classification-review.js';
import type { DepositTaxMeaning } from './deposit-closing.js';
import type { NewTaxClassification, TaxClassification } from './tax-classification.js';
import type { TaxMeaning } from './tax-meaning.js';
import type { TaxYearRead } from './tax-year-view.js';
import type { WegTaxMeaning } from './weg-sources.js';
import type { Origin, ReviewState, SourceType, TaxCategory } from './vocabulary.js';

/**
 * TaxClassification (data-model.md §36, api-design.md §55–§58A, phase-7-plan P7-D2, P7-D4): the stored interpretation
 * of a split, or of a retained deposit (VC-7-02), made when a user confirms or changes the default. It never changes its
 * source, the split's amount, category or Transaction, or the deposit (ADR-006). One current classification per
 * source; a change supersedes it.
 */

// The entity, the meaning and the rules, re-exported for the importers of this module (index.ts, the sibling modules, the tests).
export { classificationFingerprint } from './tax-classification.js';
export type { AcquisitionFacts, NewTaxClassification, TaxClassification, TaxClassificationId } from './tax-classification.js';
export { categoryDefaultsOn, defaultOf, deriveTaxMeaning, ruleSupersededFlags, splitCounts } from './tax-meaning.js';
export type { CorrectedOriginal, RuleSupersededFlag, SplitFacts, TaxMeaning, TaxMeaningFlag, TaxYearInputs, TreatmentSuggestion } from './tax-meaning.js';
export {
  distributionRuleCheck,
  planClassification,
  supersedesCheck,
  treatmentFieldsCheck,
  treatmentRefusal,
  wegSpendingRefusal,
} from './classification-checks.js';
export type {
  AnschaffungsnaheNotApplicableReason,
  CreateRefusal,
  DepositNotCounted,
  DepositNotCountedReason,
  DistributionNotAllowedReason,
  InterestContext,
  TreatmentRequest,
  TreatmentSource,
  WegSourceNotCounted,
} from './classification-checks.js';
export { planReview } from './classification-review.js';
export type { ReviewPlan, ReviewRefusal, ReviewStep } from './classification-review.js';

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

/**
 * An item of the per-property list: a split, a retained deposit (§58A), a withdrawal or a use (§58B), with the amount
 * of the year listed: the part of the year for a `DISTRIBUTED_82B` source, else its amount.
 */
export type TaxListItem = (TaxMeaning | DepositTaxMeaning | WegTaxMeaning) & { readonly yearAmount: Money };

export interface TaxMeaningFilter {
  readonly reviewStates?: readonly ReviewState[];
  readonly origins?: readonly Origin[];
  readonly taxCategories?: readonly TaxCategory[];
  /** VC-7-03 (§58B): the four source types. */
  readonly sourceTypes?: readonly SourceType[];
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
  /** Every classification of a source (a WEG source by its `sourcePosition`), by creation; undefined for an unknown source. */
  listHistory(sourceType: SourceType, sourceId: string, mreRealmId: string, sourcePosition?: number | null): Promise<readonly TaxClassification[] | undefined>;
  /** One `REPEATABLE READ READ ONLY` snapshot; undefined for an unknown split. */
  findTaxMeaning(splitId: string, mreRealmId: string, today: BusinessDate): Promise<TaxMeaning | undefined>;
  /** The retained amount of a deposit at its closing (§58A); undefined for an unknown deposit. */
  findDepositTaxMeaning(depositId: string, mreRealmId: string, today: BusinessDate): Promise<DepositTaxMeaning | undefined>;
  /**
   * The counting splits of a PropertyReference whose tax year is `year` (§58A), and its retained deposits closed in
   * `year`, derived, filtered and paged; undefined for an unknown one.
   */
  listTaxMeanings(
    propertyReferenceId: string,
    mreRealmId: string,
    year: number,
    filter: TaxMeaningFilter,
    page: TaxPageRequest,
    today: BusinessDate,
  ): Promise<TaxPage<TaxListItem> | undefined>;
  /** A reserve withdrawal's meaning (§58B); undefined for an unknown statement or a position naming no reserve line. */
  findWithdrawalTaxMeaning(statementId: string, position: number, mreRealmId: string, today: BusinessDate): Promise<WegTaxMeaning | undefined>;
  /** A Sonderumlage use's meaning (§58B); undefined for an unknown assessment or a position naming no use. */
  findUseTaxMeaning(assessmentId: string, position: number, mreRealmId: string, today: BusinessDate): Promise<WegTaxMeaning | undefined>;
  /** The anschaffungsnahe check of an Acquisition (§58B), one snapshot; undefined for an unknown one. */
  anschaffungsnaheCheck(acquisitionId: string, mreRealmId: string, today: BusinessDate): Promise<AnschaffungsnaheCheck | undefined>;
  /**
   * What the tax-year view reads (§58C), in one `REPEATABLE READ READ ONLY` snapshot: §55's items of `year` and the
   * rest of its input; undefined for an unknown PropertyReference. With an `ownerPartyId` that names no Party of the
   * Realm, `ownerPartyFound` is false and nothing else is read.
   */
  readTaxYear(
    propertyReferenceId: string,
    mreRealmId: string,
    year: number,
    ownerPartyId: string | null,
    today: BusinessDate,
  ): Promise<TaxYearRead | undefined>;
  /** Every distinct stored `ruleCode@version`, both references (§58B), across Realms (the start check, §58). */
  storedRuleReferences(): Promise<readonly RuleRef[]>;
}
