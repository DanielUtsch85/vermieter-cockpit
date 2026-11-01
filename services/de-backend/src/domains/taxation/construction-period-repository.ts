import type { AuditActor, VersionConflict } from '../../shared/index.js';
import type { ConstructionPeriodChanges, ConstructionPeriodInterest, NewConstructionPeriodInterest } from './construction-period-interest.js';
import type { Treatment } from './vocabulary.js';

/** The persistence port of the construction-period records (api-design.md §59E "Routes"), scoped to the Realm given. */

/** A classification naming a record, as its read shows them (current and superseded). */
export interface NamingClassification {
  readonly classificationId: string;
  readonly splitId: string;
  readonly treatment: Treatment | null;
  readonly reviewState: string;
  readonly current: boolean;
}

export type CreateRecordOutcome =
  | { readonly kind: 'CREATED'; readonly record: ConstructionPeriodInterest }
  | { readonly kind: 'REPLAYED'; readonly record: ConstructionPeriodInterest }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'LOAN_NOT_FOUND'; readonly loanId: string }
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND'; readonly propertyReferenceId: string };

export type ChangeRecordOutcome =
  | { readonly kind: 'CHANGED'; readonly record: ConstructionPeriodInterest; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'RECORD_VOID' }
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND'; readonly propertyReferenceId: string }
  | { readonly kind: 'PARTY_NOT_FOUND'; readonly partyId: string }
  | VersionConflict;

export type ConfirmStep =
  | { readonly reviewState: 'CONFIRMED'; readonly advisorPartyId: null }
  | { readonly reviewState: 'ADVISOR_CONFIRMED'; readonly advisorPartyId: string };

export interface ConstructionPeriodInterestRepository {
  create(
    record: NewConstructionPeriodInterest,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateRecordOutcome>;
  amend(
    id: string,
    mreRealmId: string,
    changes: ConstructionPeriodChanges,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ChangeRecordOutcome>;
  confirm(id: string, mreRealmId: string, step: ConfirmStep, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ChangeRecordOutcome>;
  void(id: string, mreRealmId: string, reason: string, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ChangeRecordOutcome>;
  /** One `REPEATABLE READ READ ONLY` snapshot: the record and the classifications naming it; undefined when unknown. */
  find(
    id: string,
    mreRealmId: string,
  ): Promise<{ readonly record: ConstructionPeriodInterest; readonly classifications: readonly NamingClassification[] } | undefined>;
  /** The Realm's records, filtered by Loan and PropertyReference, by creation. */
  list(mreRealmId: string, filter: { readonly loanId?: string; readonly propertyReferenceId?: string }): Promise<readonly ConstructionPeriodInterest[]>;
}
