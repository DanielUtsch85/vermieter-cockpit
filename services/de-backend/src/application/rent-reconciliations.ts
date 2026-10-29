import {
  availableOf,
  bookingWindow,
  coverageOf,
  suggestPairs,
  type ConfirmPrecheck,
  type SuggestionTerm,
  matchFingerprint,
  matchedTotalOf,
  type Coverage,
  type CreateMatchOutcome,
  type NewMatch,
  type ReconciliationFilter,
  type ReconciliationPage,
  type ReconciliationStatus,
  type RentPaymentReconciliation,
  type SkippedInflows,
  type RentReconciliationRepository,
} from '../domains/rent-reconciliation/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, MreUnavailableError, VersionConflictError } from './errors.js';
import { TransactionNotFoundError } from './transaction-splits.js';

/**
 * Rent reconciliation commands and reads (api-design.md §37.1, backlog VC-4-01), in the caller's verified Realm. Input
 * arrives validated from the API boundary (ids, the term key's form, an amount > 0, texts trimmed).
 */

/**
 * Whether MRE returns the rent term `mreRentTerm` of the Tenant in the Realm, asked with the caller's own MRE
 * credentials (P4-D1). Throws AccessError when MRE refuses the caller and MreUnavailableError when MRE cannot be asked.
 */
export type MreRentTermLookup = (authorizationHeader: string, mreRealmId: string, mreTenantId: string, mreRentTerm: string) => Promise<boolean>;

/** An MRE rent term as the coverage read shows it (§37.2): MRE settlement, never cash (BR-RENT-001). */
export interface MreRentTermView {
  readonly amountDue: Money;
  readonly payments: readonly { readonly date: BusinessDate | null; readonly amount: Money; readonly type: string | null; readonly reference: string | null }[];
}

/**
 * The rent term read live with the caller's own MRE credentials; undefined when MRE does not return it. Throws
 * AccessError when MRE refuses the caller and MreUnavailableError when MRE cannot be asked.
 */
export type MreRentTermReader = (
  authorizationHeader: string,
  mreRealmId: string,
  mreTenantId: string,
  mreRentTerm: string,
) => Promise<MreRentTermView | undefined>;

export class ReconciliationNotFoundError extends Error {
  override readonly name = 'ReconciliationNotFoundError';

  constructor(readonly reconciliationId: string) {
    super(`Rent reconciliation ${reconciliationId} not found`);
  }
}

/** Not `CONFIRMED`/`RECONCILED`, or a reversal (→ 409 TRANSACTION_NOT_COUNTED). */
export class TransactionNotCountedError extends Error {
  override readonly name = 'TransactionNotCountedError';

  constructor(
    readonly status: string,
    readonly correctionRole: string | null,
  ) {
    super(`The Transaction is ${status}${correctionRole === null ? '' : ` (${correctionRole})`} and does not count`);
  }
}

/** `OUTFLOW` (→ 422 TRANSACTION_NOT_INFLOW). */
export class TransactionNotInflowError extends Error {
  override readonly name = 'TransactionNotInflowError';
}

/** No split in the rent categories (→ 422 NO_RENT_CASH). */
export class NoRentCashError extends Error {
  override readonly name = 'NoRentCashError';
}

/** A `CONFIRMED` reconciliation for the same Transaction and term exists (→ 409 ALREADY_MATCHED). */
export class AlreadyMatchedError extends Error {
  override readonly name = 'AlreadyMatchedError';

  constructor(readonly reconciliationId: string) {
    super(`Already matched by rent reconciliation ${reconciliationId}`);
  }
}

/** `matchedAmount` above the available rent cash (→ 409 RENT_CASH_EXCEEDED). */
export class RentCashExceededError extends Error {
  override readonly name = 'RentCashExceededError';

  constructor(
    readonly rentCash: Money,
    readonly available: Money,
  ) {
    super(`Only ${available.amount} of ${rentCash.amount} rent cash is available`);
  }
}

/** MRE did not return the term (→ 422 MRE_RENT_TERM_NOT_FOUND). */
export class MreRentTermNotFoundError extends Error {
  override readonly name = 'MreRentTermNotFoundError';

  constructor(
    readonly mreTenantId: string,
    readonly mreRentTerm: string,
  ) {
    super(`MRE did not return term ${mreRentTerm} of Tenant ${mreTenantId}`);
  }
}

/** A rent of an MRE month read (§37.3): the Tenant, the term and the amount due only. */
export interface MreMonthRentView {
  readonly mreTenantId: string;
  readonly term: string;
  readonly amountDue: Money;
}

/**
 * Every rent of the Realm in one month, read with the caller's own MRE credentials. Throws AccessError when MRE refuses
 * the caller and MreUnavailableError when MRE cannot be asked.
 */
export type MreMonthReader = (authorizationHeader: string, mreRealmId: string, year: number, month: number) => Promise<readonly MreMonthRentView[]>;

/** Confirm with an amount above the suggestion (→ 422 ABOVE_SUGGESTION). */
export class AboveSuggestionError extends Error {
  override readonly name = 'AboveSuggestionError';

  constructor(readonly suggested: Money) {
    super(`A confirmation may lower the suggested ${suggested.amount}, never raise it`);
  }
}

/** Not `SUGGESTED` (→ 409 NOT_CONFIRMABLE). */
export class NotConfirmableError extends Error {
  override readonly name = 'NotConfirmableError';

  constructor(readonly status: ReconciliationStatus) {
    super(`A ${status} reconciliation cannot be confirmed`);
  }
}

/** The term was matched in between: the amount is above its open amount now (→ 409 SUGGESTION_STALE). */
export class SuggestionStaleError extends Error {
  override readonly name = 'SuggestionStaleError';

  constructor(readonly openAmount: Money) {
    super(`The term's open amount is ${openAmount.amount} now`);
  }
}

/** `CONFIRMED` or `RELEASED` (→ 409 NOT_REJECTABLE). */
export class NotRejectableError extends Error {
  override readonly name = 'NotRejectableError';

  constructor(readonly status: ReconciliationStatus) {
    super(`A ${status} reconciliation cannot be rejected`);
  }
}

/** A write-back holds a live lease, its own or another reconciliation's of the same MRE Tenant (→ 409 WRITE_BACK_IN_PROGRESS). */
export class WriteBackInProgressError extends Error {
  override readonly name = 'WriteBackInProgressError';

  constructor(readonly reconciliationId: string) {
    super(`A write-back to MRE is running for reconciliation ${reconciliationId}`);
  }
}

/** `SUGGESTED` or `REJECTED` (→ 409 NOT_RELEASABLE). */
export class NotReleasableError extends Error {
  override readonly name = 'NotReleasableError';

  constructor(readonly status: ReconciliationStatus) {
    super(`A ${status} reconciliation cannot be released`);
  }
}

export const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

function refusal(outcome: Exclude<CreateMatchOutcome, { kind: 'CREATED' | 'REPLAYED' }>, transactionId: string): Error {
  switch (outcome.kind) {
    case 'IDEMPOTENCY_CONFLICT':
      return new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
    case 'TRANSACTION_NOT_FOUND':
      return new TransactionNotFoundError(transactionId);
    case 'TRANSACTION_NOT_COUNTED':
      return new TransactionNotCountedError(outcome.status, outcome.correctionRole);
    case 'TRANSACTION_NOT_INFLOW':
      return new TransactionNotInflowError('The Transaction is not an INFLOW');
    case 'NO_RENT_CASH':
      return new NoRentCashError('The Transaction has no split in a rent category');
    case 'ALREADY_MATCHED':
      return new AlreadyMatchedError(outcome.reconciliationId);
    case 'RENT_CASH_EXCEEDED':
      return new RentCashExceededError(outcome.rentCash, outcome.available);
  }
}

export interface CreateReconciliationInput extends Omit<NewMatch, 'mreRealmId'> {
  readonly principal: RealmPrincipal;
  /** The caller's `Authorization` header, forwarded to MRE for the term read. */
  readonly authorizationHeader: string;
  readonly idempotencyKey?: string;
}

export type CreateReconciliation = (
  input: CreateReconciliationInput,
) => Promise<{ readonly reconciliation: RentPaymentReconciliation; readonly replayed: boolean }>;

/** §37.1's manual match: DE's checks, then MRE outside any transaction, then DE's checks again under the locks. */
export function createReconciliation(deps: {
  readonly repository: RentReconciliationRepository;
  readonly lookupMreRentTerm: MreRentTermLookup;
}): CreateReconciliation {
  return async ({ principal, authorizationHeader, idempotencyKey, ...fields }) => {
    const match: NewMatch = { mreRealmId: principal.mreRealmId, ...fields };
    const idempotency = idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: matchFingerprint(match) };
    const settle = (outcome: CreateMatchOutcome) => {
      if (outcome.kind === 'CREATED') return { reconciliation: outcome.reconciliation, replayed: false };
      if (outcome.kind === 'REPLAYED') return { reconciliation: outcome.reconciliation, replayed: true };
      throw refusal(outcome, match.transactionId);
    };
    // Checks 2–7 from DE alone, so a replay or a refusal never asks MRE.
    const pre = await deps.repository.precheck(match, idempotency);
    if (pre.kind !== 'PROCEED') return settle(pre);
    if (!(await deps.lookupMreRentTerm(authorizationHeader, match.mreRealmId, match.mreTenantId, match.mreRentTerm))) {
      throw new MreRentTermNotFoundError(match.mreTenantId, match.mreRentTerm);
    }
    return settle(await deps.repository.create(match, actorOf(principal), idempotency));
  };
}

export type GetReconciliation = (input: { readonly principal: RealmPrincipal; readonly reconciliationId: string }) => Promise<RentPaymentReconciliation>;

export function getReconciliation(deps: { readonly repository: RentReconciliationRepository }): GetReconciliation {
  return async ({ principal, reconciliationId }) => {
    const found = await deps.repository.findById(reconciliationId, principal.mreRealmId);
    // Unknown and other-Realm reconciliations look the same, so existence does not leak.
    if (found === undefined) throw new ReconciliationNotFoundError(reconciliationId);
    return found;
  };
}

export type ListReconciliations = (input: {
  readonly principal: RealmPrincipal;
  readonly filter: ReconciliationFilter;
  readonly page: { readonly page: number; readonly pageSize: number };
}) => Promise<ReconciliationPage>;

export function listReconciliations(deps: { readonly repository: RentReconciliationRepository }): ListReconciliations {
  return ({ principal, filter, page }) => deps.repository.list(principal.mreRealmId, filter, page);
}

export type ReleaseReconciliation = (input: {
  readonly principal: RealmPrincipal;
  readonly reconciliationId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly reconciliation: RentPaymentReconciliation; readonly changed: boolean }>;

/** §37.1's release: DE-only, never calls MRE (P4-D7). */
export function releaseReconciliation(deps: { readonly repository: RentReconciliationRepository; readonly now?: () => Date }): ReleaseReconciliation {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, reconciliationId, reason, expectedVersions }) => {
    const outcome = await deps.repository.release(reconciliationId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'RELEASED':
        return { reconciliation: outcome.reconciliation, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new ReconciliationNotFoundError(reconciliationId);
      case 'NOT_RELEASABLE':
        throw new NotReleasableError(outcome.status);
      case 'WRITE_BACK_IN_PROGRESS':
        throw new WriteBackInProgressError(outcome.reconciliationId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type MreStatus = 'AVAILABLE' | 'NOT_RETURNED' | 'UNAVAILABLE';

export interface TermCoverage {
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
  readonly reconciliations: readonly RentPaymentReconciliation[];
  readonly matchedTotal: Money;
  readonly mreStatus: MreStatus;
  readonly mre: MreRentTermView | null;
  readonly coverage: Coverage | null;
  readonly openAmount: Money | null;
}

export type GetTermCoverage = (input: {
  readonly principal: RealmPrincipal;
  readonly authorizationHeader: string;
  readonly mreTenantId: string;
  readonly mreRentTerm: string;
}) => Promise<TermCoverage>;

/**
 * §37.2's per-term read: DE's side always, MRE's side read live next to it and never merged. An MRE outage degrades
 * to `UNAVAILABLE` with DE's side (BR-MRE-004); a refused token or caller stays an error (AccessError passes).
 */
export function getTermCoverage(deps: { readonly repository: RentReconciliationRepository; readonly readMreRentTerm: MreRentTermReader }): GetTermCoverage {
  return async ({ principal, authorizationHeader, mreTenantId, mreRentTerm }) => {
    const reconciliations = await deps.repository.termSide(principal.mreRealmId, mreTenantId, mreRentTerm);
    const matchedTotal = matchedTotalOf(reconciliations);
    let mre: MreRentTermView | undefined;
    try {
      mre = await deps.readMreRentTerm(authorizationHeader, principal.mreRealmId, mreTenantId, mreRentTerm);
    } catch (error) {
      if (!(error instanceof MreUnavailableError)) throw error;
      return { mreTenantId, mreRentTerm, reconciliations, matchedTotal, mreStatus: 'UNAVAILABLE', mre: null, coverage: null, openAmount: null };
    }
    if (mre === undefined) {
      return { mreTenantId, mreRentTerm, reconciliations, matchedTotal, mreStatus: 'NOT_RETURNED', mre: null, coverage: null, openAmount: null };
    }
    const { coverage, openAmount } = coverageOf(mre.amountDue, matchedTotal);
    return { mreTenantId, mreRentTerm, reconciliations, matchedTotal, mreStatus: 'AVAILABLE', mre, coverage, openAmount };
  };
}

export interface TransactionCoverage {
  readonly transactionId: string;
  readonly status: string;
  readonly direction: string;
  readonly correctionRole: string | null;
  readonly counted: boolean;
  readonly rentCash: Money | null;
  readonly matchedTotal: Money;
  readonly available: Money | null;
  readonly reconciliations: readonly RentPaymentReconciliation[];
}

export type GetTransactionCoverage = (input: { readonly principal: RealmPrincipal; readonly transactionId: string }) => Promise<TransactionCoverage>;

/** §37.2's per-Transaction read; never asks MRE. Cash that is not counted is not available to match. */
export function getTransactionCoverage(deps: { readonly repository: RentReconciliationRepository }): GetTransactionCoverage {
  return async ({ principal, transactionId }) => {
    const side = await deps.repository.transactionSide(transactionId, principal.mreRealmId);
    if (side === undefined) throw new TransactionNotFoundError(transactionId);
    const counted = (side.status === 'CONFIRMED' || side.status === 'RECONCILED') && side.correctionRole !== 'REVERSAL';
    const confirmed = side.reconciliations.filter((r) => r.status === 'CONFIRMED');
    const matchedTotal = matchedTotalOf(side.reconciliations);
    const available = counted && side.rentCash !== null ? availableOf({ ...side, rentCash: side.rentCash, confirmed }) : null;
    return { ...side, counted, matchedTotal, available };
  };
}

/** `YYYY-MM` months as year and month, inclusive, plus one; months are counted from year 0. */
const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const fromIndex = (i: number) => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });
const termOfMonth = (i: number) => `${fromIndex(i).year}${String(fromIndex(i).month).padStart(2, '0')}0100`;

export type SuggestReconciliations = (input: {
  readonly principal: RealmPrincipal;
  readonly authorizationHeader: string;
  /** `YYYY-MM`, validated at the API (from ≤ to, at most 12 months). */
  readonly from: string;
  readonly to: string;
}) => Promise<{ readonly from: string; readonly to: string; readonly items: readonly RentPaymentReconciliation[]; readonly skipped: SkippedInflows }>;

/**
 * §37.3's suggest: MRE's months (the window and its two neighbours) outside any transaction, then DE's snapshot, the
 * rule, and the write re-checking each pair. MRE down is MreUnavailableError and nothing is written.
 */
export function suggestReconciliations(deps: {
  readonly repository: RentReconciliationRepository;
  readonly readMreMonth: MreMonthReader;
}): SuggestReconciliations {
  return async ({ principal, authorizationHeader, from, to }) => {
    const first = monthIndex(from);
    const last = monthIndex(to);
    const months: { readonly index: number; readonly rents: readonly MreMonthRentView[] }[] = [];
    for (let i = first - 1; i <= last + 1; i++) {
      const { year, month } = fromIndex(i);
      months.push({ index: i, rents: await deps.readMreMonth(authorizationHeader, principal.mreRealmId, year, month) });
    }
    const rents = months.flatMap((m) => m.rents.map((r) => ({ ...r, inWindow: m.index >= first && m.index <= last })));
    // Candidates booked within the booking windows of every term read, the neighbours' included.
    const snapshot = await deps.repository.suggestionSnapshot(
      principal.mreRealmId,
      rents.map((r) => ({ mreTenantId: r.mreTenantId, mreRentTerm: r.term })),
      bookingWindow(termOfMonth(first - 1)).from,
      bookingWindow(termOfMonth(last + 1)).to,
      // §37.6: the window's own booking range, the neighbours left out.
      { from: bookingWindow(termOfMonth(first)).from, to: bookingWindow(termOfMonth(last)).to },
    );
    const terms: SuggestionTerm[] = rents.map((r) => ({
      mreTenantId: r.mreTenantId,
      mreRentTerm: r.term,
      openAmount: r.amountDue.subtract(snapshot.confirmedByTerm.get(`${r.mreTenantId}/${r.term}`) ?? Money.zero('EUR')),
      inWindow: r.inWindow,
    }));
    const suggestions = suggestPairs({ terms, candidates: snapshot.candidates, handled: snapshot.handled, open: snapshot.open, history: snapshot.history });
    const items = await deps.repository.writeSuggestions(principal.mreRealmId, suggestions, actorOf(principal));
    return { from, to, items, skipped: snapshot.skipped };
  };
}

export type ConfirmReconciliation = (input: {
  readonly principal: RealmPrincipal;
  readonly authorizationHeader: string;
  readonly reconciliationId: string;
  readonly matchedAmount?: Money;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly reconciliation: RentPaymentReconciliation; readonly changed: boolean }>;

function confirmRefusal(outcome: Exclude<ConfirmPrecheck, { kind: 'PROCEED' | 'UNCHANGED' }>, reconciliationId: string, transactionId: string): Error {
  switch (outcome.kind) {
    case 'NOT_FOUND':
      return new ReconciliationNotFoundError(reconciliationId);
    case 'NOT_CONFIRMABLE':
      return new NotConfirmableError(outcome.status);
    case 'ABOVE_SUGGESTION':
      return new AboveSuggestionError(outcome.suggested);
    default:
      return refusal(outcome, transactionId);
  }
}

/** §37.3's confirm: DE's checks, the live MRE read outside any transaction, then the checks again under the locks. */
export function confirmReconciliation(deps: {
  readonly repository: RentReconciliationRepository;
  readonly readMreRentTerm: MreRentTermReader;
}): ConfirmReconciliation {
  return async ({ principal, authorizationHeader, reconciliationId, matchedAmount, expectedVersions }) => {
    const pre = await deps.repository.confirmPrecheck(reconciliationId, principal.mreRealmId, matchedAmount);
    if (pre.kind === 'UNCHANGED') return { reconciliation: pre.reconciliation, changed: false };
    if (pre.kind !== 'PROCEED') throw confirmRefusal(pre, reconciliationId, '');
    const { reconciliation } = pre;
    const term = await deps.readMreRentTerm(authorizationHeader, principal.mreRealmId, reconciliation.mreTenantId, reconciliation.mreRentTerm);
    if (term === undefined) throw new MreRentTermNotFoundError(reconciliation.mreTenantId, reconciliation.mreRentTerm);
    const outcome = await deps.repository.confirm(reconciliationId, principal.mreRealmId, matchedAmount, term.amountDue, actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'CONFIRMED':
        return { reconciliation: outcome.reconciliation, changed: outcome.changed };
      case 'SUGGESTION_STALE':
        throw new SuggestionStaleError(outcome.openAmount);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
      default:
        throw confirmRefusal(outcome, reconciliationId, reconciliation.transactionId);
    }
  };
}

export type RejectReconciliation = (input: {
  readonly principal: RealmPrincipal;
  readonly reconciliationId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly reconciliation: RentPaymentReconciliation; readonly changed: boolean }>;

/** §37.3's reject: final; the pair is never suggested again. */
export function rejectReconciliation(deps: { readonly repository: RentReconciliationRepository; readonly now?: () => Date }): RejectReconciliation {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, reconciliationId, reason, expectedVersions }) => {
    const outcome = await deps.repository.reject(reconciliationId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'REJECTED':
        return { reconciliation: outcome.reconciliation, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new ReconciliationNotFoundError(reconciliationId);
      case 'NOT_REJECTABLE':
        throw new NotRejectableError(outcome.status);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}
