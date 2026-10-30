import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Direction, SplitInput } from '../../domains/ledger/index.js';
import { DE_CATEGORY_DEFAULTS_V1, type NewTaxClassification, type TaxListItem, type TaxMeaning, type TaxPage } from '../../domains/taxation/index.js';
import { parseMea, type Mea } from '../../domains/weg/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { checkStoredRuleReferences } from './tax-rule-check.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresWegRepository } from './weg-repository.js';

/**
 * VC-7-01 persistence (api-design.md §55–§58): create with its order of checks, supersede and replay; the history; the
 * review steps with their AuditRecords, no-ops and refusals; the tax meaning per split and per property and year; the
 * split and its Transaction unchanged by every command; every guard of 0045 past the repository; the start check; the
 * serialisation on the Transaction row under RC and RR; and `down`. Figures are invented.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee000000000000a1';
const OTHER_REALM = '64b0c0ffee000000000000a2';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2026-10-30');
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const split = (amount: string, financialCategoryCode: string, propertyReferenceId: string | null): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode,
  propertyReferenceId,
  loanId: null,
  securityDepositId: null,
  description: null,
});
const mea = (text: string): Mea => {
  const parsed = parseMea(text);
  if (!('mea' in parsed)) throw new Error(text);
  return parsed.mea;
};
let counter = 0;
/** The split items of a page of the per-property list (VC-7-02 adds retained deposits). */
const splitsOf = (page: TaxPage<TaxListItem> | undefined): TaxMeaning[] =>
  (page?.items ?? []).filter((m): m is TaxMeaning => m.sourceType === 'TRANSACTION_SPLIT');

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
  return (
    error.constraint ??
    /\(([A-Z_]+)\)|only inserted current|never change|never deleted|superseded is final|does not move|changes nothing else|does not name it|is not superseded by it/.exec(
      error.message ?? '',
    )?.[0] ??
    error.code ??
    'error'
  );
}

describe.skipIf(databaseUrl === undefined)('TaxClassification (§55–§58)', () => {
  const schema = testSchemaName('tax_classification_test');
  let pool: pg.Pool;
  let classifications: PostgresTaxClassificationRepository;
  let accounts: PostgresFinancialAccountRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let corrections: PostgresCorrectionRepository;
  let wegs: PostgresWegRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    classifications = new PostgresTaxClassificationRepository(db);
    accounts = new PostgresFinancialAccountRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    wegs = new PostgresWegRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function propertyReference(realm = REALM) {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fb0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function transaction(options: { direction?: Direction; amount?: string; bookingDate?: string; realm?: string } = {}) {
    const realm = options.realm ?? REALM;
    const account = await accounts.create({ mreRealmId: realm, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const created = await transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: account.account.id,
        amount: eur(options.amount ?? '120.00'),
        direction: options.direction ?? 'OUTFLOW',
        bookingDate: day(options.bookingDate ?? '2026-03-02'),
        valueDate: null,
        description: 'Handwerker',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.transaction.id;
  }
  /** A Transaction with its splits, confirmed unless `confirm` is false; returns it and its split ids by position. */
  async function booked(
    set: SplitInput[],
    options: { direction?: Direction; bookingDate?: string; confirm?: boolean; realm?: string } = {},
  ): Promise<{ tx: string; splitIds: string[] }> {
    const total = set.reduce((sum, s) => sum.add(s.amount), eur('0.00'));
    const realm = options.realm ?? REALM;
    const tx = await transaction({ ...options, amount: total.amount });
    const outcome = await splits.replaceSplits(tx, realm, set, actor);
    if (outcome.kind !== 'REPLACED') throw new Error(JSON.stringify(outcome));
    if (options.confirm !== false) expect((await transactions.confirm(tx, realm, actor)).kind).toBe('CONFIRMED');
    const { rows } = await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [tx]);
    return { tx, splitIds: rows.map((r) => r.id as string) };
  }
  async function oneSplit(code = 'MAINTENANCE', options: Parameters<typeof booked>[1] & { amount?: string } = {}) {
    const pr = await propertyReference(options.realm);
    const { tx, splitIds } = await booked([split(options.amount ?? '120.00', code, pr)], options);
    return { tx, splitId: splitIds[0] as string, pr };
  }
  const request = (sourceId: string, overrides: Partial<NewTaxClassification> = {}): NewTaxClassification => ({
    mreRealmId: REALM,
    sourceType: 'TRANSACTION_SPLIT',
    sourceId,
    taxCategory: 'MAINTENANCE',
    treatment: 'CAPITALIZED',
    reviewState: 'USER_CONFIRMED',
    supersedes: null,
    notes: 'Austausch Thermostatventile',
    sourceReferences: ['Rechnung 2026-117'],
    ...overrides,
  });
  async function classified(sourceId: string, overrides: Partial<NewTaxClassification> = {}) {
    const created = await classifications.createClassification(request(sourceId, overrides), actor);
    if (created.kind !== 'CREATED') throw new Error(JSON.stringify(created));
    return created.classification;
  }
  const audit = async (id: string) =>
    (await pool.query(`SELECT action, metadata, actor_id, previous_version, new_version FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [id]))
      .rows as { action: string; metadata: Record<string, unknown>; actor_id: string; previous_version: number | null; new_version: number }[];
  /** The Transaction row and its split rows as stored, for the "nothing changes" counter-check. */
  const cashOf = async (tx: string) => ({
    transaction: (await pool.query(`SELECT row_to_json(t)::text AS j FROM ledger_transaction t WHERE id = $1`, [tx])).rows[0].j as string,
    splits: (await pool.query(`SELECT row_to_json(s)::text AS j FROM transaction_split s WHERE transaction_id = $1 ORDER BY position`, [tx])).rows.map(
      (r) => r.j as string,
    ),
  });

  describe('create (§56)', () => {
    it('creates with the rule of the booking date, AuditRecord TAX_CLASSIFIED; replay and IDEMPOTENCY_CONFLICT', async () => {
      const { splitId } = await oneSplit();
      const key = { key: `k-${++counter}`, fingerprint: 'f' };
      const created = await classifications.createClassification(request(splitId), actor, key);
      expect(created).toMatchObject({
        kind: 'CREATED',
        classification: {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: splitId,
          taxCategory: 'MAINTENANCE',
          treatment: 'CAPITALIZED',
          reviewState: 'USER_CONFIRMED',
          rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
          advisorPartyId: null,
          notes: 'Austausch Thermostatventile',
          sourceReferences: ['Rechnung 2026-117'],
          supersedes: null,
          supersededBy: null,
          supersededAt: null,
          createdBy: 'anna@example.com',
          version: 1,
        },
      });
      if (created.kind !== 'CREATED') return;
      const replay = await classifications.createClassification(request(splitId), actor, key);
      expect(replay).toEqual({ kind: 'REPLAYED', classification: created.classification });
      expect(await classifications.createClassification(request(splitId), actor, { ...key, fingerprint: 'g' })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
      expect(await audit(created.classification.id)).toEqual([
        {
          action: 'TAX_CLASSIFIED',
          actor_id: 'anna@example.com',
          previous_version: null,
          new_version: 1,
          metadata: {
            sourceType: 'TRANSACTION_SPLIT',
            sourceId: splitId,
            taxCategory: 'MAINTENANCE',
            treatment: 'CAPITALIZED',
            reviewState: 'USER_CONFIRMED',
            rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
          },
        },
      ]);
      expect(await classifications.findClassification(created.classification.id, OTHER_REALM)).toBeUndefined();
      expect(await classifications.findClassification(created.classification.id, REALM)).toEqual(created.classification);
    });

    it('the order of checks: 404 → SOURCE_NOT_COUNTED → TREATMENT_NOT_ALLOWED → CLASSIFICATION_EXISTS / NOT_CURRENT_CLASSIFICATION', async () => {
      expect(await classifications.createClassification(request(UNKNOWN), actor)).toEqual({ kind: 'SOURCE_NOT_FOUND' });
      expect(await classifications.createClassification(request('not-a-uuid'), actor)).toEqual({ kind: 'SOURCE_NOT_FOUND' });
      const foreign = await oneSplit('TRANSFER', { realm: OTHER_REALM, confirm: false });
      expect(await classifications.createClassification(request(foreign.splitId, { treatment: 'DEDUCTIBLE' }), actor)).toEqual({ kind: 'SOURCE_NOT_FOUND' });
      // Unconfirmed and a treatment the category refuses: SOURCE_NOT_COUNTED comes first.
      const open = await oneSplit('TRANSFER', { confirm: false });
      expect(await classifications.createClassification(request(open.splitId, { taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE' }), actor)).toEqual({
        kind: 'SOURCE_NOT_COUNTED',
        transactionStatus: 'CLASSIFIED',
        correctionRole: null,
      });
      const transfer = await oneSplit('TRANSFER');
      expect(await classifications.createClassification(request(transfer.splitId, { treatment: 'DEDUCTIBLE' }), actor)).toEqual({
        kind: 'TREATMENT_NOT_ALLOWED',
        categoryType: 'TRANSFER',
        allowed: ['NOT_RELEVANT'],
      });
      const deposit = await oneSplit('SECURITY_DEPOSIT', { direction: 'INFLOW' });
      expect(await classifications.createClassification(request(deposit.splitId, { taxCategory: 'OTHER_INCOME', treatment: 'INCOME' }), actor)).toMatchObject({
        kind: 'TREATMENT_NOT_ALLOWED',
        categoryType: 'SECURITY_DEPOSIT',
      });
      const principal = await oneSplit('LOAN_PRINCIPAL');
      expect(await classifications.createClassification(request(principal.splitId, { taxCategory: 'LOAN_INTEREST', treatment: 'DEDUCTIBLE' }), actor)).toEqual({
        kind: 'TREATMENT_NOT_ALLOWED',
        categoryType: 'FINANCING',
        allowed: ['INCOME', 'CAPITALIZED', 'NOT_RELEVANT'],
      });
      expect(
        (await classifications.createClassification(request(principal.splitId, { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' }), actor)).kind,
      ).toBe('CREATED');
      const purchase = await oneSplit('ACQUISITION');
      expect(await classifications.createClassification(request(purchase.splitId, { taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED' }), actor)).toEqual({
        kind: 'TREATMENT_NOT_ALLOWED',
        categoryType: 'CAPITAL_MOVEMENT',
        allowed: ['INCOME', 'DEDUCTIBLE', 'NOT_RELEVANT'],
      });
      // A classification exists: a refused treatment still comes first, then supersedes.
      const { splitId } = await oneSplit('TRANSFER');
      const first = await classified(splitId, { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' });
      expect(await classifications.createClassification(request(splitId, { treatment: 'DEDUCTIBLE' }), actor)).toMatchObject({ kind: 'TREATMENT_NOT_ALLOWED' });
      const again = request(splitId, { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', reviewState: 'NEEDS_REVIEW' });
      expect(await classifications.createClassification(again, actor)).toEqual({ kind: 'CLASSIFICATION_EXISTS', currentClassificationId: first.id });
      expect(await classifications.createClassification({ ...again, supersedes: UNKNOWN }, actor)).toEqual({
        kind: 'NOT_CURRENT_CLASSIFICATION',
        currentClassificationId: first.id,
      });
      const none = await oneSplit();
      expect(await classifications.createClassification(request(none.splitId, { supersedes: first.id }), actor)).toEqual({
        kind: 'NOT_CURRENT_CLASSIFICATION',
        currentClassificationId: null,
      });
      // A refused create rolls its key back: the key is free again.
      const key = { key: `k-${++counter}`, fingerprint: 'f' };
      expect((await classifications.createClassification(again, actor, key)).kind).toBe('CLASSIFICATION_EXISTS');
      expect((await classifications.createClassification({ ...again, supersedes: first.id }, actor, { ...key, fingerprint: 'other' })).kind).toBe('CREATED');
    });

    it('supersede: one current per split, the chain both ways, TAX_CLASSIFICATION_SUPERSEDED; the history by creation', async () => {
      const { splitId } = await oneSplit();
      const first = await classified(splitId, { treatment: 'DEDUCTIBLE', reviewState: 'NEEDS_REVIEW' });
      const second = await classified(splitId, { supersedes: first.id });
      const third = await classified(splitId, { supersedes: second.id, treatment: 'NOT_RELEVANT' });
      const history = await classifications.listHistory('TRANSACTION_SPLIT', splitId, REALM);
      expect(history?.map((c) => [c.id, c.supersedes, c.supersededBy, c.supersededAt === null, c.version])).toEqual([
        [first.id, null, second.id, false, 2],
        [second.id, first.id, third.id, false, 2],
        [third.id, second.id, null, true, 1],
      ]);
      // A supersede changes nothing else on the old one.
      expect(history?.[0]).toMatchObject({ treatment: 'DEDUCTIBLE', reviewState: 'NEEDS_REVIEW' });
      expect((await audit(first.id)).map((a) => [a.action, a.metadata])).toEqual([
        ['TAX_CLASSIFIED', expect.objectContaining({ reviewState: 'NEEDS_REVIEW' })],
        ['TAX_CLASSIFICATION_SUPERSEDED', { supersededBy: second.id }],
      ]);
      expect((await audit(second.id))[0]?.metadata).toMatchObject({ supersedes: first.id });
      expect(await classifications.listHistory('TRANSACTION_SPLIT', splitId, OTHER_REALM)).toBeUndefined();
      expect(await classifications.listHistory('TRANSACTION_SPLIT', UNKNOWN, REALM)).toBeUndefined();
      expect(await classifications.listHistory('WEG_RESERVE_WITHDRAWAL', splitId, REALM)).toBeUndefined();
      expect(await classifications.listHistory('TRANSACTION_SPLIT', (await oneSplit()).splitId, REALM)).toEqual([]);
    });
  });

  describe('review steps (§57)', () => {
    async function party(realm = REALM) {
      const { rows } = await pool.query(
        `INSERT INTO party (mre_realm_id, party_type, display_name, legal_name, status, created_by) VALUES ($1, 'ORGANIZATION', 'Steuerbüro', 'Steuerbüro GmbH', 'ACTIVE', 'x') RETURNING id`,
        [realm],
      );
      return rows[0].id as string;
    }

    it('confirm, advisor-confirm, mark-needs-review: targets, no-ops, If-Match, AuditRecords with the actor', async () => {
      const { splitId } = await oneSplit();
      const c = await classified(splitId, { reviewState: 'NEEDS_REVIEW' });
      const advisor = await party();
      expect(await classifications.reviewClassification(c.id, REALM, { kind: 'CONFIRM' }, actor, [9])).toEqual({
        kind: 'VERSION_CONFLICT',
        expectedVersions: [9],
        currentVersion: 1,
      });
      expect(await classifications.reviewClassification(c.id, REALM, { kind: 'CONFIRM' }, actor, [1])).toMatchObject({
        kind: 'REVIEWED',
        changed: true,
        classification: { reviewState: 'USER_CONFIRMED', version: 2 },
      });
      // A no-op answers before If-Match.
      expect(await classifications.reviewClassification(c.id, REALM, { kind: 'CONFIRM' }, actor, [1])).toMatchObject({
        kind: 'REVIEWED',
        changed: false,
        classification: { version: 2 },
      });
      const advisorStep = { kind: 'ADVISOR_CONFIRM', advisorPartyId: advisor, note: 'geprüft' } as const;
      expect(await classifications.reviewClassification(c.id, REALM, { ...advisorStep, advisorPartyId: UNKNOWN }, actor)).toEqual({
        kind: 'PARTY_NOT_FOUND',
        partyId: UNKNOWN,
      });
      const foreign = await party(OTHER_REALM);
      expect(await classifications.reviewClassification(c.id, REALM, { ...advisorStep, advisorPartyId: foreign }, actor)).toEqual({
        kind: 'PARTY_NOT_FOUND',
        partyId: foreign,
      });
      expect(await classifications.reviewClassification(c.id, REALM, advisorStep, actor, [2])).toMatchObject({
        changed: true,
        classification: { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor, version: 3 },
      });
      expect(await classifications.reviewClassification(c.id, REALM, advisorStep, actor)).toMatchObject({ changed: false });
      expect(await classifications.reviewClassification(c.id, REALM, { kind: 'CONFIRM' }, actor)).toEqual({ kind: 'ADVISOR_CONFIRMED' });
      expect(await classifications.reviewClassification(c.id, REALM, { kind: 'MARK_NEEDS_REVIEW', reason: 'Beleg fehlt' }, actor, [3])).toMatchObject({
        changed: true,
        classification: { reviewState: 'NEEDS_REVIEW', advisorPartyId: null, version: 4 },
      });
      expect(await classifications.reviewClassification(c.id, REALM, { kind: 'MARK_NEEDS_REVIEW', reason: 'again' }, actor)).toMatchObject({ changed: false });
      expect(await classifications.reviewClassification(c.id, REALM, { kind: 'ADVISOR_CONFIRM', advisorPartyId: null, note: null }, actor)).toMatchObject({
        changed: true,
        classification: { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: null, version: 5 },
      });
      expect((await audit(c.id)).map((a) => [a.action, a.metadata, a.actor_id, a.previous_version, a.new_version])).toEqual([
        ['TAX_CLASSIFIED', expect.anything(), 'anna@example.com', null, 1],
        ['TAX_CLASSIFICATION_CONFIRMED', { from: 'NEEDS_REVIEW', to: 'USER_CONFIRMED' }, 'anna@example.com', 1, 2],
        [
          'TAX_CLASSIFICATION_ADVISOR_CONFIRMED',
          { from: 'USER_CONFIRMED', to: 'ADVISOR_CONFIRMED', advisorPartyId: advisor, note: 'geprüft' },
          'anna@example.com',
          2,
          3,
        ],
        ['TAX_CLASSIFICATION_MARKED_NEEDS_REVIEW', { from: 'ADVISOR_CONFIRMED', to: 'NEEDS_REVIEW', reason: 'Beleg fehlt' }, 'anna@example.com', 3, 4],
        ['TAX_CLASSIFICATION_ADVISOR_CONFIRMED', { from: 'NEEDS_REVIEW', to: 'ADVISOR_CONFIRMED', advisorPartyId: null, note: null }, 'anna@example.com', 4, 5],
      ]);
      expect(await classifications.reviewClassification(c.id, OTHER_REALM, { kind: 'CONFIRM' }, actor)).toEqual({ kind: 'NOT_FOUND' });
      expect(await classifications.reviewClassification(UNKNOWN, REALM, { kind: 'CONFIRM' }, actor)).toEqual({ kind: 'NOT_FOUND' });
    });

    it('only the current one moves; the source must still count for a confirmation, not for mark-needs-review', async () => {
      const { tx, splitId } = await oneSplit();
      const first = await classified(splitId, { reviewState: 'NEEDS_REVIEW' });
      const second = await classified(splitId, { supersedes: first.id, reviewState: 'NEEDS_REVIEW' });
      for (const step of [
        { kind: 'CONFIRM' },
        { kind: 'MARK_NEEDS_REVIEW', reason: 'r' },
        { kind: 'ADVISOR_CONFIRM', advisorPartyId: null, note: null },
      ] as const) {
        expect(await classifications.reviewClassification(first.id, REALM, step, actor)).toEqual({
          kind: 'CLASSIFICATION_SUPERSEDED',
          supersededBy: second.id,
        });
      }
      expect((await corrections.correct(tx, REALM, { reason: 'falsch', replacement: null }, actor)).kind).toBe('CORRECTED');
      for (const step of [{ kind: 'CONFIRM' }, { kind: 'ADVISOR_CONFIRM', advisorPartyId: null, note: null }] as const)
        expect(await classifications.reviewClassification(second.id, REALM, step, actor)).toEqual({
          kind: 'SOURCE_NOT_COUNTED',
          transactionStatus: 'CORRECTED',
          correctionRole: null,
        });
      // Marking for review still works on a source that stopped counting (review on #158).
      const counted = await oneSplit();
      const toReview = await classified(counted.splitId);
      expect((await corrections.correct(counted.tx, REALM, { reason: 'falsch', replacement: null }, actor)).kind).toBe('CORRECTED');
      expect(await classifications.reviewClassification(toReview.id, REALM, { kind: 'MARK_NEEDS_REVIEW', reason: 'storniert' }, actor)).toMatchObject({
        changed: true,
        classification: { reviewState: 'NEEDS_REVIEW' },
      });
    });
  });

  describe('tax meaning (§55)', () => {
    it('DEFAULT, CLASSIFICATION, NOT_COUNTED, CLASSIFICATION_ON_CORRECTED_SPLIT; 404 of another Realm', async () => {
      const pr = await propertyReference();
      const { tx, splitIds } = await booked([split('100.00', 'MAINTENANCE', pr), split('20.00', 'OTHER_EXPENSE', pr)]);
      const [maintenance, other] = splitIds as [string, string];
      expect(await classifications.findTaxMeaning(maintenance, REALM, today)).toMatchObject({
        splitId: maintenance,
        transactionId: tx,
        bookingDate: '2026-03-02',
        direction: 'OUTFLOW',
        amount: eur('100.00'),
        financialCategoryCode: 'MAINTENANCE',
        propertyReferenceId: pr,
        counts: true,
        taxCategory: 'MAINTENANCE',
        treatment: 'DEDUCTIBLE',
        reviewState: 'SUGGESTED',
        origin: 'DEFAULT',
        rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
        classificationId: null,
        flags: [],
      });
      expect(await classifications.findTaxMeaning(other, REALM, today)).toMatchObject({
        taxCategory: 'UNCLASSIFIED',
        treatment: null,
        reviewState: 'NEEDS_REVIEW',
      });
      const c = await classified(maintenance);
      expect(await classifications.findTaxMeaning(maintenance, REALM, today)).toMatchObject({
        origin: 'CLASSIFICATION',
        treatment: 'CAPITALIZED',
        reviewState: 'USER_CONFIRMED',
        classificationId: c.id,
      });
      const corrected = await corrections.correct(tx, REALM, { reason: 'Beschreibung', replacement: { description: 'Heizung' } }, actor);
      if (corrected.kind !== 'CORRECTED' || corrected.result.replacement === null) throw new Error(corrected.kind);
      expect(await classifications.findTaxMeaning(maintenance, REALM, today)).toMatchObject({
        counts: false,
        origin: 'CLASSIFICATION',
        flags: [{ code: 'NOT_COUNTED', details: { transactionStatus: 'CORRECTED', correctionRole: null } }],
      });
      const { rows } = await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [corrected.result.replacement.id]);
      expect(await classifications.findTaxMeaning(rows[0].id, REALM, today)).toMatchObject({
        counts: true,
        origin: 'DEFAULT',
        treatment: 'DEDUCTIBLE',
        flags: [{ code: 'CLASSIFICATION_ON_CORRECTED_SPLIT', details: { originalTransactionId: tx, classificationIds: [c.id] } }],
      });
      // The replacement's other split shares the Transaction: the flag is per Transaction's original (P7-D2).
      expect((await classifications.findTaxMeaning(rows[1].id, REALM, today))?.flags.map((f) => f.code)).toEqual(['CLASSIFICATION_ON_CORRECTED_SPLIT']);
      const { rows: reversal } = await pool.query(
        `SELECT s.id FROM transaction_split s JOIN ledger_transaction t ON t.id = s.transaction_id WHERE t.correction_of_transaction_id = $1 AND t.correction_role = 'REVERSAL' ORDER BY position`,
        [tx],
      );
      expect(await classifications.findTaxMeaning(reversal[0].id, REALM, today)).toMatchObject({
        counts: false,
        flags: [{ code: 'NOT_COUNTED', details: { transactionStatus: 'CONFIRMED', correctionRole: 'REVERSAL' } }],
      });
      expect(await classifications.findTaxMeaning(maintenance, OTHER_REALM, today)).toBeUndefined();
      expect(await classifications.findTaxMeaning(UNKNOWN, REALM, today)).toBeUndefined();
      const open = await oneSplit('MAINTENANCE', { confirm: false });
      expect((await classifications.findTaxMeaning(open.splitId, REALM, today))?.flags).toEqual([
        { code: 'NOT_COUNTED', details: { transactionStatus: 'CLASSIFIED', correctionRole: null } },
      ]);
    });

    it('per property and year: only counting splits of the year, ordered, filtered and paged; unknown property', async () => {
      const pr = await propertyReference();
      const a = await booked([split('900.00', 'RENT_BASE', pr), split('150.00', 'RENT_OPERATING_COST_ADVANCE', pr)], {
        direction: 'INFLOW',
        bookingDate: '2026-02-01',
      });
      const b = await booked([split('80.00', 'OTHER_EXPENSE', pr)], { bookingDate: '2026-01-15' });
      const c = await booked([split('300.00', 'MAINTENANCE', pr)], { bookingDate: '2026-12-31' });
      await booked([split('300.00', 'MAINTENANCE', pr)], { bookingDate: '2025-12-31' });
      await booked([split('300.00', 'MAINTENANCE', pr)], { bookingDate: '2027-01-01' });
      await booked([split('300.00', 'MAINTENANCE', pr)], { bookingDate: '2026-06-01', confirm: false });
      await booked([split('300.00', 'MAINTENANCE', await propertyReference())], { bookingDate: '2026-06-01' });
      const reversed = await booked([split('40.00', 'BANK_FEES', pr)], { bookingDate: '2026-05-01' });
      await corrections.correct(reversed.tx, REALM, { reason: 'falsch', replacement: null }, actor);
      await classified(c.splitIds[0] as string, { reviewState: 'NEEDS_REVIEW' });
      const page = { page: 1, pageSize: 200 };
      const all = await classifications.listTaxMeanings(pr, REALM, 2026, {}, page, today);
      expect(splitsOf(all).map((m) => [m.bookingDate, m.financialCategoryCode, m.origin])).toEqual([
        ['2026-01-15', 'OTHER_EXPENSE', 'DEFAULT'],
        ['2026-02-01', 'RENT_BASE', 'DEFAULT'],
        ['2026-02-01', 'RENT_OPERATING_COST_ADVANCE', 'DEFAULT'],
        ['2026-12-31', 'MAINTENANCE', 'CLASSIFICATION'],
      ]);
      expect(all?.total).toBe(4);
      expect(splitsOf(await classifications.listTaxMeanings(pr, REALM, 2026, { reviewStates: ['NEEDS_REVIEW'] }, page, today)).map((m) => m.splitId)).toEqual([
        b.splitIds[0],
        c.splitIds[0],
      ]);
      expect(splitsOf(await classifications.listTaxMeanings(pr, REALM, 2026, { origins: ['CLASSIFICATION'] }, page, today)).map((m) => m.splitId)).toEqual([
        c.splitIds[0],
      ]);
      expect(
        splitsOf(await classifications.listTaxMeanings(pr, REALM, 2026, { taxCategories: ['RENT', 'OPERATING_COST_ADVANCES'] }, page, today)).map(
          (m) => m.splitId,
        ),
      ).toEqual(a.splitIds);
      const second = await classifications.listTaxMeanings(pr, REALM, 2026, {}, { page: 2, pageSize: 3 }, today);
      expect(second).toMatchObject({ page: 2, pageSize: 3, total: 4 });
      expect(splitsOf(second).map((m) => m.splitId)).toEqual([c.splitIds[0]]);
      expect(await classifications.listTaxMeanings(pr, OTHER_REALM, 2026, {}, page, today)).toBeUndefined();
      expect(await classifications.listTaxMeanings(UNKNOWN, REALM, 2026, {}, page, today)).toBeUndefined();
      expect((await classifications.listTaxMeanings(pr, REALM, 2024, {}, page, today))?.items).toEqual([]);
    });

    it('every category seeded by the migrations is listed in the default table', async () => {
      const { rows } = await pool.query(`SELECT code, category_type FROM financial_category ORDER BY code`);
      for (const row of rows) expect(Object.keys(DE_CATEGORY_DEFAULTS_V1.parameters.defaults), row.code).toContain(row.code);
      expect(rows.length).toBe(Object.keys(DE_CATEGORY_DEFAULTS_V1.parameters.defaults).length);
    });
  });

  it('no command changes the split or its Transaction (rows and versions)', async () => {
    const { tx, splitId } = await oneSplit();
    const before = await cashOf(tx);
    const first = await classified(splitId, { reviewState: 'NEEDS_REVIEW' });
    expect(await cashOf(tx)).toEqual(before);
    const second = await classified(splitId, { supersedes: first.id, reviewState: 'NEEDS_REVIEW' });
    expect(await cashOf(tx)).toEqual(before);
    await classifications.reviewClassification(second.id, REALM, { kind: 'CONFIRM' }, actor);
    await classifications.reviewClassification(second.id, REALM, { kind: 'ADVISOR_CONFIRM', advisorPartyId: null, note: null }, actor);
    await classifications.reviewClassification(second.id, REALM, { kind: 'MARK_NEEDS_REVIEW', reason: 'r' }, actor);
    await classifications.findTaxMeaning(splitId, REALM, today);
    expect(await cashOf(tx)).toEqual(before);
    // Refused commands too.
    await classifications.createClassification(request(splitId), actor);
    await classifications.reviewClassification(first.id, REALM, { kind: 'CONFIRM' }, actor);
    expect(await cashOf(tx)).toEqual(before);
  });

  describe('schema past the repository (0045)', () => {
    const columns = `mre_realm_id, source_type, transaction_split_id, tax_category, treatment, review_state, rule_code, rule_version, created_by`;
    const insert = (splitId: string, values: { category?: string; treatment?: string | null; state?: string; realm?: string; extra?: string } = {}) =>
      pool
        .query(
          `INSERT INTO tax_classification (${columns}${values.extra === undefined ? '' : `, ${values.extra.split('=')[0]}`})
           VALUES ($1, 'TRANSACTION_SPLIT', $2, $3, $4, $5, 'DE_CATEGORY_DEFAULTS', 1, 'x'${values.extra === undefined ? '' : `, ${values.extra.split('=')[1]}`}) RETURNING id`,
          [
            values.realm ?? REALM,
            splitId,
            values.category ?? 'MAINTENANCE',
            values.treatment === undefined ? 'DEDUCTIBLE' : values.treatment,
            values.state ?? 'USER_CONFIRMED',
          ],
        )
        .then((r) => r.rows[0].id as string, reasonOf);
    const update = (set: string, id: string) => pool.query(`UPDATE tax_classification SET ${set} WHERE id = $1`, [id]).then(() => 'accepted', reasonOf);
    const isId = /^[0-9a-f-]{36}$/;

    it('source_counts and treatment: an uncounted source and the hard rules are refused; the foreign keys hold', async () => {
      const open = await oneSplit('MAINTENANCE', { confirm: false });
      expect(await insert(open.splitId)).toBe('(SOURCE_NOT_COUNTED)');
      const transfer = await oneSplit('TRANSFER');
      expect(await insert(transfer.splitId)).toBe('(TREATMENT_NOT_ALLOWED)');
      expect(await insert(transfer.splitId, { category: 'UNCLASSIFIED', treatment: null })).toBe('(TREATMENT_NOT_ALLOWED)');
      expect(await insert(transfer.splitId, { category: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' })).toMatch(isId);
      const principal = await oneSplit('LOAN_PRINCIPAL');
      expect(await insert(principal.splitId)).toBe('(TREATMENT_NOT_ALLOWED)');
      expect(await insert(principal.splitId, { treatment: 'CAPITALIZED' })).toMatch(isId);
      const purchase = await oneSplit('ACQUISITION');
      expect(await insert(purchase.splitId, { treatment: 'CAPITALIZED' })).toBe('(TREATMENT_NOT_ALLOWED)');
      expect(await insert(purchase.splitId, { category: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' })).toMatch(isId);
      const deposit = await oneSplit('SECURITY_DEPOSIT', { direction: 'INFLOW' });
      expect(await insert(deposit.splitId, { treatment: 'CAPITALIZED' })).toBe('(TREATMENT_NOT_ALLOWED)');
      // WEG_FUNDS: a reserve contribution with its unit's membership.
      const weg = await wegs.createWeg(
        { mreRealmId: REALM, displayName: `WEG ${++counter}`, administratorPartyId: null, financialYearStartMonth: 1, notes: null },
        actor,
      );
      if (weg.kind !== 'CREATED') throw new Error(weg.kind);
      const unit = await propertyReference();
      const m = await wegs.createMembership(
        {
          mreRealmId: REALM,
          wegId: weg.weg.id,
          propertyReferenceId: unit,
          mea: mea('250/10000'),
          validFrom: day('2025-01-01'),
          validUntil: null,
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (m.kind !== 'CREATED') throw new Error(m.kind);
      const reserve = await booked([split('50.00', 'WEG_RESERVE_CONTRIBUTION', unit)]);
      expect(await insert(reserve.splitIds[0] as string)).toBe('(TREATMENT_NOT_ALLOWED)');
      expect(await insert(reserve.splitIds[0] as string, { category: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' })).toMatch(isId);
      // The Realm is part of the split's key; an unknown split and another Realm's are refused by the foreign key.
      const counted = await oneSplit();
      expect(await insert(counted.splitId, { realm: OTHER_REALM })).toBe('tax_classification_split_fk');
      expect(await insert(UNKNOWN)).toBe('tax_classification_split_fk');
      expect(
        await pool
          .query(
            `INSERT INTO tax_classification (${columns}) VALUES ($1, 'WEG_RESERVE_WITHDRAWAL', $2, 'MAINTENANCE', 'DEDUCTIBLE', 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x')`,
            [REALM, counted.splitId],
          )
          .then(() => 'accepted', reasonOf),
      ).toMatch(/^tax_classification_(one_source|source_type_check)$/);
    });

    it('the CHECKs and initial: fit, review state, advisor, inserted current with version 1; one current per split', async () => {
      const { splitId } = await oneSplit();
      expect(await insert(splitId, { category: 'RENT', treatment: 'DEDUCTIBLE' })).toBe('tax_classification_fit');
      expect(await insert(splitId, { category: 'UNCLASSIFIED', treatment: 'DEDUCTIBLE' })).toBe('tax_classification_fit');
      expect(await insert(splitId, { category: 'MAINTENANCE', treatment: 'INCOME' })).toBe('tax_classification_fit');
      expect(await insert(splitId, { category: 'MAINTENANCE', treatment: null })).toBe('tax_classification_fit');
      expect(await insert(splitId, { state: 'SUGGESTED' })).toBe('only inserted current');
      expect(await insert(splitId, { state: 'ADVISOR_CONFIRMED' })).toBe('only inserted current');
      expect(await insert(splitId, { extra: 'version=2' })).toBe('only inserted current');
      expect(await insert(splitId, { extra: `superseded_at=now()` })).toBe('only inserted current');
      const id = await insert(splitId);
      expect(id).toMatch(isId);
      expect(await insert(splitId, { state: 'NEEDS_REVIEW' })).toBe('tax_classification_current');
      expect(await update(`advisor_party_id = gen_random_uuid(), version = version + 1`, id)).not.toBe('accepted');
    });

    it('frozen: content, source, rule and creation never change; version + 1; the review targets; superseded is final; never deleted', async () => {
      const { splitId } = await oneSplit();
      const id = await insert(splitId, { state: 'NEEDS_REVIEW' });
      expect(await update(`version = version`, id)).toBe('accepted');
      for (const set of [
        `tax_category = 'ADMINISTRATION', version = version + 1`,
        `treatment = 'CAPITALIZED', version = version + 1`,
        `rule_version = 2, version = version + 1`,
        `notes = 'n', version = version + 1`,
        `source_references = '{x}', version = version + 1`,
        `created_by = 'y', version = version + 1`,
        `review_state = 'USER_CONFIRMED'`,
        `review_state = 'USER_CONFIRMED', version = version + 2`,
      ])
        expect(await update(set, id), set).toBe('never change');
      expect(await update(`review_state = 'USER_CONFIRMED', version = version + 1`, id)).toBe('accepted');
      expect(await update(`review_state = 'ADVISOR_CONFIRMED', version = version + 1`, id)).toBe('accepted');
      expect(await update(`review_state = 'USER_CONFIRMED', version = version + 1`, id)).toBe('does not move');
      expect(await update(`review_state = 'NEEDS_REVIEW', version = version + 1`, id)).toBe('accepted');
      expect(await pool.query(`DELETE FROM tax_classification WHERE id = $1`, [id]).then(() => 'accepted', reasonOf)).toBe('never deleted');
      // A supersede: the old row first, then the successor naming it, in one transaction.
      const client = await pool.connect();
      let next = '';
      try {
        await client.query('BEGIN');
        next = (await client.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;
        await client.query(`UPDATE tax_classification SET superseded_at = now(), superseded_by = $2, version = version + 1 WHERE id = $1`, [id, next]);
        await client.query(
          `INSERT INTO tax_classification (id, ${columns}, supersedes_id) VALUES ($1, $2, 'TRANSACTION_SPLIT', $3, 'MAINTENANCE', 'DEDUCTIBLE', 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x', $4)`,
          [next, REALM, splitId, id],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      expect(await update(`review_state = 'ADVISOR_CONFIRMED', version = version + 1`, id)).toBe('superseded is final');
      expect(await update(`superseded_at = now(), version = version + 1`, id)).toBe('superseded is final');
      // A supersede without a successor naming it fails at commit (deferred), as does one that changes the state.
      const other = await insert((await oneSplit()).splitId, { state: 'NEEDS_REVIEW' });
      expect(await update(`superseded_at = now(), superseded_by = '${next}', version = version + 1`, other)).not.toBe('accepted');
      const lone = await insert((await oneSplit()).splitId, { state: 'NEEDS_REVIEW' });
      expect(await update(`superseded_at = now(), superseded_by = '${lone}', review_state = 'USER_CONFIRMED', version = version + 1`, lone)).toBe(
        'changes nothing else',
      );
    });

    it('chain (deferred): superseded_by and supersedes must name each other, both directions (review on #158)', async () => {
      const inOneTransaction = async (steps: (client: pg.PoolClient) => Promise<void>) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await steps(client);
          await client.query('COMMIT');
          return 'accepted';
        } catch (error) {
          await client.query('ROLLBACK');
          return reasonOf(error as { message?: string });
        } finally {
          client.release();
        }
      };
      const successor = (client: pg.PoolClient, id: string, splitId: string, supersedes: string | null) =>
        client.query(
          `INSERT INTO tax_classification (id, ${columns}, supersedes_id) VALUES ($1, $2, 'TRANSACTION_SPLIT', $3, 'MAINTENANCE', 'DEDUCTIBLE', 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x', $4)`,
          [id, REALM, splitId, supersedes],
        );
      const newId = async () => (await pool.query(`SELECT gen_random_uuid() AS id`)).rows[0].id as string;

      // superseded_by names a successor of the same split that does not name it back.
      const one = await oneSplit();
      const a = await insert(one.splitId);
      const b = await newId();
      expect(
        await inOneTransaction(async (client) => {
          await client.query(`UPDATE tax_classification SET superseded_at = now(), superseded_by = $2, version = version + 1 WHERE id = $1`, [a, b]);
          await successor(client, b, one.splitId, null);
        }),
      ).toBe('does not name it');

      // supersedes names a classification that is not superseded by it (here: itself, still current).
      const two = await oneSplit();
      const c = await newId();
      expect(await inOneTransaction((client) => successor(client, c, two.splitId, c).then(() => undefined))).toBe('is not superseded by it');

      // Both directions agreeing commit.
      const d = await insert(two.splitId);
      const e = await newId();
      expect(
        await inOneTransaction(async (client) => {
          await client.query(`UPDATE tax_classification SET superseded_at = now(), superseded_by = $2, version = version + 1 WHERE id = $1`, [d, e]);
          await successor(client, e, two.splitId, d);
        }),
      ).toBe('accepted');
    });

    it('down drops the table, its functions and the split key (under MIGRATION_ADVISORY_LOCK)', { timeout: 30_000 }, async () => {
      const downSchema = testSchemaName('tax_classification_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        // 0046 (VC-7-02) builds on 0045: its own down first.
        await withMigrationLock(async () => {
          await (await import('./migrations/0046_tax_year_and_income.js')).down(createDatabase(downPool) as never);
          await (await import('./migrations/0045_tax_classification.js')).down(createDatabase(downPool) as never);
        });
        expect((await downPool.query(`SELECT to_regclass('tax_classification') AS t`)).rows[0].t).toBeNull();
        const functions = await downPool.query(
          `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = $1 AND proname LIKE 'tax_classification%'`,
          [downSchema],
        );
        expect(functions.rows).toEqual([]);
        const key = await downPool.query(
          `SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE nspname = $1 AND conname = 'transaction_split_realm_key'`,
          [downSchema],
        );
        expect(key.rows).toEqual([]);
        // 0044 is intact: its trigger on transaction_split still exists.
        const triggers = await downPool.query(
          `SELECT tgname FROM pg_trigger WHERE tgrelid = 'transaction_split'::regclass AND tgname = 'transaction_split_weg_assessment'`,
        );
        expect(triggers.rows).toHaveLength(1);
      } finally {
        await downPool.end();
      }
    });
  });

  it('start check (§58): every stored rule reference resolves, else the start is refused naming the missing ones', async () => {
    const db = createDatabase(pool);
    const { splitId } = await oneSplit();
    await classified(splitId);
    expect(await checkStoredRuleReferences(db)).toEqual([{ ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 }]);
    // A stored reference to a version the code does not know (written past the repository).
    const unknown = await oneSplit();
    const { rows } = await pool.query(
      `INSERT INTO tax_classification (mre_realm_id, source_type, transaction_split_id, tax_category, treatment, review_state, rule_code, rule_version, created_by)
       VALUES ($1, 'TRANSACTION_SPLIT', $2, 'MAINTENANCE', 'DEDUCTIBLE', 'NEEDS_REVIEW', 'DE_CATEGORY_DEFAULTS', 9, 'x') RETURNING id`,
      [REALM, unknown.splitId],
    );
    await expect(checkStoredRuleReferences(db)).rejects.toThrow('Stored tax rule references are not registered: DE_CATEGORY_DEFAULTS@9');
    // A step on it refuses too: the rule version does not resolve (§57).
    expect(await classifications.reviewClassification(rows[0].id, REALM, { kind: 'CONFIRM' }, actor)).toEqual({
      kind: 'RULE_NOT_REGISTERED',
      ruleCode: 'DE_CATEGORY_DEFAULTS',
      version: 9,
    });
    // It cannot be removed (never deleted); supersede it so later tests of this file are unaffected by the check.
    expect((await classifications.createClassification(request(unknown.splitId, { supersedes: rows[0].id }), actor)).kind).toBe('CREATED');
  });

  describe('concurrency on the Transaction row (P7-D9)', () => {
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
    const insertSql = `INSERT INTO tax_classification (mre_realm_id, source_type, transaction_split_id, tax_category, treatment, review_state, rule_code, rule_version, created_by)
       VALUES ($1, 'TRANSACTION_SPLIT', $2, 'MAINTENANCE', 'CAPITALIZED', 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x')`;
    /** A reversal of `original` as §35 writes it, in `client`'s open transaction (the mirror and the chain check at commit). */
    async function reverseIn(client: pg.PoolClient, original: string) {
      const { rows } = await client.query(
        `INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by,
           correction_of_transaction_id, correction_role)
         SELECT mre_realm_id, financial_account_id, amount, currency, CASE direction WHEN 'INFLOW' THEN 'OUTFLOW' ELSE 'INFLOW' END, booking_date,
                'CORRECTION', 'CLASSIFIED', 'x', id, 'REVERSAL'
           FROM ledger_transaction WHERE id = $1 RETURNING id`,
        [original],
      );
      await client.query(
        `INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, created_by)
         SELECT $1, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, 'x' FROM transaction_split WHERE transaction_id = $2`,
        [rows[0].id, original],
      );
      await client.query(`UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x' WHERE id = $1`, [rows[0].id]);
      await client.query(`UPDATE ledger_transaction SET status = 'CORRECTED', version = version + 1 WHERE id = $1`, [original]);
    }
    const countCurrent = async (splitId: string) =>
      Number((await pool.query(`SELECT count(*) FROM tax_classification WHERE transaction_split_id = $1 AND superseded_at IS NULL`, [splitId])).rows[0].count);

    it('RC: a create waiting on a correction in flight sees it: SOURCE_NOT_COUNTED (repository and trigger)', async () => {
      for (const path of ['repository', 'trigger'] as const) {
        const { tx, splitId } = await oneSplit();
        const holder = await pool.connect();
        try {
          await holder.query('BEGIN');
          await reverseIn(holder, tx);
          const creating =
            path === 'repository'
              ? classifications.createClassification(request(splitId), actor)
              : pool.query(insertSql, [REALM, splitId]).then(() => 'accepted', reasonOf);
          await waitForLock(path === 'repository' ? 'update "ledger_transaction"' : 'INSERT INTO tax_classification');
          await holder.query('COMMIT');
          expect(await creating, path).toEqual(
            path === 'repository' ? { kind: 'SOURCE_NOT_COUNTED', transactionStatus: 'CORRECTED', correctionRole: null } : '(SOURCE_NOT_COUNTED)',
          );
          expect(await countCurrent(splitId)).toBe(0);
        } finally {
          holder.release();
        }
      }
    });

    it('RC: a correction waiting on a create in flight proceeds; the classification stays on the CORRECTED split, flagged', async () => {
      const { tx, splitId } = await oneSplit();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(insertSql, [REALM, splitId]);
        const correcting = corrections.correct(tx, REALM, { reason: 'Beschreibung', replacement: { description: 'neu' } }, actor);
        await waitForLock('"ledger_transaction"');
        await holder.query('COMMIT');
        const corrected = await correcting;
        if (corrected.kind !== 'CORRECTED' || corrected.result.replacement === null) throw new Error(corrected.kind);
        expect(await classifications.findTaxMeaning(splitId, REALM, today)).toMatchObject({ origin: 'CLASSIFICATION', counts: false });
        const { rows } = await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1`, [corrected.result.replacement.id]);
        expect((await classifications.findTaxMeaning(rows[0].id, REALM, today))?.flags.map((f) => f.code)).toEqual(['CLASSIFICATION_ON_CORRECTED_SPLIT']);
      } finally {
        holder.release();
      }
    });

    it('RR: a create and a correction of the Transaction, both orders: the later one fails to serialise', async () => {
      for (const first of ['create', 'correction'] as const) {
        const { tx, splitId } = await oneSplit();
        const [a, b] = [await pool.connect(), await pool.connect()];
        try {
          await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await a.query('SELECT count(*) FROM ledger_transaction');
          await b.query('SELECT count(*) FROM tax_classification');
          if (first === 'create') await a.query(insertSql, [REALM, splitId]);
          else await reverseIn(a, tx);
          const late = (
            first === 'create'
              ? b.query(`UPDATE ledger_transaction SET status = 'CORRECTED', version = version + 1 WHERE id = $1`, [tx])
              : b.query(insertSql, [REALM, splitId])
          ).then(
            () => 'written',
            (error: { code?: string }) => error.code,
          );
          await waitForLock(first === 'create' ? `UPDATE ledger_transaction SET status = 'CORRECTED'` : 'INSERT INTO tax_classification');
          await a.query('COMMIT');
          expect(await late, first).toBe('40001');
          await b.query('ROLLBACK');
        } finally {
          a.release();
          b.release();
        }
      }
    });

    it('two creates for one split: RC the second sees CLASSIFICATION_EXISTS; RR it fails to serialise; never two current', async () => {
      const rc = await oneSplit();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        const { rows } = await holder.query(`${insertSql} RETURNING id`, [REALM, rc.splitId]);
        const creating = classifications.createClassification(request(rc.splitId), actor);
        await waitForLock('update "ledger_transaction"');
        await holder.query('COMMIT');
        expect(await creating).toEqual({ kind: 'CLASSIFICATION_EXISTS', currentClassificationId: rows[0].id });
        expect(await countCurrent(rc.splitId)).toBe(1);
      } finally {
        holder.release();
      }
      const rr = await oneSplit();
      const [a, b] = [await pool.connect(), await pool.connect()];
      try {
        await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await a.query('SELECT count(*) FROM tax_classification');
        await b.query('SELECT count(*) FROM tax_classification');
        await a.query(insertSql, [REALM, rr.splitId]);
        const late = b.query(insertSql, [REALM, rr.splitId]).then(
          () => 'written',
          (error: { code?: string }) => error.code,
        );
        await waitForLock('INSERT INTO tax_classification');
        await a.query('COMMIT');
        expect(await late).toBe('40001');
        await b.query('ROLLBACK');
        expect(await countCurrent(rr.splitId)).toBe(1);
      } finally {
        a.release();
        b.release();
      }
    });
  });
});
