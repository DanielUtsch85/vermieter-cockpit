import { PHASE_7_DEPRECIATION } from './tax-year-depreciation.test-support.js';
import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, centsOf, type BusinessDate } from '../../shared/index.js';
import { distribute, withValidUntil, type AllocationBasis, type LoanAllocationSet, type LoanAllocationSetView } from '../financing/index.js';
import type { Direction } from '../ledger/index.js';
import { refundOf, yearOf } from './cash-timing.js';
import type { TaxMeaning } from './classification.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import {
  TAX_YEAR_ITEM_LIMIT,
  buildTaxYearView,
  flagIsOpen,
  loanInterestOf,
  type LoanInterestSplit,
  type TaxYearItem,
  type TaxYearRead,
  type TaxYearView,
  type ViewOwnership,
} from './tax-year-view.js';
import type { Origin, ReviewState, TaxCategory, Treatment } from './vocabulary.js';

/**
 * VC-X-29 (api-design.md §58D): the interest of an allocated Loan in the tax-year view. The set valid on the booking
 * date, Financing's `distribute` over the whole set, the owners on the booking date by `shareOut`; the three cases;
 * `PURCHASE_PRICE` sets with their open flag; the narrowed `LOAN_INTEREST_NOT_ATTRIBUTED`; the property test that the
 * parts over a set's PropertyReferences sum to the split. Synthetic figures and ids only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2026-10-30');
const DEFAULTS = { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 };
const CASH = { ruleCode: 'DE_CASH_TIMING', version: 1 };
/** PropertyReferences P1 < P2 and Parties A < B < C by id. */
const [P1, P2] = [1, 2].map((n) => `0000aaaa-0000-4000-8000-00000000000${n}`) as [string, string];
const [A, B, C] = ['a', 'b', 'c'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000000`) as [string, string, string];
const L = '0000bbbb-0000-4000-8000-000000000001';
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

interface InterestOptions {
  readonly loanId?: string;
  readonly direction?: Direction;
  readonly taxYear?: number;
  readonly taxCategory?: TaxCategory;
  readonly treatment?: Treatment | null;
  readonly reviewState?: ReviewState;
  readonly origin?: Origin;
  readonly flags?: TaxMeaning['flags'];
  readonly transactionId?: string;
  readonly position?: number;
}

/** A counting interest split of a Loan (no PropertyReference, 0027), by default `LOAN_INTEREST` / `DEDUCTIBLE` / `SUGGESTED`. */
function interest(amount: string, bookingDate: string, o: InterestOptions = {}): LoanInterestSplit {
  const date = day(bookingDate);
  const direction = o.direction ?? 'OUTFLOW';
  const taxCategory = o.taxCategory ?? 'LOAN_INTEREST';
  const taxYear = o.taxYear ?? yearOf(date);
  const sourceId = id();
  const meaning: TaxMeaning = {
    splitId: sourceId,
    sourceId,
    sourceType: 'TRANSACTION_SPLIT',
    transactionId: o.transactionId ?? id(),
    position: o.position ?? 1,
    bookingDate: date,
    direction,
    amount: eur(amount),
    financialCategoryCode: 'LOAN_INTEREST',
    categoryType: 'FINANCING',
    propertyReferenceId: null,
    transactionStatus: 'CONFIRMED',
    correctionRole: null,
    counts: true,
    taxCategory,
    treatment: o.treatment === undefined ? 'DEDUCTIBLE' : o.treatment,
    reviewState: o.reviewState ?? 'SUGGESTED',
    origin: o.origin ?? 'DEFAULT',
    rule: DEFAULTS,
    classificationId: o.origin === 'CLASSIFICATION' ? id() : null,
    taxYear,
    attribution: { rule: CASH, bookingYear: yearOf(date), proposedYear: taxYear, overridden: false },
    refund: refundOf(direction, taxCategory, taxYear, null, null).refund,
    netAmount: null,
    treatmentRule: null,
    distribution: null,
    suggestion: null,
    flags: o.flags ?? [],
  };
  return { item: { ...meaning, yearAmount: meaning.amount }, loanId: o.loanId ?? L };
}

interface SetSpec {
  readonly validFrom: string;
  readonly shares: readonly (readonly [string, string])[];
  readonly basis?: AllocationBasis;
  readonly status?: 'VALID' | 'VOID';
  readonly id?: string;
}
const set = (s: SetSpec, loanId = L): LoanAllocationSet => ({
  id: (s.id ?? id()) as LoanAllocationSet['id'],
  loanId,
  mreRealmId: 'realm',
  status: s.status ?? 'VALID',
  validFrom: day(s.validFrom),
  basis: s.basis ?? 'MANUAL',
  allocations: s.shares.map(([propertyReferenceId, share]) => {
    const [n, d] = share.split('/') as [string, string];
    return { propertyReferenceId, share: { numerator: BigInt(n), denominator: BigInt(d) }, acquisitionId: null };
  }),
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  version: 1,
});
const setsOf = (byLoan: Record<string, readonly LoanAllocationSet[]>) =>
  new Map<string, readonly LoanAllocationSetView[]>(Object.entries(byLoan).map(([loanId, sets]) => [loanId, withValidUntil(sets)]));

const own = (party: string, share: string, from: string, until: string | null = null): ViewOwnership => {
  const [n, d] = share.split('/').map(Number) as [number, number];
  return { id: id(), partyId: party, share: { numerator: n, denominator: d }, validFrom: day(from), validUntil: until === null ? null : day(until) };
};
const OWNERS: Record<string, ViewOwnership[]> = { [P1]: [own(A, '1/2', '2026-01-01'), own(B, '1/2', '2026-01-01')], [P2]: [own(C, '1/1', '2026-01-01')] };

function readOf(
  pr: string,
  splits: readonly LoanInterestSplit[],
  sets: ReadonlyMap<string, readonly LoanAllocationSetView[]>,
  extra: Partial<TaxYearRead> = {},
): TaxYearRead {
  return {
    propertyReferenceId: pr,
    ownerPartyFound: null,
    sources: [],
    unattributedDeposits: [],
    ownerships: OWNERS[pr] ?? [],
    checks: [],
    attribution: { references: [], candidates: [] },
    allocatedLoanInterest: splits,
    loanAllocationSets: sets,
    depreciation: PHASE_7_DEPRECIATION,
    ...extra,
  };
}
function viewOf(read: TaxYearRead, year = 2027, ownerPartyId: string | null = null): TaxYearView {
  const outcome = buildTaxYearView(read, { year, ownerPartyId, today, registry: TAX_RULES });
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
}
const line = (v: TaxYearView) => v.werbungskosten.lines.find((l) => l.taxCategory === 'LOAN_INTEREST') as TaxYearView['werbungskosten']['lines'][number];
const placed = (v: TaxYearView): TaxYearItem[] => [
  ...v.einnahmen.lines.flatMap((l) => l.items),
  ...v.werbungskosten.lines.flatMap((l) => l.items),
  ...v.capitalized.items,
  ...v.notInView.items,
  ...v.unclassified.items,
];
const ownerLine = (v: TaxYearView, party: string) =>
  v.owners?.find((o) => o.ownerPartyId === party)?.werbungskosten.lines.find((l) => l.taxCategory === 'LOAN_INTEREST')?.total.amount;
const flag = (v: TaxYearView, code: string) => v.flags.find((f) => f.code === code)?.details;
const codes = (flags: readonly { code: string }[]) => flags.map((f) => f.code);

describe('§58D: the synthetic example', () => {
  // S1 from 2027-02-01 (60/40), S2 from 2027-07-01 (50/50), S3 from 2028-01-01 (70/30), all MANUAL.
  const S1 = set({
    validFrom: '2027-02-01',
    shares: [
      [P1, '3/5'],
      [P2, '2/5'],
    ],
  });
  const S2 = set({
    validFrom: '2027-07-01',
    shares: [
      [P1, '1/2'],
      [P2, '1/2'],
    ],
  });
  const S3 = set({
    validFrom: '2028-01-01',
    shares: [
      [P1, '7/10'],
      [P2, '3/10'],
    ],
  });
  const before = interest('451.20', '2027-01-29');
  const march = interest('450.01', '2027-03-31');
  const july = interest('449.99', '2027-07-30');
  const moved = interest('448.00', '2028-01-03', { taxYear: 2027, flags: [{ code: 'ATTRIBUTED_BY_10_DAY_RULE', details: {} }] });
  const year2027 = [before, march, july, moved];
  const sets = setsOf({ [L]: [S1, S2, S3] });

  it('per property and per owner, to the cent; the debit before S1 not attributed in both views; nothing estimated', () => {
    const [v1, v2] = [viewOf(readOf(P1, year2027, sets)), viewOf(readOf(P2, year2027, sets))];
    expect(line(v1).items.map((i) => [i.sourceId, i.lineAmount?.amount, i.loanAllocation?.allocationSetId, i.loanAllocation?.share])).toEqual([
      [march.item.sourceId, '270.01', S1.id, '3/5'],
      [july.item.sourceId, '225.00', S2.id, '1/2'],
      [moved.item.sourceId, '313.60', S3.id, '7/10'],
    ]);
    expect(line(v2).items.map((i) => i.lineAmount?.amount)).toEqual(['180.00', '224.99', '134.40']);
    expect([line(v1).total.amount, line(v2).total.amount]).toEqual(['808.61', '539.39']);
    expect(centsOf(line(v1).total) + centsOf(line(v2).total)).toBe(134800n);
    expect([ownerLine(v1, A), ownerLine(v1, B), ownerLine(v2, C)]).toEqual(['404.31', '404.30', '539.39']);
    // The owners of each item: A 135.01 / B 135.00 (the tie to the lower ownerPartyId), 112.50 each, 156.80 each.
    const a = viewOf(readOf(P1, year2027, sets), 2027, A);
    expect(line(a).items.map((i) => [i.lineAmount?.amount, i.share?.share, i.loanAllocation?.propertyPart?.amount])).toEqual([
      ['135.01', '1/2', '270.01'],
      ['112.50', '1/2', '225.00'],
      ['156.80', '1/2', '313.60'],
    ]);
    expect(line(viewOf(readOf(P1, year2027, sets), 2027, B)).items.map((i) => i.lineAmount?.amount)).toEqual(['135.00', '112.50', '156.80']);
    for (const v of [v1, v2, a]) {
      expect(v.notAttributed.items.map((i) => [i.sourceId, i.lineAmount, i.share, i.notAttributed?.reason, i.notAttributed?.candidates])).toEqual([
        [before.item.sourceId, null, null, 'NO_LOAN_ALLOCATION', [P1, P2]],
      ]);
      expect(v.notAttributed.items[0]?.notAttributed?.href).toBe(`/api/v1/loans/${L}/allocations?asOf=2027-01-29`);
      expect(v.notAttributed.items[0]?.loanAllocation).toEqual({
        loanId: L,
        allocationSetId: null,
        validFrom: null,
        validUntil: null,
        basis: null,
        share: null,
        propertyPart: null,
      });
      expect(flag(v, 'LOAN_INTEREST_NOT_ATTRIBUTED')).toEqual({ loanIds: [L], interestTotal: eur('451.20').toJSON(), splitIds: [before.item.sourceId] });
      expect(v.review.open).toContainEqual({ code: 'LOAN_INTEREST_NOT_ATTRIBUTED', count: 1 });
      expect(codes(v.flags)).not.toContain('UNATTRIBUTED_ITEMS');
    }
    // The item's set and its derived end; the moved debit keeps its open 10-day flag (decision 7).
    expect(line(v1).items[1]?.loanAllocation).toEqual({
      loanId: L,
      allocationSetId: S2.id,
      validFrom: '2027-07-01',
      validUntil: '2027-12-31',
      basis: 'MANUAL',
      share: '1/2',
      propertyPart: eur('225.00'),
    });
    expect(line(v1).items[2]).toMatchObject({ date: '2028-01-03', taxYear: 2027, reviewState: 'SUGGESTED', origin: 'DEFAULT', amount: eur('448.00') });
    expect(v1.review.open).toContainEqual({ code: 'ATTRIBUTED_BY_10_DAY_RULE', count: 1 });
  });

  it('2028 lists neither the moved debit nor its flag; without S3 the moved debit takes S2’s 224.00 each', () => {
    // The repository keeps only the splits of `year` (§58A): 2028 has none of these.
    for (const pr of [P1, P2]) expect(codes(viewOf(readOf(pr, [], sets), 2028).flags)).not.toContain('LOAN_INTEREST_NOT_ATTRIBUTED');
    const withoutS3 = setsOf({ [L]: [S1, S2] });
    expect([line(viewOf(readOf(P1, [moved], withoutS3))), line(viewOf(readOf(P2, [moved], withoutS3)))].map((l) => l.total.amount)).toEqual([
      '224.00',
      '224.00',
    ]);
  });

  it('no retroactive re-distribution: appending S2 and S3 leaves the earlier debit’s parts unchanged', () => {
    const parts = (s: ReadonlyMap<string, readonly LoanAllocationSetView[]>) =>
      [P1, P2].map((pr) => line(viewOf(readOf(pr, [march], s))).items.map((i) => i.lineAmount?.amount));
    expect(parts(setsOf({ [L]: [S1] }))).toEqual([['270.01'], ['180.00']]);
    expect(parts(sets)).toEqual([['270.01'], ['180.00']]);
  });

  it('the PURCHASE_PRICE variant: the same parts, and the open flag on each item in both views', () => {
    const S1p = { ...S1, basis: 'PURCHASE_PRICE' as const };
    const priced = setsOf({ [L]: [S1p, S2, S3] });
    for (const [pr, part] of [
      [P1, '270.01'],
      [P2, '180.00'],
    ] as const) {
      for (const owner of [null, pr === P1 ? A : C]) {
        const v = viewOf(readOf(pr, [march, july], priced), 2027, owner);
        const [first, second] = line(v).items;
        expect(first?.loanAllocation?.propertyPart?.amount).toBe(part);
        expect(first?.flags.filter((f) => f.code === 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY')).toEqual([
          { code: 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', details: { loanId: L, allocationSetId: S1.id } },
        ]);
        // July's set is MANUAL: no flag there.
        expect(codes(second?.flags ?? [])).not.toContain('LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY');
        expect(v.review.open).toContainEqual({ code: 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', count: 1 });
        expect(v.review.final).toBe(false);
      }
    }
  });
});

describe('§58D: the three cases', () => {
  it('attributed elsewhere: a set naming only P2 puts nothing into P1’s view, neither an item nor the flag', () => {
    const sets = setsOf({ [L]: [set({ validFrom: '2027-01-01', shares: [[P2, '1/1']] })] });
    const split = interest('100.00', '2027-03-01');
    expect(loanInterestOf(P1, [split], sets).map((c) => c.kind)).toEqual(['ELSEWHERE']);
    const v = viewOf(readOf(P1, [split], sets));
    expect([placed(v), v.notAttributed.items, flag(v, 'LOAN_INTEREST_NOT_ATTRIBUTED')]).toEqual([[], [], undefined]);
    expect(line(viewOf(readOf(P2, [split], sets))).total.amount).toBe('100.00');
  });

  it('not attributed: no set at all on the day, the day before the first set, and a set whose shares sum to 9/10', () => {
    const later = set({ validFrom: '2027-06-01', shares: [[P1, '1/1']] });
    const broken = set({
      validFrom: '2027-06-01',
      shares: [
        [P1, '1/2'],
        [P2, '2/5'],
      ],
    });
    const dayBefore = interest('10.00', '2027-05-31');
    const onDay = interest('20.00', '2027-06-01');
    const cases = loanInterestOf(P1, [dayBefore, onDay], setsOf({ [L]: [later] }));
    expect(cases.map((c) => c.kind)).toEqual(['NOT_ATTRIBUTED', 'ATTRIBUTED']);
    const v = viewOf(readOf(P1, [dayBefore, onDay], setsOf({ [L]: [broken] })));
    expect(v.notAttributed.items.map((i) => [i.sourceId, i.notAttributed?.reason, i.loanAllocation?.allocationSetId, i.loanAllocation?.basis])).toEqual([
      [dayBefore.item.sourceId, 'NO_LOAN_ALLOCATION', null, null],
      [onDay.item.sourceId, 'ALLOCATION_SUM_NOT_ONE', broken.id, 'MANUAL'],
    ]);
    // No estimate: in no line, no total, no owner, no NOT_OWNED.
    expect([placed(v), v.werbungskosten.total.amount, v.owners, v.notOwned]).toEqual([[], '0.00', [], null]);
    expect(flag(v, 'LOAN_INTEREST_NOT_ATTRIBUTED')).toEqual({
      loanIds: [L],
      interestTotal: eur('30.00').toJSON(),
      splitIds: [dayBefore.item.sourceId, onDay.item.sourceId].sort(),
    });
    for (const i of v.notAttributed.items) expect(['NO_LOAN_ALLOCATION', 'ALLOCATION_SUM_NOT_ONE']).toContain(i.notAttributed?.reason);
  });

  it('the set by the booking date: validFrom takes the new set, the day before the old; a VOID set covers nothing and the previous one extends', () => {
    const old = set({ validFrom: '2027-01-01', shares: [[P1, '1/1']] });
    const next = set({
      validFrom: '2027-06-01',
      shares: [
        [P1, '1/2'],
        [P2, '1/2'],
      ],
    });
    const voided = set({
      validFrom: '2027-06-01',
      shares: [
        [P1, '1/2'],
        [P2, '1/2'],
      ],
      status: 'VOID',
    });
    const [onFrom, dayBefore] = [interest('100.00', '2027-06-01'), interest('100.00', '2027-05-31')];
    expect(line(viewOf(readOf(P1, [dayBefore, onFrom], setsOf({ [L]: [old, next] })))).items.map((i) => i.loanAllocation?.allocationSetId)).toEqual([
      old.id,
      next.id,
    ]);
    const extended = line(viewOf(readOf(P1, [dayBefore, onFrom], setsOf({ [L]: [old, voided] }))));
    expect(extended.items.map((i) => [i.loanAllocation?.allocationSetId, i.loanAllocation?.validUntil, i.lineAmount?.amount])).toEqual([
      [old.id, null, '100.00'],
      [old.id, null, '100.00'],
    ]);
    // A 10-day-rule split and a taxYear override across a set change: the booking date's set, not the tax year's.
    const newYear = set({
      validFrom: '2028-01-01',
      shares: [
        [P1, '1/2'],
        [P2, '1/2'],
      ],
    });
    const tenDay = interest('100.00', '2028-01-02', { taxYear: 2027 });
    const overridden = interest('100.00', '2027-06-02', { taxYear: 2026, origin: 'CLASSIFICATION', reviewState: 'USER_CONFIRMED' });
    expect(line(viewOf(readOf(P1, [tenDay], setsOf({ [L]: [old, newYear] })))).items[0]?.loanAllocation?.allocationSetId).toBe(newYear.id);
    expect(line(viewOf(readOf(P1, [overridden], setsOf({ [L]: [old, next] })), 2026)).items[0]?.loanAllocation?.allocationSetId).toBe(next.id);
  });
});

describe('§58D: PURCHASE_PRICE sets (decided 2026-10-31, third set)', () => {
  const twoEntries = (basis: AllocationBasis) =>
    set({
      validFrom: '2027-01-01',
      shares: [
        [P1, '123457/200000'],
        [P2, '76543/200000'],
      ],
      basis,
    });
  const split = interest('999.99', '2027-03-01');

  it('two entries attribute with exactly a MANUAL set’s parts, flagged open in every place, not cleared by a confirmed classification', () => {
    const priced = twoEntries('PURCHASE_PRICE');
    const manual = twoEntries('MANUAL');
    for (const pr of [P1, P2]) {
      expect(line(viewOf(readOf(pr, [split], setsOf({ [L]: [priced] })))).total).toEqual(line(viewOf(readOf(pr, [split], setsOf({ [L]: [manual] })))).total);
      expect(codes(line(viewOf(readOf(pr, [split], setsOf({ [L]: [manual] })))).items[0]?.flags ?? [])).toEqual([]);
    }
    const sets = setsOf({ [L]: [priced] });
    const notRelevant = interest('50.00', '2027-04-01', { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' });
    const confirmed = interest('70.00', '2027-05-01', { origin: 'CLASSIFICATION', reviewState: 'USER_CONFIRMED' });
    for (const owner of [null, A]) {
      const v = viewOf(readOf(P1, [split, notRelevant, confirmed], sets), 2027, owner);
      const items = [...line(v).items, ...v.notInView.items];
      expect(items).toHaveLength(3);
      for (const item of items) {
        expect(item.flags.find((f) => f.code === 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY')?.details).toEqual({ loanId: L, allocationSetId: priced.id });
        expect(flagIsOpen('LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', item)).toBe(true);
      }
      expect(v.notInView.items[0]).toMatchObject({ lineAmount: null, loanAllocation: { basis: 'PURCHASE_PRICE', share: '123457/200000' } });
      expect(v.review.open).toContainEqual({ code: 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', count: 3 });
      expect(v.review.final).toBe(false);
    }
    expect(viewOf(readOf(P1, [split], sets)).notAttributed.items).toEqual([]);
  });

  it('a one-entry PURCHASE_PRICE set and a MANUAL set attribute without the flag', () => {
    for (const s of [
      set({ validFrom: '2027-01-01', shares: [[P1, '1/1']], basis: 'PURCHASE_PRICE' }),
      set({ validFrom: '2027-01-01', shares: [[P1, '1/1']] }),
    ]) {
      const v = viewOf(readOf(P1, [split], setsOf({ [L]: [s] })));
      expect(line(v).total.amount).toBe('999.99');
      expect(codes(placed(v).flatMap((i) => i.flags))).toEqual([]);
      expect(v.review.open.map((o) => o.code)).toEqual(['DEPRECIATION_NOT_AVAILABLE', 'NO_ASSET']);
    }
  });
});

describe('§58D: placement, owners and review (decision 7)', () => {
  const sets = setsOf({
    [L]: [
      set({
        validFrom: '2027-01-01',
        shares: [
          [P1, '3/5'],
          [P2, '2/5'],
        ],
      }),
    ],
  });

  it('placement by meaning: DEDUCTIBLE on the line; NOT_RELEVANT in notInView; UNCLASSIFIED; CAPITALIZED with its open flag; NEEDS_REVIEW open', () => {
    const deductible = interest('100.00', '2027-02-01');
    const notRelevant = interest('100.00', '2027-03-01', { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', origin: 'CLASSIFICATION' });
    const unclassified = interest('100.00', '2027-04-01', { taxCategory: 'UNCLASSIFIED', treatment: null, reviewState: 'NEEDS_REVIEW' });
    const capitalized = interest('100.00', '2027-05-01', { treatment: 'CAPITALIZED', origin: 'CLASSIFICATION', reviewState: 'USER_CONFIRMED' });
    const v = viewOf(readOf(P1, [deductible, notRelevant, unclassified, capitalized], sets));
    expect(line(v).items.map((i) => [i.sourceId, i.lineAmount?.amount, i.treatment, i.reviewState])).toEqual([
      [deductible.item.sourceId, '60.00', 'DEDUCTIBLE', 'SUGGESTED'],
    ]);
    for (const [items, source] of [
      [v.notInView.items, notRelevant],
      [v.unclassified.items, unclassified],
    ] as const) {
      expect(items.map((i) => [i.sourceId, i.lineAmount, i.loanAllocation?.propertyPart?.amount])).toEqual([[source.item.sourceId, null, '60.00']]);
    }
    expect(v.capitalized).toMatchObject({ total: eur('60.00'), items: [{ sourceId: capitalized.item.sourceId, lineAmount: eur('60.00') }] });
    expect(v.capitalized.items[0]?.flags).toContainEqual({
      code: 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS',
      details: { loanId: L, allocationSetId: expect.any(String) },
    });
    expect(v.review.open).toEqual(
      expect.arrayContaining([
        { code: 'LOAN_INTEREST_CAPITALIZED_NOT_IN_BASIS', count: 1 },
        { code: 'NEEDS_REVIEW', count: 1 },
        { code: 'UNCLASSIFIED', count: 1 },
      ]),
    );
    expect(codes(line(v).items[0]?.flags ?? [])).toEqual([]);
    // Counts: every Loan item in reviewStates and ruleVersions.
    expect(v.review.reviewStates).toMatchObject({ SUGGESTED: 2, NEEDS_REVIEW: 1, USER_CONFIRMED: 1 });
    expect(v.ruleVersions.find((r) => r.ruleCode === 'DE_CATEGORY_DEFAULTS')?.itemCount).toBe(4);
  });

  it('a negative amount (a synthetic INFLOW): negative parts, REDUCES_LINE, and interestTotal subtracting it', () => {
    const refund = interest('100.01', '2027-02-01', { direction: 'INFLOW' });
    const [v1, v2] = [P1, P2].map((pr) => viewOf(readOf(pr, [refund], sets)));
    expect([line(v1 as TaxYearView).items[0]?.lineAmount?.amount, line(v2 as TaxYearView).items[0]?.lineAmount?.amount]).toEqual(['-60.01', '-40.00']);
    expect(line(v1 as TaxYearView).items[0]?.refund?.presentation).toBe('REDUCES_LINE');
    expect(line(v1 as TaxYearView).items[0]?.loanAllocation?.propertyPart).toEqual(eur('60.01'));
    const unallocated = interest('30.00', '2027-02-01');
    const gap = interest('10.00', '2026-12-01', { direction: 'INFLOW', taxYear: 2027 });
    expect(
      flag(viewOf(readOf(P1, [unallocated, gap], setsOf({ [L]: [set({ validFrom: '2027-03-01', shares: [[P1, '1/1']] })] }))), 'LOAN_INTEREST_NOT_ATTRIBUTED'),
    ).toMatchObject({
      interestTotal: eur('20.00').toJSON(),
    });
  });

  it('owners on the booking date; without an Ownership the part is NOT_OWNED with OWNERSHIP_INCOMPLETE; an owner by interest alone takes part', () => {
    const split = interest('100.00', '2027-02-01');
    const none = viewOf(readOf(P1, [split], sets, { ownerships: [] }));
    expect(line(none).total.amount).toBe('60.00');
    expect(none.notOwned?.werbungskosten.total.amount).toBe('60.00');
    expect(codes(none.flags)).toContain('OWNERSHIP_INCOMPLETE');
    // Participation: B owns from 2028 only, and holds the booking date's share of a 10-day-rule split of 2027; B's only
    // part in 2027 is this interest, so B is an owner in the year (no NOT_AN_OWNER_IN_YEAR).
    const moved = interest('100.00', '2028-01-05', { taxYear: 2027 });
    const owner2028 = [own(B, '1/1', '2028-01-01')];
    const sets2028 = setsOf({ [L]: [set({ validFrom: '2027-01-01', shares: [[P1, '1/1']] })] });
    const b = buildTaxYearView(readOf(P1, [moved], sets2028, { ownerships: owner2028 }), { year: 2027, ownerPartyId: B, today, registry: TAX_RULES });
    expect(b.kind).toBe('VIEW');
    if (b.kind === 'VIEW') {
      expect(line(b.view).items.map((i) => i.lineAmount?.amount)).toEqual(['100.00']);
      expect(line(b.view).items[0]?.flags).toContainEqual({
        code: 'SHARE_DATE_OUTSIDE_TAX_YEAR',
        details: { shareDate: '2028-01-05', nearestDayOfYear: '2027-12-31' },
      });
    }
  });

  it('the cap counts the Loan items: 5,000 with them → the view; 5,001 → TAX_YEAR_TOO_LARGE; an item elsewhere does not count', () => {
    const elsewhere = setsOf({ [L]: [set({ validFrom: '2027-01-01', shares: [[P2, '1/1']] })] });
    const many = (n: number, loanId: string) => Array.from({ length: n }, () => interest('1.00', '2027-02-01', { loanId }));
    const mixed = (n: number) => {
      // 'gap' is a Loan without a set: its splits are not attributed, and count.
      return readOf(P1, [...many(TAX_YEAR_ITEM_LIMIT - 1, L), ...many(n, 'gap')], sets);
    };
    expect(buildTaxYearView(mixed(1), { year: 2027, ownerPartyId: null, today, registry: TAX_RULES }).kind).toBe('VIEW');
    expect(buildTaxYearView(mixed(2), { year: 2027, ownerPartyId: null, today, registry: TAX_RULES })).toEqual({
      kind: 'TAX_YEAR_TOO_LARGE',
      itemCount: 5001,
      limit: 5000,
    });
    expect(buildTaxYearView(readOf(P1, many(TAX_YEAR_ITEM_LIMIT + 1, L), elsewhere), { year: 2027, ownerPartyId: null, today, registry: TAX_RULES }).kind).toBe(
      'VIEW',
    );
  });

  it('the attributed items are merged into the list’s items by date, Transaction and position', () => {
    const tx = '00000000-0000-4000-8000-000000000500';
    const second = interest('10.00', '2027-02-01', { transactionId: tx, position: 2 });
    const first = interest('20.00', '2027-02-01', { transactionId: tx, position: 1 });
    const earlier = interest('30.00', '2027-01-15');
    const v = viewOf(readOf(P1, [earlier, first, second], sets));
    expect(line(v).items.map((i) => i.sourceId)).toEqual([earlier, first, second].map((s) => s.item.sourceId));
  });
});

describe('§58D: rounding (decision 6)', () => {
  it('per split, never the year’s total: three debits of 0.01 over 1/2 and 1/2 give P1 0.03 and P2 0.00 (a total distributed once would give 0.02 and 0.01)', () => {
    const sets = setsOf({
      [L]: [
        set({
          validFrom: '2027-01-01',
          shares: [
            [P1, '1/2'],
            [P2, '1/2'],
          ],
        }),
      ],
    });
    const cents = [interest('0.01', '2027-02-01'), interest('0.01', '2027-03-01'), interest('0.01', '2027-04-01')];
    expect(line(viewOf(readOf(P1, cents, sets))).items.map((i) => i.lineAmount?.amount)).toEqual(['0.01', '0.01', '0.01']);
    expect(line(viewOf(readOf(P2, cents, sets))).items.map((i) => i.lineAmount?.amount)).toEqual(['0.00', '0.00', '0.00']);
  });

  it('a tie on the remainder goes by propertyReferenceId, not to the larger share: 0.02 over P1 1/4 and P2 3/4 is 0.01 each', () => {
    const sets = setsOf({
      [L]: [
        set({
          validFrom: '2027-01-01',
          shares: [
            [P2, '3/4'],
            [P1, '1/4'],
          ],
        }),
      ],
    });
    const split = interest('0.02', '2027-02-01');
    expect([P1, P2].map((pr) => line(viewOf(readOf(pr, [split], sets))).total.amount)).toEqual(['0.01', '0.01']);
  });
});

describe('§58D: the property test', () => {
  /** A small deterministic generator (mulberry32), so a failure is reproducible. */
  const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('per split, the parts over all the set’s PropertyReferences sum to A, each equals distribute’s and has A’s sign; owners + NOT_OWNED = the property', () => {
    const next = random(58);
    const int = (n: number) => 1 + Math.floor(next() * n);
    for (let run = 0; run < 60; run++) {
      const entries = int(run % 3 === 0 ? 50 : 6);
      const large = run % 5 === 0;
      // Weights summing to at most 10,000, or a PURCHASE_PRICE-like large denominator (prices in cents).
      const weights = Array.from({ length: entries }, () => BigInt(large ? int(90_000_000) : int(Math.max(1, Math.floor(10_000 / entries)))));
      const total = weights.reduce((s, w) => s + w, 0n);
      const prs = Array.from({ length: entries }, (_, i) => `0000cccc-0000-4000-8000-${String(i).padStart(12, '0')}`);
      const s = set({
        validFrom: '2027-01-01',
        shares: prs.map((pr, i) => [pr, `${weights[i]}/${total}`] as const),
        basis: large ? 'PURCHASE_PRICE' : 'MANUAL',
      });
      const sets = setsOf({ [L]: [s] });
      const direction: Direction = next() < 0.2 ? 'INFLOW' : 'OUTFLOW';
      const cents = BigInt(int(5_000_000));
      const split = interest(`${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`, '2027-06-15', { direction });
      const signed = direction === 'OUTFLOW' ? cents : -cents;
      const expected = distribute(signed, s.allocations);
      let sum = 0n;
      prs.forEach((pr, i) => {
        const ownerships = Array.from({ length: int(3) - 1 }, (_, k) =>
          own(`${k}${'d'.repeat(7)}-0000-4000-8000-000000000000`, `1/${int(4) + 1}`, '2026-01-01'),
        );
        const v = viewOf(readOf(pr, [split], sets, { ownerships }));
        const item = line(v).items[0] as TaxYearItem;
        const part = centsOf(item.lineAmount as Money);
        expect(part, `run ${run}, entry ${i}`).toBe(expected[i]);
        expect(part * signed >= 0n).toBe(true);
        sum += part;
        const holders = [...(v.owners ?? []), ...(v.notOwned === null ? [] : [v.notOwned])];
        expect(holders.reduce((t, o) => t + centsOf(o.werbungskosten.total), 0n)).toBe(part);
        expect(holders.reduce((t, o) => t + centsOf(o.result.amount), 0n)).toBe(centsOf(v.result.amount));
        expect(v.notOwned === null ? 0 : 1).toBe(v.flags.some((f) => f.code === 'OWNERSHIP_INCOMPLETE') ? 1 : 0);
        expect(codes(item.flags).includes('LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY')).toBe(large && entries > 1);
      });
      expect(sum).toBe(signed);
    }
  });
});
