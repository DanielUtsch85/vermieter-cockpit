import { describe, expect, it } from 'vitest';
import { PROPERTIES, REALM_B, codes, databaseUrl, eur, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-36 end to end (api-design.md §59E "Tests the implementation must have", the example), through the HTTP API against
 * PostgreSQL on ACC8's support module (ACC8 itself unchanged): ACC8's building on P1 (A `3/5`, B `2/5` from 2026-07-01,
 * 2 %) and a second building on P2 (C `1/1`); a Loan L set `MANUAL` P1 `3/5`, P2 `2/5` (from 2026-07-01, so it also
 * covers the counter-check's interest of 2026); a construction-period record R naming L, P1 and P2. The owner's
 * counter-check on 2026 (final but for the Loan item; then held only by the component's own flags), the example of
 * 2028 literally (P1 300.00 and 270.01, P2 200.00 and 180.00, 950.01 once), the variant "R naming P1 only", the
 * refusal without a record and Realm isolation. Synthetic figures; the clock is set explicitly.
 */
describe.skipIf(databaseUrl === undefined)('capitalised Loan interest in the AfA basis (§59E) end to end', () => {
  const api = useAcc8('loan_interest_capitalized_e2e');
  const { at, post, get, call, json, view, schedule, record, classify, booked } = api;
  const notInBasis = (v: Json, splitId: string) =>
    v.capitalized.items.find((i: Json) => i.sourceId === splitId)?.flags.find((f: Json) => f.code === 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS')?.details;
  const componentOf = (s: Json, splitId: string) => s.components.find((c: Json) => c.componentId === `TRANSACTION_SPLIT:${splitId}`);
  const yearOf = (c: Json, year: number) => c.years.find((y: Json) => y.year === year);
  const cpi = (path: string, body: unknown, version: number, status = 200) =>
    post(`/construction-period-interest/${path}`, body, status, { headers: { 'if-match': `"${version}"` } });

  it('the counter-check of 2026, the example of 2028, the variant, the refusal without a record, Realm isolation', { timeout: 300_000 }, async () => {
    at('2026-07-01');
    const p1 = await api.link(PROPERTIES[0] as string);
    const [a, b] = [await api.party('Käuferin A'), await api.party('Käufer B')].sort() as [string, string];
    const w = await api.purchase({
      pr: p1,
      buyers: [a, b],
      share: '1/1',
      price: '300000.00',
      contract: '2026-05-20',
      transfer: '2026-07-01',
      costs: [
        ['REAL_ESTATE_TRANSFER_TAX', '15000.00'],
        ['NOTARY', '2000.00'],
        ['LAND_REGISTRY', '1000.00'],
      ],
      allocation: { total: '318000.00', land: '63600.00', building: '254400.00' },
    });
    await api.own(p1, a, '3/5', '2026-07-01', w.acquisitionId);
    await api.own(p1, b, '2/5', '2026-07-01', w.acquisitionId);
    await api.confirm(w.acquisitionId);
    const building1 = await api.building(p1, [w.acquisitionId]);
    const p2 = await api.link(PROPERTIES[1] as string);
    const c = await api.party('Eigentümerin C');
    const w2 = await api.purchase({
      pr: p2,
      buyers: [c],
      share: '1/1',
      price: '200000.00',
      contract: '2026-05-20',
      transfer: '2026-07-01',
      costs: [['REAL_ESTATE_TRANSFER_TAX', '10000.00']],
      allocation: { total: '210000.00', land: '42000.00', building: '168000.00' },
    });
    await api.own(p2, c, '1/1', '2026-07-01', w2.acquisitionId);
    await api.confirm(w2.acquisitionId);
    const building2 = await api.building(p2, [w2.acquisitionId]);
    const bank = await api.party('Bank Beispiel (synthetisch)');
    const loanId = (await post('/loans', { lenderPartyId: bank, borrowerPartyIds: [a, b], principalOriginal: eur('80000.00'), startDate: '2026-07-01' }))
      .loanId;
    const set = await post(`/loans/${loanId}/allocations`, {
      validFrom: '2026-07-01',
      basis: 'MANUAL',
      allocations: [
        { propertyReferenceId: p1, share: '3/5' },
        { propertyReferenceId: p2, share: '2/5' },
      ],
    });
    const created = await post(
      '/construction-period-interest',
      {
        loanId,
        propertyReferenceIds: [p1, p2],
        measure: 'Dachgeschossausbau, zwei neue Wohnungen (synthetisch)',
        herstellungFrom: '2026-08-01',
        herstellungUntil: '2028-10-31',
        useIntent: 'Vermietung der neuen Wohnungen (synthetisch)',
        advanceExpenseDeductible: false,
        buildingFundsShare: '1/1',
        earlierYearsTreatment: 'Keine Vorjahre betroffen (synthetisch)',
        sourceReferences: ['Darlehensvertrag (synthetisch)', 'Bauvertrag (synthetisch)'],
      },
      201,
      { headers: { 'idempotency-key': 'cpi-e2e' } },
    );
    const R = created.constructionPeriodInterestId as string;
    expect([created.reviewState, created.version]).toEqual(['UNREVIEWED', 1]);
    const account = await api.account();
    const interest = (amount: string) => ({ amount: eur(amount), financialCategoryCode: 'LOAN_INTEREST', loanId });

    // Classified CAPITALIZED without a record: refused (CONSTRUCTION_PERIOD_INTEREST_REQUIRED); with R: accepted.
    at('2026-10-05');
    const [i0] = await booked(account, 'OUTFLOW', '2026-09-30', [interest('100.00')]);
    const refused = await call('POST', '/tax-classifications', {
      sourceType: 'TRANSACTION_SPLIT',
      sourceId: i0,
      taxCategory: 'LOAN_INTEREST',
      treatment: 'CAPITALIZED',
      reviewState: 'USER_CONFIRMED',
      supersedes: null,
    });
    const refusal = (await json(refused, 422)).error;
    expect([refusal.code, refusal.details.reason]).toEqual(['TREATMENT_NOT_ALLOWED', 'CONSTRUCTION_PERIOD_INTEREST_REQUIRED']);
    await classify({ sourceId: i0, taxCategory: 'LOAN_INTEREST', treatment: 'CAPITALIZED', constructionPeriodInterestId: R });

    // The owner's counter-check: 2026 recorded and final but for the Loan item (R UNREVIEWED): exactly the flag, at both levels.
    at('2029-10-15');
    await record(building1, 2026);
    for (const owner of [undefined, a, b]) {
      const v = await view(p1, 2026, owner);
      expect([v.review.open, v.review.final], String(owner)).toEqual([[{ code: 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS', count: 1 }], false]);
      expect(notInBasis(v, i0 as string)).toEqual({ loanId, allocationSetId: set.allocationSetId, reason: 'RECORD_NOT_CONFIRMED' });
    }
    expect(componentOf(await schedule(building1, 'from=2026&to=2026'), i0 as string)).toBeUndefined();
    // R confirmed: the source enters P1's building with P1's part (60.00 of 100.00); the flag is gone, and 2026 is held
    // open only by the component's own flags: SUBSEQUENT_COST_START_TO_VERIFY and the recorded year changed.
    const cashBefore = await api.cashRows();
    await cpi(`${R}/confirm`, { reviewState: 'CONFIRMED' }, 1);
    expect(await api.cashRows()).toEqual(cashBefore);
    const confirmed2026 = await view(p1, 2026);
    expect(notInBasis(confirmed2026, i0 as string)).toBeUndefined();
    expect(confirmed2026.review.open.map((o: Json) => o.code).sort()).toEqual(['DEPRECIATION_CHANGED_SINCE_RECORDED', 'SUBSEQUENT_COST_START_TO_VERIFY']);
    const c0 = componentOf(await schedule(building1, 'from=2026&to=2026'), i0 as string);
    expect([c0.basis.amount, c0.start.method, c0.source.loan, c0.source.constructionPeriodInterestId]).toEqual([
      eur('60.00'),
      'START_OF_YEAR',
      { loanId, allocationSetId: set.allocationSetId, share: '3/5', propertyPart: eur('60.00') },
      R,
    ]);

    // The example of 2028 (§59E), literally.
    at('2028-07-05');
    const [s1] = await booked(account, 'OUTFLOW', '2028-03-31', [interest('500.00')]);
    const [s2] = await booked(account, 'OUTFLOW', '2028-06-30', [interest('450.01')]);
    for (const s of [s1, s2]) await classify({ sourceId: s, taxCategory: 'LOAN_INTEREST', treatment: 'CAPITALIZED', constructionPeriodInterestId: R });
    at('2029-10-15');
    const sched1 = await schedule(building1, 'from=2028&to=2028');
    const sched2 = await schedule(building2, 'from=2028&to=2028');
    const figures = (s: Json, split: string) => {
      const comp = componentOf(s, split);
      const y = yearOf(comp, 2028);
      return [comp.basis.amount.amount, y.amount.amount, ...y.owners.map((o: Json) => o.amount.amount)];
    };
    expect(figures(sched1, s1 as string)).toEqual(['300.00', '6.00', '3.60', '2.40']);
    expect(figures(sched1, s2 as string)).toEqual(['270.01', '5.40', '3.24', '2.16']);
    expect(figures(sched2, s1 as string)).toEqual(['200.00', '4.00', '4.00']);
    expect(figures(sched2, s2 as string)).toEqual(['180.00', '3.60', '3.60']);
    expect(componentOf(sched1, s1 as string).owners.map((o: Json) => [o.ownerPartyId, o.basis.amount])).toEqual([
      [a, '180.00'],
      [b, '120.00'],
    ]);
    const bases = [sched1, sched2].flatMap((s) => [s1, s2].map((x) => Number(componentOf(s, x as string).basis.amount.amount)));
    expect(bases.reduce((x, y) => x + y, 0).toFixed(2)).toBe('950.01');
    for (const [pr, part1, part2] of [
      [p1, '300.00', '270.01'],
      [p2, '200.00', '180.00'],
    ] as const) {
      const v = await view(pr, 2028);
      expect(v.capitalized.items.filter((i: Json) => i.sourceId === s1 || i.sourceId === s2).map((i: Json) => [i.lineAmount.amount, codes(i.flags)])).toEqual([
        [part1, []],
        [part2, []],
      ]);
      expect(codes(v.review.open)).not.toContain('LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS');
      expect(codes(v.review.open)).toContain('SUBSEQUENT_COST_START_TO_VERIFY');
    }

    // The variant: R naming P1 only. The amend resets the review (RECORD_NOT_CONFIRMED everywhere); confirmed again, P1's
    // items are sources and P2's are not (PROPERTY_NOT_NAMED), P2's building without them.
    await cpi(`${R}/amend`, { propertyReferenceIds: [p1] }, 2);
    expect(notInBasis(await view(p1, 2028), s1 as string)).toMatchObject({ reason: 'RECORD_NOT_CONFIRMED' });
    await cpi(`${R}/confirm`, { reviewState: 'CONFIRMED' }, 3);
    expect(notInBasis(await view(p1, 2028), s1 as string)).toBeUndefined();
    const p2After = await view(p2, 2028);
    expect([notInBasis(p2After, s1 as string), notInBasis(p2After, s2 as string)]).toEqual([
      { loanId, allocationSetId: set.allocationSetId, reason: 'PROPERTY_NOT_NAMED' },
      { loanId, allocationSetId: set.allocationSetId, reason: 'PROPERTY_NOT_NAMED' },
    ]);
    expect(componentOf(await schedule(building2, 'from=2028&to=2028'), s1 as string)).toBeUndefined();
    // Recorded through 2028 (naming the changed 2026): the stored Loan columns reproduce the figures, and the year's
    // recording is UNCHANGED and reproducible.
    const v2 = await record(building1, 2028, [2026]);
    expect(v2.components.find((x: Json) => x.componentId === `TRANSACTION_SPLIT:${s1}`)).toMatchObject({ basis: eur('300.00') });
    const recorded2028 = await view(p1, 2028);
    expect(recorded2028.depreciation.assets.map((x: Json) => [x.recording.state, x.recording.reproducible])).toEqual([['UNCHANGED', true]]);
    // The record's read names its classifications; the list filters by PropertyReference.
    const read = await get(`/construction-period-interest/${R}`);
    expect([read.version, read.propertyReferenceIds, read.classifications.length]).toEqual([4, [p1], 3]);
    expect((await get(`/construction-period-interest?propertyReferenceId=${p2}`)).items).toEqual([]);

    // Realm isolation: Realm B neither reads, lists nor changes R.
    expect((await call('GET', `/construction-period-interest/${R}`, undefined, { realm: REALM_B })).status).toBe(404);
    expect((await get('/construction-period-interest', { realm: REALM_B })).items).toEqual([]);
    expect((await call('POST', `/construction-period-interest/${R}/void`, { reason: 'x' }, { realm: REALM_B })).status).toBe(404);
  });
});
