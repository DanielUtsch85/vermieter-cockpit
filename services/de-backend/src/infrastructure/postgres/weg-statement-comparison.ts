import { sql, type Kysely, type Transaction } from 'kysely';
import {
  viewStatement,
  type AnnualStatement,
  type ComparisonContext,
  type SettlementContext,
  type WegCategory,
  CLASS_OF_CATEGORY,
  meaFromColumns,
} from '../../domains/weg/index.js';
import type { SplitStatement } from '../../domains/ledger/index.js';
import type { BusinessDate } from '../../shared/index.js';
import { fromNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { COLUMNS, UUID, toStatement } from './weg-statement-rows.js';

/** A statement against the unit's WEG payments (api-design.md §51): the comparison, a settlement's context, and the statements a split set names. */

export async function comparisonContext(db: Kysely<Database>, statementId: string, mreRealmId: string): Promise<ComparisonContext> {
  if (!UUID.test(statementId)) return { kind: 'NOT_FOUND' };
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const row = await trx
        .selectFrom('weg_annual_statement')
        .select(COLUMNS)
        .where('id', '=', statementId)
        .where('mre_realm_id', '=', mreRealmId)
        .executeTakeFirst();
      if (row === undefined) return { kind: 'NOT_FOUND' };
      if (row.status !== 'CONFIRMED' && row.status !== 'SUPERSEDED') return { kind: 'STATEMENT_NOT_CONFIRMED', status: row.status };
      return comparisonOf(trx, await toStatement(trx, row));
    });
}

export async function settlementContext(db: Kysely<Database>, transactionId: string, statementId: string, mreRealmId: string): Promise<SettlementContext> {
  if (!UUID.test(transactionId)) return { kind: 'TRANSACTION_NOT_FOUND' };
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx): Promise<SettlementContext> => {
      const tx = await trx
        .selectFrom('ledger_transaction')
        .select(['id', 'amount', 'currency', 'direction', 'status'])
        .where('id', '=', transactionId)
        .where('mre_realm_id', '=', mreRealmId)
        .executeTakeFirst();
      if (tx === undefined) return { kind: 'TRANSACTION_NOT_FOUND' };
      const row = UUID.test(statementId)
        ? await trx.selectFrom('weg_annual_statement').select(COLUMNS).where('id', '=', statementId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst()
        : undefined;
      if (row === undefined) return { kind: 'STATEMENT_NOT_FOUND' };
      if (!UNCONFIRMED.includes(tx.status)) return { kind: 'NOT_PROPOSABLE', status: tx.status };
      if (row.status !== 'CONFIRMED') return { kind: 'STATEMENT_NOT_CURRENT', status: row.status, supersededBy: row.superseded_by_id };
      const split = await trx.selectFrom('transaction_split').select('id').where('transaction_id', '=', tx.id).executeTakeFirst();
      return {
        kind: 'FOUND',
        transactionId: tx.id,
        amount: fromNumericAmount(tx.amount, tx.currency),
        direction: tx.direction as 'INFLOW' | 'OUTFLOW',
        alreadySplit: split !== undefined,
        comparison: await comparisonOf(trx, await toStatement(trx, row)),
      };
    });
}

/**
 * The statements named by a split set (§51), each **written** with P3-D8's no-op in id order after the Transaction and
 * the units (Transaction → PropertyReference → statement), with their status, unit and successor; foreign or unknown
 * ones are left out.
 */
export async function lockStatementsOf(trx: Transaction<Database>, mreRealmId: string, ids: readonly string[]): Promise<Map<string, SplitStatement>> {
  const found = new Map<string, SplitStatement>();
  for (const id of [...new Set(ids)].filter((i) => UUID.test(i)).sort()) {
    const row = await trx
      .updateTable('weg_annual_statement')
      .set((eb) => ({ version: eb.ref('version') }))
      .where('id', '=', id)
      .where('mre_realm_id', '=', mreRealmId)
      .returning(['status', 'membership_id', 'superseded_by_id'])
      .executeTakeFirst();
    if (row === undefined) continue;
    const membership = await trx.selectFrom('weg_membership').select('property_reference_id').where('id', '=', row.membership_id).executeTakeFirstOrThrow();
    found.set(id, { status: row.status, propertyReferenceId: membership.property_reference_id, supersededBy: row.superseded_by_id });
  }
  return found;
}

const UNCONFIRMED = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'];
const COUNTED = ['CONFIRMED', 'RECONCILED'];

/** The signed amount of a split: an `OUTFLOW` positive, an `INFLOW` negative (§51). */
const signed = (amount: string, currency: string, direction: string) => {
  const money = fromNumericAmount(amount, currency);
  return direction === 'INFLOW' ? money.negate() : money;
};

/**
 * §51's inputs for a statement, in the caller's snapshot: the chain (the statement and those it supersedes,
 * transitively), the unit's counted WEG splits in the period that name no statement, the current settlements naming
 * the chain, and the uncounted WEG splits in the period.
 */
async function comparisonOf(trx: Transaction<Database>, statement: AnnualStatement): Promise<Extract<ComparisonContext, { kind: 'FOUND' }>> {
  const membership = await trx
    .selectFrom('weg_membership')
    .select(['property_reference_id', sql<string>`mea_numerator::text`.as('mea_numerator'), sql<string>`mea_denominator::text`.as('mea_denominator')])
    .where('id', '=', statement.membershipId)
    .executeTakeFirstOrThrow();
  const chain = [statement.id as string];
  for (let next = statement.supersedes; next !== null; ) {
    chain.push(next);
    const predecessor = await trx.selectFrom('weg_annual_statement').select('supersedes_id').where('id', '=', next).executeTakeFirstOrThrow();
    next = predecessor.supersedes_id;
  }
  const unit = membership.property_reference_id;
  const wegSplits = () =>
    trx
      .selectFrom('transaction_split as s')
      .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
      .innerJoin('ledger_transaction as t', 't.id', 's.transaction_id')
      .select([
        't.id as transaction_id',
        sql<string>`to_char(t.booking_date, 'YYYY-MM-DD')`.as('booking_date'),
        't.direction',
        't.status',
        's.amount',
        's.currency',
        'c.code',
        's.weg_annual_statement_id',
      ])
      .where('s.property_reference_id', '=', unit)
      .where('c.code', 'in', Object.keys(CLASS_OF_CATEGORY))
      .where((eb) => eb.or([eb('t.correction_role', 'is', null), eb('t.correction_role', '<>', 'REVERSAL')]));
  const inPeriod = await wegSplits().where('t.booking_date', '>=', statement.periodFrom).where('t.booking_date', '<=', statement.periodUntil).execute();
  const settlements = await wegSplits().where('s.weg_annual_statement_id', 'in', chain).where('t.status', 'in', COUNTED).execute();
  return {
    kind: 'FOUND',
    statement: viewStatement(statement),
    propertyReferenceId: unit,
    mea: meaFromColumns(membership.mea_numerator, membership.mea_denominator),
    advances: inPeriod
      .filter((r) => COUNTED.includes(r.status) && r.weg_annual_statement_id === null)
      .map((r) => ({
        transactionId: r.transaction_id,
        bookingDate: r.booking_date as BusinessDate,
        category: r.code as WegCategory,
        amount: signed(r.amount, r.currency, r.direction),
      })),
    settlements: settlements.map((r) => ({
      transactionId: r.transaction_id,
      statementId: r.weg_annual_statement_id as string,
      bookingDate: r.booking_date as BusinessDate,
      amount: signed(r.amount, r.currency, r.direction),
    })),
    uncountedTransactionIds: inPeriod.filter((r) => UNCONFIRMED.includes(r.status)).map((r) => r.transaction_id),
  };
}
