import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SplitInput } from '../../domains/ledger/index.js';
import type { NewTaxClassification, TaxListItem, WegTaxMeaning } from '../../domains/taxation/index.js';
import { RuleRegistry, TAX_RULES } from '../../domains/taxation/index.js';
import { parseMea, type Mea, type NewAnnualStatement, type ReserveLine } from '../../domains/weg/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLandBuildingAllocationRepository } from './land-building-allocation-repository.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import { PostgresPropertyReferenceRepository } from './property-reference-repository.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { checkStoredRuleReferences } from './tax-rule-check.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresWegAnnualStatementRepository } from './weg-annual-statement-repository.js';
import { PostgresWegRepository } from './weg-repository.js';
import { PostgresWegSpecialAssessmentRepository } from './weg-special-assessment-repository.js';

/**
 * VC-7-03 persistence (api-design.md §58B, migration 0047): classifications of reserve withdrawals and Sonderumlage uses
 * (create with its order of checks, supersede, replay, history), a superseded statement, the per-property list with
 * withdrawals, uses and § 82b parts, the anschaffungsnahe check through the repository, every new CHECK and guard past
 * the repository, nothing else written, the VC-X-26 indexes, `down`, the locks under RC and RR, and the start check.
 * Figures and names are synthetic.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee000000000000d1';
const OTHER_REALM = '64b0c0ffee000000000000d2';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2026-10-30');
const AT = new Date('2026-10-30T10:00:00Z');
const UNKNOWN = '00000000-0000-4000-8000-000000000000';
const codes = (flags: readonly { code: string }[] | undefined) => (flags ?? []).map((f) => f.code);
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

function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return error.constraint ?? /\(([A-Z_]+)\)|never change/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error';
}

describe.skipIf(databaseUrl === undefined)('WEG spending, Erhaltungsaufwand and § 82b (§58B)', () => {
  const schema = testSchemaName('tax_weg_test');
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let classifications: PostgresTaxClassificationRepository;
  let wegs: PostgresWegRepository;
  let statements: PostgresWegAnnualStatementRepository;
  let assessments: PostgresWegSpecialAssessmentRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let acquisitions: PostgresAcquisitionRepository;
  let allocations: PostgresLandBuildingAllocationRepository;
  let parties: PostgresPartyRepository;
  let giro = '';

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    db = createDatabase(pool);
    classifications = new PostgresTaxClassificationRepository(db);
    wegs = new PostgresWegRepository(db);
    statements = new PostgresWegAnnualStatementRepository(db);
    assessments = new PostgresWegSpecialAssessmentRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    acquisitions = new PostgresAcquisitionRepository(db);
    allocations = new PostgresLandBuildingAllocationRepository(db);
    parties = new PostgresPartyRepository(db);
    const created = await new PostgresFinancialAccountRepository(db).create(
      { mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    giro = created.account.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function propertyReference(realm = REALM) {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fd0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  /** A WEG with a membership of MEA 125/1000 on a new PropertyReference. */
  async function member(options: { realm?: string; startMonth?: number; pr?: string } = {}) {
    const realm = options.realm ?? REALM;
    const weg = await wegs.createWeg(
      { mreRealmId: realm, displayName: `WEG ${++counter}`, administratorPartyId: null, financialYearStartMonth: options.startMonth ?? 1, notes: null },
      actor,
    );
    if (weg.kind !== 'CREATED') throw new Error(weg.kind);
    const pr = options.pr ?? (await propertyReference(realm));
    const m = await wegs.createMembership(
      {
        mreRealmId: realm,
        wegId: weg.weg.id,
        propertyReferenceId: pr,
        mea: (parseMea('125/1000') as { mea: Mea }).mea,
        validFrom: day('2020-01-01'),
        validUntil: null,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (m.kind !== 'CREATED') throw new Error(m.kind);
    return { pr, membershipId: m.membership.id };
  }
  const line = (position: number, kind: ReserveLine['kind'], withdrawal: string | null, date: string | null = null): ReserveLine => ({
    position,
    description: `Linie ${position}`,
    kind,
    opening: null,
    addition: null,
    withdrawal: withdrawal === null ? null : eur(withdrawal),
    closing: null,
    date: date === null ? null : day(date),
  });
  const newStatement = (membershipId: string, overrides: Partial<NewAnnualStatement> = {}, realm = REALM): NewAnnualStatement => ({
    mreRealmId: realm,
    membershipId,
    financialYear: 2026,
    periodFrom: day('2026-01-01'),
    periodUntil: day('2026-12-31'),
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
        totalAmount: eur('8000.00'),
        unitShare: eur('1000.00'),
        classification: null,
      },
    ],
    recoverableSubtotal: eur('1000.00'),
    nonRecoverableSubtotal: eur('0.00'),
    totalCosts: eur('1000.00'),
    hausgeldRequested: eur('1000.00'),
    hausgeldPaid: eur('1000.00'),
    reserveRequested: null,
    reservePaid: null,
    settlementPeak: eur('0.00'),
    settlementResult: null,
    // Position 1: 8,000.00 on 15.06.2026 → 1,000.00; position 2: undated 4,000.00 → 500.00; position 3: a contribution.
    reserve: {
      source: 'ANNUAL_STATEMENT',
      lines: [line(1, 'WITHDRAWAL', '8000.00', '2026-06-15'), line(2, 'WITHDRAWAL', '4000.00'), line(3, 'CONTRIBUTION', null)],
      unitShareOpening: null,
      unitShareClosing: null,
    },
    sourceReferences: [],
    notes: null,
    ...overrides,
  });
  async function statement(membershipId: string, overrides: Partial<NewAnnualStatement> = {}, confirm = true, realm = REALM) {
    const created = await statements.createStatement(newStatement(membershipId, overrides, realm), actor);
    if (created.kind !== 'CREATED') throw new Error(JSON.stringify(created));
    if (confirm) {
      const confirmed = await statements.confirmStatement(created.statement.id, realm, AT, actor);
      if (confirmed.kind !== 'CONFIRMED') throw new Error(JSON.stringify(confirmed));
    }
    return created.statement.id;
  }
  async function assessment(membershipId: string, uses: { position: number; date: string; unitShare: string }[], realm = REALM) {
    const created = await assessments.createAssessment(
      {
        mreRealmId: realm,
        membershipId,
        description: 'Fassade',
        resolutionDate: day('2026-02-10'),
        purpose: 'MAINTENANCE',
        totalAmount: null,
        unitShare: eur('20000.00'),
        instalments: [{ position: 1, dueDate: day('2026-03-01'), amount: eur('20000.00') }],
        sourceReferences: [],
        notes: null,
      },
      actor,
      today,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const id = created.assessment.id;
    if (uses.length > 0) {
      const replaced = await assessments.replaceUses(
        id,
        realm,
        uses.map((u) => ({ position: u.position, date: day(u.date), description: `Verwendung ${u.position}`, unitShare: eur(u.unitShare) })),
        actor,
        today,
      );
      if (replaced.kind !== 'AMENDED') throw new Error(replaced.kind);
    }
    return id;
  }
  const request = (
    sourceType: 'WEG_RESERVE_WITHDRAWAL' | 'WEG_ASSESSMENT_USE',
    sourceId: string,
    sourcePosition: number,
    overrides: Partial<NewTaxClassification> = {},
  ): NewTaxClassification => ({
    mreRealmId: REALM,
    sourceType,
    sourceId,
    sourcePosition,
    taxCategory: 'WEG_SPENDING',
    treatment: 'DEDUCTIBLE',
    reviewState: 'USER_CONFIRMED',
    supersedes: null,
    notes: null,
    sourceReferences: [],
    ...overrides,
  });
  const split = (amount: string, code: string, pr: string | null): SplitInput => ({
    amount: eur(amount),
    financialCategoryCode: code,
    propertyReferenceId: pr,
    loanId: null,
    securityDepositId: null,
    description: null,
  });
  async function booked(set: SplitInput[], bookingDate: string, direction: 'INFLOW' | 'OUTFLOW' = 'OUTFLOW') {
    const total = set.reduce((sum, s) => sum.add(s.amount), eur('0.00'));
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: giro,
        amount: total,
        direction,
        bookingDate: day(bookingDate),
        valueDate: null,
        description: 'x',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const outcome = await splits.replaceSplits(created.transaction.id, REALM, set, actor);
    if (outcome.kind !== 'REPLACED') throw new Error(JSON.stringify(outcome));
    expect((await transactions.confirm(created.transaction.id, REALM, actor)).kind).toBe('CONFIRMED');
    const { rows } = await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [created.transaction.id]);
    return { tx: created.transaction.id, splitIds: rows.map((r) => r.id as string) };
  }
  async function party(name: string) {
    const p = await parties.create(
      {
        mreRealmId: REALM,
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
    if (p.kind !== 'CREATED') throw new Error(p.kind);
    return p.party.id;
  }
  /** A confirmed Acquisition of `pr` (transfer 15.03.2026, price 240,000.00) with its Ownership and a confirmed allocation (198,000 of 264,000). */
  async function acquisition(pr: string, options: { transfer?: string; confirm?: boolean } = {}) {
    const transfer = options.transfer ?? '2026-03-15';
    const buyer = await party('Anna');
    const created = await acquisitions.create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        purchasePrice: eur('240000.00'),
        acquiredShare: { numerator: 1, denominator: 1 },
        contractDate: day(transfer),
        economicTransferDate: day(transfer),
        landRegistryTransferDate: null,
        buyerPartyIds: [buyer],
        sellerPartyIds: [],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const id = created.acquisition.id;
    await pool.query(
      `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, acquisition_id, created_by)
       VALUES ($1, $2, $3, 1, 1, $4, 'VALID', $5, 'x')`,
      [REALM, pr, buyer, transfer, id],
    );
    if (options.confirm !== false) {
      const confirmed = await acquisitions.confirm(id, REALM, AT, actor);
      if (confirmed.kind !== 'CONFIRMED') throw new Error(JSON.stringify(confirmed));
      const allocated = await allocations.create(
        {
          mreRealmId: REALM,
          acquisitionId: id,
          totalAllocableAmount: eur('264000.00'),
          landAmount: eur('66000.00'),
          buildingAmount: eur('198000.00'),
          method: 'PURCHASE_CONTRACT',
          reviewState: 'CONFIRMED',
          effectiveDate: null,
          advisorPartyId: null,
          sourceReferences: [],
          notes: null,
          supersedes: null,
        },
        actor,
      );
      if (allocated.kind !== 'CREATED') throw new Error(allocated.kind);
    }
    return id;
  }
  const withdrawalMeaning = (statementId: string, position: number) => classifications.findWithdrawalTaxMeaning(statementId, position, REALM, today);
  const useMeaning = (assessmentId: string, position: number) => classifications.findUseTaxMeaning(assessmentId, position, REALM, today);
  const list = (pr: string, year: number, sourceTypes?: NewTaxClassification['sourceType'][]) =>
    classifications.listTaxMeanings(pr, REALM, year, sourceTypes === undefined ? {} : { sourceTypes }, { page: 1, pageSize: 200 }, today);
  const keys = (items: readonly TaxListItem[] | undefined) =>
    (items ?? []).map((m) => `${m.sourceType}:${'sourcePosition' in m ? m.sourcePosition : '-'}:${m.yearAmount.amount}`);

  describe('a reserve withdrawal (§58B)', () => {
    it('its meaning: unit share, own date or the period end assumed; NOT_A_WITHDRAWAL; 404 for no line or another Realm', async () => {
      const { membershipId } = await member();
      const st = await statement(membershipId);
      expect(await withdrawalMeaning(st, 1)).toMatchObject({
        amount: eur('1000.00'),
        date: '2026-06-15',
        dateSource: 'WITHDRAWAL',
        counts: true,
        taxYear: 2026,
        taxCategory: 'UNCLASSIFIED',
        reviewState: 'NEEDS_REVIEW',
        origin: 'DEFAULT',
        rule: { ruleCode: 'DE_WEG_SPENDING', version: 1 },
      });
      const undated = await withdrawalMeaning(st, 2);
      expect(undated).toMatchObject({ amount: eur('500.00'), date: '2026-12-31', dateSource: 'PERIOD_END' });
      expect(codes(undated?.flags)).toEqual(['WITHDRAWAL_DATE_ASSUMED']);
      expect(await withdrawalMeaning(st, 3)).toMatchObject({ counts: false, notCountedReason: 'NOT_A_WITHDRAWAL' });
      expect(await withdrawalMeaning(st, 4)).toBeUndefined();
      expect(await classifications.findWithdrawalTaxMeaning(st, 1, OTHER_REALM, today)).toBeUndefined();
      expect(await withdrawalMeaning(UNKNOWN, 1)).toBeUndefined();
    });

    it('create: the order of checks, supersede, replay, the history by position, the AuditRecord; nothing else written', async () => {
      const { membershipId } = await member();
      const draft = await statement(membershipId, {}, false);
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', UNKNOWN, 1), actor)).toEqual({ kind: 'SOURCE_NOT_FOUND' });
      expect(await classifications.createClassification({ ...request('WEG_RESERVE_WITHDRAWAL', draft, 1), mreRealmId: OTHER_REALM }, actor)).toEqual({
        kind: 'SOURCE_NOT_FOUND',
      });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', draft, 9), actor)).toEqual({ kind: 'SOURCE_NOT_FOUND' });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', draft, 1), actor)).toMatchObject({
        kind: 'WEG_SOURCE_NOT_COUNTED',
        reason: 'STATEMENT_NOT_CONFIRMED',
        details: { status: 'DRAFT' },
      });
      const st = await statement((await member()).membershipId);
      const before = (await pool.query(`SELECT version, reserve, status FROM weg_annual_statement WHERE id = $1`, [st])).rows[0];
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 3), actor)).toMatchObject({
        kind: 'WEG_SOURCE_NOT_COUNTED',
        reason: 'NOT_A_WITHDRAWAL',
      });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1, { taxCategory: 'MAINTENANCE' }), actor)).toMatchObject({
        kind: 'TREATMENT_NOT_ALLOWED',
        sourceType: 'WEG_RESERVE_WITHDRAWAL',
      });
      expect(
        await classifications.createClassification(
          request('WEG_RESERVE_WITHDRAWAL', st, 1, { treatment: 'DISTRIBUTED_82B', distributionYears: 3, mostlyResidentialConfirmed: false }),
          actor,
        ),
      ).toEqual({ kind: 'DISTRIBUTION_NOT_ALLOWED', reason: 'NOT_MOSTLY_RESIDENTIAL' });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1, { netAmount: eur('1000.01') }), actor)).toEqual({
        kind: 'NET_AMOUNT_EXCEEDS_GROSS',
        netAmount: eur('1000.01'),
        grossAmount: eur('1000.00'),
      });
      expect(
        await classifications.createClassification(
          request('WEG_RESERVE_WITHDRAWAL', st, 1, { treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: UNKNOWN }),
          actor,
        ),
      ).toEqual({ kind: 'ACQUISITION_NOT_FOUND', acquisitionId: UNKNOWN });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1, { taxYear: 2026 }), actor)).toEqual({
        kind: 'FIELD_NOT_SUPPORTED',
        field: 'taxYear',
      });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 2, { taxYear: 2027 }), actor)).toEqual({
        kind: 'WITHDRAWAL_TAX_YEAR_OUT_OF_RANGE',
        taxYear: 2027,
        allowedYears: [2026],
      });
      const key = { key: `k-${++counter}`, fingerprint: 'f' };
      const first = await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1, { netAmount: eur('840.34') }), actor, key);
      expect(first).toMatchObject({
        kind: 'CREATED',
        classification: {
          sourceType: 'WEG_RESERVE_WITHDRAWAL',
          sourceId: st,
          sourcePosition: 1,
          reserveWithdrawal: { unitShare: eur('1000.00') },
          netAmount: eur('840.34'),
          rule: { ruleCode: 'DE_WEG_SPENDING', version: 1 },
          treatmentRule: null,
        },
      });
      if (first.kind !== 'CREATED') return;
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1, { netAmount: eur('840.34') }), actor, key)).toMatchObject({
        kind: 'REPLAYED',
        classification: { id: first.classification.id, netAmount: eur('840.34'), sourcePosition: 1 },
      });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1), actor)).toEqual({
        kind: 'CLASSIFICATION_EXISTS',
        currentClassificationId: first.classification.id,
      });
      const second = await classifications.createClassification(
        request('WEG_RESERVE_WITHDRAWAL', st, 1, {
          treatment: 'DISTRIBUTED_82B',
          distributionYears: 2,
          mostlyResidentialConfirmed: true,
          supersedes: first.classification.id,
        }),
        actor,
      );
      expect(second).toMatchObject({
        kind: 'CREATED',
        classification: { treatmentRule: { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 }, distributionYears: 2 },
      });
      const history = await classifications.listHistory('WEG_RESERVE_WITHDRAWAL', st, REALM, 1);
      expect(history?.map((c) => [c.treatment, c.supersededBy === null])).toEqual([
        ['DEDUCTIBLE', false],
        ['DISTRIBUTED_82B', true],
      ]);
      expect(await classifications.listHistory('WEG_RESERVE_WITHDRAWAL', st, REALM, 2)).toEqual([]);
      expect(await classifications.listHistory('WEG_RESERVE_WITHDRAWAL', st, OTHER_REALM, 1)).toBeUndefined();
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'TAX_CLASSIFIED'`, [
        second.kind === 'CREATED' ? second.classification.id : '',
      ]);
      expect(audit.rows[0].metadata).toMatchObject({
        sourcePosition: 1,
        distributionYears: 2,
        mostlyResidentialConfirmed: true,
        treatmentRule: { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 },
      });
      // Nothing else written: the statement row and its version unchanged (the lock is a no-op write).
      expect((await pool.query(`SELECT version, reserve, status FROM weg_annual_statement WHERE id = $1`, [st])).rows[0]).toEqual(before);
      const meaning = (await withdrawalMeaning(st, 1)) as WegTaxMeaning;
      expect(meaning.distribution?.parts.map((p) => [p.year, p.amount.amount])).toEqual([
        [2026, '500.00'],
        [2027, '500.00'],
      ]);
    });

    it('a superseded statement: its classification stops counting; the successor reads the default with PREDECESSOR_CLASSIFIED; the list holds only the new', async () => {
      const { pr, membershipId } = await member();
      const st = await statement(membershipId);
      const c1 = await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1), actor);
      const c2 = await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 2), actor);
      expect([c1.kind, c2.kind]).toEqual(['CREATED', 'CREATED']);
      expect(keys((await list(pr, 2026, ['WEG_RESERVE_WITHDRAWAL']))?.items)).toEqual(['WEG_RESERVE_WITHDRAWAL:1:1000.00', 'WEG_RESERVE_WITHDRAWAL:2:500.00']);
      const corrected = await statement(membershipId, {
        supersedes: st,
        reserve: { source: 'ANNUAL_STATEMENT', lines: [line(1, 'WITHDRAWAL', '8800.00', '2026-06-20')], unitShareOpening: null, unitShareClosing: null },
      });
      expect(await withdrawalMeaning(st, 1)).toMatchObject({ counts: false, notCountedReason: 'STATEMENT_SUPERSEDED', origin: 'CLASSIFICATION' });
      const successor = await withdrawalMeaning(corrected, 1);
      expect(successor).toMatchObject({ counts: true, origin: 'DEFAULT', reviewState: 'NEEDS_REVIEW', amount: eur('1100.00') });
      expect(successor?.flags).toContainEqual({
        code: 'PREDECESSOR_CLASSIFIED',
        details: {
          statementId: st,
          classificationIds: [c1, c2].map((c) => (c.kind === 'CREATED' ? c.classification.id : '')).sort(),
        },
      });
      expect(keys((await list(pr, 2026))?.items)).toEqual(['WEG_RESERVE_WITHDRAWAL:1:1100.00']);
      expect(
        await classifications.createClassification(
          request('WEG_RESERVE_WITHDRAWAL', st, 1, { supersedes: c1.kind === 'CREATED' ? c1.classification.id : null }),
          actor,
        ),
      ).toMatchObject({
        kind: 'WEG_SOURCE_NOT_COUNTED',
        reason: 'STATEMENT_SUPERSEDED',
      });
      // The history of the old one stays readable.
      expect(await classifications.listHistory('WEG_RESERVE_WITHDRAWAL', st, REALM, 1)).toHaveLength(1);
    });
  });

  describe('a Sonderumlage use (§58B)', () => {
    it('counts; a replace changing it stops the classification (USE_CHANGED); a dropped use answers 404 with its history kept; a void stops it', async () => {
      const { membershipId } = await member();
      const a = await assessment(membershipId, [
        { position: 1, date: '2026-09-01', unitShare: '3000.00' },
        { position: 2, date: '2027-02-01', unitShare: '2000.00' },
      ]);
      expect(await useMeaning(a, 1)).toMatchObject({ amount: eur('3000.00'), date: '2026-09-01', dateSource: 'USE', taxYear: 2026, counts: true });
      expect(codes((await useMeaning(a, 1))?.flags)).toEqual(['USES_EXCEED_PAID']);
      const c = await classifications.createClassification(request('WEG_ASSESSMENT_USE', a, 1), actor);
      expect(c).toMatchObject({ kind: 'CREATED', classification: { assessmentUse: { date: '2026-09-01', unitShare: eur('3000.00') }, taxYear: null } });
      const replace = (uses: { position: number; date: string; unitShare: string; description?: string }[]) =>
        assessments.replaceUses(
          a,
          REALM,
          uses.map((u) => ({ position: u.position, date: day(u.date), description: u.description ?? `Verwendung ${u.position}`, unitShare: eur(u.unitShare) })),
          actor,
          today,
        );
      await replace([
        { position: 1, date: '2026-09-01', unitShare: '3000.00', description: 'neu beschrieben' },
        { position: 2, date: '2027-02-01', unitShare: '2000.00' },
      ]);
      expect(await useMeaning(a, 1)).toMatchObject({ counts: true, origin: 'CLASSIFICATION' });
      await replace([
        { position: 1, date: '2026-09-02', unitShare: '3000.00' },
        { position: 2, date: '2027-02-01', unitShare: '2000.00' },
      ]);
      expect(await useMeaning(a, 1)).toMatchObject({ counts: false, notCountedReason: 'USE_CHANGED', origin: 'CLASSIFICATION' });
      const id = c.kind === 'CREATED' ? c.classification.id : '';
      expect(await classifications.reviewClassification(id, REALM, { kind: 'CONFIRM' }, actor)).toMatchObject({
        kind: 'WEG_SOURCE_NOT_COUNTED',
        reason: 'USE_CHANGED',
      });
      const again = await classifications.createClassification(request('WEG_ASSESSMENT_USE', a, 1, { supersedes: id }), actor);
      expect(again).toMatchObject({ kind: 'CREATED', classification: { assessmentUse: { date: '2026-09-02' } } });
      await replace([{ position: 2, date: '2027-02-01', unitShare: '2000.00' }]);
      expect(await useMeaning(a, 1)).toBeUndefined();
      expect(await classifications.listHistory('WEG_ASSESSMENT_USE', a, REALM, 1)).toHaveLength(2);
      expect(await classifications.createClassification(request('WEG_ASSESSMENT_USE', a, 1), actor)).toEqual({ kind: 'SOURCE_NOT_FOUND' });
      const voided = await assessments.voidAssessment(a, REALM, 'falsch', AT, actor, today);
      expect(voided.kind).toBe('VOIDED');
      expect(await useMeaning(a, 2)).toMatchObject({ counts: false, notCountedReason: 'ASSESSMENT_VOID' });
      expect(await classifications.createClassification(request('WEG_ASSESSMENT_USE', a, 2), actor)).toMatchObject({
        kind: 'WEG_SOURCE_NOT_COUNTED',
        reason: 'ASSESSMENT_VOID',
      });
    });
  });

  describe('the per-property list (§58B)', () => {
    it('withdrawals and uses of the year, a § 82b source of an earlier year with its part; the order; the sourceType filter; never a cost line', async () => {
      const { pr, membershipId } = await member();
      const st = await statement(membershipId);
      const a = await assessment(membershipId, [{ position: 1, date: '2026-06-15', unitShare: '900.00' }]);
      const { splitIds } = await booked([split('9000.00', 'MAINTENANCE', pr), split('300.00', 'WEG_RESERVE_CONTRIBUTION', pr)], '2026-06-15');
      const election = await classifications.createClassification(
        {
          mreRealmId: REALM,
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: splitIds[0] as string,
          taxCategory: 'MAINTENANCE',
          treatment: 'DISTRIBUTED_82B',
          reviewState: 'USER_CONFIRMED',
          supersedes: null,
          notes: null,
          sourceReferences: [],
          distributionYears: 3,
          mostlyResidentialConfirmed: true,
        },
        actor,
      );
      expect(election.kind).toBe('CREATED');
      // On 15.06.2026: the splits first, then the withdrawal, then the use.
      expect(keys((await list(pr, 2026))?.items)).toEqual([
        'TRANSACTION_SPLIT:-:3000.00',
        'TRANSACTION_SPLIT:-:300.00',
        'WEG_RESERVE_WITHDRAWAL:1:1000.00',
        'WEG_ASSESSMENT_USE:1:900.00',
        'WEG_RESERVE_WITHDRAWAL:2:500.00',
      ]);
      expect(keys((await list(pr, 2027))?.items)).toEqual(['TRANSACTION_SPLIT:-:3000.00']);
      expect(keys((await list(pr, 2028))?.items)).toEqual(['TRANSACTION_SPLIT:-:3000.00']);
      expect(keys((await list(pr, 2029))?.items)).toEqual([]);
      expect(keys((await list(pr, 2026, ['WEG_ASSESSMENT_USE']))?.items)).toEqual(['WEG_ASSESSMENT_USE:1:900.00']);
      // The WEG_FUNDS split stays NOT_RELEVANT; no cost line is listed.
      const items = (await list(pr, 2026))?.items ?? [];
      expect(items.find((m) => m.sourceType === 'TRANSACTION_SPLIT' && m.financialCategoryCode === 'WEG_RESERVE_CONTRIBUTION')).toMatchObject({
        taxCategory: 'NOT_RELEVANT',
        treatment: 'NOT_RELEVANT',
      });
      // The statement's cost line (unit share 1,000.00, Hausmeister) is in none of the items: they are the five above.
      expect(items).toHaveLength(5);
      expect(items.filter((m) => m.sourceType === 'WEG_RESERVE_WITHDRAWAL').map((m) => m.sourceId)).toEqual([st, st]);
      expect(items.filter((m) => m.sourceType === 'WEG_ASSESSMENT_USE').map((m) => m.sourceId)).toEqual([a]);
    });
  });

  describe('the anschaffungsnahe check through the repository (§58B)', () => {
    it('a split and a use in the window, above 15 %; flagged in their meanings; a CANCELLED Acquisition left to the use case', async () => {
      const pr = await propertyReference();
      const { membershipId } = await member({ pr });
      const acq = await acquisition(pr);
      const { splitIds } = await booked([split('18000.00', 'MAINTENANCE', pr)], '2026-05-14');
      const repair = await classifications.createClassification(
        {
          mreRealmId: REALM,
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: splitIds[0] as string,
          taxCategory: 'MAINTENANCE',
          treatment: 'DEDUCTIBLE',
          reviewState: 'USER_CONFIRMED',
          supersedes: null,
          notes: null,
          sourceReferences: [],
          netAmount: eur('15126.05'),
        },
        actor,
      );
      expect(repair.kind).toBe('CREATED');
      const a = await assessment(membershipId, [{ position: 1, date: '2027-06-10', unitShare: '14800.00' }]);
      await classifications.createClassification(request('WEG_ASSESSMENT_USE', a, 1), actor);
      const check = await classifications.anschaffungsnaheCheck(acq, REALM, today);
      // No acquisition costs here: basis 240,000 × 198,000 / 264,000 = 180,000.00, threshold 27,000.00.
      expect(check).toMatchObject({ status: 'ABOVE_THRESHOLD', threshold: '27000.00', sum: eur('29926.05'), affectedYears: [2026, 2027], final: false });
      expect(codes((await classifications.findTaxMeaning(splitIds[0] as string, REALM, today))?.flags)).toContain('ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN');
      expect(await useMeaning(a, 1)).toMatchObject({
        treatment: 'DEDUCTIBLE',
        suggestion: { treatment: 'CAPITALIZED', reason: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', acquisitionIds: [acq], final: false },
      });
      expect(await classifications.anschaffungsnaheCheck(acq, OTHER_REALM, today)).toBeUndefined();
      // The capitalisation following the check names the Acquisition; outside the window it is refused.
      const outside = await assessment(membershipId, [{ position: 1, date: '2029-03-16', unitShare: '100.00' }]);
      expect(
        await classifications.createClassification(
          request('WEG_ASSESSMENT_USE', outside, 1, { treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: acq }),
          actor,
        ),
      ).toEqual({ kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE', reason: 'OUTSIDE_WINDOW', acquisitionId: acq });
      const other = await member();
      const foreignUse = await assessment(other.membershipId, [{ position: 1, date: '2027-01-01', unitShare: '100.00' }]);
      expect(
        await classifications.createClassification(
          request('WEG_ASSESSMENT_USE', foreignUse, 1, { treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: acq }),
          actor,
        ),
      ).toMatchObject({ reason: 'OTHER_PROPERTY_REFERENCE' });
      // Nothing written on the Acquisition or its allocation.
      expect((await pool.query(`SELECT version FROM acquisition WHERE id = $1`, [acq])).rows[0].version).toBe(2);
    });
  });

  /** A confirmed MAINTENANCE split of 900.00 in a schema of its own (the start check and `down`). */
  async function confirmedSplitIn(target: pg.Pool): Promise<string> {
    const targetDb = createDatabase(target);
    const pr = (
      await target.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f6aa01', 'ACTIVE', 'x') RETURNING id`,
        [REALM],
      )
    ).rows[0].id as string;
    const account = (
      await target.query(
        `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, status, created_by) VALUES ($1, 'BANK', 'G', 'EUR', 'OPEN', 'x') RETURNING id`,
        [REALM],
      )
    ).rows[0].id as string;
    const targetTransactions = new PostgresTransactionRepository(targetDb);
    const created = await targetTransactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: account,
        amount: eur('900.00'),
        direction: 'OUTFLOW',
        bookingDate: day('2026-06-01'),
        valueDate: null,
        description: 'x',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    await new PostgresTransactionSplitRepository(targetDb).replaceSplits(created.transaction.id, REALM, [split('900.00', 'MAINTENANCE', pr)], actor);
    await targetTransactions.confirm(created.transaction.id, REALM, actor);
    return (await target.query(`SELECT id FROM transaction_split`)).rows[0].id as string;
  }

  describe('schema past the repository (0047)', () => {
    const insert = (values: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        mre_realm_id: REALM,
        tax_category: 'WEG_SPENDING',
        treatment: 'DEDUCTIBLE',
        review_state: 'USER_CONFIRMED',
        rule_code: 'DE_WEG_SPENDING',
        rule_version: 1,
        created_by: 'x',
        ...values,
      };
      const columns = Object.keys(row);
      return pool
        .query(
          `INSERT INTO tax_classification (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          Object.values(row),
        )
        .then(
          (r) => r.rows[0].id as string,
          (error) => reasonOf(error),
        );
    };
    const withdrawalRow = (st: string, position: number, share: string, extra: Record<string, unknown> = {}) =>
      insert({
        source_type: 'WEG_RESERVE_WITHDRAWAL',
        weg_annual_statement_id: st,
        weg_reserve_position: position,
        weg_withdrawal_unit_share: share,
        ...extra,
      });
    const useRow = (a: string, position: number, date: string, share: string, extra: Record<string, unknown> = {}) =>
      insert({
        source_type: 'WEG_ASSESSMENT_USE',
        weg_special_assessment_id: a,
        weg_use_position: position,
        weg_use_date: date,
        weg_use_unit_share: share,
        ...extra,
      });

    it('the withdrawal guard: confirmed only, a withdrawal line, the exact unit share (one cent off either way, the half), tax_year of an undated line', async () => {
      const { membershipId } = await member();
      const st = await statement(membershipId, {
        reserve: {
          source: 'ANNUAL_STATEMENT',
          // 0.04 × 125/1000 = 0.005: the exact half, rounded up to 0.01.
          lines: [line(1, 'WITHDRAWAL', '8000.00', '2026-06-15'), line(2, 'WITHDRAWAL', '0.04'), line(3, 'CONTRIBUTION', null)],
          unitShareOpening: null,
          unitShareClosing: null,
        },
      });
      expect(await withdrawalRow(st, 1, '999.99')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await withdrawalRow(st, 1, '1000.01')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await withdrawalRow(st, 3, '1.00')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await withdrawalRow(st, 9, '1.00')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await withdrawalRow(st, 1, '1000.00', { tax_year: 2026 })).toBe('(TAX_YEAR_OUT_OF_RANGE)');
      expect(await withdrawalRow(st, 2, '0.01', { tax_year: 2025 })).toBe('(TAX_YEAR_OUT_OF_RANGE)');
      expect(await withdrawalRow(st, 2, '0.01', { tax_year: 2026 })).toMatch(/^[0-9a-f-]{36}$/);
      expect(await withdrawalRow(st, 1, '1000.00')).toMatch(/^[0-9a-f-]{36}$/);
      expect(await withdrawalRow(st, 1, '1000.00')).toBe('tax_classification_current_withdrawal');
      const draft = await statement((await member()).membershipId, {}, false);
      expect(await withdrawalRow(draft, 1, '1000.00')).toBe('(SOURCE_NOT_COUNTED)');
      const foreign = await statement((await member({ realm: OTHER_REALM })).membershipId, {}, true, OTHER_REALM);
      expect(await withdrawalRow(foreign, 1, '1000.00')).toBe('tax_classification_statement_fk');
      // A superseded statement takes none.
      const { membershipId: m2 } = await member();
      const old = await statement(m2);
      await statement(m2, { supersedes: old });
      expect(await withdrawalRow(old, 1, '1000.00')).toBe('(SOURCE_NOT_COUNTED)');
    });

    it('the lines (DE_WEG_SPENDING@1), the fit, the distribution, the fields; the use guard; net above gross on each source; the split guard', async () => {
      const { pr, membershipId } = await member();
      const st = await statement(membershipId);
      expect(await withdrawalRow(st, 1, '1000.00', { tax_category: 'NOT_RELEVANT', treatment: 'DEDUCTIBLE' })).toBe('tax_classification_fit');
      expect(await withdrawalRow(st, 1, '1000.00', { tax_category: 'MAINTENANCE' })).toBe('tax_classification_weg_lines');
      expect(
        await withdrawalRow(st, 1, '1000.00', {
          treatment: 'DISTRIBUTED_82B',
          distribution_years: 1,
          mostly_residential_confirmed: true,
          treatment_rule_code: 'DE_82B_DISTRIBUTION',
          treatment_rule_version: 1,
        }),
      ).toBe('tax_classification_distribution');
      expect(
        await withdrawalRow(st, 1, '1000.00', {
          treatment: 'DISTRIBUTED_82B',
          distribution_years: 6,
          mostly_residential_confirmed: true,
          treatment_rule_code: 'DE_82B_DISTRIBUTION',
          treatment_rule_version: 1,
        }),
      ).toBe('tax_classification_distribution');
      expect(
        await withdrawalRow(st, 1, '1000.00', {
          treatment: 'DISTRIBUTED_82B',
          distribution_years: 3,
          treatment_rule_code: 'DE_82B_DISTRIBUTION',
          treatment_rule_version: 1,
        }),
      ).toBe('tax_classification_distribution');
      expect(await withdrawalRow(st, 1, '1000.00', { treatment: 'DISTRIBUTED_82B', distribution_years: 3, mostly_residential_confirmed: true })).toBe(
        'tax_classification_treatment_rule',
      );
      expect(await withdrawalRow(st, 1, '1000.00', { net_amount: '1000.01' })).toBe('tax_classification_erhaltung_fields');
      expect(await withdrawalRow(st, 1, '1000.00', { refund_of_year: 2026 })).toBe('tax_classification_weg_source_fields');
      const a = await assessment(membershipId, [{ position: 1, date: '2026-09-01', unitShare: '3000.00' }]);
      expect(await useRow(a, 1, '2026-09-02', '3000.00')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await useRow(a, 1, '2026-09-01', '2999.99')).toBe('(SOURCE_NOT_COUNTED)');
      expect(await useRow(a, 1, '2026-09-01', '3000.00', { net_amount: '3000.01' })).toBe('tax_classification_erhaltung_fields');
      expect(await useRow(a, 1, '2026-09-01', '3000.00', { tax_year: 2026 })).toBe('tax_classification_weg_source_fields');
      const ok = await useRow(a, 1, '2026-09-01', '3000.00', { net_amount: '3000.00' });
      expect(ok).toMatch(/^[0-9a-f-]{36}$/);
      expect(await useRow(a, 1, '2026-09-01', '3000.00')).toBe('tax_classification_current_use');
      // A change of a new column.
      expect(await pool.query(`UPDATE tax_classification SET net_amount = 1, version = version + 1 WHERE id = $1`, [ok]).then(() => 'accepted', reasonOf)).toBe(
        'never change',
      );
      // The position without its source (on a split row): the WEG source fields hold together.
      // On a split: WEG_SPENDING refused; net above gross; DISTRIBUTED_82B only on an OUTFLOW; the WEG_FUNDS hard rule.
      const { splitIds } = await booked([split('500.00', 'MAINTENANCE', pr), split('100.00', 'WEG_SPECIAL_ASSESSMENT', pr)], '2026-06-01');
      const [repair, funds] = splitIds as [string, string];
      const splitRow = (splitId: string, extra: Record<string, unknown> = {}) =>
        insert({ source_type: 'TRANSACTION_SPLIT', transaction_split_id: splitId, tax_category: 'MAINTENANCE', rule_code: 'DE_CATEGORY_DEFAULTS', ...extra });
      expect(await splitRow(repair, { tax_category: 'WEG_SPENDING' })).toBe('tax_classification_weg_lines');
      expect(await splitRow(repair, { weg_reserve_position: 1 })).toBe('tax_classification_weg_source_fields');
      expect(await splitRow(repair, { net_amount: '500.01' })).toBe('(NET_AMOUNT_EXCEEDS_GROSS)');
      expect(await splitRow(repair, { annually_recurring: true, tax_category: 'INSURANCE' })).toBe('tax_classification_erhaltung_fields');
      expect(
        await splitRow(repair, {
          tax_category: 'INSURANCE',
          treatment: 'DISTRIBUTED_82B',
          distribution_years: 2,
          mostly_residential_confirmed: true,
          treatment_rule_code: 'DE_82B_DISTRIBUTION',
          treatment_rule_version: 1,
        }),
      ).toBe('tax_classification_fit');
      expect(await splitRow(funds, { tax_category: 'MAINTENANCE', treatment: 'DEDUCTIBLE' })).toBe('(TREATMENT_NOT_ALLOWED)');
      const refund = await booked([split('50.00', 'MAINTENANCE', pr)], '2026-06-02', 'INFLOW');
      expect(
        await splitRow(refund.splitIds[0] as string, {
          treatment: 'DISTRIBUTED_82B',
          distribution_years: 2,
          mostly_residential_confirmed: true,
          treatment_rule_code: 'DE_82B_DISTRIBUTION',
          treatment_rule_version: 1,
        }),
      ).toBe('(DISTRIBUTION_NOT_ALLOWED)');
      expect(await splitRow(repair, { net_amount: '500.00' })).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('the anschaffungsnahe guard: confirmed, the source’s PropertyReference, inside the three years (literally)', async () => {
      const pr = await propertyReference();
      const acq = await acquisition(pr);
      const draftPr = await propertyReference();
      const draft = await acquisition(draftPr, { confirm: false });
      const row = async (date: string, acquisitionId: string, on = pr) => {
        const { splitIds } = await booked([split('100.00', 'MAINTENANCE', on)], date);
        return insert({
          source_type: 'TRANSACTION_SPLIT',
          transaction_split_id: splitIds[0],
          tax_category: 'MAINTENANCE',
          treatment: 'CAPITALIZED',
          rule_code: 'DE_CATEGORY_DEFAULTS',
          anschaffungsnahe_acquisition_id: acquisitionId,
          treatment_rule_code: 'DE_ANSCHAFFUNGSNAHE',
          treatment_rule_version: 1,
        });
      };
      expect(await row('2029-03-16', acq)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
      expect(await row('2026-03-14', acq)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
      expect(await row('2027-01-01', draft, draftPr)).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
      expect(await row('2029-03-15', acq)).toMatch(/^[0-9a-f-]{36}$/);
      const otherPr = await propertyReference();
      const { splitIds } = await booked([split('100.00', 'MAINTENANCE', otherPr)], '2027-01-01');
      expect(
        await insert({
          source_type: 'TRANSACTION_SPLIT',
          transaction_split_id: splitIds[0],
          tax_category: 'MAINTENANCE',
          treatment: 'CAPITALIZED',
          rule_code: 'DE_CATEGORY_DEFAULTS',
          anschaffungsnahe_acquisition_id: acq,
          treatment_rule_code: 'DE_ANSCHAFFUNGSNAHE',
          treatment_rule_version: 1,
        }),
      ).toBe('(ANSCHAFFUNGSNAHE_NOT_APPLICABLE)');
    });

    it('the VC-X-26 indexes serve the first page of both name-ordered lists (the plan)', async () => {
      const sent: CompiledQuery[] = [];
      const logged = new Kysely<Database>({
        dialect: new PostgresDialect({ pool }),
        log: (event) => {
          if (event.level === 'query') sent.push(event.query);
        },
      });
      const realms = 60;
      await pool.query(
        `INSERT INTO financial_account (mre_realm_id, account_type, display_name, currency, status, created_by)
         SELECT 'plan-' || r, 'BANK', 'Konto ' || g, 'EUR', 'OPEN', 'x' FROM generate_series(1, $1::int) r, generate_series(1, 40) g`,
        [realms],
      );
      await pool.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, display_name, created_by)
         SELECT 'plan-' || r, lpad(to_hex(r * 1000 + g), 24, '0'), 'ACTIVE', 'Wohnung ' || g, 'x' FROM generate_series(1, $1::int) r, generate_series(1, 40) g`,
        [realms],
      );
      await pool.query(`ANALYZE financial_account; ANALYZE property_reference`);
      const planOf = async (query: CompiledQuery | undefined) => {
        if (query === undefined) throw new Error('the page query was not sent');
        const { rows } = await pool.query(`EXPLAIN (FORMAT JSON) ${query.sql}`, [...query.parameters]);
        return JSON.stringify(rows[0]['QUERY PLAN']);
      };
      sent.length = 0;
      await new PostgresFinancialAccountRepository(logged).list('plan-7', {}, { page: 1, pageSize: 10 });
      const accountPlan = await planOf(sent.find((q) => q.sql.includes('order by')));
      expect(accountPlan).toContain('financial_account_realm_name_idx');
      expect(accountPlan).not.toContain('"Sort"');
      sent.length = 0;
      await new PostgresPropertyReferenceRepository(logged).list('plan-7', {}, { page: 1, pageSize: 10 });
      const referencePlan = await planOf(sent.find((q) => q.sql.includes('order by')));
      expect(referencePlan).toContain('property_reference_realm_name_idx');
      expect(referencePlan).not.toContain('"Sort"');
    });

    it('the start check resolves the treatmentRule too: a stored unknown one stops the start', async () => {
      const startSchema = testSchemaName('tax_weg_start_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${startSchema}"`);
      await admin.end();
      const startPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${startSchema}`, max: 2 });
      try {
        await migrateToLatest(startPool, { migrationTableSchema: startSchema });
        const startDb = createDatabase(startPool);
        const splitId = await confirmedSplitIn(startPool);
        const repository = new PostgresTaxClassificationRepository(startDb);
        const elected = await repository.createClassification(
          {
            mreRealmId: REALM,
            sourceType: 'TRANSACTION_SPLIT',
            sourceId: splitId,
            taxCategory: 'MAINTENANCE',
            treatment: 'DISTRIBUTED_82B',
            reviewState: 'USER_CONFIRMED',
            supersedes: null,
            notes: null,
            sourceReferences: [],
            distributionYears: 3,
            mostlyResidentialConfirmed: true,
          },
          actor,
        );
        expect(elected.kind).toBe('CREATED');
        expect(await checkStoredRuleReferences(startDb)).toEqual([
          { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 },
          { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
        ]);
        // A registry without DE_82B_DISTRIBUTION@1: the stored treatmentRule no longer resolves.
        const without = new RuleRegistry(
          TAX_RULES.codes()
            .filter((c) => c !== 'DE_82B_DISTRIBUTION')
            .flatMap((c) => TAX_RULES.versions(c)),
        );
        await expect(checkStoredRuleReferences(startDb, without)).rejects.toThrow('Stored tax rule references are not registered: DE_82B_DISTRIBUTION@1');
      } finally {
        await startPool.end();
      }
    });

    it(
      'down refuses while a WEG classification exists; then restores 0046 and drops the columns, guards and indexes (under MIGRATION_ADVISORY_LOCK)',
      { timeout: 30_000 },
      async () => {
        const downSchema = testSchemaName('tax_weg_down_test');
        const admin = new pg.Client({ connectionString: databaseUrl });
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${downSchema}"`);
        await admin.end();
        const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
        try {
          await migrateToLatest(downPool, { migrationTableSchema: downSchema });
          const down = async () => (await import('./migrations/0047_tax_weg_spending.js')).down(createDatabase(downPool) as never);
          // A classification with a field of §58B: down refuses and changes nothing; once it is gone, down proceeds.
          const startDb = createDatabase(downPool);
          const splitId = await confirmedSplitIn(downPool);
          const created = await new PostgresTaxClassificationRepository(startDb).createClassification(
            {
              mreRealmId: REALM,
              sourceType: 'TRANSACTION_SPLIT',
              sourceId: splitId,
              taxCategory: 'MAINTENANCE',
              treatment: 'DEDUCTIBLE',
              reviewState: 'USER_CONFIRMED',
              supersedes: null,
              notes: null,
              sourceReferences: [],
              annuallyRecurring: true,
            },
            actor,
          );
          expect(created.kind).toBe('CREATED');
          let refused = '';
          await withMigrationLock(async () => {
            refused = await down().then(
              () => 'accepted',
              (error: { message?: string }) => error.message ?? '',
            );
          });
          expect(refused).toContain('down 0047');
          expect((await downPool.query(`SELECT count(*)::int AS n FROM tax_classification WHERE annually_recurring`)).rows[0].n).toBe(1);
          await downPool.query(`ALTER TABLE tax_classification DISABLE TRIGGER USER`);
          await downPool.query(`DELETE FROM tax_classification`);
          await downPool.query(`ALTER TABLE tax_classification ENABLE TRIGGER USER`);
          await withMigrationLock(down);
          const columns = await downPool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tax_classification'
             AND column_name IN ('weg_annual_statement_id', 'weg_use_position', 'net_amount', 'annually_recurring', 'distribution_years', 'treatment_rule_code')`,
            [downSchema],
          );
          expect(columns.rows).toEqual([]);
          const indexes = await downPool.query(
            `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname IN ('property_reference_realm_name_idx', 'financial_account_realm_name_idx',
             'tax_classification_current_withdrawal', 'tax_classification_current_use')`,
            [downSchema],
          );
          expect(indexes.rows).toEqual([]);
          const triggers = await downPool.query(
            `SELECT tgname FROM pg_trigger WHERE tgrelid = 'tax_classification'::regclass AND NOT tgisinternal ORDER BY tgname`,
          );
          expect(triggers.rows.map((r) => r.tgname)).toEqual([
            'tax_classification_chain',
            'tax_classification_deposit_counts',
            'tax_classification_deposit_treatment',
            'tax_classification_frozen',
            'tax_classification_initial',
            'tax_classification_source_counts',
            'tax_classification_source_fixed',
            'tax_classification_tax_year',
            'tax_classification_treatment',
          ]);
          const checks = await downPool.query(
            `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
            WHERE nspname = $1 AND conname = 'tax_classification_source_type_check'`,
            [downSchema],
          );
          expect(String(checks.rows[0].def)).not.toContain('WEG_RESERVE_WITHDRAWAL');
        } finally {
          await downPool.end();
        }
      },
    );
  });

  describe('concurrency (P7-D9)', () => {
    const waitForLock = async (text: string) => {
      const deadline = Date.now() + 5_000;
      while (
        Number(
          (
            await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [
              `%${text}%`,
            ])
          ).rows[0].count,
        ) < 1
      ) {
        if (Date.now() > deadline) throw new Error('no session waits on a lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const insertWithdrawal = `INSERT INTO tax_classification (mre_realm_id, source_type, weg_annual_statement_id, weg_reserve_position, weg_withdrawal_unit_share,
         tax_category, treatment, review_state, rule_code, rule_version, created_by)
       VALUES ($1, 'WEG_RESERVE_WITHDRAWAL', $2, 1, 1000.00, 'WEG_SPENDING', 'DEDUCTIBLE', 'USER_CONFIRMED', 'DE_WEG_SPENDING', 1, 'x')`;
    const insertUse = `INSERT INTO tax_classification (mre_realm_id, source_type, weg_special_assessment_id, weg_use_position, weg_use_date, weg_use_unit_share,
         tax_category, treatment, review_state, rule_code, rule_version, created_by)
       VALUES ($1, 'WEG_ASSESSMENT_USE', $2, 1, '2026-09-01', 3000.00, 'WEG_SPENDING', 'DEDUCTIBLE', 'USER_CONFIRMED', 'DE_WEG_SPENDING', 1, 'x')`;
    const supersede = async (client: pg.PoolClient, old: string, successor: string) => {
      await client.query(`UPDATE weg_annual_statement SET status = 'SUPERSEDED', superseded_by_id = $2, version = version + 1 WHERE id = $1`, [old, successor]);
      await client.query(
        `UPDATE weg_annual_statement SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', version = version + 1 WHERE id = $1`,
        [successor],
      );
    };
    async function pair() {
      const { membershipId } = await member();
      const old = await statement(membershipId);
      const successor = await statement(membershipId, { supersedes: old }, false);
      return { old, successor };
    }

    it('RC: a withdrawal classification waiting on the confirm superseding its statement sees it (repository); the other order proceeds and stops counting', async () => {
      const { old, successor } = await pair();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await supersede(holder, old, successor);
        const creating = classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', old, 1), actor);
        await waitForLock('update "weg_annual_statement"');
        await holder.query('COMMIT');
        expect(await creating).toMatchObject({ kind: 'WEG_SOURCE_NOT_COUNTED', reason: 'STATEMENT_SUPERSEDED' });
      } finally {
        holder.release();
      }
      const second = await pair();
      const classifier = await pool.connect();
      try {
        await classifier.query('BEGIN');
        await classifier.query(insertWithdrawal, [REALM, second.old]);
        const confirming = statements.confirmStatement(second.successor, REALM, AT, actor);
        await waitForLock('"weg_annual_statement"');
        await classifier.query('COMMIT');
        expect((await confirming).kind).toBe('CONFIRMED');
        expect(await withdrawalMeaning(second.old, 1)).toMatchObject({ origin: 'CLASSIFICATION', counts: false, notCountedReason: 'STATEMENT_SUPERSEDED' });
      } finally {
        classifier.release();
      }
    });

    it('RR: a withdrawal classification and the superseding confirm, both orders: the later one fails to serialise', async () => {
      for (const first of ['classify', 'supersede'] as const) {
        const { old, successor } = await pair();
        const [a, b] = [await pool.connect(), await pool.connect()];
        try {
          await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await a.query('SELECT count(*) FROM weg_annual_statement');
          await b.query('SELECT count(*) FROM tax_classification');
          if (first === 'classify') await a.query(insertWithdrawal, [REALM, old]);
          else await supersede(a, old, successor);
          const late = (first === 'classify' ? supersede(b, old, successor) : b.query(insertWithdrawal, [REALM, old])).then(
            () => 'written',
            (error: { code?: string }) => error.code,
          );
          await waitForLock(first === 'classify' ? 'UPDATE weg_annual_statement SET status' : 'INSERT INTO tax_classification');
          await a.query('COMMIT');
          expect(await late, first).toBe('40001');
          await b.query('ROLLBACK');
        } finally {
          a.release();
          b.release();
        }
      }
    });

    it('a use classification against PUT …/uses and against a void: RC sees the other, RR fails to serialise, both orders', async () => {
      const changeUses = `UPDATE weg_special_assessment SET uses = '[{"position":1,"date":"2026-09-02","description":"x","unitShare":{"amount":"3000.00","currency":"EUR"}}]'::jsonb,
           version = version + 1 WHERE id = $1`;
      const voidIt = `UPDATE weg_special_assessment SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1 WHERE id = $1`;
      for (const [writer, reason] of [
        [changeUses, 'USE_CHANGED'],
        [voidIt, 'ASSESSMENT_VOID'],
      ] as const) {
        const fresh = async () => assessment((await member()).membershipId, [{ position: 1, date: '2026-09-01', unitShare: '3000.00' }]);
        // RC: the create waits on the writer and sees it.
        const a1 = await fresh();
        const holder = await pool.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(writer, [a1]);
          const creating = classifications.createClassification(request('WEG_ASSESSMENT_USE', a1, 1), actor);
          await waitForLock('update "weg_special_assessment"');
          await holder.query('COMMIT');
          const outcome = await creating;
          if (reason === 'USE_CHANGED') expect(outcome, reason).toMatchObject({ kind: 'CREATED', classification: { assessmentUse: { date: '2026-09-02' } } });
          else expect(outcome, reason).toMatchObject({ kind: 'WEG_SOURCE_NOT_COUNTED', reason });
        } finally {
          holder.release();
        }
        // RC, the other order: the writer proceeds; the classification stops counting on read.
        const a2 = await fresh();
        const classifier = await pool.connect();
        try {
          await classifier.query('BEGIN');
          await classifier.query(insertUse, [REALM, a2]);
          const writing = pool.query(writer, [a2]).then(() => 'written', reasonOf);
          await waitForLock('UPDATE weg_special_assessment');
          await classifier.query('COMMIT');
          expect(await writing).toBe('written');
          if (reason === 'USE_CHANGED') expect(await useMeaning(a2, 1)).toMatchObject({ counts: false, notCountedReason: 'USE_CHANGED' });
          else expect(await useMeaning(a2, 1)).toMatchObject({ counts: false, notCountedReason: 'ASSESSMENT_VOID' });
        } finally {
          classifier.release();
        }
        // RR: both orders, the later one fails.
        for (const first of ['classify', 'write'] as const) {
          const a3 = await fresh();
          const [x, y] = [await pool.connect(), await pool.connect()];
          try {
            await x.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
            await y.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
            await x.query('SELECT count(*) FROM weg_special_assessment');
            await y.query('SELECT count(*) FROM tax_classification');
            await x.query(first === 'classify' ? insertUse : writer, first === 'classify' ? [REALM, a3] : [a3]);
            const late = (first === 'classify' ? y.query(writer, [a3]) : y.query(insertUse, [REALM, a3])).then(
              () => 'written',
              (error: { code?: string }) => error.code,
            );
            await waitForLock(first === 'classify' ? 'UPDATE weg_special_assessment' : 'INSERT INTO tax_classification');
            await x.query('COMMIT');
            expect(await late, `${reason} ${first}`).toBe('40001');
            await y.query('ROLLBACK');
          } finally {
            x.release();
            y.release();
          }
        }
      }
    });

    it('two creates for one withdrawal: the second waits and sees CLASSIFICATION_EXISTS; never two current', async () => {
      const { membershipId } = await member();
      const st = await statement(membershipId);
      const outcomes = await Promise.all([
        classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1), actor),
        classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1), actor),
      ]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(['CLASSIFICATION_EXISTS', 'CREATED']);
      expect(
        Number((await pool.query(`SELECT count(*) FROM tax_classification WHERE weg_annual_statement_id = $1 AND superseded_at IS NULL`, [st])).rows[0].count),
      ).toBe(1);
    });
  });
});
