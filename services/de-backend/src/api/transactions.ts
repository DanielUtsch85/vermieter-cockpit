import express, { type Router } from 'express';
import {
  CurrencyMismatchError,
  type ConfirmTransaction,
  type GetTransaction,
  type ListTransactions,
  type ListPropertyReferenceTransactions,
  type CorrectTransaction,
  type ReverseTransaction,
  type AmendTransaction,
  type IgnoreTransaction,
  type RestoreTransaction,
  type CreateManualTransaction,
  type SetTransactionSplits,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { NO_QUERY, readBody, readIdempotencyKey, readQuery, refuseQuery, RESOURCE_ID, sendValidationError } from './validation.js';
import { createBody, listQuery, propertyReferenceListQuery, listFilter, sendPage, setVersionTag, toSplitDto, toDto } from './transaction-dto.js';
import { transactionLifecycleRoutes } from './transaction-lifecycle.js';
import { transactionSplitRoutes } from './transaction-splits.js';

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
    const parsed = readQuery(listQuery, req);
    if (refuseQuery(res, parsed)) return;
    const q = parsed.data;
    commands
      .list({ principal: principalOf(res), filter: listFilter(q), page: { page: q.page, pageSize: q.pageSize } })
      .then((result) => sendPage(res, result))
      .catch(next);
  });

  router.get('/property-references/:propertyReferenceId/transactions', (req, res, next) => {
    const parsed = readQuery(propertyReferenceListQuery, req);
    const propertyReferenceId = req.params['propertyReferenceId'] ?? '';
    if (!RESOURCE_ID.test(propertyReferenceId)) {
      sendValidationError(res, [{ field: 'propertyReferenceId', code: 'INVALID_FORMAT' }]);
      return;
    }
    if (refuseQuery(res, parsed)) return;
    const q = parsed.data;
    commands
      .listForPropertyReference({
        principal: principalOf(res),
        propertyReferenceId: propertyReferenceId.toLowerCase(),
        filter: listFilter(q),
        page: { page: q.page, pageSize: q.pageSize },
      })
      .then((result) => sendPage(res, result))
      .catch(next);
  });

  router.get('/transactions/:transactionId', (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const id = req.params['transactionId'] ?? '';
    if (!RESOURCE_ID.test(id)) {
      sendValidationError(res, [{ field: 'transactionId', code: 'INVALID_FORMAT' }]);
      return;
    }
    if (refuseQuery(res, query)) return;
    commands
      .get({ principal: principalOf(res), transactionId: id.toLowerCase() })
      .then(({ transaction, splits }) => {
        setVersionTag(res, transaction.version);
        res.json({ ...toDto(transaction), splits: splits.map(toSplitDto) });
      })
      .catch(next);
  });

  router.post('/transactions', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = readBody(createBody, req);
    if (!parsed.ok) {
      sendValidationError(
        res,
        parsed.errors.map((f) => (f.field === 'rentalContractReferenceId' ? { ...f, code: 'NOT_SUPPORTED' } : f)),
      );
      return;
    }
    const body = parsed.data;

    commands
      .createManual({
        principal: principalOf(res),
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
        if (error instanceof CurrencyMismatchError) {
          sendValidationError(res, [{ field: 'amount.currency', code: 'CURRENCY_MISMATCH' }]);
        } else {
          next(error);
        }
      });
  });

  // Splits (§33) and the lifecycle commands (§31.3–§35.9), mounted after the reads and create, as before.
  router.use(transactionSplitRoutes(commands));
  router.use(transactionLifecycleRoutes(commands));
  return router;
}
