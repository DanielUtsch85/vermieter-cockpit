import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  correctionFingerprint,
  type BusinessDate,
  type CorrectionRequest,
  type CorrectionResult,
  type FinancialAccountId,
  type Transaction,
  type SplitInput,
} from '../../domains/ledger/index.js';
import { Money } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-1-11 persistence (api-design.md §35): the records a correction writes,
 * its checks, the net effect over a chain, idempotency and concurrency.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee0000000000000a';
const OTHER_REALM = '64b0c0ffee0000000000000b';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, financialCategoryCode: string, propertyReferenceId: string | null = null): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId,
  description: null,
});
const date = (value: string) => value as BusinessDate;

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe.skipIf(databaseUrl === undefined)('PostgresCorrectionRepository', () => {
  const schema = testSchemaName('correction_test');
  let pool: pg.Pool;
  let corrections: PostgresCorrectionRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let accounts: PostgresFinancialAccountRepository;
  let properties: PostgresPropertyReferenceRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    corrections = new PostgresCorrectionRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    properties = new PostgresPropertyReferenceRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function openAccount(mreRealmId = REALM): Promise<string> {
    const outcome = await accounts.create({ mreRealmId, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.account.id;
  }
  async function property(mrePropertyId: string, mreRealmId = REALM): Promise<string> {
    const linked = await properties.linkOnce(
      { mreRealmId, mrePropertyId, displayName: null, cachedAddress: null, cachedSurface: null, refreshedAt: new Date() },
      actor,
    );
    return linked.reference.id;
  }
  /** A confirmed rent payment of 1250.00: 1000.00 base rent + 250.00 operating-cost advance on `propertyId`. */
  async function confirmedRent(options: { accountId?: string; propertyId?: string | null; mreRealmId?: string } = {}): Promise<string> {
    const mreRealmId = options.mreRealmId ?? REALM;
    const created = await transactions.createManual(
      {
        mreRealmId,
        financialAccountId: options.accountId ?? (await openAccount(mreRealmId)),
        amount: eur('1250.00'),
        direction: 'INFLOW',
        bookingDate: date('2026-09-01'),
        valueDate: date('2026-09-02'),
        description: 'Miete September',
        propertyReferenceId: options.propertyId ?? null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const id = created.transaction.id;
    const replaced = await splits.replaceSplits(
      id,
      mreRealmId,
      [split('1000.00', 'RENT_BASE', options.propertyId ?? null), split('250.00', 'RENT_OPERATING_COST_ADVANCE', options.propertyId ?? null)],
      actor,
    );
    if (replaced.kind !== 'REPLACED') throw new Error(replaced.kind);
    const confirmed = await transactions.confirm(id, mreRealmId, actor);
    if (confirmed.kind !== 'CONFIRMED') throw new Error(confirmed.kind);
    return id;
  }
  /** A correction with a replacement (`correct`, not `reverse`): its replacement is always there. */
  async function correctOk(id: string, request: CorrectionRequest, mreRealmId = REALM): Promise<CorrectionResult & { replacement: Transaction }> {
    const outcome = await corrections.correct(id, mreRealmId, request, actor);
    if (outcome.kind !== 'CORRECTED' || outcome.result.replacement === null) throw new Error(JSON.stringify(outcome));
    return { ...outcome.result, replacement: outcome.result.replacement };
  }
  const splitRows = async (transactionId: string) =>
    (
      await pool.query(
        `SELECT s.position, s.amount::text AS amount, c.code, s.property_reference_id
         FROM transaction_split s JOIN financial_category c ON c.id = s.financial_category_id
         WHERE s.transaction_id = $1 ORDER BY s.position`,
        [transactionId],
      )
    ).rows;
  const audits = async (id: string) =>
    (await pool.query(`SELECT action, metadata, previous_version, new_version FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at`, [id]))
      .rows as { action: string; metadata: Record<string, unknown>; previous_version: number; new_version: number }[];

  it('writes a confirmed reversal and replacement and marks the original CORRECTED, in one step (§35.1, §35.3)', async () => {
    const reference = await property('64b0c0ffee00000000000c01');
    const id = await confirmedRent({ propertyId: reference });
    const before = (await pool.query(`SELECT * FROM ledger_transaction WHERE id = $1`, [id])).rows[0];

    const { original, reversal, replacement } = await correctOk(id, {
      reason: 'Falsches Buchungsdatum',
      replacement: { bookingDate: date('2026-09-03') },
    });

    expect(original).toMatchObject({
      id,
      status: 'CORRECTED',
      version: before.version + 1,
      provenance: 'MANUAL',
      bookingDate: '2026-09-01',
      confirmedBy: 'anna@example.com',
      correctionOfTransactionId: null,
      correctionRole: null,
      reversalTransactionId: reversal.id,
      replacementTransactionId: replacement.id,
    });
    // The original keeps everything but its status (and version).
    const after = (await pool.query(`SELECT * FROM ledger_transaction WHERE id = $1`, [id])).rows[0];
    expect({ ...after, status: before.status, version: before.version, updated_at: before.updated_at }).toEqual(before);

    expect(reversal).toMatchObject({
      financialAccountId: original.financialAccountId,
      direction: 'OUTFLOW',
      bookingDate: '2026-09-01',
      valueDate: '2026-09-02',
      description: 'Miete September',
      propertyReferenceId: reference,
      provenance: 'CORRECTION',
      status: 'CONFIRMED',
      confirmedBy: 'anna@example.com',
      correctionOfTransactionId: id,
      correctionRole: 'REVERSAL',
      reversalTransactionId: null,
      replacementTransactionId: null,
    });
    expect(reversal.amount.equals(original.amount)).toBe(true);
    expect(replacement).toMatchObject({
      financialAccountId: original.financialAccountId,
      direction: 'INFLOW',
      bookingDate: '2026-09-03',
      valueDate: '2026-09-02',
      description: 'Miete September',
      propertyReferenceId: reference,
      provenance: 'CORRECTION',
      status: 'CONFIRMED',
      correctionOfTransactionId: id,
      correctionRole: 'REPLACEMENT',
    });
    expect(reversal.confirmedAt).toBeInstanceOf(Date);

    // Mirrored and copied splits; the original's stay as they were.
    const originalSplits = await splitRows(id);
    expect(await splitRows(reversal.id)).toEqual(originalSplits);
    expect(await splitRows(replacement.id)).toEqual(originalSplits);
    expect(originalSplits.map((s) => s.amount)).toEqual(['1000.00', '250.00']);

    // No import identity on the new records.
    const identity = await pool.query(
      `SELECT import_batch_id, external_transaction_id, source_row_key, content_fingerprint FROM ledger_transaction WHERE id = ANY($1)`,
      [[reversal.id, replacement.id]],
    );
    expect(identity.rows.every((r) => Object.values(r).every((v) => v === null))).toBe(true);

    // One AuditRecord, on the original; none of their own for reversal and replacement (§35.4).
    const records = await audits(id);
    expect(records.map((r) => r.action)).toEqual(['CREATED', 'SPLITS_REPLACED', 'CONFIRMED', 'CORRECTED']);
    expect(records.at(-1)).toMatchObject({
      previous_version: before.version,
      new_version: before.version + 1,
      metadata: {
        reason: 'Falsches Buchungsdatum',
        previousStatus: 'CONFIRMED',
        reversalTransactionId: reversal.id,
        replacementTransactionId: replacement.id,
        changes: { bookingDate: { from: '2026-09-01', to: '2026-09-03' } },
      },
    });
    expect(await audits(reversal.id)).toEqual([]);
    expect(await audits(replacement.id)).toEqual([]);
  });

  it('a changed amount needs new splits that cover it exactly; requested splits replace the copied ones', async () => {
    const id = await confirmedRent();
    expect(await corrections.correct(id, REALM, { reason: 'Betrag', replacement: { amount: eur('1200.00') } }, actor)).toMatchObject({
      kind: 'SUM_MISMATCH',
      expected: eur('1200.00'),
      actual: eur('1250.00'),
    });
    expect(
      await corrections.correct(
        id,
        REALM,
        { reason: 'Betrag', replacement: { amount: eur('1200.00'), splits: [split('1000.00', 'RENT_BASE'), split('199.99', 'OTHER')] } },
        actor,
      ),
    ).toMatchObject({ kind: 'SUM_MISMATCH' });

    const { replacement } = await correctOk(id, {
      reason: 'Betrag',
      replacement: { amount: eur('1200.00'), splits: [split('1000.00', 'RENT_BASE'), split('200.00', 'RENT_OPERATING_COST_ADVANCE')] },
    });
    expect(replacement.amount.toJSON()).toEqual({ amount: '1200.00', currency: 'EUR' });
    expect((await splitRows(replacement.id)).map((s) => [s.amount, s.code])).toEqual([
      ['1000.00', 'RENT_BASE'],
      ['200.00', 'RENT_OPERATING_COST_ADVANCE'],
    ]);
  });

  it('a correction must change something; description or PropertyReference alone is enough (§35.2)', async () => {
    const id = await confirmedRent();
    expect(await corrections.correct(id, REALM, { reason: 'nichts', replacement: {} }, actor)).toEqual({ kind: 'NO_CHANGE' });
    expect(
      await corrections.correct(
        id,
        REALM,
        { reason: 'nichts', replacement: { bookingDate: date('2026-09-01'), description: 'Miete September', splits: [split('1000.00', 'RENT_BASE'), split('250.00', 'RENT_OPERATING_COST_ADVANCE')] } },
        actor,
      ),
    ).toEqual({ kind: 'NO_CHANGE' });

    const { replacement } = await correctOk(id, { reason: 'Tippfehler', replacement: { description: null } });
    expect(replacement.description).toBeNull();

    const other = await confirmedRent();
    const reference = await property('64b0c0ffee00000000000c02');
    expect((await correctOk(other, { reason: 'Objekt', replacement: { propertyReferenceId: reference } })).replacement.propertyReferenceId).toBe(reference);
  });

  it('the original’s closed account takes both records with any change; another closed account is refused (§35.2)', async () => {
    const accountId = await openAccount();
    const id = await confirmedRent({ accountId });
    await accounts.close(accountId as FinancialAccountId, REALM, new Date(), actor);
    const { reversal, replacement } = await correctOk(id, {
      reason: 'Betrag',
      replacement: { amount: eur('1000.00'), splits: [split('1000.00', 'RENT_BASE')] },
    });
    expect([reversal.financialAccountId, replacement.financialAccountId]).toEqual([accountId, accountId]);

    const closedElsewhere = await openAccount();
    await accounts.close(closedElsewhere as FinancialAccountId, REALM, new Date(), actor);
    const next = await confirmedRent();
    expect(await corrections.correct(next, REALM, { reason: 'Konto', replacement: { financialAccountId: closedElsewhere } }, actor)).toEqual({
      kind: 'ACCOUNT_CLOSED',
      financialAccountId: closedElsewhere,
    });
    const foreign = await openAccount(OTHER_REALM);
    expect(await corrections.correct(next, REALM, { reason: 'Konto', replacement: { financialAccountId: foreign } }, actor)).toEqual({
      kind: 'ACCOUNT_NOT_FOUND',
      financialAccountId: foreign,
    });
    const open = await openAccount();
    const moved = await correctOk(next, { reason: 'Konto', replacement: { financialAccountId: open } });
    expect(moved.replacement.financialAccountId).toBe(open);
    expect(moved.reversal.financialAccountId).toBe(moved.original.financialAccountId);
    expect(await pool.query(`SELECT 1 FROM ledger_transaction WHERE financial_account_id = $1`, [closedElsewhere])).toMatchObject({
      rowCount: 0,
    });
  });

  it('refuses what cannot be corrected, and names an existing correction', async () => {
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: await openAccount(),
        amount: eur('10.00'),
        direction: 'OUTFLOW',
        bookingDate: date('2026-09-01'),
        valueDate: null,
        description: null,
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const request = { reason: 'x', replacement: { bookingDate: date('2026-09-05') } };
    expect(await corrections.correct(created.transaction.id, REALM, request, actor)).toEqual({ kind: 'NOT_CORRECTABLE', status: 'UNREVIEWED' });

    const reconciled = await confirmedRent();
    await pool.query(`UPDATE ledger_transaction SET status = 'RECONCILED', version = version + 1 WHERE id = $1`, [reconciled]);
    expect(await corrections.correct(reconciled, REALM, request, actor)).toEqual({ kind: 'NOT_CORRECTABLE', status: 'RECONCILED' });

    const id = await confirmedRent();
    const first = await correctOk(id, request);
    expect(await corrections.correct(id, REALM, request, actor)).toEqual({
      kind: 'ALREADY_CORRECTED',
      reversalTransactionId: first.reversal.id,
      replacementTransactionId: first.replacement.id,
    });
    expect(await corrections.correct(first.reversal.id, REALM, request, actor)).toEqual({
      kind: 'NOT_CORRECTABLE',
      status: 'CONFIRMED',
      correctionRole: 'REVERSAL',
    });
    expect(await corrections.correct(id, OTHER_REALM, request, actor)).toEqual({ kind: 'NOT_FOUND' });
    expect(await corrections.correct('nope', REALM, request, actor)).toEqual({ kind: 'NOT_FOUND' });
  });

  it('checks categories and PropertyReferences of the replacement', async () => {
    const id = await confirmedRent();
    expect(
      await corrections.correct(id, REALM, { reason: 'x', replacement: { splits: [split('1250.00', 'NO_SUCH_CATEGORY')] } }, actor),
    ).toEqual({ kind: 'UNKNOWN_CATEGORY', codes: ['NO_SUCH_CATEGORY'] });
    const foreign = await property('64b0c0ffee00000000000c03', OTHER_REALM);
    expect(await corrections.correct(id, REALM, { reason: 'x', replacement: { propertyReferenceId: foreign } }, actor)).toEqual({
      kind: 'PROPERTY_REFERENCE_NOT_FOUND',
      propertyReferenceIds: [foreign],
    });
    expect(
      await corrections.correct(id, REALM, { reason: 'x', replacement: { splits: [split('1250.00', 'RENT_BASE', foreign)] } }, actor),
    ).toEqual({ kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceIds: [foreign] });

    // Copied splits whose category was deactivated since: send new splits (→ 422). The reversal would still mirror them.
    await pool.query(`UPDATE financial_category SET active = false WHERE code = 'RENT_OPERATING_COST_ADVANCE'`);
    try {
      expect(await corrections.correct(id, REALM, { reason: 'x', replacement: { bookingDate: date('2026-09-05') } }, actor)).toEqual({
        kind: 'INACTIVE_CATEGORY',
        codes: ['RENT_OPERATING_COST_ADVANCE'],
      });
      const { reversal } = await correctOk(id, { reason: 'x', replacement: { splits: [split('1250.00', 'RENT_BASE')] } });
      expect((await splitRows(reversal.id)).map((s) => s.code)).toEqual(['RENT_BASE', 'RENT_OPERATING_COST_ADVANCE']);
    } finally {
      await pool.query(`UPDATE financial_category SET active = true WHERE code = 'RENT_OPERATING_COST_ADVANCE'`);
    }
    // Nothing of the refused attempts was written.
    expect(Number((await pool.query(`SELECT count(*) FROM ledger_transaction WHERE correction_of_transaction_id = $1`, [id])).rows[0].count)).toBe(2);
  });

  it('net effect: over a chain T1 → T2 → T3 the signed sums equal those of the current Transactions alone (§35.3)', async () => {
    const accountId = await openAccount();
    const a = await property('64b0c0ffee00000000000c04');
    const b = await property('64b0c0ffee00000000000c05');
    const t1 = await confirmedRent({ accountId, propertyId: a });
    const { replacement: t2 } = await correctOk(t1, {
      reason: 'Objekt und Datum',
      replacement: { bookingDate: date('2026-10-01'), splits: [split('1000.00', 'RENT_BASE', b), split('250.00', 'RENT_OPERATING_COST_ADVANCE', b)] },
    });
    const { replacement: t3 } = await correctOk(t2.id, {
      reason: 'Betrag',
      replacement: { amount: eur('1100.00'), splits: [split('1000.00', 'RENT_BASE', b), split('100.00', 'OTHER', b)] },
    });

    const totals = async (where: string) =>
      (
        await pool.query(
          `SELECT to_char(t.booking_date, 'YYYY-MM') AS period, c.code, s.property_reference_id AS property,
                  sum(CASE t.direction WHEN 'INFLOW' THEN s.amount ELSE -s.amount END)::text AS total
           FROM ledger_transaction t
           JOIN transaction_split s ON s.transaction_id = t.id
           JOIN financial_category c ON c.id = s.financial_category_id
           WHERE t.financial_account_id = $1 AND ${where}
           GROUP BY 1, 2, 3 HAVING sum(CASE t.direction WHEN 'INFLOW' THEN s.amount ELSE -s.amount END) <> 0
           ORDER BY 1, 2, 3`,
          [accountId],
        )
      ).rows;
    const chain = await totals(`t.status IN ('CONFIRMED', 'RECONCILED', 'CORRECTED')`);
    const current = await totals(`t.status IN ('CONFIRMED', 'RECONCILED') AND t.correction_role IS DISTINCT FROM 'REVERSAL'`);
    expect(chain).toEqual(current);
    expect(current).toEqual([
      { period: '2026-10', code: 'OTHER', property: b, total: '100.00' },
      { period: '2026-10', code: 'RENT_BASE', property: b, total: '1000.00' },
    ]);
    // Only the last member of the chain is current.
    const statuses = await pool.query(`SELECT id, status FROM ledger_transaction WHERE id = ANY($1)`, [[t1, t2.id, t3.id]]);
    expect(Object.fromEntries(statuses.rows.map((r) => [r.id, r.status]))).toEqual({ [t1]: 'CORRECTED', [t2.id]: 'CORRECTED', [t3.id]: 'CONFIRMED' });
    expect(t3.correctionOfTransactionId).toBe(t2.id);
  });

  it('Idempotency-Key: a replay answers as recorded; another payload conflicts; a rejection does not use the key', async () => {
    const id = await confirmedRent();
    const request = { reason: 'Datum', replacement: { bookingDate: date('2026-09-04') } };
    const key = { key: 'k-correct-1', fingerprint: correctionFingerprint(id, request) };

    const refused = { reason: 'Datum', replacement: { amount: eur('1.00') } };
    expect(await corrections.correct(id, REALM, refused, actor, { key: 'k-correct-1', fingerprint: correctionFingerprint(id, refused) })).toMatchObject({
      kind: 'SUM_MISMATCH',
    });

    const first = await corrections.correct(id, REALM, request, actor, key);
    expect(first).toMatchObject({ kind: 'CORRECTED', replayed: false });
    const replay = await corrections.correct(id, REALM, request, actor, key);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(
      await corrections.correct(id, REALM, { ...request, reason: 'anders' }, actor, { key: 'k-correct-1', fingerprint: correctionFingerprint(id, { ...request, reason: 'anders' }) }),
    ).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    expect((await audits(id)).filter((r) => r.action === 'CORRECTED')).toHaveLength(1);
  });

  it('two concurrent corrections: one chain, the other waits for it and gets ALREADY_CORRECTED with its ids', async () => {
    const id = await confirmedRent();
    const request = { reason: 'Datum', replacement: { bookingDate: date('2026-09-04') } };
    // Hold the original's row lock, so both corrections queue on it; the second then waits on the first.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM ledger_transaction WHERE id = $1 FOR UPDATE`, [id]);
      const both = Promise.all([corrections.correct(id, REALM, request, actor), corrections.correct(id, REALM, request, actor)]);
      await waitUntil(async () =>
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND query LIKE '%from "ledger_transaction"%for update%'`,
            )
          ).rows[0].count,
        ) === 2,
      );
      await holder.query('COMMIT');
      const outcomes = await both;
      const winner = outcomes.find((o) => o.kind === 'CORRECTED');
      if (winner?.kind !== 'CORRECTED') throw new Error(JSON.stringify(outcomes));
      expect(outcomes.find((o) => o.kind !== 'CORRECTED')).toEqual({
        kind: 'ALREADY_CORRECTED',
        reversalTransactionId: winner.result.reversal.id,
        replacementTransactionId: winner.result.replacement?.id,
      });
    } finally {
      holder.release();
    }
    expect(Number((await pool.query(`SELECT count(*) FROM ledger_transaction WHERE correction_of_transaction_id = $1`, [id])).rows[0].count)).toBe(2);
  });

  it('the splits of a corrected original stay frozen', async () => {
    const id = await confirmedRent();
    const outcome = await splits.replaceSplits(id, REALM, [split('1250.00', 'RENT_BASE')], actor);
    expect(outcome).toEqual({ kind: 'FROZEN', status: 'CONFIRMED' });
    await correctOk(id, { reason: 'Datum', replacement: { bookingDate: date('2026-09-04') } });
    expect(await splits.replaceSplits(id, REALM, [split('1250.00', 'RENT_BASE')], actor)).toEqual({ kind: 'FROZEN', status: 'CORRECTED' });
  });

  describe('reverse without a replacement (VC-X-15, api-design §35.9)', () => {
    const reverse = (id: string, reason = 'Doppelt erfasst', key?: string) =>
      corrections.correct(
        id,
        REALM,
        { reason, replacement: null },
        actor,
        key === undefined ? undefined : { key, fingerprint: correctionFingerprint(id, { reason, replacement: null }) },
      );

    it('writes only the confirmed reversal; the original is CORRECTED; one AuditRecord REVERSED; the net effect is zero', async () => {
      const accountId = await openAccount();
      const id = await confirmedRent({ accountId });
      const outcome = await reverse(id);
      if (outcome.kind !== 'CORRECTED') throw new Error(outcome.kind);
      const { original, reversal, replacement } = outcome.result;
      expect(replacement).toBeNull();
      expect(original).toMatchObject({ status: 'CORRECTED', reversalTransactionId: reversal.id, replacementTransactionId: null });
      expect(reversal).toMatchObject({ direction: 'OUTFLOW', status: 'CONFIRMED', correctionRole: 'REVERSAL', correctionOfTransactionId: id });
      expect(await splitRows(reversal.id)).toEqual(await splitRows(id));
      expect((await audits(id)).at(-1)).toMatchObject({
        action: 'REVERSED',
        metadata: { reason: 'Doppelt erfasst', previousStatus: 'CONFIRMED', reversalTransactionId: reversal.id },
      });
      expect((await audits(id)).at(-1)?.metadata).not.toHaveProperty('replacementTransactionId');
      const net = await pool.query(
        `SELECT coalesce(sum(CASE direction WHEN 'INFLOW' THEN amount ELSE -amount END), 0)::text AS total
         FROM ledger_transaction WHERE financial_account_id = $1 AND status IN ('CONFIRMED', 'RECONCILED', 'CORRECTED')`,
        [accountId],
      );
      expect(net.rows).toEqual([{ total: '0.00' }]);
    });

    it('a second reverse or correct names the reversal; a reversal itself cannot be reversed; a closed account is fine', async () => {
      const accountId = await openAccount();
      const id = await confirmedRent({ accountId });
      await accounts.close(accountId as FinancialAccountId, REALM, new Date(), actor);
      const first = await reverse(id);
      if (first.kind !== 'CORRECTED') throw new Error(first.kind);
      const already = { kind: 'ALREADY_CORRECTED', reversalTransactionId: first.result.reversal.id, replacementTransactionId: null };
      expect(await reverse(id)).toEqual(already);
      expect(await corrections.correct(id, REALM, { reason: 'x', replacement: { bookingDate: date('2026-09-04') } }, actor)).toEqual(already);
      expect(await reverse(first.result.reversal.id)).toEqual({ kind: 'NOT_CORRECTABLE', status: 'CONFIRMED', correctionRole: 'REVERSAL' });
    });

    it('ends a correction chain: reversing the current replacement leaves nothing current', async () => {
      const id = await confirmedRent();
      const { replacement } = await correctOk(id, { reason: 'Datum', replacement: { bookingDate: date('2026-09-04') } });
      const outcome = await reverse(replacement.id, 'Miete storniert');
      expect(outcome).toMatchObject({ kind: 'CORRECTED', result: { original: { id: replacement.id, status: 'CORRECTED' }, replacement: null } });
      const current = await pool.query(
        `SELECT count(*) FROM ledger_transaction WHERE id = ANY($1) AND status IN ('CONFIRMED', 'RECONCILED') AND correction_role IS DISTINCT FROM 'REVERSAL'`,
        [[id, replacement.id]],
      );
      expect(current.rows).toEqual([{ count: '0' }]);
    });

    it('Idempotency-Key: a replay answers as recorded; the same key on correct is another scope', async () => {
      const id = await confirmedRent();
      const first = await reverse(id, 'Doppelt', 'k-rev-1');
      expect(first).toMatchObject({ kind: 'CORRECTED', replayed: false });
      expect(await reverse(id, 'Doppelt', 'k-rev-1')).toEqual({ ...first, replayed: true });
      // The same key on `correct` is unrelated (own scope); that request then finds the original already reversed.
      const request = { reason: 'Doppelt', replacement: { bookingDate: date('2026-09-04') } };
      expect(await corrections.correct(id, REALM, request, actor, { key: 'k-rev-1', fingerprint: correctionFingerprint(id, request) })).toMatchObject({
        kind: 'ALREADY_CORRECTED',
      });
    });
  });
});
