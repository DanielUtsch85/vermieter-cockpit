import {
  proposePayment,
  scheduleOf,
  scheduleWindow,
  termsFingerprint,
  type PaymentProposal,
  type Schedule,
  type ScheduleEndReason,
  type AppendRefusal,
  type LoanTermsData,
  type LoanTermsRepository,
  type LoanTermsView,
  type TermsStatus,
} from '../domains/financing/index.js';
import type { BusinessDate } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { LoanNotActiveError, LoanNotFoundError } from './loans.js';

/**
 * Loan terms commands and reads (api-design.md §41.2, backlog VC-3-02), in the caller's verified Realm. Input arrives
 * validated and normalized from the API boundary (rates parsed, the payment matching the model, dates in order).
 */

/** A rule of §41.2 refuses the period (→ 422 with the refusal's code and details). */
export class TermsRefusedError extends Error {
  override readonly name = 'TermsRefusedError';

  constructor(readonly refusal: Exclude<AppendRefusal, { kind: 'LOAN_NOT_ACTIVE' }>) {
    super(refusal.kind);
  }
}

export class LoanTermsNotFoundError extends Error {
  override readonly name = 'LoanTermsNotFoundError';

  constructor(readonly termsId: string) {
    super(`LoanTerms ${termsId} not found`);
  }
}

/** Only the last `VALID` period is voidable (→ 409 TERMS_NOT_LAST). */
export class TermsNotLastError extends Error {
  override readonly name = 'TermsNotLastError';

  constructor(
    readonly termsId: string,
    readonly laterTermsId: string,
  ) {
    super(`LoanTerms ${termsId} is followed by ${laterTermsId}`);
  }
}

const actorOf = (principal: RealmPrincipal) => ({ actorType: 'USER', actorId: principal.email }) as const;

export interface CreateLoanTermsInput extends LoanTermsData {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly idempotencyKey?: string;
}

export type CreateLoanTerms = (input: CreateLoanTermsInput) => Promise<{ readonly terms: LoanTermsView; readonly replayed: boolean }>;

export function createLoanTerms(deps: { readonly repository: LoanTermsRepository }): CreateLoanTerms {
  return async ({ principal, loanId, idempotencyKey, ...terms }) => {
    const outcome = await deps.repository.create(
      loanId,
      principal.mreRealmId,
      terms,
      actorOf(principal),
      idempotencyKey === undefined ? undefined : { key: idempotencyKey, fingerprint: termsFingerprint(loanId, terms) },
    );
    switch (outcome.kind) {
      case 'CREATED':
        return { terms: outcome.terms, replayed: false };
      case 'REPLAYED':
        return { terms: outcome.terms, replayed: true };
      case 'IDEMPOTENCY_CONFLICT':
        throw new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload');
      case 'LOAN_NOT_FOUND':
        throw new LoanNotFoundError(loanId);
      case 'LOAN_NOT_ACTIVE':
        throw new LoanNotActiveError(loanId, outcome.status);
      default:
        throw new TermsRefusedError(outcome);
    }
  };
}

export type VoidLoanTerms = (input: {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly termsId: string;
  readonly reason: string;
  readonly expectedVersions?: readonly number[];
}) => Promise<{ readonly terms: LoanTermsView; readonly changed: boolean }>;

export function voidLoanTerms(deps: { readonly repository: LoanTermsRepository; readonly now?: () => Date }): VoidLoanTerms {
  const now = deps.now ?? (() => new Date());
  return async ({ principal, loanId, termsId, reason, expectedVersions }) => {
    const outcome = await deps.repository.void(loanId, termsId, principal.mreRealmId, reason, now(), actorOf(principal), expectedVersions);
    switch (outcome.kind) {
      case 'VOIDED':
        return { terms: outcome.terms, changed: outcome.changed };
      case 'NOT_FOUND':
        throw new LoanTermsNotFoundError(termsId);
      case 'LOAN_NOT_ACTIVE':
        throw new LoanNotActiveError(loanId, outcome.status);
      case 'TERMS_NOT_LAST':
        throw new TermsNotLastError(termsId, outcome.laterTermsId);
      case 'VERSION_CONFLICT':
        throw new VersionConflictError(outcome.expectedVersions, outcome.currentVersion);
    }
  };
}

export type ListLoanTerms = (input: { readonly principal: RealmPrincipal; readonly loanId: string; readonly status?: TermsStatus }) => Promise<readonly LoanTermsView[]>;

export function listLoanTerms(deps: { readonly repository: LoanTermsRepository }): ListLoanTerms {
  return async ({ principal, loanId, status }) => {
    const items = await deps.repository.list(loanId, principal.mreRealmId, status);
    if (items === undefined) throw new LoanNotFoundError(loanId);
    return items;
  };
}

/** The Loan's derived plan (api-design §41.4), the entries limited to `[from, to]`; the summary covers the whole plan. */
export type GetLoanSchedule = (input: {
  readonly principal: RealmPrincipal;
  readonly loanId: string;
  readonly from?: BusinessDate;
  readonly to?: BusinessDate;
}) => Promise<Schedule>;

export function getLoanSchedule(deps: { readonly repository: LoanTermsRepository }): GetLoanSchedule {
  return async ({ principal, loanId, from, to }) => {
    const inputs = await deps.repository.scheduleInputs(loanId, principal.mreRealmId);
    if (inputs === undefined) throw new LoanNotFoundError(loanId);
    return scheduleWindow(scheduleOf(inputs.loan.principalOriginal, inputs.loan.maturityDate, inputs.periods), from, to);
  };
}

/** The Transaction is not an unconfirmed `OUTFLOW` (→ 409 NOT_PROPOSABLE, §41.5). */
export class PaymentNotProposableError extends Error {
  override readonly name = 'PaymentNotProposableError';

  constructor(
    readonly transactionId: string,
    readonly direction: string,
    readonly status: string,
  ) {
    super(`Transaction ${transactionId} is ${direction} and ${status}; no payment is proposed`);
  }
}

/** The Loan's plan has no payments (→ 409 NO_SCHEDULE, §41.5). */
export class NoScheduleError extends Error {
  override readonly name = 'NoScheduleError';

  constructor(
    readonly loanId: string,
    readonly endReason: ScheduleEndReason,
  ) {
    super(`Loan ${loanId} has no planned payment (${endReason})`);
  }
}

/** The Transaction is unknown or of another Realm (→ 404 with `details.transactionId`). */
export class ProposalTransactionNotFoundError extends Error {
  override readonly name = 'ProposalTransactionNotFoundError';

  constructor(readonly transactionId: string) {
    super(`Transaction ${transactionId} not found`);
  }
}

export type PaymentProposalResult = Extract<PaymentProposal, { kind: 'PROPOSAL' }> & {
  readonly loanId: string;
  readonly transactionId: string;
  readonly bookingDate: BusinessDate;
  readonly amount: bigint;
};

/** §41.5's proposal: a read, never a write; the client applies it through the splits command. */
export type GetPaymentProposal = (input: { readonly principal: RealmPrincipal; readonly loanId: string; readonly transactionId: string }) => Promise<PaymentProposalResult>;

export function getPaymentProposal(deps: { readonly repository: LoanTermsRepository }): GetPaymentProposal {
  return async ({ principal, loanId, transactionId }) => {
    const inputs = await deps.repository.proposalInputs(loanId, transactionId, principal.mreRealmId);
    if (inputs.kind === 'LOAN_NOT_FOUND') throw new LoanNotFoundError(loanId);
    if (inputs.kind === 'TRANSACTION_NOT_FOUND') throw new ProposalTransactionNotFoundError(transactionId);
    const { loan, periods, transaction } = inputs;
    if (loan.status === 'VOID') throw new LoanNotActiveError(loanId, loan.status);
    const models = new Map(periods.map((p) => [p.id as string, p.repaymentModel]));
    const proposal = proposePayment(scheduleOf(loan.principalOriginal, loan.maturityDate, periods), transaction, (id) => models.get(id) ?? 'ANNUITY');
    if (proposal.kind === 'NOT_PROPOSABLE') throw new PaymentNotProposableError(transactionId, proposal.direction, proposal.status);
    if (proposal.kind === 'NO_SCHEDULE') throw new NoScheduleError(loanId, proposal.endReason);
    return { ...proposal, loanId, transactionId: transaction.id, bookingDate: transaction.bookingDate, amount: transaction.amount };
  };
}
