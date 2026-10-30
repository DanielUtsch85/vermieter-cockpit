import type { Kysely, Transaction as Trx } from 'kysely';
import {
  checkVersion,
  checkWegSplits,
  planAmend,
  planIgnore,
  planRestore,
  type AmendOutcome,
  type IgnoreOutcome,
  type RestoreOutcome,
  type Transaction,
  type TransactionChanges,
  type UnconfirmedTransactionRepository,
} from '../../domains/ledger/index.js';
import type { AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { toFinancialAccount } from './financial-account-repository.js';
import { lockLoansOf } from './loan-repository.js';
import { unitsWithMembershipOn } from './weg-repository.js';
import { toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { COLUMNS, UUID, toDomain } from './transaction-repository.js';

const ENTITY_TYPE = 'Transaction';

/** Thrown inside the transaction to roll back every write together. */
class Rejected extends Error {
  constructor(readonly outcome: Exclude<AmendOutcome, { kind: 'AMENDED' }>) {
    super(outcome.kind);
  }
}

/**
 * PostgreSQL implementation of amend / ignore / restore (api-design.md §31.3–31.4). Each command locks the
 * Transaction `FOR UPDATE` — the lock split replacement, confirm and correct take — and reads it afterwards in a
 * new statement, so a command that waited sees what the other one committed.
 */
export class PostgresUnconfirmedTransactionRepository implements UnconfirmedTransactionRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async amend(id: string, mreRealmId: string, changes: TransactionChanges, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<AmendOutcome> => {
          const transaction = await lockAndRead(trx, id, mreRealmId);
          if (transaction === undefined) return { kind: 'NOT_FOUND' };
          const plan = planAmend(transaction, changes);
          if (plan.kind === 'UNCHANGED') return { kind: 'AMENDED', transaction, changed: false, splitsDropped: false };
          if (plan.kind !== 'AMEND') return plan;
          const conflict = checkVersion(transaction.version, expectedVersions);
          if (conflict !== undefined) return conflict;
          const { values } = plan;

          if (plan.changed.includes('financialAccountId') || plan.changed.includes('amount')) {
            await checkAccount(trx, mreRealmId, transaction, values.financialAccountId, values.amount.currency);
          }
          if (plan.changed.includes('propertyReferenceId') && values.propertyReferenceId !== null) {
            const found = UUID.test(values.propertyReferenceId)
              ? await trx
                  .selectFrom('property_reference')
                  .select('id')
                  .where('id', '=', values.propertyReferenceId)
                  .where('mre_realm_id', '=', mreRealmId)
                  .executeTakeFirst()
              : undefined;
            if (found === undefined) throw new Rejected({ kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceId: values.propertyReferenceId });
          }

          if (plan.dropSplits) await trx.deleteFrom('transaction_split').where('transaction_id', '=', id).execute();
          else if (plan.changed.includes('bookingDate')) {
            // §41.7: after the Transaction lock, the Loans its splits name in id order (P3-D8); none may be closed before the new date.
            const named = await trx
              .selectFrom('transaction_split')
              .select('loan_id')
              .where('transaction_id', '=', id)
              .where('loan_id', 'is not', null)
              .execute();
            const loans = await lockLoansOf(
              trx,
              mreRealmId,
              named.map((n) => n.loan_id as string),
            );
            for (const [loanId, loan] of loans) {
              if (loan.status === 'CLOSED' && loan.closingDate !== null && values.bookingDate > loan.closingDate) {
                throw new Rejected({ kind: 'LOAN_CLOSED', loanId, closingDate: loan.closingDate });
              }
            }
            // §49.3: the kept WEG splits need their unit's membership on the new date (review on #147); then the units
            // (Transaction → PropertyReference). ledger_transaction_weg_booking_date is the backstop.
            const kept = await trx
              .selectFrom('transaction_split')
              .innerJoin('financial_category', 'financial_category.id', 'transaction_split.financial_category_id')
              .select([
                'financial_category.code as financialCategoryCode',
                'transaction_split.property_reference_id as propertyReferenceId',
                'transaction_split.weg_annual_statement_id as wegAnnualStatementId',
              ])
              .where('transaction_split.transaction_id', '=', id)
              .orderBy('transaction_split.position')
              .execute();
            const splits = kept.map((k) => ({ ...k, amount: values.amount, loanId: null, securityDepositId: null, description: null }));
            const wegRefusal = checkWegSplits(
              { reversal: transaction.correctionRole === 'REVERSAL', bookingDate: values.bookingDate },
              splits,
              await unitsWithMembershipOn(trx, mreRealmId, splits, values.bookingDate),
            );
            if (wegRefusal !== undefined) throw new Rejected(wegRefusal);
          }
          const updated = await trx
            .updateTable('ledger_transaction')
            .set((eb) => ({
              financial_account_id: values.financialAccountId,
              amount: toNumericAmount(values.amount),
              currency: values.amount.currency,
              direction: values.direction,
              booking_date: values.bookingDate,
              value_date: values.valueDate,
              description: values.description,
              property_reference_id: values.propertyReferenceId,
              status: plan.nextStatus,
              version: eb('version', '+', 1),
              updated_at: new Date(),
            }))
            .where('id', '=', id)
            .returning(COLUMNS)
            .executeTakeFirstOrThrow();
          const amended = toDomain(updated);
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'AMENDED', actor, {
            previousVersion: transaction.version,
            newVersion: amended.version,
            metadata: {
              changes: Object.fromEntries(plan.changed.map((field) => [field, { from: json(transaction[field]), to: json(amended[field]) }])),
              ...(plan.dropSplits ? { splitsDropped: true, previousStatus: transaction.status, status: amended.status } : {}),
            },
          });
          return { kind: 'AMENDED', transaction: amended, changed: true, splitsDropped: plan.dropSplits };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  ignore(id: string, mreRealmId: string, reason: string, actor: AuditActor, expectedVersions?: readonly number[]): Promise<IgnoreOutcome> {
    if (!UUID.test(id)) return Promise.resolve({ kind: 'NOT_FOUND' });
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<IgnoreOutcome> => {
        const transaction = await lockAndRead(trx, id, mreRealmId);
        if (transaction === undefined) return { kind: 'NOT_FOUND' };
        const plan = planIgnore(transaction.status);
        if (plan.kind === 'ALREADY_IGNORED') return { kind: 'IGNORED', transaction, replayed: true };
        if (plan.kind === 'NOT_IGNORABLE') return plan;
        const conflict = checkVersion(transaction.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        const ignored = toDomain(await setStatus(trx, id, 'IGNORED'));
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'IGNORED', actor, {
          previousVersion: transaction.version,
          newVersion: ignored.version,
          metadata: { reason, previousStatus: transaction.status },
        });
        return { kind: 'IGNORED', transaction: ignored, replayed: false };
      });
  }

  restore(id: string, mreRealmId: string, actor: AuditActor, expectedVersions?: readonly number[]): Promise<RestoreOutcome> {
    if (!UUID.test(id)) return Promise.resolve({ kind: 'NOT_FOUND' });
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<RestoreOutcome> => {
        const transaction = await lockAndRead(trx, id, mreRealmId);
        if (transaction === undefined) return { kind: 'NOT_FOUND' };
        const split = await trx.selectFrom('transaction_split').select('id').where('transaction_id', '=', id).limit(1).executeTakeFirst();
        const plan = planRestore(transaction, split !== undefined);
        if (plan.kind === 'NOT_IGNORED') return plan;
        const conflict = checkVersion(transaction.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        const restored = toDomain(await setStatus(trx, id, plan.nextStatus));
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'RESTORED', actor, {
          previousVersion: transaction.version,
          newVersion: restored.version,
          metadata: { status: restored.status },
        });
        return { kind: 'RESTORED', transaction: restored };
      });
  }
}

/** Locks the row, then reads it in a new statement (sees a concurrent writer's committed result under READ COMMITTED). */
async function lockAndRead(trx: Trx<Database>, id: string, mreRealmId: string): Promise<Transaction | undefined> {
  const locked = await trx
    .selectFrom('ledger_transaction')
    .select('id')
    .where('id', '=', id)
    .where('mre_realm_id', '=', mreRealmId)
    .forUpdate()
    .executeTakeFirst();
  if (locked === undefined) return undefined;
  return toDomain(await trx.selectFrom('ledger_transaction').select(COLUMNS).where('id', '=', locked.id).executeTakeFirstOrThrow());
}

function setStatus(trx: Trx<Database>, id: string, status: string) {
  return trx
    .updateTable('ledger_transaction')
    .set((eb) => ({ status, version: eb('version', '+', 1), updated_at: new Date() }))
    .where('id', '=', id)
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
}

/**
 * The target account `FOR SHARE` (a concurrent close waits): in the Realm, open unless it is the Transaction's own
 * account (§31.3, as §35.2), and in the amount's currency (no FX, data-model §17.7).
 */
async function checkAccount(trx: Trx<Database>, mreRealmId: string, transaction: Transaction, accountId: string, currency: string): Promise<void> {
  const row = UUID.test(accountId)
    ? await trx.selectFrom('financial_account').selectAll().where('id', '=', accountId).where('mre_realm_id', '=', mreRealmId).forShare().executeTakeFirst()
    : undefined;
  if (row === undefined) throw new Rejected({ kind: 'ACCOUNT_NOT_FOUND', financialAccountId: accountId });
  const account = toFinancialAccount(row);
  if (account.id !== transaction.financialAccountId && account.status === 'CLOSED') {
    throw new Rejected({ kind: 'ACCOUNT_CLOSED', financialAccountId: account.id });
  }
  if (account.currency !== currency) throw new Rejected({ kind: 'CURRENCY_MISMATCH' });
}

/** A field value as it is written to the AuditRecord. */
function json(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'toJSON' in value ? (value as { toJSON(): unknown }).toJSON() : value;
}
