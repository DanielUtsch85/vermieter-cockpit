import type { Kysely, Transaction as Trx } from 'kysely';
import {
  planSplits,
  sameSplits,
  type Direction,
  type ReplaceSplitsOutcome,
  type SplitInput,
  type SplitTransaction,
  type TransactionId,
  type TransactionSplit,
  type TransactionSplitRepository,
  type TransactionStatus,
} from '../../domains/ledger/index.js';
import type { AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PostgreSQL implementation of the split port. The Transaction row is locked
 * `FOR UPDATE`, so a concurrent replacement (or, later, a confirm) waits and
 * then sees the new state; the split set is replaced as a whole (delete +
 * insert) in the same database transaction.
 */
export class PostgresTransactionSplitRepository implements TransactionSplitRepository {
  constructor(private readonly db: Kysely<Database>) {}

  replaceSplits(
    transactionId: string,
    mreRealmId: string,
    splits: readonly SplitInput[],
    actor: AuditActor,
  ): Promise<ReplaceSplitsOutcome> {
    if (!UUID.test(transactionId)) return Promise.resolve({ kind: 'NOT_FOUND' });
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<ReplaceSplitsOutcome> => {
        const row = await trx
          .selectFrom('ledger_transaction')
          .select(['id', 'amount', 'currency', 'direction', 'status', 'version'])
          .where('id', '=', transactionId)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const transaction: SplitTransaction = {
          id: row.id as TransactionId,
          amount: fromNumericAmount(row.amount, row.currency),
          direction: row.direction as Direction,
          status: row.status as TransactionStatus,
          version: row.version,
        };

        const current = await currentSplits(trx, transaction.id);
        // Repeating the current set is a no-op even once frozen: naturally idempotent (§33.1).
        if (sameSplits(current, splits)) return { kind: 'REPLACED', transaction, splits: current, changed: false };

        const plan = planSplits(transaction, splits);
        if (plan.kind !== 'APPLY') return plan;

        const codes = [...new Set(splits.map((s) => s.financialCategoryCode))];
        const categories = await trx
          .selectFrom('financial_category')
          .select(['id', 'code'])
          .where('code', 'in', codes)
          .where('active', '=', true)
          .execute();
        const categoryIds = new Map(categories.map((c) => [c.code, c.id]));
        const unknown = codes.filter((c) => !categoryIds.has(c));
        if (unknown.length > 0) return { kind: 'UNKNOWN_CATEGORY', codes: unknown };

        const references = [...new Set(splits.flatMap((s) => (s.propertyReferenceId === null ? [] : [s.propertyReferenceId])))];
        if (references.length > 0) {
          const invalid = references.filter((id) => !UUID.test(id));
          const found =
            invalid.length === references.length
              ? []
              : await trx
                  .selectFrom('property_reference')
                  .select('id')
                  .where(
                    'id',
                    'in',
                    references.filter((id) => UUID.test(id)),
                  )
                  .where('mre_realm_id', '=', mreRealmId)
                  .execute();
          const missing = references.filter((id) => !found.some((f) => f.id === id));
          if (missing.length > 0) return { kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceIds: missing };
        }

        await trx.deleteFrom('transaction_split').where('transaction_id', '=', transaction.id).execute();
        const inserted = await trx
          .insertInto('transaction_split')
          .values(
            splits.map((split, i) => ({
              transaction_id: transaction.id,
              mre_realm_id: mreRealmId,
              position: i + 1,
              amount: toNumericAmount(split.amount),
              currency: split.amount.currency,
              financial_category_id: categoryIds.get(split.financialCategoryCode) as string,
              property_reference_id: split.propertyReferenceId,
              description: split.description,
              created_by: actor.actorId,
            })),
          )
          .returning(['id', 'position'])
          .execute();
        const ids = new Map(inserted.map((r) => [r.position, r.id]));

        const updated = await trx
          .updateTable('ledger_transaction')
          .set((eb) => ({ status: plan.nextStatus, version: eb('version', '+', 1), updated_at: new Date() }))
          .where('id', '=', transaction.id)
          .returning(['status', 'version'])
          .executeTakeFirstOrThrow();
        await writeAudit(trx, { type: 'Transaction', id: transaction.id }, 'SPLITS_REPLACED', actor, {
          previousVersion: transaction.version,
          newVersion: updated.version,
          metadata: {
            previousStatus: transaction.status,
            status: updated.status,
            splits: splits.map((s) => ({
              amount: s.amount.toJSON(),
              financialCategoryCode: s.financialCategoryCode,
              ...(s.propertyReferenceId === null ? {} : { propertyReferenceId: s.propertyReferenceId }),
            })),
          },
        });
        return {
          kind: 'REPLACED',
          transaction: { ...transaction, status: updated.status as TransactionStatus, version: updated.version },
          splits: splits.map((split, i) => ({ ...split, id: ids.get(i + 1) as string, position: i + 1 })),
          changed: true,
        };
      });
  }
}

async function currentSplits(trx: Trx<Database>, transactionId: string): Promise<TransactionSplit[]> {
  const rows = await trx
    .selectFrom('transaction_split')
    .innerJoin('financial_category', 'financial_category.id', 'transaction_split.financial_category_id')
    .select([
      'transaction_split.id',
      'transaction_split.position',
      'transaction_split.amount',
      'transaction_split.currency',
      'transaction_split.property_reference_id',
      'transaction_split.description',
      'financial_category.code',
    ])
    .where('transaction_split.transaction_id', '=', transactionId)
    .orderBy('transaction_split.position')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    position: r.position,
    amount: fromNumericAmount(r.amount, r.currency),
    financialCategoryCode: r.code,
    propertyReferenceId: r.property_reference_id,
    description: r.description,
  }));
}
