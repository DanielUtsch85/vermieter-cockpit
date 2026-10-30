import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  amendRentalContractReference,
  changeOwnership,
  closeDeposit,
  confirmAcquisition,
  confirmAnnualStatement,
  confirmTransaction,
  createAcquisition,
  createAcquisitionCost,
  createAnnualStatement,
  createDeposit,
  createFinancialAccount,
  createLandBuildingAllocation,
  createManualTransaction,
  createMembership,
  createOwnership,
  createParty,
  createReconciliation,
  createRentalContractReference,
  createSpecialAssessment,
  createTaxClassification,
  createWeg,
  getAnschaffungsnaheCheck,
  getTaxYearView,
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
  PostgresRentReconciliationRepository,
  PostgresRentalContractReferenceRepository,
  PostgresSecurityDepositRepository,
  PostgresTaxClassificationRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  PostgresWegAnnualStatementRepository,
  PostgresWegRepository,
  PostgresWegSpecialAssessmentRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { mrePrincipalVerifier, mreRentTermLookup, mreTenantDepositReader, mreTenantLookup } from './wiring.js';

/**
 * VC-7-04 end to end (api-design.md §58C), wired as in main.ts, on PropertyReferences of WEG units: two owners and an
 * owner change; a 10-day-rule rent at the year boundary (and a seller who may open the year); a § 82b part folded per
 * owner on a co-owner's sale; a capitalised repair; refunds of an earlier and of the same year; retained deposits "nicht
 * zugeordnet"; `ATTRIBUTION_INPUT_CHANGED` and its 31-December rule; the anschaffungsnahe check shown; the counter-checks;
 * no cash mutated; Realm isolation. Synthetic figures and names only.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM_A = '64b0c0ffee000000000000b1';
const REALM_B = '64b0c0ffee000000000000b2';
const T1 = '6512f0c2a1b2c3d4e5f6b001';
const T2 = '6512f0c2a1b2c3d4e5f6b002';
const T3 = '6512f0c2a1b2c3d4e5f6b003';
const T4 = '6512f0c2a1b2c3d4e5f6b004';

type Money = { amount: string; currency: string };
type Flag = { code: string; details: unknown };
type Item = {
  sourceType: string;
  sourceId: string;
  date: string;
  lineAmount: Money | null;
  treatment: string | null;
  taxCategory: string;
  share: { ownershipId: string; share: string; amount: Money | null } | null;
  flags: Flag[];
  reason?: string;
};
type Line = { taxCategory: string; total: Money; itemCount: number; subtotals: { immediate: Money; distributed82b: Money } | null; items: Item[] };
type Totals = {
  einnahmen: { total: Money; lines: Omit<Line, 'items'>[] };
  werbungskosten: { total: Money; lines: Omit<Line, 'items'>[] };
  result: { amount: Money };
  capitalized: { total: Money };
};
type View = {
  level: string;
  einnahmen: { total: Money; lines: Line[] };
  werbungskosten: { total: Money; lines: Line[] };
  result: { amount: Money; kind: string; basis: string };
  capitalized: { total: Money; items: Item[] };
  notInView: { items: Item[] };
  unclassified: { items: Item[] };
  notAttributed: { items: Item[] };
  acquisitions: { acquisitionId: string; status: string; final: boolean; notFinalReasons: string[] }[];
  owners: (Totals & { ownerPartyId: string })[] | null;
  notOwned: Totals | null;
  flags: Flag[];
  review: { final: boolean; open: { code: string; count: number }[] };
};

/** Cents of a Money JSON, exact. */
const cents = (m: Money | null | undefined): bigint => {
  if (m === null || m === undefined) return 0n;
  const negative = m.amount.startsWith('-');
  const [w, f = ''] = m.amount.replace('-', '').split('.') as [string, string?];
  return (negative ? -1n : 1n) * (BigInt(w) * 100n + BigInt(f.padEnd(2, '0')));
};
const lineOf = (v: View, taxCategory: string) => [...v.einnahmen.lines, ...v.werbungskosten.lines].find((l) => l.taxCategory === taxCategory) as Line;
const codes = (flags: readonly Flag[]) => flags.map((f) => f.code);
const placed = (v: View) => [
  ...v.einnahmen.lines.flatMap((l) => l.items),
  ...v.werbungskosten.lines.flatMap((l) => l.items),
  ...v.capitalized.items,
  ...v.notInView.items,
  ...v.unclassified.items,
];

describe.skipIf(databaseUrl === undefined)('the tax-year view (VC-7-04) end to end', () => {
  const schema = testSchemaName('tax_year_view_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let app: Express;
  let server: Server;
  let base: string;
  const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
  /** Every PropertyReference of Realm A and its parties, for the views of every Realm A PropertyReference. */
  const properties: { pr: string; parties: string[] }[] = [];

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    mre = await startFakeMre([
      {
        _id: REALM_A,
        name: 'A',
        members: member,
        applications: [],
        tenants: [
          { _id: T1, name: 'Mieterin Eins', guaranty: 2000 },
          { _id: T2, name: 'Mieter Zwei', guaranty: 3000 },
          { _id: T3, name: 'Mieterin Drei', guaranty: 3000 },
        ],
        rents: { [T1]: [2028010100], [T2]: [2027020100, 2027030100] },
      },
      {
        _id: REALM_B,
        name: 'B',
        members: member,
        applications: [],
        tenants: [
          { _id: T1, name: 'Fremd Eins' },
          { _id: T4, name: 'Fremd Vier', guaranty: 3000 },
        ],
      },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const wegs = new PostgresWegRepository(db);
    const statements = new PostgresWegAnnualStatementRepository(db);
    const assessments = new PostgresWegSpecialAssessmentRepository(db);
    const transactions = new PostgresTransactionRepository(db);
    const acquisitions = new PostgresAcquisitionRepository(db);
    const ownerships = new PostgresOwnershipRepository(db);
    const deposits = new PostgresSecurityDepositRepository(db);
    const classifications = new PostgresTaxClassificationRepository(db);
    const references = new PostgresRentalContractReferenceRepository(db);
    app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        parties: { create: createParty({ repository: new PostgresPartyRepository(db) }) },
        ownerships: { create: createOwnership({ repository: ownerships }), change: changeOwnership({ repository: ownerships }) },
        acquisitions: { create: createAcquisition({ repository: acquisitions }), confirm: confirmAcquisition({ repository: acquisitions }) },
        acquisitionCosts: { createCost: createAcquisitionCost({ repository: new PostgresAcquisitionCostRepository(db) }) },
        landBuildingAllocations: { create: createLandBuildingAllocation({ repository: new PostgresLandBuildingAllocationRepository(db) }) },
        wegs: { createWeg: createWeg({ repository: wegs }), createMembership: createMembership({ repository: wegs }) },
        wegAnnualStatements: { create: createAnnualStatement({ repository: statements }), confirm: confirmAnnualStatement({ repository: statements }) },
        wegSpecialAssessments: {
          create: createSpecialAssessment({ repository: assessments }),
          replaceUses: replaceAssessmentUses({ repository: assessments }),
        },
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: transactions }),
        },
        rentReconciliations: {
          create: createReconciliation({ repository: new PostgresRentReconciliationRepository(db), lookupMreRentTerm: mreRentTermLookup(client) }),
        },
        securityDeposits: {
          create: createDeposit({ repository: deposits, readMreTenant: mreTenantDepositReader(client) }),
          close: closeDeposit({ repository: deposits }),
        },
        rentalContractReferences: {
          create: createRentalContractReference({ repository: references, lookupMreTenant: mreTenantLookup(client) }),
          amend: amendRentalContractReference({ repository: references }),
        },
        taxation: {
          create: createTaxClassification({ repository: classifications }),
          anschaffungsnahe: getAnschaffungsnaheCheck({ repository: classifications }),
          taxMeanings: listTaxMeanings({ repository: classifications }),
          taxYear: getTaxYearView({ repository: classifications }),
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
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
  let counter = 0;
  const giro = new Map<string, string>();

  async function flat(realm = REALM_A) {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f7b000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    const pr = rows[0].id as string;
    if (realm === REALM_A) {
      // A unit of a WEG (§58C's scenarios).
      const weg = await json<{ wegId: string }>(await A('POST', '/wegs', { displayName: `WEG ${++counter}` }), 201);
      const membershipId = (
        await json<{ membershipId: string }>(
          await A('POST', `/wegs/${weg.wegId}/memberships`, { propertyReferenceId: pr, miteigentumsanteil: '125/1000', validFrom: '2020-01-01' }),
          201,
        )
      ).membershipId;
      properties.push({ pr, parties: [] });
      return { pr, membershipId };
    }
    return { pr, membershipId: '' };
  }
  async function party(name: string, realm = REALM_A) {
    return (await json<{ partyId: string }>(await call(realm, 'POST', '/parties', { partyType: 'PERSON', displayName: name }), 201)).partyId;
  }
  async function own(pr: string, ownerPartyId: string, share: string, validFrom: string) {
    properties.find((p) => p.pr === pr)?.parties.push(ownerPartyId);
    return (await json<{ ownershipId: string }>(await A('POST', '/ownerships', { propertyReferenceId: pr, ownerPartyId, share, validFrom }), 201)).ownershipId;
  }
  /** §26.2: `close` ends on effectiveDate − 1, the new Party starts on effectiveDate. */
  async function sell(pr: string, ownershipId: string, buyer: string, share: string, effectiveDate: string) {
    properties.find((p) => p.pr === pr)?.parties.push(buyer);
    await json(
      await A('POST', `/property-references/${pr}/ownership-changes`, {
        effectiveDate,
        reason: 'Verkauf',
        close: [ownershipId],
        create: [{ ownerPartyId: buyer, share }],
      }),
      201,
    );
  }
  async function booked(direction: 'INFLOW' | 'OUTFLOW', bookingDate: string, splits: Record<string, unknown>[], realm = REALM_A) {
    if (!giro.has(realm)) {
      giro.set(
        realm,
        (
          await json<{ financialAccountId: string }>(
            await call(realm, 'POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }),
            201,
          )
        ).financialAccountId,
      );
    }
    const total = splits.reduce((sum, s) => sum + cents(s['amount'] as Money), 0n);
    const amount = `${total / 100n}.${String(total % 100n).padStart(2, '0')}`;
    const { transactionId } = await json<{ transactionId: string }>(
      await call(realm, 'POST', '/transactions', { financialAccountId: giro.get(realm), amount: eur(amount), direction, bookingDate }),
      201,
    );
    const set = await json<{ splits: { splitId: string }[] }>(await call(realm, 'PUT', `/transactions/${transactionId}/splits`, { splits }), 200);
    await json(await call(realm, 'POST', `/transactions/${transactionId}/confirm`), 200);
    return { transactionId, splitIds: set.splits.map((s) => s.splitId) };
  }
  const on = (pr: string, amount: string, financialCategoryCode: string) => ({ amount: eur(amount), financialCategoryCode, propertyReferenceId: pr });
  const classify = async (body: Record<string, unknown>) =>
    json<{ classificationId: string }>(await A('POST', '/tax-classifications', { reviewState: 'USER_CONFIRMED', supersedes: null, ...body }), 201);
  const view = async (pr: string, year: number, ownerPartyId?: string, realm = REALM_A) =>
    json<View>(
      await call(realm, 'GET', `/property-references/${pr}/tax-years/${year}${ownerPartyId === undefined ? '' : `?ownerPartyId=${ownerPartyId}`}`),
      200,
    );
  /** The owners' figures plus NOT_OWNED are the property's, line by line, to the cent. */
  function reconciles(property: View) {
    const totals = [...(property.owners ?? []), ...(property.notOwned === null ? [] : [property.notOwned])];
    for (const section of ['einnahmen', 'werbungskosten'] as const) {
      property[section].lines.forEach((line, i) =>
        expect(
          totals.reduce((s, t) => s + cents(t[section].lines[i]?.total), 0n),
          line.taxCategory,
        ).toBe(cents(line.total)),
      );
      expect(totals.reduce((s, t) => s + cents(t[section].total), 0n)).toBe(cents(property[section].total));
    }
    expect(totals.reduce((s, t) => s + cents(t.result.amount), 0n)).toBe(cents(property.result.amount));
    expect(totals.reduce((s, t) => s + cents(t.capitalized.total), 0n)).toBe(cents(property.capitalized.total));
  }
  /** 750.01 over two owners of 1/2 each: the extra cent to the lower ownerPartyId (§58C ties). */
  const halfOf = (party: string, other: string) => (party < other ? '375.01' : '375.00');

  it('two owners and an owner change: A’s, B’s and C’s views of 2027, each figure × the share on its date; A + B + C = the property to the cent', async () => {
    const { pr } = await flat();
    const [a, b, c] = [await party('Anna'), await party('Bernd'), await party('Clara')];
    await own(pr, a, '1/2', '2026-01-01');
    const bs = await own(pr, b, '1/2', '2026-01-01');
    await sell(pr, bs, c, '1/2', '2027-07-01');
    for (let month = 1; month <= 12; month++) {
      await booked('INFLOW', `2027-${String(month).padStart(2, '0')}-15`, [on(pr, '750.01', 'RENT_BASE'), on(pr, '150.00', 'RENT_OPERATING_COST_ADVANCE')]);
    }
    const property = await view(pr, 2027);
    expect([lineOf(property, 'RENT').total, lineOf(property, 'OPERATING_COST_ADVANCES').total]).toEqual([eur('9000.12'), eur('1800.00')]);
    expect(property.result).toMatchObject({ amount: eur('10800.12'), kind: 'SURPLUS', basis: 'BEFORE_DEPRECIATION' });
    reconciles(property);
    const [va, vb, vc] = [await view(pr, 2027, a), await view(pr, 2027, b), await view(pr, 2027, c)];
    expect(lineOf(vb, 'RENT').items.map((i) => i.date.slice(5, 7))).toEqual(['01', '02', '03', '04', '05', '06']);
    expect(lineOf(vc, 'RENT').items.map((i) => i.date.slice(5, 7))).toEqual(['07', '08', '09', '10', '11', '12']);
    expect(lineOf(va, 'RENT').items).toHaveLength(12);
    expect(lineOf(vb, 'RENT').items.map((i) => i.lineAmount?.amount)).toEqual(Array(6).fill(halfOf(b, a)));
    expect(lineOf(vc, 'RENT').items.map((i) => i.lineAmount?.amount)).toEqual(Array(6).fill(halfOf(c, a)));
    expect(lineOf(vc, 'RENT').items[0]?.share).toMatchObject({ share: '1/2' });
    expect(cents(va.result.amount) + cents(vb.result.amount) + cents(vc.result.amount)).toBe(cents(property.result.amount));
    for (const category of ['RENT', 'OPERATING_COST_ADVANCES']) {
      expect(cents(lineOf(va, category).total) + cents(lineOf(vb, category).total) + cents(lineOf(vc, category).total)).toBe(
        cents(lineOf(property, category).total),
      );
    }
    expect(property.owners?.map((o) => o.ownerPartyId)).toEqual([a, b, c].sort());
    expect(property.notOwned).toBeNull();
  });

  it('a 10-day-rule rent at the year boundary; a seller opens the year; ATTRIBUTION_INPUT_CHANGED from the AuditRecords, only after 31 December; Realm isolation of the history', async () => {
    const { pr } = await flat();
    const [a, c, d] = [await party('Anna Zwei'), await party('Clara Zwei'), await party('Dora Zwei')];
    const as = await own(pr, a, '1/2', '2026-01-01');
    await own(pr, c, '1/2', '2026-01-01');
    const reference = await json<{ rentalContractReferenceId: string }>(
      await A('POST', '/rental-contract-references', { mreTenantId: T1, rentDueDays: [{ validFrom: '2026-01-01', day: 3 }] }),
      201,
    );
    const january = await booked('INFLOW', '2027-12-29', [on(pr, '750.01', 'RENT_BASE')]);
    await json(
      await A('POST', '/rent-reconciliations', {
        transactionId: january.transactionId,
        mreTenantId: T1,
        mreRentTerm: '2028010100',
        matchedAmount: eur('750.01'),
      }),
      201,
    );
    const rentId = january.splitIds[0] as string;
    const v2028 = await view(pr, 2028);
    expect(lineOf(v2028, 'RENT').items.map((i) => [i.sourceId, codes(i.flags)])).toEqual([[rentId, ['ATTRIBUTED_BY_10_DAY_RULE']]]);
    expect(v2028.review.open).toContainEqual({ code: 'ATTRIBUTED_BY_10_DAY_RULE', count: 1 });
    expect(lineOf(await view(pr, 2027), 'RENT').items).toEqual([]);
    expect([(await view(pr, 2028, a)).einnahmen.total, (await view(pr, 2028, c)).einnahmen.total].map(cents).reduce((s, x) => s + x, 0n)).toBe(75001n);

    // The variant: A sells to D effective 2028-01-01. The rent stays A's and C's (the owners on 29 December).
    await sell(pr, as, d, '1/2', '2028-01-01');
    const after = await view(pr, 2028);
    const rent = lineOf(after, 'RENT').items[0] as Item;
    expect(codes(rent.flags)).toContain('SHARE_DATE_OUTSIDE_TAX_YEAR');
    expect(after.owners?.map((o) => o.ownerPartyId)).toEqual([a, c].sort());
    const sellers = await view(pr, 2028, a);
    expect(lineOf(sellers, 'RENT').items.map((i) => i.lineAmount?.amount)).toEqual([halfOf(a, c)]);
    expect(lineOf(await view(pr, 2028, d), 'RENT').items).toEqual([]);

    // rentDueDays from day 3 to day 15: the rent moves to 2027. Recorded today (2026), while both years lie ahead: no flag.
    const path = `/rental-contract-references/${reference.rentalContractReferenceId}`;
    await json(await A('POST', `${path}/amend`, { rentDueDays: [{ validFrom: '2026-01-01', day: 15 }] }, { 'if-match': '"1"' }), 200);
    expect(lineOf(await view(pr, 2027), 'RENT').items.map((i) => i.sourceId)).toEqual([rentId]);
    expect(codes((await view(pr, 2027)).flags)).not.toContain('ATTRIBUTION_INPUT_CHANGED');
    expect(codes((await view(pr, 2028)).flags)).not.toContain('ATTRIBUTION_INPUT_CHANGED');
    // The same correction recorded after both years (a filed return may be affected): both views flagged.
    const { rows } = await pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = 'AMENDED'`, [reference.rentalContractReferenceId]);
    const auditRecordId = rows[0].id as string;
    await pool.query(`UPDATE audit_record SET occurred_at = '2029-01-15T10:00:00Z' WHERE id = $1`, [auditRecordId]);
    const flagged = await view(pr, 2027);
    const expected = [
      {
        rentalContractReferenceId: reference.rentalContractReferenceId,
        auditRecordId,
        amendedAt: '2029-01-15T10:00:00.000Z',
        changedEntries: [{ validFrom: '2026-01-01', from: 3, to: 15 }],
        items: [{ sourceId: rentId, yearBefore: 2028, yearAfter: 2027 }],
      },
    ];
    expect(flagged.flags.find((f) => f.code === 'ATTRIBUTION_INPUT_CHANGED')?.details).toEqual(expected);
    expect(codes(lineOf(flagged, 'RENT').items[0]?.flags ?? [])).toContain('ATTRIBUTION_INPUT_CHANGED');
    const moved = await view(pr, 2028);
    expect(moved.flags.find((f) => f.code === 'ATTRIBUTION_INPUT_CHANGED')?.details).toEqual(expected);
    expect(lineOf(moved, 'RENT').items).toEqual([]);
    expect(moved.review.open).toContainEqual({ code: 'ATTRIBUTION_INPUT_CHANGED', count: 1 });

    // Counter-check: an amendment adding an entry from 2030 flags nothing of its own.
    await json(
      await A(
        'POST',
        `${path}/amend`,
        {
          rentDueDays: [
            { validFrom: '2026-01-01', day: 15 },
            { validFrom: '2030-01-01', day: 1 },
          ],
        },
        { 'if-match': '"2"' },
      ),
      200,
    );
    await pool.query(`UPDATE audit_record SET occurred_at = '2029-02-15T10:00:00Z' WHERE entity_id = $1 AND action = 'AMENDED' AND id <> $2`, [
      reference.rentalContractReferenceId,
      auditRecordId,
    ]);
    expect((await view(pr, 2027)).flags.find((f) => f.code === 'ATTRIBUTION_INPUT_CHANGED')?.details).toEqual(expected);

    // Realm isolation: another Realm's reference of the same MRE Tenant id, amended after the years, raises nothing here.
    const foreign = await json<{ rentalContractReferenceId: string }>(
      await call(REALM_B, 'POST', '/rental-contract-references', { mreTenantId: T1, rentDueDays: [{ validFrom: '2026-01-01', day: 3 }] }),
      201,
    );
    await json(
      await call(
        REALM_B,
        'POST',
        `/rental-contract-references/${foreign.rentalContractReferenceId}/amend`,
        { rentDueDays: [{ validFrom: '2026-01-01', day: 20 }] },
        { 'if-match': '"1"' },
      ),
      200,
    );
    await pool.query(`UPDATE audit_record SET occurred_at = '2029-03-01T10:00:00Z' WHERE entity_id = $1 AND action = 'AMENDED'`, [
      foreign.rentalContractReferenceId,
    ]);
    expect((await view(pr, 2028)).flags.find((f) => f.code === 'ATTRIBUTION_INPUT_CHANGED')?.details).toEqual(expected);
  });

  it('a § 82b part: 3,000.00 in each year 2027–2029, 1,500.00 each to A and C; C sells to D: C 3,000.00 in 2028, the property 4,500.00 and 1,500.00, flagged; D has no part', async () => {
    const { pr } = await flat();
    const [a, c, d] = [await party('Anna Drei'), await party('Clara Drei'), await party('Dora Drei')];
    await own(pr, a, '1/2', '2026-01-01');
    const cs = await own(pr, c, '1/2', '2026-01-01');
    const repair = (await booked('OUTFLOW', '2027-09-15', [on(pr, '9000.00', 'MAINTENANCE')])).splitIds[0] as string;
    await classify({
      sourceType: 'TRANSACTION_SPLIT',
      sourceId: repair,
      taxCategory: 'MAINTENANCE',
      treatment: 'DISTRIBUTED_82B',
      distributionYears: 3,
      mostlyResidentialConfirmed: true,
    });
    for (const year of [2027, 2028, 2029]) {
      const v = await view(pr, year);
      expect(lineOf(v, 'MAINTENANCE')).toMatchObject({ total: eur('3000.00'), subtotals: { immediate: eur('0.00'), distributed82b: eur('3000.00') } });
      expect([lineOf(await view(pr, year, a), 'MAINTENANCE').total, lineOf(await view(pr, year, c), 'MAINTENANCE').total]).toEqual([
        eur('1500.00'),
        eur('1500.00'),
      ]);
      reconciles(v);
    }
    await sell(pr, cs, d, '1/2', '2028-07-01');
    const [y27, y28, y29] = [await view(pr, 2027), await view(pr, 2028), await view(pr, 2029)];
    expect([y27, y28, y29].map((v) => lineOf(v, 'MAINTENANCE').total.amount)).toEqual(['3000.00', '4500.00', '1500.00']);
    expect([y27, y28, y29].map((v) => codes(lineOf(v, 'MAINTENANCE').items[0]?.flags ?? []).includes('DISTRIBUTION_FOLDED_PER_OWNER'))).toEqual([
      false,
      true,
      true,
    ]);
    expect(lineOf(await view(pr, 2028, c), 'MAINTENANCE').total).toEqual(eur('3000.00'));
    expect(lineOf(await view(pr, 2029, a), 'MAINTENANCE').total).toEqual(eur('1500.00'));
    expect(lineOf(await view(pr, 2029, d), 'MAINTENANCE').items).toEqual([]);
    expect(y29.owners?.map((o) => o.ownerPartyId)).toEqual([a]);
    for (const v of [y27, y28, y29]) reconciles(v);
    // §58B's per-property list is unchanged: 3,000.00 in 2029 there.
    const listed = await json<{ items: { yearAmount: Money }[] }>(await A('GET', `/property-references/${pr}/tax-meanings?year=2029`), 200);
    expect(listed.items.map((i) => i.yearAmount)).toEqual([eur('3000.00')]);
  });

  it('a capitalised repair, refunds of an earlier and of the same year; the counter-checks: WEG_FUNDS in notInView, no statement cost line, result = Σ lineAmounts', async () => {
    const { pr, membershipId } = await flat();
    const a = await party('Anna Vier');
    await own(pr, a, '1/1', '2020-01-01');
    await booked('INFLOW', '2027-03-15', [on(pr, '1000.00', 'RENT_BASE')]);
    const capitalised = (await booked('OUTFLOW', '2027-04-01', [on(pr, '5000.00', 'MAINTENANCE')])).splitIds[0] as string;
    await classify({ sourceType: 'TRANSACTION_SPLIT', sourceId: capitalised, taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED' });
    const earlier = (await booked('INFLOW', '2027-02-01', [on(pr, '120.00', 'MAINTENANCE')])).splitIds[0] as string;
    await classify({ sourceType: 'TRANSACTION_SPLIT', sourceId: earlier, taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', refundOfYear: 2026 });
    await booked('OUTFLOW', '2027-05-04', [on(pr, '500.00', 'MAINTENANCE')]);
    const same = (await booked('INFLOW', '2027-06-01', [on(pr, '50.00', 'MAINTENANCE')])).splitIds[0] as string;
    await classify({ sourceType: 'TRANSACTION_SPLIT', sourceId: same, taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', refundOfYear: 2027 });
    const reserve = (await booked('OUTFLOW', '2027-03-01', [on(pr, '600.00', 'WEG_RESERVE_CONTRIBUTION')])).splitIds[0] as string;
    const statement = (
      await json<{ statementId: string }>(
        await A('POST', `/weg-memberships/${membershipId}/annual-statements`, {
          financialYear: 2027,
          periodFrom: '2027-01-01',
          periodUntil: '2027-12-31',
          supersedes: null,
          costLines: [
            { position: 1, account: 'Instandhaltung', group: 'NON_RECOVERABLE', allocationKey: 'MEA', totalAmount: eur('8000.00'), unitShare: eur('1000.00') },
          ],
          recoverableSubtotal: eur('0.00'),
          nonRecoverableSubtotal: eur('1000.00'),
          totalCosts: eur('1000.00'),
          hausgeldRequested: eur('1000.00'),
          hausgeldPaid: eur('1000.00'),
          settlementPeak: eur('0.00'),
          reserve: { source: 'ANNUAL_STATEMENT', lines: [] },
        }),
        201,
      )
    ).statementId;
    await json(await A('POST', `/weg-annual-statements/${statement}/confirm`), 200);
    const before = await view(pr, 2027);
    const v = await view(pr, 2027);
    expect(v).toEqual(before);
    expect(v.capitalized).toMatchObject({ total: eur('5000.00'), items: [{ sourceId: capitalised, taxCategory: 'MAINTENANCE', lineAmount: eur('5000.00') }] });
    expect(lineOf(v, 'REFUNDS_OF_EARLIER_YEARS').items.map((i) => [i.sourceId, i.lineAmount])).toEqual([[earlier, eur('120.00')]]);
    expect(lineOf(v, 'MAINTENANCE').items.map((i) => i.lineAmount?.amount)).toEqual(['500.00', '-50.00']);
    expect([v.einnahmen.total, v.werbungskosten.total, v.result.amount]).toEqual([eur('1120.00'), eur('450.00'), eur('670.00')]);
    // Counter-checks: the reserve contribution in notInView, never in a total; no statement cost line anywhere.
    expect(v.notInView.items.map((i) => [i.sourceId, i.lineAmount])).toEqual([[reserve, null]]);
    expect(placed(v).some((i) => i.sourceId === statement)).toBe(false);
    const sum = [
      ...v.einnahmen.lines.flatMap((l) => l.items).map((i) => cents(i.lineAmount)),
      ...v.werbungskosten.lines.flatMap((l) => l.items).map((i) => -cents(i.lineAmount)),
    ];
    expect(sum.reduce((s, x) => s + x, 0n)).toBe(cents(v.result.amount));
    // The capitalised repair leaves the result unchanged: it is not summed.
    expect(cents(v.result.amount)).toBe(112000n - 45000n);
  });

  it('retained deposits "nicht zugeordnet": a Tenant on two PropertyReferences in both views, one with no reconciled rent in every view, never summed; another Realm’s in none; principal and deposit cash in no view', async () => {
    const [{ pr: first }, { pr: second }] = [await flat(), await flat()];
    for (const [pr, date, term] of [
      [first, '2027-02-14', '2027020100'],
      [second, '2027-03-14', '2027030100'],
    ] as const) {
      const r = await booked('INFLOW', date, [on(pr, '800.00', 'RENT_BASE')]);
      await json(
        await A('POST', '/rent-reconciliations', { transactionId: r.transactionId, mreTenantId: T2, mreRentTerm: term, matchedAmount: eur('800.00') }),
        201,
      );
    }
    const close = async (tenant: string, realm = REALM_A) => {
      const deposit = await json<{ securityDepositId: string }>(await call(realm, 'POST', '/security-deposits', { mreTenantId: tenant }), 201);
      const id = deposit.securityDepositId;
      const receipt = await booked(
        'INFLOW',
        '2026-01-05',
        [{ amount: eur('3000.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: id }],
        realm,
      );
      await booked('OUTFLOW', '2027-06-20', [{ amount: eur('2600.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: id }], realm);
      await json(
        await call(realm, 'POST', `/security-deposits/${id}/close`, { closingDate: '2027-06-30', reason: 'RETAINED', closingNote: 'Mietrückstand' }),
        200,
      );
      return { id, receipt: receipt.splitIds[0] as string };
    };
    const several = await close(T2);
    await classify({ sourceType: 'DEPOSIT_CLOSING', sourceId: several.id, taxCategory: 'RETAINED_DEPOSIT_RENT', treatment: 'INCOME' });
    const none = await close(T3);
    const foreign = await close(T4, REALM_B);
    for (const pr of [first, second]) {
      const v = await view(pr, 2027);
      const listed = v.notAttributed.items.map((i) => [i.sourceId, i.reason, i.lineAmount, i.taxCategory]);
      expect(listed).toContainEqual([several.id, 'SEVERAL_PROPERTY_REFERENCES', null, 'RETAINED_DEPOSIT_RENT']);
      expect(listed).toContainEqual([none.id, 'NO_RECONCILED_RENT', null, 'UNCLASSIFIED']);
      expect(lineOf(v, 'RETAINED_DEPOSIT_RENT').items).toEqual([]);
      expect(v.einnahmen.total).toEqual(eur('800.00'));
      expect(codes(v.flags)).toContain('UNATTRIBUTED_ITEMS');
    }
    // Every view of the Realm lists the one without reconciled rent; none lists another Realm's; deposit cash is in no view.
    for (const { pr } of properties) {
      const v = await view(pr, 2027);
      const ids = v.notAttributed.items.map((i) => i.sourceId);
      expect(ids).toContain(none.id);
      expect(ids).not.toContain(foreign.id);
      expect(placed(v).some((i) => i.sourceId === several.receipt || i.sourceId === none.receipt)).toBe(false);
    }
    const { pr: theirs } = await flat(REALM_B);
    expect((await view(theirs, 2027, undefined, REALM_B)).notAttributed.items.map((i) => i.sourceId)).toEqual([foreign.id]);
  });

  it('the anschaffungsnahe check above 15 %: the summed items keep their treatment and are flagged; acquisitions names the check, final false; ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL', async () => {
    const { pr, membershipId } = await flat();
    const buyer = await party('Anna Käuferin');
    const acquisition = (
      await json<{ acquisitionId: string }>(
        await A('POST', '/acquisitions', {
          propertyReferenceId: pr,
          purchasePrice: eur('240000.00'),
          acquiredShare: '1/1',
          contractDate: '2026-02-01',
          economicTransferDate: '2026-03-15',
          buyerPartyIds: [buyer],
          sellerPartyIds: [],
        }),
        201,
      )
    ).acquisitionId;
    properties.find((p) => p.pr === pr)?.parties.push(buyer);
    await json(
      await A('POST', '/ownerships', { propertyReferenceId: pr, ownerPartyId: buyer, share: '1/1', validFrom: '2026-03-15', acquisitionId: acquisition }),
      201,
    );
    await json(await A('POST', `/acquisitions/${acquisition}/confirm`, {}), 200);
    await json(await A('POST', `/acquisitions/${acquisition}/costs`, { category: 'REAL_ESTATE_TRANSFER_TAX', amount: eur('24000.00') }), 201);
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
    const repair = (await booked('OUTFLOW', '2026-05-14', [on(pr, '18000.00', 'MAINTENANCE')])).splitIds[0] as string;
    await classify({ sourceType: 'TRANSACTION_SPLIT', sourceId: repair, taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', netAmount: eur('15126.05') });
    const assessment = (
      await json<{ assessmentId: string }>(
        await A('POST', `/weg-memberships/${membershipId}/special-assessments`, {
          description: 'Fassadensanierung',
          resolutionDate: '2027-01-20',
          purpose: 'MAINTENANCE',
          unitShare: eur('14800.00'),
          instalments: [{ position: 1, dueDate: '2027-03-01', amount: eur('14800.00') }],
        }),
        201,
      )
    ).assessmentId;
    await json(
      await A('PUT', `/weg-special-assessments/${assessment}/uses`, {
        uses: [{ position: 1, date: '2027-06-10', description: 'Fassade', unitShare: eur('14800.00') }],
      }),
      200,
    );
    await classify({ sourceType: 'WEG_ASSESSMENT_USE', sourceId: assessment, sourcePosition: 1, taxCategory: 'WEG_SPENDING', treatment: 'DEDUCTIBLE' });
    const v2027 = await view(pr, 2027);
    const use = lineOf(v2027, 'WEG_SPENDING').items[0] as Item;
    expect([use.sourceId, use.treatment, use.lineAmount]).toEqual([assessment, 'DEDUCTIBLE', eur('14800.00')]);
    expect(codes(use.flags)).toEqual(expect.arrayContaining(['ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', 'VAT_NOT_SEPARATED']));
    expect(v2027.acquisitions).toEqual([expect.objectContaining({ acquisitionId: acquisition, status: 'ABOVE_THRESHOLD', final: false })]);
    expect(v2027.acquisitions[0]?.notFinalReasons).toEqual(expect.arrayContaining(['GROSS_AMOUNTS', 'WINDOW_OPEN']));
    expect(codes(v2027.flags)).toContain('ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL');
    expect(v2027.review.open).toContainEqual({ code: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', count: 1 });
    expect(lineOf(v2027, 'WEG_SPENDING').total).toEqual(eur('14800.00'));
    const v2026 = await view(pr, 2026);
    expect(lineOf(v2026, 'MAINTENANCE').items.map((i) => [i.sourceId, i.treatment, codes(i.flags).includes('ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN')])).toEqual([
      [repair, 'DEDUCTIBLE', true],
    ]);
    expect(lineOf(v2026, 'MAINTENANCE').total).toEqual(eur('18000.00'));
  });

  it('no cash mutated around every view at both levels and of three years; Realm isolation of the route', async () => {
    const before = await rowsSnapshot(pool);
    for (const { pr, parties } of properties) {
      for (const year of [2026, 2027, 2028]) {
        const property = await view(pr, year);
        expect(property.review.final).toBe(false);
        expect(property.flags[0]?.code).toBe('DEPRECIATION_NOT_AVAILABLE');
        reconciles(property);
        for (const p of parties) {
          const res = await A('GET', `/property-references/${pr}/tax-years/${year}?ownerPartyId=${p}`);
          expect([200, 422]).toContain(res.status);
        }
      }
    }
    expect(await rowsSnapshot(pool)).toEqual(before);
    // Realm isolation: another Realm's PropertyReference and Party are unknown.
    const pr = properties[0]?.pr as string;
    const other = await call(REALM_B, 'GET', `/property-references/${pr}/tax-years/2027`);
    expect(other.status).toBe(404);
    const foreignParty = await party('Fremde Partei', REALM_B);
    const res = await A('GET', `/property-references/${pr}/tax-years/2027?ownerPartyId=${foreignParty}`);
    expect([res.status, ((await res.json()) as { error: { details: unknown } }).error.details]).toEqual([404, { ownerPartyId: foreignParty }]);
  });
});
