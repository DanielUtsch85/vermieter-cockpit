import express, { type Router } from 'express';
import { z } from 'zod';
import { CurrencyMismatchError, FinancialCategoryNotFoundError, type SplitTransaction, type TransactionSplit } from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { RESOURCE_ID, fieldErrors, readIfMatch, sendValidationError } from './validation.js';
import { split, toSplitInput, setVersionTag, toSplitDto, splitFieldCode, sendLoanSplitError } from './transaction-dto.js';
import type { TransactionCommands } from './transactions.js';

const splitsBody = z.object({ splits: z.array(split).min(1).max(100) }).strict();

/** A stale `If-Match`: 412 Precondition Failed (RFC 9110 §13.2.2), with the versions to compare (§16.1). */
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

/** Splits of a Transaction (api-design.md §33, VC-1-07). */
export function transactionSplitRoutes(commands: TransactionCommands): Router {
  const router = express.Router();

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
        principal: principalOf(res),
        transactionId: id.toLowerCase(),
        splits,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ transaction, splits: stored }) => {
        setVersionTag(res, transaction.version);
        res.json(toSplitsDto(transaction, stored));
      })
      .catch((error: unknown) => {
        if (sendLoanSplitError(res, error)) return;
        if (error instanceof FinancialCategoryNotFoundError) {
          sendValidationError(
            res,
            splits.flatMap((s, i) =>
              error.codes.includes(s.financialCategoryCode) ? [{ field: `splits.${i}.financialCategoryCode`, code: 'UNKNOWN_CATEGORY' }] : [],
            ),
          );
        } else if (error instanceof CurrencyMismatchError) {
          const fields = error.where.splitPositions.map((p) => ({ field: `splits.${p - 1}.amount.currency`, code: 'CURRENCY_MISMATCH' }));
          sendValidationError(res, fields.length > 0 ? fields : [{ field: 'splits', code: 'CURRENCY_MISMATCH' }]);
        } else {
          next(error);
        }
      });
  });

  return router;
}
