import { sql, type Transaction } from 'kysely';
import { loanSchedule } from '../../domains/financing/index.js';
import type { CategoryType, Direction, TransactionStatus } from '../../domains/ledger/index.js';
import type { RentDueDay } from '../../domains/rental-contract-reference/index.js';
import { retainedAmountOf, type DepositClosingReason } from '../../domains/security-deposit/index.js';
import {
  TIMING_SOURCES,
  deriveTaxMeaning,
  hausgeldTiming,
  interestTiming,
  needsTiming,
  rentTiming,
  widestWindowDays,
  type AcquisitionFacts,
  type CorrectedOriginal,
  type DepositFacts,
  type RuleRegistry,
  type SplitFacts,
  type TaxClassification,
  type TaxMeaning,
  type TaxYearInputs,
  type TimingInput,
} from '../../domains/taxation/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { readLoanIn } from './loan-repository.js';
import { periodsOf } from './loan-terms-repository.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { UUID, currentOf } from './tax-classification-rows.js';

/**
 * What tax reads of a split and a deposit (§55, §58A): the split's facts, its timing inputs and its meaning; the
 * deposit's facts; the Acquisition a capitalisation names. Shared by the classifications and every read.
 */

export const COUNTED = ['CONFIRMED', 'RECONCILED'];
const RENT_CODES = ['RENT_BASE', 'RENT_OPERATING_COST_ADVANCE', 'RENT_OPERATING_COST_SETTLEMENT'];

interface FactsRow {
  id: string;
  transaction_id: string;
  position: number;
  amount: string;
  currency: string;
  property_reference_id: string | null;
  loan_id: string | null;
  statement_year: number | null;
  code: string;
  category_type: string;
  booking_date: string;
  direction: string;
  status: string;
  correction_role: string | null;
}

/** A split's facts with what its tax year and refund read besides (§58A). */
interface SplitRead {
  readonly facts: SplitFacts;
  readonly loanId: string | null;
  readonly statementYear: number | null;
}

/**
 * A split of the Realm with its category, its Transaction, its Loan and its WEG statement's year, the booking date as
 * `YYYY-MM-DD` and Money as text.
 */
export function factsQuery(trx: Transaction<Database>, mreRealmId: string) {
  return trx
    .selectFrom('transaction_split as s')
    .innerJoin('ledger_transaction as t', 't.id', 's.transaction_id')
    .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
    .leftJoin('weg_annual_statement as st', 'st.id', 's.weg_annual_statement_id')
    .select([
      's.id',
      's.transaction_id',
      's.position',
      sql<string>`s.amount::text`.as('amount'),
      's.currency',
      's.property_reference_id',
      's.loan_id',
      'st.financial_year as statement_year',
      'c.code',
      'c.category_type',
      sql<string>`to_char(t.booking_date, 'YYYY-MM-DD')`.as('booking_date'),
      't.direction',
      't.status',
      't.correction_role',
    ])
    .where('s.mre_realm_id', '=', mreRealmId);
}

/** The meanings of the splits, with their current classifications, corrected originals and tax-year inputs. */
export async function meaningsOf(
  trx: Transaction<Database>,
  registry: RuleRegistry,
  mreRealmId: string,
  reads: readonly SplitRead[],
  today: BusinessDate,
): Promise<{ readonly meaning: TaxMeaning; readonly classification: TaxClassification | null }[]> {
  const facts = reads.map((r) => r.facts);
  const current = await currentOf(
    trx,
    facts.map((f) => f.splitId),
  );
  const originals = await correctedOriginalsOf(trx, facts);
  const timing = await timingOf(trx, mreRealmId, reads, registry);
  return reads.map((r) => {
    const known = timing.get(r.facts.splitId);
    const inputs: TaxYearInputs = { statementYear: r.statementYear, ...(known === undefined ? {} : { timing: known }) };
    const classification = current.get(r.facts.splitId) ?? null;
    return {
      meaning: deriveTaxMeaning(r.facts, classification, originals.get(r.facts.transactionId) ?? null, registry, today, inputs),
      classification,
    };
  });
}

/** The booking dates of the splits that can count in `year` (§58A): the year with the widest window around it. */
export function yearWindow(registry: RuleRegistry, year: number): { readonly from: string; readonly to: string } {
  const days = widestWindowDays(registry);
  return {
    from: days > 0 ? `${year - 1}-12-${String(32 - days).padStart(2, '0')}` : `${year}-01-01`,
    to: days > 0 ? `${year + 1}-01-${String(days).padStart(2, '0')}` : `${year}-12-31`,
  };
}

/** The splits whose current classification overrides their tax year to `year` (§58A). */
export const overriddenTo = (trx: Transaction<Database>, year: number) =>
  trx.selectFrom('tax_classification').select('transaction_split_id').where('superseded_at', 'is', null).where('tax_year', '=', year);

/** Only the splits that count: a current Transaction, not a reversal (§55). */
export const countingSplits = (query: ReturnType<typeof factsQuery>) =>
  query.where('t.status', 'in', COUNTED).where((eb) => eb.or([eb('t.correction_role', 'is', null), eb('t.correction_role', '<>', 'REVERSAL')]));

/** The Acquisition a capitalisation names, of the Realm, read without a lock (§58B: a confirmed one is final); `null`: unknown. */
export async function acquisitionFactsOf(trx: Transaction<Database>, mreRealmId: string, id: string | null): Promise<AcquisitionFacts | null | undefined> {
  if (id === null) return undefined;
  if (!UUID.test(id)) return null;
  const row = await trx
    .selectFrom('acquisition')
    .select(['id', 'property_reference_id', 'status', sql<string>`to_char(coalesce(economic_transfer_date, contract_date), 'YYYY-MM-DD')`.as('transfer_date')])
    .where('id', '=', id)
    .where('mre_realm_id', '=', mreRealmId)
    .executeTakeFirst();
  return row === undefined
    ? null
    : { id: row.id, propertyReferenceId: row.property_reference_id, status: row.status, transferDate: row.transfer_date as BusinessDate };
}

export function toRead(row: FactsRow): SplitRead {
  return {
    facts: {
      splitId: row.id,
      transactionId: row.transaction_id,
      position: row.position,
      bookingDate: row.booking_date as BusinessDate,
      direction: row.direction as Direction,
      amount: fromNumericAmount(row.amount, row.currency),
      financialCategoryCode: row.code,
      categoryType: row.category_type as CategoryType,
      propertyReferenceId: row.property_reference_id,
      transactionStatus: row.status as TransactionStatus,
      correctionRole: row.correction_role as SplitFacts['correctionRole'],
    },
    loanId: row.loan_id,
    statementYear: row.statement_year,
  };
}

/**
 * The economic period and due date of each split the 10-day rule could move (`needsTiming`, §58A's table): rent by
 * its Transaction's `CONFIRMED` reconciliation and the Tenant's RentalContractReference, Hausgeld by the plan of the
 * unit's membership on the booking date, interest by the Loan's schedule. Other splits are not read.
 */
export async function timingOf(
  trx: Transaction<Database>,
  mreRealmId: string,
  reads: readonly SplitRead[],
  registry: RuleRegistry,
): Promise<Map<string, TimingInput>> {
  const found = new Map<string, TimingInput>();
  const needed = reads.filter((r) => needsTiming(registry, r.facts));
  if (needed.length === 0) return found;
  const bySource = (source: string) => needed.filter((r) => TIMING_SOURCES[r.facts.financialCategoryCode] === source);

  const rent = bySource('RENT');
  if (rent.length > 0) {
    const reconciliations = await trx
      .selectFrom('rent_payment_reconciliation')
      .select(['transaction_id', 'mre_tenant_id', 'mre_rent_term'])
      .where('transaction_id', 'in', [...new Set(rent.map((r) => r.facts.transactionId))])
      .where('mre_realm_id', '=', mreRealmId)
      .where('status', '=', 'CONFIRMED')
      .execute();
    const tenants = [...new Set(reconciliations.map((r) => r.mre_tenant_id))];
    const references =
      tenants.length === 0
        ? []
        : await trx
            .selectFrom('rental_contract_reference')
            .select(['mre_tenant_id', 'rent_due_days'])
            .where('mre_realm_id', '=', mreRealmId)
            .where('mre_tenant_id', 'in', tenants)
            .execute();
    const dueDays = new Map(references.map((r) => [r.mre_tenant_id, r.rent_due_days as RentDueDay[]]));
    for (const r of rent) {
      const terms = new Map(
        reconciliations.filter((c) => c.transaction_id === r.facts.transactionId).map((c) => [`${c.mre_tenant_id}/${c.mre_rent_term}`, c] as const),
      );
      const [only] = terms.values();
      if (only === undefined) found.set(r.facts.splitId, { kind: 'NO_ECONOMIC_PERIOD', reason: 'NO_RECONCILIATION' });
      else if (terms.size > 1) found.set(r.facts.splitId, { kind: 'NO_ECONOMIC_PERIOD', reason: 'SEVERAL_TERMS' });
      else found.set(r.facts.splitId, rentTiming(only.mre_rent_term, dueDays.get(only.mre_tenant_id) ?? null));
    }
  }

  for (const r of bySource('HAUSGELD')) {
    const unit = r.facts.propertyReferenceId;
    const plan =
      unit === null
        ? undefined
        : await trx
            .selectFrom('weg_membership as m')
            .innerJoin('weg_economic_plan as p', 'p.membership_id', 'm.id')
            .select('p.advance_due_day')
            .where('m.property_reference_id', '=', unit)
            .where('m.mre_realm_id', '=', mreRealmId)
            .where('m.status', '=', 'ACTIVE')
            .where('m.valid_from', '<=', r.facts.bookingDate)
            .where((eb) => eb.or([eb('m.valid_until', 'is', null), eb('m.valid_until', '>=', r.facts.bookingDate)]))
            .where('p.status', '=', 'ACTIVE')
            .where('p.effective_from', '<=', r.facts.bookingDate)
            .orderBy('p.effective_from', 'desc')
            .limit(1)
            .executeTakeFirst();
    found.set(
      r.facts.splitId,
      plan === undefined ? { kind: 'NO_ECONOMIC_PERIOD', reason: 'NO_ECONOMIC_PLAN' } : hausgeldTiming(r.facts.bookingDate, plan.advance_due_day),
    );
  }

  for (const r of bySource('LOAN_SCHEDULE')) {
    const loan = r.loanId === null ? undefined : await readLoanIn(trx, r.loanId, mreRealmId);
    if (loan === undefined) {
      found.set(r.facts.splitId, { kind: 'NO_ECONOMIC_PERIOD', reason: 'NO_LOAN' });
      continue;
    }
    const periods = (await periodsOf(trx, loan.id)).filter((t) => t.status === 'VALID');
    const schedule = loanSchedule(loan, periods);
    found.set(
      r.facts.splitId,
      interestTiming(
        r.facts.bookingDate,
        schedule.entries.map((e) => e.paymentDate),
      ),
    );
  }
  return found;
}

/** Deposits of the Realm as tax reads them, in the order of `ids`; unknown ids are left out. */
export async function depositFactsOf(trx: Transaction<Database>, mreRealmId: string, ids: readonly string[]): Promise<DepositFacts[]> {
  if (ids.length === 0) return [];
  const rows = await trx
    .selectFrom('security_deposit')
    .select([
      'id',
      'status',
      'mre_tenant_id',
      'currency',
      'closing_reason',
      'closing_note',
      sql<string | null>`to_char(closing_date, 'YYYY-MM-DD')`.as('closing_date'),
      sql<string | null>`held_at_closing::text`.as('held_at_closing'),
    ])
    .where('id', 'in', [...ids])
    .where('mre_realm_id', '=', mreRealmId)
    .execute();
  const tenants = [...new Set(rows.map((r) => r.mre_tenant_id))];
  // The deposit's PropertyReference: the one its Tenant's confirmed rent is booked on (§58A); none, or several, is null.
  const units =
    tenants.length === 0
      ? []
      : await trx
          .selectFrom('rent_payment_reconciliation as r')
          .innerJoin('transaction_split as s', 's.transaction_id', 'r.transaction_id')
          .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
          .select(['r.mre_tenant_id', 's.property_reference_id'])
          .distinct()
          .where('r.mre_realm_id', '=', mreRealmId)
          .where('r.mre_tenant_id', 'in', tenants)
          .where('r.status', '=', 'CONFIRMED')
          .where('c.code', 'in', RENT_CODES)
          .where('s.property_reference_id', 'is not', null)
          .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (row === undefined) return [];
    const ofTenant = [...new Set(units.filter((u) => u.mre_tenant_id === row.mre_tenant_id).map((u) => u.property_reference_id as string))].sort();
    const retainedAmount =
      row.closing_reason === null || row.closing_date === null || row.held_at_closing === null
        ? Money.zero(row.currency)
        : retainedAmountOf({
            closingDate: row.closing_date as BusinessDate,
            reason: row.closing_reason as DepositClosingReason,
            closingNote: row.closing_note,
            heldAtClosing: fromNumericAmount(row.held_at_closing, row.currency),
          });
    return [
      {
        securityDepositId: row.id,
        status: row.status,
        closingDate: row.closing_date as BusinessDate | null,
        retainedAmount,
        propertyReferenceId: ofTenant.length === 1 ? (ofTenant[0] ?? null) : null,
        propertyCandidates: ofTenant,
      },
    ];
  });
}

/** For each replacement among the splits' Transactions: its original and the current classifications of its splits (P7-D2). */
async function correctedOriginalsOf(trx: Transaction<Database>, facts: readonly SplitFacts[]): Promise<Map<string, CorrectedOriginal>> {
  const replacements = [...new Set(facts.filter((f) => f.correctionRole === 'REPLACEMENT').map((f) => f.transactionId))];
  if (replacements.length === 0) return new Map();
  const rows = await trx
    .selectFrom('ledger_transaction as r')
    .innerJoin('transaction_split as os', 'os.transaction_id', 'r.correction_of_transaction_id')
    .innerJoin('tax_classification as c', (join) => join.onRef('c.transaction_split_id', '=', 'os.id').on('c.superseded_at', 'is', null))
    .select(['r.id as replacement_id', 'r.correction_of_transaction_id as original_id', 'c.id as classification_id'])
    .where('r.id', 'in', replacements)
    .execute();
  const found = new Map<string, CorrectedOriginal>();
  for (const r of rows) {
    const seen = found.get(r.replacement_id);
    found.set(r.replacement_id, {
      originalTransactionId: r.original_id as string,
      classificationIds: [...(seen?.classificationIds ?? []), r.classification_id],
    });
  }
  return found;
}
