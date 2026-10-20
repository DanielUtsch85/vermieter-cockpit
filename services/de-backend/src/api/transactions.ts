import express, { type Router } from 'express';
import { z } from 'zod';
import {
  CATEGORY_CODE,
  CurrencyMismatchError,
  FinancialCategoryNotFoundError,
  InactiveCategoryError,
  SplitsMissingError,
  TransactionNotConfirmableError,
  SplitSumMismatchError,
  TransactionFrozenError,
  TransactionNotFoundError,
  DIRECTIONS,
  FinancialAccountClosedError,
  FinancialAccountNotFoundError,
  IdempotencyKeyConflictError,
  PropertyReferenceNotFoundError,
  checkBusinessDate,
  type ConfirmTransaction,
  type CreateManualTransaction,
  type RealmPrincipal,
  type SetTransactionSplits,
  type SplitTransaction,
  type Transaction,
  type TransactionSplit,
} from '../application/index.js';
import { sendError } from './errors.js';
import { RESOURCE_ID, fieldErrors, money, readIdempotencyKey, sendValidationError } from './validation.js';

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

/** References of a split whose entities do not exist yet (data-model.md §18): refused, not stored unchecked. */
const NOT_YET_SUPPORTED = [
  'rentalContractReferenceId',
  'loanId',
  'wegId',
  'maintenanceProjectId',
  'acquisitionId',
  'securityDepositId',
  'taxClassificationId',
] as const;

const split = z
  .object({
    amount: money,
    financialCategoryCode: z.string().regex(CATEGORY_CODE),
    propertyReferenceId: z.string().regex(RESOURCE_ID).nullish(),
    description: z.string().trim().max(500).nullish(),
    // A split has no direction of its own: it inherits the Transaction's (§17.4).
    direction: z.undefined(),
    ...Object.fromEntries(NOT_YET_SUPPORTED.map((key) => [key, z.undefined()])),
  })
  .strict();
const splitsBody = z.object({ splits: z.array(split).min(1).max(100) }).strict();

/** `splits.0.direction` → NOT_ALLOWED, `splits.0.loanId` → NOT_SUPPORTED. */
function splitFieldCode(field: string, code: string): string {
  const key = field.split('.').at(-1) ?? '';
  if (key === 'direction') return 'NOT_ALLOWED';
  return (NOT_YET_SUPPORTED as readonly string[]).includes(key) ? 'NOT_SUPPORTED' : code;
}

export interface TransactionCommands {
  readonly createManual: CreateManualTransaction;
  readonly setSplits: SetTransactionSplits;
  readonly confirm: ConfirmTransaction;
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

  router.put('/transactions/:transactionId/splits', express.json({ limit: '64kb' }), (req, res, next) => {
    const id = req.params['transactionId'] ?? '';
    if (!RESOURCE_ID.test(id)) {
      sendValidationError(res, [{ field: 'transactionId', code: 'INVALID_FORMAT' }]);
      return;
    }
    const parsed = splitsBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(
        res,
        fieldErrors(parsed.error).map((f) => ({ ...f, code: splitFieldCode(f.field, f.code) })),
      );
      return;
    }
    const splits = parsed.data.splits.map((s) => ({
      amount: s.amount,
      financialCategoryCode: s.financialCategoryCode,
      propertyReferenceId: s.propertyReferenceId?.toLowerCase() ?? null,
      description: s.description === undefined || s.description === null || s.description === '' ? null : s.description,
    }));

    commands
      .setSplits({ principal: res.locals['principal'] as RealmPrincipal, transactionId: id.toLowerCase(), splits })
      .then(({ transaction, splits: stored }) => {
        res.json(toSplitsDto(transaction, stored));
      })
      .catch((error: unknown) => {
        if (error instanceof TransactionNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId });
        } else if (error instanceof PropertyReferenceNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'PropertyReference not found.', { propertyReferenceId: error.propertyReferenceId });
        } else if (error instanceof FinancialCategoryNotFoundError) {
          sendValidationError(
            res,
            splits.flatMap((s, i) =>
              error.codes.includes(s.financialCategoryCode)
                ? [{ field: `splits.${i}.financialCategoryCode`, code: 'UNKNOWN_CATEGORY' }]
                : [],
            ),
          );
        } else if (error instanceof CurrencyMismatchError) {
          sendValidationError(res, [{ field: 'splits', code: 'CURRENCY_MISMATCH' }]);
        } else if (error instanceof TransactionFrozenError) {
          sendError(res, 409, 'CONFLICT', `Transaction is ${error.status}; its splits cannot change.`, {
            reason: 'TRANSACTION_FROZEN',
            status: error.status,
          });
        } else if (error instanceof SplitSumMismatchError) {
          sendError(res, 409, 'INVARIANT_VIOLATION', 'Splits do not add up to the Transaction amount.', {
            reason: 'SPLIT_SUM_MISMATCH',
            expected: error.expected.toJSON(),
            actual: error.actual.toJSON(),
            difference: error.expected.subtract(error.actual).toJSON(),
          });
        } else {
          next(error);
        }
      });
  });

  router.post('/transactions/:transactionId/confirm', (req, res, next) => {
    const id = req.params['transactionId'] ?? '';
    if (!RESOURCE_ID.test(id)) {
      sendValidationError(res, [{ field: 'transactionId', code: 'INVALID_FORMAT' }]);
      return;
    }
    commands
      .confirm({ principal: res.locals['principal'] as RealmPrincipal, transactionId: id.toLowerCase() })
      .then(({ transaction, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.json(toDto(transaction));
      })
      .catch((error: unknown) => {
        if (error instanceof TransactionNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId });
        } else if (error instanceof TransactionNotConfirmableError) {
          sendError(res, 409, 'CONFLICT', `Transaction is ${error.status} and cannot be confirmed.`, {
            reason: 'NOT_CONFIRMABLE',
            status: error.status,
          });
        } else if (error instanceof SplitsMissingError) {
          sendError(res, 409, 'INVARIANT_VIOLATION', 'Transaction has no splits; split it before confirming.', {
            reason: 'SPLITS_MISSING',
          });
        } else if (error instanceof SplitSumMismatchError) {
          sendError(res, 409, 'INVARIANT_VIOLATION', 'Splits do not add up to the Transaction amount.', {
            reason: 'SPLIT_SUM_MISMATCH',
            expected: error.expected.toJSON(),
            actual: error.actual.toJSON(),
            difference: error.expected.subtract(error.actual).toJSON(),
          });
        } else if (error instanceof InactiveCategoryError) {
          sendError(res, 422, 'REVIEW_REQUIRED', 'A split uses an inactive financial category; split again before confirming.', {
            reason: 'INACTIVE_CATEGORY',
            financialCategoryCodes: error.codes,
          });
        } else {
          next(error);
        }
      });
  });

  return router;
}

function toSplitsDto(transaction: SplitTransaction, splits: readonly TransactionSplit[]) {
  return {
    transactionId: transaction.id,
    amount: transaction.amount.toJSON(),
    direction: transaction.direction,
    status: transaction.status,
    version: transaction.version,
    splits: splits.map((s) => ({
      splitId: s.id,
      position: s.position,
      amount: s.amount.toJSON(),
      financialCategoryCode: s.financialCategoryCode,
      propertyReferenceId: s.propertyReferenceId,
      description: s.description,
    })),
  };
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
    confirmedAt: transaction.confirmedAt?.toISOString() ?? null,
    confirmedBy: transaction.confirmedBy,
  };
}
