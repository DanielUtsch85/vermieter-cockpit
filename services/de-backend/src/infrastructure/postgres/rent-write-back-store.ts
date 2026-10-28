import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  holdsLease,
  planRemoval,
  planWriteBack,
  type ClaimOutcome,
  type RemovalClaimOutcome,
  type RemovalPlan,
  type RemovalResult,
  type WriteBackPlan,
  type RecordOutcome,
  type WriteBackError,
  type WriteBackResult,
  type RentPaymentReconciliation,
} from '../../domains/rent-reconciliation/index.js';
import { checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import type { Database } from './schema.js';
import { UUID, ENTITY_TYPE, COLUMNS, databaseNow, toPaymentColumn, readIn, toReconciliation } from './rent-reconciliation-rows.js';

/** The write-back and removal leases (§37.4–§37.5): claim a lease, record what MRE did under it. */

export async function claimWriteBack(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  leaseMs: number,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<ClaimOutcome> {
  const outcome = await claimLease(db, id, mreRealmId, leaseMs, actor, expectedVersions, 'PENDING', 'WRITE_BACK_STARTED', (current, now, holder) =>
    planWriteBack(current, now, holder),
  );
  return outcome as ClaimOutcome;
}

export async function claimRemoval(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  leaseMs: number,
  marginMs: number,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<RemovalClaimOutcome> {
  const outcome = await claimLease(db, id, mreRealmId, leaseMs, actor, expectedVersions, 'REMOVING', 'REMOVAL_STARTED', (current, now, holder) =>
    planRemoval(current, now, marginMs, holder),
  );
  return outcome as RemovalClaimOutcome;
}

/**
 * §37.4 and §37.5 step 1, one READ COMMITTED transaction on reconciliation rows only (P4-D8): the row `FOR UPDATE`,
 * the plan on the database's clock (the one the frozen trigger compares leases with), `If-Match`; the Tenant's other
 * expired leases failed in the same transaction (`PENDING` → `FAILED`, `REMOVING` → `REMOVAL_FAILED`, review on #75
 * and #84); then `target` with a new attempt and a lease of `leaseMs`, which is also the last lease end.
 */
async function claimLease(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  leaseMs: number,
  actor: AuditActor,
  expectedVersions: readonly number[] | undefined,
  target: 'PENDING' | 'REMOVING',
  action: string,
  plan: (current: RentPaymentReconciliation, now: Date, holder: RentPaymentReconciliation | undefined) => WriteBackPlan | RemovalPlan,
): Promise<ClaimOutcome | RemovalClaimOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  try {
    return await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<ClaimOutcome | RemovalClaimOutcome> => {
        const row = await trx
          .selectFrom('rent_payment_reconciliation')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = toReconciliation(row);
        const now = await databaseNow(trx);
        const holders = (
          await trx
            .selectFrom('rent_payment_reconciliation')
            .select(COLUMNS)
            .where('mre_realm_id', '=', mreRealmId)
            .where('mre_tenant_id', '=', current.mreTenantId)
            .where('mre_write_back_state', 'in', ['PENDING', 'REMOVING'])
            .where('id', '<>', id)
            .orderBy('id')
            .forUpdate()
            .execute()
        ).map(toReconciliation);
        const planned = plan(
          current,
          now,
          holders.find((h) => holdsLease(h, now)),
        );
        if (planned.kind === 'UNCHANGED') return { kind: 'UNCHANGED', reconciliation: current };
        if (planned.kind !== 'CLAIM') return planned;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        // Another reconciliation's expired lease: failed in the same transaction that takes the new one.
        for (const expired of holders) {
          await trx
            .updateTable('rent_payment_reconciliation')
            .set({
              mre_write_back_state: expired.mreWriteBackState === 'REMOVING' ? 'REMOVAL_FAILED' : 'FAILED',
              mre_write_back_error: 'LEASE_EXPIRED' satisfies WriteBackError,
              mre_write_back_failed_at: now,
              mre_write_back_attempt_id: null,
              mre_write_back_lease_until: null,
              version: expired.version + 1,
              updated_at: now,
            })
            .where('id', '=', expired.id)
            .execute();
          await writeAudit(trx, { type: ENTITY_TYPE, id: expired.id }, 'WRITE_BACK_ABANDONED', actor, {
            previousVersion: expired.version,
            newVersion: expired.version + 1,
            metadata: {
              attemptId: expired.mreWriteBackAttemptId,
              leaseUntil: expired.mreWriteBackLeaseUntil?.toISOString() ?? null,
              takenOverBy: id,
              from: expired.mreWriteBackState,
            },
          });
        }
        const attemptId = randomUUID();
        const leaseUntil = new Date(now.getTime() + leaseMs);
        await trx
          .updateTable('rent_payment_reconciliation')
          .set({
            mre_write_back_state: target,
            mre_write_back_attempt_id: attemptId,
            mre_write_back_lease_until: leaseUntil,
            // The last lease end only grows: a shorter lease never hides a longer one still running (§37.5).
            mre_last_lease_until: sql<Date>`greatest(mre_last_lease_until, ${leaseUntil}::timestamptz)`,
            mre_write_back_error: null,
            mre_write_back_failed_at: null,
            version: current.version + 1,
            updated_at: now,
          })
          .where('id', '=', id)
          .execute();
        await writeAudit(trx, { type: ENTITY_TYPE, id }, action, actor, {
          previousVersion: current.version,
          newVersion: current.version + 1,
          metadata: { attemptId, leaseUntil: leaseUntil.toISOString(), from: current.mreWriteBackState },
        });
        const tx = await trx
          .selectFrom('ledger_transaction')
          .select(sql<string>`to_char(booking_date, 'YYYY-MM-DD')`.as('booking_date'))
          .where('id', '=', current.transactionId)
          .executeTakeFirstOrThrow();
        return { kind: 'CLAIMED', reconciliation: await readIn(trx, id), attemptId, bookingDate: tx.booking_date as BusinessDate };
      });
  } catch (error) {
    // Another reconciliation of the same Tenant claimed first and committed: the Tenant index decides.
    if ((error as { constraint?: string }).constraint !== 'rent_payment_reconciliation_write_back_tenant_key') throw error;
    const named = await db.selectFrom('rent_payment_reconciliation').select('mre_tenant_id').where('id', '=', id).executeTakeFirstOrThrow();
    const holder = await db
      .selectFrom('rent_payment_reconciliation')
      .select('id')
      .where('mre_realm_id', '=', mreRealmId)
      .where('mre_tenant_id', '=', named.mre_tenant_id)
      .where('mre_write_back_state', 'in', ['PENDING', 'REMOVING'])
      .executeTakeFirst();
    return { kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: holder?.id ?? id };
  }
}

export async function recordWriteBack(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  attemptId: string,
  result: WriteBackResult,
  actor: AuditActor,
): Promise<RecordOutcome> {
  return recordLease(db, id, mreRealmId, attemptId, 'PENDING', actor, (now) => {
    switch (result.kind) {
      case 'WRITTEN':
        return {
          set: {
            mre_write_back_state: 'WRITTEN',
            mre_written_back_at: now,
            mre_written_back_by: actor.actorId,
            mre_payment: JSON.stringify(toPaymentColumn(result.payment)),
          },
          action: 'WRITE_BACK_WRITTEN',
          metadata: { patched: result.patched, payment: toPaymentColumn(result.payment) },
        };
      case 'FAILED':
        return {
          set: { mre_write_back_state: 'FAILED', mre_write_back_error: result.error, mre_write_back_failed_at: now },
          action: 'WRITE_BACK_FAILED',
          metadata: { error: result.error },
        };
      case 'NOT_WRITTEN':
        return { set: { mre_write_back_state: 'NOT_WRITTEN' }, action: 'WRITE_BACK_NOT_ROUND_TRIPPABLE', metadata: {} };
    }
  });
}

export async function recordRemoval(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  attemptId: string,
  result: RemovalResult,
  actor: AuditActor,
): Promise<RecordOutcome> {
  return recordLease(db, id, mreRealmId, attemptId, 'REMOVING', actor, (now) => {
    switch (result.kind) {
      case 'REMOVED':
        return {
          set: { mre_write_back_state: 'REMOVED', mre_removed_at: now, mre_removed_by: actor.actorId },
          action: 'REMOVED',
          metadata: { patched: result.patched },
        };
      case 'FAILED':
        return {
          set: { mre_write_back_state: 'REMOVAL_FAILED', mre_write_back_error: result.error, mre_write_back_failed_at: now },
          action: 'REMOVAL_FAILED',
          metadata: { error: result.error },
        };
      case 'NOT_REMOVED':
        return { set: { mre_write_back_state: 'REMOVAL_REQUIRED' }, action: 'REMOVAL_NOT_ROUND_TRIPPABLE', metadata: {} };
    }
  });
}

/** §37.4 and §37.5 step 5: only the attempt holding the lease records; a taken-over one writes nothing. */
async function recordLease(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  attemptId: string,
  state: 'PENDING' | 'REMOVING',
  actor: AuditActor,
  outcome: (now: Date) => { readonly set: Record<string, unknown>; readonly action: string; readonly metadata: Record<string, unknown> },
): Promise<RecordOutcome> {
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx): Promise<RecordOutcome> => {
      const row = await trx
        .selectFrom('rent_payment_reconciliation')
        .select(COLUMNS)
        .where('id', '=', id)
        .where('mre_realm_id', '=', mreRealmId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined || row.mre_write_back_state !== state || row.mre_write_back_attempt_id !== attemptId) return { kind: 'LEASE_LOST' };
      const current = toReconciliation(row);
      const now = new Date();
      const { set, action, metadata } = outcome(now);
      await trx
        .updateTable('rent_payment_reconciliation')
        .set({ ...set, mre_write_back_attempt_id: null, mre_write_back_lease_until: null, version: current.version + 1, updated_at: now })
        .where('id', '=', id)
        .execute();
      await writeAudit(trx, { type: ENTITY_TYPE, id }, action, actor, {
        previousVersion: current.version,
        newVersion: current.version + 1,
        metadata: { attemptId, ...metadata },
      });
      return { kind: 'RECORDED', reconciliation: await readIn(trx, id) };
    });
}
