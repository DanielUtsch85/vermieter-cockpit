import { Money } from '../../shared/index.js';
import type {
  DepreciationFlag,
  TaxYearDepreciation,
  TaxYearDepreciationAsset,
  TaxYearDepreciationComponent,
  TaxYearDepreciationPart,
} from './tax-year-depreciation.js';

/**
 * Builders of Taxation's AfA input (`TaxYearDepreciation`, api-design.md §58C "VC-8-05") for the domain tests: a
 * building or a separate asset, a component with its parts, a flag with its carried level. Synthetic figures. Test
 * support only.
 */

/** A Phase-7 fixture: no depreciation asset, the property owned in the year (`NO_ASSET`, so the year is not final). */
export const PHASE_7_DEPRECIATION: TaxYearDepreciation = {
  year: 2027,
  assets: [],
  withoutAsset: { acquisitionIds: [], items: [], ownershipInYear: true },
};

const eur = (amount: string) => Money.of(amount, 'EUR');

export const flag = (code: string, level: DepreciationFlag['level'] = 'OPEN', ownerPartyIds: readonly string[] = []): DepreciationFlag => ({
  code,
  level,
  details: {},
  ownerPartyIds,
});

/** An owner part (`ownerPartyId` null for `NOT_OWNED`) with its amount, or `null` (not computed, with `reasons`). */
export function part(
  ownerPartyId: string | null,
  amount: string | null,
  options: { share?: string; ownershipIds?: readonly string[]; reasons?: readonly DepreciationFlag[]; flags?: readonly DepreciationFlag[] } = {},
): TaxYearDepreciationPart {
  return {
    partKey: ownerPartyId === null ? 'NOT_OWNED' : `OWNER:${ownerPartyId}`,
    ownerPartyId,
    ownershipIds: options.ownershipIds ?? (ownerPartyId === null ? [] : [`own-${ownerPartyId}`]),
    share: options.share ?? null,
    months: amount === null ? null : 12,
    fraction: amount === null ? null : '1/50',
    amount: amount === null ? null : eur(amount),
    reasons: options.reasons ?? [],
    flags: options.flags ?? [],
  };
}

/** A component of `kind`, computable unless `reasons` are given, its amount the parts' sum. */
export function component(
  componentId: string,
  parts: readonly TaxYearDepreciationPart[],
  options: {
    kind?: TaxYearDepreciationComponent['kind'];
    reasons?: readonly DepreciationFlag[];
    flags?: readonly DepreciationFlag[];
    source?: TaxYearDepreciationComponent['source'];
    rule?: { ruleCode: string; version: number };
  } = {},
): TaxYearDepreciationComponent {
  const reasons = options.reasons ?? [];
  const computed = parts.every((p) => p.amount !== null);
  const sum = parts.reduce((s, p) => (p.amount === null ? s : s.add(p.amount)), eur('0.00'));
  const kind = options.kind ?? 'ACQUISITION';
  return {
    componentId,
    kind,
    acquisitionId: kind === 'ACQUISITION' ? componentId.replace('ACQUISITION:', '') : null,
    source: options.source ?? null,
    computable: reasons.length === 0,
    reasons,
    basis: eur('254400.00'),
    rate: { kind: 'BAND', rate: '1/50', ratePercent: '2', usefulLifeYears: null, legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG' },
    start: { date: null, dateSource: 'ECONOMIC_TRANSFER_DATE', method: 'TRANSFER_DATE', month: '2026-07', firstYearMonths: 6 },
    months: 12,
    amount: computed && reasons.length === 0 ? sum : null,
    rule: options.rule ?? (reasons.length === 0 ? { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 } : null),
    parts,
    flags: options.flags ?? [],
  };
}

/** An `ACTIVE` asset with its components active in the year; `NOT_RECORDED` unless `recording` says otherwise. */
export function asset(
  assetId: string,
  components: readonly TaxYearDepreciationComponent[],
  options: {
    assetType?: TaxYearDepreciationAsset['assetType'];
    reasons?: readonly DepreciationFlag[];
    yearFlags?: readonly DepreciationFlag[];
    recording?: Partial<TaxYearDepreciationAsset['recording']>;
    componentIndex?: TaxYearDepreciationAsset['componentIndex'];
  } = {},
): TaxYearDepreciationAsset {
  const active = components.length > 0;
  return {
    assetId,
    assetType: options.assetType ?? 'BUILDING',
    description: options.assetType === 'SEPARATE_ASSET' ? 'Einbauküche (synthetisch)' : null,
    reviewState: 'CONFIRMED',
    reasons: options.reasons ?? [],
    components,
    componentIndex:
      options.componentIndex ?? components.map((c) => ({ componentId: c.componentId, source: c.source, computable: c.computable, reasons: c.reasons })),
    yearFlags: options.yearFlags ?? [],
    recording: {
      state: active ? 'NOT_RECORDED' : null,
      versionId: null,
      versionNumber: null,
      throughYear: null,
      reproducible: null,
      flags: active
        ? [
            {
              code: 'DEPRECIATION_SCHEDULE_NOT_RECORDED',
              level: 'OPEN',
              details: { assetId, currentVersionId: null, currentThroughYear: null },
              ownerPartyIds: [],
            },
          ]
        : [],
      ...options.recording,
    },
  };
}

/** A year recorded and unchanged: no recording flag. */
export const UNCHANGED = { state: 'UNCHANGED', versionId: 'v-1', versionNumber: 1, throughYear: 2028, reproducible: true, flags: [] } as const;

export const depreciationOf = (
  year: number,
  assets: readonly TaxYearDepreciationAsset[],
  withoutAsset: TaxYearDepreciation['withoutAsset'] = null,
): TaxYearDepreciation => ({
  year,
  assets,
  withoutAsset,
});
