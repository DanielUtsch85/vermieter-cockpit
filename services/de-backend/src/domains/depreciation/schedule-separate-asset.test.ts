import { describe, expect, it } from 'vitest';
import type { CapitalizedItem } from './capitalized-item.js';
import type { ScheduleInput } from './schedule.js';
import { W, acc8, capitalized, day, eur, kitchen } from './schedule.test-support.js';
import { EXTENSION, KITCHEN_SPLIT, REPAIR, USE, amount, codes, derive, item, items, ownerAmounts, repair, use, yearOf } from './schedule-items.test-support.js';

/**
 * VC-8-03 domain (api-design.md §59B, P8-D7): a separate asset's schedule, and the building and the separate asset never
 * sharing an item. Moved out of `schedule-items.test.ts` unchanged (issue #191); ACC8's Einbauküche as there.
 */
describe('a separate asset (§59B "Separate assets", P8-D7)', () => {
  const kitchenItem = (overrides: Partial<CapitalizedItem> = {}, date = '2027-04-28', amountText = '6000.00') =>
    capitalized(KITCHEN_SPLIT, date, amountText, undefined, { taxCategory: 'OTHER_EXPENSE', ...overrides });
  const separate = (assetOverrides = {}, list: CapitalizedItem[] = [kitchenItem()], extra: Partial<ScheduleInput> = {}) => {
    const k = kitchen({ items: list.map((i) => ({ sourceType: i.sourceType, sourceId: i.sourceId, sourcePosition: i.sourcePosition })), ...assetOverrides });
    return derive(acc8({ asset: k, from: 2027, to: 2037, capitalizedItems: list, ...extra }));
  };

  it('ACC8’s Einbauküche: 2027 450.00 (A 270.00, B 180.00), 600.00 a year, 2037 150.00, the last month 2037-03, 120 months in all', () => {
    const s = separate();
    expect(s).toMatchObject({ assetType: 'SEPARATE_ASSET', status: 'AVAILABLE', excludedItems: null, flags: [] });
    expect(s.asset).toEqual({
      status: 'ACTIVE',
      description: 'Einbauküche, Wohnung 3 (synthetisch)',
      usefulLifeYears: 10,
      acquiredOn: '2027-04-20',
      reviewState: 'CONFIRMED',
    });
    const c = item(s);
    expect(c).toMatchObject({
      start: { date: '2027-04-20', dateSource: 'ACQUIRED_ON', method: 'MONTH_OF_ACQUISITION', month: '2027-04', firstYearMonths: 9 },
      rate: { kind: 'USEFUL_LIFE', band: null, ratePercent: '10.0000', rate: '1/10', usefulLifeYears: 10, legalBasis: '§ 7 Abs. 1 EStG' },
      end: { lastYear: 2037, lastMonth: '2037-03' },
      flags: [],
    });
    expect(c.years.map((y) => [y.year, amount(y.amount)])).toEqual([
      [2027, '450.00'],
      ...[2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035, 2036].map((y) => [y, '600.00']),
      [2037, '150.00'],
    ]);
    expect(ownerAmounts(yearOf(c, 2027))).toEqual(['270.00', '180.00']);
    expect(yearOf(c, 2027).rule).toEqual({ ruleCode: 'DE_AFA_MOVABLE_LINEAR', version: 1, band: null, legalBasis: null });
    expect(c.years.reduce((sum, y) => sum + (y.months ?? 0), 0)).toBe(120);
    expect(s.ruleVersions.map((v) => [v.ruleCode, v.version])).toEqual([['DE_AFA_MOVABLE_LINEAR', 1]]);
    expect(s.components.every((x) => x.kind === 'CAPITALIZED_ITEM')).toBe(true);
  });

  it('the month of acquiredOn, never the item’s date: December 1/12, January 12/12', () => {
    expect(amount(yearOf(item(separate({ acquiredOn: day('2027-12-05') }, [kitchenItem({}, '2027-04-28')])), 2027).amount)).toBe('50.00');
    expect(amount(yearOf(item(separate({ acquiredOn: day('2027-01-02') })), 2027).amount)).toBe('600.00');
  });

  it('an item booked after acquiredOn: the same year no flag, the next year LATER_ITEM_TO_VERIFY', () => {
    expect(codes(item(separate({}, [kitchenItem({}, '2027-11-30')])).flags)).toEqual([]);
    expect(item(separate({ acquiredOn: day('2027-12-20') }, [kitchenItem({}, '2028-01-10')])).flags).toEqual([
      { code: 'LATER_ITEM_TO_VERIFY', details: { date: '2028-01-10', acquiredOn: '2027-12-20' } },
    ]);
  });

  it('NO_CAPITALIZED_ITEMS without a counting CAPITALIZED item; LINKED_ITEM_NOT_CAPITALIZED for a reclassified or anschaffungsnahe one', () => {
    expect(separate({}, []).reasons).toEqual([{ code: 'NO_CAPITALIZED_ITEMS', details: {} }]);
    const reclassified = separate({}, [kitchenItem({ treatment: 'DEDUCTIBLE', parts: [] })]);
    expect(codes(reclassified.reasons)).toEqual(['NO_CAPITALIZED_ITEMS']);
    expect(item(reclassified).reasons).toEqual([
      { code: 'LINKED_ITEM_NOT_CAPITALIZED', details: { counts: true, treatment: 'DEDUCTIBLE', anschaffungsnaheAcquisitionId: null } },
    ]);
    const both = separate({}, [kitchenItem(), capitalized(EXTENSION, '2027-04-28', '500.00', undefined, { anschaffungsnaheAcquisitionId: W })]);
    expect(both.status).toBe('PARTIAL');
    expect(items(both).map((c) => [c.componentId, c.status, codes(c.reasons)])).toEqual([
      [`TRANSACTION_SPLIT:${KITCHEN_SPLIT}`, 'COMPUTABLE', []],
      [`TRANSACTION_SPLIT:${EXTENSION}`, 'NOT_COMPUTABLE', ['LINKED_ITEM_NOT_CAPITALIZED']],
    ]);
  });

  it('GWG_THRESHOLD_MAY_APPLY (informative) at 800.00 and not at 800.01, by the gross cost or the net amounts', () => {
    expect(codes(separate({}, [kitchenItem({}, '2027-04-28', '800.00')]).flags)).toEqual(['GWG_THRESHOLD_MAY_APPLY']);
    expect(codes(separate({}, [kitchenItem({}, '2027-04-28', '800.01')]).flags)).toEqual([]);
    expect(codes(separate({}, [kitchenItem({ netAmount: eur('800.00') }, '2027-04-28', '952.00')]).flags)).toEqual(['GWG_THRESHOLD_MAY_APPLY']);
    expect(codes(separate({}, [kitchenItem({ netAmount: eur('800.01') }, '2027-04-28', '952.01')]).flags)).toEqual([]);
    const s = separate({}, [kitchenItem({}, '2027-04-28', '800.00')]);
    expect(s.review.info).toContainEqual({ code: 'GWG_THRESHOLD_MAY_APPLY', count: 1 });
    expect(s.flags[0]?.details).toMatchObject({ netThreshold: '800.00', grossCost: { amount: '800.00', currency: 'EUR' }, netCost: null });
  });

  it('NO_APPLICABLE_RULE for acquiredOn in 2022, in every year (decided 2026-10-31)', () => {
    const c = item(separate({ acquiredOn: day('2022-12-01') }, [kitchenItem({}, '2022-12-05')]));
    expect(c.reasons).toEqual([{ code: 'NO_APPLICABLE_RULE', details: { acquiredOn: '2022-12-01', supportedFrom: '2023-01-01' } }]);
    expect(c.years.every((y) => y.amount === null)).toBe(true);
  });

  it('the asset’s reasons: VOID and not confirmed stop it; no COMPLETION_YEAR_MISSING and no OWNER_WITHOUT_ACQUISITION', () => {
    expect(codes(separate({ status: 'VOID', reviewState: 'UNREVIEWED' }).reasons)).toEqual(['ASSET_VOID', 'ASSET_NOT_CONFIRMED']);
    expect(separate().years.flatMap((y) => codes(y.flags))).not.toContain('OWNER_WITHOUT_ACQUISITION');
  });
});

describe('the building and the separate asset never share an item (§59B "Never twice")', () => {
  const kitchenLink = { assetId: kitchen().id, sourceType: 'TRANSACTION_SPLIT' as const, sourceId: KITCHEN_SPLIT, sourcePosition: null };
  const all = [repair(), capitalized(KITCHEN_SPLIT, '2027-04-28', '6000.00')];

  it('a linked item leaves the building’s basis and is listed in excludedItems; after a void (no ACTIVE link) it is back', () => {
    const linked = derive(acc8({ from: 2027, to: 2027, capitalizedItems: all, links: [kitchenLink] }));
    expect(items(linked).map((c) => c.componentId)).toEqual([`TRANSACTION_SPLIT:${REPAIR}`]);
    expect(linked.excludedItems).toEqual([{ componentId: `TRANSACTION_SPLIT:${KITCHEN_SPLIT}`, separateAssetId: kitchen().id }]);
    const voided = derive(acc8({ from: 2027, to: 2027, capitalizedItems: all, links: [] }));
    expect(
      items(voided)
        .map((c) => c.componentId)
        .sort(),
    ).toEqual([`TRANSACTION_SPLIT:${KITCHEN_SPLIT}`, `TRANSACTION_SPLIT:${REPAIR}`]);
    expect(voided.excludedItems).toEqual([]);
  });

  it('every capitalised item is a component of exactly one asset, and the item components start in the year of their date', () => {
    const building = derive(acc8({ from: 2027, to: 2028, capitalizedItems: [...all, use()], links: [kitchenLink] }));
    const separate = derive(acc8({ asset: kitchen({ items: [kitchenLink] }), from: 2027, to: 2028, capitalizedItems: [...all, use()] }));
    const ids = [...items(building), ...items(separate)].map((c) => c.componentId).sort();
    expect(ids).toEqual([`TRANSACTION_SPLIT:${KITCHEN_SPLIT}`, `TRANSACTION_SPLIT:${REPAIR}`, `WEG_ASSESSMENT_USE:${USE}:1`].sort());
    for (const c of items(building)) expect(c.years[0]?.year).toBe(Number(c.source.date?.slice(0, 4)));
  });
});
