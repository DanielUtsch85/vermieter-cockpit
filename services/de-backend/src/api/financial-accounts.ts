import express, { type Router } from 'express';
import { z } from 'zod';
import {
  ACCOUNT_TYPES,
  FinancialAccountNotFoundError,
  IdempotencyKeyConflictError,
  type CloseFinancialAccount,
  type CreateFinancialAccount,
  type FinancialAccount,
  type RealmPrincipal,
} from '../application/index.js';
import { isSupportedCurrency, normalizeIban } from '../shared/index.js';
import { sendError } from './errors.js';

const FINANCIAL_ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Client-generated key (api-design.md §15): visible ASCII, bounded length. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

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
    const keyHeader = req.headers['idempotency-key'];
    const idempotencyKey = typeof keyHeader === 'string' ? keyHeader : undefined;
    if (keyHeader !== undefined && (idempotencyKey === undefined || !IDEMPOTENCY_KEY.test(idempotencyKey))) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Validation failed.', {
        fields: [{ field: 'Idempotency-Key', code: 'INVALID_FORMAT' }],
      });
      return;
    }
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || '(body)',
        code: issue.code === 'invalid_type' && issue.received === 'undefined' ? 'REQUIRED' : 'INVALID_FORMAT',
      }));
      sendError(res, 400, 'VALIDATION_ERROR', 'Validation failed.', { fields });
      return;
    }

    commands
      .create({
        principal: res.locals['principal'] as RealmPrincipal,
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
      .catch((error: unknown) => {
        if (error instanceof IdempotencyKeyConflictError) {
          sendError(res, 409, 'CONFLICT', 'Idempotency-Key was already used with a different payload.');
        } else {
          next(error);
        }
      });
  });

  router.post('/financial-accounts/:financialAccountId/close', (req, res, next) => {
    const { financialAccountId } = req.params;
    if (!FINANCIAL_ACCOUNT_ID.test(financialAccountId)) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Validation failed.', {
        fields: [{ field: 'financialAccountId', code: 'INVALID_FORMAT' }],
      });
      return;
    }
    commands
      .close({ principal: res.locals['principal'] as RealmPrincipal, financialAccountId })
      .then((account) => {
        res.status(200).json(toDto(account));
      })
      .catch((error: unknown) => {
        if (error instanceof FinancialAccountNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'FinancialAccount not found.', { financialAccountId });
        } else {
          next(error);
        }
      });
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
