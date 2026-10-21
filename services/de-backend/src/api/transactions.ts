import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  CATEGORY_CODE,
  CorrectionNoChangeError,
  ImportedFieldsFixedError,
  TransactionNotAmendableError,
  TransactionNotIgnorableError,
  TransactionNotIgnoredError,
  CurrencyMismatchError,
  TransactionAlreadyCorrectedError,
  TransactionNotCorrectableError,
  FinancialCategoryNotFoundError,
  InactiveCategoryError,
  SplitsMissingError,
  TransactionNotConfirmableError,
  VersionConflictError,
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
  type GetTransaction,
  type ListTransactions,
  type ListPropertyReferenceTransactions,
  type TransactionFilter,
  type TransactionPage,
  type TransactionStatus,
  REVIEWABLE_STATUSES,
  TRANSACTION_STATUSES,
  type CorrectTransaction,
  type ReverseTransaction,
  type AmendTransaction,
  type IgnoreTransaction,
  type RestoreTransaction,
  type TransactionChanges,
  type ReplacementInput,
  type CreateManualTransaction,
  type RealmPrincipal,
  type SetTransactionSplits,
  type SplitTransaction,
  type Transaction,
  type TransactionSplit,
} from '../application/index.js';
import { sendError } from './errors.js';
import { RESOURCE_ID, fieldErrors, money, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

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

type SplitBody = z.infer<typeof split>;

/** A split as the use cases take it: lower-case ids, empty description = none. */
function toSplitInput(s: SplitBody) {
  return {
    amount: s.amount,
    financialCategoryCode: s.financialCategoryCode,
    propertyReferenceId: s.propertyReferenceId?.toLowerCase() ?? null,
    description: s.description === undefined || s.description === null || s.description === '' ? null : s.description,
  };
}

/** `correct` (api-design.md §35.2): the replacement names only the fields that differ; null clears an optional one. */
const correctBody = z
  .object({
    reason: z.string().trim().min(1).max(500),
    replacement: z
      .object({
        financialAccountId: z.string().regex(RESOURCE_ID).optional(),
        amount: money.optional(),
        direction: z.enum(DIRECTIONS).optional(),
        bookingDate: businessDate.optional(),
        valueDate: businessDate.nullable().optional(),
        description: z.string().trim().max(500).nullable().optional(),
        propertyReferenceId: z.string().regex(RESOURCE_ID).nullable().optional(),
        splits: z.array(split).min(1).max(100).optional(),
      })
      .strict(),
  })
  .strict();

/** `GET /transactions` (api-design.md §30.1): filters and page; unknown parameters are refused. */
const listFields = z.object({
    financialAccountId: z.string().regex(RESOURCE_ID).optional(),
    // Comma-separated, any of them.
    status: z
      .string()
      .transform((value, ctx) => {
        const statuses = value.split(',').map((s) => s.trim());
        if (statuses.some((s) => !(TRANSACTION_STATUSES as readonly string[]).includes(s))) {
          ctx.addIssue({ code: 'custom', params: { code: 'INVALID_FORMAT' } });
          return z.NEVER;
        }
        return statuses as TransactionStatus[];
      })
      .optional(),
    reviewable: z.enum(['true']).optional(),
    current: z.enum(['true']).optional(),
    propertyReferenceId: z.string().regex(RESOURCE_ID).optional(),
    financialCategoryCode: z.string().regex(CATEGORY_CODE).optional(),
    bookingDateFrom: businessDate.optional(),
    bookingDateTo: businessDate.optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const dateRange = {
  check: (q: { bookingDateFrom?: string | undefined; bookingDateTo?: string | undefined }) =>
    q.bookingDateFrom === undefined || q.bookingDateTo === undefined || q.bookingDateFrom <= q.bookingDateTo,
  issue: { path: ['bookingDateTo'], params: { code: 'INVALID_RANGE' } },
};
const listQuery = listFields.strict().refine(dateRange.check, dateRange.issue);
/** `GET /property-references/{id}/transactions`: the same, with the PropertyReference in the path. */
const propertyReferenceListQuery = listFields.omit({ propertyReferenceId: true }).strict().refine(dateRange.check, dateRange.issue);

type ListQuery = z.infer<typeof listQuery>;

/** The filter of a parsed list query (§30.1). */
function listFilter(q: Omit<ListQuery, 'propertyReferenceId'> & { propertyReferenceId?: string | undefined }): TransactionFilter {
  // `reviewable=true` is the statuses IMPORTED and UNREVIEWED; with `status` too, both must hold.
  const reviewable: readonly TransactionStatus[] | undefined = q.reviewable === 'true' ? REVIEWABLE_STATUSES : undefined;
  const statuses =
    q.status !== undefined && reviewable !== undefined ? q.status.filter((s) => reviewable.includes(s)) : (q.status ?? reviewable);
  return {
    ...(q.financialAccountId === undefined ? {} : { financialAccountId: q.financialAccountId.toLowerCase() }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(q.propertyReferenceId === undefined ? {} : { propertyReferenceId: q.propertyReferenceId.toLowerCase() }),
    ...(q.financialCategoryCode === undefined ? {} : { financialCategoryCode: q.financialCategoryCode }),
    ...(q.bookingDateFrom === undefined ? {} : { bookingDateFrom: q.bookingDateFrom }),
    ...(q.bookingDateTo === undefined ? {} : { bookingDateTo: q.bookingDateTo }),
    ...(q.current === 'true' ? { current: true as const } : {}),
  };
}

/**
 * The fields a replacement's currency mismatch points at (backlog VC-X-18): a requested amount or split by its
 * path; a copied one by the changed `financialAccountId`, whose currency it no longer matches.
 */
function replacementCurrencyFields(error: CurrencyMismatchError, body: { readonly amount?: unknown; readonly splits?: unknown }) {
  const fields = [
    ...(error.where.amount ? [body.amount === undefined ? 'replacement.financialAccountId' : 'replacement.amount.currency'] : []),
    ...error.where.splitPositions.map((p) =>
      body.splits === undefined ? 'replacement.financialAccountId' : `replacement.splits.${p - 1}.amount.currency`,
    ),
  ];
  return [...new Set(fields)].map((field) => ({ field, code: 'CURRENCY_MISMATCH' }));
}

function sendPage(res: Response, result: TransactionPage): void {
  res.json({ items: result.items.map(toDto), page: result.page, pageSize: result.pageSize, total: result.total });
}

/** `amend` (api-design.md §31.3): only the fields to change, at least one; null clears an optional one. */
const amendBody = z
  .object({
    financialAccountId: z.string().regex(RESOURCE_ID).optional(),
    amount: money.optional(),
    direction: z.enum(DIRECTIONS).optional(),
    bookingDate: businessDate.optional(),
    valueDate: businessDate.nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    propertyReferenceId: z.string().regex(RESOURCE_ID).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'no field to change', params: { code: 'REQUIRED' } });

const ignoreBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
/** `reverse` (api-design.md §35.9): only the reason. */
const reverseBody = ignoreBody;

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
  readonly correct: CorrectTransaction;
  readonly reverse: ReverseTransaction;
  readonly get: GetTransaction;
  readonly list: ListTransactions;
  readonly listForPropertyReference: ListPropertyReferenceTransactions;
  readonly amend: AmendTransaction;
  readonly ignore: IgnoreTransaction;
  readonly restore: RestoreTransaction;
}

/** Transaction API (api-design.md §30–31). */
export function transactionRoutes(commands: TransactionCommands): Router {
  const router = express.Router();

  router.get('/transactions', (req, res, next) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const q = parsed.data;
    commands
      .list({ principal: res.locals['principal'] as RealmPrincipal, filter: listFilter(q), page: { page: q.page, pageSize: q.pageSize } })
      .then((result) => sendPage(res, result))
      .catch(next);
  });

  router.get('/property-references/:propertyReferenceId/transactions', (req, res, next) => {
    const propertyReferenceId = req.params['propertyReferenceId'] ?? '';
    if (!RESOURCE_ID.test(propertyReferenceId)) {
      sendValidationError(res, [{ field: 'propertyReferenceId', code: 'INVALID_FORMAT' }]);
      return;
    }
    const parsed = propertyReferenceListQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const q = parsed.data;
    commands
      .listForPropertyReference({
        principal: res.locals['principal'] as RealmPrincipal,
        propertyReferenceId: propertyReferenceId.toLowerCase(),
        filter: listFilter(q),
        page: { page: q.page, pageSize: q.pageSize },
      })
      .then((result) => sendPage(res, result))
      .catch((error: unknown) => {
        if (error instanceof PropertyReferenceNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'PropertyReference not found.', { propertyReferenceId: propertyReferenceId.toLowerCase() });
        } else {
          next(error);
        }
      });
  });

  router.get('/transactions/:transactionId', (req, res, next) => {
    const id = req.params['transactionId'] ?? '';
    if (!RESOURCE_ID.test(id)) {
      sendValidationError(res, [{ field: 'transactionId', code: 'INVALID_FORMAT' }]);
      return;
    }
    commands
      .get({ principal: res.locals['principal'] as RealmPrincipal, transactionId: id.toLowerCase() })
      .then(({ transaction, splits }) => {
        setVersionTag(res, transaction.version);
        res.json({ ...toDto(transaction), splits: splits.map(toSplitDto) });
      })
      .catch((error: unknown) => {
        if (error instanceof TransactionNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId });
        } else {
          next(error);
        }
      });
  });

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
        setVersionTag(res, transaction.version);
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
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = splitsBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(
        res,
        fieldErrors(parsed.error).map((f) => ({ ...f, code: splitFieldCode(f.field, f.code) })),
      );
      return;
    }
    const splits = parsed.data.splits.map(toSplitInput);

    commands
      .setSplits({
        principal: res.locals['principal'] as RealmPrincipal,
        transactionId: id.toLowerCase(),
        splits,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ transaction, splits: stored }) => {
        setVersionTag(res, transaction.version);
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
          const fields = error.where.splitPositions.map((p) => ({ field: `splits.${p - 1}.amount.currency`, code: 'CURRENCY_MISMATCH' }));
          sendValidationError(res, fields.length > 0 ? fields : [{ field: 'splits', code: 'CURRENCY_MISMATCH' }]);
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
        } else if (error instanceof VersionConflictError) {
          sendVersionConflict(res, error);
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
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    commands
      .confirm({
        principal: res.locals['principal'] as RealmPrincipal,
        transactionId: id.toLowerCase(),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ transaction, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        setVersionTag(res, transaction.version);
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
        } else if (error instanceof VersionConflictError) {
          sendVersionConflict(res, error);
        } else {
          next(error);
        }
      });
  });

  router.post('/transactions/:transactionId/correct', express.json({ limit: '64kb' }), (req, res, next) => {
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const id = req.params['transactionId'] ?? '';
    if (!RESOURCE_ID.test(id)) {
      sendValidationError(res, [{ field: 'transactionId', code: 'INVALID_FORMAT' }]);
      return;
    }
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = correctBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(
        res,
        fieldErrors(parsed.error).map((f) =>
          f.field.startsWith('replacement.splits.') ? { ...f, code: splitFieldCode(f.field, f.code) } : f,
        ),
      );
      return;
    }
    const body = parsed.data.replacement;
    // Omitted keys stay undefined (copy the original's value); explicit null clears it (§35.2).
    const replacement: ReplacementInput = {
      ...(body.financialAccountId === undefined ? {} : { financialAccountId: body.financialAccountId.toLowerCase() }),
      ...(body.amount === undefined ? {} : { amount: body.amount }),
      ...(body.direction === undefined ? {} : { direction: body.direction }),
      ...(body.bookingDate === undefined ? {} : { bookingDate: body.bookingDate }),
      ...(body.valueDate === undefined ? {} : { valueDate: body.valueDate }),
      ...(body.description === undefined ? {} : { description: body.description === '' ? null : body.description }),
      ...(body.propertyReferenceId === undefined ? {} : { propertyReferenceId: body.propertyReferenceId?.toLowerCase() ?? null }),
      ...(body.splits === undefined ? {} : { splits: body.splits.map(toSplitInput) }),
    };

    commands
      .correct({
        principal: res.locals['principal'] as RealmPrincipal,
        transactionId: id.toLowerCase(),
        reason: parsed.data.reason,
        replacement,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ original, reversal, replacement: corrected, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.status(201).json({ original: toDto(original), reversal: toDto(reversal), replacement: corrected === null ? null : toDto(corrected) });
      })
      .catch((error: unknown) => {
        if (error instanceof TransactionNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId });
        } else if (error instanceof FinancialAccountNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'FinancialAccount not found.', { financialAccountId: error.financialAccountId });
        } else if (error instanceof PropertyReferenceNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'PropertyReference not found.', { propertyReferenceId: error.propertyReferenceId });
        } else if (error instanceof TransactionAlreadyCorrectedError) {
          sendError(res, 409, 'CONFLICT', 'Transaction is already corrected.', {
            reason: 'ALREADY_CORRECTED',
            reversalTransactionId: error.reversalTransactionId,
            replacementTransactionId: error.replacementTransactionId,
          });
        } else if (error instanceof TransactionNotCorrectableError) {
          const message =
            error.correctionRole === 'REVERSAL'
              ? 'A reversal cannot be corrected; correct its replacement.'
              : `Transaction is ${error.status} and cannot be corrected.`;
          sendError(res, 409, 'CONFLICT', message, {
            reason: 'NOT_CORRECTABLE',
            status: error.status,
            ...(error.correctionRole === undefined ? {} : { correctionRole: error.correctionRole }),
          });
        } else if (error instanceof CorrectionNoChangeError) {
          sendError(res, 409, 'CONFLICT', 'The replacement equals the original; nothing to correct.', { reason: 'NO_CHANGE' });
        } else if (error instanceof FinancialAccountClosedError) {
          sendError(res, 409, 'CONFLICT', 'The target FinancialAccount is closed.', {
            reason: 'ACCOUNT_CLOSED',
            financialAccountId: error.financialAccountId,
          });
        } else if (error instanceof CurrencyMismatchError) {
          sendValidationError(res, replacementCurrencyFields(error, body));
        } else if (error instanceof FinancialCategoryNotFoundError) {
          const splits = replacement.splits ?? [];
          sendValidationError(
            res,
            splits.flatMap((s, i) =>
              error.codes.includes(s.financialCategoryCode)
                ? [{ field: `replacement.splits.${i}.financialCategoryCode`, code: 'UNKNOWN_CATEGORY' }]
                : [],
            ),
          );
        } else if (error instanceof SplitSumMismatchError) {
          sendError(res, 409, 'INVARIANT_VIOLATION', 'Replacement splits do not add up to its amount.', {
            reason: 'SPLIT_SUM_MISMATCH',
            expected: error.expected.toJSON(),
            actual: error.actual.toJSON(),
            difference: error.expected.subtract(error.actual).toJSON(),
          });
        } else if (error instanceof InactiveCategoryError) {
          sendError(res, 422, 'REVIEW_REQUIRED', 'A copied split uses an inactive financial category; send new splits.', {
            reason: 'INACTIVE_CATEGORY',
            financialCategoryCodes: error.codes,
          });
        } else if (error instanceof IdempotencyKeyConflictError) {
          sendError(res, 409, 'CONFLICT', 'Idempotency-Key was already used with a different payload.');
        } else if (error instanceof VersionConflictError) {
          sendVersionConflict(res, error);
        } else {
          next(error);
        }
      });
  });

  router.post('/transactions/:transactionId/reverse', express.json({ limit: '16kb' }), (req, res, next) => {
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const id = req.params['transactionId'] ?? '';
    if (!RESOURCE_ID.test(id)) {
      sendValidationError(res, [{ field: 'transactionId', code: 'INVALID_FORMAT' }]);
      return;
    }
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = reverseBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .reverse({
        principal: res.locals['principal'] as RealmPrincipal,
        transactionId: id.toLowerCase(),
        reason: parsed.data.reason,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ original, reversal, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.status(201).json({ original: toDto(original), reversal: toDto(reversal), replacement: null });
      })
      .catch((error: unknown) => {
        if (error instanceof TransactionNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId });
        } else if (error instanceof TransactionAlreadyCorrectedError) {
          sendError(res, 409, 'CONFLICT', 'Transaction is already corrected or reversed.', {
            reason: 'ALREADY_CORRECTED',
            reversalTransactionId: error.reversalTransactionId,
            replacementTransactionId: error.replacementTransactionId,
          });
        } else if (error instanceof TransactionNotCorrectableError) {
          const message =
            error.correctionRole === 'REVERSAL'
              ? 'A reversal cannot be reversed; correct or reverse its original’s replacement.'
              : `Transaction is ${error.status} and cannot be reversed.`;
          sendError(res, 409, 'CONFLICT', message, {
            reason: 'NOT_CORRECTABLE',
            status: error.status,
            ...(error.correctionRole === undefined ? {} : { correctionRole: error.correctionRole }),
          });
        } else if (error instanceof IdempotencyKeyConflictError) {
          sendError(res, 409, 'CONFLICT', 'Idempotency-Key was already used with a different payload.');
        } else if (error instanceof VersionConflictError) {
          sendVersionConflict(res, error);
        } else {
          next(error);
        }
      });
  });

  router.post('/transactions/:transactionId/amend', express.json({ limit: '16kb' }), (req, res, next) => {
    const id = req.params['transactionId'] ?? '';
    if (!RESOURCE_ID.test(id)) {
      sendValidationError(res, [{ field: 'transactionId', code: 'INVALID_FORMAT' }]);
      return;
    }
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = amendBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    // Omitted keys stay undefined (keep the value); explicit null clears it.
    const changes: TransactionChanges = {
      ...(body.financialAccountId === undefined ? {} : { financialAccountId: body.financialAccountId.toLowerCase() }),
      ...(body.amount === undefined ? {} : { amount: body.amount }),
      ...(body.direction === undefined ? {} : { direction: body.direction }),
      ...(body.bookingDate === undefined ? {} : { bookingDate: body.bookingDate }),
      ...(body.valueDate === undefined ? {} : { valueDate: body.valueDate }),
      ...(body.description === undefined ? {} : { description: body.description === '' ? null : body.description }),
      ...(body.propertyReferenceId === undefined ? {} : { propertyReferenceId: body.propertyReferenceId?.toLowerCase() ?? null }),
    };
    commands
      .amend({
        principal: res.locals['principal'] as RealmPrincipal,
        transactionId: id.toLowerCase(),
        changes,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ transaction, splitsDropped }) => {
        // The Transaction plus whether a changed amount discarded its split set (§31.3).
        setVersionTag(res, transaction.version);
        res.json({ ...toDto(transaction), splitsDropped });
      })
      .catch((error: unknown) => {
        if (error instanceof TransactionNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId });
        } else if (error instanceof FinancialAccountNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'FinancialAccount not found.', { financialAccountId: error.financialAccountId });
        } else if (error instanceof PropertyReferenceNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'PropertyReference not found.', { propertyReferenceId: error.propertyReferenceId });
        } else if (error instanceof TransactionNotAmendableError) {
          sendError(res, 409, 'CONFLICT', `Transaction is ${error.status} and cannot be amended.`, {
            reason: 'NOT_AMENDABLE',
            status: error.status,
          });
        } else if (error instanceof ImportedFieldsFixedError) {
          sendError(res, 409, 'CONFLICT', 'An imported Transaction keeps the values of its bank row.', {
            reason: 'IMPORTED_FIELDS_FIXED',
            fields: error.fields,
          });
        } else if (error instanceof FinancialAccountClosedError) {
          sendError(res, 409, 'CONFLICT', 'The target FinancialAccount is closed.', {
            reason: 'ACCOUNT_CLOSED',
            financialAccountId: error.financialAccountId,
          });
        } else if (error instanceof CurrencyMismatchError) {
          sendValidationError(res, [{ field: 'amount.currency', code: 'CURRENCY_MISMATCH' }]);
        } else if (error instanceof VersionConflictError) {
          sendVersionConflict(res, error);
        } else {
          next(error);
        }
      });
  });

  router.post('/transactions/:transactionId/ignore', express.json({ limit: '16kb' }), (req, res, next) => {
    const id = req.params['transactionId'] ?? '';
    if (!RESOURCE_ID.test(id)) {
      sendValidationError(res, [{ field: 'transactionId', code: 'INVALID_FORMAT' }]);
      return;
    }
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = ignoreBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .ignore({
        principal: res.locals['principal'] as RealmPrincipal,
        transactionId: id.toLowerCase(),
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ transaction, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        setVersionTag(res, transaction.version);
        res.json(toDto(transaction));
      })
      .catch((error: unknown) => {
        if (error instanceof TransactionNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId });
        } else if (error instanceof TransactionNotIgnorableError) {
          sendError(res, 409, 'CONFLICT', `Transaction is ${error.status} and cannot be ignored; correct it instead.`, {
            reason: 'NOT_IGNORABLE',
            status: error.status,
          });
        } else if (error instanceof VersionConflictError) {
          sendVersionConflict(res, error);
        } else {
          next(error);
        }
      });
  });

  router.post('/transactions/:transactionId/restore', (req, res, next) => {
    const id = req.params['transactionId'] ?? '';
    if (!RESOURCE_ID.test(id)) {
      sendValidationError(res, [{ field: 'transactionId', code: 'INVALID_FORMAT' }]);
      return;
    }
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    commands
      .restore({
        principal: res.locals['principal'] as RealmPrincipal,
        transactionId: id.toLowerCase(),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ transaction }) => {
        setVersionTag(res, transaction.version);
        res.json(toDto(transaction));
      })
      .catch((error: unknown) => {
        if (error instanceof TransactionNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', 'Transaction not found.', { transactionId: error.transactionId });
        } else if (error instanceof TransactionNotIgnoredError) {
          sendError(res, 409, 'CONFLICT', `Transaction is ${error.status}, not IGNORED.`, { reason: 'NOT_IGNORED', status: error.status });
        } else if (error instanceof VersionConflictError) {
          sendVersionConflict(res, error);
        } else {
          next(error);
        }
      });
  });

  return router;
}

/** The Transaction's version as entity tag, for a later `If-Match` (api-design.md §16). */
function setVersionTag(res: Response, version: number): void {
  res.setHeader('ETag', `"${version}"`);
}

/** A stale `If-Match`: 412 Precondition Failed (RFC 9110 §13.2.2), with the versions to compare (§16.1). */
function sendVersionConflict(res: Response, error: VersionConflictError): void {
  sendError(res, 412, 'VERSION_CONFLICT', 'The Transaction changed since the version given in If-Match.', {
    expectedVersions: error.expectedVersions,
    currentVersion: error.currentVersion,
  });
}

function toSplitsDto(transaction: SplitTransaction, splits: readonly TransactionSplit[]) {
  return {
    transactionId: transaction.id,
    amount: transaction.amount.toJSON(),
    direction: transaction.direction,
    status: transaction.status,
    version: transaction.version,
    splits: splits.map(toSplitDto),
  };
}

function toSplitDto(s: TransactionSplit) {
  return {
    splitId: s.id,
    position: s.position,
    amount: s.amount.toJSON(),
    financialCategoryCode: s.financialCategoryCode,
    propertyReferenceId: s.propertyReferenceId,
    description: s.description,
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
    correctionOfTransactionId: transaction.correctionOfTransactionId,
    correctionRole: transaction.correctionRole,
    reversalTransactionId: transaction.reversalTransactionId,
    replacementTransactionId: transaction.replacementTransactionId,
  };
}
