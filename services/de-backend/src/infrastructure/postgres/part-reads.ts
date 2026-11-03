import type { Transaction } from 'kysely';
import type { PartChangeInput, TaxMeaning, TaxYearRead } from '../../domains/taxation/index.js';
import { history, recordsOf } from './attribution-reads.js';
import type { Database } from './schema.js';

/**
 * What `PROPERTY_PART_CHANGED` reads (api-design.md §58G), in the caller's snapshot, from §58G's wider Loan read
 * (`allocatedLoanInterest` with `anySet`: the Loans any of whose sets names the PropertyReference, their counting
 * `LOAN_INTEREST` splits whose tax year is `year`, every set of the Loan): the sets' `CREATED`/`VOIDED` AuditRecords by
 * `audit_record_entity_idx`, after the sets were selected in the Realm (`audit_record` has no Realm column), so another
 * Realm's record is never read. Used by the view and by the acknowledgement command (its own snapshot).
 */
export async function partChangeInputOf(
  trx: Transaction<Database>,
  wide: Pick<TaxYearRead, 'allocatedLoanInterest' | 'loanAllocationSets'>,
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
    loans: loanIds.map((loanId) => ({
      loanId,
      candidates: wide.allocatedLoanInterest
        .filter((i) => i.loanId === loanId)
        .map((i) => ({ sourceId: i.item.sourceId, bookingDate: (i.item as TaxMeaning).bookingDate, amount: i.item.amount })),
      sets: (wide.loanAllocationSets.get(loanId) ?? []).map(({ validUntil: _derived, ...set }) => ({ set, records: history(records, set.id) })),
    })),
  };
}
