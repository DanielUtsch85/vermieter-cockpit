import { centsOf } from '../../shared/index.js';
import {
  INTEREST_CAPITALIZED_CONDITIONS_MISSING,
  STRICT_INTEREST_POLICY,
  constructionPeriodFlags,
  interestReasonOf,
  type InterestFacts,
} from './construction-period-interest.js';
import type { TaxMeaning } from './classification.js';
import type { TaxYearDepreciation } from './tax-year-depreciation.js';
import type { Derived } from './tax-year-items.js';
import { LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS } from './tax-year-loan-interest.js';
import type { ViewFlag } from './tax-year-response.js';

/**
 * Bauzeitzinsen in the tax-year view (api-design.md §59E "The flag's lifecycle"): the record's flags on the items naming
 * it, `INTEREST_CAPITALIZED_CONDITIONS_MISSING` on a PropertyReference's `CAPITALIZED` interest that is no source, and
 * `LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS` on an attributed `CAPITALIZED` Loan item, dropped only when the item provably
 * entered P's building basis exactly once: the component `TRANSACTION_SPLIT:{splitId}` on P's `ACTIVE` building whose
 * basis equals the item's `lineAmount` and whose owners' bases equal the item's parts, read in the view's one snapshot.
 */

/** Why a `CAPITALIZED` Loan item is not (yet) provably in P's basis; `null` when it is. */
export type NotInBasisReason = ReturnType<typeof interestReasonOf> | 'NO_COMPONENT' | 'BASIS_MISMATCH';

/** No facts read for a split (a test's read without them): the strict policy without a record, never a source. */
const noFacts = (d: Derived): InterestFacts => {
  const m = d.source as TaxMeaning;
  return {
    splitId: m.sourceId,
    loanId: d.loanAllocation?.loanId ?? null,
    bookingDate: m.bookingDate,
    amountCents: centsOf(m.amount),
    transactionInterestCents: centsOf(m.amount),
    constructionPeriodInterestId: null,
    record: null,
    policy: STRICT_INTEREST_POLICY,
  };
};

/**
 * The component of a Loan item on P's `ACTIVE` building, and whether its basis equals the item's at the property level
 * and at each participant's (the owners and `NOT_OWNED`): a separate asset never takes a Loan split (0051), so only the
 * building is read.
 */
export function inBuildingBasis(dep: TaxYearDepreciation, d: Derived): 'IN_BASIS' | 'NO_COMPONENT' | 'BASIS_MISMATCH' {
  const splitId = d.source.sourceId;
  const building = dep.assets.find((a) => a.assetType === 'BUILDING');
  const found = (building?.componentIndex ?? []).filter((c) => c.source?.sourceType === 'TRANSACTION_SPLIT' && c.source.sourceId === splitId);
  if (found.length === 0) return 'NO_COMPONENT';
  const [c] = found;
  // Exactly once: one component, its basis P's part, its owners' bases the item's parts (no participant more or less).
  if (found.length > 1 || c === undefined || c.basis === undefined || c.basis === null || c.partBases === undefined) return 'BASIS_MISMATCH';
  if (centsOf(c.basis) !== d.lineCents) return 'BASIS_MISMATCH';
  const bases = new Map(c.partBases.map((p) => [p.participant, centsOf(p.amount)] as const));
  const keys = new Set([...bases.keys(), ...d.participants.map((p) => p.key)]);
  const parts = new Map(d.participants.map((p) => [p.key, d.parts.get(p.key) ?? 0n] as const));
  for (const key of keys) if ((bases.get(key) ?? 0n) !== (parts.get(key) ?? 0n)) return 'BASIS_MISMATCH';
  return 'IN_BASIS';
}

/** A listed item (a split of the PropertyReference) with §59E's flags. */
export function withInterestFlags(d: Derived, facts: InterestFacts | undefined, propertyReferenceId: string): Derived {
  if (d.source.sourceType !== 'TRANSACTION_SPLIT' || facts === undefined) return d;
  const m = d.source;
  const flags: ViewFlag[] = [...d.flags, ...constructionPeriodFlags(facts, m.treatment)];
  if (d.placement.place === 'CAPITALIZED' && m.origin === 'CLASSIFICATION' && m.counts) {
    const reason = interestReasonOf(facts, propertyReferenceId);
    if (reason !== null) flags.push({ code: INTEREST_CAPITALIZED_CONDITIONS_MISSING, details: { reason } });
  }
  return flags.length === d.flags.length ? d : { ...d, flags };
}

/**
 * An attributed Loan item with §59E's flags: the record's, and `LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS` with its
 * `reason` on a `CAPITALIZED` item that did not provably enter P's building basis exactly once.
 */
export function withLoanInterestFlags(d: Derived, facts: InterestFacts | undefined, propertyReferenceId: string, dep: TaxYearDepreciation): Derived {
  const m = d.source as TaxMeaning;
  const known = facts ?? noFacts(d);
  const flags: ViewFlag[] = [...d.flags, ...(facts === undefined ? [] : constructionPeriodFlags(facts, m.treatment))];
  if (d.placement.place === 'CAPITALIZED') {
    const reason: NotInBasisReason = interestReasonOf(known, propertyReferenceId) ?? notInBasisOf(inBuildingBasis(dep, d));
    if (reason !== null) {
      flags.push({
        code: LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS,
        details: { loanId: d.loanAllocation?.loanId ?? null, allocationSetId: d.loanAllocation?.allocationSetId ?? null, reason },
      });
    }
  }
  return flags.length === d.flags.length ? d : { ...d, flags };
}

const notInBasisOf = (state: ReturnType<typeof inBuildingBasis>): NotInBasisReason => (state === 'IN_BASIS' ? null : state);
