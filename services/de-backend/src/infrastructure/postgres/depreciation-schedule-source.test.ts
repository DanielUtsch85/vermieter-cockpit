import { Kysely, PostgresDialect, sql, type CompiledQuery } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveSchedule, type DepreciationSchedule, type ScheduleComponent, type ScheduleRead } from '../../domains/depreciation/index.js';
import type { SplitInput } from '../../domains/ledger/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { checkAnschaffungsnahe } from '../../domains/taxation/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresAcquisitionCostRepository } from './acquisition-cost-repository.js';
import { PostgresAcquisitionRepository } from './acquisition-repository.js';
import { createDatabase } from './database.js';
import { PostgresDepreciationAssetRepository, depreciationSnapshot } from './depreciation-asset-repository.js';
import { PostgresDepreciationScheduleSource } from './depreciation-schedule-source.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLandBuildingAllocationRepository } from './land-building-allocation-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import type { Database } from './schema.js';
import { acquisitionsOf } from './tax-property-context.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-8-02 persistence (api-design.md §59A "One snapshot", "Concurrency and consistency", "Performance"): the inputs of
 * the schedule read in one `REPEATABLE READ READ ONLY` transaction, Realm-filtered; a `DRAFT` with and without
 * Ownerships; `CANCELLED` absent; an allocation committed during the read not seen; the plans of the Ownership and
 * Acquisition queries; no cash mutated and a write inside the read refused (`25006`); the schedule's basis equal to the
 * anschaffungsnahe check's for the same snapshot. Figures, names and texts are synthetic (ACC8's purchase).
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000821';
const OTHER_REALM = '64b0c0ffee00000000000822';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const AT = new Date('2026-10-30T10:00:00Z');
let counter = 0;

/** The tables the read touches or could touch, every row with its `version`, and the count of AuditRecords. */
const READ_TABLES = [
  'ledger_transaction',
  'transaction_split',
  'acquisition',
  'acquisition_cost',
  'acquisition_payment',
  'land_building_allocation',
  'ownership',
  'property_reference',
  'depreciation_asset',
  'depreciation_asset_useful_life',
  'tax_classification',
] as const;

/** The repositories of one schema, and the fixture of ACC8's purchase in it. */
function fixtureIn(pool: pg.Pool) {
  const db = createDatabase(pool);
  const parties = new PostgresPartyRepository(db);
  const acquisitions = new PostgresAcquisitionRepository(db);
  const ownerships = new PostgresOwnershipRepository(db);
  const costs = new PostgresAcquisitionCostRepository(db);
  const allocations = new PostgresLandBuildingAllocationRepository(db);
  const assets = new PostgresDepreciationAssetRepository(db);
  const accounts = new PostgresFinancialAccountRepository(db);
  const transactions = new PostgresTransactionRepository(db);
  const splits = new PostgresTransactionSplitRepository(db);

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
  async function propertyReference(realm = REALM): Promise<string> {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fd0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function acquisition(pr: string, buyers: string[], overrides: { share?: [number, number]; transfer?: string; price?: string } = {}): Promise<string> {
    const [numerator, denominator] = overrides.share ?? [1, 1];
    const outcome = await acquisitions.create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        purchasePrice: eur(overrides.price ?? '300000.00'),
        acquiredShare: { numerator, denominator },
        contractDate: day('2026-05-15'),
        economicTransferDate: day(overrides.transfer ?? '2026-07-01'),
        landRegistryTransferDate: null,
        buyerPartyIds: buyers,
        sellerPartyIds: [],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.acquisition.id;
  }
  async function own(pr: string, owner: string, share: [number, number], from: string, acquisitionId: string | null): Promise<string> {
    const outcome = await ownerships.create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        ownerPartyId: owner,
        share: { numerator: share[0], denominator: share[1] },
        validFrom: day(from),
        validUntil: null,
        acquisitionId,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.ownership.id;
  }
  async function cost(acquisitionId: string, category: 'REAL_ESTATE_TRANSFER_TAX' | 'NOTARY' | 'FINANCING_RELATED', amount: string): Promise<string> {
    const outcome = await costs.createCost(
      { mreRealmId: REALM, acquisitionId, category, amount: eur(amount), incurredDate: null, counterpartyPartyId: null, sourceReferences: [], notes: null },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.cost.id;
  }
  /** A confirmed outflow, linked to the cost: the cost is PAID. */
  async function pay(acquisitionId: string, costId: string, amount: string): Promise<void> {
    const account = await accounts.create({ mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: account.account.id,
        amount: eur(amount),
        direction: 'OUTFLOW',
        bookingDate: day('2026-07-15'),
        valueDate: null,
        description: 'Notar',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const split: SplitInput = {
      amount: eur(amount),
      financialCategoryCode: 'ACQUISITION',
      propertyReferenceId: null,
      loanId: null,
      securityDepositId: null,
      description: null,
    };
    if ((await splits.replaceSplits(created.transaction.id, REALM, [split], actor)).kind !== 'REPLACED') throw new Error('split');
    if ((await transactions.confirm(created.transaction.id, REALM, actor)).kind !== 'CONFIRMED') throw new Error('confirm');
    const linked = await costs.linkPayment(
      { mreRealmId: REALM, acquisitionId, transactionId: created.transaction.id, acquisitionCostId: costId, amount: eur(amount) },
      actor,
    );
    if (linked.kind !== 'LINKED') throw new Error(linked.kind);
  }
  async function allocate(acquisitionId: string, building: string, supersedes: string | null = null, reviewState: 'CONFIRMED' | 'UNREVIEWED' = 'CONFIRMED') {
    const outcome = await allocations.create(
      {
        mreRealmId: REALM,
        acquisitionId,
        totalAllocableAmount: eur('318000.00'),
        landAmount: eur((318000 - Number(building)).toFixed(2)),
        buildingAmount: eur(building),
        method: 'PURCHASE_CONTRACT',
        reviewState,
        effectiveDate: null,
        advisorPartyId: null,
        sourceReferences: [],
        notes: null,
        supersedes,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.allocation.id;
  }
  /** ACC8: A 3/5 and B 2/5 of W from 2026-07-01, confirmed; the building asset of 1995, confirmed. */
  async function acc8() {
    const pr = await propertyReference();
    const [a, b] = [await party('Käuferin A'), await party('Käufer B')].sort() as [string, string];
    const w = await acquisition(pr, [a, b]);
    await own(pr, a, [3, 5], '2026-07-01', w);
    await own(pr, b, [2, 5], '2026-07-01', w);
    const tax = await cost(w, 'REAL_ESTATE_TRANSFER_TAX', '15000.00');
    const notary = await cost(w, 'NOTARY', '3000.00');
    await cost(w, 'FINANCING_RELATED', '1200.00');
    await pay(w, notary, '3000.00');
    const allocation = await allocate(w, '254400.00');
    expect((await acquisitions.confirm(w, REALM, AT, actor)).kind).toBe('CONFIRMED');
    const created = await assets.create(
      {
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
        sourceReferences: ['Teilungserklärung, Baujahr laut Anlage 1'],
        reviewState: 'CONFIRMED',
        advisorPartyId: null,
        shorterUsefulLives: [],
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return { pr, a, b, w, tax, notary, allocation, assetId: created.asset.id };
  }
  return { db, party, propertyReference, acquisition, own, cost, allocate, acc8, acquisitions, ownerships, costs };
}

const derive = (read: ScheduleRead | undefined, ownerPartyId: string | null = null): DepreciationSchedule => {
  if (read === undefined) throw new Error('no read');
  return deriveSchedule(
    { asset: read.asset, acquisitions: read.acquisitions, ownerships: read.ownerships, today: day('2026-10-30'), from: 2026, to: 2027, ownerPartyId },
    TAX_RULES,
  );
};
const amounts = (s: DepreciationSchedule) => s.years.map((y) => y.amount?.amount ?? null);

async function rowsSnapshot(pool: pg.Pool): Promise<Record<string, unknown>> {
  const snapshot: Record<string, unknown> = {};
  for (const table of READ_TABLES) {
    const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
    snapshot[table] = rows.map((r: { row: unknown }) => r.row);
  }
  snapshot['audit_record'] = Number((await pool.query(`SELECT count(*) AS n FROM audit_record`)).rows[0].n);
  return snapshot;
}

describe.skipIf(databaseUrl === undefined)('PostgresDepreciationScheduleSource (§59A)', () => {
  const schema = testSchemaName('depreciation_schedule_test');
  let pool: pg.Pool;
  let fx: ReturnType<typeof fixtureIn>;
  let source: PostgresDepreciationScheduleSource;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    fx = fixtureIn(pool);
    source = new PostgresDepreciationScheduleSource(fx.db, new PostgresTaxClassificationRepository(fx.db).capitalizedSources);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('ACC8 read in one snapshot and derived: 2,544.00 and 5,088.00, A and B; the counting payment makes a cost PAID, the others are not', async () => {
    const s = await fx.acc8();
    const read = await source.read(s.assetId, REALM, null);
    expect(read?.ownerPartyFound).toBeNull();
    expect(read?.acquisitions.map((a) => [a.id, a.status, a.economicTransferDate, a.costs.map((c) => [c.category, c.amount.amount, c.paymentStatus])])).toEqual(
      [
        [
          s.w,
          'CONFIRMED',
          '2026-07-01',
          expect.arrayContaining([
            ['REAL_ESTATE_TRANSFER_TAX', '15000.00', 'EXPECTED'],
            ['NOTARY', '3000.00', 'PAID'],
            ['FINANCING_RELATED', '1200.00', 'EXPECTED'],
          ]),
        ],
      ],
    );
    expect(read?.ownerships.map((o) => [o.partyId, `${o.share.numerator}/${o.share.denominator}`, o.validFrom, o.acquisitionId]).sort()).toEqual([
      [s.a, '3/5', '2026-07-01', s.w],
      [s.b, '2/5', '2026-07-01', s.w],
    ]);
    const schedule = derive(read);
    expect(schedule.components[0]?.basis.amount?.amount).toBe('254400.00');
    expect(amounts(schedule)).toEqual(['2544.00', '5088.00']);
    expect(schedule.years[1]?.owners?.map((o) => [o.ownerPartyId, o.amount?.amount])).toEqual([
      [s.a, '3052.80'],
      [s.b, '2035.20'],
    ]);
    expect(schedule.components[0]?.flags).toEqual([{ code: 'ACQUISITION_COST_UNPAID', details: { costIds: expect.any(Array) } }]);
    expect((schedule.components[0]?.flags[0]?.details['costIds'] as string[]).length).toBe(2);
  });

  it('a VOID cost is not in the basis, nor in acquisitionCosts or ACQUISITION_COST_UNPAID (§59A: ACTIVE costs only)', async () => {
    const s = await fx.acc8();
    const extra = await fx.cost(s.w, 'NOTARY', '5000.00');
    expect((await fx.costs.voidCost(s.w, extra, REALM, 'doppelt erfasst', AT, actor)).kind).toBe('VOIDED');
    const read = await source.read(s.assetId, REALM, null);
    expect(read?.acquisitions[0]?.costs.map((c) => c.id)).not.toContain(extra);
    const schedule = derive(read);
    expect(schedule.components[0]?.basis.amount?.amount).toBe('254400.00');
    expect(schedule.components[0]?.flags[0]?.details['costIds']).not.toContain(extra);
  });

  it('only the current allocation feeds the basis: superseded twice, the newest one, whatever the row order', async () => {
    const s = await fx.acc8();
    const second = await fx.allocate(s.w, '200000.00', s.allocation);
    const third = await fx.allocate(s.w, '159000.00', second);
    const read = await source.read(s.assetId, REALM, null);
    expect(read?.acquisitions[0]?.allocation?.id).toBe(third);
    const component = derive(read).components[0] as ScheduleComponent | undefined;
    expect([component?.basis.allocationId, component?.basis.amount?.amount]).toEqual([third, '159000.00']);
  });

  it('the schedule’s basis equals the anschaffungsnahe check’s basis for the same snapshot (§59A, one function)', async () => {
    const s = await fx.acc8();
    const read = await source.read(s.assetId, REALM, null);
    const inputs = await depreciationSnapshot(fx.db, (trx) => acquisitionsOf(trx, REALM, { propertyReferenceId: s.pr }));
    const check = checkAnschaffungsnahe({ ...(inputs[0] as (typeof inputs)[number]), sources: [], statements: [], today: day('2026-10-30') }, TAX_RULES);
    expect(check.basis?.basisAmount.amount).toBe(derive(read).components[0]?.basis.amount?.amount);
  });

  it('a DRAFT with Ownerships is listed (ACQUISITION_NOT_CONFIRMED), one without is not; a CANCELLED one is absent', async () => {
    const s = await fx.acc8();
    const c = await fx.party('Käuferin C');
    // B sells its 2/5 to C from 2027-01-01, recorded this far: B's row closed, C's row carries the DRAFT.
    const listed = await fx.acquisition(s.pr, [c], { share: [2, 5], transfer: '2027-01-01', price: '110000.00' });
    const bRow = (await pool.query(`SELECT id FROM ownership WHERE owner_party_id = $1 AND property_reference_id = $2`, [s.b, s.pr])).rows[0].id as string;
    expect((await fx.ownerships.close(bRow, REALM, day('2026-12-31'), actor)).kind).toBe('CLOSED');
    await fx.own(s.pr, c, [2, 5], '2027-01-01', listed);
    const unlisted = await fx.acquisition(s.pr, [c], { transfer: '2027-02-01' });
    const cancelled = await fx.acquisition(s.pr, [c], { transfer: '2027-03-01' });
    expect((await fx.acquisitions.cancel(cancelled, REALM, 'Rücktritt', AT, actor)).kind).toBe('CANCELLED');
    const read = await source.read(s.assetId, REALM, null);
    expect(read?.acquisitions.map((a) => a.id).sort()).toEqual([s.w, listed, unlisted].sort());
    const schedule = derive(read);
    expect((schedule.components as ScheduleComponent[]).map((c2) => [c2.acquisitionId, c2.acquisitionStatus, c2.reasons.map((r) => r.code)])).toEqual([
      [s.w, 'CONFIRMED', []],
      [listed, 'DRAFT', ['ACQUISITION_NOT_CONFIRMED']],
    ]);
  });

  it('one snapshot: an allocation committed while the read waits is not seen', { timeout: 20_000 }, async () => {
    const s = await fx.acc8();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // The read takes its snapshot with the asset, then waits on the payments, before it reads the allocations.
      await holder.query('LOCK TABLE acquisition_payment IN ACCESS EXCLUSIVE MODE');
      const reading = source.read(s.assetId, REALM, null);
      const deadline = Date.now() + 5_000;
      while (
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND application_name = current_setting('application_name') AND query LIKE '%"acquisition_payment"%' AND pid <> pg_backend_pid()`,
            )
          ).rows[0].count,
        ) < 1
      ) {
        if (Date.now() > deadline) throw new Error('the read does not wait');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await fx.allocate(s.w, '200000.00', s.allocation);
      await holder.query('ROLLBACK');
      expect(derive(await reading).components[0]?.basis.amount?.amount).toBe('254400.00');
      // Afterwards the new allocation is the basis: (318,000.00 × 200,000 / 318,000).
      expect(derive(await source.read(s.assetId, REALM, null)).components[0]?.basis.amount?.amount).toBe('200000.00');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('the plans: the Acquisition and Ownership queries use acquisition_property_reference_idx and ownership_property_reference_idx', async () => {
    const s = await fx.acc8();
    const sent: CompiledQuery[] = [];
    const logged = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === 'query') sent.push(event.query);
      },
    });
    await new PostgresDepreciationScheduleSource(logged, new PostgresTaxClassificationRepository(logged).capitalizedSources).read(s.assetId, REALM, null);
    const plan = async (table: string) => {
      const query = sent.find((q) => q.sql.includes(`from "${table}"`) && q.sql.includes('"property_reference_id" = $'));
      if (query === undefined) throw new Error(`no ${table} query`);
      const client = await pool.connect();
      try {
        // The tables are small here: without a sequential scan the planner shows which index the query can use.
        await client.query('SET enable_seqscan = off');
        const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${query.sql}`, [...query.parameters]);
        return JSON.stringify(rows[0]['QUERY PLAN']);
      } finally {
        await client.query('RESET enable_seqscan');
        client.release();
      }
    };
    expect(await plan('acquisition')).toContain('acquisition_property_reference_idx');
    expect(await plan('ownership')).toContain('ownership_property_reference_idx');
  });

  it('no cash mutated: every row and version unchanged, no AuditRecord, by reads at both levels; a write inside the read’s transaction is refused', async () => {
    const s = await fx.acc8();
    const before = await rowsSnapshot(pool);
    for (const owner of [null, s.a, s.b]) derive(await source.read(s.assetId, REALM, owner), owner);
    expect(await rowsSnapshot(pool)).toEqual(before);
    const refused = await depreciationSnapshot(fx.db, (trx) => sql`UPDATE ledger_transaction SET description = description WHERE false`.execute(trx)).then(
      () => 'accepted',
      (error: { code?: string }) => error.code,
    );
    expect(refused).toBe('25006');
    const inserted = await depreciationSnapshot(fx.db, (trx) =>
      trx.insertInto('audit_record').values({ entity_type: 'X', entity_id: 'x', action: 'X', actor_type: 'SYSTEM', actor_id: null, metadata: null }).execute(),
    ).then(
      () => 'accepted',
      (error: { code?: string }) => error.code,
    );
    expect(inserted).toBe('25006');
  });

  it('Realm isolation: the asset of another Realm is not found; a Party of another Realm is not found; an unknown id is not found', async () => {
    const s = await fx.acc8();
    expect(await source.read(s.assetId, OTHER_REALM, null)).toBeUndefined();
    expect(await source.read('00000000-0000-4000-8000-000000000000', REALM, null)).toBeUndefined();
    expect(await source.read('x', REALM, null)).toBeUndefined();
    const foreign = await fx.party('Fremd', OTHER_REALM);
    expect((await source.read(s.assetId, REALM, foreign))?.ownerPartyFound).toBe(false);
    expect((await source.read(s.assetId, REALM, s.a))?.ownerPartyFound).toBe(true);
    expect((await source.read(s.assetId, REALM, 'y'))?.ownerPartyFound).toBe(false);
  });
});

describe.skipIf(databaseUrl === undefined)('PostgresDepreciationScheduleSource: every query filtered by the Realm (§59A)', () => {
  // Another Realm's rows on this PropertyReference cannot be written while the composite foreign keys hold; this schema
  // drops them, so a query without its Realm filter would read them (the mutation "the Realm filter dropped").
  const schema = testSchemaName('depreciation_schedule_realm_test');
  let pool: pg.Pool;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 5 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('another Realm’s Acquisition, cost, allocation and Ownership on the same PropertyReference never appear', async () => {
    const fx = fixtureIn(pool);
    const s = await fx.acc8();
    const foreign = await fx.party('Fremd', OTHER_REALM);
    await pool.query(`ALTER TABLE acquisition DROP CONSTRAINT acquisition_property_reference_fk`);
    await pool.query(`ALTER TABLE ownership DROP CONSTRAINT ownership_property_reference_fk`);
    await pool.query(`ALTER TABLE acquisition DISABLE TRIGGER USER`);
    await pool.query(`ALTER TABLE ownership DISABLE TRIGGER USER`);
    const { rows } = await pool.query(
      `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, economic_transfer_date, confirmed_at, created_by)
       VALUES ($1, $2, 'CONFIRMED', 1000, 'EUR', 1, 1, '2026-01-01', '2026-01-01', now(), 'x') RETURNING id`,
      [OTHER_REALM, s.pr],
    );
    const theirs = rows[0].id as string;
    await pool.query(
      `INSERT INTO ownership (mre_realm_id, property_reference_id, owner_party_id, share_numerator, share_denominator, valid_from, status, acquisition_id, created_by)
       VALUES ($1, $2, $3, 1, 1, '2026-01-01', 'VALID', $4, 'x')`,
      [OTHER_REALM, s.pr, foreign, theirs],
    );
    const read = await new PostgresDepreciationScheduleSource(fx.db, new PostgresTaxClassificationRepository(fx.db).capitalizedSources).read(
      s.assetId,
      REALM,
      null,
    );
    expect(read?.acquisitions.map((a) => a.id)).toEqual([s.w]);
    expect(read?.ownerships.map((o) => o.partyId).sort()).toEqual([s.a, s.b].sort());
    const schedule = derive(read);
    expect(schedule.years.flatMap((y) => y.flags.map((f) => f.code))).not.toContain('OWNER_WITHOUT_ACQUISITION');
    expect(amounts(schedule)).toEqual(['2544.00', '5088.00']);
  });
});
