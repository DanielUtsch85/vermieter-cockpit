import { sql } from 'kysely';
import type {
  AssetReviewState,
  AssetStatus,
  DepreciationAsset,
  DepreciationAssetId,
  DepreciationMethod,
  ItemRef,
  SupportedAssetType,
} from '../../domains/depreciation/index.js';
import type { BusinessDate } from '../../shared/index.js';

/** The DepreciationAsset rows (migrations 0049, 0051): the columns read, their mapping, the stored fields and the snapshot. */

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ASSET_COLUMNS = [
  'id',
  'mre_realm_id',
  'property_reference_id',
  'asset_type',
  'status',
  'building_completion_year',
  'description',
  'useful_life_years',
  'useful_life_basis',
  sql<string | null>`to_char(acquired_on, 'YYYY-MM-DD')`.as('acquired_on'),
  'source_references',
  'depreciation_method',
  'review_state',
  'advisor_party_id',
  'notes',
  'voided_at',
  'void_reason',
  'created_at',
  'version',
] as const;

export interface AssetRow {
  id: string;
  mre_realm_id: string;
  property_reference_id: string;
  asset_type: string;
  status: string;
  building_completion_year: number | null;
  description: string | null;
  useful_life_years: number | null;
  useful_life_basis: string | null;
  acquired_on: string | null;
  source_references: string[];
  depreciation_method: string;
  review_state: string;
  advisor_party_id: string | null;
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
  version: number;
}

export interface EntryRow {
  asset_id: string;
  acquisition_id: string;
  useful_life_years: number;
  evidence_source: string;
  evidence_date: string;
  evidence_document_reference: string | null;
  review_state: string;
  advisor_party_id: string | null;
}

export function toDomain(row: AssetRow, entries: readonly EntryRow[], items: readonly ItemRef[]): DepreciationAsset {
  return {
    id: row.id as DepreciationAssetId,
    mreRealmId: row.mre_realm_id,
    propertyReferenceId: row.property_reference_id,
    // Checked by the table's CHECKs.
    assetType: row.asset_type as SupportedAssetType,
    status: row.status as AssetStatus,
    buildingCompletionYear: row.building_completion_year,
    description: row.description,
    usefulLifeYears: row.useful_life_years,
    usefulLifeBasis: row.useful_life_basis,
    acquiredOn: row.acquired_on as BusinessDate | null,
    items,
    sourceReferences: row.source_references,
    depreciationMethod: row.depreciation_method as DepreciationMethod,
    reviewState: row.review_state as AssetReviewState,
    advisorPartyId: row.advisor_party_id,
    shorterUsefulLives: entries.map((e) => ({
      acquisitionId: e.acquisition_id,
      usefulLifeYears: e.useful_life_years,
      evidence: { source: e.evidence_source, date: e.evidence_date as BusinessDate, documentReference: e.evidence_document_reference },
      reviewState: e.review_state as AssetReviewState,
      advisorPartyId: e.advisor_party_id,
    })),
    notes: row.notes,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The CREATED record (§59): every stored field and each entry. */
export function storedFields(asset: DepreciationAsset): Record<string, unknown> {
  return {
    propertyReferenceId: asset.propertyReferenceId,
    assetType: asset.assetType,
    buildingCompletionYear: asset.buildingCompletionYear,
    ...(asset.assetType === 'SEPARATE_ASSET'
      ? {
          description: asset.description,
          usefulLifeYears: asset.usefulLifeYears,
          usefulLifeBasis: asset.usefulLifeBasis,
          acquiredOn: asset.acquiredOn,
          items: asset.items,
        }
      : {}),
    sourceReferences: asset.sourceReferences,
    depreciationMethod: asset.depreciationMethod,
    reviewState: asset.reviewState,
    advisorPartyId: asset.advisorPartyId,
    shorterUsefulLives: asset.shorterUsefulLives,
    notes: asset.notes,
  };
}

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === constraint;
}

type AssetSnapshot = Omit<DepreciationAsset, 'voidedAt' | 'createdAt'> & { readonly voidedAt: string | null; readonly createdAt: string };

export function toSnapshot(asset: DepreciationAsset): AssetSnapshot {
  return { ...asset, voidedAt: asset.voidedAt?.toISOString() ?? null, createdAt: asset.createdAt.toISOString() };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
export function fromSnapshot(result: unknown): DepreciationAsset {
  const snapshot = result as AssetSnapshot;
  return { ...snapshot, voidedAt: snapshot.voidedAt === null ? null : new Date(snapshot.voidedAt), createdAt: new Date(snapshot.createdAt) };
}
