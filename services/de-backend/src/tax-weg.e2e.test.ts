import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  closeOwnership,
  confirmAcquisition,
  confirmAnnualStatement,
  confirmTransaction,
  createAcquisition,
  createAcquisitionCost,
  createAnnualStatement,
  createFinancialAccount,
  createLandBuildingAllocation,
  createManualTransaction,
  createMembership,
  createOwnership,
  createParty,
  createSpecialAssessment,
  createTaxClassification,
  createWeg,
  getAnschaffungsnaheCheck,
  getTaxMeaning,
  getUseTaxMeaning,
  getWithdrawalTaxMeaning,
  listTaxClassificationHistory,
  listTaxMeanings,
  replaceAssessmentUses,
  setTransactionSplits,
} from './application/index.js';
import {
  PostgresAcquisitionCostRepository,
  PostgresAcquisitionRepository,
  PostgresFinancialAccountRepository,
  PostgresLandBuildingAllocationRepository,
  PostgresOwnershipRepository,
  PostgresPartyRepository,
  PostgresTaxClassificationRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  PostgresWegAnnualStatementRepository,
  PostgresWegRepository,
  PostgresWegSpecialAssessmentRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';

/**
 * VC-7-03 end to end (api-design.md §58B), wired as in main.ts: the anschaffungsnahe check above 15 % (a repair with a
 * net amount and a Sonderumlage use), followed by a capitalisation and its counter-check outside the window; a § 82b
 * election over three years with the end of ownership; a superseded statement with dated and undated withdrawals; and
 * Realm isolation. Synthetic figures and names only.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee000000000000e1';
const REALM_B = '64b0c0ffee000000000000e2';

describe.skipIf(databaseUrl === undefined)('WEG spending, Erhaltungsaufwand and § 82b (VC-7-03) end to end', () => {
  const schema = testSchemaName('tax_weg_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let app: Express;
  let server: Server;
  let base: string;
  const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    mre = await startFakeMre([
      { _id: REALM_A, name: 'A', members: member, applications: [], tenants: [] },
      { _id: REALM_B, name: 'B', members: member, applications: [], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const wegs = new PostgresWegRepository(db);
    const statements = new PostgresWegAnnualStatementRepository(db);
    const assessments = new PostgresWegSpecialAssessmentRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const acquisitions = new PostgresAcquisitionRepository(db);
    const ownerships = new PostgresOwnershipRepository(db);
    const classifications = new PostgresTaxClassificationRepository(db);
    app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        parties: { create: createParty({ repository: new PostgresPartyRepository(db) }) },
        ownerships: { create: createOwnership({ repository: ownerships }), close: closeOwnership({ repository: ownerships }) },
        acquisitions: { create: createAcquisition({ repository: acquisitions }), confirm: confirmAcquisition({ repository: acquisitions }) },
        acquisitionCosts: { createCost: createAcquisitionCost({ repository: new PostgresAcquisitionCostRepository(db) }) },
        landBuildingAllocations: { create: createLandBuildingAllocation({ repository: new PostgresLandBuildingAllocationRepository(db) }) },
        wegs: { createWeg: createWeg({ repository: wegs }), createMembership: createMembership({ repository: wegs }) },
        wegAnnualStatements: { create: createAnnualStatement({ repository: statements }), confirm: confirmAnnualStatement({ repository: statements }) },
        wegSpecialAssessments: { create: createSpecialAssessment({ repository: assessments }), replaceUses: replaceAssessmentUses({ repository: assessments }) },
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: transactions }),
        },
        taxation: {
          create: createTaxClassification({ repository: classifications }),
          history: listTaxClassificationHistory({ repository: classifications }),
          taxMeaning: getTaxMeaning({ repository: classifications }),
          withdrawalTaxMeaning: getWithdrawalTaxMeaning({ repository: classifications }),
          useTaxMeaning: getUseTaxMeaning({ repository: classifications }),
          anschaffungsnahe: getAnschaffungsnaheCheck({ repository: classifications }),
          taxMeanings: listTaxMeanings({ repository: classifications }),
        },
      }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
    await pool.end();
  });

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 300);
  const call = (realm: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const A = (method: string, path: string, body?: unknown) => call(REALM_A, method, path, body);
  const B = (method: string, path: string, body?: unknown) => call(REALM_B, method, path, body);
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
  type Flag = { code: string; details: Record<string, unknown> };
  type Item = { sourceType: string; sourceId: string; sourcePosition: number | null; yearAmount: { amount: string }; taxCategory: string; treatment: string | null };
  const codes = (flags: readonly Flag[]) => flags.map((f) => f.code);
  let counter = 0;

  async function flat(realm = REALM_A) {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f7e000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function membership(pr: string) {
    const weg = await json<{ wegId: string }>(await A('POST', '/wegs', { displayName: `WEG ${++counter}` }), 201);
    return (
      await json<{ membershipId: string }>(
        await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: pr, miteigentumsanteil: '125/1000', validFrom: '2020-01-01' }),
        201,
      )
    ).membershipId;
  }
  let giro = '';
  async function booked(pr: string, amount: string, code: string, bookingDate: string) {
    if (giro === '') {
      giro = (await json<{ financialAccountId: string }>(await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }), 201))
        .financialAccountId;
    }
    const tx = (
      await json<{ transactionId: string }>(
        await A('POST', '/transactions', { financialAccountId: giro, amount: eur(amount), direction: 'OUTFLOW', bookingDate, propertyReferenceId: pr }),
        201,
      )
    ).transactionId;
    const split = await json<{ splits: { splitId: string }[] }>(
      await A('PUT', `/transactions/${tx}/splits`, { splits: [{ amount: eur(amount), financialCategoryCode: code, propertyReferenceId: pr }] }),
      200,
    );
    await json(await A('POST', `/transactions/${tx}/confirm`), 200);
    return split.splits[0]?.splitId as string;
  }
  const classify = (body: Record<string, unknown>) =>
    A('POST', '/tax-classifications', { reviewState: 'USER_CONFIRMED', supersedes: null, ...body });
  const items = async (pr: string, year: number, realm = REALM_A) =>
    (await json<{ items: Item[] }>(await call(realm, 'GET', `/property-references/${pr}/tax-meanings?year=${year}`), 200)).items;

  it('the check above 15 %: a repair net and a Sonderumlage use; flagged, unchanged; a capitalisation on the check stays above; the counter-check outside the window', async () => {
    const pr = await flat();
    const m = await membership(pr);
    const party = (await json<{ partyId: string }>(await A('POST', '/parties', { partyType: 'PERSON', displayName: 'Anna Käuferin' }), 201)).partyId;
    const acquisition = (
      await json<{ acquisitionId: string }>(
        await A('POST', '/acquisitions', {
          propertyReferenceId: pr,
          purchasePrice: eur('240000.00'),
          acquiredShare: '1/1',
          contractDate: '2026-02-01',
          economicTransferDate: '2026-03-15',
          buyerPartyIds: [party],
          sellerPartyIds: [],
        }),
        201,
      )
    ).acquisitionId;
    await json(await A('POST', '/ownerships', { propertyReferenceId: pr, ownerPartyId: party, share: '1/1', validFrom: '2026-03-15', acquisitionId: acquisition }), 201);
    await json(await A('POST', `/acquisitions/${acquisition}/confirm`, {}), 200);
    await json(await A('POST', `/acquisitions/${acquisition}/costs`, { category: 'REAL_ESTATE_TRANSFER_TAX', amount: eur('24000.00') }), 201);
    await json(await A('POST', `/acquisitions/${acquisition}/costs`, { category: 'FINANCING_RELATED', amount: eur('1500.00') }), 201);
    await json(
      await A('POST', `/acquisitions/${acquisition}/land-building-allocation`, {
        totalAllocableAmount: eur('264000.00'),
        landAmount: eur('66000.00'),
        buildingAmount: eur('198000.00'),
        method: 'PURCHASE_CONTRACT',
        reviewState: 'CONFIRMED',
        supersedes: null,
      }),
      201,
    );
    const check = async (path = acquisition) =>
      json<{
        status: string;
        threshold: { amount: string };
        sum: { amount: string };
        final: boolean;
        affectedYears: number[] | null;
        basis: { basisAmount: { amount: string }; acquisitionCosts: { amount: string } };
        flags: Flag[];
        sources: { sourceType: string; suggestedTreatment: string | null; flags: Flag[] }[];
        excluded: { sourceType: string; reason: string }[];
      }>(
        // The check reads "today" from the clock: the window (to 15.03.2029) is open.
        await A('GET', `/acquisitions/${path}/anschaffungsnahe-herstellungskosten`),
        200,
      );

    // The repair: 18,000.00 gross in May 2026, 15,126.05 net: alone below the threshold of 29,700.00.
    const repair = await booked(pr, '18000.00', 'MAINTENANCE', '2026-05-14');
    await json(await classify({ sourceType: 'TRANSACTION_SPLIT', sourceId: repair, taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', netAmount: eur('15126.05') }), 201);
    const alone = await check();
    expect(alone).toMatchObject({ status: 'NOT_ABOVE_THRESHOLD', threshold: eur('29700.00'), sum: eur('15126.05'), basis: { basisAmount: eur('198000.00'), acquisitionCosts: eur('24000.00') } });

    // The Sonderumlage use of 14,800.00 on 10.06.2027, classified WEG_SPENDING / DEDUCTIBLE: 29,926.05, above.
    const assessment = (
      await json<{ assessmentId: string }>(
        await A('POST', `/weg-memberships/${m}/special-assessments`, {
          description: 'Fassadensanierung',
          resolutionDate: '2027-01-20',
          purpose: 'MAINTENANCE',
          unitShare: eur('14800.00'),
          instalments: [{ position: 1, dueDate: '2027-03-01', amount: eur('14800.00') }],
        }),
        201,
      )
    ).assessmentId;
    const setUse = (date: string) =>
      A('PUT', `/weg-special-assessments/${assessment}/uses`, { uses: [{ position: 1, date, description: 'Fassade', unitShare: eur('14800.00') }] });
    await json(await setUse('2027-06-10'), 200);
    const use = await json<{ classificationId: string }>(
      await classify({ sourceType: 'WEG_ASSESSMENT_USE', sourceId: assessment, sourcePosition: 1, taxCategory: 'WEG_SPENDING', treatment: 'DEDUCTIBLE' }),
      201,
    );
    const above = await check();
    expect(above).toMatchObject({ status: 'ABOVE_THRESHOLD', sum: eur('29926.05'), final: false, affectedYears: [2026, 2027] });
    const reasons = (above.flags.find((f) => f.code === 'NOT_FINAL')?.details as { reasons: string[] }).reasons;
    expect(reasons).toEqual(expect.arrayContaining(['GROSS_AMOUNTS', 'WINDOW_OPEN']));
    expect(above.sources.map((s) => s.suggestedTreatment)).toEqual(['CAPITALIZED', 'CAPITALIZED']);
    // Both sources flagged in their meanings; their treatments unchanged.
    const repairMeaning = await json<{ treatment: string; reviewState: string; suggestion: { treatment: string } | null; flags: Flag[] }>(
      await A('GET', `/transaction-splits/${repair}/tax-meaning`),
      200,
    );
    expect(repairMeaning).toMatchObject({ treatment: 'DEDUCTIBLE', reviewState: 'USER_CONFIRMED', suggestion: { treatment: 'CAPITALIZED' } });
    expect(codes(repairMeaning.flags)).toContain('ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN');
    const useMeaning = await json<{ treatment: string; flags: Flag[] }>(await A('GET', `/weg-special-assessments/${assessment}/uses/1/tax-meaning`), 200);
    expect(useMeaning.treatment).toBe('DEDUCTIBLE');
    expect(codes(useMeaning.flags)).toEqual(expect.arrayContaining(['ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', 'VAT_NOT_SEPARATED']));

    // The use reclassified CAPITALIZED on this check: still above (open question 7).
    const capitalised = await json<{ treatmentRule: { ruleCode: string } }>(
      await classify({
        sourceType: 'WEG_ASSESSMENT_USE',
        sourceId: assessment,
        sourcePosition: 1,
        taxCategory: 'WEG_SPENDING',
        treatment: 'CAPITALIZED',
        anschaffungsnaheAcquisitionId: acquisition,
        supersedes: use.classificationId,
      }),
      201,
    );
    expect(capitalised.treatmentRule).toEqual({ ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 });
    expect(await check()).toMatchObject({ status: 'ABOVE_THRESHOLD', sum: eur('29926.05') });

    // Counter-check: the same use dated 16.03.2029, outside the window: not above. It lies in the 90-day strip after
    // the window's end, so it is listed, never summed, and the result stays NOT_FINAL.
    await json(await setUse('2029-03-16'), 200);
    const history = await json<{ items: { classificationId: string; supersededBy: string | null }[] }>(
      await A('GET', `/tax-classifications?sourceType=WEG_ASSESSMENT_USE&sourceId=${assessment}&sourcePosition=1`),
      200,
    );
    const current = history.items.find((c) => c.supersededBy === null)?.classificationId;
    await json(
      await classify({
        sourceType: 'WEG_ASSESSMENT_USE',
        sourceId: assessment,
        sourcePosition: 1,
        taxCategory: 'WEG_SPENDING',
        treatment: 'DEDUCTIBLE',
        supersedes: current,
      }),
      201,
    );
    const outside = await check();
    expect(outside).toMatchObject({ status: 'NOT_ABOVE_THRESHOLD', sum: eur('15126.05') });
    expect(outside.excluded).toEqual([expect.objectContaining({ sourceType: 'WEG_ASSESSMENT_USE', reason: 'AFTER_WINDOW_NEAR_EDGE' })]);
    expect((outside.flags.find((f) => f.code === 'NOT_FINAL')?.details as { reasons: string[] }).reasons).toContain('DATES_NEAR_WINDOW_EDGE');

    // Realm isolation on the check and on create with the Acquisition.
    expect((await B('GET', `/acquisitions/${acquisition}/anschaffungsnahe-herstellungskosten`)).status).toBe(404);
  });

  it('a § 82b election: 9,000.00 over three years, 3,000.00 in each year’s list; the Ownership closed in the second year → 3,000.00 and 6,000.00', async () => {
    const pr = await flat();
    const party = (await json<{ partyId: string }>(await A('POST', '/parties', { partyType: 'PERSON', displayName: 'Ben Vermieter' }), 201)).partyId;
    const ownership = (
      await json<{ ownershipId: string }>(await A('POST', '/ownerships', { propertyReferenceId: pr, ownerPartyId: party, share: '1/1', validFrom: '2020-01-01' }), 201)
    ).ownershipId;
    const repair = await booked(pr, '9000.00', 'MAINTENANCE', '2026-08-03');
    const elected = await json<{ treatmentRule: unknown; distributionYears: number; mostlyResidentialConfirmed: boolean }>(
      await classify({
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: repair,
        taxCategory: 'MAINTENANCE',
        treatment: 'DISTRIBUTED_82B',
        distributionYears: 3,
        mostlyResidentialConfirmed: true,
      }),
      201,
    );
    expect(elected).toMatchObject({ treatmentRule: { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 }, distributionYears: 3, mostlyResidentialConfirmed: true });
    const yearAmounts = async (year: number) => (await items(pr, year)).map((i) => i.yearAmount.amount);
    expect([await yearAmounts(2026), await yearAmounts(2027), await yearAmounts(2028), await yearAmounts(2029)]).toEqual([['3000.00'], ['3000.00'], ['3000.00'], []]);
    await json(await A('POST', `/ownerships/${ownership}/close`, { validUntil: '2027-09-30' }), 200);
    expect([await yearAmounts(2026), await yearAmounts(2027), await yearAmounts(2028)]).toEqual([['3000.00'], ['6000.00'], []]);
    const meaning = await json<{ distribution: { endYear: number; parts: unknown[] }; flags: Flag[] }>(await A('GET', `/transaction-splits/${repair}/tax-meaning`), 200);
    expect(meaning.distribution).toMatchObject({ endYear: 2027, parts: [{ year: 2026, amount: eur('3000.00') }, { year: 2027, amount: eur('6000.00') }] });
    expect(codes(meaning.flags)).toContain('DISTRIBUTION_ENDED');
    // A refund is never distributed; mostlyResidentialConfirmed false is no election.
    expect(
      (
        await json<{ error: { code: string; details: { reason: string } } }>(
          await classify({ sourceType: 'TRANSACTION_SPLIT', sourceId: repair, taxCategory: 'MAINTENANCE', treatment: 'DISTRIBUTED_82B', distributionYears: 3, mostlyResidentialConfirmed: false }),
          422,
        )
      ).error,
    ).toMatchObject({ code: 'DISTRIBUTION_NOT_ALLOWED', details: { reason: 'NOT_MOSTLY_RESIDENTIAL' } });
  });

  it('a superseded statement: the old classifications stop counting, the new withdrawals read NEEDS_REVIEW with PREDECESSOR_CLASSIFIED; the list holds only the new; never a cost line; the reserve contribution NOT_RELEVANT; Realm isolation', async () => {
    const pr = await flat();
    const m = await membership(pr);
    const statementBody = (lines: unknown[], supersedes: string | null = null) => ({
      financialYear: 2026,
      periodFrom: '2026-01-01',
      periodUntil: '2026-12-31',
      supersedes,
      costLines: [
        { position: 1, account: 'Instandhaltung', group: 'NON_RECOVERABLE', allocationKey: 'MEA', totalAmount: eur('8000.00'), unitShare: eur('1000.00') },
      ],
      recoverableSubtotal: eur('0.00'),
      nonRecoverableSubtotal: eur('1000.00'),
      totalCosts: eur('1000.00'),
      hausgeldRequested: eur('1000.00'),
      hausgeldPaid: eur('1000.00'),
      settlementPeak: eur('0.00'),
      reserve: { source: 'ANNUAL_STATEMENT', lines },
    });
    const withdrawal = (position: number, amount: string, date?: string) => ({
      position,
      description: `Entnahme ${position}`,
      kind: 'WITHDRAWAL',
      withdrawal: eur(amount),
      ...(date === undefined ? {} : { date }),
    });
    const old = (await json<{ statementId: string }>(await A('POST', `/weg-memberships/${m}/annual-statements`, statementBody([withdrawal(1, '8000.00', '2026-06-15'), withdrawal(2, '4000.00')])), 201))
      .statementId;
    await json(await A('POST', `/weg-annual-statements/${old}/confirm`), 200);
    const dated = await json<{ dateSource: string; amount: { amount: string } }>(await A('GET', `/weg-annual-statements/${old}/reserve-withdrawals/1/tax-meaning`), 200);
    expect(dated).toMatchObject({ dateSource: 'WITHDRAWAL', amount: eur('1000.00') });
    const undated = await json<{ dateSource: string; flags: Flag[] }>(await A('GET', `/weg-annual-statements/${old}/reserve-withdrawals/2/tax-meaning`), 200);
    expect(undated.dateSource).toBe('PERIOD_END');
    expect(codes(undated.flags)).toEqual(['WITHDRAWAL_DATE_ASSUMED']);
    const c1 = await json<{ classificationId: string }>(
      await classify({ sourceType: 'WEG_RESERVE_WITHDRAWAL', sourceId: old, sourcePosition: 1, taxCategory: 'WEG_SPENDING', treatment: 'DEDUCTIBLE' }),
      201,
    );
    const c2 = await json<{ classificationId: string }>(
      await classify({ sourceType: 'WEG_RESERVE_WITHDRAWAL', sourceId: old, sourcePosition: 2, taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', taxYear: 2026 }),
      201,
    );
    const contribution = await booked(pr, '600.00', 'WEG_RESERVE_CONTRIBUTION', '2026-03-01');
    expect((await items(pr, 2026)).map((i) => [i.sourceType, i.sourcePosition])).toEqual([
      ['TRANSACTION_SPLIT', null],
      ['WEG_RESERVE_WITHDRAWAL', 1],
      ['WEG_RESERVE_WITHDRAWAL', 2],
    ]);

    // The corrected statement, confirmed with supersedes.
    const corrected = (
      await json<{ statementId: string }>(
        await A('POST', `/weg-memberships/${m}/annual-statements`, statementBody([withdrawal(1, '8800.00', '2026-06-20')], old)),
        201,
      )
    ).statementId;
    await json(await A('POST', `/weg-annual-statements/${corrected}/confirm`), 200);
    const stopped = await json<{ counts: boolean; notCountedReason: string }>(await A('GET', `/weg-annual-statements/${old}/reserve-withdrawals/1/tax-meaning`), 200);
    expect(stopped).toMatchObject({ counts: false, notCountedReason: 'STATEMENT_SUPERSEDED' });
    const fresh = await json<{ reviewState: string; origin: string; flags: Flag[] }>(await A('GET', `/weg-annual-statements/${corrected}/reserve-withdrawals/1/tax-meaning`), 200);
    expect(fresh).toMatchObject({ reviewState: 'NEEDS_REVIEW', origin: 'DEFAULT' });
    expect(fresh.flags).toContainEqual({
      code: 'PREDECESSOR_CLASSIFIED',
      details: { statementId: old, classificationIds: [c1.classificationId, c2.classificationId].sort() },
    });
    const listed = await items(pr, 2026);
    expect(listed.map((i) => [i.sourceType, i.sourceId, i.sourcePosition])).toEqual([
      ['TRANSACTION_SPLIT', contribution, null],
      ['WEG_RESERVE_WITHDRAWAL', corrected, 1],
    ]);
    // Counter-check: never a cost line (unit share 1,000.00 of "Instandhaltung"), and the contribution NOT_RELEVANT.
    expect(listed[0]).toMatchObject({ taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' });
    expect(listed.map((i) => i.yearAmount.amount)).toEqual(['600.00', '1100.00']);
    const refused = await json<{ error: { code: string; details: { reason: string } } }>(
      await classify({ sourceType: 'TRANSACTION_SPLIT', sourceId: contribution, taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE' }),
      422,
    );
    expect(refused.error.code).toBe('TREATMENT_NOT_ALLOWED');

    // Realm isolation: the new routes, the list's new items, and creates naming another Realm's source.
    expect((await B('GET', `/weg-annual-statements/${corrected}/reserve-withdrawals/1/tax-meaning`)).status).toBe(404);
    expect((await B('GET', `/tax-classifications?sourceType=WEG_RESERVE_WITHDRAWAL&sourceId=${old}&sourcePosition=1`)).status).toBe(404);
    const foreignPr = await flat(REALM_B);
    expect(await items(foreignPr, 2026, REALM_B)).toEqual([]);
    expect((await B('GET', `/property-references/${pr}/tax-meanings?year=2026`)).status).toBe(404);
    expect(
      (await call(REALM_B, 'POST', '/tax-classifications', { sourceType: 'WEG_RESERVE_WITHDRAWAL', sourceId: corrected, sourcePosition: 1, taxCategory: 'WEG_SPENDING', treatment: 'DEDUCTIBLE' }))
        .status,
    ).toBe(404);
    const assessment = (
      await json<{ assessmentId: string }>(
        await A('POST', `/weg-memberships/${m}/special-assessments`, {
          description: 'Dach',
          resolutionDate: '2026-02-10',
          purpose: 'MAINTENANCE',
          unitShare: eur('100.00'),
          instalments: [{ position: 1, dueDate: '2026-03-01', amount: eur('100.00') }],
        }),
        201,
      )
    ).assessmentId;
    await json(await A('PUT', `/weg-special-assessments/${assessment}/uses`, { uses: [{ position: 1, date: '2026-09-01', description: 'Dach', unitShare: eur('100.00') }] }), 200);
    expect((await B('GET', `/weg-special-assessments/${assessment}/uses/1/tax-meaning`)).status).toBe(404);
    expect(
      (await call(REALM_B, 'POST', '/tax-classifications', { sourceType: 'WEG_ASSESSMENT_USE', sourceId: assessment, sourcePosition: 1, taxCategory: 'WEG_SPENDING', treatment: 'DEDUCTIBLE' }))
        .status,
    ).toBe(404);
  });
});
