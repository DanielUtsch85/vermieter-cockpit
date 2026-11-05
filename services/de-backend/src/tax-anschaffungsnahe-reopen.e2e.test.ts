import { describe, expect, it } from 'vitest';
import { createDatabase } from './infrastructure/postgres/index.js';
import { ExactDecimal, Money } from './shared/index.js';
import { confirmedStatementsOf } from './infrastructure/postgres/weg-statements.test-support.js';
import { PROPERTIES, REALM_A, databaseUrl, eur, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * The follow-up to VC-X-27 (api-design.md §58M "As implemented (VC-X-27)", the open questions of #269; Entscheidung des
 * Projektinhabers, 2026-11-05) end to end over HTTP, synthetic: (1) a check of a WEG member not final only because of
 * `WEG_STATEMENT_MISSING` holds the purchase at stage 2 (`ANSCHAFFUNGSNAHE_CHECK_OPEN`) in every year of the window, back
 * to stage 1 once the statements are confirmed and the check is final; a purchase without a WEG is unaffected. (2) (a″):
 * a later statement beyond the read range with a line performed in the window reopens the final check visibly
 * (`ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL` on the years again), with no change flag of §58E (M9) and no figure of any view moved.
 */
describe.skipIf(databaseUrl === undefined)('WEG_STATEMENT_MISSING at stage 2 and (a″) reopening a final check end to end (VC-X-27 follow-up)', () => {
  const api = useAcc8('tax_anschaffungsnahe_reopen_e2e');
  const { at, post, classify, booked } = api;
  const YEARS = [2026, 2027, 2028, 2029];
  const cost = (position: number, account: string, group: 'RECOVERABLE' | 'NON_RECOVERABLE', unitShare: string) => ({
    position,
    account,
    group,
    allocationKey: 'MEA',
    allocationTotal: null,
    allocationShare: null,
    totalAmount: Money.of(unitShare, 'EUR').multiply(ExactDecimal.of('20'), 'HALF_UP'),
    unitShare: Money.of(unitShare, 'EUR'),
    classification: null,
  });
  const ordinary = [cost(1, 'Hausmeister', 'RECOVERABLE', '1800.00'), cost(2, 'Verwaltervergütung', 'NON_RECOVERABLE', '600.00')];
  const statementOf = async (membership: string, year: number, lines: ReturnType<typeof cost>[], from?: string) => {
    const [id] = await confirmedStatementsOf(
      createDatabase(api.ctx.pool),
      { mreRealmId: REALM_A, membershipId: membership, years: [year], costLines: lines, ...(from === undefined ? {} : { firstFrom: from }) },
      { actorType: 'USER', actorId: 'anna@example.com' },
      new Date(`${year + 1}-02-01T10:00:00Z`),
    );
    return id as string;
  };
  const line = (sourceId: string, sourcePosition: number, body: Record<string, unknown>) => ({
    sourceType: 'WEG_STATEMENT_COST_LINE',
    sourceId,
    sourcePosition,
    ...body,
  });
  /** A judged statement: its NON_RECOVERABLE Verwaltervergütung NOT_RELEVANT. */
  const judgedStatement = async (membership: string, year: number, from?: string) => {
    const id = await statementOf(membership, year, ordinary, from);
    await classify(line(id, 2, { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' }));
    return id;
  };
  const reasons = (c: Json) => (c.flags.find((f: Json) => f.code === 'NOT_FINAL')?.details.reasons ?? []) as string[];
  const stages = async (asset: string) => ((await api.schedule(asset, 'from=2026&to=2029')).years as Json[]).map((y) => y.stage.stage);
  const criteria = async (asset: string) =>
    ((await api.schedule(asset, 'from=2026&to=2029')).years as Json[]).map((y) => y.stage.components.map((c: Json) => c.criteria));
  /** Every money section of a view (the figures): the view without its flags, its checks' status, its review and its date. */
  const figures = (v: Json) => {
    const { flags: _flags, acquisitions: _acquisitions, review: _review, computedOn: _computedOn, ...rest } = v;
    return rest;
  };
  const codes = (v: Json) => (v.flags as Json[]).map((f) => f.code).sort();

  it(
    'not final only for WEG_STATEMENT_MISSING: stage 2 in the window years, 1 once final; (a″) reopens visibly, no change flag, no figure moved',
    { timeout: 180_000 },
    async () => {
      at('2026-03-01');
      const owner = await api.party('Eigentümerin A (synthetisch)');
      const purchase = async (pr: string) => {
        const { acquisitionId } = await api.purchase({
          pr,
          buyers: [owner],
          share: '1/1',
          price: '264000.00',
          contract: '2026-02-01',
          transfer: '2026-03-15',
          allocation: { total: '264000.00', land: '66000.00', building: '198000.00' },
        });
        await api.own(pr, owner, '1/1', '2026-03-15', acquisitionId);
        await api.confirm(acquisitionId);
        return acquisitionId;
      };
      const pr = await api.link(PROPERTIES[0] as string);
      const q = await purchase(pr);
      // The counter-check: a purchase of the same day without a WEG.
      const plain = await api.link(PROPERTIES[1] as string);
      const x = await purchase(plain);
      const { wegId } = await post('/wegs', { displayName: 'WEG Musterstraße (synthetisch)' });
      const { membershipId: m } = await post(`/wegs/${wegId}/memberships`, { propertyReferenceId: pr, miteigentumsanteil: '50/1000', validFrom: '2026-03-15' });
      const account = await api.account();
      at('2027-06-01');
      // A repair in the window below 15 % (5,000.00 of 198,000.00) and the Hausgeld of each year: figures of the views.
      const [r] = await booked(account, 'OUTFLOW', '2027-05-10', [{ amount: eur('5950.00'), financialCategoryCode: 'MAINTENANCE', propertyReferenceId: pr }]);
      await classify({
        sourceId: r,
        taxCategory: 'MAINTENANCE',
        treatment: 'DEDUCTIBLE',
        netAmount: eur('5000.00'),
        performance: { from: '2027-04-01', until: '2027-04-30' },
      });
      for (const year of YEARS) {
        await booked(account, 'OUTFLOW', `${year}-06-15`, [{ amount: eur('900.00'), financialCategoryCode: 'WEG_NON_RECOVERABLE', propertyReferenceId: pr }]);
      }

      // (1) On 2030-08-01 the statements 2026–2029 are confirmed and judged, 2030 is missing: not final for it alone.
      at('2030-08-01');
      await judgedStatement(m, 2026, '2026-03-15');
      for (const year of [2027, 2028, 2029]) await judgedStatement(m, year);
      const open = await api.check(q);
      expect([open.status, open.final, reasons(open)]).toEqual(['NOT_ABOVE_THRESHOLD', false, ['WEG_STATEMENT_MISSING']]);
      const asset = await api.building(pr, [q]);
      expect(await stages(asset)).toEqual([2, 2, 2, 2]);
      expect(await criteria(asset)).toEqual(YEARS.map(() => [['PURCHASE', 'ANSCHAFFUNGSNAHE_CHECK_OPEN']]));
      // Counter-check: the purchase without a WEG is final and stage 1 in every year.
      expect((await api.check(x)).final).toBe(true);
      const plainAsset = await api.building(plain, [x]);
      expect(await stages(plainAsset)).toEqual([1, 1, 1, 1]);

      // Counter-check: on 2031-08-01 with the statement of 2030 confirmed and judged the check is final: back to stage 1.
      at('2031-08-01');
      await judgedStatement(m, 2030);
      expect(await api.check(q)).toMatchObject({ status: 'NOT_ABOVE_THRESHOLD', final: true });
      expect(await stages(asset)).toEqual([1, 1, 1, 1]);
      const viewsFinal = await Promise.all(YEARS.map((year) => api.view(pr, year)));
      for (const v of viewsFinal) expect(codes(v)).not.toContain('ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL');

      // (2) (a″) On 2032-08-01 the statement of 2031 (beyond the read range, within the outer bound): with its line still
      // unjudged nothing reopens; judged MAINTENANCE performed in the window, it reopens the check.
      at('2032-08-01');
      const s31 = await statementOf(m, 2031, [cost(1, 'Instandsetzung Balkone', 'NON_RECOVERABLE', '1000.00')]);
      expect((await api.check(q)).final).toBe(true);
      const viewsBefore = await Promise.all(YEARS.map((year) => api.view(pr, year)));
      for (const v of viewsBefore) expect(codes(v)).not.toContain('ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL');
      await classify(
        line(s31, 1, {
          taxCategory: 'MAINTENANCE',
          treatment: 'DEDUCTIBLE',
          netAmount: eur('840.34'),
          performance: { from: '2029-01-05', until: '2029-01-25' },
        }),
      );
      const reopened = await api.check(q);
      expect([reopened.status, reopened.notComputableReason, reopened.final, reasons(reopened), reopened.sum]).toEqual([
        'NOT_COMPUTABLE',
        'SOURCES_OUTSIDE_SEARCH_RANGE',
        false,
        ['SOURCES_OUTSIDE_SEARCH_RANGE'],
        open.sum,
      ]);
      expect(reopened.outsideSearchRange.map((e: Json) => [e.sourceId, e.sourcePosition])).toEqual([[s31, 1]]);
      const viewsAfter = await Promise.all(YEARS.map((year) => api.view(pr, year)));
      viewsAfter.forEach((after, i) => {
        const before = viewsBefore[i];
        // Visible: ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL on the year again, naming the check; the year's check not final.
        expect(after.flags.find((f: Json) => f.code === 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL')?.details).toEqual({ acquisitionIds: [q] });
        expect(after.acquisitions.map((a: Json) => [a.acquisitionId, a.final, a.notFinalReasons])).toEqual([[q, false, ['SOURCES_OUTSIDE_SEARCH_RANGE']]]);
        // M9: no change flag of §58E; no other flag comes or goes.
        expect(codes(after)).toEqual([...codes(before), 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL'].sort());
        expect(JSON.stringify(after)).not.toContain('ATTRIBUTION_INPUT_CHANGED');
        // No figure moved: every money section of the view equal before and after.
        expect(figures(after)).toEqual(figures(before));
      });
      // The figures of the views equal those read while the check was final on 2031-08-01, too.
      expect(viewsAfter.map(figures)).toEqual(viewsFinal.map(figures));
      // The reopened check is NOT_COMPUTABLE or not final: the purchase is at stage 2 again (A1), the other one unaffected.
      expect(await stages(asset)).toEqual([2, 2, 2, 2]);
      expect(await stages(plainAsset)).toEqual([1, 1, 1, 1]);
    },
  );
});
