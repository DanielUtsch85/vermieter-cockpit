import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  REPAYMENT_MODELS,
  TERMS_STATUSES,
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
import { eurCents, signedEurCents } from './cents.js';
import { businessDate, optionalText, readId } from './acquisitions.js';
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

const proposalQuery = z
  .object({
    transactionId: z
      .string()
      .regex(RESOURCE_ID)
      .transform((id) => id.toLowerCase()),
  })
  .strict();

const scheduleQuery = z
  .object({ from: businessDate.optional(), to: businessDate.optional() })
  .strict()
  .refine((query) => typeof query.from !== 'string' || typeof query.to !== 'string' || query.from <= query.to, {
    path: ['to'],
    params: { code: 'BEFORE_FROM' },
  });

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
      .catch(next);
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
      .catch(next);
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
      .catch(next);
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
      .catch(next);
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
      .catch(next);
  });

  return router;
}

/** Signed cents as Money (a difference may be negative). */

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
    flags: p.flags.map((f) =>
      f.code === 'AMOUNT_DIFFERS_FROM_SCHEDULE' ? { code: f.code, details: { difference: signedEurCents(f.difference) } } : { code: f.code },
    ),
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
