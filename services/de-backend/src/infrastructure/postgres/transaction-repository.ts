import { sql, type Kysely, type Transaction as Trx } from 'kysely';
import {
  checkPosting,
  planConfirm,
  type ConfirmOutcome,
  type CorrectionRole,
  type BusinessDate,
  type CreateTransactionOutcome,
  type Direction,
  type FinancialAccountId,
  type NewManualTransaction,
  type PostingRejection,
  type Provenance,
  type Transaction,
  type TransactionId,
  type TransactionRepository,
  type TransactionStatus,
} from '../../domains/ledger/index.js';
import type { AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { toFinancialAccount } from './financial-account-repository.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'Transaction';
const CREATE_SCOPE = 'transaction.create-manual';

/** Thrown inside the transaction to roll back claim and checks together. */
class Rejected extends Error {
  constructor(readonly reason: PostingRejection) {
    super(reason);
  }
}

/**
 * Columns of a ledger_transaction row; dates as `YYYY-MM-DD` text, independent of DateStyle. The reverse links of a
 * corrected original are subqueries, so they also work in `RETURNING` (they see the transaction's earlier writes).
 */
export const COLUMNS = [
  'id',
  'mre_realm_id',
  'financial_account_id',
  'amount',
  'currency',
  'direction',
  sql<string>`to_char(booking_date, 'YYYY-MM-DD')`.as('booking_date'),
  sql<string | null>`to_char(value_date, 'YYYY-MM-DD')`.as('value_date'),
  'description',
  'property_reference_id',
  'provenance',
  'status',
  'created_at',
  'version',
  'confirmed_at',
  'confirmed_by',
  'correction_of_transaction_id',
  'correction_role',
  correctionLink('REVERSAL').as('reversal_transaction_id'),
  correctionLink('REPLACEMENT').as('replacement_transaction_id'),
] as const;

function correctionLink(role: CorrectionRole) {
  return sql<string | null>`(SELECT c.id FROM ledger_transaction c
    WHERE c.correction_of_transaction_id = ledger_transaction.id AND c.correction_role = ${role})`;
}

export interface Row {
  id: string;
  mre_realm_id: string;
  financial_account_id: string;
  amount: string;
  currency: string;
  direction: string;
  booking_date: string;
  value_date: string | null;
  description: string | null;
  property_reference_id: string | null;
  provenance: string;
  status: string;
  created_at: Date;
  version: number;
  confirmed_at: Date | null;
  confirmed_by: string | null;
  correction_of_transaction_id: string | null;
  correction_role: string | null;
  reversal_transaction_id: string | null;
  replacement_transaction_id: string | null;
}

/** PostgreSQL implementation of the Transaction persistence port. */
export class PostgresTransactionRepository implements TransactionRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createManual(
    transaction: NewManualTransaction,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateTransactionOutcome> {
    try {
      // READ COMMITTED explicitly: the idempotency claim relies on it (idempotency.ts).
      return await this.db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
        const keyed =
          idempotency === undefined
            ? undefined
            : {
                ref: { mreRealmId: transaction.mreRealmId, scope: CREATE_SCOPE, key: idempotency.key },
                fingerprint: idempotency.fingerprint,
              };
        if (keyed !== undefined) {
          const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
          if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
          // Before any check: a replay answers as the first request did, even if the account closed since.
          if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', transaction: fromSnapshot(claim.result) };
        }

        await this.assertPostable(trx, transaction);
        const inserted = (await trx
          .insertInto('ledger_transaction')
          .values({
            mre_realm_id: transaction.mreRealmId,
            financial_account_id: transaction.financialAccountId,
            amount: toNumericAmount(transaction.amount),
            currency: transaction.amount.currency,
            direction: transaction.direction,
            booking_date: transaction.bookingDate,
            value_date: transaction.valueDate,
            description: transaction.description,
            property_reference_id: transaction.propertyReferenceId,
            provenance: 'MANUAL' satisfies Provenance,
            status: 'UNREVIEWED' satisfies TransactionStatus,
            created_by: actor.actorId,
          })
          .returning(COLUMNS)
          .executeTakeFirstOrThrow()) as Row;

        const created = toDomain(inserted);
        if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, created.id, toSnapshot(created));
        await writeAudit(trx, { type: ENTITY_TYPE, id: created.id }, 'CREATED', actor, {
          newVersion: created.version,
          metadata: { provenance: created.provenance, financialAccountId: created.financialAccountId },
        });
        return { kind: 'CREATED', transaction: created };
      });
    } catch (error) {
      if (error instanceof Rejected) return { kind: 'REJECTED', reason: error.reason };
      throw error;
    }
  }

  /** Locks the account FOR SHARE, so a concurrent close waits until this Transaction is committed or rolled back. */
  private async assertPostable(trx: Trx<Database>, transaction: NewManualTransaction): Promise<void> {
    const accountRow = UUID.test(transaction.financialAccountId)
      ? await trx
          .selectFrom('financial_account')
          .selectAll()
          .where('id', '=', transaction.financialAccountId)
          .where('mre_realm_id', '=', transaction.mreRealmId)
          .forShare()
          .executeTakeFirst()
      : undefined;
    const rejection = checkPosting(accountRow === undefined ? undefined : toFinancialAccount(accountRow), transaction);
    if (rejection !== undefined) throw new Rejected(rejection);

    if (transaction.propertyReferenceId !== null) {
      const reference = UUID.test(transaction.propertyReferenceId)
        ? await trx
            .selectFrom('property_reference')
            .select('id')
            .where('id', '=', transaction.propertyReferenceId)
            .where('mre_realm_id', '=', transaction.mreRealmId)
            .executeTakeFirst()
        : undefined;
      if (reference === undefined) throw new Rejected('PROPERTY_REFERENCE_NOT_FOUND');
    }
  }

  confirm(id: string, mreRealmId: string, actor: AuditActor): Promise<ConfirmOutcome> {
    if (!UUID.test(id)) return Promise.resolve({ kind: 'NOT_FOUND' });
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<ConfirmOutcome> => {
        // The same lock a split replacement takes: confirm and replace serialize.
        const row = await trx
          .selectFrom('ledger_transaction')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const transaction = toDomain(row);
        const splits = await trx
          .selectFrom('transaction_split')
          .innerJoin('financial_category', 'financial_category.id', 'transaction_split.financial_category_id')
          .select(['transaction_split.amount', 'transaction_split.currency', 'financial_category.code', 'financial_category.active'])
          .where('transaction_split.transaction_id', '=', id)
          .execute();
        const plan = planConfirm(
          transaction,
          splits.map((s) => ({ amount: fromNumericAmount(s.amount, s.currency), financialCategoryCode: s.code, categoryActive: s.active })),
        );
        switch (plan.kind) {
          case 'ALREADY_CONFIRMED':
            return { kind: 'CONFIRMED', transaction, replayed: true };
          case 'CONFIRM':
            break;
          default:
            return plan;
        }
        const confirmed = await trx
          .updateTable('ledger_transaction')
          .set((eb) => ({
            status: 'CONFIRMED',
            confirmed_at: new Date(),
            confirmed_by: actor.actorId,
            version: eb('version', '+', 1),
            updated_at: new Date(),
          }))
          .where('id', '=', id)
          .returning(COLUMNS)
          .executeTakeFirstOrThrow();
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CONFIRMED', actor, {
          previousVersion: transaction.version,
          newVersion: confirmed.version,
          metadata: { previousStatus: transaction.status, amount: transaction.amount.toJSON(), direction: transaction.direction },
        });
        return { kind: 'CONFIRMED', transaction: toDomain(confirmed), replayed: false };
      });
  }
}

export function toDomain(row: Row): Transaction {
  return {
    id: row.id as TransactionId,
    mreRealmId: row.mre_realm_id,
    financialAccountId: row.financial_account_id as FinancialAccountId,
    amount: fromNumericAmount(row.amount, row.currency),
    direction: row.direction as Direction,
    bookingDate: row.booking_date as BusinessDate,
    valueDate: row.value_date as BusinessDate | null,
    description: row.description,
    propertyReferenceId: row.property_reference_id,
    provenance: row.provenance as Provenance,
    status: row.status as TransactionStatus,
    createdAt: row.created_at,
    version: row.version,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    correctionOfTransactionId: row.correction_of_transaction_id as TransactionId | null,
    correctionRole: row.correction_role as CorrectionRole | null,
    reversalTransactionId: row.reversal_transaction_id as TransactionId | null,
    replacementTransactionId: row.replacement_transaction_id as TransactionId | null,
  };
}

/** A Transaction as JSON for the idempotency store (Money as its JSON form, dates as text). */
export function toSnapshot(transaction: Transaction): Record<string, unknown> {
  return {
    ...transaction,
    amount: transaction.amount.toJSON(),
    createdAt: transaction.createdAt.toISOString(),
    confirmedAt: transaction.confirmedAt?.toISOString() ?? null,
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted; Money is re-validated. */
export function fromSnapshot(result: unknown): Transaction {
  const s = result as Record<string, unknown> & { amount: { amount: string; currency: string }; createdAt: string };
  return toDomain({
    id: s['id'] as string,
    mre_realm_id: s['mreRealmId'] as string,
    financial_account_id: s['financialAccountId'] as string,
    amount: s.amount.amount,
    currency: s.amount.currency,
    direction: s['direction'] as string,
    booking_date: s['bookingDate'] as string,
    value_date: s['valueDate'] as string | null,
    description: s['description'] as string | null,
    property_reference_id: s['propertyReferenceId'] as string | null,
    provenance: s['provenance'] as string,
    status: s['status'] as string,
    created_at: new Date(s.createdAt),
    version: s['version'] as number,
    // Snapshots from before VC-1-08 lack the fields.
    confirmed_at: typeof s['confirmedAt'] === 'string' ? new Date(s['confirmedAt']) : null,
    confirmed_by: (s['confirmedBy'] as string | null | undefined) ?? null,
    // Snapshots from before VC-1-11 lack the correction fields.
    correction_of_transaction_id: (s['correctionOfTransactionId'] as string | null | undefined) ?? null,
    correction_role: (s['correctionRole'] as string | null | undefined) ?? null,
    reversal_transaction_id: (s['reversalTransactionId'] as string | null | undefined) ?? null,
    replacement_transaction_id: (s['replacementTransactionId'] as string | null | undefined) ?? null,
  });
}
