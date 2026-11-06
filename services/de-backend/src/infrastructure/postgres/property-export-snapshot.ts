import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from './schema.js';
import { PostgresAcquisitionCostRepository } from './acquisition-cost-repository.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { PostgresLandBuildingAllocationRepository } from './land-building-allocation-repository.js';
import { PostgresLoanAllocationRepository } from './loan-allocation-repository.js';
import { PostgresLoanDebtRepository } from './loan-debt-repository.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { PostgresLoanTermsRepository } from './loan-terms-repository.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
import { PostgresSecurityDepositRepository } from './security-deposit-repository.js';
import { DEPOSIT_RENT_CODES, depositFactsOf } from './tax-source-facts.js';
import { PostgresWegRepository } from './weg-repository.js';

/**
 * The property export (api-design.md §58S, VC-X-04) reads in one `REPEATABLE READ READ ONLY` snapshot, through the
 * repositories of the single reads, so every element is the single read's value; plus the few id lists of P that no
 * single read gives in this form (every status, the export's order).
 */

/**
 * `trx` as a `Kysely` whose `transaction()` joins it: a repository read that opens its own snapshot runs in this one
 * instead. Read only, so a write through it fails in PostgreSQL. Methods are bound to `trx` (Kysely's private fields).
 */
export function joiningSnapshot(trx: Transaction<Database>): Kysely<Database> {
  const joined = {
    setIsolationLevel: () => joined,
    setAccessMode: () => joined,
    execute: <T>(callback: (t: Transaction<Database>) => Promise<T>): Promise<T> => callback(trx),
  };
  return new Proxy(trx, {
    get(target, key) {
      if (key === 'transaction') return () => joined;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as Kysely<Database>;
}

/** The id lists of the property export: P's records in every status, in the export's order (§58S "Schema"). */
export class PropertyExportScope {
  constructor(private readonly trx: Transaction<Database>) {}

  /** Every Acquisition of P, `DRAFT`, `CONFIRMED` and `CANCELLED`: contract date, creation, id. */
  async acquisitionIds(propertyReferenceId: string, mreRealmId: string): Promise<string[]> {
    const rows = await this.trx
      .selectFrom('acquisition')
      .select('id')
      .where('mre_realm_id', '=', mreRealmId)
      .where('property_reference_id', '=', propertyReferenceId)
      .orderBy('contract_date')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((r) => r.id);
  }

  /** Every Loan any of whose sets, in any status, names P; the Loan in any status (unlike §41.3's list). By id. */
  async loanIds(propertyReferenceId: string, mreRealmId: string): Promise<string[]> {
    const rows = await this.trx
      .selectFrom('loan_allocation_set as s')
      .innerJoin('loan_allocation as a', (join) => join.onRef('a.set_id', '=', 's.id').onRef('a.mre_realm_id', '=', 's.mre_realm_id'))
      .select('s.loan_id')
      .distinct()
      .where('s.mre_realm_id', '=', mreRealmId)
      .where('a.property_reference_id', '=', propertyReferenceId)
      .orderBy('s.loan_id')
      .execute();
    return rows.map((r) => r.loan_id);
  }

  /** Every WEG membership of P, `VOID` included: valid from, creation, id. */
  async membershipIds(propertyReferenceId: string, mreRealmId: string): Promise<string[]> {
    const rows = await this.trx
      .selectFrom('weg_membership')
      .select('id')
      .where('mre_realm_id', '=', mreRealmId)
      .where('property_reference_id', '=', propertyReferenceId)
      .orderBy('valid_from')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((r) => r.id);
  }

  /**
   * The deposits by §58A's rule (the one PropertyReference the Tenant's confirmed rent is booked on): those whose
   * PropertyReference is P, and those with several candidates, P among them. Only Tenants with confirmed rent on P can be
   * either; a deposit without reconciled rent is in no property's file (§58S, open question 9). By id.
   */
  async deposits(
    propertyReferenceId: string,
    mreRealmId: string,
  ): Promise<{
    readonly attributed: readonly string[];
    readonly severalCandidates: readonly { readonly securityDepositId: string; readonly candidates: readonly string[] }[];
  }> {
    const rows = await this.trx
      .selectFrom('security_deposit')
      .select('id')
      .where('mre_realm_id', '=', mreRealmId)
      .where('mre_tenant_id', 'in', (eb) =>
        eb
          .selectFrom('rent_payment_reconciliation as r')
          .innerJoin('transaction_split as s', 's.transaction_id', 'r.transaction_id')
          .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
          .select('r.mre_tenant_id')
          .where('r.mre_realm_id', '=', mreRealmId)
          .where('r.status', '=', 'CONFIRMED')
          .where('c.code', 'in', [...DEPOSIT_RENT_CODES])
          .where('s.property_reference_id', '=', propertyReferenceId),
      )
      .orderBy('id')
      .execute();
    const facts = await depositFactsOf(
      this.trx,
      mreRealmId,
      rows.map((r) => r.id),
    );
    return {
      attributed: facts.filter((f) => f.propertyReferenceId === propertyReferenceId).map((f) => f.securityDepositId),
      severalCandidates: facts
        .filter((f) => f.propertyReferenceId === null && f.propertyCandidates.length > 1 && f.propertyCandidates.includes(propertyReferenceId))
        .map((f) => ({ securityDepositId: f.securityDepositId, candidates: [...f.propertyCandidates] })),
    };
  }
}

/** The repositories of the single reads and the scope, all on one snapshot. */
function readsOn(trx: Transaction<Database>) {
  const db = joiningSnapshot(trx);
  return {
    propertyReferences: new PostgresPropertyReferenceRepository(db),
    ownerships: new PostgresOwnershipRepository(db),
    acquisitions: new PostgresAcquisitionRepository(db),
    acquisitionCosts: new PostgresAcquisitionCostRepository(db),
    landBuildingAllocations: new PostgresLandBuildingAllocationRepository(db),
    loans: new PostgresLoanRepository(db),
    loanTerms: new PostgresLoanTermsRepository(db),
    loanAllocations: new PostgresLoanAllocationRepository(db),
    loanDebt: new PostgresLoanDebtRepository(db),
    wegs: new PostgresWegRepository(db),
    securityDeposits: new PostgresSecurityDepositRepository(db),
    parties: new PostgresPartyRepository(db),
    scope: new PropertyExportScope(trx),
  };
}

export type PropertyExportReadsOnSnapshot = ReturnType<typeof readsOn>;

/** Opens the property export's snapshot; `generatedAt` is the server clock at its start. */
export class PostgresPropertyExportSnapshots {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  read<T>(callback: (reads: PropertyExportReadsOnSnapshot, generatedAt: Date) => Promise<T>): Promise<T> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        // The snapshot starts with its first statement; the clock is read right after it.
        await sql`SELECT 1`.execute(trx);
        return callback(readsOn(trx), this.now());
      });
  }
}
