import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  STATEMENT_STATUSES,
  formatShare,
  type CreateBalanceStatement,
  type GetLoanPayments,
  type GetRemainingDebt,
  type ListBalanceStatements,
  type RemainingDebt,
  type RemainingDebtPerProperty,
  type StatementView,
  type VoidBalanceStatement,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { eurCents, signedEurCents } from './cents.js';
import { businessDate, optionalText, readId } from './acquisitions.js';
import { fieldErrors, money, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const perProperty = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

const debtQuery = z.object({ asOf: businessDate.optional(), perProperty }).strict();

const paymentsQuery = z
  .object({
    year: z.string().transform((value, ctx) => {
      const year = /^\d{4}$/.test(value) ? Number(value) : undefined;
      if (year !== undefined && year >= 2000 && year <= 2100) return year;
      ctx.addIssue({ code: 'custom', params: { code: year === undefined ? 'INVALID_FORMAT' : 'OUT_OF_RANGE' } });
      return z.NEVER;
    }),
    perProperty,
  })
  .strict();

const createBody = z
  .object({
    statementDate: businessDate,
    // `money` refuses a negative amount (NEGATIVE_AMOUNT); 0.00 is a valid balance.
    balance: money,
    source: z.string().trim().min(1).max(200),
    notes: optionalText(2000).nullish(),
  })
  .strict();

const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const listQuery = z.object({ status: z.enum(STATEMENT_STATUSES).optional() }).strict();

export interface LoanDebtCommands {
  readonly remainingDebt: GetRemainingDebt;
  readonly payments: GetLoanPayments;
  readonly createStatement: CreateBalanceStatement;
  readonly voidStatement: VoidBalanceStatement;
  readonly listStatements: ListBalanceStatements;
}

/** Remaining debt, payments and lender statements (api-design.md §41.6, backlog VC-3-06). */
export function loanDebtRoutes(commands: LoanDebtCommands): Router {
  const router = express.Router();

  router.get('/loans/:loanId/remaining-debt', (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const parsed = debtQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { asOf } = parsed.data;
    commands
      .remainingDebt({ principal: principalOf(res), loanId, perProperty: parsed.data.perProperty ?? false, ...(asOf === undefined ? {} : { asOf }) })
      .then((debt) => res.json(toDebtDto(loanId, debt)))
      .catch(next);
  });

  router.get('/loans/:loanId/payments', (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const parsed = paymentsQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .payments({ principal: principalOf(res), loanId, year: parsed.data.year, perProperty: parsed.data.perProperty ?? false })
      .then((p) =>
        res.json({
          loanId,
          year: p.year,
          interest: eurCents(p.interest),
          principal: eurCents(p.principal),
          payments: p.payments,
          ...(p.items === undefined
            ? {}
            : {
                items: p.items.map((i) => ({ propertyReferenceId: i.propertyReferenceId, interest: eurCents(i.interest), principal: eurCents(i.principal) })),
              }),
        }),
      )
      .catch(next);
  });

  router.post('/loans/:loanId/balance-statements', express.json({ limit: '16kb' }), (req, res, next) => {
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
      .createStatement({
        principal: principalOf(res),
        loanId,
        statementDate: body.statementDate,
        balance: body.balance,
        source: body.source,
        notes: body.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ statement, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendStatement(res.status(201), statement);
      })
      .catch(next);
  });

  router.post('/loans/:loanId/balance-statements/:statementId/void', express.json({ limit: '16kb' }), (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const statementId = readId(req.params['statementId'], 'statementId', res);
    if (statementId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = voidBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .voidStatement({
        principal: principalOf(res),
        loanId,
        statementId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ statement }) => sendStatement(res, statement))
      .catch(next);
  });

  router.get('/loans/:loanId/balance-statements', (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .listStatements({ principal: principalOf(res), loanId, ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }) })
      .then((items) => res.json({ items: items.map(toStatementDto) }))
      .catch(next);
  });

  return router;
}

/** Signed cents as Money (an actual remaining debt or a difference may be negative). */
const signedOrNull = (cents: bigint | null) => (cents === null ? null : signedEurCents(cents));

function toDebtDto(loanId: string, d: RemainingDebt | RemainingDebtPerProperty) {
  return {
    loanId,
    asOf: d.asOf,
    debtFrom: d.debtFrom,
    principalOriginal: d.principalOriginal.toJSON(),
    principalPaid: signedEurCents(d.principalPaid),
    actual: signedEurCents(d.actual),
    planned: signedOrNull(d.planned),
    difference: signedOrNull(d.difference),
    planEndReason: d.planEndReason,
    latestStatement: d.latestStatement === null ? null : toStatementDto(d.latestStatement),
    closing:
      d.closing === null
        ? null
        : {
            closingDate: d.closing.closingDate,
            reason: d.closing.reason,
            refinancedByLoanId: d.closing.refinancedByLoanId,
            actualOnClosingDate: signedEurCents(d.closing.actualOnClosingDate),
          },
    ...('items' in d
      ? {
          allocationSetId: d.allocationSetId,
          items: d.items.map((i) => ({
            propertyReferenceId: i.propertyReferenceId,
            share: formatShare(i.share),
            actual: signedEurCents(i.actual),
            planned: signedOrNull(i.planned),
            difference: signedOrNull(i.difference),
          })),
        }
      : {}),
  };
}

function sendStatement(res: Response, statement: StatementView): void {
  res.setHeader('ETag', `"${statement.version}"`);
  res.json(toStatementDto(statement));
}

function toStatementDto(s: StatementView) {
  return {
    statementId: s.id,
    loanId: s.loanId,
    status: s.status,
    statementDate: s.statementDate,
    balance: s.balance.toJSON(),
    source: s.source,
    notes: s.notes,
    voidedAt: s.voidedAt?.toISOString() ?? null,
    voidReason: s.voidReason,
    createdAt: s.createdAt.toISOString(),
    version: s.version,
    comparison: { actualOnDate: signedEurCents(s.comparison.actualOnDate), difference: signedEurCents(s.comparison.difference) },
  };
}
