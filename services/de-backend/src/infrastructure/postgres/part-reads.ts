import type { Transaction } from 'kysely';
import {
  depositNotCounted,
  type DepositPartHistory,
  type PartChangeInput,
  type RuleRegistry,
  type TaxMeaning,
  type TaxYearRead,
} from '../../domains/taxation/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { history, recordsOf } from './audit-history-reads.js';
import { correctionHistoriesOf } from './mover-reads.js';
import type { Database } from './schema.js';
import { DEPOSIT_RENT_CODES, depositFactsOf } from './tax-source-facts.js';

/**
 * What `PROPERTY_PART_CHANGED` reads (api-design.md §58G), in the caller's snapshot, from §58G's wider Loan read
 * (`allocatedLoanInterest` with `anySet`: the Loans any of whose sets names the PropertyReference, their counting
 * `LOAN_INTEREST` splits whose tax year is `year`, every set of the Loan): the sets' `CREATED`/`VOIDED` AuditRecords by
 * `audit_record_entity_idx`, after the sets were selected in the Realm (`audit_record` has no Realm column), so another
 * Realm's record is never read. Used by the view and by the acknowledgement command (its own snapshot). §58H Part 2: the
 * candidate deposits of the Realm and `year` with their Tenants' reconciliations (`depositPartsOf`). §58I Part 2 (VC-X-50):
 * the corrected Transactions with a split that can count in `year` for P (`correctionHistoriesOf`).
 */
export async function partChangeInputOf(
  trx: Transaction<Database>,
  wide: Pick<TaxYearRead, 'allocatedLoanInterest' | 'loanAllocationSets'>,
  mreRealmId: string,
  year: number,
  movers: { readonly propertyReferenceId: string; readonly registry: RuleRegistry; readonly today: BusinessDate },
): Promise<PartChangeInput> {
  const loanIds = [...new Set(wide.allocatedLoanInterest.map((i) => i.loanId))].sort();
  const sets = loanIds.flatMap((loanId) => wide.loanAllocationSets.get(loanId) ?? []);
  const records = await recordsOf(
    trx,
    'LoanAllocationSet',
    sets.map((s) => s.id),
    ['CREATED', 'VOIDED'],
  );
  return {
    deposits: await depositPartsOf(trx, mreRealmId, year),
    corrections: await correctionHistoriesOf(trx, movers.registry, mreRealmId, movers.propertyReferenceId, year, movers.today),
    loans: loanIds.map((loanId) => ({
      loanId,
      candidates: wide.allocatedLoanInterest
        .filter((i) => i.loanId === loanId)
        .map((i) => ({ sourceId: i.item.sourceId, bookingDate: (i.item as TaxMeaning).bookingDate, amount: i.item.amount, period: i.period })),
      sets: (wide.loanAllocationSets.get(loanId) ?? []).map(({ validUntil: _derived, ...set }) => ({ set, records: history(records, set.id) })),
    })),
  };
}

/**
 * §58H Part 2: the counting deposit closings of the Realm closed in `year` (`CLOSED`, a retained amount; their tax year,
 * §58A), every reconciliation of their Tenants that is or was `CONFIRMED`, at any date, in the Realm, the PropertyReferences
 * of each one's rent splits as now, and their `CONFIRMED`/`RELEASED` AuditRecords by `audit_record_entity_idx` after the
 * reconciliations were selected in the Realm.
 */
export async function depositPartsOf(trx: Transaction<Database>, mreRealmId: string, year: number): Promise<DepositPartHistory[]> {
  const closed = await trx
    .selectFrom('security_deposit')
    .select('id')
    .where('mre_realm_id', '=', mreRealmId)
    .where('status', '=', 'CLOSED')
    .where('closing_date', '>=', `${year}-01-01`)
    .where('closing_date', '<=', `${year}-12-31`)
    .orderBy('id')
    .execute();
  const facts = (
    await depositFactsOf(
      trx,
      mreRealmId,
      closed.map((d) => d.id),
    )
  ).filter((f) => depositNotCounted(f, null) === null);
  if (facts.length === 0) return [];
  const tenantsOf = await trx
    .selectFrom('security_deposit')
    .select(['id', 'mre_tenant_id'])
    .where('mre_realm_id', '=', mreRealmId)
    .where(
      'id',
      'in',
      facts.map((f) => f.securityDepositId),
    )
    .execute();
  const tenantOf = new Map(tenantsOf.map((t) => [t.id, t.mre_tenant_id]));
  const reconciliations = await trx
    .selectFrom('rent_payment_reconciliation')
    .select(['id', 'transaction_id', 'mre_tenant_id', 'mre_rent_term', 'status'])
    .where('mre_realm_id', '=', mreRealmId)
    .where('mre_tenant_id', 'in', [...new Set(tenantOf.values())])
    .where('status', 'in', ['CONFIRMED', 'RELEASED'])
    .orderBy('id')
    .execute();
  const units =
    reconciliations.length === 0
      ? []
      : await trx
          .selectFrom('transaction_split as s')
          .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
          .select(['s.transaction_id', 's.property_reference_id'])
          .distinct()
          .where('s.mre_realm_id', '=', mreRealmId)
          .where('s.transaction_id', 'in', [...new Set(reconciliations.map((r) => r.transaction_id))])
          .where('c.code', 'in', [...DEPOSIT_RENT_CODES])
          .where('s.property_reference_id', 'is not', null)
          .execute();
  const records = await recordsOf(
    trx,
    'RentPaymentReconciliation',
    reconciliations.map((r) => r.id),
    ['CONFIRMED', 'RELEASED'],
  );
  return facts.map((f) => ({
    securityDepositId: f.securityDepositId,
    mreTenantId: tenantOf.get(f.securityDepositId) as string,
    closingDate: f.closingDate as BusinessDate,
    retainedAmount: f.retainedAmount,
    reconciliations: reconciliations
      .filter((r) => r.mre_tenant_id === tenantOf.get(f.securityDepositId))
      .map((r) => ({
        reconciliationId: r.id,
        transactionId: r.transaction_id,
        mreRentTerm: r.mre_rent_term,
        confirmedNow: r.status === 'CONFIRMED',
        records: history(records, r.id),
        propertyReferenceIds: [...new Set(units.filter((u) => u.transaction_id === r.transaction_id).map((u) => u.property_reference_id as string))].sort(),
      })),
  }));
}
