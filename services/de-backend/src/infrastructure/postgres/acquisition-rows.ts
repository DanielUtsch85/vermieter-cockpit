import { sql, type Transaction } from 'kysely';
import { ownershipStartFlag, type Acquisition, type AcquisitionId, type AcquisitionStatus } from '../../domains/acquisition/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { fromNumericAmount } from './money-column.js';
import { sellersWithAfaComponent } from './ownership-start-reads.js';
import type { Database } from './schema.js';

/**
 * The Acquisition's rows (api-design.md §27.1): the columns, the mapping with its parties and §58N's flag, and the
 * idempotency snapshot; shared by the repository and the transfer-date command (`acquisition-transfer-date.ts`).
 */
/** Every column, the dates as `YYYY-MM-DD` text and the price as text (exact). */
export const COLUMNS = [
  'id',
  'mre_realm_id',
  'property_reference_id',
  'status',
  sql<string>`purchase_price::text`.as('purchase_price'),
  'currency',
  'acquired_share_numerator',
  'acquired_share_denominator',
  sql<string>`to_char(contract_date, 'YYYY-MM-DD')`.as('contract_date'),
  sql<string | null>`to_char(economic_transfer_date, 'YYYY-MM-DD')`.as('economic_transfer_date'),
  'economic_transfer_recorded_at',
  'economic_transfer_source_references',
  'ownership_aligned_at',
  'ownership_alignment_source_references',
  sql<string | null>`to_char(confirmed_ownership_start, 'YYYY-MM-DD')`.as('confirmed_ownership_start'),
  sql<string | null>`to_char(land_registry_transfer_date, 'YYYY-MM-DD')`.as('land_registry_transfer_date'),
  'source_references',
  'notes',
  'cancelled_at',
  'cancellation_reason',
  'confirmed_at',
  'created_at',
  'version',
] as const;

export interface AcquisitionRow {
  id: string;
  mre_realm_id: string;
  property_reference_id: string;
  status: string;
  purchase_price: string;
  currency: string;
  acquired_share_numerator: number;
  acquired_share_denominator: number;
  contract_date: string;
  economic_transfer_date: string | null;
  economic_transfer_recorded_at: Date | null;
  economic_transfer_source_references: string[] | null;
  ownership_aligned_at: Date | null;
  ownership_alignment_source_references: string[] | null;
  confirmed_ownership_start: string | null;
  land_registry_transfer_date: string | null;
  source_references: string[];
  notes: string | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  confirmed_at: Date | null;
  created_at: Date;
  version: number;
}

export async function readOne(trx: Transaction<Database>, id: string): Promise<Acquisition> {
  const row = await trx.selectFrom('acquisition').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow();
  return (await withParties(trx, [row]))[0] as Acquisition;
}

/** The rows as Acquisitions, with their buyers and sellers in the order given. */
export async function withParties(trx: Transaction<Database>, rows: readonly AcquisitionRow[]): Promise<Acquisition[]> {
  if (rows.length === 0) return [];
  const parties = await trx
    .selectFrom('acquisition_party')
    .select(['acquisition_id', 'party_id', 'role'])
    .where(
      'acquisition_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('position')
    .execute();
  const of = (id: string, role: 'BUYER' | 'SELLER') => parties.filter((p) => p.acquisition_id === id && p.role === role).map((p) => p.party_id);
  // §58N: the flag's level needs the sellers' AfA components, read only for a recorded date.
  const sellers = await sellersWithAfaComponent(
    trx,
    rows.filter((r) => r.economic_transfer_recorded_at !== null).map((r) => r.id),
  );
  return rows.map((row) => ({
    id: row.id as AcquisitionId,
    mreRealmId: row.mre_realm_id,
    propertyReferenceId: row.property_reference_id,
    status: row.status as AcquisitionStatus,
    purchasePrice: fromNumericAmount(row.purchase_price, row.currency),
    acquiredShare: { numerator: row.acquired_share_numerator, denominator: row.acquired_share_denominator },
    contractDate: row.contract_date as BusinessDate,
    economicTransferDate: row.economic_transfer_date as BusinessDate | null,
    economicTransferRecordedAt: row.economic_transfer_recorded_at,
    economicTransferSourceReferences: row.economic_transfer_source_references,
    ownershipAlignedAt: row.ownership_aligned_at,
    ownershipAlignmentSourceReferences: row.ownership_alignment_source_references,
    confirmedOwnershipStart: row.confirmed_ownership_start as BusinessDate | null,
    landRegistryTransferDate: row.land_registry_transfer_date as BusinessDate | null,
    buyerPartyIds: of(row.id, 'BUYER'),
    sellerPartyIds: of(row.id, 'SELLER'),
    sourceReferences: row.source_references,
    notes: row.notes,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    version: row.version,
    flags: flagsOf(row, sellers.has(row.id)),
  }));
}

const flagsOf = (row: AcquisitionRow, sellerHasAfaComponent: boolean) => {
  const flag = ownershipStartFlag(
    {
      id: row.id,
      status: row.status as AcquisitionStatus,
      contractDate: row.contract_date as BusinessDate,
      economicTransferDate: row.economic_transfer_date as BusinessDate | null,
      economicTransferRecordedAt: row.economic_transfer_recorded_at,
      ownershipAlignedAt: row.ownership_aligned_at,
      confirmedOwnershipStart: row.confirmed_ownership_start as BusinessDate | null,
    },
    sellerHasAfaComponent,
  );
  return flag === null ? [] : [flag];
};

/** The created Acquisition as JSON for the idempotency store: Money as `{ amount, currency }`, timestamps ISO. */
export interface AcquisitionSnapshot
  extends Omit<
    Acquisition,
    'purchasePrice' | 'createdAt' | 'cancelledAt' | 'confirmedAt' | 'economicTransferRecordedAt' | 'ownershipAlignedAt' | 'confirmedOwnershipStart'
  > {
  readonly purchasePrice: { readonly amount: string; readonly currency: string };
  readonly confirmedOwnershipStart?: BusinessDate | null;
  readonly createdAt: string;
  readonly economicTransferRecordedAt: string | null;
  readonly ownershipAlignedAt?: string | null;
  readonly cancelledAt: string | null;
  readonly confirmedAt: string | null;
}

export function toSnapshot(a: Acquisition): AcquisitionSnapshot {
  return {
    ...a,
    purchasePrice: { amount: a.purchasePrice.amount, currency: a.purchasePrice.currency },
    createdAt: a.createdAt.toISOString(),
    economicTransferRecordedAt: a.economicTransferRecordedAt?.toISOString() ?? null,
    ownershipAlignedAt: a.ownershipAlignedAt?.toISOString() ?? null,
    cancelledAt: a.cancelledAt?.toISOString() ?? null,
    confirmedAt: a.confirmedAt?.toISOString() ?? null,
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
export function fromSnapshot(result: unknown): Acquisition {
  const s = result as AcquisitionSnapshot;
  return {
    ...s,
    id: s.id,
    purchasePrice: fromNumericAmount(s.purchasePrice.amount, s.purchasePrice.currency),
    createdAt: new Date(s.createdAt),
    economicTransferRecordedAt:
      s.economicTransferRecordedAt === null || s.economicTransferRecordedAt === undefined ? null : new Date(s.economicTransferRecordedAt),
    // A snapshot stored before 0067 has neither field.
    economicTransferSourceReferences: s.economicTransferSourceReferences ?? null,
    // A snapshot stored before 0072 has neither field.
    ownershipAlignedAt: s.ownershipAlignedAt === null || s.ownershipAlignedAt === undefined ? null : new Date(s.ownershipAlignedAt),
    ownershipAlignmentSourceReferences: s.ownershipAlignmentSourceReferences ?? null,
    // A snapshot stored before 0073 has no such field.
    confirmedOwnershipStart: s.confirmedOwnershipStart ?? null,
    flags: s.flags ?? [],
    cancelledAt: s.cancelledAt === null ? null : new Date(s.cancelledAt),
    confirmedAt: s.confirmedAt === null ? null : new Date(s.confirmedAt),
  };
}
