import { describe, expect, it } from 'vitest';
import { checkStoredRuleReferences, createDatabase } from './infrastructure/postgres/index.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import { routesOf } from './phase-2-acceptance.test-support.js';
import {
  PHASE_8,
  PROPERTIES,
  REALM_A,
  REALM_B,
  cents,
  codes,
  databaseUrl,
  eur,
  expectAfaTraceable,
  expectOwnersAddUp,
  lineOf,
  totalOf,
  useAcc8,
  type Json,
} from './phase-8-acceptance.test-support.js';

/**
 * VC-8-06: the Phase-8 exit of `docs/roadmap.md` as one acceptance run through the HTTP API (ACC8, invariant-suite.md
 * §51; phase-8-plan §2 "ACC8"), wired as in main.ts with the fake MRE, against PostgreSQL: a WEG unit bought mid-year by
 * two buyers (A 3/5, B 2/5); its building as a DepreciationAsset; the schedule of the purchase; six months of rent and
 * Hausgeld; the anschaffungsnahe check crossing 15 % and both sources capitalised by the user; an Einbauküche as a
 * separate asset; a capitalised item on 2027-12-30 with odd cents; an extension of 2030; recorded schedule versions
 * (the record command built with the recording switch on, as §60 prescribes for tests) and the shipped default (off)
 * keeping every year with AfA from being final; the tax-year view of 2026–2031 at both levels; interest via a Loan keeping a year open. Then the variants (the
 * year boundary, no confirmed allocation, a second Acquisition not confirmed, B selling to C) and Realm isolation on
 * every Phase-8 route. The figures are invented and hand-computed in §51; they are checked literally. Every date is
 * set explicitly through the clock: no figure asserted here depends on today's date.
 */
describe.skipIf(databaseUrl === undefined)('Phase 8 acceptance (roadmap exit)', () => {
  const api = useAcc8('phase_8_e2e');
  const { at, post, get, call, json, view, schedule, record, classify, booked } = api;
  const ACC8_COSTS = [
    ['REAL_ESTATE_TRANSFER_TAX', '15000.00'],
    ['NOTARY', '2000.00'],
    ['LAND_REGISTRY', '1000.00'],
    ['FINANCING_RELATED', '1200.00'],
  ] as const;
  const ACC8_ALLOCATION = { total: '318000.00', land: '63600.00', building: '254400.00' };
  /** A Phase-8 command never touches cash: every row and version of the cash tables is the same after it. */
  const phase8 = async <T>(command: () => Promise<T>): Promise<T> => {
    const before = await api.cashRows();
    const result = await command();
    expect(await api.cashRows()).toEqual(before);
    return result;
  };
  /** Two buyers of a unit through the API, A `3/5` and B `2/5` (A the lower id, so A comes first in every list). */
  async function buyers(names: readonly string[] = ['Käuferin A', 'Käufer B']) {
    const ids: string[] = [];
    for (const name of names) ids.push(await api.party(name));
    return ids.sort() as [string, string];
  }
  /** ACC8's purchase on one of Realm A's MRE properties: W, its costs, the allocation, the Ownerships, confirmed; the building. */
  async function acc8Unit(property: number, transfer: string, reviewState: 'CONFIRMED' | 'UNREVIEWED' = 'CONFIRMED', withMethod = true) {
    at('2026-07-01');
    const pr = await api.link(PROPERTIES[property] as string);
    const [a, b] = await buyers();
    const { acquisitionId: w, allocationId } = await api.purchase({
      pr,
      buyers: [a, b],
      share: '1/1',
      price: '300000.00',
      contract: '2026-05-20',
      transfer,
      costs: ACC8_COSTS,
      allocation: { ...ACC8_ALLOCATION, reviewState },
    });
    const ownerships = [await api.own(pr, a, '3/5', transfer, w), await api.own(pr, b, '2/5', transfer, w)];
    await api.confirm(w);
    // §59C: W's confirmed STANDARD method entry with the building (ACC8's main run records it one step later).
    const building = await phase8(() => api.building(pr, withMethod ? [w] : []));
    return { pr, a, b, w, allocationId, ownerships, building };
  }
  const years = (s: Json) => s.years.map((y: Json) => [y.year, y.amount?.amount ?? null, ...(y.owners ?? []).map((o: Json) => o.amount?.amount ?? null)]);
  const ownerFigures = (v: Json) =>
    v.owners.map((o: Json) => [o.einnahmen.total.amount, o.werbungskosten.total.amount, totalOf(o, 'AFA_BUILDING'), o.result.amount.amount]);
  const recordingOf = (v: Json) => v.depreciation.assets.map((x: Json) => x.recording.state);

  it('the Phase-8 exit, claim by claim (ACC8)', { timeout: 300_000 }, async () => {
    const { pr, a, b, w, building } = await acc8Unit(0, '2026-07-01', 'CONFIRMED', false);
    const weg = await post('/wegs', { displayName: 'WEG Beispielallee (synthetisch)' });
    const membership = (await post(`/wegs/${weg.wegId}/memberships`, { propertyReferenceId: pr, miteigentumsanteil: '125/1000', validFrom: '2026-07-01' }))
      .membershipId;
    const account = await api.account();
    const on = (amount: string, financialCategoryCode: string) => ({ amount: eur(amount), financialCategoryCode, propertyReferenceId: pr });
    // July to December 2026: rent 1,100.00 and advances 250.00 on the 15th, Hausgeld 210.00 on the 5th, classified by the user.
    at('2027-01-10');
    for (let month = 7; month <= 12; month++) {
      const mm = String(month).padStart(2, '0');
      const [rent, advance] = await booked(account, 'INFLOW', `2026-${mm}-15`, [on('1100.00', 'RENT_BASE'), on('250.00', 'RENT_OPERATING_COST_ADVANCE')]);
      const [hausgeld] = await booked(account, 'OUTFLOW', `2026-${mm}-05`, [on('210.00', 'WEG_NON_RECOVERABLE')]);
      await classify({ sourceId: rent, taxCategory: 'RENT', treatment: 'INCOME' });
      await classify({ sourceId: advance, taxCategory: 'OPERATING_COST_ADVANCES', treatment: 'INCOME' });
      await classify({ sourceId: hausgeld, taxCategory: 'WEG_HAUSGELD', treatment: 'DEDUCTIBLE' });
    }

    // Claim 1, the schedule of the purchase from acquisition truth: basis 254,400.00 = 318,000.00 × 254,400/318,000 (the
    // land and the FINANCING_RELATED 1,200.00 in no component), 2 % for 1995, 6/12 in 2026, per Acquisition among its buyers.
    at('2027-02-15');
    // §59C (decided by the owner on 2026-11-01, open question 6): before W's method entry the year is not available,
    // never assumed linear: DEPRECIATION_METHOD_NOT_CONFIRMED, the amounts null; the entry is then recorded and confirmed.
    const unknown = await phase8(() => schedule(building, 'from=2026&to=2026'));
    expect([unknown.years[0].status, unknown.years[0].amount, codes(unknown.components[0].reasons)]).toEqual([
      'DEPRECIATION_NOT_AVAILABLE',
      null,
      ['DEPRECIATION_METHOD_NOT_CONFIRMED'],
    ]);
    await phase8(() => api.methods(building, [w]));
    const first = await phase8(() => schedule(building, 'from=2026&to=2027'));
    expect(
      first.components.map((c: Json) => [
        c.componentId,
        c.kind,
        c.basis.amount.amount,
        c.basis.purchasePrice.amount,
        c.basis.acquisitionCosts.amount,
        c.basis.excludedCosts,
        c.basis.totalAllocableAmount.amount,
        c.rate.rate,
        c.start.month,
        c.start.firstYearMonths,
        c.owners.map((o: Json) => [o.ownerPartyId, o.weight, o.basis.amount]),
      ]),
    ).toEqual([
      [
        `ACQUISITION:${w}`,
        'ACQUISITION',
        '254400.00',
        '300000.00',
        '18000.00',
        [{ category: 'FINANCING_RELATED', amount: eur('1200.00') }],
        '318000.00',
        '1/50',
        '2026-07',
        6,
        [
          [a, '3/5', '152640.00'],
          [b, '2/5', '101760.00'],
        ],
      ],
    ]);
    expect(years(first)).toEqual([
      [2026, '2544.00', '1526.40', '1017.60'],
      [2027, '5088.00', '3052.80', '2035.20'],
    ]);
    // Counter-check "land in the basis": the basis is the anschaffungsnahe check's, never the 318,000.00 allocable.
    expect((await api.check(w)).basis.basisAmount).toEqual(eur('254400.00'));
    // The shipped default reads the same schedule; it only reports that recording is off.
    const offSchedule = await schedule(building, 'from=2026&to=2027', 'off');
    expect([offSchedule.recordingEnabled, first.recordingEnabled, years(offSchedule)]).toEqual([false, true, years(first)]);

    // Claim 2, feeding the tax-year view: 2026 after AfA, the result lower by exactly the AfA (8,100.00 − 1,260.00 = 6,840.00
    // before it; − 2,544.00 = 4,296.00), the owners' AfA the schedule's parts. The same view behind the shipped default.
    const v2026 = await view(pr, 2026);
    expect(await view(pr, 2026, undefined, 'off')).toEqual(v2026);
    expect([v2026.einnahmen.total.amount, v2026.werbungskosten.total.amount, totalOf(v2026, 'WEG_HAUSGELD'), totalOf(v2026, 'AFA_BUILDING')]).toEqual([
      '8100.00',
      '3804.00',
      '1260.00',
      '2544.00',
    ]);
    expect(v2026.result).toEqual({ amount: eur('4296.00'), kind: 'SURPLUS', basis: 'AFTER_DEPRECIATION' });
    expect(cents(v2026.einnahmen.total)! - (cents(v2026.werbungskosten.total)! - cents(lineOf(v2026, 'AFA_BUILDING').total)!)).toBe(684000n);
    expect(ownerFigures(v2026)).toEqual([
      ['4860.00', '2282.40', '1526.40', '2577.60'],
      ['3240.00', '1521.60', '1017.60', '1718.40'],
    ]);
    // The shipped default (recording off): the record command refuses before any data access, nothing is written, and
    // no year with AfA can be final (DEPRECIATION_SCHEDULE_NOT_RECORDED stays open).
    const refused = await call('POST', `/depreciation-assets/${building}/schedule-versions`, await api.recordBody(building, 2026), {
      base: 'off',
      headers: { 'idempotency-key': 'acc8-off' },
    });
    expect([refused.status, ((await refused.json()) as Json).error.details.reason]).toEqual([409, 'RECORDING_NOT_ENABLED']);
    expect((await get(`/depreciation-assets/${building}/schedule-versions`, { base: 'off' })).items).toEqual([]);
    expect([v2026.review.final, codes(v2026.flags)]).toEqual([false, ['DEPRECIATION_SCHEDULE_NOT_RECORDED', 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL']]);
    // The recording flag itself is open (not only some other flag): final would stay false without the 15 % check too.
    expect(v2026.review.open.map((o: Json) => o.code)).toContain('DEPRECIATION_SCHEDULE_NOT_RECORDED');

    // Claim 3, stored as derivation: version 1 through 2026, recorded through the use case built with the switch on.
    const v1 = await phase8(() => record(building, 2026));
    expect(years(v1)).toEqual([[2026, '2544.00', '1526.40', '1017.60']]);
    const recorded2026 = await view(pr, 2026);
    expect([recordingOf(recorded2026), recorded2026.review.open, recorded2026.review.final]).toEqual([
      ['UNCHANGED'],
      [{ code: 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL', count: 1 }],
      false,
    ]);

    // 2027: the repair (35,700.00 gross, 30,000.00 net) DEDUCTIBLE: the check's sum 30,000.00 of a threshold of 38,160.00.
    at('2027-03-15');
    const [repair] = await booked(account, 'OUTFLOW', '2027-03-10', [on('35700.00', 'MAINTENANCE')]);
    const repairDeductible = await classify({ sourceId: repair, taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', netAmount: eur('30000.00') });
    // The Einbauküche (6,000.00 on 2027-04-28) capitalised and recorded as a separate asset over 10 years (P8-D7, B8): its
    // own rule from the month of acquisition, 9/12 × 600.00 = 450.00 in 2027 (A 270.00, B 180.00), and not in the building.
    at('2027-05-05');
    const [kitchenSplit] = await booked(account, 'OUTFLOW', '2027-04-28', [on('6000.00', 'MAINTENANCE')]);
    await classify({ sourceId: kitchenSplit, taxCategory: 'OTHER_EXPENSE', treatment: 'CAPITALIZED' });
    const kitchen = await phase8(async () => {
      const created = await post(
        '/depreciation-assets',
        {
          propertyReferenceId: pr,
          assetType: 'SEPARATE_ASSET',
          description: 'Einbauküche (synthetisch)',
          usefulLifeYears: 10,
          usefulLifeBasis: 'BFH IX R 14/15: Einbauküche als einheitliches Wirtschaftsgut, 10 Jahre (verification-checklist B8)',
          acquiredOn: '2027-04-20',
          items: [{ sourceType: 'TRANSACTION_SPLIT', sourceId: kitchenSplit, sourcePosition: null }],
        },
        201,
        { headers: { 'idempotency-key': 'acc8-kitchen' } },
      );
      await post(`/depreciation-assets/${created.assetId}/confirm`, { reviewState: 'CONFIRMED' }, 200, { headers: { 'if-match': '"1"' } });
      return created.assetId as string;
    });
    const kitchenSchedule = await schedule(kitchen, 'from=2027&to=2028');
    expect([kitchenSchedule.components[0].rate.rate, kitchenSchedule.components[0].start.month, years(kitchenSchedule)]).toEqual([
      '1/10',
      '2027-04',
      [
        [2027, '450.00', '270.00', '180.00'],
        [2028, '600.00', '360.00', '240.00'],
      ],
    ]);
    expect((await schedule(building, 'from=2027&to=2027')).excludedItems).toEqual([
      { componentId: `TRANSACTION_SPLIT:${kitchenSplit}`, separateAssetId: kitchen },
    ]);
    // A capitalised item booked on 2027-12-30 counts by its date (P8-D6): from January 2027 (START_OF_YEAR, provisional),
    // 1,234.56 split 740.74 / 493.82 (largest remainder), 2 % rounded cumulatively per part: 14.81 + 9.88 = 24.69.
    at('2028-01-10');
    const [odd] = await booked(account, 'OUTFLOW', '2027-12-30', [on('1234.56', 'MAINTENANCE')]);
    await classify({ sourceId: odd, taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED' });
    const notAbove = await api.check(w);
    expect([notAbove.status, notAbove.threshold.amount, notAbove.sum.amount, notAbove.sources.map((s: Json) => s.sourceId)]).toEqual([
      'NOT_ABOVE_THRESHOLD',
      '38160.00',
      '30000.00',
      [repair],
    ]);
    at('2028-01-20');
    const v2 = await phase8(() => record(building, 2027));
    expect(years(v2)).toEqual([
      [2026, '2544.00', '1526.40', '1017.60'],
      [2027, '5112.69', '3067.61', '2045.08'],
    ]);

    // The Sonderumlage use of 9,000.00 on 2028-02-15, DEDUCTIBLE: 39,000.00 > 38,160.00, ABOVE_THRESHOLD for 2027 and 2028.
    at('2028-03-01');
    const assessment = (
      await post(`/weg-memberships/${membership}/special-assessments`, {
        description: 'Fassadensanierung (synthetisch)',
        resolutionDate: '2028-01-10',
        purpose: 'MAINTENANCE',
        unitShare: eur('9000.00'),
        instalments: [{ position: 1, dueDate: '2028-02-01', amount: eur('9000.00') }],
      })
    ).assessmentId;
    await json(
      await call('PUT', `/weg-special-assessments/${assessment}/uses`, {
        uses: [{ position: 1, date: '2028-02-15', description: 'Fassade', unitShare: eur('9000.00') }],
      }),
    );
    const useSource = { sourceType: 'WEG_ASSESSMENT_USE', sourceId: assessment, sourcePosition: 1, taxCategory: 'WEG_SPENDING' };
    const useDeductible = await classify({ ...useSource, treatment: 'DEDUCTIBLE', netAmount: eur('9000.00') });
    const above = await api.check(w);
    expect([above.status, above.sum.amount, above.affectedYears, above.sources.map((s: Json) => [s.sourceId, s.suggestedTreatment])]).toEqual([
      'ABOVE_THRESHOLD',
      '39000.00',
      [2027, 2028],
      [
        [repair, 'CAPITALIZED'],
        [assessment, 'CAPITALIZED'],
      ],
    ]);
    // Counter-check "a suggestion moving money": before the user acts the AfA is unchanged, both sources stay in the
    // Werbungskosten with the open flag, and neither year is final.
    expect(years(await schedule(building, 'from=2027&to=2028'))).toEqual([
      [2027, '5112.69', '3067.61', '2045.08'],
      [2028, '5112.69', '3067.62', '2045.07'],
    ]);
    const [suggested2027, suggested2028] = [await view(pr, 2027), await view(pr, 2028)];
    expect([totalOf(suggested2027, 'MAINTENANCE'), totalOf(suggested2027, 'AFA_BUILDING'), totalOf(suggested2028, 'WEG_SPENDING')]).toEqual([
      '35700.00',
      '5112.69',
      '9000.00',
    ]);
    expect(codes(lineOf(suggested2027, 'MAINTENANCE').items[0].flags)).toContain('ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN');
    for (const v of [suggested2027, suggested2028])
      expect([v.review.final, codes(v.flags)]).toEqual([false, expect.arrayContaining(['ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL'])]);

    // Both capitalised on the check by the user: the repair leaves MAINTENANCE, the use leaves WEG_SPENDING; the basis
    // gains 35,700.00 (gross) and 9,000.00; the AfA 714.00 from 2027 and 180.00 from 2028 (START_OF_YEAR, provisional).
    await classify({
      sourceId: repair,
      taxCategory: 'MAINTENANCE',
      treatment: 'CAPITALIZED',
      netAmount: eur('30000.00'),
      anschaffungsnaheAcquisitionId: w,
      supersedes: repairDeductible,
    });
    await classify({ ...useSource, treatment: 'CAPITALIZED', netAmount: eur('9000.00'), anschaffungsnaheAcquisitionId: w, supersedes: useDeductible });
    const capitalised = await phase8(() => schedule(building, 'from=2027&to=2028'));
    // Components of one start month are ordered by their id (§59A "Order"): compared by id.
    const byComponent = (sched: Json) =>
      Object.fromEntries(
        sched.components.map((c: Json) => [
          c.componentId,
          [c.basis.amount.amount, c.start.month, c.years.map((y: Json) => [y.year, y.amount?.amount ?? null])],
        ]),
      );
    expect(byComponent(capitalised)).toEqual({
      [`ACQUISITION:${w}`]: [
        '254400.00',
        '2026-07',
        [
          [2027, '5088.00'],
          [2028, '5088.00'],
        ],
      ],
      [`TRANSACTION_SPLIT:${repair}`]: [
        '35700.00',
        '2027-01',
        [
          [2027, '714.00'],
          [2028, '714.00'],
        ],
      ],
      [`TRANSACTION_SPLIT:${odd}`]: [
        '1234.56',
        '2027-01',
        [
          [2027, '24.69'],
          [2028, '24.69'],
        ],
      ],
      [`WEG_ASSESSMENT_USE:${assessment}:1`]: ['9000.00', '2028-01', [[2028, '180.00']]],
    });
    // 2027: 5,088.00 + 714.00 + 24.69 = 5,826.69 (A 3,052.80 + 428.40 + 14.81, B 2,035.20 + 285.60 + 9.88);
    // 2028: + 180.00 = 6,006.69 (A + 108.00 and 14.82 by the cumulative rounding, B + 72.00 and 9.87).
    expect(years(capitalised)).toEqual([
      [2027, '5826.69', '3496.01', '2330.68'],
      [2028, '6006.69', '3604.02', '2402.67'],
    ]);
    const [c2027, c2028] = [await view(pr, 2027), await view(pr, 2028)];
    // 2027: no income booked; Werbungskosten 5,826.69 + 450.00 = 6,276.69; capitalised 35,700.00 + 6,000.00 + 1,234.56.
    expect([
      totalOf(c2027, 'MAINTENANCE'),
      totalOf(c2027, 'AFA_BUILDING'),
      totalOf(c2027, 'AFA_SEPARATE_ASSETS'),
      c2027.capitalized.total.amount,
      c2027.result,
    ]).toEqual(['0.00', '5826.69', '450.00', '42934.56', { amount: eur('-6276.69'), kind: 'LOSS', basis: 'AFTER_DEPRECIATION' }]);
    expect([totalOf(c2028, 'WEG_SPENDING'), totalOf(c2028, 'AFA_BUILDING'), totalOf(c2028, 'AFA_SEPARATE_ASSETS'), c2028.capitalized.total.amount]).toEqual([
      '0.00',
      '6006.69',
      '600.00',
      '9000.00',
    ]);
    // The recorded version of 2027 now differs, naming the repair; the line shows the derived figure.
    expect(c2027.flags.find((f: Json) => f.code === 'DEPRECIATION_CHANGED_SINCE_RECORDED').details).toMatchObject({
      versionId: v2.versionId,
      year: 2027,
      recorded: eur('5112.69'),
      derived: eur('5826.69'),
      components: [{ componentId: `TRANSACTION_SPLIT:${repair}`, change: 'ADDED', recorded: null, derived: eur('714.00') }],
    });
    // The changed recorded year is held open by the recording flag itself, not only by other flags.
    expect(c2027.review.open.map((o: Json) => o.code)).toContain('DEPRECIATION_CHANGED_SINCE_RECORDED');
    expect(recordingOf(await view(pr, 2026))).toEqual(['UNCHANGED']);

    // After the window (2029-07-01) and its 90-day strip: version 3 through 2028, naming the changed 2027. 2026 is final
    // for the first time; 2027 and 2028 stay open by SUBSEQUENT_COST_START_TO_VERIFY alone (the VERIFY proposal).
    at('2029-10-15');
    expect((await api.check(w)).final).toBe(true);
    const refusedChange = await call('POST', `/depreciation-assets/${building}/schedule-versions`, await api.recordBody(building, 2028), {
      headers: { 'idempotency-key': 'acc8-unnamed' },
    });
    const unnamed = ((await refusedChange.json()) as Json).error.details;
    expect([refusedChange.status, unnamed.reason, unnamed.changedYears]).toEqual([
      409,
      'RECORDED_YEARS_WOULD_CHANGE',
      [{ year: 2027, recorded: eur('5112.69'), derived: eur('5826.69'), causes: ['INPUTS'] }],
    ]);
    const v3 = await phase8(() => record(building, 2028, [2027]));
    expect(years(await phase8(() => record(kitchen, 2028)))).toEqual(years(kitchenSchedule));
    expect(years(v3)).toEqual([
      [2026, '2544.00', '1526.40', '1017.60'],
      [2027, '5826.69', '3496.01', '2330.68'],
      [2028, '6006.69', '3604.02', '2402.67'],
    ]);
    const final2026 = await view(pr, 2026);
    expect([final2026.result, final2026.flags, final2026.review.open, final2026.review.final, recordingOf(final2026)]).toEqual([
      { amount: eur('4296.00'), kind: 'SURPLUS', basis: 'AFTER_DEPRECIATION' },
      [],
      [],
      true,
      ['UNCHANGED'],
    ]);
    for (const owner of [a, b]) expect((await view(pr, 2026, owner)).review.final).toBe(true);
    for (const [year, count] of [
      [2027, 2],
      [2028, 3],
    ] as const) {
      const later = await view(pr, year);
      expect([year, recordingOf(later), later.review.open, later.review.final]).toEqual([
        year,
        ['UNCHANGED', 'UNCHANGED'],
        [{ code: 'SUBSEQUENT_COST_START_TO_VERIFY', count }],
        false,
      ]);
    }
    // Reproducible from its stored inputs alone, read back through the shipped default: the schedule's figures to the cent.
    const read = await get(`/depreciation-assets/${building}/schedule-versions/${v3.versionId}`, { base: 'off' });
    expect([read.reproduction, read.comparison.years.map((y: Json) => y.state)]).toEqual([
      { reproducible: true, causes: [], years: [] },
      ['UNCHANGED', 'UNCHANGED', 'UNCHANGED'],
    ]);
    expect(years(read)).toEqual(years(await schedule(building, 'from=2026&to=2028')));
    expect((await get(`/depreciation-assets/${building}/schedule-versions`)).items.map((v: Json) => [v.versionNumber, v.status])).toEqual([
      [3, 'CURRENT'],
      [2, 'SUPERSEDED'],
      [1, 'SUPERSEDED'],
    ]);
    // Counter-check "a recorded version changed": a direct UPDATE or DELETE of a recorded entry is refused by the schema.
    for (const statement of [
      `UPDATE depreciation_schedule_entry SET amount = amount + 1 WHERE version_id = $1`,
      `DELETE FROM depreciation_schedule_entry WHERE version_id = $1`,
    ]) {
      await expect(api.ctx.pool.query(statement, [v3.versionId])).rejects.toMatchObject({ code: '23000' });
    }

    // The extension of 2030-09-15 (12,000.00 CAPITALIZED, outside the window): 240.00 a year from 2030 at the building's
    // rate (B11), A 144.00 and B 96.00. 2030: 5,088.00 + 714.00 + 180.00 + 240.00 + 24.70 = 6,246.70; 2031: … + 24.68.
    at('2030-10-01');
    const [extension] = await booked(account, 'OUTFLOW', '2030-09-15', [on('12000.00', 'MAINTENANCE')]);
    await classify({ sourceId: extension, taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED' });
    at('2032-01-15');
    const late = await phase8(() => schedule(building, 'from=2029&to=2031'));
    expect(byComponent(late)[`TRANSACTION_SPLIT:${extension}`]).toEqual([
      '12000.00',
      '2030-01',
      [
        [2030, '240.00'],
        [2031, '240.00'],
      ],
    ]);
    expect(years(late)).toEqual([
      [2029, '6006.69', '3604.01', '2402.68'],
      [2030, '6246.70', '3748.02', '2498.68'],
      [2031, '6246.68', '3748.01', '2498.67'],
    ]);

    // Every year 2026–2031 at both levels: owners = the property for every line, the AfA lines, the result, to the cent;
    // each AfA line the sum of its components, each with basis, rate, months and rule; the line equal to the schedule's
    // year; a capitalised source in no Werbungskosten line of any year (counter-check "a source counted twice").
    const full = await schedule(building, 'from=2026&to=2031');
    const fullKitchen = await schedule(kitchen, 'from=2027&to=2031');
    const kitchenOf = (year: number, i?: number) => {
      const y = fullKitchen.years.find((k: Json) => k.year === year);
      return y === undefined ? '0.00' : (i === undefined ? y.amount : y.owners[i].amount).amount;
    };
    const capitalisedSources = [repair, odd, kitchenSplit, assessment, extension];
    for (const year of [2026, 2027, 2028, 2029, 2030, 2031]) {
      const v = await view(pr, year);
      expectOwnersAddUp(v, String(year));
      expectAfaTraceable(v, String(year));
      expect([year, totalOf(v, 'AFA_BUILDING'), totalOf(v, 'AFA_SEPARATE_ASSETS')]).toEqual([
        year,
        full.years.find((y: Json) => y.year === year).amount.amount,
        kitchenOf(year),
      ]);
      for (const [i, owner] of [a, b].entries()) {
        const own = await view(pr, year, owner);
        expectAfaTraceable(own, `${year} ${owner}`);
        expect([year, own.result, totalOf(own, 'AFA_BUILDING')]).toEqual([year, v.owners[i].result, totalOf(v.owners[i], 'AFA_BUILDING')]);
        expect([totalOf(own, 'AFA_BUILDING'), totalOf(own, 'AFA_SEPARATE_ASSETS')]).toEqual([
          full.years.find((y: Json) => y.year === year).owners[i].amount.amount,
          kitchenOf(year, i),
        ]);
        for (const source of capitalisedSources)
          expect(JSON.stringify(own.werbungskosten.lines.filter((l: Json) => l.taxCategory !== null))).not.toContain(source);
      }
      for (const source of capitalisedSources) expect(JSON.stringify(v.werbungskosten.lines.filter((l: Json) => l.taxCategory !== null))).not.toContain(source);
    }

    // Every stored rule reference resolves, with its frozen hash (the start check, §60).
    expect((await checkStoredRuleReferences(createDatabase(api.ctx.pool))).map((r) => `${r.ruleCode}@${r.version}`)).toEqual(
      expect.arrayContaining(['DE_AFA_BUILDING_LINEAR@2', 'DE_AFA_MOVABLE_LINEAR@1']),
    );

    // A year with interest booked via a Loan before the Loan's first allocation set (as in ACC7) is never final.
    const bank = await api.party('Bank Beispiel (synthetisch)');
    const loan = (await post('/loans', { lenderPartyId: bank, borrowerPartyIds: [a, b], principalOriginal: eur('180000.00'), startDate: '2026-07-01' })).loanId;
    await post(`/loans/${loan}/terms`, { validFrom: '2026-07-01', interestRate: '3.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2026-07-31' });
    await post(`/loans/${loan}/allocations`, { validFrom: '2026-10-01', basis: 'MANUAL', allocations: [{ propertyReferenceId: pr, share: '1/1' }] });
    await booked(account, 'OUTFLOW', '2026-09-20', [{ amount: eur('120.00'), financialCategoryCode: 'LOAN_INTEREST', loanId: loan }]);
    const withInterest = await view(pr, 2026);
    expect([withInterest.review.final, codes(withInterest.flags), recordingOf(withInterest), totalOf(withInterest, 'AFA_BUILDING')]).toEqual([
      false,
      ['LOAN_INTEREST_NOT_ATTRIBUTED'],
      ['UNCHANGED'],
      '2544.00',
    ]);
  });

  it('the variants: the year boundary, no confirmed allocation, a second Acquisition not confirmed, B selling to C', { timeout: 120_000 }, async () => {
    // Transfer on 2026-12-31: the month counts in full, 2026 is 1/12 = 424.00 (A 254.40, B 169.60).
    const december = await acc8Unit(1, '2026-12-31');
    at('2027-02-15');
    expect(years(await schedule(december.building, 'from=2026&to=2026'))).toEqual([[2026, '424.00', '254.40', '169.60']]);
    const d2026 = await view(december.pr, 2026);
    expect([totalOf(d2026, 'AFA_BUILDING'), lineOf(d2026, 'AFA_BUILDING').items[0].months, d2026.result.basis]).toEqual(['424.00', 1, 'AFTER_DEPRECIATION']);
    // Transfer on 2027-01-01: no AfA in 2026, 2027 is 12/12.
    const january = await acc8Unit(2, '2027-01-01');
    at('2028-02-15');
    expect(years(await schedule(january.building, 'from=2026&to=2027')).map((y: Json[]) => y.slice(0, 2))).toEqual([
      [2026, '0.00'],
      [2027, '5088.00'],
    ]);
    const j2027 = await view(january.pr, 2027);
    expect([totalOf(j2027, 'AFA_BUILDING'), lineOf(j2027, 'AFA_BUILDING').items[0].start.month]).toEqual(['5088.00', '2027-01']);

    // No confirmed allocation: DEPRECIATION_NOT_AVAILABLE, the result before AfA, nothing estimated.
    const unreviewed = await acc8Unit(3, '2026-07-01', 'UNREVIEWED');
    at('2027-02-15');
    const u2026 = await view(unreviewed.pr, 2026);
    expect([
      totalOf(u2026, 'AFA_BUILDING'),
      lineOf(u2026, 'AFA_BUILDING').itemCount,
      u2026.depreciation.status,
      u2026.depreciation.amount,
      u2026.result.basis,
    ]).toEqual(['0.00', 0, 'DEPRECIATION_NOT_AVAILABLE', null, 'BEFORE_DEPRECIATION']);
    expect(u2026.depreciation.gaps.map((g: Json) => [g.code, g.componentId])).toEqual([['ALLOCATION_NOT_CONFIRMED', `ACQUISITION:${unreviewed.w}`]]);

    // A second Acquisition of a share not confirmed: A's 3/5 (W: building 144,000.00, 2,880.00 a year) computed, B's 2/5
    // (X) named with its reason, PARTIAL_DEPRECIATION.
    at('2026-07-01');
    const partPr = await api.link(PROPERTIES[4] as string);
    const [pa, pb] = await buyers();
    const part = { pr: partPr, contract: '2026-05-20', transfer: '2026-07-01' };
    const pw = await api.purchase({
      ...part,
      buyers: [pa],
      share: '3/5',
      price: '180000.00',
      allocation: { total: '180000.00', land: '36000.00', building: '144000.00' },
    });
    const px = await api.purchase({
      ...part,
      buyers: [pb],
      share: '2/5',
      price: '120000.00',
      allocation: { total: '120000.00', land: '24000.00', building: '96000.00', reviewState: 'UNREVIEWED' },
    });
    await api.own(partPr, pa, '3/5', '2026-07-01', pw.acquisitionId);
    await api.own(partPr, pb, '2/5', '2026-07-01', px.acquisitionId);
    await api.confirm(pw.acquisitionId);
    await api.confirm(px.acquisitionId);
    await phase8(() => api.building(partPr, [pw.acquisitionId, px.acquisitionId]));
    at('2028-02-15');
    const p2027 = await view(partPr, 2027);
    expect([totalOf(p2027, 'AFA_BUILDING'), p2027.result.basis, ownerFigures(p2027).map((o: string[]) => o[2])]).toEqual([
      '2880.00',
      'PARTIAL_DEPRECIATION',
      ['2880.00', '0.00'],
    ]);
    expect(p2027.depreciation.gaps.map((g: Json) => [g.code, g.componentId, g.ownerPartyIds])).toEqual([
      ['ALLOCATION_NOT_CONFIRMED', `ACQUISITION:${px.acquisitionId}`, [pb]],
    ]);
    expectOwnersAddUp(p2027, 'partial');

    // B sells its 2/5 to C effective 2029-07-01 (§26.2): B's 2029 is 6/12 of 2,035.20 = 1,017.60, CALCULATED: the
    // disposal year as decided 2026-10-31, confirmed by the Prüfbericht 01.11.2026, Frage 4 (mündlich bestätigt durch den
    // Steuerberater, laut Projektinhaber am 2026-11-01), so DISPOSAL_YEAR_TO_VERIFY no longer appears; C's own component from C's Acquisition (building 88,000.00):
    // 1,760.00 a year, 880.00 in 2029. 2029: 3,052.80 + 1,017.60 + 880.00 = 4,950.40; 2030: 3,052.80 + 1,760.00 = 4,812.80.
    const sold = await acc8Unit(5, '2026-07-01');
    const c = await api.party('Käuferin C');
    at('2029-07-01');
    const x = await api.purchase({
      pr: sold.pr,
      buyers: [c],
      sellers: [sold.b],
      share: '2/5',
      price: '110000.00',
      contract: '2029-05-15',
      transfer: '2029-07-01',
      allocation: { total: '110000.00', land: '22000.00', building: '88000.00' },
    });
    await post(
      `/property-references/${sold.pr}/ownership-changes`,
      {
        effectiveDate: '2029-07-01',
        reason: 'Verkauf (synthetisch)',
        close: [sold.ownerships[1]],
        create: [{ ownerPartyId: c, share: '2/5' }],
        acquisitionId: x.acquisitionId,
      },
      201,
      { headers: { 'idempotency-key': 'acc8-sale' } },
    );
    await api.confirm(x.acquisitionId);
    // §59C: C's purchase gets its confirmed STANDARD entry with the others.
    await phase8(() => api.methods(sold.building, [sold.w, x.acquisitionId]));
    at('2031-02-15');
    const sale = await schedule(sold.building, 'from=2029&to=2030');
    const [ofW, ofX] = sale.components;
    const b2029 = ofW.years[0].owners.find((o: Json) => o.ownerPartyId === sold.b);
    expect([b2029.amount.amount, b2029.calculationStatus, codes(b2029.flags)]).toEqual(['1017.60', 'CALCULATED', []]);
    expect([ofX.acquisitionId, ofX.basis.amount.amount, ofX.start.month, ofX.years.map((y: Json) => y.amount.amount)]).toEqual([
      x.acquisitionId,
      '88000.00',
      '2029-07',
      ['880.00', '1760.00'],
    ]);
    expect(sale.years.map((y: Json) => y.amount.amount)).toEqual(['4950.40', '4812.80']);
    const s2029 = await view(sold.pr, 2029);
    expect(totalOf(s2029, 'AFA_BUILDING')).toBe('4950.40');
    expectOwnersAddUp(s2029, 'sale 2029');
  });

  it("Realm isolation: every Phase-8 route called by Realm B with Realm A's ids is 404, and nothing of Realm A changes", { timeout: 60_000 }, async () => {
    const unit = await acc8Unit(6, '2026-07-01');
    at('2026-12-01');
    const account = await api.account();
    const [split] = await booked(account, 'OUTFLOW', '2026-11-20', [
      { amount: eur('6000.00'), financialCategoryCode: 'MAINTENANCE', propertyReferenceId: unit.pr },
    ]);
    await classify({ sourceId: split, taxCategory: 'OTHER_EXPENSE', treatment: 'CAPITALIZED' });
    at('2027-02-15');
    const version = await record(unit.building, 2026);
    const ids: Record<string, string> = { assetId: unit.building, propertyReferenceId: unit.pr, versionId: version.versionId };
    const body = await api.recordBody(unit.building, 2026);
    type Row = { readonly body?: unknown; readonly query?: string; readonly headers?: Record<string, string> };
    const routes: Record<string, readonly Row[]> = {
      'POST /depreciation-assets': [
        { body: { propertyReferenceId: unit.pr, buildingCompletionYear: 1995 } },
        {
          body: {
            propertyReferenceId: unit.pr,
            assetType: 'SEPARATE_ASSET',
            description: 'Einbauküche (synthetisch)',
            usefulLifeYears: 10,
            usefulLifeBasis: 'B8',
            acquiredOn: '2026-11-20',
            items: [{ sourceType: 'TRANSACTION_SPLIT', sourceId: split, sourcePosition: null }],
          },
        },
      ],
      'GET /depreciation-assets/:assetId': [{}, { query: 'year=2027' }],
      'GET /property-references/:propertyReferenceId/depreciation-assets': [{}],
      'POST /depreciation-assets/:assetId/amend': [{ body: { notes: 'x' } }],
      'POST /depreciation-assets/:assetId/confirm': [{ body: { reviewState: 'CONFIRMED' } }],
      'POST /depreciation-assets/:assetId/void': [{ body: { reason: 'x' } }],
      'GET /depreciation-assets/:assetId/schedule': [{}, { query: `from=2026&to=2027&ownerPartyId=${unit.a}` }],
      'POST /depreciation-assets/:assetId/schedule-versions': [{ body, headers: { 'idempotency-key': 'realm-b' } }],
      'GET /depreciation-assets/:assetId/schedule-versions': [{}],
      'GET /depreciation-assets/:assetId/schedule-versions/:versionId': [{}],
    };
    // The table is the app's Phase-8 routes, no more and no fewer: a new route without a row turns this red.
    expect(Object.keys(routes).sort()).toEqual(
      routesOf(api.ctx.app)
        .filter((route) => PHASE_8.test(route))
        .sort(),
    );
    const before = await rowsSnapshot(api.ctx.pool);
    for (const [route, rows] of Object.entries(routes)) {
      for (const row of rows) {
        const [method = '', template = ''] = route.split(' ');
        const path = template.replace(/:(\w+)/g, (_, name: string) => ids[name] ?? `missing-${name}`) + (row.query === undefined ? '' : `?${row.query}`);
        const res = await call(method, path, row.body, { realm: REALM_B, ...(row.headers === undefined ? {} : { headers: row.headers }) });
        const answer: Json = await res.json();
        expect([route, res.status, answer.error?.code], JSON.stringify(answer)).toEqual([route, 404, 'NOT_FOUND']);
        expect(await rowsSnapshot(api.ctx.pool), route).toEqual(before);
      }
    }
    // Realm A still reads its own; Realm B's view of Realm A's unit is 404 as well.
    expect((await get(`/depreciation-assets/${unit.building}/schedule-versions`)).items.map((v: Json) => v.versionId)).toEqual([version.versionId]);
    expect((await call('GET', `/property-references/${unit.pr}/tax-years/2026`, undefined, { realm: REALM_B })).status).toBe(404);
    expect(REALM_A).not.toBe(REALM_B);
  });
});
