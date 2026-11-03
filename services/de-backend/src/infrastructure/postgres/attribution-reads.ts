import type { Transaction } from 'kysely';
import { withValidUntil } from '../../domains/financing/index.js';
import type { ChangedEntry, RentDueDay } from '../../domains/rental-contract-reference/index.js';
import { widestWindowDays, type AttributionInput, type HistoryRecord, type LoanTermsHistory, type RuleRegistry } from '../../domains/taxation/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { setsOfLoans } from './loan-allocation-repository.js';
import { readLoanIn } from './loan-repository.js';
import { periodsOf } from './loan-terms-repository.js';
import type { Database } from './schema.js';
import { currentOf } from './tax-classification-rows.js';
import { countingSplits, factsQuery } from './tax-source-facts.js';

/**
 * What `ATTRIBUTION_INPUT_CHANGED` reads (api-design.md §58C, §58E Part 1), in the caller's snapshot: the counting
 * candidates booked in either window at an edge of `year` and the histories of their inputs. Every entity is selected
 * in the Realm first, then its AuditRecords by `audit_record_entity_idx` (`audit_record` has no Realm column), so
 * another Realm's AuditRecord is never read. Used by the view and by the acknowledgement command (its own snapshot).
 */

/** The rent splits whose year `rentDueDays` and the reconciliation decide (§58A's table): base rent and advances. */
const ATTRIBUTED_RENT_CODES = ['RENT_BASE', 'RENT_OPERATING_COST_ADVANCE'];

const NONE: AttributionInput = { references: [], candidates: [] };

export async function recordsOf(trx: Transaction<Database>, entityType: string, ids: readonly string[], actions: readonly string[]) {
  if (ids.length === 0) return [];
  return trx
    .selectFrom('audit_record')
    .select(['id', 'entity_id', 'action', 'new_version', 'occurred_at', 'metadata'])
    .where('entity_type', '=', entityType)
    .where('entity_id', 'in', [...ids])
    .where('action', 'in', [...actions])
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();
}

export const history = (records: Awaited<ReturnType<typeof recordsOf>>, id: string): HistoryRecord[] =>
  records.filter((r) => r.entity_id === id).map((r) => ({ auditRecordId: r.id, action: r.action, occurredAt: r.occurred_at }));

export async function attributionInputOf(
  trx: Transaction<Database>,
  mreRealmId: string,
  propertyReferenceId: string,
  year: number,
  registry: RuleRegistry,
): Promise<AttributionInput> {
  const days = widestWindowDays(registry);
  if (days === 0) return NONE;
  const windows = [year - 1, year].map((y) => ({ from: `${y}-12-${String(32 - days).padStart(2, '0')}`, to: `${y + 1}-01-${String(days).padStart(2, '0')}` }));
  const rows = await countingSplits(factsQuery(trx, mreRealmId).where('s.property_reference_id', '=', propertyReferenceId))
    .where('c.code', 'in', ATTRIBUTED_RENT_CODES)
    .where((eb) => eb.or(windows.map((w) => eb.and([eb('t.booking_date', '>=', w.from), eb('t.booking_date', '<=', w.to)]))))
    .orderBy('t.booking_date')
    .orderBy('t.id')
    .orderBy('s.position')
    .execute();
  const loans = await loanTermsHistories(trx, mreRealmId, propertyReferenceId, windows);
  if (rows.length === 0) return { ...NONE, loans };
  // Every reconciliation of the candidates' Transactions that is or was CONFIRMED (a RELEASED one was), in the Realm.
  const reconciliations = await trx
    .selectFrom('rent_payment_reconciliation')
    .select(['id', 'transaction_id', 'mre_tenant_id', 'mre_rent_term', 'status'])
    .where('transaction_id', 'in', [...new Set(rows.map((r) => r.transaction_id))])
    .where('mre_realm_id', '=', mreRealmId)
    .where('status', 'in', ['CONFIRMED', 'RELEASED'])
    .orderBy('id')
    .execute();
  const overrides = await currentOf(
    trx,
    rows.map((r) => r.id),
  );
  const confirmed = reconciliations.filter((c) => c.status === 'CONFIRMED');
  const candidates: AttributionInput['candidates'][number][] = rows.flatMap((r) => {
    const terms = new Map(confirmed.filter((c) => c.transaction_id === r.transaction_id).map((c) => [`${c.mre_tenant_id}/${c.mre_rent_term}`, c] as const));
    // Without one term the rent has no economic period under any list (§58A): rentDueDays decides nothing.
    const [only] = terms.values();
    if (only === undefined || terms.size > 1) return [];
    return [
      {
        sourceId: r.id,
        bookingDate: r.booking_date as BusinessDate,
        financialCategoryCode: r.code,
        mreTenantId: only.mre_tenant_id,
        mreRentTerm: only.mre_rent_term,
        taxYearOverride: overrides.get(r.id)?.taxYear ?? null,
      },
    ];
  });
  const tenants = [...new Set([...candidates.map((c) => c.mreTenantId), ...reconciliations.map((c) => c.mre_tenant_id)])];
  const references =
    tenants.length === 0
      ? []
      : await trx
          .selectFrom('rental_contract_reference')
          .select(['id', 'mre_tenant_id', 'rent_due_days'])
          .where('mre_realm_id', '=', mreRealmId)
          .where('mre_tenant_id', 'in', tenants)
          .orderBy('id')
          .execute();
  const rentTenants = new Set(candidates.map((c) => c.mreTenantId));
  const ofCandidates = references.filter((r) => rentTenants.has(r.mre_tenant_id));
  const referenceRecords = await recordsOf(
    trx,
    'RentalContractReference',
    ofCandidates.map((r) => r.id),
    ['CREATED', 'AMENDED'],
  );
  const reconciliationRecords = await recordsOf(
    trx,
    'RentPaymentReconciliation',
    reconciliations.map((r) => r.id),
    ['CONFIRMED', 'RELEASED'],
  );
  const reconciled = new Set(reconciliations.map((r) => r.transaction_id));
  return {
    candidates,
    references: ofCandidates.map((r) => {
      const own = referenceRecords.filter((a) => a.entity_id === r.id);
      const created = own.find((a) => a.action === 'CREATED');
      const createdDays = (created?.metadata as { rentDueDays?: RentDueDay[] } | null)?.rentDueDays;
      return {
        rentalContractReferenceId: r.id,
        mreTenantId: r.mre_tenant_id,
        rentDueDays: r.rent_due_days as RentDueDay[],
        created: createdDays ?? null,
        createdRecord: created === undefined ? null : { auditRecordId: created.id, createdAt: created.occurred_at },
        amendments: own
          .filter((a) => a.action === 'AMENDED')
          .map((a) => ({
            auditRecordId: a.id,
            newVersion: a.new_version ?? 0,
            amendedAt: a.occurred_at,
            changedEntries: (a.metadata as { changedEntries?: ChangedEntry[] } | null)?.changedEntries ?? [],
          }))
          // An amendment of notes, sourceReferences or evidence alone has no changedEntries (§58C; §58E, 237-4).
          .filter((a) => a.changedEntries.length > 0),
      };
    }),
    reconciliations: {
      candidates: rows
        .filter((r) => reconciled.has(r.transaction_id))
        .map((r) => ({
          sourceId: r.id,
          transactionId: r.transaction_id,
          bookingDate: r.booking_date as BusinessDate,
          financialCategoryCode: r.code,
          taxYearOverride: overrides.get(r.id)?.taxYear ?? null,
        })),
      reconciliations: reconciliations.map((r) => ({
        reconciliationId: r.id,
        transactionId: r.transaction_id,
        mreTenantId: r.mre_tenant_id,
        mreRentTerm: r.mre_rent_term,
        confirmedNow: r.status === 'CONFIRMED',
        records: history(reconciliationRecords, r.id),
      })),
      rentDueDays: references.map((r) => ({ mreTenantId: r.mre_tenant_id, rentDueDays: r.rent_due_days as RentDueDay[] })),
    },
    loans,
  };
}

/**
 * The candidate Loans of §58D (a `VALID` set names the PropertyReference) with a counting `LOAN_INTEREST` split booked
 * in a window, each with its periods (`VALID` and `VOID`, in the Realm), their `CREATED`/`VOIDED` records and its sets.
 */
async function loanTermsHistories(
  trx: Transaction<Database>,
  mreRealmId: string,
  propertyReferenceId: string,
  windows: readonly { readonly from: string; readonly to: string }[],
): Promise<LoanTermsHistory[]> {
  const rows = await countingSplits(factsQuery(trx, mreRealmId))
    .where('c.code', '=', 'LOAN_INTEREST')
    .where((eb) =>
      eb(
        's.loan_id',
        'in',
        eb
          .selectFrom('loan_allocation_set as las')
          .innerJoin('loan_allocation as la', 'la.set_id', 'las.id')
          .select('las.loan_id')
          .where('las.mre_realm_id', '=', mreRealmId)
          .where('las.status', '=', 'VALID')
          .where('la.property_reference_id', '=', propertyReferenceId),
      ),
    )
    .where((eb) => eb.or(windows.map((w) => eb.and([eb('t.booking_date', '>=', w.from), eb('t.booking_date', '<=', w.to)]))))
    .orderBy('t.booking_date')
    .orderBy('t.id')
    .orderBy('s.position')
    .execute();
  if (rows.length === 0) return [];
  const overrides = await currentOf(
    trx,
    rows.map((r) => r.id),
  );
  const loanIds = [...new Set(rows.map((r) => r.loan_id as string))].sort();
  const sets = await setsOfLoans(trx, mreRealmId, loanIds);
  const found: LoanTermsHistory[] = [];
  for (const loanId of loanIds) {
    const loan = await readLoanIn(trx, loanId, mreRealmId);
    if (loan === undefined) continue;
    const periods = (await periodsOf(trx, loanId)).filter((t) => t.mreRealmId === mreRealmId);
    const records = await recordsOf(
      trx,
      'LoanTerms',
      periods.map((t) => t.id),
      ['CREATED', 'VOIDED'],
    );
    found.push({
      loanId,
      loan,
      terms: periods.map((t) => ({ period: t, validNow: t.status === 'VALID', records: history(records, t.id) })),
      candidates: rows
        .filter((r) => r.loan_id === loanId)
        .map((r) => ({
          sourceId: r.id,
          bookingDate: r.booking_date as BusinessDate,
          financialCategoryCode: r.code,
          taxYearOverride: overrides.get(r.id)?.taxYear ?? null,
        })),
      sets: withValidUntil(sets.get(loanId) ?? []),
    });
  }
  return found;
}
