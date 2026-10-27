import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { remainingDebt, type CloseRequest, type Loan } from '../../domains/financing/index.js';
import type { BusinessDate, SplitInput } from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLoanAllocationRepository } from './loan-allocation-repository.js';
import { PostgresLoanDebtRepository } from './loan-debt-repository.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { PostgresLoanTermsRepository } from './loan-terms-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresUnconfirmedTransactionRepository } from './unconfirmed-transaction-repository.js';

/**
 * VC-3-07 persistence (api-design.md §41.7): close with its order of checks (the splits that could still count after
 * the date, review on #71), its effects (no split, booking date or statement after the date, a reversal exempt; terms
 * and allocations refused; the remaining debt 0), a successor that is never voided, the locks against split writes,
 * booking-date amends and voids (RC and RR), and the schema's rules past the repository.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000012';
const OTHER_REALM = '64b0c0ffee00000000000013';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, financialCategoryCode: string, loanId: string | null = null): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId: null,
  loanId,
  description: null,
});
const closing = (closingDate: string, reason: CloseRequest['reason'] = 'OTHER', refinancedByLoanId: string | null = null): CloseRequest => ({
  closingDate: day(closingDate),
  reason,
  refinancedByLoanId,
  closingNote: reason === 'OTHER' ? 'Vergleich' : null,
});

async function waitForLocks(pool: pg.Pool, count = 1): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Number((await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].count) < count) {
    if (Date.now() > deadline) throw new Error(`fewer than ${count} sessions wait on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The trigger's own reason, the constraint's name, or the error code. */
function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return error.constraint ?? /\(([A-Z_]+)\)|is final/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error';
}

describe.skipIf(databaseUrl === undefined)('Closing a Loan (§41.7)', () => {
  const schema = testSchemaName('loan_close_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let loans: PostgresLoanRepository;
  let terms: PostgresLoanTermsRepository;
  let allocations: PostgresLoanAllocationRepository;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let unconfirmed: PostgresUnconfirmedTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let corrections: PostgresCorrectionRepository;
  let debt: PostgresLoanDebtRepository;
  let account: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    loans = new PostgresLoanRepository(db);
    terms = new PostgresLoanTermsRepository(db);
    allocations = new PostgresLoanAllocationRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    unconfirmed = new PostgresUnconfirmedTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    debt = new PostgresLoanDebtRepository(db);
    const created = await accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    account = created.account.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function party(name: string, realm = REALM): Promise<string> {
    const outcome = await parties.create(
      { mreRealmId: realm, partyType: 'PERSON', displayName: name, firstName: null, lastName: null, legalName: null, registrationNumber: null, email: null, phone: null },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party.id;
  }
  /** 1 000.00 owed from 2027-01-01. */
  async function loan(realm = REALM): Promise<Loan> {
    const outcome = await loans.create(
      {
        mreRealmId: realm,
        lenderPartyId: await party('Bank', realm),
        borrowerPartyIds: [await party('Anna', realm)],
        principalOriginal: eur('1000.00'),
        startDate: day('2027-01-01'),
        disbursementDate: null,
        maturityDate: null,
        contractNumber: null,
        acquisitionId: null,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.loan;
  }
  async function transaction(bookingDate: string, amount: string): Promise<string> {
    const created = await transactions.createManual(
      { mreRealmId: REALM, financialAccountId: account, amount: eur(amount), direction: 'OUTFLOW', bookingDate: day(bookingDate), valueDate: null, description: 'Rate', propertyReferenceId: null },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  /** A payment of `principal` to `loanId`, split and (unless told otherwise) confirmed. */
  async function pay(loanId: string, bookingDate: string, principal: string, confirm = true): Promise<string> {
    const id = await transaction(bookingDate, principal);
    const replaced = await splits.replaceSplits(id, REALM, [split(principal, 'LOAN_PRINCIPAL', loanId)], actor);
    if (replaced.kind !== 'REPLACED') throw new Error(JSON.stringify(replaced));
    if (confirm) {
      const confirmed = await transactions.confirm(id, REALM, actor);
      if (confirmed.kind !== 'CONFIRMED') throw new Error(confirmed.kind);
    }
    return id;
  }
  const closed = async (loanId: string, request: CloseRequest) => {
    const outcome = await loans.close(loanId, REALM, request, actor);
    if (outcome.kind !== 'CLOSED') throw new Error(JSON.stringify(outcome));
    return outcome.loan;
  };
  const rawClose = (loanId: string, date = '2027-06-30', extra = `closing_reason = 'OTHER', closing_note = 'x'`) =>
    `UPDATE loan SET status = 'CLOSED', closing_date = '${date}', ${extra}, version = version + 1 WHERE id = '${loanId}'`;
  const rawVoid = (loanId: string) => `UPDATE loan SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = '${loanId}'`;
  const rawSplit = (transactionId: string, loanId: string) =>
    `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, loan_id, created_by)
     SELECT '${transactionId}', '${REALM}', 1, 1.00, 'EUR', id, '${loanId}', 'x' FROM financial_category WHERE code = 'LOAN_PRINCIPAL'`;
  const rawAmend = (transactionId: string, date: string) => `UPDATE ledger_transaction SET booking_date = '${date}', version = version + 1 WHERE id = '${transactionId}'`;

  describe('close: the order of checks', () => {
    it('unknown or foreign → NOT_FOUND; VOID or CLOSED with other values → LOAN_NOT_ACTIVE; before the debt', async () => {
      const [foreign, voided, l] = [await loan(OTHER_REALM), await loan(), await loan()];
      await loans.void(voided.id, REALM, 'x', new Date(), actor);
      expect(await loans.close(foreign.id, REALM, closing('2027-06-30'), actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await loans.close('nope', REALM, closing('2027-06-30'), actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await loans.close(voided.id, REALM, closing('2026-01-01'), actor)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
      expect(await loans.close(l.id, REALM, closing('2026-12-31'), actor)).toEqual({ kind: 'CLOSING_BEFORE_DEBT', debtFrom: '2027-01-01' });
      await closed(l.id, closing('2027-06-30'));
      expect(await loans.close(l.id, REALM, closing('2027-07-31'), actor)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'CLOSED' });
    });

    it('REFINANCED: the named Loan unknown, foreign, VOID or CLOSED is refused', async () => {
      const [l, foreign, voided, done] = [await loan(), await loan(OTHER_REALM), await loan(), await loan()];
      await loans.void(voided.id, REALM, 'x', new Date(), actor);
      await closed(done.id, closing('2027-06-30'));
      const unknown = '00000000-0000-4000-8000-000000000000';
      expect(await loans.close(l.id, REALM, closing('2027-06-30', 'REFINANCED', unknown), actor)).toEqual({ kind: 'REFINANCING_LOAN_NOT_FOUND', refinancedByLoanId: unknown });
      expect(await loans.close(l.id, REALM, closing('2027-06-30', 'REFINANCED', foreign.id), actor)).toEqual({ kind: 'REFINANCING_LOAN_NOT_FOUND', refinancedByLoanId: foreign.id });
      expect(await loans.close(l.id, REALM, closing('2027-06-30', 'REFINANCED', voided.id), actor)).toEqual({ kind: 'REFINANCING_LOAN_NOT_ACTIVE', status: 'VOID' });
      expect(await loans.close(l.id, REALM, closing('2027-06-30', 'REFINANCED', done.id), actor)).toEqual({ kind: 'REFINANCING_LOAN_NOT_ACTIVE', status: 'CLOSED' });
    });

    it('SPLITS_AFTER_CLOSING for a current, an unconfirmed and an IGNORED split, in booking-date order', async () => {
      const l = await loan();
      const current = await pay(l.id, '2027-08-31', '1.00');
      const open = await pay(l.id, '2027-07-31', '1.00', false);
      const ignored = await pay(l.id, '2027-09-30', '1.00', false);
      expect((await unconfirmed.ignore(ignored, REALM, 'doppelt', actor)).kind).toBe('IGNORED');
      await pay(l.id, '2027-06-30', '1.00'); // on the date: allowed
      expect(await loans.close(l.id, REALM, closing('2027-06-30'), actor)).toEqual({ kind: 'SPLITS_AFTER_CLOSING', transactionIds: [open, current, ignored] });
    });

    it('the refinancing scenario (review on #71): a payment booked on the old Loan after the date, corrected to the new one; then the close passes', async () => {
      const [old, successor] = [await loan(), await loan()];
      await pay(old.id, '2027-01-31', '400.00');
      const july = await pay(old.id, '2027-07-31', '25.00');
      expect(await loans.close(old.id, REALM, closing('2027-06-30', 'REFINANCED', successor.id), actor)).toEqual({ kind: 'SPLITS_AFTER_CLOSING', transactionIds: [july] });
      const moved = await corrections.correct(july, REALM, { reason: 'falsches Darlehen', replacement: { splits: [split('25.00', 'LOAN_PRINCIPAL', successor.id)] } }, actor);
      expect(moved.kind).toBe('CORRECTED');
      const done = await closed(old.id, closing('2027-06-30', 'REFINANCED', successor.id));
      expect(done).toMatchObject({ status: 'CLOSED', closingDate: '2027-06-30', closingReason: 'REFINANCED', refinancedByLoanId: successor.id, version: old.version + 1 });
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_type = 'Loan' AND entity_id = $1 AND action = 'CLOSED'`, [old.id]);
      expect(audit.rows).toEqual([
        { metadata: { closingDate: '2027-06-30', reason: 'REFINANCED', refinancedByLoanId: successor.id, closingNote: null, settledAmount: { amount: '600.00', currency: 'EUR' } } },
      ]);
    });

    it('REPAID only at 0: a rest and an overpayment refused with the signed amount; at 0 it passes', async () => {
      const [rest, over, paid] = [await loan(), await loan(), await loan()];
      await pay(rest.id, '2027-01-31', '999.99');
      await pay(over.id, '2027-01-31', '1000.01');
      await pay(paid.id, '2027-01-31', '600.00');
      await pay(paid.id, '2027-02-28', '400.00');
      await pay(paid.id, '2027-03-31', '1.00', false); // unconfirmed and on or before the date: does not count
      expect(await loans.close(rest.id, REALM, closing('2027-06-30', 'REPAID'), actor)).toEqual({ kind: 'REMAINING_DEBT_NOT_ZERO', actual: 1n });
      expect(await loans.close(over.id, REALM, closing('2027-06-30', 'REPAID'), actor)).toEqual({ kind: 'REMAINING_DEBT_NOT_ZERO', actual: -1n });
      expect((await closed(paid.id, closing('2027-06-30', 'REPAID'))).closingReason).toBe('REPAID');
    });

    it('a repeat with the same values is a no-op whatever If-Match; If-Match otherwise', async () => {
      const l = await loan();
      expect(await loans.close(l.id, REALM, closing('2027-06-30'), actor, [9])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [9], currentVersion: 1 });
      const first = await closed(l.id, closing('2027-06-30'));
      expect(await loans.close(l.id, REALM, closing('2027-06-30'), actor, [1])).toEqual({ kind: 'CLOSED', loan: first, changed: false });
      const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_record WHERE entity_id = $1 AND action = 'CLOSED'`, [l.id]);
      expect(audit.rows[0].n).toBe(1);
    });
  });

  describe('after closing', () => {
    it('a split after the date refused, on it allowed; a reversal of an earlier payment allowed; a replacement after it refused', async () => {
      const l = await loan();
      const earlier = await pay(l.id, '2027-05-31', '100.00');
      const corrected = await pay(l.id, '2027-06-15', '50.00');
      await closed(l.id, closing('2027-06-30'));
      const after = await transaction('2027-07-01', '1.00');
      expect(await splits.replaceSplits(after, REALM, [split('1.00', 'LOAN_PRINCIPAL', l.id)], actor)).toEqual({ kind: 'LOAN_CLOSED', loanId: l.id, closingDate: '2027-06-30' });
      const on = await transaction('2027-06-30', '1.00');
      expect((await splits.replaceSplits(on, REALM, [split('1.00', 'LOAN_PRINCIPAL', l.id)], actor)).kind).toBe('REPLACED');
      expect((await corrections.correct(earlier, REALM, { reason: 'doppelt', replacement: null }, actor)).kind).toBe('CORRECTED');
      expect(await corrections.correct(corrected, REALM, { reason: 'Datum', replacement: { bookingDate: day('2027-07-02') } }, actor)).toEqual({
        kind: 'LOAN_CLOSED',
        loanId: l.id,
        closingDate: '2027-06-30',
      });
    });

    it('an amend of a booking date past the date refused, in the repository and past it; on the date allowed', async () => {
      const l = await loan();
      const open = await pay(l.id, '2027-06-01', '1.00', false);
      await closed(l.id, closing('2027-06-30'));
      expect(await unconfirmed.amend(open, REALM, { bookingDate: day('2027-07-01') }, actor)).toEqual({ kind: 'LOAN_CLOSED', loanId: l.id, closingDate: '2027-06-30' });
      expect(await pool.query(rawAmend(open, '2027-07-01')).then(() => 'accepted', reasonOf)).toBe('(LOAN_CLOSED)');
      expect((await unconfirmed.amend(open, REALM, { bookingDate: day('2027-06-30') }, actor)).kind).toBe('AMENDED');
    });

    it('statements up to the date allowed, later refused; terms and allocations refused', async () => {
      const l = await loan();
      await closed(l.id, closing('2027-06-30'));
      const statement = (date: string) => ({ statementDate: day(date), balance: eur('0.00'), source: 'Schlussabrechnung', notes: null });
      expect((await debt.createStatement(l.id, REALM, statement('2027-06-30'), actor)).kind).toBe('CREATED');
      expect(await debt.createStatement(l.id, REALM, statement('2027-07-01'), actor)).toEqual({ kind: 'STATEMENT_AFTER_CLOSING', closingDate: '2027-06-30' });
      const period = {
        validFrom: day('2027-07-01'),
        interestRate: 1000n,
        repaymentModel: 'INTEREST_ONLY' as const,
        scheduledPayment: null,
        firstPaymentDate: day('2027-07-31'),
        principalAtStart: null,
        fixedRateUntil: null,
        initialRepaymentRate: null,
        specialRepaymentLimit: null,
        notes: null,
      };
      expect(await terms.create(l.id, REALM, period, actor)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'CLOSED' });
      expect(await allocations.create(l.id, REALM, { validFrom: day('2027-07-01'), basis: 'MANUAL', allocations: [], notes: null }, actor)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'CLOSED' });
    });

    it('the remaining debt: 0 after the date with the closing; on the date as derived; a later correction shows in actualOnClosingDate', async () => {
      const [l, successor] = [await loan(), await loan()];
      const payment = await pay(l.id, '2027-01-31', '300.00');
      await closed(l.id, closing('2027-06-30', 'REFINANCED', successor.id));
      const read = async (asOf: string) => remainingDebt((await debt.debtInputs(l.id, REALM))!, day(asOf), false);
      expect(await read('2027-06-30')).toMatchObject({ debt: { principalPaid: 30_000n, actual: 70_000n, planned: null, closing: { closingDate: '2027-06-30', reason: 'REFINANCED', refinancedByLoanId: successor.id, actualOnClosingDate: 70_000n } } });
      expect(await read('2027-07-01')).toMatchObject({ debt: { principalPaid: 30_000n, actual: 0n, planned: null, difference: null } });
      expect((await corrections.correct(payment, REALM, { reason: 'doppelt', replacement: null }, actor)).kind).toBe('CORRECTED');
      expect(await read('2027-07-01')).toMatchObject({ debt: { actual: 0n, closing: { actualOnClosingDate: 100_000n } } });
    });
  });

  describe('a successor is never voided (review on #71)', () => {
    it('void refused after the close with LOAN_REFINANCES, in the repository and past it; allowed before the close', async () => {
      const [old, successor, other, unused] = [await loan(), await loan(), await loan(), await loan()];
      await closed(old.id, closing('2027-06-30', 'REFINANCED', successor.id));
      expect(await loans.void(successor.id, REALM, 'x', new Date(), actor)).toEqual({ kind: 'LOAN_REFINANCES', loanIds: [old.id] });
      expect(await pool.query(rawVoid(successor.id)).then(() => 'accepted', reasonOf)).toBe('(LOAN_REFINANCES)');
      expect((await loans.void(unused.id, REALM, 'falsch erfasst', new Date(), actor)).kind).toBe('VOIDED');
      expect(await loans.close(other.id, REALM, closing('2027-06-30', 'REFINANCED', unused.id), actor)).toEqual({ kind: 'REFINANCING_LOAN_NOT_ACTIVE', status: 'VOID' });
    });
  });

  describe('concurrency (P3-D8)', () => {
    /** Two raw writes in two connections, the second under REPEATABLE READ with a snapshot taken first. */
    async function repeatableRead(first: string, second: string): Promise<string | undefined> {
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await two.query(first);
        const later = one.query(second).then(
          () => 'written',
          (error: { code?: string }) => error.code,
        );
        await waitForLocks(pool);
        await two.query('COMMIT');
        return await later;
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    }
    /** `first` held in an open transaction while `second` runs and waits, then committed. */
    async function heldThen<T>(first: string, second: () => Promise<T>): Promise<T> {
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await holder.query(first);
        const waiting = second();
        await waitForLocks(pool);
        await holder.query('COMMIT');
        return await waiting;
      } finally {
        holder.release();
      }
    }

    it('READ COMMITTED, close against a split write, both orders: the second sees the first', async () => {
      const a = await loan();
      const afterA = await transaction('2027-07-15', '1.00');
      expect(await heldThen(rawSplit(afterA, a.id), () => loans.close(a.id, REALM, closing('2027-06-30'), actor))).toEqual({ kind: 'SPLITS_AFTER_CLOSING', transactionIds: [afterA] });
      const b = await loan();
      const afterB = await transaction('2027-07-15', '1.00');
      expect(await heldThen(rawClose(b.id), () => splits.replaceSplits(afterB, REALM, [split('1.00', 'LOAN_PRINCIPAL', b.id)], actor))).toEqual({
        kind: 'LOAN_CLOSED',
        loanId: b.id,
        closingDate: '2027-06-30',
      });
    });

    it('REPEATABLE READ past the repository, close against a split write, both orders: the later one fails to serialise', async () => {
      const a = await loan();
      expect(await repeatableRead(rawSplit(await transaction('2027-07-15', '1.00'), a.id), rawClose(a.id)), 'split first').toBe('40001');
      const b = await loan();
      expect(await repeatableRead(rawClose(b.id), rawSplit(await transaction('2027-07-15', '1.00'), b.id)), 'close first').toBe('40001');
    });

    it('close against a booking-date amend: RC sees it, RR fails to serialise', async () => {
      const a = await loan();
      const openA = await pay(a.id, '2027-06-01', '1.00', false);
      expect(await heldThen(rawClose(a.id), () => unconfirmed.amend(openA, REALM, { bookingDate: day('2027-07-01') }, actor))).toEqual({
        kind: 'LOAN_CLOSED',
        loanId: a.id,
        closingDate: '2027-06-30',
      });
      const b = await loan();
      const openB = await pay(b.id, '2027-06-01', '1.00', false);
      expect(await heldThen(rawAmend(openB, '2027-07-01'), () => loans.close(b.id, REALM, closing('2027-06-30'), actor))).toEqual({ kind: 'SPLITS_AFTER_CLOSING', transactionIds: [openB] });
      const c = await loan();
      const openC = await pay(c.id, '2027-06-01', '1.00', false);
      expect(await repeatableRead(rawAmend(openC, '2027-07-01'), rawClose(c.id))).toBe('40001');
    });

    it('REFINANCED against a void of the named Loan: RC both orders; RR fails to serialise', async () => {
      const [a, successorA] = [await loan(), await loan()];
      expect(await heldThen(rawClose(a.id, '2027-06-30', `closing_reason = 'REFINANCED', refinanced_by_loan_id = '${successorA.id}'`), () => loans.void(successorA.id, REALM, 'x', new Date(), actor))).toEqual({
        kind: 'LOAN_REFINANCES',
        loanIds: [a.id],
      });
      const [b, successorB] = [await loan(), await loan()];
      expect(await heldThen(rawVoid(successorB.id), () => loans.close(b.id, REALM, closing('2027-06-30', 'REFINANCED', successorB.id), actor))).toEqual({
        kind: 'REFINANCING_LOAN_NOT_ACTIVE',
        status: 'VOID',
      });
      const [c, successorC] = [await loan(), await loan()];
      // Without the close guard's write on the named Loan's row, the stale void would commit.
      expect(await repeatableRead(rawClose(c.id, '2027-06-30', `closing_reason = 'REFINANCED', refinanced_by_loan_id = '${successorC.id}'`), rawVoid(successorC.id))).toBe('40001');
    });

    it('two booking-date amends naming two Loans in opposite position order: the id order avoids a deadlock', async () => {
      const [x, y] = [await loan(), await loan()];
      const [low = '', high = ''] = [x.id as string, y.id as string].sort();
      const both = async (first: string, second: string) => {
        const id = await transaction('2027-06-01', '2.00');
        const replaced = await splits.replaceSplits(id, REALM, [split('1.00', 'LOAN_PRINCIPAL', first), split('1.00', 'LOAN_PRINCIPAL', second)], actor);
        if (replaced.kind !== 'REPLACED') throw new Error(replaced.kind);
        return id;
      };
      const [highFirst, lowFirst] = [await both(high, low), await both(low, high)];
      const holder = await pool.connect();
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        // READ COMMITTED whatever the database's default: the test is about the lock order, not a stale snapshot.
        await holder.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await holder.query(`SELECT id FROM loan WHERE id = $1 FOR UPDATE`, [low]);
        await one.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await two.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        // Each commits as soon as it is through, so the other can take the Loans it holds.
        const amend = (client: pg.PoolClient, id: string) =>
          client.query(rawAmend(id, '2027-06-02')).then(
            async () => {
              await client.query('COMMIT');
              return 'written';
            },
            async (error: { code?: string }) => {
              await client.query('ROLLBACK');
              return error.code;
            },
          );
        // B queues first on the lower Loan; A names the higher one first. In position order A would hold the higher
        // Loan while waiting behind B, and B would then wait on it: a deadlock (40P01).
        const amendB = amend(two, lowFirst);
        await waitForLocks(pool, 1);
        const amendA = amend(one, highFirst);
        await waitForLocks(pool, 2);
        await holder.query('COMMIT');
        expect(await Promise.all([amendB, amendA])).toEqual(['written', 'written']);
      } finally {
        holder.release();
        one.release();
        two.release();
      }
    });
  });

  describe('the schema past the repository (each guard has a counter-check)', () => {
    const update = (loanId: string, set: string) => pool.query(`UPDATE loan SET ${set}, version = version + 1 WHERE id = $1`, [loanId]).then(() => 'accepted', reasonOf);

    it('the CHECKs: the closing fields with CLOSED, REFINANCED with its Loan, OTHER with a note, not itself, not before the debt, the Realm', async () => {
      const [l, successor, foreign] = [await loan(), await loan(), await loan(OTHER_REALM)];
      expect(await update(l.id, `status = 'CLOSED'`)).toBe('loan_closing_fields');
      expect(await update(l.id, `closing_note = 'x'`)).toBe('loan_closing_fields');
      expect(await update(l.id, `status = 'CLOSED', closing_date = '2027-06-30', closing_reason = 'REFINANCED'`)).toBe('loan_closing_fields');
      expect(await update(l.id, `status = 'CLOSED', closing_date = '2027-06-30', closing_reason = 'OTHER', closing_note = 'x', refinanced_by_loan_id = '${successor.id}'`)).toBe('loan_closing_fields');
      expect(await update(l.id, `status = 'CLOSED', closing_date = '2027-06-30', closing_reason = 'OTHER'`)).toBe('loan_closing_fields');
      expect(await update(l.id, `status = 'CLOSED', closing_date = '2027-06-30', closing_reason = 'REFINANCED', refinanced_by_loan_id = id`)).toBe('loan_not_refinanced_by_itself');
      expect(await update(l.id, `status = 'CLOSED', closing_date = '2026-12-31', closing_reason = 'OTHER', closing_note = 'x'`)).toBe('loan_closing_after_debt');
      expect(await update(l.id, `status = 'CLOSED', closing_date = '2027-06-30', closing_reason = 'REFINANCED', refinanced_by_loan_id = '${foreign.id}'`)).toBe('loan_refinanced_by_fk');
      expect(await update(l.id, `status = 'CLOSED', closing_date = '2027-06-30', closing_reason = 'OTHER', closing_note = ' x'`)).toBe('loan_closing_note_check');
      expect(await update(l.id, `status = 'CLOSED', closing_date = '2027-06-30', closing_reason = 'OTHER', closing_note = 'x'`)).toBe('accepted');
      expect(await update(l.id, `closing_date = '2027-07-31'`)).toBe('is final');
    });

    it('loan_close_guard: a split after the date (an IGNORED one too), REPAID with a rest, REFINANCED by a Loan not ACTIVE', async () => {
      const [l, ignoredOnly, repaid, refinanced, voided] = [await loan(), await loan(), await loan(), await loan(), await loan()];
      await pay(l.id, '2027-07-01', '1.00', false);
      expect(await pool.query(rawClose(l.id)).then(() => 'accepted', reasonOf)).toBe('(SPLITS_AFTER_CLOSING)');
      // `restore` brings an IGNORED Transaction back, so past the repository it counts as open too (review on #72).
      const ignored = await pay(ignoredOnly.id, '2027-07-01', '1.00', false);
      expect((await unconfirmed.ignore(ignored, REALM, 'doppelt', actor)).kind).toBe('IGNORED');
      expect(await pool.query(rawClose(ignoredOnly.id)).then(() => 'accepted', reasonOf)).toBe('(SPLITS_AFTER_CLOSING)');
      await pay(repaid.id, '2027-01-31', '999.99');
      expect(await pool.query(rawClose(repaid.id, '2027-06-30', `closing_reason = 'REPAID'`)).then(() => 'accepted', reasonOf)).toBe('(REMAINING_DEBT_NOT_ZERO)');
      await loans.void(voided.id, REALM, 'x', new Date(), actor);
      expect(await pool.query(rawClose(refinanced.id, '2027-06-30', `closing_reason = 'REFINANCED', refinanced_by_loan_id = '${voided.id}'`)).then(() => 'accepted', reasonOf)).toBe(
        '(REFINANCING_LOAN_NOT_ACTIVE)',
      );
      await pay(repaid.id, '2027-02-28', '0.01');
      expect(await pool.query(rawClose(repaid.id, '2027-06-30', `closing_reason = 'REPAID'`)).then(() => 'accepted', reasonOf)).toBe('accepted');
    });

    it('the split guard: after the date refused, a reversal exempt (checked at the insert, rolled back); the booking-date trigger; the statement rule', async () => {
      const l = await loan();
      const before = await pay(l.id, '2027-06-01', '1.00');
      await closed(l.id, closing('2027-06-30'));
      expect(await pool.query(rawSplit(await transaction('2027-07-01', '1.00'), l.id)).then(() => 'accepted', reasonOf)).toBe('(LOAN_CLOSED)');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by,
             correction_of_transaction_id, correction_role)
           SELECT mre_realm_id, financial_account_id, amount, currency, 'INFLOW', '2027-07-01', 'CORRECTION', 'CLASSIFIED', 'x', id, 'REVERSAL'
             FROM ledger_transaction WHERE id = $1 RETURNING id`,
          [before],
        );
        expect(await client.query(rawSplit(rows[0].id as string, l.id)).then(() => 'accepted', reasonOf)).toBe('accepted');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      const statement = `INSERT INTO loan_balance_statement (mre_realm_id, loan_id, status, statement_date, balance, currency, source, created_by) VALUES ('${REALM}', '${l.id}', 'VALID', $1, 0, 'EUR', 'Brief', 'x')`;
      expect(await pool.query(statement, ['2027-07-01']).then(() => 'accepted', reasonOf)).toBe('(STATEMENT_AFTER_CLOSING)');
      expect(await pool.query(statement, ['2027-06-30']).then(() => 'accepted', reasonOf)).toBe('accepted');
    });
  });
});
