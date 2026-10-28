import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  type RemoveFromMre,
  type GetReconciliationWithPresence,
  type WriteBackToMre,
  type ConfirmReconciliation,
  type RejectReconciliation,
  type SuggestReconciliations,
  MRE_EXTERNAL_ID,
  RECONCILIATION_STATUSES,
  isTermKey,
  type CreateReconciliation,
  type GetReconciliation,
  type GetTermCoverage,
  type GetTransactionCoverage,
  type MreRentTermView,
  type TermCoverage,
  type TransactionCoverage,
  type ListReconciliations,
  type ReconciliationStatus,
  type ReleaseReconciliation,
  type RentPaymentReconciliation,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { definedOnly, optionalText, readId } from './acquisitions.js';
import { RESOURCE_ID, fieldErrors, money, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const uuid = z
  .string()
  .regex(RESOURCE_ID)
  .transform((id) => id.toLowerCase());
const mreTenantId = z.string().regex(MRE_EXTERNAL_ID);
/** MRE's term key `YYYYMMDDHH`: only its form (§37.1). */
const mreRentTerm = z.string().refine(isTermKey, { params: { code: 'INVALID_TERM' } });

const createBody = z
  .object({
    transactionId: uuid,
    mreTenantId,
    mreRentTerm,
    matchedAmount: money,
    notes: optionalText(2000).nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // Refinements run even after a field failed to parse: only check what parsed.
    if (body.matchedAmount instanceof Money && !body.matchedAmount.isPositive()) {
      ctx.addIssue({ code: 'custom', path: ['matchedAmount', 'amount'], params: { code: 'NOT_POSITIVE' } });
    }
  });

const releaseBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

/** `YYYY-MM` with a real month. */
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));
const suggestBody = z
  .object({ from: yearMonth, to: yearMonth })
  .strict()
  .superRefine((body, ctx) => {
    // Refinements run even after a field failed to parse: only check what parsed.
    if (typeof body.from !== 'string' || typeof body.to !== 'string') return;
    const span = monthIndex(body.to) - monthIndex(body.from);
    if (span < 0) ctx.addIssue({ code: 'custom', path: ['to'], params: { code: 'INVALID_RANGE' } });
    else if (span >= 12) ctx.addIssue({ code: 'custom', path: ['to'], params: { code: 'RANGE_TOO_LONG' } });
  });
const confirmBody = z
  .object({ matchedAmount: money.optional() })
  .strict()
  .superRefine((body, ctx) => {
    if (body.matchedAmount instanceof Money && !body.matchedAmount.isPositive()) {
      ctx.addIssue({ code: 'custom', path: ['matchedAmount', 'amount'], params: { code: 'NOT_POSITIVE' } });
    }
  });

/** `status` as a comma-separated list, any of them. */
const statusList = z
  .string()
  .transform((value) => value.split(','))
  .pipe(z.array(z.enum(RECONCILIATION_STATUSES)).min(1));

const listQuery = z
  .object({
    status: statusList.optional(),
    transactionId: uuid.optional(),
    mreTenantId: mreTenantId.optional(),
    mreRentTerm: mreRentTerm.optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/** The coverage reads take no query parameters (§37.2). */
const noQuery = z.object({}).strict();
/** One reconciliation's read: the presence check is `checkMre=true` (§37.4); nothing else. */
const getQuery = z.object({ checkMre: z.enum(['true', 'false']).optional() }).strict();
/** The write-back takes no body, or `{}` (§37.4). */
const writeBackBody = z.object({}).strict();

export interface RentReconciliationCommands {
  readonly create: CreateReconciliation;
  readonly get: GetReconciliation;
  readonly list: ListReconciliations;
  readonly release: ReleaseReconciliation;
  readonly termCoverage: GetTermCoverage;
  readonly transactionCoverage: GetTransactionCoverage;
  readonly suggest: SuggestReconciliations;
  readonly confirm: ConfirmReconciliation;
  readonly reject: RejectReconciliation;
  readonly writeBack: WriteBackToMre;
  readonly removeFromMre: RemoveFromMre;
  readonly getWithPresence: GetReconciliationWithPresence;
}

/** Rent reconciliation API (api-design.md §37.1, backlog VC-4-01). */
export function rentReconciliationRoutes(commands: RentReconciliationCommands): Router {
  const router = express.Router();

  router.post('/rent-reconciliations', express.json({ limit: '16kb' }), (req, res, next) => {
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
        authorizationHeader: req.headers.authorization ?? '',
        transactionId: body.transactionId,
        mreTenantId: body.mreTenantId,
        mreRentTerm: body.mreRentTerm,
        matchedAmount: body.matchedAmount,
        notes: body.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ reconciliation, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendReconciliation(res.status(201), reconciliation);
      })
      .catch(next);
  });

  router.post('/rent-reconciliations/suggest', express.json({ limit: '16kb' }), (req, res, next) => {
    const parsed = suggestBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .suggest({ principal: principalOf(res), authorizationHeader: req.headers.authorization ?? '', ...parsed.data })
      .then((result) => res.json({ ...result, items: result.items.map(toDto) }))
      .catch(next);
  });

  router.post('/rent-reconciliations/:reconciliationId/confirm', express.json({ limit: '16kb' }), (req, res, next) => {
    const reconciliationId = readId(req.params['reconciliationId'], 'reconciliationId', res);
    if (reconciliationId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = confirmBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .confirm({
        principal: principalOf(res),
        authorizationHeader: req.headers.authorization ?? '',
        reconciliationId,
        ...(parsed.data.matchedAmount === undefined ? {} : { matchedAmount: parsed.data.matchedAmount }),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ reconciliation }) => sendReconciliation(res, reconciliation))
      .catch(next);
  });

  router.post('/rent-reconciliations/:reconciliationId/reject', express.json({ limit: '16kb' }), (req, res, next) => {
    const reconciliationId = readId(req.params['reconciliationId'], 'reconciliationId', res);
    if (reconciliationId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = releaseBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .reject({
        principal: principalOf(res),
        reconciliationId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ reconciliation }) => sendReconciliation(res, reconciliation))
      .catch(next);
  });

  router.get('/rent-reconciliations', (req, res, next) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { page, pageSize, ...filter } = parsed.data;
    commands
      .list({ principal: principalOf(res), filter: definedOnly(filter), page: { page, pageSize } })
      .then((result) => res.json({ ...result, items: result.items.map(toDto) }))
      .catch(next);
  });

  router.get('/rent-reconciliations/terms/:mreTenantId/:mreRentTerm', (req, res, next) => {
    const parsed = z.object({ mreTenantId, mreRentTerm }).safeParse(req.params);
    const query = noQuery.safeParse(req.query);
    if (!parsed.success || !query.success) {
      sendValidationError(res, [...(parsed.success ? [] : fieldErrors(parsed.error)), ...(query.success ? [] : fieldErrors(query.error))]);
      return;
    }
    commands
      .termCoverage({ principal: principalOf(res), authorizationHeader: req.headers.authorization ?? '', ...parsed.data })
      .then((result) => res.json(toTermDto(result)))
      .catch(next);
  });

  router.get('/transactions/:transactionId/rent-reconciliations', (req, res, next) => {
    const transactionId = readId(req.params['transactionId'], 'transactionId', res);
    if (transactionId === undefined) return;
    const query = noQuery.safeParse(req.query);
    if (!query.success) {
      sendValidationError(res, fieldErrors(query.error));
      return;
    }
    commands
      .transactionCoverage({ principal: principalOf(res), transactionId })
      .then((result) => res.json(toTransactionDto(result)))
      .catch(next);
  });

  router.get('/rent-reconciliations/:reconciliationId', (req, res, next) => {
    const reconciliationId = readId(req.params['reconciliationId'], 'reconciliationId', res);
    if (reconciliationId === undefined) return;
    const query = getQuery.safeParse(req.query);
    if (!query.success) {
      sendValidationError(res, fieldErrors(query.error));
      return;
    }
    const read =
      query.data.checkMre === 'true'
        ? commands.getWithPresence({ principal: principalOf(res), authorizationHeader: req.headers.authorization ?? '', reconciliationId })
        : commands.get({ principal: principalOf(res), reconciliationId }).then((reconciliation) => ({ reconciliation, mrePresence: null }));
    read
      .then(({ reconciliation, mrePresence }) => {
        res.setHeader('ETag', `"${reconciliation.version}"`);
        res.json({ ...toDto(reconciliation), mrePresence });
      })
      .catch(next);
  });

  // §37.4's write-back and §37.5's removal: no body or {}, If-Match optional.
  for (const [path, command] of [
    ['write-back-to-mre', commands.writeBack],
    ['remove-from-mre', commands.removeFromMre],
  ] as const) {
    router.post(`/rent-reconciliations/:reconciliationId/${path}`, express.json({ limit: '16kb' }), (req, res, next) => {
      const reconciliationId = readId(req.params['reconciliationId'], 'reconciliationId', res);
      if (reconciliationId === undefined) return;
      const ifMatch = readIfMatch(req, res);
      if (ifMatch === undefined) return;
      const parsed = writeBackBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendValidationError(res, fieldErrors(parsed.error));
        return;
      }
      command({
        principal: principalOf(res),
        authorizationHeader: req.headers.authorization ?? '',
        reconciliationId,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
        .then(({ reconciliation }) => sendReconciliation(res, reconciliation))
        .catch(next);
    });
  }

  router.post('/rent-reconciliations/:reconciliationId/release', express.json({ limit: '16kb' }), (req, res, next) => {
    const reconciliationId = readId(req.params['reconciliationId'], 'reconciliationId', res);
    if (reconciliationId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = releaseBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .release({
        principal: principalOf(res),
        reconciliationId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ reconciliation }) => sendReconciliation(res, reconciliation))
      .catch(next);
  });

  return router;
}

/** A single reconciliation with its version as `ETag` for the next `If-Match` (api-design.md §16.1). */
function sendReconciliation(res: Response, reconciliation: RentPaymentReconciliation): void {
  res.setHeader('ETag', `"${reconciliation.version}"`);
  res.json(toDto(reconciliation));
}

function toDto(r: RentPaymentReconciliation) {
  return {
    reconciliationId: r.id,
    mreRealmId: r.mreRealmId,
    status: r.status satisfies ReconciliationStatus,
    transactionId: r.transactionId,
    mreTenantId: r.mreTenantId,
    mreRentTerm: r.mreRentTerm,
    matchedAmount: r.matchedAmount.toJSON(),
    confidence: r.confidence,
    suggestionReason: r.suggestionReason,
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    confirmedBy: r.confirmedBy,
    releasedAt: r.releasedAt?.toISOString() ?? null,
    releasedBy: r.releasedBy,
    releaseReason: r.releaseReason,
    rejectedAt: r.rejectedAt?.toISOString() ?? null,
    rejectedBy: r.rejectedBy,
    rejectReason: r.rejectReason,
    notes: r.notes,
    mreWriteBackState: r.mreWriteBackState,
    mreWriteBackLeaseUntil: r.mreWriteBackLeaseUntil?.toISOString() ?? null,
    mreWrittenBackAt: r.mreWrittenBackAt?.toISOString() ?? null,
    mreWrittenBackBy: r.mreWrittenBackBy,
    mrePayment: r.mrePayment === null ? null : { ...r.mrePayment, amount: r.mrePayment.amount.toJSON() },
    mreWriteBackError: r.mreWriteBackError,
    mreWriteBackFailedAt: r.mreWriteBackFailedAt?.toISOString() ?? null,
    mreLastLeaseUntil: r.mreLastLeaseUntil?.toISOString() ?? null,
    mreRemovedAt: r.mreRemovedAt?.toISOString() ?? null,
    mreRemovedBy: r.mreRemovedBy,
    createdAt: r.createdAt.toISOString(),
    version: r.version,
  };
}

function toMreDto(mre: MreRentTermView) {
  return {
    amountDue: mre.amountDue.toJSON(),
    payments: mre.payments.map((p) => ({ date: p.date, amount: p.amount.toJSON(), type: p.type, reference: p.reference })),
  };
}

function toTermDto(t: TermCoverage) {
  return {
    mreTenantId: t.mreTenantId,
    mreRentTerm: t.mreRentTerm,
    reconciliations: t.reconciliations.map(toDto),
    matchedTotal: t.matchedTotal.toJSON(),
    mreStatus: t.mreStatus,
    mre: t.mre === null ? null : toMreDto(t.mre),
    coverage: t.coverage,
    openAmount: t.openAmount?.toJSON() ?? null,
  };
}

function toTransactionDto(t: TransactionCoverage) {
  return {
    transactionId: t.transactionId,
    status: t.status,
    direction: t.direction,
    correctionRole: t.correctionRole,
    counted: t.counted,
    rentCash: t.rentCash?.toJSON() ?? null,
    matchedTotal: t.matchedTotal.toJSON(),
    available: t.available?.toJSON() ?? null,
    reconciliations: t.reconciliations.map(toDto),
  };
}
