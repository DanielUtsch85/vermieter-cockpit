import { beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from './database.js';
import { databaseUrl, REALM, OTHER_REALM, actor, eur, split, useRentReconciliationDatabase } from './rent-reconciliation.test-support.js';
import { PostgresRentTenantTermQueries } from './rent-tenant-terms-store.js';

/**
 * §37.7's DE side (#364, VC-X-72): the Realm's Tenants grouped from its reconciliations of any status, their order and
 * paging, and one Tenant's reconciliations in a window of term keys; both filtered to the Realm. Reads only: the tests
 * count the AuditRecords before and after. Synthetic ids only.
 */
const A = '6512f0c2a1b2c3d4e5f60b01';
const B = '6512f0c2a1b2c3d4e5f60b02';
const C = '6512f0c2a1b2c3d4e5f60b03';
const D = '6512f0c2a1b2c3d4e5f60b04';
const W = '6512f0c2a1b2c3d4e5f60b09';

describe.skipIf(databaseUrl === undefined)('PostgresRentTenantTermQueries (§37.7)', () => {
  const { ctx, transaction } = useRentReconciliationDatabase('rent_tenant_terms_test');
  let queries: PostgresRentTenantTermQueries;
  beforeAll(() => {
    queries = new PostgresRentTenantTermQueries(createDatabase(ctx.pool));
  });

  /** One reconciliation on its own confirmed Transaction, inserted with its `created_at` (SUGGESTED or CONFIRMED). */
  async function insert(tenant: string, term: string, createdAt: string, status: 'CONFIRMED' | 'SUGGESTED' = 'CONFIRMED', realm = REALM, amount = '100.00') {
    const tx = await transaction([split('800.00')], { realm });
    const suggested = status === 'SUGGESTED';
    const { rows } = await ctx.pool.query<{ id: string }>(
      `INSERT INTO rent_payment_reconciliation (mre_realm_id, status, transaction_id, mre_tenant_id, mre_rent_term, matched_amount, currency,
         confidence, suggestion_reason, confirmed_at, confirmed_by, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'EUR', $7, $8, $9, $10, 'x', $11) RETURNING id`,
      [
        realm,
        status,
        tx,
        tenant,
        term,
        amount,
        suggested ? 'MEDIUM' : null,
        suggested ? 'EXACT_AMOUNT' : null,
        suggested ? null : createdAt,
        suggested ? null : 'x',
        createdAt,
      ],
    );
    return rows[0]?.id ?? '';
  }
  const audits = async () => Number((await ctx.pool.query(`SELECT count(*) FROM audit_record`)).rows[0].count);

  it('an empty Realm is an empty page, never an error', async () => {
    expect(await queries.tenants(REALM, { page: 1, pageSize: 50 })).toEqual({ items: [], page: 1, pageSize: 50, total: 0 });
  });

  it('each Tenant once, over every status; the highest term, the count and the latest createdAt; another Realm never listed', async () => {
    await insert(A, '2027010100', '2027-01-05T10:00:00Z');
    await insert(A, '2027030100', '2027-02-01T10:00:00Z');
    const released = await insert(A, '2027020100', '2027-03-01T10:00:00Z');
    expect((await ctx.repository.release(released, REALM, 'falscher Monat', new Date(), actor)).kind).toBe('RELEASED');
    const rejected = await insert(B, '2027020100', '2027-02-10T10:00:00Z', 'SUGGESTED');
    expect((await ctx.repository.reject(rejected, REALM, 'anderer Mieter', new Date(), actor)).kind).toBe('REJECTED');
    await insert(C, '2027020100', '2027-02-10T10:00:00Z', 'SUGGESTED');
    await insert(W, '2027090100', '2027-09-01T10:00:00Z', 'CONFIRMED', OTHER_REALM);
    const before = await audits();
    const page = await queries.tenants(REALM, { page: 1, pageSize: 50 });
    expect(await audits()).toBe(before);
    expect(page).toEqual({
      items: [
        { mreTenantId: A, latestMreRentTerm: '2027030100', reconciliationCount: 3, latestCreatedAt: new Date('2027-03-01T10:00:00Z') },
        // Equal latestCreatedAt: the id decides, ascending.
        { mreTenantId: B, latestMreRentTerm: '2027020100', reconciliationCount: 1, latestCreatedAt: new Date('2027-02-10T10:00:00Z') },
        { mreTenantId: C, latestMreRentTerm: '2027020100', reconciliationCount: 1, latestCreatedAt: new Date('2027-02-10T10:00:00Z') },
      ],
      page: 1,
      pageSize: 50,
      total: 3,
    });
    expect(await queries.tenants(OTHER_REALM, { page: 1, pageSize: 50 })).toMatchObject({ items: [{ mreTenantId: W }], total: 1 });
  });

  it('pages: stable and disjoint, total over all pages, a page past the end empty', async () => {
    await insert(D, '2027020100', '2027-02-10T10:00:00Z');
    const pages = await Promise.all([1, 2, 3].map((page) => queries.tenants(REALM, { page, pageSize: 2 })));
    expect(pages.map((p) => [p.total, p.items.map((i) => i.mreTenantId)])).toEqual([
      [4, [A, B]],
      [4, [C, D]],
      [4, []],
    ]);
  });

  it('the reconciliations of one Tenant in [from, before), any status, of the Realm only', async () => {
    const T = '6512f0c2a1b2c3d4e5f60b10';
    await insert(T, '2027013100', '2027-02-01T10:00:00Z');
    await insert(T, '2027020100', '2027-02-02T10:00:00Z', 'CONFIRMED', REALM, '250.00');
    await insert(T, '2027020100', '2027-02-03T10:00:00Z', 'SUGGESTED');
    await insert(T, '2027032300', '2027-03-04T10:00:00Z');
    await insert(T, '2027040100', '2027-04-01T10:00:00Z');
    await insert(T, '2027030100', '2027-03-01T10:00:00Z', 'CONFIRMED', OTHER_REALM);
    await insert(A, '2027020500', '2027-02-05T10:00:00Z');
    const before = await audits();
    const rows = await queries.tenantTerms(REALM, T, '2027020000', '2027040000');
    expect(await audits()).toBe(before);
    expect(rows).toEqual([
      { mreRentTerm: '2027020100', status: 'CONFIRMED', matchedAmount: eur('250.00') },
      { mreRentTerm: '2027020100', status: 'SUGGESTED', matchedAmount: eur('100.00') },
      { mreRentTerm: '2027032300', status: 'CONFIRMED', matchedAmount: eur('100.00') },
    ]);
    expect(await queries.tenantTerms(OTHER_REALM, T, '2027020000', '2027040000')).toEqual([
      { mreRentTerm: '2027030100', status: 'CONFIRMED', matchedAmount: eur('100.00') },
    ]);
    expect(await queries.tenantTerms(REALM, '6512f0c2a1b2c3d4e5f60bff', '2027010000', '2028010000')).toEqual([]);
  });
});
