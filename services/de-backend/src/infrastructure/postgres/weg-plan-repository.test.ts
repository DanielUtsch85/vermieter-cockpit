import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessDate, Direction, SplitInput } from '../../domains/ledger/index.js';
import { parseMea, type Mea, type NewEconomicPlan } from '../../domains/weg/index.js';
import { Money } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresUnconfirmedTransactionRepository } from './unconfirmed-transaction-repository.js';
import { PostgresWegEconomicPlanRepository } from './weg-economic-plan-repository.js';
import { PostgresWegRepository } from './weg-repository.js';

/**
 * VC-6-02 persistence (api-design.md §49.3–§49.6): the WEG split rule through the splits command and `correct`, the
 * membership guards, `WEG_FUNDS`, the Wirtschaftsplan with its order of checks and derived figures, the proposal's
 * snapshot, the schema's rules past the repository, the serialisation on the unit under RC and RR, and `down`.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000062';
const OTHER_REALM = '64b0c0ffee00000000000063';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const mea = (text: string): Mea => {
  const parsed = parseMea(text);
  if (!('mea' in parsed)) throw new Error(text);
  return parsed.mea;
};
const split = (amount: string, financialCategoryCode: string, propertyReferenceId: string | null = null): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId,
  loanId: null,
  securityDepositId: null,
  description: null,
});
let counter = 0;

/** Runs `work` under the session advisory lock that migrations and schema teardown take (migrate.ts). */
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
  return error.constraint ?? /\(([A-Z_]+)\)|VOID is final|only ACTIVE → VOID/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error';
}

describe.skipIf(databaseUrl === undefined)('WEG splits and Wirtschaftsplan (§49.3–§49.6)', () => {
  const schema = testSchemaName('weg_plan_test');
  let pool: pg.Pool;
  let wegs: PostgresWegRepository;
  let plans: PostgresWegEconomicPlanRepository;
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
    plans = new PostgresWegEconomicPlanRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    unconfirmed = new PostgresUnconfirmedTransactionRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function unit(realm = REALM): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f70000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function member(options: { validFrom?: string; validUntil?: string | null; startMonth?: number } = {}) {
    const weg = await wegs.createWeg(
      { mreRealmId: REALM, displayName: `WEG ${++counter}`, administratorPartyId: null, financialYearStartMonth: options.startMonth ?? 1, notes: null },
      actor,
    );
    if (weg.kind !== 'CREATED') throw new Error(weg.kind);
    const pr = await unit();
    const m = await wegs.createMembership(
      {
        mreRealmId: REALM,
        wegId: weg.weg.id,
        propertyReferenceId: pr,
        mea: mea('125.5/10000'),
        validFrom: day(options.validFrom ?? '2026-01-01'),
        validUntil: options.validUntil === undefined ? null : day(options.validUntil as string),
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (m.kind !== 'CREATED') throw new Error(m.kind);
    return { wegId: weg.weg.id, unit: pr, membership: m.membership };
  }
  async function transaction(options: { direction?: Direction; amount?: string; bookingDate?: string; propertyReferenceId?: string | null } = {}) {
    const account = await accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: account.account.id,
        amount: eur(options.amount ?? '360.00'),
        direction: options.direction ?? 'OUTFLOW',
        bookingDate: day(options.bookingDate ?? '2026-03-02'),
        valueDate: null,
        description: 'Hausgeld',
        propertyReferenceId: options.propertyReferenceId ?? null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  const newPlan = (membershipId: string, overrides: Partial<NewEconomicPlan> = {}): NewEconomicPlan => ({
    mreRealmId: REALM,
    membershipId,
    financialYear: 2026,
    effectiveFrom: day('2026-03-01'),
    resolutionDate: day('2026-02-20'),
    monthlyHausgeld: eur('300.00'),
    monthlyReserveContribution: eur('60.00'),
    recoverableCosts: eur('2400.00'),
    nonRecoverableCosts: eur('1200.00'),
    income: null,
    annualReserveContribution: null,
    costLines: [],
    sourceReferences: [],
    notes: null,
    ...overrides,
  });
  async function plan(membershipId: string, overrides: Partial<NewEconomicPlan> = {}) {
    const outcome = await plans.createPlan(newPlan(membershipId, overrides), actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.plan;
  }

  describe('the WEG split rule (§49.3)', () => {
    it('NO_UNIT, then NO_MEMBERSHIP (none, or not on the booking date); allowed with a membership; other categories untouched', async () => {
      const { unit: pr } = await member({ validFrom: '2026-03-01' });
      const early = await transaction({ bookingDate: '2026-02-28' });
      expect(await splits.replaceSplits(early, REALM, [split('300.00', 'WEG_NON_RECOVERABLE'), split('60.00', 'WEG_RESERVE_CONTRIBUTION')], actor)).toEqual({
        kind: 'NO_WEG_MEMBERSHIP',
        position: 1,
        reason: 'NO_UNIT',
      });
      expect(await splits.replaceSplits(early, REALM, [split('360.00', 'WEG_RESERVE_CONTRIBUTION', pr)], actor)).toEqual({
        kind: 'NO_WEG_MEMBERSHIP',
        position: 1,
        reason: 'NO_MEMBERSHIP',
        propertyReferenceId: pr,
        bookingDate: '2026-02-28',
      });
      const elsewhere = await unit();
      const tx = await transaction();
      expect(
        await splits.replaceSplits(tx, REALM, [split('300.00', 'WEG_RECOVERABLE', pr), split('60.00', 'WEG_RESERVE_CONTRIBUTION', elsewhere)], actor),
      ).toMatchObject({
        reason: 'NO_MEMBERSHIP',
        position: 2,
      });
      expect(
        await splits.replaceSplits(tx, REALM, [split('300.00', 'WEG_RECOVERABLE', pr), split('60.00', 'WEG_RESERVE_CONTRIBUTION', pr)], actor),
      ).toMatchObject({
        kind: 'REPLACED',
        changed: true,
      });
      expect((await splits.replaceSplits(await transaction(), REALM, [split('360.00', 'OTHER_EXPENSE')], actor)).kind).toBe('REPLACED');
    });

    it('correct: a replacement copying a pre-Phase-6 split without unit is refused; the reversal alone is exempt', async () => {
      const tx = await transaction();
      // A split written before VC-6-02, past the new guard.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE transaction_split DISABLE TRIGGER transaction_split_weg');
        await client.query(
          `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, created_by)
           SELECT $1, $2, 1, 360, 'EUR', id, 'x' FROM financial_category WHERE code = 'WEG_NON_RECOVERABLE'`,
          [tx, REALM],
        );
        await client.query('ALTER TABLE transaction_split ENABLE TRIGGER transaction_split_weg');
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect((await transactions.confirm(tx, REALM, actor)).kind).toBe('CONFIRMED');
      expect(await corrections.correct(tx, REALM, { reason: 'Datum', replacement: { bookingDate: day('2026-03-03') } }, actor)).toEqual({
        kind: 'NO_WEG_MEMBERSHIP',
        position: 1,
        reason: 'NO_UNIT',
      });
      expect((await corrections.correct(tx, REALM, { reason: 'doppelt', replacement: null }, actor)).kind).toBe('CORRECTED');
    });

    it('correct: a replacement naming the unit is checked against its own booking date', async () => {
      const { unit: pr } = await member({ validFrom: '2026-03-01' });
      const tx = await transaction({ bookingDate: '2026-03-02' });
      await splits.replaceSplits(tx, REALM, [split('360.00', 'WEG_NON_RECOVERABLE', pr)], actor);
      await transactions.confirm(tx, REALM, actor);
      expect(await corrections.correct(tx, REALM, { reason: 'Datum', replacement: { bookingDate: day('2026-02-27') } }, actor)).toMatchObject({
        kind: 'NO_WEG_MEMBERSHIP',
        reason: 'NO_MEMBERSHIP',
        bookingDate: '2026-02-27',
      });
    });

    it('amend: a booking date that leaves a kept WEG split without membership is refused (review on #147)', async () => {
      const { unit: pr } = await member({ validFrom: '2026-03-01', validUntil: '2026-12-31' });
      const tx = await transaction({ bookingDate: '2026-03-02' });
      await splits.replaceSplits(tx, REALM, [split('300.00', 'WEG_RECOVERABLE', pr), split('60.00', 'WEG_RESERVE_CONTRIBUTION', pr)], actor);
      expect(await unconfirmed.amend(tx, REALM, { bookingDate: day('2026-02-01') }, actor)).toEqual({
        kind: 'NO_WEG_MEMBERSHIP',
        position: 1,
        reason: 'NO_MEMBERSHIP',
        propertyReferenceId: pr,
        bookingDate: '2026-02-01',
      });
      expect((await unconfirmed.amend(tx, REALM, { bookingDate: day('2027-01-01') }, actor)).kind).toBe('NO_WEG_MEMBERSHIP');
      expect((await unconfirmed.amend(tx, REALM, { bookingDate: day('2026-03-03') }, actor)).kind).toBe('AMENDED');
      // A changed amount drops the splits (§31.3): then any date is free.
      expect((await unconfirmed.amend(tx, REALM, { bookingDate: day('2026-02-01'), amount: eur('361.00') }, actor)).kind).toBe('AMENDED');
    });

    it('membership end and void: MEMBERSHIP_HAS_SPLITS for a split outside the rest, on any status; inside it the end passes', async () => {
      const { unit: pr, membership } = await member();
      const tx = await transaction({ bookingDate: '2026-09-01' });
      await splits.replaceSplits(tx, REALM, [split('360.00', 'WEG_NON_RECOVERABLE', pr)], actor);
      expect(await wegs.endMembership(membership.id, REALM, day('2026-06-30'), actor)).toEqual({ kind: 'MEMBERSHIP_HAS_SPLITS', transactionIds: [tx] });
      expect(await wegs.voidMembership(membership.id, REALM, 'falsch', new Date(), actor)).toEqual({ kind: 'MEMBERSHIP_HAS_SPLITS', transactionIds: [tx] });
      expect(await wegs.endMembership(membership.id, REALM, day('2026-09-01'), actor)).toMatchObject({ kind: 'ENDED', changed: true });
    });
  });

  describe('WEG_FUNDS (§49.4)', () => {
    it('the reserve contribution reads as WEG_FUNDS, the Hausgeld categories stay operating expenses', async () => {
      const { rows } = await pool.query(`SELECT code, category_type FROM financial_category WHERE code LIKE 'WEG_%' ORDER BY code`);
      expect(rows).toEqual([
        { code: 'WEG_NON_RECOVERABLE', category_type: 'OPERATING_EXPENSE' },
        { code: 'WEG_RECOVERABLE', category_type: 'OPERATING_EXPENSE' },
        { code: 'WEG_RESERVE_CONTRIBUTION', category_type: 'WEG_FUNDS' },
      ]);
    });
  });

  describe('the Wirtschaftsplan (§49.5)', () => {
    it('create: derived components, flags, AuditRecords; a replay; PLAN_EXISTS; void and a new one on the same day', async () => {
      const { membership } = await member();
      const outcome = await plans.createPlan(newPlan(membership.id, { income: eur('120.00') }), actor, { key: 'k-plan', fingerprint: 'f' });
      if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
      expect(outcome.plan).toMatchObject({ status: 'ACTIVE', version: 1, effectiveFrom: '2026-03-01', financialYear: 2026 });
      expect(outcome.plan.components.recoverable.amount).toBe('200.00');
      expect(outcome.plan.flags.map((f) => f.code)).toEqual(['HAUSGELD_DIFFERS_FROM_PLAN']);
      expect(await plans.createPlan(newPlan(membership.id), actor, { key: 'k-plan', fingerprint: 'f' })).toMatchObject({
        kind: 'REPLAYED',
        plan: { id: outcome.plan.id },
      });
      expect(await plans.createPlan(newPlan(membership.id), actor)).toEqual({ kind: 'PLAN_EXISTS', economicPlanId: outcome.plan.id });
      const audits = (
        await pool.query(`SELECT entity_type, action FROM audit_record WHERE metadata->>'economicPlanId' = $1 OR entity_id = $1`, [outcome.plan.id])
      ).rows;
      expect(audits).toEqual(
        expect.arrayContaining([
          { entity_type: 'WegEconomicPlan', action: 'CREATED' },
          { entity_type: 'WegMembership', action: 'ECONOMIC_PLAN_ADDED' },
        ]),
      );
      expect(await plans.voidPlan(outcome.plan.id, REALM, 'Tippfehler', new Date(), actor, [1])).toMatchObject({ kind: 'VOIDED', changed: true });
      expect(await plans.voidPlan(outcome.plan.id, REALM, 'nochmal', new Date(), actor, [9])).toMatchObject({ kind: 'VOIDED', changed: false });
      expect((await plans.createPlan(newPlan(membership.id), actor)).kind).toBe('CREATED');
      const listed = await plans.listPlans(membership.id, REALM, {}, { page: 1, pageSize: 50 });
      expect(listed?.items.map((p) => p.status)).toEqual(['VOID', 'ACTIVE']);
      expect(listed?.total).toBe(2);
      expect(await plans.listPlans(membership.id, OTHER_REALM, {}, { page: 1, pageSize: 50 })).toBeUndefined();
    });

    it('order of checks: unknown membership, outside the financial year, VOID membership, outside the membership', async () => {
      expect(await plans.createPlan(newPlan('00000000-0000-4000-8000-000000000000'), actor)).toEqual({ kind: 'MEMBERSHIP_NOT_FOUND' });
      const { membership } = await member({ validFrom: '2026-04-01', startMonth: 7 });
      expect(await plans.createPlan(newPlan(membership.id, { financialYear: 2026, effectiveFrom: day('2026-05-01') }), actor)).toEqual({
        kind: 'EFFECTIVE_FROM_OUTSIDE_YEAR',
        from: '2026-07-01',
        until: '2027-06-30',
      });
      expect(await plans.createPlan(newPlan(membership.id, { financialYear: 2025, effectiveFrom: day('2026-03-01') }), actor)).toEqual({
        kind: 'PLAN_OUTSIDE_MEMBERSHIP',
        validFrom: '2026-04-01',
        validUntil: null,
      });
      expect((await plans.createPlan(newPlan(membership.id, { financialYear: 2025, effectiveFrom: day('2026-04-01') }), actor)).kind).toBe('CREATED');
      const { membership: other } = await member();
      await wegs.voidMembership(other.id, REALM, 'falsch', new Date(), actor);
      expect(await plans.createPlan(newPlan(other.id), actor)).toEqual({ kind: 'MEMBERSHIP_NOT_ACTIVE' });
    });

    it('MEMBERSHIP_HAS_PLANS on end and void; WEG_HAS_YEARS on the start month', async () => {
      const { wegId, membership } = await member();
      const p = await plan(membership.id, { effectiveFrom: day('2026-07-01') });
      expect(await wegs.endMembership(membership.id, REALM, day('2026-06-30'), actor)).toEqual({ kind: 'MEMBERSHIP_HAS_PLANS', economicPlanIds: [p.id] });
      expect(await wegs.voidMembership(membership.id, REALM, 'x', new Date(), actor)).toEqual({ kind: 'MEMBERSHIP_HAS_PLANS', economicPlanIds: [p.id] });
      expect(await wegs.amendWeg(wegId, REALM, { financialYearStartMonth: 7 }, actor)).toEqual({ kind: 'WEG_HAS_YEARS' });
      expect((await wegs.amendWeg(wegId, REALM, { notes: 'ok' }, actor)).kind).toBe('AMENDED');
      await plans.voidPlan(p.id, REALM, 'x', new Date(), actor);
      expect((await wegs.amendWeg(wegId, REALM, { financialYearStartMonth: 7 }, actor)).kind).toBe('AMENDED');
    });
  });

  describe('the proposal snapshot (§49.6)', () => {
    it('refusals in order, then the plan in force and ALREADY_SPLIT', async () => {
      expect(await plans.proposalContext('00000000-0000-4000-8000-000000000000', REALM, null)).toEqual({ kind: 'TRANSACTION_NOT_FOUND' });
      const { unit: pr, membership } = await member();
      const inflow = await transaction({ direction: 'INFLOW' });
      expect(await plans.proposalContext(inflow, REALM, await unit(OTHER_REALM))).toEqual({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' });
      expect(await plans.proposalContext(inflow, REALM, pr)).toMatchObject({ kind: 'NOT_PROPOSABLE', direction: 'INFLOW' });
      const tx = await transaction({ bookingDate: '2026-02-02' });
      expect(await plans.proposalContext(tx, REALM, null)).toEqual({ kind: 'NO_UNIT' });
      expect(await plans.proposalContext(tx, REALM, await unit())).toMatchObject({ kind: 'NO_MEMBERSHIP' });
      expect(await plans.proposalContext(tx, REALM, pr)).toEqual({ kind: 'NO_ECONOMIC_PLAN', membershipId: membership.id, bookingDate: '2026-02-02' });
      const p = await plan(membership.id);
      const later = await transaction({ propertyReferenceId: pr });
      expect(await plans.proposalContext(later, REALM, null)).toMatchObject({
        kind: 'FOUND',
        propertyReferenceId: pr,
        membershipId: membership.id,
        plan: { id: p.id },
        financialYearStartMonth: 1,
        alreadySplit: false,
      });
      await splits.replaceSplits(later, REALM, [split('360.00', 'WEG_NON_RECOVERABLE', pr)], actor);
      expect(await plans.proposalContext(later, REALM, null)).toMatchObject({ kind: 'FOUND', alreadySplit: true });
    });
  });

  describe('schema past the repository', () => {
    const categoryId = async (code: string) => (await pool.query(`SELECT id FROM financial_category WHERE code = $1`, [code])).rows[0].id as string;
    const insertSplit = async (client: pg.Pool | pg.PoolClient, transactionId: string, code: string, unitId: string | null) =>
      client
        .query(
          `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, created_by)
           VALUES ($1, $2, 1, 360, 'EUR', $3, $4, 'x')`,
          [transactionId, REALM, await categoryId(code), unitId],
        )
        .then(() => 'accepted', reasonOf);

    it('transaction_split_weg: no unit, no membership; a reversal is exempt', async () => {
      const { unit: pr } = await member({ validFrom: '2026-04-01' });
      expect(await insertSplit(pool, await transaction(), 'WEG_RESERVE_CONTRIBUTION', null)).toBe('(NO_WEG_MEMBERSHIP)');
      expect(await insertSplit(pool, await transaction(), 'WEG_RESERVE_CONTRIBUTION', pr)).toBe('(NO_WEG_MEMBERSHIP)');
      expect(await insertSplit(pool, await transaction({ bookingDate: '2026-04-01' }), 'WEG_RESERVE_CONTRIBUTION', pr)).toBe('accepted');
      expect(await insertSplit(pool, await transaction(), 'OTHER_EXPENSE', null)).toBe('accepted');
    });

    it('ledger_transaction_weg_booking_date: a raw date change past the membership is refused; other splits do not matter', async () => {
      const { unit: pr } = await member({ validFrom: '2026-03-01' });
      const tx = await transaction({ bookingDate: '2026-03-02' });
      await splits.replaceSplits(tx, REALM, [split('360.00', 'WEG_NON_RECOVERABLE', pr)], actor);
      const move = (id: string, date: string) =>
        pool.query(`UPDATE ledger_transaction SET booking_date = $2, version = version + 1 WHERE id = $1`, [id, date]).then(() => 'accepted', reasonOf);
      expect(await move(tx, '2026-02-28')).toBe('(NO_WEG_MEMBERSHIP)');
      expect(await move(tx, '2027-05-01')).toBe('accepted');
      const plain = await transaction({ bookingDate: '2026-03-02' });
      await splits.replaceSplits(plain, REALM, [split('360.00', 'OTHER_EXPENSE')], actor);
      expect(await move(plain, '2020-01-01')).toBe('accepted');
    });

    it('weg_membership_guard, weg_economic_plan_membership, plan frozen, source references, WEG_HAS_YEARS', async () => {
      const { wegId, unit: pr, membership } = await member();
      expect(await insertSplit(pool, await transaction({ bookingDate: '2026-10-01' }), 'WEG_NON_RECOVERABLE', pr)).toBe('accepted');
      const update = (table: string, set: string, id: string) => pool.query(`UPDATE ${table} SET ${set} WHERE id = $1`, [id]).then(() => 'accepted', reasonOf);
      expect(await update('weg_membership', `valid_until = '2026-09-30', version = version + 1`, membership.id)).toBe('(MEMBERSHIP_HAS_SPLITS)');
      expect(await update('weg_membership', `source_references = ARRAY[''], version = version + 1`, membership.id)).toBe(
        'weg_membership_source_references_length',
      );
      const insertPlan = (membershipId: string, effectiveFrom: string, financialYear = 2026) =>
        pool
          .query(
            `INSERT INTO weg_economic_plan (mre_realm_id, membership_id, financial_year, effective_from, monthly_hausgeld, monthly_reserve_contribution,
               recoverable_costs, non_recoverable_costs, currency, status, created_by)
             VALUES ($1, $2, $3, $4, 300, 60, 0, 0, 'EUR', 'ACTIVE', 'x') RETURNING id`,
            [REALM, membershipId, financialYear, effectiveFrom],
          )
          .then((r) => r.rows[0].id as string, reasonOf);
      expect(await insertPlan(membership.id, '2025-12-31', 2025)).toBe('(PLAN_OUTSIDE_MEMBERSHIP)');
      expect(await insertPlan(membership.id, '2027-01-01', 2026)).toBe('(EFFECTIVE_FROM_OUTSIDE_YEAR)');
      const planId = await insertPlan(membership.id, '2026-11-01');
      expect(await update('weg_economic_plan', `monthly_hausgeld = 1, version = version + 1`, planId)).toBe('only ACTIVE → VOID');
      expect(await update('weg_economic_plan', `version = version`, planId)).toBe('accepted');
      expect(await update('weg', `financial_year_start_month = 7, version = version + 1`, wegId)).toBe('(WEG_HAS_YEARS)');
      expect(await update('weg_membership', `valid_until = '2026-10-31', version = version + 1`, membership.id)).toBe('(MEMBERSHIP_HAS_PLANS)');
      expect(await update('weg_economic_plan', `status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1`, planId)).toBe(
        'accepted',
      );
      expect(await update('weg_economic_plan', `notes = 'n', version = version + 1`, planId)).toBe('VOID is final');
      expect(await pool.query(`DELETE FROM weg_economic_plan WHERE id = $1`, [planId]).then(() => 'accepted', reasonOf)).not.toBe('accepted');
      const voided = await member();
      await wegs.voidMembership(voided.membership.id, REALM, 'x', new Date(), actor);
      expect(await insertPlan(voided.membership.id, '2026-03-01')).toBe('(MEMBERSHIP_NOT_ACTIVE)');
    });

    it('down restores the category type and drops the plan table and the guards', async () => {
      const downSchema = testSchemaName('weg_plan_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        // Dropping a table while another worker's Migrator introspects the database breaks it: hold the migration lock.
        await withMigrationLock(async () => (await import('./migrations/0041_weg_plan_and_splits.js')).down(createDatabase(downPool) as never));
        expect((await downPool.query(`SELECT category_type FROM financial_category WHERE code = 'WEG_RESERVE_CONTRIBUTION'`)).rows[0].category_type).toBe(
          'OPERATING_EXPENSE',
        );
        expect((await downPool.query(`SELECT to_regclass('weg_economic_plan') AS t`)).rows[0].t).toBeNull();
        const { rows } = await downPool.query(
          `SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND t.tgname IN ('transaction_split_weg', 'weg_membership_guard', 'weg_financial_year_held')`,
          [downSchema],
        );
        expect(rows).toEqual([]);
      } finally {
        await downPool.end();
      }
    });
  });

  describe('concurrency on the unit', () => {
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
    const categoryId = async (code: string) => (await pool.query(`SELECT id FROM financial_category WHERE code = $1`, [code])).rows[0].id as string;

    it('RC, raw SQL (review on #146): an end waiting on a split in flight sees it and is refused', async () => {
      const { unit: pr, membership } = await member();
      const tx = await transaction({ bookingDate: '2026-09-01' });
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, created_by)
           VALUES ($1, $2, 1, 360, 'EUR', $3, $4, 'x')`,
          [tx, REALM, await categoryId('WEG_NON_RECOVERABLE'), pr],
        );
        const ending = pool
          .query(`UPDATE weg_membership SET valid_until = '2026-06-30', version = version + 1 WHERE id = $1`, [membership.id])
          .then(() => 'ended', reasonOf);
        await waitForLock('UPDATE weg_membership');
        await holder.query('COMMIT');
        expect(await ending).toBe('(MEMBERSHIP_HAS_SPLITS)');
      } finally {
        holder.release();
      }
    });

    it('RC, raw SQL: an end waiting on a plan insert in flight sees it and is refused', async () => {
      const { membership } = await member();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `INSERT INTO weg_economic_plan (mre_realm_id, membership_id, financial_year, effective_from, monthly_hausgeld, monthly_reserve_contribution,
             recoverable_costs, non_recoverable_costs, currency, status, created_by)
           VALUES ($1, $2, 2026, '2026-09-01', 300, 60, 0, 0, 'EUR', 'ACTIVE', 'x')`,
          [REALM, membership.id],
        );
        const ending = pool
          .query(`UPDATE weg_membership SET valid_until = '2026-06-30', version = version + 1 WHERE id = $1`, [membership.id])
          .then(() => 'ended', reasonOf);
        await waitForLock('UPDATE weg_membership');
        await holder.query('COMMIT');
        expect(await ending).toBe('(MEMBERSHIP_HAS_PLANS)');
      } finally {
        holder.release();
      }
    });

    it('RC: a split write waiting on a void of the membership sees VOID and is refused', async () => {
      const { unit: pr, membership } = await member();
      const tx = await transaction();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `UPDATE weg_membership SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1 WHERE id = $1`,
          [membership.id],
        );
        const writing = splits.replaceSplits(tx, REALM, [split('360.00', 'WEG_NON_RECOVERABLE', pr)], actor);
        await waitForLock('"property_reference"');
        await holder.query('COMMIT');
        expect(await writing).toMatchObject({ kind: 'NO_WEG_MEMBERSHIP', reason: 'NO_MEMBERSHIP' });
      } finally {
        holder.release();
      }
    });

    it('RR: a split write and an end of the membership; the later one fails to serialise', async () => {
      const { unit: pr, membership } = await member();
      const tx = await transaction({ bookingDate: '2026-09-01' });
      const [first, second] = [await pool.connect(), await pool.connect()];
      try {
        await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await first.query('SELECT count(*) FROM transaction_split');
        await second.query('SELECT count(*) FROM weg_membership');
        await first.query(
          `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, created_by)
           VALUES ($1, $2, 1, 360, 'EUR', $3, $4, 'x')`,
          [tx, REALM, await categoryId('WEG_NON_RECOVERABLE'), pr],
        );
        const late = second.query(`UPDATE weg_membership SET valid_until = '2026-06-30', version = version + 1 WHERE id = $1`, [membership.id]).then(
          () => 'ended',
          (error: { code?: string }) => error.code,
        );
        await waitForLock('UPDATE weg_membership');
        await first.query('COMMIT');
        expect(await late).toBe('40001');
        await second.query('ROLLBACK');
      } finally {
        first.release();
        second.release();
      }
    });

    it('RC (review on #147): a plan create waiting on an amend of the start month reads the new one and is refused', async () => {
      const { wegId, membership } = await member();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE weg SET financial_year_start_month = 7, version = version + 1 WHERE id = $1`, [wegId]);
        const creating = plans.createPlan(newPlan(membership.id), actor);
        await waitForLock('"weg"');
        await holder.query('COMMIT');
        expect(await creating).toEqual({ kind: 'EFFECTIVE_FROM_OUTSIDE_YEAR', from: '2026-07-01', until: '2027-06-30' });
      } finally {
        holder.release();
      }
    });

    it('RC, raw SQL: an amend of the start month waiting on a plan insert sees it and is refused (WEG_HAS_YEARS)', async () => {
      const { wegId, membership } = await member();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `INSERT INTO weg_economic_plan (mre_realm_id, membership_id, financial_year, effective_from, monthly_hausgeld, monthly_reserve_contribution,
             recoverable_costs, non_recoverable_costs, currency, status, created_by)
           VALUES ($1, $2, 2026, '2026-03-01', 300, 60, 0, 0, 'EUR', 'ACTIVE', 'x')`,
          [REALM, membership.id],
        );
        const amending = pool
          .query(`UPDATE weg SET financial_year_start_month = 7, version = version + 1 WHERE id = $1`, [wegId])
          .then(() => 'amended', reasonOf);
        await waitForLock('UPDATE weg SET financial_year_start_month');
        await holder.query('COMMIT');
        expect(await amending).toBe('(WEG_HAS_YEARS)');
      } finally {
        holder.release();
      }
    });

    it('RR: a plan insert and an amend of the start month; the later one fails to serialise', async () => {
      const { wegId, membership } = await member();
      const [first, second] = [await pool.connect(), await pool.connect()];
      try {
        await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await first.query('SELECT count(*) FROM weg_economic_plan');
        await second.query('SELECT count(*) FROM weg');
        await first.query(
          `INSERT INTO weg_economic_plan (mre_realm_id, membership_id, financial_year, effective_from, monthly_hausgeld, monthly_reserve_contribution,
             recoverable_costs, non_recoverable_costs, currency, status, created_by)
           VALUES ($1, $2, 2026, '2026-03-01', 300, 60, 0, 0, 'EUR', 'ACTIVE', 'x')`,
          [REALM, membership.id],
        );
        const late = second.query(`UPDATE weg SET financial_year_start_month = 7, version = version + 1 WHERE id = $1`, [wegId]).then(
          () => 'amended',
          (error: { code?: string }) => error.code,
        );
        await waitForLock('UPDATE weg SET financial_year_start_month');
        await first.query('COMMIT');
        expect(await late).toBe('40001');
        await second.query('ROLLBACK');
      } finally {
        first.release();
        second.release();
      }
    });

    it('plan create against plan create with the same day: the loser answers PLAN_EXISTS', async () => {
      const { membership } = await member();
      const outcomes = await Promise.all([plans.createPlan(newPlan(membership.id), actor), plans.createPlan(newPlan(membership.id), actor)]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(['CREATED', 'PLAN_EXISTS']);
    });
  });
});
