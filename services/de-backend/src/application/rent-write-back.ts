import {
  dePayment,
  isRoundTrippable,
  markerIn,
  markerOf,
  storedPayments,
  verifyWritten,
  writeBody,
  type MrePaymentSnapshot,
  type ReconciliationStatus,
  type RentPaymentReconciliation,
  type RentReconciliationRepository,
  type TermWrite,
  type WriteBackError,
  type WriteBackResult,
  type WriteBackTerm,
} from '../domains/rent-reconciliation/index.js';
import { AccessError, type RealmPrincipal } from './access.js';
import { MreUnavailableError, VersionConflictError } from './errors.js';
import { ReconciliationNotFoundError, WriteBackInProgressError, actorOf } from './rent-reconciliations.js';

/**
 * The write-back to MRE and its presence check (api-design.md §37.4, backlog VC-4-04): claim → read → write → verify
 * → record, with no database transaction open during an MRE call (P4-D8), under the caller's own MRE credentials.
 */

/**
 * The rent term with its raw values, read with the caller's own MRE credentials; undefined when MRE does not return
 * it. Throws AccessError when MRE refuses the caller and MreUnavailableError when MRE cannot be asked.
 */
export type MreWriteBackTermReader = (authorizationHeader: string, mreRealmId: string, mreTenantId: string, mreRentTerm: string) => Promise<WriteBackTerm | undefined>;

/**
 * The PATCH of the term's whole settlement with the caller's own MRE credentials. Throws AccessError when MRE refuses
 * the caller; every other outcome is a result, since a PATCH without an answer may still have been saved.
 */
export type MreWriteBackTermWriter = (
  authorizationHeader: string,
  mreRealmId: string,
  mreTenantId: string,
  mreRentTerm: string,
  write: TermWrite,
) => Promise<{ readonly kind: 'ANSWERED'; readonly term: WriteBackTerm } | { readonly kind: 'NO_ANSWER' } | { readonly kind: 'REFUSED'; readonly status: number }>;

/** Not `CONFIRMED` (→ 409 NOT_WRITABLE). */
export class NotWritableError extends Error {
  override readonly name = 'NotWritableError';

  constructor(readonly status: ReconciliationStatus) {
    super(`A ${status} reconciliation cannot be written back`);
  }
}

/**
 * An attempt after its claim that ended without `WRITTEN` (§37.4): its code, and the reconciliation as recorded
 * (`FAILED`, or `NOT_WRITTEN` for `MRE_TERM_NOT_ROUND_TRIPPABLE`).
 */
export class WriteBackFailedError extends Error {
  override readonly name = 'WriteBackFailedError';

  constructor(
    readonly code: WriteBackError | 'MRE_TERM_NOT_ROUND_TRIPPABLE',
    readonly reconciliation: RentPaymentReconciliation,
  ) {
    super(`The write-back to MRE ended with ${code}`);
  }
}

export type WriteBackToMre = (input: {
  readonly principal: RealmPrincipal;
  readonly authorizationHeader: string;
  readonly reconciliationId: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly reconciliation: RentPaymentReconciliation; readonly changed: boolean }>;

/** §37.4's write-back; `leaseMs` is twice the MRE timeout. */
export function writeBackToMre(deps: {
  readonly repository: RentReconciliationRepository;
  readonly readTerm: MreWriteBackTermReader;
  readonly writeTerm: MreWriteBackTermWriter;
  readonly leaseMs: number;
}): WriteBackToMre {
  return async ({ principal, authorizationHeader, reconciliationId, expectedVersions }) => {
    const actor = actorOf(principal);
    const realm = principal.mreRealmId;
    // 1. Claim.
    const claim = await deps.repository.claimWriteBack(reconciliationId, realm, deps.leaseMs, actor, expectedVersions);
    switch (claim.kind) {
      case 'UNCHANGED':
        return { reconciliation: claim.reconciliation, changed: false };
      case 'NOT_FOUND':
        throw new ReconciliationNotFoundError(reconciliationId);
      case 'NOT_WRITABLE':
        throw new NotWritableError(claim.status);
      case 'WRITE_BACK_IN_PROGRESS':
        throw new WriteBackInProgressError(claim.reconciliationId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(claim.expectedVersions, claim.currentVersion);
      case 'CLAIMED':
        break;
    }
    const { reconciliation: claimed, attemptId, bookingDate } = claim;
    const { mreTenantId, mreRentTerm } = claimed;
    const payment = dePayment(claimed.id, claimed.matchedAmount, bookingDate);

    // 5. Record, only under this attempt's lease.
    const record = async (result: WriteBackResult) => {
      const recorded = await deps.repository.recordWriteBack(claimed.id, realm, attemptId, result, actor);
      if (recorded.kind === 'LEASE_LOST') throw new WriteBackInProgressError(claimed.id);
      return recorded.reconciliation;
    };
    const failed = async (error: WriteBackError) => new WriteBackFailedError(error, await record({ kind: 'FAILED', error }));
    const written = async (patched: boolean) => {
      const snapshot: MrePaymentSnapshot = { date: String(payment.date), amount: claimed.matchedAmount, type: 'transfer', reference: markerOf(claimed.id) };
      return { reconciliation: await record({ kind: 'WRITTEN', payment: snapshot, patched }), changed: true };
    };
    /** An MRE call that threw: refused callers keep their AccessError, an outage becomes `MRE_UNAVAILABLE`. */
    const mreFailure = async (error: unknown) => {
      if (error instanceof AccessError) {
        await record({ kind: 'FAILED', error: 'MRE_FORBIDDEN' });
        return error;
      }
      if (error instanceof MreUnavailableError) return failed('MRE_UNAVAILABLE');
      return error;
    };
    const readTerm = async () => {
      try {
        return await deps.readTerm(authorizationHeader, realm, mreTenantId, mreRentTerm);
      } catch (error) {
        throw await mreFailure(error);
      }
    };

    // 2. Read before writing: an earlier attempt may have written DE's payment already.
    const read = await readTerm();
    if (read === undefined) throw await failed('MRE_RENT_TERM_NOT_FOUND');
    const marker = markerIn(read, payment);
    if (marker === 'PRESENT') return written(false);
    if (marker === 'CHANGED') throw await failed('MRE_PAYMENT_CHANGED');
    if (!isRoundTrippable(read)) throw new WriteBackFailedError('MRE_TERM_NOT_ROUND_TRIPPABLE', await record({ kind: 'NOT_WRITTEN' }));

    // 3. Write the whole settlement back with DE's payment.
    let result: Awaited<ReturnType<MreWriteBackTermWriter>>;
    try {
      result = await deps.writeTerm(authorizationHeader, realm, mreTenantId, mreRentTerm, writeBody(read, payment));
    } catch (error) {
      throw await mreFailure(error);
    }

    // 4. Verify the answer; without one, or on a mismatch, read once more.
    if (result.kind === 'ANSWERED' && verifyWritten(read, result.term, payment) === 'OK') return written(true);
    let again: WriteBackTerm | undefined;
    try {
      again = await deps.readTerm(authorizationHeader, realm, mreTenantId, mreRentTerm);
    } catch (error) {
      if (error instanceof AccessError) throw await mreFailure(error);
      throw await failed(result.kind === 'REFUSED' ? 'MRE_WRITE_REFUSED' : 'MRE_UNAVAILABLE');
    }
    if (again === undefined) throw await failed('MRE_RENT_TERM_NOT_FOUND');
    const check = verifyWritten(read, again, payment);
    if (check === 'OK') return written(true);
    // MRE saved and answered, or the marker is there with other content: someone edited the Tenant in between.
    if (check === 'CHANGED' || result.kind === 'ANSWERED') throw await failed('MRE_TERM_CHANGED');
    throw await failed(result.kind === 'REFUSED' ? 'MRE_WRITE_REFUSED' : 'MRE_UNAVAILABLE');
  };
}

export type MrePresence = 'PRESENT' | 'MISSING' | 'UNAVAILABLE';

export type GetReconciliationWithPresence = (input: {
  readonly principal: RealmPrincipal;
  readonly authorizationHeader: string;
  readonly reconciliationId: string;
}) => Promise<{ readonly reconciliation: RentPaymentReconciliation; readonly mrePresence: MrePresence | null }>;

/**
 * §37.4's presence check (`?checkMre=true`): whether DE's payment is still in MRE, for a `WRITTEN` or
 * `REMOVAL_REQUIRED` reconciliation. A read only: nothing is written, not even an AuditRecord.
 */
export function getReconciliationWithPresence(deps: { readonly repository: RentReconciliationRepository; readonly readTerm: MreWriteBackTermReader }): GetReconciliationWithPresence {
  return async ({ principal, authorizationHeader, reconciliationId }) => {
    const reconciliation = await deps.repository.findById(reconciliationId, principal.mreRealmId);
    if (reconciliation === undefined) throw new ReconciliationNotFoundError(reconciliationId);
    if (reconciliation.mreWriteBackState !== 'WRITTEN' && reconciliation.mreWriteBackState !== 'REMOVAL_REQUIRED') return { reconciliation, mrePresence: null };
    try {
      const term = await deps.readTerm(authorizationHeader, principal.mreRealmId, reconciliation.mreTenantId, reconciliation.mreRentTerm);
      const marker = markerOf(reconciliation.id);
      const present = term !== undefined && storedPayments(term.payments).some((p) => p.reference === marker);
      return { reconciliation, mrePresence: present ? 'PRESENT' : 'MISSING' };
    } catch (error) {
      if (error instanceof MreUnavailableError) return { reconciliation, mrePresence: 'UNAVAILABLE' };
      throw error;
    }
  };
}
