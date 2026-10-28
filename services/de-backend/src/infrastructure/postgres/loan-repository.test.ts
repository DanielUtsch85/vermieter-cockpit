import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFingerprint, type Loan, type NewLoan } from '../../domains/financing/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-3-01 persistence (api-design.md §41.1): create with its order of checks and idempotency, the reads, amend and
 * void with their refusals, the lock order Parties → Loan under concurrency, and the schema's own rules past the
 * repository (review on #59: borrowers as a column, the lender never a borrower in both directions, no NULL element).
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresLoanRepository', () => {
  const schema = testSchemaName('loan_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let loans: PostgresLoanRepository;

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
  const deactivate = (id: string, realm = REALM) => parties.deactivate(id, realm, 'verstorben', new Date(), actor);
  const newLoan = (lender: string, borrowers: string[], overrides: Partial<NewLoan> = {}): NewLoan => ({
    mreRealmId: REALM,
    lenderPartyId: lender,
    borrowerPartyIds: borrowers,
    principalOriginal: Money.of('250000.00', 'EUR'),
    startDate: day('2026-08-15'),
    disbursementDate: day('2026-09-01'),
    maturityDate: null,
    contractNumber: 'D-4711',
    acquisitionId: null,
    sourceReferences: [],
    notes: null,
    ...overrides,
  });
  async function created(loan: NewLoan): Promise<Loan> {
    const outcome = await loans.create(loan, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.loan;
  }
  const audit = async (id: string) =>
    (await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_type = 'Loan' AND entity_id = $1 ORDER BY occurred_at`, [id])).rows;

  it('creates an ACTIVE Loan with version 1 and its AuditRecord', async () => {
    const [bank, anna, ben] = [await party('Sparkasse'), await party('Anna'), await party('Ben')];
    const loan = await created(newLoan(bank, [anna, ben], { maturityDate: day('2046-09-01'), notes: 'Zinsbindung 10 Jahre' }));
    expect(loan).toMatchObject({
      status: 'ACTIVE',
      version: 1,
      lenderPartyId: bank,
      borrowerPartyIds: [anna, ben],
      startDate: '2026-08-15',
      disbursementDate: '2026-09-01',
      maturityDate: '2046-09-01',
      contractNumber: 'D-4711',
      notes: 'Zinsbindung 10 Jahre',
    });
    expect(loan.principalOriginal.equals(Money.of('250000.00', 'EUR'))).toBe(true);
    expect(await loans.findById(loan.id, REALM)).toEqual(loan);
    expect(await audit(loan.id)).toEqual([
      {
        action: 'CREATED',
        metadata: expect.objectContaining({ principalOriginal: { amount: '250000.00', currency: 'EUR' }, lenderPartyId: bank, borrowerPartyIds: [anna, ben] }),
      },
    ]);
  });

  it('order of checks: lender, then borrowers in the order given, unknown or foreign; then the Acquisition; then inactive', async () => {
    const [bank, anna] = [await party('Bank'), await party('Anna')];
    const foreign = await party('Fremd', OTHER_REALM);
    const unknown = '0a000000-0000-4000-8000-0000000000ff';
    expect(await loans.create(newLoan(foreign, [unknown]), actor)).toEqual({ kind: 'PARTY_NOT_FOUND', partyId: foreign });
    expect(await loans.create(newLoan(bank, [anna, unknown, foreign]), actor)).toEqual({ kind: 'PARTY_NOT_FOUND', partyId: unknown });
    expect(await loans.create(newLoan(bank, [anna], { acquisitionId: unknown }), actor)).toEqual({ kind: 'ACQUISITION_NOT_FOUND', acquisitionId: unknown });
    const [gone, alsoGone] = [await party('Inaktiv'), await party('Auch inaktiv')];
    await deactivate(gone);
    await deactivate(alsoGone);
    expect(await loans.create(newLoan(bank, [anna, alsoGone], { lenderPartyId: gone }), actor)).toEqual({ kind: 'PARTY_INACTIVE', partyId: gone });
    expect(await loans.create(newLoan(bank, [anna, alsoGone]), actor)).toEqual({ kind: 'PARTY_INACTIVE', partyId: alsoGone });
    // Nothing was written by the refusals.
    expect((await pool.query(`SELECT count(*)::int AS n FROM loan WHERE lender_party_id = $1`, [bank])).rows[0].n).toBe(0);
  });

  it('links an Acquisition of the Realm in any status; one of another Realm is not found', async () => {
    const [bank, anna] = [await party('Bank'), await party('Anna')];
    const pr = (
      await pool.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f6aa01', 'ACTIVE', 'x') RETURNING id`,
        [REALM],
      )
    ).rows[0].id as string;
    const acquisition = (
      await pool.query(
        `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, created_by)
         VALUES ($1, $2, 'DRAFT', 300000, 'EUR', 1, 1, '2026-06-15', 'x') RETURNING id`,
        [REALM, pr],
      )
    ).rows[0].id as string;
    expect((await created(newLoan(bank, [anna], { acquisitionId: acquisition }))).acquisitionId).toBe(acquisition);
    const other = await party('Bank B', OTHER_REALM);
    expect(await loans.create(newLoan(other, [await party('B', OTHER_REALM)], { mreRealmId: OTHER_REALM, acquisitionId: acquisition }), actor)).toEqual({
      kind: 'ACQUISITION_NOT_FOUND',
      acquisitionId: acquisition,
    });
  });

  it('idempotency: the same key and payload replays, another payload conflicts, a refusal frees the key', async () => {
    const [bank, anna] = [await party('Bank'), await party('Anna')];
    const loan = newLoan(bank, [anna]);
    const key = { key: `loan-${bank}`, fingerprint: createFingerprint(loan) };
    const first = await loans.create(loan, actor, key);
    if (first.kind !== 'CREATED') throw new Error(first.kind);
    expect(await loans.create(loan, actor, key)).toEqual({ kind: 'REPLAYED', loan: first.loan });
    const other = newLoan(bank, [anna], { contractNumber: 'X' });
    expect(await loans.create(other, actor, { key: key.key, fingerprint: createFingerprint(other) })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    const gone = await party('Inaktiv');
    await deactivate(gone);
    const refused = newLoan(bank, [gone]);
    const refusedKey = { key: `refused-${bank}`, fingerprint: createFingerprint(refused) };
    expect(await loans.create(refused, actor, refusedKey)).toEqual({ kind: 'PARTY_INACTIVE', partyId: gone });
    expect((await loans.create(newLoan(bank, [anna]), actor, { key: refusedKey.key, fingerprint: createFingerprint(newLoan(bank, [anna])) })).kind).toBe(
      'CREATED',
    );
  });

  it('reads: newest start date first; filters by status, party (lender or borrower) and Acquisition; paged; Realm-scoped', async () => {
    const realm = '64b0c0ffee0000000000000c';
    const [bank, anna, ben] = [await party('Bank C', realm), await party('Anna C', realm), await party('Ben C', realm)];
    const old = await created(newLoan(bank, [anna], { mreRealmId: realm, startDate: day('2020-01-01'), disbursementDate: null }));
    const recent = await created(newLoan(anna, [ben], { mreRealmId: realm, startDate: day('2026-01-01'), disbursementDate: null }));
    await loans.void(old.id, realm, 'x', new Date(), actor);
    const page = { page: 1, pageSize: 50 };
    expect((await loans.list(realm, {}, page)).items.map((l) => l.id)).toEqual([recent.id, old.id]);
    expect((await loans.list(realm, { status: 'VOID' }, page)).items.map((l) => l.id)).toEqual([old.id]);
    expect((await loans.list(realm, { partyId: anna }, page)).items.map((l) => l.id)).toEqual([recent.id, old.id]);
    expect((await loans.list(realm, { partyId: ben }, page)).items.map((l) => l.id)).toEqual([recent.id]);
    expect((await loans.list(realm, { partyId: bank }, page)).items.map((l) => l.id)).toEqual([old.id]);
    expect(await loans.list(realm, {}, { page: 2, pageSize: 1 })).toMatchObject({ items: [{ id: old.id }], total: 2 });
    expect((await loans.list(OTHER_REALM, { partyId: anna }, page)).total).toBe(0);
    expect(await loans.findById(recent.id, OTHER_REALM)).toBeUndefined();
    expect(await loans.findById('not-a-uuid', realm)).toBeUndefined();
  });

  describe('amend', () => {
    it('changes the amendable fields with version + 1 and an AuditRecord of old and new values', async () => {
      const [bank, anna, ben] = [await party('Bank'), await party('Anna'), await party('Ben')];
      const loan = await created(newLoan(bank, [anna]));
      const outcome = await loans.amend(loan.id, REALM, { borrowerPartyIds: [anna, ben], maturityDate: day('2046-09-01'), contractNumber: null }, actor, [1]);
      expect(outcome).toMatchObject({
        kind: 'AMENDED',
        changed: true,
        loan: { version: 2, borrowerPartyIds: [anna, ben], maturityDate: '2046-09-01', contractNumber: null },
      });
      expect((await audit(loan.id))[1]).toEqual({
        action: 'AMENDED',
        metadata: {
          changes: {
            borrowerPartyIds: { from: [anna], to: [anna, ben] },
            maturityDate: { from: null, to: '2046-09-01' },
            contractNumber: { from: 'D-4711', to: null },
          },
        },
      });
    });

    it('a no-op answers whatever the version; a change with a stale version is a conflict', async () => {
      const [bank, anna] = [await party('Bank'), await party('Anna')];
      const loan = await created(newLoan(bank, [anna]));
      expect(await loans.amend(loan.id, REALM, { contractNumber: 'D-4711' }, actor, [7])).toEqual({ kind: 'AMENDED', loan, changed: false });
      expect(await loans.amend(loan.id, REALM, { contractNumber: 'D-4712' }, actor, [7])).toEqual({
        kind: 'VERSION_CONFLICT',
        expectedVersions: [7],
        currentVersion: 1,
      });
    });

    it('order: 404, then LOAN_NOT_ACTIVE (a no-op too), then the merged rules, then newly named Parties', async () => {
      const [bank, anna] = [await party('Bank'), await party('Anna')];
      const unknown = '0a000000-0000-4000-8000-0000000000ee';
      expect(await loans.amend(unknown, REALM, { notes: 'x' }, actor)).toEqual({ kind: 'NOT_FOUND' });
      const voided = await created(newLoan(bank, [anna]));
      await loans.void(voided.id, REALM, 'x', new Date(), actor);
      expect(await loans.amend(voided.id, REALM, { contractNumber: 'D-4711' }, actor)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
      expect(await loans.amend(voided.id, REALM, { lenderPartyId: unknown }, actor)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
      const loan = await created(newLoan(bank, [anna]));
      expect(await loans.amend(loan.id, REALM, { lenderPartyId: anna }, actor)).toEqual({
        kind: 'INVALID',
        errors: [{ field: 'borrowerPartyIds.0', code: 'LENDER_IS_BORROWER' }],
      });
      expect(await loans.amend(loan.id, REALM, { borrowerPartyIds: [anna, unknown] }, actor)).toEqual({ kind: 'PARTY_NOT_FOUND', partyId: unknown });
      const gone = await party('Inaktiv');
      await deactivate(gone);
      expect(await loans.amend(loan.id, REALM, { lenderPartyId: gone }, actor)).toEqual({ kind: 'PARTY_INACTIVE', partyId: gone });
    });

    it('a borrower who stays may have turned inactive; a swap of lender and borrower passes', async () => {
      const [bank, anna, ben] = [await party('Bank'), await party('Anna'), await party('Ben')];
      const loan = await created(newLoan(bank, [anna, ben]));
      await deactivate(anna);
      expect(await loans.amend(loan.id, REALM, { borrowerPartyIds: [ben, anna], notes: 'Anna verstorben' }, actor)).toMatchObject({
        kind: 'AMENDED',
        changed: true,
      });
      expect(await loans.amend(loan.id, REALM, { lenderPartyId: ben, borrowerPartyIds: [bank, anna] }, actor)).toMatchObject({
        kind: 'AMENDED',
        loan: { lenderPartyId: ben, borrowerPartyIds: [bank, anna], version: 3 },
      });
    });
  });

  describe('void', () => {
    it('voids once with version + 1; a repeat is a no-op keeping the first reason; CLOSED is final', async () => {
      const [bank, anna] = [await party('Bank'), await party('Anna')];
      const loan = await created(newLoan(bank, [anna]));
      const at = new Date('2026-10-01T08:00:00Z');
      expect(await loans.void(loan.id, REALM, 'Doppelt', at, actor, [2])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [2], currentVersion: 1 });
      const voided = await loans.void(loan.id, REALM, 'Doppelt', at, actor, [1]);
      expect(voided).toMatchObject({ kind: 'VOIDED', changed: true, loan: { status: 'VOID', voidReason: 'Doppelt', voidedAt: at, version: 2 } });
      expect(await loans.void(loan.id, REALM, 'anders', new Date(), actor, [9])).toMatchObject({
        kind: 'VOIDED',
        changed: false,
        loan: { voidReason: 'Doppelt' },
      });
      expect((await audit(loan.id)).map((r) => r.action)).toEqual(['CREATED', 'VOIDED']);
      const closed = await created(newLoan(bank, [anna]));
      // VC-3-07 brings close; past the repository a status step out of ACTIVE is allowed with version + 1.
      await pool.query(
        `UPDATE loan SET status = 'CLOSED', closing_date = coalesce(disbursement_date, start_date), closing_reason = 'OTHER', closing_note = 'x', version = version + 1 WHERE id = $1`,
        [closed.id],
      );
      expect(await loans.void(closed.id, REALM, 'x', new Date(), actor)).toEqual({ kind: 'LOAN_CLOSED' });
      expect(await loans.void(loan.id, OTHER_REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
    });
  });

  describe('concurrency', () => {
    it('a deactivate of a borrower racing a create (READ COMMITTED): the create waits on the Party and sees it inactive', async () => {
      const [bank, anna] = [await party('Bank'), await party('Anna')];
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE party SET status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'x', version = version + 1 WHERE id = $1`, [
          anna,
        ]);
        const creating = loans.create(newLoan(bank, [anna]), actor);
        await waitUntil(
          async () =>
            Number((await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].count) >=
            1,
        );
        await holder.query('COMMIT');
        expect(await creating).toEqual({ kind: 'PARTY_INACTIVE', partyId: anna });
      } finally {
        holder.release();
      }
    });

    it('past the repository (REPEATABLE READ): a Loan naming a Party a concurrent deactivate committed first fails to serialise', async () => {
      const [bank, anna] = [await party('Bank'), await party('Anna')];
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN');
        await two.query(`UPDATE party SET status = 'INACTIVE', deactivated_at = now(), deactivation_reason = 'x', version = version + 1 WHERE id = $1`, [anna]);
        const inserting = one
          .query(
            `INSERT INTO loan (mre_realm_id, status, lender_party_id, borrower_party_ids, principal_original, currency, start_date, created_by)
             VALUES ($1, 'ACTIVE', $2, ARRAY[$3]::uuid[], 1000, 'EUR', '2026-01-01', 'x')`,
            [REALM, bank, anna],
          )
          .then(
            () => 'inserted',
            (error: { code?: string }) => error.code,
          );
        await waitUntil(
          async () =>
            Number((await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].count) >=
            1,
        );
        await two.query('COMMIT');
        expect(await inserting).toBe('40001');
      } finally {
        await one.query('ROLLBACK');
        one.release();
        two.release();
      }
    });

    it('an amend racing a void: the amend waits on the Loan and answers LOAN_NOT_ACTIVE', async () => {
      const [bank, anna] = [await party('Bank'), await party('Anna')];
      const loan = await created(newLoan(bank, [anna]));
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE loan SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [loan.id]);
        const amending = loans.amend(loan.id, REALM, { notes: 'zu spät' }, actor);
        await waitUntil(
          async () =>
            Number((await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].count) >=
            1,
        );
        await holder.query('COMMIT');
        expect(await amending).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
      } finally {
        holder.release();
      }
    });
  });

  describe('the schema past the repository (each guard has a counter-check)', () => {
    async function refused(statement: string, params: unknown[] = []): Promise<string> {
      return pool.query(statement, params).then(
        () => 'accepted',
        (error: { code?: string; constraint?: string; message?: string }) => error.constraint ?? error.code ?? 'error',
      );
    }
    const insert = (lender: string, borrowers: string, extra = '', values = '') =>
      `INSERT INTO loan (mre_realm_id, status, lender_party_id, borrower_party_ids, principal_original, currency, start_date, created_by${extra})
       VALUES ('${REALM}', 'ACTIVE', '${lender}', ${borrowers}, 1000, 'EUR', '2026-01-01', 'x'${values})`;

    it('fixed fields never change; every other change is a step of version + 1 out of ACTIVE; VOID is final; the no-op passes', async () => {
      const [bank, anna] = [await party('Bank'), await party('Anna')];
      const loan = await created(newLoan(bank, [anna]));
      expect(await refused(`UPDATE loan SET principal_original = 1, version = version + 1 WHERE id = $1`, [loan.id])).toBe('23000');
      expect(await refused(`UPDATE loan SET start_date = '2026-08-16', version = version + 1 WHERE id = $1`, [loan.id])).toBe('23000');
      expect(await refused(`UPDATE loan SET disbursement_date = '2026-09-02', version = version + 1 WHERE id = $1`, [loan.id])).toBe('23000');
      expect(await refused(`UPDATE loan SET created_by = 'y', version = version + 1 WHERE id = $1`, [loan.id])).toBe('23000');
      expect(await refused(`UPDATE loan SET notes = 'x' WHERE id = $1`, [loan.id])).toBe('23000');
      expect(await refused(`UPDATE loan SET notes = 'x', version = version + 2 WHERE id = $1`, [loan.id])).toBe('23000');
      expect(await refused(`UPDATE loan SET version = version WHERE id = $1`, [loan.id])).toBe('accepted');
      expect(await refused(`UPDATE loan SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [loan.id])).toBe(
        'accepted',
      );
      expect(await refused(`UPDATE loan SET status = 'ACTIVE', voided_at = NULL, void_reason = NULL, version = version + 1 WHERE id = $1`, [loan.id])).toBe(
        '23000',
      );
      expect(await refused(`UPDATE loan SET borrower_party_ids = ARRAY[$2]::uuid[], version = version + 1 WHERE id = $1`, [loan.id, bank])).toBe('23000');
      // The no-op of P3-D8 still passes on a final Loan.
      expect(await refused(`UPDATE loan SET version = version WHERE id = $1`, [loan.id])).toBe('accepted');
      expect(await refused(`DELETE FROM loan WHERE id = $1`, [loan.id])).toBe('23000');
    });

    it('a Loan is only inserted ACTIVE with version 1', async () => {
      const [bank, anna] = [await party('Bank'), await party('Anna')];
      expect(await refused(insert(bank, `ARRAY['${anna}']::uuid[]`, ', version', ', 2'))).toBe('23000');
      expect(
        await refused(
          `INSERT INTO loan (mre_realm_id, status, lender_party_id, borrower_party_ids, principal_original, currency, start_date, voided_at, void_reason, created_by)
           VALUES ('${REALM}', 'VOID', '${bank}', ARRAY['${anna}']::uuid[], 1000, 'EUR', '2026-01-01', now(), 'x', 'x')`,
        ),
      ).toBe('23000');
    });

    it('borrowers: the lender never one, in both directions; a swap passes; no duplicate, no NULL, 1–20, Realm, existence', async () => {
      const [bank, anna, ben] = [await party('Bank'), await party('Anna'), await party('Ben')];
      expect(await refused(insert(bank, `ARRAY['${anna}', '${bank}']::uuid[]`))).toBe('loan_lender_not_borrower');
      const loan = await created(newLoan(bank, [anna, ben]));
      expect(await refused(`UPDATE loan SET lender_party_id = $2, version = version + 1 WHERE id = $1`, [loan.id, anna])).toBe('loan_lender_not_borrower');
      expect(
        await refused(`UPDATE loan SET lender_party_id = $2, borrower_party_ids = ARRAY[$3, $4]::uuid[], version = version + 1 WHERE id = $1`, [
          loan.id,
          anna,
          bank,
          ben,
        ]),
      ).toBe('accepted');
      expect(await refused(insert(bank, `ARRAY['${anna}', '${anna}']::uuid[]`))).toBe('23000');
      // NOT (x = ANY (…)) is NULL with a NULL element, which a CHECK alone would pass (review on #59).
      expect(await refused(insert(bank, `ARRAY['${anna}', NULL]::uuid[]`))).toBe('loan_borrowers');
      expect(await refused(insert(bank, `ARRAY[]::uuid[]`))).toBe('loan_borrowers');
      const many = (await Promise.all(Array.from({ length: 21 }, (_, i) => party(`Kreditnehmer ${i}`)))).map((id) => `'${id}'`).join(', ');
      expect(await refused(insert(bank, `ARRAY[${many}]::uuid[]`))).toBe('loan_borrowers');
      expect(await refused(insert(bank, `ARRAY['0a000000-0000-4000-8000-0000000000aa']::uuid[]`))).toBe('23503');
      const foreign = await party('Fremd', OTHER_REALM);
      expect(await refused(insert(bank, `ARRAY['${foreign}']::uuid[]`))).toBe('23503');
    });

    it('a newly named Party must be ACTIVE; one who stays may be inactive; a named Party is never deleted', async () => {
      const [bank, anna, ben, gone] = [await party('Bank'), await party('Anna'), await party('Ben'), await party('Inaktiv')];
      await deactivate(gone);
      expect(await refused(insert(bank, `ARRAY['${gone}']::uuid[]`))).toBe('23000');
      expect(await refused(insert(gone, `ARRAY['${anna}']::uuid[]`))).toBe('23000');
      const loan = await created(newLoan(bank, [anna]));
      expect(await refused(`UPDATE loan SET borrower_party_ids = ARRAY[$2, $3]::uuid[], version = version + 1 WHERE id = $1`, [loan.id, anna, gone])).toBe(
        '23000',
      );
      await deactivate(anna);
      expect(await refused(`UPDATE loan SET borrower_party_ids = ARRAY[$2, $3]::uuid[], version = version + 1 WHERE id = $1`, [loan.id, anna, ben])).toBe(
        'accepted',
      );
      expect(await refused(`DELETE FROM party WHERE id = $1`, [ben])).toBe('23503');
      expect(await refused(`DELETE FROM party WHERE id = $1`, [bank])).toBe('23503');
    });

    it('the date order and the principal', async () => {
      const [bank, anna] = [await party('Bank'), await party('Anna')];
      expect(await refused(insert(bank, `ARRAY['${anna}']::uuid[]`, ', disbursement_date', ", '2025-12-31'"))).toBe('loan_dates');
      expect(await refused(insert(bank, `ARRAY['${anna}']::uuid[]`, ', maturity_date', ", '2026-01-01'"))).toBe('loan_dates');
      expect(await refused(insert(bank, `ARRAY['${anna}']::uuid[]`, ', disbursement_date, maturity_date', ", '2026-02-01', '2026-02-01'"))).toBe('loan_dates');
      expect(
        await refused(
          `INSERT INTO loan (mre_realm_id, status, lender_party_id, borrower_party_ids, principal_original, currency, start_date, created_by)
           VALUES ('${REALM}', 'ACTIVE', '${bank}', ARRAY['${anna}']::uuid[], 0.001, 'EUR', '2026-01-01', 'x')`,
        ),
      ).toBe('loan_principal_original_check');
    });
  });
});
