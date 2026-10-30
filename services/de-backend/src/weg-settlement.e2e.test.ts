import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  confirmAnnualStatement,
  confirmTransaction,
  createAnnualStatement,
  createEconomicPlan,
  createFinancialAccount,
  createManualTransaction,
  createMembership,
  createWeg,
  getHausgeldProposal,
  getSettlementProposal,
  getStatementComparison,
  setTransactionSplits,
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  PostgresWegAnnualStatementRepository,
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
 * VC-6-04 end to end (api-design.md §51), wired as in main.ts: a year of the two debits of F5 split by the Hausgeld
 * proposal and confirmed; a confirmed statement with a credit as Abrechnungsspitze; the comparison, whose differences
 * sum to it plus the unpaid advances; the refund split by the settlement proposal and confirmed, naming the statement;
 * a corrected statement superseding it, whose comparison counts the refund with SETTLED_AGAINST_SUPERSEDED; Realm
 * isolation. Figures are invented.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000008c';
const REALM_B = '64b0c0ffee0000000000008d';
const money = (amount: string) => ({ amount, currency: 'EUR' });

describe.skipIf(databaseUrl === undefined)('Ledger effects of a statement (VC-6-04) end to end', () => {
  const schema = testSchemaName('weg_settlement_e2e');
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
    const statements = new PostgresWegAnnualStatementRepository(db);
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        wegs: { createWeg: createWeg({ repository: wegs }), createMembership: createMembership({ repository: wegs }) },
        wegEconomicPlans: { create: createEconomicPlan({ repository: plans }), hausgeldProposal: getHausgeldProposal({ repository: plans }) },
        wegAnnualStatements: {
          create: createAnnualStatement({ repository: statements }),
          confirm: confirmAnnualStatement({ repository: statements }),
          comparison: getStatementComparison({ repository: statements }),
          settlementProposal: getSettlementProposal({ repository: statements }),
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
  type Splits = { splits: { financialCategoryCode: string; propertyReferenceId: string; wegAnnualStatementId?: string; amount: { amount: string } }[] };
  type Comparison = {
    classes: Record<string, { paid: { amount: string }; actual: { amount: string }; difference: { amount: string } }>;
    advances: { unpaidAdvances: { amount: string } };
    settlementPeak: { amount: string };
    settlement: { settled: { amount: string }; open: { amount: string }; settledBy: { transactionId: string; statementId: string }[] };
    reserveWithdrawals: { unitShare: { amount: string } }[];
    flags: { code: string }[];
  };

  /** Costs 1,500, Hausgeld 1,800 and reserve 600 requested: a credit of 300; a roof repair taken from the reserve. */
  const statementBody = (overrides: Record<string, unknown> = {}) => ({
    financialYear: 2025,
    periodFrom: '2025-01-01',
    periodUntil: '2025-12-31',
    costLines: [
      {
        position: 1,
        account: 'Hausmeister',
        group: 'RECOVERABLE',
        allocationKey: 'Miteigentumsanteile',
        totalAmount: money('40000.00'),
        unitShare: money('1000.00'),
      },
      {
        position: 2,
        account: 'Verwaltervergütung',
        group: 'NON_RECOVERABLE',
        allocationKey: 'Einheit',
        totalAmount: money('10000.00'),
        unitShare: money('500.00'),
      },
    ],
    recoverableSubtotal: money('1000.00'),
    nonRecoverableSubtotal: money('500.00'),
    totalCosts: money('1500.00'),
    hausgeldRequested: money('1800.00'),
    hausgeldPaid: money('1800.00'),
    reserveRequested: money('600.00'),
    reservePaid: money('600.00'),
    settlementPeak: money('-300.00'),
    reserve: {
      source: 'ANNUAL_STATEMENT',
      lines: [{ position: 1, description: 'Entnahme Dachreparatur', kind: 'WITHDRAWAL', withdrawal: money('8000.00') }],
    },
    ...overrides,
  });

  it('a year by plan, the statement, the comparison, the refund by proposal, a correction superseding it', async () => {
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f6c201', 'ACTIVE', 'x') RETURNING id`,
      [REALM_A],
    );
    const flat = rows[0].id as string;
    const weg = await json<{ wegId: string }>(await A('POST', '/wegs', { displayName: 'WEG Musterstraße 1' }), 201);
    const membership = await json<{ membershipId: string }>(
      await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '250/10000', validFrom: '2025-01-01' }),
      201,
    );
    await json(
      await A('POST', `/weg-memberships/${membership.membershipId}/economic-plans`, {
        financialYear: 2025,
        effectiveFrom: '2025-01-01',
        monthlyHausgeld: money('150.00'),
        monthlyReserveContribution: money('50.00'),
        recoverableCosts: money('1200.00'),
        nonRecoverableCosts: money('600.00'),
      }),
      201,
    );
    const giro = (
      await json<{ financialAccountId: string }>(await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }), 201)
    ).financialAccountId;
    const transaction = async (amount: string, bookingDate: string, direction = 'OUTFLOW') =>
      (
        await json<{ transactionId: string }>(
          await A('POST', '/transactions', { financialAccountId: giro, amount: money(amount), direction, bookingDate, propertyReferenceId: flat }),
          201,
        )
      ).transactionId;
    const apply = async (transactionId: string, proposal: Splits) => {
      await json(
        await A('PUT', `/transactions/${transactionId}/splits`, {
          splits: proposal.splits.map((s) => ({
            amount: s.amount,
            financialCategoryCode: s.financialCategoryCode,
            propertyReferenceId: s.propertyReferenceId,
            ...(s.wegAnnualStatementId === undefined ? {} : { wegAnnualStatementId: s.wegAnnualStatementId }),
          })),
        }),
        200,
      );
      await json(await A('POST', `/transactions/${transactionId}/confirm`, {}), 200);
    };

    // F5: the Hausgeld and the Rücklage as two debits each month, split by the Hausgeld proposal.
    for (let month = 1; month <= 12; month += 1) {
      const date = `2025-${String(month).padStart(2, '0')}-02`;
      for (const amount of ['150.00', '50.00']) {
        const tx = await transaction(amount, date);
        await apply(tx, await json<Splits>(await A('GET', `/transactions/${tx}/hausgeld-proposal`), 200));
      }
    }

    const statementsPath = `/weg-memberships/${membership.membershipId}/annual-statements`;
    const first = await json<{ statementId: string }>(await A('POST', statementsPath, statementBody()), 201);
    // A DRAFT is not compared.
    expect((await A('GET', `/weg-annual-statements/${first.statementId}/comparison`)).status).toBe(409);
    await json(await A('POST', `/weg-annual-statements/${first.statementId}/confirm`), 200);

    const comparison = await json<Comparison>(await A('GET', `/weg-annual-statements/${first.statementId}/comparison`), 200);
    expect(comparison.classes).toEqual({
      RECOVERABLE: { paid: money('1200.00'), actual: money('1000.00'), difference: money('-200.00') },
      NON_RECOVERABLE: { paid: money('600.00'), actual: money('500.00'), difference: money('-100.00') },
      RESERVE: { paid: money('600.00'), actual: money('600.00'), difference: money('0.00') },
    });
    // The differences sum to the Abrechnungsspitze plus the unpaid advances (here none).
    const sum = Object.values(comparison.classes).reduce((total, c) => total + Math.round(Number(c.difference.amount) * 100), 0);
    expect(sum - Math.round(Number(comparison.advances.unpaidAdvances.amount) * 100)).toBe(Math.round(Number(comparison.settlementPeak.amount) * 100));
    expect(comparison.reserveWithdrawals.map((w) => w.unitShare)).toEqual([money('200.00')]);
    expect(comparison.flags).toEqual([]);

    // The refund arrives: a back-payment direction is refused, the INFLOW is split by the proposal and names the statement.
    const wrong = await transaction('300.00', '2026-05-04');
    expect((await A('GET', `/transactions/${wrong}/settlement-proposal?statementId=${first.statementId}`)).status).toBe(422);
    const refund = await transaction('300.00', '2026-05-04', 'INFLOW');
    const proposal = await json<Splits & { flags: unknown[] }>(
      await A('GET', `/transactions/${refund}/settlement-proposal?statementId=${first.statementId}`),
      200,
    );
    expect(proposal.splits.map((s) => [s.financialCategoryCode, s.amount.amount, s.wegAnnualStatementId])).toEqual([
      ['WEG_RECOVERABLE', '200.00', first.statementId],
      ['WEG_NON_RECOVERABLE', '100.00', first.statementId],
    ]);
    expect(proposal.flags).toEqual([]);
    await apply(refund, proposal);
    const settled = await json<Comparison>(await A('GET', `/weg-annual-statements/${first.statementId}/comparison`), 200);
    expect(settled.settlement).toMatchObject({ settled: money('-300.00'), open: money('0.00') });
    // The refund is no advance: the classes are unchanged.
    expect(settled.classes).toEqual(comparison.classes);

    // The Verwalter corrects the statement; the correction supersedes it and takes the refund over.
    const corrected = await json<{ statementId: string }>(
      await A('POST', statementsPath, statementBody({ supersedes: first.statementId, notes: 'Korrigierte Abrechnung' })),
      201,
    );
    await json(await A('POST', `/weg-annual-statements/${corrected.statementId}/confirm`), 200);
    const taken = await json<Comparison>(await A('GET', `/weg-annual-statements/${corrected.statementId}/comparison`), 200);
    expect(taken.settlement.settledBy).toEqual([expect.objectContaining({ transactionId: refund, statementId: first.statementId })]);
    expect(taken.flags.map((f) => f.code)).toEqual(['SETTLED_AGAINST_SUPERSEDED']);
    // A new settlement against the superseded one is refused.
    const late = await transaction('1.00', '2026-06-01', 'INFLOW');
    const refused = await A('PUT', `/transactions/${late}/splits`, {
      splits: [{ amount: money('1.00'), financialCategoryCode: 'WEG_NON_RECOVERABLE', propertyReferenceId: flat, wegAnnualStatementId: first.statementId }],
    });
    expect(refused.status).toBe(409);

    // Realm isolation on both reads and on the split.
    expect((await B('GET', `/weg-annual-statements/${corrected.statementId}/comparison`)).status).toBe(404);
    expect((await B('GET', `/transactions/${late}/settlement-proposal?statementId=${corrected.statementId}`)).status).toBe(404);
    expect(
      (
        await B('PUT', `/transactions/${late}/splits`, {
          splits: [
            { amount: money('1.00'), financialCategoryCode: 'WEG_NON_RECOVERABLE', propertyReferenceId: flat, wegAnnualStatementId: corrected.statementId },
          ],
        })
      ).status,
    ).toBe(404);
  });
});
