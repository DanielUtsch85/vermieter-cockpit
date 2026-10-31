import { centsOf, moneyOfCents, type BusinessDate, type Money, type RuleRegistry } from '../../shared/index.js';
import type { Direction } from '../ledger/index.js';
import type { AnschaffungsnaheCheck, NotFinalReason } from './anschaffungsnahe.js';
import { attributionChanges, type AttributionInput } from './attribution-changes.js';
import type { TaxListItem } from './classification.js';
import type { DepositTaxMeaning } from './deposit-closing.js';
import { deriveItem, notAttributedItem, type Derived } from './tax-year-items.js';
import { reviewOf, ruleVersionsOf } from './tax-year-review.js';
import type { TaxYearAcquisition, TaxYearTotals, TaxYearView, ViewFlag } from './tax-year-response.js';
import { sectionsOf, withoutItems } from './tax-year-sections.js';
import { NOT_OWNED, type ViewOwnership } from './tax-year-shares.js';

/**
 * The tax-year view (api-design.md §58C, phase-7-plan P7-D7, P7-D8): §55's per-year list, grouped and summed into
 * Einnahmen, Werbungskosten and the result before AfA, per PropertyReference and per owner. Derived on every read from
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

/** At most this many items over all places, `notInView` and the deposits not attributed included (§58C). */
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
   * The counting `LOAN_INTEREST` splits of `year` (§58A's tax year, as the list derives it) of the Loans with a `VALID`
   * LoanAllocation set naming this PropertyReference. A split with a `loanId` carries no PropertyReference (0027), so
   * the view places none of them: they only raise `LOAN_INTEREST_NOT_ATTRIBUTED` (VC-X-29 decides the attribution).
   */
  readonly allocatedLoanInterest: readonly { readonly splitId: string; readonly loanId: string; readonly direction: Direction; readonly amount: Money }[];
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
  const derived = read.sources.map((s) => deriveItem(s.item, year, read.ownerships, attribution.changes)).filter((d): d is Derived => d !== undefined);

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
  const itemCount = derived.length + unattributed.length;
  if (itemCount > TAX_YEAR_ITEM_LIMIT) return { kind: 'TAX_YEAR_TOO_LARGE', itemCount, limit: TAX_YEAR_ITEM_LIMIT };

  const participant = ownerPartyId ?? undefined;
  const sections = sectionsOf(derived, year, currency, participant);
  const notAttributed = unattributed.map(notAttributedItem);

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
  if (notAttributed.length > 0) flags.push({ code: 'UNATTRIBUTED_ITEMS', details: { count: notAttributed.length } });
  // Interest of an allocated Loan reaches no line (VC-X-29): flagged at both levels with the property's total, never summed.
  const interest = read.allocatedLoanInterest;
  if (interest.length > 0) {
    const total = interest.reduce((s, i) => s + (i.direction === 'OUTFLOW' ? centsOf(i.amount) : -centsOf(i.amount)), 0n);
    flags.push({
      code: 'LOAN_INTEREST_NOT_ATTRIBUTED',
      details: {
        loanIds: [...new Set(interest.map((i) => i.loanId))].sort(),
        interestTotal: moneyOfCents(total, currency).toJSON(),
        splitIds: interest.map((i) => i.splitId).sort(),
      },
    });
  }
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
