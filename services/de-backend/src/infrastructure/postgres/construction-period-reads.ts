import { sql, type Transaction } from 'kysely';
import {
  interestPolicyOn,
  isInterestSplit,
  type ConstructionPeriodView,
  type InterestFacts,
  type RuleRegistry,
  type TaxCategory,
  type Treatment,
} from '../../domains/taxation/index.js';
import { centsOf, type BusinessDate, type Money } from '../../shared/index.js';
import { recordsIn } from './construction-period-interest-repository.js';
import type { Database } from './schema.js';
import { COUNTED } from './tax-source-facts.js';

/**
 * What §59E's conditions read of interest splits (api-design.md §59E "What becomes a capitalised source"), in the
 * caller's transaction (the view's or the schedule's one snapshot): each split's current classification's record, the
 * record with its PropertyReferences and the treatments of the counting splits naming it, and the interest of the
 * split's Loan (or PropertyReference) in its Transaction for the land-share check. Used by the tax-year view and by the
 * capitalised sources Depreciation reads, so both decide by the same facts and the same pure `interestReasonOf`.
 */

type Trx = Transaction<Database>;

/** A split as the conditions read it: its facts and its current meaning's line and treatment. */
export interface InterestSplitRef {
  readonly splitId: string;
  readonly transactionId: string;
  readonly loanId: string | null;
  readonly propertyReferenceId: string | null;
  readonly financialCategoryCode: string;
  readonly bookingDate: BusinessDate;
  readonly amount: Money;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
}

/**
 * The facts of each interest split whose current classification is `CAPITALIZED` or names a record, by split id; the
 * other splits have none (they are no interest, or neither capitalised nor named).
 */
export async function interestFactsIn(
  trx: Trx,
  registry: RuleRegistry,
  mreRealmId: string,
  splits: readonly InterestSplitRef[],
): Promise<Map<string, InterestFacts>> {
  const facts = new Map<string, InterestFacts>();
  if (splits.length === 0) return facts;
  const links = await trx
    .selectFrom('tax_classification')
    .select(['transaction_split_id', 'construction_period_interest_id'])
    .where('transaction_split_id', 'in', [...new Set(splits.map((s) => s.splitId))])
    .where('superseded_at', 'is', null)
    .execute();
  const linkOf = new Map(links.map((l) => [l.transaction_split_id as string, l.construction_period_interest_id] as const));
  const wanted = splits.filter((s) => {
    const { policy } = interestPolicyOn(registry, s.bookingDate);
    return isInterestSplit(s, policy) && (s.treatment === 'CAPITALIZED' || (linkOf.get(s.splitId) ?? null) !== null);
  });
  if (wanted.length === 0) return facts;
  const records = await recordViewsIn(
    trx,
    mreRealmId,
    wanted.flatMap((s) => linkOf.get(s.splitId) ?? []),
  );
  const interest = await transactionInterestIn(trx, mreRealmId, wanted, registry);
  for (const s of wanted) {
    const id = linkOf.get(s.splitId) ?? null;
    facts.set(s.splitId, {
      splitId: s.splitId,
      loanId: s.loanId,
      bookingDate: s.bookingDate,
      amountCents: centsOf(s.amount),
      transactionInterestCents: interest.get(s.splitId) ?? centsOf(s.amount),
      constructionPeriodInterestId: id,
      record: id === null ? null : (records.get(id) ?? null),
      policy: interestPolicyOn(registry, s.bookingDate).policy,
    });
  }
  return facts;
}

/** The records with the treatments of the counting splits whose current classification names them. */
export async function recordViewsIn(trx: Trx, mreRealmId: string, ids: readonly string[]): Promise<Map<string, ConstructionPeriodView>> {
  const records = await recordsIn(trx, mreRealmId, ids);
  if (records.size === 0) return new Map();
  const naming = await trx
    .selectFrom('tax_classification as tc')
    .innerJoin('transaction_split as s', 's.id', 'tc.transaction_split_id')
    .innerJoin('ledger_transaction as t', 't.id', 's.transaction_id')
    .select(['tc.construction_period_interest_id as record_id', 'tc.transaction_split_id as split_id', 'tc.treatment'])
    .where('tc.construction_period_interest_id', 'in', [...records.keys()])
    .where('tc.superseded_at', 'is', null)
    .where('t.status', 'in', COUNTED)
    .where((eb) => eb.or([eb('t.correction_role', 'is', null), eb('t.correction_role', '<>', 'REVERSAL')]))
    .execute();
  const splitsOf = (recordId: string, treatment: string) =>
    naming
      .filter((n) => n.record_id === recordId && n.treatment === treatment)
      .map((n) => n.split_id as string)
      .sort();
  return new Map(
    [...records.values()].map((r) => [
      r.id,
      {
        id: r.id,
        loanId: r.loanId,
        propertyReferenceIds: r.propertyReferenceIds,
        herstellungFrom: r.herstellungFrom,
        herstellungUntil: r.herstellungUntil,
        advanceExpenseDeductible: r.advanceExpenseDeductible,
        buildingFundsShare: r.buildingFundsShare,
        reviewState: r.reviewState,
        status: r.status,
        deductibleSplitIds: splitsOf(r.id, 'DEDUCTIBLE'),
        capitalizedSplitIds: splitsOf(r.id, 'CAPITALIZED'),
      },
    ]),
  );
}

/**
 * The interest of each split's Loan (for a PropertyReference's split: of its PropertyReference without a Loan) in its
 * Transaction, by the rule's interest codes, the split itself always included (§59E "Land": the land share is
 * separated in the cash, as two interest splits of one debit).
 */
async function transactionInterestIn(trx: Trx, mreRealmId: string, splits: readonly InterestSplitRef[], registry: RuleRegistry): Promise<Map<string, bigint>> {
  const rows = await trx
    .selectFrom('transaction_split as s')
    .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
    .select(['s.id', 's.transaction_id', 's.loan_id', 's.property_reference_id', 'c.code', sql<string>`s.amount::text`.as('amount'), 's.currency'])
    .where('s.transaction_id', 'in', [...new Set(splits.map((s) => s.transactionId))])
    .where('s.mre_realm_id', '=', mreRealmId)
    .execute();
  const sums = new Map<string, bigint>();
  for (const split of splits) {
    const { policy } = interestPolicyOn(registry, split.bookingDate);
    const total = rows
      .filter(
        (r) =>
          r.transaction_id === split.transactionId &&
          (r.id === split.splitId ||
            (policy.interestCategoryCodes.includes(r.code) &&
              (split.loanId !== null ? r.loan_id === split.loanId : r.loan_id === null && r.property_reference_id === split.propertyReferenceId))),
      )
      .reduce((sum, r) => sum + cents(r.amount), 0n);
    sums.set(split.splitId, total);
  }
  return sums;
}

const cents = (text: string): bigint => {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole as string) * 100n + BigInt((fraction + '00').slice(0, 2));
};
