import { describe, expect, it } from 'vitest';
import { PROPERTIES, REALM_B, databaseUrl, eur, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-38 end to end over HTTP (api-design.md §59F "Example (synthetic)", literally; tax review of 2026-11-01,
 * questions 5, 14 and 16, mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01): an Acquisition
 * with economic transfer 2026-03-15, basis 198,000.00, one owner A (1/1), a building of 1995 (2 %); S1–S5 classified
 * MAINTENANCE / DEDUCTIBLE with their net amounts and performances, read on 2029-08-01; S2 capitalised on the check from
 * 2028. History, unchanged money and Realm isolation. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('the period of performance end to end (VC-X-38)', () => {
  const api = useAcc8('classification_performance_e2e');
  const { at, call, json, classify, booked, schedule } = api;

  it(
    'the example of §59F: ABOVE_THRESHOLD by the performance, S3 shown with its share, S2 capitalised from 2028; history, money, Realm isolation',
    { timeout: 120_000 },
    async () => {
      at('2026-03-01');
      const pr = await api.link(PROPERTIES[0] as string);
      const owner = await api.party('Eigentümerin A (synthetisch)');
      const { acquisitionId: w } = await api.purchase({
        pr,
        buyers: [owner],
        share: '1/1',
        price: '240000.00',
        contract: '2026-02-01',
        transfer: '2026-03-15',
        costs: [['REAL_ESTATE_TRANSFER_TAX', '24000.00']],
        allocation: { total: '264000.00', land: '66000.00', building: '198000.00' },
      });
      await api.own(pr, owner, '1/1', '2026-03-15', w);
      await api.confirm(w);
      const building = await api.building(pr, [w]);
      const account = await api.account();
      at('2029-08-01');
      const on = (amount: string) => ({ amount: eur(amount), financialCategoryCode: 'MAINTENANCE', propertyReferenceId: pr });
      const [s1] = await booked(account, 'OUTFLOW', '2027-05-20', [on('12000.00')]);
      const [s2] = await booked(account, 'OUTFLOW', '2029-07-10', [on('11305.00')]);
      const [s3] = await booked(account, 'OUTFLOW', '2029-04-30', [on('8400.00')]);
      const [s4] = await booked(account, 'OUTFLOW', '2026-03-02', [on('3000.00')]);
      const [s5] = await booked(account, 'OUTFLOW', '2027-09-14', [on('1200.00')]);
      const cashBefore = await api.cashRows();
      const acquisitionBefore = (await api.ctx.pool.query(`SELECT to_jsonb(a) AS row FROM acquisition a WHERE id = $1`, [w])).rows;
      const deductible = (sourceId: string, net: string, performance: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
        classify({
          sourceId,
          taxCategory: 'MAINTENANCE',
          treatment: 'DEDUCTIBLE',
          netAmount: eur(net),
          ...(performance === undefined ? {} : { performance }),
          ...extra,
        });
      await deductible(s1 as string, '12000.00', { from: '2027-04-01', until: '2027-04-30' });
      const s2Deductible = await deductible(s2 as string, '9500.00', { from: '2028-11-02', until: '2028-12-20' });
      const s3Body = {
        from: '2029-02-01',
        until: '2029-04-15',
        progress: [{ through: '2029-03-15', amount: eur('5600.00') }],
        progressEstimated: false,
      };
      // Points without a source reference are refused (the owner's decision of 2026-11-02: evidenced shares).
      const noEvidence = await call('POST', '/tax-classifications', {
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: s3,
        taxCategory: 'MAINTENANCE',
        treatment: 'DEDUCTIBLE',
        reviewState: 'USER_CONFIRMED',
        supersedes: null,
        netAmount: eur('8400.00'),
        performance: s3Body,
      });
      expect((await json(noEvidence, 422)).error.code).toBe('PERFORMANCE_EVIDENCE_REQUIRED');
      await deductible(s3 as string, '8400.00', s3Body, { sourceReferences: ['Leistungsstand des Unternehmers zum 15.03.2029 (synthetisch)'] });
      await deductible(s4 as string, '3000.00', { from: '2026-04-10', until: '2026-04-20' });
      await deductible(s5 as string, '1200.00', undefined);

      const check = await api.check(w);
      expect([
        check.status,
        check.sum.amount,
        check.sumUpper.amount,
        check.percentOfBasis,
        check.percentOfBasisUpper,
        check.final,
        check.affectedYears,
      ]).toEqual(['ABOVE_THRESHOLD', '30100.00', '31300.00', '15.20', '15.81', false, [2026, 2027, 2029]]);
      expect(check.flags.find((f: Json) => f.code === 'NOT_FINAL').details.reasons).toEqual(['PERFORMANCE_IN_WINDOW_UNKNOWN']);
      expect(check.sources.map((e: Json) => [e.sourceId, e.inWindow.lower.amount, e.suggestedTreatment])).toEqual([
        [s4, '3000.00', 'CAPITALIZED'],
        [s1, '12000.00', 'CAPITALIZED'],
        [s3, '5600.00', null],
        [s2, '9500.00', 'CAPITALIZED'],
      ]);
      expect(check.undetermined.map((e: Json) => [e.sourceId, e.inWindow.upper.amount])).toEqual([[s5, '1200.00']]);
      // S3: its share shown (exact by the point at the window's end), split required, no suggestion; its performance as stored.
      const s3Entry = check.sources.find((e: Json) => e.sourceId === s3);
      expect(s3Entry.performance).toEqual({
        from: '2029-02-01',
        until: '2029-04-15',
        progress: [{ through: '2029-03-15', amount: eur('5600.00') }],
        progressEstimated: false,
      });
      expect(s3Entry.flags.find((f: Json) => f.code === 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN').details).toMatchObject({ splitRequired: true });
      expect(s3Entry.flags.find((f: Json) => f.code === 'PERFORMANCE_STRADDLES_WINDOW').details).toEqual({
        edge: 'END',
        lower: eur('5600.00'),
        upper: eur('5600.00'),
      });
      // A capitalisation on the check: S3 (straddling) refused, S5 (undated) refused, S2 (wholly in the window) accepted.
      const capitalise = (sourceId: string, performance: Record<string, unknown> | undefined, supersedes: string | null) =>
        call('POST', '/tax-classifications', {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId,
          taxCategory: 'MAINTENANCE',
          treatment: 'CAPITALIZED',
          reviewState: 'USER_CONFIRMED',
          anschaffungsnaheAcquisitionId: w,
          sourceReferences: ['Rechnung (synthetisch)'],
          supersedes,
          ...(performance === undefined ? {} : { performance }),
        });
      // The history as stored (the acceptance wiring serves the commands this test calls, not the history read).
      const history = async (sourceId: string) =>
        (await api.ctx.pool.query(`SELECT id, superseded_by FROM tax_classification WHERE transaction_split_id = $1 ORDER BY created_at`, [sourceId])).rows;
      const currentOf = async (sourceId: string) => (await history(sourceId)).find((c) => c.superseded_by === null)?.id as string;
      expect((await json(await capitalise(s3 as string, s3Body, await currentOf(s3 as string)), 422)).error.details).toMatchObject({
        reason: 'PERFORMANCE_REQUIRED',
        cause: 'STRADDLES_WINDOW',
      });
      expect((await json(await capitalise(s5 as string, undefined, await currentOf(s5 as string)), 422)).error.details).toMatchObject({
        reason: 'PERFORMANCE_REQUIRED',
        cause: 'MISSING',
      });
      const capitalised = await json(await capitalise(s2 as string, { from: '2028-11-02', until: '2028-12-20' }, s2Deductible), 201);
      expect(capitalised.performance).toEqual({ from: '2028-11-02', until: '2028-12-20', progress: [], progressEstimated: null });

      // The item: basis 11,305.00 (gross), start PERFORMANCE_UNTIL 2028-12-20 → 2028-01, 226.10 in 2028 and in 2029.
      const s = await schedule(building, 'from=2028&to=2029');
      const item = s.components.find((c: Json) => c.componentId === `TRANSACTION_SPLIT:${s2}`);
      expect([item.basis.amount.amount, item.start.date, item.start.dateSource, item.start.month, item.years.map((y: Json) => y.amount.amount)]).toEqual([
        '11305.00',
        '2028-12-20',
        'PERFORMANCE_UNTIL',
        '2028-01',
        ['226.10', '226.10'],
      ]);
      expect(item.flags.find((f: Json) => f.code === 'CAPITALIZED_YEAR_DIFFERS').details).toMatchObject({ startDate: '2028-12-20', taxYear: 2029 });

      // History: each create a TAX_CLASSIFIED AuditRecord with the performance; the superseded one recorded.
      const audits = await api.ctx.pool.query(
        `SELECT action, metadata FROM audit_record WHERE entity_type = 'TaxClassification' AND entity_id IN (SELECT id::text FROM tax_classification WHERE transaction_split_id = $1)
       ORDER BY occurred_at, action`,
        [s2],
      );
      expect(audits.rows.map((r) => [r.action, r.metadata.performance ?? null])).toEqual(
        expect.arrayContaining([
          ['TAX_CLASSIFIED', { from: '2028-11-02', until: '2028-12-20', progress: [], progressEstimated: null }],
          ['TAX_CLASSIFICATION_SUPERSEDED', null],
        ]),
      );
      expect(audits.rows.filter((r) => r.action === 'TAX_CLASSIFIED')).toHaveLength(2);
      // Money: no cash row and no Acquisition row changed by any classification.
      expect(await api.cashRows()).toEqual(cashBefore);
      expect((await api.ctx.pool.query(`SELECT to_jsonb(a) AS row FROM acquisition a WHERE id = $1`, [w])).rows).toEqual(acquisitionBefore);

      // Realm isolation: Realm B reads neither the check nor the meaning, and cannot classify Realm A's split.
      expect((await call('GET', `/acquisitions/${w}/anschaffungsnahe-herstellungskosten`, undefined, { realm: REALM_B })).status).toBe(404);
      const foreign = await call(
        'POST',
        '/tax-classifications',
        {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: s5,
          taxCategory: 'MAINTENANCE',
          treatment: 'DEDUCTIBLE',
          reviewState: 'USER_CONFIRMED',
          supersedes: null,
          performance: { from: '2027-09-01', until: '2027-09-05' },
        },
        { realm: REALM_B },
      );
      expect(foreign.status).toBe(404);
      expect(await history(s5 as string)).toHaveLength(1);
    },
  );
});
