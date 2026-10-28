import express, { type Router } from 'express';
import {
  CurrencyMismatchError,
  FinancialCategoryNotFoundError,
  LoanClosedOnError,
  type TransactionChanges,
  type ReplacementInput,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { RESOURCE_ID, fieldErrors, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';
import {
  toSplitInput,
  correctBody,
  replacementCurrencyFields,
  amendBody,
  ignoreBody,
  reverseBody,
  setVersionTag,
  toDto,
  splitFieldCode,
  sendLoanSplitError,
  sendLoanClosed,
} from './transaction-dto.js';
import type { TransactionCommands } from './transactions.js';

/** Confirm, correct, reverse, amend, ignore and restore a Transaction (api-design.md §31.3–§35.9). */
export function transactionLifecycleRoutes(commands: TransactionCommands): Router {
  const router = express.Router();

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
        principal: principalOf(res),
        transactionId: id.toLowerCase(),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ transaction, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        setVersionTag(res, transaction.version);
        res.json(toDto(transaction));
      })
      .catch(next);
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
        fieldErrors(parsed.error).map((f) => (f.field.startsWith('replacement.splits.') ? { ...f, code: splitFieldCode(f.field, f.code) } : f)),
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
        principal: principalOf(res),
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
        if (sendLoanSplitError(res, error)) return;
        if (error instanceof CurrencyMismatchError) {
          sendValidationError(res, replacementCurrencyFields(error, body));
        } else if (error instanceof FinancialCategoryNotFoundError) {
          const splits = replacement.splits ?? [];
          sendValidationError(
            res,
            splits.flatMap((s, i) =>
              error.codes.includes(s.financialCategoryCode) ? [{ field: `replacement.splits.${i}.financialCategoryCode`, code: 'UNKNOWN_CATEGORY' }] : [],
            ),
          );
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
        principal: principalOf(res),
        transactionId: id.toLowerCase(),
        reason: parsed.data.reason,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ original, reversal, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.status(201).json({ original: toDto(original), reversal: toDto(reversal), replacement: null });
      })
      .catch(next);
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
        principal: principalOf(res),
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
        if (error instanceof CurrencyMismatchError) {
          sendValidationError(res, [{ field: 'amount.currency', code: 'CURRENCY_MISMATCH' }]);
        } else if (error instanceof LoanClosedOnError) {
          sendLoanClosed(res, error);
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
        principal: principalOf(res),
        transactionId: id.toLowerCase(),
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ transaction, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        setVersionTag(res, transaction.version);
        res.json(toDto(transaction));
      })
      .catch(next);
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
        principal: principalOf(res),
        transactionId: id.toLowerCase(),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ transaction }) => {
        setVersionTag(res, transaction.version);
        res.json(toDto(transaction));
      })
      .catch(next);
  });

  return router;
}
