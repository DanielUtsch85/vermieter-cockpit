import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  IdempotencyKeyConflictError,
  LoanClosedOnError,
  LoanNotActiveError,
  LoanNotFoundError,
  LoanTermsNotFoundError,
  NoScheduleError,
  PaymentNotProposableError,
  ProposalTransactionNotFoundError,
  REPAYMENT_MODELS,
  TERMS_STATUSES,
  TermsNotLastError,
  TermsRefusedError,
  VersionConflictError,
  formatRate,
  parseRate,
  type CreateLoanTerms,
  type GetLoanSchedule,
  type GetPaymentProposal,
  type PaymentProposalResult,
  type ListLoanTerms,
  type LoanTermsView,
  type NumberedScheduleEntry,
  type Schedule,
  type VoidLoanTerms,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, optionalText, readId } from './acquisitions.js';
import { sendError } from './errors.js';
import { RESOURCE_ID, fieldErrors, money, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

/** Percent p.a. as a decimal string, at most three decimals, `0 ≤ r < 100`; a JSON number is refused (no float in transit). */
const rate = z.string().transform((value, ctx) => {
  const parsed = parseRate(value);
  if (parsed !== undefined) return parsed;
  ctx.addIssue({ code: 'custom', params: { code: /^\d+(\.\d{1,3})?$/.test(value) ? 'OUT_OF_RANGE' : 'INVALID_FORMAT' } });
  return z.NEVER;
});

const createBody = z
  .object({
    validFrom: businessDate,
    interestRate: rate,
    repaymentModel: z.enum(REPAYMENT_MODELS),
    scheduledPayment: money.optional(),
    firstPaymentDate: businessDate,
    principalAtStart: money.optional(),
    fixedRateUntil: businessDate.nullish(),
    initialRepaymentRate: rate.nullish(),
    specialRepaymentLimit: money.nullish(),
    notes: optionalText(2000).nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // Refinements run even after a field failed to parse: only check what parsed.
    if (body.repaymentModel === 'ANNUITY' && body.scheduledPayment === undefined) {
      ctx.addIssue({ code: 'custom', path: ['scheduledPayment'], params: { code: 'REQUIRED' } });
    }
    if (body.repaymentModel === 'INTEREST_ONLY' && body.scheduledPayment !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['scheduledPayment'], params: { code: 'NOT_ALLOWED_FOR_MODEL' } });
    }
    for (const field of ['scheduledPayment', 'principalAtStart'] as const) {
      const amount = body[field];
      if (amount instanceof Money && !amount.isPositive()) ctx.addIssue({ code: 'custom', path: [field, 'amount'], params: { code: 'NOT_POSITIVE' } });
    }
    for (const field of ['firstPaymentDate', 'fixedRateUntil'] as const) {
      const date = body[field];
      if (typeof date === 'string' && typeof body.validFrom === 'string' && date < body.validFrom) {
        ctx.addIssue({ code: 'custom', path: [field], params: { code: 'BEFORE_VALID_FROM' } });
      }
    }
  });

const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const listQuery = z.object({ status: z.enum(TERMS_STATUSES).optional() }).strict();

const proposalQuery = z.object({ transactionId: z.string().regex(RESOURCE_ID).transform((id) => id.toLowerCase()) }).strict();

const scheduleQuery = z
  .object({ from: businessDate.optional(), to: businessDate.optional() })
  .strict()
  .refine((query) => typeof query.from !== 'string' || typeof query.to !== 'string' || query.from <= query.to, { path: ['to'], params: { code: 'BEFORE_FROM' } });

export interface LoanTermsCommands {
  readonly create: CreateLoanTerms;
  readonly void: VoidLoanTerms;
  readonly list: ListLoanTerms;
  readonly schedule: GetLoanSchedule;
  readonly proposal: GetPaymentProposal;
}

/** Loan terms (api-design.md §41.2, backlog VC-3-02) and the schedule derived from them (§41.4, VC-3-04). */
export function loanTermsRoutes(commands: LoanTermsCommands): Router {
  const router = express.Router();
  const fail = (res: Response, next: (error: unknown) => void) => (error: unknown) => {
    if (!sendTermsError(res, error)) next(error);
  };

  router.post('/loans/:loanId/terms', express.json({ limit: '16kb' }), (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    commands
      .create({
        principal: principalOf(res),
        loanId,
        validFrom: body.validFrom,
        interestRate: body.interestRate,
        repaymentModel: body.repaymentModel,
        scheduledPayment: body.scheduledPayment ?? null,
        firstPaymentDate: body.firstPaymentDate,
        principalAtStart: body.principalAtStart ?? null,
        fixedRateUntil: body.fixedRateUntil ?? null,
        initialRepaymentRate: body.initialRepaymentRate ?? null,
        specialRepaymentLimit: body.specialRepaymentLimit ?? null,
        notes: body.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ terms, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendTerms(res.status(201), terms);
      })
      .catch(fail(res, next));
  });

  router.post('/loans/:loanId/terms/:termsId/void', express.json({ limit: '16kb' }), (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const termsId = readId(req.params['termsId'], 'termsId', res);
    if (termsId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = voidBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .void({
        principal: principalOf(res),
        loanId,
        termsId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ terms }) => sendTerms(res, terms))
      .catch(fail(res, next));
  });

  router.get('/loans/:loanId/terms', (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .list({ principal: principalOf(res), loanId, ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }) })
      .then((items) => res.json({ items: items.map(toDto) }))
      .catch(fail(res, next));
  });

  router.get('/loans/:loanId/schedule', (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const parsed = scheduleQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { from, to } = parsed.data;
    commands
      .schedule({ principal: principalOf(res), loanId, ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) })
      .then((schedule) => res.json(toScheduleDto(loanId, from ?? null, to ?? null, schedule)))
      .catch(fail(res, next));
  });

  router.get('/loans/:loanId/payment-proposal', (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const parsed = proposalQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .proposal({ principal: principalOf(res), loanId, transactionId: parsed.data.transactionId })
      .then((proposal) => res.json(toProposalDto(proposal)))
      .catch(fail(res, next));
  });

  return router;
}

/** Signed cents as Money (a difference may be negative). */
const signedEurCents = (cents: bigint) => (cents < 0n ? { amount: `-${eurCents(-cents).amount}`, currency: 'EUR' } : eurCents(cents));

function toProposalDto(p: PaymentProposalResult) {
  const splits = [
    { financialCategoryCode: 'LOAN_INTEREST', amount: p.interest },
    { financialCategoryCode: 'LOAN_PRINCIPAL', amount: p.principal },
  ].filter((s) => s.amount > 0n);
  return {
    loanId: p.loanId,
    transactionId: p.transactionId,
    bookingDate: p.bookingDate,
    amount: eurCents(p.amount),
    scheduleEntry: {
      number: p.entry.number,
      paymentDate: p.entry.paymentDate,
      termsId: p.entry.termsId,
      interest: eurCents(p.entry.interest),
      principal: eurCents(p.entry.principal),
      payment: eurCents(p.entry.payment),
      balanceBefore: eurCents(p.entry.balanceBefore),
    },
    splits: splits.map((s) => ({ financialCategoryCode: s.financialCategoryCode, loanId: p.loanId, amount: eurCents(s.amount) })),
    unallocated: eurCents(p.unallocated),
    flags: p.flags.map((f) => (f.code === 'AMOUNT_DIFFERS_FROM_SCHEDULE' ? { code: f.code, details: { difference: signedEurCents(f.difference) } } : { code: f.code })),
  };
}

function toScheduleDto(loanId: string, from: string | null, to: string | null, { entries, summary }: Schedule) {
  const entry = (e: NumberedScheduleEntry) => ({
    number: e.number,
    paymentDate: e.paymentDate,
    termsId: e.termsId,
    balanceBefore: eurCents(e.balanceBefore),
    interest: eurCents(e.interest),
    principal: eurCents(e.principal),
    payment: eurCents(e.payment),
    balanceAfter: eurCents(e.balanceAfter),
  });
  return {
    loanId,
    from,
    to,
    items: entries.map(entry),
    summary: {
      payments: summary.payments,
      firstPaymentDate: summary.firstPaymentDate,
      lastPaymentDate: summary.lastPaymentDate,
      totalInterest: eurCents(summary.totalInterest),
      totalPrincipal: eurCents(summary.totalPrincipal),
      balanceDue: eurCents(summary.balanceDue),
      endReason: summary.endReason,
    },
  };
}

function sendTerms(res: Response, terms: LoanTermsView): void {
  res.setHeader('ETag', `"${terms.version}"`);
  res.json(toDto(terms));
}

const eurCents = (cents: bigint) => ({ amount: `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`, currency: 'EUR' });

/** The refusals of §41.2; false for anything else (→ the error handler). */
function sendTermsError(res: Response, error: unknown): boolean {
  if (error instanceof LoanNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Loan not found.', { loanId: error.loanId });
  } else if (error instanceof ProposalTransactionNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId });
  } else if (error instanceof PaymentNotProposableError) {
    sendError(res, 409, 'CONFLICT', 'Only an unconfirmed OUTFLOW gets a payment proposal.', { reason: 'NOT_PROPOSABLE', direction: error.direction, status: error.status });
  } else if (error instanceof LoanClosedOnError) {
    sendError(res, 409, 'CONFLICT', `The Loan was closed on ${error.closingDate}.`, { reason: 'LOAN_CLOSED', closingDate: error.closingDate });
  } else if (error instanceof NoScheduleError) {
    sendError(res, 409, 'CONFLICT', 'The Loan has no planned payment.', { reason: 'NO_SCHEDULE', endReason: error.endReason });
  } else if (error instanceof LoanTermsNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Loan terms not found.', { termsId: error.termsId });
  } else if (error instanceof LoanNotActiveError) {
    sendError(res, 409, 'CONFLICT', `The Loan is ${error.status}; its terms cannot change.`, { reason: 'LOAN_NOT_ACTIVE', status: error.status });
  } else if (error instanceof TermsNotLastError) {
    sendError(res, 409, 'CONFLICT', 'Only the last period is voided.', { reason: 'TERMS_NOT_LAST', laterTermsId: error.laterTermsId });
  } else if (error instanceof TermsRefusedError) {
    const r = error.refusal;
    const details =
      r.kind === 'TERMS_BEFORE_DEBT'
        ? { debtFrom: r.debtFrom }
        : r.kind === 'TERMS_NOT_APPENDED'
          ? { lastValidFrom: r.lastValidFrom }
          : r.kind === 'PREVIOUS_TERMS_WITHOUT_PAYMENT'
            ? { termsId: r.termsId, firstPaymentDate: r.firstPaymentDate }
            : r.kind === 'PRINCIPAL_AT_START_EXCEEDS_ORIGINAL'
              ? { principalOriginal: r.principalOriginal.toJSON() }
              : r.kind === 'PAYMENT_DOES_NOT_COVER_INTEREST'
                ? { firstInterest: eurCents(r.firstInterest), balance: eurCents(r.balance) }
                : undefined;
    sendError(res, 422, r.kind, 'The period cannot be appended.', details);
  } else if (error instanceof VersionConflictError) {
    sendError(res, 412, 'VERSION_CONFLICT', 'The period changed since the version given in If-Match.', {
      expectedVersions: error.expectedVersions,
      currentVersion: error.currentVersion,
    });
  } else if (error instanceof IdempotencyKeyConflictError) {
    sendError(res, 409, 'CONFLICT', 'Idempotency-Key was already used with a different payload.');
  } else {
    return false;
  }
  return true;
}

function toDto(t: LoanTermsView) {
  return {
    termsId: t.id,
    loanId: t.loanId,
    status: t.status,
    validFrom: t.validFrom,
    validUntil: t.validUntil,
    interestRate: formatRate(t.interestRate),
    repaymentModel: t.repaymentModel,
    scheduledPayment: t.scheduledPayment?.toJSON() ?? null,
    firstPaymentDate: t.firstPaymentDate,
    principalAtStart: t.principalAtStart?.toJSON() ?? null,
    fixedRateUntil: t.fixedRateUntil,
    initialRepaymentRate: t.initialRepaymentRate === null ? null : formatRate(t.initialRepaymentRate),
    specialRepaymentLimit: t.specialRepaymentLimit?.toJSON() ?? null,
    notes: t.notes,
    voidedAt: t.voidedAt?.toISOString() ?? null,
    voidReason: t.voidReason,
    createdAt: t.createdAt.toISOString(),
    version: t.version,
  };
}
