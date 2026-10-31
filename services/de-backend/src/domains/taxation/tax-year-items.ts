import { centsOf, moneyOfCents, type BusinessDate } from '../../shared/index.js';
import type { Direction } from '../ledger/index.js';
import type { AttributionChange } from './attribution-changes.js';
import type { RefundInfo } from './cash-timing.js';
import type { TaxListItem } from './classification.js';
import type { DepositTaxMeaning } from './deposit-closing.js';
import { partOf, type Distribution } from './distribution-82b.js';
import { placementOf, signedCents, type Placement } from './tax-year-placement.js';
import type { TaxYearItem, TaxYearLoanAllocation, ViewFlag } from './tax-year-response.js';
import {
  covers,
  foldPerOwner,
  NOT_OWNED,
  participantsOn,
  shareOut,
  type FoldedParts,
  type Fraction,
  type Participant,
  type ViewOwnership,
} from './tax-year-shares.js';

/**
 * The items of the tax-year view (api-design.md §58C): what the view derives for each source of §55's list (its place,
 * share date, participants, parts and item flags) and the item it shows at a level.
 */

/** An item with what the view derived for it, before a level is chosen. */
export interface Derived {
  readonly source: TaxListItem;
  readonly placement: Placement;
  readonly date: BusinessDate;
  readonly participants: readonly Participant[];
  /** The property's signed contribution in `year`; `null` where nothing counts (notInView, unclassified). */
  readonly lineCents: bigint | null;
  /** Each participant's part of `lineCents` (absent: no part in `year`, for a § 82b source). */
  readonly parts: ReadonlyMap<string, bigint>;
  readonly folded: { readonly parts: FoldedParts; readonly endYears: ReadonlyMap<string, number> } | null;
  readonly flags: readonly ViewFlag[];
  /** An interest item of a Loan only (§58D): the set behind the property's part. */
  readonly loanAllocation: TaxYearLoanAllocation | null;
}

const dateOf = (m: TaxListItem): BusinessDate =>
  m.sourceType === 'TRANSACTION_SPLIT' ? m.bookingDate : m.sourceType === 'DEPOSIT_CLOSING' ? (m.closingDate as BusinessDate) : m.date;
const dateSourceOf = (m: TaxListItem): string =>
  m.sourceType === 'TRANSACTION_SPLIT' ? 'BOOKING' : m.sourceType === 'DEPOSIT_CLOSING' ? 'CLOSING' : m.dateSource;
const directionOf = (m: TaxListItem): Direction | null => (m.sourceType === 'TRANSACTION_SPLIT' ? m.direction : null);
const refundOfItem = (m: TaxListItem): RefundInfo | null => (m.sourceType === 'TRANSACTION_SPLIT' ? m.refund : null);
const distributionOfItem = (m: TaxListItem): Distribution | null => (m.sourceType === 'DEPOSIT_CLOSING' ? null : m.distribution);
const positionOf = (m: TaxListItem): number | null =>
  m.sourceType === 'WEG_RESERVE_WITHDRAWAL' || m.sourceType === 'WEG_ASSESSMENT_USE' ? m.sourcePosition : null;
const keyOfSource = (m: { readonly sourceType: string; readonly sourceId: string; readonly sourcePosition?: number | null }) =>
  `${m.sourceType}/${m.sourceId}/${m.sourcePosition ?? ''}`;

const sameOwnerships = (ownerships: readonly ViewOwnership[], a: BusinessDate, b: BusinessDate) => {
  const on = (day: BusinessDate) =>
    ownerships
      .filter((o) => covers(o, day))
      .map((o) => o.id)
      .sort()
      .join(',');
  return on(a) === on(b);
};

/**
 * What the view derives for a source. `propertyCents` is the property's non-negative part of a Loan's interest split
 * (§58D): it stands for the source's amount in every figure, and is shared out to the owners as any amount; `amount`
 * stays the whole split.
 */
export function deriveItem(
  source: TaxListItem,
  year: number,
  ownerships: readonly ViewOwnership[],
  changed: readonly AttributionChange[],
  propertyCents: bigint | null = null,
): Derived | undefined {
  const date = dateOf(source);
  const amount = propertyCents === null ? source.amount : moneyOfCents(propertyCents, source.amount.currency);
  const placement: Placement = source.counts ? placementOf({ ...source, refund: refundOfItem(source) }) : { place: 'UNCLASSIFIED' };
  const flags: ViewFlag[] = [];
  const distribution = distributionOfItem(source);
  let participants: readonly Participant[];
  let lineCents: bigint | null = null;
  let parts = new Map<string, bigint>();
  let folded: Derived['folded'] = null;
  if (distribution !== null && source.counts && placement.place === 'LINE') {
    // § 82b: the per-owner fold decides the parts of `year`; the property's part is their sum.
    const fold = foldPerOwner({ amount, firstYear: distribution.firstYear, years: distribution.years, rule: distribution.rule, date }, ownerships);
    participants = fold.participants;
    for (const [key, byYear] of fold.parts) {
      const cents = byYear.get(year);
      if (cents !== undefined) parts.set(key, cents);
    }
    if (parts.size === 0) return undefined;
    lineCents = [...parts.values()].reduce((s, c) => s + c, 0n);
    folded = { parts: fold.parts, endYears: fold.endYears };
    const yearAmount = partOf(distribution, year);
    if (yearAmount === undefined || centsOf(yearAmount) !== lineCents) {
      flags.push({
        code: 'DISTRIBUTION_FOLDED_PER_OWNER',
        details: {
          yearAmount: (yearAmount ?? moneyOfCents(0n, source.amount.currency)).toJSON(),
          lineAmount: moneyOfCents(lineCents, source.amount.currency).toJSON(),
          owners: [...fold.endYears.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ownerPartyId, endYear]) => ({ ownerPartyId, endYear })),
        },
      });
    }
  } else {
    // An earlier § 82b source that counts nowhere in `year` (outside a line) or does not count is not in the view.
    if (source.taxYear !== year && source.sourceType !== 'DEPOSIT_CLOSING') return undefined;
    participants = participantsOn(ownerships, date);
    if (placement.place === 'LINE' || placement.place === 'CAPITALIZED') {
      lineCents = signedCents({ amount, direction: directionOf(source), taxCategory: source.taxCategory }, placement);
      parts = shareOut(lineCents, participants);
    } else {
      for (const p of participants) parts.set(p.key, 0n);
    }
  }
  if (date < `${year}-01-01` || date > `${year}-12-31`) {
    const nearest = (date < `${year}-01-01` ? `${year}-01-01` : `${year}-12-31`) as BusinessDate;
    if (!sameOwnerships(ownerships, date, nearest))
      flags.push({ code: 'SHARE_DATE_OUTSIDE_TAX_YEAR', details: { shareDate: date, nearestDayOfYear: nearest } });
  }
  const moved = changed.flatMap((c) =>
    c.items
      .filter((i) => i.sourceId === source.sourceId && source.sourceType === 'TRANSACTION_SPLIT')
      .map((i) => ({
        rentalContractReferenceId: c.rentalContractReferenceId,
        auditRecordId: c.auditRecordId,
        amendedAt: c.amendedAt.toISOString(),
        yearBefore: i.yearBefore,
        yearAfter: i.yearAfter,
      })),
  );
  if (moved.length > 0 && source.taxYear === year) flags.push({ code: 'ATTRIBUTION_INPUT_CHANGED', details: moved });
  if (source.reviewState === 'NEEDS_REVIEW') flags.push({ code: 'NEEDS_REVIEW', details: {} });
  if (source.treatment === null) flags.push({ code: 'UNCLASSIFIED', details: {} });
  return { source, placement, date, participants, lineCents, parts, folded, flags, loanAllocation: null };
}

const formatFraction = (f: Fraction) => `${f.numerator}/${f.denominator}`;

/** The item at a level: the property's (`participant` undefined) or one participant's part. */
export function itemAt(d: Derived, year: number, currency: string, participant: string | undefined): TaxYearItem {
  const m = d.source;
  const money = (cents: bigint) => moneyOfCents(cents, currency);
  const distribution = distributionOfItem(m);
  const p = participant === undefined ? undefined : d.participants.find((x) => x.key === participant);
  const partCents = participant === undefined ? undefined : d.parts.get(participant);
  const lineCents = participant === undefined ? d.lineCents : d.lineCents === null ? null : (partCents ?? 0n);
  const ownerParts =
    participant === undefined || d.folded === null
      ? null
      : [...(d.folded.parts.get(participant) ?? new Map<number, bigint>()).entries()]
          .sort(([a], [b]) => a - b)
          .map(([y, cents]) => ({ year: y, amount: money(cents) }));
  return {
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    sourcePosition: positionOf(m),
    transactionId: m.sourceType === 'TRANSACTION_SPLIT' ? m.transactionId : null,
    date: d.date,
    dateSource: dateSourceOf(m),
    taxYear: m.taxYear,
    direction: directionOf(m),
    amount: m.amount,
    lineAmount: lineCents === null ? null : money(lineCents),
    taxCategory: m.taxCategory,
    treatment: m.treatment,
    reviewState: m.reviewState,
    origin: m.origin,
    classificationId: m.classificationId,
    rule: m.rule,
    treatmentRule: m.sourceType === 'DEPOSIT_CLOSING' ? null : m.treatmentRule,
    attribution: m.sourceType === 'DEPOSIT_CLOSING' ? null : m.attribution,
    refund: refundOfItem(m),
    distribution: distribution === null ? null : { ...distribution, yearAmount: partOf(distribution, year) ?? money(0n), ownerParts },
    suggestion: m.sourceType === 'DEPOSIT_CLOSING' ? null : m.suggestion,
    share:
      p === undefined
        ? null
        : {
            ownershipId: [...p.ownershipIds].sort()[0] ?? NOT_OWNED,
            share: formatFraction(p.share),
            amount: lineCents === null ? null : money(lineCents),
          },
    flags: [...(m.flags as readonly ViewFlag[]), ...d.flags],
    notAttributed: null,
    loanAllocation: d.loanAllocation,
  };
}

export function notAttributedItem(m: DepositTaxMeaning): TaxYearItem {
  const flag = m.flags.find((f) => f.code === 'NO_PROPERTY_REFERENCE');
  const details = (flag?.details ?? { reason: 'NO_RECONCILED_RENT' }) as { reason: string; candidates?: readonly string[] };
  return {
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    sourcePosition: null,
    transactionId: null,
    date: m.closingDate as BusinessDate,
    dateSource: 'CLOSING',
    taxYear: m.taxYear,
    direction: null,
    amount: m.amount,
    lineAmount: null,
    taxCategory: m.taxCategory,
    treatment: m.treatment,
    reviewState: m.reviewState,
    origin: m.origin,
    classificationId: m.classificationId,
    rule: m.rule,
    treatmentRule: null,
    attribution: null,
    refund: null,
    distribution: null,
    suggestion: null,
    share: null,
    flags: [
      ...(m.flags as readonly ViewFlag[]),
      ...(m.reviewState === 'NEEDS_REVIEW' ? [{ code: 'NEEDS_REVIEW', details: {} }] : []),
      ...(m.treatment === null ? [{ code: 'UNCLASSIFIED', details: {} }] : []),
    ],
    notAttributed: { reason: details.reason, candidates: details.candidates ?? [], href: `/api/v1/security-deposits/${m.sourceId}/tax-meaning` },
    loanAllocation: null,
  };
}

/** For tests and callers comparing a view with §55's list: the source key of an item. */
export const sourceKeyOf = (item: { readonly sourceType: string; readonly sourceId: string; readonly sourcePosition?: number | null }) => keyOfSource(item);
