import express, { type Express } from 'express';
import type { PrincipalVerifier } from '../application/index.js';
import { principalOf, requireDeAccess } from './access-middleware.js';
import { acquisitionCostRoutes, type AcquisitionCostCommands } from './acquisition-costs.js';
import { acquisitionRoutes, type AcquisitionCommands } from './acquisitions.js';
import { errorHandler } from './errors.js';
import { financialAccountRoutes, type FinancialAccountCommands } from './financial-accounts.js';
import { financialCategoryRoutes, type FinancialCategoryQueries } from './financial-categories.js';
import { importRoutes, type ImportCommands } from './imports.js';
import { landBuildingAllocationRoutes, type LandBuildingAllocationCommands } from './land-building-allocations.js';
import { loanAllocationRoutes, type LoanAllocationCommands } from './loan-allocations.js';
import { loanDebtRoutes, type LoanDebtCommands } from './loan-debt.js';
import { loanTermsRoutes, type LoanTermsCommands } from './loan-terms.js';
import { loanRoutes, type LoanCommands } from './loans.js';
import { securityDepositRoutes, type SecurityDepositCommands } from './security-deposits.js';
import { ownerAllocationRoutes, type OwnerAllocationCommands } from './owner-allocation.js';
import { ownershipRoutes, type OwnershipCommands } from './ownerships.js';
import { partyRoutes, type PartyCommands } from './parties.js';
import { externalReferenceRoutes, type ExternalReferenceCommands } from './party-external-references.js';
import { propertyReferenceRoutes, type PropertyReferenceCommands } from './property-references.js';
import { rentReconciliationRoutes, type RentReconciliationCommands } from './rent-reconciliations.js';
import { transactionRoutes, type TransactionCommands } from './transactions.js';
import { wegEconomicPlanRoutes, type WegEconomicPlanCommands } from './weg-economic-plans.js';
import { wegRoutes, type WegCommands } from './wegs.js';

/**
 * HTTP application (ADR-026, api-design.md). Infrastructure is injected by the
 * composition root (`main.ts`), so the API layer never imports adapters directly.
 *
 * The commands come grouped per module, each group typed by its route factory's own interface: a new operation of a
 * module that is already wired changes that interface, its routes and `main.ts`, never this file (#89).
 */
export interface AppCommands {
  /** Property references (VC-1-01, VC-1-02). */
  readonly propertyReferences: PropertyReferenceCommands;
  /** Parties (VC-2-01). */
  readonly parties: PartyCommands;
  /** Party external references (VC-2-02). */
  readonly externalReferences: ExternalReferenceCommands;
  /** Ownership and its changes (VC-2-03, VC-2-04). */
  readonly ownerships: OwnershipCommands;
  /** Acquisitions (VC-2-05, VC-2-07). */
  readonly acquisitions: AcquisitionCommands;
  /** Owner-level allocation (VC-2-09). */
  readonly ownerAllocation: OwnerAllocationCommands;
  /** Land/building allocation (VC-2-08). */
  readonly landBuildingAllocations: LandBuildingAllocationCommands;
  /** Acquisition costs and payment links (VC-2-06). */
  readonly acquisitionCosts: AcquisitionCostCommands;
  /** Loans, including closing (VC-3-01, VC-3-07). */
  readonly loans: LoanCommands;
  readonly securityDeposits: SecurityDepositCommands;
  /** WEG and membership (VC-6-01). */
  readonly wegs: WegCommands;
  /** Wirtschaftsplan and Hausgeld proposal (VC-6-02). */
  readonly wegEconomicPlans: WegEconomicPlanCommands;
  /** Rent reconciliation, coverage, suggestions, write-back and removal (VC-4-01 … VC-4-05). */
  readonly rentReconciliations: RentReconciliationCommands;
  /** Loan terms, schedule and payment proposal (VC-3-02, VC-3-04, VC-3-05). */
  readonly loanTerms: LoanTermsCommands;
  /** Remaining debt, payments and lender statements (VC-3-06). */
  readonly loanDebt: LoanDebtCommands;
  /** Loan allocation sets (VC-3-03). */
  readonly loanAllocations: LoanAllocationCommands;
  /** FinancialAccounts (VC-1-03). */
  readonly financialAccounts: FinancialAccountCommands;
  /** Transactions: create, read, splits, confirm, correct, reverse, amend, ignore, restore (VC-1-04 … VC-X-21). */
  readonly transactions: TransactionCommands;
  /** Bank import and its review items (VC-1-05, VC-1-06, VC-1-06a). */
  readonly imports: ImportCommands;
  /** Financial categories, read-only (VC-1-07). */
  readonly financialCategories: FinancialCategoryQueries;
}

export interface AppDependencies extends AppCommands {
  /** Resolves true when the DE backend can serve requests (e.g. PostgreSQL reachable). */
  readonly isReady: () => Promise<boolean>;
  /** Verifies MRE identity and Realm membership (VC-0-08). */
  readonly verifyPrincipal: PrincipalVerifier;
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
    void deps
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
    const principal = principalOf(res);
    res.json({ status: 'ok', mreRealmId: principal.mreRealmId });
  });
  api.use(propertyReferenceRoutes(deps.propertyReferences));
  api.use(partyRoutes(deps.parties));
  api.use(externalReferenceRoutes(deps.externalReferences));
  api.use(ownershipRoutes(deps.ownerships));
  api.use(acquisitionRoutes(deps.acquisitions));
  api.use(ownerAllocationRoutes(deps.ownerAllocation));
  api.use(landBuildingAllocationRoutes(deps.landBuildingAllocations));
  api.use(acquisitionCostRoutes(deps.acquisitionCosts));
  api.use(loanRoutes(deps.loans));
  api.use(securityDepositRoutes(deps.securityDeposits));
  api.use(wegRoutes(deps.wegs));
  api.use(wegEconomicPlanRoutes(deps.wegEconomicPlans));
  api.use(rentReconciliationRoutes(deps.rentReconciliations));
  api.use(loanTermsRoutes(deps.loanTerms));
  api.use(loanDebtRoutes(deps.loanDebt));
  api.use(loanAllocationRoutes(deps.loanAllocations));
  api.use(financialAccountRoutes(deps.financialAccounts));
  api.use(transactionRoutes(deps.transactions));
  api.use(importRoutes(deps.imports));
  api.use(financialCategoryRoutes(deps.financialCategories));
  app.use('/api/v1', api);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
  app.use(errorHandler);

  return app;
}
