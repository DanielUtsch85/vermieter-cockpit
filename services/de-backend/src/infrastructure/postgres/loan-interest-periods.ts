import type { Transaction } from 'kysely';
import { debtFrom } from '../../domains/financing/index.js';
import {
  deviationOf,
  interestPeriodOf,
  planFactsOf,
  type InterestPeriod,
  type LoanPeriodFacts,
  type PeriodDeviation,
  type TaxClassification,
} from '../../domains/taxation/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { readLoanIn } from './loan-repository.js';
import { periodsOf } from './loan-terms-repository.js';
import type { Database } from './schema.js';

/**
 * What §58L's interest period reads of each Loan (api-design.md §58L rule 1, VC-X-40), in the caller's snapshot and
 * Realm: `debtFrom` (§41.1) and the payment dates of the schedule of its `VALID` terms (§41.4, cut at a closing as
 * Financing's). A Loan without terms has no payment dates (rule 8, `NO_SCHEDULE`); one not of the Realm is absent.
 */
export async function loanPeriodFactsOf(trx: Transaction<Database>, mreRealmId: string, loanIds: readonly string[]): Promise<Map<string, LoanPeriodFacts>> {
  const found = new Map<string, LoanPeriodFacts>();
  for (const loanId of [...new Set(loanIds)].sort()) {
    const loan = await readLoanIn(trx, loanId, mreRealmId);
    if (loan === undefined) continue;
    const periods = (await periodsOf(trx, loanId, mreRealmId)).filter((t) => t.status === 'VALID');
    // The contract plan (§58O question 12 (b)); the first entry's interval (rule 8) and each entry's period (the flag's
    // details); built as §58P's sides are (`planFactsOf`).
    found.set(loanId, planFactsOf(loan, debtFrom(loan), periods));
  }
  return found;
}

/** A Loan interest split's period: its classification's recorded one, else its Loan's schedule's (`interestPeriodOf`). */
export const periodOfSplit = (
  bookingDate: BusinessDate,
  classification: Pick<TaxClassification, 'interestPeriod'> | null | undefined,
  loan: LoanPeriodFacts | undefined,
): InterestPeriod | null => interestPeriodOf(bookingDate, classification?.interestPeriod ?? null, loan);

/** §58O: the split's recorded period where it deviates from its Loan's plan (`INTEREST_PERIOD_DEVIATES_FROM_SCHEDULE`), else null. */
export const deviationOfSplit = (
  bookingDate: BusinessDate,
  classification: Pick<TaxClassification, 'interestPeriod'> | null | undefined,
  loan: LoanPeriodFacts | undefined,
): PeriodDeviation | null => deviationOf(bookingDate, classification?.interestPeriod ?? null, loan);
