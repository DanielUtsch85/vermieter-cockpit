import { describe, expect, it } from 'vitest';
import { PROPERTIES, REALM_B, databaseUrl, eur, lineOf, totalOf, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-44 end to end over HTTP (api-design.md §58T "Example (synthetic)"; Entscheidung des Projektinhabers, 2026-11-06):
 * P bought for 400,000.00 with 30,000.00 counted costs, A 1/1 from 2026-07-01, the building of 1995 (2 %). E1 (a
 * confirmed contract split 40,000.00 / 360,000.00) against the Arbeitshilfe 120,000.00 / 280,000.00: the `201` carries
 * the open flag, the schedule's years `PROVISIONAL`, the view 2026 counts it open; E2 (every field repeated, the reason)
 * informative, the years `CALCULATED`; the history shows E1 open still; E2′ (the same without `reviewState`) stored
 * `UNREVIEWED`, `NOT_CALCULABLE`. Question 5 on Q: `ADVISOR_CONFIRMED` closes it without a reason; the replacement adding
 * one is `CONFIRMED`. The AfA 3,870.00 / 7,740.00 throughout; the export shows the fields; Realm B 404; no cash, no
 * Acquisition, cost or Ownership row changed. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('the plausibility warning on the allocation end to end (VC-X-44)', () => {
  const api = useAcc8('land_building_plausibility_e2e');
  const { at, call, json, post, get } = api;
  const DEVIATES = 'ALLOCATION_DEVIATES_FROM_COMPARISON';
  const REASON = 'Bodenwert wegen Altlasten im Vertrag gemindert, Gutachten folgt (synthetisch)';
  const comparison = {
    method: 'BMF_TOOL',
    landValue: eur('120000.00'),
    buildingValue: eur('280000.00'),
    sourceReferences: ['BMF-Arbeitshilfe, Ausdruck 2026-08-03 (synthetisch)'],
  };
  /** E1's body: every field of §27.3 given, so a replacement can repeat them all. */
  const e1Body = (supersedes: string | null, extra: Record<string, unknown> = {}) => ({
    totalAllocableAmount: eur('400000.00'),
    landAmount: eur('40000.00'),
    buildingAmount: eur('360000.00'),
    method: 'PURCHASE_CONTRACT',
    reviewState: 'CONFIRMED',
    effectiveDate: '2026-07-01',
    advisorPartyId: null,
    sourceReferences: ['Kaufvertrag § 3 (synthetisch)'],
    notes: null,
    comparison,
    supersedes,
    ...extra,
  });
  const allocate = (acquisitionId: string, body: unknown) => post(`/acquisitions/${acquisitionId}/land-building-allocation`, body);
  const flagOf = (dto: Json) => dto.flags.map((f: Json) => [f.code, f.level, f.details.closedBy, f.details.reviewState]);
  /** A DRAFT of 400,000.00 with 30,000.00 Grunderwerbsteuer, A's Ownership from 2026-07-01, confirmed; the building. */
  async function purchase(index: number) {
    at('2026-06-01');
    const pr = await api.link(PROPERTIES[index] as string);
    const a = await api.party('Käuferin A (synthetisch)');
    const { acquisitionId } = await post('/acquisitions', {
      propertyReferenceId: pr,
      purchasePrice: eur('400000.00'),
      acquiredShare: '1/1',
      contractDate: '2026-05-15',
      economicTransferDate: '2026-07-01',
      buyerPartyIds: [a],
      sellerPartyIds: [],
    });
    await post(`/acquisitions/${acquisitionId}/costs`, { category: 'REAL_ESTATE_TRANSFER_TAX', amount: eur('30000.00') });
    await api.own(pr, a, '1/1', '2026-07-01', acquisitionId);
    await api.confirm(acquisitionId);
    const building = await api.building(pr, [acquisitionId]);
    return { pr, a, acquisitionId, building };
  }
  const component = async (building: string) => (await api.schedule(building, 'from=2026&to=2027')).components[0];
  const figures = (c: Json) => [c.basis.amount?.amount ?? null, ...c.years.map((y: Json) => [y.year, y.amount?.amount ?? null, y.calculationStatus])];
  const stable = async () => {
    const rows: Record<string, unknown> = { ...(await api.cashRows()) };
    for (const t of ['acquisition', 'acquisition_cost', 'ownership']) {
      rows[t] = (await api.ctx.pool.query(`SELECT to_jsonb(t) AS row FROM ${t} t ORDER BY to_jsonb(t)::text`)).rows.map((r) => r.row);
    }
    return rows;
  };

  it(
    'E1 open, the view not final by it; E2 with the reason informative; E2′ UNREVIEWED and not calculable; the AfA unchanged',
    { timeout: 300_000 },
    async () => {
      const p = await purchase(0);
      const before = await stable();
      at('2026-08-05');
      const e1 = await allocate(p.acquisitionId, e1Body(null));
      expect(flagOf(e1)).toEqual([[DEVIATES, 'OPEN', null, 'CONFIRMED']]);
      expect(e1.flags[0].details).toMatchObject({
        allocationLandShare: '0.1000',
        comparisonLandShare: '0.3000',
        deviation: '0.2000',
        direction: 'LAND_SHARE_LOWER',
      });
      expect(e1.comparison).toEqual({ ...comparison, landShare: '0.3000' });
      at('2027-02-01');
      const c1 = await component(p.building);
      expect(c1.flags.map((f: Json) => f.code)).toContain(DEVIATES);
      expect(figures(c1)).toEqual(['387000.00', [2026, '3870.00', 'PROVISIONAL'], [2027, '7740.00', 'PROVISIONAL']]);
      const v1 = await api.view(p.pr, 2026);
      expect(totalOf(v1, 'AFA_BUILDING')).toBe('3870.00');
      expect(v1.review.open).toContainEqual({ code: DEVIATES, count: 1 });
      expect(v1.review.final).toBe(false);
      // The flag carried on the AfA item with its details as raised (its level in review), never re-decided in Taxation.
      const carried = (v: Json) =>
        lineOf(v, 'AFA_BUILDING')
          .items[0].flags.filter((f: Json) => f.code === DEVIATES)
          .map((f: Json) => f.details.closedBy);
      expect(carried(v1)).toEqual([null]);

      // E2: every field repeated, the reason added.
      const e2 = await allocate(p.acquisitionId, e1Body(e1.allocationId, { deviationReason: REASON }));
      expect([e2.reviewState, e2.deviationReason, ...flagOf(e2)]).toEqual(['CONFIRMED', REASON, [DEVIATES, 'INFORMATIVE', 'DEVIATION_REASON', 'CONFIRMED']]);
      const c2 = await component(p.building);
      expect(figures(c2)).toEqual(['387000.00', [2026, '3870.00', 'CALCULATED'], [2027, '7740.00', 'CALCULATED']]);
      const v2 = await api.view(p.pr, 2026);
      expect(totalOf(v2, 'AFA_BUILDING')).toBe('3870.00');
      expect(v2.review.info).toContainEqual({ code: DEVIATES, count: 1 });
      expect(v2.review.open).toEqual(v1.review.open.filter((o: Json) => o.code !== DEVIATES));
      expect(carried(v2)).toEqual(['DEVIATION_REASON']);
      const history = await get(`/acquisitions/${p.acquisitionId}/land-building-allocations`);
      expect(history.items.map((i: Json) => [i.allocationId, i.flags[0].level])).toEqual([
        [e2.allocationId, 'INFORMATIVE'],
        [e1.allocationId, 'OPEN'],
      ]);

      // The export shows the fields of every allocation, additively.
      const doc = await get(`/property-references/${p.pr}/export.json`);
      const exported = doc.acquisitions[0].landBuildingAllocations;
      expect(exported.map((x: Json) => [x.allocationId, x.comparison.landShare, x.deviationReason, x.flags[0].level])).toEqual([
        [e2.allocationId, '0.3000', REASON, 'INFORMATIVE'],
        [e1.allocationId, '0.3000', null, 'OPEN'],
      ]);

      // E2′: the same replacement without reviewState: stored UNREVIEWED (§27.3), the flag informative, no figure.
      const { reviewState: _omitted, ...withoutState } = e1Body(e2.allocationId, { deviationReason: REASON });
      const e3 = await allocate(p.acquisitionId, withoutState);
      expect([e3.reviewState, ...flagOf(e3)]).toEqual(['UNREVIEWED', [DEVIATES, 'INFORMATIVE', 'DEVIATION_REASON', 'UNREVIEWED']]);
      const c3 = await component(p.building);
      expect(c3.reasons.map((r: Json) => r.code)).toContain('ALLOCATION_NOT_CONFIRMED');
      // The basis is still shown as §59A shows it for an unconfirmed split (unchanged); no year has a figure.
      expect(figures(c3)).toEqual(['387000.00', [2026, null, 'NOT_CALCULABLE'], [2027, null, 'NOT_CALCULABLE']]);
      expect(c3.flags.map((f: Json) => f.code)).toContain(DEVIATES);

      // Realm B: nothing found, nothing written.
      expect((await call('GET', `/acquisitions/${p.acquisitionId}/land-building-allocations`, undefined, { realm: REALM_B })).status).toBe(404);
      expect((await call('POST', `/acquisitions/${p.acquisitionId}/land-building-allocation`, e1Body(e3.allocationId), { realm: REALM_B })).status).toBe(404);
      expect((await get(`/acquisitions/${p.acquisitionId}/land-building-allocations`)).items).toHaveLength(3);
      // No cash, no Acquisition, cost or Ownership row or version changed by any of it.
      expect(await stable()).toEqual(before);
    },
  );

  it(
    'question 5: ADVISOR_CONFIRMED without a reason informative and CALCULATED; the replacement adding a reason falls back to CONFIRMED',
    { timeout: 300_000 },
    async () => {
      const q = await purchase(1);
      const advisor = await api.party('Steuerberaterin S (synthetisch)');
      at('2026-08-05');
      const e1 = await allocate(q.acquisitionId, e1Body(null, { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor }));
      expect(flagOf(e1)).toEqual([[DEVIATES, 'INFORMATIVE', 'ADVISOR_CONFIRMED', 'ADVISOR_CONFIRMED']]);
      at('2027-02-01');
      expect(figures(await component(q.building))).toEqual(['387000.00', [2026, '3870.00', 'CALCULATED'], [2027, '7740.00', 'CALCULATED']]);
      // A version of 2026 recorded (the test harness's switch on; productive recording stays disabled), and §58B's check.
      await api.record(q.building, 2026);
      const check = await api.check(q.acquisitionId);
      const e2 = await allocate(q.acquisitionId, e1Body(e1.allocationId, { deviationReason: REASON }));
      // The supersede is a new allocationId: the recorded 2026 shows DEPRECIATION_CHANGED_SINCE_RECORDED; the check is unchanged.
      const recorded = (await api.schedule(q.building, 'from=2026&to=2026')).years[0];
      expect(recorded.flags.map((f: Json) => f.code)).toContain('DEPRECIATION_CHANGED_SINCE_RECORDED');
      // §58B's check (question 8): the same response but the allocation it names; no plausibility code in it.
      const named = (c: Json) => ({ ...c, computedOn: null, basis: { ...c.basis, allocationId: null, allocationReviewState: null } });
      const after = await api.check(q.acquisitionId);
      expect(named(after)).toEqual(named(check));
      expect([after.basis.allocationId, after.basis.allocationReviewState]).toEqual([e2.allocationId, 'CONFIRMED']);
      expect(JSON.stringify(after)).not.toMatch(/ALLOCATION_(DEVIATES|PLAUSIBILITY)/);
      expect([e2.reviewState, e2.advisorPartyId, ...flagOf(e2)]).toEqual(['CONFIRMED', null, [DEVIATES, 'INFORMATIVE', 'DEVIATION_REASON', 'CONFIRMED']]);
      expect(figures(await component(q.building))).toEqual(['387000.00', [2026, '3870.00', 'CALCULATED'], [2027, '7740.00', 'CALCULATED']]);
      // A contract split without a comparison carries only the informative hint; the year's figure the same.
      const plain = await allocate(q.acquisitionId, e1Body(e2.allocationId, { comparison: null }));
      expect(plain.flags).toEqual([
        { code: 'ALLOCATION_PLAUSIBILITY_NOT_CHECKED', level: 'INFORMATIVE', details: { allocationId: plain.allocationId, method: 'PURCHASE_CONTRACT' } },
      ]);
      const v = await api.view(q.pr, 2026);
      expect(v.review.info).toContainEqual({ code: 'ALLOCATION_PLAUSIBILITY_NOT_CHECKED', count: 1 });
      expect(v.review.open.map((o: Json) => o.code)).not.toContain(DEVIATES);
      expect(totalOf(v, 'AFA_BUILDING')).toBe('3870.00');
      void json;
    },
  );
});
