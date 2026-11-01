import { moneyOfCents, type BusinessDate, type Money } from '../../shared/index.js';
import type { LoanAllocationSetView } from '../financing/index.js';
import type { TaxMeaning } from './classification.js';
import { STRICT_INTEREST_POLICY, interestReasonOf, type InterestFacts, type InterestReason } from './construction-period-interest.js';
import { participantsOn, placementOf, shareOut, signedCents, type ViewOwnership } from './tax-year-view.js';
import type { ReviewState, TaxCategory, Treatment } from './vocabulary.js';
import type { WegTaxMeaning } from './weg-sources.js';

/**
 * The capitalised items of a PropertyReference (api-design.md §59B, P8-D2 (2), P8-D11): exactly the sources the
 * tax-year view places in `capitalized` (§58C), over every year, with the view's own signs and per-item parts. Only a
 * **classification** with `treatment` `CAPITALIZED` makes one: a default never does, and neither does the anschaffungsnahe
 * check's suggestion (§58B). Pure; Taxation does not know who reads it (Depreciation, through `infrastructure/`).
 */

/** A source as the repository derived it (§55, §58B), with its current classification's anschaffungsnahe link. */
export interface CapitalizedSourceInput {
  readonly meaning: TaxMeaning | WegTaxMeaning;
  readonly anschaffungsnaheAcquisitionId: string | null;
  /**
   * §59E: a Loan's interest split attributed to the PropertyReference by §58D (`loanInterestOf`: the set covering its
   * booking date, P's part by `distribute` over the whole set); absent or `null` for a split of the PropertyReference.
   */
  readonly loan?: { readonly loanId: string; readonly set: LoanAllocationSetView; readonly propertyCents: bigint } | null;
  /** §59E: the conditions' facts of an interest split (`isInterestSplit`); absent or `null` for every other source. */
  readonly interest?: InterestFacts | null;
}

/** The Loan of a capitalised Loan interest source (§59E "The component"): the values of the view's `loanAllocation`. */
export interface CapitalizedSourceLoan {
  readonly loanId: string;
  readonly allocationSetId: string;
  /** P's share in the set, `"3/5"`. */
  readonly share: string;
  readonly propertyPart: Money;
}

export interface CapitalizedSource {
  readonly sourceType: 'TRANSACTION_SPLIT' | 'WEG_RESERVE_WITHDRAWAL' | 'WEG_ASSESSMENT_USE';
  readonly sourceId: string;
  readonly sourcePosition: number | null;
  readonly propertyReferenceId: string | null;
  /** The share date of the view (booking, withdrawal or use date) and its kind. */
  readonly date: BusinessDate;
  readonly dateSource: string;
  readonly taxYear: number;
  /** The signed amount in `capitalized` (§58C "Signs"): an `OUTFLOW`, a withdrawal or a use positive, a refund negative. */
  readonly lineAmount: Money;
  readonly netAmount: Money | null;
  readonly classificationId: string | null;
  readonly reviewState: ReviewState;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly counts: boolean;
  readonly anschaffungsnaheAcquisitionId: string | null;
  /** §59E: the Loan of a Loan interest source (`null` for a split of the PropertyReference), and the record it names. */
  readonly loan: CapitalizedSourceLoan | null;
  readonly constructionPeriodInterestId: string | null;
  /** §58C's per-item parts: the participants on the date (`NOT_OWNED` for the rest), by largest remainder. */
  readonly parts: readonly {
    readonly participant: string;
    readonly ownershipIds: readonly string[];
    readonly share: { readonly numerator: bigint; readonly denominator: bigint };
    readonly amount: Money;
  }[];
  readonly flags: readonly { readonly code: string; readonly details: Readonly<Record<string, unknown>> }[];
}

/** An interest split classified `CAPITALIZED` that is no source of the PropertyReference, with the reason (§59E). */
export interface NotASource {
  readonly sourceId: string;
  readonly loanId: string | null;
  readonly reason: InterestReason;
}

/** Each counting source whose current classification places it in `capitalized`, in the input's order (§59B, §59E). */
export function capitalizedItemsOf(
  sources: readonly CapitalizedSourceInput[],
  ownerships: readonly ViewOwnership[],
  propertyReferenceId?: string,
): CapitalizedSource[] {
  return capitalizedSourcesOf(sources, ownerships, propertyReferenceId).items;
}

/**
 * The capitalised sources and, for the interest splits classified `CAPITALIZED` that fail §59E's conditions, the reasons.
 * A Loan's interest split enters with P's part (never the split's whole amount), on its booking date.
 */
export function capitalizedSourcesOf(
  sources: readonly CapitalizedSourceInput[],
  ownerships: readonly ViewOwnership[],
  propertyReferenceId?: string,
): { readonly items: CapitalizedSource[]; readonly notSources: NotASource[] } {
  const notSources: NotASource[] = [];
  const items = sources.flatMap(({ meaning, anschaffungsnaheAcquisitionId, loan = null, interest = null }): CapitalizedSource[] => {
    // A default (or a suggestion) never moves the basis: only the user's classification does (§58B, §59B).
    if (!meaning.counts || meaning.origin !== 'CLASSIFICATION') return [];
    const split = meaning.sourceType === 'TRANSACTION_SPLIT';
    const placement = placementOf({ taxCategory: meaning.taxCategory, treatment: meaning.treatment, refund: split ? meaning.refund : null });
    if (placement.place !== 'CAPITALIZED') return [];
    // §59E: interest is a source only with its conditions; a Loan's split only with P's part. A Loan's split is always
    // interest: read without its facts, it is held as without a record, never a source on a guess.
    const facts: InterestFacts | null =
      interest ??
      (loan === null || !split
        ? null
        : {
            splitId: meaning.sourceId,
            loanId: loan.loanId,
            bookingDate: meaning.bookingDate,
            amountCents: 0n,
            transactionInterestCents: 0n,
            constructionPeriodInterestId: null,
            record: null,
            policy: STRICT_INTEREST_POLICY,
          });
    if (facts !== null) {
      const reason = interestReasonOf(facts, propertyReferenceId ?? meaning.propertyReferenceId ?? '');
      if (reason !== null) {
        notSources.push({ sourceId: meaning.sourceId, loanId: loan?.loanId ?? null, reason });
        return [];
      }
    }
    const date = split ? meaning.bookingDate : meaning.date;
    const amount = loan === null ? meaning.amount : moneyOfCents(loan.propertyCents, meaning.amount.currency);
    const lineCents = signedCents({ amount, direction: split ? meaning.direction : null, taxCategory: meaning.taxCategory }, placement);
    const participants = participantsOn(ownerships, date);
    const parts = shareOut(lineCents, participants);
    const entry = loan === null ? undefined : loan.set.allocations.find((a) => a.propertyReferenceId === propertyReferenceId);
    // A Loan source reaches P only through P's entry of the covering set (§58D's ATTRIBUTED): anything else is a bug.
    if (loan !== null && entry === undefined) throw new Error(`Loan interest split ${meaning.sourceId}: the set ${loan.set.id} names no entry for P`);
    return [
      {
        sourceType: meaning.sourceType,
        sourceId: meaning.sourceId,
        sourcePosition: split ? null : meaning.sourcePosition,
        propertyReferenceId: meaning.propertyReferenceId,
        date,
        dateSource: split ? 'BOOKING' : meaning.dateSource,
        taxYear: meaning.taxYear,
        lineAmount: moneyOfCents(lineCents, meaning.amount.currency),
        netAmount: meaning.netAmount,
        classificationId: meaning.classificationId,
        reviewState: meaning.reviewState,
        taxCategory: meaning.taxCategory,
        treatment: meaning.treatment,
        counts: meaning.counts,
        anschaffungsnaheAcquisitionId,
        loan:
          loan === null || entry === undefined
            ? null
            : {
                loanId: loan.loanId,
                allocationSetId: loan.set.id,
                share: `${entry.share.numerator}/${entry.share.denominator}`,
                propertyPart: moneyOfCents(loan.propertyCents, meaning.amount.currency),
              },
        constructionPeriodInterestId: interest?.constructionPeriodInterestId ?? null,
        parts: participants.map((p) => ({
          participant: p.key,
          ownershipIds: p.ownershipIds,
          share: p.share,
          amount: moneyOfCents(parts.get(p.key) ?? 0n, meaning.amount.currency),
        })),
        flags: meaning.flags.map((f) => ({ code: f.code, details: f.details as Readonly<Record<string, unknown>> })),
      },
    ];
  });
  return { items, notSources };
}
