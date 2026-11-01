import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Loan } from '../../domains/financing/index.js';
import type { BusinessDate, Direction, SplitInput } from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { PostgresLoanTermsRepository } from './loan-terms-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionQueries } from './transaction-query-repository.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-3-05 persistence (api-design.md §41.5): splits with `loanId` through the splits command and `correct` /
 * `reverse`, the order of checks, the payments that count, a Loan with splits that cannot be voided, the lock order
 * Transaction → Loan under concurrency (RC and RR), the proposal's inputs, and the schema's rules past the repository.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000e';
const OTHER_REALM = '64b0c0ffee0000000000000f';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, financialCategoryCode: string, loanId: string | null = null): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId: null,
  loanId,
  securityDepositId: null,
  description: null,
});
const payment = (loanId: string | null, interest = '3.53', principal = '296.47') => [
  split(interest, 'LOAN_INTEREST', loanId),
  split(principal, 'LOAN_PRINCIPAL', loanId),
];

async function waitForLocks(pool: pg.Pool, count = 1): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (
    Number(
      (
        await pool.query(
          `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = current_setting('application_name')`,
        )
      ).rows[0].count,
    ) < count
  ) {
    if (Date.now() > deadline) throw new Error(`fewer than ${count} sessions wait on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The trigger's own reason or the constraint's name, to tell guards apart that share an error code. */
function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return error.constraint ?? /\(([A-Z_]+)\)|does not mirror/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error';
}

describe.skipIf(databaseUrl === undefined)('Loan payments (§41.5)', () => {
  const schema = testSchemaName('loan_payment_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let loans: PostgresLoanRepository;
  let terms: PostgresLoanTermsRepository;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let corrections: PostgresCorrectionRepository;
  let queries: PostgresTransactionQueries;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    loans = new PostgresLoanRepository(db);
    terms = new PostgresLoanTermsRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    queries = new PostgresTransactionQueries(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function party(name: string, realm = REALM): Promise<string> {
    const outcome = await parties.create(
      {
        mreRealmId: realm,
        partyType: 'PERSON',
        displayName: name,
        firstName: null,
        lastName: null,
        legalName: null,
        registrationNumber: null,
        email: null,
        phone: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party.id;
  }
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
  async function account(realm = REALM): Promise<string> {
    const outcome = await accounts.create({ mreRealmId: realm, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account.id;
  }
  async function transaction(options: { direction?: Direction; amount?: string; realm?: string; bookingDate?: string } = {}): Promise<string> {
    const realm = options.realm ?? REALM;
    const created = await transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: await account(realm),
        amount: eur(options.amount ?? '300.00'),
        direction: options.direction ?? 'OUTFLOW',
        bookingDate: day(options.bookingDate ?? '2027-03-01'),
        valueDate: null,
        description: 'Rate',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  async function replaced(id: string, set: readonly SplitInput[]) {
    const outcome = await splits.replaceSplits(id, REALM, set, actor);
    if (outcome.kind !== 'REPLACED') throw new Error(JSON.stringify(outcome));
    return outcome;
  }
  async function confirmedPayment(loanId: string): Promise<string> {
    const id = await transaction();
    await replaced(id, payment(loanId));
    const confirmed = await transactions.confirm(id, REALM, actor);
    if (confirmed.kind !== 'CONFIRMED') throw new Error(confirmed.kind);
    return id;
  }
  /** What counts for a Loan (§41.5): splits of current Transactions, reversals left out, per category. */
  async function counted(loanId: string): Promise<Record<string, string>> {
    const { rows } = await pool.query(
      `SELECT c.code, sum(s.amount)::text AS total FROM transaction_split s
         JOIN ledger_transaction t ON t.id = s.transaction_id JOIN financial_category c ON c.id = s.financial_category_id
        WHERE s.loan_id = $1 AND t.status IN ('CONFIRMED', 'RECONCILED') AND t.correction_role IS DISTINCT FROM 'REVERSAL'
        GROUP BY c.code ORDER BY c.code`,
      [loanId],
    );
    return Object.fromEntries(rows.map((r) => [r.code, r.total]));
  }

  describe('the splits command', () => {
    it('stores loanId on LOAN_INTEREST and LOAN_PRINCIPAL; reads carry it; the same set is a no-op, a changed loanId a change', async () => {
      const [l1, l2] = [await loan(), await loan()];
      const id = await transaction();
      const first = await replaced(id, payment(l1.id));
      expect(first.splits.map((s) => s.loanId)).toEqual([l1.id, l1.id]);
      expect((await queries.get(id, REALM))?.splits.map((s) => [s.financialCategoryCode, s.loanId])).toEqual([
        ['LOAN_INTEREST', l1.id],
        ['LOAN_PRINCIPAL', l1.id],
      ]);
      const again = await replaced(id, payment(l1.id));
      expect([again.changed, again.transaction.version]).toEqual([false, first.transaction.version]);
      const moved = await replaced(id, [split('3.53', 'LOAN_INTEREST', l1.id), split('296.47', 'LOAN_PRINCIPAL', l2.id)]);
      expect([moved.changed, moved.transaction.version]).toEqual([true, first.transaction.version + 1]);
      expect(moved.splits.map((s) => s.loanId)).toEqual([l1.id, l2.id]);
      // A LOAN_* split without a Loan stays allowed and counts for no Loan.
      expect((await replaced(id, payment(null))).splits.map((s) => s.loanId)).toEqual([null, null]);
      const audit = await pool.query(
        `SELECT metadata->'splits' AS splits FROM audit_record WHERE entity_id = $1 AND action = 'SPLITS_REPLACED' ORDER BY occurred_at`,
        [id],
      );
      expect(audit.rows[1].splits.map((s: { loanId?: string }) => s.loanId)).toEqual([l1.id, l2.id]);
    });

    it('order of checks: an unknown or foreign Loan, then the category, then the direction, then a VOID Loan; nothing written', async () => {
      const [active, voided, foreign] = [await loan(), await loan(), await loan(OTHER_REALM)];
      await loans.void(voided.id, REALM, 'falsch', new Date(), actor);
      const unknown = '00000000-0000-4000-8000-000000000000';
      const outflow = await transaction();
      const inflow = await transaction({ direction: 'INFLOW' });
      const refused = (id: string, set: readonly SplitInput[]) => splits.replaceSplits(id, REALM, set, actor);
      expect(await refused(outflow, [split('300.00', 'LOAN_INTEREST', foreign.id)])).toEqual({ kind: 'LOAN_NOT_FOUND', loanId: foreign.id });
      expect(await refused(inflow, [split('1.00', 'OTHER', voided.id), split('299.00', 'LOAN_INTEREST', unknown)])).toEqual({
        kind: 'LOAN_NOT_FOUND',
        loanId: unknown,
      });
      expect(await refused(inflow, [split('1.00', 'LOAN_INTEREST', voided.id), split('299.00', 'OTHER', active.id)])).toEqual({
        kind: 'INVALID_LOAN_SPLIT',
        position: 2,
        reason: 'CATEGORY',
      });
      expect(await refused(inflow, [split('300.00', 'LOAN_PRINCIPAL', voided.id)])).toEqual({ kind: 'INVALID_LOAN_SPLIT', position: 1, reason: 'DIRECTION' });
      expect(await refused(outflow, [split('1.00', 'LOAN_INTEREST', active.id), split('299.00', 'LOAN_PRINCIPAL', voided.id)])).toEqual({
        kind: 'LOAN_NOT_ACTIVE',
        loanId: voided.id,
        status: 'VOID',
      });
      // The existing checks come first: a sum mismatch before the Loans.
      expect((await refused(outflow, [split('1.00', 'LOAN_INTEREST', unknown)])).kind).toBe('SUM_MISMATCH');
      expect((await pool.query(`SELECT count(*)::int AS n FROM transaction_split WHERE transaction_id IN ($1, $2)`, [outflow, inflow])).rows[0].n).toBe(0);
    });

    it('several Loans in one Transaction', async () => {
      const [l1, l2] = [await loan(), await loan()];
      const id = await transaction({ amount: '600.00' });
      expect((await replaced(id, [...payment(l1.id), ...payment(l2.id)])).splits.map((s) => s.loanId)).toEqual([l1.id, l1.id, l2.id, l2.id]);
    });
  });

  describe('void of a Loan with splits', () => {
    it('LOAN_HAS_SPLITS through the repository and past it; the guard’s no-op write passes', async () => {
      const l = await loan();
      const id = await transaction();
      await replaced(id, payment(l.id));
      expect(await loans.void(l.id, REALM, 'x', new Date(), actor)).toEqual({ kind: 'LOAN_HAS_SPLITS', transactionIds: [id] });
      const refused = await pool
        .query(`UPDATE loan SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [l.id])
        .then(() => 'accepted', reasonOf);
      expect(refused).toBe('(LOAN_HAS_SPLITS)');
      // Not a step to VOID: an amend and the guard's no-op write pass.
      await expect(pool.query(`UPDATE loan SET version = version WHERE id = $1`, [l.id])).resolves.toBeDefined();
      await expect(pool.query(`UPDATE loan SET notes = 'x', version = version + 1 WHERE id = $1`, [l.id])).resolves.toBeDefined();
      // Once the splits are gone (replaced before confirmation), the void passes.
      await replaced(id, [split('300.00', 'OTHER')]);
      expect((await loans.void(l.id, REALM, 'x', new Date(), actor)).kind).toBe('VOIDED');
    });
  });

  describe('corrections of a payment (review on #58)', () => {
    it('correct: copied splits keep loanId; the replacement’s own splits may name another Loan or none; it must be OUTFLOW', async () => {
      const [l1, l2] = [await loan(), await loan()];
      const original = await confirmedPayment(l1.id);
      expect(await counted(l1.id)).toEqual({ LOAN_INTEREST: '3.53', LOAN_PRINCIPAL: '296.47' });

      const refusedInflow = await corrections.correct(original, REALM, { reason: 'Richtung', replacement: { direction: 'INFLOW' } }, actor);
      expect(refusedInflow).toEqual({ kind: 'INVALID_LOAN_SPLIT', position: 1, reason: 'DIRECTION' });
      const refusedCategory = await corrections.correct(
        original,
        REALM,
        { reason: 'Kategorie', replacement: { splits: [split('300.00', 'OTHER', l2.id)] } },
        actor,
      );
      expect(refusedCategory).toEqual({ kind: 'INVALID_LOAN_SPLIT', position: 1, reason: 'CATEGORY' });

      const copied = await corrections.correct(original, REALM, { reason: 'Datum', replacement: { bookingDate: day('2027-03-02') } }, actor);
      if (copied.kind !== 'CORRECTED' || copied.result.replacement === null) throw new Error(copied.kind);
      const loanIdsOf = async (id: string) => (await queries.get(id, REALM))?.splits.map((s) => s.loanId);
      expect(await loanIdsOf(copied.result.reversal.id)).toEqual([l1.id, l1.id]);
      expect(await loanIdsOf(copied.result.replacement.id)).toEqual([l1.id, l1.id]);
      expect(await counted(l1.id)).toEqual({ LOAN_INTEREST: '3.53', LOAN_PRINCIPAL: '296.47' });

      // The wrong Loan was named: the next replacement moves the payment to l2.
      const moved = await corrections.correct(
        copied.result.replacement.id,
        REALM,
        { reason: 'anderes Darlehen', replacement: { splits: payment(l2.id) } },
        actor,
      );
      if (moved.kind !== 'CORRECTED' || moved.result.replacement === null) throw new Error(moved.kind);
      expect([await counted(l1.id), await counted(l2.id)]).toEqual([{}, { LOAN_INTEREST: '3.53', LOAN_PRINCIPAL: '296.47' }]);
      // Not a Loan payment at all: the replacement without a Loan.
      const none = await corrections.correct(
        moved.result.replacement.id,
        REALM,
        { reason: 'kein Darlehen', replacement: { splits: [split('300.00', 'OTHER')] } },
        actor,
      );
      expect(none.kind).toBe('CORRECTED');
      expect(await counted(l2.id)).toEqual({});
    });

    it('reverse: the INFLOW reversal mirrors loanId, and nothing counts after it', async () => {
      const l = await loan();
      const original = await confirmedPayment(l.id);
      const reversed = await corrections.correct(original, REALM, { reason: 'doppelt', replacement: null }, actor);
      if (reversed.kind !== 'CORRECTED') throw new Error(reversed.kind);
      expect(reversed.result.reversal.direction).toBe('INFLOW');
      expect((await queries.get(reversed.result.reversal.id, REALM))?.splits.map((s) => s.loanId)).toEqual([l.id, l.id]);
      expect(await counted(l.id)).toEqual({});
      // The reversal's splits count for the history: the Loan cannot be voided.
      expect((await loans.void(l.id, REALM, 'x', new Date(), actor)).kind).toBe('LOAN_HAS_SPLITS');
    });
  });

  describe('concurrency (Transaction → Loan, the guard writing the Loan row, P3-D8)', () => {
    const rawSplit = (transactionId: string, loanId: string) =>
      `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, loan_id, created_by)
       SELECT '${transactionId}', '${REALM}', 1, 300.00, 'EUR', id, '${loanId}', 'x' FROM financial_category WHERE code = 'LOAN_INTEREST'`;
    const rawVoid = (loanId: string) => `UPDATE loan SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = '${loanId}'`;

    it('READ COMMITTED, a split write first: the void waits on the Loan row and answers LOAN_HAS_SPLITS', async () => {
      const l = await loan();
      const id = await transaction();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(rawSplit(id, l.id));
        const voiding = loans.void(l.id, REALM, 'x', new Date(), actor);
        await waitForLocks(pool);
        await holder.query('COMMIT');
        expect(await voiding).toEqual({ kind: 'LOAN_HAS_SPLITS', transactionIds: [id] });
      } finally {
        holder.release();
      }
    });

    it('READ COMMITTED, a void first: the split write waits on the Loan row and answers LOAN_NOT_ACTIVE', async () => {
      const l = await loan();
      const id = await transaction();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(rawVoid(l.id));
        const writing = splits.replaceSplits(id, REALM, payment(l.id), actor);
        await waitForLocks(pool);
        await holder.query('COMMIT');
        expect(await writing).toEqual({ kind: 'LOAN_NOT_ACTIVE', loanId: l.id, status: 'VOID' });
      } finally {
        holder.release();
      }
    });

    it('REPEATABLE READ past the repository, both orders: the later one fails to serialise', async () => {
      for (const first of ['split', 'void'] as const) {
        const l = await loan();
        const id = await transaction();
        const [one, two] = [await pool.connect(), await pool.connect()];
        try {
          await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await one.query('SELECT 1');
          await two.query('BEGIN');
          await two.query(first === 'split' ? rawSplit(id, l.id) : rawVoid(l.id));
          const second = one.query(first === 'split' ? rawVoid(l.id) : rawSplit(id, l.id)).then(
            () => 'written',
            (error: { code?: string }) => error.code,
          );
          await waitForLocks(pool);
          await two.query('COMMIT');
          // With a share lock instead of the write, a stale void would pass and commit (lesson of #50).
          expect(await second, first).toBe('40001');
        } finally {
          await one.query('ROLLBACK');
          one.release();
          two.release();
        }
      }
    });

    it('two split writes naming two Loans in opposite position order: the id order avoids a deadlock', async () => {
      const [x, y] = [await loan(), await loan()];
      const [low, high] = [x.id, y.id].sort();
      const [a, b] = [await transaction({ amount: '2.00' }), await transaction({ amount: '2.00' })];
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM loan WHERE id = $1 FOR UPDATE`, [low]);
        // B queues first on the lower Loan; A names the higher one first.
        const writeB = splits.replaceSplits(b, REALM, [split('1.00', 'LOAN_INTEREST', low), split('1.00', 'LOAN_PRINCIPAL', high)], actor);
        await waitForLocks(pool, 1);
        const writeA = splits.replaceSplits(a, REALM, [split('1.00', 'LOAN_INTEREST', high), split('1.00', 'LOAN_PRINCIPAL', low)], actor);
        await waitForLocks(pool, 2);
        await holder.query('COMMIT');
        expect([(await writeB).kind, (await writeA).kind]).toEqual(['REPLACED', 'REPLACED']);
      } finally {
        holder.release();
      }
    });
  });

  describe('concurrency of corrections (review on #68)', () => {
    /** Two confirmed payments naming the two Loans in opposite position order, `low` < `high`. */
    async function crossedPayments() {
      const [x, y] = [await loan(), await loan()];
      const [low = '', high = ''] = [x.id as string, y.id as string].sort();
      const confirmedWith = async (first: string, second: string) => {
        const id = await transaction({ amount: '2.00' });
        await replaced(id, [split('1.00', 'LOAN_INTEREST', first), split('1.00', 'LOAN_PRINCIPAL', second)]);
        const confirmed = await transactions.confirm(id, REALM, actor);
        if (confirmed.kind !== 'CONFIRMED') throw new Error(confirmed.kind);
        return id;
      };
      return { low, high, lowFirst: await confirmedWith(low, high), highFirst: await confirmedWith(high, low) };
    }
    /** As the splits test: a blocker holds `high`; the high-first correction queues on it first, then the low-first one. */
    async function crossed(replacement: (low: string, high: string) => Parameters<PostgresCorrectionRepository['correct']>[2]['replacement']) {
      const { low, high, lowFirst, highFirst } = await crossedPayments();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM loan WHERE id = $1 FOR UPDATE`, [high]);
        const first = corrections.correct(highFirst, REALM, { reason: 'x', replacement: replacement(low, high) }, actor).then(
          (o) => o.kind,
          (error: { code?: string }) => error.code,
        );
        await waitForLocks(pool, 1);
        const second = corrections.correct(lowFirst, REALM, { reason: 'x', replacement: replacement(low, high) }, actor).then(
          (o) => o.kind,
          (error: { code?: string }) => error.code,
        );
        await waitForLocks(pool, 2);
        await holder.query('COMMIT');
        return [await first, await second];
      } finally {
        holder.release();
      }
    }

    it('two reverses of payments naming two Loans in opposite order: the id-ordered lock of the original’s Loans avoids a deadlock', async () => {
      expect(await crossed(() => null)).toEqual(['CORRECTED', 'CORRECTED']);
    });

    it('the same for correct with a replacement without a Loan', async () => {
      expect(await crossed(() => ({ splits: [split('2.00', 'OTHER')] }))).toEqual(['CORRECTED', 'CORRECTED']);
    });
  });

  describe('the proposal’s inputs', () => {
    it('the Loan, its VALID periods and the Transaction of the Realm, in one snapshot', async () => {
      const l = await loan();
      const created = await terms.create(
        l.id,
        REALM,
        {
          validFrom: day('2027-01-01'),
          interestRate: 6000n,
          repaymentModel: 'ANNUITY',
          scheduledPayment: eur('300.00'),
          firstPaymentDate: day('2027-01-31'),
          principalAtStart: null,
          fixedRateUntil: null,
          initialRepaymentRate: null,
          specialRepaymentLimit: null,
          notes: null,
        },
        actor,
      );
      expect(created.kind).toBe('CREATED');
      const id = await transaction({ amount: '400.00' });
      await replaced(id, [split('400.00', 'OTHER')]);
      const inputs = await terms.proposalInputs(l.id, id, REALM);
      expect(inputs).toMatchObject({
        kind: 'FOUND',
        transaction: { id, bookingDate: '2027-03-01', amount: 40_000n, direction: 'OUTFLOW', status: 'CLASSIFIED', splitCount: 1 },
      });
      expect(inputs.kind === 'FOUND' ? inputs.periods.length : -1).toBe(1);
      expect(await terms.proposalInputs(l.id, id, OTHER_REALM)).toEqual({ kind: 'LOAN_NOT_FOUND' });
      expect(await terms.proposalInputs(l.id, await transaction({ realm: OTHER_REALM }), REALM)).toEqual({ kind: 'TRANSACTION_NOT_FOUND' });
      expect(await terms.proposalInputs(l.id, 'nope', REALM)).toEqual({ kind: 'TRANSACTION_NOT_FOUND' });
      expect(await terms.proposalInputs('nope', id, REALM)).toEqual({ kind: 'LOAN_NOT_FOUND' });
    });
  });

  describe('the schema past the repository (each guard has a counter-check)', () => {
    const insert = (transactionId: string, values: { loanId?: string; code?: string; property?: string; realm?: string }) =>
      pool
        .query(
          `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, loan_id, property_reference_id, created_by)
           SELECT $1, $2, 1, 300.00, 'EUR', id, $3, $4, 'x' FROM financial_category WHERE code = $5`,
          [transactionId, values.realm ?? REALM, values.loanId ?? null, values.property ?? null, values.code ?? 'LOAN_INTEREST'],
        )
        .then(() => 'accepted', reasonOf);

    it('a Loan of the Realm and not VOID; LOAN_INTEREST or LOAN_PRINCIPAL; an OUTFLOW; never with a PropertyReference', async () => {
      const [l, voided, foreign] = [await loan(), await loan(), await loan(OTHER_REALM)];
      await loans.void(voided.id, REALM, 'x', new Date(), actor);
      const outflow = await transaction();
      expect(await insert(outflow, { loanId: foreign.id })).toBe('transaction_split_loan_fk');
      expect(await insert(outflow, { loanId: voided.id })).toBe('(LOAN_NOT_ACTIVE)');
      expect(await insert(outflow, { loanId: l.id, code: 'OTHER' })).toBe('(INVALID_LOAN_SPLIT)');
      expect(await insert(await transaction({ direction: 'INFLOW' }), { loanId: l.id })).toBe('(INVALID_LOAN_SPLIT)');
      const { rows } = await pool.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f9ff01', 'ACTIVE', 'x') RETURNING id`,
        [REALM],
      );
      expect(await insert(outflow, { loanId: l.id, property: rows[0].id })).toBe('transaction_split_loan_no_property');
      expect(await insert(outflow, { loanId: l.id, code: 'LOAN_PRINCIPAL' })).toBe('accepted');
    });

    it('a reversal mirrors loan_id: dropping or changing it is refused at commit, the exact mirror passes', async () => {
      const [l, other] = [await loan(), await loan()];
      const reverseWith = async (loanIds: readonly (string | null)[]) => {
        const original = await confirmedPayment(l.id);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query(
            `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by,
               correction_of_transaction_id, correction_role)
             SELECT mre_realm_id, financial_account_id, amount, currency, 'INFLOW', booking_date, 'CORRECTION', 'CLASSIFIED', 'x', id, 'REVERSAL'
               FROM ledger_transaction WHERE id = $1 RETURNING id`,
            [original],
          );
          const reversal = rows[0].id as string;
          await client.query(
            `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, loan_id, created_by)
             SELECT $1, mre_realm_id, position, amount, currency, financial_category_id, ($3::uuid[])[position], 'x' FROM transaction_split WHERE transaction_id = $2`,
            [reversal, original, loanIds],
          );
          await client.query(`UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x' WHERE id = $1`, [reversal]);
          await client.query(`UPDATE ledger_transaction SET status = 'CORRECTED', version = version + 1 WHERE id = $1`, [original]);
          await client.query('COMMIT');
          return 'accepted';
        } catch (error) {
          await client.query('ROLLBACK');
          return reasonOf(error as Error);
        } finally {
          client.release();
        }
      };
      expect(await reverseWith([null, null])).toBe('does not mirror');
      expect(await reverseWith([l.id, other.id])).toBe('does not mirror');
      expect(await reverseWith([l.id, l.id])).toBe('accepted');
    });

    it('trigger order (review on #67): transaction_split_frozen fires before transaction_split_loan, so the Transaction row comes first', async () => {
      const { rows } = await pool.query(
        `SELECT tgname FROM pg_trigger WHERE tgrelid = 'transaction_split'::regclass AND NOT tgisinternal AND tgtype & 2 = 2 ORDER BY tgname`,
      );
      const names = rows.map((r) => r.tgname as string);
      expect(names).toContain('transaction_split_loan');
      expect(names.indexOf('transaction_split_frozen')).toBeLessThan(names.indexOf('transaction_split_loan'));
    });
  });
});
