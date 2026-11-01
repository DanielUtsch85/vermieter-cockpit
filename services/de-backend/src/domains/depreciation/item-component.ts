import { centsOf, moneyOfCents, type Money } from '../../shared/index.js';
import { NOT_OWNED_PART } from './capitalized-item.js';
import { ZERO, add, byText, monthLabel, monthOf, rateOfYear, show, yearOfDate, yearOfMonth, type Frac } from './exact.js';
import { buildingRuleOn, movableRuleOn, reciprocalPercent } from './rate.js';
import { AFA_BUILDING_LINEAR } from './rules/de-afa-building-linear.js';
import type { ComponentYear, Flag, ItemComponent, ItemComponentRate, OwnerYear } from './schedule-model.js';
import { roundCents, type ItemContext, type ItemPart, type ItemWork, type PartRate, type Reading } from './item-part.js';
import { lastYearOf } from './item-pools.js';

/**
 * A capitalised item's component of the response (api-design.md §59B "The component"): its rate, its end, its owners
 * and `NOT_OWNED` part, and its years, each part's year rounded once, cumulatively, half-up. Moved out of
 * `schedule-items.ts` unchanged (issue #191).
 */

// ---------------------------------------------------------------------------------------------------------------------
// The component of the response

const isOpenCode = (informative: readonly string[]) => (code: string) => !informative.includes(code);

/** The exact cumulative AfA of a part in cents to the end of `year`. */
function cumulativeCents(reading: Reading, year: number): Frac {
  let total = ZERO;
  for (const [m, amount] of reading.monthly) if (yearOfMonth(m) <= year) total = add(total, amount);
  return total;
}

export function itemComponentOf(
  w: ItemWork,
  ctx: ItemContext,
  range: { readonly from: number; readonly to: number },
  ownerPartyId: string | null,
  informative: readonly string[],
): ItemComponent {
  const isOpen = isOpenCode(informative);
  const currency = w.item?.lineAmount.currency ?? 'EUR';
  const reasonsOfComponent = [...ctx.assetReasons, ...w.reasons];
  const componentOpen = w.flags.some((f) => isOpen(f.code));
  const readingOf = (p: ItemPart) => (p.stopFrom !== null ? p.perItem : w.selected === 'POOLED_BASIS' ? p.pooled : p.perItem);
  const alternativeOf = (p: ItemPart) => (w.selected === 'POOLED_BASIS' ? p.perItem : p.pooled);
  const lastYear = w.computable ? lastYearOf(w) : null;
  const partLastYear = (p: ItemPart): number => {
    const reading = readingOf(p);
    const ends = [
      yearOfMonth(p.firstMonth),
      ...(reading.lastMonth === null ? [] : [yearOfMonth(reading.lastMonth)]),
      ...(p.endToVerify === null ? [] : [p.endToVerify.to]),
    ];
    const end = Math.max(...ends);
    return p.lastDay === null ? end : Math.min(end, yearOfDate(p.lastDay));
  };
  const ownerYearOf = (p: ItemPart, year: number): OwnerYear => {
    const notCalculable = (reasons: readonly Flag[]): OwnerYear => ({
      ownerPartyId: p.participant,
      months: null,
      fraction: null,
      amount: null,
      residualValue: null,
      calculationStatus: 'NOT_CALCULABLE',
      reasons,
      flags: [],
    });
    if (!w.computable) return notCalculable(reasonsOfComponent);
    if (p.partReasons.length > 0) return notCalculable(p.partReasons);
    if (p.missingFrom !== null && year >= p.missingFrom.year) return notCalculable([{ code: 'DISPOSAL_DATE_MISSING', details: p.missingFrom.details }]);
    if (p.stopFrom !== null && year >= p.stopFrom.year) return notCalculable([p.stopFrom.reason]);
    const reading = readingOf(p);
    const now = roundCents(cumulativeCents(reading, year));
    const before = roundCents(cumulativeCents(reading, year - 1));
    const counted = reading.counted.get(year);
    const flags: Flag[] = [];
    if (!w.parameters.rateVerified(year, p.rate?.kind === 'SHORTER_USEFUL_LIFE')) {
      const rule = buildingRuleOn(ctx.registry, year);
      flags.push({ code: 'HISTORICAL_RULE_TO_VERIFY', details: { ruleCode: rule?.ruleCode ?? AFA_BUILDING_LINEAR, version: rule?.version ?? null } });
    }
    const disposal = p.disposals.get(year);
    if (disposal !== undefined && !w.parameters.disposalVerified)
      flags.push({ code: 'DISPOSAL_YEAR_TO_VERIFY', details: { ...disposal, months: counted?.months ?? 0 } });
    for (const c of p.changes.filter((c) => yearOfDate(c.date) === year)) {
      flags.push({ code: 'OWNER_SHARE_CHANGED', details: { date: c.date, from: show(c.from), to: show(c.to) } });
    }
    if (p.endToVerify !== null && year >= p.endToVerify.from && year <= p.endToVerify.to) {
      const alternative = alternativeOf(p);
      const alternativeAmount =
        p.endToVerify.details['alternativeAmount'] === null
          ? null
          : moneyOfCents(roundCents(cumulativeCents(alternative, year)) - roundCents(cumulativeCents(alternative, year - 1)), currency).toJSON();
      flags.push({ code: 'SUBSEQUENT_COST_END_TO_VERIFY', details: { ...p.endToVerify.details, alternativeAmount } });
    }
    const open = componentOpen || flags.some((f) => isOpen(f.code));
    return {
      ownerPartyId: p.participant,
      months: counted?.months ?? 0,
      fraction: counted === undefined ? null : show(counted.fraction),
      amount: moneyOfCents(now - before, currency),
      residualValue: moneyOfCents(p.basisCents - now, currency),
      calculationStatus: open ? 'PROVISIONAL' : 'CALCULATED',
      reasons: [],
      flags: sortFlags(flags),
    };
  };
  const shownParts = ownerPartyId === null ? w.parts : w.parts.filter((p) => p.participant === ownerPartyId);
  const listedIn = (p: ItemPart, year: number) => {
    if (!w.computable || p.partReasons.length > 0) return true;
    return year >= yearOfMonth(p.firstMonth) && year <= partLastYear(p);
  };
  const firstYear = w.startMonth === null ? range.from : yearOfMonth(w.startMonth);
  const yearsTo = w.computable && lastYear !== null ? Math.min(range.to, Math.max(lastYear, ...w.parts.map(partLastYear))) : range.to;
  const years: ComponentYear[] = [];
  for (let year = Math.max(range.from, firstYear); year <= yearsTo; year++) {
    const listed = shownParts.filter((p) => listedIn(p, year)).map((p) => ({ p, y: ownerYearOf(p, year) }));
    const owners = listed.filter(({ p }) => p.participant !== NOT_OWNED_PART).map(({ y }) => y);
    const notOwnedYear = listed.find(({ p }) => p.participant === NOT_OWNED_PART)?.y;
    const all = listed.map(({ y }) => y);
    const notCalculable = all.some((o) => o.calculationStatus === 'NOT_CALCULABLE') || !w.computable;
    const known =
      w.computable &&
      w.parts.every(
        (p) => p.partReasons.length === 0 && (p.missingFrom === null || p.missingFrom.year > year) && (p.stopFrom === null || p.stopFrom.year > year),
      );
    const cumulative = known ? w.parts.map((p) => roundCents(cumulativeCents(readingOf(p), year))) : null;
    const sum = (values: readonly bigint[]) =>
      moneyOfCents(
        values.reduce((s, v) => s + v, 0n),
        currency,
      );
    const rule = w.separate ? movableRuleOn(ctx.registry, year) : buildingRuleOn(ctx.registry, year);
    const band = w.separate || rule === undefined ? null : rateOfYear(ctx.registry, year, ctx.asset.buildingCompletionYear, undefined)?.band;
    years.push({
      year,
      rule: rule === undefined ? null : { ruleCode: rule.ruleCode, version: rule.version, band: band?.band ?? null, legalBasis: band?.legalBasis ?? null },
      months: w.computable ? Math.max(0, ...w.parts.map((p) => readingOf(p).counted.get(year)?.months ?? 0)) : null,
      amount: notCalculable ? null : sum(all.map((o) => centsOf(o.amount as Money))),
      cumulative: notCalculable || cumulative === null ? null : sum(cumulative),
      residualValue: notCalculable || cumulative === null ? null : sum(w.parts.map((p, i) => p.basisCents - (cumulative[i] as bigint))),
      notOwned: notOwnedYear === undefined || ownerPartyId !== null ? null : notOwnedYear.amount,
      calculationStatus: notCalculable
        ? 'NOT_CALCULABLE'
        : all.some((o) => o.calculationStatus === 'PROVISIONAL') || componentOpen
          ? 'PROVISIONAL'
          : 'CALCULATED',
      reasons: notCalculable ? mergeOwnerFlags(listed.map(({ y }) => ({ ownerPartyId: y.ownerPartyId, flags: y.reasons }))) : [],
      owners,
      flags: mergeOwnerFlags(listed.map(({ y }) => ({ ownerPartyId: y.ownerPartyId, flags: y.flags }))),
    });
  }
  const lastMonth = w.computable
    ? Math.max(
        ...w.parts.flatMap((p) => {
          const m = readingOf(p).lastMonth;
          return m === null ? [] : [p.lastDay === null ? m : Math.min(m, monthOf(p.lastDay))];
        }),
      )
    : null;
  const notOwned = w.parts.find((p) => p.participant === NOT_OWNED_PART);
  const item = w.item;
  const rateYear = Math.max(firstYear, Math.min(range.to, lastYear ?? range.to));
  const componentRate: ItemComponentRate | null = w.separate
    ? ctx.asset.usefulLifeYears === null
      ? null
      : {
          kind: 'USEFUL_LIFE',
          band: null,
          ratePercent: reciprocalPercent(ctx.asset.usefulLifeYears),
          rate: `1/${ctx.asset.usefulLifeYears}`,
          usefulLifeYears: ctx.asset.usefulLifeYears,
          legalBasis: '§ 7 Abs. 1 EStG',
        }
    : (() => {
        const r = rateOfYear(ctx.registry, rateYear, ctx.asset.buildingCompletionYear, undefined);
        return r === undefined
          ? null
          : { kind: 'BAND', band: r.band.band, ratePercent: r.band.ratePercent, rate: show(r.annual), usefulLifeYears: null, legalBasis: r.band.legalBasis };
      })();
  return {
    componentId: w.componentId,
    kind: 'CAPITALIZED_ITEM',
    source: {
      sourceType: w.ref.sourceType,
      sourceId: w.ref.sourceId,
      sourcePosition: w.ref.sourcePosition,
      classificationId: item?.classificationId ?? null,
      reviewState: item?.reviewState ?? null,
      taxCategory: item?.taxCategory ?? null,
      date: item?.date ?? null,
      dateSource: item?.dateSource ?? null,
      taxYear: item?.taxYear ?? null,
      anschaffungsnaheAcquisitionId: item?.anschaffungsnaheAcquisitionId ?? null,
    },
    status: w.computable ? 'COMPUTABLE' : 'NOT_COMPUTABLE',
    reasons: w.reasons,
    basis: { amount: item?.lineAmount ?? null, netAmount: item?.netAmount ?? null, amountUsed: 'GROSS_LINE_AMOUNT' },
    start: {
      date: w.startDate,
      dateSource: w.separate ? 'ACQUIRED_ON' : 'ITEM_DATE',
      method: w.method,
      month: w.startMonth === null ? null : monthLabel(w.startMonth),
      firstYearMonths: w.startMonth === null ? null : 12 - (w.startMonth % 12),
    },
    rate: componentRate,
    end: lastYear === null || lastMonth === null || !Number.isFinite(lastMonth) ? null : { lastYear: yearOfMonth(lastMonth), lastMonth: monthLabel(lastMonth) },
    owners: shownParts
      .filter((p) => p.participant !== NOT_OWNED_PART)
      .sort((a, b) => byText(a.participant, b.participant))
      .map((p) => ({
        ownerPartyId: p.participant,
        ownershipIds: p.ownershipIds,
        share: show(p.share),
        basis: moneyOfCents(p.basisCents, currency),
        firstMonth: p.partReasons.some((r) => r.code === 'TRANSFER_DATE_MISSING') ? null : monthLabel(p.firstMonth),
        rate: p.rate === null ? null : rateLabel(p.rate, firstYear),
        tenure: { from: p.tenureFrom, lastDay: p.lastDay, lastDaySource: p.lastDaySource },
      })),
    notOwned: notOwned === undefined || ownerPartyId !== null ? null : { share: show(notOwned.share), basis: moneyOfCents(notOwned.basisCents, currency) },
    years: years.map((y) => ({ ...y, owners: [...y.owners].sort((a, b) => byText(a.ownerPartyId, b.ownerPartyId)) })),
    flags: sortFlags(w.flags),
  };
}

const rateLabel = (rate: PartRate, year: number) => {
  const annual = rate.annualOf(year);
  return annual === undefined ? null : show(annual);
};

/** The first and the last year of an item component (the default range, §59A "Path and query"). */
export function itemYears(w: ItemWork): { readonly first: number | null; readonly last: number | null } {
  const last = w.computable ? lastYearOf(w) : null;
  const ends = w.parts
    .map((p) => (p.stopFrom !== null ? p.perItem : w.selected === 'POOLED_BASIS' ? p.pooled : p.perItem).lastMonth)
    .filter((m): m is number => m !== null);
  return { first: w.startMonth === null ? null : yearOfMonth(w.startMonth), last: last ?? (ends.length === 0 ? null : yearOfMonth(Math.max(...ends))) };
}

export const itemParticipants = (w: ItemWork) => w.parts.map((p) => p.participant);

const sortFlags = (flags: readonly Flag[]) => [...flags].sort((a, b) => byText(a.code, b.code));

function mergeOwnerFlags(entries: readonly { ownerPartyId: string; flags: readonly Flag[] }[]): Flag[] {
  const byCode = new Map<string, Set<string>>();
  for (const { ownerPartyId, flags } of entries) for (const f of flags) byCode.set(f.code, (byCode.get(f.code) ?? new Set()).add(ownerPartyId));
  return sortFlags([...byCode.entries()].map(([code, ids]) => ({ code, details: { ownerPartyIds: [...ids].sort(byText) } })));
}
