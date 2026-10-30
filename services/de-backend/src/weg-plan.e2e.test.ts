import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  confirmTransaction,
  createEconomicPlan,
  createFinancialAccount,
  createManualTransaction,
  createMembership,
  createWeg,
  endMembership,
  getEconomicPlan,
  getHausgeldProposal,
  listEconomicPlans,
  setTransactionSplits,
  voidEconomicPlan,
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  PostgresWegEconomicPlanRepository,
  PostgresWegRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier } from './wiring.js';

/**
 * VC-6-02 end to end (api-design.md §49.3–§49.6), wired as in main.ts: a unit with two plans (the amounts change "ab
 * 1.3."), the two monthly debits of F5 (Hausgeld and Rücklage) split by proposal and confirmed, a debit before the
 * change proposed from the old plan, a WEG split refused without a membership, the membership end guarded by its
 * splits, and Realm isolation on every new route. Figures are invented.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000006c';
const REALM_B = '64b0c0ffee0000000000006d';
const money = (amount: string) => ({ amount, currency: 'EUR' });

describe.skipIf(databaseUrl === undefined)('Wirtschaftsplan and Hausgeld proposal (VC-6-02) end to end', () => {
  const schema = testSchemaName('weg_plan_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
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
      { _id: REALM_A, name: 'A', members: member, applications: [] },
      { _id: REALM_B, name: 'B', members: member, applications: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const wegs = new PostgresWegRepository(db);
    const plans = new PostgresWegEconomicPlanRepository(db);
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        wegs: {
          createWeg: createWeg({ repository: wegs }),
          createMembership: createMembership({ repository: wegs }),
          endMembership: endMembership({ repository: wegs }),
        },
        wegEconomicPlans: {
          create: createEconomicPlan({ repository: plans }),
          get: getEconomicPlan({ repository: plans }),
          list: listEconomicPlans({ repository: plans }),
          void: voidEconomicPlan({ repository: plans }),
          hausgeldProposal: getHausgeldProposal({ repository: plans }),
        },
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: new PostgresTransactionRepository(db) }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: new PostgresTransactionRepository(db) }),
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
  const call = (realm: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
  const B = (method: string, path: string, body?: unknown) => call(REALM_B, method, path, body);
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const errorOf = async (res: Response, status: number) => (await json<{ error: { code: string; details?: Record<string, unknown> } }>(res, status)).error;
  type Proposal = {
    case: string;
    splits: { financialCategoryCode: string; propertyReferenceId: string; amount: { amount: string } }[];
    flags: { code: string }[];
  };
  const planBody = (financialYear: number, effectiveFrom: string, hausgeld: string, reserve: string) => ({
    financialYear,
    effectiveFrom,
    monthlyHausgeld: money(hausgeld),
    monthlyReserveContribution: money(reserve),
    recoverableCosts: money('2400.00'),
    nonRecoverableCosts: money('1200.00'),
    annualReserveContribution: money((Number(reserve) * 12).toFixed(2)),
  });

  it('two plans, the two debits of F5 split by proposal and confirmed, the old plan before the change, the guards', async () => {
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f6c001', 'ACTIVE', 'x') RETURNING id`,
      [REALM_A],
    );
    const flat = rows[0].id as string;
    const weg = await json<{ wegId: string }>(await A('POST', '/wegs', { displayName: 'WEG Musterstraße 1' }), 201);
    const membership = await json<{ membershipId: string }>(
      await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '125.5/10000', validFrom: '2025-01-01' }),
      201,
    );
    const plansPath = `/weg-memberships/${membership.membershipId}/economic-plans`;
    await json(await A('POST', plansPath, planBody(2025, '2025-01-01', '300.00', '60.00')), 201);
    // The resolution of 2026 sets new amounts "ab 1.3.".
    const plan2026 = await json<{ economicPlanId: string; components: Record<string, unknown> }>(
      await A('POST', plansPath, planBody(2026, '2026-03-01', '330.00', '70.00')),
      201,
    );
    expect(plan2026.components).toEqual({ recoverable: money('220.00'), nonRecoverable: money('110.00'), reserve: money('70.00') });

    const giro = (
      await json<{ financialAccountId: string }>(await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }), 201)
    ).financialAccountId;
    const debit = async (amount: string, bookingDate: string) =>
      (
        await json<{ transactionId: string }>(
          await A('POST', '/transactions', { financialAccountId: giro, amount: money(amount), direction: 'OUTFLOW', bookingDate, propertyReferenceId: flat }),
          201,
        )
      ).transactionId;
    const proposalOf = async (transactionId: string) => json<Proposal>(await A('GET', `/transactions/${transactionId}/hausgeld-proposal`), 200);
    const apply = async (transactionId: string, proposal: Proposal) => {
      await json(
        await A('PUT', `/transactions/${transactionId}/splits`, {
          splits: proposal.splits.map((s) => ({
            amount: s.amount,
            financialCategoryCode: s.financialCategoryCode,
            propertyReferenceId: s.propertyReferenceId,
          })),
        }),
        200,
      );
      await json(await A('POST', `/transactions/${transactionId}/confirm`, {}), 200);
    };

    // F5: the Hausgeld and the Rücklage arrive as two debits each month.
    const hausgeld = await debit('330.00', '2026-03-02');
    const hausgeldProposal = await proposalOf(hausgeld);
    expect(hausgeldProposal.case).toBe('HAUSGELD_ONLY');
    expect(hausgeldProposal.splits.map((s) => [s.financialCategoryCode, s.amount.amount])).toEqual([
      ['WEG_RECOVERABLE', '220.00'],
      ['WEG_NON_RECOVERABLE', '110.00'],
    ]);
    await apply(hausgeld, hausgeldProposal);
    const reserve = await debit('70.00', '2026-03-02');
    const reserveProposal = await proposalOf(reserve);
    expect(reserveProposal).toMatchObject({ case: 'RESERVE_ONLY', flags: [] });
    await apply(reserve, reserveProposal);

    // Before the change the 2025 plan is in force, flagged as an earlier year's.
    const february = await proposalOf(await debit('300.00', '2026-02-02'));
    expect(february).toMatchObject({ case: 'HAUSGELD_ONLY', flags: [{ code: 'PLAN_OF_EARLIER_YEAR' }] });
    // An amount that fits no case is split in proportion.
    expect((await proposalOf(await debit('500.00', '2026-04-01'))).case).toBe('PROPORTIONAL');

    // A WEG split names its unit; the membership cannot end before its splits.
    const unlinked = await json<{ transactionId: string }>(
      await A('POST', '/transactions', { financialAccountId: giro, amount: money('70.00'), direction: 'OUTFLOW', bookingDate: '2026-03-02' }),
      201,
    );
    expect(
      await errorOf(
        await A('PUT', `/transactions/${unlinked.transactionId}/splits`, {
          splits: [{ amount: money('70.00'), financialCategoryCode: 'WEG_RESERVE_CONTRIBUTION' }],
        }),
        422,
      ),
    ).toMatchObject({ code: 'NO_WEG_MEMBERSHIP', details: { position: 1, reason: 'NO_UNIT' } });
    expect(await errorOf(await A('POST', `/weg-memberships/${membership.membershipId}/end`, { validUntil: '2026-02-28' }), 409)).toMatchObject({
      details: { reason: 'MEMBERSHIP_HAS_SPLITS', transactionIds: [hausgeld, reserve].sort() },
    });

    // Realm isolation on the new routes.
    expect((await B('GET', plansPath)).status).toBe(404);
    expect((await B('POST', plansPath, planBody(2027, '2027-01-01', '1.00', '1.00'))).status).toBe(404);
    expect((await B('GET', `/weg-economic-plans/${plan2026.economicPlanId}`)).status).toBe(404);
    expect((await B('POST', `/weg-economic-plans/${plan2026.economicPlanId}/void`, { reason: 'x' })).status).toBe(404);
    expect((await B('GET', `/transactions/${hausgeld}/hausgeld-proposal`)).status).toBe(404);
  });
});
