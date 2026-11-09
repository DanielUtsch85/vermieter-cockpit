import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import type { TaxListItem, TaxMeaning } from './classification.js';
import type { DepositTaxMeaning } from './deposit-closing.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import { PHASE_7_DEPRECIATION } from './tax-year-depreciation.test-support.js';
import { TAX_YEAR_PLACES, buildTaxYearView, type TaxYearItem, type TaxYearRead, type TaxYearView, type ViewOwnership } from './tax-year-view.js';
import type { Origin, ReviewState, TaxCategory, Treatment } from './vocabulary.js';

/**
 * §58C "Follow-up: the level on the item flags" (Entscheidung des Projektinhabers, 2026-11-09): every money item's flag
 * carries `level`, judged per raised flag (its details included) by the rule `review` counts by; the money, `final` and
 * `review` are as without it. Synthetic figures and ids only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const PR = '0000aaaa-0000-4000-8000-0000000000c1';
const [A, B] = ['a', 'b'].map((c) => `${c.repeat(8)}-0000-4000-8000-0000000000c0`) as [string, string];
const CASH = { ruleCode: 'DE_CASH_TIMING', version: 1 };
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
type Raised = { readonly code: string; readonly details: unknown };
const MIXED = 'CONSTRUCTION_PERIOD_TREATMENT_MIXED';

function split(o: {
  amount: string;
  taxCategory: TaxCategory;
  treatment: Treatment | null;
  flags?: readonly Raised[];
  origin?: Origin;
  reviewState?: ReviewState;
}): TaxListItem {
  const bookingDate = day('2027-03-10');
  const amount = Money.of(o.amount, 'EUR');
  const sourceId = id();
  const meaning: TaxMeaning = {
    splitId: sourceId,
    sourceId,
    sourceType: 'TRANSACTION_SPLIT',
    transactionId: id(),
    position: 1,
    bookingDate,
    direction: TAX_YEAR_PLACES[o.taxCategory] === 'EINNAHMEN' ? 'INFLOW' : 'OUTFLOW',
    amount,
    financialCategoryCode: 'X',
    categoryType: 'OPERATING_EXPENSE',
    propertyReferenceId: PR,
    transactionStatus: 'CONFIRMED',
    correctionRole: null,
    counts: true,
    taxCategory: o.taxCategory,
    treatment: o.treatment,
    reviewState: o.reviewState ?? 'SUGGESTED',
    origin: o.origin ?? 'DEFAULT',
    rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
    classificationId: o.origin === 'CLASSIFICATION' ? id() : null,
    taxYear: 2027,
    attribution: { rule: CASH, bookingYear: 2027, proposedYear: 2027, overridden: false },
    refund: null,
    netAmount: null,
    performance: null,
    treatmentRule: null,
    distribution: null,
    suggestion: null,
    // Raised as the list raises them; the codes and details are what the view judges, so the union is cast here.
    flags: (o.flags ?? []) as unknown as TaxMeaning['flags'],
  };
  return { ...meaning, yearAmount: amount };
}

const half = (party: string): ViewOwnership => ({
  id: id(),
  partyId: party,
  share: { numerator: 1, denominator: 2 },
  validFrom: day('2020-01-01'),
  validUntil: null,
});
const OWNERS = [half(A), half(B)];

const viewOf = (items: readonly TaxListItem[], extra: Partial<TaxYearRead> = {}, ownerPartyId: string | null = null): TaxYearView => {
  const read: TaxYearRead = {
    propertyReferenceId: PR,
    ownerPartyFound: null,
    sources: items.map((item) => ({ item, listed: true })),
    unattributedDeposits: [],
    ownerships: OWNERS,
    checks: [],
    attribution: { references: [], candidates: [] },
    allocatedLoanInterest: [],
    loanAllocationSets: new Map(),
    depreciation: PHASE_7_DEPRECIATION,
    ...extra,
  };
  const outcome = buildTaxYearView(read, { year: 2027, ownerPartyId, today: day('2028-03-01'), registry: TAX_RULES, fingerprinter });
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
};

/** Every item of the view, AfA items aside. */
const itemsOf = (v: TaxYearView): readonly TaxYearItem[] => [
  ...v.einnahmen.lines.flatMap((l) => l.items),
  ...v.werbungskosten.lines.flatMap((l) => l.items),
  ...v.capitalized.items,
  ...v.notInView.items,
  ...v.unclassified.items,
  ...v.notAttributed.items,
];
const levels = (item: TaxYearItem | undefined) => item?.flags.map((f) => [f.code, f.level]);
const money = (v: TaxYearView) => ({
  einnahmen: v.einnahmen.total.toJSON(),
  werbungskosten: v.werbungskosten.total.toJSON(),
  result: v.result.amount.toJSON(),
  capitalized: v.capitalized.total.toJSON(),
  lines: [...v.einnahmen.lines, ...v.werbungskosten.lines].map((l) => [l.line, l.total.toJSON(), l.items.map((i) => i.lineAmount?.toJSON() ?? null)]),
  owners: v.owners?.map((o) => [o.ownerPartyId, o.einnahmen.total.toJSON(), o.werbungskosten.total.toJSON(), o.result.amount.toJSON()]),
});
/** The view without the levels: every item flag back to `{ code, details }`. */
const withoutLevels = (v: TaxYearView) =>
  JSON.parse(
    JSON.stringify(v, (key, value) => (key === 'level' && typeof value === 'string' && value !== 'PROPERTY' && value !== 'OWNER' ? undefined : value)),
  );

describe('the level on the money item flags of the tax-year view (§58C follow-up, 2026-11-09)', () => {
  it('OPEN and INFORMATIVE on money items, judged per raised flag by its details as review counts them, at both levels', () => {
    const open = split({
      amount: '300.00',
      taxCategory: 'MAINTENANCE',
      treatment: 'DEDUCTIBLE',
      flags: [{ code: MIXED, details: { recordReviewState: 'CONFIRMED' } }],
    });
    const closed = split({
      amount: '200.00',
      taxCategory: 'MAINTENANCE',
      treatment: 'DEDUCTIBLE',
      flags: [{ code: MIXED, details: { recordReviewState: 'ADVISOR_CONFIRMED' } }],
    });
    const due = { code: 'DUE_DATE_ASSUMED', details: {} };
    const rentOpen = split({ amount: '900.00', taxCategory: 'RENT', treatment: 'INCOME', flags: [due] });
    const rentConfirmed = split({
      amount: '900.00',
      taxCategory: 'RENT',
      treatment: 'INCOME',
      flags: [due],
      origin: 'CLASSIFICATION',
      reviewState: 'USER_CONFIRMED',
    });
    for (const owner of [null, A]) {
      const v = viewOf([open, closed, rentOpen, rentConfirmed], {}, owner);
      const at = (s: TaxListItem) => itemsOf(v).find((i) => i.sourceId === s.sourceId);
      // The same code, OPEN or INFORMATIVE by the raised flag's own details (the advisor's confirmation of the record).
      expect([levels(at(open)), levels(at(closed))]).toEqual([[[MIXED, 'OPEN']], [[MIXED, 'INFORMATIVE']]]);
      // The same code and details, the level by the item (a confirmed classification closes it).
      expect([levels(at(rentOpen)), levels(at(rentConfirmed))]).toEqual([[['DUE_DATE_ASSUMED', 'OPEN']], [['DUE_DATE_ASSUMED', 'INFORMATIVE']]]);
      expect(v.review.open).toEqual(
        expect.arrayContaining([
          { code: MIXED, count: 1 },
          { code: 'DUE_DATE_ASSUMED', count: 1 },
        ]),
      );
      expect(v.review.info).toEqual(
        expect.arrayContaining([
          { code: MIXED, count: 1 },
          { code: 'DUE_DATE_ASSUMED', count: 1 },
        ]),
      );
      expect(v.review.final).toBe(false);
      // Every item flag carries its level, in the one shape, and agrees with the review.
      for (const flag of itemsOf(v).flatMap((i) => i.flags)) {
        expect(Object.keys(flag)).toEqual(['code', 'level', 'details']);
        expect((flag.level === 'OPEN' ? v.review.open : v.review.info).map((e) => e.code)).toContain(flag.code);
      }
    }
  });

  it('one item carrying two codes of different levels: each keeps its own level, also on the item that closes one of them', () => {
    const both = split({
      amount: '120.00',
      taxCategory: 'MAINTENANCE',
      treatment: 'DEDUCTIBLE',
      flags: [
        { code: 'REFUND_YEAR_UNKNOWN', details: {} },
        { code: 'VAT_NOT_SEPARATED', details: {} },
        { code: MIXED, details: { recordReviewState: 'ADVISOR_CONFIRMED' } },
      ],
    });
    for (const owner of [null, A, B]) {
      const item = itemsOf(viewOf([both], {}, owner)).find((i) => i.sourceId === both.sourceId);
      expect(levels(item), String(owner)).toEqual([
        ['REFUND_YEAR_UNKNOWN', 'OPEN'],
        ['VAT_NOT_SEPARATED', 'INFORMATIVE'],
        [MIXED, 'INFORMATIVE'],
      ]);
    }
  });

  it('every place of the view: capitalized, notInView, unclassified and notAttributed items carry the level as well', () => {
    const flags = [{ code: 'VAT_NOT_SEPARATED', details: {} }];
    const capitalised = split({ amount: '5000.00', taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED', flags });
    const reserve = split({ amount: '600.00', taxCategory: 'MAINTENANCE', treatment: 'NOT_RELEVANT', flags });
    const open = split({ amount: '40.00', taxCategory: 'MAINTENANCE', treatment: null, flags });
    const deposit = {
      sourceType: 'DEPOSIT_CLOSING',
      sourceId: id(),
      closingDate: '2027-06-30',
      taxYear: 2027,
      amount: Money.of('400.00', 'EUR'),
      taxCategory: 'UNCLASSIFIED',
      treatment: null,
      reviewState: 'NEEDS_REVIEW',
      origin: 'DEFAULT',
      classificationId: null,
      rule: null,
      propertyCandidates: [],
      flags: [{ code: 'NO_PROPERTY_REFERENCE', details: { reason: 'NO_RECONCILED_RENT' } }],
    } as unknown as DepositTaxMeaning;
    const v = viewOf([capitalised, reserve, open], { unattributedDeposits: [deposit] });
    const kinds = {
      capitalized: v.capitalized.items,
      notInView: v.notInView.items,
      unclassified: v.unclassified.items,
      notAttributed: v.notAttributed.items,
    };
    for (const [kind, items] of Object.entries(kinds)) {
      expect(items.length, kind).toBeGreaterThan(0);
      for (const f of items.flatMap((i) => i.flags)) expect(['OPEN', 'INFORMATIVE'], `${kind} ${f.code}`).toContain(f.level);
    }
    expect(levels(v.notAttributed.items[0])).toEqual([
      ['NO_PROPERTY_REFERENCE', 'INFORMATIVE'],
      ['NEEDS_REVIEW', 'OPEN'],
      ['UNCLASSIFIED', 'OPEN'],
    ]);
  });

  it('the money sums, final and review are unchanged: the open and the informative flag, and no flag at all, give the same figures', () => {
    const rent = split({ amount: '1000.01', taxCategory: 'RENT', treatment: 'INCOME' });
    const variant = (flags: readonly Raised[]) => [
      rent,
      split({ amount: '333.33', taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', flags }),
      split({ amount: '5000.00', taxCategory: 'MAINTENANCE', treatment: 'CAPITALIZED', flags }),
    ];
    const opened = viewOf(variant([{ code: MIXED, details: { recordReviewState: 'CONFIRMED' } }]));
    const informative = viewOf(variant([{ code: MIXED, details: { recordReviewState: 'ADVISOR_CONFIRMED' } }]));
    const none = viewOf(variant([]));
    expect(money(opened)).toEqual(money(none));
    expect(money(informative)).toEqual(money(none));
    expect(money(none)).toMatchObject({ einnahmen: { amount: '1000.01' }, werbungskosten: { amount: '333.33' }, result: { amount: '666.68' } });
    // The levels are the only addition: without them the item flags are `{ code, details }`, and the review counts by the same rule.
    const stripped = withoutLevels(opened);
    expect(stripped.werbungskosten.lines.flatMap((l: { items: { flags: object[] }[] }) => l.items.flatMap((i) => i.flags))).toEqual([
      { code: MIXED, details: { recordReviewState: 'CONFIRMED' } },
    ]);
    expect(stripped.level).toBe('PROPERTY');
    expect(opened.review.open).toContainEqual({ code: MIXED, count: 2 });
    expect(informative.review.info).toContainEqual({ code: MIXED, count: 2 });
    expect(informative.review.open.map((e) => e.code)).toEqual(none.review.open.map((e) => e.code));
  });
});
