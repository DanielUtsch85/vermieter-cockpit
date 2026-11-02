import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import { acquisition, acc8, capitalized, day, ownership, A, B, W } from './schedule.test-support.js';
import { amount, codes, derive, item, monthOfDate, ownerAmounts, REPAIR, repair, yearOf } from './schedule-items.test-support.js';
import type { ScheduleInput } from './schedule-model.js';
import { computeVersionEntries } from './version-compute.js';
import { inputFingerprint, truncateInputs } from './version-fingerprint.js';
import { planRecord } from './version-record.js';
import { identity, live, readOf } from './version.test-support.js';

/**
 * §59F "Capitalised items start in the year of completion" (VC-X-38; tax review of 2026-11-01, question 5, mündlich
 * bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01; the owner's decisions of 2026-11-02, open
 * questions 9–11): a building's item starts at `performance.until` (START_OF_YEAR of that year), never at its booking
 * date; without a performance, or across a year end, it is not computed in any year. ACC8 (synthetic): the purchase of
 * 254,400.00 at 2 % from 2026-07-01, A 3/5 and B 2/5; the repair of 35,700.00.
 */
const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
const period = (from: string, until: string) => ({ from: day(from), until: day(until) });
const schedule = (items: ReturnType<typeof repair>[], from = 2026, to = 2029, reg = registry) => derive(acc8({ from, to, capitalizedItems: items }), reg);

describe('the start by the completion of the work (§59F)', () => {
  it('booked 2028-02-01 (tax year 2028), performed 2027-01-10 to 2027-02-28: from 2027-01, 714.00 in 2027; CAPITALIZED_YEAR_DIFFERS with the start', () => {
    const c = item(schedule([repair({ date: day('2028-02-01'), taxYear: 2028, performance: period('2027-01-10', '2027-02-28') })]));
    expect([c.status, c.start.date, c.start.dateSource, c.start.month, c.source.performance]).toEqual([
      'COMPUTABLE',
      '2027-02-28',
      'PERFORMANCE_UNTIL',
      '2027-01',
      period('2027-01-10', '2027-02-28'),
    ]);
    expect([amount(yearOf(c, 2027).amount), ...ownerAmounts(yearOf(c, 2027))]).toEqual(['714.00', '428.40', '285.60']);
    expect(c.flags.find((f) => f.code === 'CAPITALIZED_YEAR_DIFFERS')?.details).toEqual({
      date: '2028-02-01',
      taxYear: 2028,
      startDate: '2027-02-28',
      dateSource: 'PERFORMANCE_UNTIL',
    });
    // Counter-check: the start is the completion, never the beginning nor the booking date.
    const later = item(schedule([repair({ date: day('2027-03-10'), performance: period('2027-03-01', '2027-12-31') })]));
    expect(later.start.date).toBe('2027-12-31');
    expect(codes(later.flags)).not.toContain('CAPITALIZED_YEAR_DIFFERS');
  });

  it('MONTH_OF_DATE (a test registry) reads the month of the completion', () => {
    const c = item(schedule([repair({ performance: period('2027-03-01', '2027-06-15') })], 2027, 2027, monthOfDate));
    expect([c.start.month, c.start.firstYearMonths]).toEqual(['2027-06', 7]);
  });

  it('§59F example: S2 booked 2029-07-10, performed until 2028-12-20, 11,305.00 gross: 226.10 in 2028 and 2029, never nothing in 2028', () => {
    const s2 = capitalized(REPAIR, '2029-07-10', '11305.00', undefined, { performance: period('2028-11-02', '2028-12-20') });
    const c = item(derive(acc8({ from: 2028, to: 2029, capitalizedItems: [s2] })));
    expect(c.years.map((y) => [y.year, amount(y.amount)])).toEqual([
      [2028, '226.10'],
      [2029, '226.10'],
    ]);
    expect(c.flags.find((f) => f.code === 'CAPITALIZED_YEAR_DIFFERS')?.details).toMatchObject({ startDate: '2028-12-20', taxYear: 2029 });
  });
});

describe('not computable without a reliable start (§59F, open questions 9 and 10)', () => {
  it('PERFORMANCE_DATE_MISSING: every year, the component and owner amounts null, never 0.00 and never by the booking year', () => {
    const s = schedule([repair({ performance: null })]);
    const c = item(s);
    expect([c.status, c.start.date, c.start.month, c.reasons]).toEqual([
      'NOT_COMPUTABLE',
      null,
      null,
      [{ code: 'PERFORMANCE_DATE_MISSING', details: { date: '2027-03-10', dateSource: 'BOOKING', classificationId: c.source.classificationId } }],
    ]);
    for (const y of c.years) {
      expect(y.amount, String(y.year)).toBeNull();
      expect(y.owners.map((o) => [o.amount, o.calculationStatus])).toEqual([
        [null, 'NOT_CALCULABLE'],
        [null, 'NOT_CALCULABLE'],
      ]);
    }
    expect(s.years.find((y) => y.year === 2027)?.status).toBe('PARTIAL');
    // The purchase is unchanged: 5,088.00 in 2027 with or without the undated item in the list.
    expect(amount(s.components[0]?.years.find((y) => y.year === 2027)?.amount)).toBe('5088.00');
  });

  it('PERFORMANCE_SPANS_YEAR_END: across 31 December not computed in any year, never put into the completion year', () => {
    const c = item(schedule([repair({ performance: period('2027-11-01', '2028-02-15') })]));
    expect([c.status, c.reasons]).toEqual([
      'NOT_COMPUTABLE',
      [{ code: 'PERFORMANCE_SPANS_YEAR_END', details: { from: '2027-11-01', until: '2028-02-15', classificationId: c.source.classificationId } }],
    ]);
    expect(c.years.every((y) => y.amount === null)).toBe(true);
    // Counter-check: within one year it is computed.
    expect(item(schedule([repair({ performance: period('2027-11-01', '2027-12-31') })])).status).toBe('COMPUTABLE');
  });

  it('the record command refuses a run with either reason (SCHEDULE_NOT_COMPLETE names the component)', () => {
    for (const performance of [null, period('2027-11-01', '2028-02-15')]) {
      const input: ScheduleInput = acc8({ capitalizedItems: [repair({ performance })] });
      const decision = planRecord(
        { schedule: readOf(input), current: null },
        {
          throughYear: 2027,
          reason: 'synthetisch',
          expectedInputFingerprint: inputFingerprint(live(input, registry, 2027).inputs, 2027, identity),
          acceptChangedYears: [],
        },
        { registry, fingerprinter: identity, today: day('2028-03-01'), recordedBy: 'anna@example.com', releasedStage: 3 },
      );
      expect(decision).toMatchObject({ kind: 'REFUSED', refusal: { kind: 'SCHEDULE_NOT_COMPLETE' } });
    }
  });
});

describe('the confirmed rule and the open reading (§59F, open question 11)', () => {
  it('SUBSEQUENT_COST_OWNER_START_TO_VERIFY exactly where notBeforeOwnerStart moves a start; never SUBSEQUENT_COST_START_TO_VERIFY', () => {
    // Performed 2026-09-15 after the transfer on 2026-07-01: START_OF_YEAR 2026-01 moved to the owners' start 2026-07.
    const moved = item(schedule([repair({ date: day('2026-09-20'), taxYear: 2026, performance: period('2026-09-01', '2026-09-15') })]));
    expect(moved.flags.filter((f) => f.code === 'SUBSEQUENT_COST_OWNER_START_TO_VERIFY')).toEqual([
      { code: 'SUBSEQUENT_COST_OWNER_START_TO_VERIFY', details: { startYear: 2026, ownerStart: '2026-07-01' } },
    ]);
    expect(moved.owners.map((o) => o.firstMonth)).toEqual(['2026-07', '2026-07']);
    expect(codes(moved.flags)).not.toContain('SUBSEQUENT_COST_START_TO_VERIFY');
    // Counter-check: a start in a later year is not moved, so no flag.
    expect(codes(item(schedule([repair()])).flags)).not.toContain('SUBSEQUENT_COST_OWNER_START_TO_VERIFY');
  });
});

describe('what the performance does not change (§59F "What stays", "Not affected")', () => {
  it('the owners and their parts follow the share date, not the performance; interest keeps its booking date', () => {
    const sale = acc8({
      from: 2027,
      to: 2027,
      acquisitions: [acquisition()],
      ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', null, W)],
    });
    const a = item(derive({ ...sale, capitalizedItems: [repair({ performance: period('2027-01-02', '2027-01-03') })] }));
    const b = item(derive({ ...sale, capitalizedItems: [repair({ performance: period('2027-06-01', '2027-06-03') })] }));
    expect(a.owners.map((o) => [o.ownerPartyId, o.share, o.basis.amount])).toEqual(b.owners.map((o) => [o.ownerPartyId, o.share, o.basis.amount]));
    // Performed before the owners' tenure (an order of the seller, paid after the transfer): the tenure is judged on the
    // share date, so the owners start with their tenure (2026-07), never on the day the work was completed.
    const early = item(schedule([repair({ date: day('2026-09-20'), taxYear: 2026, performance: period('2026-05-01', '2026-05-10') })]));
    expect(early.owners.map((o) => [o.ownerPartyId, o.firstMonth, o.tenure.from])).toEqual([
      [A, '2026-07', '2026-07-01'],
      [B, '2026-07', '2026-07-01'],
    ]);
    const interest = item(schedule([repair({ taxCategory: 'LOAN_INTEREST', anschaffungsnaheAcquisitionId: null, performance: null })]));
    expect([interest.status, interest.start.dateSource, interest.start.date]).toEqual(['COMPUTABLE', 'ITEM_DATE', '2027-03-10']);
    expect(codes(interest.reasons)).not.toContain('PERFORMANCE_DATE_MISSING');
  });
});

describe('the stored inputs and the fingerprint (§59F "Recorded versions and the fingerprint")', () => {
  it('the performance is stored where it decides the start, recomputes the same entries, and moves the fingerprint from the earlier start', () => {
    // One set of Ownerships for every input: the fixtures number their ids, and an id is an input.
    const ownerships = acc8().ownerships;
    const at = (until: string) =>
      acc8({ ownerships, capitalizedItems: [repair({ date: day('2028-03-10'), taxYear: 2028, performance: period('2027-01-02', until) })] });
    const inputs = live(at('2027-02-28'), registry, 2030).inputs;
    const stored = inputs.components.find((c) => c.kind === 'CAPITALIZED_ITEM');
    expect([stored?.start.dateSource, stored?.start.date, stored?.item?.performedFrom, stored?.item?.performedUntil]).toEqual([
      'PERFORMANCE_UNTIL',
      '2027-02-28',
      '2027-01-02',
      '2027-02-28',
    ]);
    const derived = live(at('2027-02-28'), registry, 2030);
    expect(computeVersionEntries(truncateInputs(derived.inputs, 2030), registry, 2026, 2030)).toEqual(
      derived.entries.filter((e) => e.year >= 2026 && e.year <= 2030),
    );
    // A superseding performance completed in 2028 instead: every year from the earlier start (2027) changes, 2026 not.
    const fp = (input: ScheduleInput, year: number) => inputFingerprint(live(input, registry, 2030).inputs, year, identity);
    expect(fp(at('2027-02-28'), 2026)).toBe(fp(at('2027-12-31'), 2026));
    expect(fp(at('2027-02-28'), 2027)).not.toBe(fp(at('2027-12-31'), 2027));
    const in2028 = acc8({
      ownerships,
      capitalizedItems: [repair({ date: day('2028-03-10'), taxYear: 2028, performance: period('2028-01-02', '2028-02-01') })],
    });
    expect(fp(at('2027-02-28'), 2027)).not.toBe(fp(in2028, 2027));
    expect(fp(at('2027-02-28'), 2026)).toBe(fp(in2028, 2026));
    // The period itself is an input: another beginning with the same completion changes the fingerprint too.
    const begun = acc8({ ownerships, capitalizedItems: [repair({ date: day('2028-03-10'), taxYear: 2028, performance: period('2027-02-01', '2027-02-28') })] });
    expect(fp(at('2027-02-28'), 2027)).not.toBe(fp(begun, 2027));
  });
});

describe('CAPITALIZED_YEAR_DIFFERS, a level by state (§59F, the owner’s decision 239-7 of 2026-11-02)', () => {
  // Booked 2028-02-01 in tax year 2028, performed 2027-01-10 to 2027-02-28: the start comes from the performance.
  const performed = () => repair({ date: day('2028-02-01'), taxYear: 2028, performance: period('2027-01-10', '2027-02-28') });
  // Interest keeps its booking date (ITEM_DATE); a tax year of 2028 for a booking of 2027-03-10 differs from it.
  const interest = () => repair({ taxCategory: 'LOAN_INTEREST', anschaffungsnaheAcquisitionId: null, performance: null, taxYear: 2028 });
  const flagOf = (c: ReturnType<typeof item>) => c.flags.find((f) => f.code === 'CAPITALIZED_YEAR_DIFFERS');
  const reviewCodes = (s: ReturnType<typeof schedule>): [string[], string[]] => [s.review.open.map((o) => o.code), s.review.info.map((o) => o.code)];
  const record = (input: ScheduleInput) =>
    planRecord(
      { schedule: readOf(input), current: null },
      {
        throughYear: 2028,
        reason: 'synthetisch',
        expectedInputFingerprint: inputFingerprint(live(input, registry, 2028).inputs, 2028, identity),
        acceptChangedYears: [],
      },
      { registry, fingerprinter: identity, today: day('2029-03-01'), recordedBy: 'anna@example.com', releasedStage: 3 },
    );
  const levels = (input: ScheduleInput) => {
    const decision = record(input);
    if (decision.kind !== 'RECORD') throw new Error(`not recorded: ${decision.kind}`);
    return [...new Set(decision.version.flags.filter((f) => f.code === 'CAPITALIZED_YEAR_DIFFERS').map((f) => f.level))];
  };

  it('informative where dateSource is PERFORMANCE_UNTIL: in the review, the component years and the recorded flags; the figures unchanged', () => {
    const s = schedule([performed()], 2027, 2028);
    expect(flagOf(item(s))?.details).toMatchObject({ dateSource: 'PERFORMANCE_UNTIL', taxYear: 2028, startDate: '2027-02-28' });
    const [open, info] = reviewCodes(s);
    expect([open.includes('CAPITALIZED_YEAR_DIFFERS'), info.includes('CAPITALIZED_YEAR_DIFFERS')]).toEqual([false, true]);
    // Counter-check by figures and statuses: the same item without the differing year (no flag) gives the same years.
    const same = schedule([repair({ date: day('2028-02-01'), taxYear: 2027, performance: period('2027-01-10', '2027-02-28') })], 2027, 2028);
    expect(codes(item(same).flags)).not.toContain('CAPITALIZED_YEAR_DIFFERS');
    const shape = (x: ReturnType<typeof schedule>) => x.years.map((y) => [y.year, amount(y.amount), y.calculationStatus]);
    expect(shape(s)).toEqual(shape(same));
    expect(item(s).years.map((y) => [y.year, amount(y.amount), y.calculationStatus])).toEqual(
      item(same).years.map((y) => [y.year, amount(y.amount), y.calculationStatus]),
    );
    expect(item(s).years.map((y) => amount(y.amount))).toEqual(['714.00', '714.00']);
    expect(levels(acc8({ from: 2026, to: 2028, capitalizedItems: [performed()] }))).toEqual(['INFORMATIVE']);
    // At the owner level too (A 3/5): informative, the owner's figures unchanged.
    const atOwner = derive({ ...acc8({ from: 2027, to: 2028, capitalizedItems: [performed()] }), ownerPartyId: A });
    expect(reviewCodes(atOwner).map((l) => l.includes('CAPITALIZED_YEAR_DIFFERS'))).toEqual([false, true]);
    expect(item(atOwner).years.map((y) => amount(y.amount))).toEqual(['428.40', '428.40']);
  });

  it('open otherwise: an item starting on its own date (ITEM_DATE) keeps the flag open, the years provisional and the recorded level OPEN', () => {
    const s = schedule([interest()], 2027, 2028);
    expect(flagOf(item(s))?.details).toMatchObject({ dateSource: 'ITEM_DATE', taxYear: 2028, startDate: '2027-03-10' });
    const [open, info] = reviewCodes(s);
    expect([open.includes('CAPITALIZED_YEAR_DIFFERS'), info.includes('CAPITALIZED_YEAR_DIFFERS')]).toEqual([true, false]);
    expect(item(s).years.map((y) => y.calculationStatus)).toEqual(['PROVISIONAL', 'PROVISIONAL']);
    expect(s.years.map((y) => y.calculationStatus)).toEqual(['PROVISIONAL', 'PROVISIONAL']);
    expect(levels(acc8({ from: 2026, to: 2028, capitalizedItems: [interest()] }))).toEqual(['OPEN']);
    const atOwner = derive({ ...acc8({ from: 2027, to: 2028, capitalizedItems: [interest()] }), ownerPartyId: B });
    expect(reviewCodes(atOwner).map((l) => l.includes('CAPITALIZED_YEAR_DIFFERS'))).toEqual([true, false]);
    // Both at once: each counted at its own level, the code once open and once informative.
    const both = schedule([performed(), { ...interest(), sourceId: '0000eeee-0000-4000-8000-000000000079' }], 2027, 2028);
    expect([both.review.open, both.review.info].map((l) => l.find((o) => o.code === 'CAPITALIZED_YEAR_DIFFERS')?.count)).toEqual([1, 1]);
  });
});
