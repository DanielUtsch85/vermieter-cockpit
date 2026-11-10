import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  type CloseFinancialAccount,
  type CreateFinancialAccount,
  type FinancialAccount,
  type GetFinancialAccount,
  type ListFinancialAccounts,
} from '../application/index.js';
import { isSupportedCurrency, normalizeIban } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { EMPTY_BODY, NO_QUERY, PAGING, readBody, readIdempotencyKey, readQuery, refuseQuery, RESOURCE_ID, sendValidationError } from './validation.js';

/** Field mapping verbatim from data-model.md §16 (api-design.md §29.1). */
const createBody = z
  .object({
    accountType: z.enum(ACCOUNT_TYPES),
    displayName: z.string().trim().min(1).max(200),
    currency: z.string().refine(isSupportedCurrency),
    iban: z
      .string()
      .transform((value, ctx) => normalizeIban(value) ?? (ctx.addIssue({ code: 'custom' }), z.NEVER))
      .optional(),
  })
  .strict();

/** A comma-separated list of the given values, any of them. */
const commaList = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(values)).min(1));

/** api-design.md §29.3; unknown parameters are `400`. */
const listQuery = z.object({
  status: commaList(ACCOUNT_STATUSES).optional(),
  accountType: commaList(ACCOUNT_TYPES).optional(),
  ...PAGING,
});

export interface FinancialAccountCommands {
  readonly create: CreateFinancialAccount;
  readonly close: CloseFinancialAccount;
  readonly get: GetFinancialAccount;
  readonly list: ListFinancialAccounts;
}

/** FinancialAccount API (api-design.md §29). */
export function financialAccountRoutes(commands: FinancialAccountCommands): Router {
  const router = express.Router();

  router.post('/financial-accounts', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const idempotencyKey = idempotency.key;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(createBody, req);
    if (!parsed.ok) {
      sendValidationError(res, parsed.errors);
      return;
    }

    commands
      .create({
        principal: principalOf(res),
        accountType: parsed.data.accountType,
        displayName: parsed.data.displayName,
        currency: parsed.data.currency,
        iban: parsed.data.iban ?? null,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      })
      .then(({ account, replayed }) => {
        // A replay answers like the original request; the header tells them apart.
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.status(201).json(toDto(account));
      })
      .catch(next);
  });

  router.get('/financial-accounts', (req, res, next) => {
    const parsed = readQuery(listQuery, req);
    if (refuseQuery(res, parsed)) return;
    const { page, pageSize, status, accountType } = parsed.data;
    commands
      .list({
        principal: principalOf(res),
        filter: { ...(status === undefined ? {} : { statuses: status }), ...(accountType === undefined ? {} : { accountTypes: accountType }) },
        page: { page, pageSize },
      })
      .then((result) => {
        res.json({ items: result.items.map(toDto), page: result.page, pageSize: result.pageSize, total: result.total });
      })
      .catch(next);
  });

  router.get('/financial-accounts/:financialAccountId', (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const { financialAccountId } = req.params;
    if (!RESOURCE_ID.test(financialAccountId)) {
      sendValidationError(res, [{ field: 'financialAccountId', code: 'INVALID_FORMAT' }]);
      return;
    }
    if (refuseQuery(res, query)) return;
    commands
      .get({ principal: principalOf(res), financialAccountId: financialAccountId.toLowerCase() })
      .then((account) => sendAccount(res, account))
      .catch(next);
  });

  // Takes no body: no body, an empty one or `{}`; a field is unknown (§58X rule 3).
  router.post('/financial-accounts/:financialAccountId/close', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const { financialAccountId } = req.params;
    if (!RESOURCE_ID.test(financialAccountId)) {
      sendValidationError(res, [{ field: 'financialAccountId', code: 'INVALID_FORMAT' }]);
      return;
    }
    if (refuseQuery(res, query)) return;
    const empty = readBody(EMPTY_BODY, req);
    if (!empty.ok) {
      sendValidationError(res, empty.errors);
      return;
    }
    commands
      .close({ principal: principalOf(res), financialAccountId })
      .then((account) => {
        res.status(200).json(toDto(account));
      })
      .catch(next);
  });

  return router;
}

/** A single account with its version as `ETag` (api-design.md §16.1). */
function sendAccount(res: Response, account: FinancialAccount): void {
  res.setHeader('ETag', `"${account.version}"`);
  res.json(toDto(account));
}

function toDto(account: FinancialAccount) {
  return {
    financialAccountId: account.id,
    mreRealmId: account.mreRealmId,
    accountType: account.accountType,
    displayName: account.displayName,
    currency: account.currency,
    iban: account.iban,
    status: account.status,
    createdAt: account.createdAt.toISOString(),
    closedAt: account.closedAt?.toISOString() ?? null,
    version: account.version,
  };
}
