import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import { createLoan, createLoanAllocation, createLoanTerms, getTaxYearView } from './application/index.js';
import { depreciationCommands } from './depreciation-commands.test-support.js';
import type { NewTaxClassification } from './domains/taxation/index.js';
import { parseMea, type Mea } from './domains/weg/index.js';
import {
  PostgresAcquisitionCostRepository,
  PostgresAcquisitionRepository,
  PostgresFinancialAccountRepository,
  PostgresLandBuildingAllocationRepository,
  PostgresLoanAllocationRepository,
  PostgresLoanRepository,
  PostgresLoanTermsRepository,
  PostgresOwnershipRepository,
  PostgresPartyRepository,
  PostgresTaxClassificationRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  PostgresWegRepository,
  PostgresWegSpecialAssessmentRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { Money, type BusinessDate } from './shared/index.js';
import { mrePrincipalVerifier } from './wiring.js';

/**
 * VC-8-05 end to end (api-design.md §58C "VC-8-05: the AfA in the view", Examples 1–4 and "Pointers for VC-8-06"),
 * wired as in main.ts, with ACC8 (synthetic): A 3/5 and B 2/5 of W from 2026-07-01; rent 1,100.00 and advances 250.00 a
 * month, Hausgeld without reserve 210.00 a month, all classified and confirmed by the user. Example 1 (2026, nothing
 * recorded: the shipped default, the view identical with the recording switch off and on); Example 4's
 * `BEFORE_DEPRECIATION` (an unreviewed allocation); Example 2 (2027, version 1 recorded before the repair, the repair
 * and the Sonderumlage use capitalised on the check, the Einbauküche a separate asset); Example 4's `PARTIAL_DEPRECIATION`
 * (a superseding unconfirmed allocation); Example 3 (2026 final after recording, 2027 and 2028 not final by
 * `SUBSEQUENT_COST_START_TO_VERIFY` alone); interest via a Loan keeping 2026 open; no cash mutated; Realm isolation.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee000000000008a5';
const REALM_B = '64b0c0ffee000000000008b5';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;
const money = (amount: string) => ({ amount, currency: 'EUR' });
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let counter = 0;
let clock = new Date('2027-02-15T10:00:00Z');
const now = () => clock;
const at = (date: string) => (clock = new Date(`${date}T10:00:00Z`));

describe.skipIf(databaseUrl === undefined)('the AfA in the tax-year view (VC-8-05) end to end', () => {
  const schema = testSchemaName('tax_year_afa_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  const servers: Server[] = [];
  const bases = { on: '', off: '' };
  let classifications: PostgresTaxClassificationRepository;
  const giro = new Map<string, string>();

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
    mre = await startFakeMre([
      { _id: REALM_A, name: 'A', members: member, applications: [], tenants: [] },
      { _id: REALM_B, name: 'B', members: member, applications: [], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    classifications = new PostgresTaxClassificationRepository(db);
    for (const realm of [REALM_A, REALM_B]) {
      const account = await new PostgresFinancialAccountRepository(db).create(
        { mreRealmId: realm, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null },
        actor,
      );
      if (account.kind !== 'CREATED') throw new Error(account.kind);
      giro.set(realm, account.account.id);
    }
    // The same view behind both apps; only the record command differs (the view never reads the switch, §60).
    for (const recordingEnabled of [false, true]) {
      const app = createApp({
        isReady: async () => true,
        verifyPrincipal: mrePrincipalVerifier(client),
        ...commandsWith({
          depreciationAssets: depreciationCommands(db, { recordingEnabled, now }),
          taxation: { taxYear: getTaxYearView({ repository: classifications, now }) },
          loans: { create: createLoan({ repository: new PostgresLoanRepository(db) }) },
          loanTerms: { create: createLoanTerms({ repository: new PostgresLoanTermsRepository(db) }) },
          loanAllocations: { create: createLoanAllocation({ repository: new PostgresLoanAllocationRepository(db) }) },
        }),
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      servers.push(server);
      bases[recordingEnabled ? 'on' : 'off'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    }
  });

  afterAll(async () => {
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
    await pool.end();
  });

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 300);
  const call = (method: string, path: string, body?: unknown, options: { realm?: string; base?: string; headers?: Record<string, string> } = {}) =>
    fetch(`${options.base ?? bases.on}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: options.realm ?? REALM_A, 'content-type': 'application/json', ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (res: Response, status = 200): Promise<Json> => {
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(status);
    return body;
  };
  const view = (pr: string, year: number, ownerPartyId?: string, base = bases.on) =>
    call('GET', `/property-references/${pr}/tax-years/${year}${ownerPartyId === undefined ? '' : `?ownerPartyId=${ownerPartyId}`}`, undefined, { base }).then(
      (r) => json(r),
    );
  const db = () => createDatabase(pool);
  const line = (v: Json, code: string): Json => v.werbungskosten.lines.find((l: Json) => l.line === code);
  const total = (v: Json, code: string) => line(v, code)?.total.amount;
  const codes = (flags: readonly { code: string }[]) => flags.map((f) => f.code);
  /** The fixture's purchase costs are unpaid (unlike §58C's examples): ACQUISITION_COST_UNPAID is informative, no figure moves. */
  const unpaidAside = (flags: readonly { code: string }[]) => codes(flags).filter((c) => c !== 'ACQUISITION_COST_UNPAID');
  const ownerFigures = (v: Json) =>
    v.owners.map((o: Json) => [
      o.einnahmen.total.amount,
      o.werbungskosten.total.amount,
      ...['AFA_BUILDING', 'AFA_SEPARATE_ASSETS'].map((c) => total(o, c)),
      o.result.amount.amount,
    ]);

  async function party(name: string, realm: string): Promise<string> {
    const outcome = await new PostgresPartyRepository(db()).create(
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
  async function allocate(realm: string, acquisitionId: string, reviewState: 'CONFIRMED' | 'UNREVIEWED', supersedes: string | null): Promise<string> {
    const outcome = await new PostgresLandBuildingAllocationRepository(db()).create(
      {
        mreRealmId: realm,
        acquisitionId,
        totalAllocableAmount: eur('318000.00'),
        landAmount: eur('63600.00'),
        buildingAmount: eur('254400.00'),
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
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome));
    return outcome.allocation.id;
  }
  /** ACC8's purchase (§59A): basis 254,400.00; the building of 1995 confirmed through the API. */
  async function acc8(realm = REALM_A, reviewState: 'CONFIRMED' | 'UNREVIEWED' = 'CONFIRMED') {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5e80000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const pr = (
      await pool.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
        [realm, mrePropertyId],
      )
    ).rows[0].id as string;
    const [a, b] = [await party('Käuferin A', realm), await party('Käufer B', realm)].sort() as [string, string];
    const acquisitions = new PostgresAcquisitionRepository(db());
    const created = await acquisitions.create(
      {
        mreRealmId: realm,
        propertyReferenceId: pr,
        purchasePrice: eur('300000.00'),
        acquiredShare: { numerator: 1, denominator: 1 },
        contractDate: day('2026-05-15'),
        economicTransferDate: day('2026-07-01'),
        landRegistryTransferDate: null,
        buyerPartyIds: [a, b],
        sellerPartyIds: [],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const w = created.acquisition.id;
    for (const [category, amount] of [
      ['REAL_ESTATE_TRANSFER_TAX', '15000.00'],
      ['NOTARY', '3000.00'],
      ['FINANCING_RELATED', '1200.00'],
    ] as const) {
      const cost = await new PostgresAcquisitionCostRepository(db()).createCost(
        {
          mreRealmId: realm,
          acquisitionId: w,
          category,
          amount: eur(amount),
          incurredDate: null,
          counterpartyPartyId: null,
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (cost.kind !== 'CREATED') throw new Error(cost.kind);
    }
    const allocation = await allocate(realm, w, reviewState, null);
    for (const [owner, n] of [
      [a, 3],
      [b, 2],
    ] as const) {
      const o = await new PostgresOwnershipRepository(db()).create(
        {
          mreRealmId: realm,
          propertyReferenceId: pr,
          ownerPartyId: owner,
          share: { numerator: n, denominator: 5 },
          validFrom: day('2026-07-01'),
          validUntil: null,
          acquisitionId: w,
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (o.kind !== 'CREATED') throw new Error(o.kind);
    }
    if ((await acquisitions.confirm(w, realm, new Date('2026-07-01T10:00:00Z'), actor)).kind !== 'CONFIRMED') throw new Error('confirm');
    const asset = await json(
      await call('POST', '/depreciation-assets', { propertyReferenceId: pr, buildingCompletionYear: 1995, reviewState: 'CONFIRMED' }, { realm }),
      201,
    );
    return { pr, a, b, w, allocation, building: asset.assetId as string, membership: await membershipOf(pr, realm) };
  }
  /** A confirmed Transaction with its splits; the split ids in order. */
  async function booked(pr: string | null, direction: 'INFLOW' | 'OUTFLOW', date: string, splits: readonly [string, string, string?][], realm = REALM_A) {
    const transactions = new PostgresTransactionRepository(db());
    const sum = splits.reduce((s, [amount]) => s.add(eur(amount)), eur('0.00'));
    const created = await transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: giro.get(realm) as string,
        amount: sum,
        direction,
        bookingDate: day(date),
        valueDate: null,
        description: 'Buchung (synthetisch)',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const replaced = await new PostgresTransactionSplitRepository(db()).replaceSplits(
      created.transaction.id,
      realm,
      splits.map(([amount, code, loanId]) => ({
        amount: eur(amount),
        financialCategoryCode: code,
        propertyReferenceId: loanId === undefined ? pr : null,
        loanId: loanId ?? null,
        securityDepositId: null,
        description: null,
      })),
      actor,
    );
    if (replaced.kind !== 'REPLACED') throw new Error(JSON.stringify(replaced));
    if ((await transactions.confirm(created.transaction.id, realm, actor)).kind !== 'CONFIRMED') throw new Error('confirm');
    return (await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [created.transaction.id])).rows.map(
      (r) => r.id as string,
    );
  }
  async function classify(request: Partial<NewTaxClassification> & { sourceId: string }, realm = REALM_A): Promise<string> {
    const outcome = await classifications.createClassification(
      {
        mreRealmId: realm,
        sourceType: 'TRANSACTION_SPLIT',
        taxCategory: 'MAINTENANCE',
        treatment: 'CAPITALIZED',
        reviewState: 'USER_CONFIRMED',
        supersedes: null,
        notes: null,
        sourceReferences: [],
        ...request,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome));
    return outcome.classification.id;
  }
  /** Rent 1,100.00 and advances 250.00 (one Transaction), Hausgeld 210.00 a month, each classified USER_CONFIRMED. */
  async function cashOf(pr: string, year: number, fromMonth: number, realm = REALM_A) {
    for (let month = fromMonth; month <= 12; month++) {
      const mm = String(month).padStart(2, '0');
      const [rent, advance] = await booked(
        pr,
        'INFLOW',
        `${year}-${mm}-15`,
        [
          ['1100.00', 'RENT_BASE'],
          ['250.00', 'RENT_OPERATING_COST_ADVANCE'],
        ],
        realm,
      );
      const [hausgeld] = await booked(pr, 'OUTFLOW', `${year}-${mm}-05`, [['210.00', 'WEG_NON_RECOVERABLE']], realm);
      await classify({ sourceId: rent as string, taxCategory: 'RENT', treatment: 'INCOME' }, realm);
      await classify({ sourceId: advance as string, taxCategory: 'OPERATING_COST_ADVANCES', treatment: 'INCOME' }, realm);
      await classify({ sourceId: hausgeld as string, taxCategory: 'WEG_HAUSGELD', treatment: 'DEDUCTIBLE' }, realm);
    }
  }
  /** The unit's WEG membership from 2020 (the Hausgeld is booked against it). */
  async function membershipOf(pr: string, realm: string): Promise<string> {
    const wegs = new PostgresWegRepository(db());
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
    return m.membership.id;
  }
  /** A Sonderumlage of the unit with one use of 9,000.00 on 2028-02-15 (§59B's example). */
  async function sonderumlage(membershipId: string): Promise<string> {
    const assessments = new PostgresWegSpecialAssessmentRepository(db());
    const today = day('2028-03-01');
    const a = await assessments.createAssessment(
      {
        mreRealmId: REALM_A,
        membershipId,
        description: 'Fassadensanierung (synthetisch)',
        resolutionDate: day('2028-01-10'),
        purpose: 'MAINTENANCE',
        totalAmount: null,
        unitShare: eur('9000.00'),
        instalments: [{ position: 1, dueDate: day('2028-02-01'), amount: eur('9000.00') }],
        sourceReferences: [],
        notes: null,
      },
      actor,
      today,
    );
    if (a.kind !== 'CREATED') throw new Error(a.kind);
    const uses = await assessments.replaceUses(
      a.assessment.id,
      REALM_A,
      [{ position: 1, date: day('2028-02-15'), description: 'Fassade', unitShare: eur('9000.00') }],
      actor,
      today,
    );
    if (uses.kind !== 'AMENDED') throw new Error(uses.kind);
    return a.assessment.id;
  }
  async function recordVersion(assetId: string, throughYear: number, acceptChangedYears: number[] = []) {
    const schedule = await json(await call('GET', `/depreciation-assets/${assetId}/schedule?from=${throughYear}&to=${throughYear}`));
    const body = {
      throughYear,
      reason: `AfA laut Einkommensteuererklärung ${throughYear} (synthetisch)`,
      expectedInputFingerprint: schedule.years[0].inputFingerprint,
      acceptChangedYears,
    };
    return json(await call('POST', `/depreciation-assets/${assetId}/schedule-versions`, body, { headers: { 'idempotency-key': `record-${++counter}` } }), 201);
  }

  it('Examples 1–4 of §58C (ACC8): the AfA lines, the block, result.basis, the owners, the recording flags and final', { timeout: 120_000 }, async () => {
    const { pr, a, b, w, allocation, building, membership } = await acc8();
    await cashOf(pr, 2026, 7);

    // Example 1: 2026, nothing recorded (the shipped default). The same answer with the recording switch off.
    at('2027-02-15');
    const e1 = await view(pr, 2026);
    expect(await view(pr, 2026, undefined, bases.off)).toEqual(e1);
    expect([
      e1.einnahmen.total.amount,
      e1.werbungskosten.total.amount,
      total(e1, 'WEG_HAUSGELD'),
      total(e1, 'AFA_BUILDING'),
      total(e1, 'AFA_SEPARATE_ASSETS'),
    ]).toEqual(['8100.00', '3804.00', '1260.00', '2544.00', '0.00']);
    expect(e1.result).toEqual({ amount: money('4296.00'), kind: 'SURPLUS', basis: 'AFTER_DEPRECIATION' });
    expect(line(e1, 'AFA_BUILDING').items).toEqual([
      expect.objectContaining({
        assetId: building,
        assetType: 'BUILDING',
        componentId: `ACQUISITION:${w}`,
        kind: 'ACQUISITION',
        acquisitionId: w,
        source: null,
        basis: money('254400.00'),
        rate: expect.objectContaining({ kind: 'BAND', rate: '1/50' }),
        start: { date: '2026-07-01', dateSource: 'ECONOMIC_TRANSFER_DATE', method: 'TRANSFER_DATE', month: '2026-07', firstYearMonths: 6 },
        months: 6,
        amount: money('2544.00'),
        rule: { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 },
        share: null,
        href: `/api/v1/depreciation-assets/${building}/schedule?from=2026&to=2026`,
      }),
    ]);
    expect(e1.depreciation).toEqual({
      status: 'AVAILABLE',
      amount: money('2544.00'),
      assets: [
        {
          assetId: building,
          assetType: 'BUILDING',
          description: null,
          reviewState: 'CONFIRMED',
          status: 'AVAILABLE',
          amount: money('2544.00'),
          itemCount: 1,
          reasons: [],
          recording: { state: 'NOT_RECORDED', versionId: null, versionNumber: null, throughYear: null, reproducible: null },
          href: `/api/v1/depreciation-assets/${building}/schedule?from=2026&to=2026`,
        },
      ],
      gaps: [],
      note: 'Ergebnis nach AfA.',
    });
    expect(ownerFigures(e1)).toEqual([
      ['4860.00', '2282.40', '1526.40', '0.00', '2577.60'],
      ['3240.00', '1521.60', '1017.60', '0.00', '1718.40'],
    ]);
    expect(e1.flags).toEqual([
      { code: 'DEPRECIATION_SCHEDULE_NOT_RECORDED', details: { assetId: building, assetType: 'BUILDING', currentVersionId: null, currentThroughYear: null } },
      { code: 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL', details: { acquisitionIds: [w] } },
    ]);
    expect(e1.review).toMatchObject({
      final: false,
      open: [
        { code: 'DEPRECIATION_SCHEDULE_NOT_RECORDED', count: 1 },
        { code: 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL', count: 1 },
      ],
      reviewStates: { SUGGESTED: 0, USER_CONFIRMED: 18, ADVISOR_CONFIRMED: 0, NEEDS_REVIEW: 0 },
    });
    // The fixture's costs are unpaid (unlike Example 1): ACQUISITION_COST_UNPAID is informative and changes nothing.
    expect(e1.review.info.map((i: Json) => i.code).filter((c: string) => c !== 'ACQUISITION_COST_UNPAID')).toEqual([]);
    expect(e1.ruleVersions).toContainEqual(expect.objectContaining({ ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2, status: 'ACTIVE', itemCount: 1 }));
    // Lower by exactly the AfA than Phase 7's 6,840.00; the owners' AfA is the schedule's parts.
    const ownerA = await view(pr, 2026, a);
    expect([line(ownerA, 'AFA_BUILDING').items[0].share, ownerA.result]).toEqual([
      expect.objectContaining({ share: '3/5', amount: money('1526.40'), partKey: `OWNER:${a}` }),
      { amount: money('2577.60'), kind: 'SURPLUS', basis: 'AFTER_DEPRECIATION' },
    ]);

    // Example 4, BEFORE_DEPRECIATION: another property whose allocation is still UNREVIEWED.
    const unreviewed = await acc8(REALM_A, 'CONFIRMED');
    const pending = await allocate(REALM_A, unreviewed.w, 'UNREVIEWED', unreviewed.allocation);
    expect(pending).toBeTruthy();
    await cashOf(unreviewed.pr, 2026, 7);
    const e4 = await view(unreviewed.pr, 2026);
    expect([e4.werbungskosten.total.amount, total(e4, 'AFA_BUILDING'), line(e4, 'AFA_BUILDING').itemCount, e4.result]).toEqual([
      '1260.00',
      '0.00',
      0,
      { amount: money('6840.00'), kind: 'SURPLUS', basis: 'BEFORE_DEPRECIATION' },
    ]);
    expect(e4.depreciation).toMatchObject({
      status: 'DEPRECIATION_NOT_AVAILABLE',
      amount: null,
      gaps: [
        {
          code: 'ALLOCATION_NOT_CONFIRMED',
          assetId: unreviewed.building,
          componentId: `ACQUISITION:${unreviewed.w}`,
          ownerPartyIds: [unreviewed.a, unreviewed.b],
          details: { reasons: ['ALLOCATION_NOT_CONFIRMED'] },
        },
      ],
      assets: [
        expect.objectContaining({
          status: 'DEPRECIATION_NOT_AVAILABLE',
          amount: null,
          itemCount: 0,
          recording: expect.objectContaining({ state: 'NOT_RECORDED' }),
        }),
      ],
      note: 'Ergebnis vor AfA; die AfA ist nicht berechenbar, siehe gaps.',
    });
    expect(codes(e4.flags)).toEqual(['DEPRECIATION_NOT_AVAILABLE', 'DEPRECIATION_SCHEDULE_NOT_RECORDED', 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL']);
    expect(e4.review.open).toEqual([
      { code: 'DEPRECIATION_NOT_AVAILABLE', count: 1 },
      { code: 'DEPRECIATION_SCHEDULE_NOT_RECORDED', count: 1 },
      { code: 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL', count: 1 },
      { code: 'ALLOCATION_NOT_CONFIRMED', count: 1 },
    ]);
    expect(e4.owners.map((o: Json) => o.result.amount.amount)).toEqual(['4104.00', '2736.00']);

    // Example 2: 2027. Version 1 of the building recorded through 2027 on 2028-01-20 (5,088.00), before the repair.
    await cashOf(pr, 2027, 1);
    const [repair] = await booked(pr, 'OUTFLOW', '2027-03-10', [['35700.00', 'MAINTENANCE']]);
    const repairDeductible = await classify({ sourceId: repair as string, treatment: 'DEDUCTIBLE', netAmount: eur('30000.00') });
    const use = await sonderumlage(membership);
    const useDeductible = await classify({
      sourceType: 'WEG_ASSESSMENT_USE',
      sourceId: use,
      sourcePosition: 1,
      taxCategory: 'WEG_SPENDING',
      treatment: 'DEDUCTIBLE',
      netAmount: eur('9000.00'),
    });
    at('2028-01-20');
    const v1 = await recordVersion(building, 2027);
    expect(v1.years.map((y: Json) => [y.year, y.amount.amount])).toEqual([
      [2026, '2544.00'],
      [2027, '5088.00'],
    ]);
    // The repair and the use capitalised on the check; the Einbauküche a separate asset (not recorded).
    await classify({ sourceId: repair as string, netAmount: eur('30000.00'), anschaffungsnaheAcquisitionId: w, supersedes: repairDeductible });
    await classify({
      sourceType: 'WEG_ASSESSMENT_USE',
      sourceId: use,
      sourcePosition: 1,
      taxCategory: 'WEG_SPENDING',
      netAmount: eur('9000.00'),
      anschaffungsnaheAcquisitionId: w,
      supersedes: useDeductible,
    });
    const [kitchenSplit] = await booked(pr, 'OUTFLOW', '2027-04-28', [['6000.00', 'MAINTENANCE']]);
    await classify({ sourceId: kitchenSplit as string, taxCategory: 'OTHER_EXPENSE' });
    const kitchen = await json(
      await call(
        'POST',
        '/depreciation-assets',
        {
          propertyReferenceId: pr,
          assetType: 'SEPARATE_ASSET',
          description: 'Einbauküche, Wohnung 3 (synthetisch)',
          usefulLifeYears: 10,
          usefulLifeBasis: 'BFH IX R 14/15: Einbauküche als einheitliches Wirtschaftsgut, 10 Jahre (verification-checklist B8)',
          acquiredOn: '2027-04-20',
          items: [{ sourceType: 'TRANSACTION_SPLIT', sourceId: kitchenSplit, sourcePosition: null }],
        },
        { headers: { 'idempotency-key': `kitchen-${++counter}` } },
      ),
      201,
    );
    await json(await call('POST', `/depreciation-assets/${kitchen.assetId}/confirm`, { reviewState: 'CONFIRMED' }, { headers: { 'if-match': '"1"' } }));
    at('2028-03-01');
    const e2 = await view(pr, 2027);
    expect([
      e2.einnahmen.total.amount,
      e2.werbungskosten.total.amount,
      total(e2, 'WEG_HAUSGELD'),
      total(e2, 'MAINTENANCE'),
      total(e2, 'AFA_BUILDING'),
      total(e2, 'AFA_SEPARATE_ASSETS'),
    ]).toEqual(['16200.00', '8772.00', '2520.00', '0.00', '5802.00', '450.00']);
    expect(e2.result).toEqual({ amount: money('7428.00'), kind: 'SURPLUS', basis: 'AFTER_DEPRECIATION' });
    expect(
      line(e2, 'AFA_BUILDING').items.map((i: Json) => [
        i.componentId,
        i.kind,
        i.basis.amount,
        i.start.month,
        i.start.method,
        i.months,
        i.amount.amount,
        unpaidAside(i.flags),
      ]),
    ).toEqual([
      [`ACQUISITION:${w}`, 'ACQUISITION', '254400.00', '2026-07', 'TRANSFER_DATE', 12, '5088.00', []],
      [
        `TRANSACTION_SPLIT:${repair}`,
        'CAPITALIZED_ITEM',
        '35700.00',
        '2027-01',
        'START_OF_YEAR',
        12,
        '714.00',
        ['ANSCHAFFUNGSNAHE_CAPITALIZED', 'SUBSEQUENT_COST_START_TO_VERIFY'],
      ],
    ]);
    expect(
      line(e2, 'AFA_SEPARATE_ASSETS').items.map((i: Json) => [
        i.assetId,
        i.description,
        i.componentId,
        i.basis.amount,
        i.rate.rate,
        i.start.month,
        i.start.method,
        i.months,
        i.amount.amount,
        i.rule,
      ]),
    ).toEqual([
      [
        kitchen.assetId,
        'Einbauküche, Wohnung 3 (synthetisch)',
        `TRANSACTION_SPLIT:${kitchenSplit}`,
        '6000.00',
        '1/10',
        '2027-04',
        'MONTH_OF_ACQUISITION',
        9,
        '450.00',
        { ruleCode: 'DE_AFA_MOVABLE_LINEAR', version: 1 },
      ],
    ]);
    expect([e2.capitalized.total.amount, e2.capitalized.items.map((i: Json) => [i.sourceId, i.lineAmount.amount, i.component])]).toEqual([
      '41700.00',
      [
        [repair, '35700.00', { assetId: building, assetType: 'BUILDING', componentId: `TRANSACTION_SPLIT:${repair}`, computable: true, reasons: [] }],
        [
          kitchenSplit,
          '6000.00',
          { assetId: kitchen.assetId, assetType: 'SEPARATE_ASSET', componentId: `TRANSACTION_SPLIT:${kitchenSplit}`, computable: true, reasons: [] },
        ],
      ],
    ]);
    expect(e2.depreciation).toMatchObject({ status: 'AVAILABLE', amount: money('6252.00'), gaps: [] });
    expect(e2.depreciation.assets.map((x: Json) => [x.assetId, x.amount.amount, x.itemCount, x.recording])).toEqual([
      [building, '5802.00', 2, { state: 'CHANGED_SINCE_RECORDED', versionId: v1.versionId, versionNumber: 1, throughYear: 2027, reproducible: true }],
      [kitchen.assetId, '450.00', 1, { state: 'NOT_RECORDED', versionId: null, versionNumber: null, throughYear: null, reproducible: null }],
    ]);
    expect(ownerFigures(e2)).toEqual([
      ['9720.00', '5263.20', '3481.20', '270.00', '4456.80'],
      ['6480.00', '3508.80', '2320.80', '180.00', '2971.20'],
    ]);
    expect(e2.owners.map((o: Json) => o.capitalized.total.amount)).toEqual(['25020.00', '16680.00']);
    expect(codes(e2.flags)).toEqual(['DEPRECIATION_CHANGED_SINCE_RECORDED', 'DEPRECIATION_SCHEDULE_NOT_RECORDED', 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL']);
    // The recorded figure only in the flag's details; the line shows the derived one.
    expect(e2.flags[0].details).toMatchObject({
      assetId: building,
      versionId: v1.versionId,
      versionNumber: 1,
      year: 2027,
      recorded: money('5088.00'),
      derived: money('5802.00'),
      amountChanged: true,
      causes: ['INPUTS'],
      owners: [
        { partKey: `OWNER:${a}`, ownerPartyId: a, recorded: money('3052.80'), derived: money('3481.20') },
        { partKey: `OWNER:${b}`, ownerPartyId: b, recorded: money('2035.20'), derived: money('2320.80') },
      ],
      components: [{ componentId: `TRANSACTION_SPLIT:${repair}`, change: 'ADDED', recorded: null, derived: money('714.00') }],
    });
    expect(e2.review.open).toEqual([
      { code: 'DEPRECIATION_CHANGED_SINCE_RECORDED', count: 1 },
      { code: 'DEPRECIATION_SCHEDULE_NOT_RECORDED', count: 1 },
      { code: 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL', count: 1 },
      { code: 'SUBSEQUENT_COST_START_TO_VERIFY', count: 1 },
    ]);
    expect(e2.review.info).toEqual(
      expect.arrayContaining([
        { code: 'ANSCHAFFUNGSNAHE_CAPITALIZED', count: 1 },
        { code: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', count: 1 },
      ]),
    );
    expect(e2.ruleVersions.filter((r: Json) => r.ruleCode.startsWith('DE_AFA')).map((r: Json) => [r.ruleCode, r.version, r.itemCount])).toEqual([
      ['DE_AFA_BUILDING_LINEAR', 2, 2],
      ['DE_AFA_MOVABLE_LINEAR', 1, 1],
    ]);

    // Example 4, PARTIAL_DEPRECIATION: a superseding allocation recorded and not yet confirmed.
    const unconfirmed = await allocate(REALM_A, w, 'UNREVIEWED', allocation);
    const p4 = await view(pr, 2027);
    expect([total(p4, 'AFA_BUILDING'), total(p4, 'AFA_SEPARATE_ASSETS'), p4.depreciation.amount, p4.werbungskosten.total.amount, p4.result]).toEqual([
      '714.00',
      '450.00',
      money('1164.00'),
      '3684.00',
      { amount: money('12516.00'), kind: 'SURPLUS', basis: 'PARTIAL_DEPRECIATION' },
    ]);
    expect(p4.depreciation.gaps).toEqual([
      {
        code: 'ALLOCATION_NOT_CONFIRMED',
        assetId: building,
        componentId: `ACQUISITION:${w}`,
        ownerPartyIds: [a, b],
        details: { reasons: ['ALLOCATION_NOT_CONFIRMED'] },
      },
    ]);
    expect(codes(p4.flags)).toEqual([
      'DEPRECIATION_INCOMPLETE',
      'DEPRECIATION_CHANGED_SINCE_RECORDED',
      'DEPRECIATION_SCHEDULE_NOT_RECORDED',
      'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL',
    ]);
    expect(ownerFigures(p4).map((o: string[]) => [o[2], o[3], o[4]])).toEqual([
      ['428.40', '270.00', '7509.60'],
      ['285.60', '180.00', '5006.40'],
    ]);
    // Confirmed again (a new allocation with the same amounts): the purchase is computed again.
    await allocate(REALM_A, w, 'CONFIRMED', unconfirmed);
    expect(total(await view(pr, 2027), 'AFA_BUILDING')).toBe('5802.00');

    // Example 3: after the window, version 2 of the building through 2028 (naming the changed years) and the kitchen's
    // version 1. 2026 is final for the first time; 2027 and 2028 stay open by SUBSEQUENT_COST_START_TO_VERIFY alone.
    at('2029-10-15');
    const v2 = await recordVersion(building, 2028, [2026, 2027]);
    await recordVersion(kitchen.assetId, 2028);
    const e3 = await view(pr, 2026);
    expect(e3.depreciation).toMatchObject({
      status: 'AVAILABLE',
      amount: money('2544.00'),
      gaps: [],
      assets: [
        expect.objectContaining({
          assetId: building,
          recording: { state: 'UNCHANGED', versionId: v2.versionId, versionNumber: 2, throughYear: 2028, reproducible: true },
        }),
      ],
    });
    expect(e3.acquisitions).toEqual([expect.objectContaining({ acquisitionId: w, status: 'ABOVE_THRESHOLD', final: true })]);
    expect([e3.result, e3.flags, e3.review.final, e3.review.open]).toEqual([
      { amount: money('4296.00'), kind: 'SURPLUS', basis: 'AFTER_DEPRECIATION' },
      [],
      true,
      [],
    ]);
    expect((await view(pr, 2026, a)).review.final).toBe(true);
    for (const year of [2027, 2028]) {
      const later = await view(pr, year);
      expect([later.depreciation.assets.map((x: Json) => x.recording.state), later.review.open, later.review.final], String(year)).toEqual([
        ['UNCHANGED', 'UNCHANGED'],
        [{ code: 'SUBSEQUENT_COST_START_TO_VERIFY', count: year === 2027 ? 1 : 2 }],
        false,
      ]);
    }

    // Interest via a Loan (ACC7's second debit): a debit before the Loan's first set keeps 2026 from being final.
    const bank = await party('Bank Beispiel (synthetisch)', REALM_A);
    const loan = await json(
      await call('POST', '/loans', { lenderPartyId: bank, borrowerPartyIds: [a, b], principalOriginal: money('180000.00'), startDate: '2026-07-01' }),
      201,
    );
    await json(
      await call('POST', `/loans/${loan.loanId}/terms`, {
        validFrom: '2026-07-01',
        interestRate: '3.000',
        repaymentModel: 'INTEREST_ONLY',
        firstPaymentDate: '2026-07-31',
      }),
      201,
    );
    await json(
      await call('POST', `/loans/${loan.loanId}/allocations`, {
        validFrom: '2026-10-01',
        basis: 'MANUAL',
        allocations: [{ propertyReferenceId: pr, share: '1/1' }],
      }),
      201,
    );
    await booked(null, 'OUTFLOW', '2026-09-20', [['120.00', 'LOAN_INTEREST', loan.loanId]]);
    const withInterest = await view(pr, 2026);
    expect([withInterest.review.final, codes(withInterest.flags), withInterest.depreciation.assets[0].recording.state]).toEqual([
      false,
      ['LOAN_INTEREST_NOT_ATTRIBUTED'],
      'UNCHANGED',
    ]);
    expect(withInterest.review.open).toContainEqual({ code: 'LOAN_INTEREST_NOT_ATTRIBUTED', count: 1 });
  });

  it('no cash mutated around views of three years at both levels; Realm isolation of the AfA', { timeout: 60_000 }, async () => {
    at('2028-03-01');
    const mine = await acc8();
    const theirs = await acc8(REALM_B);
    const [theirSplit] = await booked(theirs.pr, 'OUTFLOW', '2027-03-10', [['35700.00', 'MAINTENANCE']], REALM_B);
    await classify({ sourceId: theirSplit as string }, REALM_B);
    const before = await rowsSnapshot(pool);
    const views: Json[] = [];
    for (const year of [2026, 2027, 2028]) for (const owner of [undefined, mine.a]) views.push(await view(mine.pr, year, owner));
    expect(await rowsSnapshot(pool)).toEqual(before);
    // Another Realm's asset, capitalised source and Ownership never reach this Realm's AfA lines, gaps or flags.
    const v2027 = views[2];
    expect([
      v2027.depreciation.assets.map((x: Json) => x.assetId),
      line(v2027, 'AFA_BUILDING').items.map((i: Json) => i.componentId),
      v2027.capitalized.items,
    ]).toEqual([[mine.building], [`ACQUISITION:${mine.w}`], []]);
    expect(JSON.stringify(views)).not.toContain(theirs.building);
    expect(JSON.stringify(views)).not.toContain(theirSplit);
    expect((await call('GET', `/property-references/${theirs.pr}/tax-years/2027`)).status).toBe(404);
    expect((await call('GET', `/property-references/${mine.pr}/tax-years/2027`, undefined, { realm: REALM_B })).status).toBe(404);
  });
});
