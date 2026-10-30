import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  ANNUAL_STATEMENT_STATUSES,
  CLASSIFICATIONS,
  COST_GROUPS,
  RESERVE_LINE_KINDS,
  RESERVE_SOURCES,
  compareQuantities,
  normalizeQuantity,
  type AnnualStatementView,
  type ConfirmAnnualStatement,
  type CreateAnnualStatement,
  type GetAnnualStatement,
  type GetSettlementProposal,
  type GetStatementComparison,
  type ListAnnualStatements,
  type ReplaceAnnualStatement,
  type SettlementProposal,
  type StatementComparison,
  type StatementContent,
  type VoidAnnualStatement,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, definedOnly, optionalText, readId } from './acquisitions.js';
import { RESOURCE_ID, fieldErrors, readIdempotencyKey, readIfMatch, sendValidationError, signedMoney } from './validation.js';

const uuid = z
  .string()
  .regex(RESOURCE_ID)
  .transform((id) => id.toLowerCase());

/** An allocation quantity as printed: a decimal string with at most 12 integer digits and 3 decimals (§50). */
const quantity = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,3})?$/)
  .transform(normalizeQuantity);

const costLine = z
  .object({
    position: z.number().int().min(1).max(1000),
    account: z.string().trim().min(1).max(200),
    group: z.enum(COST_GROUPS),
    allocationKey: z.string().trim().min(1).max(100),
    allocationTotal: quantity.nullish(),
    allocationShare: quantity.nullish(),
    totalAmount: signedMoney,
    unitShare: signedMoney,
    classification: z.enum(CLASSIFICATIONS).nullish(),
  })
  .strict()
  .superRefine((line, ctx) => {
    if (
      typeof line.allocationTotal === 'string' &&
      typeof line.allocationShare === 'string' &&
      compareQuantities(line.allocationShare, line.allocationTotal) > 0
    ) {
      ctx.addIssue({ code: 'custom', path: ['allocationShare'], params: { code: 'OUT_OF_RANGE' } });
    }
  });

const reserveLine = z
  .object({
    position: z.number().int().min(1).max(1000),
    description: z.string().trim().min(1).max(200),
    kind: z.enum(RESERVE_LINE_KINDS),
    opening: signedMoney.nullish(),
    addition: signedMoney.nullish(),
    withdrawal: signedMoney.nullish(),
    closing: signedMoney.nullish(),
  })
  .strict();

const reserveSection = z
  .object({
    source: z.enum(RESERVE_SOURCES),
    lines: z.array(reserveLine).max(20),
    unitShareOpening: signedMoney.nullish(),
    unitShareClosing: signedMoney.nullish(),
  })
  .strict();

const statementBody = z
  .object({
    financialYear: z.number().int().min(1900).max(2200),
    periodFrom: businessDate,
    periodUntil: businessDate,
    documentDate: businessDate.nullish(),
    resolutionDate: businessDate.nullish(),
    dueDate: businessDate.nullish(),
    supersedes: uuid.nullish(),
    costLines: z.array(costLine).min(1).max(200),
    recoverableSubtotal: signedMoney,
    nonRecoverableSubtotal: signedMoney,
    totalCosts: signedMoney,
    hausgeldRequested: signedMoney,
    hausgeldPaid: signedMoney,
    reserveRequested: signedMoney.nullish(),
    reservePaid: signedMoney.nullish(),
    settlementPeak: signedMoney,
    settlementResult: signedMoney.nullish(),
    reserve: reserveSection.nullish(),
    sourceReferences: z.array(optionalText(500)).max(10).optional(),
    notes: optionalText(2000).nullish(),
    documentId: z.unknown().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.documentId !== undefined) ctx.addIssue({ code: 'custom', path: ['documentId'], params: { code: 'NOT_SUPPORTED' } });
    // Refinements run even after a field failed to parse: only check what parsed.
    if (typeof body.periodFrom === 'string' && typeof body.periodUntil === 'string' && body.periodUntil < body.periodFrom) {
      ctx.addIssue({ code: 'custom', path: ['periodUntil'], params: { code: 'INVALID_RANGE' } });
    }
    const duplicates = (path: 'costLines' | 'reserve', lines: readonly { readonly position: number }[] | undefined) =>
      (lines ?? []).forEach((line, i, all) => {
        if (all.findIndex((other) => other.position === line.position) !== i) {
          ctx.addIssue({
            code: 'custom',
            path: path === 'costLines' ? ['costLines', i, 'position'] : ['reserve', 'lines', i, 'position'],
            params: { code: 'DUPLICATE' },
          });
        }
      });
    duplicates('costLines', Array.isArray(body.costLines) ? body.costLines : undefined);
    duplicates('reserve', Array.isArray(body.reserve?.lines) ? body.reserve.lines : undefined);
  });

type StatementBody = z.infer<typeof statementBody>;

const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const listQuery = z
  .object({
    status: z
      .string()
      .transform((value) => value.split(','))
      .pipe(z.array(z.enum(ANNUAL_STATEMENT_STATUSES)).min(1))
      .optional(),
    financialYear: z.coerce.number().int().min(1900).max(2200).optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/** The validated body as the content of create and replace; absent optionals are null. */
function contentOf(body: StatementBody): StatementContent {
  return {
    financialYear: body.financialYear,
    periodFrom: body.periodFrom,
    periodUntil: body.periodUntil,
    documentDate: body.documentDate ?? null,
    resolutionDate: body.resolutionDate ?? null,
    dueDate: body.dueDate ?? null,
    supersedes: body.supersedes ?? null,
    costLines: body.costLines.map((line) => ({
      position: line.position,
      account: line.account,
      group: line.group,
      allocationKey: line.allocationKey,
      allocationTotal: line.allocationTotal ?? null,
      allocationShare: line.allocationShare ?? null,
      totalAmount: line.totalAmount,
      unitShare: line.unitShare,
      classification: line.classification ?? null,
    })),
    recoverableSubtotal: body.recoverableSubtotal,
    nonRecoverableSubtotal: body.nonRecoverableSubtotal,
    totalCosts: body.totalCosts,
    hausgeldRequested: body.hausgeldRequested,
    hausgeldPaid: body.hausgeldPaid,
    reserveRequested: body.reserveRequested ?? null,
    reservePaid: body.reservePaid ?? null,
    settlementPeak: body.settlementPeak,
    settlementResult: body.settlementResult ?? null,
    reserve:
      body.reserve === undefined || body.reserve === null
        ? null
        : {
            source: body.reserve.source,
            lines: body.reserve.lines.map((l) => ({
              position: l.position,
              description: l.description,
              kind: l.kind,
              opening: l.opening ?? null,
              addition: l.addition ?? null,
              withdrawal: l.withdrawal ?? null,
              closing: l.closing ?? null,
            })),
            unitShareOpening: body.reserve.unitShareOpening ?? null,
            unitShareClosing: body.reserve.unitShareClosing ?? null,
          },
    sourceReferences: (body.sourceReferences ?? []).filter((reference): reference is string => reference !== null),
    notes: body.notes ?? null,
  };
}

export interface WegAnnualStatementCommands {
  readonly create: CreateAnnualStatement;
  readonly get: GetAnnualStatement;
  readonly list: ListAnnualStatements;
  readonly replace: ReplaceAnnualStatement;
  readonly confirm: ConfirmAnnualStatement;
  readonly void: VoidAnnualStatement;
  readonly comparison: GetStatementComparison;
  readonly settlementProposal: GetSettlementProposal;
}

/** Jahresabrechnung API (api-design.md §50, backlog VC-6-03). */
export function wegAnnualStatementRoutes(commands: WegAnnualStatementCommands): Router {
  const router = express.Router();

  router.post('/weg-memberships/:membershipId/annual-statements', express.json({ limit: '256kb' }), (req, res, next) => {
    const membershipId = readId(req.params['membershipId'], 'membershipId', res);
    if (membershipId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = statementBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .create({
        principal: principalOf(res),
        membershipId,
        ...contentOf(parsed.data),
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ statement, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendStatement(res.status(201), statement);
      })
      .catch(next);
  });

  router.get('/weg-memberships/:membershipId/annual-statements', (req, res, next) => {
    const membershipId = readId(req.params['membershipId'], 'membershipId', res);
    if (membershipId === undefined) return;
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { page, pageSize, status, financialYear } = parsed.data;
    commands
      .list({ principal: principalOf(res), membershipId, filter: definedOnly({ statuses: status, financialYear }), page: { page, pageSize } })
      .then((result) =>
        res.json({
          ...result,
          items: result.items.map((statement) => {
            const { costLines: _lines, ...item } = statementDto(statement);
            return item;
          }),
        }),
      )
      .catch(next);
  });

  router.get('/weg-annual-statements/:statementId', (req, res, next) => {
    const statementId = readId(req.params['statementId'], 'statementId', res);
    if (statementId === undefined) return;
    commands
      .get({ principal: principalOf(res), statementId })
      .then((statement) => sendStatement(res, statement))
      .catch(next);
  });

  router.put('/weg-annual-statements/:statementId', express.json({ limit: '256kb' }), (req, res, next) => {
    const statementId = readId(req.params['statementId'], 'statementId', res);
    if (statementId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = statementBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .replace({
        principal: principalOf(res),
        statementId,
        content: contentOf(parsed.data),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ statement }) => sendStatement(res, statement))
      .catch(next);
  });

  router.post('/weg-annual-statements/:statementId/confirm', express.json({ limit: '1kb' }), (req, res, next) => {
    const statementId = readId(req.params['statementId'], 'statementId', res);
    if (statementId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = z.object({}).strict().optional().safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .confirm({ principal: principalOf(res), statementId, ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }) })
      .then(({ statement }) => sendStatement(res, statement))
      .catch(next);
  });

  router.post('/weg-annual-statements/:statementId/void', express.json({ limit: '16kb' }), (req, res, next) => {
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
      .void({
        principal: principalOf(res),
        statementId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ statement }) => sendStatement(res, statement))
      .catch(next);
  });

  router.get('/weg-annual-statements/:statementId/comparison', (req, res, next) => {
    const statementId = readId(req.params['statementId'], 'statementId', res);
    if (statementId === undefined) return;
    commands
      .comparison({ principal: principalOf(res), statementId })
      .then((comparison) => res.json(comparisonDto(comparison)))
      .catch(next);
  });

  router.get('/transactions/:transactionId/settlement-proposal', (req, res, next) => {
    const transactionId = readId(req.params['transactionId'], 'transactionId', res);
    if (transactionId === undefined) return;
    const parsed = settlementQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .settlementProposal({ principal: principalOf(res), transactionId, statementId: parsed.data.statementId })
      .then((proposal) => res.json(settlementDto(proposal)))
      .catch(next);
  });

  return router;
}

const settlementQuery = z.object({ statementId: uuid }).strict();

function comparisonDto(comparison: StatementComparison) {
  const figures = (c: StatementComparison['classes']['RECOVERABLE']) => ({
    paid: c.paid.toJSON(),
    actual: c.actual.toJSON(),
    difference: c.difference.toJSON(),
  });
  return {
    statementId: comparison.statementId,
    membershipId: comparison.membershipId,
    propertyReferenceId: comparison.propertyReferenceId,
    financialYear: comparison.financialYear,
    periodFrom: comparison.periodFrom,
    periodUntil: comparison.periodUntil,
    status: comparison.status,
    classes: {
      RECOVERABLE: figures(comparison.classes.RECOVERABLE),
      NON_RECOVERABLE: figures(comparison.classes.NON_RECOVERABLE),
      RESERVE: figures(comparison.classes.RESERVE),
    },
    advances: {
      requested: comparison.advances.requested.toJSON(),
      counted: comparison.advances.counted.toJSON(),
      unpaidAdvances: comparison.advances.unpaidAdvances.toJSON(),
    },
    settlementPeak: comparison.settlementPeak.toJSON(),
    settlement: {
      settledBy: comparison.settlement.settledBy.map((s) => ({ ...s, amount: s.amount.toJSON() })),
      settled: comparison.settlement.settled.toJSON(),
      open: comparison.settlement.open.toJSON(),
    },
    reserveWithdrawals: comparison.reserveWithdrawals.map((w) => ({ ...w, withdrawal: w.withdrawal.toJSON(), unitShare: w.unitShare.toJSON() })),
    flags: comparison.flags.map((flag) => ({ code: flag.code, details: detailsDto(flag.details) })),
  };
}

function settlementDto(proposal: SettlementProposal) {
  return {
    transactionId: proposal.transactionId,
    statementId: proposal.statementId,
    amount: proposal.amount.toJSON(),
    direction: proposal.direction,
    settlementPeak: proposal.settlementPeak.toJSON(),
    splits: proposal.splits.map((s) => ({
      financialCategoryCode: s.financialCategoryCode,
      propertyReferenceId: s.propertyReferenceId,
      wegAnnualStatementId: s.wegAnnualStatementId,
      amount: s.amount.toJSON(),
    })),
    flags: proposal.flags.map((flag) => ({ code: flag.code, details: detailsDto(flag.details) })),
  };
}

function sendStatement(res: Response, statement: AnnualStatementView): void {
  res.setHeader('ETag', `"${statement.version}"`);
  res.json(statementDto(statement));
}

const json = (m: Money | null) => m?.toJSON() ?? null;

/** Money in details as JSON; everything else as it is. */
const detailsDto = (details: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(details).map(([key, value]) => [key, value instanceof Money ? value.toJSON() : value]));

function statementDto(statement: AnnualStatementView) {
  return {
    statementId: statement.id,
    mreRealmId: statement.mreRealmId,
    membershipId: statement.membershipId,
    financialYear: statement.financialYear,
    periodFrom: statement.periodFrom,
    periodUntil: statement.periodUntil,
    documentDate: statement.documentDate,
    resolutionDate: statement.resolutionDate,
    dueDate: statement.dueDate,
    supersedes: statement.supersedes,
    supersededBy: statement.supersededBy,
    costLines: statement.costLines.map((line) => ({ ...line, totalAmount: line.totalAmount.toJSON(), unitShare: line.unitShare.toJSON() })),
    recoverableSubtotal: statement.recoverableSubtotal.toJSON(),
    nonRecoverableSubtotal: statement.nonRecoverableSubtotal.toJSON(),
    totalCosts: statement.totalCosts.toJSON(),
    hausgeldRequested: statement.hausgeldRequested.toJSON(),
    hausgeldPaid: statement.hausgeldPaid.toJSON(),
    reserveRequested: json(statement.reserveRequested),
    reservePaid: json(statement.reservePaid),
    settlementPeak: statement.settlementPeak.toJSON(),
    settlementResult: json(statement.settlementResult),
    reserve:
      statement.reserve === null
        ? null
        : {
            source: statement.reserve.source,
            lines: statement.reserve.lines.map((l) => ({
              ...l,
              opening: json(l.opening),
              addition: json(l.addition),
              withdrawal: json(l.withdrawal),
              closing: json(l.closing),
            })),
            unitShareOpening: json(statement.reserve.unitShareOpening),
            unitShareClosing: json(statement.reserve.unitShareClosing),
          },
    byClassification: {
      RECOVERABLE: statement.byClassification.RECOVERABLE.toJSON(),
      NON_RECOVERABLE: statement.byClassification.NON_RECOVERABLE.toJSON(),
      RESERVE: statement.byClassification.RESERVE.toJSON(),
    },
    flags: statement.flags.map((flag) => ({ code: flag.code, details: detailsDto(flag.details) })),
    status: statement.status,
    confirmedAt: statement.confirmedAt?.toISOString() ?? null,
    voidedAt: statement.voidedAt?.toISOString() ?? null,
    voidReason: statement.voidReason,
    sourceReferences: statement.sourceReferences,
    notes: statement.notes,
    createdAt: statement.createdAt.toISOString(),
    version: statement.version,
  };
}
