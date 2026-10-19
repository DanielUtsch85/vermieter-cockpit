import express, { type Router } from 'express';
import { z } from 'zod';
import {
  CurrencyMismatchError,
  DIRECTIONS,
  FinancialAccountClosedError,
  FinancialAccountNotFoundError,
  IdempotencyKeyConflictError,
  PropertyReferenceNotFoundError,
  checkBusinessDate,
  type CreateManualTransaction,
  type RealmPrincipal,
  type Transaction,
} from '../application/index.js';
import { Money, MoneyError } from '../shared/index.js';
import { sendError } from './errors.js';
import { RESOURCE_ID, fieldErrors, readIdempotencyKey, sendValidationError } from './validation.js';

/** Field codes for amounts (api-design.md §31.1: 400 for each). */
const MONEY_CODES: Record<MoneyError['code'], string> = {
  INVALID_AMOUNT: 'INVALID_FORMAT',
  AMOUNT_OUT_OF_RANGE: 'AMOUNT_OUT_OF_RANGE',
  SCALE_EXCEEDED: 'SCALE_EXCEEDED',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
};

/**
 * Money arrives as `{ amount: "1250.00", currency: "EUR" }` (api-design.md §86).
 * The amount must be a decimal string, never a JSON number (no float in transit),
 * non-negative (the sign is `direction`, data-model.md §17.4) and representable
 * in the currency's scale — rejected, never rounded.
 */
const money = z.object({ amount: z.string(), currency: z.string() }).transform((value, ctx) => {
  try {
    const parsed = Money.of(value.amount, value.currency);
    if (parsed.isNegative()) {
      ctx.addIssue({ code: 'custom', path: ['amount'], params: { code: 'NEGATIVE_AMOUNT' } });
      return z.NEVER;
    }
    return parsed;
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    const path = error.code === 'UNSUPPORTED_CURRENCY' ? ['currency'] : ['amount'];
    ctx.addIssue({ code: 'custom', path, params: { code: MONEY_CODES[error.code] } });
    return z.NEVER;
  }
});

/** `YYYY-MM-DD` within 1900–2100 (api-design.md §88): INVALID_FORMAT or OUT_OF_RANGE. */
const businessDate = z.string().transform((value, ctx) => {
  const result = checkBusinessDate(value);
  if ('date' in result) return result.date;
  ctx.addIssue({ code: 'custom', params: { code: result.error } });
  return z.NEVER;
});

const createBody = z.object({
  financialAccountId: z.string().regex(RESOURCE_ID),
  amount: money,
  direction: z.enum(DIRECTIONS),
  bookingDate: businessDate,
  // Explicit null means the same as omitted (the usual JSON idiom for "empty").
  valueDate: businessDate.nullish(),
  description: z.string().trim().max(500).nullish(),
  propertyReferenceId: z.string().regex(RESOURCE_ID).nullish(),
  // RentalContractReference does not exist yet: refuse rather than store an unchecked id.
  rentalContractReferenceId: z.undefined(),
  // Manual creation only; other provenances come from imports (data-model.md §17.6).
  provenance: z.literal('MANUAL').optional(),
});

export interface TransactionCommands {
  readonly createManual: CreateManualTransaction;
}

/** Transaction API (api-design.md §30–31). */
export function transactionRoutes(commands: TransactionCommands): Router {
  const router = express.Router();

  router.post('/transactions', express.json({ limit: '16kb' }), (req, res, next) => {
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(
        res,
        fieldErrors(parsed.error).map((f) => (f.field === 'rentalContractReferenceId' ? { ...f, code: 'NOT_SUPPORTED' } : f)),
      );
      return;
    }
    const body = parsed.data;

    commands
      .createManual({
        principal: res.locals['principal'] as RealmPrincipal,
        financialAccountId: body.financialAccountId.toLowerCase(),
        amount: body.amount,
        direction: body.direction,
        bookingDate: body.bookingDate,
        valueDate: body.valueDate ?? null,
        description: body.description === undefined || body.description === null || body.description === '' ? null : body.description,
        propertyReferenceId: body.propertyReferenceId?.toLowerCase() ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ transaction, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.status(201).json(toDto(transaction));
      })
      .catch((error: unknown) => {
        if (error instanceof FinancialAccountNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'FinancialAccount not found.', { financialAccountId: error.financialAccountId });
        } else if (error instanceof PropertyReferenceNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'PropertyReference not found.', { propertyReferenceId: error.propertyReferenceId });
        } else if (error instanceof FinancialAccountClosedError) {
          sendError(res, 409, 'CONFLICT', 'FinancialAccount is closed; no new Transactions.', {
            reason: 'ACCOUNT_CLOSED',
            financialAccountId: error.financialAccountId,
          });
        } else if (error instanceof CurrencyMismatchError) {
          sendValidationError(res, [{ field: 'amount.currency', code: 'CURRENCY_MISMATCH' }]);
        } else if (error instanceof IdempotencyKeyConflictError) {
          sendError(res, 409, 'CONFLICT', 'Idempotency-Key was already used with a different payload.');
        } else {
          next(error);
        }
      });
  });

  return router;
}

function toDto(transaction: Transaction) {
  return {
    transactionId: transaction.id,
    mreRealmId: transaction.mreRealmId,
    financialAccountId: transaction.financialAccountId,
    amount: transaction.amount.toJSON(),
    direction: transaction.direction,
    bookingDate: transaction.bookingDate,
    valueDate: transaction.valueDate,
    description: transaction.description,
    propertyReferenceId: transaction.propertyReferenceId,
    provenance: transaction.provenance,
    status: transaction.status,
    createdAt: transaction.createdAt.toISOString(),
    version: transaction.version,
  };
}
