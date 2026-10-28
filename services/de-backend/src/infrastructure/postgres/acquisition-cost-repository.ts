import { sql, type Kysely, type Transaction } from 'kysely';
import {
  checkLink,
  isCurrentTransaction,
  notCountingReason,
  paymentStatusOf,
  planUnlink,
  planVoidCost,
  type AcquisitionCost,
  type AcquisitionCostRepository,
  type AcquisitionPayment,
  type AcquisitionStatus,
  type CostCategory,
  type CostFilter,
  type CostStatus,
  type CreateCostOutcome,
  type LinkPaymentOutcome,
  type NewAcquisitionCost,
  type NewAcquisitionPayment,
  type PaymentFilter,
  type PurchasePricePayments,
  type UnlinkPaymentOutcome,
  type VoidCostOutcome,
} from '../../domains/acquisition/index.js';
import { Money, checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COST_ENTITY = 'AcquisitionCost';
const PAYMENT_ENTITY = 'AcquisitionPayment';
const COST_SCOPE = 'acquisition.cost.create';
const PAYMENT_SCOPE = 'acquisition.payment.create';

/** A payment counts while it is not unlinked and its Transaction is current (§35.3); the Acquisition is checked apart. */
const COUNTING = sql<boolean>`p.unlinked_at IS NULL AND t.status IN ('CONFIRMED', 'RECONCILED') AND t.correction_role IS DISTINCT FROM 'REVERSAL'`;

interface AcquisitionState {
  readonly status: AcquisitionStatus;
  readonly purchasePrice: Money;
}

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected<T> extends Error {
  constructor(readonly outcome: T) {
    super('rejected');
  }
}

/** PostgreSQL implementation of the cost and payment port (api-design.md §27.2). */
export class PostgresAcquisitionCostRepository implements AcquisitionCostRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createCost(
    cost: NewAcquisitionCost,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateCostOutcome> {
    if (!UUID.test(cost.acquisitionId)) return { kind: 'ACQUISITION_NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateCostOutcome> => {
          const ref = { mreRealmId: cost.mreRealmId, scope: COST_SCOPE, key: idempotency?.key ?? '' };
          if (idempotency !== undefined) {
            const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', cost: costFromSnapshot(claim.result) };
          }
          const acquisition = await touchAcquisition(trx, cost.acquisitionId, cost.mreRealmId);
          if (acquisition === undefined) throw new Rejected<CreateCostOutcome>({ kind: 'ACQUISITION_NOT_FOUND' });
          if (cost.counterpartyPartyId !== null) {
            const party = await trx
              .selectFrom('party')
              .select('id')
              .where('id', '=', cost.counterpartyPartyId)
              .where('mre_realm_id', '=', cost.mreRealmId)
              .executeTakeFirst();
            if (party === undefined) throw new Rejected<CreateCostOutcome>({ kind: 'PARTY_NOT_FOUND', partyId: cost.counterpartyPartyId });
          }
          if (acquisition.status === 'CANCELLED') throw new Rejected<CreateCostOutcome>({ kind: 'ACQUISITION_CANCELLED' });

          const { id } = await trx
            .insertInto('acquisition_cost')
            .values({
              mre_realm_id: cost.mreRealmId,
              acquisition_id: cost.acquisitionId,
              category: cost.category,
              amount: toNumericAmount(cost.amount),
              currency: cost.amount.currency,
              incurred_date: cost.incurredDate,
              counterparty_party_id: cost.counterpartyPartyId,
              source_references: [...cost.sourceReferences],
              notes: cost.notes,
              status: 'ACTIVE' satisfies CostStatus,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const [created] = await costsOf(trx, cost.acquisitionId, acquisition, {}, id);
          if (created === undefined) throw new Error(`AcquisitionCost ${id} vanished`);
          if (idempotency !== undefined) await recordIdempotentResult(trx, ref, id, costToSnapshot(created));
          await writeAudit(trx, { type: COST_ENTITY, id }, 'CREATED', actor, {
            newVersion: created.version,
            metadata: {
              acquisitionId: cost.acquisitionId,
              category: cost.category,
              amount: cost.amount.toJSON(),
              incurredDate: cost.incurredDate,
              counterpartyPartyId: cost.counterpartyPartyId,
            },
          });
          return { kind: 'CREATED', cost: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome as CreateCostOutcome;
      throw error;
    }
  }

  async voidCost(
    acquisitionId: string,
    costId: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidCostOutcome> {
    if (!UUID.test(acquisitionId) || !UUID.test(costId)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<VoidCostOutcome> => {
        const acquisition = await touchAcquisition(trx, acquisitionId, mreRealmId);
        if (acquisition === undefined) return { kind: 'NOT_FOUND' };
        const [current] = await costsOf(trx, acquisitionId, acquisition, {}, costId);
        if (current === undefined) return { kind: 'NOT_FOUND' };
        const linked = await trx
          .selectFrom('acquisition_payment')
          .select('id')
          .where('acquisition_cost_id', '=', costId)
          .where('unlinked_at', 'is', null)
          .execute();
        const plan = planVoidCost(
          current,
          acquisition.status,
          linked.map((p) => p.id),
        );
        if (plan.kind === 'UNCHANGED') return { kind: 'VOIDED', cost: current, changed: false };
        if (plan.kind !== 'VOID') return plan;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('acquisition_cost')
          .set({ status: 'VOID' satisfies CostStatus, voided_at: at, void_reason: reason, version: current.version + 1, updated_at: at })
          .where('id', '=', costId)
          .execute();
        const [voided] = await costsOf(trx, acquisitionId, acquisition, {}, costId);
        if (voided === undefined) throw new Error(`AcquisitionCost ${costId} vanished`);
        await writeAudit(trx, { type: COST_ENTITY, id: costId }, 'VOIDED', actor, {
          previousVersion: current.version,
          newVersion: voided.version,
          metadata: { acquisitionId, reason },
        });
        return { kind: 'VOIDED', cost: voided, changed: true };
      });
  }

  async listCosts(acquisitionId: string, mreRealmId: string, filter: CostFilter): Promise<readonly AcquisitionCost[] | undefined> {
    if (!UUID.test(acquisitionId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const acquisition = await readAcquisition(trx, acquisitionId, mreRealmId);
        return acquisition === undefined ? undefined : costsOf(trx, acquisitionId, acquisition, filter);
      });
  }

  async linkPayment(
    payment: NewAcquisitionPayment,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<LinkPaymentOutcome> {
    if (!UUID.test(payment.acquisitionId)) return { kind: 'ACQUISITION_NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<LinkPaymentOutcome> => {
          const ref = { mreRealmId: payment.mreRealmId, scope: PAYMENT_SCOPE, key: idempotency?.key ?? '' };
          if (idempotency !== undefined) {
            const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', payment: paymentFromSnapshot(claim.result) };
          }
          const reject = (outcome: LinkPaymentOutcome): never => {
            throw new Rejected(outcome);
          };
          // Lock order of §27.2: the Acquisition, then the Transaction.
          const acquisition = (await touchAcquisition(trx, payment.acquisitionId, payment.mreRealmId)) ?? reject({ kind: 'ACQUISITION_NOT_FOUND' });
          const costId = payment.acquisitionCostId;
          const cost =
            costId === null
              ? undefined
              : ((await trx
                  .selectFrom('acquisition_cost')
                  .select(['status', sql<string>`amount::text`.as('amount'), 'currency'])
                  .where('id', '=', costId)
                  .where('acquisition_id', '=', payment.acquisitionId)
                  .executeTakeFirst()) ?? reject({ kind: 'COST_NOT_FOUND' }));
          const transaction =
            (await trx
              .updateTable('ledger_transaction')
              .set((eb) => ({ version: eb.ref('version') }))
              .where('id', '=', payment.transactionId)
              .where('mre_realm_id', '=', payment.mreRealmId)
              .returning([sql<string>`amount::text`.as('amount'), 'currency', 'status', 'direction', 'correction_role'])
              .executeTakeFirst()) ?? reject({ kind: 'TRANSACTION_NOT_FOUND' });

          const { linked } = await trx
            .selectFrom('acquisition_payment as p')
            .innerJoin('acquisition as a', 'a.id', 'p.acquisition_id')
            .select(sql<string>`coalesce(sum(p.amount), 0)::text`.as('linked'))
            .where('p.transaction_id', '=', payment.transactionId)
            .where('p.unlinked_at', 'is', null)
            .where('a.status', '<>', 'CANCELLED')
            .executeTakeFirstOrThrow();
          const { paid } = await trx
            .selectFrom('acquisition_payment as p')
            .innerJoin('ledger_transaction as t', 't.id', 'p.transaction_id')
            .select(sql<string>`coalesce(sum(p.amount), 0)::text`.as('paid'))
            .where('p.acquisition_id', '=', payment.acquisitionId)
            .where(sql<boolean>`p.acquisition_cost_id IS NOT DISTINCT FROM ${costId}::uuid`)
            .where(COUNTING)
            .executeTakeFirstOrThrow();
          const currency = acquisition.purchasePrice.currency;
          const refusal = checkLink(payment.amount, {
            acquisitionStatus: acquisition.status,
            ...(cost === undefined ? {} : { costStatus: cost.status as CostStatus }),
            transaction: {
              amount: fromNumericAmount(transaction.amount, transaction.currency),
              status: transaction.status,
              direction: transaction.direction,
              correctionRole: transaction.correction_role,
            },
            linkedOnTransaction: transaction.currency === currency ? fromNumericAmount(linked, currency) : Money.zero(currency),
            expected: cost === undefined ? acquisition.purchasePrice : fromNumericAmount(cost.amount, cost.currency),
            paid: fromNumericAmount(paid, currency),
          });
          if (refusal !== undefined) reject(refusal);

          const { id } = await trx
            .insertInto('acquisition_payment')
            .values({
              mre_realm_id: payment.mreRealmId,
              acquisition_id: payment.acquisitionId,
              acquisition_cost_id: costId,
              transaction_id: payment.transactionId,
              amount: toNumericAmount(payment.amount),
              currency: payment.amount.currency,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const [created] = await paymentsOf(trx, payment.acquisitionId, acquisition, {}, id);
          if (created === undefined) throw new Error(`AcquisitionPayment ${id} vanished`);
          if (idempotency !== undefined) await recordIdempotentResult(trx, ref, id, paymentToSnapshot(created));
          await writeAudit(trx, { type: PAYMENT_ENTITY, id }, 'LINKED', actor, {
            newVersion: created.version,
            metadata: {
              acquisitionId: payment.acquisitionId,
              acquisitionCostId: costId,
              transactionId: payment.transactionId,
              amount: payment.amount.toJSON(),
            },
          });
          return { kind: 'LINKED', payment: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome as LinkPaymentOutcome;
      throw error;
    }
  }

  async unlinkPayment(
    acquisitionId: string,
    paymentId: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<UnlinkPaymentOutcome> {
    if (!UUID.test(acquisitionId) || !UUID.test(paymentId)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<UnlinkPaymentOutcome> => {
        const acquisition = await touchAcquisition(trx, acquisitionId, mreRealmId);
        if (acquisition === undefined) return { kind: 'NOT_FOUND' };
        const [current] = await paymentsOf(trx, acquisitionId, acquisition, {}, paymentId);
        if (current === undefined) return { kind: 'NOT_FOUND' };
        const plan = planUnlink(current, acquisition.status);
        if (plan.kind === 'UNCHANGED') return { kind: 'UNLINKED', payment: current, changed: false };
        if (plan.kind !== 'UNLINK') return plan;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('acquisition_payment')
          .set({ unlinked_at: at, unlink_reason: reason, version: current.version + 1, updated_at: at })
          .where('id', '=', paymentId)
          .execute();
        const [unlinked] = await paymentsOf(trx, acquisitionId, acquisition, {}, paymentId);
        if (unlinked === undefined) throw new Error(`AcquisitionPayment ${paymentId} vanished`);
        await writeAudit(trx, { type: PAYMENT_ENTITY, id: paymentId }, 'UNLINKED', actor, {
          previousVersion: current.version,
          newVersion: unlinked.version,
          metadata: { acquisitionId, reason },
        });
        return { kind: 'UNLINKED', payment: unlinked, changed: true };
      });
  }

  async listPayments(
    acquisitionId: string,
    mreRealmId: string,
    filter: PaymentFilter,
  ): Promise<{ readonly purchasePrice: PurchasePricePayments; readonly items: readonly AcquisitionPayment[] } | undefined> {
    if (!UUID.test(acquisitionId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const acquisition = await readAcquisition(trx, acquisitionId, mreRealmId);
        if (acquisition === undefined) return undefined;
        const all = await paymentsOf(trx, acquisitionId, acquisition, {});
        const price = acquisition.purchasePrice;
        const paid = all.filter((p) => p.acquisitionCostId === null && p.counting).reduce((sum, p) => sum.add(p.amount), Money.zero(price.currency));
        const purchasePrice =
          acquisition.status === 'CANCELLED'
            ? { amount: price, paidAmount: Money.zero(price.currency), paymentStatus: null }
            : { amount: price, paidAmount: paid, paymentStatus: paymentStatusOf(price, paid) };
        const items = all.filter(
          (p) =>
            (filter.acquisitionCostId === undefined || p.acquisitionCostId === filter.acquisitionCostId) &&
            (filter.counting === undefined || p.counting === filter.counting),
        );
        return { purchasePrice, items };
      });
  }
}

/**
 * The Acquisition's no-op write that serialises every cost and payment write with each other and with cancel
 * (§27.2); its status as of after the wait. `undefined` for an unknown or foreign one.
 */
async function touchAcquisition(trx: Transaction<Database>, id: string, mreRealmId: string): Promise<AcquisitionState | undefined> {
  const row = await trx
    .updateTable('acquisition')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('mre_realm_id', '=', mreRealmId)
    .returning(['status', sql<string>`purchase_price::text`.as('purchase_price'), 'currency'])
    .executeTakeFirst();
  return row === undefined ? undefined : { status: row.status as AcquisitionStatus, purchasePrice: fromNumericAmount(row.purchase_price, row.currency) };
}

async function readAcquisition(trx: Transaction<Database>, id: string, mreRealmId: string): Promise<AcquisitionState | undefined> {
  const row = await trx
    .selectFrom('acquisition')
    .select(['status', sql<string>`purchase_price::text`.as('purchase_price'), 'currency'])
    .where('id', '=', id)
    .where('mre_realm_id', '=', mreRealmId)
    .executeTakeFirst();
  return row === undefined ? undefined : { status: row.status as AcquisitionStatus, purchasePrice: fromNumericAmount(row.purchase_price, row.currency) };
}

/** The Acquisition's costs (or the one with `onlyId`) with their derived paid state, in `createdAt`, id order. */
async function costsOf(
  trx: Transaction<Database>,
  acquisitionId: string,
  acquisition: AcquisitionState,
  filter: CostFilter,
  onlyId?: string,
): Promise<AcquisitionCost[]> {
  let query = trx
    .selectFrom('acquisition_cost as c')
    .select([
      'c.id',
      'c.mre_realm_id',
      'c.acquisition_id',
      'c.category',
      sql<string>`c.amount::text`.as('amount'),
      'c.currency',
      sql<string | null>`to_char(c.incurred_date, 'YYYY-MM-DD')`.as('incurred_date'),
      'c.counterparty_party_id',
      'c.source_references',
      'c.notes',
      'c.status',
      'c.voided_at',
      'c.void_reason',
      'c.created_at',
      'c.version',
      sql<string>`coalesce((
        SELECT sum(p.amount) FROM acquisition_payment p JOIN ledger_transaction t ON t.id = p.transaction_id
         WHERE p.acquisition_cost_id = c.id AND ${COUNTING}), 0)::text`.as('paid'),
    ])
    .where('c.acquisition_id', '=', acquisitionId);
  if (onlyId !== undefined) query = query.where('c.id', '=', onlyId);
  if (filter.status !== undefined) query = query.where('c.status', '=', filter.status);
  const rows = await query.orderBy('c.created_at').orderBy('c.id').execute();
  return rows.map((row) => {
    const amount = fromNumericAmount(row.amount, row.currency);
    const status = row.status as CostStatus;
    const cancelled = acquisition.status === 'CANCELLED';
    const paid = cancelled ? Money.zero(row.currency) : fromNumericAmount(row.paid, row.currency);
    return {
      id: row.id,
      mreRealmId: row.mre_realm_id,
      acquisitionId: row.acquisition_id,
      category: row.category as CostCategory,
      amount,
      incurredDate: row.incurred_date as BusinessDate | null,
      counterpartyPartyId: row.counterparty_party_id,
      sourceReferences: row.source_references,
      notes: row.notes,
      status,
      voidedAt: row.voided_at,
      voidReason: row.void_reason,
      paidAmount: paid,
      paymentStatus: cancelled || status === 'VOID' ? null : paymentStatusOf(amount, paid),
      createdAt: row.created_at,
      version: row.version,
    };
  });
}

/** The Acquisition's payments (or the one with `onlyId`) with their Transaction's state, in `createdAt`, id order. */
async function paymentsOf(
  trx: Transaction<Database>,
  acquisitionId: string,
  acquisition: AcquisitionState,
  filter: PaymentFilter,
  onlyId?: string,
): Promise<AcquisitionPayment[]> {
  let query = trx
    .selectFrom('acquisition_payment as p')
    .innerJoin('ledger_transaction as t', 't.id', 'p.transaction_id')
    .select([
      'p.id',
      'p.mre_realm_id',
      'p.acquisition_id',
      'p.acquisition_cost_id',
      'p.transaction_id',
      sql<string>`p.amount::text`.as('amount'),
      'p.currency',
      'p.unlinked_at',
      'p.unlink_reason',
      'p.created_at',
      'p.version',
      't.status as transaction_status',
      't.correction_role',
      sql<string | null>`(SELECT r.id FROM ledger_transaction r WHERE r.correction_of_transaction_id = t.id AND r.correction_role = 'REPLACEMENT')`.as(
        'replacement_id',
      ),
    ])
    .where('p.acquisition_id', '=', acquisitionId);
  if (onlyId !== undefined) query = query.where('p.id', '=', onlyId);
  const rows = await query.orderBy('p.created_at').orderBy('p.id').execute();
  const payments = rows.map((row): AcquisitionPayment => {
    const reason = notCountingReason({
      unlinked: row.unlinked_at !== null,
      acquisitionStatus: acquisition.status,
      transactionCurrent: isCurrentTransaction(row.transaction_status, row.correction_role),
    });
    return {
      id: row.id,
      mreRealmId: row.mre_realm_id,
      acquisitionId: row.acquisition_id,
      acquisitionCostId: row.acquisition_cost_id,
      transactionId: row.transaction_id,
      amount: fromNumericAmount(row.amount, row.currency),
      counting: reason === null,
      notCountingReason: reason,
      transactionStatus: row.transaction_status,
      replacementTransactionId: row.replacement_id,
      unlinkedAt: row.unlinked_at,
      unlinkReason: row.unlink_reason,
      createdAt: row.created_at,
      version: row.version,
    };
  });
  return payments.filter(
    (p) =>
      (filter.acquisitionCostId === undefined || p.acquisitionCostId === filter.acquisitionCostId) &&
      (filter.counting === undefined || p.counting === filter.counting),
  );
}

/** The created cost or payment as JSON for the idempotency store: Money as `{ amount, currency }`, timestamps ISO. */
function costToSnapshot(c: AcquisitionCost): unknown {
  return {
    ...c,
    amount: c.amount.toJSON(),
    paidAmount: c.paidAmount.toJSON(),
    createdAt: c.createdAt.toISOString(),
    voidedAt: c.voidedAt?.toISOString() ?? null,
  };
}

/** Written by costToSnapshot in the same codebase, so its shape is trusted. */
function costFromSnapshot(result: unknown): AcquisitionCost {
  const s = result as Omit<AcquisitionCost, 'amount' | 'paidAmount' | 'createdAt' | 'voidedAt'> & {
    amount: { amount: string; currency: string };
    paidAmount: { amount: string; currency: string };
    createdAt: string;
    voidedAt: string | null;
  };
  return {
    ...s,
    amount: fromNumericAmount(s.amount.amount, s.amount.currency),
    paidAmount: fromNumericAmount(s.paidAmount.amount, s.paidAmount.currency),
    createdAt: new Date(s.createdAt),
    voidedAt: s.voidedAt === null ? null : new Date(s.voidedAt),
  };
}

function paymentToSnapshot(p: AcquisitionPayment): unknown {
  return { ...p, amount: p.amount.toJSON(), createdAt: p.createdAt.toISOString(), unlinkedAt: p.unlinkedAt?.toISOString() ?? null };
}

function paymentFromSnapshot(result: unknown): AcquisitionPayment {
  const s = result as Omit<AcquisitionPayment, 'amount' | 'createdAt' | 'unlinkedAt'> & {
    amount: { amount: string; currency: string };
    createdAt: string;
    unlinkedAt: string | null;
  };
  return {
    ...s,
    amount: fromNumericAmount(s.amount.amount, s.amount.currency),
    createdAt: new Date(s.createdAt),
    unlinkedAt: s.unlinkedAt === null ? null : new Date(s.unlinkedAt),
  };
}
