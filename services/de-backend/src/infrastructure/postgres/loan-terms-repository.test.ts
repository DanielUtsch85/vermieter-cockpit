import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { termsFingerprint, type Loan, type LoanTermsData } from '../../domains/financing/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { PostgresLoanTermsRepository } from './loan-terms-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-3-02 persistence (api-design.md §41.2): append with its order of checks and idempotency, void of the last
 * period, the derived `validUntil`, the lock order (the Loan row first, also in both triggers, review on #61) under
 * concurrency, and the schema's own rules past the repository.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');

async function waitForLock(pool: pg.Pool): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Number((await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].count) < 1) {
    if (Date.now() > deadline) throw new Error('no session waits on a lock');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresLoanTermsRepository', () => {
  const schema = testSchemaName('loan_terms_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let loans: PostgresLoanRepository;
  let terms: PostgresLoanTermsRepository;

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
  async function loan(realm = REALM): Promise<Loan> {
    const outcome = await loans.create(
      {
        mreRealmId: realm,
        lenderPartyId: await party('Bank', realm),
        borrowerPartyIds: [await party('Anna', realm)],
        principalOriginal: eur('100000.00'),
        startDate: day('2026-08-15'),
        disbursementDate: day('2026-09-01'),
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
  const data = (overrides: Partial<LoanTermsData> = {}): LoanTermsData => ({
    validFrom: day('2026-09-01'),
    interestRate: 3000n,
    repaymentModel: 'ANNUITY',
    scheduledPayment: eur('500.00'),
    firstPaymentDate: day('2026-10-01'),
    principalAtStart: null,
    fixedRateUntil: day('2036-08-31'),
    initialRepaymentRate: 3000n,
    specialRepaymentLimit: eur('5000.00'),
    notes: null,
    ...overrides,
  });
  const followUp = (overrides: Partial<LoanTermsData> = {}) => data({ validFrom: day('2026-12-01'), firstPaymentDate: day('2027-01-01'), fixedRateUntil: null, ...overrides });
  async function appended(loanId: string, d: LoanTermsData) {
    const outcome = await terms.create(loanId, REALM, d, actor);
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    return outcome.terms;
  }

  it('appends periods; validUntil is derived; the list is ordered and filters by status; AuditRecords', async () => {
    const l = await loan();
    const first = await appended(l.id, data({ notes: 'Zinsbindung laut Vertrag' }));
    expect(first).toMatchObject({ status: 'VALID', version: 1, validFrom: '2026-09-01', validUntil: null, interestRate: 3000n, firstPaymentDate: '2026-10-01', fixedRateUntil: '2036-08-31' });
    expect(first.scheduledPayment?.amount).toBe('500.00');
    const second = await appended(l.id, followUp({ repaymentModel: 'INTEREST_ONLY', scheduledPayment: null, interestRate: 2450n }));
    expect(second).toMatchObject({ repaymentModel: 'INTEREST_ONLY', scheduledPayment: null, interestRate: 2450n, validUntil: null });
    const listed = await terms.list(l.id, REALM);
    expect(listed?.map((t) => [t.id, t.validUntil])).toEqual([
      [first.id, '2026-11-30'],
      [second.id, null],
    ]);
    expect(await terms.list(l.id, REALM, 'VOID')).toEqual([]);
    expect(await terms.list(l.id, OTHER_REALM)).toBeUndefined();
    const audit = await pool.query(`SELECT action, metadata->>'interestRate' AS rate FROM audit_record WHERE entity_type = 'LoanTerms' AND entity_id = $1`, [second.id]);
    expect(audit.rows).toEqual([{ action: 'CREATED', rate: '2.450' }]);
    const informational = await pool.query(
      `SELECT metadata->>'fixedRateUntil' AS until, metadata->>'initialRepaymentRate' AS repayment, metadata->'specialRepaymentLimit'->>'amount' AS limit, metadata->'notes' AS notes
         FROM audit_record WHERE entity_type = 'LoanTerms' AND entity_id = $1`,
      [first.id],
    );
    expect(informational.rows).toEqual([{ until: '2036-08-31', repayment: '3.000', limit: '5000.00', notes: 'Zinsbindung laut Vertrag' }]);
  });

  it('order of checks: Loan unknown or foreign, not ACTIVE, before the debt, not appended, before the previous first payment, principalAtStart, annuity', async () => {
    const l = await loan();
    expect(await terms.create(l.id, OTHER_REALM, data(), actor)).toEqual({ kind: 'LOAN_NOT_FOUND' });
    expect(await terms.create('not-a-uuid', REALM, data(), actor)).toEqual({ kind: 'LOAN_NOT_FOUND' });
    expect(await terms.create(l.id, REALM, data({ validFrom: day('2026-08-31') }), actor)).toEqual({ kind: 'TERMS_BEFORE_DEBT', debtFrom: '2026-09-01' });
    expect(await terms.create(l.id, REALM, data({ principalAtStart: eur('1.00') }), actor)).toEqual({ kind: 'PRINCIPAL_AT_START_ON_FIRST_TERMS' });
    expect(await terms.create(l.id, REALM, data({ scheduledPayment: eur('250.00') }), actor)).toEqual({ kind: 'PAYMENT_DOES_NOT_COVER_INTEREST', firstInterest: 25_000n, balance: 10_000_000n });
    const first = await appended(l.id, data());
    expect(await terms.create(l.id, REALM, data(), actor)).toEqual({ kind: 'TERMS_NOT_APPENDED', lastValidFrom: '2026-09-01' });
    expect(await terms.create(l.id, REALM, data({ validFrom: day('2026-10-01'), firstPaymentDate: day('2026-11-01') }), actor)).toEqual({
      kind: 'PREVIOUS_TERMS_WITHOUT_PAYMENT',
      termsId: first.id,
      firstPaymentDate: '2026-10-01',
    });
    expect(await terms.create(l.id, REALM, followUp({ principalAtStart: eur('100000.01') }), actor)).toMatchObject({ kind: 'PRINCIPAL_AT_START_EXCEEDS_ORIGINAL' });
    // The carried-over balance on 2026-12-01 is 99 499.38; its interest at 3 % is 248.75.
    expect(await terms.create(l.id, REALM, followUp({ scheduledPayment: eur('248.75') }), actor)).toEqual({ kind: 'PAYMENT_DOES_NOT_COVER_INTEREST', firstInterest: 24_875n, balance: 9_949_938n });
    expect((await terms.create(l.id, REALM, followUp({ scheduledPayment: eur('248.76') }), actor)).kind).toBe('CREATED');
    await loans.void(l.id, REALM, 'x', new Date(), actor);
    expect(await terms.create(l.id, REALM, followUp({ validFrom: day('2027-06-01'), firstPaymentDate: day('2027-07-01') }), actor)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
    // Nothing was written by the refusals: two periods.
    expect((await terms.list(l.id, REALM))?.length).toBe(2);
  });

  it('schedule inputs (§41.4): the Loan and its VALID periods in one snapshot; unknown or foreign is undefined', async () => {
    const l = await loan();
    const first = await appended(l.id, data());
    const second = await appended(l.id, followUp());
    await terms.void(l.id, second.id, REALM, 'falsch', new Date(), actor);
    const third = await appended(l.id, followUp({ validFrom: day('2027-02-01'), firstPaymentDate: day('2027-03-01') }));
    const inputs = await terms.scheduleInputs(l.id, REALM);
    expect(inputs?.loan).toMatchObject({ id: l.id, maturityDate: null });
    expect(inputs?.loan.principalOriginal.amount).toBe('100000.00');
    expect(inputs?.periods.map((t) => t.id)).toEqual([first.id, third.id]);
    expect(await terms.scheduleInputs(l.id, OTHER_REALM)).toBeUndefined();
    expect(await terms.scheduleInputs('not-a-uuid', REALM)).toBeUndefined();
    expect((await terms.scheduleInputs((await loan()).id, REALM))?.periods).toEqual([]);
  });

  it('idempotency: the same key and payload replays, another payload conflicts', async () => {
    const l = await loan();
    const d = data();
    const key = { key: `terms-${l.id}`, fingerprint: termsFingerprint(l.id, d) };
    const first = await terms.create(l.id, REALM, d, actor, key);
    if (first.kind !== 'CREATED') throw new Error(first.kind);
    expect(await terms.create(l.id, REALM, d, actor, key)).toEqual({ kind: 'REPLAYED', terms: first.terms });
    const other = data({ notes: 'x' });
    expect(await terms.create(l.id, REALM, other, actor, { key: key.key, fingerprint: termsFingerprint(l.id, other) })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
  });

  it('void: only the last VALID period; a repeat is a no-op; another Loan’s period is not found; then a new one can take its place', async () => {
    const l = await loan();
    const first = await appended(l.id, data());
    const second = await appended(l.id, followUp());
    const at = new Date('2026-10-01T08:00:00Z');
    expect(await terms.void(l.id, first.id, REALM, 'x', at, actor)).toEqual({ kind: 'TERMS_NOT_LAST', laterTermsId: second.id });
    expect(await terms.void(l.id, second.id, REALM, 'falsch', at, actor, [2])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [2], currentVersion: 1 });
    expect(await terms.void(l.id, second.id, REALM, 'falsch', at, actor, [1])).toMatchObject({ kind: 'VOIDED', changed: true, terms: { status: 'VOID', voidReason: 'falsch', version: 2 } });
    expect(await terms.void(l.id, second.id, REALM, 'anders', new Date(), actor)).toMatchObject({ kind: 'VOIDED', changed: false, terms: { voidReason: 'falsch' } });
    expect((await terms.list(l.id, REALM))?.map((t) => t.validUntil)).toEqual([null, null]);
    expect((await appended(l.id, followUp({ interestRate: 2900n }))).validFrom).toBe('2026-12-01');
    const other = await loan();
    expect(await terms.void(other.id, first.id, REALM, 'x', at, actor)).toEqual({ kind: 'NOT_FOUND' });
    expect(await terms.void(l.id, first.id, OTHER_REALM, 'x', at, actor)).toEqual({ kind: 'NOT_FOUND' });
    await loans.void(other.id, REALM, 'x', new Date(), actor);
    const closedLoan = await loan();
    const closedTerms = await appended(closedLoan.id, data());
    await pool.query(`UPDATE loan SET status = 'CLOSED', version = version + 1 WHERE id = $1`, [closedLoan.id]);
    expect(await terms.void(closedLoan.id, closedTerms.id, REALM, 'x', at, actor)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'CLOSED' });
    const audit = await pool.query(`SELECT action FROM audit_record WHERE entity_type = 'LoanTerms' AND entity_id = $1 ORDER BY occurred_at`, [second.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['CREATED', 'VOIDED']);
  });

  describe('concurrency (the Loan row first, P3-D8; review on #61)', () => {
    const insertRaw = (loanId: string, validFrom: string, firstPaymentDate: string) =>
      `INSERT INTO loan_terms (mre_realm_id, loan_id, status, valid_from, interest_rate, repayment_model, scheduled_payment, first_payment_date, currency, created_by)
       VALUES ('${REALM}', '${loanId}', 'VALID', '${validFrom}', 3, 'ANNUITY', 500, '${firstPaymentDate}', 'EUR', 'x')`;

    it('two appends to one Loan (READ COMMITTED): the second waits on the Loan and sees the first', async () => {
      const l = await loan();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(insertRaw(l.id, '2026-09-01', '2026-10-01'));
        const appending = terms.create(l.id, REALM, data(), actor);
        await waitForLock(pool);
        await holder.query('COMMIT');
        expect(await appending).toEqual({ kind: 'TERMS_NOT_APPENDED', lastValidFrom: '2026-09-01' });
      } finally {
        holder.release();
      }
    });

    it('two raw appends (REPEATABLE READ): the later one fails to serialise', async () => {
      const l = await loan();
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await two.query(insertRaw(l.id, '2026-09-01', '2026-10-01'));
        const second = one.query(insertRaw(l.id, '2026-12-01', '2027-01-01')).then(
          () => 'inserted',
          (error: { code?: string }) => error.code,
        );
        await waitForLock(pool);
        await two.query('COMMIT');
        expect(await second).toBe('40001');
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    });

    it('an append against a void of the Loan: the append waits and answers LOAN_NOT_ACTIVE', async () => {
      const l = await loan();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE loan SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [l.id]);
        const appending = terms.create(l.id, REALM, data(), actor);
        await waitForLock(pool);
        await holder.query('COMMIT');
        expect(await appending).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
      } finally {
        holder.release();
      }
    });

    it('a raw void of the last period against a raw append behind it: RC refuses the void, RR fails to serialise', async () => {
      for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
        const l = await loan();
        const first = await appended(l.id, data());
        const [one, two] = [await pool.connect(), await pool.connect()];
        try {
          await one.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          await one.query('SELECT 1');
          await two.query('BEGIN');
          await two.query(insertRaw(l.id, '2026-12-01', '2027-01-01'));
          const voiding = one
            .query(`UPDATE loan_terms SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [first.id])
            .then(
              () => 'voided',
              (error: { code?: string }) => error.code,
            );
          await waitForLock(pool);
          await two.query('COMMIT');
          expect(await voiding, isolation).toBe(isolation === 'READ COMMITTED' ? '23000' : '40001');
        } finally {
          await one.query('ROLLBACK');
          one.release();
          two.release();
        }
      }
    });
  });

  describe('the schema past the repository (each guard has a counter-check)', () => {
    const refused = (statement: string, params: unknown[] = []) =>
      pool.query(statement, params).then(
        () => 'accepted',
        (error: { code?: string; constraint?: string }) => error.constraint ?? error.code ?? 'error',
      );
    /** The trigger's own reason, to tell guards apart that share an error code. */
    const reason = (statement: string, params: unknown[] = []) =>
      pool.query(statement, params).then(
        () => 'accepted',
        (error: { message?: string }) => /\(([A-Z_]+)\)|never deleted|never edited|only step/.exec(error.message ?? '')?.[0] ?? error.message,
      );
    const insert = (loanId: string, set: Record<string, string> = {}) => {
      const values: Record<string, string> = {
        mre_realm_id: `'${REALM}'`,
        loan_id: `'${loanId}'`,
        status: `'VALID'`,
        valid_from: `'2026-09-01'`,
        interest_rate: '3',
        repayment_model: `'ANNUITY'`,
        scheduled_payment: '500',
        first_payment_date: `'2026-10-01'`,
        currency: `'EUR'`,
        created_by: `'x'`,
        ...set,
      };
      return `INSERT INTO loan_terms (${Object.keys(values).join(', ')}) VALUES (${Object.values(values).join(', ')})`;
    };

    it('inserts: only VALID v1, on an ACTIVE Loan, not before the debt, appended after the last start and its first payment', async () => {
      const l = await loan();
      expect(await refused(insert(l.id, { status: `'VOID'`, voided_at: 'now()', void_reason: `'x'` }))).toBe('23000');
      expect(await refused(insert(l.id, { version: '2' }))).toBe('23000');
      expect(await refused(insert(l.id, { valid_from: `'2026-08-31'` }))).toBe('23000');
      expect(await refused(insert(l.id))).toBe('accepted');
      expect(await refused(insert(l.id, { valid_from: `'2026-08-31'`, first_payment_date: `'2026-09-30'` }))).toBe('23000');
      expect(await refused(insert(l.id, { valid_from: `'2026-10-01'`, first_payment_date: `'2026-11-01'` }))).toBe('23000');
      expect(await reason(insert(l.id, { valid_from: `'2026-10-01'`, first_payment_date: `'2026-11-01'` }))).toBe('(PREVIOUS_TERMS_WITHOUT_PAYMENT)');
      // On the last period's own start day: not appended, before the first-payment rule is reached.
      expect(await reason(insert(l.id, { first_payment_date: `'2026-11-01'` }))).toBe('(TERMS_NOT_APPENDED)');
      expect(await refused(insert(l.id, { valid_from: `'2026-10-02'`, first_payment_date: `'2026-11-01'` }))).toBe('accepted');
      const voided = await loan();
      await loans.void(voided.id, REALM, 'x', new Date(), actor);
      expect(await refused(insert(voided.id))).toBe('23000');
    });

    it('the payment matches the model; the dates are in order', async () => {
      const l = await loan();
      expect(await refused(insert(l.id, { repayment_model: `'INTEREST_ONLY'` }))).toBe('loan_terms_payment');
      expect(await refused(insert(l.id, { scheduled_payment: 'NULL' }))).toBe('loan_terms_payment');
      expect(await refused(insert(l.id, { first_payment_date: `'2026-08-31'` }))).toBe('loan_terms_dates');
      expect(await refused(insert(l.id, { fixed_rate_until: `'2026-08-31'` }))).toBe('loan_terms_dates');
      expect(await refused(insert(l.id, { interest_rate: '100' }))).toBe('loan_terms_interest_rate_check');
      expect(await refused(insert(l.id, { interest_rate: '3.4567' }))).toBe('loan_terms_interest_rate_check');
    });

    it('updates: data never changes; the only step is VALID → VOID with version + 1, for the last period; never deleted', async () => {
      const l = await loan();
      const first = await appended(l.id, data());
      const second = await appended(l.id, followUp());
      expect(await refused(`UPDATE loan_terms SET interest_rate = 4, version = version + 1 WHERE id = $1`, [second.id])).toBe('23000');
      expect(await refused(`UPDATE loan_terms SET valid_from = '2026-12-02', version = version + 1 WHERE id = $1`, [second.id])).toBe('23000');
      expect(await refused(`UPDATE loan_terms SET status = 'VOID', voided_at = now(), void_reason = 'x' WHERE id = $1`, [second.id])).toBe('23000');
      expect(await refused(`UPDATE loan_terms SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [first.id])).toBe('23000');
      expect(await reason(`DELETE FROM loan_terms WHERE id = $1`, [first.id])).toBe('never deleted');
      // A valid void step that also edits data is refused for the edit.
      expect(await reason(`UPDATE loan_terms SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1, notes = 'x' WHERE id = $1`, [second.id])).toBe('never edited');
      expect(await refused(`UPDATE loan_terms SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [second.id])).toBe('accepted');
      expect(await refused(`UPDATE loan_terms SET status = 'VALID', voided_at = NULL, void_reason = NULL, version = version + 1 WHERE id = $1`, [second.id])).toBe('23000');
    });
  });
});
