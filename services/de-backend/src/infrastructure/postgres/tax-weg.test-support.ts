import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';
import type { SplitInput } from '../../domains/ledger/index.js';
import type { NewTaxClassification, TaxListItem } from '../../domains/taxation/index.js';
import { parseMea, type Mea, type NewAnnualStatement, type ReserveLine } from '../../domains/weg/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLandBuildingAllocationRepository } from './land-building-allocation-repository.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresWegAnnualStatementRepository } from './weg-annual-statement-repository.js';
import { PostgresWegRepository } from './weg-repository.js';
import { PostgresWegSpecialAssessmentRepository } from './weg-special-assessment-repository.js';

/**
 * The shared setup of the VC-7-03 persistence tests (api-design.md §58B, migration 0047): one migrated schema per test
 * file with a Giro account, the fixtures (PropertyReferences, WEG memberships, annual statements, Sonderumlagen, booked
 * splits, Parties, Acquisitions with their allocation) and the read helpers. Figures and names are synthetic. Test
 * support only.
 */

export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

export const REALM = '64b0c0ffee000000000000d1';
export const OTHER_REALM = '64b0c0ffee000000000000d2';
export const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
export const day = (value: string) => value as BusinessDate;
export const eur = (amount: string) => Money.of(amount, 'EUR');
export const today = day('2026-10-30');
export const AT = new Date('2026-10-30T10:00:00Z');
export const UNKNOWN = '00000000-0000-4000-8000-000000000000';
export const codes = (flags: readonly { code: string }[] | undefined) => (flags ?? []).map((f) => f.code);

export async function withMigrationLock(work: () => Promise<unknown>): Promise<void> {
  const lock = new pg.Client({ connectionString: databaseUrl });
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    await work();
  } finally {
    await lock.end().catch(() => undefined);
  }
}

export function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return error.constraint ?? /\(([A-Z_]+)\)|never change/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error';
}

export interface TaxWegContext {
  pool: pg.Pool;
  db: Kysely<Database>;
  classifications: PostgresTaxClassificationRepository;
  wegs: PostgresWegRepository;
  statements: PostgresWegAnnualStatementRepository;
  assessments: PostgresWegSpecialAssessmentRepository;
  transactions: PostgresTransactionRepository;
  splits: PostgresTransactionSplitRepository;
  acquisitions: PostgresAcquisitionRepository;
  allocations: PostgresLandBuildingAllocationRepository;
  parties: PostgresPartyRepository;
}

/**
 * Registers the schema's `beforeAll`/`afterAll` in the calling `describe` and returns the context (filled once
 * `beforeAll` has run) with the helpers bound to it.
 */
export function useTaxWegDatabase(name: `${string}_test`) {
  const schema = testSchemaName(name);
  const ctx = {} as TaxWegContext;
  let counter = 0;
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
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 10 });
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
    Object.assign(ctx, { pool, db, classifications, wegs, statements, assessments, transactions, splits, acquisitions, allocations, parties });
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

  return {
    ctx,
    propertyReference,
    member,
    line,
    newStatement,
    statement,
    assessment,
    request,
    split,
    booked,
    party,
    acquisition,
    withdrawalMeaning,
    useMeaning,
    list,
    keys,
  };
}
