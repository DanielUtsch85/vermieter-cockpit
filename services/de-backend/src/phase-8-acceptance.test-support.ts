import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, expect } from 'vitest';
import type { Express } from 'express';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  changeOwnership,
  confirmAcquisition,
  confirmTransaction,
  createAcquisition,
  createAcquisitionCost,
  createCostClassification,
  constructionPeriodInterestCommands,
  listAcquisitionCosts,
  listCostClassifications,
  createFinancialAccount,
  createLandBuildingAllocation,
  createLoan,
  createLoanAllocation,
  createLoanTerms,
  createManualTransaction,
  createMembership,
  createOwnership,
  createParty,
  createSpecialAssessment,
  createTaxClassification,
  createWeg,
  getAnschaffungsnaheCheck,
  getTaxYearView,
  linkPropertyReference,
  refreshPropertyReference,
  replaceAssessmentUses,
  setTransactionSplits,
} from './application/index.js';
import { depreciationCommands } from './depreciation-commands.test-support.js';
import {
  PostgresAcquisitionCostClassificationRepository,
  PostgresConstructionPeriodInterestRepository,
  PostgresAcquisitionCostRepository,
  PostgresAcquisitionRepository,
  PostgresFinancialAccountRepository,
  PostgresLandBuildingAllocationRepository,
  PostgresLoanAllocationRepository,
  PostgresLoanRepository,
  PostgresLoanTermsRepository,
  PostgresOwnershipRepository,
  PostgresPartyRepository,
  PostgresPropertyReferenceRepository,
  PostgresTaxClassificationRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  PostgresWegRepository,
  PostgresWegSpecialAssessmentRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier, mrePropertyLookup } from './wiring.js';
import { standardMethodBody } from './infrastructure/postgres/depreciation-method.test-support.js';

/**
 * The setup of ACC8 (`phase-8-acceptance.e2e.test.ts`, invariant-suite.md §51): one migrated schema, the fake MRE and the
 * app wired as in main.ts behind two real HTTP servers on the same database, one with the recording switch as shipped
 * (off) and one built with it on (api-design §60 "Tests while it is off, and with it on": no environment variable is
 * set). Every write of the scenario goes through the HTTP API; the request helpers below are its vocabulary. A settable
 * clock stands in for today, so no figure depends on the date the test runs. Synthetic data only. Test support only.
 */
export const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

export const REALM_A = '64b0c0ffee0000000000a8a8';
export const REALM_B = '64b0c0ffee0000000000a8b8';
/** The MRE properties of Realm A: the unit of the scenario first, then one per variant. */
export const PROPERTIES = Array.from({ length: 8 }, (_, i) => `6512f0c2a1b2c3d4e5f6a8${String(i + 1).padStart(2, '0')}`);
const THEIRS = '6512f0c2a1b2c3d4e5f6b801';

export type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export type Base = 'on' | 'off';
export type Money = { amount: string; currency: string };

/** Cents of a Money JSON (or of its amount), exact; `null` for a missing figure. */
export const cents = (m: Money | string | null | undefined): bigint | null => {
  if (m === null || m === undefined) return null;
  const amount = typeof m === 'string' ? m : m.amount;
  const negative = amount.startsWith('-');
  const [w, f = ''] = amount.replace('-', '').split('.') as [string, string?];
  return (negative ? -1n : 1n) * (BigInt(w) * 100n + BigInt(f.padEnd(2, '0')));
};
export const eur = (amount: string): Money => ({ amount, currency: 'EUR' });
export const codes = (flags: readonly { code: string }[]) => flags.map((f) => f.code);
/** The two AfA lines and the cash lines of the Werbungskosten, by their `line`. */
export const lineOf = (v: Json, line: string): Json => v.werbungskosten.lines.find((l: Json) => l.line === line);
export const totalOf = (v: Json, line: string): string | undefined => lineOf(v, line)?.total.amount;

/** The Phase-8 routes (api-design §59–§60) under `/api/v1`, as `METHOD /path/:param`. */
export const PHASE_8 = /^[A-Z]+ \/(?:depreciation-assets\b|property-references\/:propertyReferenceId\/depreciation-assets$)/;

export interface Acc8Context {
  pool: pg.Pool;
  mre: FakeMre;
  app: Express;
}

/** Registers the schema's, the fake MRE's and the servers' `beforeAll`/`afterAll` and returns the request helpers. */
export function useAcc8(name: `${string}_e2e`) {
  const schema = testSchemaName(name);
  const ctx = {} as Acc8Context;
  const servers: Server[] = [];
  const bases: Record<Base, string> = { on: '', off: '' };
  let clock = new Date('2026-07-01T10:00:00Z');
  const now = () => clock;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    ctx.pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(ctx.pool, { migrationTableSchema: schema });
    const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
    ctx.mre = await startFakeMre([
      {
        _id: REALM_A,
        name: 'A',
        members: member,
        applications: [],
        properties: PROPERTIES.map((_id, i) => ({ _id, name: `Wohnung Beispielallee ${i + 1}`, surface: 60 })),
        tenants: [],
      },
      { _id: REALM_B, name: 'B', members: member, applications: [], properties: [{ _id: THEIRS, name: 'Fremde Wohnung', surface: 50 }], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: ctx.mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(ctx.pool);
    const propertyReferences = { repository: new PostgresPropertyReferenceRepository(db), lookupMreProperty: mrePropertyLookup(client) };
    const acquisitions = new PostgresAcquisitionRepository(db);
    const ownerships = new PostgresOwnershipRepository(db);
    const wegs = new PostgresWegRepository(db);
    const assessments = new PostgresWegSpecialAssessmentRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const classifications = new PostgresTaxClassificationRepository(db);
    for (const recordingEnabled of [false, true]) {
      const app = createApp({
        isReady: async () => true,
        verifyPrincipal: mrePrincipalVerifier(client),
        ...commandsWith({
          propertyReferences: { link: linkPropertyReference(propertyReferences), refresh: refreshPropertyReference(propertyReferences) },
          parties: { create: createParty({ repository: new PostgresPartyRepository(db) }) },
          ownerships: { create: createOwnership({ repository: ownerships }), change: changeOwnership({ repository: ownerships }) },
          acquisitions: { create: createAcquisition({ repository: acquisitions }), confirm: confirmAcquisition({ repository: acquisitions, now }) },
          acquisitionCosts: {
            createCost: createAcquisitionCost({ repository: new PostgresAcquisitionCostRepository(db) }),
            listCosts: listAcquisitionCosts({ repository: new PostgresAcquisitionCostRepository(db) }),
          },
          constructionPeriodInterest: constructionPeriodInterestCommands(new PostgresConstructionPeriodInterestRepository(db)),
          costClassifications: {
            create: createCostClassification({ repository: new PostgresAcquisitionCostClassificationRepository(db) }),
            list: listCostClassifications({ repository: new PostgresAcquisitionCostClassificationRepository(db) }),
          },
          landBuildingAllocations: { create: createLandBuildingAllocation({ repository: new PostgresLandBuildingAllocationRepository(db) }) },
          wegs: { createWeg: createWeg({ repository: wegs }), createMembership: createMembership({ repository: wegs }) },
          wegSpecialAssessments: {
            create: createSpecialAssessment({ repository: assessments, now }),
            replaceUses: replaceAssessmentUses({ repository: assessments, now }),
          },
          financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
          transactions: {
            createManual: createManualTransaction({ repository: transactions }),
            setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
            confirm: confirmTransaction({ repository: transactions }),
          },
          loans: { create: createLoan({ repository: new PostgresLoanRepository(db) }) },
          loanTerms: { create: createLoanTerms({ repository: new PostgresLoanTermsRepository(db) }) },
          loanAllocations: { create: createLoanAllocation({ repository: new PostgresLoanAllocationRepository(db) }) },
          taxation: {
            create: createTaxClassification({ repository: classifications, now }),
            anschaffungsnahe: getAnschaffungsnaheCheck({ repository: classifications, now }),
            taxYear: getTaxYearView({ repository: classifications, now }),
          },
          depreciationAssets: depreciationCommands(db, { recordingEnabled, now }),
        }),
      });
      const server = app.listen(0, '127.0.0.1');
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      servers.push(server);
      bases[recordingEnabled ? 'on' : 'off'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
      if (recordingEnabled) ctx.app = app;
    }
  });

  afterAll(async () => {
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.mre.close();
    await ctx.pool.end();
  });

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 3600);
  let key = 0;
  type Options = { realm?: string; base?: Base; headers?: Record<string, string> };
  const call = (method: string, path: string, body?: unknown, options: Options = {}) =>
    fetch(`${bases[options.base ?? 'on']}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        organizationid: options.realm ?? REALM_A,
        'content-type': 'application/json',
        ...options.headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async (res: Response, status = 200): Promise<Json> => {
    const text = await res.text();
    expect(res.status, text).toBe(status);
    return JSON.parse(text);
  };
  const post = async (path: string, body: unknown, status = 201, options: Options = {}) => json(await call('POST', path, body, options), status);
  const get = async (path: string, options: Options = {}) => json(await call('GET', path, undefined, options));

  const api = {
    ctx,
    call,
    json,
    post,
    get,
    /** Sets the clock that stands in for today (Europe/Berlin business day at 10:00 UTC). */
    at: (date: string) => (clock = new Date(`${date}T10:00:00Z`)),
    nextKey: (prefix: string) => `${prefix}-${++key}`,
    link: async (mrePropertyId: string): Promise<string> =>
      (await post('/property-references/link', { mreRealmId: REALM_A, mrePropertyId })).propertyReferenceId,
    party: async (displayName: string): Promise<string> => (await post('/parties', { partyType: 'PERSON', displayName })).partyId,
    /**
     * An Acquisition through the API: the DRAFT, its costs, its allocation (confirmed unless said otherwise). The
     * Ownerships and the confirmation are the caller's (`own`, `confirm`). §59D: a `NOTARY`, `LAND_REGISTRY` or `OTHER`
     * cost is classified as a confirmed `OWNERSHIP_TRANSFER` unless `classify` is false (then `api.classifyCost` later).
     */
    purchase: async (p: {
      pr: string;
      buyers: readonly string[];
      sellers?: readonly string[];
      share: string;
      price: string;
      contract: string;
      transfer: string;
      costs?: readonly (readonly [string, string])[];
      allocation: { total: string; land: string; building: string; reviewState?: 'CONFIRMED' | 'UNREVIEWED' };
      classify?: boolean;
    }): Promise<{ acquisitionId: string; allocationId: string; costIds: string[] }> => {
      const { acquisitionId } = await post('/acquisitions', {
        propertyReferenceId: p.pr,
        purchasePrice: eur(p.price),
        acquiredShare: p.share,
        contractDate: p.contract,
        economicTransferDate: p.transfer,
        buyerPartyIds: p.buyers,
        sellerPartyIds: p.sellers ?? [],
      });
      const costIds: string[] = [];
      for (const [category, amount] of p.costs ?? []) {
        const { costId } = await post(`/acquisitions/${acquisitionId}/costs`, { category, amount: eur(amount) });
        costIds.push(costId);
        if (p.classify !== false && ['NOTARY', 'LAND_REGISTRY', 'OTHER'].includes(category)) await api.classifyCost(acquisitionId, costId, amount);
      }
      const allocationId = await api.allocate(acquisitionId, p.allocation, null);
      return { acquisitionId, allocationId, costIds };
    },
    /** §59D: the whole cost classified as a confirmed `OWNERSHIP_TRANSFER` (the first classification); its id. */
    classifyCost: async (acquisitionId: string, costId: string, amount: string): Promise<string> =>
      (
        await post(`/acquisitions/${acquisitionId}/costs/${costId}/classifications`, {
          parts: [{ purpose: 'OWNERSHIP_TRANSFER', amount: eur(amount) }],
          description: 'Kosten der Eigentumsübertragung (synthetisch)',
          reviewState: 'CONFIRMED',
          supersedes: null,
        })
      ).classificationId,
    allocate: async (
      acquisitionId: string,
      a: { total: string; land: string; building: string; reviewState?: 'CONFIRMED' | 'UNREVIEWED' },
      supersedes: string | null,
    ): Promise<string> =>
      (
        await post(`/acquisitions/${acquisitionId}/land-building-allocation`, {
          totalAllocableAmount: eur(a.total),
          landAmount: eur(a.land),
          buildingAmount: eur(a.building),
          method: 'PURCHASE_CONTRACT',
          reviewState: a.reviewState ?? 'CONFIRMED',
          supersedes,
        })
      ).allocationId,
    own: async (pr: string, ownerPartyId: string, share: string, validFrom: string, acquisitionId: string): Promise<string> =>
      (await post('/ownerships', { propertyReferenceId: pr, ownerPartyId, share, validFrom, acquisitionId })).ownershipId,
    confirm: async (acquisitionId: string) => post(`/acquisitions/${acquisitionId}/confirm`, {}, 200),
    /** The building of 1995 (band 2 %), confirmed; §59C: a confirmed STANDARD method entry for each purchase named. */
    building: async (pr: string, purchases: readonly string[] = []): Promise<string> =>
      (
        await post('/depreciation-assets', {
          propertyReferenceId: pr,
          buildingCompletionYear: 1995,
          reviewState: 'CONFIRMED',
          purchaseMethods: purchases.map((id) => standardMethodBody(id)),
        })
      ).assetId,
    /** §59C: the confirmed STANDARD method entries of the purchases named, by an amend (the whole list). */
    methods: async (assetId: string, purchases: readonly string[]): Promise<void> => {
      await post(`/depreciation-assets/${assetId}/amend`, { purchaseMethods: purchases.map((id) => standardMethodBody(id)) }, 200);
    },
    account: async (): Promise<string> =>
      (await post('/financial-accounts', { accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR' })).financialAccountId,
    /** A Transaction entered, split and confirmed; its split ids in order. */
    booked: async (account: string, direction: 'INFLOW' | 'OUTFLOW', bookingDate: string, splits: Record<string, unknown>[]): Promise<string[]> => {
      const total = splits.reduce((sum: bigint, s) => sum + (cents(s['amount'] as Money) ?? 0n), 0n);
      const amount = eur(`${total / 100n}.${String(total % 100n).padStart(2, '0')}`);
      const { transactionId } = await post('/transactions', { financialAccountId: account, amount, direction, bookingDate });
      const set = await json(await call('PUT', `/transactions/${transactionId}/splits`, { splits }));
      await post(`/transactions/${transactionId}/confirm`, undefined, 200);
      return set.splits.map((s: Json) => s.splitId as string);
    },
    /** A classification by the user (`USER_CONFIRMED`); a split by default. */
    classify: async (body: Record<string, unknown>): Promise<string> =>
      (await post('/tax-classifications', { sourceType: 'TRANSACTION_SPLIT', reviewState: 'USER_CONFIRMED', supersedes: null, ...body })).classificationId,
    schedule: async (assetId: string, query: string, base: Base = 'on') => get(`/depreciation-assets/${assetId}/schedule?${query}`, { base }),
    view: async (pr: string, year: number, ownerPartyId?: string, base: Base = 'on') =>
      get(`/property-references/${pr}/tax-years/${year}${ownerPartyId === undefined ? '' : `?ownerPartyId=${ownerPartyId}`}`, { base }),
    check: async (acquisitionId: string) => get(`/acquisitions/${acquisitionId}/anschaffungsnahe-herstellungskosten`),
    /** The body of a record: the schedule's fingerprint of `throughYear`, a reason, the changed years named. */
    recordBody: async (assetId: string, throughYear: number, acceptChangedYears: number[] = []) => ({
      throughYear,
      reason: `AfA laut Einkommensteuererklärung ${throughYear} (synthetisch)`,
      expectedInputFingerprint: (await api.schedule(assetId, `from=${throughYear}&to=${throughYear}`)).years[0].inputFingerprint,
      acceptChangedYears,
    }),
    record: async (assetId: string, throughYear: number, acceptChangedYears: number[] = []) =>
      post(`/depreciation-assets/${assetId}/schedule-versions`, await api.recordBody(assetId, throughYear, acceptChangedYears), 201, {
        headers: { 'idempotency-key': api.nextKey('record') },
      }),
    /** Every row (with its `version`) of the cash tables: AfA is never cash (ACC8 counter-check). */
    cashRows: async () => {
      const rows: Record<string, unknown> = {};
      for (const table of ['ledger_transaction', 'transaction_split']) {
        rows[table] = (await ctx.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map((r) => r.row);
      }
      return rows;
    },
  };
  return api;
}

/**
 * Owners = the property, to the cent, at the property level of a view: every Einnahmen and Werbungskosten line (the
 * two AfA lines included), both totals, `capitalized` and the result; `notOwned` must be null (every day owned).
 */
export function expectOwnersAddUp(v: Json, label: string) {
  expect(v.notOwned, label).toBeNull();
  const sum = (pick: (t: Json) => Money | undefined) => v.owners.reduce((s: bigint, o: Json) => s + (cents(pick(o)) ?? 0n), 0n);
  const sections = ['einnahmen', 'werbungskosten'] as const;
  for (const section of sections) {
    expect([label, section, sum((t) => t[section].total)], label).toEqual([label, section, cents(v[section].total)]);
    for (const l of v[section].lines) {
      const key = l.line ?? l.taxCategory;
      const pick = (t: Json) => t[section].lines.find((x: Json) => (x.line ?? x.taxCategory) === key)?.total;
      expect([label, key, sum(pick)]).toEqual([label, key, cents(l.total)]);
    }
  }
  expect([label, 'capitalized', sum((t) => t.capitalized.total)]).toEqual([label, 'capitalized', cents(v.capitalized.total)]);
  expect([label, 'result', sum((t) => t.result.amount)]).toEqual([label, 'result', cents(v.result.amount)]);
}

/**
 * A figure never without its components: each AfA line is the sum of its items, `itemCount` their number, and every item
 * names its asset, component, basis, rate, start, months and a rule version listed in `ruleVersions`.
 */
export function expectAfaTraceable(v: Json, label: string) {
  for (const code of ['AFA_BUILDING', 'AFA_SEPARATE_ASSETS']) {
    const l = lineOf(v, code);
    expect([label, code, l.items.reduce((s: bigint, i: Json) => s + (cents(i.amount) ?? 0n), 0n), l.items.length]).toEqual([
      label,
      code,
      cents(l.total),
      l.itemCount,
    ]);
    for (const item of l.items) {
      expect(item, label).toMatchObject({
        assetId: expect.any(String),
        componentId: expect.any(String),
        basis: expect.objectContaining({ currency: 'EUR' }),
        rate: expect.objectContaining({ rate: expect.any(String) }),
        start: expect.objectContaining({ month: expect.any(String) }),
        months: expect.any(Number),
        rule: { ruleCode: expect.stringMatching(/^DE_AFA_/), version: expect.any(Number) },
      });
      expect(
        v.ruleVersions.map((r: Json) => `${r.ruleCode}@${r.version}`),
        label,
      ).toContain(`${item.rule.ruleCode}@${item.rule.version}`);
      // No AfA as cash: an AfA item is no split and carries no direction.
      expect([item.sourceId, item.direction, item.splitId], label).toEqual([undefined, undefined, undefined]);
    }
  }
}
