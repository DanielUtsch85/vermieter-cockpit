import express, { type Express } from 'express';
import type {
  CloseFinancialAccount,
  CreateFinancialAccount,
  ConfirmTransaction,
  CorrectTransaction,
  ReverseTransaction,
  GetTransaction,
  ListTransactions,
  ListPropertyReferenceTransactions,
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
  AmendParty,
  CancelAcquisition,
  ConfirmAcquisition,
  CreateLandBuildingAllocation,
  GetOwnerAllocation,
  ListLandBuildingAllocations,
  CreateAcquisitionCost,
  VoidAcquisitionCost,
  ListAcquisitionCosts,
  LinkAcquisitionPayment,
  UnlinkAcquisitionPayment,
  ListAcquisitionPayments,
  AmendLoan,
  CloseLoan,
  CreateReconciliation,
  GetReconciliation,
  GetTermCoverage,
  ConfirmReconciliation,
  RejectReconciliation,
  SuggestReconciliations,
  GetTransactionCoverage,
  ListReconciliations,
  ReleaseReconciliation,
  CreateLoan,
  GetLoan,
  ListLoans,
  VoidLoan,
  CreateBalanceStatement,
  CreateLoanTerms,
  GetLoanPayments,
  GetRemainingDebt,
  ListBalanceStatements,
  ListLoanTerms,
  VoidBalanceStatement,
  VoidLoanTerms,
  GetLoanSchedule,
  GetPaymentProposal,
  CreateLoanAllocation,
  GetLoanAllocationOn,
  ListLoanAllocations,
  ListPropertyLoans,
  VoidLoanAllocation,
  CreateAcquisition,
  GetAcquisition,
  ListAcquisitions,
  ListPropertyAcquisitions,
  ChangeOwnership,
  CloseOwnership,
  CreateOwnership,
  GetOwnership,
  ReadPropertyOwnerships,
  VoidOwnership,
  CreateExternalReference,
  EndExternalReference,
  ListExternalReferences,
  CreateParty,
  DeactivateParty,
  GetParty,
  ListParties,
} from '../application/index.js';
import { requireDeAccess } from './access-middleware.js';
import { errorHandler } from './errors.js';
import { financialAccountRoutes } from './financial-accounts.js';
import { financialCategoryRoutes } from './financial-categories.js';
import { importRoutes } from './imports.js';
import { partyRoutes } from './parties.js';
import { externalReferenceRoutes } from './party-external-references.js';
import { ownershipRoutes } from './ownerships.js';
import { acquisitionCostRoutes } from './acquisition-costs.js';
import { acquisitionRoutes } from './acquisitions.js';
import { landBuildingAllocationRoutes } from './land-building-allocations.js';
import { loanAllocationRoutes } from './loan-allocations.js';
import { loanDebtRoutes } from './loan-debt.js';
import { loanTermsRoutes } from './loan-terms.js';
import { loanRoutes } from './loans.js';
import { rentReconciliationRoutes } from './rent-reconciliations.js';
import { ownerAllocationRoutes } from './owner-allocation.js';
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
  /** Party commands and reads (VC-2-01). */
  readonly createParty: CreateParty;
  readonly getParty: GetParty;
  readonly listParties: ListParties;
  readonly amendParty: AmendParty;
  readonly deactivateParty: DeactivateParty;
  /** Party external references (VC-2-02). */
  readonly createExternalReference: CreateExternalReference;
  readonly endExternalReference: EndExternalReference;
  readonly listExternalReferences: ListExternalReferences;
  /** Ownership (VC-2-03). */
  readonly createOwnership: CreateOwnership;
  readonly getOwnership: GetOwnership;
  readonly closeOwnership: CloseOwnership;
  readonly voidOwnership: VoidOwnership;
  readonly readPropertyOwnerships: ReadPropertyOwnerships;
  /** Ownership change (VC-2-04). */
  readonly changeOwnership: ChangeOwnership;
  /** Acquisition (VC-2-05). */
  readonly createAcquisition: CreateAcquisition;
  readonly getAcquisition: GetAcquisition;
  readonly listAcquisitions: ListAcquisitions;
  readonly listPropertyAcquisitions: ListPropertyAcquisitions;
  readonly cancelAcquisition: CancelAcquisition;
  readonly confirmAcquisition: ConfirmAcquisition;
  /** Land/building allocation (VC-2-08). */
  readonly createLandBuildingAllocation: CreateLandBuildingAllocation;
  readonly listLandBuildingAllocations: ListLandBuildingAllocations;
  /** Owner-level allocation (VC-2-09). */
  readonly getOwnerAllocation: GetOwnerAllocation;
  /** Acquisition costs and payment links (VC-2-06). */
  readonly createAcquisitionCost: CreateAcquisitionCost;
  readonly voidAcquisitionCost: VoidAcquisitionCost;
  readonly listAcquisitionCosts: ListAcquisitionCosts;
  readonly linkAcquisitionPayment: LinkAcquisitionPayment;
  readonly unlinkAcquisitionPayment: UnlinkAcquisitionPayment;
  readonly listAcquisitionPayments: ListAcquisitionPayments;
  /** Loan (VC-3-01). */
  readonly createLoan: CreateLoan;
  readonly getLoan: GetLoan;
  readonly listLoans: ListLoans;
  readonly amendLoan: AmendLoan;
  readonly voidLoan: VoidLoan;
  /** Close a Loan (VC-3-07). */
  readonly closeLoan: CloseLoan;
  /** Rent reconciliation (VC-4-01). */
  readonly createReconciliation: CreateReconciliation;
  readonly getReconciliation: GetReconciliation;
  readonly listReconciliations: ListReconciliations;
  readonly releaseReconciliation: ReleaseReconciliation;
  /** Coverage reads (VC-4-02). */
  readonly getTermCoverage: GetTermCoverage;
  readonly getTransactionCoverage: GetTransactionCoverage;
  /** Suggestions (VC-4-03). */
  readonly suggestReconciliations: SuggestReconciliations;
  readonly confirmReconciliation: ConfirmReconciliation;
  readonly rejectReconciliation: RejectReconciliation;
  /** Loan terms (VC-3-02). */
  readonly createLoanTerms: CreateLoanTerms;
  readonly voidLoanTerms: VoidLoanTerms;
  readonly listLoanTerms: ListLoanTerms;
  /** Loan schedule, derived (VC-3-04). */
  readonly getLoanSchedule: GetLoanSchedule;
  /** Loan payment proposal (VC-3-05). */
  readonly getPaymentProposal: GetPaymentProposal;
  /** Remaining debt, payments and lender statements (VC-3-06). */
  readonly getRemainingDebt: GetRemainingDebt;
  readonly getLoanPayments: GetLoanPayments;
  readonly createBalanceStatement: CreateBalanceStatement;
  readonly voidBalanceStatement: VoidBalanceStatement;
  readonly listBalanceStatements: ListBalanceStatements;
  /** Loan allocation sets (VC-3-03). */
  readonly createLoanAllocation: CreateLoanAllocation;
  readonly voidLoanAllocation: VoidLoanAllocation;
  readonly listLoanAllocations: ListLoanAllocations;
  readonly getLoanAllocationOn: GetLoanAllocationOn;
  readonly listPropertyLoans: ListPropertyLoans;
  /** FinancialAccount commands (VC-1-03). */
  readonly createFinancialAccount: CreateFinancialAccount;
  readonly closeFinancialAccount: CloseFinancialAccount;
  /** Manual Transaction (VC-1-04). */
  readonly createManualTransaction: CreateManualTransaction;
  /** Confirm (VC-1-08). */
  readonly confirmTransaction: ConfirmTransaction;
  /** Correct a confirmed Transaction (VC-1-11). */
  readonly correctTransaction: CorrectTransaction;
  /** Reverse without a replacement (VC-X-15). */
  readonly reverseTransaction: ReverseTransaction;
  /** Read Transactions (VC-X-21). */
  readonly getTransaction: GetTransaction;
  readonly listTransactions: ListTransactions;
  readonly listPropertyReferenceTransactions: ListPropertyReferenceTransactions;
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
  api.use(
    partyRoutes({
      create: deps.createParty,
      get: deps.getParty,
      list: deps.listParties,
      amend: deps.amendParty,
      deactivate: deps.deactivateParty,
    }),
  );
  api.use(
    externalReferenceRoutes({
      create: deps.createExternalReference,
      end: deps.endExternalReference,
      list: deps.listExternalReferences,
    }),
  );
  api.use(
    ownershipRoutes({
      create: deps.createOwnership,
      get: deps.getOwnership,
      close: deps.closeOwnership,
      void: deps.voidOwnership,
      read: deps.readPropertyOwnerships,
      change: deps.changeOwnership,
    }),
  );
  api.use(
    acquisitionRoutes({
      create: deps.createAcquisition,
      get: deps.getAcquisition,
      list: deps.listAcquisitions,
      listForPropertyReference: deps.listPropertyAcquisitions,
      cancel: deps.cancelAcquisition,
      confirm: deps.confirmAcquisition,
    }),
  );
  api.use(ownerAllocationRoutes({ get: deps.getOwnerAllocation }));
  api.use(landBuildingAllocationRoutes({ create: deps.createLandBuildingAllocation, list: deps.listLandBuildingAllocations }));
  api.use(
    acquisitionCostRoutes({
      createCost: deps.createAcquisitionCost,
      voidCost: deps.voidAcquisitionCost,
      listCosts: deps.listAcquisitionCosts,
      linkPayment: deps.linkAcquisitionPayment,
      unlinkPayment: deps.unlinkAcquisitionPayment,
      listPayments: deps.listAcquisitionPayments,
    }),
  );
  api.use(loanRoutes({ create: deps.createLoan, get: deps.getLoan, list: deps.listLoans, amend: deps.amendLoan, void: deps.voidLoan, close: deps.closeLoan }));
  api.use(
    rentReconciliationRoutes({
      create: deps.createReconciliation,
      get: deps.getReconciliation,
      list: deps.listReconciliations,
      release: deps.releaseReconciliation,
      termCoverage: deps.getTermCoverage,
      transactionCoverage: deps.getTransactionCoverage,
      suggest: deps.suggestReconciliations,
      confirm: deps.confirmReconciliation,
      reject: deps.rejectReconciliation,
    }),
  );
  api.use(loanTermsRoutes({ create: deps.createLoanTerms, void: deps.voidLoanTerms, list: deps.listLoanTerms, schedule: deps.getLoanSchedule, proposal: deps.getPaymentProposal }));
  api.use(
    loanDebtRoutes({
      remainingDebt: deps.getRemainingDebt,
      payments: deps.getLoanPayments,
      createStatement: deps.createBalanceStatement,
      voidStatement: deps.voidBalanceStatement,
      listStatements: deps.listBalanceStatements,
    }),
  );
  api.use(
    loanAllocationRoutes({
      create: deps.createLoanAllocation,
      void: deps.voidLoanAllocation,
      list: deps.listLoanAllocations,
      on: deps.getLoanAllocationOn,
      propertyLoans: deps.listPropertyLoans,
    }),
  );
  api.use(financialAccountRoutes({ create: deps.createFinancialAccount, close: deps.closeFinancialAccount }));
  api.use(
    transactionRoutes({
      createManual: deps.createManualTransaction,
      setSplits: deps.setTransactionSplits,
      confirm: deps.confirmTransaction,
      correct: deps.correctTransaction,
      reverse: deps.reverseTransaction,
      get: deps.getTransaction,
      list: deps.listTransactions,
      listForPropertyReference: deps.listPropertyReferenceTransactions,
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
