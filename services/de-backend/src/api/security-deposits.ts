import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  DEPOSIT_CLOSING_REASONS,
  DEPOSIT_STATES,
  DEPOSIT_STATUSES,
  MRE_EXTERNAL_ID,
  retainedAmountOf,
  type AmendDeposit,
  type CloseDeposit,
  type CreateDeposit,
  type DepositChanges,
  type GetDeposit,
  type ListDeposits,
  type DepositFlag,
  type DepositView,
  type ReopenDeposit,
  type VoidDeposit,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, definedOnly, optionalText, readId } from './acquisitions.js';
import { RESOURCE_ID, fieldErrors, money, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const uuid = z
  .string()
  .regex(RESOURCE_ID)
  .transform((id) => id.toLowerCase());
const mreTenantId = z.string().regex(MRE_EXTERNAL_ID);

/** Data-model §26's fields that P5-D1 dropped or P5-D2 derives: unknown keys, refused as any other (§47.1). */
const createBody = z
  .object({
    mreTenantId,
    expectedAmount: money.optional(),
    holdingFinancialAccountId: uuid.nullish(),
    interestBearing: z.boolean().optional(),
    notes: optionalText(2000).nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // Refinements run even after a field failed to parse: only check what parsed.
    if (body.expectedAmount instanceof Money && !body.expectedAmount.isPositive()) {
      ctx.addIssue({ code: 'custom', path: ['expectedAmount', 'amount'], params: { code: 'NOT_POSITIVE' } });
    }
  });

/** Fixed after creation (§47.1): named in an amend, it is `400 NOT_AMENDABLE`, not an unknown key. */
const FIXED = ['mreTenantId'] as const;

const amendBody = z
  .object({
    expectedAmount: money.optional(),
    holdingFinancialAccountId: uuid.nullable().optional(),
    interestBearing: z.boolean().optional(),
    notes: optionalText(2000).nullish(),
    ...Object.fromEntries(FIXED.map((field) => [field, z.unknown().optional()])),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Object.keys(body).length === 0) ctx.addIssue({ code: 'custom', params: { code: 'REQUIRED' } });
    for (const field of FIXED) {
      if (field in body) ctx.addIssue({ code: 'custom', path: [field], params: { code: 'NOT_AMENDABLE' } });
    }
    if (body.expectedAmount instanceof Money && !body.expectedAmount.isPositive()) {
      ctx.addIssue({ code: 'custom', path: ['expectedAmount', 'amount'], params: { code: 'NOT_POSITIVE' } });
    }
  });

const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const closeBody = z
  .object({
    closingDate: businessDate,
    reason: z.enum(DEPOSIT_CLOSING_REASONS),
    closingNote: optionalText(500).nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // §47.4: what a retained part covers, or the other reason, is named.
    if ((body.reason === 'RETAINED' || body.reason === 'OTHER') && (body.closingNote ?? null) === null) {
      ctx.addIssue({ code: 'custom', path: ['closingNote'], params: { code: 'REQUIRED' } });
    }
  });

const reopenBody = z.object({}).strict();

const getQuery = z.object({ checkMre: z.enum(['true', 'false']).default('false') }).strict();

/** A comma-separated list of the given values, any of them. */
const commaList = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(values)).min(1));

const listQuery = z
  .object({
    status: commaList(DEPOSIT_STATUSES).optional(),
    // The derived state (§47.3), applied before paging.
    state: commaList(DEPOSIT_STATES).optional(),
    mreTenantId: mreTenantId.optional(),
    holdingFinancialAccountId: uuid.optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export interface SecurityDepositCommands {
  readonly create: CreateDeposit;
  readonly get: GetDeposit;
  readonly list: ListDeposits;
  readonly amend: AmendDeposit;
  readonly void: VoidDeposit;
  readonly close: CloseDeposit;
  readonly reopen: ReopenDeposit;
}

/** SecurityDeposit API (api-design.md §47.1, §47.3, §47.4, backlog VC-5-01, VC-5-03, VC-5-04). */
export function securityDepositRoutes(commands: SecurityDepositCommands): Router {
  const router = express.Router();

  router.post('/security-deposits', express.json({ limit: '16kb' }), (req, res, next) => {
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
        mreTenantId: body.mreTenantId,
        expectedAmount: body.expectedAmount ?? null,
        holdingFinancialAccountId: body.holdingFinancialAccountId ?? null,
        // A residential deposit bears interest (§ 551 Abs. 3 BGB, P5-D5).
        interestBearing: body.interestBearing ?? true,
        notes: body.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ deposit, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendDeposit(res.status(201), deposit);
      })
      .catch(next);
  });

  router.get('/security-deposits', (req, res, next) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { page, pageSize, status, state, ...rest } = parsed.data;
    commands
      .list({ principal: principalOf(res), filter: definedOnly({ statuses: status, states: state, ...rest }), page: { page, pageSize } })
      .then((result) => res.json({ ...result, items: result.items.map(toDto) }))
      .catch(next);
  });

  router.get('/security-deposits/:securityDepositId', (req, res, next) => {
    const securityDepositId = readId(req.params['securityDepositId'], 'securityDepositId', res);
    if (securityDepositId === undefined) return;
    const parsed = getQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .get({
        principal: principalOf(res),
        securityDepositId,
        ...(parsed.data.checkMre === 'true' ? { checkMre: { authorizationHeader: req.headers.authorization ?? '' } } : {}),
      })
      .then((deposit) => sendDeposit(res, deposit))
      .catch(next);
  });

  router.post('/security-deposits/:securityDepositId/amend', express.json({ limit: '16kb' }), (req, res, next) => {
    const securityDepositId = readId(req.params['securityDepositId'], 'securityDepositId', res);
    if (securityDepositId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = amendBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    const changes: DepositChanges = definedOnly({
      expectedAmount: body.expectedAmount,
      holdingFinancialAccountId: body.holdingFinancialAccountId,
      interestBearing: body.interestBearing,
      notes: body.notes,
    });
    commands
      .amend({ principal: principalOf(res), securityDepositId, changes, ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }) })
      .then(({ deposit }) => sendDeposit(res, deposit))
      .catch(next);
  });

  router.post('/security-deposits/:securityDepositId/void', express.json({ limit: '16kb' }), (req, res, next) => {
    const securityDepositId = readId(req.params['securityDepositId'], 'securityDepositId', res);
    if (securityDepositId === undefined) return;
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
        securityDepositId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ deposit }) => sendDeposit(res, deposit))
      .catch(next);
  });

  router.post('/security-deposits/:securityDepositId/close', express.json({ limit: '16kb' }), (req, res, next) => {
    const securityDepositId = readId(req.params['securityDepositId'], 'securityDepositId', res);
    if (securityDepositId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = closeBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    commands
      .close({
        principal: principalOf(res),
        securityDepositId,
        request: { closingDate: body.closingDate, reason: body.reason, closingNote: body.closingNote ?? null },
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ deposit }) => sendDeposit(res, deposit))
      .catch(next);
  });

  router.post('/security-deposits/:securityDepositId/reopen', express.json({ limit: '16kb' }), (req, res, next) => {
    const securityDepositId = readId(req.params['securityDepositId'], 'securityDepositId', res);
    if (securityDepositId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    // An empty body is `{}` (§47.4).
    const parsed = reopenBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .reopen({ principal: principalOf(res), securityDepositId, ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }) })
      .then(({ deposit }) => sendDeposit(res, deposit))
      .catch(next);
  });

  return router;
}

/** A single deposit with its version as `ETag` for the next `If-Match` (api-design.md §16.1). */
function sendDeposit(res: Response, deposit: DepositView): void {
  res.setHeader('ETag', `"${deposit.version}"`);
  res.json(toDto(deposit));
}

/** Money in a flag's details as JSON; ids and empty details as they are. */
const flagDto = (flag: DepositFlag) => ({
  code: flag.code,
  details: Object.fromEntries(Object.entries(flag.details).map(([key, value]) => [key, value instanceof Money ? value.toJSON() : value])),
});

/** §47.1's fields and §47.3's figures; `cash` only where the read carries it (the single read). */
function toDto(deposit: DepositView) {
  const { figures } = deposit;
  return {
    securityDepositId: deposit.id,
    mreRealmId: deposit.mreRealmId,
    status: deposit.status,
    mreTenantId: deposit.mreTenantId,
    expectedAmount: deposit.expectedAmount.toJSON(),
    expectedAmountSource: deposit.expectedAmountSource,
    holdingFinancialAccountId: deposit.holdingFinancialAccountId,
    interestBearing: deposit.interestBearing,
    notes: deposit.notes,
    voidedAt: deposit.voidedAt?.toISOString() ?? null,
    voidReason: deposit.voidReason,
    closing:
      deposit.closing === null
        ? null
        : {
            closingDate: deposit.closing.closingDate,
            reason: deposit.closing.reason,
            closingNote: deposit.closing.closingNote,
            heldAtClosing: deposit.closing.heldAtClosing.toJSON(),
            retainedAmount: retainedAmountOf(deposit.closing).toJSON(),
          },
    createdAt: deposit.createdAt.toISOString(),
    version: deposit.version,
    received: figures.received.toJSON(),
    interestCredited: figures.interestCredited.toJSON(),
    returned: figures.returned.toJSON(),
    outstanding: figures.outstanding.toJSON(),
    held: figures.held.toJSON(),
    state: figures.state,
    flags: figures.flags.map(flagDto),
    ...(deposit.cash === undefined
      ? {}
      : {
          cash: deposit.cash.map((c) => ({
            transactionId: c.transactionId,
            bookingDate: c.bookingDate,
            financialAccountId: c.financialAccountId,
            kind: c.kind,
            amount: c.amount.toJSON(),
          })),
        }),
    // Only with `checkMre` (§47.4).
    ...(deposit.mre === undefined
      ? {}
      : {
          mre:
            deposit.mre === null ? null : { guaranty: deposit.mre.guaranty?.toJSON() ?? null, guarantyPayback: deposit.mre.guarantyPayback?.toJSON() ?? null },
        }),
  };
}
