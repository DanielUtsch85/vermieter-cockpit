import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import type { Direction } from '../ledger/index.js';
import { amendmentLists, attributionChanges, listBefore, type AttributionInput, type ReferenceHistory } from './attribution-changes.js';
import { refundOf, yearOf } from './cash-timing.js';
import type { TaxListItem, TaxMeaning } from './classification.js';
import type { DepositTaxMeaning } from './deposit-closing.js';
import { continuousOwners, distribute } from './distribution-82b.js';
import { TAX_RULES } from './rules/registry.js';
import {
  EINNAHMEN_LINES,
  NOT_OWNED,
  TAX_YEAR_ITEM_LIMIT,
  TAX_YEAR_PLACES,
  WERBUNGSKOSTEN_LINES,
  buildTaxYearView,
  flagIsOpen,
  foldPerOwner,
  participantsOn,
  placementOf,
  shareOut,
  type TaxYearRead,
  type TaxYearView,
  type ViewOwnership,
} from './tax-year-view.js';
import { TAX_CATEGORIES, TREATMENTS, treatmentFits, type Origin, type ReviewState, type TaxCategory, type Treatment } from './vocabulary.js';

/**
 * VC-7-04 (api-design.md §58C): the placement table, signs, `subtotals`, the per-owner rounding with its ties and the
 * property test that owners + `NOT_OWNED` = the property to the cent, the per-owner § 82b fold, `ATTRIBUTION_INPUT_CHANGED`
 * from the AuditRecords, the review levels and `final`. Synthetic figures and ids only.
 */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2026-10-30');
const PR = '0000aaaa-0000-4000-8000-000000000001';
const DEFAULTS = { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 };
const CASH = { ruleCode: 'DE_CASH_TIMING', version: 1 };
const D82B = { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 };
/** Parties A < B < C < D by id. */
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000000`) as [string, string, string, string];
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

interface SplitOptions {
  readonly amount: string;
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly direction?: Direction;
  readonly bookingDate?: string;
  readonly taxYear?: number;
  readonly reviewState?: ReviewState;
  readonly origin?: Origin;
  readonly refundOfYear?: number | null;
  readonly flags?: TaxMeaning['flags'];
  readonly sourceId?: string;
  readonly distributionYears?: number;
  readonly ownerships?: readonly ViewOwnership[];
  readonly counts?: boolean;
}

function split(o: SplitOptions): TaxListItem {
  const bookingDate = day(o.bookingDate ?? '2027-03-10');
  const direction = o.direction ?? (TAX_YEAR_PLACES[o.taxCategory] === 'EINNAHMEN' ? 'INFLOW' : 'OUTFLOW');
  const taxYear = o.taxYear ?? yearOf(bookingDate);
  const amount = eur(o.amount);
  const sourceId = o.sourceId ?? id();
  const distributed =
    o.distributionYears === undefined
      ? null
      : distribute({ amount, firstYear: taxYear, years: o.distributionYears, rule: D82B, ownerships: continuousOwners(o.ownerships ?? [], bookingDate) });
  const distribution = distributed?.distribution ?? null;
  const meaning: TaxMeaning = {
    splitId: sourceId,
    sourceId,
    sourceType: 'TRANSACTION_SPLIT',
    transactionId: id(),
    position: 1,
    bookingDate,
    direction,
    amount,
    financialCategoryCode: 'X',
    categoryType: 'OPERATING_EXPENSE',
    propertyReferenceId: PR,
    transactionStatus: 'CONFIRMED',
    correctionRole: null,
    counts: o.counts ?? true,
    taxCategory: o.taxCategory,
    treatment: o.treatment,
    reviewState: o.reviewState ?? 'SUGGESTED',
    origin: o.origin ?? 'DEFAULT',
    rule: DEFAULTS,
    classificationId: o.origin === 'CLASSIFICATION' ? id() : null,
    taxYear,
    attribution: { rule: CASH, bookingYear: yearOf(bookingDate), proposedYear: taxYear, overridden: false },
    refund: refundOf(direction, o.taxCategory, taxYear, null, o.refundOfYear ?? null).refund,
    netAmount: null,
    treatmentRule: distribution === null ? null : D82B,
    distribution,
    suggestion: null,
    flags: [...(o.flags ?? []), ...(distributed?.flags ?? [])],
  };
  return { ...meaning, yearAmount: amount };
}

const own = (party: string, share: string, from: string, until: string | null = null, ownershipId = id()): ViewOwnership => {
  const [n, d] = share.split('/').map(Number) as [number, number];
  return { id: ownershipId, partyId: party, share: { numerator: n, denominator: d }, validFrom: day(from), validUntil: until === null ? null : day(until) };
};

const readOf = (items: readonly TaxListItem[], ownerships: readonly ViewOwnership[] = [], extra: Partial<TaxYearRead> = {}): TaxYearRead => ({
  propertyReferenceId: PR,
  ownerPartyFound: null,
  sources: items.map((item) => ({ item, listed: true })),
  unattributedDeposits: [],
  ownerships,
  checks: [],
  attribution: { references: [], candidates: [] },
  ...extra,
});

function viewOf(read: TaxYearRead, year = 2027, ownerPartyId: string | null = null): TaxYearView {
  const outcome = buildTaxYearView(read, { year, ownerPartyId, today, registry: TAX_RULES });
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
}

const lineOf = (v: TaxYearView, taxCategory: TaxCategory) =>
  [...v.einnahmen.lines, ...v.werbungskosten.lines].find((l) => l.taxCategory === taxCategory) as TaxYearView['einnahmen']['lines'][number];
const amounts = (items: readonly { readonly lineAmount: Money | null }[]) => items.map((i) => i.lineAmount?.amount ?? null);
const codes = (flags: readonly { readonly code: string }[]) => flags.map((f) => f.code);

describe('the placement table (§58C)', () => {
  it('every taxCategory and fitting treatment goes to exactly one place', () => {
    for (const taxCategory of TAX_CATEGORIES) {
      for (const treatment of [...TREATMENTS, null] as const) {
        if (!treatmentFits(taxCategory, treatment)) continue;
        const placement = placementOf({ taxCategory, treatment, refund: null });
        const section = TAX_YEAR_PLACES[taxCategory];
        if (treatment === null) expect(placement).toEqual({ place: 'UNCLASSIFIED' });
        else if (treatment === 'NOT_RELEVANT') expect(placement).toEqual({ place: 'NOT_IN_VIEW' });
        else if (treatment === 'CAPITALIZED') expect(placement).toEqual({ place: 'CAPITALIZED', line: taxCategory });
        else expect(placement).toEqual({ place: 'LINE', section, line: taxCategory });
      }
    }
    // A refund of an earlier year goes to REFUNDS_OF_EARLIER_YEARS when DEDUCTIBLE; NOT_RELEVANT and CAPITALIZED keep their place.
    const earlier = { presentation: 'INCOME', line: 'REFUNDS_OF_EARLIER_YEARS' } as const;
    expect(placementOf({ taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', refund: earlier })).toEqual({
      place: 'LINE',
      section: 'EINNAHMEN',
      line: 'REFUNDS_OF_EARLIER_YEARS',
    });
    expect(placementOf({ taxCategory: 'MAINTENANCE', treatment: 'NOT_RELEVANT', refund: earlier })).toEqual({ place: 'NOT_IN_VIEW' });
    expect(placementOf({ taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED', refund: earlier })).toEqual({ place: 'CAPITALIZED', line: 'MAINTENANCE' });
  });

  it('the lines are fixed: every line in its section, in the order of the table, 0.00 without items', () => {
    const v = viewOf(readOf([]));
    expect(v.einnahmen.lines.map((l) => l.taxCategory)).toEqual([...EINNAHMEN_LINES]);
    expect(v.werbungskosten.lines.map((l) => l.taxCategory)).toEqual([...WERBUNGSKOSTEN_LINES]);
    for (const l of [...v.einnahmen.lines, ...v.werbungskosten.lines]) expect([l.total.amount, l.itemCount, l.items]).toEqual(['0.00', 0, []]);
    expect(lineOf(v, 'MAINTENANCE').subtotals).toEqual({ immediate: eur('0.00'), distributed82b: eur('0.00') });
    expect(lineOf(v, 'RENT').subtotals).toBeNull();
    expect(v.result).toEqual({ amount: eur('0.00'), kind: 'ZERO', basis: 'BEFORE_DEPRECIATION' });
  });

  it('the registry: no taxCategory a registered rule names is left unplaced', () => {
    const named = new Set<string>();
    const walk = (value: unknown, key = ''): void => {
      if (Array.isArray(value)) value.forEach((v) => walk(v, key));
      else if (value !== null && typeof value === 'object') Object.entries(value).forEach(([k, v]) => walk(v, k));
      else if (typeof value === 'string' && (key === 'taxCategory' || key === 'taxCategories')) named.add(value);
    };
    for (const code of TAX_RULES.codes()) for (const version of TAX_RULES.versions(code)) walk(version.parameters);
    expect(named.size).toBeGreaterThan(10);
    for (const taxCategory of named) expect(TAX_YEAR_PLACES[taxCategory as TaxCategory], taxCategory).toBeDefined();
    // And every line of the table is a taxCategory of the vocabulary.
    for (const line of [...EINNAHMEN_LINES, ...WERBUNGSKOSTEN_LINES]) expect(TAX_CATEGORIES).toContain(line);
  });

  it('the example: rent, advances, interest, Hausgeld, a repair → 10,800.00 − 5,300.00 = 5,500.00 SURPLUS; principal in notInView', () => {
    const v = viewOf(
      readOf([
        split({ amount: '9000.00', taxCategory: 'RENT', treatment: 'INCOME' }),
        split({ amount: '1800.00', taxCategory: 'OPERATING_COST_ADVANCES', treatment: 'INCOME' }),
        split({ amount: '3200.00', taxCategory: 'LOAN_INTEREST', treatment: 'DEDUCTIBLE' }),
        split({ amount: '1500.00', taxCategory: 'WEG_HAUSGELD', treatment: 'DEDUCTIBLE' }),
        split({ amount: '600.00', taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE' }),
        split({ amount: '2400.00', taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' }),
      ]),
    );
    expect([v.einnahmen.total.amount, v.werbungskosten.total.amount, v.result.amount.amount, v.result.kind]).toEqual(['10800.00', '5300.00', '5500.00', 'SURPLUS']);
    expect(v.notInView.items.map((i) => [i.amount.amount, i.lineAmount])).toEqual([['2400.00', null]]);
    expect(v.depreciation).toMatchObject({ status: 'DEPRECIATION_NOT_AVAILABLE', amount: null });
    expect(v.result.basis).toBe('BEFORE_DEPRECIATION');
  });

  it('CAPITALIZED leaves the Werbungskosten: listed in capitalized with its line, never in the result; UNCLASSIFIED listed and flagged', () => {
    const repair = split({ amount: '5000.00', taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED', origin: 'CLASSIFICATION', reviewState: 'USER_CONFIRMED' });
    const other = split({ amount: '70.00', taxCategory: 'UNCLASSIFIED', treatment: null, reviewState: 'NEEDS_REVIEW' });
    const v = viewOf(readOf([split({ amount: '1000.00', taxCategory: 'RENT', treatment: 'INCOME' }), repair, other]));
    expect(v.capitalized.items.map((i) => [i.sourceId, i.taxCategory, i.lineAmount?.amount])).toEqual([[repair.sourceId, 'MAINTENANCE', '5000.00']]);
    expect(v.capitalized.total.amount).toBe('5000.00');
    expect([lineOf(v, 'MAINTENANCE').total.amount, v.werbungskosten.total.amount, v.result.amount.amount]).toEqual(['0.00', '0.00', '1000.00']);
    expect(v.unclassified.items.map((i) => [i.sourceId, i.lineAmount, codes(i.flags)])).toEqual([[other.sourceId, null, ['NEEDS_REVIEW', 'UNCLASSIFIED']]]);
  });
});

describe('signs (§58C, §58A)', () => {
  it('a repayment reduces its income line; refunds of the same, an earlier and an unknown year; a refund of a CAPITALIZED source', () => {
    const v = viewOf(
      readOf([
        split({ amount: '900.00', taxCategory: 'RENT', treatment: 'INCOME' }),
        split({ amount: '100.00', taxCategory: 'RENT', treatment: 'INCOME', direction: 'OUTFLOW' }),
        split({ amount: '800.00', taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE' }),
        split({ amount: '50.00', taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', direction: 'INFLOW', refundOfYear: 2027 }),
        split({ amount: '30.00', taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', direction: 'INFLOW', refundOfYear: 2026 }),
        split({ amount: '20.00', taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', direction: 'INFLOW', flags: [{ code: 'REFUND_YEAR_UNKNOWN', details: {} }] }),
        split({ amount: '4000.00', taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED' }),
        split({ amount: '400.00', taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED', direction: 'INFLOW', refundOfYear: 2026 }),
      ]),
    );
    expect(amounts(lineOf(v, 'RENT').items)).toEqual(['900.00', '-100.00']);
    expect(lineOf(v, 'RENT').total.amount).toBe('800.00');
    // Same year and unknown year reduce MAINTENANCE; the earlier year is income on REFUNDS_OF_EARLIER_YEARS.
    expect(amounts(lineOf(v, 'MAINTENANCE').items)).toEqual(['800.00', '-50.00', '-20.00']);
    expect(amounts(lineOf(v, 'REFUNDS_OF_EARLIER_YEARS').items)).toEqual(['30.00']);
    expect(lineOf(v, 'REFUNDS_OF_EARLIER_YEARS').items[0]?.taxCategory).toBe('MAINTENANCE');
    expect([v.einnahmen.total.amount, v.werbungskosten.total.amount, v.result.amount.amount]).toEqual(['830.00', '730.00', '100.00']);
    // A refund of Herstellungskosten reduces the basis (Phase 8): negative in capitalized.
    expect(amounts(v.capitalized.items)).toEqual(['4000.00', '-400.00']);
    expect(v.capitalized.total.amount).toBe('3600.00');
    // The result is the same either way; only the line differs (P7-D4).
    const reduced = viewOf(readOf([split({ amount: '30.00', taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', direction: 'INFLOW', refundOfYear: 2027 })]));
    const income = viewOf(readOf([split({ amount: '30.00', taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', direction: 'INFLOW', refundOfYear: 2026 })]));
    expect([reduced.result.amount.amount, income.result.amount.amount]).toEqual(['30.00', '30.00']);
    // Refunds above the year's costs: a negative line, and a loss below zero.
    const loss = viewOf(readOf([split({ amount: '10.00', taxCategory: 'INSURANCE', treatment: 'DEDUCTIBLE', direction: 'INFLOW', refundOfYear: 2027 })]));
    expect(lineOf(loss, 'INSURANCE').total.amount).toBe('-10.00');
    const lossy = viewOf(readOf([split({ amount: '10.00', taxCategory: 'INSURANCE', treatment: 'DEDUCTIBLE' })]));
    expect(lossy.result).toMatchObject({ amount: eur('-10.00'), kind: 'LOSS' });
  });

  it('subtotals: a § 82b part and an immediate repair on MAINTENANCE', () => {
    const owners = [own(A, '1/1', '2020-01-01')];
    const v = viewOf(
      readOf(
        [
          split({ amount: '600.00', taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE' }),
          split({ amount: '9000.00', taxCategory: 'MAINTENANCE', treatment: 'DISTRIBUTED_82B', distributionYears: 3, ownerships: owners }),
        ],
        owners,
      ),
    );
    const line = lineOf(v, 'MAINTENANCE');
    expect([line.total.amount, line.subtotals?.immediate.amount, line.subtotals?.distributed82b.amount]).toEqual(['3600.00', '600.00', '3000.00']);
    const part = line.items[1];
    expect(part?.amount.amount).toBe('9000.00');
    expect(part?.lineAmount?.amount).toBe('3000.00');
    expect(part?.distribution?.yearAmount.amount).toBe('3000.00');
  });
});

describe('per owner (§58C, P7-D7)', () => {
  it('the example: A and B 1/2 each; a rent of 750.01 → 375.01 and 375.00; a refund of 0.03 → −0.02 and −0.01', () => {
    const owners = [own(A, '1/2', '2026-01-01'), own(B, '1/2', '2026-01-01')];
    const rent = split({ amount: '750.01', taxCategory: 'RENT', treatment: 'INCOME' });
    const refund = split({ amount: '0.03', taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', direction: 'INFLOW', refundOfYear: 2027 });
    const read = readOf([rent, refund], owners);
    const [a, b] = [viewOf(read, 2027, A), viewOf(read, 2027, B)];
    expect([amounts(lineOf(a, 'RENT').items), amounts(lineOf(b, 'RENT').items)]).toEqual([['375.01'], ['375.00']]);
    expect([amounts(lineOf(a, 'MAINTENANCE').items), amounts(lineOf(b, 'MAINTENANCE').items)]).toEqual([['-0.02'], ['-0.01']]);
    expect(lineOf(a, 'RENT').items[0]?.share).toEqual({ ownershipId: owners[0]?.id, share: '1/2', amount: eur('375.01') });
    expect([a.level, a.owners, a.notOwned]).toEqual(['OWNER', null, null]);
    const property = viewOf(read);
    expect(property.owners?.map((o) => [o.ownerPartyId, o.result.amount.amount])).toEqual([
      [A, '375.03'],
      [B, '375.01'],
    ]);
    expect(property.notOwned).toBeNull();
  });

  it('ties: the larger share first, then ownerPartyId, NOT_OWNED last', () => {
    // 0.02 over 3/4 (D) and 1/4 (A): 1.5 and 0.5 cents, a tie of remainders → the larger share, though its id is later.
    const larger = participantsOn([own(A, '1/4', '2020-01-01'), own(D, '3/4', '2020-01-01')], day('2027-01-01'));
    expect(Object.fromEntries(shareOut(2n, larger))).toEqual({ [D]: 2n, [A]: 0n });
    // Equal shares: the lower ownerPartyId.
    const equal = participantsOn([own(B, '1/2', '2020-01-01'), own(A, '1/2', '2020-01-01')], day('2027-01-01'));
    expect(Object.fromEntries(shareOut(1n, equal))).toEqual({ [A]: 1n, [B]: 0n });
    expect(Object.fromEntries(shareOut(-1n, equal))).toEqual({ [A]: -1n, [B]: 0n });
    // NOT_OWNED last, though "ffff…" sorts after it.
    const F = 'ffffffff-0000-4000-8000-000000000000';
    const half = participantsOn([own(F, '1/2', '2020-01-01')], day('2027-01-01'));
    expect(half.map((p) => p.key)).toEqual([F, NOT_OWNED]);
    expect(Object.fromEntries(shareOut(1n, half))).toEqual({ [F]: 1n, [NOT_OWNED]: 0n });
  });

  it('7 owners of 1/7 and 0.05: no part negative, each within a cent, the sum exact', () => {
    const parties = Array.from({ length: 7 }, (_, i) => `${String(i + 1).repeat(8)}-0000-4000-8000-000000000000`);
    const parts = shareOut(5n, participantsOn(parties.map((p) => own(p, '1/7', '2020-01-01')), day('2027-06-01')));
    expect([...parts.values()].every((c) => c === 0n || c === 1n)).toBe(true);
    expect([...parts.values()].reduce((s, c) => s + c, 0n)).toBe(5n);
    expect(parties.slice(0, 5).map((p) => parts.get(p))).toEqual([1n, 1n, 1n, 1n, 1n]);
  });

  it('NOT_OWNED: shares below 1 leave the rest unowned, flagged OWNERSHIP_INCOMPLETE; the property is complete', () => {
    const owners = [own(A, '1/3', '2020-01-01')];
    const v = viewOf(readOf([split({ amount: '100.00', taxCategory: 'RENT', treatment: 'INCOME', bookingDate: '2027-02-01' })], owners));
    expect(v.result.amount.amount).toBe('100.00');
    expect(v.owners?.map((o) => o.result.amount.amount)).toEqual(['33.33']);
    expect(v.notOwned?.result.amount.amount).toBe('66.67');
    expect(v.flags.find((f) => f.code === 'OWNERSHIP_INCOMPLETE')?.details).toEqual({
      itemCount: 1,
      notOwnedTotal: { amount: '66.67', currency: 'EUR' },
      firstDate: '2027-02-01',
    });
  });

  it('an owner change during the year: each item takes the owners of its date; nothing is pro-rated by days', () => {
    const owners = [own(A, '1/2', '2026-01-01', '2027-06-30'), own(B, '1/2', '2026-01-01'), own(C, '1/2', '2027-07-01')];
    const items = ['2027-01-03', '2027-06-30', '2027-07-01', '2027-12-01'].map((d) => split({ amount: '750.01', taxCategory: 'RENT', treatment: 'INCOME', bookingDate: d }));
    const read = readOf(items, owners);
    expect(lineOf(viewOf(read, 2027, A), 'RENT').items.map((i) => i.date)).toEqual(['2027-01-03', '2027-06-30']);
    expect(lineOf(viewOf(read, 2027, C), 'RENT').items.map((i) => i.date)).toEqual(['2027-07-01', '2027-12-01']);
    expect(amounts(lineOf(viewOf(read, 2027, B), 'RENT').items)).toEqual(['375.00', '375.00', '375.01', '375.01']);
    expect(viewOf(read).owners?.map((o) => [o.ownerPartyId, o.einnahmen.total.amount])).toEqual([
      [A, '750.02'],
      [B, '1500.02'],
      [C, '750.00'],
    ]);
  });

  it('property test: owners + NOT_OWNED = the property for every item, line, total and the result (random shares ≤ 20 owners, d ≤ 10,000; signed amounts)', () => {
    // A seeded generator (mulberry32): the test is reproducible.
    let state = 0x5eed;
    const rand = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const kinds: readonly [TaxCategory, Treatment][] = [
      ['RENT', 'INCOME'],
      ['OPERATING_COST_ADVANCES', 'INCOME'],
      ['MAINTENANCE', 'DEDUCTIBLE'],
      ['LOAN_INTEREST', 'DEDUCTIBLE'],
      ['INSURANCE', 'DEDUCTIBLE'],
      ['MAINTENANCE', 'CAPITALIZED'],
      ['NOT_RELEVANT', 'NOT_RELEVANT'],
    ];
    for (let run = 0; run < 60; run++) {
      const n = int(1, 20);
      const denominator = int(n, 10_000);
      // n positive numerators summing to at most the denominator: incomplete in some runs.
      const room = int(n, denominator);
      const cuts = [...new Set(Array.from({ length: n - 1 }, () => int(1, room - 1)))].sort((x, y) => x - y);
      while (cuts.length < n - 1) cuts.push(room - (n - 1 - cuts.length));
      const bounds = [0, ...[...new Set(cuts)].sort((x, y) => x - y).slice(0, n - 1), room];
      const numerators = bounds.slice(1).map((b, i) => b - (bounds[i] as number)).filter((k) => k > 0);
      const parties = numerators.map((_, i) => `${String(run).padStart(4, '0')}${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`);
      const owners = numerators.map((k, i) => own(parties[i] as string, `${k}/${denominator}`, '2020-01-01'));
      const items = Array.from({ length: int(1, 12) }, () => {
        const [taxCategory, treatment] = kinds[int(0, kinds.length - 1)] as [TaxCategory, Treatment];
        const cents = int(1, 9_999_999);
        return split({
          amount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`,
          taxCategory,
          treatment,
          ...(rand() < 0.3 ? { direction: TAX_YEAR_PLACES[taxCategory] === 'EINNAHMEN' ? ('OUTFLOW' as const) : ('INFLOW' as const) } : {}),
          refundOfYear: 2027,
        });
      });
      const read = readOf(items, owners);
      const property = viewOf(read);
      const ownerViews = parties.map((p) => viewOf(read, 2027, p));
      const cents = (m: Money | null | undefined) => {
        if (m === null || m === undefined) return 0n;
        const [w, f = ''] = m.amount.replace('-', '').split('.') as [string, string?];
        return (m.isNegative() ? -1n : 1n) * (BigInt(w) * 100n + BigInt(f.padEnd(2, '0')));
      };
      const totals = [property.owners ?? [], property.notOwned === null ? [] : [property.notOwned]].flat();
      // Every item: the owners' parts plus NOT_OWNED's are the property's lineAmount; each part within a cent, of its sign.
      const sections = (v: TaxYearView) => [...v.einnahmen.lines, ...v.werbungskosten.lines];
      for (const item of [...sections(property).flatMap((l) => l.items), ...property.capitalized.items]) {
        const a = cents(item.lineAmount);
        const parts = ownerViews.map(
          (ov) => cents([...sections(ov).flatMap((l) => l.items), ...ov.capitalized.items].find((i) => i.sourceId === item.sourceId)?.lineAmount),
        );
        const p = participantsOn(owners, item.date);
        const notOwnedPart = shareOut(a, p).get(NOT_OWNED) ?? 0n;
        expect(parts.reduce((s, c) => s + c, 0n) + notOwnedPart).toBe(a);
        p.forEach((participant) => {
          const part = participant.key === NOT_OWNED ? notOwnedPart : (parts[parties.indexOf(participant.key)] as bigint);
          const exact = a * participant.share.numerator;
          const diff = part * participant.share.denominator - exact;
          expect(diff < 0n ? -diff : diff).toBeLessThan(participant.share.denominator);
          expect(a >= 0n ? part >= 0n : part <= 0n).toBe(true);
        });
      }
      // Every line, both totals, capitalized and the result: summed from the parts, never distributed.
      property.einnahmen.lines.forEach((line, i) =>
        expect(totals.reduce((s, t) => s + cents(t.einnahmen.lines[i]?.total), 0n), line.taxCategory).toBe(cents(line.total)),
      );
      property.werbungskosten.lines.forEach((line, i) =>
        expect(totals.reduce((s, t) => s + cents(t.werbungskosten.lines[i]?.total), 0n), line.taxCategory).toBe(cents(line.total)),
      );
      expect(totals.reduce((s, t) => s + cents(t.einnahmen.total), 0n)).toBe(cents(property.einnahmen.total));
      expect(totals.reduce((s, t) => s + cents(t.werbungskosten.total), 0n)).toBe(cents(property.werbungskosten.total));
      expect(totals.reduce((s, t) => s + cents(t.capitalized.total), 0n)).toBe(cents(property.capitalized.total));
      expect(totals.reduce((s, t) => s + cents(t.result.amount), 0n)).toBe(cents(property.result.amount));
      // The owner views agree with the owners' totals of the property view.
      ownerViews.forEach((ov, i) => {
        const summary = property.owners?.find((o) => o.ownerPartyId === parties[i]);
        expect(cents(ov.result.amount)).toBe(cents(summary?.result.amount));
      });
    }
  });

  it('SHARE_DATE_OUTSIDE_TAX_YEAR: a share date outside the year whose Ownerships differ from the nearest day of it; NOT_AN_OWNER_IN_YEAR via an item', () => {
    // A sells to D effective 2028-01-01; a January 2028 rent paid on 2027-12-29 counts in 2028 and stays A's and B's.
    const owners = [own(A, '1/2', '2026-01-01', '2027-12-31'), own(B, '1/2', '2026-01-01'), own(D, '1/2', '2028-01-01')];
    const rent = split({ amount: '750.01', taxCategory: 'RENT', treatment: 'INCOME', bookingDate: '2027-12-29', taxYear: 2028 });
    const read = readOf([rent], owners);
    const item = lineOf(viewOf(read, 2028), 'RENT').items[0];
    expect(item?.flags.find((f) => f.code === 'SHARE_DATE_OUTSIDE_TAX_YEAR')?.details).toEqual({ shareDate: '2027-12-29', nearestDayOfYear: '2028-01-01' });
    // A holds no Ownership in 2028 but takes part in an item of it: A may open the view; C may not.
    expect(amounts(lineOf(viewOf(read, 2028, A), 'RENT').items)).toEqual(['375.01']);
    expect(lineOf(viewOf(read, 2028, D), 'RENT').items).toEqual([]);
    expect(buildTaxYearView(read, { year: 2028, ownerPartyId: C, today, registry: TAX_RULES })).toEqual({ kind: 'NOT_AN_OWNER_IN_YEAR' });
    // Without the change, the owners of 2027-12-29 are those of 2028-01-01: no flag.
    const unchanged = readOf([rent], [own(A, '1/2', '2026-01-01'), own(B, '1/2', '2026-01-01')]);
    expect(codes(lineOf(viewOf(unchanged, 2028), 'RENT').items[0]?.flags ?? [])).not.toContain('SHARE_DATE_OUTSIDE_TAX_YEAR');
  });
});

describe('§ 82b per owner (§58C)', () => {
  const repair = (owners: readonly ViewOwnership[]) =>
    split({ amount: '9000.00', taxCategory: 'MAINTENANCE', treatment: 'DISTRIBUTED_82B', bookingDate: '2027-09-15', distributionYears: 3, ownerships: owners });
  const yearsOf = (owners: readonly ViewOwnership[], party: string | null = null) => {
    const item = repair(owners);
    return [2027, 2028, 2029, 2030].map((year) => {
      const read = { ...readOf([], owners), sources: [{ item, listed: ((item as TaxMeaning).distribution?.parts ?? []).some((p) => p.year === year) }] };
      const outcome = buildTaxYearView(read, { year, ownerPartyId: party, today, registry: TAX_RULES });
      if (outcome.kind !== 'VIEW') return outcome.kind;
      const found = lineOf(outcome.view, 'MAINTENANCE').items[0];
      return found === undefined ? null : { amount: found.lineAmount?.amount, flags: codes(found.flags).filter((c) => c.startsWith('DISTRIBUTION')) };
    });
  };

  it('the example: B sells within the distribution → A 1,500.00 each year; B 1,500.00 and 3,000.00; the property 3,000, 4,500, 1,500; the buyer has no part', () => {
    const owners = [own(A, '1/2', '2026-01-01'), own(B, '1/2', '2026-01-01', '2028-06-30'), own(C, '1/2', '2028-07-01')];
    expect(yearsOf(owners)).toEqual([
      { amount: '3000.00', flags: [] },
      { amount: '4500.00', flags: ['DISTRIBUTION_FOLDED_PER_OWNER'] },
      { amount: '1500.00', flags: ['DISTRIBUTION_FOLDED_PER_OWNER'] },
      null,
    ]);
    expect(yearsOf(owners, A).map((y) => (typeof y === 'object' ? (y?.amount ?? null) : y))).toEqual(['1500.00', '1500.00', '1500.00', null]);
    expect(yearsOf(owners, B).map((y) => (typeof y === 'object' ? (y?.amount ?? null) : y))).toEqual(['1500.00', '3000.00', 'NOT_AN_OWNER_IN_YEAR', 'NOT_AN_OWNER_IN_YEAR']);
    expect(yearsOf(owners, C).map((y) => (typeof y === 'object' ? (y?.amount ?? null) : y))).toEqual(['NOT_AN_OWNER_IN_YEAR', null, null, null]);
    // The flag's details, and the item's distribution with §58B's yearAmount beside the folded lineAmount.
    const item = repair(owners);
    const v = viewOf(readOf([item], owners), 2028);
    const shown = lineOf(v, 'MAINTENANCE').items[0];
    expect(shown?.flags.find((f) => f.code === 'DISTRIBUTION_FOLDED_PER_OWNER')?.details).toEqual({
      yearAmount: { amount: '3000.00', currency: 'EUR' },
      lineAmount: { amount: '4500.00', currency: 'EUR' },
      owners: [{ ownerPartyId: B, endYear: 2028 }],
    });
    expect(shown?.distribution?.yearAmount.amount).toBe('3000.00');
    expect(lineOf(viewOf(readOf([item], owners), 2028, B), 'MAINTENANCE').items[0]?.distribution?.ownerParts).toEqual([
      { year: 2027, amount: eur('1500.00') },
      { year: 2028, amount: eur('3000.00') },
    ]);
  });

  it('a tenure continued through a new Ownership folds nothing; a seller next to the continuing owner folds alone', () => {
    // A's 1/1 closed and continued the next day (a share change, §26.2): no end, no fold.
    expect(yearsOf([own(A, '1/1', '2026-01-01', '2028-06-30'), own(A, '1/1', '2028-07-01')])).toEqual([
      { amount: '3000.00', flags: [] },
      { amount: '3000.00', flags: [] },
      { amount: '3000.00', flags: [] },
      null,
    ]);
    // B sells to A: B folds, A continues at 1/1 with no fold of its own.
    const owners = [own(A, '1/2', '2026-01-01', '2028-06-30'), own(B, '1/2', '2026-01-01', '2028-06-30'), own(A, '1/1', '2028-07-01')];
    expect(yearsOf(owners, A).map((y) => (typeof y === 'object' ? (y?.amount ?? null) : y))).toEqual(['1500.00', '1500.00', '1500.00', null]);
    expect(yearsOf(owners).map((y) => (typeof y === 'object' ? (y?.amount ?? null) : y))).toEqual(['3000.00', '4500.00', '1500.00', null]);
  });

  it('every owner ending in the same year gives §58B’s fold (no DISTRIBUTION_FOLDED_PER_OWNER); NOT_OWNED keeps its year', () => {
    const owners = [own(A, '1/2', '2026-01-01', '2028-06-30'), own(B, '1/2', '2026-01-01', '2028-06-30'), own(C, '1/1', '2028-07-01')];
    expect(yearsOf(owners)).toEqual([
      { amount: '3000.00', flags: ['DISTRIBUTION_ENDED'] },
      { amount: '6000.00', flags: ['DISTRIBUTION_ENDED'] },
      null,
      null,
    ]);
    const fold = foldPerOwner({ amount: eur('9000.00'), firstYear: 2027, years: 3, rule: D82B, date: day('2027-09-15') }, [own(A, '1/2', '2026-01-01', '2028-06-30')]);
    expect(Object.fromEntries([...fold.parts].map(([k, v]) => [k, Object.fromEntries(v)]))).toEqual({
      [A]: { 2027: 150000n, 2028: 300000n },
      [NOT_OWNED]: { 2027: 150000n, 2028: 150000n, 2029: 150000n },
    });
  });
});

describe('ATTRIBUTION_INPUT_CHANGED (§58C)', () => {
  const REF = '0000cccc-0000-4000-8000-000000000001';
  const TENANT = '6512f0c2a1b2c3d4e5f6d001';
  const rentId = '0000dddd-0000-4000-8000-000000000001';
  const reference = (overrides: Partial<ReferenceHistory> = {}): ReferenceHistory => ({
    rentalContractReferenceId: REF,
    mreTenantId: TENANT,
    rentDueDays: [{ validFrom: day('2026-01-01'), day: 15 }],
    created: [{ validFrom: day('2026-01-01'), day: 3 }],
    amendments: [
      {
        auditRecordId: 'audit-2',
        newVersion: 2,
        amendedAt: new Date('2029-02-01T10:00:00Z'),
        changedEntries: [{ validFrom: day('2026-01-01'), from: 3, to: 15 }],
      },
    ],
    ...overrides,
  });
  const input = (ref: ReferenceHistory, override: number | null = null): AttributionInput => ({
    references: [ref],
    candidates: [
      { sourceId: rentId, bookingDate: day('2027-12-29'), financialCategoryCode: 'RENT_BASE', mreTenantId: TENANT, mreRentTerm: '2028010100', taxYearOverride: override },
    ],
  });

  it('the lists rebuilt from the AuditRecords, newest first, back to the CREATED list', () => {
    expect(listBefore([{ validFrom: day('2026-01-01'), day: 15 }], [{ validFrom: day('2026-01-01'), from: 3, to: 15 }])).toEqual([{ validFrom: '2026-01-01', day: 3 }]);
    expect(listBefore([{ validFrom: day('2026-01-01'), day: 15 }], [{ validFrom: day('2030-01-01'), from: null, to: 15 }])).toBeUndefined();
    const two = reference({
      rentDueDays: [
        { validFrom: day('2026-01-01'), day: 15 },
        { validFrom: day('2030-01-01'), day: 1 },
      ],
      amendments: [
        { auditRecordId: 'audit-3', newVersion: 3, amendedAt: new Date('2029-03-01T10:00:00Z'), changedEntries: [{ validFrom: day('2030-01-01'), from: null, to: 1 }] },
        { auditRecordId: 'audit-2', newVersion: 2, amendedAt: new Date('2029-02-01T10:00:00Z'), changedEntries: [{ validFrom: day('2026-01-01'), from: 3, to: 15 }] },
      ],
    });
    expect(amendmentLists(two)?.map((l) => [l.amendment.auditRecordId, l.before.map((e) => e.day), l.after.map((e) => e.day)])).toEqual([
      ['audit-3', [15], [15, 1]],
      ['audit-2', [3], [15]],
    ]);
  });

  it('an amendment from day 3 to 15 moves the January rent out of 2028 and into 2027: both years flagged', () => {
    const into = attributionChanges(input(reference()), 2027, TAX_RULES);
    const out = attributionChanges(input(reference()), 2028, TAX_RULES);
    const expected = [
      {
        rentalContractReferenceId: REF,
        auditRecordId: 'audit-2',
        amendedAt: new Date('2029-02-01T10:00:00Z'),
        changedEntries: [{ validFrom: '2026-01-01', from: 3, to: 15 }],
        items: [{ sourceId: rentId, yearBefore: 2028, yearAfter: 2027 }],
      },
    ];
    expect(into).toEqual({ changes: expected, inconsistent: [] });
    expect(out).toEqual({ changes: expected, inconsistent: [] });
    expect(attributionChanges(input(reference()), 2026, TAX_RULES).changes).toEqual([]);
    // In the view: the year flag, and the item now in 2027 carries it too; the 2028 view names it in the details only.
    const rent = split({ amount: '900.00', taxCategory: 'RENT', treatment: 'INCOME', bookingDate: '2027-12-29', sourceId: rentId });
    const v2027 = viewOf(readOf([rent], [], { attribution: input(reference()) }), 2027);
    expect(codes(v2027.flags)).toContain('ATTRIBUTION_INPUT_CHANGED');
    expect(codes(lineOf(v2027, 'RENT').items[0]?.flags ?? [])).toContain('ATTRIBUTION_INPUT_CHANGED');
    expect(v2027.flags.find((f) => f.code === 'ATTRIBUTION_INPUT_CHANGED')?.details).toEqual([
      {
        rentalContractReferenceId: REF,
        auditRecordId: 'audit-2',
        amendedAt: '2029-02-01T10:00:00.000Z',
        changedEntries: [{ validFrom: '2026-01-01', from: 3, to: 15 }],
        items: [{ sourceId: rentId, yearBefore: 2028, yearAfter: 2027 }],
      },
    ]);
    const v2028 = viewOf(readOf([], [], { attribution: input(reference()) }), 2028);
    expect(codes(v2028.flags)).toContain('ATTRIBUTION_INPUT_CHANGED');
    expect(v2028.review.open).toContainEqual({ code: 'ATTRIBUTION_INPUT_CHANGED', count: 1 });
  });

  it('an entry with a later validFrom added, or a taxYear override, raises nothing', () => {
    const later = reference({
      rentDueDays: [
        { validFrom: day('2026-01-01'), day: 3 },
        { validFrom: day('2030-01-01'), day: 15 },
      ],
      amendments: [{ auditRecordId: 'audit-2', newVersion: 2, amendedAt: new Date('2029-02-01T10:00:00Z'), changedEntries: [{ validFrom: day('2030-01-01'), from: null, to: 15 }] }],
    });
    expect(attributionChanges(input(later), 2028, TAX_RULES)).toEqual({ changes: [], inconsistent: [] });
    expect(attributionChanges(input(reference(), 2028), 2028, TAX_RULES).changes).toEqual([]);
    expect(attributionChanges(input(reference(), 2028), 2027, TAX_RULES).changes).toEqual([]);
  });

  it('recorded on 31 December of the year: no flag for it; on 1 January of the next (Europe/Berlin): flagged', () => {
    const at = (iso: string) => reference({ amendments: [{ ...(reference().amendments[0] as ReferenceHistory['amendments'][number]), amendedAt: new Date(iso) }] });
    // 31 December 2028, 13:00 in Berlin: 2028 was still running.
    expect(attributionChanges(input(at('2028-12-31T12:00:00Z')), 2028, TAX_RULES).changes).toEqual([]);
    // …but after 2027: the 2027 view is flagged.
    expect(attributionChanges(input(at('2028-12-31T12:00:00Z')), 2027, TAX_RULES).changes).toHaveLength(1);
    // 23:30 UTC on 31 December is 00:30 on 1 January 2029 in Berlin.
    expect(attributionChanges(input(at('2028-12-31T23:30:00Z')), 2028, TAX_RULES).changes).toHaveLength(1);
    // Recorded in 2026, while both years still lay ahead: nothing.
    expect(attributionChanges(input(at('2026-10-30T10:00:00Z')), 2027, TAX_RULES).changes).toEqual([]);
  });

  it('an inconsistent history: ATTRIBUTION_HISTORY_INCONSISTENT, and that reference’s history is not used', () => {
    const broken = reference({ created: [{ validFrom: day('2026-01-01'), day: 5 }] });
    expect(attributionChanges(input(broken), 2028, TAX_RULES)).toEqual({ changes: [], inconsistent: [REF] });
    const v = viewOf(readOf([], [], { attribution: input(broken) }), 2028);
    expect(v.flags.filter((f) => f.code === 'ATTRIBUTION_HISTORY_INCONSISTENT')).toEqual([
      { code: 'ATTRIBUTION_HISTORY_INCONSISTENT', details: { rentalContractReferenceId: REF } },
    ]);
    expect(attributionChanges(input(reference({ created: null })), 2028, TAX_RULES).inconsistent).toEqual([REF]);
  });
});

describe('not attributed, the cap, the review and final (§58C)', () => {
  const deposit = (candidates: readonly string[]): DepositTaxMeaning => ({
    securityDepositId: id(),
    status: 'CLOSED',
    closingDate: day('2027-05-31'),
    retainedAmount: eur('400.00'),
    propertyReferenceId: null,
    propertyCandidates: candidates,
    sourceType: 'DEPOSIT_CLOSING',
    sourceId: id(),
    counts: true,
    taxYear: 2027,
    amount: eur('400.00'),
    taxCategory: 'RETAINED_DEPOSIT_RENT',
    treatment: 'INCOME',
    reviewState: 'USER_CONFIRMED',
    origin: 'CLASSIFICATION',
    rule: DEFAULTS,
    classificationId: id(),
    flags:
      candidates.length === 0
        ? [{ code: 'NO_PROPERTY_REFERENCE', details: { reason: 'NO_RECONCILED_RENT' } }]
        : [{ code: 'NO_PROPERTY_REFERENCE', details: { reason: 'SEVERAL_PROPERTY_REFERENCES', candidates } }],
  });

  it('"nicht zugeordnet": in the candidates’ views (SEVERAL) and in every view (NO_RECONCILED_RENT), never summed, at both levels', () => {
    const OTHER = '0000aaaa-0000-4000-8000-000000000099';
    const several = deposit([PR, OTHER]);
    const elsewhere = deposit([OTHER, '0000aaaa-0000-4000-8000-000000000098']);
    const none = deposit([]);
    const owners = [own(A, '1/1', '2020-01-01')];
    const read = readOf([split({ amount: '100.00', taxCategory: 'RENT', treatment: 'INCOME' })], owners, { unattributedDeposits: [several, elsewhere, none] });
    for (const v of [viewOf(read), viewOf(read, 2027, A)]) {
      expect(v.notAttributed.items.map((i) => [i.sourceId, i.lineAmount, i.share, i.notAttributed?.reason])).toEqual([
        [several.sourceId, null, null, 'SEVERAL_PROPERTY_REFERENCES'],
        [none.sourceId, null, null, 'NO_RECONCILED_RENT'],
      ]);
      expect(v.notAttributed.items[0]?.notAttributed?.href).toBe(`/api/v1/security-deposits/${several.sourceId}/tax-meaning`);
      expect([v.einnahmen.total.amount, lineOf(v, 'RETAINED_DEPOSIT_RENT').total.amount]).toEqual(['100.00', '0.00']);
      expect(v.flags.find((f) => f.code === 'UNATTRIBUTED_ITEMS')?.details).toEqual({ count: 2 });
    }
  });

  it('the cap: 5,000 items over all places (notInView and the deposits not attributed included) → the view; 5,001 → TAX_YEAR_TOO_LARGE', () => {
    const notRelevant = Array.from({ length: TAX_YEAR_ITEM_LIMIT - 2 }, () => split({ amount: '1.00', taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' }));
    const at = (extra: number) => readOf([...notRelevant, ...Array.from({ length: extra }, () => split({ amount: '1.00', taxCategory: 'RENT', treatment: 'INCOME' }))], [], {
      unattributedDeposits: [deposit([]), deposit([])],
    });
    expect(buildTaxYearView(at(0), { year: 2027, ownerPartyId: null, today, registry: TAX_RULES }).kind).toBe('VIEW');
    expect(buildTaxYearView(at(1), { year: 2027, ownerPartyId: null, today, registry: TAX_RULES })).toEqual({
      kind: 'TAX_YEAR_TOO_LARGE',
      itemCount: 5001,
      limit: 5000,
    });
  });

  it('the levels of the review table; DEPRECIATION_NOT_AVAILABLE always open, so final is always false', () => {
    const item = { treatment: 'DEDUCTIBLE', origin: 'DEFAULT', reviewState: 'SUGGESTED' } as const;
    const confirmed = { treatment: 'DEDUCTIBLE', origin: 'CLASSIFICATION', reviewState: 'USER_CONFIRMED' } as const;
    for (const code of ['DEPRECIATION_NOT_AVAILABLE', 'ATTRIBUTION_INPUT_CHANGED', 'ATTRIBUTION_HISTORY_INCONSISTENT', 'OWNERSHIP_INCOMPLETE', 'UNATTRIBUTED_ITEMS']) {
      expect(flagIsOpen(code, item), code).toBe(true);
    }
    for (const code of ['NEEDS_REVIEW', 'UNCLASSIFIED', 'CLASSIFICATION_ON_CORRECTED_SPLIT', 'PREDECESSOR_CLASSIFIED', 'REFUND_YEAR_UNKNOWN', 'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE']) {
      expect(flagIsOpen(code, confirmed), code).toBe(true);
    }
    expect(flagIsOpen('ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', item)).toBe(true);
    expect(flagIsOpen('ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', { ...confirmed, treatment: 'CAPITALIZED' })).toBe(false);
    for (const code of ['ATTRIBUTED_BY_10_DAY_RULE', 'DUE_DATE_ASSUMED', 'ECONOMIC_PERIOD_ASSUMED', 'NO_ECONOMIC_PERIOD', 'WITHDRAWAL_DATE_ASSUMED', 'WEG_FINANCIAL_YEAR_NOT_CALENDAR']) {
      expect([flagIsOpen(code, item), flagIsOpen(code, confirmed), flagIsOpen(code, { ...confirmed, reviewState: 'NEEDS_REVIEW' })], code).toEqual([true, false, true]);
    }
    for (const code of [
      'VAT_NOT_SEPARATED',
      'RULE_SUPERSEDED',
      'WEG_SPENDING_POSSIBLY_TWICE',
      'USES_EXCEED_PAID',
      'DISTRIBUTION_ENDED',
      'OWNERSHIP_PARTLY_ENDED',
      'DISTRIBUTION_FOLDED_PER_OWNER',
      'SHARE_DATE_OUTSIDE_TAX_YEAR',
    ]) {
      expect(flagIsOpen(code, item), code).toBe(false);
    }
    const tenDay = { code: 'ATTRIBUTED_BY_10_DAY_RULE', details: {} };
    const v = viewOf(
      readOf([
        split({ amount: '900.00', taxCategory: 'RENT', treatment: 'INCOME', flags: [tenDay] }),
        split({ amount: '900.00', taxCategory: 'RENT', treatment: 'INCOME', flags: [tenDay], origin: 'CLASSIFICATION', reviewState: 'USER_CONFIRMED' }),
        split({ amount: '10.00', taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', flags: [{ code: 'VAT_NOT_SEPARATED', details: {} }], reviewState: 'NEEDS_REVIEW' }),
      ]),
    );
    expect(v.review).toEqual({
      final: false,
      open: [
        { code: 'DEPRECIATION_NOT_AVAILABLE', count: 1 },
        { code: 'OWNERSHIP_INCOMPLETE', count: 1 },
        { code: 'ATTRIBUTED_BY_10_DAY_RULE', count: 1 },
        { code: 'NEEDS_REVIEW', count: 1 },
      ],
      info: [
        { code: 'ATTRIBUTED_BY_10_DAY_RULE', count: 1 },
        { code: 'VAT_NOT_SEPARATED', count: 1 },
      ],
      reviewStates: { SUGGESTED: 1, USER_CONFIRMED: 1, ADVISOR_CONFIRMED: 0, NEEDS_REVIEW: 1 },
    });
    expect(viewOf(readOf([])).review.final).toBe(false);
    expect(v.ruleVersions).toEqual([
      { ruleCode: 'DE_CASH_TIMING', version: 1, title: expect.any(String), legalBasis: expect.any(String), status: 'ACTIVE', itemCount: 3 },
      { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1, title: expect.any(String), legalBasis: expect.any(String), status: 'ACTIVE', itemCount: 3 },
    ]);
  });

  it('a counting=false item of the list is never summed: listed in unclassified', () => {
    const stale = split({ amount: '400.00', taxCategory: 'RENT', treatment: 'INCOME', counts: false });
    const v = viewOf(readOf([stale]));
    expect([v.einnahmen.total.amount, v.unclassified.items.map((i) => i.sourceId)]).toEqual(['0.00', [stale.sourceId]]);
  });
});
