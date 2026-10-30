import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Direction, SplitInput } from '../../domains/ledger/index.js';
import { parseMea, type Mea, type NewSpecialAssessment } from '../../domains/weg/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresUnconfirmedTransactionRepository } from './unconfirmed-transaction-repository.js';
import { PostgresWegRepository } from './weg-repository.js';
import { PostgresWegSpecialAssessmentRepository } from './weg-special-assessment-repository.js';

/**
 * VC-6-05 persistence (api-design.md §51A): the Sonderumlage with its order of checks, amend, uses and void; its
 * payments through `wegSpecialAssessmentId` with their rules and the exemption from the booking-date membership; the
 * derived figures from counted cash; the membership's guard; the schema past the repository; the serialisation on the
 * assessment row under RC and RR; and `down`. Figures are invented.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000092';
const OTHER_REALM = '64b0c0ffee00000000000093';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const asOf = day('2026-07-01');
const mea = (text: string): Mea => {
  const parsed = parseMea(text);
  if (!('mea' in parsed)) throw new Error(text);
  return parsed.mea;
};
const split = (
  amount: string,
  financialCategoryCode: string,
  propertyReferenceId: string | null,
  wegSpecialAssessmentId: string | null = null,
): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId,
  loanId: null,
  securityDepositId: null,
  wegSpecialAssessmentId,
  description: null,
});
let counter = 0;

async function withMigrationLock(work: () => Promise<unknown>): Promise<void> {
  const lock = new pg.Client({ connectionString: databaseUrl });
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    await work();
  } finally {
    await lock.end().catch(() => undefined);
  }
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return error.constraint ?? /\(([A-Z_]+)\)|does not mirror|VOID is final|never change/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error';
}

describe.skipIf(databaseUrl === undefined)('Sonderumlage (§51A)', () => {
  const schema = testSchemaName('weg_assessment_test');
  let pool: pg.Pool;
  let wegs: PostgresWegRepository;
  let assessments: PostgresWegSpecialAssessmentRepository;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let corrections: PostgresCorrectionRepository;
  let unconfirmed: PostgresUnconfirmedTransactionRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    wegs = new PostgresWegRepository(db);
    assessments = new PostgresWegSpecialAssessmentRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    unconfirmed = new PostgresUnconfirmedTransactionRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function member(options: { validFrom?: string; validUntil?: string } = {}) {
    const weg = await wegs.createWeg(
      { mreRealmId: REALM, displayName: `WEG ${++counter}`, administratorPartyId: null, financialYearStartMonth: 1, notes: null },
      actor,
    );
    if (weg.kind !== 'CREATED') throw new Error(weg.kind);
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fa0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [REALM, mrePropertyId],
    );
    const m = await wegs.createMembership(
      {
        mreRealmId: REALM,
        wegId: weg.weg.id,
        propertyReferenceId: rows[0].id as string,
        mea: mea('250/10000'),
        validFrom: day(options.validFrom ?? '2025-01-01'),
        validUntil: options.validUntil === undefined ? null : day(options.validUntil),
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (m.kind !== 'CREATED') throw new Error(m.kind);
    return { wegId: weg.weg.id, unit: rows[0].id as string, membership: m.membership };
  }
  /** 900 in three instalments of 300 (1 March, 1 June, 1 September 2026). */
  const newAssessment = (membershipId: string, overrides: Partial<NewSpecialAssessment> = {}): NewSpecialAssessment => ({
    mreRealmId: REALM,
    membershipId,
    description: 'Dachsanierung',
    resolutionDate: day('2026-02-10'),
    purpose: 'MAINTENANCE',
    totalAmount: eur('36000.00'),
    unitShare: eur('900.00'),
    instalments: [
      { position: 1, dueDate: day('2026-03-01'), amount: eur('300.00') },
      { position: 2, dueDate: day('2026-06-01'), amount: eur('300.00') },
      { position: 3, dueDate: day('2026-09-01'), amount: eur('300.00') },
    ],
    sourceReferences: [],
    notes: null,
    ...overrides,
  });
  async function assessment(membershipId: string, overrides: Partial<NewSpecialAssessment> = {}) {
    const created = await assessments.createAssessment(newAssessment(membershipId, overrides), actor, asOf);
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.assessment;
  }
  async function transaction(options: { direction?: Direction; amount?: string; bookingDate?: string } = {}) {
    const account = await accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: account.account.id,
        amount: eur(options.amount ?? '300.00'),
        direction: options.direction ?? 'OUTFLOW',
        bookingDate: day(options.bookingDate ?? '2026-03-02'),
        valueDate: null,
        description: 'Sonderumlage',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  async function booked(options: { direction?: Direction; amount: string; bookingDate: string }, set: SplitInput[]) {
    const tx = await transaction(options);
    const outcome = await splits.replaceSplits(tx, REALM, set, actor);
    if (outcome.kind !== 'REPLACED') throw new Error(JSON.stringify(outcome));
    expect((await transactions.confirm(tx, REALM, actor)).kind).toBe('CONFIRMED');
    return tx;
  }
  const audit = async (id: string) =>
    (await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [id])).rows as {
      action: string;
      metadata: Record<string, unknown>;
    }[];

  describe('the assessment', () => {
    it('create: derived figures, AuditRecords, replay, Realm-scoped; the order of checks', async () => {
      const { membership } = await member({ validFrom: '2026-01-01' });
      const key = { key: `k-${++counter}`, fingerprint: 'f' };
      const created = await assessments.createAssessment(newAssessment(membership.id), actor, asOf, key);
      expect(created).toMatchObject({ kind: 'CREATED', assessment: { status: 'ACTIVE', paid: eur('0.00'), outstanding: eur('900.00'), version: 1 } });
      if (created.kind !== 'CREATED') return;
      expect(created.assessment.instalmentsCovered.map((i) => i.overdue)).toEqual([true, true, false]);
      expect(await assessments.createAssessment(newAssessment(membership.id), actor, asOf, key)).toMatchObject({ kind: 'REPLAYED' });
      expect(await assessments.createAssessment(newAssessment(membership.id), actor, asOf, { ...key, fingerprint: 'g' })).toEqual({
        kind: 'IDEMPOTENCY_CONFLICT',
      });
      expect((await audit(created.assessment.id)).map((a) => a.action)).toEqual(['CREATED']);
      expect((await audit(membership.id)).map((a) => a.action)).toContain('SPECIAL_ASSESSMENT_ADDED');
      expect(await assessments.findAssessment(created.assessment.id, OTHER_REALM, asOf)).toBeUndefined();
      expect(await assessments.createAssessment({ ...newAssessment(membership.id), mreRealmId: OTHER_REALM }, actor, asOf)).toEqual({
        kind: 'MEMBERSHIP_NOT_FOUND',
      });
      expect(await assessments.createAssessment(newAssessment(membership.id, { resolutionDate: day('2025-12-31') }), actor, asOf)).toEqual({
        kind: 'ASSESSMENT_OUTSIDE_MEMBERSHIP',
        validFrom: '2026-01-01',
        validUntil: null,
      });
      const voided = await member();
      await wegs.voidMembership(voided.membership.id, REALM, 'x', new Date(), actor);
      expect(await assessments.createAssessment(newAssessment(voided.membership.id), actor, asOf)).toEqual({
        kind: 'MEMBERSHIP_NOT_ACTIVE',
        membershipId: voided.membership.id,
      });
    });

    it('amend and uses: no-op before If-Match, AuditRecords; VOID refused', async () => {
      const { membership } = await member();
      const a = await assessment(membership.id);
      const content = newAssessment(membership.id);
      expect(await assessments.amendAssessment(a.id, REALM, content, actor, asOf, [9])).toMatchObject({ kind: 'AMENDED', changed: false });
      expect(await assessments.amendAssessment(a.id, REALM, { ...content, purpose: 'MODERNISATION' }, actor, asOf, [9])).toEqual({
        kind: 'VERSION_CONFLICT',
        expectedVersions: [9],
        currentVersion: 1,
      });
      expect(await assessments.amendAssessment(a.id, REALM, { ...content, purpose: 'MODERNISATION' }, actor, asOf, [1])).toMatchObject({
        kind: 'AMENDED',
        changed: true,
        assessment: { purpose: 'MODERNISATION', version: 2 },
      });
      const uses = [{ position: 1, date: day('2026-08-01'), description: 'Dachdecker', unitShare: eur('400.00') }];
      const withUses = await assessments.replaceUses(a.id, REALM, uses, actor, asOf);
      expect(withUses).toMatchObject({ kind: 'AMENDED', changed: true, assessment: { version: 3 } });
      if (withUses.kind === 'AMENDED') expect(withUses.assessment.flags.map((f) => f.code)).toEqual(['USES_EXCEED_PAID']);
      expect(await assessments.replaceUses(a.id, REALM, uses, actor, asOf)).toMatchObject({ changed: false });
      expect((await audit(a.id)).map((r) => r.action)).toEqual(['CREATED', 'AMENDED', 'USES_REPLACED']);
      expect((await audit(a.id))[1]?.metadata).toEqual({ changedFields: ['purpose'] });
      expect((await assessments.voidAssessment(a.id, REALM, 'Doppelt', new Date(), actor, asOf)).kind).toBe('VOIDED');
      expect(await assessments.amendAssessment(a.id, REALM, content, actor, asOf)).toEqual({ kind: 'ASSESSMENT_NOT_ACTIVE' });
      expect(await assessments.replaceUses(a.id, REALM, [], actor, asOf)).toEqual({ kind: 'ASSESSMENT_NOT_ACTIVE' });
      expect(await assessments.voidAssessment(a.id, REALM, 'again', new Date(), actor, asOf)).toMatchObject({ kind: 'VOIDED', changed: false });
    });

    it('list: by resolution date; the derived status and the purpose filtered; unknown membership', async () => {
      const { unit, membership } = await member();
      const late = await assessment(membership.id, {
        resolutionDate: day('2026-05-01'),
        purpose: 'LIQUIDITY',
        unitShare: eur('100.00'),
        instalments: [{ position: 1, dueDate: day('2026-06-01'), amount: eur('100.00') }],
      });
      const early = await assessment(membership.id);
      await booked({ amount: '100.00', bookingDate: '2026-06-02' }, [split('100.00', 'WEG_SPECIAL_ASSESSMENT', unit, late.id)]);
      const all = await assessments.listAssessments(membership.id, REALM, {}, { page: 1, pageSize: 50 }, asOf);
      expect(all?.items.map((a) => [a.id, a.status])).toEqual([
        [early.id, 'ACTIVE'],
        [late.id, 'SETTLED'],
      ]);
      expect(
        (await assessments.listAssessments(membership.id, REALM, { statuses: ['SETTLED'] }, { page: 1, pageSize: 50 }, asOf))?.items.map((a) => a.id),
      ).toEqual([late.id]);
      expect((await assessments.listAssessments(membership.id, REALM, { purposes: ['MAINTENANCE'] }, { page: 1, pageSize: 50 }, asOf))?.total).toBe(1);
      expect(await assessments.listAssessments(membership.id, OTHER_REALM, {}, { page: 1, pageSize: 50 }, asOf)).toBeUndefined();
    });
  });

  describe('payments', () => {
    it('the split rules in order; the payments count in due order; a refund and an uncounted payment', async () => {
      const { unit: pr, membership } = await member();
      const a = await assessment(membership.id);
      const tx = await transaction();
      const replace = (set: SplitInput[]) => splits.replaceSplits(tx, REALM, set, actor);
      const unknown = '00000000-0000-4000-8000-000000000000';
      expect(await replace([split('300.00', 'WEG_SPECIAL_ASSESSMENT', pr, unknown)])).toEqual({
        kind: 'WEG_ASSESSMENT_NOT_FOUND',
        wegSpecialAssessmentId: unknown,
      });
      expect(await replace([split('300.00', 'WEG_RESERVE_CONTRIBUTION', pr, a.id)])).toEqual({
        kind: 'INVALID_WEG_ASSESSMENT_SPLIT',
        position: 1,
        reason: 'CATEGORY',
      });
      expect(await replace([split('300.00', 'WEG_SPECIAL_ASSESSMENT', (await member()).unit, a.id)])).toEqual({
        kind: 'INVALID_WEG_ASSESSMENT_SPLIT',
        position: 1,
        reason: 'UNIT',
      });
      expect(await replace([split('300.00', 'WEG_SPECIAL_ASSESSMENT', null)])).toMatchObject({ kind: 'NO_WEG_MEMBERSHIP', reason: 'NO_UNIT' });
      // Without an assessment, a WEG_SPECIAL_ASSESSMENT split counts for none but is allowed with a membership.
      expect((await replace([split('300.00', 'WEG_SPECIAL_ASSESSMENT', pr)])).kind).toBe('REPLACED');
      expect((await replace([split('300.00', 'WEG_SPECIAL_ASSESSMENT', pr, a.id)])).kind).toBe('REPLACED');
      await transactions.confirm(tx, REALM, actor);
      await booked({ amount: '250.00', bookingDate: '2026-06-02' }, [split('250.00', 'WEG_SPECIAL_ASSESSMENT', pr, a.id)]);
      await booked({ direction: 'INFLOW', amount: '20.00', bookingDate: '2026-06-20' }, [split('20.00', 'WEG_SPECIAL_ASSESSMENT', pr, a.id)]);
      const open = await transaction({ amount: '10.00', bookingDate: '2026-06-25' });
      await splits.replaceSplits(open, REALM, [split('10.00', 'WEG_SPECIAL_ASSESSMENT', pr, a.id)], actor);
      const view = await assessments.findAssessment(a.id, REALM, asOf);
      expect(view).toMatchObject({ status: 'ACTIVE', paid: eur('530.00'), outstanding: eur('370.00') });
      expect(view?.instalmentsCovered.map((i) => [i.covered.amount, i.overdue])).toEqual([
        ['300.00', false],
        ['230.00', true],
        ['0.00', false],
      ]);
      expect(view?.flags).toEqual([{ code: 'UNCOUNTED_PAYMENTS', details: { transactionIds: [open] } }]);
    });

    it('a reversal does not count and mirrors the id; a payment after the sale is checked against the assessment', async () => {
      const { unit: pr, membership } = await member({ validUntil: '2026-06-30' });
      const a = await assessment(membership.id);
      const paid = await booked({ amount: '900.00', bookingDate: '2026-03-02' }, [split('900.00', 'WEG_SPECIAL_ASSESSMENT', pr, a.id)]);
      expect((await assessments.findAssessment(a.id, REALM, asOf))?.status).toBe('SETTLED');
      expect((await corrections.correct(paid, REALM, { reason: 'falsch', replacement: null }, actor)).kind).toBe('CORRECTED');
      expect(await assessments.findAssessment(a.id, REALM, asOf)).toMatchObject({ status: 'ACTIVE', paid: eur('0.00') });
      // After the membership ended: the plain split is refused, the assessment's payment is not.
      expect(
        await splits.replaceSplits(await transaction({ bookingDate: '2026-09-01' }), REALM, [split('300.00', 'WEG_SPECIAL_ASSESSMENT', pr)], actor),
      ).toMatchObject({
        reason: 'NO_MEMBERSHIP',
      });
      const late = await transaction({ bookingDate: '2026-09-01' });
      expect((await splits.replaceSplits(late, REALM, [split('300.00', 'WEG_SPECIAL_ASSESSMENT', pr, a.id)], actor)).kind).toBe('REPLACED');
      expect((await unconfirmed.amend(late, REALM, { bookingDate: day('2026-10-01') }, actor)).kind).toBe('AMENDED');
    });

    it('void: refused while a split names it, a reversal included; a split on a VOID assessment is refused', async () => {
      const { unit: pr, membership } = await member();
      const a = await assessment(membership.id);
      const paid = await booked({ amount: '300.00', bookingDate: '2026-03-02' }, [split('300.00', 'WEG_SPECIAL_ASSESSMENT', pr, a.id)]);
      await corrections.correct(paid, REALM, { reason: 'falsch', replacement: null }, actor);
      const refused = await assessments.voidAssessment(a.id, REALM, 'x', new Date(), actor, asOf);
      expect(refused).toMatchObject({ kind: 'ASSESSMENT_HAS_SPLITS' });
      if (refused.kind === 'ASSESSMENT_HAS_SPLITS') expect(refused.transactionIds).toHaveLength(2);
      const empty = await assessment(membership.id);
      expect((await assessments.voidAssessment(empty.id, REALM, 'Doppelt', new Date(), actor, asOf, [1])).kind).toBe('VOIDED');
      expect(await splits.replaceSplits(await transaction(), REALM, [split('300.00', 'WEG_SPECIAL_ASSESSMENT', pr, empty.id)], actor)).toEqual({
        kind: 'ASSESSMENT_NOT_ACTIVE',
        wegSpecialAssessmentId: empty.id,
        status: 'VOID',
      });
    });
  });

  describe('rules elsewhere', () => {
    it('MEMBERSHIP_HAS_ASSESSMENTS on end and void; a payment after the sale does not hold; no WEG_HAS_YEARS', async () => {
      const { wegId, unit: pr, membership } = await member();
      const a = await assessment(membership.id);
      await booked({ amount: '300.00', bookingDate: '2026-08-03' }, [split('300.00', 'WEG_SPECIAL_ASSESSMENT', pr, a.id)]);
      expect(await wegs.endMembership(membership.id, REALM, day('2026-01-31'), actor)).toEqual({ kind: 'MEMBERSHIP_HAS_ASSESSMENTS', assessmentIds: [a.id] });
      expect(await wegs.voidMembership(membership.id, REALM, 'x', new Date(), actor)).toMatchObject({ kind: 'MEMBERSHIP_HAS_ASSESSMENTS' });
      // The sale on 30 June: the payment of 3 August follows the assessment and does not hold the membership.
      expect((await wegs.endMembership(membership.id, REALM, day('2026-06-30'), actor)).kind).toBe('ENDED');
      // A Sonderumlage is filed by resolution date: the start month stays amendable.
      expect((await wegs.amendWeg(wegId, REALM, { financialYearStartMonth: 7 }, actor)).kind).toBe('AMENDED');
    });
  });

  describe('schema past the repository', () => {
    const insert = (membershipId: string, resolutionDate = '2026-02-10', status = 'ACTIVE') =>
      pool
        .query(
          `INSERT INTO weg_special_assessment (mre_realm_id, membership_id, description, resolution_date, purpose, unit_share, currency, instalments, status, created_by)
           VALUES ($1, $2, 'd', $3, 'OTHER', 100, 'EUR', '[{"position":1}]', $4, 'x') RETURNING id`,
          [REALM, membershipId, resolutionDate, status],
        )
        .then((r) => r.rows[0].id as string, reasonOf);
    const update = (table: string, set: string, id: string) => pool.query(`UPDATE ${table} SET ${set} WHERE id = $1`, [id]).then(() => 'accepted', reasonOf);
    const categoryId = async (code: string) => (await pool.query(`SELECT id FROM financial_category WHERE code = $1`, [code])).rows[0].id as string;
    const insertSplit = async (transactionId: string, code: string, unitId: string | null, assessmentId: string, extra = '') =>
      pool
        .query(
          `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id,
             weg_special_assessment_id, created_by${extra === '' ? '' : ', weg_annual_statement_id'})
           VALUES ($1, $2, 1, 300, 'EUR', $3, $4, $5, 'x'${extra === '' ? '' : `, '${extra}'`})`,
          [transactionId, REALM, await categoryId(code), unitId, assessmentId],
        )
        .then(() => 'accepted', reasonOf);

    it('the assessment guards: membership, frozen, initial, void unreferenced, no delete', async () => {
      const { unit: pr, membership } = await member({ validFrom: '2026-01-01' });
      expect(await insert(membership.id, '2025-12-31')).toBe('(ASSESSMENT_OUTSIDE_MEMBERSHIP)');
      expect(await insert(membership.id, '2026-02-10', 'VOID')).not.toMatch(/^[0-9a-f-]{36}$/);
      const id = await insert(membership.id);
      expect(await update('weg_special_assessment', `resolution_date = '2026-02-11', version = version + 1`, id)).toBe('never change');
      expect(await update('weg_special_assessment', `description = 'e'`, id)).toBe('never change');
      expect(await update('weg_special_assessment', `description = 'e', version = version + 1`, id)).toBe('accepted');
      expect(await update('weg_special_assessment', `version = version`, id)).toBe('accepted');
      expect(await insertSplit(await transaction(), 'WEG_SPECIAL_ASSESSMENT', pr, id)).toBe('accepted');
      expect(await update('weg_special_assessment', `status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1`, id)).toBe(
        '(ASSESSMENT_HAS_SPLITS)',
      );
      expect(await pool.query(`DELETE FROM weg_special_assessment WHERE id = $1`, [id]).then(() => 'accepted', reasonOf)).not.toBe('accepted');
      const other = await insert(membership.id);
      expect(
        await update('weg_special_assessment', `status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1`, other),
      ).toBe('accepted');
      expect(await update('weg_special_assessment', `description = 'f', version = version + 1`, other)).toBe('VOID is final');
      expect(await insertSplit(await transaction(), 'WEG_SPECIAL_ASSESSMENT', pr, other)).toBe('(ASSESSMENT_NOT_ACTIVE)');
      const voided = await member();
      await wegs.voidMembership(voided.membership.id, REALM, 'x', new Date(), actor);
      expect(await insert(voided.membership.id)).toBe('(MEMBERSHIP_NOT_ACTIVE)');
    });

    it('the split trigger and the CHECK: category, unit, alone; weg_membership_assessments', async () => {
      const { unit: pr, membership } = await member();
      const id = await insert(membership.id);
      expect(await insertSplit(await transaction(), 'WEG_RESERVE_CONTRIBUTION', pr, id)).toBe('(INVALID_WEG_ASSESSMENT_SPLIT)');
      expect(await insertSplit(await transaction(), 'WEG_SPECIAL_ASSESSMENT', (await member()).unit, id)).toBe('(INVALID_WEG_ASSESSMENT_SPLIT)');
      expect(await insertSplit(await transaction(), 'OTHER_EXPENSE', null, id)).toBe('transaction_split_weg_assessment_alone');
      expect(await update('weg_membership', `valid_until = '2026-01-31', version = version + 1`, membership.id)).toBe('(MEMBERSHIP_HAS_ASSESSMENTS)');
      expect(await update('weg_membership', `valid_until = '2026-02-10', version = version + 1`, membership.id)).toBe('accepted');
    });

    it('0014 mirror: a reversal dropping or changing the assessment is refused at commit', async () => {
      const { unit: pr, membership } = await member();
      const a = await assessment(membership.id);
      const b = await assessment(membership.id);
      const reverseWith = async (assessmentId: string | null) => {
        const original = await booked({ amount: '300.00', bookingDate: '2026-03-02' }, [split('300.00', 'WEG_SPECIAL_ASSESSMENT', pr, a.id)]);
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
          await client.query(
            `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id,
               weg_special_assessment_id, created_by)
             SELECT $1, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, $3::uuid, 'x' FROM transaction_split
              WHERE transaction_id = $2`,
            [rows[0].id, original, assessmentId],
          );
          await client.query(`UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x' WHERE id = $1`, [rows[0].id]);
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
      expect(await reverseWith(b.id)).toBe('does not mirror');
      expect(await reverseWith(a.id)).toBe('accepted');
    });

    it('down drops the table, the column and the triggers and restores 0043 (under MIGRATION_ADVISORY_LOCK)', { timeout: 30_000 }, async () => {
      const downSchema = testSchemaName('weg_assessment_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        await withMigrationLock(async () => (await import('./migrations/0044_weg_special_assessment.js')).down(createDatabase(downPool) as never));
        expect((await downPool.query(`SELECT to_regclass('weg_special_assessment') AS t`)).rows[0].t).toBeNull();
        expect((await downPool.query(`SELECT count(*)::int AS n FROM financial_category WHERE code = 'WEG_SPECIAL_ASSESSMENT'`)).rows[0].n).toBe(0);
        const source = async (name: string) =>
          (
            await downPool.query(`SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = $1 AND proname = $2`, [
              downSchema,
              name,
            ])
          ).rows[0]?.prosrc as string | undefined;
        for (const fn of ['transaction_split_weg_assessment', 'weg_membership_assessments', 'weg_special_assessment_frozen'])
          expect(await source(fn)).toBeUndefined();
        for (const fn of ['transaction_split_weg', 'ledger_transaction_weg_booking_date', 'weg_membership_guard', 'ledger_transaction_reversal_mirror']) {
          expect(await source(fn)).not.toContain('weg_special_assessment_id');
          expect(await source(fn)).not.toContain('WEG_SPECIAL_ASSESSMENT');
        }
        expect(await source('weg_membership_guard')).toContain('weg_annual_statement_id');
      } finally {
        await downPool.end();
      }
    });
  });

  describe('concurrency on the assessment row', () => {
    const waitForLock = (text: string) =>
      waitUntil(
        async () =>
          Number(
            (
              await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [
                `%${text}%`,
              ])
            ).rows[0].count,
          ) >= 1,
      );
    const insertPayment = async (client: pg.PoolClient | pg.Pool, tx: string, pr: string, id: string) =>
      client.query(
        `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id,
           weg_special_assessment_id, created_by)
         SELECT $1, $2, 1, 300, 'EUR', id, $3, $4, 'x' FROM financial_category WHERE code = 'WEG_SPECIAL_ASSESSMENT'`,
        [tx, REALM, pr, id],
      );
    const voidSql = `UPDATE weg_special_assessment SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1 WHERE id = $1`;

    it('RC: a void waiting on a payment in flight sees it and is refused', async () => {
      const { unit: pr, membership } = await member();
      const a = await assessment(membership.id);
      const tx = await transaction();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await insertPayment(holder, tx, pr, a.id);
        const voiding = assessments.voidAssessment(a.id, REALM, 'x', new Date(), actor, asOf);
        await waitForLock('"weg_special_assessment"');
        await holder.query('COMMIT');
        expect(await voiding).toMatchObject({ kind: 'ASSESSMENT_HAS_SPLITS', transactionIds: [tx] });
      } finally {
        holder.release();
      }
    });

    it('RC: a payment waiting on a void sees VOID and is refused', async () => {
      const { unit: pr, membership } = await member();
      const a = await assessment(membership.id);
      const tx = await transaction();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(voidSql, [a.id]);
        const writing = splits.replaceSplits(tx, REALM, [split('300.00', 'WEG_SPECIAL_ASSESSMENT', pr, a.id)], actor);
        await waitForLock('"weg_special_assessment"');
        await holder.query('COMMIT');
        expect(await writing).toMatchObject({ kind: 'ASSESSMENT_NOT_ACTIVE', status: 'VOID' });
      } finally {
        holder.release();
      }
    });

    it('RR: a payment insert and a void; the later one fails to serialise', async () => {
      const { unit: pr, membership } = await member();
      const a = await assessment(membership.id);
      const tx = await transaction();
      const [first, second] = [await pool.connect(), await pool.connect()];
      try {
        await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await first.query('SELECT count(*) FROM transaction_split');
        await second.query('SELECT count(*) FROM weg_special_assessment');
        await insertPayment(first, tx, pr, a.id);
        const late = second.query(voidSql, [a.id]).then(
          () => 'voided',
          (error: { code?: string }) => error.code,
        );
        await waitForLock('UPDATE weg_special_assessment SET status');
        await first.query('COMMIT');
        expect(await late).toBe('40001');
        await second.query('ROLLBACK');
      } finally {
        first.release();
        second.release();
      }
    });
  });
});
