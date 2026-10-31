import { Money, centsOf, moneyOfCents, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import { transferDate } from '../acquisition/index.js';
import { isConfirmed } from './asset.js';
import { byText, yearOfDate } from './exact.js';
import { componentIdOf, isCapitalized, sameItem, type CapitalizedItem, type ItemRef } from './capitalized-item.js';
import { movableRuleOn } from './rate.js';
import { AFA_BUILDING_LINEAR, type BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import { AFA_MOVABLE_LINEAR, type MovableLinearParameters } from './rules/de-afa-movable-linear.js';
import { deriveItemWorks, itemComponentOf, itemYears, type ItemComponent, type ItemWork } from './schedule-items.js';
import { componentOf } from './purchase-component.js';
import { uncoveredIn, walkOwnerMonths, walkTenures } from './purchase-tenure.js';
import { purchaseWorkOf, type Work } from './purchase-work.js';
import {
  RANGE_MAX_YEAR,
  RANGE_MIN_YEAR,
  type AssetLink,
  type CalculationStatus,
  type ComponentYear,
  type DepreciationSchedule,
  type Flag,
  type ScheduleComponent,
  type ScheduleInput,
  type ScheduleOwnership,
  type ScheduleStatus,
  type ScheduleYear,
} from './schedule-model.js';
import { INFORMATIVE_CODES, isOpen, mergeFlags, reviewOf, ruleVersionsOf, sortFlags } from './schedule-review.js';

/**
 * The depreciation schedule of the purchase (api-design.md §59A, backlog VC-8-02; P8-D2, P8-D3, P8-D5, P8-D8, P8-D9;
 * §28.1A "Effect on §59A"). Derived on every read from one snapshot, never stored: per Acquisition (a component) and per
 * owner part, month by month in exact fractions, each owner's year rounded once, cumulatively, half-up to the cent. A
 * figure that cannot be derived is `null` with a reason, never 0.00 (decided 2026-10-31). The capitalised items
 * (`CAPITALIZED_ITEM`) and a separate asset's schedule are VC-8-03's (§59B, `schedule-items.ts`); recorded versions
 * (VC-8-04) and the tax-year view (VC-8-05) build on this.
 */

// The schedule's parts (issue #191): the inputs and the response (`schedule-model.ts`), the purchase component's start,
// basis and owner parts (`purchase-work.ts`), the owners' tenure and the disposal year (`purchase-tenure.ts`), the
// purchase component's years (`purchase-component.ts`), the open and informative codes and the review
// (`schedule-review.ts`), and the capitalised items (`schedule-items.ts`). Every name stays importable from here.
export type {
  AssetLink,
  CalculationStatus,
  ComponentBasis,
  ComponentOwner,
  ComponentRate,
  ComponentYear,
  DepreciationSchedule,
  DepreciationScheduleSource,
  Flag,
  OwnerYear,
  ScheduleAcquisition,
  ScheduleAllocation,
  ScheduleComponent,
  ScheduleCost,
  ScheduleInput,
  ScheduleOwnership,
  ScheduleRead,
  ScheduleStatus,
  ScheduleYear,
  YearRule,
} from './schedule-model.js';
export { RANGE_MAX_YEAR, RANGE_MIN_YEAR } from './schedule-model.js';
export { INFORMATIVE_CODES } from './schedule-review.js';
export type { Part, Work } from './purchase-work.js';

export function deriveSchedule(input: ScheduleInput, registry: RuleRegistry): DepreciationSchedule {
  const { asset } = input;
  const versions = registry.versions(AFA_BUILDING_LINEAR) as readonly RuleVersion<BuildingLinearParameters>[];
  const latest = versions[versions.length - 1];
  // DE computes no year before the first version, and a contract before it may run a method DE does not know (§59A).
  const supportedFrom = versions[0]?.effectiveFrom ?? null;
  const separate = asset.assetType === 'SEPARATE_ASSET';
  const capitalizedItems = input.capitalizedItems ?? [];
  const links = input.links ?? [];
  const assetReasons: Flag[] = [];
  if (asset.status === 'VOID') assetReasons.push({ code: 'ASSET_VOID', details: {} });
  if (!separate && asset.buildingCompletionYear === null) assetReasons.push({ code: 'COMPLETION_YEAR_MISSING', details: {} });
  if (!isConfirmed(asset.reviewState)) assetReasons.push({ code: 'ASSET_NOT_CONFIRMED', details: {} });
  // §59B: a separate asset without a counting CAPITALIZED item has nothing to depreciate.
  const linkedItems = asset.items.map((ref) => ({ ref, item: capitalizedItems.find((i) => sameItem(i, ref)) ?? null }));
  if (separate && !linkedItems.some(({ item }) => item !== null && isCapitalized(item) && item.anschaffungsnaheAcquisitionId === null)) {
    assetReasons.push({ code: 'NO_CAPITALIZED_ITEMS', details: {} });
  }

  const carrying = (id: string) => input.ownerships.filter((o) => o.acquisitionId === id);
  // A separate asset has no purchase components: its cost is its items (§59B).
  const listed = (separate ? [] : input.acquisitions)
    .filter((a) => a.status === 'CONFIRMED' || (a.status === 'DRAFT' && carrying(a.id).length > 0))
    .map((a) => ({ a, ownedFrom: transferDate(a) }))
    .sort((x, y) => byText(x.ownedFrom, y.ownedFrom) || byText(x.a.id, y.a.id));
  const rowsOf = (partyId: string) => input.ownerships.filter((o) => o.partyId === partyId);

  const works: Work[] = listed.map(({ a, ownedFrom }) =>
    purchaseWorkOf({ registry, asset, latest, supportedFrom, assetReasons, carrying, rowsOf }, a, ownedFrom),
  );

  // The tenure and the still-held fraction per Party, over all its components at once (§59A, §28.1A). A separate
  // asset's owners are its items' (§59B): OWNER_WITHOUT_ACQUISITION concerns the building's purchases only.
  const parties = separate
    ? []
    : [...new Set([...input.ownerships.map((o) => o.partyId), ...works.flatMap((w) => w.parts.map((p) => p.ownerPartyId))])].sort(byText);
  const coverage = walkTenures(parties, works, rowsOf);

  // Per owner part: the cut-off, the months and the exact cumulative AfA (§59A "Per owner").
  walkOwnerMonths(input, works, latest);

  // §59B: the item components. The building takes every capitalised item not linked to an ACTIVE separate asset; a
  // separate asset its linked items.
  const itemContext = { registry, asset, assetReasons, works, ownerships: input.ownerships, acquisitions: input.acquisitions };
  const excluded = separate ? [] : capitalizedItems.filter((i) => isCapitalized(i) && links.some((l) => sameItem(l, i)));
  const itemWorks: ItemWork[] = deriveItemWorks(
    itemContext,
    separate
      ? linkedItems
      : capitalizedItems
          .filter((i) => isCapitalized(i) && !excluded.includes(i))
          .map((item) => ({ ref: item as ItemRef, item: item as CapitalizedItem | null })),
  );
  const excludedItems = separate
    ? null
    : excluded
        .map((i) => ({ componentId: componentIdOf(i), separateAssetId: (links.find((l) => sameItem(l, i)) as AssetLink).assetId }))
        .sort((a, b) => byText(a.componentId, b.componentId));

  // The range (§59A "Path and query"): defaults from the components, clamped to 2000–2100.
  const todayYear = yearOfDate(input.today);
  const clamp = (y: number) => Math.min(RANGE_MAX_YEAR, Math.max(RANGE_MIN_YEAR, y));
  const lastYearOf = (w: Work): number | null => {
    const years = w.parts.flatMap((p) => [...p.years.entries()].filter(([, v]) => v.months > 0).map(([y]) => y));
    return years.length === 0 ? null : Math.max(...years);
  };
  const computableLast = [...works.filter((w) => w.computable).map(lastYearOf), ...itemWorks.filter((w) => w.computable).map((w) => itemYears(w).last)].filter(
    (y): y is number => y !== null,
  );
  const naturalTo = computableLast.length === 0 ? todayYear : Math.max(...computableLast);
  const starts = [
    ...works.map((w) => (w.start === null ? w.firstYear : yearOfDate(w.start))),
    ...itemWorks.map((w) => itemYears(w).first).filter((y): y is number => y !== null),
  ];
  const from = input.from ?? clamp(starts.length === 0 ? todayYear : Math.min(...starts));
  let to = input.to ?? clamp(naturalTo);
  if (to < from) to = from;
  const truncated = input.to === undefined && naturalTo > RANGE_MAX_YEAR;

  const level = input.ownerPartyId === null ? 'PROPERTY' : 'OWNER';
  const shown = input.ownerPartyId === null ? works : works.filter((w) => w.parts.some((p) => p.ownerPartyId === input.ownerPartyId));
  const partsShown = (w: Work) => (input.ownerPartyId === null ? w.parts : w.parts.filter((p) => p.ownerPartyId === input.ownerPartyId));

  const components: (ScheduleComponent | ItemComponent)[] = [
    ...shown.map((w) => componentOf(w, partsShown(w), { from, to }, assetReasons)),
    ...itemWorks
      .filter((w) => input.ownerPartyId === null || w.parts.some((p) => p.participant === input.ownerPartyId))
      .map((w) => itemComponentOf(w, itemContext, { from, to }, input.ownerPartyId, INFORMATIVE_CODES)),
  ];

  // The schedule's years: components summed, never distributed (P8-D8, F4b).
  const years: ScheduleYear[] = [];
  for (let year = from; year <= to; year++) {
    const active = components
      .map((c) => ({ c, y: c.years.find((y) => y.year === year) }))
      .filter((x): x is { c: ScheduleComponent | ItemComponent; y: ComponentYear } => x.y !== undefined);
    const calculable = active.filter(({ y }) => y.calculationStatus !== 'NOT_CALCULABLE');
    const sum = (values: readonly (Money | null)[]) =>
      values.some((v) => v === null) ? null : moneyOfCents(values.reduce((s, v) => s + centsOf(v as Money), 0n));
    const ownerIds = [...new Set(active.flatMap(({ y }) => y.owners.map((o) => o.ownerPartyId)))].sort(byText);
    const flags: Flag[] = mergeFlags(active.flatMap(({ c, y }) => [...c.flags, ...y.flags].map((f) => ({ componentId: c.componentId, flag: f }))));
    for (const partyId of input.ownerPartyId === null ? parties : [input.ownerPartyId]) {
      const gap = uncoveredIn(coverage.get(partyId) ?? [], year);
      if (gap !== undefined) flags.push({ code: 'OWNER_WITHOUT_ACQUISITION', details: { ownerPartyId: partyId, ...gap } });
    }
    const reasons = [...assetReasons, ...mergeFlags(active.flatMap(({ c, y }) => y.reasons.map((f) => ({ componentId: c.componentId, flag: f }))))];
    // A year with some figures (a component, or one owner of it) is PARTIAL; one without any is not available.
    const someFigure = active.some(({ y }) => y.owners.some((o) => o.calculationStatus !== 'NOT_CALCULABLE'));
    const status: ScheduleStatus =
      assetReasons.length > 0
        ? 'DEPRECIATION_NOT_AVAILABLE'
        : calculable.length === active.length
          ? 'AVAILABLE'
          : someFigure
            ? 'PARTIAL'
            : 'DEPRECIATION_NOT_AVAILABLE';
    const notCalculable = assetReasons.length > 0 || calculable.length < active.length;
    const calculationStatus: CalculationStatus = notCalculable
      ? 'NOT_CALCULABLE'
      : active.some(({ y }) => y.calculationStatus === 'PROVISIONAL') || flags.some((f) => isOpen(f.code))
        ? 'PROVISIONAL'
        : 'CALCULATED';
    years.push({
      year,
      status,
      calculationStatus,
      amount: notCalculable ? null : sum(active.map(({ y }) => y.amount)),
      residualValue: notCalculable ? null : sum(active.map(({ y }) => y.residualValue)),
      owners:
        level === 'OWNER'
          ? null
          : ownerIds.map((ownerPartyId) => ({
              ownerPartyId,
              amount: sum(active.flatMap(({ y }) => y.owners.filter((o) => o.ownerPartyId === ownerPartyId).map((o) => o.amount))),
            })),
      // §59B: the NOT_OWNED parts of the item components, summed; null at the owner level and without one.
      notOwned:
        level === 'OWNER' || notCalculable || !active.some(({ y }) => y.notOwned !== null)
          ? null
          : sum(active.flatMap(({ y }) => (y.notOwned === null ? [] : [y.notOwned]))),
      reasons: sortFlags(reasons),
      flags: sortFlags(flags),
    });
  }

  // §59B: a separate asset whose cost is at most the GWG threshold (gross, or net when every item has a net amount).
  const scheduleFlags: Flag[] = [];
  if (separate) {
    const counted = linkedItems.flatMap(({ item }) => (item !== null && isCapitalized(item) && item.anschaffungsnaheAcquisitionId === null ? [item] : []));
    const versions = registry.versions(AFA_MOVABLE_LINEAR) as readonly RuleVersion<MovableLinearParameters>[];
    const rule = (asset.acquiredOn === null ? undefined : movableRuleOn(registry, yearOfDate(asset.acquiredOn))) ?? versions[versions.length - 1];
    if (counted.length > 0 && rule !== undefined) {
      const threshold = centsOf(Money.of(rule.parameters.gwgHint.netThreshold, counted[0]?.lineAmount.currency ?? 'EUR'));
      const gross = counted.reduce((s, i) => s + centsOf(i.lineAmount), 0n);
      const net = counted.every((i) => i.netAmount !== null) ? counted.reduce((s, i) => s + centsOf(i.netAmount as Money), 0n) : null;
      if (gross <= threshold || (net !== null && net <= threshold)) {
        scheduleFlags.push({
          code: 'GWG_THRESHOLD_MAY_APPLY',
          details: {
            netThreshold: rule.parameters.gwgHint.netThreshold,
            grossCost: moneyOfCents(gross).toJSON(),
            netCost: net === null ? null : moneyOfCents(net).toJSON(),
            legalBasis: rule.parameters.gwgHint.legalBasis,
          },
        });
      }
    }
  }

  const status: ScheduleStatus =
    assetReasons.length > 0
      ? 'DEPRECIATION_NOT_AVAILABLE'
      : components.every((c) => c.status === 'COMPUTABLE')
        ? 'AVAILABLE'
        : components.some((c) => c.status === 'COMPUTABLE')
          ? 'PARTIAL'
          : 'DEPRECIATION_NOT_AVAILABLE';

  return {
    assetId: asset.id,
    propertyReferenceId: asset.propertyReferenceId,
    assetType: asset.assetType,
    level,
    ownerPartyId: input.ownerPartyId,
    computedOn: input.today,
    range: { from, to, truncated },
    status,
    reasons: assetReasons,
    flags: scheduleFlags,
    asset: separate
      ? {
          status: asset.status,
          description: asset.description,
          usefulLifeYears: asset.usefulLifeYears,
          acquiredOn: asset.acquiredOn,
          reviewState: asset.reviewState,
        }
      : { status: asset.status, buildingCompletionYear: asset.buildingCompletionYear, reviewState: asset.reviewState },
    components,
    excludedItems,
    years,
    review: reviewOf(assetReasons, scheduleFlags, components, years),
    ruleVersions: ruleVersionsOf(components, registry, input.today),
  };
}

/**
 * Whether `partyId` owns the PropertyReference at any time or bought a listed component (§59A, `NOT_AN_OWNER`): a buyer
 * of a listed component holds a `VALID` Ownership carrying its id, so the `VALID` Ownerships answer both.
 */
export function isOwnerOf(ownerships: readonly ScheduleOwnership[], partyId: string): boolean {
  return ownerships.some((o) => o.partyId === partyId);
}
