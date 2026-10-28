import express, { type Router } from 'express';
import { z } from 'zod';
import { ACCOUNT_TYPES, type CloseFinancialAccount, type CreateFinancialAccount, type FinancialAccount } from '../application/index.js';
import { isSupportedCurrency, normalizeIban } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { RESOURCE_ID, fieldErrors, readIdempotencyKey, sendValidationError } from './validation.js';

/** Field mapping verbatim from data-model.md §16 (api-design.md §29.1). */
const createBody = z.object({
  accountType: z.enum(ACCOUNT_TYPES),
  displayName: z.string().trim().min(1).max(200),
  currency: z.string().refine(isSupportedCurrency),
  iban: z
    .string()
    .transform((value, ctx) => normalizeIban(value) ?? (ctx.addIssue({ code: 'custom' }), z.NEVER))
    .optional(),
});

export interface FinancialAccountCommands {
  readonly create: CreateFinancialAccount;
  readonly close: CloseFinancialAccount;
}

/** FinancialAccount API (api-design.md §29). */
export function financialAccountRoutes(commands: FinancialAccountCommands): Router {
  const router = express.Router();

  router.post('/financial-accounts', express.json({ limit: '16kb' }), (req, res, next) => {
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const idempotencyKey = idempotency.key;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
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

  router.post('/financial-accounts/:financialAccountId/close', (req, res, next) => {
    const { financialAccountId } = req.params;
    if (!RESOURCE_ID.test(financialAccountId)) {
      sendValidationError(res, [{ field: 'financialAccountId', code: 'INVALID_FORMAT' }]);
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
