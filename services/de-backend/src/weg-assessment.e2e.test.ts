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
  createFinancialAccount,
  createManualTransaction,
  createMembership,
  createSpecialAssessment,
  createWeg,
  getSpecialAssessment,
  getStatementComparison,
  listSpecialAssessments,
  replaceAssessmentUses,
  setTransactionSplits,
  voidSpecialAssessment,
  amendSpecialAssessment,
} from './application/index.js';
import {
  PostgresFinancialAccountRepository,
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
 * VC-6-05 end to end (api-design.md §51A), wired as in main.ts: a Sonderumlage in three instalments, two paid by debits
 * split with the assessment, the third overdue at `asOf`, then paid: `SETTLED`; a use added later; the §51 comparison
 * of the year unchanged by the payments; void refused while payments name it; Realm isolation. Figures are invented.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee0000000000009c';
const REALM_B = '64b0c0ffee0000000000009d';
const money = (amount: string) => ({ amount, currency: 'EUR' });

describe.skipIf(databaseUrl === undefined)('Sonderumlage (VC-6-05) end to end', () => {
  const schema = testSchemaName('weg_assessment_e2e');
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
    const statements = new PostgresWegAnnualStatementRepository(db);
    const assessments = new PostgresWegSpecialAssessmentRepository(db);
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        wegs: { createWeg: createWeg({ repository: wegs }), createMembership: createMembership({ repository: wegs }) },
        wegAnnualStatements: {
          create: createAnnualStatement({ repository: statements }),
          confirm: confirmAnnualStatement({ repository: statements }),
          comparison: getStatementComparison({ repository: statements }),
        },
        wegSpecialAssessments: {
          create: createSpecialAssessment({ repository: assessments }),
          get: getSpecialAssessment({ repository: assessments }),
          list: listSpecialAssessments({ repository: assessments }),
          amend: amendSpecialAssessment({ repository: assessments }),
          replaceUses: replaceAssessmentUses({ repository: assessments }),
          void: voidSpecialAssessment({ repository: assessments }),
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
  type Assessment = {
    assessmentId: string;
    status: string;
    paid: { amount: string };
    outstanding: { amount: string };
    instalments: { covered: { amount: string }; overdue: boolean }[];
    flags: { code: string }[];
    version: number;
  };

  it('three instalments, two paid, the third overdue, then paid: SETTLED; the use; the comparison unchanged', async () => {
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f6c301', 'ACTIVE', 'x') RETURNING id`,
      [REALM_A],
    );
    const flat = rows[0].id as string;
    const weg = await json<{ wegId: string }>(await A('POST', '/wegs', { displayName: 'WEG Musterstraße 1' }), 201);
    const membership = await json<{ membershipId: string }>(
      await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: flat, miteigentumsanteil: '250/10000', validFrom: '2025-01-01' }),
      201,
    );
    const path = `/weg-memberships/${membership.membershipId}/special-assessments`;
    const created = await json<Assessment>(
      await A('POST', path, {
        description: 'Dachsanierung',
        resolutionDate: '2026-02-10',
        purpose: 'MAINTENANCE',
        totalAmount: money('36000.00'),
        unitShare: money('900.00'),
        instalments: [
          { position: 1, dueDate: '2026-03-01', amount: money('300.00') },
          { position: 2, dueDate: '2026-06-01', amount: money('300.00') },
          { position: 3, dueDate: '2026-09-01', amount: money('300.00') },
        ],
      }),
      201,
    );
    const one = `/weg-special-assessments/${created.assessmentId}`;

    const giro = (
      await json<{ financialAccountId: string }>(await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }), 201)
    ).financialAccountId;
    const pay = async (amount: string, bookingDate: string) => {
      const tx = (
        await json<{ transactionId: string }>(
          await A('POST', '/transactions', { financialAccountId: giro, amount: money(amount), direction: 'OUTFLOW', bookingDate, propertyReferenceId: flat }),
          201,
        )
      ).transactionId;
      await json(
        await A('PUT', `/transactions/${tx}/splits`, {
          splits: [
            { amount: money(amount), financialCategoryCode: 'WEG_SPECIAL_ASSESSMENT', propertyReferenceId: flat, wegSpecialAssessmentId: created.assessmentId },
          ],
        }),
        200,
      );
      await json(await A('POST', `/transactions/${tx}/confirm`, {}), 200);
      return tx;
    };
    await pay('300.00', '2026-03-02');
    await pay('300.00', '2026-06-02');
    const pending = await json<Assessment>(await A('GET', `${one}?asOf=2026-09-15`), 200);
    expect(pending).toMatchObject({ status: 'ACTIVE', paid: money('600.00'), outstanding: money('300.00') });
    expect(pending.instalments.map((i) => [i.covered.amount, i.overdue])).toEqual([
      ['300.00', false],
      ['300.00', false],
      ['0.00', true],
    ]);
    // A Sonderumlage with payments is never voided.
    expect((await A('POST', `${one}/void`, { reason: 'x' })).status).toBe(409);
    await pay('300.00', '2026-09-20');
    const settled = await json<Assessment>(await A('GET', `${one}?asOf=2026-09-30`), 200);
    expect(settled).toMatchObject({ status: 'SETTLED', outstanding: money('0.00'), flags: [] });

    // What the WEG used it for, added later (Phase 7's input).
    const used = await json<Assessment>(
      await A('PUT', `${one}/uses`, {
        uses: [{ position: 1, date: '2026-10-01', description: 'Dachdecker, Erneuerung der Eindeckung', unitShare: money('850.00') }],
      }),
      200,
    );
    expect(used.flags).toEqual([]);
    const list = await json<{ items: Assessment[] }>(await A('GET', `${path}?status=SETTLED`), 200);
    expect(list.items.map((a) => a.assessmentId)).toEqual([created.assessmentId]);

    // The year's statement: its comparison counts no Sonderumlage payment as an advance.
    const statement = await json<{ statementId: string }>(
      await A('POST', `/weg-memberships/${membership.membershipId}/annual-statements`, {
        financialYear: 2026,
        periodFrom: '2026-01-01',
        periodUntil: '2026-12-31',
        costLines: [
          {
            position: 1,
            account: 'Hausmeister',
            group: 'RECOVERABLE',
            allocationKey: 'Miteigentumsanteile',
            totalAmount: money('4000.00'),
            unitShare: money('100.00'),
          },
        ],
        recoverableSubtotal: money('100.00'),
        nonRecoverableSubtotal: money('0.00'),
        totalCosts: money('100.00'),
        hausgeldRequested: money('0.00'),
        hausgeldPaid: money('0.00'),
        settlementPeak: money('100.00'),
      }),
      201,
    );
    await json(await A('POST', `/weg-annual-statements/${statement.statementId}/confirm`), 200);
    const comparison = await json<{ classes: Record<string, { paid: { amount: string } }>; flags: { code: string }[] }>(
      await A('GET', `/weg-annual-statements/${statement.statementId}/comparison`),
      200,
    );
    expect(Object.values(comparison.classes).map((c) => c.paid.amount)).toEqual(['0.00', '0.00', '0.00']);
    expect(comparison.flags).toEqual([]);

    // Realm isolation on every §51A route.
    expect((await B('GET', path)).status).toBe(404);
    expect(
      (
        await B('POST', path, {
          description: 'x',
          resolutionDate: '2026-02-10',
          purpose: 'OTHER',
          unitShare: money('1.00'),
          instalments: [{ position: 1, dueDate: '2026-03-01', amount: money('1.00') }],
        })
      ).status,
    ).toBe(404);
    expect((await B('GET', one)).status).toBe(404);
    expect(
      (
        await B('POST', `${one}/amend`, {
          description: 'x',
          purpose: 'OTHER',
          unitShare: money('1.00'),
          instalments: [{ position: 1, dueDate: '2026-03-01', amount: money('1.00') }],
        })
      ).status,
    ).toBe(404);
    expect((await B('PUT', `${one}/uses`, { uses: [] })).status).toBe(404);
    expect((await B('POST', `${one}/void`, { reason: 'x' })).status).toBe(404);
  });
});
