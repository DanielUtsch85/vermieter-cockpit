import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, centsOf, moneyOfCents, type BusinessDate } from '../../shared/index.js';
import { yearOf } from './cash-timing.js';
import type { TaxListItem, TaxMeaning } from './classification.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import { NO_DEPRECIATION, afaOf, componentOfItem, type TaxYearDepreciation } from './tax-year-depreciation.js';
import { UNCHANGED, asset, component, depreciationOf, flag, part } from './tax-year-depreciation.test-support.js';
import {
  NOT_OWNED,
  TAX_YEAR_ITEM_LIMIT,
  WERBUNGSKOSTEN_LINES,
  buildTaxYearView,
  reviewOf,
  type TaxYearRead,
  type TaxYearView,
  type ViewOwnership,
} from './tax-year-view.js';
import type { TaxCategory, Treatment } from './vocabulary.js';

/**
 * VC-8-05 (api-design.md §58C "VC-8-05: the AfA in the view"; decided 2026-10-31, second set: the cap counts the AfA
 * components, two lines, `RECORDED_VERSION_NOT_REPRODUCIBLE` open; third set via #203: the view does not read the
 * recording switch, `DEPRECIATION_SCHEDULE_NOT_RECORDED` keeps every year with AfA open): the three statuses and bases,
 * each gap, `NO_ASSET`, `OWNER_WITHOUT_ACQUISITION` as a gap, the two lines, the result moved by exactly the AfA, the
 * schedule's parts taken as given (owners + `NOT_OWNED` = the property), the owner level, `capitalized.component`, the
 * review and `final`, `ruleVersions` and the cap. Pure; synthetic figures and ids only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2029-10-15');
const PR = '0000bbbb-0000-4000-8000-000000000001';
const [A, B, C] = ['a', 'b', 'c'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000000`) as [string, string, string];
const BUILDING = '0000bbbb-0000-4000-8000-000000000010';
const KITCHEN = '0000bbbb-0000-4000-8000-000000000011';
const W = 'ACQUISITION:0000bbbb-0000-4000-8000-000000000002';
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const own = (party: string, n: number, d: number, from = '2026-07-01'): ViewOwnership => ({
  id: `own-${party}`,
  partyId: party,
  share: { numerator: n, denominator: d },
  validFrom: day(from),
  validUntil: null,
});
const OWNERS = [own(A, 3, 5), own(B, 2, 5)];

/** A confirmed cash split of `year` (USER_CONFIRMED, so no attribution flag stays open). */
function cash(amount: string, taxCategory: TaxCategory, treatment: Treatment, bookingDate = '2027-03-10', sourceId = id()): TaxListItem {
  const direction = ['RENT', 'OPERATING_COST_ADVANCES'].includes(taxCategory) ? 'INFLOW' : 'OUTFLOW';
  const meaning: TaxMeaning = {
    splitId: sourceId,
    sourceId,
    sourceType: 'TRANSACTION_SPLIT',
    transactionId: id(),
    position: 1,
    bookingDate: day(bookingDate),
    direction,
    amount: eur(amount),
    financialCategoryCode: 'X',
    categoryType: 'OPERATING_EXPENSE',
    propertyReferenceId: PR,
    transactionStatus: 'CONFIRMED',
    correctionRole: null,
    counts: true,
    taxCategory,
    treatment,
    reviewState: 'USER_CONFIRMED',
    origin: 'CLASSIFICATION',
    rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
    classificationId: id(),
    taxYear: yearOf(day(bookingDate)),
    attribution: {
      rule: { ruleCode: 'DE_CASH_TIMING', version: 1 },
      bookingYear: yearOf(day(bookingDate)),
      proposedYear: yearOf(day(bookingDate)),
      overridden: false,
    },
    refund: null,
    netAmount: null,
    treatmentRule: null,
    distribution: null,
    suggestion: null,
    flags: [],
  };
  return { ...meaning, yearAmount: eur(amount) };
}

const readOf = (depreciation: TaxYearDepreciation, items: readonly TaxListItem[] = [], ownerships: readonly ViewOwnership[] = OWNERS): TaxYearRead => ({
  propertyReferenceId: PR,
  ownerPartyFound: null,
  sources: items.map((item) => ({ item, listed: true })),
  unattributedDeposits: [],
  ownerships,
  checks: [],
  attribution: { references: [], candidates: [] },
  allocatedLoanInterest: [],
  loanAllocationSets: new Map(),
  depreciation,
});
function viewOf(read: TaxYearRead, ownerPartyId: string | null = null): TaxYearView {
  const outcome = buildTaxYearView(read, { year: read.depreciation.year, ownerPartyId, today, registry: TAX_RULES });
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
}
const amount = (m: Money | null | undefined) => m?.amount ?? null;
const afaLine = <T extends { readonly line: string }>(v: { readonly werbungskosten: { readonly afaLines?: readonly T[] } }, line: string): T | undefined =>
  v.werbungskosten.afaLines?.find((l) => l.line === line);
const codes = (flags: readonly { code: string }[]) => flags.map((f) => f.code);

/** ACC8 2026: the purchase's parts at 3/5 and 2/5 of 6/12 of 5,088.00 (§58C Example 1). */
const purchase2026 = (recording = {}) =>
  depreciationOf(2026, [asset(BUILDING, [component(W, [part(A, '1526.40', { share: '3/5' }), part(B, '1017.60', { share: '2/5' })])], { recording })]);
/** ACC8 2027 (§58C Example 2): the purchase, the repair (an item of the building) and the kitchen (a separate asset). */
const REPAIR = { sourceType: 'TRANSACTION_SPLIT', sourceId: '0000bbbb-0000-4000-8000-000000000071', sourcePosition: null };
const KITCHEN_SPLIT = { sourceType: 'TRANSACTION_SPLIT', sourceId: '0000bbbb-0000-4000-8000-000000000072', sourcePosition: null };
const acc8of2027 = (purchaseReasons: ReturnType<typeof flag>[] = []) =>
  depreciationOf(2027, [
    asset(BUILDING, [
      component(
        W,
        purchaseReasons.length > 0
          ? [part(A, null, { reasons: purchaseReasons }), part(B, null, { reasons: purchaseReasons })]
          : [part(A, '3052.80', { share: '3/5' }), part(B, '2035.20', { share: '2/5' })],
        { reasons: purchaseReasons },
      ),
      component(`TRANSACTION_SPLIT:${REPAIR.sourceId}`, [part(A, '428.40'), part(B, '285.60')], {
        kind: 'CAPITALIZED_ITEM',
        source: REPAIR,
        flags: [flag('SUBSEQUENT_COST_START_TO_VERIFY'), flag('ANSCHAFFUNGSNAHE_CAPITALIZED', 'INFORMATIVE')],
      }),
    ]),
    asset(
      KITCHEN,
      [
        component(`TRANSACTION_SPLIT:${KITCHEN_SPLIT.sourceId}`, [part(A, '270.00'), part(B, '180.00')], {
          kind: 'CAPITALIZED_ITEM',
          source: KITCHEN_SPLIT,
          rule: { ruleCode: 'DE_AFA_MOVABLE_LINEAR', version: 1 },
        }),
      ],
      {
        assetType: 'SEPARATE_ASSET',
      },
    ),
  ]);

describe('VC-8-05: statuses, bases and gaps (§58C "The `depreciation` block")', () => {
  it('AVAILABLE: AFTER_DEPRECIATION, the AfA in the Werbungskosten, no status flag; 0.00 before every start, without a flag', () => {
    const v = viewOf(readOf(purchase2026(), [cash('1100.00', 'RENT', 'INCOME', '2026-07-03'), cash('210.00', 'WEG_HAUSGELD', 'DEDUCTIBLE', '2026-07-05')]));
    expect([v.depreciation.status, amount(v.depreciation.amount), v.result.basis, amount(v.result.amount)]).toEqual([
      'AVAILABLE',
      '2544.00',
      'AFTER_DEPRECIATION',
      '-1654.00',
    ]);
    expect(amount(v.werbungskosten.total)).toBe('2754.00');
    expect(codes(v.flags)).toEqual(['DEPRECIATION_SCHEDULE_NOT_RECORDED']);
    expect(v.depreciation).toMatchObject({ gaps: [], note: 'Ergebnis nach AfA.' });
    // Before every start: the asset has nothing active, the AfA is 0.00, AVAILABLE, no flag, and the year can be final.
    const before = viewOf(readOf(depreciationOf(2025, [asset(BUILDING, [])]), [], []));
    expect([before.depreciation.status, amount(before.depreciation.amount), before.depreciation.assets, before.flags, before.review.final]).toEqual([
      'AVAILABLE',
      '0.00',
      [],
      [],
      true,
    ]);
  });

  it('PARTIAL: a gap with an item → PARTIAL_DEPRECIATION, DEPRECIATION_INCOMPLETE (open) with the gaps; only the computed AfA', () => {
    const v = viewOf(readOf(acc8of2027([flag('ALLOCATION_NOT_CONFIRMED')])));
    expect([v.depreciation.status, v.result.basis, amount(v.depreciation.amount)]).toEqual(['PARTIAL', 'PARTIAL_DEPRECIATION', '1164.00']);
    expect(v.depreciation.gaps).toEqual([
      { code: 'ALLOCATION_NOT_CONFIRMED', assetId: BUILDING, componentId: W, ownerPartyIds: [A, B], details: { reasons: ['ALLOCATION_NOT_CONFIRMED'] } },
    ]);
    expect(v.flags[0]).toEqual({ code: 'DEPRECIATION_INCOMPLETE', details: { gaps: v.depreciation.gaps } });
    expect(v.review.open).toContainEqual({ code: 'DEPRECIATION_INCOMPLETE', count: 1 });
    expect(v.review.open).toContainEqual({ code: 'ALLOCATION_NOT_CONFIRMED', count: 1 });
    expect(v.depreciation.note).toBe('Ergebnis nach teilweiser AfA; nicht berechnete Teile siehe gaps.');
    // §58C Example 4, PARTIAL: A 428.40 + 270.00, B 285.60 + 180.00.
    expect(v.owners?.map((o) => [amount(afaLine(o, 'AFA_BUILDING')?.total), amount(afaLine(o, 'AFA_SEPARATE_ASSETS')?.total), o.result.basis])).toEqual([
      ['428.40', '270.00', 'PARTIAL_DEPRECIATION'],
      ['285.60', '180.00', 'PARTIAL_DEPRECIATION'],
    ]);
  });

  it('DEPRECIATION_NOT_AVAILABLE: gaps only → BEFORE_DEPRECIATION, amount null, the flag (open); nothing estimated', () => {
    const dep = depreciationOf(2026, [
      asset(BUILDING, [
        component(W, [part(A, null, { reasons: [flag('ALLOCATION_NOT_CONFIRMED')] }), part(B, null, { reasons: [flag('ALLOCATION_NOT_CONFIRMED')] })], {
          reasons: [flag('ALLOCATION_NOT_CONFIRMED')],
        }),
      ]),
    ]);
    const v = viewOf(readOf(dep, [cash('1100.00', 'RENT', 'INCOME', '2026-07-03')]));
    expect([v.depreciation.status, v.depreciation.amount, v.result.basis, amount(v.result.amount)]).toEqual([
      'DEPRECIATION_NOT_AVAILABLE',
      null,
      'BEFORE_DEPRECIATION',
      '1100.00',
    ]);
    expect(v.werbungskosten.afaLines?.map((l) => [l.line, amount(l.total), l.itemCount])).toEqual([
      ['AFA_BUILDING', '0.00', 0],
      ['AFA_SEPARATE_ASSETS', '0.00', 0],
    ]);
    expect(codes(v.flags)).toEqual(['DEPRECIATION_NOT_AVAILABLE', 'DEPRECIATION_SCHEDULE_NOT_RECORDED']);
    expect(v.depreciation.assets).toEqual([expect.objectContaining({ status: 'DEPRECIATION_NOT_AVAILABLE', amount: null, itemCount: 0 })]);
    expect(v.depreciation.note).toBe('Ergebnis vor AfA; die AfA ist nicht berechenbar, siehe gaps.');
  });

  it('each gap reason alone keeps the year open; an asset reason is one gap without a component; DISPOSAL_DATE_MISSING for the owner only', () => {
    for (const code of [
      'ACQUISITION_NOT_CONFIRMED',
      'NO_ALLOCATION',
      'ALLOCATION_NOT_CONFIRMED',
      'NO_BUILDING',
      'USEFUL_LIFE_NOT_CONFIRMED',
      'HISTORICAL_RULE_NOT_SUPPORTED',
      'DEPRECIATION_METHOD_UNKNOWN',
      'NO_APPLICABLE_RULE',
      'BUYER_ALREADY_OWNER',
      'TRANSFER_DATE_MISSING',
      'ITEM_CLASSIFICATION_NEEDS_REVIEW',
      'LINKED_ITEM_NOT_CAPITALIZED',
    ]) {
      const dep = depreciationOf(2026, [
        asset(BUILDING, [component(W, [part(A, null, { reasons: [flag(code)] })], { reasons: [flag(code)] })], { recording: UNCHANGED }),
      ]);
      const v = viewOf(readOf(dep));
      expect([v.depreciation.gaps.map((g) => g.code), v.review.open.map((o) => o.code), v.review.final], code).toEqual([
        [code],
        ['DEPRECIATION_NOT_AVAILABLE', code],
        false,
      ]);
    }
    for (const code of ['ASSET_NOT_CONFIRMED', 'COMPLETION_YEAR_MISSING', 'NO_CAPITALIZED_ITEMS']) {
      const reasons = [flag(code)];
      const dep = depreciationOf(2026, [asset(BUILDING, [component(W, [part(A, null, { reasons })], { reasons: [] })], { reasons, recording: UNCHANGED })]);
      expect(viewOf(readOf(dep)).depreciation.gaps, code).toEqual([
        { code, assetId: BUILDING, componentId: null, ownerPartyIds: [], details: { reasons: [code] } },
      ]);
    }
    const disposal = depreciationOf(2026, [
      asset(BUILDING, [component(W, [part(A, '1526.40'), part(B, null, { reasons: [flag('DISPOSAL_DATE_MISSING')] })])], { recording: UNCHANGED }),
    ]);
    const v = viewOf(readOf(disposal));
    expect([v.depreciation.status, amount(v.depreciation.amount), v.depreciation.gaps.map((g) => [g.code, g.ownerPartyIds])]).toEqual([
      'PARTIAL',
      '1526.40',
      [['DISPOSAL_DATE_MISSING', [B]]],
    ]);
    expect([viewOf(readOf(disposal), A).depreciation.status, viewOf(readOf(disposal), B).depreciation.status]).toEqual([
      'AVAILABLE',
      'DEPRECIATION_NOT_AVAILABLE',
    ]);
  });

  it('NO_ASSET: with a purchase, with a capitalised item, with an Ownership only; none before all of them', () => {
    for (const withoutAsset of [
      { acquisitionIds: ['w'], items: [], ownershipInYear: false },
      { acquisitionIds: [], items: [REPAIR], ownershipInYear: false },
      { acquisitionIds: [], items: [], ownershipInYear: true },
    ]) {
      const v = viewOf(readOf(depreciationOf(2026, [], withoutAsset)));
      expect([v.depreciation.status, v.depreciation.gaps, v.result.basis, codes(v.flags), v.review.final]).toEqual([
        'DEPRECIATION_NOT_AVAILABLE',
        [{ code: 'NO_ASSET', assetId: null, componentId: null, ownerPartyIds: [], details: withoutAsset }],
        'BEFORE_DEPRECIATION',
        ['DEPRECIATION_NOT_AVAILABLE'],
        false,
      ]);
    }
    const none = viewOf(readOf(depreciationOf(2025, [], { acquisitionIds: [], items: [], ownershipInYear: false }), [], []));
    expect([none.depreciation.status, none.depreciation.gaps, none.review.final]).toEqual(['AVAILABLE', [], true]);
  });

  it('two assets in different states: each asset’s status from its own gaps; the building AVAILABLE, the unconfirmed separate asset not available, the year PARTIAL', () => {
    const notConfirmed = [flag('ASSET_NOT_CONFIRMED')];
    const dep = depreciationOf(2027, [
      asset(BUILDING, [component(W, [part(A, '3052.80'), part(B, '2035.20')])], { recording: UNCHANGED }),
      asset(
        KITCHEN,
        [
          component(`TRANSACTION_SPLIT:${KITCHEN_SPLIT.sourceId}`, [part(A, null, { reasons: notConfirmed }), part(B, null, { reasons: notConfirmed })], {
            kind: 'CAPITALIZED_ITEM',
            source: KITCHEN_SPLIT,
            reasons: notConfirmed,
          }),
        ],
        {
          assetType: 'SEPARATE_ASSET',
          reasons: notConfirmed,
          recording: UNCHANGED,
        },
      ),
    ]);
    const v = viewOf(readOf(dep));
    expect(v.depreciation.assets.map((x) => [x.assetId, x.status, amount(x.amount), x.itemCount])).toEqual([
      [BUILDING, 'AVAILABLE', '5088.00', 1],
      [KITCHEN, 'DEPRECIATION_NOT_AVAILABLE', null, 0],
    ]);
    expect([v.depreciation.status, amount(v.depreciation.amount), v.result.basis]).toEqual(['PARTIAL', '5088.00', 'PARTIAL_DEPRECIATION']);
    expect(v.depreciation.gaps).toEqual([
      { code: 'ASSET_NOT_CONFIRMED', assetId: KITCHEN, componentId: null, ownerPartyIds: [], details: { reasons: ['ASSET_NOT_CONFIRMED'] } },
    ]);
    expect(codes(v.flags)).toEqual(['DEPRECIATION_INCOMPLETE']);
    expect([afaLine(v, 'AFA_BUILDING')?.total, afaLine(v, 'AFA_SEPARATE_ASSETS')?.total]).toEqual([eur('5088.00'), eur('0.00')]);
  });

  it('OWNER_WITHOUT_ACQUISITION: one gap per asset (not a year flag), counted once; the heir’s level not available, A’s available', () => {
    const heir = flag('OWNER_WITHOUT_ACQUISITION', 'OPEN', [C]);
    const dep = depreciationOf(2026, [
      asset(BUILDING, [component(W, [part(A, '1526.40')])], { yearFlags: [{ ...heir, details: { ownerPartyId: C } }], recording: UNCHANGED }),
    ]);
    const read = readOf(dep, [], [own(A, 3, 5), own(C, 2, 5)]);
    const v = viewOf(read);
    expect([v.depreciation.status, v.depreciation.gaps]).toEqual([
      'PARTIAL',
      [{ code: 'OWNER_WITHOUT_ACQUISITION', assetId: BUILDING, componentId: null, ownerPartyIds: [C], details: { owners: [{ ownerPartyId: C }] } }],
    ]);
    expect(codes(v.flags)).toEqual(['DEPRECIATION_INCOMPLETE']);
    expect(v.review.open).toEqual([
      { code: 'DEPRECIATION_INCOMPLETE', count: 1 },
      { code: 'OWNER_WITHOUT_ACQUISITION', count: 1 },
    ]);
    expect([viewOf(read, C).depreciation.status, viewOf(read, C).result.basis]).toEqual(['DEPRECIATION_NOT_AVAILABLE', 'BEFORE_DEPRECIATION']);
    expect([viewOf(read, A).depreciation.status, viewOf(read, A).review.final]).toEqual(['AVAILABLE', true]);
  });
});

describe('VC-8-05: the lines AFA_BUILDING and AFA_SEPARATE_ASSETS (decided 2026-10-31, Q4)', () => {
  it('both present and empty without AfA, after OTHER_EXPENSE, `line` set and `taxCategory` null; a line’s total is its items; a refund negative', () => {
    const empty = viewOf(readOf(NO_DEPRECIATION(2027)));
    expect(empty.werbungskosten.lines.at(-1)?.line).toBe(WERBUNGSKOSTEN_LINES.at(-1));
    expect(empty.werbungskosten.lines.at(-1)?.line).toBe('OTHER_EXPENSE');
    expect(empty.werbungskosten.lines.every((l) => l.line === l.taxCategory)).toBe(true);
    expect(empty.werbungskosten.afaLines).toEqual([
      { line: 'AFA_BUILDING', taxCategory: null, total: eur('0.00'), itemCount: 0, subtotals: null, items: [] },
      { line: 'AFA_SEPARATE_ASSETS', taxCategory: null, total: eur('0.00'), itemCount: 0, subtotals: null, items: [] },
    ]);
    const refund = { sourceType: 'TRANSACTION_SPLIT', sourceId: id(), sourcePosition: null };
    const v = viewOf(
      readOf({
        ...acc8of2027(),
        assets: [
          ...acc8of2027()
            .assets.slice(0, 1)
            .map((a) => ({
              ...a,
              components: [
                ...a.components,
                component(`TRANSACTION_SPLIT:${refund.sourceId}`, [part(A, '-12.00'), part(B, '-8.00')], { kind: 'CAPITALIZED_ITEM', source: refund }),
              ],
            })),
          ...acc8of2027().assets.slice(1),
        ],
      }),
    );
    const building = afaLine(v, 'AFA_BUILDING');
    expect(building?.items.map((i) => [i.kind, amount(i.amount)])).toEqual([
      ['ACQUISITION', '5088.00'],
      ['CAPITALIZED_ITEM', '714.00'],
      ['CAPITALIZED_ITEM', '-20.00'],
    ]);
    expect(amount(building?.total)).toBe('5782.00');
    expect(building?.items.reduce((s, i) => s + centsOf(i.amount), 0n)).toBe(centsOf(building?.total as Money));
    // The linked item in AFA_SEPARATE_ASSETS, not in AFA_BUILDING: a component appears once across both lines.
    expect(afaLine(v, 'AFA_SEPARATE_ASSETS')?.items.map((i) => i.componentId)).toEqual([`TRANSACTION_SPLIT:${KITCHEN_SPLIT.sourceId}`]);
    // Never a cash item: no transactionId, no direction.
    expect(building?.items.every((i) => !('transactionId' in i) && !('direction' in i))).toBe(true);
  });

  it('the result moved by exactly the AfA (random inputs): result with = result without − the AfA lines; the cash lines unchanged', () => {
    let state = 7;
    const rnd = (n: number) => (state = (state * 1103515245 + 12345) % 2147483648) % n;
    for (let round = 0; round < 200; round++) {
      const items = Array.from({ length: rnd(5) }, () =>
        cash(`${rnd(5000)}.${String(rnd(100)).padStart(2, '0')}`, rnd(2) === 0 ? 'RENT' : 'MAINTENANCE', rnd(2) === 0 ? 'INCOME' : 'DEDUCTIBLE'),
      );
      const fixed = items.map((i) => ({ ...i, treatment: (i.taxCategory === 'RENT' ? 'INCOME' : 'DEDUCTIBLE') as Treatment }));
      const parts = (n: number) => Array.from({ length: n }, (_, k) => part([A, B, C][k] as string, `${rnd(3000) - 200}.${String(rnd(100)).padStart(2, '0')}`));
      const dep = depreciationOf(2027, [
        asset(BUILDING, [component(W, parts(1 + rnd(3)))], { recording: UNCHANGED }),
        asset(KITCHEN, [component('TRANSACTION_SPLIT:k', parts(1 + rnd(3)), { kind: 'CAPITALIZED_ITEM', source: KITCHEN_SPLIT })], {
          assetType: 'SEPARATE_ASSET',
          recording: UNCHANGED,
        }),
      ]);
      const with_ = viewOf(readOf(dep, fixed, [own(A, 1, 3), own(B, 1, 3), own(C, 1, 3)]));
      const without = viewOf(readOf(NO_DEPRECIATION(2027), fixed, [own(A, 1, 3), own(B, 1, 3), own(C, 1, 3)]));
      const afa = (with_.werbungskosten.afaLines ?? []).reduce((s, l) => s + centsOf(l.total), 0n);
      expect(centsOf(with_.result.amount)).toBe(centsOf(without.result.amount) - afa);
      expect(with_.werbungskosten.lines).toEqual(without.werbungskosten.lines);
      expect(with_.einnahmen).toEqual(without.einnahmen);
      expect(with_.result.basis).not.toBe('BEFORE_DEPRECIATION');
    }
  });
});

describe('VC-8-05: per owner, the schedule’s parts never split again (P8-D8)', () => {
  it('the parts taken as given (not the shares’ largest remainder); owners + NOT_OWNED = the property for each AfA item, line, the Werbungskosten and the result', () => {
    // Two purchases at different prices: A's and B's parts are not 1/2 each of the line, though the shares are.
    const dep = depreciationOf(2027, [
      asset(
        BUILDING,
        [
          component(W, [part(A, '1000.01'), part(B, '0.99')]),
          component('TRANSACTION_SPLIT:x', [part(A, '10.00'), part(null, '3.33')], { kind: 'CAPITALIZED_ITEM', source: REPAIR }),
        ],
        {
          recording: UNCHANGED,
        },
      ),
    ]);
    const v = viewOf(readOf(dep, [cash('100.00', 'RENT', 'INCOME')], [own(A, 1, 2), own(B, 1, 4)]));
    expect(v.owners?.map((o) => [o.ownerPartyId, amount(afaLine(o, 'AFA_BUILDING')?.total)])).toEqual([
      [A, '1010.01'],
      [B, '0.99'],
    ]);
    expect(amount(v.notOwned === null ? null : afaLine(v.notOwned, 'AFA_BUILDING')?.total)).toBe('3.33');
    let state = 3;
    const rnd = (n: number) => (state = (state * 1103515245 + 12345) % 2147483648) % n;
    for (let round = 0; round < 150; round++) {
      const people = [A, B, C, null];
      const comps = Array.from({ length: 1 + rnd(4) }, (_, k) =>
        component(
          `C:${k}`,
          people.filter(() => rnd(3) > 0).map((p) => part(p, `${rnd(4000) - 300}.${String(rnd(100)).padStart(2, '0')}`)),
          {
            kind: 'CAPITALIZED_ITEM',
            source: { sourceType: 'TRANSACTION_SPLIT', sourceId: `s${k}`, sourcePosition: null },
          },
        ),
      ).filter((c) => c.parts.length > 0);
      const read = readOf(
        depreciationOf(2027, [asset(BUILDING, comps, { recording: UNCHANGED })]),
        [cash('77.77', 'RENT', 'INCOME')],
        [own(A, 1, 3), own(B, 1, 3), own(C, 1, 4)],
      );
      const r = viewOf(read);
      const ownerViews = [A, B, C].map((p) => viewOf(read, p));
      const levels = [...(r.owners ?? []), ...(r.notOwned === null ? [] : [r.notOwned])];
      const sum = (pick: (t: (typeof levels)[number]) => Money | undefined) => levels.reduce((s, t) => s + centsOf(pick(t) ?? eur('0.00')), 0n);
      for (const line of ['AFA_BUILDING', 'AFA_SEPARATE_ASSETS']) expect(sum((t) => afaLine(t, line)?.total)).toBe(centsOf(afaLine(r, line)?.total as Money));
      expect(sum((t) => t.werbungskosten.total)).toBe(centsOf(r.werbungskosten.total));
      expect(sum((t) => t.result.amount)).toBe(centsOf(r.result.amount));
      for (const item of afaLine(r, 'AFA_BUILDING')?.items ?? []) {
        const perOwner = ownerViews.map((o) => afaLine(o, 'AFA_BUILDING')?.items.find((i) => i.componentId === item.componentId)?.amount);
        const notOwned = comps.find((c) => c.componentId === item.componentId)?.parts.find((p) => p.ownerPartyId === null)?.amount ?? null;
        expect([...perOwner, notOwned].reduce((s, m) => s + (m === undefined || m === null ? 0n : centsOf(m)), 0n)).toBe(centsOf(item.amount));
      }
    }
  });

  it('the owner level: only the owner’s components and gaps; C DEPRECIATION_NOT_AVAILABLE while A is AVAILABLE and the property PARTIAL', () => {
    const C_ACQ = 'ACQUISITION:c';
    const dep = depreciationOf(2027, [
      asset(BUILDING, [
        component(W, [part(A, '3052.80', { share: '3/5', ownershipIds: ['own-a2', 'own-a1'] })]),
        component(C_ACQ, [part(C, null, { reasons: [flag('ALLOCATION_NOT_CONFIRMED')] })], { reasons: [flag('ALLOCATION_NOT_CONFIRMED')] }),
      ]),
    ]);
    const read = readOf(dep, [], [own(A, 3, 5), own(C, 2, 5)]);
    const [property, a, c] = [viewOf(read), viewOf(read, A), viewOf(read, C)];
    expect([property.depreciation.status, a.depreciation.status, c.depreciation.status]).toEqual(['PARTIAL', 'AVAILABLE', 'DEPRECIATION_NOT_AVAILABLE']);
    expect([a.result.basis, c.result.basis]).toEqual(['AFTER_DEPRECIATION', 'BEFORE_DEPRECIATION']);
    expect(afaLine(a, 'AFA_BUILDING')?.items).toEqual([
      expect.objectContaining({
        componentId: W,
        amount: eur('3052.80'),
        share: { ownershipId: 'own-a1', share: '3/5', amount: eur('3052.80'), ownershipIds: ['own-a1', 'own-a2'], partKey: `OWNER:${A}` },
        href: `/api/v1/depreciation-assets/${BUILDING}/schedule?from=2027&to=2027&ownerPartyId=${A}`,
      }),
    ]);
    expect([a.depreciation.gaps, c.depreciation.gaps.map((g) => g.componentId)]).toEqual([[], [C_ACQ]]);
    expect(afaLine(c, 'AFA_BUILDING')?.items).toEqual([]);
    expect(afaLine(property, 'AFA_BUILDING')?.items[0]).toMatchObject({
      share: null,
      href: `/api/v1/depreciation-assets/${BUILDING}/schedule?from=2027&to=2027`,
    });
  });
});

describe('VC-8-05: capitalized.component, the review, final, ruleVersions and the cap', () => {
  it('capitalized names its component: the building’s, the separate asset’s, a not-computable one, NO_ASSET; null on other items', () => {
    const repair = cash('35700.00', 'MAINTENANCE', 'CAPITALIZED', '2027-03-10', REPAIR.sourceId);
    const kitchen = cash('6000.00', 'OTHER_EXPENSE', 'CAPITALIZED', '2027-04-28', KITCHEN_SPLIT.sourceId);
    const v = viewOf(readOf(acc8of2027(), [repair, kitchen, cash('100.00', 'MAINTENANCE', 'DEDUCTIBLE')]));
    expect(v.capitalized.items.map((i) => i.component)).toEqual([
      { assetId: BUILDING, assetType: 'BUILDING', componentId: `TRANSACTION_SPLIT:${REPAIR.sourceId}`, computable: true, reasons: [] },
      { assetId: KITCHEN, assetType: 'SEPARATE_ASSET', componentId: `TRANSACTION_SPLIT:${KITCHEN_SPLIT.sourceId}`, computable: true, reasons: [] },
    ]);
    // Never twice: the items' amounts in capitalized (not summed), their AfA in the AfA lines.
    expect([amount(v.capitalized.total), amount(v.werbungskosten.total)]).toEqual(['41700.00', '6352.00']);
    expect(v.werbungskosten.lines.flatMap((l) => l.items).map((i) => i.component)).toEqual([undefined]);
    const notComputable = depreciationOf(2027, [
      asset(BUILDING, [], {
        componentIndex: [
          { componentId: `TRANSACTION_SPLIT:${REPAIR.sourceId}`, source: REPAIR, computable: false, reasons: [flag('ITEM_CLASSIFICATION_NEEDS_REVIEW')] },
        ],
      }),
    ]);
    expect(viewOf(readOf(notComputable, [repair])).capitalized.items[0]?.component).toEqual({
      assetId: BUILDING,
      assetType: 'BUILDING',
      componentId: `TRANSACTION_SPLIT:${REPAIR.sourceId}`,
      computable: false,
      reasons: [{ code: 'ITEM_CLASSIFICATION_NEEDS_REVIEW', details: {} }],
    });
    const noAsset = depreciationOf(2027, [], { acquisitionIds: [], items: [REPAIR], ownershipInYear: true });
    expect(componentOfItem(noAsset, { sourceType: 'TRANSACTION_SPLIT', sourceId: REPAIR.sourceId, sourcePosition: 1 })).toEqual({
      assetId: null,
      assetType: null,
      componentId: null,
      computable: false,
      reasons: [{ code: 'NO_ASSET', details: {} }],
    });
    expect(componentOfItem(acc8of2027(), { sourceType: 'TRANSACTION_SPLIT', sourceId: id(), sourcePosition: 1 })).toBeNull();
  });

  it('final true without an open flag; false with each recording flag, gap reason and open AfA flag alone; true again with each informative one', () => {
    const clean = (afaFlags: ReturnType<typeof flag>[] = [], recording: object = UNCHANGED, yearFlags: ReturnType<typeof flag>[] = []) =>
      viewOf(
        readOf(
          depreciationOf(2026, [asset(BUILDING, [component(W, [part(A, '1526.40'), part(B, '1017.60')], { flags: afaFlags })], { recording, yearFlags })]),
        ),
      );
    expect(clean().review).toMatchObject({ final: true, open: [], info: [] });
    for (const code of ['DEPRECIATION_SCHEDULE_NOT_RECORDED', 'DEPRECIATION_CHANGED_SINCE_RECORDED', 'RECORDED_VERSION_NOT_REPRODUCIBLE']) {
      const v = clean([], {
        ...UNCHANGED,
        state: code === 'DEPRECIATION_SCHEDULE_NOT_RECORDED' ? 'NOT_RECORDED' : 'CHANGED_SINCE_RECORDED',
        flags: [flag(code)],
      });
      expect([v.review.final, v.review.open], code).toEqual([false, [{ code, count: 1 }]]);
    }
    for (const code of [
      'USEFUL_LIFE_NOT_SHORTER',
      'USEFUL_LIFE_START_TO_VERIFY',
      'DISPOSAL_YEAR_TO_VERIFY',
      'HISTORICAL_RULE_TO_VERIFY',
      'SHARE_REDUCTION_SPLIT_TO_VERIFY',
      'SUBSEQUENT_COST_START_TO_VERIFY',
      'SUBSEQUENT_COST_END_TO_VERIFY',
      'SUBSEQUENT_COST_SHORTER_LIFE_TO_VERIFY',
      'CAPITALIZED_YEAR_DIFFERS',
      'CAPITALIZED_ITEM_NOT_OWNED',
      'REFUND_EXCEEDS_CAPITALIZED',
      'LATER_ITEM_TO_VERIFY',
      'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE',
    ]) {
      expect(clean([flag(code)]).review, code).toMatchObject({ final: false, open: [{ code, count: 1 }] });
    }
    for (const code of [
      'SHORTER_USEFUL_LIFE',
      'ACQUISITION_COST_UNPAID',
      'OWNER_SHARE_CHANGED',
      'ANSCHAFFUNGSNAHE_CAPITALIZED',
      'CAPITALIZED_REFUND',
      'DATE_IS_BOOKING_DATE',
      'WITHDRAWAL_DATE_ASSUMED',
    ]) {
      expect(clean([flag(code, 'INFORMATIVE')]).review, code).toMatchObject({ final: true, open: [], info: [{ code, count: 1 }] });
    }
    const gwg = clean([], UNCHANGED, [flag('GWG_THRESHOLD_MAY_APPLY', 'INFORMATIVE')]);
    expect([gwg.review.final, gwg.flags]).toEqual([true, [{ code: 'GWG_THRESHOLD_MAY_APPLY', details: { assetId: BUILDING } }]]);
    // Phase 7's year flags and §58D's: each alone keeps an otherwise recorded year from being final.
    for (const code of [
      'ATTRIBUTION_INPUT_CHANGED',
      'ATTRIBUTION_HISTORY_INCONSISTENT',
      'OWNERSHIP_INCOMPLETE',
      'UNATTRIBUTED_ITEMS',
      'LOAN_INTEREST_NOT_ATTRIBUTED',
      'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL',
      'DEPRECIATION_NOT_AVAILABLE',
      'DEPRECIATION_INCOMPLETE',
    ]) {
      expect(reviewOf([{ code, details: {} }], [], []).final, code).toBe(false);
    }
    expect(reviewOf([], [], [[{ code: 'NO_ASSET', open: true }]]).open).toEqual([{ code: 'NO_ASSET', count: 1 }]);
  });

  it('§58C Example 2 (abridged): the flags, the review, the owners, and ruleVersions with both AfA rules and their itemCount', () => {
    const dep = acc8of2027();
    const changed = {
      code: 'DEPRECIATION_CHANGED_SINCE_RECORDED',
      level: 'OPEN' as const,
      details: { assetId: BUILDING, recorded: '5088.00', derived: '5802.00' },
      ownerPartyIds: [],
    };
    const read = readOf(
      {
        ...dep,
        assets: [
          {
            ...(dep.assets[0] as (typeof dep.assets)[number]),
            recording: { ...UNCHANGED, state: 'CHANGED_SINCE_RECORDED', versionNumber: 1, throughYear: 2027, flags: [changed] },
          },
          dep.assets[1] as (typeof dep.assets)[number],
        ],
      },
      [
        ...Array.from({ length: 12 }, (_, m) => cash('1100.00', 'RENT', 'INCOME', `2027-${String(m + 1).padStart(2, '0')}-03`)),
        ...Array.from({ length: 12 }, (_, m) => cash('250.00', 'OPERATING_COST_ADVANCES', 'INCOME', `2027-${String(m + 1).padStart(2, '0')}-03`)),
        ...Array.from({ length: 12 }, (_, m) => cash('210.00', 'WEG_HAUSGELD', 'DEDUCTIBLE', `2027-${String(m + 1).padStart(2, '0')}-05`)),
      ],
    );
    const v = viewOf(read);
    expect([
      amount(v.werbungskosten.total),
      amount(afaLine(v, 'AFA_BUILDING')?.total),
      amount(afaLine(v, 'AFA_SEPARATE_ASSETS')?.total),
      amount(v.result.amount),
      v.result.basis,
    ]).toEqual(['8772.00', '5802.00', '450.00', '7428.00', 'AFTER_DEPRECIATION']);
    expect(v.owners?.map((o) => [amount(o.werbungskosten.total), amount(o.result.amount)])).toEqual([
      ['5263.20', '4456.80'],
      ['3508.80', '2971.20'],
    ]);
    expect(codes(v.flags)).toEqual(['DEPRECIATION_CHANGED_SINCE_RECORDED', 'DEPRECIATION_SCHEDULE_NOT_RECORDED']);
    // The recorded figure only in the flag's details; the line shows the derived one.
    expect(v.flags[0]?.details).toMatchObject({ recorded: '5088.00', derived: '5802.00' });
    expect(v.review.open).toEqual([
      { code: 'DEPRECIATION_CHANGED_SINCE_RECORDED', count: 1 },
      { code: 'DEPRECIATION_SCHEDULE_NOT_RECORDED', count: 1 },
      { code: 'SUBSEQUENT_COST_START_TO_VERIFY', count: 1 },
    ]);
    expect(v.review.info).toEqual([{ code: 'ANSCHAFFUNGSNAHE_CAPITALIZED', count: 1 }]);
    expect(v.depreciation.assets.map((a) => [a.assetId, a.status, amount(a.amount), a.itemCount, a.recording?.state])).toEqual([
      [BUILDING, 'AVAILABLE', '5802.00', 2, 'CHANGED_SINCE_RECORDED'],
      [KITCHEN, 'AVAILABLE', '450.00', 1, 'NOT_RECORDED'],
    ]);
    expect(v.ruleVersions.filter((r) => r.ruleCode.startsWith('DE_AFA')).map((r) => [r.ruleCode, r.version, r.itemCount])).toEqual([
      ['DE_AFA_BUILDING_LINEAR', 2, 2],
      ['DE_AFA_MOVABLE_LINEAR', 1, 1],
    ]);
  });

  it('the cap counts the AfA components (decided 2026-10-31, Q1): 5,000 with them → the view; 5,001 → TAX_YEAR_TOO_LARGE', () => {
    const many = (n: number, gap = false) =>
      depreciationOf(2027, [
        asset(BUILDING, [
          ...Array.from({ length: n }, (_, k) =>
            component(`C:${k}`, [part(A, '1.00')], {
              kind: 'CAPITALIZED_ITEM',
              source: { sourceType: 'TRANSACTION_SPLIT', sourceId: `s${k}`, sourcePosition: null },
            }),
          ),
          ...(gap ? [component('C:gap', [part(A, null, { reasons: [flag('NO_ALLOCATION')] })], { reasons: [flag('NO_ALLOCATION')] })] : []),
        ]),
      ]);
    const cashItems = [cash('1.00', 'RENT', 'INCOME')];
    const run = (dep: TaxYearDepreciation) => buildTaxYearView(readOf(dep, cashItems), { year: 2027, ownerPartyId: null, today, registry: TAX_RULES });
    expect(run(many(TAX_YEAR_ITEM_LIMIT - 1)).kind).toBe('VIEW');
    expect(run(many(TAX_YEAR_ITEM_LIMIT))).toEqual({ kind: 'TAX_YEAR_TOO_LARGE', itemCount: 5001, limit: 5000 });
    // A gap with a component counts too.
    expect(run(many(TAX_YEAR_ITEM_LIMIT - 1, true))).toEqual({ kind: 'TAX_YEAR_TOO_LARGE', itemCount: 5001, limit: 5000 });
  });

  it('afaOf at NOT_OWNED: only the NOT_OWNED parts; owners’ AfA never the shares × the property’s AfA', () => {
    const dep = depreciationOf(2027, [
      asset(BUILDING, [component('C:1', [part(A, '7.00'), part(null, '0.01')], { kind: 'CAPITALIZED_ITEM', source: REPAIR })]),
    ]);
    expect(afaOf(dep, 'EUR', NOT_OWNED).lines.map((l) => amount(l.total))).toEqual(['0.01', '0.00']);
    expect(afaOf(dep, 'EUR', A).lines.map((l) => amount(l.total))).toEqual(['7.00', '0.00']);
    expect(moneyOfCents(afaOf(dep, 'EUR', undefined).totalCents, 'EUR')).toEqual(eur('7.01'));
  });
});
