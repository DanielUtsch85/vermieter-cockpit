import { TAX_RULES } from '../domains/tax-rules/index.js';
import {
  attributionChanges,
  partChanges,
  planAcknowledgement,
  type AcknowledgedKind,
  type LoanAllocationTaxConfirmation,
  type NothingToConfirmCause,
  type TaxStatementStatus,
  type TaxStatementRepository,
  type TaxYearAcknowledgement,
} from '../domains/taxation/index.js';
import { businessDayOf } from '../domains/ledger/index.js';
import type { Fingerprinter, RuleRegistry } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { ConcurrentUpdateError, IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { LoanAllocationSetNotFoundError } from './loan-allocations.js';
import { LoanNotFoundError } from './loans.js';
import { PartyNotFoundError } from './parties.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';

/**
 * The statements of the tax-year view (api-design.md §58E, VC-X-28): acknowledging an attribution change of a
 * PropertyReference and year (Part 2) and confirming a multi-entry `PURCHASE_PRICE` allocation set (Part 3), each
 * withdrawable with a reason, and their lists. Any user of the Realm may state them (as §57: no advisor role in the
 * MVP; the actor is recorded). A statement clears exactly its own flag in the view and nothing else (decided by the owner
 * on 2026-11-02): no figure, no other flag, no stage of §60A.
 */

export class TaxYearAcknowledgementNotFoundError extends Error {
  override readonly name = 'TaxYearAcknowledgementNotFoundError';

  constructor(readonly acknowledgementId: string) {
    super(`Acknowledgement ${acknowledgementId} not found`);
  }
}

/** The year shows no such change (→ 409 CONFLICT, `CHANGE_NOT_FLAGGED`; §58G: `kind` named when given). */
export class AttributionChangeNotFlaggedError extends Error {
  override readonly name = 'AttributionChangeNotFlaggedError';

  constructor(
    readonly auditRecordId: string,
    readonly year: number,
    readonly kind?: AcknowledgedKind,
  ) {
    super(`The year ${year} shows no attribution change ${auditRecordId}`);
  }
}

/** The record is more than one change of the year and no `kind` was named (→ 409 CONFLICT, `CHANGE_AMBIGUOUS`, §58G). */
export class AttributionChangeAmbiguousError extends Error {
  override readonly name = 'AttributionChangeAmbiguousError';

  constructor(
    readonly auditRecordId: string,
    readonly year: number,
    readonly kinds: readonly AcknowledgedKind[],
  ) {
    super(`The record ${auditRecordId} is more than one change of ${year}`);
  }
}

/** The change moves other items than when the person read it (→ 412 ATTRIBUTION_CHANGE_DIFFERS). */
export class AttributionChangeDiffersError extends Error {
  override readonly name = 'AttributionChangeDiffersError';

  constructor(
    readonly auditRecordId: string,
    readonly expectedFingerprint: string,
    readonly currentFingerprint: string,
  ) {
    super(`The attribution change ${auditRecordId} differs from what was read`);
  }
}

export class LoanAllocationTaxConfirmationNotFoundError extends Error {
  override readonly name = 'LoanAllocationTaxConfirmationNotFoundError';

  constructor(readonly confirmationId: string) {
    super(`Confirmation ${confirmationId} not found`);
  }
}

/** The set needs no tax confirmation (→ 409 CONFLICT, `NOTHING_TO_CONFIRM`). */
export class NothingToConfirmError extends Error {
  override readonly name = 'NothingToConfirmError';

  constructor(
    readonly allocationSetId: string,
    readonly nothingCause: NothingToConfirmCause,
  ) {
    super(`Allocation set ${allocationSetId} needs no tax confirmation (${nothingCause})`);
  }
}

interface Deps {
  readonly repository: TaxStatementRepository;
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER' as const, actorId: principal.email });

/** §15: the fingerprint of the normalized request; the reason is part of it (another reason is another payload). */
const requestFingerprint = (parts: readonly unknown[]) => JSON.stringify(parts);

export type AcknowledgeAttributionChange = (input: {
  readonly principal: RealmPrincipal;
  readonly propertyReferenceId: string;
  readonly year: number;
  readonly auditRecordId: string;
  /** §58G: which of the record's changes (optional; needed only when the record is more than one change of the year). */
  readonly kind?: AcknowledgedKind;
  readonly expectedFingerprint: string;
  readonly reason: string;
  readonly idempotencyKey?: string;
}) => Promise<{ readonly acknowledgement: TaxYearAcknowledgement; readonly created: boolean; readonly replayed: boolean }>;

/**
 * `POST …/tax-years/{year}/acknowledgements` in §58E's order of checks after the `400`s: the PropertyReference, the change
 * among both flags' changes of the year (§58E Part 1 and §58G) derived in the command's own snapshot, by `auditRecordId`
 * and the optional `kind` (`CHANGE_NOT_FLAGGED`, `CHANGE_AMBIGUOUS`), its fingerprint
 * (`ATTRIBUTION_CHANGE_DIFFERS`), the no-op, then `201`. A serialisation failure retries the whole transaction up to three
 * times with a fresh snapshot (it then ends in the no-op), then `503 CONCURRENT_UPDATE`.
 */
export function acknowledgeAttributionChange(
  deps: Deps & {
    readonly fingerprinter: Fingerprinter;
    readonly registry?: RuleRegistry;
    readonly attempts?: number;
    readonly now?: () => Date;
  },
): AcknowledgeAttributionChange {
  const registry = deps.registry ?? TAX_RULES;
  const attempts = deps.attempts ?? 3;
  return async ({ principal, propertyReferenceId, year, auditRecordId, kind, expectedFingerprint, reason, idempotencyKey }) => {
    const request = { auditRecordId: auditRecordId.toLowerCase(), expectedFingerprint, ...(kind === undefined ? {} : { kind }) };
    const context = { propertyReferenceId, fingerprinter: deps.fingerprinter };
    for (let attempt = 1; ; attempt++) {
      const outcome = await deps.repository.acknowledge({
        propertyReferenceId,
        year,
        mreRealmId: principal.mreRealmId,
        actor: actorOf(principal),
        reason,
        today: businessDayOf((deps.now ?? (() => new Date()))()),
        ...(idempotencyKey === undefined
          ? {}
          : {
              idempotency: {
                key: idempotencyKey,
                // §58G: the kind is part of the payload; without it the fingerprint is VC-X-28's.
                fingerprint: requestFingerprint([
                  propertyReferenceId,
                  year,
                  request.auditRecordId,
                  expectedFingerprint,
                  reason,
                  ...(kind === undefined ? [] : [kind]),
                ]),
              },
            }),
        decide: ({ attribution, parts }, active) =>
          planAcknowledgement(
            [...attributionChanges(attribution, year, registry, context).changes, ...partChanges(parts, year, context).changes],
            request,
            active,
          ),
      });
      switch (outcome.kind) {
        case 'CREATED':
          return { acknowledgement: outcome.acknowledgement, created: true, replayed: outcome.replayed };
        case 'UNCHANGED':
          return { acknowledgement: outcome.acknowledgement, created: false, replayed: outcome.replayed };
        case 'NOT_FOUND':
          throw new PropertyReferenceNotFoundError(propertyReferenceId);
        case 'NOT_FLAGGED':
          throw new AttributionChangeNotFlaggedError(request.auditRecordId, year, kind);
        case 'AMBIGUOUS':
          throw new AttributionChangeAmbiguousError(request.auditRecordId, year, outcome.kinds);
        case 'DIFFERS':
          throw new AttributionChangeDiffersError(request.auditRecordId, expectedFingerprint, outcome.currentFingerprint);
        case 'IDEMPOTENCY_CONFLICT':
          throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
        case 'SERIALIZATION_FAILURE':
          if (attempt >= attempts) throw new ConcurrentUpdateError('The data kept changing concurrently; nothing was written');
      }
    }
  };
}

export type WithdrawAcknowledgement = (input: {
  readonly principal: RealmPrincipal;
  readonly propertyReferenceId: string;
  readonly year: number;
  readonly acknowledgementId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<TaxYearAcknowledgement>;

/** `POST …/acknowledgements/{id}/withdraw`: `404` → already `WITHDRAWN` (no-op, the first reason kept) → `If-Match` → `200`. */
export function withdrawAcknowledgement(deps: Deps): WithdrawAcknowledgement {
  return async ({ principal, propertyReferenceId, year, acknowledgementId, reason, expectedVersions }) => {
    const outcome = await deps.repository.withdrawAcknowledgement({
      propertyReferenceId,
      year,
      acknowledgementId,
      mreRealmId: principal.mreRealmId,
      actor: actorOf(principal),
      reason,
      ...(expectedVersions === undefined ? {} : { expectedVersions }),
    });
    if (outcome.kind === 'NOT_FOUND') throw new TaxYearAcknowledgementNotFoundError(acknowledgementId);
    if (outcome.kind === 'VERSION_CONFLICT') throw new VersionConflictError(expectedVersions ?? [], outcome.currentVersion);
    return outcome.statement;
  };
}

export type ListAcknowledgements = (input: {
  readonly principal: RealmPrincipal;
  readonly propertyReferenceId: string;
  readonly year: number;
  readonly statuses: readonly TaxStatementStatus[] | null;
}) => Promise<readonly TaxYearAcknowledgement[]>;

/** The list: stored data only, newest first, both statuses unless filtered; no derivation. */
export function listAcknowledgements(deps: Deps): ListAcknowledgements {
  return async ({ principal, propertyReferenceId, year, statuses }) => {
    const found = await deps.repository.listAcknowledgements(propertyReferenceId, year, principal.mreRealmId, statuses);
    if (found === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);
    return found;
  };
}

export type ConfirmAllocationSet = (input: {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly allocationSetId: string;
  readonly reason: string;
  readonly advisorPartyId: string | null;
  readonly idempotencyKey?: string;
}) => Promise<{ readonly confirmation: LoanAllocationTaxConfirmation; readonly created: boolean; readonly replayed: boolean }>;

/**
 * `POST /loans/{loanId}/allocations/{allocationSetId}/tax-confirmations` in §58E's order of checks: the Loan, the set,
 * the advisor Party, `NOTHING_TO_CONFIRM`, the no-op (whatever the body says), then `201`.
 */
export function confirmAllocationSet(deps: Deps): ConfirmAllocationSet {
  return async ({ principal, loanId, allocationSetId, reason, advisorPartyId, idempotencyKey }) => {
    const outcome = await deps.repository.confirm({
      loanId,
      allocationSetId,
      mreRealmId: principal.mreRealmId,
      actor: actorOf(principal),
      reason,
      advisorPartyId,
      ...(idempotencyKey === undefined
        ? {}
        : { idempotency: { key: idempotencyKey, fingerprint: requestFingerprint([allocationSetId, reason, advisorPartyId]) } }),
    });
    switch (outcome.kind) {
      case 'CREATED':
        return { confirmation: outcome.confirmation, created: true, replayed: outcome.replayed };
      case 'UNCHANGED':
        return { confirmation: outcome.confirmation, created: false, replayed: outcome.replayed };
      case 'LOAN_NOT_FOUND':
        throw new LoanNotFoundError(loanId);
      case 'SET_NOT_FOUND':
        throw new LoanAllocationSetNotFoundError(allocationSetId);
      case 'ADVISOR_NOT_FOUND':
        throw new PartyNotFoundError(advisorPartyId as string);
      case 'NOTHING_TO_CONFIRM':
        throw new NothingToConfirmError(allocationSetId, outcome.cause);
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
    }
  };
}

export type WithdrawConfirmation = (input: {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly allocationSetId: string;
  readonly confirmationId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<LoanAllocationTaxConfirmation>;

/** As the acknowledgement's; allowed on a `VOID` set's confirmation too (it changes only the record). */
export function withdrawConfirmation(deps: Deps): WithdrawConfirmation {
  return async ({ principal, loanId, allocationSetId, confirmationId, reason, expectedVersions }) => {
    const outcome = await deps.repository.withdrawConfirmation({
      loanId,
      allocationSetId,
      confirmationId,
      mreRealmId: principal.mreRealmId,
      actor: actorOf(principal),
      reason,
      ...(expectedVersions === undefined ? {} : { expectedVersions }),
    });
    if (outcome.kind === 'NOT_FOUND') throw new LoanAllocationTaxConfirmationNotFoundError(confirmationId);
    if (outcome.kind === 'VERSION_CONFLICT') throw new VersionConflictError(expectedVersions ?? [], outcome.currentVersion);
    return outcome.statement;
  };
}

export type ListConfirmations = (input: {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly allocationSetId: string;
}) => Promise<readonly LoanAllocationTaxConfirmation[]>;

export function listConfirmations(deps: Deps): ListConfirmations {
  return async ({ principal, loanId, allocationSetId }) => {
    const found = await deps.repository.listConfirmations(loanId, allocationSetId, principal.mreRealmId);
    if (found === 'LOAN_NOT_FOUND') throw new LoanNotFoundError(loanId);
    if (found === 'SET_NOT_FOUND') throw new LoanAllocationSetNotFoundError(allocationSetId);
    return found;
  };
}
