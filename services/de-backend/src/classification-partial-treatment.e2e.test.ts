import { describe, expect, it } from 'vitest';
import { PROPERTIES, REALM_B, databaseUrl, eur, expectOwnersAddUp, lineOf, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-38 Part 2 end to end over HTTP (api-design.md §59F "As implemented (VC-X-38 Part 2)"; Entscheidung des
 * Projektinhabers, 2026-11-02, 239-2; Prüfbericht 2026-11-01, Frage 14, mündlich bestätigt durch den Steuerberater,
 * laut Projektinhaber am 2026-11-01): §59F's example (transfer 2026-03-15, basis 198,000.00, a building of 1995, 2 %),
 * owned by A 1/3 and B 2/3. S3 straddles the window's end (point 2029-03-15: 5,600.00 of 8,400.00) and takes the partial
 * treatment: the window part CAPITALIZED, the rest DEDUCTIBLE. S6 straddles its start (point 2026-03-14: 1,000.00 of
 * 4,000.00): refused (`STRADDLES_START`, the owner's review of #252: work before the transfer is not decided), nothing
 * written, S6 stays DEDUCTIBLE. The check's sums, the cash and the owners' shares stay; the AfA of the window part starts
 * by §59F's rule; history, re-classification and Realm isolation. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('the partial treatment of a straddling source end to end (VC-X-38 Part 2)', () => {
  const api = useAcc8('classification_partial_e2e');
  const { at, call, json, classify, booked, schedule } = api;

  it(
    'S3 partially treated, S6 (across the start) refused: the check unchanged, the view split per part and owner, the AfA of 5,600.00 from 2029; refusals, history, cash, Realm',
    { timeout: 180_000 },
    async () => {
      at('2026-03-01');
      const pr = await api.link(PROPERTIES[2] as string);
      const a = await api.party('Eigentümerin A (synthetisch)');
      const b = await api.party('Eigentümer B (synthetisch)');
      const { acquisitionId: w } = await api.purchase({
        pr,
        buyers: [a, b],
        share: '1/1',
        price: '240000.00',
        contract: '2026-02-01',
        transfer: '2026-03-15',
        costs: [['REAL_ESTATE_TRANSFER_TAX', '24000.00']],
        allocation: { total: '264000.00', land: '66000.00', building: '198000.00' },
      });
      await api.own(pr, a, '1/3', '2026-03-15', w);
      await api.own(pr, b, '2/3', '2026-03-15', w);
      await api.confirm(w);
      const building = await api.building(pr, [w]);
      const account = await api.account();
      at('2029-08-01');
      const on = (amount: string) => ({ amount: eur(amount), financialCategoryCode: 'MAINTENANCE', propertyReferenceId: pr });
      const [s1] = await booked(account, 'OUTFLOW', '2027-05-20', [on('12000.00')]);
      const [s2] = await booked(account, 'OUTFLOW', '2029-07-10', [on('11305.00')]);
      const [s3] = await booked(account, 'OUTFLOW', '2029-04-30', [on('8400.00')]);
      const [s4] = await booked(account, 'OUTFLOW', '2026-03-02', [on('3000.00')]);
      const [s6] = await booked(account, 'OUTFLOW', '2026-04-30', [on('4000.00')]);
      const evidence = { sourceReferences: ['Leistungsstand des Unternehmers (synthetisch)'] };
      const S3 = { from: '2029-02-01', until: '2029-04-15', progress: [{ through: '2029-03-15', amount: eur('5600.00') }], progressEstimated: false };
      const S6 = { from: '2026-03-01', until: '2026-04-15', progress: [{ through: '2026-03-14', amount: eur('1000.00') }], progressEstimated: false };
      const deductible = (sourceId: string, net: string, performance: Json, extra: Json = {}) =>
        classify({ sourceId, taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', netAmount: eur(net), performance, ...extra });
      await deductible(s1 as string, '12000.00', { from: '2027-04-01', until: '2027-04-30' });
      await deductible(s2 as string, '9500.00', { from: '2028-11-02', until: '2028-12-20' });
      let s3Current = await deductible(s3 as string, '8400.00', S3, evidence);
      await deductible(s4 as string, '3000.00', { from: '2026-04-10', until: '2026-04-20' });
      const s6Current = await deductible(s6 as string, '4000.00', S6, evidence);

      // The check before: every part exact, 33,100.00 (12,000 + 9,500 + 5,600 + 3,000 + 3,000), final; S3 and S6 split required.
      const before = await api.check(w);
      expect([before.status, before.sum.amount, before.sumUpper.amount, before.percentOfBasis, before.final]).toEqual([
        'ABOVE_THRESHOLD',
        '33100.00',
        '33100.00',
        '16.72',
        true,
      ]);
      const splitRequired = (c: Json, sourceId: string) =>
        c.sources.find((e: Json) => e.sourceId === sourceId).flags.find((f: Json) => f.code === 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN').details.splitRequired;
      expect([splitRequired(before, s3 as string), splitRequired(before, s6 as string)]).toEqual([true, true]);
      const cashBefore = await api.cashRows();
      const view2029Before = await api.view(pr, 2029);
      expect([lineOf(view2029Before, 'MAINTENANCE').total.amount, view2029Before.capitalized.total.amount]).toEqual(['19705.00', '0.00']);

      const capitalise = (sourceId: string, supersedes: string, body: Json, realm?: string) =>
        call(
          'POST',
          '/tax-classifications',
          {
            sourceType: 'TRANSACTION_SPLIT',
            sourceId,
            taxCategory: 'MAINTENANCE',
            treatment: 'CAPITALIZED',
            reviewState: 'USER_CONFIRMED',
            anschaffungsnaheAcquisitionId: w,
            netAmount: eur('8400.00'),
            supersedes,
            ...evidence,
            ...body,
          },
          realm === undefined ? {} : { realm },
        );
      // The refusals: whole (STRADDLES_WINDOW, as before); points that leave the edge open; an estimated point;
      // a source wholly in the window (NOT_STRADDLING); the field errors.
      expect((await json(await capitalise(s3 as string, s3Current, { performance: S3 }), 422)).error.details).toMatchObject({
        reason: 'PERFORMANCE_REQUIRED',
        cause: 'STRADDLES_WINDOW',
      });
      const open = { ...S3, progress: [{ through: '2029-03-31', amount: eur('6500.00') }] };
      expect((await json(await capitalise(s3 as string, s3Current, { performance: open, partialTreatment: true }), 422)).error.details).toEqual({
        reason: 'PERFORMANCE_REQUIRED',
        acquisitionId: w,
        cause: 'SPLIT_NOT_EVIDENCED',
        inWindow: { lower: eur('0.00'), upper: eur('6500.00') },
      });
      expect(
        (await json(await capitalise(s3 as string, s3Current, { performance: { ...S3, progressEstimated: true }, partialTreatment: true }), 422)).error.details,
      ).toMatchObject({ cause: 'SPLIT_NOT_EVIDENCED', inWindow: { lower: eur('0.00'), upper: eur('8400.00') } });
      const s2History = await api.ctx.pool.query(`SELECT id FROM tax_classification WHERE transaction_split_id = $1 AND superseded_at IS NULL`, [s2]);
      expect(
        (
          await json(
            await capitalise(s2 as string, s2History.rows[0].id, {
              netAmount: eur('9500.00'),
              performance: { from: '2028-11-02', until: '2028-12-20' },
              partialTreatment: true,
            }),
            422,
          )
        ).error.details,
      ).toMatchObject({ reason: 'PARTIAL_TREATMENT_NOT_APPLICABLE', cause: 'NOT_STRADDLING' });
      const fields = async (body: Json) => (await json(await capitalise(s3 as string, s3Current, body), 400)).error.details.fields;
      expect(await fields({ treatment: 'DEDUCTIBLE', anschaffungsnaheAcquisitionId: null, performance: S3, partialTreatment: true })).toContainEqual({
        field: 'partialTreatment',
        code: 'NOT_ALLOWED_WITH_TREATMENT',
      });
      expect(await fields({ partialTreatment: true })).toContainEqual({ field: 'performance', code: 'REQUIRED' });
      expect(await fields({ performance: S3, partialTreatment: 'yes' })).toContainEqual(expect.objectContaining({ field: 'partialTreatment' }));
      // Realm isolation: Realm B cannot classify Realm A's split.
      expect((await capitalise(s3 as string, s3Current, { performance: S3, partialTreatment: true }, REALM_B)).status).toBe(404);

      // S6 across the transfer date, even with its point on the day before it: refused, nothing written.
      const rowsOf = async () =>
        (
          await api.ctx.pool.query(
            `SELECT (SELECT count(*)::int FROM tax_classification) AS classifications,
                    (SELECT count(*)::int FROM tax_classification_treatment_part) AS parts,
                    (SELECT count(*)::int FROM audit_record) AS audits`,
          )
        ).rows[0];
      const rowsBefore = await rowsOf();
      expect(
        (await json(await capitalise(s6 as string, s6Current, { netAmount: eur('4000.00'), performance: S6, partialTreatment: true }), 422)).error.details,
      ).toEqual({
        reason: 'PERFORMANCE_REQUIRED',
        acquisitionId: w,
        cause: 'STRADDLES_START',
      });
      expect(await rowsOf()).toEqual(rowsBefore);

      // Accepted: S3 5,600.00 / 2,800.00 (the point on W).
      const s3Partial = await json(await capitalise(s3 as string, s3Current, { performance: S3, partialTreatment: true }), 201);
      expect(s3Partial.treatmentParts).toEqual([
        { position: 1, treatment: 'CAPITALIZED', amount: eur('5600.00') },
        { position: 2, treatment: 'DEDUCTIBLE', amount: eur('2800.00') },
      ]);
      s3Current = s3Partial.classificationId;
      // As stored (the acceptance wiring serves the commands this test calls, not the classification read).
      const stored = await api.ctx.pool.query(
        `SELECT position, treatment, amount::text FROM tax_classification_treatment_part WHERE classification_id = $1 ORDER BY position`,
        [s3Current],
      );
      expect(stored.rows).toEqual([
        { position: 1, treatment: 'CAPITALIZED', amount: '5600.00' },
        { position: 2, treatment: 'DEDUCTIBLE', amount: '2800.00' },
      ]);

      // The check after: the same sums (exactly the window parts count), S3's split done, S6's still required.
      const after = await api.check(w);
      expect([after.status, after.sum, after.sumUpper, after.percentOfBasis, after.final]).toEqual([
        before.status,
        before.sum,
        before.sumUpper,
        before.percentOfBasis,
        before.final,
      ]);
      expect([splitRequired(after, s3 as string), splitRequired(after, s6 as string)]).toEqual([false, true]);

      // The view of 2029: the window part in capitalized, the rest on MAINTENANCE; per owner, each part shared on its own.
      const v2029 = await api.view(pr, 2029);
      expect(v2029.capitalized.items.map((i: Json) => [i.sourceId, i.lineAmount.amount, i.amount.amount, i.treatmentPart])).toEqual([
        [s3, '5600.00', '8400.00', { position: 1, treatment: 'CAPITALIZED', amount: eur('5600.00') }],
      ]);
      expect([lineOf(v2029, 'MAINTENANCE').total.amount, v2029.capitalized.total.amount]).toEqual(['14105.00', '5600.00']);
      expect(lineOf(v2029, 'MAINTENANCE').items.find((i: Json) => i.sourceId === s3).treatmentPart).toEqual({
        position: 2,
        treatment: 'DEDUCTIBLE',
        amount: eur('2800.00'),
      });
      // The cash part of 2029 (capitalized + MAINTENANCE) is the cash of 2029, as before.
      expect(Number(lineOf(v2029, 'MAINTENANCE').total.amount) + Number(v2029.capitalized.total.amount)).toBe(19705);
      expectOwnersAddUp(v2029, '2029');
      const [va, vb] = [await api.view(pr, 2029, a), await api.view(pr, 2029, b)];
      expect([va.capitalized.total.amount, vb.capitalized.total.amount]).toEqual(['1866.67', '3733.33']);
      // The review: S3's suggestion followed by its partial treatment (both its items informative); S2's (DEDUCTIBLE) still open.
      const countOf = (l: Json[]) => l.find((o: Json) => o.code === 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN')?.count ?? 0;
      expect([countOf(view2029Before.review.open), countOf(view2029Before.review.info)]).toEqual([2, 0]);
      expect([countOf(v2029.review.open), countOf(v2029.review.info)]).toEqual([1, 2]);
      const v2026 = await api.view(pr, 2026);
      // S6 refused: whole on MAINTENANCE (S4 3,000.00 + S6 4,000.00), nothing capitalised in 2026.
      expect([lineOf(v2026, 'MAINTENANCE').total.amount, v2026.capitalized.total.amount]).toEqual(['7000.00', '0.00']);
      // S6 per owner, whole (S4, booked before the transfer, is NOT_OWNED in 2026, so the owners alone do not add up there).
      const [a2026, b2026] = [await api.view(pr, 2026, a), await api.view(pr, 2026, b)];
      expect([
        a2026.capitalized.total.amount,
        b2026.capitalized.total.amount,
        lineOf(a2026, 'MAINTENANCE').total.amount,
        lineOf(b2026, 'MAINTENANCE').total.amount,
      ]).toEqual(['0.00', '0.00', '1333.33', '2666.67']);

      // The AfA of S3's window part: basis 5,600.00, start PERFORMANCE_UNTIL 2029-04-15 → 2029-01, 112.00 in 2029.
      const s = await schedule(building, 'from=2029&to=2029');
      const item = s.components.find((c: Json) => c.componentId === `TRANSACTION_SPLIT:${s3}`);
      expect([item.basis.amount.amount, item.start.date, item.start.dateSource, item.start.month, item.years.map((y: Json) => y.amount.amount)]).toEqual([
        '5600.00',
        '2029-04-15',
        'PERFORMANCE_UNTIL',
        '2029-01',
        ['112.00'],
      ]);

      // No cash correction: every cash row unchanged.
      expect(await api.cashRows()).toEqual(cashBefore);

      // Re-classified: S3 back to DEDUCTIBLE (the partial treatment withdrawn by a new classification).
      await deductible(s3 as string, '8400.00', S3, { ...evidence, supersedes: s3Current });
      const back = await api.view(pr, 2029);
      expect([lineOf(back, 'MAINTENANCE').total.amount, back.capitalized.total.amount]).toEqual(['19705.00', '0.00']);
      expect((await api.check(w)).sum).toEqual(before.sum);

      // History: TAX_CLASSIFIED with the parts on the partial treatment only; each supersession recorded.
      const audits = await api.ctx.pool.query(
        `SELECT action, metadata FROM audit_record WHERE entity_type = 'TaxClassification'
           AND entity_id IN (SELECT id::text FROM tax_classification WHERE transaction_split_id = $1) ORDER BY occurred_at, action`,
        [s3],
      );
      expect(
        audits.rows
          .filter((r) => r.action === 'TAX_CLASSIFIED')
          .map((r) => [r.metadata.treatment, r.metadata.treatmentParts?.map((p: Json) => p.amount.amount) ?? null]),
      ).toEqual([
        ['DEDUCTIBLE', null],
        ['CAPITALIZED', ['5600.00', '2800.00']],
        ['DEDUCTIBLE', null],
      ]);
      expect(audits.rows.filter((r) => r.action === 'TAX_CLASSIFICATION_SUPERSEDED')).toHaveLength(2);
    },
  );
});
