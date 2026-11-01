import type { BusinessDate, Money, RuleRef } from '../../shared/index.js';
import type { CreateReviewState, SourceType, StoredReviewState, TaxCategory, Treatment } from './vocabulary.js';

/**
 * TaxClassification (data-model.md §36, api-design.md §55–§58A, phase-7-plan P7-D2, P7-D4): the stored interpretation
 * of a split, or of a retained deposit (VC-7-02), made when a user confirms or changes the default. It never changes its
 * source, the split's amount, category or Transaction, or the deposit (ADR-006). One current classification per
 * source; a change supersedes it.
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
  /** VC-7-02 (§58A): the tax year a split counts in, overriding the rule; `null` keeps the rule's year. */
  readonly taxYear: number | null;
  /** VC-7-02: the year a refund refunds (or a repayment repays, for information). */
  readonly refundOfYear: number | null;
  /** A `DEPOSIT_CLOSING`'s closing, as it was when classified; a later closing needs a new classification. */
  readonly depositClosing: { readonly closingDate: BusinessDate; readonly retainedAmount: Money } | null;
  /** VC-7-03 (§58B): the reserve line's or the use's `position` of a WEG source; `null` for a split or a deposit. */
  readonly sourcePosition: number | null;
  /** The withdrawal's unit share as classified (a confirmed statement never changes it). */
  readonly reserveWithdrawal: { readonly unitShare: Money } | null;
  /** The use as classified: a replace of the uses that changes it stops the classification counting. */
  readonly assessmentUse: { readonly date: BusinessDate; readonly unitShare: Money } | null;
  /** The amount without VAT, for the anschaffungsnahe check only (P7-D6). */
  readonly netAmount: Money | null;
  /** Annually recurring maintenance: left out of the anschaffungsnahe check (A2). */
  readonly annuallyRecurring: boolean;
  /** The § 82b election: its years (2–5) and the user's confirmation that the building is mostly residential. */
  readonly distributionYears: number | null;
  readonly mostlyResidentialConfirmed: boolean | null;
  /** A capitalisation that follows the anschaffungsnahe check of this Acquisition. */
  readonly anschaffungsnaheAcquisitionId: string | null;
  /** §59E: the construction-period record (Bauzeitzinsen) of an interest split classified `CAPITALIZED` or `DEDUCTIBLE`. */
  readonly constructionPeriodInterestId: string | null;
  /**
   * The second rule reference: `DE_82B_DISTRIBUTION` for an election, `DE_ANSCHAFFUNGSNAHE` for such a capitalisation,
   * `DE_CONSTRUCTION_PERIOD_INTEREST` for a classification naming a construction-period record (§59E).
   */
  readonly treatmentRule: RuleRef | null;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
  readonly supersededAt: Date | null;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly version: number;
}

/** What a create carries (§56, §58A). */
export interface NewTaxClassification {
  readonly mreRealmId: string;
  readonly sourceType: SourceType;
  readonly sourceId: string;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: CreateReviewState;
  readonly supersedes: string | null;
  readonly notes: string | null;
  readonly sourceReferences: readonly string[];
  /** Splits (§58A) and undated withdrawals (§58B) only; omitted means `null`. */
  readonly taxYear?: number | null;
  readonly refundOfYear?: number | null;
  /** VC-7-03 (§58B): the WEG sources' `position`; the fields below, each omitted meaning `null` (or `false`). */
  readonly sourcePosition?: number | null;
  readonly netAmount?: Money | null;
  readonly annuallyRecurring?: boolean;
  readonly distributionYears?: number | null;
  readonly mostlyResidentialConfirmed?: boolean | null;
  readonly anschaffungsnaheAcquisitionId?: string | null;
  /** §59E: splits only; omitted means `null`. */
  readonly constructionPeriodInterestId?: string | null;
}

/** The Acquisition a capitalisation following the check names, as a create reads it (without a lock, §58B). */
export interface AcquisitionFacts {
  readonly id: string;
  readonly propertyReferenceId: string;
  readonly status: string;
  readonly transferDate: BusinessDate;
}

/** Identity of a create for `Idempotency-Key` replays. */
export function classificationFingerprint(c: NewTaxClassification): string {
  const years = (c.taxYear ?? null) === null && (c.refundOfYear ?? null) === null ? [] : [c.taxYear ?? null, c.refundOfYear ?? null];
  const fields = [
    c.sourcePosition ?? null,
    c.netAmount?.amount ?? null,
    c.annuallyRecurring ?? false,
    c.distributionYears ?? null,
    c.mostlyResidentialConfirmed ?? null,
    c.anschaffungsnaheAcquisitionId ?? null,
  ];
  // VC-7-03's fields only when one is given (§58B): a body without them keeps the fingerprint of VC-7-02.
  const later = JSON.stringify(fields) === JSON.stringify([null, null, false, null, null, null]) ? [] : [{ vc703: fields }];
  // §59E's record only when given, so a key stored before VC-X-36 still replays.
  const record = (c.constructionPeriodInterestId ?? null) === null ? [] : [{ vcx36: c.constructionPeriodInterestId }];
  // VC-7-01's fingerprint unchanged without the years, so a key stored before VC-7-02 still replays.
  return JSON.stringify([
    c.sourceType,
    c.sourceId,
    c.taxCategory,
    c.treatment,
    c.reviewState,
    c.supersedes,
    c.notes,
    c.sourceReferences,
    ...years,
    ...later,
    ...record,
  ]);
}
