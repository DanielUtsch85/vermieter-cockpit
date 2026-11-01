import {
  classificationFingerprint,
  type AcquisitionCostClassification,
  type AcquisitionCostClassificationRepository,
  type ClassificationData,
  type ClassificationPurpose,
} from '../domains/acquisition/index.js';
import type { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { AcquisitionCancelledError, AcquisitionCostNotFoundError } from './acquisition-costs.js';
import { IdempotencyKeyConflictError } from './errors.js';
import { AcquisitionNotFoundError } from './ownerships.js';
import { PartyNotFoundError } from './parties.js';

/**
 * The classification of an acquisition cost (api-design.md §59D, backlog VC-X-42), in the caller's verified Realm.
 * Input arrives validated from the API boundary (1–5 parts, each > 0; a known purpose; no `SUGGESTED`; an advisor only
 * with `ADVISOR_CONFIRMED`).
 */

/** The cost is `VOID` (→ 409 COST_VOID, as §27.2). */
export class AcquisitionCostVoidError extends Error {
  override readonly name = 'AcquisitionCostVoidError';

  constructor(readonly acquisitionCostId: string) {
    super(`AcquisitionCost ${acquisitionCostId} is void`);
  }
}

/** `supersedes` does not name the current classification (→ 409 CURRENT_CLASSIFICATION_CHANGED). */
export class CurrentClassificationChangedError extends Error {
  override readonly name = 'CurrentClassificationChangedError';

  constructor(readonly currentClassificationId: string | null) {
    super(`The current classification is ${currentClassificationId ?? 'none'}`);
  }
}

/** The parts do not sum to the cost's amount (→ 422 PARTS_SUM_MISMATCH). */
export class ClassificationPartsSumMismatchError extends Error {
  override readonly name = 'ClassificationPartsSumMismatchError';

  constructor(
    readonly costAmount: Money,
    readonly partsSum: Money,
  ) {
    super(`The parts sum to ${partsSum.amount}, not the cost's ${costAmount.amount}`);
  }
}

/** A `FINANCING_RELATED` cost with another purpose than `FINANCING` (→ 422 PURPOSE_NOT_ALLOWED). */
export class ClassificationPurposeNotAllowedError extends Error {
  override readonly name = 'ClassificationPurposeNotAllowedError';

  constructor(
    readonly category: string,
    readonly purpose: ClassificationPurpose,
  ) {
    super(`A ${category} cost takes no ${purpose} part`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

export type CreateCostClassification = (
  input: ClassificationData & { readonly principal: RealmPrincipal; readonly acquisitionId: string; readonly costId: string; readonly idempotencyKey?: string },
) => Promise<{ readonly classification: AcquisitionCostClassification; readonly replayed: boolean }>;

export function createCostClassification(deps: { readonly repository: AcquisitionCostClassificationRepository }): CreateCostClassification {
  return async ({ principal, acquisitionId, costId, idempotencyKey, ...fields }) => {
    const classification = { mreRealmId: principal.mreRealmId, acquisitionId, costId, ...fields };
    const outcome = await deps.repository.create(
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
      case 'ACQUISITION_NOT_FOUND':
        throw new AcquisitionNotFoundError(acquisitionId);
      case 'COST_NOT_FOUND':
        throw new AcquisitionCostNotFoundError(costId);
      case 'PARTY_NOT_FOUND':
        throw new PartyNotFoundError(outcome.partyId);
      case 'ACQUISITION_CANCELLED':
        throw new AcquisitionCancelledError(acquisitionId);
      case 'COST_VOID':
        throw new AcquisitionCostVoidError(costId);
      case 'CURRENT_CLASSIFICATION_CHANGED':
        throw new CurrentClassificationChangedError(outcome.currentClassificationId);
      case 'PARTS_SUM_MISMATCH':
        throw new ClassificationPartsSumMismatchError(outcome.costAmount, outcome.partsSum);
      case 'PURPOSE_NOT_ALLOWED':
        throw new ClassificationPurposeNotAllowedError(outcome.category, outcome.purpose);
    }
  };
}

export type ListCostClassifications = (input: {
  readonly principal: RealmPrincipal;
  readonly acquisitionId: string;
  readonly costId: string;
}) => Promise<{ readonly current: AcquisitionCostClassification | null; readonly items: readonly AcquisitionCostClassification[] }>;

export function listCostClassifications(deps: { readonly repository: AcquisitionCostClassificationRepository }): ListCostClassifications {
  return async ({ principal, acquisitionId, costId }) => {
    const result = await deps.repository.list(acquisitionId, costId, principal.mreRealmId);
    if (result.kind === 'ACQUISITION_NOT_FOUND') throw new AcquisitionNotFoundError(acquisitionId);
    if (result.kind === 'COST_NOT_FOUND') throw new AcquisitionCostNotFoundError(costId);
    return { current: result.current, items: result.items };
  };
}
