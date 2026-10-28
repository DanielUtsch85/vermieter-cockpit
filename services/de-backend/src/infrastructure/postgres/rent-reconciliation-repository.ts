import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  RENT_CATEGORIES,
  checkMatch,
  holdsLease,
  planWriteBack,
  type ClaimOutcome,
  type MrePaymentSnapshot,
  type RecordOutcome,
  type WriteBackError,
  type WriteBackResult,
  planConfirm,
  planReject,
  planRelease,
  staleBy,
  type ConfirmOutcome,
  type ConfirmPrecheck,
  type RejectOutcome,
  type Suggestion,
  type SuggestionPair,
  type SuggestionSnapshot,
  type CreateMatchOutcome,
  type MatchCash,
  type MreWriteBackState,
  type NewMatch,
  type PrecheckOutcome,
  type ReconciliationFilter,
  type ReconciliationPage,
  type ReconciliationStatus,
  type ReleaseOutcome,
  type RentPaymentReconciliation,
  type RentPaymentReconciliationId,
  type RentReconciliationRepository,
  type TransactionRentSide,
} from '../../domains/rent-reconciliation/index.js';
import { Money, checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'RentPaymentReconciliation';
const CREATE_SCOPE = 'rent-reconciliation.create';

/** Every column, the amount as text (exact). */
const COLUMNS = [
  'id',
  'mre_realm_id',
  'status',
  'transaction_id',
  'mre_tenant_id',
  'mre_rent_term',
  sql<string>`matched_amount::text`.as('matched_amount'),
  'currency',
  'confidence',
  'suggestion_reason',
  'confirmed_at',
  'confirmed_by',
  'released_at',
  'released_by',
  'release_reason',
  'rejected_at',
  'rejected_by',
  'reject_reason',
  'notes',
  'mre_write_back_state',
  'mre_write_back_attempt_id',
  'mre_write_back_lease_until',
  'mre_written_back_at',
  'mre_written_back_by',
  'mre_payment',
  'mre_write_back_error',
  'mre_write_back_failed_at',
  'created_at',
  'version',
] as const;

interface ReconciliationRow {
  id: string;
  mre_realm_id: string;
  status: string;
  transaction_id: string;
  mre_tenant_id: string;
  mre_rent_term: string;
  matched_amount: string;
  currency: string;
  confidence: string | null;
  suggestion_reason: string | null;
  confirmed_at: Date | null;
  confirmed_by: string | null;
  released_at: Date | null;
  released_by: string | null;
  release_reason: string | null;
  rejected_at: Date | null;
  rejected_by: string | null;
  reject_reason: string | null;
  notes: string | null;
  mre_write_back_state: string;
  mre_write_back_attempt_id: string | null;
  mre_write_back_lease_until: Date | null;
  mre_written_back_at: Date | null;
  mre_written_back_by: string | null;
  mre_payment: unknown;
  mre_write_back_error: string | null;
  mre_write_back_failed_at: Date | null;
  created_at: Date;
  version: number;
}

/** `mre_payment` as stored: DE's payment as MRE stores it, the amount as Money JSON. */
interface PaymentColumn {
  date: string;
  amount: { amount: string; currency: string };
  type: string;
  reference: string;
}

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateMatchOutcome) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of api-design.md §37.1. */
export class PostgresRentReconciliationRepository implements RentReconciliationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async precheck(match: NewMatch, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<PrecheckOutcome> {
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx): Promise<PrecheckOutcome> => {
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
      return await this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<CreateMatchOutcome> => {
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
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      const cash = await cashOf(trx, transactionId, mreRealmId, false);
      if (cash === undefined) return undefined;
      const rows = await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('transaction_id', '=', transactionId).orderBy('created_at').orderBy('id').execute();
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


  async suggestionSnapshot(
    mreRealmId: string,
    terms: readonly { readonly mreTenantId: string; readonly mreRentTerm: string }[],
    from: BusinessDate,
    to: BusinessDate,
  ): Promise<SuggestionSnapshot> {
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      // Counted INFLOW Transactions of the Realm booked in the window, with their rent cash and CONFIRMED matches.
      const rows = await sql<{ id: string; booking_date: string; iban: string | null; rent: string | null; matched: string }>`
        SELECT t.id, to_char(t.booking_date, 'YYYY-MM-DD') AS booking_date, t.counterparty_iban_raw AS iban,
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
        return available.isPositive() ? [{ transactionId: r.id, bookingDate: r.booking_date as BusinessDate, available, counterpartyIban: r.iban }] : [];
      });
      const ids = candidates.map((c) => c.transactionId);
      const termKeys = terms.map((t) => `${t.mreTenantId}/${t.mreRentTerm}`);
      const confirmedByTerm = new Map<string, Money>();
      const pairs = ids.length === 0 && termKeys.length === 0 ? [] : await trx
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
        if (p.status === 'CONFIRMED' && termSet.has(key)) confirmedByTerm.set(key, (confirmedByTerm.get(key) ?? Money.zero('EUR')).add(fromNumericAmount(p.matched_amount, 'EUR')));
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
      return {
        candidates,
        confirmedByTerm,
        handled,
        open,
        history: history.map((h) => ({ mreTenantId: h.mre_tenant_id, counterpartyIban: h.counterparty_iban_raw as string })),
      };
    });
  }

  async writeSuggestions(mreRealmId: string, suggestions: readonly Suggestion[], actor: AuditActor): Promise<readonly RentPaymentReconciliation[]> {
    if (suggestions.length === 0) return [];
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx) => {
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

  async confirmPrecheck(id: string, mreRealmId: string, amount: Money | undefined): Promise<ConfirmPrecheck> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx): Promise<ConfirmPrecheck> => {
      const row = await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
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

  async confirm(
    id: string,
    mreRealmId: string,
    amount: Money | undefined,
    amountDue: Money,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ConfirmOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<ConfirmOutcome> => {
      const named = await trx.selectFrom('rent_payment_reconciliation').select('transaction_id').where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
      if (named === undefined) return { kind: 'NOT_FOUND' };
      // P4-D8: the Transaction row first, then the reconciliation.
      await lockTransaction(trx, named.transaction_id, mreRealmId);
      const current = toReconciliation(await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).forUpdate().executeTakeFirstOrThrow());
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

  async reject(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<RejectOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<RejectOutcome> => {
      // A rejection consumes no cash: the reconciliation alone (§37.3).
      const row = await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).forUpdate().executeTakeFirst();
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

  async findById(id: string, mreRealmId: string): Promise<RentPaymentReconciliation | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
    return row === undefined ? undefined : toReconciliation(row);
  }

  async list(mreRealmId: string, filter: ReconciliationFilter, page: { readonly page: number; readonly pageSize: number }): Promise<ReconciliationPage> {
    // Count and page in one snapshot, so `total` and `items` agree.
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
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
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<ReleaseOutcome> => {
      const named = await trx.selectFrom('rent_payment_reconciliation').select('transaction_id').where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
      if (named === undefined) return { kind: 'NOT_FOUND' };
      // P4-D8: the Transaction row first, then the reconciliation; a release and a create on it serialise.
      await lockTransaction(trx, named.transaction_id, mreRealmId);
      const current = toReconciliation(await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).forUpdate().executeTakeFirstOrThrow());
      const plan = planRelease(current, reason, at, actor);
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
  }

  async claimWriteBack(id: string, mreRealmId: string, leaseMs: number, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ClaimOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    try {
      return await this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<ClaimOutcome> => {
        // P4-D8: reconciliation rows only, never the Transaction.
        const row = await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).forUpdate().executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = toReconciliation(row);
        // The database's clock, the one the frozen trigger compares leases with.
        const now = (await sql<{ now: Date }>`SELECT now() AS now`.execute(trx)).rows[0]?.now ?? new Date();
        const holders = (
          await trx
            .selectFrom('rent_payment_reconciliation')
            .select(COLUMNS)
            .where('mre_realm_id', '=', mreRealmId)
            .where('mre_tenant_id', '=', current.mreTenantId)
            .where('mre_write_back_state', '=', 'PENDING')
            .where('id', '<>', id)
            .orderBy('id')
            .forUpdate()
            .execute()
        ).map(toReconciliation);
        const plan = planWriteBack(current, now, holders.find((h) => holdsLease(h, now)));
        if (plan.kind === 'UNCHANGED') return { kind: 'UNCHANGED', reconciliation: current };
        if (plan.kind !== 'CLAIM') return plan;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        // Another reconciliation's expired lease: FAILED in the same transaction that takes the new one (review on #75).
        for (const expired of holders) {
          await trx
            .updateTable('rent_payment_reconciliation')
            .set({
              mre_write_back_state: 'FAILED',
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
            metadata: { attemptId: expired.mreWriteBackAttemptId, leaseUntil: expired.mreWriteBackLeaseUntil?.toISOString() ?? null, takenOverBy: id },
          });
        }
        const attemptId = randomUUID();
        const leaseUntil = new Date(now.getTime() + leaseMs);
        await trx
          .updateTable('rent_payment_reconciliation')
          .set({
            mre_write_back_state: 'PENDING',
            mre_write_back_attempt_id: attemptId,
            mre_write_back_lease_until: leaseUntil,
            mre_write_back_error: null,
            mre_write_back_failed_at: null,
            version: current.version + 1,
            updated_at: now,
          })
          .where('id', '=', id)
          .execute();
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'WRITE_BACK_STARTED', actor, {
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
      const named = await this.db.selectFrom('rent_payment_reconciliation').select('mre_tenant_id').where('id', '=', id).executeTakeFirstOrThrow();
      const holder = await this.db
        .selectFrom('rent_payment_reconciliation')
        .select('id')
        .where('mre_realm_id', '=', mreRealmId)
        .where('mre_tenant_id', '=', named.mre_tenant_id)
        .where('mre_write_back_state', '=', 'PENDING')
        .executeTakeFirst();
      return { kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: holder?.id ?? id };
    }
  }

  async recordWriteBack(id: string, mreRealmId: string, attemptId: string, result: WriteBackResult, actor: AuditActor): Promise<RecordOutcome> {
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<RecordOutcome> => {
      const row = await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).forUpdate().executeTakeFirst();
      // Only the attempt that holds the lease records; a taken-over one writes nothing (§37.4 step 5).
      if (row === undefined || row.mre_write_back_state !== 'PENDING' || row.mre_write_back_attempt_id !== attemptId) return { kind: 'LEASE_LOST' };
      const current = toReconciliation(row);
      const now = new Date();
      const cleared = { mre_write_back_attempt_id: null, mre_write_back_lease_until: null, version: current.version + 1, updated_at: now };
      const audit = (action: string, metadata: Record<string, unknown>) =>
        writeAudit(trx, { type: ENTITY_TYPE, id }, action, actor, { previousVersion: current.version, newVersion: current.version + 1, metadata: { attemptId, ...metadata } });
      switch (result.kind) {
        case 'WRITTEN':
          await trx
            .updateTable('rent_payment_reconciliation')
            .set({ ...cleared, mre_write_back_state: 'WRITTEN', mre_written_back_at: now, mre_written_back_by: actor.actorId, mre_payment: JSON.stringify(toPaymentColumn(result.payment)) })
            .where('id', '=', id)
            .execute();
          await audit('WRITE_BACK_WRITTEN', { patched: result.patched, payment: toPaymentColumn(result.payment) });
          break;
        case 'FAILED':
          await trx
            .updateTable('rent_payment_reconciliation')
            .set({ ...cleared, mre_write_back_state: 'FAILED', mre_write_back_error: result.error, mre_write_back_failed_at: now })
            .where('id', '=', id)
            .execute();
          await audit('WRITE_BACK_FAILED', { error: result.error });
          break;
        case 'NOT_WRITTEN':
          await trx.updateTable('rent_payment_reconciliation').set({ ...cleared, mre_write_back_state: 'NOT_WRITTEN' }).where('id', '=', id).execute();
          await audit('WRITE_BACK_NOT_ROUND_TRIPPABLE', {});
          break;
      }
      return { kind: 'RECORDED', reconciliation: await readIn(trx, id) };
    });
  }
}

function toPaymentColumn(payment: MrePaymentSnapshot): PaymentColumn {
  return { date: payment.date, amount: payment.amount.toJSON(), type: payment.type, reference: payment.reference };
}

function fromPaymentColumn(value: unknown): MrePaymentSnapshot | null {
  if (value === null || value === undefined) return null;
  const p = value as PaymentColumn;
  return { date: p.date, amount: fromNumericAmount(p.amount.amount, p.amount.currency), type: p.type, reference: p.reference };
}

/** A confirm's cash refusal: the Transaction is known (the foreign key), so TRANSACTION_NOT_FOUND cannot occur. */
function withTransaction<T extends { readonly kind: string }>(refusal: T): Exclude<T, { kind: 'TRANSACTION_NOT_FOUND' }> {
  if (refusal.kind === 'TRANSACTION_NOT_FOUND') throw new Error('a reconciliation names an unknown Transaction');
  return refusal as Exclude<T, { kind: 'TRANSACTION_NOT_FOUND' }>;
}

/**
 * P3-D8's no-op write of the Transaction row (0013 allows it on a confirmed row): it serialises every confirm and
 * release on the Transaction, and a stale one fails under REPEATABLE READ.
 */
async function lockTransaction(trx: Transaction<Database>, transactionId: string, mreRealmId: string) {
  return trx
    .updateTable('ledger_transaction')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', transactionId)
    .where('mre_realm_id', '=', mreRealmId)
    .returning(['status', 'direction', 'correction_role'])
    .executeTakeFirst();
}

/** The cash rules' view of a Transaction of the Realm (P4-D3); `lock` takes the Transaction row first. */
async function cashOf(trx: Transaction<Database>, transactionId: string, mreRealmId: string, lock: boolean): Promise<MatchCash | undefined> {
  if (!UUID.test(transactionId)) return undefined;
  const tx = lock
    ? await lockTransaction(trx, transactionId, mreRealmId)
    : await trx.selectFrom('ledger_transaction').select(['status', 'direction', 'correction_role']).where('id', '=', transactionId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
  if (tx === undefined) return undefined;
  // New statements after the lock: under READ COMMITTED they see every confirm that committed before it.
  const rent = await trx
    .selectFrom('transaction_split as s')
    .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
    .select([sql<string | null>`sum(s.amount)::text`.as('total'), sql<string | null>`min(s.currency)`.as('currency')])
    .where('s.transaction_id', '=', transactionId)
    .where('c.code', 'in', RENT_CATEGORIES)
    .executeTakeFirstOrThrow();
  const confirmed = await trx
    .selectFrom('rent_payment_reconciliation')
    .select(['id', 'mre_tenant_id', 'mre_rent_term', sql<string>`matched_amount::text`.as('matched_amount'), 'currency'])
    .where('transaction_id', '=', transactionId)
    .where('status', '=', 'CONFIRMED')
    .orderBy('id')
    .execute();
  return {
    status: tx.status,
    direction: tx.direction,
    correctionRole: tx.correction_role,
    rentCash: rent.total === null || rent.currency === null ? null : fromNumericAmount(rent.total, rent.currency),
    confirmed: confirmed.map((c) => ({ id: c.id, mreTenantId: c.mre_tenant_id, mreRentTerm: c.mre_rent_term, matchedAmount: fromNumericAmount(c.matched_amount, c.currency) })),
  };
}

async function readIn(trx: Transaction<Database>, id: string): Promise<RentPaymentReconciliation> {
  return toReconciliation(await trx.selectFrom('rent_payment_reconciliation').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

function toReconciliation(row: ReconciliationRow): RentPaymentReconciliation {
  return {
    id: row.id as RentPaymentReconciliationId,
    mreRealmId: row.mre_realm_id,
    status: row.status as ReconciliationStatus,
    transactionId: row.transaction_id,
    mreTenantId: row.mre_tenant_id,
    mreRentTerm: row.mre_rent_term,
    matchedAmount: fromNumericAmount(row.matched_amount, row.currency),
    confidence: row.confidence,
    suggestionReason: row.suggestion_reason,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    releasedAt: row.released_at,
    releasedBy: row.released_by,
    releaseReason: row.release_reason,
    rejectedAt: row.rejected_at,
    rejectedBy: row.rejected_by,
    rejectReason: row.reject_reason,
    notes: row.notes,
    mreWriteBackState: row.mre_write_back_state as MreWriteBackState,
    mreWriteBackAttemptId: row.mre_write_back_attempt_id,
    mreWriteBackLeaseUntil: row.mre_write_back_lease_until,
    mreWrittenBackAt: row.mre_written_back_at,
    mreWrittenBackBy: row.mre_written_back_by,
    mrePayment: fromPaymentColumn(row.mre_payment),
    mreWriteBackError: row.mre_write_back_error as WriteBackError | null,
    mreWriteBackFailedAt: row.mre_write_back_failed_at,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created reconciliation as JSON for the idempotency store. */
function toSnapshot(r: RentPaymentReconciliation): unknown {
  return {
    ...r,
    matchedAmount: r.matchedAmount.toJSON(),
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    releasedAt: r.releasedAt?.toISOString() ?? null,
    rejectedAt: r.rejectedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    // A created reconciliation is NOT_WRITTEN: nothing of the write-back is stored with its replay.
    mreWriteBackAttemptId: null,
    mreWriteBackLeaseUntil: null,
    mreWrittenBackAt: null,
    mreWrittenBackBy: null,
    mrePayment: null,
    mreWriteBackError: null,
    mreWriteBackFailedAt: null,
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): RentPaymentReconciliation {
  const r = result as Omit<RentPaymentReconciliation, 'matchedAmount' | 'confirmedAt' | 'releasedAt' | 'rejectedAt' | 'createdAt'> & {
    rejectedAt?: string | null;
    matchedAmount: { amount: string; currency: string };
    confirmedAt: string | null;
    releasedAt: string | null;
    createdAt: string;
  };
  return {
    ...r,
    matchedAmount: fromNumericAmount(r.matchedAmount.amount, r.matchedAmount.currency),
    confirmedAt: r.confirmedAt === null ? null : new Date(r.confirmedAt),
    releasedAt: r.releasedAt === null ? null : new Date(r.releasedAt),
    rejectedAt: r.rejectedAt == null ? null : new Date(r.rejectedAt),
    rejectedBy: r.rejectedBy ?? null,
    rejectReason: r.rejectReason ?? null,
    mreWriteBackAttemptId: null,
    mreWriteBackLeaseUntil: null,
    mreWrittenBackAt: null,
    mreWrittenBackBy: null,
    mrePayment: null,
    mreWriteBackError: null,
    mreWriteBackFailedAt: null,
    createdAt: new Date(r.createdAt),
  };
}
