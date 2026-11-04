import { sql, type Transaction } from 'kysely';
import type { OwnershipStartFact } from '../../domains/taxation/index.js';
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
 * The PropertyReference's Acquisitions (not cancelled) whose date was recorded later than their Ownerships began, with
 * their `ECONOMIC_TRANSFER_DATE_RECORDED` record (the latest, there is one) and the seller's AfA component.
 */
export async function ownershipStartFactsOf(trx: Transaction<Database>, mreRealmId: string, propertyReferenceId: string): Promise<OwnershipStartFact[]> {
  const rows = await trx
    .selectFrom('acquisition')
    .select([
      'id',
      sql<string>`to_char(contract_date, 'YYYY-MM-DD')`.as('contract_date'),
      sql<string>`to_char(economic_transfer_date, 'YYYY-MM-DD')`.as('economic_transfer_date'),
    ])
    .where('mre_realm_id', '=', mreRealmId)
    .where('property_reference_id', '=', propertyReferenceId)
    .where('status', '<>', 'CANCELLED')
    .where('economic_transfer_recorded_at', 'is not', null)
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
        ownershipStart: r.contract_date as BusinessDate,
        economicTransferDate: r.economic_transfer_date as BusinessDate,
        sellerHasAfaComponent: sellers.has(r.id),
        auditRecordId: record.id,
        recordedAt: record.occurred_at,
      },
    ];
  });
}
