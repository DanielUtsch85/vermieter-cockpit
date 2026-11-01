import { sql, type Kysely, type Transaction } from 'kysely';
import {
  planClose,
  planReopen,
  type CloseCash,
  type CloseDepositOutcome,
  type CloseRequest,
  type DepositStatus,
  type DepositView,
  type ReopenDepositOutcome,
  type SecurityDeposit,
} from '../../domains/security-deposit/index.js';
import { checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { COLUMNS, ENTITY_TYPE, UUID, countedCashOf, readOne, toDeposit, viewsOf } from './security-deposit-rows.js';

/** The deposit's closing (api-design.md §47.4): close and reopen, and the cash a closing reads. */

export async function close(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  request: CloseRequest,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<CloseDepositOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx): Promise<CloseDepositOutcome> => {
      const row = await trx
        .selectFrom('security_deposit')
        .select(COLUMNS)
        .where('id', '=', id)
        .where('mre_realm_id', '=', mreRealmId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return { kind: 'NOT_FOUND' };
      const current = toDeposit(row);
      // P5-D9: the splits after the deposit's lock; a split write locks the deposit too, so none changes meanwhile.
      // security_deposit_close_guard is the backstop.
      const plan = planClose(current, request, await closeCashOf(trx, id));
      if (plan.kind === 'UNCHANGED') return { kind: 'CLOSED', deposit: (await viewsOf(trx, [current]))[0] as DepositView, changed: false };
      if (plan.kind !== 'CLOSE') return plan;
      const conflict = checkVersion(current.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      const { closing } = plan;
      await trx
        .updateTable('security_deposit')
        .set((eb) => ({
          status: 'CLOSED' satisfies DepositStatus,
          closing_date: closing.closingDate,
          closing_reason: closing.reason,
          closing_note: closing.closingNote,
          held_at_closing: toNumericAmount(closing.heldAtClosing),
          version: eb('version', '+', 1),
          updated_at: new Date(),
        }))
        .where('id', '=', id)
        .execute();
      const closed = await readOne(trx, id);
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CLOSED', actor, {
        previousVersion: current.version,
        newVersion: closed.version,
        metadata: closingJson(closing),
      });
      return { kind: 'CLOSED', deposit: (await viewsOf(trx, [closed]))[0] as DepositView, changed: true };
    });
}

export async function reopen(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<ReopenDepositOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx): Promise<ReopenDepositOutcome> => {
      const row = await trx
        .selectFrom('security_deposit')
        .select(COLUMNS)
        .where('id', '=', id)
        .where('mre_realm_id', '=', mreRealmId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return { kind: 'NOT_FOUND' };
      const current = toDeposit(row);
      const plan = planReopen(current);
      if (plan.kind === 'UNCHANGED') return { kind: 'REOPENED', deposit: (await viewsOf(trx, [current]))[0] as DepositView, changed: false };
      if (plan.kind !== 'REOPEN') return plan;
      const conflict = checkVersion(current.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      await trx
        .updateTable('security_deposit')
        .set((eb) => ({
          status: 'ACTIVE' satisfies DepositStatus,
          closing_date: null,
          closing_reason: null,
          closing_note: null,
          held_at_closing: null,
          version: eb('version', '+', 1),
          updated_at: new Date(),
        }))
        .where('id', '=', id)
        .execute();
      const reopened = await readOne(trx, id);
      // The cleared closing stays in the audit trail (§47.4).
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'REOPENED', actor, {
        previousVersion: current.version,
        newVersion: reopened.version,
        metadata: { cleared: current.closing === null ? null : closingJson(current.closing) },
      });
      return { kind: 'REOPENED', deposit: (await viewsOf(trx, [reopened]))[0] as DepositView, changed: true };
    });
}

/** §47.4: the deposit's counted cash and its open splits, read after the deposit's lock (P5-D9). */
async function closeCashOf(trx: Transaction<Database>, id: string): Promise<CloseCash> {
  const counted = (await countedCashOf(trx, [id])).get(id) ?? [];
  const open = await trx
    .selectFrom('transaction_split as s')
    .innerJoin('ledger_transaction as t', 't.id', 's.transaction_id')
    .select(['t.id as transaction_id', sql<string>`to_char(t.booking_date, 'YYYY-MM-DD')`.as('booking_date')])
    .where('s.security_deposit_id', '=', id)
    .where('t.status', 'in', ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED', 'IGNORED'])
    .where(sql<boolean>`t.correction_role IS DISTINCT FROM 'REVERSAL'`)
    .orderBy('t.booking_date')
    .orderBy('t.id')
    .orderBy('s.position')
    .execute();
  return { counted, open: open.map((r) => ({ transactionId: r.transaction_id, bookingDate: r.booking_date as BusinessDate })) };
}

const closingJson = (closing: NonNullable<SecurityDeposit['closing']>) => ({
  closingDate: closing.closingDate,
  reason: closing.reason,
  closingNote: closing.closingNote,
  heldAtClosing: closing.heldAtClosing.toJSON(),
});
