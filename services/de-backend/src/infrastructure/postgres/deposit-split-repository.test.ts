import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate, Direction, SplitInput } from '../../domains/ledger/index.js';
import type { SecurityDeposit } from '../../domains/security-deposit/index.js';
import { Money } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { PostgresSecurityDepositRepository } from './security-deposit-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionQueries } from './transaction-query-repository.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-5-02 persistence (api-design.md §47.2): splits with `securityDepositId` through the splits command and `correct` /
 * `reverse`, the order of checks, what counts, a deposit with splits that cannot be voided, the lock order
 * Transaction → Loan → SecurityDeposit under concurrency (RC and RR), and the schema's rules past the repository.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000052';
const OTHER_REALM = '64b0c0ffee00000000000053';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, financialCategoryCode: string, securityDepositId: string | null = null, extra: Partial<SplitInput> = {}): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId: null,
  loanId: null,
  securityDepositId,
  description: null,
  ...extra,
});
let tenantCounter = 0;
const nextTenant = () => `6512f0c2a1b3${(++tenantCounter).toString(16).padStart(12, '0')}`;

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
  return error.constraint ?? /\(([A-Z_]+)\)|does not mirror/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error';
}

describe.skipIf(databaseUrl === undefined)('Security deposit splits (§47.2)', () => {
  const schema = testSchemaName('deposit_split_test');
  let pool: pg.Pool;
  let deposits: PostgresSecurityDepositRepository;
  let loans: PostgresLoanRepository;
  let parties: PostgresPartyRepository;
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
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    deposits = new PostgresSecurityDepositRepository(db);
    loans = new PostgresLoanRepository(db);
    parties = new PostgresPartyRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    queries = new PostgresTransactionQueries(db);
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
  async function voidedDeposit(): Promise<SecurityDeposit> {
    const d = await deposit();
    expect((await deposits.void(d.id, REALM, 'falsch', new Date(), actor)).kind).toBe('VOIDED');
    return d;
  }
  async function party(name: string): Promise<string> {
    const outcome = await parties.create(
      {
        mreRealmId: REALM,
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
  async function loan(): Promise<string> {
    const outcome = await loans.create(
      {
        mreRealmId: REALM,
        lenderPartyId: await party('Bank'),
        borrowerPartyIds: [await party('Anna')],
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
    return outcome.loan.id;
  }
  async function account(realm = REALM): Promise<string> {
    const outcome = await accounts.create({ mreRealmId: realm, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account.id;
  }
  async function transaction(options: { direction?: Direction; amount?: string; realm?: string } = {}): Promise<string> {
    const realm = options.realm ?? REALM;
    const created = await transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: await account(realm),
        amount: eur(options.amount ?? '1500.00'),
        direction: options.direction ?? 'INFLOW',
        bookingDate: day('2027-02-01'),
        valueDate: null,
        description: 'Kaution',
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
  async function confirmed(set: readonly SplitInput[], options: { direction?: Direction; amount?: string } = {}): Promise<string> {
    const id = await transaction(options);
    await replaced(id, set);
    const outcome = await transactions.confirm(id, REALM, actor);
    if (outcome.kind !== 'CONFIRMED') throw new Error(outcome.kind);
    return id;
  }
  /** What counts for a deposit (§47.2): splits of current Transactions, reversals left out, per category and direction. */
  async function counted(securityDepositId: string): Promise<Record<string, string>> {
    const { rows } = await pool.query(
      `SELECT c.code || '/' || t.direction AS kind, sum(s.amount)::text AS total FROM transaction_split s
         JOIN ledger_transaction t ON t.id = s.transaction_id JOIN financial_category c ON c.id = s.financial_category_id
        WHERE s.security_deposit_id = $1 AND t.status IN ('CONFIRMED', 'RECONCILED') AND t.correction_role IS DISTINCT FROM 'REVERSAL'
        GROUP BY 1 ORDER BY 1`,
      [securityDepositId],
    );
    return Object.fromEntries(rows.map((r) => [r.kind, r.total]));
  }

  describe('the splits command', () => {
    it('a receipt, a repayment and an interest credit; reads carry the id; the same set is a no-op, a changed id a change', async () => {
      const [d1, d2] = [await deposit(), await deposit()];
      const id = await transaction();
      const first = await replaced(id, [split('1500.00', 'SECURITY_DEPOSIT', d1.id)]);
      expect(first.splits.map((s) => s.securityDepositId)).toEqual([d1.id]);
      expect((await queries.get(id, REALM))?.splits.map((s) => [s.financialCategoryCode, s.securityDepositId])).toEqual([['SECURITY_DEPOSIT', d1.id]]);
      const again = await replaced(id, [split('1500.00', 'SECURITY_DEPOSIT', d1.id)]);
      expect([again.changed, again.transaction.version]).toEqual([false, first.transaction.version]);
      const moved = await replaced(id, [split('1500.00', 'SECURITY_DEPOSIT', d2.id)]);
      expect([moved.changed, moved.transaction.version]).toEqual([true, first.transaction.version + 1]);
      // Interest on an INFLOW; a repayment on an OUTFLOW.
      const interest = await transaction({ amount: '1.20' });
      expect((await replaced(interest, [split('1.20', 'SECURITY_DEPOSIT_INTEREST', d1.id)])).splits[0]?.securityDepositId).toBe(d1.id);
      const repayment = await transaction({ direction: 'OUTFLOW', amount: '1500.00' });
      expect((await replaced(repayment, [split('1500.00', 'SECURITY_DEPOSIT', d1.id)])).splits[0]?.securityDepositId).toBe(d1.id);
      // A deposit-category split without an id stays allowed and counts for no deposit.
      expect((await replaced(id, [split('1500.00', 'SECURITY_DEPOSIT')])).splits.map((s) => s.securityDepositId)).toEqual([null]);
      const audit = await pool.query(
        `SELECT metadata->'splits' AS splits FROM audit_record WHERE entity_id = $1 AND action = 'SPLITS_REPLACED' ORDER BY occurred_at`,
        [id],
      );
      expect(audit.rows[1].splits.map((s: { securityDepositId?: string }) => s.securityDepositId)).toEqual([d2.id]);
    });

    it('order of checks: an unknown or foreign deposit, then the category, then the interest direction, then a VOID deposit; nothing written', async () => {
      const [active, voided, foreign] = [await deposit(), await voidedDeposit(), await deposit(OTHER_REALM)];
      const unknown = '00000000-0000-4000-8000-000000000000';
      const inflow = await transaction();
      const outflow = await transaction({ direction: 'OUTFLOW' });
      const refused = (id: string, set: readonly SplitInput[]) => splits.replaceSplits(id, REALM, set, actor);
      expect(await refused(inflow, [split('1500.00', 'SECURITY_DEPOSIT', foreign.id)])).toEqual({
        kind: 'SECURITY_DEPOSIT_NOT_FOUND',
        securityDepositId: foreign.id,
      });
      expect(await refused(outflow, [split('1.00', 'OTHER', voided.id), split('1499.00', 'SECURITY_DEPOSIT_INTEREST', unknown)])).toEqual({
        kind: 'SECURITY_DEPOSIT_NOT_FOUND',
        securityDepositId: unknown,
      });
      expect(await refused(outflow, [split('1.00', 'SECURITY_DEPOSIT_INTEREST', voided.id), split('1499.00', 'RENT_BASE', active.id)])).toEqual({
        kind: 'INVALID_SECURITY_DEPOSIT_SPLIT',
        position: 2,
        reason: 'CATEGORY',
      });
      expect(await refused(outflow, [split('1.00', 'SECURITY_DEPOSIT', active.id), split('1499.00', 'SECURITY_DEPOSIT_INTEREST', voided.id)])).toEqual({
        kind: 'INVALID_SECURITY_DEPOSIT_SPLIT',
        position: 2,
        reason: 'DIRECTION',
      });
      expect(await refused(inflow, [split('1.00', 'SECURITY_DEPOSIT', active.id), split('1499.00', 'SECURITY_DEPOSIT', voided.id)])).toEqual({
        kind: 'DEPOSIT_NOT_ACTIVE',
        securityDepositId: voided.id,
        status: 'VOID',
      });
      // The existing checks come first: a sum mismatch before the deposits.
      expect((await refused(inflow, [split('1.00', 'SECURITY_DEPOSIT', unknown)])).kind).toBe('SUM_MISMATCH');
      expect((await pool.query(`SELECT count(*)::int AS n FROM transaction_split WHERE transaction_id IN ($1, $2)`, [inflow, outflow])).rows[0].n).toBe(0);
    });

    it('the Loan checks come before the deposit checks; a set with a Loan split and a deposit split passes', async () => {
      const d = await deposit();
      const l = await loan();
      const outflow = await transaction({ direction: 'OUTFLOW', amount: '2.00' });
      // Both refuse: an unknown Loan is answered first.
      const unknownLoan = '00000000-0000-4000-8000-000000000001';
      expect(
        await splits.replaceSplits(outflow, REALM, [split('1.00', 'RENT_BASE', d.id), split('1.00', 'LOAN_INTEREST', null, { loanId: unknownLoan })], actor),
      ).toEqual({ kind: 'LOAN_NOT_FOUND', loanId: unknownLoan });
      const both = await replaced(outflow, [split('1.00', 'LOAN_INTEREST', null, { loanId: l }), split('1.00', 'SECURITY_DEPOSIT', d.id)]);
      expect(both.splits.map((s) => [s.loanId, s.securityDepositId])).toEqual([
        [l, null],
        [null, d.id],
      ]);
    });

    it('several deposits in one Transaction; a mixed rent-and-deposit transfer', async () => {
      const [d1, d2] = [await deposit(), await deposit()];
      const pooled = await transaction({ amount: '2.40' });
      expect(
        (await replaced(pooled, [split('1.20', 'SECURITY_DEPOSIT_INTEREST', d1.id), split('1.20', 'SECURITY_DEPOSIT_INTEREST', d2.id)])).splits.map(
          (s) => s.securityDepositId,
        ),
      ).toEqual([d1.id, d2.id]);
      const mixed = await transaction({ amount: '2300.00' });
      const set = await replaced(mixed, [
        split('650.00', 'RENT_BASE'),
        split('150.00', 'RENT_OPERATING_COST_ADVANCE'),
        split('1500.00', 'SECURITY_DEPOSIT', d1.id),
      ]);
      expect(set.splits.map((s) => [s.financialCategoryCode, s.securityDepositId])).toEqual([
        ['RENT_BASE', null],
        ['RENT_OPERATING_COST_ADVANCE', null],
        ['SECURITY_DEPOSIT', d1.id],
      ]);
    });
  });

  describe('void of a deposit with splits', () => {
    it('DEPOSIT_HAS_SPLITS through the repository and past it; the guard’s no-op write passes; once unreferenced the void passes', async () => {
      const d = await deposit();
      const id = await transaction();
      await replaced(id, [split('1500.00', 'SECURITY_DEPOSIT', d.id)]);
      expect(await deposits.void(d.id, REALM, 'x', new Date(), actor)).toEqual({ kind: 'DEPOSIT_HAS_SPLITS', transactionIds: [id] });
      const refused = await pool
        .query(`UPDATE security_deposit SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'x', version = version + 1 WHERE id = $1`, [
          d.id,
        ])
        .then(() => 'accepted', reasonOf);
      expect(refused).toBe('(DEPOSIT_HAS_SPLITS)');
      await expect(pool.query(`UPDATE security_deposit SET version = version WHERE id = $1`, [d.id])).resolves.toBeDefined();
      await expect(deposits.amend(d.id, REALM, { notes: 'x' }, actor)).resolves.toMatchObject({ kind: 'AMENDED', changed: true });
      await replaced(id, [split('1500.00', 'SECURITY_DEPOSIT')]);
      expect((await deposits.void(d.id, REALM, 'x', new Date(), actor)).kind).toBe('VOIDED');
    });
  });

  describe('corrections of deposit cash', () => {
    it('correct: copied splits keep the id; the replacement may name another deposit or none; interest needs an INFLOW', async () => {
      const [d1, d2] = [await deposit(), await deposit()];
      const original = await confirmed([split('1500.00', 'SECURITY_DEPOSIT', d1.id)]);
      expect(await counted(d1.id)).toEqual({ 'SECURITY_DEPOSIT/INFLOW': '1500.00' });

      const refusedInterest = await corrections.correct(
        original,
        REALM,
        { reason: 'Richtung', replacement: { direction: 'OUTFLOW', splits: [split('1500.00', 'SECURITY_DEPOSIT_INTEREST', d1.id)] } },
        actor,
      );
      expect(refusedInterest).toEqual({ kind: 'INVALID_SECURITY_DEPOSIT_SPLIT', position: 1, reason: 'DIRECTION' });
      const refusedCategory = await corrections.correct(
        original,
        REALM,
        { reason: 'Kategorie', replacement: { splits: [split('1500.00', 'RENT_BASE', d2.id)] } },
        actor,
      );
      expect(refusedCategory).toEqual({ kind: 'INVALID_SECURITY_DEPOSIT_SPLIT', position: 1, reason: 'CATEGORY' });

      const copied = await corrections.correct(original, REALM, { reason: 'Datum', replacement: { bookingDate: day('2027-02-02') } }, actor);
      if (copied.kind !== 'CORRECTED' || copied.result.replacement === null) throw new Error(copied.kind);
      const depositIdsOf = async (id: string) => (await queries.get(id, REALM))?.splits.map((s) => s.securityDepositId);
      expect(await depositIdsOf(copied.result.reversal.id)).toEqual([d1.id]);
      expect(await depositIdsOf(copied.result.replacement.id)).toEqual([d1.id]);
      expect(await counted(d1.id)).toEqual({ 'SECURITY_DEPOSIT/INFLOW': '1500.00' });

      // The wrong deposit was named: the next replacement moves the receipt to d2, then to none.
      const moved = await corrections.correct(
        copied.result.replacement.id,
        REALM,
        { reason: 'andere Kaution', replacement: { splits: [split('1500.00', 'SECURITY_DEPOSIT', d2.id)] } },
        actor,
      );
      if (moved.kind !== 'CORRECTED' || moved.result.replacement === null) throw new Error(moved.kind);
      expect([await counted(d1.id), await counted(d2.id)]).toEqual([{}, { 'SECURITY_DEPOSIT/INFLOW': '1500.00' }]);
      const none = await corrections.correct(
        moved.result.replacement.id,
        REALM,
        { reason: 'Miete', replacement: { splits: [split('1500.00', 'RENT_BASE')] } },
        actor,
      );
      expect(none.kind).toBe('CORRECTED');
      expect(await counted(d2.id)).toEqual({});
    });

    it('reverse of a receipt and of a repayment: the reversal mirrors the id in the opposite direction, nothing counts after it', async () => {
      const d = await deposit();
      const receipt = await confirmed([split('1500.00', 'SECURITY_DEPOSIT', d.id)]);
      const repayment = await confirmed([split('1500.00', 'SECURITY_DEPOSIT', d.id)], { direction: 'OUTFLOW' });
      const interest = await confirmed([split('1.20', 'SECURITY_DEPOSIT_INTEREST', d.id)], { amount: '1.20' });
      expect(await counted(d.id)).toEqual({
        'SECURITY_DEPOSIT/INFLOW': '1500.00',
        'SECURITY_DEPOSIT/OUTFLOW': '1500.00',
        'SECURITY_DEPOSIT_INTEREST/INFLOW': '1.20',
      });
      for (const id of [receipt, repayment, interest]) {
        const reversed = await corrections.correct(id, REALM, { reason: 'doppelt', replacement: null }, actor);
        if (reversed.kind !== 'CORRECTED') throw new Error(reversed.kind);
        expect((await queries.get(reversed.result.reversal.id, REALM))?.splits.map((s) => s.securityDepositId)).toEqual([d.id]);
      }
      expect(await counted(d.id)).toEqual({});
      // The reversals' splits are the history: the deposit cannot be voided.
      expect((await deposits.void(d.id, REALM, 'x', new Date(), actor)).kind).toBe('DEPOSIT_HAS_SPLITS');
    });
  });

  describe('concurrency (Transaction → Loan → SecurityDeposit, the guard writing the deposit row, P5-D9)', () => {
    const rawSplit = (transactionId: string, depositId: string) =>
      `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, security_deposit_id, created_by)
       SELECT '${transactionId}', '${REALM}', 1, 1500.00, 'EUR', id, '${depositId}', 'x' FROM financial_category WHERE code = 'SECURITY_DEPOSIT'`;
    const rawVoid = (depositId: string) =>
      `UPDATE security_deposit SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'x', version = version + 1 WHERE id = '${depositId}'`;

    it('READ COMMITTED, a split write first: the void waits on the deposit row and answers DEPOSIT_HAS_SPLITS', async () => {
      const d = await deposit();
      const id = await transaction();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(rawSplit(id, d.id));
        const voiding = deposits.void(d.id, REALM, 'x', new Date(), actor);
        await waitForLocks(pool);
        await holder.query('COMMIT');
        expect(await voiding).toEqual({ kind: 'DEPOSIT_HAS_SPLITS', transactionIds: [id] });
      } finally {
        holder.release();
      }
    });

    it('READ COMMITTED, a void first: the split write waits on the deposit row and answers DEPOSIT_NOT_ACTIVE', async () => {
      const d = await deposit();
      const id = await transaction();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(rawVoid(d.id));
        const writing = splits.replaceSplits(id, REALM, [split('1500.00', 'SECURITY_DEPOSIT', d.id)], actor);
        await waitForLocks(pool);
        await holder.query('COMMIT');
        expect(await writing).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', securityDepositId: d.id, status: 'VOID' });
      } finally {
        holder.release();
      }
    });

    it('REPEATABLE READ past the repository, both orders: the later one fails to serialise', async () => {
      for (const first of ['split', 'void'] as const) {
        const d = await deposit();
        const id = await transaction();
        const [one, two] = [await pool.connect(), await pool.connect()];
        try {
          await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await one.query('SELECT 1');
          await two.query('BEGIN');
          await two.query(first === 'split' ? rawSplit(id, d.id) : rawVoid(d.id));
          const second = one.query(first === 'split' ? rawVoid(d.id) : rawSplit(id, d.id)).then(
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

    it('two split writes naming two deposits in opposite position order: the id order avoids a deadlock', async () => {
      const [x, y] = [await deposit(), await deposit()];
      const [low = '', high = ''] = [x.id as string, y.id as string].sort();
      const [a, b] = [await transaction({ amount: '2.00' }), await transaction({ amount: '2.00' })];
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM security_deposit WHERE id = $1 FOR UPDATE`, [low]);
        // B queues first on the lower deposit; A names the higher one first.
        const writeB = splits.replaceSplits(b, REALM, [split('1.00', 'SECURITY_DEPOSIT', low), split('1.00', 'SECURITY_DEPOSIT', high)], actor);
        await waitForLocks(pool, 1);
        const writeA = splits.replaceSplits(a, REALM, [split('1.00', 'SECURITY_DEPOSIT', high), split('1.00', 'SECURITY_DEPOSIT', low)], actor);
        await waitForLocks(pool, 2);
        await holder.query('COMMIT');
        expect([(await writeB).kind, (await writeA).kind]).toEqual(['REPLACED', 'REPLACED']);
      } finally {
        holder.release();
      }
    });

    it('a split set with a Loan and a deposit against a void of each: the split write waits on each row and sees the void', async () => {
      for (const which of ['loan', 'deposit'] as const) {
        const d = await deposit();
        const l = await loan();
        const id = await transaction({ direction: 'OUTFLOW', amount: '2.00' });
        const holder = await pool.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(
            which === 'loan' ? `UPDATE loan SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = '${l}'` : rawVoid(d.id),
          );
          const writing = splits.replaceSplits(
            id,
            REALM,
            [split('1.00', 'LOAN_INTEREST', null, { loanId: l }), split('1.00', 'SECURITY_DEPOSIT', d.id)],
            actor,
          );
          await waitForLocks(pool);
          await holder.query('COMMIT');
          expect(await writing, which).toMatchObject({ kind: which === 'loan' ? 'LOAN_NOT_ACTIVE' : 'DEPOSIT_NOT_ACTIVE' });
        } finally {
          holder.release();
        }
      }
    });

    it('two reverses of receipts naming two deposits in opposite order: the id-ordered lock avoids a deadlock', async () => {
      const [x, y] = [await deposit(), await deposit()];
      const [low = '', high = ''] = [x.id as string, y.id as string].sort();
      const lowFirst = await confirmed([split('1.00', 'SECURITY_DEPOSIT', low), split('1.00', 'SECURITY_DEPOSIT', high)], { amount: '2.00' });
      const highFirst = await confirmed([split('1.00', 'SECURITY_DEPOSIT', high), split('1.00', 'SECURITY_DEPOSIT', low)], { amount: '2.00' });
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT id FROM security_deposit WHERE id = $1 FOR UPDATE`, [high]);
        const first = corrections.correct(highFirst, REALM, { reason: 'x', replacement: null }, actor).then(
          (o) => o.kind,
          (error: { code?: string }) => error.code,
        );
        await waitForLocks(pool, 1);
        const second = corrections.correct(lowFirst, REALM, { reason: 'x', replacement: null }, actor).then(
          (o) => o.kind,
          (error: { code?: string }) => error.code,
        );
        await waitForLocks(pool, 2);
        await holder.query('COMMIT');
        expect([await first, await second]).toEqual(['CORRECTED', 'CORRECTED']);
      } finally {
        holder.release();
      }
    });
  });

  describe('the schema past the repository (each guard has a counter-check)', () => {
    const insert = (transactionId: string, values: { depositId?: string; code?: string; property?: string; loanId?: string; realm?: string }) =>
      pool
        .query(
          `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, security_deposit_id, property_reference_id, loan_id, created_by)
           SELECT $1, $2, 1, 1500.00, 'EUR', id, $3, $4, $5, 'x' FROM financial_category WHERE code = $6`,
          [transactionId, values.realm ?? REALM, values.depositId ?? null, values.property ?? null, values.loanId ?? null, values.code ?? 'SECURITY_DEPOSIT'],
        )
        .then(() => 'accepted', reasonOf);

    it('a deposit of the Realm and not VOID; the two categories; interest only on an INFLOW; never with a PropertyReference or a Loan', async () => {
      const [d, voided, foreign] = [await deposit(), await voidedDeposit(), await deposit(OTHER_REALM)];
      const inflow = await transaction();
      const outflow = await transaction({ direction: 'OUTFLOW' });
      expect(await insert(inflow, { depositId: foreign.id })).toBe('transaction_split_security_deposit_fk');
      expect(await insert(inflow, { depositId: voided.id })).toBe('(DEPOSIT_NOT_ACTIVE)');
      expect(await insert(inflow, { depositId: d.id, code: 'RENT_BASE' })).toBe('(INVALID_SECURITY_DEPOSIT_SPLIT)');
      expect(await insert(outflow, { depositId: d.id, code: 'SECURITY_DEPOSIT_INTEREST' })).toBe('(INVALID_SECURITY_DEPOSIT_SPLIT)');
      const { rows } = await pool.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f9fe01', 'ACTIVE', 'x') RETURNING id`,
        [REALM],
      );
      expect(await insert(inflow, { depositId: d.id, property: rows[0].id })).toBe('transaction_split_security_deposit_alone');
      // With a Loan, the Loan trigger (it sorts first) already refuses every deposit category; the CHECK is shown with it
      // disabled in a transaction that is rolled back.
      const loanId = await loan();
      expect(await insert(outflow, { depositId: d.id, loanId })).toBe('(INVALID_LOAN_SPLIT)');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE transaction_split DISABLE TRIGGER transaction_split_loan');
        const withLoan = await client
          .query(
            `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, security_deposit_id, loan_id, created_by)
             SELECT $1, $2, 1, 1500.00, 'EUR', id, $3, $4, 'x' FROM financial_category WHERE code = 'SECURITY_DEPOSIT'`,
            [outflow, REALM, d.id, loanId],
          )
          .then(() => 'accepted', reasonOf);
        expect(withLoan).toBe('transaction_split_security_deposit_alone');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(await insert(outflow, { depositId: d.id })).toBe('accepted');
      expect(await insert(inflow, { depositId: d.id, code: 'SECURITY_DEPOSIT_INTEREST' })).toBe('accepted');
    });

    it('an OUTFLOW reversal mirroring an interest credit is allowed; dropping or changing the id is refused at commit', async () => {
      const [d, other] = [await deposit(), await deposit()];
      const reverseWith = async (depositId: string | null) => {
        const original = await confirmed([split('1.20', 'SECURITY_DEPOSIT_INTEREST', d.id)], { amount: '1.20' });
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query(
            `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by,
               correction_of_transaction_id, correction_role)
             SELECT mre_realm_id, financial_account_id, amount, currency, 'OUTFLOW', booking_date, 'CORRECTION', 'CLASSIFIED', 'x', id, 'REVERSAL'
               FROM ledger_transaction WHERE id = $1 RETURNING id`,
            [original],
          );
          const reversal = rows[0].id as string;
          await client.query(
            `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, security_deposit_id, created_by)
             SELECT $1, mre_realm_id, position, amount, currency, financial_category_id, $3::uuid, 'x' FROM transaction_split WHERE transaction_id = $2`,
            [reversal, original, depositId],
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
      expect(await reverseWith(null)).toBe('does not mirror');
      expect(await reverseWith(other.id)).toBe('does not mirror');
      expect(await reverseWith(d.id)).toBe('accepted');
    });

    it('trigger order: transaction_split_frozen, then transaction_split_loan, then transaction_split_security_deposit', async () => {
      const { rows } = await pool.query(
        `SELECT tgname FROM pg_trigger WHERE tgrelid = 'transaction_split'::regclass AND NOT tgisinternal AND tgtype & 2 = 2 ORDER BY tgname`,
      );
      const names = rows.map((r) => r.tgname as string);
      expect(names).toContain('transaction_split_security_deposit');
      expect(names.indexOf('transaction_split_frozen')).toBeLessThan(names.indexOf('transaction_split_loan'));
      expect(names.indexOf('transaction_split_loan')).toBeLessThan(names.indexOf('transaction_split_security_deposit'));
    });

    it('the category SECURITY_DEPOSIT_INTEREST is seeded with type SECURITY_DEPOSIT, never INCOME', async () => {
      const { rows } = await pool.query(`SELECT code, category_type, active FROM financial_category WHERE code LIKE 'SECURITY_DEPOSIT%' ORDER BY code`);
      expect(rows).toEqual([
        { code: 'SECURITY_DEPOSIT', category_type: 'SECURITY_DEPOSIT', active: true },
        { code: 'SECURITY_DEPOSIT_INTEREST', category_type: 'SECURITY_DEPOSIT', active: true },
      ]);
    });
  });
});
