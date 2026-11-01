import { moneyOfCents, type BusinessDate, type Money } from '../../shared/index.js';
import type { TaxMeaning } from './classification.js';
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
  /** §58C's per-item parts: the participants on the date (`NOT_OWNED` for the rest), by largest remainder. */
  readonly parts: readonly {
    readonly participant: string;
    readonly ownershipIds: readonly string[];
    readonly share: { readonly numerator: bigint; readonly denominator: bigint };
    readonly amount: Money;
  }[];
  readonly flags: readonly { readonly code: string; readonly details: Readonly<Record<string, unknown>> }[];
}

/** Each counting source whose current classification places it in `capitalized`, in the input's order. */
export function capitalizedItemsOf(sources: readonly CapitalizedSourceInput[], ownerships: readonly ViewOwnership[]): CapitalizedSource[] {
  return sources.flatMap(({ meaning, anschaffungsnaheAcquisitionId }): CapitalizedSource[] => {
    // A default (or a suggestion) never moves the basis: only the user's classification does (§58B, §59B).
    if (!meaning.counts || meaning.origin !== 'CLASSIFICATION') return [];
    const split = meaning.sourceType === 'TRANSACTION_SPLIT';
    const placement = placementOf({ taxCategory: meaning.taxCategory, treatment: meaning.treatment, refund: split ? meaning.refund : null });
    if (placement.place !== 'CAPITALIZED') return [];
    const date = split ? meaning.bookingDate : meaning.date;
    const lineCents = signedCents({ amount: meaning.amount, direction: split ? meaning.direction : null, taxCategory: meaning.taxCategory }, placement);
    const participants = participantsOn(ownerships, date);
    const parts = shareOut(lineCents, participants);
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
}
