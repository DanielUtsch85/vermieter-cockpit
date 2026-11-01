import { Money, type AuditActor } from '../../shared/index.js';
import type { AcquisitionStatus } from './acquisition.js';
import type { CostCategory, CostStatus } from './cost.js';

/**
 * The purpose of one acquisition cost (api-design.md §59D, data-model.md `AcquisitionCostClassification`; tax review of
 * 2026-11-01, questions 10 and 24, mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01):
 * recorded as entered, never changed, only superseded, with its own review state, as the land/building allocation
 * (§27.3). The cost itself stays frozen. Which purposes enter a basis is the rule's (`costClassification`), never this
 * module's. No input VAT per classification (§59D open question 6, the alternative): the scope assumption without a
 * VAT option stays global (§59A "Gross amounts").
 */

export const CLASSIFICATION_PURPOSES = ['OWNERSHIP_TRANSFER', 'FINANCING', 'NOT_ACQUISITION_COST'] as const;
export type ClassificationPurpose = (typeof CLASSIFICATION_PURPOSES)[number];

/** data-model §6.7 without `SUGGESTED`, which is reserved for machine suggestions (as §27.3). */
export const CLASSIFICATION_REVIEW_STATES = ['UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED', 'ADVISOR_CONFIRMED'] as const;
export type ClassificationReviewState = (typeof CLASSIFICATION_REVIEW_STATES)[number];

/** At most this many parts per classification (§59D open question 5). */
export const MAX_CLASSIFICATION_PARTS = 5;

/**
 * The category whose cost is a financing cost by its own statement (question 24: never in the basis): only `FINANCING`
 * parts (§59D open question 7). A fact of the category, not a tax rule's choice; the database repeats it.
 */
export const FINANCING_CATEGORY: CostCategory = 'FINANCING_RELATED';
export const FINANCING_PURPOSE: ClassificationPurpose = 'FINANCING';

export interface ClassificationPart {
  readonly purpose: ClassificationPurpose;
  /** > 0; the parts sum exactly to the cost's amount. */
  readonly amount: Money;
}

export interface ClassificationData {
  readonly parts: readonly ClassificationPart[];
  readonly description: string;
  readonly sourceReferences: readonly string[];
  readonly reviewState: ClassificationReviewState;
  readonly advisorPartyId: string | null;
  readonly notes: string | null;
  /** The current classification this one replaces; `null` for the first. */
  readonly supersedes: string | null;
}

export interface NewCostClassification extends ClassificationData {
  readonly mreRealmId: string;
  readonly acquisitionId: string;
  readonly costId: string;
}

export interface AcquisitionCostClassification extends Omit<ClassificationData, 'supersedes'> {
  readonly id: string;
  readonly mreRealmId: string;
  readonly acquisitionId: string;
  readonly costId: string;
  readonly supersedesId: string | null;
  readonly supersededAt: Date | null;
  /** Derived: the classification whose `supersedesId` names this one (no stored back-pointer, as §27.3). */
  readonly supersededById: string | null;
  readonly current: boolean;
  readonly createdAt: Date;
}

export type ClassificationRefusal =
  | { readonly kind: 'ACQUISITION_CANCELLED' }
  | { readonly kind: 'COST_VOID' }
  /** `supersedes` does not name the current classification (→ 409 CURRENT_CLASSIFICATION_CHANGED). */
  | { readonly kind: 'CURRENT_CLASSIFICATION_CHANGED'; readonly currentClassificationId: string | null }
  | { readonly kind: 'PARTS_SUM_MISMATCH'; readonly costAmount: Money; readonly partsSum: Money }
  | { readonly kind: 'PURPOSE_NOT_ALLOWED'; readonly category: string; readonly purpose: ClassificationPurpose };

/** The parts' sum (in the cost's currency). */
export function partsSum(parts: readonly ClassificationPart[], currency: string): Money {
  return parts.reduce((sum, p) => sum.add(p.amount), Money.zero(currency));
}

/** The checks of §59D after the 404s, in their order (3–5); `undefined` = the classification may be written. */
export function checkClassification(
  acquisitionStatus: AcquisitionStatus,
  cost: { readonly status: CostStatus; readonly category: string; readonly amount: Money },
  currentId: string | null,
  data: Pick<ClassificationData, 'parts' | 'supersedes'>,
): ClassificationRefusal | undefined {
  if (acquisitionStatus === 'CANCELLED') return { kind: 'ACQUISITION_CANCELLED' };
  if (cost.status === 'VOID') return { kind: 'COST_VOID' };
  if (data.supersedes !== currentId) return { kind: 'CURRENT_CLASSIFICATION_CHANGED', currentClassificationId: currentId };
  const sum = partsSum(data.parts, cost.amount.currency);
  if (!sum.equals(cost.amount)) return { kind: 'PARTS_SUM_MISMATCH', costAmount: cost.amount, partsSum: sum };
  if (cost.category === FINANCING_CATEGORY) {
    const other = data.parts.find((p) => p.purpose !== FINANCING_PURPOSE);
    if (other !== undefined) return { kind: 'PURPOSE_NOT_ALLOWED', category: cost.category, purpose: other.purpose };
  }
  return undefined;
}

/** Identity of a create for `Idempotency-Key` replays: the cost and the normalized payload. */
export function classificationFingerprint(c: NewCostClassification): string {
  return JSON.stringify([
    c.acquisitionId,
    c.costId,
    c.parts.map((p) => [p.purpose, p.amount.amount, p.amount.currency]),
    c.description,
    c.sourceReferences,
    c.reviewState,
    c.advisorPartyId,
    c.notes,
    c.supersedes,
  ]);
}

export type CreateClassificationOutcome =
  | { readonly kind: 'CREATED'; readonly classification: AcquisitionCostClassification }
  | { readonly kind: 'REPLAYED'; readonly classification: AcquisitionCostClassification }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'ACQUISITION_NOT_FOUND' }
  | { readonly kind: 'COST_NOT_FOUND' }
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | ClassificationRefusal;

/** Persistence port, implemented in infrastructure/postgres; scoped to the Realm. */
export interface AcquisitionCostClassificationRepository {
  /**
   * One READ COMMITTED transaction: claims the key, writes the Acquisition row (the serialising no-op of §27.2), reads
   * the cost and its current classification, checks, sets the old one's `supersededAt`, inserts the new one and its
   * parts, writes the AuditRecords.
   */
  create(
    classification: NewCostClassification,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateClassificationOutcome>;
  /**
   * The cost's current classification and its history, newest first, in one snapshot; `ACQUISITION_NOT_FOUND` or
   * `COST_NOT_FOUND` for an unknown or foreign one.
   */
  list(
    acquisitionId: string,
    costId: string,
    mreRealmId: string,
  ): Promise<
    | { readonly kind: 'FOUND'; readonly current: AcquisitionCostClassification | null; readonly items: readonly AcquisitionCostClassification[] }
    | { readonly kind: 'ACQUISITION_NOT_FOUND' }
    | { readonly kind: 'COST_NOT_FOUND' }
  >;
}
