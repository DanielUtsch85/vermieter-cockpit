import { describe, expect, it } from 'vitest';
import { PROPERTIES, REALM_B, codes, databaseUrl, totalOf, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-41 Part 1 end to end (api-design.md §59G "Tests the implementation must have", "End to end"), through the HTTP
 * API wired as in main.ts, on ACC8's purchase (synthetic: 254,400.00, transfer 2026-07-01, A 3/5, B 2/5): a Stichtag in
 * the first year (1/30 from the start), moved after the first year (the band before its year, nothing from it, the
 * release missing), released (`ADVISOR_CONFIRMED`, evidence, release note), an entry without a Stichtag as stored before
 * 0056 (not computable, never its document date); the history of each amend; no cash, split or classification
 * changed; another Realm neither reads nor writes the entry.
 */
describe.skipIf(databaseUrl === undefined)('the shorter useful life from its Stichtag (VC-X-41 Part 1) end to end', () => {
  const api = useAcc8('shorter_life_e2e');
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
    return { pr, a, b, w, building: await api.building(pr, [w]) };
  }
  const entry = (w: string, valuationDate: string, extra: Record<string, unknown> = {}) => ({
    acquisitionId: w,
    usefulLifeYears: 30,
    evidence: { source: 'Gutachten zur Restnutzungsdauer (synthetisch)', date: '2026-08-10', valuationDate, documentReference: null },
    reviewState: 'CONFIRMED',
    ...extra,
  });
  const amend = (assetId: string, e: Record<string, unknown>) => post(`/depreciation-assets/${assetId}/amend`, { shorterUsefulLives: [e] }, 200);
  const owners = (s: Json) => s.years.map((y: Json) => [y.year, y.status, y.amount?.amount ?? null, y.owners.map((o: Json) => o.amount?.amount ?? null)]);
  /** Every row of the cash, the splits, the classifications, the purchases and the Ownerships, with its version. */
  const moneyRows = async () => {
    const out: Record<string, unknown> = {};
    for (const table of [
      'ledger_transaction',
      'transaction_split',
      'tax_classification',
      'acquisition',
      'acquisition_cost',
      'land_building_allocation',
      'ownership',
    ]) {
      out[table] = (await api.ctx.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    }
    return JSON.stringify(out);
  };

  it(
    'a Stichtag in the first year, moved after it (band before, nothing from it), released; history kept; no money mutated',
    { timeout: 120_000 },
    async () => {
      const { pr, a, w, building } = await acc8(0);
      at('2029-02-15');
      const band = owners(await schedule(building, 'from=2026&to=2029'));
      const bandView2027 = totalOf(await view(pr, 2027), 'AFA_BUILDING');
      const before = await moneyRows();

      // A Stichtag in the first year: 1/30 from 2026-07, as before VC-X-41.
      const fromStart = await amend(building, entry(w, '2026-06-15'));
      expect(fromStart.shorterUsefulLives[0].evidence).toEqual({
        source: 'Gutachten zur Restnutzungsdauer (synthetisch)',
        date: '2026-08-10',
        valuationDate: '2026-06-15',
        documentReference: null,
      });
      const s1 = await schedule(building, 'from=2026&to=2027');
      expect(owners(s1)[0]).toEqual([2026, 'AVAILABLE', '4240.00', ['2544.00', '1696.00']]);
      const shorterFlag = s1.components[0].flags.find((f: Json) => f.code === 'SHORTER_USEFUL_LIFE');
      expect([shorterFlag?.details.method, shorterFlag?.details.lastMonth]).toEqual(['FROM_START', '2056-06']);

      // The Stichtag moved after the first year (only CONFIRMED): the band's years exactly as without an entry, nothing
      // from 2028 (never 0.00), the release shown missing beside the Part 1 reason.
      await amend(building, entry(w, '2028-03-01'));
      const s2 = await schedule(building, 'from=2026&to=2029');
      expect(owners(s2).slice(0, 2)).toEqual(band.slice(0, 2));
      expect(owners(s2).slice(2)).toEqual([
        [2028, 'DEPRECIATION_NOT_AVAILABLE', null, [null, null]],
        [2029, 'DEPRECIATION_NOT_AVAILABLE', null, [null, null]],
      ]);
      const reasons2028 = s2.components[0].years.find((y: Json) => y.year === 2028).owners[0].reasons;
      expect(reasons2028.map((r: Json) => [r.code, r.details.missing ?? null])).toEqual([
        ['SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED', null],
        ['SHORTER_USEFUL_LIFE_RELEASE_MISSING', ['ADVISOR_CONFIRMED', 'EVIDENCE', 'RELEASE_NOTE']],
      ]);
      // The tax-year view: 2027 unchanged against the band (the schedule is unaffected there), 2028 not available.
      expect(totalOf(await view(pr, 2027), 'AFA_BUILDING')).toBe(bandView2027);
      expect(totalOf(await view(pr, 2027, a), 'AFA_BUILDING')).toBe('3052.80');
      const v2028 = await view(pr, 2028);
      expect([v2028.depreciation.status, v2028.depreciation.gaps.map((g: Json) => [g.code, g.details.reasons])]).toEqual([
        'DEPRECIATION_NOT_AVAILABLE',
        [['SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED', ['SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED', 'SHORTER_USEFUL_LIFE_RELEASE_MISSING']]],
      ]);

      // Released by the advisor with evidence and a release note: the release is no longer missing; Part 1 still computes nothing from 2028.
      const advisor = await api.party('Steuerberatung S');
      const released = await amend(
        building,
        entry(w, '2028-03-01', {
          reviewState: 'ADVISOR_CONFIRMED',
          advisorPartyId: advisor,
          releaseNote: 'Restwertmethode freigegeben, Steuerberatung, 2029-02-01 (synthetisch)',
          evidence: {
            source: 'Gutachten zur Restnutzungsdauer (synthetisch)',
            date: '2026-08-10',
            valuationDate: '2028-03-01',
            documentReference: 'Gutachten Nr. 0000-SYN',
          },
        }),
      );
      expect(released.shorterUsefulLives[0]).toMatchObject({ reviewState: 'ADVISOR_CONFIRMED', releaseNote: expect.stringContaining('Restwertmethode') });
      const s3 = await schedule(building, 'from=2028&to=2028');
      expect(codes(s3.components[0].years[0].owners[0].reasons)).toEqual(['SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED']);
      expect(s3.review.open.map((r: Json) => r.code)).not.toContain('SHORTER_USEFUL_LIFE_RELEASE_MISSING');

      // History: one AuditRecord per amend, each with the entry's old and new values; nothing overwritten.
      const records = (await api.ctx.pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [building]))
        .rows as { action: string; metadata: Json }[];
      expect(records.map((r) => r.action)).toEqual(['CREATED', 'AMENDED', 'AMENDED', 'AMENDED']);
      expect(
        records
          .slice(1)
          .map((r) => [r.metadata.changedEntries[0].from?.evidence.valuationDate ?? null, r.metadata.changedEntries[0].to.evidence.valuationDate]),
      ).toEqual([
        [null, '2026-06-15'],
        ['2026-06-15', '2028-03-01'],
        ['2028-03-01', '2028-03-01'],
      ]);
      expect(records[3]?.metadata.changedEntries[0]).toMatchObject({
        from: { reviewState: 'CONFIRMED', releaseNote: null },
        to: { reviewState: 'ADVISOR_CONFIRMED', releaseNote: expect.stringContaining('Restwertmethode') },
      });
      // No cash, split, classification, purchase or Ownership row changed by any of it.
      expect(await moneyRows()).toBe(before);
    },
  );

  it(
    'an entry without a Stichtag (as stored before 0056): not computable in every year, its document date never read as one; amended, it computes',
    { timeout: 60_000 },
    async () => {
      const { w, building } = await acc8(1);
      at('2027-03-01');
      await amend(building, entry(w, '2026-06-15'));
      // The row as 0056 leaves an entry stored before it (the guard stops every write without a Stichtag, so the fixture lifts it).
      await api.ctx.pool.query(`ALTER TABLE depreciation_asset_useful_life DISABLE TRIGGER depreciation_asset_useful_life_valuation_date`);
      await api.ctx.pool.query(`UPDATE depreciation_asset_useful_life SET valuation_date = NULL WHERE asset_id = $1`, [building]);
      await api.ctx.pool.query(`ALTER TABLE depreciation_asset_useful_life ENABLE TRIGGER depreciation_asset_useful_life_valuation_date`);
      const read = await get(`/depreciation-assets/${building}`);
      expect(read.shorterUsefulLives[0].evidence).toMatchObject({ date: '2026-08-10', valuationDate: null });
      const s = await schedule(building, 'from=2026&to=2027');
      expect([s.components[0].status, s.components[0].reasons]).toEqual([
        'NOT_COMPUTABLE',
        [{ code: 'USEFUL_LIFE_VALUATION_DATE_MISSING', details: { acquisitionId: w, evidenceDate: '2026-08-10' } }],
      ]);
      expect(s.years.map((y: Json) => y.amount)).toEqual([null, null]);
      // Restating the entry with its Stichtag is a change (its state reset unless named): here named, so it computes again.
      await amend(building, entry(w, '2026-06-15'));
      expect((await schedule(building, 'from=2026&to=2026')).years[0].amount.amount).toBe('4240.00');
    },
  );

  it('Realm isolation: another Realm can neither read nor amend the entry; a body without a Stichtag is 400 REQUIRED', async () => {
    const { w, building } = await acc8(2);
    await amend(building, entry(w, '2026-06-15'));
    expect((await call('GET', `/depreciation-assets/${building}`, undefined, { realm: REALM_B })).status).toBe(404);
    expect((await call('POST', `/depreciation-assets/${building}/amend`, { shorterUsefulLives: [entry(w, '2030-01-01')] }, { realm: REALM_B })).status).toBe(
      404,
    );
    expect((await get(`/depreciation-assets/${building}`)).shorterUsefulLives[0].evidence.valuationDate).toBe('2026-06-15');
    const { valuationDate: _v, ...withoutStichtag } = entry(w, 'x').evidence;
    const res = await call('POST', `/depreciation-assets/${building}/amend`, { shorterUsefulLives: [{ ...entry(w, 'x'), evidence: withoutStichtag }] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('shorterUsefulLives.0.evidence.valuationDate');
  });
});
