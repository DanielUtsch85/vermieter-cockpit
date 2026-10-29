import { sql, type Kysely } from 'kysely';
import {
  RENT_CATEGORIES,
  checkMatch,
  planConfirm,
  planReject,
  staleBy,
  type ConfirmOutcome,
  type ConfirmPrecheck,
  type RejectOutcome,
  type Suggestion,
  type SuggestionPair,
  type SuggestionSnapshot,
  type ReconciliationStatus,
  type RentPaymentReconciliation,
} from '../../domains/rent-reconciliation/index.js';
import { Money, checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { UUID, ENTITY_TYPE, COLUMNS, withTransaction, lockTransaction, cashOf, readIn, toReconciliation } from './rent-reconciliation-rows.js';

/** Suggestions (§37.3): the snapshot a run decides on, writing the run, confirming and rejecting a suggestion. */

export async function suggestionSnapshot(
  db: Kysely<Database>,
  mreRealmId: string,
  terms: readonly { readonly mreTenantId: string; readonly mreRentTerm: string }[],
  from: BusinessDate,
  to: BusinessDate,
  window: { readonly from: BusinessDate; readonly to: BusinessDate },
): Promise<SuggestionSnapshot> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      // Counted INFLOW Transactions of the Realm booked in the window, with their rent cash and CONFIRMED matches.
      const rows = await sql<{ id: string; booking_date: string; iban: string | null; description: string | null; rent: string | null; matched: string }>`
      SELECT t.id, to_char(t.booking_date, 'YYYY-MM-DD') AS booking_date, t.counterparty_iban_raw AS iban, t.description,
        (SELECT sum(s.amount)::text FROM transaction_split s JOIN financial_category c ON c.id = s.financial_category_id
          WHERE s.transaction_id = t.id AND c.code IN (${sql.join(RENT_CATEGORIES.map((c) => sql`${c}`))})) AS rent,
        (SELECT coalesce(sum(r.matched_amount), 0)::text FROM rent_payment_reconciliation r WHERE r.transaction_id = t.id AND r.status = 'CONFIRMED') AS matched
      FROM ledger_transaction t
      WHERE t.mre_realm_id = ${mreRealmId} AND t.direction = 'INFLOW' AND t.status IN ('CONFIRMED', 'RECONCILED')
        AND t.correction_role IS DISTINCT FROM 'REVERSAL' AND t.booking_date BETWEEN ${from} AND ${to}
      ORDER BY t.id`.execute(trx);
      const candidates = rows.rows.flatMap((r) => {
        if (r.rent === null) return [];
        const available = fromNumericAmount(r.rent, 'EUR').subtract(fromNumericAmount(r.matched, 'EUR'));
        return available.isPositive()
          ? [{ transactionId: r.id, bookingDate: r.booking_date as BusinessDate, available, counterpartyIban: r.iban, description: r.description }]
          : [];
      });
      const ids = candidates.map((c) => c.transactionId);
      const termKeys = terms.map((t) => `${t.mreTenantId}/${t.mreRentTerm}`);
      const confirmedByTerm = new Map<string, Money>();
      const pairs =
        ids.length === 0 && termKeys.length === 0
          ? []
          : await trx
              .selectFrom('rent_payment_reconciliation')
              .select(['transaction_id', 'mre_tenant_id', 'mre_rent_term', 'status', sql<string>`matched_amount::text`.as('matched_amount')])
              .where('mre_realm_id', '=', mreRealmId)
              .where((eb) => {
                const ors = [];
                if (ids.length > 0) ors.push(eb('transaction_id', 'in', ids));
                if (termKeys.length > 0) ors.push(eb(sql<string>`mre_tenant_id || '/' || mre_rent_term`, 'in', termKeys));
                return eb.or(ors);
              })
              .orderBy('id')
              .execute();
      const handled: SuggestionPair[] = [];
      const open: SuggestionPair[] = [];
      const idSet = new Set(ids);
      const termSet = new Set(termKeys);
      for (const p of pairs) {
        const key = `${p.mre_tenant_id}/${p.mre_rent_term}`;
        const pair = { transactionId: p.transaction_id, mreTenantId: p.mre_tenant_id, mreRentTerm: p.mre_rent_term };
        if (p.status === 'CONFIRMED' && termSet.has(key))
          confirmedByTerm.set(key, (confirmedByTerm.get(key) ?? Money.zero('EUR')).add(fromNumericAmount(p.matched_amount, 'EUR')));
        // Open suggestions are edges for every candidate and every term read (review on #80); handled pairs only matter for candidates.
        if (p.status === 'SUGGESTED') open.push(pair);
        else if (idSet.has(p.transaction_id)) handled.push(pair);
      }
      const history = await trx
        .selectFrom('rent_payment_reconciliation as r')
        .innerJoin('ledger_transaction as t', 't.id', 'r.transaction_id')
        .select(['r.mre_tenant_id', 't.counterparty_iban_raw'])
        .distinct()
        .where('r.mre_realm_id', '=', mreRealmId)
        .where('r.status', '=', 'CONFIRMED')
        .where('t.counterparty_iban_raw', 'is not', null)
        .execute();
      // §37.6: the window's INFLOWs no rule could see; IGNORED ones are out of the ledger and not counted.
      const skipped = await sql<{ unconfirmed: number; noRentCash: number }>`
      SELECT
        count(*) FILTER (WHERE t.status IN ('IMPORTED', 'UNREVIEWED', 'CLASSIFIED'))::int AS unconfirmed,
        count(*) FILTER (WHERE t.status IN ('CONFIRMED', 'RECONCILED') AND t.correction_role IS DISTINCT FROM 'REVERSAL'
          AND NOT EXISTS (SELECT 1 FROM transaction_split s JOIN financial_category c ON c.id = s.financial_category_id
            WHERE s.transaction_id = t.id AND c.code IN (${sql.join(RENT_CATEGORIES.map((c) => sql`${c}`))})))::int AS "noRentCash"
      FROM ledger_transaction t
      WHERE t.mre_realm_id = ${mreRealmId} AND t.direction = 'INFLOW' AND t.booking_date BETWEEN ${window.from} AND ${window.to}`.execute(trx);
      const counts = skipped.rows[0] ?? { unconfirmed: 0, noRentCash: 0 };
      return {
        skipped: { unconfirmed: counts.unconfirmed, noRentCash: counts.noRentCash },
        candidates,
        confirmedByTerm,
        handled,
        open,
        history: history.map((h) => ({ mreTenantId: h.mre_tenant_id, counterpartyIban: h.counterparty_iban_raw as string })),
      };
    });
}

export async function writeSuggestions(
  db: Kysely<Database>,
  mreRealmId: string,
  suggestions: readonly Suggestion[],
  actor: AuditActor,
): Promise<readonly RentPaymentReconciliation[]> {
  if (suggestions.length === 0) return [];
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx) => {
      // P4-D8: the Transactions first, in id order; every pair re-checked under them.
      for (const id of [...new Set(suggestions.map((x) => x.transactionId))].sort()) await lockTransaction(trx, id, mreRealmId);
      const written: RentPaymentReconciliation[] = [];
      for (const suggestion of suggestions) {
        const cash = await cashOf(trx, suggestion.transactionId, mreRealmId, false);
        if (cash === undefined || cash.rentCash === null) continue;
        const counted = (cash.status === 'CONFIRMED' || cash.status === 'RECONCILED') && cash.correctionRole !== 'REVERSAL';
        const available = cash.confirmed.reduce((left, c) => left.subtract(c.matchedAmount), cash.rentCash);
        if (!counted || cash.direction !== 'INFLOW' || !available.equals(suggestion.matchedAmount)) continue;
        const existing = await trx
          .selectFrom('rent_payment_reconciliation')
          .select('id')
          .where('transaction_id', '=', suggestion.transactionId)
          .where('mre_tenant_id', '=', suggestion.mreTenantId)
          .where('mre_rent_term', '=', suggestion.mreRentTerm)
          .executeTakeFirst();
        if (existing !== undefined) continue; // changed in between: skipped, not refused
        const inserted = await trx
          .insertInto('rent_payment_reconciliation')
          .values({
            mre_realm_id: mreRealmId,
            status: 'SUGGESTED' satisfies ReconciliationStatus,
            transaction_id: suggestion.transactionId,
            mre_tenant_id: suggestion.mreTenantId,
            mre_rent_term: suggestion.mreRentTerm,
            matched_amount: toNumericAmount(suggestion.matchedAmount),
            currency: suggestion.matchedAmount.currency,
            confidence: suggestion.confidence,
            suggestion_reason: suggestion.suggestionReason,
            created_by: actor.actorId,
          })
          .onConflict((oc) => oc.columns(['transaction_id', 'mre_tenant_id', 'mre_rent_term']).where('status', '=', 'SUGGESTED').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (inserted === undefined) continue; // a concurrent run wrote it
        const created = await readIn(trx, inserted.id);
        await writeAudit(trx, { type: ENTITY_TYPE, id: created.id }, 'SUGGESTED', actor, {
          newVersion: 1,
          metadata: {
            transactionId: created.transactionId,
            mreTenantId: created.mreTenantId,
            mreRentTerm: created.mreRentTerm,
            matchedAmount: created.matchedAmount.toJSON(),
            confidence: created.confidence,
            suggestionReason: created.suggestionReason,
          },
        });
        written.push(created);
      }
      return written;
    });
}

export async function confirmPrecheck(db: Kysely<Database>, id: string, mreRealmId: string, amount: Money | undefined): Promise<ConfirmPrecheck> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx): Promise<ConfirmPrecheck> => {
      const row = await trx
        .selectFrom('rent_payment_reconciliation')
        .select(COLUMNS)
        .where('id', '=', id)
        .where('mre_realm_id', '=', mreRealmId)
        .executeTakeFirst();
      if (row === undefined) return { kind: 'NOT_FOUND' };
      const current = toReconciliation(row);
      const plan = planConfirm(current, amount);
      if (plan.kind === 'UNCHANGED') return { kind: 'UNCHANGED', reconciliation: current };
      if (plan.kind !== 'CONFIRM') return plan;
      const refusal = checkMatch(await cashOf(trx, current.transactionId, mreRealmId, false), { ...current, matchedAmount: plan.amount });
      if (refusal !== undefined) return withTransaction(refusal);
      return { kind: 'PROCEED', reconciliation: current, amount: plan.amount };
    });
}

export async function confirm(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  amount: Money | undefined,
  amountDue: Money,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<ConfirmOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx): Promise<ConfirmOutcome> => {
      const named = await trx
        .selectFrom('rent_payment_reconciliation')
        .select('transaction_id')
        .where('id', '=', id)
        .where('mre_realm_id', '=', mreRealmId)
        .executeTakeFirst();
      if (named === undefined) return { kind: 'NOT_FOUND' };
      // P4-D8: the Transaction row first, then the reconciliation.
      await lockTransaction(trx, named.transaction_id, mreRealmId);
      const current = toReconciliation(
        await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).forUpdate().executeTakeFirstOrThrow(),
      );
      const plan = planConfirm(current, amount);
      if (plan.kind === 'UNCHANGED') return { kind: 'CONFIRMED', reconciliation: current, changed: false };
      if (plan.kind !== 'CONFIRM') return plan;
      const refusal = checkMatch(await cashOf(trx, current.transactionId, mreRealmId, false), { ...current, matchedAmount: plan.amount });
      if (refusal !== undefined) return withTransaction(refusal);
      const termConfirmed = await trx
        .selectFrom('rent_payment_reconciliation')
        .select(sql<string>`coalesce(sum(matched_amount), 0)::text`.as('total'))
        .where('mre_realm_id', '=', mreRealmId)
        .where('mre_tenant_id', '=', current.mreTenantId)
        .where('mre_rent_term', '=', current.mreRentTerm)
        .where('status', '=', 'CONFIRMED')
        .executeTakeFirstOrThrow();
      const stale = staleBy(plan.amount, amountDue, fromNumericAmount(termConfirmed.total, 'EUR'));
      if (stale !== undefined) return { kind: 'SUGGESTION_STALE', openAmount: stale.openAmount };
      const conflict = checkVersion(current.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      const at = new Date();
      await trx
        .updateTable('rent_payment_reconciliation')
        .set({
          status: 'CONFIRMED',
          matched_amount: toNumericAmount(plan.amount),
          confirmed_at: at,
          confirmed_by: actor.actorId,
          version: current.version + 1,
          updated_at: at,
        })
        .where('id', '=', id)
        .execute();
      const confirmed = await readIn(trx, id);
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CONFIRMED', actor, {
        previousVersion: current.version,
        newVersion: confirmed.version,
        metadata: {
          transactionId: confirmed.transactionId,
          mreTenantId: confirmed.mreTenantId,
          mreRentTerm: confirmed.mreRentTerm,
          suggestedAmount: current.matchedAmount.toJSON(),
          matchedAmount: confirmed.matchedAmount.toJSON(),
          manual: false,
        },
      });
      return { kind: 'CONFIRMED', reconciliation: confirmed, changed: true };
    });
}

export async function reject(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  reason: string,
  at: Date,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<RejectOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
    .transaction()
    .setIsolationLevel('read committed')
    .execute(async (trx): Promise<RejectOutcome> => {
      // A rejection consumes no cash: the reconciliation alone (§37.3).
      const row = await trx
        .selectFrom('rent_payment_reconciliation')
        .select(COLUMNS)
        .where('id', '=', id)
        .where('mre_realm_id', '=', mreRealmId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return { kind: 'NOT_FOUND' };
      const current = toReconciliation(row);
      const plan = planReject(current, reason, at, actor);
      if (plan.kind === 'UNCHANGED') return { kind: 'REJECTED', reconciliation: current, changed: false };
      if (plan.kind !== 'REJECT') return plan;
      const conflict = checkVersion(current.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      await trx
        .updateTable('rent_payment_reconciliation')
        .set({ status: 'REJECTED', rejected_at: at, rejected_by: actor.actorId, reject_reason: reason, version: plan.next.version, updated_at: at })
        .where('id', '=', id)
        .execute();
      const rejected = await readIn(trx, id);
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'REJECTED', actor, {
        previousVersion: current.version,
        newVersion: rejected.version,
        metadata: { transactionId: rejected.transactionId, mreTenantId: rejected.mreTenantId, mreRentTerm: rejected.mreRentTerm, reason },
      });
      return { kind: 'REJECTED', reconciliation: rejected, changed: true };
    });
}
