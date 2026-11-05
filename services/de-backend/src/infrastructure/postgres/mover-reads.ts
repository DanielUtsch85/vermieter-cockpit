import { sql, type Transaction } from 'kysely';
import type { CorrectionHistory, DepositClosingHistory, DepositClosingState, RuleRegistry } from '../../domains/taxation/index.js';
import { Money, type BusinessDate, type MoneyJson } from '../../shared/index.js';
import { recordsOf } from './audit-history-reads.js';
import { setsOfLoans } from './loan-allocation-repository.js';
import { loanPeriodFactsOf, periodOfSplit } from './loan-interest-periods.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { DEPOSIT_RENT_CODES, depositFactsOf, factsQuery, meaningsOf, overriddenTo, toRead, yearWindow } from './tax-source-facts.js';

/**
 * What §58I (VC-X-50) reads, in the caller's snapshot (the view's or the acknowledgement command's): the deposits
 * attributed to P now with their `SecurityDeposit` records (Part 1), and the Realm's corrected Transactions whose own
 * split or whose replacement's split can count in `year` for P, with their splits and their one `CORRECTED`/`REVERSED`
 * record (Part 2). Every entity is selected in the Realm first, then its AuditRecords by `audit_record_entity_idx`
 * (`audit_record` has no Realm column), so another Realm's record is never read.
 */

const DEPOSIT_ACTIONS = ['CREATED', 'AMENDED', 'CLOSED', 'REOPENED', 'VOIDED'];

/** A closing as a `CLOSED` record's metadata or a `REOPENED` record's `cleared` carries it (§47.4); `null` without one. */
function closingOfMetadata(value: unknown): DepositClosingState | null {
  const m = value as { closingDate?: unknown; reason?: unknown; heldAtClosing?: MoneyJson } | null | undefined;
  if (m === null || m === undefined || typeof m.closingDate !== 'string' || typeof m.reason !== 'string' || m.heldAtClosing === undefined) return null;
  return { closingDate: m.closingDate as BusinessDate, reason: m.reason, heldAtClosing: Money.of(m.heldAtClosing.amount, m.heldAtClosing.currency) };
}

/**
 * §58I Part 1: the Realm's deposits whose Tenant's `CONFIRMED` rent is booked on P and whose PropertyReference, derived
 * as §58A does now, is P; of those, every one with a `CLOSED` record or `CLOSED` now, with its row and its records.
 */
export async function depositClosingHistoriesOf(trx: Transaction<Database>, mreRealmId: string, propertyReferenceId: string): Promise<DepositClosingHistory[]> {
  const rows = await trx
    .selectFrom('security_deposit')
    .select([
      'id',
      'mre_tenant_id',
      'status',
      'currency',
      'closing_reason',
      sql<string | null>`to_char(closing_date, 'YYYY-MM-DD')`.as('closing_date'),
      sql<string | null>`held_at_closing::text`.as('held_at_closing'),
    ])
    .where('mre_realm_id', '=', mreRealmId)
    .where('mre_tenant_id', 'in', (eb) =>
      eb
        .selectFrom('rent_payment_reconciliation as r')
        .innerJoin('transaction_split as s', 's.transaction_id', 'r.transaction_id')
        .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
        .select('r.mre_tenant_id')
        .where('r.mre_realm_id', '=', mreRealmId)
        .where('r.status', '=', 'CONFIRMED')
        .where('c.code', 'in', [...DEPOSIT_RENT_CODES])
        .where('s.property_reference_id', '=', propertyReferenceId),
    )
    .orderBy('id')
    .execute();
  if (rows.length === 0) return [];
  // Only the deposits attributed to P now (one PropertyReference, P's): a deposit not attributed moves no figure (§58I).
  const attributed = new Set(
    (
      await depositFactsOf(
        trx,
        mreRealmId,
        rows.map((r) => r.id),
      )
    )
      .filter((f) => f.propertyReferenceId === propertyReferenceId)
      .map((f) => f.securityDepositId),
  );
  const own = rows.filter((r) => attributed.has(r.id));
  const records = await recordsOf(
    trx,
    'SecurityDeposit',
    own.map((r) => r.id),
    DEPOSIT_ACTIONS,
  );
  return (
    own
      // A deposit with a CLOSED record, or CLOSED now (without a record its history is unusable, §58I "The history").
      .filter((r) => r.status === 'CLOSED' || records.some((a) => a.entity_id === r.id && a.action === 'CLOSED'))
      .map((r) => ({
        securityDepositId: r.id,
        mreTenantId: r.mre_tenant_id,
        status: r.status,
        closing:
          r.closing_date === null || r.closing_reason === null || r.held_at_closing === null
            ? null
            : { closingDate: r.closing_date as BusinessDate, reason: r.closing_reason, heldAtClosing: fromNumericAmount(r.held_at_closing, r.currency) },
        records: records
          .filter((a) => a.entity_id === r.id)
          .map((a) => {
            const metadata = a.metadata as { cleared?: unknown } | null;
            const closing = a.action === 'CLOSED' ? closingOfMetadata(metadata) : a.action === 'REOPENED' ? closingOfMetadata(metadata?.cleared) : null;
            return { auditRecordId: a.id, action: a.action, occurredAt: a.occurred_at, closing };
          }),
      }))
  );
}

/**
 * §58I Part 2: the Realm's corrected Transactions whose own split or whose replacement's split is on P or of a Loan with
 * a `VALID` set naming P, and can count in `year` (booked in it or in its windows, or overridden to it); each with its
 * links, the splits of the original and of the replacement (their tax year by §58A as the list derives it, now) and
 * its `CORRECTED`/`REVERSED` records.
 */
export async function correctionHistoriesOf(
  trx: Transaction<Database>,
  registry: RuleRegistry,
  mreRealmId: string,
  propertyReferenceId: string,
  year: number,
  today: BusinessDate,
): Promise<CorrectionHistory[]> {
  const { from, to } = yearWindow(registry, year);
  const touched = await trx
    .selectFrom('transaction_split as s')
    .innerJoin('ledger_transaction as t', 't.id', 's.transaction_id')
    .select(['t.id', 't.status', 't.correction_role', 't.correction_of_transaction_id'])
    .distinct()
    .where('s.mre_realm_id', '=', mreRealmId)
    .where('t.mre_realm_id', '=', mreRealmId)
    .where((eb) =>
      eb.or([
        eb('s.property_reference_id', '=', propertyReferenceId),
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
      ]),
    )
    .where((eb) => eb.or([eb.and([eb('t.booking_date', '>=', from), eb('t.booking_date', '<=', to)]), eb('s.id', 'in', overriddenTo(trx, year))]))
    .where((eb) => eb.or([eb('t.status', '=', 'CORRECTED'), eb('t.correction_role', '=', 'REPLACEMENT')]))
    .where(sql<boolean>`t.correction_role IS DISTINCT FROM 'REVERSAL'`)
    .execute();
  // The original of each: the corrected Transaction itself, or the one a replacement belongs to (found through it).
  const originalIds = [
    ...new Set(
      touched.flatMap((t) => [
        ...(t.status === 'CORRECTED' ? [t.id] : []),
        ...(t.correction_role === 'REPLACEMENT' && t.correction_of_transaction_id !== null ? [t.correction_of_transaction_id] : []),
      ]),
    ),
  ].sort();
  if (originalIds.length === 0) return [];
  const originals = await trx
    .selectFrom('ledger_transaction')
    .select(['id', 'status'])
    .where('mre_realm_id', '=', mreRealmId)
    .where('id', 'in', originalIds)
    .orderBy('id')
    .execute();
  if (originals.length === 0) return [];
  const linked = await trx
    .selectFrom('ledger_transaction')
    .select(['id', 'correction_of_transaction_id', 'correction_role'])
    .where('mre_realm_id', '=', mreRealmId)
    .where(
      'correction_of_transaction_id',
      'in',
      originals.map((o) => o.id),
    )
    .orderBy('id')
    .execute();
  const linkOf = (id: string, role: string) => linked.find((l) => l.correction_of_transaction_id === id && l.correction_role === role)?.id ?? null;
  const splitRows = await factsQuery(trx, mreRealmId)
    .where('s.transaction_id', 'in', [...originals.map((o) => o.id), ...linked.filter((l) => l.correction_role === 'REPLACEMENT').map((l) => l.id)])
    .orderBy('t.id')
    .orderBy('s.position')
    .execute();
  const meanings = await meaningsOf(trx, registry, mreRealmId, splitRows.map(toRead), today);
  const loanIds = [...new Set(splitRows.flatMap((r) => (r.loan_id === null ? [] : [r.loan_id])))].sort();
  const sets = await setsOfLoans(trx, mreRealmId, loanIds);
  // §58L: a Loan split's interest period by its own booking date and classification, as the view reads it.
  const loans = await loanPeriodFactsOf(trx, mreRealmId, loanIds);
  const records = await recordsOf(
    trx,
    'Transaction',
    originals.map((o) => o.id),
    ['CORRECTED', 'REVERSED'],
  );
  return originals.map((o) => {
    const replacement = linkOf(o.id, 'REPLACEMENT');
    return {
      transactionId: o.id,
      status: o.status,
      reversalTransactionId: linkOf(o.id, 'REVERSAL'),
      replacementTransactionId: replacement,
      records: records
        .filter((r) => r.entity_id === o.id)
        .map((r) => {
          const m = r.metadata as { reversalTransactionId?: string; replacementTransactionId?: string; reason?: string } | null;
          return {
            auditRecordId: r.id,
            action: r.action,
            occurredAt: r.occurred_at,
            reversalTransactionId: m?.reversalTransactionId ?? null,
            replacementTransactionId: m?.replacementTransactionId ?? null,
            reason: m?.reason ?? null,
          };
        }),
      splits: splitRows.flatMap((row, i) => {
        const side = row.transaction_id === o.id ? 'ORIGINAL' : row.transaction_id === replacement ? 'REPLACEMENT' : null;
        const meaning = meanings[i]?.meaning;
        if (side === null || meaning === undefined) return [];
        return [
          {
            sourceId: row.id,
            side,
            taxYear: meaning.taxYear,
            financialCategoryCode: row.code,
            direction: row.direction,
            amount: meaning.amount,
            bookingDate: row.booking_date as BusinessDate,
            propertyReferenceId: row.property_reference_id,
            loanId: row.loan_id,
            ...(row.loan_id === null
              ? {}
              : {
                  loanSets: (sets.get(row.loan_id) ?? []).filter((s) => s.status === 'VALID'),
                  period: periodOfSplit(row.booking_date as BusinessDate, meanings[i]?.classification, loans.get(row.loan_id)),
                }),
          },
        ];
      }),
    };
  });
}
