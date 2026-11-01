import { centsOf, moneyOfCents, type BusinessDate, type Money, type RuleRef } from '../../shared/index.js';
import type { AfaItem, AfaLine, CapitalizedComponent, TaxYearDepreciationBlock, TaxYearItem, ViewFlag } from './tax-year-response.js';
import { NOT_OWNED } from './tax-year-shares.js';

/**
 * The AfA in the tax-year view (api-design.md §58C "VC-8-05: the AfA in the view", P8-D12): Taxation's own input type
 * `TaxYearDepreciation` (plain data, filled by `infrastructure/postgres/tax-year-depreciation.ts` from Depreciation's
 * schedule and its `CURRENT` recorded version in the view's one snapshot; no Depreciation type here, P8-D11), and the
 * pure placement of the AfA: the lines `AFA_BUILDING` and `AFA_SEPARATE_ASSETS`, the gaps, the status and
 * `result.basis`, the year's AfA flags and what the review counts. The view shows the live derivation; a recorded
 * version is only compared (its figures appear in the flags' details, P8-D10). The owners' AfA is the schedule's parts,
 * never re-split (P8-D8).
 */

/** A flag or reason as the schedule raised it, with its level carried (Taxation does not re-decide it). */
export interface DepreciationFlag {
  readonly code: string;
  readonly level: 'OPEN' | 'INFORMATIVE';
  readonly details: Readonly<Record<string, unknown>>;
  readonly ownerPartyIds: readonly string[];
}

export interface DepreciationSourceRef {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly sourcePosition: number | null;
}

/** An owner part (`OWNER:{partyId}`) or the `NOT_OWNED` part of a component in `year`. */
export interface TaxYearDepreciationPart {
  readonly partKey: string;
  readonly ownerPartyId: string | null;
  readonly ownershipIds: readonly string[];
  /** The part's share of the component (`"3/5"`), `null` when not known. */
  readonly share: string | null;
  readonly months: number | null;
  /** The year's fraction of the part's basis, as the schedule gives it. */
  readonly fraction: string | null;
  /** `null`: not computed in `year` (its `reasons` say why). */
  readonly amount: Money | null;
  readonly reasons: readonly DepreciationFlag[];
  readonly flags: readonly DepreciationFlag[];
}

export interface TaxYearDepreciationComponent {
  readonly componentId: string;
  readonly kind: 'ACQUISITION' | 'CAPITALIZED_ITEM';
  readonly acquisitionId: string | null;
  readonly source: DepreciationSourceRef | null;
  readonly computable: boolean;
  readonly reasons: readonly DepreciationFlag[];
  readonly basis: Money | null;
  readonly rate: {
    readonly kind: string;
    readonly rate: string;
    readonly ratePercent: string;
    readonly usefulLifeYears: number | null;
    readonly legalBasis: string;
  } | null;
  readonly start: {
    readonly date: BusinessDate | null;
    readonly dateSource: string;
    readonly method: string;
    readonly month: string | null;
    readonly firstYearMonths: number | null;
  } | null;
  readonly months: number | null;
  readonly amount: Money | null;
  readonly rule: RuleRef | null;
  readonly parts: readonly TaxYearDepreciationPart[];
  readonly flags: readonly DepreciationFlag[];
}

export type RecordingState = 'NOT_RECORDED' | 'UNCHANGED' | 'CHANGED_SINCE_RECORDED';

export interface TaxYearDepreciationAsset {
  readonly assetId: string;
  readonly assetType: 'BUILDING' | 'SEPARATE_ASSET';
  readonly description: string | null;
  readonly reviewState: string;
  /** The asset's reasons: no component of it computed (§59A, §59B). */
  readonly reasons: readonly DepreciationFlag[];
  /** Every component active in `year` (from its start year to its last year; a not-computable one from its start on). */
  readonly components: readonly TaxYearDepreciationComponent[];
  /** Every component of the asset, whatever its years: what `capitalized[].component` names. */
  readonly componentIndex: readonly {
    readonly componentId: string;
    readonly source: DepreciationSourceRef | null;
    readonly computable: boolean;
    readonly reasons: readonly DepreciationFlag[];
    /**
     * §59E: an item component's basis and its participants' bases (the owners' by Party, `NOT_OWNED`), what
     * `LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS` compares with the item; absent where not read (then never equal).
     */
    readonly basis?: Money | null;
    readonly partBases?: readonly { readonly participant: string; readonly amount: Money }[];
  }[];
  /** The schedule's own flags of the year (`GWG_THRESHOLD_MAY_APPLY`, `OWNER_WITHOUT_ACQUISITION`). */
  readonly yearFlags: readonly DepreciationFlag[];
  /** §60's comparison of `year` at the level asked; `state` `null` when no component is active in `year`. */
  readonly recording: {
    readonly state: RecordingState | null;
    readonly versionId: string | null;
    readonly versionNumber: number | null;
    readonly throughYear: number | null;
    readonly reproducible: boolean | null;
    readonly flags: readonly DepreciationFlag[];
  };
}

/** What the view reads of Depreciation (§58C "How the view gets the AfA without a cycle"). */
export interface TaxYearDepreciation {
  readonly year: number;
  /** The `ACTIVE` assets of the PropertyReference: the building first, then the separate assets by `assetId`. */
  readonly assets: readonly TaxYearDepreciationAsset[];
  /** Without an `ACTIVE` building: what would give it AfA (`NO_ASSET`); `null` with one. */
  readonly withoutAsset: {
    readonly acquisitionIds: readonly string[];
    readonly items: readonly DepreciationSourceRef[];
    readonly ownershipInYear: boolean;
  } | null;
}

/** No depreciation asset, nothing that needs one: the AfA is 0.00 and `AVAILABLE`. */
export const NO_DEPRECIATION = (year: number): TaxYearDepreciation => ({ year, assets: [], withoutAsset: null });

export const AFA_LINES = ['AFA_BUILDING', 'AFA_SEPARATE_ASSETS'] as const;
export type AfaLineCode = (typeof AFA_LINES)[number];

/** The year's AfA flags that are open (§58C's review table, VC-8-05). */
export const OPEN_AFA_YEAR_FLAGS = [
  'DEPRECIATION_INCOMPLETE',
  'DEPRECIATION_SCHEDULE_NOT_RECORDED',
  'DEPRECIATION_CHANGED_SINCE_RECORDED',
  'RECORDED_VERSION_NOT_REPRODUCIBLE',
] as const;

const NOTES = {
  AVAILABLE: 'Ergebnis nach AfA.',
  PARTIAL: 'Ergebnis nach teilweiser AfA; nicht berechnete Teile siehe gaps.',
  DEPRECIATION_NOT_AVAILABLE: 'Ergebnis vor AfA; die AfA ist nicht berechenbar, siehe gaps.',
} as const;
export type AfaStatus = keyof typeof NOTES;
export const BASIS_OF: Record<AfaStatus, 'AFTER_DEPRECIATION' | 'PARTIAL_DEPRECIATION' | 'BEFORE_DEPRECIATION'> = {
  AVAILABLE: 'AFTER_DEPRECIATION',
  PARTIAL: 'PARTIAL_DEPRECIATION',
  DEPRECIATION_NOT_AVAILABLE: 'BEFORE_DEPRECIATION',
};

/** Something with AfA in `year` that the view could not compute; `participants` `null` concerns everyone. */
interface Gap {
  readonly code: string;
  readonly assetId: string | null;
  readonly componentId: string | null;
  readonly participants: readonly string[] | null;
  readonly details: Readonly<Record<string, unknown>>;
  readonly codes: readonly { readonly code: string; readonly open: boolean }[];
}

/** A component computed for `year` with at least one part: one AfA item per level. */
interface Placed {
  readonly asset: TaxYearDepreciationAsset;
  readonly component: TaxYearDepreciationComponent;
  readonly line: AfaLineCode;
}

const keyOf = (p: TaxYearDepreciationPart) => p.ownerPartyId ?? NOT_OWNED;
const unique = <T>(values: readonly T[]) => [...new Set(values)];
/** An asset with a component active in `year`, an asset reason, or a share held without a purchase (§58C "assets[]"). */
const listedAssets = (dep: TaxYearDepreciation) =>
  dep.assets.filter((a) => a.components.length > 0 || a.reasons.length > 0 || a.yearFlags.some((f) => f.code === 'OWNER_WITHOUT_ACQUISITION'));

/** The gaps of the year at the property level, in asset order, `NO_ASSET` last (§58C "The `depreciation` block"). */
function gapsOf(dep: TaxYearDepreciation): Gap[] {
  const gaps: Gap[] = [];
  for (const asset of listedAssets(dep)) {
    const assetCodes = asset.reasons.map((r) => r.code);
    if (asset.reasons.length > 0) {
      gaps.push({
        code: assetCodes[0] as string,
        assetId: asset.assetId,
        componentId: null,
        participants: null,
        details: { reasons: unique(assetCodes) },
        codes: unique(assetCodes).map((code) => ({ code, open: asset.reasons.find((r) => r.code === code)?.level !== 'INFORMATIVE' })),
      });
    }
    for (const c of asset.components) {
      const missing = c.parts.filter((p) => p.amount === null);
      if (c.computable && missing.length === 0) continue;
      const reasons = [...c.reasons, ...missing.flatMap((p) => p.reasons)].filter((r) => !assetCodes.includes(r.code));
      const codes = unique(reasons.map((r) => r.code));
      if (codes.length === 0) continue; // the asset's own gap names it
      const concerned = c.computable ? missing : c.parts;
      gaps.push({
        code: codes[0] as string,
        assetId: asset.assetId,
        componentId: c.componentId,
        participants: concerned.length === 0 ? null : unique(concerned.map(keyOf)).sort(),
        details: { reasons: codes },
        codes: codes.map((code) => ({ code, open: reasons.find((r) => r.code === code)?.level !== 'INFORMATIVE' })),
      });
    }
    // OWNER_WITHOUT_ACQUISITION: one gap per asset and year, never also a year flag.
    const without = asset.yearFlags.filter((f) => f.code === 'OWNER_WITHOUT_ACQUISITION');
    if (without.length > 0) {
      gaps.push({
        code: 'OWNER_WITHOUT_ACQUISITION',
        assetId: asset.assetId,
        componentId: null,
        participants: unique(without.flatMap((f) => f.ownerPartyIds)).sort(),
        details: { owners: without.map((f) => f.details) },
        codes: [{ code: 'OWNER_WITHOUT_ACQUISITION', open: true }],
      });
    }
  }
  const w = dep.withoutAsset;
  if (w !== null && (w.acquisitionIds.length > 0 || w.items.length > 0 || w.ownershipInYear)) {
    gaps.push({
      code: 'NO_ASSET',
      assetId: null,
      componentId: null,
      participants: null,
      details: { acquisitionIds: w.acquisitionIds, items: w.items, ownershipInYear: w.ownershipInYear },
      codes: [{ code: 'NO_ASSET', open: true }],
    });
  }
  return gaps;
}

function placedOf(dep: TaxYearDepreciation): Placed[] {
  return listedAssets(dep).flatMap((asset) =>
    asset.components
      .filter((c) => c.parts.some((p) => p.amount !== null))
      .map((component) => ({ asset, component, line: asset.assetType === 'BUILDING' ? ('AFA_BUILDING' as const) : ('AFA_SEPARATE_ASSETS' as const) })),
  );
}

const concerns = (gap: Gap, participant: string | undefined) =>
  participant === undefined || gap.participants === null || gap.participants.includes(participant);
const computedParts = (p: Placed, participant: string | undefined) =>
  p.component.parts.filter((x) => x.amount !== null && (participant === undefined || keyOf(x) === participant));

const statusOf = (gaps: readonly Gap[], itemCount: number): AfaStatus =>
  gaps.length === 0 ? 'AVAILABLE' : itemCount > 0 ? 'PARTIAL' : 'DEPRECIATION_NOT_AVAILABLE';

const gapDto = (g: Gap) => ({
  code: g.code,
  assetId: g.assetId,
  componentId: g.componentId,
  ownerPartyIds: (g.participants ?? []).filter((k) => k !== NOT_OWNED),
  details: g.details,
});

const hrefOf = (assetId: string, year: number, ownerPartyId: string | undefined) =>
  `/api/v1/depreciation-assets/${assetId}/schedule?from=${year}&to=${year}${ownerPartyId === undefined || ownerPartyId === NOT_OWNED ? '' : `&ownerPartyId=${ownerPartyId}`}`;

function afaItemOf(p: Placed, year: number, currency: string, participant: string | undefined): AfaItem {
  const c = p.component;
  const parts = computedParts(p, participant);
  const cents = parts.reduce((s, x) => s + centsOf(x.amount as Money), 0n);
  const own = participant === undefined ? undefined : parts[0];
  // At the property level each part flag once, the owners named (as the schedule's component year); else the owner's.
  const partFlags: readonly ViewFlag[] =
    participant === undefined
      ? unique(c.parts.flatMap((x) => x.flags.map((f) => f.code))).map((code) => ({
          code,
          details: { ownerPartyIds: unique(c.parts.filter((x) => x.flags.some((f) => f.code === code)).map(keyOf)).sort() },
        }))
      : (own?.flags ?? []);
  return {
    assetId: p.asset.assetId,
    assetType: p.asset.assetType,
    description: p.asset.description,
    componentId: c.componentId,
    kind: c.kind,
    acquisitionId: c.acquisitionId,
    source: c.source,
    basis: c.basis,
    rate: c.rate,
    start: c.start,
    months: c.months,
    amount: moneyOfCents(cents, currency),
    rule: c.rule,
    share:
      own === undefined
        ? null
        : {
            ownershipId: [...own.ownershipIds].sort()[0] ?? NOT_OWNED,
            share: own.share,
            amount: moneyOfCents(cents, currency),
            ownershipIds: [...own.ownershipIds].sort(),
            partKey: own.partKey,
          },
    href: hrefOf(p.asset.assetId, year, participant),
    flags: [...c.flags.map((f) => ({ code: f.code, details: f.details })), ...partFlags.map((f) => ({ code: f.code, details: f.details }))],
  };
}

/** The AfA of a level: its two lines, the block, the status and the year's AfA flags (§58C "VC-8-05"). */
export interface AfaOfLevel {
  readonly lines: readonly AfaLine[];
  readonly totalCents: bigint;
  readonly status: AfaStatus;
  readonly block: TaxYearDepreciationBlock;
  /** The AfA's flags of the year, in the order they lead the year's flags. */
  readonly yearFlags: readonly ViewFlag[];
  /** What `review` counts beside the cash items: each AfA item's flags and each gap's reason codes, per unit. */
  readonly reviewUnits: readonly (readonly { readonly code: string; readonly open: boolean }[])[];
  /** One rule reference per AfA item (`ruleVersions`). */
  readonly ruleRefs: readonly RuleRef[];
}

/**
 * The AfA of `year` at the property level (`participant` undefined) or for one participant (an owner's Party id or
 * `NOT_OWNED`): the items are the components with a computed part, the amounts the schedule's parts summed, never
 * distributed; the gaps those that concern the level.
 */
export function afaOf(dep: TaxYearDepreciation, currency: string, participant: string | undefined): AfaOfLevel {
  const year = dep.year;
  const placed = placedOf(dep).filter((p) => computedParts(p, participant).length > 0);
  const gaps = gapsOf(dep).filter((g) => concerns(g, participant));
  const items = placed.map((p) => ({ p, item: afaItemOf(p, year, currency, participant) }));
  const lines: AfaLine[] = AFA_LINES.map((line) => {
    const on = items.filter((i) => i.p.line === line);
    return {
      line,
      taxCategory: null,
      total: moneyOfCents(
        on.reduce((s, i) => s + centsOf(i.item.amount), 0n),
        currency,
      ),
      itemCount: on.length,
      subtotals: null,
      items: on.map((i) => i.item),
    };
  });
  const totalCents = lines.reduce((s, l) => s + centsOf(l.total), 0n);
  const status = statusOf(gaps, items.length);
  const owner = participant === undefined || participant === NOT_OWNED ? undefined : participant;
  const assets = listedAssets(dep).map((asset) => {
    const own = items.filter((i) => i.p.asset === asset);
    const ownGaps = gaps.filter((g) => g.assetId === asset.assetId);
    const r = asset.recording;
    return {
      assetId: asset.assetId,
      assetType: asset.assetType,
      description: asset.description,
      reviewState: asset.reviewState,
      status: statusOf(ownGaps, own.length),
      amount:
        own.length === 0
          ? null
          : moneyOfCents(
              own.reduce((s, i) => s + centsOf(i.item.amount), 0n),
              currency,
            ),
      itemCount: own.length,
      reasons: asset.reasons.map((x) => ({ code: x.code, details: x.details })),
      recording:
        r.state === null
          ? null
          : { state: r.state, versionId: r.versionId, versionNumber: r.versionNumber, throughYear: r.throughYear, reproducible: r.reproducible },
      href: hrefOf(asset.assetId, year, owner),
    };
  });
  const gapList = gaps.map(gapDto);
  const yearFlags: ViewFlag[] = [];
  if (status === 'DEPRECIATION_NOT_AVAILABLE') yearFlags.push({ code: 'DEPRECIATION_NOT_AVAILABLE', details: { gaps: gapList } });
  if (status === 'PARTIAL') yearFlags.push({ code: 'DEPRECIATION_INCOMPLETE', details: { gaps: gapList } });
  for (const asset of listedAssets(dep)) {
    if (asset.recording.state !== null) for (const f of asset.recording.flags) yearFlags.push({ code: f.code, details: f.details });
    for (const f of asset.yearFlags.filter((x) => x.code !== 'OWNER_WITHOUT_ACQUISITION')) {
      yearFlags.push({ code: f.code, details: { ...f.details, assetId: asset.assetId } });
    }
  }
  return {
    lines,
    totalCents,
    status,
    block: {
      status,
      amount: status === 'DEPRECIATION_NOT_AVAILABLE' ? null : moneyOfCents(totalCents, currency),
      assets,
      gaps: gapList,
      note: NOTES[status],
    },
    yearFlags,
    reviewUnits: [
      ...items.map(({ p, item }) => {
        const carried = [...p.component.flags, ...p.component.parts.flatMap((x) => x.flags)];
        return unique(item.flags.map((f) => f.code)).map((code) => ({ code, open: carried.find((f) => f.code === code)?.level !== 'INFORMATIVE' }));
      }),
      ...gaps.map((g) => g.codes),
    ],
    ruleRefs: items.flatMap(({ item }) => (item.rule === null ? [] : [item.rule])),
  };
}

/** The participants (owners and `NOT_OWNED`) with a part in a component active in `year`. */
export const afaParticipants = (dep: TaxYearDepreciation): readonly string[] =>
  unique(listedAssets(dep).flatMap((a) => a.components.flatMap((c) => c.parts.map(keyOf))));

/** The number of components the response lists for `year` (each AfA item and each gap with a component), for the cap. */
export const afaComponentCount = (dep: TaxYearDepreciation): number => placedOf(dep).length + gapsOf(dep).filter((g) => g.componentId !== null).length;

/**
 * `capitalized[].component` (§58C "`capitalized`: still the year's additions"): the component the item became, on an
 * `ACTIVE` asset (the separate asset linking it, else the building), `NO_ASSET` without an `ACTIVE` building and without
 * a separate asset linking it, `null` on an item no asset lists.
 */
export function componentOfItem(dep: TaxYearDepreciation, item: Pick<TaxYearItem, 'sourceType' | 'sourceId' | 'sourcePosition'>): CapitalizedComponent | null {
  const same = (s: DepreciationSourceRef | null) =>
    s !== null &&
    s.sourceType === item.sourceType &&
    s.sourceId === item.sourceId &&
    (item.sourceType === 'TRANSACTION_SPLIT' || s.sourcePosition === item.sourcePosition);
  const ordered = [...dep.assets.filter((a) => a.assetType === 'SEPARATE_ASSET'), ...dep.assets.filter((a) => a.assetType === 'BUILDING')];
  for (const asset of ordered) {
    const c = asset.componentIndex.find((x) => same(x.source));
    if (c === undefined) continue;
    const reasons = c.reasons.length > 0 || c.computable ? c.reasons : asset.reasons;
    return {
      assetId: asset.assetId,
      assetType: asset.assetType,
      componentId: c.componentId,
      computable: c.computable && asset.reasons.length === 0,
      reasons: reasons.map((r) => ({ code: r.code, details: r.details })),
    };
  }
  if (dep.withoutAsset !== null) return { assetId: null, assetType: null, componentId: null, computable: false, reasons: [{ code: 'NO_ASSET', details: {} }] };
  return null;
}
