import { describe, expect, it } from 'vitest';
import { standardMethodBody } from './infrastructure/postgres/depreciation-method.test-support.js';
import { PROPERTIES, REALM_A, REALM_B, codes, databaseUrl, totalOf, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-37 end to end (api-design.md §59C "Tests the implementation must have", "End to end"), through the HTTP API
 * wired as in main.ts: ACC8's purchase (synthetic) without a method entry (not computable, the view's gap), with an
 * unconfirmed STANDARD entry (still not computable), confirmed (§59A's figures exactly), changed to `DEGRESSIVE_7_5`
 * (reset, not confirmed), confirmed again (`DEPRECIATION_METHOD_NOT_SUPPORTED`); Realm isolation of an entry.
 */
describe.skipIf(databaseUrl === undefined)('the method status of a purchase (VC-X-37) end to end', () => {
  const api = useAcc8('purchase_method_e2e');
  const { at, post, get, call, schedule, view } = api;

  async function acc8(property: number) {
    at('2026-07-01');
    const pr = await api.link(PROPERTIES[property] as string);
    const [a, b] = [await api.party('Käuferin A'), await api.party('Käufer B')].sort() as [string, string];
    const { acquisitionId: w } = await api.purchase({
      pr,
      buyers: [a, b],
      share: '1/1',
      price: '300000.00',
      contract: '2026-05-20',
      transfer: '2026-07-01',
      costs: [
        ['REAL_ESTATE_TRANSFER_TAX', '15000.00'],
        ['NOTARY', '3000.00'],
        ['FINANCING_RELATED', '1200.00'],
      ],
      allocation: { total: '318000.00', land: '63600.00', building: '254400.00' },
    });
    await api.own(pr, a, '3/5', '2026-07-01', w);
    await api.own(pr, b, '2/5', '2026-07-01', w);
    await api.confirm(w);
    return { pr, a, b, w, building: await api.building(pr) };
  }
  const amend = (assetId: string, entry: Record<string, unknown>) => post(`/depreciation-assets/${assetId}/amend`, { purchaseMethods: [entry] }, 200);
  const unconfirmed = (w: string, overrides: Record<string, unknown> = {}) => {
    const { reviewState: _r, ...entry } = standardMethodBody(w, overrides);
    return entry;
  };

  it(
    'no entry, unconfirmed, confirmed, changed to DEGRESSIVE_7_5 (reset), confirmed again: never a figure without a confirmed STANDARD entry',
    { timeout: 120_000 },
    async () => {
      const { pr, a, b, w, building } = await acc8(0);
      at('2027-02-15');
      const notAvailable = (s: Json) => [s.status, s.components[0].status, s.years.map((y: Json) => [y.status, y.amount, y.residualValue])];
      // No entry: NOT_COMPUTABLE in every year, the amounts null (never 0.00); the view's AfA a gap, the result before AfA.
      const none = await schedule(building, 'from=2026&to=2027');
      expect(notAvailable(none)).toEqual([
        'DEPRECIATION_NOT_AVAILABLE',
        'NOT_COMPUTABLE',
        [
          ['DEPRECIATION_NOT_AVAILABLE', null, null],
          ['DEPRECIATION_NOT_AVAILABLE', null, null],
        ],
      ]);
      expect([none.components[0].method, none.components[0].reasons]).toEqual([
        null,
        [
          {
            code: 'DEPRECIATION_METHOD_NOT_CONFIRMED',
            details: { acquisitionId: w, reviewState: null, methodStatus: null, causes: null, newBuildingInCompletionYear: false },
          },
        ],
      ]);
      expect(none.review.open).toContainEqual({ code: 'DEPRECIATION_METHOD_NOT_CONFIRMED', count: 1 });
      const v2026 = await view(pr, 2026);
      expect([v2026.depreciation.status, v2026.result.basis, totalOf(v2026, 'AFA_BUILDING')]).toEqual([
        'DEPRECIATION_NOT_AVAILABLE',
        'BEFORE_DEPRECIATION',
        '0.00',
      ]);
      expect(v2026.depreciation.gaps.map((g: Json) => [g.code, g.componentId])).toEqual([['DEPRECIATION_METHOD_NOT_CONFIRMED', `ACQUISITION:${w}`]]);

      // An unconfirmed STANDARD entry: still not computable; the asset shows its status.
      const added = await amend(building, unconfirmed(w));
      expect(added.purchaseMethods.map((e: Json) => [e.acquisitionId, e.reviewState, e.methodStatus, e.causes])).toEqual([[w, 'UNREVIEWED', 'STANDARD', []]]);
      const pending = await schedule(building, 'from=2026&to=2027');
      expect([pending.components[0].status, codes(pending.components[0].reasons), pending.years[0].amount]).toEqual([
        'NOT_COMPUTABLE',
        ['DEPRECIATION_METHOD_NOT_CONFIRMED'],
        null,
      ]);

      // Confirmed: §59A's example to the cent, at both levels.
      await amend(building, standardMethodBody(w));
      const computed = await schedule(building, 'from=2026&to=2027');
      expect(computed.years.map((y: Json) => [y.year, y.status, y.amount.amount, y.owners.map((o: Json) => o.amount.amount)])).toEqual([
        [2026, 'AVAILABLE', '2544.00', ['1526.40', '1017.60']],
        [2027, 'AVAILABLE', '5088.00', ['3052.80', '2035.20']],
      ]);
      expect(computed.components[0].method).toMatchObject({ reviewState: 'CONFIRMED', methodStatus: 'STANDARD', causes: [] });
      expect((await schedule(building, `from=2027&to=2027&ownerPartyId=${b}`)).years[0].amount.amount).toBe('2035.20');
      expect(totalOf(await view(pr, 2026, a), 'AFA_BUILDING')).toBe('1526.40');

      // Changed to DEGRESSIVE_7_5: the fact resets the entry to UNREVIEWED; NOT_CONFIRMED, its status NOT_SUPPORTED.
      const changed = await amend(building, unconfirmed(w, { method: 'DEGRESSIVE_7_5' }));
      expect(changed.purchaseMethods[0]).toMatchObject({ method: 'DEGRESSIVE_7_5', reviewState: 'UNREVIEWED', methodStatus: 'NOT_SUPPORTED' });
      expect((await schedule(building, 'from=2026&to=2027')).components[0].reasons).toEqual([
        {
          code: 'DEPRECIATION_METHOD_NOT_CONFIRMED',
          details: {
            acquisitionId: w,
            reviewState: 'UNREVIEWED',
            methodStatus: 'NOT_SUPPORTED',
            causes: ['METHOD_DEGRESSIVE_7_5'],
            newBuildingInCompletionYear: false,
          },
        },
      ]);

      // Confirmed again: DEPRECIATION_METHOD_NOT_SUPPORTED with its cause; never computed linearly.
      await amend(building, standardMethodBody(w, { method: 'DEGRESSIVE_7_5' }));
      const refused = await schedule(building, 'from=2026&to=2027');
      expect([notAvailable(refused)[1], refused.components[0].reasons]).toEqual([
        'NOT_COMPUTABLE',
        [{ code: 'DEPRECIATION_METHOD_NOT_SUPPORTED', details: { acquisitionId: w, reviewState: 'CONFIRMED', causes: ['METHOD_DEGRESSIVE_7_5'] } }],
      ]);
      expect(refused.years.map((y: Json) => y.amount)).toEqual([null, null]);
      const read = await get(`/depreciation-assets/${building}`);
      expect(read.purchaseMethods.map((e: Json) => [e.methodStatus, e.causes])).toEqual([['NOT_SUPPORTED', ['METHOD_DEGRESSIVE_7_5']]]);
      const v = await view(pr, 2027);
      expect([v.depreciation.status, v.depreciation.gaps.map((g: Json) => g.code)]).toEqual([
        'DEPRECIATION_NOT_AVAILABLE',
        ['DEPRECIATION_METHOD_NOT_SUPPORTED'],
      ]);
    },
  );

  it('Realm isolation: an entry naming another Realm’s Acquisition is 404; another Realm cannot amend the asset', async () => {
    const { building, w } = await acc8(1);
    const theirs = (
      await api.ctx.pool.query(
        `WITH pr AS (INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by)
                      VALUES ($1, 'bbbbbbbbbbbbbbbbbbbbbbbb', 'ACTIVE', 'x') RETURNING id)
         INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, created_by)
         SELECT $1, id, 'DRAFT', 1000, 'EUR', 1, 1, '2026-01-01', 'x' FROM pr RETURNING id`,
        [REALM_B],
      )
    ).rows[0].id as string;
    const res = await call('POST', `/depreciation-assets/${building}/amend`, { purchaseMethods: [standardMethodBody(theirs)] });
    expect(res.status).toBe(404);
    expect((await call('POST', `/depreciation-assets/${building}/amend`, { purchaseMethods: [standardMethodBody(w)] }, { realm: REALM_B })).status).toBe(404);
    expect((await get(`/depreciation-assets/${building}`, { realm: REALM_A })).purchaseMethods).toEqual([]);
  });
});
