import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate, type RuleVersion } from '../../shared/index.js';
import type { RentDueDay } from '../rental-contract-reference/index.js';
import { attributionChanges, type AttributionInput } from './attribution-changes.js';
import { DUE_DATE_SOURCES, attributeTaxYear, hausgeldTiming, interestTiming, rentTiming, type TimingInput } from './cash-timing.js';
import { deriveTaxMeaning, type SplitFacts, type TaxMeaning } from './classification.js';
import { CASH_TIMING, DE_CASH_TIMING_V1, type CashTimingParameters } from './rules/de-cash-timing.js';
import { CATEGORY_DEFAULTS } from './rules/de-category-defaults.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import type { TaxClassification, TaxClassificationId } from './tax-classification.js';
import { PHASE_7_DEPRECIATION } from './tax-year-depreciation.test-support.js';
import { buildTaxYearView, flagIsOpen, type TaxYearRead, type TaxYearView } from './tax-year-view.js';
import { proposalIsOpen, proposedSplits } from './ten-day-proposal.js';
import type { ReviewState } from './vocabulary.js';

/** Taxation's own versions (api-design §59): a domain test builds its registry and never imports `domains/tax-rules/`. */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);

/**
 * VC-X-39 (api-design.md §58F; owner decisions 2026-11-02): no 10-day shift without a recorded due date. The window
 * 2026-12-22 to 2027-01-10, December and January terms, due days 1–10 and 11–31, the override, the parameter read from
 * the rule, Hausgeld and interest unchanged, the review levels, and the proposal in both years without double counting.
 * Synthetic figures and ids only.
 */
const day = (value: string) => value as BusinessDate;
const at = (bookingDate: string, financialCategoryCode: string) => ({ bookingDate: day(bookingDate), financialCategoryCode });
const codes = (flags: readonly { code: string }[]) => flags.map((f) => f.code);
const due = (d: number, validFrom = '2026-01-01'): RentDueDay[] => [{ validFrom: day(validFrom), day: d }];
const JANUARY = '2027010100';
const DECEMBER = '2026120100';

/** A test registry whose copy of `DE_CASH_TIMING@1` lists other recorded sources (the parameter is read, never a constant). */
function withRecordedSources(recordedSources: readonly string[]): RuleRegistry {
  const copy: RuleVersion<CashTimingParameters> = {
    ...DE_CASH_TIMING_V1,
    parameters: { ...DE_CASH_TIMING_V1.parameters, dueDate: { ...DE_CASH_TIMING_V1.parameters.dueDate, recordedSources } },
  };
  return new RuleRegistry(TAXATION_RULE_VERSIONS.map((v) => (v.ruleCode === CASH_TIMING ? copy : v)));
}

describe('the rule (§58F): condition 4, the due date recorded', () => {
  it('the parameter lists recorded sources only: each a DueDateSource, PERIOD_START never', () => {
    const sources = DE_CASH_TIMING_V1.parameters.dueDate.recordedSources;
    expect([...sources]).toEqual(['RENTAL_CONTRACT_REFERENCE', 'ECONOMIC_PLAN', 'LOAN_SCHEDULE']);
    for (const s of sources) expect(DUE_DATE_SOURCES as readonly string[]).toContain(s);
    expect(sources).not.toContain('PERIOD_START');
    expect(DE_CASH_TIMING_V1.source).toContain('(mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01)');
    expect(DE_CASH_TIMING_V1.source).toContain('2026-11-02');
  });

  it('a January rent paid in the window without a due day stays in the year paid; edges 22 December and 21 December', () => {
    for (const booked of ['2026-12-22', '2026-12-29', '2026-12-31']) {
      const r = attributeTaxYear(at(booked, 'RENT_BASE'), rentTiming(JANUARY, null), null, TAX_RULES);
      expect([r.taxYear, r.attribution.proposedYear, r.attribution.overridden, codes(r.flags)], booked).toEqual([
        2026,
        2027,
        false,
        ['DUE_DATE_ASSUMED', 'PROPOSED_BY_10_DAY_RULE'],
      ]);
    }
    // Outside the window: no source is read, nothing proposed.
    const before = attributeTaxYear(at('2026-12-21', 'RENT_BASE'), rentTiming(JANUARY, null), null, TAX_RULES);
    expect([before.taxYear, before.attribution.proposedYear, before.flags]).toEqual([2026, 2026, []]);
  });

  it('an empty list and a term before the first entry behave as no due day', () => {
    for (const days of [[], due(3, '2027-02-01')]) {
      const r = attributeTaxYear(at('2026-12-29', 'RENT_BASE'), rentTiming(JANUARY, days), null, TAX_RULES);
      expect([r.taxYear, codes(r.flags)]).toEqual([2026, ['DUE_DATE_ASSUMED', 'PROPOSED_BY_10_DAY_RULE']]);
    }
  });

  it('a recorded day 1–10 moves the January rent to January’s year; a day 11–31 keeps the year paid without a flag', () => {
    for (const d of [1, 3, 10]) {
      const r = attributeTaxYear(at('2026-12-29', 'RENT_BASE'), rentTiming(JANUARY, due(d)), null, TAX_RULES);
      expect([r.taxYear, codes(r.flags)], `day ${d}`).toEqual([2027, ['ATTRIBUTED_BY_10_DAY_RULE']]);
      expect(r.flags[0]?.details).toMatchObject({ dueDateSource: 'RENTAL_CONTRACT_REFERENCE' });
    }
    for (const d of [11, 15, 28, 31]) {
      const r = attributeTaxYear(at('2026-12-29', 'RENT_BASE'), rentTiming(JANUARY, due(d)), null, TAX_RULES);
      expect([r.taxYear, r.attribution.proposedYear, r.flags], `day ${d}`).toEqual([2026, 2026, []]);
    }
  });

  it('a December rent paid late without a due day is never moved back nor proposed; with a recorded day 22–31 it moves', () => {
    for (const booked of ['2027-01-01', '2027-01-05', '2027-01-10']) {
      const r = attributeTaxYear(at(booked, 'RENT_BASE'), rentTiming(DECEMBER, null), null, TAX_RULES);
      expect([r.taxYear, r.attribution.proposedYear, codes(r.flags)], booked).toEqual([2027, 2027, ['DUE_DATE_ASSUMED']]);
    }
    // Recorded day 1 (1 December, outside the window): the year paid, no flag.
    const first = attributeTaxYear(at('2027-01-05', 'RENT_BASE'), rentTiming(DECEMBER, due(1)), null, TAX_RULES);
    expect([first.taxYear, first.flags]).toEqual([2027, []]);
    const late = attributeTaxYear(at('2027-01-05', 'RENT_BASE'), rentTiming(DECEMBER, due(28)), null, TAX_RULES);
    expect([late.taxYear, codes(late.flags)]).toEqual([2026, ['ATTRIBUTED_BY_10_DAY_RULE']]);
    // A January rent paid in January has nothing to propose.
    const own = attributeTaxYear(at('2027-01-02', 'RENT_BASE'), rentTiming(JANUARY, null), null, TAX_RULES);
    expect([own.taxYear, codes(own.flags)]).toEqual([2027, ['DUE_DATE_ASSUMED']]);
  });

  it('the evidence of a recorded day: named in dueDateEvidence, or null; with and without it the year moves alike', () => {
    const named: RentDueDay[] = [{ validFrom: day('2026-01-01'), day: 3, evidenceReference: 'Mietvertrag § 4 Abs. 1 (synthetisch)' }];
    const withIt = attributeTaxYear(at('2026-12-29', 'RENT_BASE'), rentTiming(JANUARY, named), null, TAX_RULES);
    const without = attributeTaxYear(at('2026-12-29', 'RENT_BASE'), rentTiming(JANUARY, due(3)), null, TAX_RULES);
    expect([withIt.taxYear, without.taxYear]).toEqual([2027, 2027]);
    expect([withIt.flags[0]?.details, without.flags[0]?.details]).toMatchObject([
      { dueDateEvidence: 'Mietvertrag § 4 Abs. 1 (synthetisch)' },
      { dueDateEvidence: null },
    ]);
    // Loan interest names none.
    const timing = interestTiming(day('2027-01-04'), ['2026-12-30', '2027-01-30'].map(day));
    expect(attributeTaxYear(at('2027-01-04', 'LOAN_INTEREST'), timing, null, TAX_RULES).flags[0]?.details).toMatchObject({ dueDateEvidence: null });
  });

  it('the advance split behaves as the base rent in every case', () => {
    for (const [days, year, flags] of [
      [null, 2026, ['DUE_DATE_ASSUMED', 'PROPOSED_BY_10_DAY_RULE']],
      [due(3), 2027, ['ATTRIBUTED_BY_10_DAY_RULE']],
      [due(15), 2026, []],
    ] as const) {
      const base = attributeTaxYear(at('2026-12-29', 'RENT_BASE'), rentTiming(JANUARY, days), null, TAX_RULES);
      const advance = attributeTaxYear(at('2026-12-29', 'RENT_OPERATING_COST_ADVANCE'), rentTiming(JANUARY, days), null, TAX_RULES);
      expect([advance.taxYear, codes(advance.flags)]).toEqual([year, flags]);
      expect(advance).toEqual(base);
    }
  });

  it('a taxYear decides: 2027 or 2026, overridden, and the proposal stays visible on the item', () => {
    for (const taxYear of [2027, 2026]) {
      const r = attributeTaxYear(at('2026-12-29', 'RENT_BASE'), rentTiming(JANUARY, null), taxYear, TAX_RULES);
      expect([r.taxYear, r.attribution, codes(r.flags)]).toEqual([
        taxYear,
        { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: 2026, proposedYear: 2027, overridden: true },
        ['DUE_DATE_ASSUMED', 'PROPOSED_BY_10_DAY_RULE'],
      ]);
    }
  });

  it('non-recurring categories never move or propose, whatever the timing passed', () => {
    for (const code of ['MAINTENANCE', 'OTHER_INCOME']) {
      const r = attributeTaxYear(at('2026-12-29', code), rentTiming(JANUARY, null), null, TAX_RULES);
      expect([r.taxYear, r.attribution.proposedYear, r.flags], code).toEqual([2026, 2026, []]);
    }
  });

  it('Hausgeld unchanged: never moved, ECONOMIC_PERIOD_ASSUMED, no proposal of the rent’s kind', () => {
    const plan = attributeTaxYear(at('2026-12-30', 'WEG_RECOVERABLE'), hausgeldTiming(day('2026-12-30'), 1), null, TAX_RULES);
    expect([plan.taxYear, codes(plan.flags)]).toEqual([2026, ['ECONOMIC_PERIOD_ASSUMED']]);
    const assumed = attributeTaxYear(at('2026-12-30', 'WEG_NON_RECOVERABLE'), hausgeldTiming(day('2026-12-30'), null), null, TAX_RULES);
    expect([assumed.taxYear, codes(assumed.flags)]).toEqual([2026, ['DUE_DATE_ASSUMED', 'ECONOMIC_PERIOD_ASSUMED']]);
    // ECONOMIC_PLAN removed from the recorded sources changes nothing: the guessed period decides first.
    const without = withRecordedSources(['RENTAL_CONTRACT_REFERENCE', 'LOAN_SCHEDULE']);
    expect(attributeTaxYear(at('2026-12-30', 'WEG_RECOVERABLE'), hausgeldTiming(day('2026-12-30'), 1), null, without)).toEqual(plan);
    // Even PERIOD_START and ECONOMIC_PLAN listed: Hausgeld is never moved on a guess.
    const all = withRecordedSources([...DUE_DATE_SOURCES]);
    expect(attributeTaxYear(at('2026-12-30', 'WEG_NON_RECOVERABLE'), hausgeldTiming(day('2026-12-30'), null), null, all)).toEqual(assumed);
  });

  it('loan interest unchanged: its schedule is a recorded due date and moves the year', () => {
    const timing = interestTiming(day('2027-01-04'), ['2026-11-30', '2026-12-30', '2027-01-30'].map(day));
    const r = attributeTaxYear(at('2027-01-04', 'LOAN_INTEREST'), timing, null, TAX_RULES);
    expect([r.taxYear, codes(r.flags)]).toEqual([2026, ['ATTRIBUTED_BY_10_DAY_RULE']]);
  });

  it('the parameter is read: PERIOD_START listed moves again; RENTAL_CONTRACT_REFERENCE left out only proposes', () => {
    const loose = withRecordedSources([...DE_CASH_TIMING_V1.parameters.dueDate.recordedSources, 'PERIOD_START']);
    const moved = attributeTaxYear(at('2026-12-29', 'RENT_BASE'), rentTiming(JANUARY, null), null, loose);
    expect([moved.taxYear, codes(moved.flags)]).toEqual([2027, ['DUE_DATE_ASSUMED', 'ATTRIBUTED_BY_10_DAY_RULE']]);
    const strict = withRecordedSources(['ECONOMIC_PLAN', 'LOAN_SCHEDULE']);
    const third = attributeTaxYear(at('2026-12-29', 'RENT_BASE'), rentTiming(JANUARY, due(3)), null, strict);
    expect([third.taxYear, codes(third.flags)]).toEqual([2026, ['PROPOSED_BY_10_DAY_RULE']]);
    expect(third.flags[0]?.details).toMatchObject({ dueDate: '2027-01-03', dueDateSource: 'RENTAL_CONTRACT_REFERENCE', proposedYear: 2027 });
  });
});

const facts = (o: Partial<SplitFacts> = {}): SplitFacts => ({
  splitId: '00000000-0000-4000-8000-000000000001',
  transactionId: '00000000-0000-4000-8000-0000000000a1',
  position: 1,
  bookingDate: day('2026-12-29'),
  direction: 'INFLOW',
  amount: Money.of('850.00', 'EUR'),
  financialCategoryCode: 'RENT_BASE',
  categoryType: 'INCOME',
  propertyReferenceId: '0000aaaa-0000-4000-8000-000000000001',
  transactionStatus: 'CONFIRMED',
  correctionRole: null,
  ...o,
});

const classification = (reviewState: Exclude<ReviewState, 'SUGGESTED'>, taxYear: number | null): TaxClassification => ({
  id: '00000000-0000-4000-8000-0000000000c1' as TaxClassificationId,
  mreRealmId: 'r',
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: facts().splitId,
  taxCategory: 'RENT',
  treatment: 'INCOME',
  reviewState,
  rule: { ruleCode: CATEGORY_DEFAULTS, version: 1 },
  treatmentRule: null,
  sourcePosition: null,
  reserveWithdrawal: null,
  assessmentUse: null,
  netAmount: null,
  performance: null,
  annuallyRecurring: false,
  distributionYears: null,
  mostlyResidentialConfirmed: null,
  anschaffungsnaheAcquisitionId: null,
  constructionPeriodInterestId: null,
  advisorPartyId: null,
  notes: null,
  sourceReferences: [],
  taxYear,
  refundOfYear: null,
  depositClosing: null,
  supersedes: null,
  supersededBy: null,
  supersededAt: null,
  createdAt: new Date('2026-12-30T10:00:00Z'),
  createdBy: 'anna@example.com',
  version: 1,
});

const today = day('2027-02-01');
/** A split's meaning as the list derives it, with its timing (no due day unless given). */
type Item = TaxMeaning & { readonly yearAmount: Money };
const meaning = (o: { readonly c?: TaxClassification; readonly timing?: TimingInput; readonly facts?: Partial<SplitFacts> } = {}): Item => {
  const m = deriveTaxMeaning(facts(o.facts), o.c ?? null, null, TAX_RULES, today, { timing: o.timing ?? rentTiming(JANUARY, null) });
  return { ...m, yearAmount: m.amount };
};

describe('the review (§58F): only a confirmed taxYear or a recorded due date closes the proposal', () => {
  const levelOf = (m: Item) => flagIsOpen('PROPOSED_BY_10_DAY_RULE', m);

  it('open on a default, open with a confirmed classification without taxYear, informative with a confirmed taxYear', () => {
    expect(levelOf(meaning())).toBe(true);
    expect(levelOf(meaning({ c: classification('USER_CONFIRMED', null) }))).toBe(true);
    for (const state of ['USER_CONFIRMED', 'ADVISOR_CONFIRMED'] as const) {
      for (const year of [2026, 2027]) expect(levelOf(meaning({ c: classification(state, year) })), `${state} ${year}`).toBe(false);
    }
    expect(levelOf(meaning({ c: classification('NEEDS_REVIEW', 2027) }))).toBe(true);
    // DUE_DATE_ASSUMED keeps its level: closed by any confirmed classification.
    expect(flagIsOpen('DUE_DATE_ASSUMED', meaning({ c: classification('USER_CONFIRMED', null) }))).toBe(false);
    expect(proposalIsOpen({ origin: 'DEFAULT', reviewState: 'USER_CONFIRMED', attribution: { overridden: true } })).toBe(true);
  });

  it('a recorded due day removes the flag', () => {
    expect(codes(meaning({ timing: rentTiming(JANUARY, due(3)) }).flags)).toEqual(['ATTRIBUTED_BY_10_DAY_RULE']);
    expect(codes(meaning({ timing: rentTiming(JANUARY, due(15)) }).flags)).toEqual([]);
  });
});

describe('both years (§58F, owner decision 2026-11-02): visible in each, counted once, neither final while open', () => {
  it('proposedSplits names the proposal in the year it is not counted in, with its level, sorted by sourceId', () => {
    const open = meaning();
    expect(proposedSplits([open], 2026)).toEqual([]);
    expect(proposedSplits([open], 2027)).toEqual([
      { sourceId: open.sourceId, bookingDate: '2026-12-29', bookingYear: 2026, proposedYear: 2027, amount: open.amount, countedInYear: 2026, open: true },
    ]);
    expect([proposedSplits([open], 2025), proposedSplits([open], 2028)]).toEqual([[], []]);
    // Decided by a confirmed taxYear: informative where it is not counted; not counting: nowhere.
    const decided = proposedSplits([meaning({ c: classification('USER_CONFIRMED', 2026) })], 2027);
    expect(decided.map((p) => [p.countedInYear, p.open])).toEqual([[2026, false]]);
    expect(proposedSplits([meaning({ facts: { transactionStatus: 'IMPORTED' } })], 2027)).toEqual([]);
    // Overridden but NEEDS_REVIEW: counted in 2027, named open in 2026.
    const pending = meaning({ c: classification('NEEDS_REVIEW', 2027) });
    expect(proposedSplits([pending], 2026).map((p) => [p.countedInYear, p.bookingYear, p.proposedYear, p.open])).toEqual([[2027, 2026, 2027, true]]);
    expect(proposedSplits([pending], 2027)).toEqual([]);
    // A confirmation without taxYear decides nothing; a recorded due day removes the proposal at both places.
    expect(proposedSplits([meaning({ c: classification('USER_CONFIRMED', null) })], 2027).map((p) => p.open)).toEqual([true]);
    expect(proposedSplits([meaning({ timing: rentTiming(JANUARY, due(3)) })], 2026)).toEqual([]);
    const ids = ['00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000003'];
    expect(
      proposedSplits(
        ids.map((splitId) => meaning({ facts: { splitId } })),
        2027,
      ).map((p) => p.sourceId),
    ).toEqual([...ids].sort());
  });

  const readOf = (year: number, items: readonly Item[]): TaxYearRead => ({
    propertyReferenceId: facts().propertyReferenceId as string,
    ownerPartyFound: null,
    sources: items.filter((i) => i.taxYear === year).map((item) => ({ item, listed: true })),
    unattributedDeposits: [],
    ownerships: [],
    checks: [],
    attribution: { references: [], candidates: [] },
    allocatedLoanInterest: [],
    loanAllocationSets: new Map(),
    depreciation: PHASE_7_DEPRECIATION,
    proposedSplits: proposedSplits(items, year),
  });
  const viewOf = (year: number, items: readonly Item[]): TaxYearView => {
    const outcome = buildTaxYearView(readOf(year, items), { year, ownerPartyId: null, today, registry: TAX_RULES });
    if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
    return outcome.view;
  };
  const rentOf = (v: TaxYearView) => v.einnahmen.lines.find((l) => l.taxCategory === 'RENT')?.total.amount;
  const tenDay = (v: TaxYearView) => [v.review.open, v.review.info].map((l) => l.filter((o) => o.code === 'PROPOSED_BY_10_DAY_RULE'));
  const second = { splitId: '00000000-0000-4000-8000-000000000002', amount: Money.of('150.00', 'EUR') };

  it('no due date: the year paid counts both splits with the open item flag; the proposed year names them, unsummed', () => {
    const items = [meaning(), meaning({ facts: second })];
    const [y2026, y2027] = [viewOf(2026, items), viewOf(2027, items)];
    expect([rentOf(y2026), rentOf(y2027)]).toEqual(['1000.00', '0.00']);
    // Counted once: the two years' RENT sum to the splits' sum.
    expect(Money.of(rentOf(y2026) as string, 'EUR').add(Money.of(rentOf(y2027) as string, 'EUR'))).toEqual(Money.of('1000.00', 'EUR'));
    expect(tenDay(y2026)).toEqual([[{ code: 'PROPOSED_BY_10_DAY_RULE', count: 2 }], []]);
    expect(codes(y2026.flags)).not.toContain('PROPOSED_BY_10_DAY_RULE');
    const flag = y2027.flags.find((f) => f.code === 'PROPOSED_BY_10_DAY_RULE');
    expect(flag?.details).toMatchObject({ count: 2, items: [{ amount: Money.of('850.00', 'EUR'), open: true }, { amount: Money.of('150.00', 'EUR') }] });
    expect(tenDay(y2027)).toEqual([[{ code: 'PROPOSED_BY_10_DAY_RULE', count: 1 }], []]);
    expect([y2026.review.final, y2027.review.final]).toEqual([false, false]);
  });

  it('a confirmed taxYear decides: counted in that year only, informative at both places', () => {
    for (const [taxYear, other] of [
      [2027, 2026],
      [2026, 2027],
    ] as const) {
      const items = [meaning({ c: classification('USER_CONFIRMED', taxYear) })];
      const [counted, shown] = [viewOf(taxYear, items), viewOf(other, items)];
      expect([rentOf(counted), rentOf(shown)], String(taxYear)).toEqual(['850.00', '0.00']);
      expect([tenDay(counted), tenDay(shown)]).toEqual([
        [[], [{ code: 'PROPOSED_BY_10_DAY_RULE', count: 1 }]],
        [[], [{ code: 'PROPOSED_BY_10_DAY_RULE', count: 1 }]],
      ]);
    }
  });

  it('a recorded due day decides: the flag gone at both places', () => {
    const items = [meaning({ timing: rentTiming(JANUARY, due(3)) })];
    const [y2026, y2027] = [viewOf(2026, items), viewOf(2027, items)];
    expect([rentOf(y2026), rentOf(y2027)]).toEqual(['0.00', '850.00']);
    expect([tenDay(y2026), tenDay(y2027)]).toEqual([
      [[], []],
      [[], []],
    ]);
  });
});

describe('the history (§58C ATTRIBUTION_INPUT_CHANGED, under the amended rule): a change of rentDueDays is still an attribution input', () => {
  // A January 2028 rent paid on 2027-12-29; the reference created with [] and amended once.
  const input = (from: RentDueDay[], to: RentDueDay[], amendedAt: string): AttributionInput => ({
    candidates: [
      {
        sourceId: 's-r1',
        bookingDate: day('2027-12-29'),
        financialCategoryCode: 'RENT_BASE',
        mreTenantId: 't',
        mreRentTerm: '2028010100',
        taxYearOverride: null,
      },
    ],
    references: [
      {
        rentalContractReferenceId: 'ref-1',
        mreTenantId: 't',
        rentDueDays: to,
        created: from,
        amendments: [
          {
            auditRecordId: 'a-1',
            newVersion: 2,
            amendedAt: new Date(amendedAt),
            changedEntries: [{ validFrom: day('2027-01-01'), from: from[0]?.day ?? null, to: to[0]?.day ?? null }],
          },
        ],
      },
    ],
  });
  const items = (i: AttributionInput, year: number) => attributionChanges(i, year, TAX_RULES).changes.flatMap((c) => c.items);

  it('from no due day to day 1, recorded after both years: flagged in both, 2027 → 2028 (the old rule moved nothing)', () => {
    const late = input([], due(1, '2027-01-01'), '2029-02-01T10:00:00Z');
    expect([items(late, 2027), items(late, 2028)]).toEqual([
      [{ sourceId: 's-r1', yearBefore: 2027, yearAfter: 2028 }],
      [{ sourceId: 's-r1', yearBefore: 2027, yearAfter: 2028 }],
    ]);
  });

  it('recorded on 2027-12-30, nothing (the 31-December rule); day 15 to no due day moves nothing', () => {
    expect(items(input([], due(1, '2027-01-01'), '2027-12-30T10:00:00Z'), 2027)).toEqual([]);
    const back = input(due(15, '2027-01-01'), [], '2029-02-01T10:00:00Z');
    expect([items(back, 2027), items(back, 2028)]).toEqual([[], []]);
  });
});
