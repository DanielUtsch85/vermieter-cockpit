import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';
import {
  deriveSchedule,
  type DepreciationSchedule,
  type ItemComponent,
  type ItemRef,
  type NewDepreciationAsset,
  type ScheduleRead,
} from '../../domains/depreciation/index.js';
import type { SplitInput } from '../../domains/ledger/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import type { NewTaxClassification } from '../../domains/taxation/index.js';
import { parseMea, type Mea, type NewAnnualStatement, type ReserveLine } from '../../domains/weg/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { PostgresDepreciationAssetRepository } from './depreciation-asset-repository.js';
import { databaseUrl, type Queryable } from './depreciation-asset.test-support.js';
import { PostgresDepreciationScheduleSource } from './depreciation-schedule-source.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLandBuildingAllocationRepository } from './land-building-allocation-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresPartyRepository } from './party-repository.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';
import { PostgresWegAnnualStatementRepository } from './weg-annual-statement-repository.js';
import { PostgresWegRepository } from './weg-repository.js';
import { PostgresWegSpecialAssessmentRepository } from './weg-special-assessment-repository.js';
import { standardMethod } from './depreciation-method.test-support.js';

/**
 * The shared setup of the separate asset's tests (VC-8-03, api-design.md §59B, migration 0051): one migrated schema per
 * test file, with the tax repository's reader wired, and the fixtures (purchases, capitalised splits, WEG withdrawals and
 * uses, separate assets and buildings), the links, the schedule read and the cash snapshot. The generic helpers are in
 * `depreciation-asset.test-support.ts`. Figures, names and texts are synthetic. Test support only.
 */
export const REALM = '64b0c0ffee00000000000831';
export const OTHER_REALM = '64b0c0ffee00000000000832';
export const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
export const day = (value: string) => value as BusinessDate;
export const eur = (amount: string) => Money.of(amount, 'EUR');
export const AT = new Date('2026-10-30T10:00:00Z');
export const NOW = () => new Date('2027-10-30T10:00:00Z');

/** The tables a separate asset's command or a schedule read must leave as they are, every row with its `version`. */
const CASH_TABLES = [
  'ledger_transaction',
  'transaction_split',
  'tax_classification',
  'weg_annual_statement',
  'weg_special_assessment',
  'acquisition',
  'acquisition_cost',
  'land_building_allocation',
  'ownership',
  'property_reference',
] as const;

export interface SeparateAssetContext {
  pool: pg.Pool;
  db: Kysely<Database>;
  classifications: PostgresTaxClassificationRepository;
  assets: PostgresDepreciationAssetRepository;
  source: PostgresDepreciationScheduleSource;
  giro: string;
  otherGiro: string;
}

/**
 * Registers the schema's `beforeAll`/`afterAll` in the calling `describe` and returns the context (filled once
 * `beforeAll` has run) with the helpers bound to it.
 */
export function useSeparateAssetDatabase(name: `${string}_test`) {
  const schema = testSchemaName(name);
  const ctx = { giro: '', otherGiro: '' } as SeparateAssetContext;
  let counter = 0;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    ctx.pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(ctx.pool, { migrationTableSchema: schema });
    ctx.db = createDatabase(ctx.pool);
    ctx.classifications = new PostgresTaxClassificationRepository(ctx.db);
    ctx.assets = new PostgresDepreciationAssetRepository(ctx.db, { capitalizedSources: ctx.classifications.capitalizedSources, now: NOW });
    ctx.source = new PostgresDepreciationScheduleSource(ctx.db, ctx.classifications.capitalizedSources, NOW);
    const account = async (realm: string) => {
      const created = await new PostgresFinancialAccountRepository(ctx.db).create(
        { mreRealmId: realm, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null },
        actor,
      );
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      return created.account.id;
    };
    ctx.giro = await account(REALM);
    ctx.otherGiro = await account(OTHER_REALM);
  });

  afterAll(async () => {
    await ctx.pool.end();
  });

  // ——— Fixtures ———

  async function propertyReference(realm = REALM) {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fe0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await ctx.pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function party(realm = REALM) {
    const created = await new PostgresPartyRepository(ctx.db).create(
      {
        mreRealmId: realm,
        partyType: 'PERSON',
        displayName: `Eigentümerin ${++counter}`,
        firstName: null,
        lastName: null,
        legalName: null,
        registrationNumber: null,
        email: null,
        phone: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.party.id;
  }
  /** A confirmed purchase of `pr` by one owner (transfer 2026-03-15) with a confirmed allocation; returns its id. */
  async function purchase(pr: string) {
    const acquisitions = new PostgresAcquisitionRepository(ctx.db);
    const buyer = await party();
    const created = await acquisitions.create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        purchasePrice: eur('240000.00'),
        acquiredShare: { numerator: 1, denominator: 1 },
        contractDate: day('2026-03-15'),
        economicTransferDate: day('2026-03-15'),
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
    await ctx.pool.query(
      `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, acquisition_id, created_by)
       VALUES ($1, $2, $3, 1, 1, '2026-03-15', 'VALID', $4, 'x')`,
      [REALM, pr, buyer, id],
    );
    if ((await acquisitions.confirm(id, REALM, AT, actor)).kind !== 'CONFIRMED') throw new Error('confirm');
    const allocated = await new PostgresLandBuildingAllocationRepository(ctx.db).create(
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
    return { acquisitionId: id, owner: buyer };
  }
  /** A confirmed split of `pr` booked on `date` (MAINTENANCE), optionally of another Realm. */
  async function splitOf(pr: string | null, amount: string, date = '2027-04-28', realm = REALM, direction: 'INFLOW' | 'OUTFLOW' = 'OUTFLOW') {
    const transactions = new PostgresTransactionRepository(ctx.db);
    const created = await transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: realm === REALM ? ctx.giro : ctx.otherGiro,
        amount: eur(amount),
        direction,
        bookingDate: day(date),
        valueDate: null,
        description: 'Rechnung (synthetisch)',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const split: SplitInput = {
      amount: eur(amount),
      financialCategoryCode: 'MAINTENANCE',
      propertyReferenceId: pr,
      loanId: null,
      securityDepositId: null,
      description: null,
    };
    const replaced = await new PostgresTransactionSplitRepository(ctx.db).replaceSplits(created.transaction.id, realm, [split], actor);
    if (replaced.kind !== 'REPLACED') throw new Error(JSON.stringify(replaced));
    if ((await transactions.confirm(created.transaction.id, realm, actor)).kind !== 'CONFIRMED') throw new Error('confirm');
    const { rows } = await ctx.pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1`, [created.transaction.id]);
    return rows[0].id as string;
  }
  async function classify(sourceId: string, overrides: Partial<NewTaxClassification> = {}, realm = REALM): Promise<string> {
    const outcome = await ctx.classifications.createClassification(
      {
        mreRealmId: realm,
        sourceType: 'TRANSACTION_SPLIT',
        sourceId,
        taxCategory: 'MAINTENANCE',
        treatment: 'CAPITALIZED',
        reviewState: 'USER_CONFIRMED',
        supersedes: null,
        notes: null,
        sourceReferences: [],
        ...overrides,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome));
    return outcome.classification.id;
  }
  /** A capitalised split of `pr`. */
  async function capitalizedSplit(pr: string, amount = '6000.00', date = '2027-04-28') {
    const id = await splitOf(pr, amount, date);
    await classify(id);
    return id;
  }
  /** A WEG membership of `pr`, a confirmed statement with a withdrawal (1) and a contribution (3), an assessment with a use (1). */
  async function wegSources(pr: string, realm = REALM) {
    const wegs = new PostgresWegRepository(ctx.db);
    const weg = await wegs.createWeg(
      { mreRealmId: realm, displayName: `WEG ${++counter}`, administratorPartyId: null, financialYearStartMonth: 1, notes: null },
      actor,
    );
    if (weg.kind !== 'CREATED') throw new Error(weg.kind);
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
    const line = (position: number, kind: ReserveLine['kind'], withdrawal: string | null, date: string | null): ReserveLine => ({
      position,
      description: `Linie ${position}`,
      kind,
      opening: null,
      addition: null,
      withdrawal: withdrawal === null ? null : eur(withdrawal),
      closing: null,
      date: date === null ? null : day(date),
    });
    const statement: NewAnnualStatement = {
      mreRealmId: realm,
      membershipId: m.membership.id,
      financialYear: 2027,
      periodFrom: day('2027-01-01'),
      periodUntil: day('2027-12-31'),
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
      reserve: {
        source: 'ANNUAL_STATEMENT',
        lines: [line(1, 'WITHDRAWAL', '8000.00', '2027-06-15'), line(3, 'CONTRIBUTION', null, null)],
        unitShareOpening: null,
        unitShareClosing: null,
      },
      sourceReferences: [],
      notes: null,
    };
    const statements = new PostgresWegAnnualStatementRepository(ctx.db);
    const st = await statements.createStatement(statement, actor);
    if (st.kind !== 'CREATED') throw new Error(JSON.stringify(st));
    if ((await statements.confirmStatement(st.statement.id, realm, AT, actor)).kind !== 'CONFIRMED') throw new Error('statement');
    const assessments = new PostgresWegSpecialAssessmentRepository(ctx.db);
    const today = day('2027-10-30');
    const a = await assessments.createAssessment(
      {
        mreRealmId: realm,
        membershipId: m.membership.id,
        description: 'Fassade (synthetisch)',
        resolutionDate: day('2027-02-10'),
        purpose: 'MAINTENANCE',
        totalAmount: null,
        unitShare: eur('9000.00'),
        instalments: [{ position: 1, dueDate: day('2027-03-01'), amount: eur('9000.00') }],
        sourceReferences: [],
        notes: null,
      },
      actor,
      today,
    );
    if (a.kind !== 'CREATED') throw new Error(a.kind);
    const replaced = await assessments.replaceUses(
      a.assessment.id,
      realm,
      [{ position: 1, date: day('2027-09-02'), description: 'Verwendung 1', unitShare: eur('9000.00') }],
      actor,
      today,
    );
    if (replaced.kind !== 'AMENDED') throw new Error(replaced.kind);
    return { statementId: st.statement.id, assessmentId: a.assessment.id };
  }
  const split = (sourceId: string): ItemRef => ({ sourceType: 'TRANSACTION_SPLIT', sourceId, sourcePosition: null });
  const withdrawal = (sourceId: string, position = 1): ItemRef => ({ sourceType: 'WEG_RESERVE_WITHDRAWAL', sourceId, sourcePosition: position });
  const use = (sourceId: string, position = 1): ItemRef => ({ sourceType: 'WEG_ASSESSMENT_USE', sourceId, sourcePosition: position });
  const kitchen = (pr: string, items: readonly ItemRef[], overrides: Partial<NewDepreciationAsset> = {}): NewDepreciationAsset => ({
    mreRealmId: REALM,
    propertyReferenceId: pr,
    assetType: 'SEPARATE_ASSET',
    depreciationMethod: 'LINEAR_7_1',
    buildingCompletionYear: null,
    description: 'Einbauküche, Wohnung 3 (synthetisch)',
    usefulLifeYears: 10,
    usefulLifeBasis: 'BFH IX R 14/15: Einbauküche als einheitliches Wirtschaftsgut, 10 Jahre (verification-checklist B8)',
    acquiredOn: day('2027-04-20'),
    items,
    sourceReferences: ['Lieferschein 2027-04-20 (synthetisch)'],
    reviewState: 'UNREVIEWED',
    advisorPartyId: null,
    shorterUsefulLives: [],
    purchaseMethods: [],
    notes: null,
    ...overrides,
  });
  /** §59C: a confirmed STANDARD method entry for each purchase named, so it computes. */
  const building = (pr: string, purchases: readonly string[] = []): NewDepreciationAsset => ({
    mreRealmId: REALM,
    propertyReferenceId: pr,
    assetType: 'BUILDING',
    depreciationMethod: 'LINEAR_7_4',
    buildingCompletionYear: 1995,
    description: null,
    usefulLifeYears: null,
    usefulLifeBasis: null,
    acquiredOn: null,
    items: [],
    sourceReferences: [],
    reviewState: 'CONFIRMED',
    advisorPartyId: null,
    shorterUsefulLives: [],
    purchaseMethods: purchases.map((id) => standardMethod(id)),
    notes: null,
  });
  async function created(asset: NewDepreciationAsset): Promise<string> {
    const outcome = await ctx.assets.create(asset, actor);
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome));
    return outcome.asset.id;
  }
  const audits = async (id: string) =>
    (
      await ctx.pool.query(`SELECT action, metadata FROM audit_record WHERE entity_type = 'DepreciationAsset' AND entity_id = $1 ORDER BY occurred_at, id`, [
        id,
      ])
    ).rows as {
      action: string;
      metadata: Record<string, unknown>;
    }[];
  const links = async (assetId: string) =>
    (
      await ctx.pool.query(
        `SELECT source_type, source_id, source_position, asset_status, xmin::text AS xmin FROM depreciation_asset_item WHERE asset_id = $1 ORDER BY source_id`,
        [assetId],
      )
    ).rows as { source_type: string; source_id: string; source_position: number | null; asset_status: string; xmin: string }[];
  const schedule = async (assetId: string, from = 2027, to = 2028): Promise<DepreciationSchedule> => {
    const read = (await ctx.source.read(assetId, REALM, null)) as ScheduleRead;
    return deriveSchedule({ ...read, today: day('2027-10-30'), from, to, ownerPartyId: null }, TAX_RULES);
  };
  const itemIds = (s: DepreciationSchedule) => s.components.filter((c): c is ItemComponent => c.kind === 'CAPITALIZED_ITEM').map((c) => c.componentId);
  const blockedBy = async (holder: Queryable) => {
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    return async () =>
      (await ctx.pool.query(`SELECT query FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`, [pid])).rows.map((r) => r.query as string);
  };
  async function snapshot(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const table of CASH_TABLES) result[table] = (await ctx.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    result['audit_record'] = (await ctx.pool.query(`SELECT count(*)::int AS n FROM audit_record WHERE entity_type <> 'DepreciationAsset'`)).rows[0].n;
    return result;
  }
  return {
    ctx,
    propertyReference,
    party,
    purchase,
    splitOf,
    classify,
    capitalizedSplit,
    wegSources,
    split,
    withdrawal,
    use,
    kitchen,
    building,
    created,
    audits,
    links,
    schedule,
    itemIds,
    blockedBy,
    snapshot,
  };
}
