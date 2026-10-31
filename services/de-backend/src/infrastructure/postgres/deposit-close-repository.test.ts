import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate, Direction, SplitInput } from '../../domains/ledger/index.js';
import type { CloseRequest, DepositView, SecurityDeposit } from '../../domains/security-deposit/index.js';
import { Money } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { PostgresSecurityDepositRepository } from './security-deposit-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresUnconfirmedTransactionRepository } from './unconfirmed-transaction-repository.js';

/**
 * VC-5-04 persistence (api-design.md §47.4): close and reopen with their order of checks, what a `CLOSED` deposit
 * refuses (new splits, amends other than `notes`, a void) and allows (a reversal, a keeping replacement), the flag
 * `HELD_CHANGED_AFTER_CLOSING`, concurrency with split writes (RC and RR), and migration 0039 past the repository.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000056';
const OTHER_REALM = '64b0c0ffee00000000000057';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, financialCategoryCode: string, securityDepositId: string | null): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId: null,
  loanId: null,
  securityDepositId,
  description: null,
});
const closeAs = (
  reason: CloseRequest['reason'],
  closingDate = '2027-06-30',
  closingNote: string | null = reason === 'RETURNED' ? null : 'Nebenkosten',
): CloseRequest => ({
  closingDate: day(closingDate),
  reason,
  closingNote,
});
let tenantCounter = 0;
const nextTenant = () => `6512f0c2a1b5${(++tenantCounter).toString(16).padStart(12, '0')}`;

async function waitForLocks(pool: pg.Pool, count = 1): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (
    Number((await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].count) < count
  ) {
    if (Date.now() > deadline) throw new Error(`fewer than ${count} sessions wait on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The trigger's own reason or the constraint's name, to tell guards apart that share an error code. */
function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return (
    error.constraint ??
    /\(([A-Z_]+)\)|not a step|only notes change|a step changes nothing else|VOID is final|exactly one/.exec(error.message ?? '')?.[0] ??
    error.code ??
    'error'
  );
}

describe.skipIf(databaseUrl === undefined)('Security deposit close and reopen (§47.4)', () => {
  const schema = testSchemaName('deposit_close_test');
  let pool: pg.Pool;
  let deposits: PostgresSecurityDepositRepository;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let corrections: PostgresCorrectionRepository;
  let unconfirmed: PostgresUnconfirmedTransactionRepository;
  let giro = '';

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    deposits = new PostgresSecurityDepositRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    unconfirmed = new PostgresUnconfirmedTransactionRepository(db);
    const created = await accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    giro = created.account.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function deposit(realm = REALM): Promise<SecurityDeposit> {
    const outcome = await deposits.create(
      {
        mreRealmId: realm,
        mreTenantId: nextTenant(),
        expectedAmount: eur('3000.00'),
        expectedAmountSource: 'REQUEST',
        holdingFinancialAccountId: null,
        interestBearing: true,
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.deposit;
  }
  /** An unconfirmed Transaction of the amount, with the given splits if any. */
  async function transaction(amount: string, options: { direction?: Direction; bookingDate?: string; set?: readonly SplitInput[] } = {}): Promise<string> {
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: giro,
        amount: eur(amount),
        direction: options.direction ?? 'INFLOW',
        bookingDate: day(options.bookingDate ?? '2027-02-01'),
        valueDate: null,
        description: 'Kaution',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    if (options.set !== undefined) {
      const replaced = await splits.replaceSplits(created.transaction.id, REALM, options.set, actor);
      if (replaced.kind !== 'REPLACED') throw new Error(JSON.stringify(replaced));
    }
    return created.transaction.id;
  }
  /** A confirmed deposit split of the amount: a receipt (INFLOW) or a repayment (OUTFLOW). */
  async function booked(depositId: string, amount: string, options: { direction?: Direction; bookingDate?: string; confirm?: boolean } = {}): Promise<string> {
    const id = await transaction(amount, { ...options, set: [split(amount, 'SECURITY_DEPOSIT', depositId)] });
    if (options.confirm !== false) {
      const confirmed = await transactions.confirm(id, REALM, actor);
      if (confirmed.kind !== 'CONFIRMED') throw new Error(confirmed.kind);
    }
    return id;
  }
  async function closed(depositId: string, request: CloseRequest): Promise<DepositView> {
    const outcome = await deposits.close(depositId, REALM, request, actor);
    if (outcome.kind !== 'CLOSED') throw new Error(JSON.stringify(outcome));
    return outcome.deposit;
  }
  const audits = async (id: string) =>
    (await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_type = 'SecurityDeposit' AND entity_id = $1 ORDER BY new_version`, [id])).rows;
  const closingOf = (d: DepositView | SecurityDeposit | undefined) =>
    d?.closing == null ? null : { ...d.closing, heldAtClosing: d.closing.heldAtClosing.amount };

  describe('close', () => {
    it('RETURNED after full repayment: CLOSED, closing stored, version + 1, AuditRecord CLOSED; the same values again are a no-op', async () => {
      const d = await deposit();
      await booked(d.id, '3000.00', { bookingDate: '2027-02-01' });
      await booked(d.id, '3000.00', { direction: 'OUTFLOW', bookingDate: '2027-06-15' });
      const c = await closed(d.id, closeAs('RETURNED'));
      expect([c.status, c.figures.state, c.version, c.figures.flags]).toEqual(['CLOSED', 'CLOSED', 2, []]);
      expect(closingOf(c)).toEqual({ closingDate: '2027-06-30', reason: 'RETURNED', closingNote: null, heldAtClosing: '0.00' });
      expect(closingOf(await deposits.findById(d.id, REALM))).toEqual(closingOf(c));
      const again = await deposits.close(d.id, REALM, closeAs('RETURNED'), actor, [99]);
      expect(again).toMatchObject({ kind: 'CLOSED', changed: false, deposit: { version: 2 } });
      expect((await audits(d.id)).map((a) => a.action)).toEqual(['CREATED', 'CLOSED']);
      expect((await audits(d.id))[1].metadata).toEqual({
        closingDate: '2027-06-30',
        reason: 'RETURNED',
        closingNote: null,
        heldAtClosing: { amount: '0.00', currency: 'EUR' },
      });
      // Other values on a CLOSED deposit, and a VOID one: DEPOSIT_NOT_ACTIVE.
      expect(await deposits.close(d.id, REALM, closeAs('RETURNED', '2027-07-01'), actor)).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', status: 'CLOSED' });
      expect(await deposits.close(d.id, REALM, { ...closeAs('RETURNED'), closingNote: 'x' }, actor)).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', status: 'CLOSED' });
      const voided = await deposit();
      await deposits.void(voided.id, REALM, 'falsch', new Date(), actor);
      expect(await deposits.close(voided.id, REALM, closeAs('RETURNED'), actor)).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', status: 'VOID' });
    });

    it('RETAINED keeps the held part; RETURNED with cash held is DEPOSIT_STILL_HELD; OTHER takes any held', async () => {
      const d = await deposit();
      await booked(d.id, '3000.00');
      await booked(d.id, '2500.00', { direction: 'OUTFLOW', bookingDate: '2027-06-01' });
      expect(await deposits.close(d.id, REALM, closeAs('RETURNED'), actor)).toEqual({ kind: 'DEPOSIT_STILL_HELD', held: eur('500.00') });
      const c = await closed(d.id, closeAs('RETAINED'));
      expect(closingOf(c)).toEqual({ closingDate: '2027-06-30', reason: 'RETAINED', closingNote: 'Nebenkosten', heldAtClosing: '500.00' });
      const other = await deposit();
      await booked(other.id, '3000.00');
      expect(closingOf(await closed(other.id, closeAs('OTHER')))).toMatchObject({ reason: 'OTHER', heldAtClosing: '3000.00' });
    });

    it('RETAINED with nothing held, or with more repaid than held: NOTHING_RETAINED with the signed held; RETURNED then closes', async () => {
      const empty = await deposit();
      expect(await deposits.close(empty.id, REALM, closeAs('RETAINED'), actor)).toEqual({ kind: 'NOTHING_RETAINED', held: eur('0.00') });
      const over = await deposit();
      await booked(over.id, '100.00');
      await booked(over.id, '105.00', { direction: 'OUTFLOW' });
      expect(await deposits.close(over.id, REALM, closeAs('RETAINED'), actor)).toEqual({ kind: 'NOTHING_RETAINED', held: eur('-5.00') });
      // More repaid than held is RETURNED (review on #136), with the flag of §47.3 and nothing retained.
      const c = await closed(over.id, closeAs('RETURNED'));
      expect(closingOf(c)).toMatchObject({ reason: 'RETURNED', heldAtClosing: '-5.00' });
      expect(c.figures.flags.map((f) => f.code)).toEqual(['RETURNED_EXCEEDS_HELD']);
    });

    it('CASH_AFTER_CLOSING_DATE: counted and open cash after the date, in booking-date order; a reversed one drops out', async () => {
      const d = await deposit();
      await booked(d.id, '3000.00');
      const later = await booked(d.id, '10.00', { bookingDate: '2027-08-01' });
      const open = await booked(d.id, '20.00', { bookingDate: '2027-07-15', confirm: false });
      expect(await deposits.close(d.id, REALM, closeAs('OTHER'), actor)).toEqual({ kind: 'CASH_AFTER_CLOSING_DATE', transactionIds: [open, later] });
      // On the closing date itself it belongs to the deposit.
      expect(await deposits.close(d.id, REALM, closeAs('OTHER', '2027-08-01'), actor)).toEqual({ kind: 'UNCONFIRMED_CASH', transactionIds: [open] });
      await splits.replaceSplits(open, REALM, [split('20.00', 'OTHER', null)], actor);
      expect((await corrections.correct(later, REALM, { reason: 'doppelt', replacement: null }, actor)).kind).toBe('CORRECTED');
      expect(closingOf(await closed(d.id, closeAs('OTHER')))).toMatchObject({ heldAtClosing: '3000.00' });
    });

    it('UNCONFIRMED_CASH: an open split on or before the date, after the date check; refusals before 412; unknown, foreign, malformed: NOT_FOUND', async () => {
      const d = await deposit();
      await booked(d.id, '3000.00');
      const open = await booked(d.id, '1.00', { bookingDate: '2027-06-30', confirm: false });
      expect(await deposits.close(d.id, REALM, closeAs('OTHER'), actor, [99])).toEqual({ kind: 'UNCONFIRMED_CASH', transactionIds: [open] });
      await transactions.confirm(open, REALM, actor);
      expect(await deposits.close(d.id, REALM, closeAs('OTHER'), actor, [99])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [99], currentVersion: 1 });
      expect(await deposits.close(d.id, REALM, closeAs('OTHER'), actor, [1])).toMatchObject({ kind: 'CLOSED', changed: true });
      const foreign = await deposit(OTHER_REALM);
      for (const id of [foreign.id, '00000000-0000-4000-8000-000000000000', 'nope']) {
        expect(await deposits.close(id, REALM, closeAs('OTHER'), actor)).toEqual({ kind: 'NOT_FOUND' });
        expect(await deposits.reopen(id, REALM, actor)).toEqual({ kind: 'NOT_FOUND' });
      }
    });
  });

  describe('reopen', () => {
    it('CLOSED → ACTIVE with the closing cleared and kept in the AuditRecord; ACTIVE a no-op; VOID DEPOSIT_NOT_CLOSED; 412', async () => {
      const d = await deposit();
      expect(await deposits.reopen(d.id, REALM, actor, [99])).toMatchObject({ kind: 'REOPENED', changed: false, deposit: { status: 'ACTIVE', version: 1 } });
      await closed(d.id, closeAs('OTHER'));
      expect(await deposits.reopen(d.id, REALM, actor, [1])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [1], currentVersion: 2 });
      const reopened = await deposits.reopen(d.id, REALM, actor, [2]);
      expect(reopened).toMatchObject({ kind: 'REOPENED', changed: true, deposit: { status: 'ACTIVE', closing: null, version: 3 } });
      const trail = await audits(d.id);
      expect(trail.map((a) => a.action)).toEqual(['CREATED', 'CLOSED', 'REOPENED']);
      expect(trail[2].metadata).toEqual({
        cleared: { closingDate: '2027-06-30', reason: 'OTHER', closingNote: 'Nebenkosten', heldAtClosing: { amount: '0.00', currency: 'EUR' } },
      });
      const voided = await deposit();
      await deposits.void(voided.id, REALM, 'falsch', new Date(), actor);
      expect(await deposits.reopen(voided.id, REALM, actor)).toEqual({ kind: 'DEPOSIT_NOT_CLOSED', status: 'VOID' });
    });

    it('a late statement: reopen, link the late cash, close again through every check', async () => {
      const d = await deposit();
      await booked(d.id, '3000.00');
      await booked(d.id, '3000.00', { direction: 'OUTFLOW', bookingDate: '2027-06-15' });
      await closed(d.id, closeAs('RETURNED'));
      const late = await transaction('2.40', { bookingDate: '2027-06-20' });
      expect(await splits.replaceSplits(late, REALM, [split('2.40', 'SECURITY_DEPOSIT_INTEREST', d.id)], actor)).toEqual({
        kind: 'DEPOSIT_CLOSED',
        securityDepositId: d.id,
      });
      await deposits.reopen(d.id, REALM, actor);
      await splits.replaceSplits(late, REALM, [split('2.40', 'SECURITY_DEPOSIT_INTEREST', d.id)], actor);
      expect(await deposits.close(d.id, REALM, closeAs('RETURNED'), actor)).toEqual({ kind: 'UNCONFIRMED_CASH', transactionIds: [late] });
      await transactions.confirm(late, REALM, actor);
      expect(await deposits.close(d.id, REALM, closeAs('RETURNED'), actor)).toEqual({ kind: 'DEPOSIT_STILL_HELD', held: eur('2.40') });
      await booked(d.id, '2.40', { direction: 'OUTFLOW', bookingDate: '2027-06-25' });
      expect(closingOf(await closed(d.id, closeAs('RETURNED')))).toMatchObject({ heldAtClosing: '0.00' });
      expect((await audits(d.id)).map((a) => a.action)).toEqual(['CREATED', 'CLOSED', 'REOPENED', 'CLOSED']);
    });
  });

  describe('effects of CLOSED', () => {
    it('a new split is refused whatever its booking date; a reversal and a keeping replacement pass, then HELD_CHANGED_AFTER_CLOSING', async () => {
      const d = await deposit();
      const receipt = await booked(d.id, '3000.00');
      await closed(d.id, closeAs('OTHER'));
      const before = await transaction('1.00', { bookingDate: '2027-03-01' });
      expect(await splits.replaceSplits(before, REALM, [split('1.00', 'SECURITY_DEPOSIT', d.id)], actor)).toEqual({
        kind: 'DEPOSIT_CLOSED',
        securityDepositId: d.id,
      });
      // A replacement that names the deposit anew (its original did not) is refused too.
      const rent = await transaction('1.00');
      await splits.replaceSplits(rent, REALM, [split('1.00', 'RENT_BASE', null)], actor);
      await transactions.confirm(rent, REALM, actor);
      expect(await corrections.correct(rent, REALM, { reason: 'Kaution', replacement: { splits: [split('1.00', 'SECURITY_DEPOSIT', d.id)] } }, actor)).toEqual({
        kind: 'DEPOSIT_CLOSED',
        securityDepositId: d.id,
      });
      // A replacement whose original names the deposit keeps it, with another amount.
      const corrected = await corrections.correct(
        receipt,
        REALM,
        { reason: 'Betrag', replacement: { amount: eur('2900.00'), splits: [split('2900.00', 'SECURITY_DEPOSIT', d.id)] } },
        actor,
      );
      if (corrected.kind !== 'CORRECTED' || corrected.result.replacement === null) throw new Error(corrected.kind);
      const after = await deposits.findById(d.id, REALM);
      expect([after?.status, after?.figures.held.amount, after?.figures.flags]).toEqual([
        'CLOSED',
        '2900.00',
        [{ code: 'HELD_CHANGED_AFTER_CLOSING', details: { heldAtClosing: eur('3000.00'), held: eur('2900.00') } }],
      ]);
      // A reversal mirrors its original: the replacement is reversed, nothing counts any more.
      expect((await corrections.correct(corrected.result.replacement.id, REALM, { reason: 'doppelt', replacement: null }, actor)).kind).toBe('CORRECTED');
      expect((await deposits.findById(d.id, REALM))?.figures.held.amount).toBe('0.00');
    });

    it('amend: notes only; any other field DEPOSIT_NOT_ACTIVE; void DEPOSIT_CLOSED', async () => {
      const d = await deposit();
      await closed(d.id, closeAs('OTHER'));
      expect(await deposits.amend(d.id, REALM, { notes: 'Schlussabrechnung' }, actor)).toMatchObject({
        kind: 'AMENDED',
        changed: true,
        deposit: { notes: 'Schlussabrechnung' },
      });
      expect(await deposits.amend(d.id, REALM, { interestBearing: false }, actor)).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', status: 'CLOSED' });
      expect(await deposits.amend(d.id, REALM, { expectedAmount: eur('3000.00') }, actor)).toMatchObject({ kind: 'AMENDED', changed: false });
      expect(await deposits.void(d.id, REALM, 'x', new Date(), actor)).toEqual({ kind: 'DEPOSIT_CLOSED' });
      expect(closingOf(await deposits.findById(d.id, REALM))).toMatchObject({ reason: 'OTHER' });
    });
  });

  describe('concurrency (the deposit row, P5-D9)', () => {
    const rawSplit = (transactionId: string, depositId: string) =>
      `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, security_deposit_id, created_by)
       SELECT '${transactionId}', '${REALM}', 1, 1.00, 'EUR', id, '${depositId}', 'x' FROM financial_category WHERE code = 'SECURITY_DEPOSIT'`;
    const rawClose = (depositId: string) =>
      `UPDATE security_deposit SET status = 'CLOSED', closing_date = '2027-06-30', closing_reason = 'OTHER', closing_note = 'x', held_at_closing = 0,
         version = version + 1 WHERE id = '${depositId}'`;

    it('READ COMMITTED, a split write first: the close waits on the deposit row and answers UNCONFIRMED_CASH', async () => {
      const d = await deposit();
      const id = await transaction('1.00');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(rawSplit(id, d.id));
        const closing = deposits.close(d.id, REALM, closeAs('OTHER'), actor);
        await waitForLocks(pool);
        await holder.query('COMMIT');
        expect(await closing).toEqual({ kind: 'UNCONFIRMED_CASH', transactionIds: [id] });
      } finally {
        holder.release();
      }
    });

    it('READ COMMITTED, a close first: the split write waits on the deposit row and answers DEPOSIT_CLOSED; after a reopen it passes', async () => {
      const d = await deposit();
      const id = await transaction('1.00');
      for (const step of ['close', 'reopen'] as const) {
        const holder = await pool.connect();
        try {
          await holder.query('BEGIN');
          if (step === 'close') await holder.query(rawClose(d.id));
          else
            await holder.query(
              `UPDATE security_deposit SET status = 'ACTIVE', closing_date = NULL, closing_reason = NULL, closing_note = NULL, held_at_closing = NULL,
                 version = version + 1 WHERE id = '${d.id}'`,
            );
          const writing = splits.replaceSplits(id, REALM, [split('1.00', 'SECURITY_DEPOSIT', d.id)], actor);
          await waitForLocks(pool);
          await holder.query('COMMIT');
          expect(await writing, step).toMatchObject(step === 'close' ? { kind: 'DEPOSIT_CLOSED', securityDepositId: d.id } : { kind: 'REPLACED' });
        } finally {
          holder.release();
        }
      }
    });

    it('REPEATABLE READ past the repository, both orders: the later one fails to serialise', async () => {
      for (const first of ['split', 'close'] as const) {
        const d = await deposit();
        const id = await transaction('1.00');
        const [one, two] = [await pool.connect(), await pool.connect()];
        try {
          await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await one.query('SELECT 1');
          await two.query('BEGIN');
          await two.query(first === 'split' ? rawSplit(id, d.id) : rawClose(d.id));
          const second = one.query(first === 'split' ? rawClose(d.id) : rawSplit(id, d.id)).then(
            () => 'written',
            (error: { code?: string }) => error.code,
          );
          await waitForLocks(pool);
          await two.query('COMMIT');
          // The split guard writes the deposit row: a stale close or split would otherwise pass (lesson of #50).
          expect(await second, first).toBe('40001');
        } finally {
          await one.query('ROLLBACK');
          one.release();
          two.release();
        }
      }
    });

    it('a close against a correction of a counted receipt: the correction that waits is allowed and shows as HELD_CHANGED_AFTER_CLOSING', async () => {
      const d = await deposit();
      const receipt = await booked(d.id, '3000.00');
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM security_deposit WHERE id = $1 FOR UPDATE`, [d.id]);
        const closing = deposits.close(d.id, REALM, closeAs('OTHER'), actor);
        await waitForLocks(pool, 1);
        const correcting = corrections.correct(
          receipt,
          REALM,
          { reason: 'Betrag', replacement: { amount: eur('2000.00'), splits: [split('2000.00', 'SECURITY_DEPOSIT', d.id)] } },
          actor,
        );
        await waitForLocks(pool, 2);
        await holder.query('COMMIT');
        expect([(await closing).kind, (await correcting).kind]).toEqual(['CLOSED', 'CORRECTED']);
        expect((await deposits.findById(d.id, REALM))?.figures.flags.map((f) => f.code)).toEqual(['HELD_CHANGED_AFTER_CLOSING']);
      } finally {
        holder.release();
      }
    });
  });

  describe('migration 0039 past the repository (each rule has a counter-check)', () => {
    const update = (id: string, set: string) =>
      pool.query(`UPDATE security_deposit SET ${set}, version = version + 1 WHERE id = $1`, [id]).then(() => 'accepted', reasonOf);
    const close = (reason: string, note: string | null, held: string, date = '2027-06-30') =>
      `status = 'CLOSED', closing_date = '${date}', closing_reason = '${reason}', closing_note = ${note === null ? 'NULL' : `'${note}'`}, held_at_closing = ${held}`;
    const reopen = `status = 'ACTIVE', closing_date = NULL, closing_reason = NULL, closing_note = NULL, held_at_closing = NULL`;

    it('the closing CHECKs: set together exactly while CLOSED; RETURNED holds 0; RETAINED more than 0 with a note; OTHER a note', async () => {
      const d = await deposit();
      await booked(d.id, '500.00');
      expect(await update(d.id, `closing_note = 'x'`)).toBe('security_deposit_closing_fields');
      expect(await update(d.id, `closing_date = '2027-06-30'`)).toBe('security_deposit_closing_fields');
      expect(await update(d.id, `status = 'CLOSED', closing_date = '2027-06-30', closing_reason = 'OTHER', closing_note = 'x', held_at_closing = NULL`)).toBe(
        '(HELD_AT_CLOSING)',
      );
      expect(await update(d.id, `status = 'CLOSED', closing_reason = 'OTHER', closing_note = 'x', held_at_closing = 500`)).toBe(
        'security_deposit_closing_fields',
      );
      expect(await update(d.id, close('GONE', 'x', '500'))).toBe('security_deposit_closing_reason_check');
      expect(await update(d.id, close('OTHER', '', '500'))).toBe('security_deposit_closing_note_check');
      expect(await update(d.id, close('OTHER', 'x'.repeat(501), '500'))).toBe('security_deposit_closing_note_check');
      expect(await update(d.id, close('OTHER', null, '500'))).toBe('security_deposit_closing_reason');
      expect(await update(d.id, close('RETAINED', null, '500'))).toBe('security_deposit_closing_reason');
      expect(await update(d.id, close('RETURNED', null, '500'))).toBe('security_deposit_closing_reason');
      expect(await update(d.id, close('RETAINED', 'x', '500'))).toBe('accepted');
      const empty = await deposit();
      expect(await update(empty.id, close('RETAINED', 'x', '0'))).toBe('security_deposit_closing_reason');
      // RETURNED holds 0 or less: more repaid than held passes (review on #136).
      const over = await deposit();
      await booked(over.id, '100.00');
      await booked(over.id, '105.00', { direction: 'OUTFLOW' });
      expect(await update(over.id, close('RETURNED', null, '-5'))).toBe('accepted');
      // The close guard sorts first and compares held_at_closing exactly; the scale CHECK is shown with it disabled in a
      // transaction that is rolled back.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE security_deposit DISABLE TRIGGER security_deposit_close_guard');
        const scaled = await client
          .query(`UPDATE security_deposit SET ${close('RETAINED', 'x', '0.001')}, version = version + 1 WHERE id = $1`, [empty.id])
          .then(() => 'accepted', reasonOf);
        expect(scaled).toBe('security_deposit_held_at_closing_check');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(await update(empty.id, close('RETURNED', null, '0'))).toBe('accepted');
    });

    it('the frozen rule: CLOSED ⇄ ACTIVE are steps, CLOSED → VOID is not; while CLOSED only notes; a step changes nothing else', async () => {
      const d = await deposit();
      expect(await update(d.id, close('OTHER', 'x', '0'))).toBe('accepted');
      expect(await update(d.id, `status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'x'`)).toBe('not a step');
      expect(await update(d.id, `expected_amount = 1`)).toBe('only notes change');
      expect(await update(d.id, `interest_bearing = false`)).toBe('only notes change');
      expect(await update(d.id, `closing_note = 'y'`)).toBe('only notes change');
      expect(await update(d.id, `closing_date = '2027-06-29'`)).toBe('only notes change');
      expect(await update(d.id, `notes = 'Schluss'`)).toBe('accepted');
      expect(await update(d.id, `${reopen}, notes = 'neu'`)).toBe('a step changes nothing else');
      expect(await update(d.id, reopen)).toBe('accepted');
      expect(await update(d.id, `${close('OTHER', 'x', '0')}, interest_bearing = false`)).toBe('a step changes nothing else');
      // Version + 1 and P3-D8's no-op write still hold.
      expect(await pool.query(`UPDATE security_deposit SET notes = 'z' WHERE id = $1`, [d.id]).then(() => 'accepted', reasonOf)).toBe('exactly one');
      expect(await pool.query(`UPDATE security_deposit SET version = version WHERE id = $1`, [d.id]).then(() => 'accepted', reasonOf)).toBe('accepted');
    });

    it('an IGNORED split naming the deposit is open cash: through the repository and past it (review on #139)', async () => {
      const ignored = async (depositId: string, bookingDate: string) => {
        const id = await booked(depositId, '1.00', { bookingDate, confirm: false });
        expect((await unconfirmed.ignore(id, REALM, 'kein Kautionseingang', actor)).kind).toBe('IGNORED');
        return id;
      };
      const before = await deposit();
      const onTheDate = await ignored(before.id, '2027-06-30');
      expect(await deposits.close(before.id, REALM, closeAs('OTHER'), actor)).toEqual({ kind: 'UNCONFIRMED_CASH', transactionIds: [onTheDate] });
      expect(await update(before.id, close('OTHER', 'x', '0'))).toBe('(UNCONFIRMED_CASH)');
      const after = await deposit();
      const later = await ignored(after.id, '2027-07-01');
      expect(await deposits.close(after.id, REALM, closeAs('OTHER'), actor)).toEqual({ kind: 'CASH_AFTER_CLOSING_DATE', transactionIds: [later] });
      expect(await update(after.id, close('OTHER', 'x', '0'))).toBe('(CASH_AFTER_CLOSING_DATE)');
    });

    it('the close guard: cash after the date, open cash, and held_at_closing not the counted held', async () => {
      const d = await deposit();
      await booked(d.id, '3000.00');
      const later = await booked(d.id, '1.00', { bookingDate: '2027-07-01', confirm: false });
      expect(await update(d.id, close('OTHER', 'x', '3000'))).toBe('(CASH_AFTER_CLOSING_DATE)');
      expect(await update(d.id, close('OTHER', 'x', '3000', '2027-07-01'))).toBe('(UNCONFIRMED_CASH)');
      await transactions.confirm(later, REALM, actor);
      expect(await update(d.id, close('OTHER', 'x', '3000', '2027-07-01'))).toBe('(HELD_AT_CLOSING)');
      expect(await update(d.id, close('OTHER', 'x', '3001', '2027-07-01'))).toBe('accepted');
      // A reversed receipt after the date no longer blocks a closing.
      const other = await deposit();
      const reversed = await booked(other.id, '5.00', { bookingDate: '2027-07-01' });
      expect(await update(other.id, close('OTHER', 'x', '5'))).toBe('(CASH_AFTER_CLOSING_DATE)');
      await corrections.correct(reversed, REALM, { reason: 'x', replacement: null }, actor);
      expect(await update(other.id, close('OTHER', 'x', '0'))).toBe('accepted');
    });

    it('the split guard: a CLOSED deposit refuses a split; a reversal and a replacement whose original names it pass', async () => {
      const d = await deposit();
      const receipt = await booked(d.id, '1500.00');
      const rent = await transaction('1500.00', { set: [split('1500.00', 'RENT_BASE', null)] });
      await transactions.confirm(rent, REALM, actor);
      expect(await update(d.id, close('OTHER', 'x', '1500'))).toBe('accepted');
      const insert = (transactionId: string) =>
        `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, security_deposit_id, created_by)
         SELECT '${transactionId}', '${REALM}', 1, 1500.00, 'EUR', id, '${d.id}', 'x' FROM financial_category WHERE code = 'SECURITY_DEPOSIT'`;
      const open = await transaction('1500.00');
      expect(await pool.query(insert(open)).then(() => 'accepted', reasonOf)).toBe('(DEPOSIT_CLOSED)');
      const correction = async (original: string, role: 'REVERSAL' | 'REPLACEMENT') => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query(
            `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by,
               correction_of_transaction_id, correction_role)
             SELECT mre_realm_id, financial_account_id, amount, currency, CASE WHEN $2 = 'REVERSAL' THEN 'OUTFLOW' ELSE direction END, booking_date,
               'CORRECTION', 'CLASSIFIED', 'x', id, $2
               FROM ledger_transaction WHERE id = $1 RETURNING id`,
            [original, role],
          );
          return await client.query(insert(rows[0].id as string)).then(() => 'accepted', reasonOf);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };
      expect(await correction(receipt, 'REVERSAL')).toBe('accepted');
      expect(await correction(receipt, 'REPLACEMENT')).toBe('accepted');
      expect(await correction(rent, 'REPLACEMENT')).toBe('(DEPOSIT_CLOSED)');
    });

    it(
      'down restores 0037 and 0038: CLOSED is no step, the closing columns are gone, a split on any non-VOID deposit passes',
      { timeout: 30_000 },
      async () => {
        const downSchema = testSchemaName('deposit_close_down_test');
        const admin = new pg.Client({ connectionString: databaseUrl });
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${downSchema}"`);
        await admin.end();
        const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
        try {
          await migrateToLatest(downPool, { migrationTableSchema: downSchema });
          // Dropping columns while another worker's Migrator introspects the database breaks that migration (the race of
          // #114 and #145): the down holds the migration lock, as schema teardown does (migrate.ts).
          const lock = new pg.Client({ connectionString: databaseUrl });
          await lock.connect();
          try {
            await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
            const { down } = await import('./migrations/0039_security_deposit_close.js');
            await down(createDatabase(downPool) as never);
          } finally {
            await lock.end().catch(() => undefined);
          }
          const { rows: columns } = await downPool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'security_deposit' AND column_name LIKE '%closing%'`,
            [downSchema],
          );
          expect(columns).toEqual([]);
          const { rows } = await downPool.query(
            `INSERT INTO security_deposit (mre_realm_id, status, mre_tenant_id, expected_amount, currency, expected_amount_source, interest_bearing, created_by)
           VALUES ($1, 'ACTIVE', $2, 1, 'EUR', 'REQUEST', true, 'x') RETURNING id`,
            [REALM, nextTenant()],
          );
          const result = await downPool
            .query(`UPDATE security_deposit SET status = 'CLOSED', version = version + 1 WHERE id = $1`, [rows[0].id])
            .then(() => 'accepted', reasonOf);
          expect(result).toBe('not a step');
          const { rows: bodies } = await downPool.query(
            `SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE proname = 'transaction_split_security_deposit' AND nspname = $1`,
            [downSchema],
          );
          expect(bodies).toHaveLength(1);
          expect(bodies.every((b) => !String(b.prosrc).includes('DEPOSIT_CLOSED'))).toBe(true);
        } finally {
          await downPool.end();
        }
      },
    );
  });
});
