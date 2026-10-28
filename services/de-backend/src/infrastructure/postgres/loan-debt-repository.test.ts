import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paymentsInYear, remainingDebt, statementViews, type DebtInputs, type Loan, type StatementData } from '../../domains/financing/index.js';
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

/**
 * VC-3-06 persistence (api-design.md §41.6): the inputs of the remaining debt and the payments in one snapshot (only
 * the splits that count), lender statements with their order of checks, idempotency and void, the comparison following
 * a later correction, a statement against a void of the Loan (RC and RR), and the schema's rules past the repository.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000010';
const OTHER_REALM = '64b0c0ffee00000000000011';
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
const statement = (statementDate: string, balance: string, source = 'Jahreskontoauszug 2027'): StatementData => ({
  statementDate: day(statementDate),
  balance: eur(balance),
  source,
  notes: null,
});

async function waitForLocks(pool: pg.Pool, count = 1): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (
    Number((await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].count) < count
  ) {
    if (Date.now() > deadline) throw new Error(`fewer than ${count} sessions wait on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The trigger's own reason, the constraint's name, or the error code. */
function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return (
    error.constraint ?? /\(([A-Z_]+)\)|only inserted VALID|never edited|never deleted|the only step/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error'
  );
}

describe.skipIf(databaseUrl === undefined)('Remaining debt and lender statements (§41.6)', () => {
  const schema = testSchemaName('loan_debt_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let loans: PostgresLoanRepository;
  let terms: PostgresLoanTermsRepository;
  let allocations: PostgresLoanAllocationRepository;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let corrections: PostgresCorrectionRepository;
  let debt: PostgresLoanDebtRepository;
  let counter = 0;

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
    splits = new PostgresTransactionSplitRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    debt = new PostgresLoanDebtRepository(db);
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
  /** §41.4's example Loan: 1 000.00 from 2027-01-01, 6 % and 300.00 a month from 2027-01-31. */
  async function loan(options: { realm?: string; withTerms?: boolean; disbursementDate?: string } = {}): Promise<Loan> {
    const realm = options.realm ?? REALM;
    const outcome = await loans.create(
      {
        mreRealmId: realm,
        lenderPartyId: await party('Bank', realm),
        borrowerPartyIds: [await party('Anna', realm)],
        principalOriginal: eur('1000.00'),
        startDate: day('2027-01-01'),
        disbursementDate: options.disbursementDate === undefined ? null : day(options.disbursementDate),
        maturityDate: null,
        contractNumber: null,
        acquisitionId: null,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    if (options.withTerms !== false) {
      const created = await terms.create(
        outcome.loan.id,
        realm,
        {
          validFrom: day(options.disbursementDate ?? '2027-01-01'),
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
      if (created.kind !== 'CREATED') throw new Error(created.kind);
    }
    return outcome.loan;
  }
  async function property(): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f80000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [REALM, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function allocate(loanId: string, validFrom: string, shares: [string, bigint, bigint][]): Promise<string> {
    const outcome = await allocations.create(
      loanId,
      REALM,
      {
        validFrom: day(validFrom),
        basis: 'MANUAL',
        allocations: shares.map(([propertyReferenceId, n, d]) => ({ propertyReferenceId, share: { numerator: n, denominator: d }, acquisitionId: null })),
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.set.id;
  }
  async function transaction(bookingDate: string, amount: string, realm = REALM): Promise<string> {
    const { account } = (await accounts.create({ mreRealmId: realm, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor)) as {
      account: { id: string };
    };
    const created = await transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: account.id,
        amount: eur(amount),
        direction: 'OUTFLOW',
        bookingDate: day(bookingDate),
        valueDate: null,
        description: 'Rate',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  /** A payment with its splits; confirmed unless told otherwise. */
  async function pay(loanId: string, bookingDate: string, interest: string, principal: string, confirm = true): Promise<string> {
    const total = (Number(interest) * 100 + Number(principal) * 100) / 100;
    const id = await transaction(bookingDate, total.toFixed(2));
    const replaced = await splits.replaceSplits(id, REALM, [split(interest, 'LOAN_INTEREST', loanId), split(principal, 'LOAN_PRINCIPAL', loanId)], actor);
    if (replaced.kind !== 'REPLACED') throw new Error(replaced.kind);
    if (confirm) {
      const confirmed = await transactions.confirm(id, REALM, actor);
      if (confirmed.kind !== 'CONFIRMED') throw new Error(confirmed.kind);
    }
    return id;
  }
  const inputsOf = async (loanId: string): Promise<DebtInputs> => {
    const inputs = await debt.debtInputs(loanId, REALM);
    if (inputs === undefined) throw new Error('no inputs');
    return inputs;
  };
  const debtOf = async (loanId: string, asOf: string, perProperty = false) => remainingDebt(await inputsOf(loanId), day(asOf), perProperty);

  describe('the inputs', () => {
    it('the example: two confirmed payments give actual = planned = 408.53 on 2027-03-15; per property 272.35 and 136.18', async () => {
      const l = await loan();
      const [a, b] = [await property(), await property()];
      await allocate(l.id, '2027-01-01', [
        [a, 2n, 3n],
        [b, 1n, 3n],
      ]);
      await pay(l.id, '2027-01-31', '5.00', '295.00');
      await pay(l.id, '2027-02-28', '3.53', '296.47');
      expect(await debtOf(l.id, '2027-03-15')).toMatchObject({
        kind: 'LOAN_LEVEL',
        debt: { principalPaid: 59_147n, actual: 40_853n, planned: 40_853n, difference: 0n },
      });
      expect(await debtOf(l.id, '2027-03-15', true)).toMatchObject({
        kind: 'PER_PROPERTY',
        debt: {
          items: [
            { propertyReferenceId: a, actual: 27_235n, planned: 27_235n, difference: 0n },
            { propertyReferenceId: b, actual: 13_618n, planned: 13_618n, difference: 0n },
          ],
        },
      });
    });

    it('only the splits that count: not unconfirmed, not a reversed original or its reversal, the replacement, not another Loan, not interest', async () => {
      const [l, other] = [await loan(), await loan()];
      await pay(l.id, '2027-01-31', '5.00', '295.00', false); // unconfirmed
      const reversed = await pay(l.id, '2027-01-31', '5.00', '100.00');
      expect((await corrections.correct(reversed, REALM, { reason: 'doppelt', replacement: null }, actor)).kind).toBe('CORRECTED');
      const corrected = await pay(l.id, '2027-01-31', '5.00', '200.00');
      const replacement = await corrections.correct(
        corrected,
        REALM,
        { reason: 'Betrag', replacement: { splits: [split('10.00', 'LOAN_INTEREST', l.id), split('195.00', 'LOAN_PRINCIPAL', l.id)] } },
        actor,
      );
      expect(replacement.kind).toBe('CORRECTED');
      await pay(other.id, '2027-01-31', '5.00', '295.00');
      expect((await inputsOf(l.id)).splits.map((s) => [s.category, s.amount])).toEqual([
        ['LOAN_INTEREST', 1_000n],
        ['LOAN_PRINCIPAL', 19_500n],
      ]);
      expect(await debtOf(l.id, '2027-02-01')).toMatchObject({ debt: { principalPaid: 19_500n, actual: 80_500n } });
    });

    it('booking dates up to and including asOf', async () => {
      const l = await loan();
      await pay(l.id, '2027-01-31', '5.00', '295.00');
      expect(await debtOf(l.id, '2027-01-30')).toMatchObject({ debt: { principalPaid: 0n, actual: 100_000n } });
      expect(await debtOf(l.id, '2027-01-31')).toMatchObject({ debt: { principalPaid: 29_500n, actual: 70_500n, planned: 70_500n } });
    });

    it('per property: the set covering asOf; before the first set LOAN_NOT_ALLOCATED, the Loan level still answered', async () => {
      const l = await loan();
      const [a, b] = [await property(), await property()];
      const first = await allocate(l.id, '2027-02-01', [[a, 1n, 1n]]);
      const second = await allocate(l.id, '2027-03-01', [
        [a, 1n, 2n],
        [b, 1n, 2n],
      ]);
      expect(await debtOf(l.id, '2027-01-31', true)).toEqual({ kind: 'LOAN_NOT_ALLOCATED', asOf: '2027-01-31' });
      expect((await debtOf(l.id, '2027-01-31')).kind).toBe('LOAN_LEVEL');
      expect(await debtOf(l.id, '2027-02-28', true)).toMatchObject({ debt: { allocationSetId: first } });
      expect(await debtOf(l.id, '2027-03-01', true)).toMatchObject({ debt: { allocationSetId: second, items: [{ actual: 50_000n }, { actual: 50_000n }] } });
    });

    it('the payments of a year per property with a set change within the year', async () => {
      const l = await loan();
      const [a, b] = [await property(), await property()];
      await allocate(l.id, '2027-01-01', [[a, 1n, 1n]]);
      await allocate(l.id, '2027-02-15', [
        [a, 1n, 2n],
        [b, 1n, 2n],
      ]);
      await pay(l.id, '2027-01-31', '5.00', '295.00');
      await pay(l.id, '2027-02-28', '3.53', '296.47');
      // January wholly to a; February's 3.53 and 296.47 by halves, the odd cent to the smaller propertyReferenceId.
      const feb = (id: string) => (id === [a, b].sort()[0] ? { interest: 177n, principal: 14_824n } : { interest: 176n, principal: 14_823n });
      expect(paymentsInYear(await inputsOf(l.id), 2027, true)).toEqual({
        kind: 'PER_PROPERTY',
        payments: { year: 2027, interest: 853n, principal: 59_147n, payments: 2 },
        items: [
          { propertyReferenceId: a, interest: 500n + feb(a).interest, principal: 29_500n + feb(a).principal },
          { propertyReferenceId: b, interest: feb(b).interest, principal: feb(b).principal },
        ].sort((x, y) => (x.propertyReferenceId < y.propertyReferenceId ? -1 : 1)),
      });
    });

    it('Realm isolation: a foreign or unknown Loan has no inputs', async () => {
      const foreign = await loan({ realm: OTHER_REALM });
      expect(await debt.debtInputs(foreign.id, REALM)).toBeUndefined();
      expect(await debt.debtInputs('nope', REALM)).toBeUndefined();
      expect(await debt.debtInputs('00000000-0000-4000-8000-000000000000', REALM)).toBeUndefined();
    });

    it('one snapshot: a statement committed while the read waits on the allocation sets is not seen', async () => {
      const l = await loan({ withTerms: false });
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        // The read takes its snapshot with the Loan, then waits here, before the splits and the statements.
        await holder.query('LOCK TABLE loan_allocation_set IN ACCESS EXCLUSIVE MODE');
        const reading = debt.debtInputs(l.id, REALM);
        await waitForLocks(pool);
        expect((await debt.createStatement(l.id, REALM, statement('2027-02-01', '1.00'), actor)).kind).toBe('CREATED');
        await holder.query('ROLLBACK');
        expect((await reading)?.statements).toEqual([]);
        expect((await debt.debtInputs(l.id, REALM))?.statements).toHaveLength(1);
      } finally {
        holder.release();
      }
    });
  });

  describe('statements', () => {
    it('create: the order of checks (unknown/foreign → VOID Loan → before debtFrom), the comparison, the audit record', async () => {
      const [l, voided, foreign] = [await loan({ disbursementDate: '2027-01-10' }), await loan({ withTerms: false }), await loan({ realm: OTHER_REALM })];
      expect((await loans.void(voided.id, REALM, 'x', new Date(), actor)).kind).toBe('VOIDED');
      expect(await debt.createStatement(foreign.id, REALM, statement('2027-01-10', '1.00'), actor)).toEqual({ kind: 'LOAN_NOT_FOUND' });
      expect(await debt.createStatement('nope', REALM, statement('2027-01-10', '1.00'), actor)).toEqual({ kind: 'LOAN_NOT_FOUND' });
      expect(await debt.createStatement(voided.id, REALM, statement('2020-01-01', '1.00'), actor)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
      expect(await debt.createStatement(l.id, REALM, statement('2027-01-09', '1.00'), actor)).toEqual({
        kind: 'STATEMENT_BEFORE_DEBT',
        debtFrom: '2027-01-10',
      });
      await pay(l.id, '2027-01-31', '5.00', '295.00');
      const created = await debt.createStatement(l.id, REALM, statement('2027-01-31', '705.10'), actor);
      expect(created).toMatchObject({
        kind: 'CREATED',
        statement: {
          status: 'VALID',
          version: 1,
          statementDate: '2027-01-31',
          source: 'Jahreskontoauszug 2027',
          comparison: { actualOnDate: 70_500n, difference: 10n },
        },
      });
      if (created.kind !== 'CREATED') return;
      const audit = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_type = 'LoanBalanceStatement' AND entity_id = $1`, [
        created.statement.id,
      ]);
      expect(audit.rows).toEqual([
        {
          action: 'CREATED',
          metadata: {
            loanId: l.id,
            statementDate: '2027-01-31',
            balance: { amount: '705.10', currency: 'EUR' },
            source: 'Jahreskontoauszug 2027',
            notes: null,
          },
        },
      ]);
      expect((await pool.query(`SELECT count(*)::int AS n FROM loan_balance_statement WHERE loan_id = $1`, [l.id])).rows[0].n).toBe(1);
    });

    it('idempotency: the same key and payload replays with a fresh comparison; another payload conflicts', async () => {
      const l = await loan();
      const key = { key: `k-${++counter}`, fingerprint: 'f1' };
      const first = await debt.createStatement(l.id, REALM, statement('2027-01-31', '705.00'), actor, key);
      await pay(l.id, '2027-01-31', '5.00', '295.00');
      const again = await debt.createStatement(l.id, REALM, statement('2027-01-31', '705.00'), actor, key);
      expect(again).toMatchObject({
        kind: 'REPLAYED',
        statement: { id: first.kind === 'CREATED' ? first.statement.id : '', comparison: { actualOnDate: 70_500n, difference: 0n } },
      });
      expect(await debt.createStatement(l.id, REALM, statement('2027-01-31', '1.00'), actor, { ...key, fingerprint: 'f2' })).toEqual({
        kind: 'IDEMPOTENCY_CONFLICT',
      });
      expect((await pool.query(`SELECT count(*)::int AS n FROM loan_balance_statement WHERE loan_id = $1`, [l.id])).rows[0].n).toBe(1);
    });

    it('void: version + 1 and audited; again a no-op; If-Match; unknown or of another Loan 404; a VOID Loan 409', async () => {
      const [l, other] = [await loan(), await loan({ withTerms: false })];
      const created = await debt.createStatement(l.id, REALM, statement('2027-01-31', '705.00'), actor);
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      const id = created.statement.id;
      expect(await debt.voidStatement(l.id, id, REALM, 'x', new Date(), actor, [7])).toEqual({
        kind: 'VERSION_CONFLICT',
        expectedVersions: [7],
        currentVersion: 1,
      });
      expect(await debt.voidStatement(other.id, id, REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await debt.voidStatement(l.id, id, OTHER_REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
      const voided = await debt.voidStatement(l.id, id, REALM, 'Tippfehler', new Date('2027-07-01T00:00:00Z'), actor, [1]);
      expect(voided).toMatchObject({ kind: 'VOIDED', changed: true, statement: { status: 'VOID', voidReason: 'Tippfehler', version: 2 } });
      expect(await debt.voidStatement(l.id, id, REALM, 'anders', new Date(), actor, [1])).toMatchObject({
        kind: 'VOIDED',
        changed: false,
        statement: { voidReason: 'Tippfehler', version: 2 },
      });
      const audit = await pool.query(`SELECT action FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at`, [id]);
      expect(audit.rows.map((r) => r.action)).toEqual(['CREATED', 'VOIDED']);

      const live = await debt.createStatement(other.id, REALM, statement('2027-01-31', '1.00'), actor);
      if (live.kind !== 'CREATED') throw new Error(live.kind);
      expect((await loans.void(other.id, REALM, 'x', new Date(), actor)).kind).toBe('VOIDED');
      expect(await debt.voidStatement(other.id, live.statement.id, REALM, 'x', new Date(), actor)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
    });

    it('the comparison follows a later correction of the ledger; the latest statement on or before asOf', async () => {
      const l = await loan();
      const payment = await pay(l.id, '2027-01-31', '5.00', '295.00');
      await debt.createStatement(l.id, REALM, statement('2027-02-01', '705.00'), actor);
      const listed = async () => statementViews(await inputsOf(l.id)).map((s) => [s.comparison.actualOnDate, s.comparison.difference]);
      expect(await listed()).toEqual([[70_500n, 0n]]);
      // The payment was booked on the wrong day: after the statement, so the statement now shows 295.00 less owed.
      expect((await corrections.correct(payment, REALM, { reason: 'Datum', replacement: { bookingDate: day('2027-02-03') } }, actor)).kind).toBe('CORRECTED');
      expect(await listed()).toEqual([[100_000n, -29_500n]]);
      const later = await debt.createStatement(l.id, REALM, statement('2027-03-01', '705.00'), actor);
      expect(await debtOf(l.id, '2027-02-28')).toMatchObject({ debt: { latestStatement: { statementDate: '2027-02-01' } } });
      expect(await debtOf(l.id, '2027-03-01')).toMatchObject({ debt: { latestStatement: { id: later.kind === 'CREATED' ? later.statement.id : '' } } });
    });
  });

  describe('concurrency of a statement and a void of the Loan (P3-D8)', () => {
    const rawStatement = (loanId: string) =>
      `INSERT INTO loan_balance_statement (mre_realm_id, loan_id, status, statement_date, balance, currency, source, created_by)
       VALUES ('${REALM}', '${loanId}', 'VALID', '2027-02-01', 1.00, 'EUR', 'Brief', 'x')`;
    const rawVoid = (loanId: string) => `UPDATE loan SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = '${loanId}'`;

    /** One statement in its own READ COMMITTED transaction, whatever the database's default isolation. */
    const rawInReadCommitted = async (query: string) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        const result = await client.query(query).then(() => 'accepted', reasonOf);
        await client.query(result === 'accepted' ? 'COMMIT' : 'ROLLBACK');
        return result;
      } finally {
        client.release();
      }
    };

    it('READ COMMITTED, a void first: the statement waits on the Loan row and sees VOID, through the repository and past it', async () => {
      for (const path of ['repository', 'raw'] as const) {
        const l = await loan({ withTerms: false });
        const holder = await pool.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(rawVoid(l.id));
          const writing =
            path === 'repository'
              ? debt.createStatement(l.id, REALM, statement('2027-02-01', '1.00'), actor).then((o) => o.kind)
              : rawInReadCommitted(rawStatement(l.id));
          await waitForLocks(pool);
          await holder.query('COMMIT');
          expect(await writing, path).toBe(path === 'repository' ? 'LOAN_NOT_ACTIVE' : '(LOAN_NOT_ACTIVE)');
        } finally {
          holder.release();
        }
      }
    });

    it('REPEATABLE READ past the repository, both orders: the later one fails to serialise', async () => {
      for (const first of ['statement', 'void'] as const) {
        const l = await loan({ withTerms: false });
        const [one, two] = [await pool.connect(), await pool.connect()];
        try {
          await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await one.query('SELECT 1');
          await two.query('BEGIN');
          await two.query(first === 'statement' ? rawStatement(l.id) : rawVoid(l.id));
          const second = one.query(first === 'statement' ? rawVoid(l.id) : rawStatement(l.id)).then(
            () => 'written',
            (error: { code?: string }) => error.code,
          );
          await waitForLocks(pool);
          await two.query('COMMIT');
          // With a share lock instead of the write, a stale void after a statement would pass and commit.
          expect(await second, first).toBe('40001');
        } finally {
          await one.query('ROLLBACK');
          one.release();
          two.release();
        }
      }
    });

    it('REPEATABLE READ: a void of a statement writes the Loan row too', async () => {
      const l = await loan({ withTerms: false });
      const created = await debt.createStatement(l.id, REALM, statement('2027-02-01', '1.00'), actor);
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN');
        await two.query(`UPDATE loan_balance_statement SET status = 'VOID', voided_at = now(), void_reason = 'x', version = 2 WHERE id = $1`, [
          created.statement.id,
        ]);
        const second = one.query(rawVoid(l.id)).then(
          () => 'written',
          (error: { code?: string }) => error.code,
        );
        await waitForLocks(pool);
        await two.query('COMMIT');
        expect(await second).toBe('40001');
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    });
  });

  describe('the schema past the repository (each guard has a counter-check)', () => {
    const insert = (loanId: string, values: { status?: string; date?: string; balance?: string; realm?: string; version?: number; source?: string } = {}) =>
      pool
        .query(
          `INSERT INTO loan_balance_statement (mre_realm_id, loan_id, status, statement_date, balance, currency, source, voided_at, void_reason, created_by, version)
           VALUES ($1, $2, $3, $4, $5, 'EUR', $6, $7, $8, 'x', $9) RETURNING id`,
          [
            values.realm ?? REALM,
            loanId,
            values.status ?? 'VALID',
            values.date ?? '2027-02-01',
            values.balance ?? '1.00',
            values.source ?? 'Brief',
            values.status === 'VOID' ? new Date() : null,
            values.status === 'VOID' ? 'x' : null,
            values.version ?? 1,
          ],
        )
        .then((r) => r.rows[0].id as string, reasonOf);

    it('a Loan of the Realm, not VOID; not before the debt; only inserted VALID with version 1; balance ≥ 0', async () => {
      const [l, voided] = [await loan({ disbursementDate: '2027-01-10', withTerms: false }), await loan({ withTerms: false })];
      await loans.void(voided.id, REALM, 'x', new Date(), actor);
      expect(await insert(l.id, { realm: OTHER_REALM })).toBe('loan_balance_statement_loan_fk');
      expect(await insert(voided.id)).toBe('(LOAN_NOT_ACTIVE)');
      expect(await insert(l.id, { date: '2027-01-09' })).toBe('(STATEMENT_BEFORE_DEBT)');
      expect(await insert(l.id, { status: 'VOID' })).toBe('only inserted VALID');
      expect(await insert(l.id, { version: 2 })).toBe('only inserted VALID');
      expect(await insert(l.id, { balance: '-0.01' })).toBe('loan_balance_statement_balance_check');
      expect(await insert(l.id, { balance: '0.001' })).toBe('loan_balance_statement_balance_check');
      expect(await insert(l.id, { source: ' Brief' })).toBe('loan_balance_statement_source_check');
      expect(await insert(l.id, { date: '2027-01-10', balance: '0.00' })).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('never edited, never deleted; the only step is VALID → VOID with version + 1', async () => {
      const l = await loan({ withTerms: false });
      const id = await insert(l.id);
      const update = (set: string) => pool.query(`UPDATE loan_balance_statement SET ${set} WHERE id = $1`, [id]).then(() => 'accepted', reasonOf);
      expect(await update(`balance = 2.00`)).toBe('never edited');
      expect(await update(`statement_date = '2027-03-01'`)).toBe('never edited');
      expect(await update(`source = 'anders'`)).toBe('never edited');
      expect(await update(`status = 'VOID', voided_at = now(), void_reason = 'x'`)).toBe('the only step');
      expect(await pool.query(`DELETE FROM loan_balance_statement WHERE id = $1`, [id]).then(() => 'accepted', reasonOf)).toBe('never deleted');
      expect(await update(`version = version`)).toBe('accepted');
      expect(await update(`status = 'VOID', voided_at = now(), void_reason = 'x', version = 2`)).toBe('accepted');
      expect(await update(`status = 'VALID', voided_at = NULL, void_reason = NULL, version = 3`)).toBe('the only step');
    });
  });
});
