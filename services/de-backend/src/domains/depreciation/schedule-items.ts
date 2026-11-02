import { centsOf, moneyOfCents, type BusinessDate, type RuleVersion } from '../../shared/index.js';
import { NOT_OWNED_PART, componentIdOf, type CapitalizedItem, type ItemRef } from './capitalized-item.js';
import { byText, monthLabel, monthOf, yearOfDate, yearOfMonth } from './exact.js';
import { buildingRuleOn, isRateVerified, movableRuleOn } from './rate.js';
import { AFA_BUILDING_LINEAR, type BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import { AFA_MOVABLE_LINEAR, type MovableLinearParameters } from './rules/de-afa-movable-linear.js';
import type { Flag, ItemComponent } from './schedule-model.js';
import { partOf, type ItemContext, type ItemPart, type ItemWork } from './item-part.js';
import { walkPools } from './item-pools.js';

/**
 * The capitalised items of the schedule (api-design.md §59B, backlog VC-8-03; P8-D2 (2), P8-D6, P8-D7, P8-D8, B11):
 * one component per item, its parts §58C's per-item parts (the owners on the item's date, `NOT_OWNED` for the rest),
 * each part depreciated month by month in exact fractions and rounded once per year, cumulatively, half-up. On the
 * building an item starts by `subsequentCostStart`, runs at its owner's purchase rate and ends with the owner's
 * **pool** (one basis per ownership tenure, `POOLED_BASIS`) or its own series (`PER_ITEM_SERIES`); both are computed,
 * and the years in which they differ are open. A separate asset's items start in the month of `acquiredOn` and run at
 * `1/usefulLifeYears`. Nothing is stored; a figure that cannot be derived is `null` with a reason, never 0.00.
 */

// The items' parts (issue #191): the response types (`schedule-model.ts`), an owner's part of an item and its tenure
// (`item-part.ts`), the pools and the end (`item-pools.ts`) and the item's component (`item-component.ts`). Every name
// stays importable from here.
export type { ItemComponent, ItemComponentRate, ItemOwner, ItemSourceView } from './schedule-model.js';
export { tenureOf } from './item-part.js';
export type { ItemContext, ItemWork } from './item-part.js';
export { itemComponentOf, itemParticipants, itemYears } from './item-component.js';

// ---------------------------------------------------------------------------------------------------------------------
// The derivation

/**
 * The item components of a schedule (§59B): for the building, `items` are the capitalised items not linked to an
 * `ACTIVE` separate asset; for a separate asset, its linked items (`null` for a link whose source the read did not
 * find). The order is the start month, then `componentId`.
 */
export function deriveItemWorks(ctx: ItemContext, items: readonly { readonly ref: ItemRef; readonly item: CapitalizedItem | null }[]): ItemWork[] {
  const { asset, registry } = ctx;
  const separate = asset.assetType === 'SEPARATE_ASSET';
  const buildingVersions = registry.versions(AFA_BUILDING_LINEAR) as readonly RuleVersion<BuildingLinearParameters>[];
  const movableVersions = registry.versions(AFA_MOVABLE_LINEAR) as readonly RuleVersion<MovableLinearParameters>[];
  const works: ItemWork[] = [];
  for (const { ref, item } of items) {
    const componentId = componentIdOf(ref);
    const reasons: Flag[] = [];
    const flags: Flag[] = [];
    if (item === null) {
      reasons.push({ code: 'LINKED_ITEM_NOT_CAPITALIZED', details: { counts: false, treatment: null, anschaffungsnaheAcquisitionId: null } });
      works.push(emptyWork(ref, componentId, separate, reasons));
      continue;
    }
    const date = item.date;
    // The parameters: of the version of the item's (resp. the acquisition's) first year, else the latest (§59A item 5).
    let startMonth: number | null;
    let method: ItemComponent['start']['method'];
    let reviewStates: readonly string[];
    let disposal: BuildingLinearParameters['end']['disposal'] | undefined;
    let selected: ItemWork['selected'] = 'PER_ITEM_SERIES';
    let notBeforeOwnerStart = true;
    let startDate: BusinessDate | null = date;
    let startDateSource: ItemWork['startDateSource'] = 'ITEM_DATE';
    if (separate) {
      const acquiredOn = asset.acquiredOn as BusinessDate;
      startDate = acquiredOn;
      startDateSource = 'ACQUIRED_ON';
      const rule = movableRuleOn(registry, yearOfDate(acquiredOn)) ?? movableVersions[movableVersions.length - 1];
      startMonth = monthOf(acquiredOn) + ((rule?.parameters.firstYear.startMonthCounts ?? true) ? 0 : 1);
      method = 'MONTH_OF_ACQUISITION';
      reviewStates = rule?.parameters.basis.itemReviewStates ?? [];
      disposal = rule?.parameters.end.disposal;
      const supportedFrom = movableVersions[0]?.effectiveFrom ?? null;
      if (supportedFrom === null || acquiredOn < supportedFrom) reasons.push({ code: 'NO_APPLICABLE_RULE', details: { acquiredOn, supportedFrom } });
      if (yearOfDate(date) > yearOfDate(acquiredOn)) flags.push({ code: 'LATER_ITEM_TO_VERIFY', details: { date, acquiredOn } });
    } else {
      // §59F (VC-X-38): the start is the completion of the work (`performance.until`), never the booking date; interest
      // (`exemptTaxCategories`) keeps its booking date. Without a performance, or with one across a year end, the item is
      // not computed in any year (the owner's decisions of 2026-11-02, §59F open questions 9 and 10).
      const latest = buildingVersions[buildingVersions.length - 1];
      const start0 = (buildingRuleOn(registry, yearOfDate(item.performance?.until ?? date)) ?? latest)?.parameters.subsequentCostStart;
      const exempt = start0 === undefined || start0.exemptTaxCategories.includes(item.taxCategory);
      const performance = item.performance ?? null;
      if (!exempt && start0.performanceRequired && performance === null) {
        reasons.push({ code: 'PERFORMANCE_DATE_MISSING', details: { date, dateSource: item.dateSource, classificationId: item.classificationId } });
        startDate = null;
      } else if (!exempt && performance !== null && yearOfDate(performance.from) !== yearOfDate(performance.until)) {
        reasons.push({
          code: 'PERFORMANCE_SPANS_YEAR_END',
          details: { from: performance.from, until: performance.until, classificationId: item.classificationId },
        });
        startDate = null;
      } else if (!exempt && performance !== null) {
        startDate = performance.until;
        startDateSource = 'PERFORMANCE_UNTIL';
      }
      const year = yearOfDate(startDate ?? date);
      const rule = buildingRuleOn(registry, year) ?? latest;
      const start = rule?.parameters.subsequentCostStart;
      method = start?.method ?? 'START_OF_YEAR';
      notBeforeOwnerStart = start?.notBeforeOwnerStart.value ?? true;
      startMonth = startDate === null ? null : method === 'START_OF_YEAR' ? year * 12 : monthOf(startDate);
      reviewStates = rule?.parameters.basis.capitalizedItemReviewStates ?? [];
      disposal = rule?.parameters.end.disposal;
      selected = rule?.parameters.subsequentCostEnd.method ?? 'POOLED_BASIS';
      // §59A as decided 2026-10-31: no version before 2006, so an item starting before it is not computed in any year.
      const supportedFrom = buildingVersions[0]?.effectiveFrom ?? null;
      if (startMonth !== null && (supportedFrom === null || startMonth < monthOf(supportedFrom))) {
        reasons.push({ code: 'NO_APPLICABLE_RULE', details: { firstMonth: monthLabel(startMonth), supportedFrom } });
      }
      if (item.anschaffungsnaheAcquisitionId !== null)
        flags.push({ code: 'ANSCHAFFUNGSNAHE_CAPITALIZED', details: { acquisitionId: item.anschaffungsnaheAcquisitionId } });
    }
    const capitalized = item.counts && item.treatment === 'CAPITALIZED' && (!separate || item.anschaffungsnaheAcquisitionId === null);
    // Only a confirmed classification feeds a figure; the states are the rule's parameter, never a constant (§59B).
    if (capitalized && !reviewStates.includes(item.reviewState)) {
      reasons.push({ code: 'ITEM_CLASSIFICATION_NEEDS_REVIEW', details: { reviewState: item.reviewState, classificationId: item.classificationId } });
    }
    if (!capitalized) {
      reasons.push({
        code: 'LINKED_ITEM_NOT_CAPITALIZED',
        details: { counts: item.counts, treatment: item.treatment, anschaffungsnaheAcquisitionId: item.anschaffungsnaheAcquisitionId },
      });
    }
    // The order of §59B's table: ITEM_CLASSIFICATION_NEEDS_REVIEW, LINKED_ITEM_NOT_CAPITALIZED, then NO_APPLICABLE_RULE.
    reasons.sort((a, b) => order(a.code) - order(b.code));
    // §59F: the tax year against the start's year (the performance's on the building; else the item's date, as before);
    // open in every case (VC-X-38 as implemented: the level is per code, never informative by its details).
    const startYear = startDateSource === 'PERFORMANCE_UNTIL' && startDate !== null ? yearOfDate(startDate) : yearOfDate(date);
    if (startDate !== null && item.taxYear !== startYear) {
      flags.push({ code: 'CAPITALIZED_YEAR_DIFFERS', details: { date, taxYear: item.taxYear, startDate, dateSource: startDateSource } });
    }
    for (const f of item.flags) if (CARRIED_FLAGS.includes(f.code)) flags.push({ code: f.code, details: f.details });
    if (item.lineAmount.isNegative()) flags.push({ code: 'CAPITALIZED_REFUND', details: {} });

    // Without a start the parts still name the owners (on the share date); their months are never read (not computable).
    const partStart = startMonth ?? yearOfDate(date) * 12;
    const parts: ItemPart[] = item.parts.map((part) => {
      const basisCents = centsOf(part.amount);
      return partOf(ctx, { date, separate, startMonth: partStart, notBeforeOwnerStart, disposal, part: { ...part, basisCents } });
    });
    // §59F (open question 11): `notBeforeOwnerStart` is this spec's reading, not confirmed: flagged where it moves a start.
    if (!separate && startMonth !== null && notBeforeOwnerStart) {
      const owners = [...new Set(parts.filter((p) => p.tenureFrom !== null && monthOf(p.tenureFrom) > startMonth).map((p) => p.tenureFrom as BusinessDate))];
      for (const ownerStart of owners.sort(byText)) {
        flags.push({ code: 'SUBSEQUENT_COST_OWNER_START_TO_VERIFY', details: { startYear: yearOfMonth(startMonth), ownerStart } });
      }
    }
    const notOwned = parts.find((p) => p.participant === NOT_OWNED_PART);
    if (notOwned !== undefined && notOwned.basisCents !== 0n) {
      flags.push({
        code: 'CAPITALIZED_ITEM_NOT_OWNED',
        details: { notOwnedBasis: moneyOfCents(notOwned.basisCents, item.lineAmount.currency).toJSON(), date },
      });
    }
    // §59G Part 1 (VC-X-41): SUBSEQUENT_COST_SHORTER_LIFE_TO_VERIFY is withdrawn; a later cost in a shorter-life pool is
    // not computed (`SUBSEQUENT_COST_SHORTER_LIFE_NOT_SUPPORTED`, `REMAINING_USEFUL_LIFE_ENDED`; `item-part.ts`).
    const work: ItemWork = {
      item,
      ref,
      componentId,
      separate,
      startDate,
      startDateSource,
      startMonth,
      method,
      reasons,
      flags,
      parts,
      selected,
      parameters: {
        disposalVerified: disposal?.verified ?? false,
        rateVerified: (y: number, shorter: boolean) => {
          const rule = separate ? undefined : buildingRuleOn(registry, y);
          return rule === undefined || isRateVerified(rule.parameters, shorter);
        },
      },
      computable: ctx.assetReasons.length === 0 && reasons.length === 0,
    };
    works.push(work);
  }

  // The months: every pool of the building (one per tenure, heirs' and NOT_OWNED's of their own), both readings.
  walkPools(ctx, works);

  // §59F (VC-X-38): SUBSEQUENT_COST_START_TO_VERIFY is withdrawn; the confirmed rule (`verified`) and the open reading
  // (`notBeforeOwnerStart`, SUBSEQUENT_COST_OWNER_START_TO_VERIFY above) are kept apart.

  // REFUND_EXCEEDS_CAPITALIZED: an owner's item bases up to a refund's date sum to less than zero (§59B "A refund").
  for (const w of works) {
    if (w.item === null || !w.item.lineAmount.isNegative()) continue;
    for (const part of w.parts) {
      const sum = works
        .filter((o) => o.item !== null && o.item.date <= (w.item as CapitalizedItem).date)
        .flatMap((o) => o.parts.filter((p) => p.participant === part.participant))
        .reduce((s, p) => s + p.basisCents, 0n);
      if (sum < 0n) {
        w.flags.push({
          code: 'REFUND_EXCEEDS_CAPITALIZED',
          details: { ownerPartyId: part.participant, basisSum: moneyOfCents(sum, w.item.lineAmount.currency).toJSON(), refundComponentId: w.componentId },
        });
      }
    }
  }
  return works.sort((a, b) => (a.startMonth ?? 0) - (b.startMonth ?? 0) || byText(a.componentId, b.componentId));
}

/** The order of the item reasons in §59B's table. */
const REASON_ORDER = [
  'ITEM_CLASSIFICATION_NEEDS_REVIEW',
  'LINKED_ITEM_NOT_CAPITALIZED',
  'PERFORMANCE_DATE_MISSING',
  'PERFORMANCE_SPANS_YEAR_END',
  'USEFUL_LIFE_NOT_CONFIRMED',
  'NO_APPLICABLE_RULE',
];
const order = (code: string) => (REASON_ORDER.includes(code) ? REASON_ORDER.indexOf(code) : REASON_ORDER.length);

/** The item's own flags carried onto its component (§59B "The date", §58C). */
const CARRIED_FLAGS = ['WITHDRAWAL_DATE_ASSUMED', 'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE'];

function emptyWork(ref: ItemRef, componentId: string, separate: boolean, reasons: Flag[]): ItemWork {
  return {
    item: null,
    ref,
    componentId,
    separate,
    startDate: null,
    startDateSource: separate ? 'ACQUIRED_ON' : 'ITEM_DATE',
    startMonth: null,
    method: separate ? 'MONTH_OF_ACQUISITION' : 'START_OF_YEAR',
    reasons,
    flags: [],
    parts: [],
    selected: 'PER_ITEM_SERIES',
    parameters: { disposalVerified: false, rateVerified: () => true },
    computable: false,
  };
}
