import { sql, type Transaction } from 'kysely';
import { transferDate } from '../../domains/acquisition/index.js';
import {
  INFORMATIVE_CODES,
  NOT_OWNED_PART,
  RECORDING_FLAGS,
  deriveSchedule,
  isCapitalized,
  withRecording,
  type ComponentYear,
  type Fingerprinter,
  type Flag,
  type ItemComponent,
  type ScheduleComponent,
} from '../../domains/depreciation/index.js';
import type {
  DepreciationFlag,
  TaxYearDepreciation,
  TaxYearDepreciationAsset,
  TaxYearDepreciationComponent,
  TaxYearDepreciationPart,
} from '../../domains/taxation/index.js';
import type { BusinessDate, RuleRegistry } from '../../shared/index.js';
import { sha256Fingerprinter } from '../hashing/index.js';
import { capitalizedItemsIn, type CapitalizedSourcesReader } from './capitalized-items.js';
import { readScheduleIn } from './depreciation-schedule-source.js';
import { currentVersionOf } from './depreciation-schedule-version-reads.js';
import type { Database } from './schema.js';

/**
 * Where the tax-year view reads the AfA (api-design.md §58C "VC-8-05: the AfA in the view", P8-D11 as amended by §59B):
 * in the view's own transaction (`readTaxYear`'s `REPEATABLE READ READ ONLY` snapshot), every `ACTIVE` depreciation asset
 * of the PropertyReference in the Realm, its schedule's inputs (§59A, §59B: `readScheduleIn`, with the capitalised items
 * through `capitalizedItemsIn` and the tax repository's reader), Depreciation's pure derivation of `year`, and §60's
 * comparison with the asset's `CURRENT` recorded version at the level asked; without an `ACTIVE` building, what would
 * need one (`NO_ASSET`). Mapped field for field into Taxation's own `TaxYearDepreciation`; no domain imports the other.
 * It does not read the recording switch: the outcome follows from the absence of versions (§60, decided 2026-10-31,
 * third set). Nothing is written.
 */

type Trx = Transaction<Database>;

/** The level of a Depreciation code as the schedule raises it (§59A "A year's flags"); Taxation never re-decides it. */
export const levelOf = (code: string): DepreciationFlag['level'] => (INFORMATIVE_CODES.includes(code) ? 'INFORMATIVE' : 'OPEN');

const ownersOf = (details: Readonly<Record<string, unknown>>): string[] => {
  const ids = details['ownerPartyIds'];
  if (Array.isArray(ids)) return ids.filter((x): x is string => typeof x === 'string' && x !== NOT_OWNED_PART);
  const id = details['ownerPartyId'];
  return typeof id === 'string' ? [id] : [];
};

export const carried = (f: Flag): DepreciationFlag => ({ code: f.code, level: levelOf(f.code), details: f.details, ownerPartyIds: ownersOf(f.details) });

/** The parts of a component in `year`: its owners' and, on an item, `NOT_OWNED`'s. */
function partsOf(c: ScheduleComponent | ItemComponent, y: ComponentYear): TaxYearDepreciationPart[] {
  const parts: TaxYearDepreciationPart[] = y.owners.map((o) => {
    const owner = c.kind === 'ACQUISITION' ? c.owners.find((x) => x.ownerPartyId === o.ownerPartyId) : c.owners.find((x) => x.ownerPartyId === o.ownerPartyId);
    const ownershipIds = owner === undefined ? [] : 'ownershipIds' in owner ? [...owner.ownershipIds] : [owner.ownershipId];
    return {
      partKey: `OWNER:${o.ownerPartyId}`,
      ownerPartyId: o.ownerPartyId,
      ownershipIds,
      share: owner?.share ?? null,
      months: o.months,
      fraction: o.fraction,
      amount: o.amount,
      reasons: o.reasons.map(carried),
      flags: o.flags.map(carried),
    };
  });
  if (c.kind === 'CAPITALIZED_ITEM' && c.notOwned !== null) {
    const named = (flags: readonly Flag[]) =>
      flags.filter((f) => Array.isArray(f.details['ownerPartyIds']) && (f.details['ownerPartyIds'] as unknown[]).includes(NOT_OWNED_PART));
    const reasons = named(y.reasons);
    if (y.notOwned !== null || reasons.length > 0) {
      parts.push({
        partKey: NOT_OWNED_PART,
        ownerPartyId: null,
        ownershipIds: [],
        share: c.notOwned.share,
        months: y.months,
        fraction: null,
        amount: y.notOwned,
        reasons: reasons.map((f) => ({ ...carried(f), ownerPartyIds: [] })),
        flags: named(y.flags).map((f) => ({ ...carried(f), ownerPartyIds: [] })),
      });
    }
  }
  return parts;
}

function componentOf(c: ScheduleComponent | ItemComponent, y: ComponentYear): TaxYearDepreciationComponent {
  const item = c.kind === 'CAPITALIZED_ITEM';
  return {
    componentId: c.componentId,
    kind: c.kind,
    acquisitionId: item ? null : c.acquisitionId,
    source: item ? { sourceType: c.source.sourceType, sourceId: c.source.sourceId, sourcePosition: c.source.sourcePosition } : null,
    computable: c.status === 'COMPUTABLE',
    reasons: c.reasons.map(carried),
    basis: c.basis.amount,
    rate:
      c.rate === null
        ? null
        : { kind: c.rate.kind, rate: c.rate.rate, ratePercent: c.rate.ratePercent, usefulLifeYears: c.rate.usefulLifeYears, legalBasis: c.rate.legalBasis },
    // §59A's start object with `method` as §59B and §60 give it: TRANSFER_DATE on a purchase (P8-D5).
    start: item ? { ...c.start } : c.start === null ? null : { ...c.start, method: 'TRANSFER_DATE' },
    months: y.months,
    amount: y.amount,
    rule: y.rule === null ? null : { ruleCode: y.rule.ruleCode, version: y.rule.version },
    parts: partsOf(c, y),
    flags: c.flags.map(carried),
  };
}

export interface TaxYearDepreciationRequest {
  readonly mreRealmId: string;
  readonly propertyReferenceId: string;
  readonly year: number;
  /** The view's level: §60's comparison at the owner level compares the owner's own parts. */
  readonly ownerPartyId: string | null;
  readonly today: BusinessDate;
  readonly registry: RuleRegistry;
  readonly capitalizedSources: CapitalizedSourcesReader;
  readonly fingerprinter?: Fingerprinter;
}

/** The AfA of `year` for the view, in the caller's transaction (§58C "The adapter", steps 1–6). */
export async function taxYearDepreciationIn(trx: Trx, request: TaxYearDepreciationRequest): Promise<TaxYearDepreciation> {
  const { mreRealmId, propertyReferenceId, year, ownerPartyId, today, registry, capitalizedSources } = request;
  const fingerprinter = request.fingerprinter ?? sha256Fingerprinter;
  // 1. The ACTIVE assets of the PropertyReference in the Realm (a VOID one is never read): the building first.
  const rows = await trx
    .selectFrom('depreciation_asset')
    .select(['id', 'asset_type'])
    .where('property_reference_id', '=', propertyReferenceId)
    .where('mre_realm_id', '=', mreRealmId)
    .where('status', '=', 'ACTIVE')
    .orderBy(sql`asset_type = 'BUILDING'`, 'desc')
    .orderBy('id')
    .execute();
  const assets: TaxYearDepreciationAsset[] = [];
  for (const row of rows) {
    // 2. The schedule's inputs in this transaction; 3. the pure derivation of `year` over the whole run.
    const read = await readScheduleIn(trx, capitalizedSources, today, row.id, mreRealmId, null);
    if (read === undefined) continue;
    const schedule = deriveSchedule(
      {
        asset: read.asset,
        acquisitions: read.acquisitions,
        ownerships: read.ownerships,
        capitalizedItems: read.capitalizedItems,
        links: read.links,
        today,
        from: year,
        to: year,
        ownerPartyId: null,
      },
      registry,
    );
    // 4. The CURRENT version, compared for `year` at the view's level (§60), and reproduced.
    const current = await currentVersionOf(trx, row.id);
    const recorded = withRecording({ ...schedule, ownerPartyId }, read, { registry, fingerprinter, today, current, recordingEnabled: false });
    const recordedYear = recorded.years.find((y) => y.year === year);
    const scheduleYear = schedule.years.find((y) => y.year === year);
    const active = schedule.components.flatMap((c) => {
      const y = c.years.find((x) => x.year === year);
      return y === undefined ? [] : [componentOf(c, y)];
    });
    const separate = read.asset.assetType === 'SEPARATE_ASSET';
    assets.push({
      assetId: read.asset.id,
      assetType: separate ? 'SEPARATE_ASSET' : 'BUILDING',
      description: read.asset.description,
      reviewState: read.asset.reviewState,
      reasons: schedule.reasons.map(carried),
      components: active,
      componentIndex: schedule.components.map((c) => ({
        componentId: c.componentId,
        source:
          c.kind === 'CAPITALIZED_ITEM' ? { sourceType: c.source.sourceType, sourceId: c.source.sourceId, sourcePosition: c.source.sourcePosition } : null,
        computable: c.status === 'COMPUTABLE',
        reasons: c.reasons.map(carried),
      })),
      yearFlags: [...schedule.flags, ...(scheduleYear?.flags ?? []).filter((f) => f.code === 'OWNER_WITHOUT_ACQUISITION')].map(carried),
      recording: {
        state: recordedYear?.recording ?? null,
        versionId: current?.versionId ?? null,
        versionNumber: current?.versionNumber ?? null,
        throughYear: current?.throughYear ?? null,
        reproducible: current === null ? null : (recorded.recordedVersion?.reproducible ?? null),
        flags: (recordedYear?.flags ?? []).filter((f) => (RECORDING_FLAGS as readonly string[]).includes(f.code)).map(carried),
      },
    });
  }
  // 5. Without an ACTIVE building: the purchases, the unlinked capitalised items and the Ownerships that need one.
  const withoutAsset = assets.some((a) => a.assetType === 'BUILDING') ? null : await withoutAssetIn(trx, request);
  return { year, assets, withoutAsset };
}

async function withoutAssetIn(trx: Trx, request: TaxYearDepreciationRequest): Promise<NonNullable<TaxYearDepreciation['withoutAsset']>> {
  const { mreRealmId, propertyReferenceId, year, today, capitalizedSources } = request;
  const end = `${year}-12-31`;
  const ownerships = await trx
    .selectFrom('ownership')
    .select([
      'acquisition_id',
      sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from'),
      sql<string | null>`to_char(valid_until, 'YYYY-MM-DD')`.as('valid_until'),
    ])
    .where('mre_realm_id', '=', mreRealmId)
    .where('property_reference_id', '=', propertyReferenceId)
    .where('status', '=', 'VALID')
    .execute();
  const acquisitions = await trx
    .selectFrom('acquisition')
    .select([
      'id',
      'status',
      sql<string>`to_char(contract_date, 'YYYY-MM-DD')`.as('contract_date'),
      sql<string | null>`to_char(economic_transfer_date, 'YYYY-MM-DD')`.as('economic_transfer_date'),
    ])
    .where('mre_realm_id', '=', mreRealmId)
    .where('property_reference_id', '=', propertyReferenceId)
    .where('status', '<>', 'CANCELLED')
    .orderBy('id')
    .execute();
  // A listed purchase (§59A): CONFIRMED, or DRAFT with an Ownership carrying it; its transfer in or before `year`.
  const acquisitionIds = acquisitions
    .filter((a) => a.status === 'CONFIRMED' || (a.status === 'DRAFT' && ownerships.some((o) => o.acquisition_id === a.id)))
    .filter(
      (a) => transferDate({ contractDate: a.contract_date as BusinessDate, economicTransferDate: a.economic_transfer_date as BusinessDate | null }) <= end,
    )
    .map((a) => a.id);
  const links = await trx
    .selectFrom('depreciation_asset_item')
    .select(['source_type', 'source_id', 'source_position'])
    .where('property_reference_id', '=', propertyReferenceId)
    .where('mre_realm_id', '=', mreRealmId)
    .where('asset_status', '=', 'ACTIVE')
    .execute();
  const items = (await capitalizedItemsIn(trx, mreRealmId, propertyReferenceId, today, capitalizedSources))
    .filter((i) => isCapitalized(i) && i.date <= end)
    .filter((i) => !links.some((l) => l.source_type === i.sourceType && l.source_id === i.sourceId && l.source_position === i.sourcePosition))
    .map((i) => ({ sourceType: i.sourceType, sourceId: i.sourceId, sourcePosition: i.sourcePosition }));
  const ownershipInYear = ownerships.some((o) => o.valid_from <= end && (o.valid_until === null || o.valid_until >= `${year}-01-01`));
  return { acquisitionIds, items, ownershipInYear };
}
