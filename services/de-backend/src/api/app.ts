import express, { type Express } from 'express';
import type {
  CloseFinancialAccount,
  CreateFinancialAccount,
  ConfirmTransaction,
  CorrectTransaction,
  GetTransaction,
  ListTransactions,
  AmendTransaction,
  IgnoreTransaction,
  RestoreTransaction,
  CreateManualTransaction,
  GetFinancialCategory,
  GetImportBatch,
  ImportBankStatement,
  ListFinancialCategories,
  ListReviewItems,
  LinkPropertyReference,
  PrincipalVerifier,
  RealmPrincipal,
  RefreshPropertyReference,
  ResolveReviewItem,
  SetTransactionSplits,
} from '../application/index.js';
import { requireDeAccess } from './access-middleware.js';
import { errorHandler } from './errors.js';
import { financialAccountRoutes } from './financial-accounts.js';
import { financialCategoryRoutes } from './financial-categories.js';
import { importRoutes } from './imports.js';
import { propertyReferenceRoutes } from './property-references.js';
import { transactionRoutes } from './transactions.js';

/**
 * HTTP application (ADR-026, api-design.md). Infrastructure is injected by the
 * composition root (`main.ts`), so the API layer never imports adapters directly.
 */
export interface AppDependencies {
  /** Resolves true when the DE backend can serve requests (e.g. PostgreSQL reachable). */
  readonly isReady: () => Promise<boolean>;
  /** Verifies MRE identity and Realm membership (VC-0-08). */
  readonly verifyPrincipal: PrincipalVerifier;
  /** Link Property command (VC-1-01). */
  readonly linkPropertyReference: LinkPropertyReference;
  /** Refresh command (VC-1-02). */
  readonly refreshPropertyReference: RefreshPropertyReference;
  /** FinancialAccount commands (VC-1-03). */
  readonly createFinancialAccount: CreateFinancialAccount;
  readonly closeFinancialAccount: CloseFinancialAccount;
  /** Manual Transaction (VC-1-04). */
  readonly createManualTransaction: CreateManualTransaction;
  /** Confirm (VC-1-08). */
  readonly confirmTransaction: ConfirmTransaction;
  /** Correct a confirmed Transaction (VC-1-11). */
  readonly correctTransaction: CorrectTransaction;
  /** Read Transactions (VC-X-21). */
  readonly getTransaction: GetTransaction;
  readonly listTransactions: ListTransactions;
  /** Amend, ignore and restore an unconfirmed Transaction (VC-X-16). */
  readonly amendTransaction: AmendTransaction;
  readonly ignoreTransaction: IgnoreTransaction;
  readonly restoreTransaction: RestoreTransaction;
  /** Splits and categories (VC-1-07). */
  readonly setTransactionSplits: SetTransactionSplits;
  readonly listFinancialCategories: ListFinancialCategories;
  readonly getFinancialCategory: GetFinancialCategory;
  /** Bank import (VC-1-05/06). */
  readonly importBankStatement: ImportBankStatement;
  readonly getImportBatch: GetImportBatch;
  /** Review items (VC-1-06a). */
  readonly listReviewItems: ListReviewItems;
  readonly resolveReviewItem: ResolveReviewItem;
}

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  // Liveness: the process is up. Unauthenticated and free of data, for orchestrators.
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: dependencies are reachable. A failing or throwing check is "not ready".
  app.get('/health/ready', (_req, res) => {
    deps
      .isReady()
      .catch(() => false)
      .then((ready) => {
        res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable' });
      });
  });

  // Business API: every route below requires a verified principal with DE access.
  const api = express.Router();
  api.use(requireDeAccess(deps.verifyPrincipal));
  api.get('/health', (_req, res) => {
    const principal = res.locals['principal'] as RealmPrincipal;
    res.json({ status: 'ok', mreRealmId: principal.mreRealmId });
  });
  api.use(propertyReferenceRoutes({ link: deps.linkPropertyReference, refresh: deps.refreshPropertyReference }));
  api.use(financialAccountRoutes({ create: deps.createFinancialAccount, close: deps.closeFinancialAccount }));
  api.use(
    transactionRoutes({
      createManual: deps.createManualTransaction,
      setSplits: deps.setTransactionSplits,
      confirm: deps.confirmTransaction,
      correct: deps.correctTransaction,
      get: deps.getTransaction,
      list: deps.listTransactions,
      amend: deps.amendTransaction,
      ignore: deps.ignoreTransaction,
      restore: deps.restoreTransaction,
    }),
  );
  api.use(
    importRoutes({
      importStatement: deps.importBankStatement,
      getBatch: deps.getImportBatch,
      listReviewItems: deps.listReviewItems,
      resolveReviewItem: deps.resolveReviewItem,
    }),
  );
  api.use(financialCategoryRoutes({ list: deps.listFinancialCategories, get: deps.getFinancialCategory }));
  app.use('/api/v1', api);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
  app.use(errorHandler);

  return app;
}
