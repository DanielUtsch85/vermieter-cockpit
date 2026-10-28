import type { Kysely } from 'kysely';
import {
  checkMatch,
  type ClaimOutcome,
  type RemovalClaimOutcome,
  type RemovalResult,
  type RecordOutcome,
  type WriteBackResult,
  planRelease,
  type ConfirmOutcome,
  type ConfirmPrecheck,
  type RejectOutcome,
  type Suggestion,
  type SuggestionSnapshot,
  type CreateMatchOutcome,
  type NewMatch,
  type PrecheckOutcome,
  type ReconciliationFilter,
  type ReconciliationPage,
  type ReconciliationStatus,
  type ReleaseOutcome,
  type RentPaymentReconciliation,
  type RentReconciliationRepository,
  type TransactionRentSide,
} from '../../domains/rent-reconciliation/index.js';
import { type Money, checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import {
  UUID,
  ENTITY_TYPE,
  COLUMNS,
  databaseNow,
  lockTransaction,
  cashOf,
  readIn,
  toReconciliation,
  toSnapshot,
  fromSnapshot,
} from './rent-reconciliation-rows.js';
import * as suggestionStore from './rent-suggestion-store.js';
import * as leaseStore from './rent-write-back-store.js';

const CREATE_SCOPE = 'rent-reconciliation.create';

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateMatchOutcome) {
    super(outcome.kind);
  }
}

/**
 * PostgreSQL implementation of api-design.md §37: matches, reads and release here; suggestions (§37.3) in
 * `rent-suggestion-store.ts` and the write-back and removal leases (§37.4–§37.5) in `rent-write-back-store.ts`, behind
 * this one class for the one port. Shared rows, reads and locks are in `rent-reconciliation-rows.ts`.
 */
export class PostgresRentReconciliationRepository implements RentReconciliationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async precheck(match: NewMatch, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<PrecheckOutcome> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx): Promise<PrecheckOutcome> => {
        if (idempotency !== undefined) {
          const existing = await trx
            .selectFrom('idempotency_key')
            .select(['request_fingerprint', 'result'])
            .where('mre_realm_id', '=', match.mreRealmId)
            .where('scope', '=', CREATE_SCOPE)
            .where('key', '=', idempotency.key)
            .executeTakeFirst();
          // A key claimed but not yet recorded belongs to a request still running: create decides.
          if (existing !== undefined && existing.request_fingerprint !== idempotency.fingerprint) return { kind: 'IDEMPOTENCY_CONFLICT' };
          if (existing?.result != null) return { kind: 'REPLAYED', reconciliation: fromSnapshot(existing.result) };
        }
        const refusal = checkMatch(await cashOf(trx, match.transactionId, match.mreRealmId, false), match);
        return refusal ?? { kind: 'PROCEED' };
      });
  }

  async create(match: NewMatch, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateMatchOutcome> {
    try {
      // READ COMMITTED explicitly: the idempotency claim and the re-reads after the Transaction lock rely on it.
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateMatchOutcome> => {
          const ref = { mreRealmId: match.mreRealmId, scope: CREATE_SCOPE, key: idempotency?.key ?? '' };
          if (idempotency !== undefined) {
            const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', reconciliation: fromSnapshot(claim.result) };
          }
          // P4-D8: the Transaction row first; checks 2–7 again under it (MRE was read outside any transaction).
          const refusal = checkMatch(await cashOf(trx, match.transactionId, match.mreRealmId, true), match);
          if (refusal !== undefined) throw new Rejected(refusal);
          const at = new Date();
          // The partial unique index is the arbiter for the same match: a lost insert yields no row and is re-read.
          const inserted = await trx
            .insertInto('rent_payment_reconciliation')
            .values({
              mre_realm_id: match.mreRealmId,
              status: 'CONFIRMED' satisfies ReconciliationStatus,
              transaction_id: match.transactionId,
              mre_tenant_id: match.mreTenantId,
              mre_rent_term: match.mreRentTerm,
              matched_amount: toNumericAmount(match.matchedAmount),
              currency: match.matchedAmount.currency,
              confirmed_at: at,
              confirmed_by: actor.actorId,
              notes: match.notes,
              created_by: actor.actorId,
            })
            .onConflict((oc) => oc.columns(['transaction_id', 'mre_tenant_id', 'mre_rent_term']).where('status', '=', 'CONFIRMED').doNothing())
            .returning('id')
            .executeTakeFirst();
          if (inserted === undefined) {
            const winner = await trx
              .selectFrom('rent_payment_reconciliation')
              .select('id')
              .where('transaction_id', '=', match.transactionId)
              .where('mre_tenant_id', '=', match.mreTenantId)
              .where('mre_rent_term', '=', match.mreRentTerm)
              .where('status', '=', 'CONFIRMED')
              .executeTakeFirstOrThrow();
            throw new Rejected({ kind: 'ALREADY_MATCHED', reconciliationId: winner.id });
          }
          const created = await readIn(trx, inserted.id);
          if (idempotency !== undefined) await recordIdempotentResult(trx, ref, created.id, toSnapshot(created));
          await writeAudit(trx, { type: ENTITY_TYPE, id: created.id }, 'CONFIRMED', actor, {
            newVersion: 1,
            metadata: {
              transactionId: created.transactionId,
              mreTenantId: created.mreTenantId,
              mreRentTerm: created.mreRentTerm,
              matchedAmount: created.matchedAmount.toJSON(),
              manual: true,
            },
          });
          return { kind: 'CREATED', reconciliation: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  async termSide(mreRealmId: string, mreTenantId: string, mreRentTerm: string): Promise<readonly RentPaymentReconciliation[]> {
    const rows = await this.db
      .selectFrom('rent_payment_reconciliation')
      .select(COLUMNS)
      .where('mre_realm_id', '=', mreRealmId)
      .where('mre_tenant_id', '=', mreTenantId)
      .where('mre_rent_term', '=', mreRentTerm)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map(toReconciliation);
  }

  async transactionSide(transactionId: string, mreRealmId: string): Promise<TransactionRentSide | undefined> {
    if (!UUID.test(transactionId)) return undefined;
    // The cash view and the reconciliations in one snapshot, so `available` agrees with the list.
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const cash = await cashOf(trx, transactionId, mreRealmId, false);
        if (cash === undefined) return undefined;
        const rows = await trx
          .selectFrom('rent_payment_reconciliation')
          .select(COLUMNS)
          .where('transaction_id', '=', transactionId)
          .orderBy('created_at')
          .orderBy('id')
          .execute();
        return {
          transactionId,
          status: cash.status,
          direction: cash.direction,
          correctionRole: cash.correctionRole,
          rentCash: cash.rentCash,
          reconciliations: rows.map(toReconciliation),
        };
      });
  }

  suggestionSnapshot(
    mreRealmId: string,
    terms: readonly { readonly mreTenantId: string; readonly mreRentTerm: string }[],
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<SuggestionSnapshot> {
    return suggestionStore.suggestionSnapshot(this.db, mreRealmId, terms, from, to);
  }

  writeSuggestions(mreRealmId: string, suggestions: readonly Suggestion[], actor: AuditActor): Promise<readonly RentPaymentReconciliation[]> {
    return suggestionStore.writeSuggestions(this.db, mreRealmId, suggestions, actor);
  }

  confirmPrecheck(id: string, mreRealmId: string, amount: Money | undefined): Promise<ConfirmPrecheck> {
    return suggestionStore.confirmPrecheck(this.db, id, mreRealmId, amount);
  }

  confirm(
    id: string,
    mreRealmId: string,
    amount: Money | undefined,
    amountDue: Money,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ConfirmOutcome> {
    return suggestionStore.confirm(this.db, id, mreRealmId, amount, amountDue, actor, expectedVersions);
  }

  reject(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<RejectOutcome> {
    return suggestionStore.reject(this.db, id, mreRealmId, reason, at, actor, expectedVersions);
  }

  async findById(id: string, mreRealmId: string): Promise<RentPaymentReconciliation | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db
      .selectFrom('rent_payment_reconciliation')
      .select(COLUMNS)
      .where('id', '=', id)
      .where('mre_realm_id', '=', mreRealmId)
      .executeTakeFirst();
    return row === undefined ? undefined : toReconciliation(row);
  }

  async list(mreRealmId: string, filter: ReconciliationFilter, page: { readonly page: number; readonly pageSize: number }): Promise<ReconciliationPage> {
    // Count and page in one snapshot, so `total` and `items` agree.
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const filtered = () => {
          let query = trx.selectFrom('rent_payment_reconciliation').where('mre_realm_id', '=', mreRealmId);
          if (filter.status !== undefined) query = query.where('status', 'in', filter.status);
          // An unknown or foreign Transaction is an empty page, not 404 (a read filter, §30.1).
          if (filter.transactionId !== undefined) query = query.where('transaction_id', '=', filter.transactionId);
          if (filter.mreTenantId !== undefined) query = query.where('mre_tenant_id', '=', filter.mreTenantId);
          if (filter.mreRentTerm !== undefined) query = query.where('mre_rent_term', '=', filter.mreRentTerm);
          return query;
        };
        const { n } = await filtered()
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        const rows = await filtered()
          .select(COLUMNS)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize)
          .execute();
        return { items: rows.map(toReconciliation), page: page.page, pageSize: page.pageSize, total: Number(n) };
      });
  }

  async release(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ReleaseOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<ReleaseOutcome> => {
          const named = await trx
            .selectFrom('rent_payment_reconciliation')
            .select('transaction_id')
            .where('id', '=', id)
            .where('mre_realm_id', '=', mreRealmId)
            .executeTakeFirst();
          if (named === undefined) return { kind: 'NOT_FOUND' };
          // P4-D8: the Transaction row first, then the reconciliation; a release and a create on it serialise.
          await lockTransaction(trx, named.transaction_id, mreRealmId);
          const current = toReconciliation(
            await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).forUpdate().executeTakeFirstOrThrow(),
          );
          // The lease is judged on the database's clock, as the claim and the trigger judge it (review on #83).
          const plan = planRelease(current, reason, await databaseNow(trx), actor);
          if (plan.kind === 'UNCHANGED') return { kind: 'RELEASED', reconciliation: current, changed: false };
          if (plan.kind !== 'RELEASE') return plan;
          const conflict = checkVersion(current.version, expectedVersions);
          if (conflict !== undefined) return conflict;
          await trx
            .updateTable('rent_payment_reconciliation')
            .set({
              status: 'RELEASED',
              released_at: at,
              released_by: actor.actorId,
              release_reason: reason,
              // P4-D7 (§37.4): a match whose payment is, or may be, in MRE stays visible as REMOVAL_REQUIRED.
              mre_write_back_state: plan.next.mreWriteBackState,
              mre_write_back_attempt_id: null,
              mre_write_back_lease_until: null,
              mre_write_back_error: null,
              mre_write_back_failed_at: null,
              version: plan.next.version,
              updated_at: at,
            })
            .where('id', '=', id)
            .execute();
          const released = await readIn(trx, id);
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'RELEASED', actor, {
            previousVersion: current.version,
            newVersion: released.version,
            metadata: {
              transactionId: released.transactionId,
              reason,
              matchedAmount: released.matchedAmount.toJSON(),
              mreWriteBackState: { from: current.mreWriteBackState, to: released.mreWriteBackState },
            },
          });
          return { kind: 'RELEASED', reconciliation: released, changed: true };
        });
    } catch (error) {
      // The trigger's own refusal of a release under a live lease is the same answer as the plan's, never a 500.
      if (/\(WRITE_BACK_IN_PROGRESS\)/.test((error as { message?: string }).message ?? '')) return { kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: id };
      throw error;
    }
  }

  claimWriteBack(id: string, mreRealmId: string, leaseMs: number, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ClaimOutcome> {
    return leaseStore.claimWriteBack(this.db, id, mreRealmId, leaseMs, actor, expectedVersions);
  }

  claimRemoval(
    id: string,
    mreRealmId: string,
    leaseMs: number,
    marginMs: number,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<RemovalClaimOutcome> {
    return leaseStore.claimRemoval(this.db, id, mreRealmId, leaseMs, marginMs, actor, expectedVersions);
  }

  recordWriteBack(id: string, mreRealmId: string, attemptId: string, result: WriteBackResult, actor: AuditActor): Promise<RecordOutcome> {
    return leaseStore.recordWriteBack(this.db, id, mreRealmId, attemptId, result, actor);
  }

  recordRemoval(id: string, mreRealmId: string, attemptId: string, result: RemovalResult, actor: AuditActor): Promise<RecordOutcome> {
    return leaseStore.recordRemoval(this.db, id, mreRealmId, attemptId, result, actor);
  }
}
