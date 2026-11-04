import { describe, expect, it } from 'vitest';
import { createDatabase } from './infrastructure/postgres/index.js';
import { PostgresTaxClassificationRepository } from './infrastructure/postgres/tax-classification-repository.js';
import { ExactDecimal, Money } from './shared/index.js';
import { confirmedStatementsOf } from './infrastructure/postgres/weg-statements.test-support.js';
import { PROPERTIES, REALM_A, REALM_B, databaseUrl, eur, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-27 end to end over HTTP (api-design.md §58M "Examples (synthetic)"; tax review of 2026-11-01, question 16,
 * mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01; Entscheidung des Projektinhabers,
 * 2026-11-04, M1–M11): P, owned by A, member of a WEG from 2026-03-15 (MEA 50/1000); Q transferred 2026-03-15, basis
 * 198,000.00; the repair R1 (net 26,000.00, April 2027); the confirmed statements 2026–2029 with L1–L4. The base example,
 * (c), (a), (a′), (a″) and (b) through the API; the views of 2026–2029 with unchanged figures; the purchase at stage 2 in
 * (b); the refusals; history, reads writing nothing, Realm isolation. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('maintenance paid from the Hausgeld in the anschaffungsnahe check end to end (VC-X-27)', () => {
  const api = useAcc8('tax_anschaffungsnahe_hausgeld_e2e');
  const { at, call, json, post, classify, booked } = api;
  const cost = (position: number, account: string, group: 'RECOVERABLE' | 'NON_RECOVERABLE', unitShare: string) => ({
    position,
    account,
    group,
    allocationKey: 'MEA',
    allocationTotal: null,
    allocationShare: null,
    // The WEG's total (20 × the unit's share, as printed), never read by the check: the printed unitShare is (M4).
    totalAmount: Money.of(unitShare, 'EUR').multiply(ExactDecimal.of('20'), 'HALF_UP'),
    unitShare: Money.of(unitShare, 'EUR'),
    classification: null,
  });
  /** A confirmed statement (the ACC8 wiring has no statement commands: through the repository, as Phase 6 stores it). */
  const statementOf = async (membership: string, year: number, lines: ReturnType<typeof cost>[], from?: string) => {
    const [id] = await confirmedStatementsOf(
      createDatabase(api.ctx.pool),
      { mreRealmId: REALM_A, membershipId: membership, years: [year], costLines: lines, ...(from === undefined ? {} : { firstFrom: from }) },
      { actorType: 'USER', actorId: 'anna@example.com' },
      new Date(`${year + 1}-02-01T10:00:00Z`),
    );
    return id as string;
  };
  const line = (sourceId: string, sourcePosition: number, body: Record<string, unknown> = {}) => ({
    sourceType: 'WEG_STATEMENT_COST_LINE',
    sourceId,
    sourcePosition,
    taxCategory: 'MAINTENANCE',
    treatment: 'DEDUCTIBLE',
    ...body,
  });
  const notRelevant = (sourceId: string, sourcePosition: number) =>
    classify(line(sourceId, sourcePosition, { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' }));
  const ordinary = [
    cost(1, 'Hausmeister', 'RECOVERABLE', '1800.00'),
    cost(2, 'Gebäudeversicherung', 'RECOVERABLE', '420.00'),
    cost(4, 'Verwaltervergütung', 'NON_RECOVERABLE', '600.00'),
  ];
  const money = (v: Json) => [
    v.einnahmen.total,
    v.werbungskosten.total,
    v.werbungskosten.lines.map((l: Json) => [l.line, l.total, l.items?.length]),
    v.result,
    v.capitalized.total,
    v.owners,
  ];
  const reasons = (c: Json) => (c.flags.find((f: Json) => f.code === 'NOT_FINAL')?.details.reasons ?? []) as string[];
  const flag = (c: Json, code: string) => c.flags.find((f: Json) => f.code === code)?.details;
  const count = async (sql: string) => Number((await api.ctx.pool.query(sql)).rows[0].n);
  const writes = async () => [await count(`SELECT count(*) AS n FROM tax_classification`), await count(`SELECT count(*) AS n FROM audit_record`)];

  it(
    'the examples of §58M through the API: the check moves, no view figure moves; stage 2 in (b); refusals, history, Realm isolation',
    { timeout: 180_000 },
    async () => {
      at('2026-03-01');
      const pr = await api.link(PROPERTIES[0] as string);
      const owner = await api.party('Eigentümerin A (synthetisch)');
      const { acquisitionId: q } = await api.purchase({
        pr,
        buyers: [owner],
        share: '1/1',
        price: '264000.00',
        contract: '2026-02-01',
        transfer: '2026-03-15',
        allocation: { total: '264000.00', land: '66000.00', building: '198000.00' },
      });
      await api.own(pr, owner, '1/1', '2026-03-15', q);
      await api.confirm(q);
      const { wegId } = await post('/wegs', { displayName: 'WEG Musterstraße (synthetisch)' });
      const { membershipId: m } = await post(`/wegs/${wegId}/memberships`, { propertyReferenceId: pr, miteigentumsanteil: '50/1000', validFrom: '2026-03-15' });
      const account = await api.account();
      at('2027-06-01');
      const [r1] = await booked(account, 'OUTFLOW', '2027-05-10', [{ amount: eur('30940.00'), financialCategoryCode: 'MAINTENANCE', propertyReferenceId: pr }]);
      await classify({
        sourceId: r1,
        taxCategory: 'MAINTENANCE',
        treatment: 'DEDUCTIBLE',
        netAmount: eur('26000.00'),
        performance: { from: '2027-04-01', until: '2027-04-30' },
      });
      // The Hausgeld paid in each year (the view's WEG_HAUSGELD), never touched by the cost lines.
      for (const year of [2026, 2027, 2028, 2029]) {
        await booked(account, 'OUTFLOW', `${year}-06-15`, [{ amount: eur('900.00'), financialCategoryCode: 'WEG_NON_RECOVERABLE', propertyReferenceId: pr }]);
      }
      at('2030-08-01');
      const s26 = await statementOf(m, 2026, ordinary, '2026-03-15');
      const s27 = await statementOf(m, 2027, [
        ...ordinary.slice(0, 2),
        cost(3, 'Instandsetzung Fassade', 'NON_RECOVERABLE', '2000.00'),
        ordinary[2] as ReturnType<typeof cost>,
      ]);
      const s28 = await statementOf(m, 2028, ordinary);
      const s29 = await statementOf(m, 2029, [
        cost(1, 'Hausmeister', 'RECOVERABLE', '1800.00'),
        cost(2, 'Dachrinnen', 'NON_RECOVERABLE', '3000.00'),
        cost(3, 'Instandsetzung Tiefgarage', 'NON_RECOVERABLE', '2400.00'),
        cost(4, 'Verwaltervergütung', 'NON_RECOVERABLE', '600.00'),
      ]);
      const views = async () => Promise.all([2026, 2027, 2028, 2029].map(async (year) => money(await api.view(pr, year))));
      const viewsBefore = await views();
      const cashBefore = await api.cashRows();

      // The refusals (400 before the source, then 404, then 409), nothing written.
      const before = await writes();
      const fields = async (body: Record<string, unknown>) => (await json(await call('POST', '/tax-classifications', body), 400)).error.details.fields;
      expect(await fields(line(s27, 3, { treatment: 'CAPITALIZED' }))).toEqual([{ field: 'treatment', code: 'NOT_ALLOWED_WITH_TREATMENT' }]);
      expect(await fields(line(s27, 3, { taxYear: 2027 }))).toEqual([{ field: 'taxYear', code: 'NOT_ALLOWED_WITH_TREATMENT' }]);
      expect(await fields(line(s27, 3, { anschaffungsnaheAcquisitionId: q }))).toEqual([
        { field: 'anschaffungsnaheAcquisitionId', code: 'NOT_ALLOWED_WITH_TREATMENT' },
      ]);
      expect(await fields({ ...line(s27, 3), sourcePosition: undefined })).toEqual([{ field: 'sourcePosition', code: 'REQUIRED' }]);
      expect((await json(await call('POST', '/tax-classifications', { ...line(s27, 9), reviewState: 'USER_CONFIRMED' }), 404)).error.code).toBe('NOT_FOUND');
      const recoverable = await json(await call('POST', '/tax-classifications', { ...line(s27, 1), reviewState: 'USER_CONFIRMED' }), 409);
      expect(recoverable.error.details).toMatchObject({
        reason: 'SOURCE_NOT_COUNTED',
        sourceType: 'WEG_STATEMENT_COST_LINE',
        notCountedReason: 'COST_LINE_NOT_NON_RECOVERABLE',
      });
      expect(
        (await json(await call('POST', '/tax-classifications', { ...line(s27, 3), reviewState: 'USER_CONFIRMED' }, { realm: REALM_B }), 404)).error.code,
      ).toBe('NOT_FOUND');
      // A cost line is never a tax meaning: not a source type of the list.
      expect((await json(await call('GET', `/property-references/${pr}/tax-meanings?year=2027&sourceType=WEG_STATEMENT_COST_LINE`), 400)).error.code).toBe(
        'VALIDATION_ERROR',
      );
      expect(await writes()).toEqual(before);

      // (c) first: every line judged but L2, L4 undated (the base example otherwise).
      await notRelevant(s26, 4);
      await notRelevant(s28, 4);
      await notRelevant(s29, 4);
      await classify(line(s27, 3, { netAmount: eur('1680.67'), performance: { from: '2027-06-01', until: '2027-07-15' } }));
      await classify(
        line(s29, 2, {
          netAmount: eur('2521.01'),
          performance: { from: '2029-02-15', until: '2029-04-14', progress: [{ through: '2029-03-15', amount: eur('1500.00') }], progressEstimated: false },
          sourceReferences: ['Leistungsaufstellung der Verwaltung (synthetisch)'],
        }),
      );
      const l4 = await classify(line(s29, 3, { netAmount: eur('2016.81') }));
      const readsBefore = await writes();
      const c = await api.check(q);
      expect(flag(c, 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED')).toEqual({
        statementIds: [s27],
        lines: [{ statementId: s27, position: 4, account: 'Verwaltervergütung', unitShare: eur('600.00') }],
      });
      // The base example: 29,180.67 to 31,197.48, not computable; the year 2030 has no statement yet.
      expect([c.sum, c.sumUpper, c.status, c.notComputableReason]).toEqual([
        eur('29180.67'),
        eur('31197.48'),
        'NOT_COMPUTABLE',
        'PERFORMANCE_IN_WINDOW_UNKNOWN',
      ]);
      expect(c.sources.map((e: Json) => [e.sourceType, e.sourcePosition])).toEqual([
        ['TRANSACTION_SPLIT', null],
        ['WEG_STATEMENT_COST_LINE', 3],
        ['WEG_STATEMENT_COST_LINE', 2],
      ]);
      expect(c.sources[1]).toMatchObject({ grossAmount: eur('2000.00'), amountUsed: eur('1680.67') });
      expect(c.sources[2]).toMatchObject({
        date: '2029-12-31',
        statementPeriod: { from: '2029-01-01', until: '2029-12-31' },
        account: 'Dachrinnen',
        inWindow: { lower: eur('1500.00'), upper: eur('1500.00') },
      });
      expect(c.undetermined[0].flags).toContainEqual({ code: 'PERFORMANCE_DATE_MISSING', details: { date: '2029-12-31', dateSource: 'STATEMENT_PERIOD_END' } });
      expect(flag(c, 'WEG_STATEMENT_MISSING')).toEqual({ missing: [{ membershipId: m, financialYear: 2030 }] });
      expect(c.sources[0]).not.toHaveProperty('statementPeriod');
      await notRelevant(s27, 4);

      // (a) L4 performed after the window, by a supersede: NOT_ABOVE_THRESHOLD 14.74, not final on 2030-08-01 (2030 missing).
      const a = await classify(line(s29, 3, { netAmount: eur('2016.81'), performance: { from: '2029-05-02', until: '2029-05-20' }, supersedes: l4 }));
      const ca = await api.check(q);
      expect([ca.status, ca.percentOfBasis, ca.final, reasons(ca)]).toEqual(['NOT_ABOVE_THRESHOLD', '14.74', false, ['WEG_STATEMENT_MISSING']]);
      // (a′) on 2031-08-01 with the statement of 2030 confirmed and judged: final.
      at('2031-08-01');
      const s30 = await statementOf(m, 2030, ordinary);
      await notRelevant(s30, 4);
      expect(await api.check(q)).toMatchObject({ status: 'NOT_ABOVE_THRESHOLD', percentOfBasis: '14.74', final: true });
      // (a″) the statement of 2031 (confirmed in 2032) with L5 performed in the window: listed, not summed; not computable.
      at('2032-08-01');
      const s31 = await statementOf(m, 2031, [
        cost(1, 'Instandsetzung Balkone', 'NON_RECOVERABLE', '1000.00'),
        cost(2, 'Wartung', 'NON_RECOVERABLE', '300.00'),
      ]);
      await classify(line(s31, 1, { netAmount: eur('840.34'), performance: { from: '2029-01-05', until: '2029-01-25' } }));
      const later = await api.check(q);
      expect([later.status, later.notComputableReason, later.final, later.sum]).toEqual([
        'NOT_COMPUTABLE',
        'SOURCES_OUTSIDE_SEARCH_RANGE',
        false,
        eur('29180.67'),
      ]);
      expect(later.outsideSearchRange.map((e: Json) => [e.sourceId, e.sourcePosition])).toEqual([[s31, 1]]);
      expect(flag(later, 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED')).toBeUndefined();

      // (b) L4 performed in the window: ABOVE_THRESHOLD 15.76; R1 suggested, the cost lines not; stage 2 by 236-4.
      await classify(line(s29, 3, { netAmount: eur('2016.81'), performance: { from: '2029-01-10', until: '2029-01-20' }, supersedes: a }));
      const cb = await api.check(q);
      expect([cb.status, cb.percentOfBasis, cb.affectedYears]).toEqual(['ABOVE_THRESHOLD', '15.76', [2027]]);
      expect(cb.sources.map((e: Json) => e.suggestedTreatment)).toEqual(['CAPITALIZED', null, null, null]);
      expect(reasons(cb)).toEqual(expect.arrayContaining(['HAUSGELD_MAINTENANCE_ABOVE_THRESHOLD', 'SOURCES_OUTSIDE_SEARCH_RANGE']));
      expect(flag(cb, 'HAUSGELD_MAINTENANCE_ANSCHAFFUNGSNAH').lines).toHaveLength(3);
      // R1's item in the view of 2027 carries the check's flag; no cost line is an item of any view.
      const v2027 = await api.view(pr, 2027);
      const maintenance = v2027.werbungskosten.lines.find((l: Json) => l.taxCategory === 'MAINTENANCE');
      expect(maintenance.items.map((i: Json) => [i.sourceId, i.flags.map((f: Json) => f.code).includes('ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN')])).toEqual([
        [r1, true],
      ]);
      expect(JSON.stringify(v2027)).not.toContain('WEG_STATEMENT_COST_LINE');
      // No figure of any view moved; no cash; the check's reads wrote nothing.
      expect(await views()).toEqual(viewsBefore);
      const asset = await api.building(pr, [q]);
      const schedule = await api.schedule(asset, 'from=2027&to=2027');
      expect(schedule.years[0].stage.stage).toBe(2);

      expect(await api.cashRows()).toEqual(cashBefore);
      const afterReads = await writes();
      await api.check(q);
      await api.view(pr, 2029);
      expect(await writes()).toEqual(afterReads);
      expect(readsBefore[1]).toBeLessThan(afterReads[1] as number);
      // History of a line (through the repository: the ACC8 wiring serves no history route): the three classifications of
      // L4 by supersede, each with the printed unit share; the AuditRecords; another Realm sees none.
      const repository = new PostgresTaxClassificationRepository(createDatabase(api.ctx.pool));
      const history = (await repository.listHistory('WEG_STATEMENT_COST_LINE', s29, REALM_A, 3)) ?? [];
      expect(history.map((i) => [i.performance?.from ?? null, i.supersededBy === null, i.costLine?.unitShare.amount])).toEqual([
        [null, false, '2400.00'],
        ['2029-05-02', false, '2400.00'],
        ['2029-01-10', true, '2400.00'],
      ]);
      expect(
        await count(`SELECT count(*) AS n FROM audit_record WHERE entity_id = '${l4}' AND action IN ('TAX_CLASSIFIED', 'TAX_CLASSIFICATION_SUPERSEDED')`),
      ).toBe(2);
      expect(await repository.listHistory('WEG_STATEMENT_COST_LINE', s29, REALM_B, 3)).toBeUndefined();
      expect((await json(await call('GET', `/acquisitions/${q}/anschaffungsnahe-herstellungskosten`, undefined, { realm: REALM_B }), 404)).error.code).toBe(
        'NOT_FOUND',
      );
      // CANCELLED: the order of checks unchanged (409 after the Acquisition was found).
      const { acquisitionId: other } = await api.purchase({
        pr: await api.link(PROPERTIES[1] as string),
        buyers: [owner],
        share: '1/1',
        price: '100000.00',
        contract: '2026-02-01',
        transfer: '2026-03-15',
        allocation: { total: '100000.00', land: '20000.00', building: '80000.00' },
      });
      await post(`/acquisitions/${other}/cancel`, { reason: 'Kauf nicht zustande gekommen (synthetisch)' }, 200);
      expect((await json(await call('GET', `/acquisitions/${other}/anschaffungsnahe-herstellungskosten`), 409)).error.details.reason).toBe(
        'ACQUISITION_CANCELLED',
      );
    },
  );
});
