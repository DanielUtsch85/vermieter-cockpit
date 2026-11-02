import { describe, expect, it } from 'vitest';
import type { Performance } from '../../domains/taxation/index.js';
import { actor, databaseUrl, day, eur, OTHER_REALM, REALM, useTaxWegDatabase } from './tax-weg.test-support.js';

/**
 * §59F "The read (PostgreSQL)" (VC-X-38): the anschaffungsnahe check reads every counting source dated within its outer
 * bound (3 years around the window), so a source with a performance in the window is read whatever its booking date,
 * and an undated one is summed in the upper bound within the search range (90 days before, 365 after) and listed
 * beyond it. One snapshot; Realm isolation. Transfer 2026-03-15, window to 2029-03-15. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('the anschaffungsnahe check reads by the performance (§59F)', () => {
  const { ctx, split, booked, propertyReference, acquisition } = useTaxWegDatabase('anschaffungsnahe_performance_read_test');
  const today = day('2032-06-01');
  const classify = async (pr: string, date: string, amount: string, performance: Performance | null) => {
    const { splitIds } = await booked([split(amount, 'MAINTENANCE', pr)], date);
    const sourceId = splitIds[0] as string;
    const outcome = await ctx.classifications.createClassification(
      {
        mreRealmId: REALM,
        sourceType: 'TRANSACTION_SPLIT',
        sourceId,
        taxCategory: 'MAINTENANCE',
        treatment: 'DEDUCTIBLE',
        reviewState: 'USER_CONFIRMED',
        supersedes: null,
        notes: null,
        sourceReferences: ['Rechnung (synthetisch)'],
        netAmount: eur(amount),
        performance,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome));
    return sourceId;
  };
  const on = (from: string, until: string) => ({ from: day(from), until: day(until), progress: [], progressEstimated: null });

  it('a source booked 117 days and two years after the window, and an advance 13 days before it, all performed in it: read and summed', async () => {
    const pr = await propertyReference();
    const acq = await acquisition(pr);
    const late = await classify(pr, '2029-07-10', '9500.00', on('2028-11-02', '2028-12-20'));
    const later = await classify(pr, '2031-03-01', '1000.00', on('2028-12-01', '2028-12-10'));
    const advance = await classify(pr, '2026-03-02', '3000.00', on('2026-04-10', '2026-04-20'));
    const check = await ctx.classifications.anschaffungsnaheCheck(acq, REALM, today);
    expect(check?.sources.map((e) => e.sourceId).sort()).toEqual([late, later, advance].sort());
    expect(check).toMatchObject({ sum: eur('13500.00'), sumUpper: eur('13500.00'), undetermined: [], outsideSearchRange: [] });
    // Counter-check: the same late source booked inside the window but performed after it is read and excluded.
    const after = await classify(pr, '2029-01-10', '500.00', on('2029-03-16', '2029-03-20'));
    const again = await ctx.classifications.anschaffungsnaheCheck(acq, REALM, today);
    expect(again?.excluded.map((e) => [e.sourceId, e.reason])).toEqual([[after, 'PERFORMED_OUTSIDE_WINDOW']]);
    expect(again?.sum).toEqual(eur('13500.00'));
  });

  it('undated: 90 days before and 365 after summed in the upper bound; 91 and 366 listed outside; beyond the outer bound not read', async () => {
    const pr = await propertyReference();
    const acq = await acquisition(pr);
    const near = [await classify(pr, '2025-12-15', '10.00', null), await classify(pr, '2030-03-15', '20.00', null)];
    const far = [await classify(pr, '2025-12-14', '30.00', null), await classify(pr, '2030-03-16', '40.00', null)];
    await classify(pr, '2023-03-14', '50.00', null);
    await classify(pr, '2032-03-16', '60.00', null);
    const check = await ctx.classifications.anschaffungsnaheCheck(acq, REALM, today);
    expect(check?.undetermined.map((e) => e.sourceId)).toEqual(near);
    expect(check?.outsideSearchRange.map((e) => e.sourceId)).toEqual(far);
    expect(check).toMatchObject({
      sum: eur('0.00'),
      sumUpper: eur('30.00'),
      status: 'NOT_COMPUTABLE',
      notComputableReason: 'SOURCES_OUTSIDE_SEARCH_RANGE',
      searchRange: { from: '2025-12-15', until: '2030-03-15' },
      outerBound: { from: '2023-03-15', until: '2032-03-15' },
    });
    // The meaning of an undated source names the date the check wants.
    const meaning = await ctx.classifications.findTaxMeaning(near[0] as string, REALM, today);
    expect(meaning?.flags).toContainEqual({ code: 'PERFORMANCE_DATE_MISSING', details: { acquisitionId: acq } });
    expect(meaning?.performance).toBeNull();
  });

  it('Realm isolation: another Realm reads no check and no meaning; the classification with its points reads back as stored', async () => {
    const pr = await propertyReference();
    const acq = await acquisition(pr);
    const { splitIds } = await booked([split('8400.00', 'MAINTENANCE', pr)], '2029-04-30');
    const created = await ctx.classifications.createClassification(
      {
        mreRealmId: REALM,
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: splitIds[0] as string,
        taxCategory: 'MAINTENANCE',
        treatment: 'DEDUCTIBLE',
        reviewState: 'USER_CONFIRMED',
        supersedes: null,
        notes: null,
        sourceReferences: ['Leistungsstand des Unternehmers (synthetisch)'],
        performance: {
          from: day('2029-02-01'),
          until: day('2029-04-15'),
          progress: [{ through: day('2029-03-15'), amount: eur('5600.00') }],
          progressEstimated: false,
        },
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    expect(created.classification.performance).toEqual({
      from: '2029-02-01',
      until: '2029-04-15',
      progress: [{ through: '2029-03-15', amount: eur('5600.00') }],
      progressEstimated: false,
    });
    const check = await ctx.classifications.anschaffungsnaheCheck(acq, REALM, today);
    expect(check?.sources[0]?.inWindow).toEqual({ lower: eur('5600.00'), upper: eur('5600.00') });
    const withPoints = await ctx.classifications.findTaxMeaning(splitIds[0] as string, REALM, today);
    expect(withPoints?.performance?.progress).toEqual([{ through: '2029-03-15', amount: eur('5600.00') }]);
    expect(await ctx.classifications.anschaffungsnaheCheck(acq, OTHER_REALM, today)).toBeUndefined();
    expect(await ctx.classifications.findTaxMeaning(splitIds[0] as string, OTHER_REALM, today)).toBeUndefined();
    expect(await ctx.classifications.findClassification(created.classification.id, OTHER_REALM)).toBeUndefined();
    // The AuditRecord carries the performance.
    const audit = await ctx.pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'TAX_CLASSIFIED'`, [created.classification.id]);
    expect(audit.rows[0].metadata.performance).toEqual({
      from: '2029-02-01',
      until: '2029-04-15',
      progress: [{ through: '2029-03-15', amount: { amount: '5600.00', currency: 'EUR' } }],
      progressEstimated: false,
    });
  });
});
