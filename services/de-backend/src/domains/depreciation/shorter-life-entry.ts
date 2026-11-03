import type { BusinessDate, Money } from '../../shared/index.js';
import type { EntryAcquisition, ShorterLifeEvidence } from './asset.js';

/**
 * The checks of a shorter-life entry's facts at create and amend (§59G): a Stichtag after its document's date (238-5),
 * and, for Part 2 (VC-X-41 Part 2; Entscheidung des Projektinhabers, 2026-11-02, open question 11), the declared AfA of a
 * late evidence per owner, a fact of the entry (migration 0061): its shape, its order, its identity for an amend's
 * comparison, the Parties it names and the refusal of one on an entry no case could read it for. Each owner's declared
 * AfA is the cumulative AfA per the tax assessments through `throughYear` (`YE − 1`), in `partyId` order; a change
 * resets the entry's review state, as a changed evidence or release note does; read only for `FROM_EVIDENCE_YEAR`.
 */

/**
 * §59G (Entscheidung des Projektinhabers, 2026-11-02, 238-5): an evidence cannot attest a Stichtag after its own date.
 * The first entry, in the order named (`index`), whose `valuationDate` lies after its `evidence.date`, else `undefined`;
 * equal dates are allowed, and an entry without a Stichtag (stored before 0056) is not judged. A structural fact of the
 * body (`422 VALUATION_DATE_AFTER_EVIDENCE_DATE`), never a tax judgement.
 */
export function valuationDateAfterEvidence(
  entries: readonly { readonly acquisitionId: string; readonly evidence: ShorterLifeEvidence }[],
): ValuationDateRefusal | undefined {
  const index = entries.findIndex((e) => e.evidence.valuationDate !== null && e.evidence.valuationDate > e.evidence.date);
  const entry = entries[index];
  if (entry === undefined || entry.evidence.valuationDate === null) return undefined;
  return {
    kind: 'VALUATION_DATE_AFTER_EVIDENCE_DATE',
    index,
    acquisitionId: entry.acquisitionId,
    valuationDate: entry.evidence.valuationDate,
    evidenceDate: entry.evidence.date,
  };
}

/** §59G 238-5: the refusal of create and amend, after the asset or PropertyReference is found (Realm isolation first). */
export interface ValuationDateRefusal {
  readonly kind: 'VALUATION_DATE_AFTER_EVIDENCE_DATE';
  readonly index: number;
  readonly acquisitionId: string;
  readonly valuationDate: BusinessDate;
  readonly evidenceDate: BusinessDate;
}

/** One owner's declared AfA of a late evidence (§59G Part 2, open question 11). */
export interface DeclaredAfa {
  readonly partyId: string;
  /** The last year the declared amount covers; only `YE − 1` counts, another year is read as none recorded. */
  readonly throughYear: number;
  /** The cumulative AfA per the tax assessments through `throughYear`, never negative, in EUR. */
  readonly amount: Money;
  /** Where the tax assessments are (1–500 characters). */
  readonly evidenceReference: string;
}

/** §59G Part 2: at most one declared AfA per owner, at most 20 per entry; the reference 1–500 characters. */
export const MAX_DECLARED_AFA = 20;
export const MAX_DECLARED_AFA_REFERENCE_LENGTH = 500;
export const sortedDeclaredAfa = (rows: readonly DeclaredAfa[]): DeclaredAfa[] =>
  [...rows].sort((a, b) => (a.partyId < b.partyId ? -1 : a.partyId > b.partyId ? 1 : 0));
export const declaredAfaKey = (rows: readonly DeclaredAfa[]) =>
  JSON.stringify(sortedDeclaredAfa(rows).map((r) => [r.partyId, r.throughYear, r.amount.toString(), r.evidenceReference]));

/** §59G Part 2: the Parties the entries' declared AfA names, each once, in the order named (checked as the advisors are). */
export const declaredPartiesOf = (entries: readonly { readonly declaredAfa?: readonly DeclaredAfa[] }[]): string[] => [
  ...new Set(entries.flatMap((e) => (e.declaredAfa ?? []).map((r) => r.partyId))),
];

/**
 * §59G Part 2 (Entscheidung des Projektinhabers, 2026-11-02, open question 11): a declared AfA belongs to an entry that
 * can be a late evidence; one whose Stichtag lies in or before its Acquisition's contract year is `FROM_START` (or before
 * the purchase) whatever the transfer date, so its declared AfA could never be read (`422 DECLARED_AFA_NOT_APPLICABLE`).
 */
export interface DeclaredAfaRefusal {
  readonly kind: 'DECLARED_AFA_NOT_APPLICABLE';
  readonly index: number;
  readonly acquisitionId: string;
  readonly valuationDate: BusinessDate | null;
  readonly contractDate: BusinessDate;
}

/** The first entry, in the order named, with a declared AfA but no Stichtag after its contract year; else `undefined`. */
export function declaredAfaRefusal(
  entries: readonly { readonly acquisitionId: string; readonly evidence: ShorterLifeEvidence; readonly declaredAfa?: readonly DeclaredAfa[] }[],
  found: ReadonlyMap<string, EntryAcquisition>,
): DeclaredAfaRefusal | undefined {
  for (const [index, e] of entries.entries()) {
    const contractDate = found.get(e.acquisitionId)?.contractDate;
    if ((e.declaredAfa ?? []).length === 0 || contractDate === undefined) continue;
    const valuationDate = e.evidence.valuationDate;
    if (valuationDate === null || valuationDate.slice(0, 4) <= contractDate.slice(0, 4)) {
      return { kind: 'DECLARED_AFA_NOT_APPLICABLE', index, acquisitionId: e.acquisitionId, valuationDate, contractDate };
    }
  }
  return undefined;
}
