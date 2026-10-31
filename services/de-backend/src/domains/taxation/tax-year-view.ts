import { moneyOfCents, type BusinessDate, type RuleRegistry } from '../../shared/index.js';
import type { LoanAllocationSetView } from '../financing/index.js';
import type { AnschaffungsnaheCheck, NotFinalReason } from './anschaffungsnahe.js';
import { attributionChanges, type AttributionInput } from './attribution-changes.js';
import type { TaxListItem } from './classification.js';
import type { DepositTaxMeaning } from './deposit-closing.js';
import { deriveItem, notAttributedItem, type Derived } from './tax-year-items.js';
import {
  deriveLoanItem,
  inListOrder,
  loanInterestOf,
  notAttributedInterestDetails,
  notAttributedLoanItem,
  type LoanInterestCase,
  type LoanInterestSplit,
} from './tax-year-loan-interest.js';
import { reviewOf, ruleVersionsOf } from './tax-year-review.js';
import type { TaxYearAcquisition, TaxYearTotals, TaxYearView, ViewFlag } from './tax-year-response.js';
import { sectionsOf, withoutItems } from './tax-year-sections.js';
import { NOT_OWNED, type ViewOwnership } from './tax-year-shares.js';

/**
 * The tax-year view (api-design.md §58C, phase-7-plan P7-D7, P7-D8): §55's per-year list, with the interest of the
 * allocated Loans (§58D), grouped and summed into Einnahmen, Werbungskosten and the result before AfA, per
 * PropertyReference and per owner. Derived on every read from
 * one snapshot (the repository's), never stored; it applies no tax rule of its own and writes nothing. Every figure is
 * exact in cents (`bigint`), and the owners' figures with `NOT_OWNED` sum to the property's to the cent.
 */

// The view's parts, re-exported for the importers of this module (index.ts, the tests, capitalized-items.ts).
export { EINNAHMEN_LINES, TAX_YEAR_PLACES, WERBUNGSKOSTEN_LINES, placementOf, signedCents } from './tax-year-placement.js';
export type { Placement, Section } from './tax-year-placement.js';
export { NOT_OWNED, foldPerOwner, participantsOn, shareOut } from './tax-year-shares.js';
export type { FoldedParts, Participant, ViewOwnership } from './tax-year-shares.js';
export type {
  Level,
  TaxYearAcquisition,
  TaxYearItem,
  TaxYearLine,
  TaxYearLoanAllocation,
  TaxYearResult,
  TaxYearReview,
  TaxYearRuleVersion,
  TaxYearSection,
  TaxYearTotals,
  TaxYearView,
  ViewFlag,
} from './tax-year-response.js';
export { sourceKeyOf } from './tax-year-items.js';
export { flagIsOpen, reviewOf, ruleVersionsOf } from './tax-year-review.js';
export { LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY, LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS, loanInterestOf } from './tax-year-loan-interest.js';
export type { LoanInterestCase, LoanInterestSplit, NotAttributedReason } from './tax-year-loan-interest.js';

/** At most this many items over all places, `notInView` and everything not attributed included (§58C, §58D). */
export const TAX_YEAR_ITEM_LIMIT = 5000;

/** What the view reads, in one snapshot (§58C "One snapshot"). */
export interface TaxYearRead {
  readonly propertyReferenceId: string;
  /** `null` without `ownerPartyId`; else whether it names a Party of the Realm. */
  readonly ownerPartyFound: boolean | null;
  /**
   * §55's per-year list (in its order), with the earlier § 82b sources whose §58B parts have none in `year` beside it
   * (`listed: false`): the per-owner fold may still give them one.
   */
  readonly sources: readonly { readonly item: TaxListItem; readonly listed: boolean }[];
  /** The counting deposit closings of the Realm closed in `year` without a PropertyReference (§58A). */
  readonly unattributedDeposits: readonly DepositTaxMeaning[];
  readonly ownerships: readonly ViewOwnership[];
  /** The anschaffungsnahe checks of the PropertyReference's Acquisitions, from the same derivation as the list's. */
  readonly checks: readonly AnschaffungsnaheCheck[];
  readonly attribution: AttributionInput;
  /**
   * The counting `LOAN_INTEREST` splits of `year` (§58A's tax year, as the list derives it; the split's own meaning, no
   * treatment effects of the PropertyReference) of the Loans with a `VALID` LoanAllocation set naming this
   * PropertyReference, in the list's order. A split with a `loanId` carries no PropertyReference (0027): which set and
   * part apply is §58D's (`loanInterestOf`).
   */
  readonly allocatedLoanInterest: readonly LoanInterestSplit[];
  /** Every set, `VALID` and `VOID`, of each Loan in `allocatedLoanInterest`, with `validUntil` derived (§41.3). */
  readonly loanAllocationSets: ReadonlyMap<string, readonly LoanAllocationSetView[]>;
}

export type TaxYearOutcome =
  | { readonly kind: 'VIEW'; readonly view: TaxYearView }
  | { readonly kind: 'NOT_AN_OWNER_IN_YEAR' }
  | { readonly kind: 'TAX_YEAR_TOO_LARGE'; readonly itemCount: number; readonly limit: number };

const DEPRECIATION_NOTE = 'Die AfA wird in Phase 8 abgeleitet; das Ergebnis ist vor AfA (P7-D8).';

/**
 * The view of `year` at the property level (`ownerPartyId` null) or of one owner, in §58C's order of checks after the
 * reads: `NOT_AN_OWNER_IN_YEAR` (no `VALID` Ownership overlapping the year and no part in an item of it), then the cap.
 */
export function buildTaxYearView(
  read: TaxYearRead,
  options: { readonly year: number; readonly ownerPartyId: string | null; readonly today: BusinessDate; readonly registry: RuleRegistry },
): TaxYearOutcome {
  const { year, ownerPartyId, today, registry } = options;
  const currency = 'EUR';
  const attribution = attributionChanges(read.attribution, year, registry);
  const listed = read.sources.map((s) => deriveItem(s.item, year, read.ownerships, attribution.changes)).filter((d): d is Derived => d !== undefined);
  // §58D: the interest of the allocated Loans, by the set on each split's booking date.
  const loanCases = loanInterestOf(read.propertyReferenceId, read.allocatedLoanInterest, read.loanAllocationSets);
  const attributedLoans = loanCases
    .filter((c): c is Extract<LoanInterestCase, { kind: 'ATTRIBUTED' }> => c.kind === 'ATTRIBUTED')
    .map((c) => deriveLoanItem(c, year, read.ownerships, attribution.changes))
    .filter((d): d is Derived => d !== undefined);
  const unattributedLoans = loanCases.filter((c): c is Extract<LoanInterestCase, { kind: 'NOT_ATTRIBUTED' }> => c.kind === 'NOT_ATTRIBUTED');
  const derived = inListOrder(listed, attributedLoans);

  // The deposits not attributed (§58C): NO_RECONCILED_RENT in every view, SEVERAL_PROPERTY_REFERENCES in each candidate's.
  const unattributed = read.unattributedDeposits.filter(
    (d) => d.counts && (d.propertyCandidates.length === 0 || d.propertyCandidates.includes(read.propertyReferenceId)),
  );

  if (ownerPartyId !== null) {
    const owns = read.ownerships.some(
      (o) => o.partyId === ownerPartyId && o.validFrom <= `${year}-12-31` && (o.validUntil === null || o.validUntil >= `${year}-01-01`),
    );
    if (!owns && !derived.some((d) => d.parts.has(ownerPartyId))) return { kind: 'NOT_AN_OWNER_IN_YEAR' };
  }
  const itemCount = derived.length + unattributed.length + unattributedLoans.length;
  if (itemCount > TAX_YEAR_ITEM_LIMIT) return { kind: 'TAX_YEAR_TOO_LARGE', itemCount, limit: TAX_YEAR_ITEM_LIMIT };

  const participant = ownerPartyId ?? undefined;
  const sections = sectionsOf(derived, year, currency, participant);
  const notAttributedDeposits = unattributed.map(notAttributedItem);
  const notAttributed = [...notAttributedDeposits, ...unattributedLoans.map((c) => notAttributedLoanItem(c, year))];

  // The flags of the year.
  const flags: ViewFlag[] = [{ code: 'DEPRECIATION_NOT_AVAILABLE', details: {} }];
  if (attribution.changes.length > 0) {
    flags.push({
      code: 'ATTRIBUTION_INPUT_CHANGED',
      details: attribution.changes.map((c) => ({
        rentalContractReferenceId: c.rentalContractReferenceId,
        auditRecordId: c.auditRecordId,
        amendedAt: c.amendedAt.toISOString(),
        changedEntries: c.changedEntries,
        items: c.items,
      })),
    });
  }
  for (const id of attribution.inconsistent) flags.push({ code: 'ATTRIBUTION_HISTORY_INCONSISTENT', details: { rentalContractReferenceId: id } });
  const incomplete = derived.filter((d) => d.parts.has(NOT_OWNED));
  if (incomplete.length > 0) {
    const notOwnedResult = incomplete.reduce((s, d) => {
      if (d.placement.place !== 'LINE') return s;
      const part = d.parts.get(NOT_OWNED) ?? 0n;
      return d.placement.section === 'EINNAHMEN' ? s + part : s - part;
    }, 0n);
    flags.push({
      code: 'OWNERSHIP_INCOMPLETE',
      details: {
        itemCount: incomplete.length,
        notOwnedTotal: moneyOfCents(notOwnedResult, currency).toJSON(),
        firstDate: incomplete.map((d) => d.date).sort()[0],
      },
    });
  }
  // The deposits only: interest not attributed has its own flag, so no split is counted twice in review.open (§58D).
  if (notAttributedDeposits.length > 0) flags.push({ code: 'UNATTRIBUTED_ITEMS', details: { count: notAttributedDeposits.length } });
  // Interest of an allocated Loan without a usable set on its booking date (§58D): flagged at both levels, never summed.
  if (unattributedLoans.length > 0) flags.push({ code: 'LOAN_INTEREST_NOT_ATTRIBUTED', details: notAttributedInterestDetails(unattributedLoans, currency) });
  const acquisitions: TaxYearAcquisition[] = read.checks
    .filter((c) => c.acquisitionStatus !== 'CANCELLED' && c.window !== null && c.window.from <= `${year}-12-31` && c.window.until >= `${year}-01-01`)
    .map((c) => {
      const notFinal = c.flags.find((f) => f.code === 'NOT_FINAL');
      return {
        acquisitionId: c.acquisitionId,
        transferDate: c.transferDate,
        window: c.window as { from: BusinessDate; until: BusinessDate },
        status: c.status,
        final: c.final,
        notFinalReasons: notFinal === undefined ? [] : (notFinal.details as { reasons: readonly NotFinalReason[] }).reasons,
        href: `/api/v1/acquisitions/${c.acquisitionId}/anschaffungsnahe-herstellungskosten`,
      };
    });
  const notFinal = acquisitions.filter((a) => !a.final || a.status === 'NOT_COMPUTABLE');
  if (notFinal.length > 0) flags.push({ code: 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL', details: { acquisitionIds: notFinal.map((a) => a.acquisitionId) } });

  // The owners and NOT_OWNED at the property level: summed from their parts, never distributed (§27.4's F4b).
  let owners: TaxYearView['owners'] = null;
  let notOwned: TaxYearTotals | null = null;
  if (ownerPartyId === null) {
    const keys = new Set(derived.flatMap((d) => [...d.parts.keys()]));
    const totalsOf = (key: string): TaxYearTotals => {
      const s = sectionsOf(derived, year, currency, key);
      return {
        einnahmen: withoutItems(s.einnahmen),
        werbungskosten: withoutItems(s.werbungskosten),
        result: s.result,
        capitalized: { total: s.capitalized.total },
      };
    };
    owners = [...keys]
      .filter((k) => k !== NOT_OWNED)
      .sort()
      .map((key) => ({
        ownerPartyId: key,
        ownershipIds: [
          ...new Set(derived.filter((d) => d.parts.has(key)).flatMap((d) => d.participants.find((p) => p.key === key)?.ownershipIds ?? [])),
        ].sort(),
        ...totalsOf(key),
      }));
    notOwned = keys.has(NOT_OWNED) ? totalsOf(NOT_OWNED) : null;
  }

  const placed = [
    ...sections.einnahmen.lines.flatMap((l) => l.items),
    ...sections.werbungskosten.lines.flatMap((l) => l.items),
    ...sections.capitalized.items,
    ...sections.notInView.items,
    ...sections.unclassified.items,
    ...notAttributed,
  ];
  return {
    kind: 'VIEW',
    view: {
      propertyReferenceId: read.propertyReferenceId,
      year,
      ownerPartyId,
      level: ownerPartyId === null ? 'PROPERTY' : 'OWNER',
      computedOn: today,
      einnahmen: sections.einnahmen,
      werbungskosten: sections.werbungskosten,
      depreciation: { status: 'DEPRECIATION_NOT_AVAILABLE', amount: null, note: DEPRECIATION_NOTE },
      result: sections.result,
      capitalized: sections.capitalized,
      notInView: sections.notInView,
      unclassified: sections.unclassified,
      notAttributed: { items: notAttributed },
      acquisitions,
      owners,
      notOwned,
      flags,
      review: reviewOf(flags, placed),
      ruleVersions: ruleVersionsOf(
        placed,
        read.checks.filter((c) => acquisitions.some((a) => a.acquisitionId === c.acquisitionId)),
        registry,
        today,
      ),
    },
  };
}
