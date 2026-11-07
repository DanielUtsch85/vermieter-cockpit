import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loanSchedule,
  proposePayment,
  reconciledPlan,
  remainingDebt,
  termsFingerprint,
  type Loan,
  type LoanTermsData,
  type PaymentIntervalMonths,
} from '../../domains/financing/index.js';
import type { BusinessDate, SplitInput } from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLoanDebtRepository } from './loan-debt-repository.js';
import { loanPeriodFactsOf } from './loan-interest-periods.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { PostgresLoanTermsRepository } from './loan-terms-repository.js';
import { migrateToLatest } from './migrate.js';
import { migrations } from './migrations/index.js';
import { PostgresPartyRepository } from './party-repository.js';
import { withMigrationLock } from './tax-year.test-support.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-X-53 persistence (api-design.md §58O, migration 0070; Entscheidung des Projektinhabers, 2026-11-05): the interval
 * stored and read, its AuditRecords, the idempotency fingerprint, the schedule, remaining debt and proposal through the
 * real tables (the rebase on the counted splits in one snapshot, Taxation on the contract plan), reads writing nothing,
 * Realm isolation, and 0070 past the repository (the CHECK, the frozen guard, existing rows, `down`), each with its
 * counter-check. Synthetic data only.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee000000000005a0';
const OTHER_REALM = '64b0c0ffee000000000005a1';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, financialCategoryCode: string, loanId: string): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId: null,
  loanId,
  securityDepositId: null,
  description: null,
});
const quarterly = (overrides: Partial<LoanTermsData> = {}): LoanTermsData => ({
  validFrom: day('2027-01-01'),
  interestRate: 3000n,
  repaymentModel: 'ANNUITY',
  scheduledPayment: eur('1800.00'),
  firstPaymentDate: day('2027-03-31'),
  principalAtStart: null,
  fixedRateUntil: null,
  initialRepaymentRate: null,
  specialRepaymentLimit: null,
  notes: null,
  paymentIntervalMonths: 3,
  ...overrides,
});

describe.skipIf(databaseUrl === undefined)('the payment interval through PostgreSQL (§58O, migration 0070)', () => {
  const schema = testSchemaName('loan_interval_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let loans: PostgresLoanRepository;
  let terms: PostgresLoanTermsRepository;
  let debt: PostgresLoanDebtRepository;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 6 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    parties = new PostgresPartyRepository(db);
    loans = new PostgresLoanRepository(db);
    terms = new PostgresLoanTermsRepository(db);
    debt = new PostgresLoanDebtRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function party(name: string, realm: string): Promise<string> {
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
  async function loan(realm = REALM, disbursementDate: string | null = null): Promise<Loan> {
    const outcome = await loans.create(
      {
        mreRealmId: realm,
        lenderPartyId: await party('Bank', realm),
        borrowerPartyIds: [await party('Anna', realm)],
        principalOriginal: eur('120000.00'),
        startDate: day('2027-01-01'),
        disbursementDate: disbursementDate === null ? null : day(disbursementDate),
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
  async function appended(loanId: string, data: LoanTermsData, realm = REALM) {
    const outcome = await terms.create(loanId, realm, data, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.terms;
  }
  async function debit(bookingDate: string, amount: string, description: string, realm = REALM): Promise<string> {
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
        description,
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  async function pay(loanId: string, bookingDate: string, parts: readonly [string, string][], realm = REALM): Promise<string> {
    const total = parts.reduce((s, [a]) => s + Math.round(Number(a) * 100), 0);
    const id = await debit(bookingDate, (total / 100).toFixed(2), 'Rate', realm);
    const replaced = await splits.replaceSplits(
      id,
      realm,
      parts.map(([amount, code]) => split(amount, code, loanId)),
      actor,
    );
    if (replaced.kind !== 'REPLACED') throw new Error(replaced.kind);
    const confirmed = await transactions.confirm(id, realm, actor);
    if (confirmed.kind !== 'CONFIRMED') throw new Error(confirmed.kind);
    return id;
  }
  const audits = async () => Number((await pool.query(`SELECT count(*) FROM audit_record`)).rows[0].count);

  it('create and read with each value; the AuditRecord carries the interval; VOIDED unchanged; re-entered as void + create', async () => {
    for (const n of [1, 3, 6, 12] as PaymentIntervalMonths[]) {
      const l = await loan();
      const created = await appended(l.id, quarterly({ paymentIntervalMonths: n, scheduledPayment: eur('9000.00') }));
      expect(created.paymentIntervalMonths).toBe(n);
      expect((await terms.list(l.id, REALM))?.map((t) => t.paymentIntervalMonths)).toEqual([n]);
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_type = 'LoanTerms' AND entity_id = $1 AND action = 'CREATED'`, [
        created.id,
      ]);
      expect(audit.rows[0].metadata.paymentIntervalMonths).toBe(n);
    }
    // Entered monthly by mistake, then re-entered with the interval: void + create, two records each.
    const l = await loan();
    const wrong = await appended(l.id, quarterly({ paymentIntervalMonths: 1 }));
    const voided = await terms.void(l.id, wrong.id, REALM, 'Intervall fehlt', new Date(), actor);
    expect(voided).toMatchObject({ kind: 'VOIDED', terms: { status: 'VOID', paymentIntervalMonths: 1 } });
    const right = await appended(l.id, quarterly());
    const history = await pool.query(
      `SELECT entity_id, action, metadata FROM audit_record WHERE entity_type = 'LoanTerms' AND entity_id = ANY($1) ORDER BY occurred_at, action`,
      [[wrong.id, right.id]],
    );
    expect(history.rows.map((r) => [r.entity_id === wrong.id ? 'wrong' : 'right', r.action, r.metadata.paymentIntervalMonths ?? null])).toEqual([
      ['wrong', 'CREATED', 1],
      ['wrong', 'VOIDED', null],
      ['right', 'CREATED', 3],
    ]);
    expect((await terms.list(l.id, REALM, 'VALID'))?.map((t) => t.paymentIntervalMonths)).toEqual([3]);
  });

  it('idempotency: a key without the interval replays (omitted and 1 are one request); the same key with 3 conflicts; an older snapshot reads 1', async () => {
    const l = await loan();
    const monthly = quarterly({ paymentIntervalMonths: 1, scheduledPayment: eur('600.00'), firstPaymentDate: day('2027-01-31') });
    const key = { key: `k-${l.id}`, fingerprint: termsFingerprint(l.id, monthly) };
    expect((await terms.create(l.id, REALM, monthly, actor, key)).kind).toBe('CREATED');
    expect((await terms.create(l.id, REALM, monthly, actor, key)).kind).toBe('REPLAYED');
    const withInterval = { ...monthly, paymentIntervalMonths: 3 as const };
    expect((await terms.create(l.id, REALM, withInterval, actor, { key: key.key, fingerprint: termsFingerprint(l.id, withInterval) })).kind).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    // A result stored before VC-X-53 has no paymentIntervalMonths: it replays as monthly.
    await pool.query(`UPDATE idempotency_key SET result = result - 'paymentIntervalMonths' WHERE key = $1`, [key.key]);
    expect(await terms.create(l.id, REALM, monthly, actor, key)).toMatchObject({ kind: 'REPLAYED', terms: { paymentIntervalMonths: 1 } });
  });

  it('the schedule, remaining debt and proposal through the real tables: Loan Q quarterly, a stub debit, the purpose text; reads write nothing', async () => {
    const l = await loan();
    await appended(l.id, quarterly());
    const stub = await pay(l.id, '2027-03-31', [
      ['960.00', 'LOAN_INTEREST'],
      ['840.00', 'LOAN_PRINCIPAL'],
    ]);
    // The application's reads, as `getLoanSchedule` and `getPaymentProposal` compose them (infrastructure tests do not import the application).
    const scheduleOf = async () => {
      const inputs = await terms.scheduleInputs(l.id, REALM);
      if (inputs === undefined) throw new Error('no inputs');
      const r = reconciledPlan(inputs.loan, inputs.periods, inputs.splits);
      return { ...r.plan.schedule, rebasedOn: r.rebases.at(-1) ?? null, deviations: r.deviations };
    };
    const proposalOf = async (transactionId: string) => {
      const inputs = await terms.proposalInputs(l.id, transactionId, REALM);
      if (inputs.kind !== 'FOUND') throw new Error(inputs.kind);
      return proposePayment(loanSchedule(inputs.loan, inputs.periods), inputs.transaction, () => 'ANNUITY');
    };
    const before = await audits();
    const schedule = await scheduleOf();
    expect(schedule.entries.slice(0, 2).map((e) => [e.paymentDate, e.interest, e.principal, e.balanceAfter])).toEqual([
      ['2027-03-31', 90_000n, 90_000n, 11_910_000n],
      ['2027-06-30', 89_370n, 90_630n, 11_825_370n],
    ]);
    expect(schedule.rebasedOn).toMatchObject({ bookingDate: '2027-03-31', entryNumber: 1, actualBalance: 11_916_000n, transactionId: stub });
    expect(schedule.deviations.get(1)).toEqual([
      {
        code: 'BOOKED_SPLIT_DIFFERS_FROM_PLAN',
        transactionId: stub,
        booked: { interest: 96_000n, principal: 84_000n },
        planned: { interest: 90_000n, principal: 90_000n },
      },
    ]);
    const inputs = await debt.debtInputs(l.id, REALM);
    expect(remainingDebt(inputs as NonNullable<typeof inputs>, day('2027-05-15'), false)).toMatchObject({
      kind: 'LOAN_LEVEL',
      debt: { actual: 11_916_000n, planned: 11_916_000n, difference: 0n, plannedAsContracted: 11_910_000n, differenceAsContracted: 6_000n },
    });
    // The June debit, unconfirmed, with BBBank's purpose text: proposed from the text, the plan's split beside it.
    const june = await debit('2027-06-30', '1800.00', 'DARLEHEN RECHN.ZINS 893,70 TILG./ENTG. 906,30 TILGUNG PER 30.06.2027');
    expect(await proposalOf(june)).toMatchObject({
      source: 'PURPOSE_TEXT',
      purposeFormat: 'BBBANK_LOAN_DEBIT',
      interest: 89_370n,
      principal: 90_630n,
      // The contract plan: the proposal changes only where a purpose text states the split.
      scheduleSplit: { interest: 89_325n, principal: 90_675n },
      entry: { number: 2, interest: 89_325n },
    });
    const other = await debit('2027-06-30', '1800.00', 'Lastschrift Darlehen');
    expect(await proposalOf(other)).toMatchObject({ source: 'SCHEDULE', flags: [] });
    const afterReads = await audits();
    // Reads write nothing: the four records are the two debits' commands (an account and a Transaction each).
    expect(afterReads - before).toBe(4);
    await scheduleOf();
    await proposalOf(june);
    await debt.debtInputs(l.id, REALM);
    expect(await audits()).toBe(afterReads);
  });

  it('Taxation reads the contract plan: a special repayment ending the rebased plan moves no payment date; the first entry over its interval', async () => {
    const l = await loan();
    const t = await appended(l.id, quarterly());
    await pay(l.id, '2027-03-31', [
      ['900.00', 'LOAN_INTEREST'],
      ['900.00', 'LOAN_PRINCIPAL'],
    ]);
    await pay(l.id, '2027-04-15', [['118500.00', 'LOAN_PRINCIPAL']]);
    const inputs = await terms.scheduleInputs(l.id, REALM);
    if (inputs === undefined) throw new Error('no inputs');
    const rebased = reconciledPlan(inputs.loan, inputs.periods, inputs.splits);
    const contract = loanSchedule(inputs.loan, inputs.periods);
    expect(rebased.plan.schedule.entries.length).toBe(2);
    expect(contract.entries.length).toBeGreaterThan(60);
    const facts = await createDatabase(pool)
      .transaction()
      .execute((trx) => loanPeriodFactsOf(trx, REALM, [l.id]));
    expect(facts.get(l.id)).toMatchObject({ firstIntervalMonths: 3, paymentDates: contract.entries.map((e) => e.paymentDate), closingDate: null });
    expect(facts.get(l.id)?.entryTerms?.[0]).toEqual({ termsId: t.id, paymentIntervalMonths: 3 });
  });

  it('Realm isolation: another Realm Loan with the same dates and another interval changes nothing; foreign reads are refused', async () => {
    const mine = await loan();
    await appended(mine.id, quarterly());
    const theirs = await loan(OTHER_REALM);
    await appended(theirs.id, quarterly({ paymentIntervalMonths: 12, scheduledPayment: eur('7200.00') }), OTHER_REALM);
    await pay(
      theirs.id,
      '2027-03-31',
      [
        ['3600.00', 'LOAN_INTEREST'],
        ['3600.00', 'LOAN_PRINCIPAL'],
      ],
      OTHER_REALM,
    );
    const inputs = await terms.scheduleInputs(mine.id, REALM);
    expect([inputs?.periods.map((p) => p.paymentIntervalMonths), inputs?.splits]).toEqual([[3], []]);
    expect(await terms.scheduleInputs(theirs.id, REALM)).toBeUndefined();
    expect(await terms.list(theirs.id, REALM)).toBeUndefined();
    const facts = await createDatabase(pool)
      .transaction()
      .execute((trx) => loanPeriodFactsOf(trx, REALM, [mine.id, theirs.id]));
    expect([...facts.keys()]).toEqual([mine.id]);
  });

  describe('0070 past the repository', () => {
    const refused = (statement: string, params: unknown[] = []) =>
      pool.query(statement, params).then(
        () => 'accepted',
        (error: { code?: string; constraint?: string; message?: string }) =>
          error.constraint ?? /never edited/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error',
      );
    const insert = (loanId: string, interval: string) =>
      `INSERT INTO loan_terms (mre_realm_id, loan_id, status, valid_from, interest_rate, repayment_model, scheduled_payment, first_payment_date, currency, created_by, payment_interval_months)
       VALUES ('${REALM}', '${loanId}', 'VALID', '2027-01-01', 3, 'ANNUITY', 1800, '2027-03-31', 'EUR', 'x', ${interval})`;

    it('the CHECK: 0, 2, 24 and NULL refused; 1, 3, 6 and 12 accepted', async () => {
      for (const bad of ['0', '2', '24']) expect(await refused(insert((await loan()).id, bad))).toBe('loan_terms_payment_interval');
      expect(await refused(insert((await loan()).id, 'NULL'))).toBe('23502');
      for (const good of ['1', '3', '6', '12']) expect(await refused(insert((await loan()).id, good))).toBe('accepted');
    });

    it('frozen: a raw update of the interval on a VALID and on a VOID period refused; the void step itself accepted', async () => {
      const l = await loan();
      const t = await appended(l.id, quarterly());
      expect(await refused(`UPDATE loan_terms SET payment_interval_months = 12 WHERE id = $1`, [t.id])).toBe('never edited');
      expect(
        await refused(
          `UPDATE loan_terms SET payment_interval_months = 1, status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`,
          [t.id],
        ),
      ).toBe('never edited');
      expect(await refused(`UPDATE loan_terms SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [t.id])).toBe(
        'accepted',
      );
      expect(await refused(`UPDATE loan_terms SET payment_interval_months = 6 WHERE id = $1`, [t.id])).toBe('never edited');
    });

    it(
      'existing rows read 1 after up (no version, no AuditRecord); down refused with an interval other than 1, else 0025 function back verbatim',
      { timeout: 90_000 },
      async () => {
        const downSchema = testSchemaName('loan_interval_down_test');
        const admin = new pg.Client({ connectionString: databaseUrl });
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${downSchema}"`);
        await admin.end();
        const down = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema} -c application_name=${downSchema}`, max: 2 });
        try {
          const before0070 = Object.fromEntries(Object.entries(migrations).filter(([name]) => name < '0070'));
          await migrateToLatest(down, { migrationTableSchema: downSchema, migrations: before0070 });
          const frozenDef = async () =>
            (
              await down.query(
                `SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = 'loan_terms_frozen'`,
                [downSchema],
              )
            ).rows[0].d as string;
          const original = await frozenDef();
          const downDb = createDatabase(down);
          const downParty = new PostgresPartyRepository(downDb);
          const downLoans = new PostgresLoanRepository(downDb);
          const lenderOutcome = await downParty.create(
            {
              mreRealmId: REALM,
              partyType: 'PERSON',
              displayName: 'Bank',
              firstName: null,
              lastName: null,
              legalName: null,
              registrationNumber: null,
              email: null,
              phone: null,
            },
            actor,
          );
          if (lenderOutcome.kind !== 'CREATED') throw new Error(lenderOutcome.kind);
          const lender = lenderOutcome.party.id;
          const borrowerOutcome = await downParty.create(
            {
              mreRealmId: REALM,
              partyType: 'PERSON',
              displayName: 'Anna',
              firstName: null,
              lastName: null,
              legalName: null,
              registrationNumber: null,
              email: null,
              phone: null,
            },
            actor,
          );
          if (borrowerOutcome.kind !== 'CREATED') throw new Error(borrowerOutcome.kind);
          const borrower = borrowerOutcome.party.id;
          const newLoan = async () => {
            const outcome = await downLoans.create(
              {
                mreRealmId: REALM,
                lenderPartyId: lender,
                borrowerPartyIds: [borrower],
                principalOriginal: eur('120000.00'),
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
          };
          const created = { rows: [{ id: await newLoan() }] as const };
          const legacy = await down.query(
            `INSERT INTO loan_terms (mre_realm_id, loan_id, status, valid_from, interest_rate, repayment_model, scheduled_payment, first_payment_date, currency, created_by)
           VALUES ('${REALM}', $1, 'VALID', '2027-01-01', 3, 'ANNUITY', 600, '2027-01-31', 'EUR', 'x') RETURNING id`,
            [created.rows[0].id],
          );
          const auditsBefore = Number((await down.query(`SELECT count(*) FROM audit_record`)).rows[0].count);
          await migrateToLatest(down, { migrationTableSchema: downSchema });
          expect((await down.query(`SELECT payment_interval_months, version FROM loan_terms WHERE id = $1`, [legacy.rows[0].id])).rows[0]).toEqual({
            payment_interval_months: 1,
            version: 1,
          });
          expect(Number((await down.query(`SELECT count(*) FROM audit_record`)).rows[0].count)).toBe(auditsBefore);
          const replaced = await frozenDef();
          expect(replaced).toContain('NEW.payment_interval_months');
          expect(replaced.replace(/, (NEW|OLD)\.payment_interval_months/g, '')).toBe(original);
          const migration = migrations['0070_loan_terms_payment_interval'] as { down: (db: never) => Promise<void> };
          // A quarterly period: refused, nothing changed.
          const loan2 = { rows: [{ id: await newLoan() }] as const };
          const q = await down.query(
            `INSERT INTO loan_terms (mre_realm_id, loan_id, status, valid_from, interest_rate, repayment_model, scheduled_payment, first_payment_date, currency, created_by, payment_interval_months)
           VALUES ('${REALM}', $1, 'VALID', '2027-01-01', 3, 'ANNUITY', 1800, '2027-03-31', 'EUR', 'x', 3) RETURNING id`,
            [loan2.rows[0].id],
          );
          const refusedDown = await withMigrationLock(() => migration.down(createDatabase(down) as never)).catch((e: unknown) => e);
          expect(refusedDown).toMatchObject({ code: '23000' });
          expect(String((refusedDown as Error).message)).toContain(q.rows[0].id);
          expect(await frozenDef()).toBe(replaced);
          // Counter-check: the quarterly row removed (triggers off), down runs and restores 0025's function verbatim.
          await down.query(`ALTER TABLE loan_terms DISABLE TRIGGER USER`);
          await down.query(`DELETE FROM loan_terms WHERE id = $1`, [q.rows[0].id]);
          await down.query(`ALTER TABLE loan_terms ENABLE TRIGGER USER`);
          await withMigrationLock(async () => {
            // 0072 (VC-X-55) and 0071 (VC-X-54) sort after 0070: their own downs first, the later first (nothing aligned, no
            // acknowledgement of their kinds here).
            // 0073 (VC-X-57) patches 0072's passages: rolled back first (no confirmation from the transfer here).
            // 0074 (VC-X-12, an index only) sorts after 0073: its own down first.
            // 0075 (VC-X-44, land_building_allocation only) sorts after 0074: its own down first, not applied again.
            // 0076 (VC-X-24, audit_record only) sorts after 0075: its own down first, not applied again.
            await (migrations['0076_audit_record_pseudonymisation'] as { down: (db: never) => Promise<void> }).down(createDatabase(down) as never);
            await (migrations['0075_land_building_allocation_plausibility'] as { down: (db: never) => Promise<void> }).down(createDatabase(down) as never);
            await (migrations['0074_idempotency_key_retention'] as { down: (db: never) => Promise<void> }).down(createDatabase(down) as never);
            await (migrations['0073_ownership_start_on_confirm'] as { down: (db: never) => Promise<void> }).down(createDatabase(down) as never);
            await (migrations['0072_ownership_extend_to_economic_transfer'] as { down: (db: never) => Promise<void> }).down(createDatabase(down) as never);
            await (migrations['0071_tax_year_loan_schedule_part_kinds'] as { down: (db: never) => Promise<void> }).down(createDatabase(down) as never);
            await migration.down(createDatabase(down) as never);
          });
          await down.query(
            `DELETE FROM kysely_migration WHERE name IN ('0070_loan_terms_payment_interval', '0071_tax_year_loan_schedule_part_kinds', '0072_ownership_extend_to_economic_transfer', '0073_ownership_start_on_confirm', '0074_idempotency_key_retention', '0075_land_building_allocation_plausibility', '0076_audit_record_pseudonymisation')`,
          );
          expect(await frozenDef()).toBe(original);
          expect(
            (
              await down.query(
                `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'payment_interval_months'`,
                [downSchema],
              )
            ).rows[0].n,
          ).toBe(0);
          // Up again: the CHECK and the guard back.
          await migrateToLatest(down, { migrationTableSchema: downSchema });
          expect(await frozenDef()).toBe(replaced);
        } finally {
          await down.end();
        }
      },
    );
  });
});
