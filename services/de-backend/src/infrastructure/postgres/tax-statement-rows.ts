import type { Transaction } from 'kysely';
import type {
  AcknowledgedKind,
  ChangeEntityType,
  LoanAllocationTaxConfirmation,
  PartChangeEntityType,
  PartItem,
  PartState,
  TaxStatementStatus,
  TaxYearAcknowledgement,
} from '../../domains/taxation/index.js';
import { Money } from '../../shared/index.js';
import { setsOfLoans } from './loan-allocation-repository.js';
import type { Database } from './schema.js';

/**
 * The rows of migrations 0060 and 0063 (api-design.md §58E, §58G) as Taxation reads them: the acknowledgements with their
 * items of either shape (a part item's amounts in EUR, the view's currency), the
 * confirmations with their set (read from the set, never stored again), in the caller's transaction.
 */

export const ACKNOWLEDGEMENT_COLUMNS = [
  'id',
  'mre_realm_id',
  'property_reference_id',
  'tax_year',
  'audit_record_id',
  'change_kind',
  'change_entity_type',
  'change_entity_id',
  'change_recorded_at',
  'change_fingerprint',
  'reason',
  'acknowledged_at',
  'acknowledged_by',
  'status',
  'withdrawn_at',
  'withdrawn_by',
  'withdraw_reason',
  'version',
] as const;

export const CONFIRMATION_COLUMNS = [
  'id',
  'mre_realm_id',
  'allocation_set_id',
  'reason',
  'advisor_party_id',
  'confirmed_at',
  'confirmed_by',
  'status',
  'withdrawn_at',
  'withdrawn_by',
  'withdraw_reason',
  'version',
] as const;

/** The Realm's acknowledgements of a PropertyReference and year, newest first (`acknowledgedAt` descending, then id). */
export async function acknowledgementsOf(
  trx: Transaction<Database>,
  mreRealmId: string,
  propertyReferenceId: string,
  year: number,
  statuses: readonly TaxStatementStatus[] | null,
  ids?: readonly string[],
): Promise<TaxYearAcknowledgement[]> {
  let query = trx
    .selectFrom('tax_year_acknowledgement')
    .select(ACKNOWLEDGEMENT_COLUMNS)
    .where('mre_realm_id', '=', mreRealmId)
    .where('property_reference_id', '=', propertyReferenceId)
    .where('tax_year', '=', year);
  if (statuses !== null) query = query.where('status', 'in', [...statuses]);
  if (ids !== undefined) query = query.where('id', 'in', [...ids]);
  const rows = await query.orderBy('acknowledged_at', 'desc').orderBy('id').execute();
  if (rows.length === 0) return [];
  const items = await trx
    .selectFrom('tax_year_acknowledgement_item')
    .select(['acknowledgement_id', 'source_id', 'year_before', 'year_after'])
    .where(
      'acknowledgement_id',
      'in',
      rows.map((r) => r.id),
    )
    .where('mre_realm_id', '=', mreRealmId)
    .orderBy('acknowledgement_id')
    .orderBy('source_id')
    .execute();
  const partItems = await trx
    .selectFrom('tax_year_acknowledgement_part_item')
    .select(['acknowledgement_id', 'source_type', 'source_id', 'tax_year', 'state_before', 'part_before', 'state_after', 'part_after'])
    .where(
      'acknowledgement_id',
      'in',
      rows.map((r) => r.id),
    )
    .where('mre_realm_id', '=', mreRealmId)
    .orderBy('acknowledgement_id')
    .orderBy('source_type')
    .orderBy('source_id')
    .execute();
  const money = (value: string | null) => (value === null ? null : Money.of(value, 'EUR'));
  const partsOf = (id: string): PartItem[] =>
    partItems
      .filter((i) => i.acknowledgement_id === id)
      .map((i) => ({
        sourceType: i.source_type as PartItem['sourceType'],
        sourceId: i.source_id,
        taxYear: i.tax_year,
        stateBefore: i.state_before as PartState,
        partBefore: money(i.part_before),
        stateAfter: i.state_after as PartState,
        partAfter: money(i.part_after),
      }));
  return rows.map((r) => ({
    acknowledgementId: r.id,
    propertyReferenceId: r.property_reference_id,
    year: r.tax_year,
    status: r.status as TaxStatementStatus,
    change: {
      auditRecordId: r.audit_record_id,
      kind: r.change_kind as AcknowledgedKind,
      entityType: r.change_entity_type as ChangeEntityType | PartChangeEntityType,
      entityId: r.change_entity_id,
      recordedAt: r.change_recorded_at,
      fingerprint: r.change_fingerprint,
      items: [
        ...items.filter((i) => i.acknowledgement_id === r.id).map((i) => ({ sourceId: i.source_id, yearBefore: i.year_before, yearAfter: i.year_after })),
        ...partsOf(r.id),
      ],
    },
    reason: r.reason,
    acknowledgedAt: r.acknowledged_at,
    acknowledgedBy: r.acknowledged_by,
    withdrawnAt: r.withdrawn_at,
    withdrawnBy: r.withdrawn_by,
    withdrawReason: r.withdraw_reason,
    version: r.version,
  }));
}

/** The Realm's confirmations of the sets, newest first, each with its set as stored (§41.3: never changed). */
export async function confirmationsOf(
  trx: Transaction<Database>,
  mreRealmId: string,
  setIds: readonly string[],
  statuses: readonly TaxStatementStatus[] | null,
  ids?: readonly string[],
): Promise<LoanAllocationTaxConfirmation[]> {
  if (setIds.length === 0) return [];
  let query = trx
    .selectFrom('loan_allocation_tax_confirmation as c')
    .innerJoin('loan_allocation_set as s', 's.id', 'c.allocation_set_id')
    .select(CONFIRMATION_COLUMNS.map((c) => `c.${c}` as const))
    .select('s.loan_id')
    .where('c.mre_realm_id', '=', mreRealmId)
    .where('c.allocation_set_id', 'in', [...setIds]);
  if (statuses !== null) query = query.where('c.status', 'in', [...statuses]);
  if (ids !== undefined) query = query.where('c.id', 'in', [...ids]);
  const rows = await query.orderBy('c.confirmed_at', 'desc').orderBy('c.id').execute();
  if (rows.length === 0) return [];
  const sets = new Map(
    [...(await setsOfLoans(trx, mreRealmId, [...new Set(rows.map((r) => r.loan_id))])).values()].flat().map((s) => [s.id as string, s] as const),
  );
  return rows.flatMap((r) => {
    const set = sets.get(r.allocation_set_id);
    if (set === undefined) return [];
    return [
      {
        confirmationId: r.id,
        loanId: r.loan_id,
        allocationSetId: r.allocation_set_id,
        status: r.status as TaxStatementStatus,
        set: {
          validFrom: set.validFrom,
          basis: set.basis,
          allocations: set.allocations.map((a) => ({
            propertyReferenceId: a.propertyReferenceId,
            share: `${a.share.numerator}/${a.share.denominator}`,
            acquisitionId: a.acquisitionId,
          })),
        },
        reason: r.reason,
        advisorPartyId: r.advisor_party_id,
        confirmedAt: r.confirmed_at,
        confirmedBy: r.confirmed_by,
        withdrawnAt: r.withdrawn_at,
        withdrawnBy: r.withdrawn_by,
        withdrawReason: r.withdraw_reason,
        version: r.version,
      },
    ];
  });
}

/** What the view reads (§58E "In the view"): the `ACTIVE` acknowledgements of the year and confirmations of the sets. */
export async function statementsOfYear(
  trx: Transaction<Database>,
  mreRealmId: string,
  propertyReferenceId: string,
  year: number,
  setIds: readonly string[],
): Promise<{
  readonly acknowledgements: readonly TaxYearAcknowledgement[];
  readonly taxConfirmations: ReadonlyMap<string, LoanAllocationTaxConfirmation>;
}> {
  const acknowledgements = await acknowledgementsOf(trx, mreRealmId, propertyReferenceId, year, ['ACTIVE']);
  const confirmations = await confirmationsOf(trx, mreRealmId, [...new Set(setIds)], ['ACTIVE']);
  return { acknowledgements, taxConfirmations: new Map(confirmations.map((c) => [c.allocationSetId, c])) };
}
