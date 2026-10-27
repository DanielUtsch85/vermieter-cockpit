import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocationFingerprint, selectPropertyLoans, setOn, type AllocationRequest, type Loan } from '../../domains/financing/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresLoanAllocationRepository } from './loan-allocation-repository.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { testSchemaName } from './test-schema.test-support.js';

/**
 * VC-3-03 persistence (api-design.md §41.3): append with its order of checks and idempotency, shares from purchase
 * prices, void of the last set, the reads, the lock order (the Loan row first, also in both triggers) under
 * concurrency, and the schema's own rules past the repository, the deferred sum among them.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000c';
const OTHER_REALM = '64b0c0ffee0000000000000d';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const f = (n: bigint, d: bigint) => ({ numerator: n, denominator: d });

async function waitForLock(pool: pg.Pool): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Number((await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].count) < 1) {
    if (Date.now() > deadline) throw new Error('no session waits on a lock');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The trigger's own reason or the constraint's name, to tell guards apart that share an error code. */
function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return error.constraint ?? /\(([A-Z_]+)\)|never deleted|never edited|never updated|only step|exactly for PURCHASE_PRICE/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error';
}

describe.skipIf(databaseUrl === undefined)('PostgresLoanAllocationRepository', () => {
  const schema = testSchemaName('loan_allocation_test');
  let pool: pg.Pool;
  let parties: PostgresPartyRepository;
  let loans: PostgresLoanRepository;
  let allocations: PostgresLoanAllocationRepository;
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
    allocations = new PostgresLoanAllocationRepository(db);
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
        principalOriginal: eur('475000.00'),
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
  async function property(realm = REALM): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f90000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function acquisition(propertyReferenceId: string, price: string, status: 'DRAFT' | 'CONFIRMED' | 'CANCELLED' = 'DRAFT', realm = REALM): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, created_by)
       VALUES ($1, $2, 'DRAFT', $3, 'EUR', 1, 1, '2026-06-15', 'x') RETURNING id`,
      [realm, propertyReferenceId, price],
    );
    const id = rows[0].id as string;
    if (status === 'CONFIRMED') {
      // Confirming needs the acquired share covered by Ownerships of its buyers (§27.1).
      const owner = await party('Owner', realm);
      await pool.query(`INSERT INTO acquisition_party (acquisition_id, mre_realm_id, party_id, role, position) VALUES ($1, $2, $3, 'BUYER', 1)`, [id, realm, owner]);
      await pool.query(
        `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, acquisition_id, created_by)
         VALUES ($1, $2, $3, 1, 1, '2026-06-15', 'VALID', $4, 'x')`,
        [realm, propertyReferenceId, owner, id],
      );
      await pool.query(`UPDATE acquisition SET status = 'CONFIRMED', confirmed_at = now(), version = version + 1 WHERE id = $1`, [id]);
    }
    if (status === 'CANCELLED') {
      await pool.query(`UPDATE acquisition SET status = 'CANCELLED', cancelled_at = now(), cancellation_reason = 'x', version = version + 1 WHERE id = $1`, [id]);
    }
    return id;
  }
  const manual = (validFrom: string, entries: readonly (readonly [string, bigint, bigint])[], notes: string | null = null): AllocationRequest => ({
    validFrom: day(validFrom),
    basis: 'MANUAL',
    allocations: entries.map(([propertyReferenceId, n, d]) => ({ propertyReferenceId, share: f(n, d), acquisitionId: null })),
    notes,
  });
  const byPrice = (validFrom: string, entries: readonly (readonly [string, string])[]): AllocationRequest => ({
    validFrom: day(validFrom),
    basis: 'PURCHASE_PRICE',
    allocations: entries.map(([propertyReferenceId, acquisitionId]) => ({ propertyReferenceId, share: null, acquisitionId })),
    notes: null,
  });
  async function appended(loanId: string, request: AllocationRequest) {
    const outcome = await allocations.create(loanId, REALM, request, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.set;
  }

  it('appends a manual and a purchase-price set; shares are exact and reduced; validUntil is derived; AuditRecord', async () => {
    const l = await loan();
    const [p1, p2] = [await property(), await property()];
    const first = await appended(l.id, manual('2026-09-01', [
      [p1, 1n, 3n],
      [p2, 2n, 3n],
    ]));
    expect(first).toMatchObject({ status: 'VALID', version: 1, basis: 'MANUAL', validFrom: '2026-09-01', validUntil: null });
    expect(first.allocations).toEqual([
      { propertyReferenceId: p1, share: f(1n, 3n), acquisitionId: null },
      { propertyReferenceId: p2, share: f(2n, 3n), acquisitionId: null },
    ]);
    const [a1, a2] = [await acquisition(p1, '300000.00', 'CONFIRMED'), await acquisition(p2, '175000.00')];
    const second = await appended(l.id, byPrice('2027-01-01', [
      [p1, a1],
      [p2, a2],
    ]));
    expect(second.allocations).toEqual([
      { propertyReferenceId: p1, share: f(12n, 19n), acquisitionId: a1 },
      { propertyReferenceId: p2, share: f(7n, 19n), acquisitionId: a2 },
    ]);
    expect((await allocations.list(l.id, REALM))?.map((s) => [s.id, s.validUntil])).toEqual([
      [first.id, '2026-12-31'],
      [second.id, null],
    ]);
    expect(await allocations.list(l.id, OTHER_REALM)).toBeUndefined();
    const audit = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_type = 'LoanAllocationSet' AND entity_id = $1`, [second.id]);
    expect(audit.rows).toEqual([
      {
        action: 'CREATED',
        metadata: {
          loanId: l.id,
          validFrom: '2027-01-01',
          basis: 'PURCHASE_PRICE',
          allocations: [
            { propertyReferenceId: p1, share: '12/19', acquisitionId: a1 },
            { propertyReferenceId: p2, share: '7/19', acquisitionId: a2 },
          ],
        },
      },
    ]);
  });

  it('stores a purchase-price denominator above 10 000 exactly', async () => {
    const l = await loan();
    const [p1, p2] = [await property(), await property()];
    const set = await appended(l.id, byPrice('2026-09-01', [
      [p1, await acquisition(p1, '100000.01')],
      [p2, await acquisition(p2, '99999.99')],
    ]));
    expect(set.allocations.map((a) => a.share)).toEqual([f(10_000_001n, 20_000_000n), f(9_999_999n, 20_000_000n)]);
    expect((await allocations.list(l.id, REALM))?.[0]?.allocations.map((a) => a.share)).toEqual([f(10_000_001n, 20_000_000n), f(9_999_999n, 20_000_000n)]);
  });

  it('order of checks: Loan, not ACTIVE, before the debt, not appended, then the PropertyReferences, then the Acquisitions', async () => {
    const l = await loan();
    const [p1, p2, foreign] = [await property(), await property(), await property(OTHER_REALM)];
    const unknown = '00000000-0000-4000-8000-000000000000';
    const one = manual('2026-09-01', [[p1, 1n, 1n]]);
    expect(await allocations.create(l.id, OTHER_REALM, one, actor)).toEqual({ kind: 'LOAN_NOT_FOUND' });
    expect(await allocations.create('not-a-uuid', REALM, one, actor)).toEqual({ kind: 'LOAN_NOT_FOUND' });
    expect(await allocations.create(l.id, REALM, manual('2026-08-31', [[unknown, 1n, 1n]]), actor)).toEqual({ kind: 'ALLOCATION_BEFORE_DEBT', debtFrom: '2026-09-01' });
    expect(await allocations.create(l.id, REALM, manual('2026-09-01', [[p1, 1n, 2n], [unknown, 1n, 2n]]), actor)).toEqual({ kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceId: unknown });
    expect(await allocations.create(l.id, REALM, manual('2026-09-01', [[foreign, 1n, 1n]]), actor)).toEqual({ kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceId: foreign });
    const [a1, a2] = [await acquisition(p1, '300000.00'), await acquisition(p2, '175000.00')];
    // The PropertyReferences in the order given come before any Acquisition.
    expect(await allocations.create(l.id, REALM, byPrice('2026-09-01', [[p1, unknown], [foreign, a2]]), actor)).toEqual({ kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceId: foreign });
    expect(await allocations.create(l.id, REALM, byPrice('2026-09-01', [[p1, unknown]]), actor)).toEqual({ kind: 'ACQUISITION_NOT_FOUND', acquisitionId: unknown });
    // An Acquisition of another property is not found, though it exists in the Realm.
    expect(await allocations.create(l.id, REALM, byPrice('2026-09-01', [[p1, a2], [p2, a1]]), actor)).toEqual({ kind: 'ACQUISITION_NOT_FOUND', acquisitionId: a2 });
    const otherRealm = await acquisition(foreign, '1.00', 'DRAFT', OTHER_REALM);
    expect(await allocations.create(l.id, REALM, byPrice('2026-09-01', [[p1, otherRealm]]), actor)).toEqual({ kind: 'ACQUISITION_NOT_FOUND', acquisitionId: otherRealm });
    const cancelled = await acquisition(p2, '1.00', 'CANCELLED');
    expect(await allocations.create(l.id, REALM, byPrice('2026-09-01', [[p1, a1], [p2, cancelled]]), actor)).toEqual({ kind: 'ACQUISITION_CANCELLED', acquisitionId: cancelled });
    await appended(l.id, one);
    // Not appended comes before the PropertyReferences.
    expect(await allocations.create(l.id, REALM, manual('2026-09-01', [[unknown, 1n, 1n]]), actor)).toEqual({ kind: 'ALLOCATION_NOT_APPENDED', lastValidFrom: '2026-09-01' });
    await loans.void(l.id, REALM, 'x', new Date(), actor);
    expect(await allocations.create(l.id, REALM, manual('2027-01-01', [[unknown, 1n, 1n]]), actor)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
    // Nothing was written by the refusals: one set with one entry.
    expect((await allocations.list(l.id, REALM))?.map((s) => s.allocations.length)).toEqual([1]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM loan_allocation a JOIN loan_allocation_set s ON s.id = a.set_id WHERE s.loan_id = $1`, [l.id])).rows[0].n).toBe(1);
  });

  it('idempotency: the same key and payload replays, another payload conflicts', async () => {
    const l = await loan();
    const p = await property();
    const request = manual('2026-09-01', [[p, 1n, 1n]]);
    const key = { key: `allocation-${l.id}`, fingerprint: allocationFingerprint(l.id, request) };
    const first = await allocations.create(l.id, REALM, request, actor, key);
    if (first.kind !== 'CREATED') throw new Error(first.kind);
    expect(await allocations.create(l.id, REALM, request, actor, key)).toEqual({ kind: 'REPLAYED', set: first.set });
    const other = manual('2026-09-01', [[p, 1n, 1n]], 'x');
    expect(await allocations.create(l.id, REALM, other, actor, { key: key.key, fingerprint: allocationFingerprint(l.id, other) })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
  });

  it('void: only the last VALID set; a repeat is a no-op; another Loan’s set is not found; then a new one can take its place', async () => {
    const l = await loan();
    const p = await property();
    const first = await appended(l.id, manual('2026-09-01', [[p, 1n, 1n]]));
    const second = await appended(l.id, manual('2027-01-01', [[p, 1n, 1n]]));
    const at = new Date('2027-02-01T08:00:00Z');
    expect(await allocations.void(l.id, first.id, REALM, 'x', at, actor)).toEqual({ kind: 'ALLOCATION_NOT_LAST', laterAllocationSetId: second.id });
    expect(await allocations.void(l.id, second.id, REALM, 'falsch', at, actor, [2])).toEqual({ kind: 'VERSION_CONFLICT', expectedVersions: [2], currentVersion: 1 });
    expect(await allocations.void(l.id, second.id, REALM, 'falsch', at, actor, [1])).toMatchObject({ kind: 'VOIDED', changed: true, set: { status: 'VOID', voidReason: 'falsch', version: 2 } });
    expect(await allocations.void(l.id, second.id, REALM, 'anders', new Date(), actor)).toMatchObject({ kind: 'VOIDED', changed: false, set: { voidReason: 'falsch' } });
    expect((await allocations.list(l.id, REALM))?.map((s) => s.validUntil)).toEqual([null, null]);
    expect((await appended(l.id, manual('2027-01-01', [[p, 1n, 1n]]))).validFrom).toBe('2027-01-01');
    const other = await loan();
    expect(await allocations.void(other.id, first.id, REALM, 'x', at, actor)).toEqual({ kind: 'NOT_FOUND' });
    expect(await allocations.void(l.id, first.id, OTHER_REALM, 'x', at, actor)).toEqual({ kind: 'NOT_FOUND' });
    const closedLoan = await loan();
    const closedSet = await appended(closedLoan.id, manual('2026-09-01', [[p, 1n, 1n]]));
    await pool.query(`UPDATE loan SET status = 'CLOSED', version = version + 1 WHERE id = $1`, [closedLoan.id]);
    expect(await allocations.void(closedLoan.id, closedSet.id, REALM, 'x', at, actor)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'CLOSED' });
    const audit = await pool.query(`SELECT action FROM audit_record WHERE entity_type = 'LoanAllocationSet' AND entity_id = $1 ORDER BY occurred_at`, [second.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['CREATED', 'VOIDED']);
  });

  it('reads: the set on a day before, on and after a change, null before the first; the Loans of a property', async () => {
    const l = await loan();
    const [p1, p2] = [await property(), await property()];
    const first = await appended(l.id, manual('2026-09-01', [[p1, 1n, 1n]]));
    const second = await appended(l.id, manual('2027-01-01', [[p1, 1n, 4n], [p2, 3n, 4n]]));
    const sets = (await allocations.list(l.id, REALM)) ?? [];
    expect(setOn(sets, day('2026-08-31'))).toBeNull();
    expect(setOn(sets, day('2026-12-31'))?.id).toBe(first.id);
    expect(setOn(sets, day('2027-01-01'))?.id).toBe(second.id);
    expect(setOn(sets, day('2030-01-01'))?.id).toBe(second.id);

    // A second Loan on p1, a VOID set on it left out, and a VOID Loan left out entirely.
    const l2 = await loan();
    const kept = await appended(l2.id, manual('2026-10-01', [[p1, 1n, 1n]]));
    const voidedSet = await appended(l2.id, manual('2027-06-01', [[p1, 1n, 1n]]));
    await allocations.void(l2.id, voidedSet.id, REALM, 'x', new Date(), actor);
    const voidLoan = await loan();
    await appended(voidLoan.id, manual('2026-09-01', [[p1, 1n, 1n]]));
    await loans.void(voidLoan.id, REALM, 'x', new Date(), actor);

    const history = (await allocations.loansOf(p1, REALM)) ?? [];
    expect(selectPropertyLoans(history).map((i) => [i.loanId, i.allocationSetId, i.validUntil, i.share])).toEqual([
      [l.id, second.id, null, f(1n, 4n)],
      [l2.id, kept.id, null, f(1n, 1n)],
      [l.id, first.id, '2026-12-31', f(1n, 1n)],
    ]);
    expect(history.find((i) => i.allocationSetId === second.id)).toMatchObject({ status: 'ACTIVE', lenderPartyId: l.lenderPartyId, basis: 'MANUAL' });
    // On one day at most one set per Loan: newest validFrom first.
    expect(selectPropertyLoans(history, day('2026-12-31')).map((i) => i.allocationSetId)).toEqual([kept.id, first.id]);
    expect(selectPropertyLoans(history, day('2026-09-15')).map((i) => i.allocationSetId)).toEqual([first.id]);
    expect(selectPropertyLoans(history, day('2026-08-31'))).toEqual([]);
    expect((await allocations.loansOf(p2, REALM))?.map((i) => i.allocationSetId)).toEqual([second.id]);
    expect(await allocations.loansOf(await property(), REALM)).toEqual([]);
    expect(await allocations.loansOf(p1, OTHER_REALM)).toBeUndefined();
    expect(await allocations.loansOf('not-a-uuid', REALM)).toBeUndefined();
  });

  describe('concurrency (the Loan row first, P3-D8)', () => {
    const insertRaw = (loanId: string, validFrom: string, propertyReferenceId: string) =>
      `WITH s AS (
         INSERT INTO loan_allocation_set (mre_realm_id, loan_id, status, valid_from, basis, created_by)
         VALUES ('${REALM}', '${loanId}', 'VALID', '${validFrom}', 'MANUAL', 'x') RETURNING id
       )
       INSERT INTO loan_allocation (set_id, mre_realm_id, position, property_reference_id, share_numerator, share_denominator)
       SELECT id, '${REALM}', 0, '${propertyReferenceId}', 1, 1 FROM s`;

    it('two appends to one Loan (READ COMMITTED): the second waits on the Loan and sees the first', async () => {
      const l = await loan();
      const p = await property();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(insertRaw(l.id, '2026-09-01', p));
        const appending = allocations.create(l.id, REALM, manual('2026-09-01', [[p, 1n, 1n]]), actor);
        await waitForLock(pool);
        await holder.query('COMMIT');
        expect(await appending).toEqual({ kind: 'ALLOCATION_NOT_APPENDED', lastValidFrom: '2026-09-01' });
      } finally {
        holder.release();
      }
    });

    it('two raw appends (REPEATABLE READ): the later one fails to serialise', async () => {
      const l = await loan();
      const p = await property();
      const [one, two] = [await pool.connect(), await pool.connect()];
      try {
        await one.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await one.query('SELECT 1');
        await two.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await two.query(insertRaw(l.id, '2026-09-01', p));
        const second = one.query(insertRaw(l.id, '2027-01-01', p)).then(
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
      const p = await property();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE loan SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [l.id]);
        const appending = allocations.create(l.id, REALM, manual('2026-09-01', [[p, 1n, 1n]]), actor);
        await waitForLock(pool);
        await holder.query('COMMIT');
        expect(await appending).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
      } finally {
        holder.release();
      }
    });

    it('a raw void of the last set against a raw append behind it: RC refuses the void, RR fails to serialise', async () => {
      for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
        const l = await loan();
        const p = await property();
        const first = await appended(l.id, manual('2026-09-01', [[p, 1n, 1n]]));
        const [one, two] = [await pool.connect(), await pool.connect()];
        try {
          await one.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          await one.query('SELECT 1');
          await two.query('BEGIN');
          await two.query(insertRaw(l.id, '2027-01-01', p));
          const voiding = one
            .query(`UPDATE loan_allocation_set SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [first.id])
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
    type Row = readonly [propertyReferenceId: string, n: string, d: string, acquisitionId?: string];
    /** One transaction: a set and its rows, committed; the reason of a refusal (the deferred trigger's at COMMIT). */
    async function commit(loanId: string, validFrom: string, rows: readonly Row[], basis = 'MANUAL'): Promise<string> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: created } = await client.query(
          `INSERT INTO loan_allocation_set (mre_realm_id, loan_id, status, valid_from, basis, created_by) VALUES ($1, $2, 'VALID', $3, $4, 'x') RETURNING id`,
          [REALM, loanId, validFrom, basis],
        );
        await insertRows(client, created[0].id as string, rows);
        await client.query('COMMIT');
        return 'accepted';
      } catch (error) {
        await client.query('ROLLBACK');
        return reasonOf(error as Error);
      } finally {
        client.release();
      }
    }
    async function insertRows(client: pg.PoolClient | pg.Pool, setId: string, rows: readonly Row[], from = 0): Promise<void> {
      for (const [i, [pr, n, d, acquisitionId]] of rows.entries()) {
        await client.query(
          `INSERT INTO loan_allocation (set_id, mre_realm_id, position, property_reference_id, share_numerator, share_denominator, acquisition_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [setId, REALM, from + i, pr, n, d, acquisitionId ?? null],
        );
      }
    }
    const refused = (statement: string, params: unknown[] = []) =>
      pool.query(statement, params).then(
        () => 'accepted',
        (error: Error) => reasonOf(error),
      );

    it('the sum is exactly one at commit; a set with several rows passes only because the check is deferred', async () => {
      const l = await loan();
      const [p1, p2, p3] = [await property(), await property(), await property()];
      expect(await commit(l.id, '2026-09-01', [])).toBe('(SHARE_SUM_NOT_ONE)');
      expect(await commit(l.id, '2026-09-01', [[p1, '1', '3'], [p2, '1', '3']])).toBe('(SHARE_SUM_NOT_ONE)');
      expect(await commit(l.id, '2026-09-01', [[p1, '1', '3'], [p2, '2', '3'], [p3, '1', '10000']])).toBe('(SHARE_SUM_NOT_ONE)');
      expect(await commit(l.id, '2026-09-01', [[p1, '1', '3'], [p2, '1', '3'], [p3, '1', '3']])).toBe('accepted');
      // Outside an explicit transaction a lone set has no rows at its statement's end.
      expect(await refused(`INSERT INTO loan_allocation_set (mre_realm_id, loan_id, status, valid_from, basis, created_by) VALUES ($1, $2, 'VALID', '2027-01-01', 'MANUAL', 'x')`, [REALM, l.id])).toBe('(SHARE_SUM_NOT_ONE)');
    });

    it('a committed set takes no further row; rows are never updated or deleted', async () => {
      const l = await loan();
      const [p1, p2] = [await property(), await property()];
      const set = await appended(l.id, manual('2026-09-01', [[p1, 1n, 1n]]));
      const row = (n: string, d: string) =>
        refused(`INSERT INTO loan_allocation (set_id, mre_realm_id, position, property_reference_id, share_numerator, share_denominator) VALUES ($1, $2, 1, $3, $4, $5)`, [set.id, REALM, p2, n, d]);
      expect(await row('1', '10000')).toBe('(SHARE_SUM_NOT_ONE)');
      expect(await refused(`UPDATE loan_allocation SET share_numerator = 1 WHERE set_id = $1`, [set.id])).toBe('never updated');
      expect(await refused(`DELETE FROM loan_allocation WHERE set_id = $1`, [set.id])).toBe('never updated');
    });

    it('a share is a reduced fraction 0 < n ≤ d; one entry per property; a property of the Realm', async () => {
      const l = await loan();
      const [p1, p2, foreign] = [await property(), await property(), await property(OTHER_REALM)];
      expect(await commit(l.id, '2026-09-01', [[p1, '2', '2']])).toBe('loan_allocation_share');
      expect(await commit(l.id, '2026-09-01', [[p1, '2', '1'], [p2, '-1', '1']])).toBe('loan_allocation_share');
      expect(await commit(l.id, '2026-09-01', [[p1, '0', '1'], [p2, '1', '1']])).toBe('loan_allocation_share');
      expect(await commit(l.id, '2026-09-01', [[p1, '0.5', '1'], [p2, '0.5', '1']])).toBe('loan_allocation_share');
      expect(await commit(l.id, '2026-09-01', [[p1, '1.0', '1']])).toBe('loan_allocation_share');
      expect(await commit(l.id, '2026-09-01', [[p1, '1', '2'], [p1, '1', '2']])).toBe('loan_allocation_property');
      expect(await commit(l.id, '2026-09-01', [[foreign, '1', '1']])).toBe('loan_allocation_property_reference_fk');
      expect(await commit(l.id, '2026-09-01', [[p1, '10000001', '20000000'], [p2, '9999999', '20000000']])).toBe('accepted');
    });

    it('an Acquisition only of the entry’s property; the basis and acquisition_id agree', async () => {
      const l = await loan();
      const [p1, p2] = [await property(), await property()];
      const [a1, a2] = [await acquisition(p1, '1.00'), await acquisition(p2, '1.00')];
      expect(await commit(l.id, '2026-09-01', [[p1, '1', '1', a2]], 'PURCHASE_PRICE')).toBe('loan_allocation_acquisition_fk');
      expect(await commit(l.id, '2026-09-01', [[p1, '1', '1', a1]], 'MANUAL')).toBe('exactly for PURCHASE_PRICE');
      expect(await commit(l.id, '2026-09-01', [[p1, '1', '2', a1], [p2, '1', '2']], 'PURCHASE_PRICE')).toBe('exactly for PURCHASE_PRICE');
      expect(await commit(l.id, '2026-09-01', [[p1, '1', '2', a1], [p2, '1', '2', a2]], 'PURCHASE_PRICE')).toBe('accepted');
    });

    it('inserts: only VALID v1, on an ACTIVE Loan, not before the debt, appended after the last start', async () => {
      const l = await loan();
      const p = await property();
      const raw = (columns: string, values: string) =>
        refused(`INSERT INTO loan_allocation_set (mre_realm_id, loan_id, valid_from, basis, created_by, ${columns}) VALUES ($1, $2, '2026-09-01', 'MANUAL', 'x', ${values})`, [REALM, l.id]);
      expect(await raw(`status, voided_at, void_reason`, `'VOID', now(), 'x'`)).toBe('23000');
      expect(await raw(`status, version`, `'VALID', 2`)).toBe('23000');
      expect(await commit(l.id, '2026-08-31', [[p, '1', '1']])).toBe('(ALLOCATION_BEFORE_DEBT)');
      expect(await commit(l.id, '2026-09-01', [[p, '1', '1']])).toBe('accepted');
      expect(await commit(l.id, '2026-09-01', [[p, '1', '1']])).toBe('(ALLOCATION_NOT_APPENDED)');
      expect(await commit(l.id, '2026-08-31', [[p, '1', '1']])).toBe('(ALLOCATION_BEFORE_DEBT)');
      expect(await commit(l.id, '2026-09-02', [[p, '1', '1']])).toBe('accepted');
      const voided = await loan();
      await loans.void(voided.id, REALM, 'x', new Date(), actor);
      expect(await commit(voided.id, '2026-09-01', [[p, '1', '1']])).toBe('(LOAN_NOT_ACTIVE)');
    });

    it('updates: data never changes; the only step is VALID → VOID with version + 1, for the last set; never deleted', async () => {
      const l = await loan();
      const p = await property();
      const first = await appended(l.id, manual('2026-09-01', [[p, 1n, 1n]]));
      const second = await appended(l.id, manual('2027-01-01', [[p, 1n, 1n]]));
      const voidStep = `status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1`;
      expect(await refused(`UPDATE loan_allocation_set SET basis = 'PURCHASE_PRICE', version = version + 1 WHERE id = $1`, [second.id])).toBe('never edited');
      expect(await refused(`UPDATE loan_allocation_set SET valid_from = '2027-01-02', version = version + 1 WHERE id = $1`, [second.id])).toBe('never edited');
      expect(await refused(`UPDATE loan_allocation_set SET status = 'VOID', voided_at = now(), void_reason = 'x' WHERE id = $1`, [second.id])).toBe('only step');
      expect(await refused(`UPDATE loan_allocation_set SET ${voidStep} WHERE id = $1`, [first.id])).toBe('(ALLOCATION_NOT_LAST)');
      expect(await refused(`DELETE FROM loan_allocation_set WHERE id = $1`, [first.id])).toBe('never deleted');
      expect(await refused(`UPDATE loan_allocation_set SET ${voidStep}, notes = 'x' WHERE id = $1`, [second.id])).toBe('never edited');
      expect(await refused(`UPDATE loan_allocation_set SET ${voidStep} WHERE id = $1`, [second.id])).toBe('accepted');
      expect(await refused(`UPDATE loan_allocation_set SET status = 'VALID', voided_at = NULL, void_reason = NULL, version = version + 1 WHERE id = $1`, [second.id])).toBe('only step');
    });
  });
});
