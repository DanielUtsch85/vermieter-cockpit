import { sql, type Transaction } from 'kysely';
import { ownershipStart } from '../../domains/acquisition/index.js';
import type { OwnershipAlignmentFact, OwnershipStartFact } from '../../domains/taxation/index.js';
import type { BusinessDate } from '../../shared/index.js';
import type { Database } from './schema.js';

/**
 * The reads of §58N's flag `OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER` (Entscheidung des Projektinhabers, 2026-11-04,
 * Frage 5), in the caller's snapshot. A seller "has an AfA component" when it holds a `VALID` Ownership of the same
 * PropertyReference in the same Realm carrying another, not cancelled Acquisition: the part of a purchase component of
 * §59A (`purchase-work.ts` reads the same from the schedule's Ownerships). Nothing is written.
 */

/** Of the given Acquisitions, those with such a seller. */
export async function sellersWithAfaComponent(trx: Transaction<Database>, acquisitionIds: readonly string[]): Promise<Set<string>> {
  if (acquisitionIds.length === 0) return new Set();
  const rows = await trx
    .selectFrom('acquisition_party as ap')
    .innerJoin('acquisition as a', (j) => j.onRef('a.id', '=', 'ap.acquisition_id').onRef('a.mre_realm_id', '=', 'ap.mre_realm_id'))
    .innerJoin('ownership as o', (j) =>
      j
        .onRef('o.owner_party_id', '=', 'ap.party_id')
        .onRef('o.property_reference_id', '=', 'a.property_reference_id')
        .onRef('o.mre_realm_id', '=', 'a.mre_realm_id')
        .on('o.status', '=', 'VALID')
        .on('o.acquisition_id', 'is not', null)
        .onRef('o.acquisition_id', '<>', 'a.id'),
    )
    .innerJoin('acquisition as other', (j) => j.onRef('other.id', '=', 'o.acquisition_id').on('other.status', '<>', 'CANCELLED'))
    .select('ap.acquisition_id')
    .distinct()
    .where('ap.role', '=', 'SELLER')
    .where('ap.acquisition_id', 'in', acquisitionIds)
    .execute();
  return new Set(rows.map((r) => r.acquisition_id));
}

/**
 * The PropertyReference's `CONFIRMED` Acquisitions (not aligned by §58Q, not confirmed from the transfer by §58R) whose
 * date was recorded later than their Ownerships began, with their `ECONOMIC_TRANSFER_DATE_RECORDED` record (the latest,
 * there is one) and the seller's AfA component. A `DRAFT` dated under §58N no longer raises the flag (§58R rule 7,
 * Entscheidung des Projektinhabers, 2026-11-06, Frage 5): its `ownershipStart` is the date.
 */
export async function ownershipStartFactsOf(trx: Transaction<Database>, mreRealmId: string, propertyReferenceId: string): Promise<OwnershipStartFact[]> {
  const rows = await trx
    .selectFrom('acquisition')
    .select([
      'id',
      sql<string>`to_char(contract_date, 'YYYY-MM-DD')`.as('contract_date'),
      sql<string>`to_char(economic_transfer_date, 'YYYY-MM-DD')`.as('economic_transfer_date'),
      'status',
      'economic_transfer_recorded_at',
    ])
    .where('mre_realm_id', '=', mreRealmId)
    .where('property_reference_id', '=', propertyReferenceId)
    .where('status', '=', 'CONFIRMED')
    .where('economic_transfer_recorded_at', 'is not', null)
    // §58Q: an aligned Acquisition's Ownerships begin on the transfer; the gap is closed and the flag no longer arises.
    .where('ownership_aligned_at', 'is', null)
    // §58R: confirmed from the transfer, the gap never arose.
    .where('confirmed_ownership_start', 'is', null)
    .whereRef('economic_transfer_date', '>', 'contract_date')
    .orderBy('id')
    .execute();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const records = await trx
    .selectFrom('audit_record')
    .select(['id', 'entity_id', 'occurred_at'])
    .where('entity_type', '=', 'Acquisition')
    .where('action', '=', 'ECONOMIC_TRANSFER_DATE_RECORDED')
    .where('entity_id', 'in', ids)
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const sellers = await sellersWithAfaComponent(trx, ids);
  return rows.flatMap((r) => {
    const record = records.find((x) => x.entity_id === r.id);
    // A date recorded past the command has no record: nothing a person could acknowledge, so no entry (none in practice).
    if (record === undefined) return [];
    return [
      {
        acquisitionId: r.id,
        // Read through the rule (§58R rule 7), not hard-coded: branch 4, the contract date.
        ownershipStart: ownershipStart({
          status: r.status,
          contractDate: r.contract_date as BusinessDate,
          economicTransferDate: r.economic_transfer_date as BusinessDate,
          economicTransferRecordedAt: r.economic_transfer_recorded_at,
        }),
        economicTransferDate: r.economic_transfer_date as BusinessDate,
        sellerHasAfaComponent: sellers.has(r.id),
        auditRecordId: record.id,
        recordedAt: record.occurred_at,
      },
    ];
  });
}

/**
 * §58Q open question 7 (decided 2026-11-05): the PropertyReference's Acquisitions whose Ownerships the act aligned, with
 * the former gap `[contractDate, economicTransferDate − 1]` and their `OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER` record
 * (one per Acquisition, the act is never applied twice). In the caller's snapshot; nothing is written.
 */
export async function ownershipAlignmentFactsOf(
  trx: Transaction<Database>,
  mreRealmId: string,
  propertyReferenceId: string,
): Promise<OwnershipAlignmentFact[]> {
  const rows = await trx
    .selectFrom('acquisition')
    .select([
      'id',
      sql<string>`to_char(contract_date, 'YYYY-MM-DD')`.as('contract_date'),
      sql<string>`to_char(economic_transfer_date, 'YYYY-MM-DD')`.as('economic_transfer_date'),
      'ownership_aligned_at',
    ])
    .where('mre_realm_id', '=', mreRealmId)
    .where('property_reference_id', '=', propertyReferenceId)
    .where('ownership_aligned_at', 'is not', null)
    .orderBy('id')
    .execute();
  if (rows.length === 0) return [];
  const records = await trx
    .selectFrom('audit_record')
    .select(['id', 'entity_id', 'occurred_at'])
    .where('entity_type', '=', 'Acquisition')
    .where('action', '=', 'OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER')
    .where(
      'entity_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  return rows.flatMap((r) => {
    const record = records.find((x) => x.entity_id === r.id);
    // Aligned past the command has no record: nothing a person could acknowledge, so no entry (none in practice).
    if (record === undefined) return [];
    return [
      {
        acquisitionId: r.id,
        contractDate: r.contract_date as BusinessDate,
        economicTransferDate: r.economic_transfer_date as BusinessDate,
        auditRecordId: record.id,
        // The act's time (the command's clock), as stored with the marker; the 31 December rule reads it.
        alignedAt: r.ownership_aligned_at as Date,
      },
    ];
  });
}
