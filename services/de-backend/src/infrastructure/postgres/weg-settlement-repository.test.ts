import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Direction, SplitInput } from '../../domains/ledger/index.js';
import { deriveComparison, parseMea, type Mea, type NewAnnualStatement } from '../../domains/weg/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresUnconfirmedTransactionRepository } from './unconfirmed-transaction-repository.js';
import { PostgresWegAnnualStatementRepository } from './weg-annual-statement-repository.js';
import { PostgresWegRepository } from './weg-repository.js';

/**
 * VC-6-04 persistence (api-design.md §51): `wegAnnualStatementId` on splits with its rules and its exemption from the
 * booking-date membership, corrections of a settlement, the comparison's snapshot (what counts, the chain of superseded
 * statements), the proposal's order of checks, the schema past the repository, the serialisation on the statement row
 * under RC and RR, and `down`. Figures are invented.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000082';
const OTHER_REALM = '64b0c0ffee00000000000083';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const mea = (text: string): Mea => {
  const parsed = parseMea(text);
  if (!('mea' in parsed)) throw new Error(text);
  return parsed.mea;
};
const split = (amount: string, financialCategoryCode: string, propertyReferenceId: string | null, wegAnnualStatementId: string | null = null): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId,
  loanId: null,
  securityDepositId: null,
  wegAnnualStatementId,
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
  return error.constraint ?? /\(([A-Z_]+)\)|does not mirror/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error';
}

describe.skipIf(databaseUrl === undefined)('Ledger effects of a statement (§51)', () => {
  const schema = testSchemaName('weg_settlement_test');
  let pool: pg.Pool;
  let wegs: PostgresWegRepository;
  let statements: PostgresWegAnnualStatementRepository;
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
    statements = new PostgresWegAnnualStatementRepository(db);
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
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f90000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function member(options: { validUntil?: string } = {}) {
    const weg = await wegs.createWeg(
      { mreRealmId: REALM, displayName: `WEG ${++counter}`, administratorPartyId: null, financialYearStartMonth: 1, notes: null },
      actor,
    );
    if (weg.kind !== 'CREATED') throw new Error(weg.kind);
    const pr = await unit();
    const m = await wegs.createMembership(
      {
        mreRealmId: REALM,
        wegId: weg.weg.id,
        propertyReferenceId: pr,
        mea: mea('250/10000'),
        validFrom: day('2025-01-01'),
        validUntil: options.validUntil === undefined ? null : day(options.validUntil),
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (m.kind !== 'CREATED') throw new Error(m.kind);
    return { unit: pr, membership: m.membership };
  }
  /** Costs 1,500 (1,000 recoverable, 500 not), Hausgeld 1,800 and reserve 600 requested: a credit of 300. */
  const newStatement = (membershipId: string, overrides: Partial<NewAnnualStatement> = {}): NewAnnualStatement => ({
    mreRealmId: REALM,
    membershipId,
    financialYear: 2025,
    periodFrom: day('2025-01-01'),
    periodUntil: day('2025-12-31'),
    documentDate: null,
    resolutionDate: null,
    dueDate: null,
    supersedes: null,
    costLines: [
      {
        position: 1,
        account: 'Hausmeister',
        group: 'RECOVERABLE',
        allocationKey: 'MEA',
        allocationTotal: null,
        allocationShare: null,
        totalAmount: eur('40000.00'),
        unitShare: eur('1000.00'),
        classification: null,
      },
      {
        position: 2,
        account: 'Verwaltung',
        group: 'NON_RECOVERABLE',
        allocationKey: 'Einheit',
        allocationTotal: null,
        allocationShare: null,
        totalAmount: eur('10000.00'),
        unitShare: eur('500.00'),
        classification: null,
      },
    ],
    recoverableSubtotal: eur('1000.00'),
    nonRecoverableSubtotal: eur('500.00'),
    totalCosts: eur('1500.00'),
    hausgeldRequested: eur('1800.00'),
    hausgeldPaid: eur('1800.00'),
    reserveRequested: eur('600.00'),
    reservePaid: eur('600.00'),
    settlementPeak: eur('-300.00'),
    settlementResult: null,
    reserve: null,
    sourceReferences: [],
    notes: null,
    ...overrides,
  });
  async function statement(membershipId: string, confirm = true, overrides: Partial<NewAnnualStatement> = {}) {
    const created = await statements.createStatement(newStatement(membershipId, overrides), actor);
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    if (!confirm) return created.statement;
    const confirmed = await statements.confirmStatement(created.statement.id, REALM, new Date(), actor);
    if (confirmed.kind !== 'CONFIRMED') throw new Error(confirmed.kind);
    return confirmed.statement;
  }
  async function transaction(options: { direction?: Direction; amount?: string; bookingDate?: string } = {}) {
    const account = await accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: account.account.id,
        amount: eur(options.amount ?? '300.00'),
        direction: options.direction ?? 'INFLOW',
        bookingDate: day(options.bookingDate ?? '2026-05-02'),
        valueDate: null,
        description: 'Abrechnung',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  /** A confirmed Transaction with the given splits. */
  async function booked(options: { direction?: Direction; amount: string; bookingDate: string }, set: SplitInput[]) {
    const tx = await transaction(options);
    const outcome = await splits.replaceSplits(tx, REALM, set, actor);
    if (outcome.kind !== 'REPLACED') throw new Error(JSON.stringify(outcome));
    expect((await transactions.confirm(tx, REALM, actor)).kind).toBe('CONFIRMED');
    return tx;
  }
  /** Twelve months of the plan's debits: Hausgeld 150 (100 recoverable, 50 not), reserve 50. */
  async function year(pr: string) {
    for (let month = 1; month <= 12; month += 1) {
      await booked({ direction: 'OUTFLOW', amount: '200.00', bookingDate: `2025-${String(month).padStart(2, '0')}-02` }, [
        split('100.00', 'WEG_RECOVERABLE', pr),
        split('50.00', 'WEG_NON_RECOVERABLE', pr),
        split('50.00', 'WEG_RESERVE_CONTRIBUTION', pr),
      ]);
    }
  }

  describe('wegAnnualStatementId on a split', () => {
    it('a refund naming the statement in force; the order of checks; Realm-scoped; the split carries it', async () => {
      const { unit: pr, membership } = await member();
      const st = await statement(membership.id);
      const tx = await transaction();
      const replace = (set: SplitInput[]) => splits.replaceSplits(tx, REALM, set, actor);
      const unknown = '00000000-0000-4000-8000-000000000000';
      expect(await replace([split('300.00', 'WEG_NON_RECOVERABLE', pr, unknown)])).toEqual({ kind: 'WEG_STATEMENT_NOT_FOUND', wegAnnualStatementId: unknown });
      expect(await replace([split('300.00', 'OTHER_INCOME', pr, st.id)])).toEqual({ kind: 'INVALID_WEG_STATEMENT_SPLIT', position: 1, reason: 'CATEGORY' });
      expect(await replace([split('300.00', 'WEG_NON_RECOVERABLE', null, st.id)])).toMatchObject({ kind: 'NO_WEG_MEMBERSHIP', reason: 'NO_UNIT' });
      const other = await member();
      expect(await replace([split('300.00', 'WEG_NON_RECOVERABLE', other.unit, st.id)])).toEqual({
        kind: 'INVALID_WEG_STATEMENT_SPLIT',
        position: 1,
        reason: 'UNIT',
      });
      const draft = await statement(membership.id, false, { financialYear: 2026, periodFrom: day('2026-01-01'), periodUntil: day('2026-12-31') });
      expect(await replace([split('300.00', 'WEG_NON_RECOVERABLE', pr, draft.id)])).toEqual({
        kind: 'STATEMENT_NOT_CURRENT',
        wegAnnualStatementId: draft.id,
        status: 'DRAFT',
        supersededBy: null,
      });
      const done = await replace([split('200.00', 'WEG_RECOVERABLE', pr, st.id), split('100.00', 'WEG_NON_RECOVERABLE', pr, st.id)]);
      expect(done).toMatchObject({ kind: 'REPLACED', changed: true });
      if (done.kind === 'REPLACED') expect(done.splits.map((s) => s.wegAnnualStatementId)).toEqual([st.id, st.id]);
      expect(await replace([split('200.00', 'WEG_RECOVERABLE', pr, st.id), split('100.00', 'WEG_NON_RECOVERABLE', pr, st.id)])).toMatchObject({
        changed: false,
      });
      // Another Realm's Transaction cannot reach the statement.
      expect((await splits.replaceSplits(tx, OTHER_REALM, [split('300.00', 'WEG_NON_RECOVERABLE', pr, st.id)], actor)).kind).toBe('NOT_FOUND');
    });

    it('a settlement after the membership ended is checked against the statement, not the booking date', async () => {
      const { unit: pr, membership } = await member({ validUntil: '2025-12-31' });
      const st = await statement(membership.id);
      // A plain WEG split in 2026 has no membership; the settlement of 2025 has one through its statement.
      const plain = await transaction();
      expect(await splits.replaceSplits(plain, REALM, [split('300.00', 'WEG_NON_RECOVERABLE', pr)], actor)).toMatchObject({ reason: 'NO_MEMBERSHIP' });
      const refund = await transaction();
      expect((await splits.replaceSplits(refund, REALM, [split('300.00', 'WEG_NON_RECOVERABLE', pr, st.id)], actor)).kind).toBe('REPLACED');
      // An amend of its date is free of the membership too (repository and ledger_transaction_weg_booking_date).
      expect((await unconfirmed.amend(refund, REALM, { bookingDate: day('2027-01-04') }, actor)).kind).toBe('AMENDED');
      expect((await transactions.confirm(refund, REALM, actor)).kind).toBe('CONFIRMED');
    });

    it('a settlement booked after the sale does not hold the membership; its statement does (review on #152)', async () => {
      // Through the repository: the refund of 2026-08-03 does not refuse a sale on 2026-06-30.
      const { unit: pr, membership } = await member();
      const st = await statement(membership.id);
      await booked({ amount: '300.00', bookingDate: '2026-08-03' }, [split('300.00', 'WEG_NON_RECOVERABLE', pr, st.id)]);
      expect((await wegs.endMembership(membership.id, REALM, day('2026-06-30'), actor)).kind).toBe('ENDED');
      // The statement itself still holds its period.
      expect(await wegs.endMembership(membership.id, REALM, day('2025-06-30'), actor)).toEqual({ kind: 'MEMBERSHIP_HAS_STATEMENTS', statementIds: [st.id] });
      // A plain WEG split after the new end still holds it.
      const other = await member();
      const plain = await booked({ direction: 'OUTFLOW', amount: '10.00', bookingDate: '2026-07-01' }, [split('10.00', 'WEG_RECOVERABLE', other.unit)]);
      expect(await wegs.endMembership(other.membership.id, REALM, day('2026-06-30'), actor)).toEqual({
        kind: 'MEMBERSHIP_HAS_SPLITS',
        transactionIds: [plain],
      });
      // Past the repository, the guard of 0041 as replaced by 0043: the settlement alone does not refuse the end.
      const sold = await member();
      const sale = await statement(sold.membership.id);
      await booked({ amount: '300.00', bookingDate: '2026-08-03' }, [split('300.00', 'WEG_NON_RECOVERABLE', sold.unit, sale.id)]);
      expect(
        await pool
          .query(`UPDATE weg_membership SET valid_until = '2026-06-30', version = version + 1 WHERE id = $1`, [sold.membership.id])
          .then(() => 'accepted', reasonOf),
      ).toBe('accepted');
    });

    it('corrections: the reversal mirrors a superseded statement; a copied replacement must name the current one', async () => {
      const { unit: pr, membership } = await member();
      const old = await statement(membership.id);
      const refund = await booked({ amount: '300.00', bookingDate: '2026-05-02' }, [split('300.00', 'WEG_NON_RECOVERABLE', pr, old.id)]);
      const successor = await statement(membership.id, false, { supersedes: old.id, settlementPeak: eur('-300.00'), notes: 'Korrektur' });
      expect((await statements.confirmStatement(successor.id, REALM, new Date(), actor)).kind).toBe('CONFIRMED');
      // A new settlement against the old one is refused, naming its successor.
      expect(await splits.replaceSplits(await transaction(), REALM, [split('300.00', 'WEG_NON_RECOVERABLE', pr, old.id)], actor)).toEqual({
        kind: 'STATEMENT_NOT_CURRENT',
        wegAnnualStatementId: old.id,
        status: 'SUPERSEDED',
        supersededBy: successor.id,
      });
      expect(await corrections.correct(refund, REALM, { reason: 'Datum', replacement: { bookingDate: day('2026-05-03') } }, actor)).toMatchObject({
        kind: 'STATEMENT_NOT_CURRENT',
        supersededBy: successor.id,
      });
      const fixed = await corrections.correct(
        refund,
        REALM,
        { reason: 'Neue Abrechnung', replacement: { splits: [split('300.00', 'WEG_NON_RECOVERABLE', pr, successor.id)] } },
        actor,
      );
      expect(fixed.kind).toBe('CORRECTED');
      if (fixed.kind !== 'CORRECTED' || fixed.result.replacement === null) return;
      const { rows } = await pool.query(
        `SELECT t.correction_role, s.weg_annual_statement_id FROM transaction_split s JOIN ledger_transaction t ON t.id = s.transaction_id
          WHERE t.id IN ($1, $2) ORDER BY t.correction_role`,
        [fixed.result.reversal.id, fixed.result.replacement.id],
      );
      expect(rows).toEqual([
        { correction_role: 'REPLACEMENT', weg_annual_statement_id: successor.id },
        { correction_role: 'REVERSAL', weg_annual_statement_id: old.id },
      ]);
    });
  });

  describe('the comparison snapshot', () => {
    it('counts the current WEG splits of the unit in the period; settlements of the chain apart; the identity holds', async () => {
      const { unit: pr, membership } = await member();
      await year(pr);
      // Not counted: another unit, a split outside the period, an unconfirmed one, a corrected one (its reversal and
      // replacement count as one current split).
      const other = await member();
      await booked({ direction: 'OUTFLOW', amount: '999.00', bookingDate: '2025-06-02' }, [split('999.00', 'WEG_RECOVERABLE', other.unit)]);
      await booked({ direction: 'OUTFLOW', amount: '50.00', bookingDate: '2026-01-02' }, [split('50.00', 'WEG_RECOVERABLE', pr)]);
      const open = await transaction({ direction: 'OUTFLOW', amount: '10.00', bookingDate: '2025-07-01' });
      await splits.replaceSplits(open, REALM, [split('10.00', 'WEG_NON_RECOVERABLE', pr)], actor);
      const doubled = await booked({ direction: 'OUTFLOW', amount: '20.00', bookingDate: '2025-08-01' }, [split('20.00', 'WEG_RECOVERABLE', pr)]);
      expect((await corrections.correct(doubled, REALM, { reason: 'doppelt', replacement: null }, actor)).kind).toBe('CORRECTED');
      const old = await statement(membership.id);
      // A settlement booked inside the period is still no advance.
      const first = await booked({ amount: '100.00', bookingDate: '2025-12-20' }, [split('100.00', 'WEG_NON_RECOVERABLE', pr, old.id)]);
      const successor = await statement(membership.id, false, { supersedes: old.id });
      await statements.confirmStatement(successor.id, REALM, new Date(), actor);
      const second = await booked({ amount: '200.00', bookingDate: '2026-06-02' }, [split('200.00', 'WEG_RECOVERABLE', pr, successor.id)]);
      // An unconfirmed settlement is not settled yet.
      const pending = await transaction({ amount: '5.00', bookingDate: '2026-07-01' });
      await splits.replaceSplits(pending, REALM, [split('5.00', 'WEG_RECOVERABLE', pr, successor.id)], actor);

      const context = await statements.comparisonContext(successor.id, REALM);
      if (context.kind !== 'FOUND') throw new Error(context.kind);
      expect(context.propertyReferenceId).toBe(pr);
      expect(context.advances).toHaveLength(36);
      expect(context.uncountedTransactionIds).toEqual([open]);
      const comparison = deriveComparison(context);
      expect(comparison.classes.RECOVERABLE).toEqual({ paid: eur('1200.00'), actual: eur('1000.00'), difference: eur('-200.00') });
      expect(comparison.classes.RESERVE).toEqual({ paid: eur('600.00'), actual: eur('600.00'), difference: eur('0.00') });
      expect(comparison.advances.unpaidAdvances).toEqual(eur('0.00'));
      expect(comparison.settlement).toMatchObject({ settled: eur('-300.00'), open: eur('0.00') });
      expect(comparison.settlement.settledBy.map((s) => [s.transactionId, s.statementId])).toEqual([
        [first, old.id],
        [second, successor.id],
      ]);
      expect(comparison.flags.map((f) => f.code)).toEqual(['UNCOUNTED_WEG_SPLITS', 'SETTLED_AGAINST_SUPERSEDED']);
      // The superseded one shows its own settlement only, and that it is superseded.
      const before = await statements.comparisonContext(old.id, REALM);
      if (before.kind !== 'FOUND') throw new Error(before.kind);
      expect(before.settlements.map((s) => s.transactionId)).toEqual([first]);
      expect(deriveComparison(before).flags.map((f) => f.code)).toContain('SUPERSEDED');
    });

    it('a DRAFT or VOID statement is not compared; unknown or foreign is not found', async () => {
      const { membership } = await member();
      const draft = await statement(membership.id, false);
      expect(await statements.comparisonContext(draft.id, REALM)).toEqual({ kind: 'STATEMENT_NOT_CONFIRMED', status: 'DRAFT' });
      const done = await statement(membership.id);
      expect(await statements.comparisonContext(done.id, OTHER_REALM)).toEqual({ kind: 'NOT_FOUND' });
      expect(await statements.comparisonContext('x', REALM)).toEqual({ kind: 'NOT_FOUND' });
    });

    it('the proposal snapshot in its order of checks', async () => {
      const { unit: pr, membership } = await member();
      const st = await statement(membership.id);
      const draft = await statement(membership.id, false, { financialYear: 2026, periodFrom: day('2026-01-01'), periodUntil: day('2026-12-31') });
      const tx = await transaction();
      const unknown = '00000000-0000-4000-8000-000000000000';
      expect(await statements.settlementContext(unknown, st.id, REALM)).toEqual({ kind: 'TRANSACTION_NOT_FOUND' });
      expect(await statements.settlementContext(tx, unknown, REALM)).toEqual({ kind: 'STATEMENT_NOT_FOUND' });
      expect(await statements.settlementContext(tx, draft.id, REALM)).toEqual({ kind: 'STATEMENT_NOT_CURRENT', status: 'DRAFT', supersededBy: null });
      const found = await statements.settlementContext(tx, st.id, REALM);
      expect(found).toMatchObject({ kind: 'FOUND', transactionId: tx, amount: eur('300.00'), direction: 'INFLOW', alreadySplit: false });
      await splits.replaceSplits(tx, REALM, [split('300.00', 'WEG_NON_RECOVERABLE', pr, st.id)], actor);
      expect(await statements.settlementContext(tx, st.id, REALM)).toMatchObject({ kind: 'FOUND', alreadySplit: true });
      await transactions.confirm(tx, REALM, actor);
      expect(await statements.settlementContext(tx, st.id, REALM)).toEqual({ kind: 'NOT_PROPOSABLE', status: 'CONFIRMED' });
    });
  });

  describe('schema past the repository', () => {
    const categoryId = async (code: string) => (await pool.query(`SELECT id FROM financial_category WHERE code = $1`, [code])).rows[0].id as string;
    const insertSplit = async (client: pg.Pool | pg.PoolClient, transactionId: string, code: string, unitId: string | null, statementId: string) =>
      client
        .query(
          `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id,
             weg_annual_statement_id, created_by)
           VALUES ($1, $2, 1, 300, 'EUR', $3, $4, $5, 'x')`,
          [transactionId, REALM, await categoryId(code), unitId, statementId],
        )
        .then(() => 'accepted', reasonOf);

    it('transaction_split_weg_statement and the CHECK: category, unit, current, alone; the date exemption', async () => {
      const { unit: pr, membership } = await member({ validUntil: '2025-12-31' });
      const st = await statement(membership.id);
      const draft = await statement(membership.id, false, { financialYear: 2025, notes: 'Entwurf' });
      expect(await insertSplit(pool, await transaction(), 'OTHER_INCOME', pr, st.id)).toBe('(INVALID_WEG_STATEMENT_SPLIT)');
      expect(await insertSplit(pool, await transaction(), 'WEG_NON_RECOVERABLE', (await member()).unit, st.id)).toBe('(INVALID_WEG_STATEMENT_SPLIT)');
      expect(await insertSplit(pool, await transaction(), 'WEG_NON_RECOVERABLE', pr, draft.id)).toBe('(STATEMENT_NOT_CURRENT)');
      expect(await insertSplit(pool, await transaction(), 'OTHER_INCOME', null, st.id)).toBe('transaction_split_weg_statement_alone');
      // After the membership ended: allowed with the statement (2026-05-02 is outside the membership).
      expect(await insertSplit(pool, await transaction(), 'WEG_NON_RECOVERABLE', pr, st.id)).toBe('accepted');
    });

    it('0014 mirror: a reversal dropping or changing the statement is refused at commit', async () => {
      const { unit: pr, membership } = await member();
      const st = await statement(membership.id);
      const other = await statement(membership.id, false, { financialYear: 2026, periodFrom: day('2026-01-01'), periodUntil: day('2026-12-31') });
      await statements.confirmStatement(other.id, REALM, new Date(), actor);
      const reverseWith = async (statementId: string | null) => {
        const original = await booked({ amount: '300.00', bookingDate: '2026-05-02' }, [split('300.00', 'WEG_NON_RECOVERABLE', pr, st.id)]);
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
            `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id,
               weg_annual_statement_id, created_by)
             SELECT $1, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, $3::uuid, 'x' FROM transaction_split
              WHERE transaction_id = $2`,
            [reversal, original, statementId],
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
      expect(await reverseWith(st.id)).toBe('accepted');
    });

    it('down drops the column and the trigger and restores 0041 and 0038 (under MIGRATION_ADVISORY_LOCK)', { timeout: 30_000 }, async () => {
      const downSchema = testSchemaName('weg_settlement_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        // 0044 builds on 0043's functions: it goes first.
        await withMigrationLock(async () => {
          await (await import('./migrations/0044_weg_special_assessment.js')).down(createDatabase(downPool) as never);
          await (await import('./migrations/0043_weg_statement_settlement.js')).down(createDatabase(downPool) as never);
        });
        const { rows: columns } = await downPool.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'transaction_split' AND column_name = 'weg_annual_statement_id'`,
          [downSchema],
        );
        expect(columns).toEqual([]);
        const source = async (name: string) =>
          (
            await downPool.query(`SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = $1 AND proname = $2`, [
              downSchema,
              name,
            ])
          ).rows[0]?.prosrc as string | undefined;
        expect(await source('transaction_split_weg_statement')).toBeUndefined();
        expect(await source('transaction_split_weg')).not.toContain('weg_annual_statement_id');
        expect(await source('ledger_transaction_weg_booking_date')).not.toContain('weg_annual_statement_id');
        expect(await source('weg_membership_guard')).not.toContain('weg_annual_statement_id');
        expect(await source('weg_membership_guard')).toContain('MEMBERSHIP_HAS_PLANS');
        expect(await source('ledger_transaction_reversal_mirror')).toContain('security_deposit_id');
        expect(await source('ledger_transaction_reversal_mirror')).not.toContain('weg_annual_statement_id');
      } finally {
        await downPool.end();
      }
    });
  });

  describe('concurrency on the statement row', () => {
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
    const supersede = async (client: pg.PoolClient, oldId: string, newId: string) => {
      await client.query(`UPDATE weg_annual_statement SET status = 'SUPERSEDED', superseded_by_id = $2, version = version + 1 WHERE id = $1`, [oldId, newId]);
      await client.query(
        `UPDATE weg_annual_statement SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', version = version + 1 WHERE id = $1`,
        [newId],
      );
    };

    it('RC: a settlement write waiting on the confirm that supersedes its statement sees SUPERSEDED', async () => {
      const { unit: pr, membership } = await member();
      const old = await statement(membership.id);
      const successor = await statement(membership.id, false, { supersedes: old.id });
      const tx = await transaction();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await supersede(holder, old.id, successor.id);
        const writing = splits.replaceSplits(tx, REALM, [split('300.00', 'WEG_NON_RECOVERABLE', pr, old.id)], actor);
        await waitForLock('"weg_annual_statement"');
        await holder.query('COMMIT');
        expect(await writing).toMatchObject({ kind: 'STATEMENT_NOT_CURRENT', status: 'SUPERSEDED', supersededBy: successor.id });
      } finally {
        holder.release();
      }
    });

    it('RR: a settlement insert and the supersede of its statement; the later one fails to serialise', async () => {
      const { unit: pr, membership } = await member();
      const old = await statement(membership.id);
      const successor = await statement(membership.id, false, { supersedes: old.id });
      const tx = await transaction();
      const category = (await pool.query(`SELECT id FROM financial_category WHERE code = 'WEG_NON_RECOVERABLE'`)).rows[0].id as string;
      const [first, second] = [await pool.connect(), await pool.connect()];
      try {
        await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await first.query('SELECT count(*) FROM transaction_split');
        await second.query('SELECT count(*) FROM weg_annual_statement');
        await first.query(
          `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id,
             weg_annual_statement_id, created_by) VALUES ($1, $2, 1, 300, 'EUR', $3, $4, $5, 'x')`,
          [tx, REALM, category, pr, old.id],
        );
        const late = supersede(second, old.id, successor.id).then(
          () => 'superseded',
          (error: { code?: string }) => error.code,
        );
        await waitForLock('UPDATE weg_annual_statement SET status');
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
