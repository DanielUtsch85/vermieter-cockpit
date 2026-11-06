import type { AcquisitionCost, AcquisitionCostRepository, AcquisitionPayment, AcquisitionRepository, Acquisition } from '../domains/acquisition/index.js';
import type { LandBuildingAllocation, LandBuildingAllocationRepository } from '../domains/acquisition/index.js';
import {
  statementViews,
  type Loan,
  type LoanAllocationRepository,
  type LoanAllocationSetView,
  type LoanDebtRepository,
  type LoanRepository,
  type LoanTermsRepository,
  type LoanTermsView,
  type StatementView,
} from '../domains/financing/index.js';
import type { TransactionExportQueries, TransactionExportSink, TransactionFilter } from '../domains/ledger/index.js';
import type { Ownership, OwnershipRepository } from '../domains/ownership/index.js';
import type { Party, PartyRepository } from '../domains/party/index.js';
import type { PropertyReference, PropertyReferenceRepository } from '../domains/property-reference/index.js';
import type { DepositView, SecurityDepositRepository } from '../domains/security-deposit/index.js';
import type { Weg, WegMembership, WegRepository } from '../domains/weg/index.js';
import type { RealmPrincipal } from './access.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';

/**
 * Data export (api-design.md §58S, VC-X-04): the Kassenbuch as CSV rows and one PropertyReference with its records as
 * one document. Both only read, in one snapshot of the caller's Realm, from the existing reads; no figure is new.
 */

/** Above the limit (§58S open question 11): `409 EXPORT_TOO_LARGE`, before the first byte. */
export class ExportTooLargeError extends Error {
  override readonly name = 'ExportTooLargeError';

  constructor(
    readonly total: number,
    readonly limit: number,
  ) {
    super(`The export holds ${total} records; the limit is ${limit}.`);
  }
}

/** §58S: at most 100,000 Transactions in one CSV, read 500 at a time; at most 10,000 records in one property file. */
export const TRANSACTION_EXPORT_LIMIT = 100_000;
export const TRANSACTION_EXPORT_BATCH_SIZE = 500;
export const PROPERTY_EXPORT_LIMIT = 10_000;

export type ExportTransactions = (input: {
  readonly principal: RealmPrincipal;
  readonly filter: TransactionFilter;
  /** `rows=splits`: the sink's head carries the row count too. */
  readonly withSplits: boolean;
  readonly sink: TransactionExportSink;
}) => Promise<void>;

/** `GET /exports/transactions.csv`: the count is checked against the limit in the snapshot, before the sink's head. */
export function exportTransactions(deps: {
  readonly queries: TransactionExportQueries;
  readonly limit?: number;
  readonly batchSize?: number;
}): ExportTransactions {
  const limit = deps.limit ?? TRANSACTION_EXPORT_LIMIT;
  const batchSize = deps.batchSize ?? TRANSACTION_EXPORT_BATCH_SIZE;
  return ({ principal, filter, withSplits, sink }) =>
    deps.queries.exportAll(
      principal.mreRealmId,
      filter,
      { batchSize, countRows: withSplits },
      {
        begin: (head) => {
          if (head.transactionCount > limit) throw new ExportTooLargeError(head.transactionCount, limit);
          return sink.begin(head);
        },
        batch: (items) => sink.batch(items),
      },
    );
}

/** The reads of the property export, all on one snapshot: the single reads' repositories and P's id lists. */
export interface PropertyExportReads {
  readonly propertyReferences: Pick<PropertyReferenceRepository, 'findById'>;
  readonly ownerships: Pick<OwnershipRepository, 'history'>;
  readonly acquisitions: Pick<AcquisitionRepository, 'findById'>;
  readonly acquisitionCosts: Pick<AcquisitionCostRepository, 'listCosts' | 'listPayments'>;
  readonly landBuildingAllocations: Pick<LandBuildingAllocationRepository, 'list'>;
  readonly loans: Pick<LoanRepository, 'findById'>;
  readonly loanTerms: Pick<LoanTermsRepository, 'list'>;
  readonly loanAllocations: Pick<LoanAllocationRepository, 'list'>;
  readonly loanDebt: Pick<LoanDebtRepository, 'debtInputs'>;
  readonly wegs: Pick<WegRepository, 'findWeg' | 'findMembership'>;
  readonly securityDeposits: Pick<SecurityDepositRepository, 'findById'>;
  readonly parties: Pick<PartyRepository, 'findById'>;
  readonly scope: {
    acquisitionIds(propertyReferenceId: string, mreRealmId: string): Promise<readonly string[]>;
    loanIds(propertyReferenceId: string, mreRealmId: string): Promise<readonly string[]>;
    membershipIds(propertyReferenceId: string, mreRealmId: string): Promise<readonly string[]>;
    deposits(
      propertyReferenceId: string,
      mreRealmId: string,
    ): Promise<{
      readonly attributed: readonly string[];
      readonly severalCandidates: readonly { readonly securityDepositId: string; readonly candidates: readonly string[] }[];
    }>;
  };
}

/** Opens one `REPEATABLE READ READ ONLY` snapshot; `generatedAt` is its start as the server clock reads it. */
export interface PropertyExportSnapshots {
  read<T>(callback: (reads: PropertyExportReads, generatedAt: Date) => Promise<T>): Promise<T>;
}

export interface PropertyExportAcquisition {
  readonly acquisition: Acquisition;
  readonly costs: readonly AcquisitionCost[];
  readonly payments: readonly AcquisitionPayment[];
  readonly landBuildingAllocations: readonly LandBuildingAllocation[];
}

export interface PropertyExportLoan {
  readonly loan: Loan;
  readonly terms: readonly LoanTermsView[];
  readonly allocationSets: readonly LoanAllocationSetView[];
  readonly balanceStatements: readonly StatementView[];
}

/** Format version 1 of `GET /property-references/{id}/export.json` (§58S "Schema"), as domain values. */
export interface PropertyExport {
  readonly generatedAt: Date;
  readonly mreRealmId: string;
  readonly propertyReference: PropertyReference;
  readonly ownerships: readonly Ownership[];
  readonly acquisitions: readonly PropertyExportAcquisition[];
  readonly loans: readonly PropertyExportLoan[];
  readonly wegMemberships: readonly { readonly membership: WegMembership; readonly weg: Weg }[];
  readonly securityDeposits: readonly DepositView[];
  readonly securityDepositsNotAttributed: readonly {
    readonly securityDepositId: string;
    readonly reason: 'SEVERAL_PROPERTY_REFERENCES';
    readonly candidates: readonly string[];
  }[];
  readonly parties: readonly Party[];
}

export type ExportProperty = (input: { readonly principal: RealmPrincipal; readonly propertyReferenceId: string }) => Promise<PropertyExport>;

/** A record the snapshot named must be there: the reads are of one snapshot, in the Realm. */
function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`property export: ${what} vanished inside its snapshot`);
  return value;
}

/** Every record of the document, over all collections (§58S "Size"). */
function recordCount(doc: Omit<PropertyExport, 'generatedAt' | 'mreRealmId'>): number {
  const acquisitions = doc.acquisitions.reduce((n, a) => n + 1 + a.costs.length + a.payments.length + a.landBuildingAllocations.length, 0);
  const loans = doc.loans.reduce((n, l) => n + 1 + l.terms.length + l.allocationSets.length + l.balanceStatements.length, 0);
  return (
    1 +
    doc.ownerships.length +
    acquisitions +
    loans +
    2 * doc.wegMemberships.length +
    doc.securityDeposits.length +
    doc.securityDepositsNotAttributed.length +
    doc.parties.length
  );
}

/**
 * `GET /property-references/{id}/export.json` (§58S): P with its Ownerships, Acquisitions, Loans, WEG memberships and
 * deposits in every status, and the Parties they name, each as its single read gives it. An unknown or foreign P is
 * `PropertyReferenceNotFoundError` (404); above the limit `ExportTooLargeError`.
 */
export function exportProperty(deps: { readonly snapshots: PropertyExportSnapshots; readonly limit?: number }): ExportProperty {
  const limit = deps.limit ?? PROPERTY_EXPORT_LIMIT;
  return ({ principal, propertyReferenceId }) =>
    deps.snapshots.read(async (reads, generatedAt) => {
      const realm = principal.mreRealmId;
      const propertyReference = await reads.propertyReferences.findById(propertyReferenceId, realm);
      if (propertyReference === undefined) throw new PropertyReferenceNotFoundError(propertyReferenceId);
      const p = propertyReference.id;

      // §26.1's history read: every Ownership, `VOID` included, by valid from, creation, id; one page past the limit.
      const history = present(await reads.ownerships.history(p, realm, { page: 1, pageSize: limit + 1 }), 'the PropertyReference');
      if (history.total > limit) throw new ExportTooLargeError(history.total, limit);

      const acquisitions: PropertyExportAcquisition[] = [];
      for (const id of await reads.scope.acquisitionIds(p, realm)) {
        const acquisition = present(await reads.acquisitions.findById(id, realm), 'an Acquisition');
        const costs = present(await reads.acquisitionCosts.listCosts(id, realm, {}), 'an Acquisition');
        const payments = present(await reads.acquisitionCosts.listPayments(id, realm, {}), 'an Acquisition');
        const allocations = present(await reads.landBuildingAllocations.list(id, realm), 'an Acquisition');
        acquisitions.push({ acquisition, costs, payments: payments.items, landBuildingAllocations: allocations.items });
      }

      const loans: PropertyExportLoan[] = [];
      for (const id of await reads.scope.loanIds(p, realm)) {
        const loan = present(await reads.loans.findById(id, realm), 'a Loan');
        const terms = present(await reads.loanTerms.list(id, realm), 'a Loan');
        const allocationSets = present(await reads.loanAllocations.list(id, realm), 'a Loan');
        // §41.6's statements, `VOID` included; also of a `VOID` Loan, whose single read refuses them (§58S: any status).
        const balanceStatements = statementViews(present(await reads.loanDebt.debtInputs(id, realm), 'a Loan'));
        loans.push({ loan, terms, allocationSets, balanceStatements });
      }

      const wegMemberships: { membership: WegMembership; weg: Weg }[] = [];
      for (const id of await reads.scope.membershipIds(p, realm)) {
        const membership = present(await reads.wegs.findMembership(id, realm), 'a WEG membership');
        wegMemberships.push({ membership, weg: present(await reads.wegs.findWeg(membership.wegId, realm), 'a WEG') });
      }

      const deposits = await reads.scope.deposits(p, realm);
      const securityDeposits: DepositView[] = [];
      for (const id of deposits.attributed) securityDeposits.push(present(await reads.securityDeposits.findById(id, realm), 'a deposit'));
      const securityDepositsNotAttributed = deposits.severalCandidates.map((d) => ({
        securityDepositId: d.securityDepositId,
        reason: 'SEVERAL_PROPERTY_REFERENCES' as const,
        candidates: [...d.candidates],
      }));

      // §19.1: every Party a `…PartyId` / `…PartyIds` field above names, once, by id.
      const partyIds = new Set<string>();
      const name = (id: string | null) => {
        if (id !== null) partyIds.add(id);
      };
      for (const o of history.items) name(o.ownerPartyId);
      for (const a of acquisitions) {
        a.acquisition.buyerPartyIds.forEach(name);
        a.acquisition.sellerPartyIds.forEach(name);
        for (const c of a.costs) {
          name(c.counterpartyPartyId);
          name(c.classification?.advisorPartyId ?? null);
        }
        for (const l of a.landBuildingAllocations) name(l.advisorPartyId);
      }
      for (const l of loans) {
        name(l.loan.lenderPartyId);
        l.loan.borrowerPartyIds.forEach(name);
      }
      for (const m of wegMemberships) name(m.weg.administratorPartyId);
      const parties: Party[] = [];
      for (const id of [...partyIds].sort()) parties.push(present(await reads.parties.findById(id, realm), 'a Party'));

      const doc = {
        propertyReference,
        ownerships: history.items,
        acquisitions,
        loans,
        wegMemberships,
        securityDeposits,
        securityDepositsNotAttributed,
        parties,
      };
      const total = recordCount(doc);
      if (total > limit) throw new ExportTooLargeError(total, limit);
      return { generatedAt, mreRealmId: realm, ...doc };
    });
}
