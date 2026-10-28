import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PostgresCorrectionRepository } from './correction-repository.js';
import type { PostgresRentReconciliationRepository } from './rent-reconciliation-repository.js';
import {
  databaseUrl,
  REALM,
  OTHER_REALM,
  actor,
  day,
  eur,
  split,
  waitForLocks,
  reasonOf,
  useRentReconciliationDatabase,
} from './rent-reconciliation.test-support.js';

/**
 * VC-4-03 persistence (api-design.md §37.3): suggest, confirm and reject in `rent-suggestion-store.ts`.
 */
describe.skipIf(databaseUrl === undefined)('RentPaymentReconciliation suggestions (§37.3)', () => {
  const { ctx, transaction, match, created, rawInsert } = useRentReconciliationDatabase('rent_suggestion_test');
  let pool: pg.Pool;
  let corrections: PostgresCorrectionRepository;
  let repository: PostgresRentReconciliationRepository;
  beforeAll(() => {
    ({ pool, corrections, repository } = ctx);
  });

  describe('suggestions (§37.3)', () => {
    const SUG_REALM_TENANT = '6512f0c2a1b2c3d4e5f60b01';
    const suggestion = (transactionId: string, amount = '800.00', term = '2027050100', tenant = SUG_REALM_TENANT) => ({
      transactionId,
      mreTenantId: tenant,
      mreRentTerm: term,
      matchedAmount: eur(amount),
      confidence: 'MEDIUM' as const,
      suggestionReason: 'EXACT_AMOUNT' as const,
    });
    const suggested = async (transactionId: string, amount = '800.00', term = '2027050100', tenant = SUG_REALM_TENANT) => {
      const [written] = await repository.writeSuggestions(REALM, [suggestion(transactionId, amount, term, tenant)], actor);
      if (written === undefined) throw new Error('not written');
      return written;
    };

    it('suggestionSnapshot: counted INFLOW with available cash in the window; term sums; handled and open pairs; the IBAN history', async () => {
      const inWindow = await transaction([split('800.00')], { bookingDate: '2027-05-03', iban: 'DE11' });
      const consumed = await transaction([split('800.00')], { bookingDate: '2027-05-04' });
      await created(match(consumed, '800.00', '2027040100', SUG_REALM_TENANT));
      const late = await transaction([split('800.00')], { bookingDate: '2027-07-01' });
      const open = await transaction([split('800.00')], { bookingDate: '2027-05-06', confirm: false });
      const outflow = await transaction([split('800.00')], { bookingDate: '2027-05-07', direction: 'OUTFLOW' });
      const partly = await transaction([split('900.00')], { bookingDate: '2027-05-08', iban: 'DE22' });
      await created(match(partly, '100.00', '2027050100', SUG_REALM_TENANT));
      const pending = await suggested(inWindow, '800.00', '2027060100');
      const snapshot = await repository.suggestionSnapshot(
        REALM,
        [{ mreTenantId: SUG_REALM_TENANT, mreRentTerm: '2027050100' }],
        day('2027-04-15'),
        day('2027-06-30'),
      );
      const ids = snapshot.candidates.map((c) => c.transactionId);
      expect(ids).toContain(inWindow);
      expect(ids).toContain(partly);
      for (const excluded of [consumed, late, open, outflow]) expect(ids).not.toContain(excluded);
      expect(snapshot.candidates.find((c) => c.transactionId === partly)).toMatchObject({
        available: eur('800.00'),
        counterpartyIban: 'DE22',
        bookingDate: '2027-05-08',
      });
      expect(snapshot.confirmedByTerm.get(`${SUG_REALM_TENANT}/2027050100`)).toEqual(eur('100.00'));
      expect(snapshot.open).toContainEqual({ transactionId: pending.transactionId, mreTenantId: SUG_REALM_TENANT, mreRentTerm: '2027060100' });
      expect(snapshot.handled).toContainEqual({ transactionId: partly, mreTenantId: SUG_REALM_TENANT, mreRentTerm: '2027050100' });
      expect(snapshot.history).toContainEqual({ mreTenantId: SUG_REALM_TENANT, counterpartyIban: 'DE22' });
      expect((await repository.suggestionSnapshot(OTHER_REALM, [], day('2027-04-15'), day('2027-06-30'))).candidates).toEqual([]);
    });

    it('writeSuggestions: SUGGESTED with an AuditRecord; a pair changed in between or already handled is skipped', async () => {
      const t = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const changed = await transaction([split('800.00')], { bookingDate: '2027-05-04' });
      await created(match(changed, '100.00', '2027010100'));
      const written = await repository.writeSuggestions(REALM, [suggestion(t), suggestion(changed)], actor);
      expect(written.map((w) => [w.transactionId, w.status, w.confidence, w.suggestionReason, w.version])).toEqual([
        [t, 'SUGGESTED', 'MEDIUM', 'EXACT_AMOUNT', 1],
      ]);
      expect(await repository.writeSuggestions(REALM, [suggestion(t)], actor)).toEqual([]);
      const audit = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1`, [written[0]?.id]);
      expect(audit.rows).toEqual([
        {
          action: 'SUGGESTED',
          metadata: {
            transactionId: t,
            mreTenantId: SUG_REALM_TENANT,
            mreRentTerm: '2027050100',
            matchedAmount: { amount: '800.00', currency: 'EUR' },
            confidence: 'MEDIUM',
            suggestionReason: 'EXACT_AMOUNT',
          },
        },
      ]);
      // A suggestion never counts: the whole cash stays available for a manual match.
      expect((await repository.precheck(match(t, '800.00', '2027090100'))).kind).toBe('PROCEED');
    });

    it('confirm: lowers the amount, a repeat is a no-op, the refusals in order; AuditRecord CONFIRMED with manual = false', async () => {
      const t = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const s1 = await suggested(t, '800.00', '2027110100');
      expect(await repository.confirmPrecheck(s1.id, OTHER_REALM, undefined)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.confirmPrecheck(s1.id, REALM, eur('800.01'))).toEqual({ kind: 'ABOVE_SUGGESTION', suggested: eur('800.00') });
      expect(await repository.confirmPrecheck(s1.id, REALM, eur('700.00'))).toMatchObject({ kind: 'PROCEED', amount: eur('700.00') });
      expect(await repository.confirm(s1.id, REALM, eur('700.00'), eur('600.00'), actor)).toEqual({ kind: 'SUGGESTION_STALE', openAmount: eur('600.00') });
      expect(await repository.confirm(s1.id, REALM, eur('700.00'), eur('800.00'), actor, [9])).toEqual({
        kind: 'VERSION_CONFLICT',
        expectedVersions: [9],
        currentVersion: 1,
      });
      const done = await repository.confirm(s1.id, REALM, eur('700.00'), eur('800.00'), actor, [1]);
      expect(done).toMatchObject({
        kind: 'CONFIRMED',
        changed: true,
        reconciliation: { status: 'CONFIRMED', matchedAmount: eur('700.00'), confirmedBy: actor.actorId, confidence: 'MEDIUM', version: 2 },
      });
      expect(await repository.confirm(s1.id, REALM, undefined, eur('800.00'), actor, [1])).toMatchObject({ kind: 'CONFIRMED', changed: false });
      expect(await repository.confirmPrecheck(s1.id, REALM, eur('600.00'))).toEqual({ kind: 'NOT_CONFIRMABLE', status: 'CONFIRMED' });
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'CONFIRMED'`, [s1.id]);
      expect(audit.rows[0].metadata).toMatchObject({
        manual: false,
        suggestedAmount: { amount: '800.00', currency: 'EUR' },
        matchedAmount: { amount: '700.00', currency: 'EUR' },
      });
      // The cash rules: a second suggestion over the rest of t confirms only within the available 100.00.
      const s2 = await suggested(t, '100.00', '2027060100');
      expect(await repository.confirmPrecheck(s2.id, REALM, undefined)).toMatchObject({ kind: 'PROCEED' });
      await created(match(t, '50.00', '2027070100'));
      expect(await repository.confirm(s2.id, REALM, undefined, eur('800.00'), actor)).toEqual({
        kind: 'RENT_CASH_EXCEEDED',
        rentCash: eur('800.00'),
        available: eur('50.00'),
      });
    });

    it('reject: final with the reason; a repeat is a no-op; CONFIRMED and RELEASED not rejectable; If-Match', async () => {
      const t = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const s1 = await suggested(t);
      expect(await repository.reject(s1.id, OTHER_REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await repository.reject(s1.id, REALM, 'x', new Date(), actor, [5])).toEqual({
        kind: 'VERSION_CONFLICT',
        expectedVersions: [5],
        currentVersion: 1,
      });
      const first = await repository.reject(s1.id, REALM, 'anderer Mieter', new Date(), actor, [1]);
      expect(first).toMatchObject({
        kind: 'REJECTED',
        changed: true,
        reconciliation: { status: 'REJECTED', rejectReason: 'anderer Mieter', rejectedBy: actor.actorId, version: 2 },
      });
      expect(await repository.reject(s1.id, REALM, 'zweiter', new Date(), actor)).toMatchObject({
        kind: 'REJECTED',
        changed: false,
        reconciliation: { rejectReason: 'anderer Mieter' },
      });
      const audit = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at`, [s1.id]);
      expect(audit.rows.map((r) => r.action)).toEqual(['SUGGESTED', 'REJECTED']);
      // A rejected pair is handled: in the snapshot, and never written again while its cash is still all available.
      const snapshot = await repository.suggestionSnapshot(REALM, [], day('2027-05-01'), day('2027-05-31'));
      expect(snapshot.handled).toContainEqual({ transactionId: t, mreTenantId: SUG_REALM_TENANT, mreRentTerm: '2027050100' });
      expect(snapshot.open).not.toContainEqual({ transactionId: t, mreTenantId: SUG_REALM_TENANT, mreRentTerm: '2027050100' });
      expect(await repository.writeSuggestions(REALM, [suggestion(t)], actor)).toEqual([]);
      const s2 = await suggested(t, '800.00', '2027060100');
      await repository.confirm(s2.id, REALM, undefined, eur('800.00'), actor);
      expect(await repository.reject(s2.id, REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_REJECTABLE', status: 'CONFIRMED' });
    });

    it("concurrency: a run waiting on another run's pair skips it; a confirm waiting on a manual match of the same cash (RC), RR 40001", async () => {
      const t = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const raw = `INSERT INTO rent_payment_reconciliation (mre_realm_id, status, transaction_id, mre_tenant_id, mre_rent_term, matched_amount, currency, confidence, suggestion_reason, created_by)
        VALUES ('${REALM}', 'SUGGESTED', '${t}', '${SUG_REALM_TENANT}', '2027050100', 800, 'EUR', 'MEDIUM', 'EXACT_AMOUNT', 'x')`;
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(raw);
        const writing = repository.writeSuggestions(REALM, [suggestion(t)], actor);
        await waitForLocks(pool);
        await holder.query('COMMIT');
        expect(await writing).toEqual([]);
      } finally {
        holder.release();
      }
      const [s1] = (await repository.list(REALM, { transactionId: t, status: ['SUGGESTED'] }, { page: 1, pageSize: 5 })).items;
      const holder2 = await pool.connect();
      try {
        await holder2.query('BEGIN');
        await holder2.query(rawInsert(t, '800.00', '2027080100'));
        const confirming = repository.confirm(s1?.id ?? '', REALM, undefined, eur('800.00'), actor);
        await waitForLocks(pool);
        await holder2.query('COMMIT');
        expect(await confirming).toEqual({ kind: 'RENT_CASH_EXCEEDED', rentCash: eur('800.00'), available: eur('0.00') });
      } finally {
        holder2.release();
      }
      const u = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const s2 = await suggested(u);
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await two.query(rawInsert(u, '800.00', '2027080100'));
        const later = one
          .query(
            `UPDATE rent_payment_reconciliation SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', version = version + 1 WHERE id = '${s2.id}'`,
          )
          .then(
            () => 'written',
            (e: { code?: string }) => e.code,
          );
        await waitForLocks(pool);
        await two.query('COMMIT');
        expect(await later).toBe('40001');
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    });

    it('concurrency: a confirm against a reversal of its Transaction (RC: the reversal wins); RR, the step to CORRECTED after a confirm: 40001', async () => {
      const t = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const s1 = await suggested(t);
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM ledger_transaction WHERE id = $1 FOR UPDATE`, [t]);
        const reversing = corrections.correct(t, REALM, { reason: 'x', replacement: null }, actor);
        await waitForLocks(pool, 1);
        const confirming = repository.confirm(s1.id, REALM, undefined, eur('800.00'), actor);
        await waitForLocks(pool, 2);
        await holder.query('ROLLBACK');
        expect((await reversing).kind).toBe('CORRECTED');
        expect(await confirming).toEqual({ kind: 'TRANSACTION_NOT_COUNTED', status: 'CORRECTED', correctionRole: null });
      } finally {
        holder.release();
      }
      const u = await transaction([split('800.00')], { bookingDate: '2027-05-03' });
      const s2 = await suggested(u);
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await two.query(
          `UPDATE rent_payment_reconciliation SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', version = version + 1 WHERE id = '${s2.id}'`,
        );
        const later = one.query(`UPDATE ledger_transaction SET status = 'CORRECTED', version = version + 1 WHERE id = '${u}'`).then(
          () => 'written',
          (e: { code?: string }) => e.code,
        );
        await waitForLocks(pool);
        await two.query('COMMIT');
        expect(await later).toBe('40001');
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    });

    it('schema (0031): suggestion fields, rejected fields, the SUGGESTED index, the amount only lowered on confirm, SUGGESTED only on counted INFLOW rent cash', async () => {
      const attempt = (query: string) => pool.query(query).then(() => 'accepted', reasonOf);
      // 900.00 of rent cash: a raise to 800.01 passes the cash guard and meets the frozen rule.
      const t = await transaction([split('900.00')], { bookingDate: '2027-05-03' });
      const sug = (tx: string, extra = `'MEDIUM', 'EXACT_AMOUNT'`, term = '2027050100') =>
        `INSERT INTO rent_payment_reconciliation (mre_realm_id, status, transaction_id, mre_tenant_id, mre_rent_term, matched_amount, currency, confidence, suggestion_reason, created_by)
         VALUES ('${REALM}', 'SUGGESTED', '${tx}', '${SUG_REALM_TENANT}', '${term}', 800, 'EUR', ${extra}, 'x') RETURNING id`;
      expect(await attempt(sug(t, 'NULL, NULL'))).toBe('rent_payment_reconciliation_suggestion_fields');
      expect(await attempt(sug(t, `'MEDIUM', 'GUESS'`))).toBe('rent_payment_reconciliation_suggestion_fields');
      expect(await attempt(sug(await transaction([split('800.00')], { confirm: false })))).toBe('(TRANSACTION_NOT_COUNTED)');
      expect(await attempt(sug(await transaction([split('800.00')], { direction: 'OUTFLOW' })))).toBe('(TRANSACTION_NOT_INFLOW)');
      expect(await attempt(sug(await transaction([split('800.00', 'INSURANCE')])))).toBe('(NO_RENT_CASH)');
      const { rows } = await pool.query(sug(t));
      const id = rows[0].id as string;
      expect(await attempt(sug(t))).toBe('rent_payment_reconciliation_suggested_key');
      const set = (assignment: string) => attempt(`UPDATE rent_payment_reconciliation SET ${assignment} WHERE id = '${id}'`);
      expect(await set(`status = 'REJECTED', version = version + 1`)).toBe('rent_payment_reconciliation_rejected_fields');
      expect(await set(`status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', matched_amount = 800.01, version = version + 1`)).toBe(
        'only lowered when a suggestion is confirmed',
      );
      expect(await set(`matched_amount = 700, version = version + 1`)).toBe('only lowered when a suggestion is confirmed');
      expect(await set(`status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', matched_amount = 700, version = version + 1`)).toBe('accepted');
      expect(await set(`status = 'RELEASED', released_at = now(), released_by = 'x', release_reason = 'x', matched_amount = 600, version = version + 1`)).toBe(
        'only lowered when a suggestion is confirmed',
      );
    });
  });
});
