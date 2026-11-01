import type { Transaction } from 'kysely';
import { withValidUntil, type LoanAllocationSetView } from '../../domains/financing/index.js';
import { loanInterestOf, type CapitalizedSourceInput, type RuleRegistry, type TaxMeaning } from '../../domains/taxation/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { interestFactsIn, type InterestSplitRef } from './construction-period-reads.js';
import { setsOfLoans } from './loan-allocation-repository.js';
import type { Database } from './schema.js';
import { countingSplits, factsQuery, meaningsOf, toRead } from './tax-source-facts.js';

/**
 * The capitalised Loan interest sources of a PropertyReference (api-design.md §59E "What becomes a capitalised source",
 * condition 3), the second of the two disjoint reads of `capitalizedSources`: the counting `LOAN_INTEREST` splits with a
 * `loanId` (0027: never with a PropertyReference) of the Loans whose `VALID` sets name P, with a current `CAPITALIZED`
 * classification, over every year; each attributed to P by §58D's `loanInterestOf` (the set covering its booking date,
 * P's part by `distribute` over the whole set) and given its conditions' facts. `ELSEWHERE` and `NOT_ATTRIBUTED` splits
 * give no source of P. In the caller's transaction.
 */
export async function capitalizedLoanInterestOf(
  trx: Transaction<Database>,
  registry: RuleRegistry,
  mreRealmId: string,
  propertyReferenceId: string,
  today: BusinessDate,
): Promise<CapitalizedSourceInput[]> {
  const rows = await countingSplits(factsQuery(trx, mreRealmId))
    .where('c.code', '=', 'LOAN_INTEREST')
    .where('s.loan_id', 'is not', null)
    .where((eb) =>
      eb(
        's.loan_id',
        'in',
        eb
          .selectFrom('loan_allocation_set as las')
          .innerJoin('loan_allocation as la', 'la.set_id', 'las.id')
          .select('las.loan_id')
          .where('las.mre_realm_id', '=', mreRealmId)
          .where('las.status', '=', 'VALID')
          .where('la.property_reference_id', '=', propertyReferenceId),
      ),
    )
    .where((eb) =>
      eb(
        's.id',
        'in',
        eb.selectFrom('tax_classification').select('transaction_split_id').where('superseded_at', 'is', null).where('treatment', '=', 'CAPITALIZED'),
      ),
    )
    .orderBy('t.booking_date')
    .orderBy('t.id')
    .orderBy('s.position')
    .execute();
  if (rows.length === 0) return [];
  const pairs = await meaningsOf(trx, registry, mreRealmId, rows.map(toRead), today);
  const splits = rows.map((row, i) => ({ row, pair: pairs[i] as (typeof pairs)[number] }));
  const sets = await setsOfLoans(trx, mreRealmId, [...new Set(rows.map((r) => r.loan_id as string))]);
  const views = new Map<string, readonly LoanAllocationSetView[]>([...sets].map(([loanId, own]) => [loanId, withValidUntil(own)]));
  const cases = loanInterestOf(
    propertyReferenceId,
    splits.map(({ row, pair }) => ({ item: { ...pair.meaning, yearAmount: pair.meaning.amount }, loanId: row.loan_id as string })),
    views,
  );
  const facts = await interestFactsIn(
    trx,
    registry,
    mreRealmId,
    splits.map(({ row, pair }) => refOf(pair.meaning, row.loan_id)),
  );
  return cases.flatMap((c, i): CapitalizedSourceInput[] => {
    if (c.kind !== 'ATTRIBUTED') return [];
    const { pair } = splits[i] as (typeof splits)[number];
    return [
      {
        meaning: pair.meaning,
        anschaffungsnaheAcquisitionId: pair.classification?.anschaffungsnaheAcquisitionId ?? null,
        loan: { loanId: c.split.loanId, set: c.set, propertyCents: c.propertyCents },
        interest: facts.get(pair.meaning.sourceId) ?? null,
      },
    ];
  });
}

/** A split's meaning as the conditions read it. */
export const refOf = (m: TaxMeaning, loanId: string | null): InterestSplitRef => ({
  splitId: m.sourceId,
  transactionId: m.transactionId,
  loanId,
  propertyReferenceId: m.propertyReferenceId,
  financialCategoryCode: m.financialCategoryCode,
  bookingDate: m.bookingDate,
  amount: m.amount,
  taxCategory: m.taxCategory,
  treatment: m.treatment,
});
