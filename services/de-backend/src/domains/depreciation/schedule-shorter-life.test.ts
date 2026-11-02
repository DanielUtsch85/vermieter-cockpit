import { describe, expect, it } from 'vitest';
import { RuleRegistry, type BusinessDate } from '../../shared/index.js';
import type { ShorterUsefulLife } from './asset.js';
import { DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2 } from './rules/de-afa-building-linear.js';
import type { ScheduleAcquisition, ScheduleInput } from './schedule.js';
import { A, B, C, W, acquisition, asset, capitalized, day, eur, life, ownership } from './schedule.test-support.js';
import { amount, codes, component, derive, ownerIn, registry as REGISTRY, withParameters, yearOf } from './schedule-purchase.test-support.js';
import { EXTENSION, item, owner } from './schedule-items.test-support.js';
import { releaseMissing, shorterLifeCaseOf } from './shorter-life.js';
import { inputFingerprint } from './version-fingerprint.js';
import { identity, live } from './version.test-support.js';

/**
 * §59G Part 1 (VC-X-41, "the guard"; Prüfbericht 2026-11-01, Fragen 8 und 9; the owner's decisions of 2026-11-02): a
 * shorter useful life applies from its Stichtag (`evidence.valuationDate`), never from the document's date, and never
 * retroactively: a Stichtag after the first year keeps the band's rate before its year and nothing from it; later costs
 * in such a pool are not computed. §59G's example (synthetic): A 3/5, B 2/5, basis 240,000.00, transfer 2024-04-01,
 * contract 2024-02-10, completed 1965 (band B of @2, 2 %, shorter below 50 years), n = 33.
 */

const RELEASED = { reviewState: 'ADVISOR_CONFIRMED', releaseNote: 'Restwertmethode freigegeben, Steuerberatung, 2027-06-30 (synthetisch)' } as const;
const gutachten = (valuationDate: string | null, overrides: Partial<ShorterUsefulLife> = {}): ShorterUsefulLife =>
  life({
    usefulLifeYears: 33,
    evidence: {
      source: 'Gutachten zur Restnutzungsdauer',
      date: day('2027-06-15'),
      documentReference: 'Gutachten Nr. 0000-SYN',
      valuationDate: valuationDate === null ? null : day(valuationDate),
    },
    ...overrides,
  });
const purchase = (overrides: Partial<ScheduleAcquisition> = {}) =>
  acquisition({
    purchasePrice: eur('240000.00'),
    costs: [],
    contractDate: day('2024-02-10'),
    economicTransferDate: day('2024-04-01'),
    allocation: {
      id: '0000bbbb-0000-4000-8000-000000000041',
      method: 'PURCHASE_CONTRACT',
      reviewState: 'CONFIRMED',
      totalAllocableAmount: eur('240000.00'),
      buildingAmount: eur('240000.00'),
    },
    ...overrides,
  });
const OWNERS = [ownership(A, '3/5', '2024-04-01', null, W), ownership(B, '2/5', '2024-04-01', null, W)];
const example = (entries: readonly ShorterUsefulLife[], extra: Partial<ScheduleInput> = {}): ScheduleInput => ({
  asset: asset({ buildingCompletionYear: 1965, shorterUsefulLives: entries }),
  acquisitions: [purchase()],
  ownerships: OWNERS,
  today: day('2026-10-30'),
  from: 2024,
  to: 2030,
  ownerPartyId: null,
  ...extra,
});
const rows = (input: ScheduleInput, reg = REGISTRY) =>
  component(derive(input, reg)).years.map((y) => [y.year, amount(ownerIn(y, A)?.amount), amount(ownerIn(y, B)?.amount), y.calculationStatus]);

describe('the case of an entry, on its Stichtag (§59G Part 1, pure)', () => {
  const parameters = DE_AFA_BUILDING_LINEAR_V2.parameters.shorterUsefulLife;
  const judge = (valuationDate: string | null, contractDate = '2024-02-10', firstYear: number | null = 2024, entry: Partial<ShorterUsefulLife> = {}) =>
    shorterLifeCaseOf({
      entry: gutachten(valuationDate, entry),
      contractDate: day(contractDate),
      firstYear,
      parameters,
      thresholdOf: () => 50,
    });

  it('FROM_START on the first month’s day, on 31 December of the first year, and in the contract year before a transfer in the next', () => {
    expect(judge('2024-04-01').kind).toBe('FROM_START');
    expect(judge('2024-12-31').kind).toBe('FROM_START');
    expect(judge('2023-11-30', '2023-10-01', 2024).kind).toBe('FROM_START');
  });

  it('FROM_EVIDENCE_YEAR on 1 January of the next year, with the year, the last month L and the missing release', () => {
    const c = judge('2025-01-01', undefined, undefined, RELEASED);
    expect(c).toMatchObject({ kind: 'FROM_EVIDENCE_YEAR', fromYear: 2025, lastMonth: (2025 + 33 - 1) * 12 + 11, shorter: true, releaseMissing: [] });
    expect(judge('2025-01-01', undefined, undefined, { reviewState: 'CONFIRMED', releaseNote: null })).toMatchObject({
      releaseMissing: ['ADVISOR_CONFIRMED', 'RELEASE_NOTE'],
    });
  });

  it('238-3: the evidence of a late release is the entry’s own documentReference alone; without it EVIDENCE is missing', () => {
    const late = (documentReference: string | null) =>
      releaseMissing(
        gutachten('2025-01-01', { ...RELEASED, evidence: { ...gutachten('2025-01-01').evidence, documentReference } }),
        parameters.lateEvidenceRelease,
      );
    expect(parameters.lateEvidenceRelease.evidence).toBe('ENTRY_DOCUMENT_REFERENCE');
    // Counter-check: the same entry with its own reference is released.
    expect(late('Gutachten Nr. 0000-SYN')).toEqual([]);
    expect(late(null)).toEqual(['EVIDENCE']);
    expect(
      releaseMissing(gutachten('2025-01-01', { ...RELEASED, evidence: { ...gutachten('2025-01-01').evidence, documentReference: null } }), {
        ...parameters.lateEvidenceRelease,
        evidence: 'NOT_REQUIRED',
      }),
    ).toEqual([]);
  });

  it('before the contract year (31 December of YC − 1): USEFUL_LIFE_EVIDENCE_BEFORE_PURCHASE; no Stichtag: USEFUL_LIFE_VALUATION_DATE_MISSING', () => {
    expect(judge('2023-12-31')).toEqual({
      kind: 'BLOCKED',
      reason: {
        code: 'USEFUL_LIFE_EVIDENCE_BEFORE_PURCHASE',
        details: { acquisitionId: W, evidenceDate: '2027-06-15', valuationDate: '2023-12-31', contractDate: '2024-02-10' },
      },
    });
    expect(judge(null)).toEqual({
      kind: 'BLOCKED',
      reason: { code: 'USEFUL_LIFE_VALUATION_DATE_MISSING', details: { acquisitionId: W, evidenceDate: '2027-06-15' } },
    });
  });

  it('the document’s date is never the Stichtag: a document of the first year with a later Stichtag is FROM_EVIDENCE_YEAR, the reverse FROM_START', () => {
    const early = (valuationDate: string) =>
      shorterLifeCaseOf({
        entry: gutachten(valuationDate, { evidence: { ...gutachten(null).evidence, date: day('2024-05-01'), valuationDate: day(valuationDate) } }),
        contractDate: day('2024-02-10'),
        firstYear: 2024,
        parameters,
        thresholdOf: () => 50,
      });
    expect(early('2026-01-01').kind).toBe('FROM_EVIDENCE_YEAR');
    expect(judge('2024-06-30').kind).toBe('FROM_START');
  });

  it('not judged: an unconfirmed entry (USEFUL_LIFE_NOT_CONFIRMED stops it) and a component without a start (TRANSFER_DATE_MISSING)', () => {
    expect(judge('2027-05-20', undefined, undefined, { reviewState: 'NEEDS_REVIEW' }).kind).toBe('NOT_JUDGED');
    expect(judge('2027-05-20', undefined, null).kind).toBe('NOT_JUDGED');
  });
});

describe('the purchase under Part 1 (§59G "Example", the Part 1 column)', () => {
  it('a Stichtag after the first year: the band years exactly as without an entry, null from its year (never 0.00), the end unknown', () => {
    const band = rows(example([]));
    const s = derive(example([gutachten('2027-05-20', RELEASED)]));
    const c = component(s);
    expect(rows(example([gutachten('2027-05-20', RELEASED)]))).toEqual([
      [2024, '2160.00', '1440.00', 'CALCULATED'],
      [2025, '2880.00', '1920.00', 'CALCULATED'],
      [2026, '2880.00', '1920.00', 'CALCULATED'],
      [2027, null, null, 'NOT_CALCULABLE'],
      [2028, null, null, 'NOT_CALCULABLE'],
      [2029, null, null, 'NOT_CALCULABLE'],
      [2030, null, null, 'NOT_CALCULABLE'],
    ]);
    // Counter-check: no shorter life before the evidence year: 2024–2026 are the band-only years, cent for cent.
    expect(rows(example([gutachten('2027-05-20', RELEASED)])).slice(0, 3)).toEqual(band.slice(0, 3));
    for (const year of [2024, 2025, 2026]) {
      expect([amount(yearOf(c, year).cumulative), amount(yearOf(c, year).residualValue)]).toEqual([
        amount(yearOf(component(derive(example([]))), year).cumulative),
        amount(yearOf(component(derive(example([]))), year).residualValue),
      ]);
    }
    const y2027 = yearOf(c, 2027);
    expect([y2027.amount, y2027.cumulative, y2027.residualValue]).toEqual([null, null, null]);
    expect(ownerIn(y2027, A)?.reasons).toEqual([
      {
        code: 'SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED',
        details: { acquisitionId: W, evidenceDate: '2027-06-15', valuationDate: '2027-05-20', firstYear: 2024, fromYear: 2027 },
      },
    ]);
    expect(c.end).toBeNull();
    expect(c.rate?.kind).toBe('BAND');
    expect(c.flags).toEqual([
      {
        code: 'SHORTER_USEFUL_LIFE',
        details: {
          usefulLifeYears: 33,
          evidenceDate: '2027-06-15',
          valuationDate: '2027-05-20',
          method: 'FROM_EVIDENCE_YEAR',
          fromYear: 2027,
          lastMonth: '2059-12',
        },
      },
    ]);
    // The property's year: no AfA shown for 2027, and the year counts as not available (never 0.00).
    const p2027 = s.years.find((y) => y.year === 2027);
    expect(p2027?.amount ?? null).toBeNull();
    expect(s.review.open.map((r) => r.code)).toContain('SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED');
  });

  it('a late evidence not released (only CONFIRMED, no document, no note): SHORTER_USEFUL_LIFE_RELEASE_MISSING beside it from its year; the band years stand', () => {
    const entry = gutachten('2027-05-20', {
      reviewState: 'CONFIRMED',
      evidence: { ...gutachten(null).evidence, documentReference: null, valuationDate: day('2027-05-20') },
    });
    const c = component(derive(example([entry])));
    expect(amount(ownerIn(yearOf(c, 2026), A)?.amount)).toBe('2880.00');
    expect(ownerIn(yearOf(c, 2027), A)?.reasons.map((r) => [r.code, r.details['missing'] ?? null])).toEqual([
      ['SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED', null],
      ['SHORTER_USEFUL_LIFE_RELEASE_MISSING', ['ADVISOR_CONFIRMED', 'EVIDENCE', 'RELEASE_NOTE']],
    ]);
    // 238-3 (Entscheidung des Projektinhabers, 2026-11-02): only the entry's own documentReference is the evidence; the
    // asset's sourceReferences do not count, so EVIDENCE stays missing with them.
    const named = derive({ ...example([entry]), asset: asset({ buildingCompletionYear: 1965, shorterUsefulLives: [entry], sourceReferences: ['Gutachten'] }) });
    expect(ownerIn(yearOf(component(named), 2027), A)?.reasons[1]?.details['missing']).toEqual(['ADVISOR_CONFIRMED', 'EVIDENCE', 'RELEASE_NOTE']);
    // The release is the rule's parameter, never a constant: a test registry that asks for a user's CONFIRMED only.
    const userRelease = withParameters((p) => ({
      ...p,
      shorterUsefulLife: { ...p.shorterUsefulLife, lateEvidenceRelease: { reviewState: 'CONFIRMED', evidence: 'NOT_REQUIRED', releaseNote: false } },
    }));
    expect(codes(ownerIn(yearOf(component(derive(example([entry]), userRelease)), 2027), A)?.reasons ?? [])).toEqual([
      'SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED',
    ]);
  });

  it('a Stichtag in the first year (FROM_START): 1/33 from 2024-04 as before VC-X-41, without any open flag; L 2057-03', () => {
    const c = component(derive(example([gutachten('2024-11-30')])));
    expect(rows(example([gutachten('2024-11-30')])).slice(0, 2)).toEqual([
      [2024, '3272.73', '2181.82', 'CALCULATED'],
      [2025, '4363.63', '2909.09', 'CALCULATED'],
    ]);
    expect(c.flags).toEqual([
      {
        code: 'SHORTER_USEFUL_LIFE',
        details: { usefulLifeYears: 33, evidenceDate: '2027-06-15', valuationDate: '2024-11-30', method: 'FROM_START', fromYear: 2024, lastMonth: '2057-03' },
      },
    ]);
    expect(c.end).toEqual({ lastYear: 2057, lastMonth: '2057-03' });
    expect(codes(c.flags)).not.toContain('USEFUL_LIFE_START_TO_VERIFY');
  });

  it('a Stichtag between the contract year and the first year: from the start too', () => {
    const input = example([gutachten('2023-12-01')], { acquisitions: [purchase({ contractDate: day('2023-10-01') })] });
    expect(rows(input)[0]).toEqual([2024, '3272.73', '2181.82', 'CALCULATED']);
  });

  it('a late evidence not shorter (n 50, band 50): the band in every year, USEFUL_LIFE_NOT_SHORTER open', () => {
    const c = component(derive(example([gutachten('2027-05-20', { ...RELEASED, usefulLifeYears: 50 })])));
    expect(rows(example([gutachten('2027-05-20', { ...RELEASED, usefulLifeYears: 50 })]))).toEqual(
      rows(example([])).map(([y, a, b]) => [y, a, b, 'PROVISIONAL']),
    );
    expect(c.flags).toEqual([{ code: 'USEFUL_LIFE_NOT_SHORTER', details: { usefulLifeYears: 50, shorterThanYears: 50 } }]);
  });

  it('a late evidence whose threshold cannot be read (no band in the Stichtag year) is never taken as not shorter', () => {
    // Review of #238: the cautious branch of `shorterLifeCaseOf` (`shorterThanYears === null`). A test registry whose
    // version from 2027 has no band for 1965: the threshold of the Stichtag's year cannot be read, so the years from it
    // stay not computed (never the band with USEFUL_LIFE_NOT_SHORTER).
    const v2 = { ...DE_AFA_BUILDING_LINEAR_V2, effectiveTo: '2027-01-01' as BusinessDate };
    const v3 = {
      ...DE_AFA_BUILDING_LINEAR_V2,
      version: 3,
      effectiveFrom: '2027-01-01' as BusinessDate,
      parameters: { ...DE_AFA_BUILDING_LINEAR_V2.parameters, bands: DE_AFA_BUILDING_LINEAR_V2.parameters.bands.filter((b) => b.band !== 'B') },
    };
    const noBand = new RuleRegistry([DE_AFA_BUILDING_LINEAR_V1, v2, v3]);
    const c = component(derive(example([gutachten('2027-05-20', RELEASED)]), noBand));
    // The years from 2027 are blocked anyway (NO_APPLICABLE_RULE); the case itself stays a shorter life from its year.
    expect([c.status, codes(c.reasons)]).toEqual(['NOT_COMPUTABLE', ['NO_APPLICABLE_RULE']]);
    expect(c.flags).toEqual([
      {
        code: 'SHORTER_USEFUL_LIFE',
        details: {
          usefulLifeYears: 33,
          evidenceDate: '2027-06-15',
          valuationDate: '2027-05-20',
          method: 'FROM_EVIDENCE_YEAR',
          fromYear: 2027,
          lastMonth: '2059-12',
        },
      },
    ]);
    // The pure case, with the threshold unreadable: shorter, and no threshold invented.
    const pure = shorterLifeCaseOf({
      entry: gutachten('2027-05-20', RELEASED),
      contractDate: day('2024-02-10'),
      firstYear: 2024,
      parameters: DE_AFA_BUILDING_LINEAR_V2.parameters.shorterUsefulLife,
      thresholdOf: (year) => (year >= 2027 ? null : 50),
    });
    expect(pure).toMatchObject({ kind: 'FROM_EVIDENCE_YEAR', fromYear: 2027, shorter: true, shorterThanYears: null });
  });

  it('a Stichtag before the contract year, and an entry without a Stichtag (stored before 0056): not computable in every year', () => {
    for (const [valuationDate, code] of [
      ['2023-12-31', 'USEFUL_LIFE_EVIDENCE_BEFORE_PURCHASE'],
      [null, 'USEFUL_LIFE_VALUATION_DATE_MISSING'],
    ] as const) {
      const c = component(derive(example([gutachten(valuationDate)])));
      expect([c.status, codes(c.reasons)]).toEqual(['NOT_COMPUTABLE', [code]]);
      expect(c.years.every((y) => y.amount === null && y.calculationStatus === 'NOT_CALCULABLE')).toBe(true);
    }
    // Counter-check: the document's date (2027-06-15, or one in the first year) is never taken for a missing Stichtag.
    const firstYearDocument = gutachten(null, { evidence: { ...gutachten(null).evidence, date: day('2024-06-01') } });
    expect(codes(component(derive(example([firstYearDocument]))).reasons)).toEqual(['USEFUL_LIFE_VALUATION_DATE_MISSING']);
  });

  it('an unconfirmed entry keeps USEFUL_LIFE_NOT_CONFIRMED alone, whatever its Stichtag', () => {
    for (const valuationDate of [null, '2023-12-31', '2027-05-20']) {
      expect(codes(component(derive(example([gutachten(valuationDate, { reviewState: 'UNREVIEWED' })]))).reasons)).toEqual(['USEFUL_LIFE_NOT_CONFIRMED']);
    }
  });

  it('withdrawn: USEFUL_LIFE_START_TO_VERIFY and SUBSEQUENT_COST_SHORTER_LIFE_TO_VERIFY appear nowhere', () => {
    for (const valuationDate of ['2024-11-30', '2027-05-20']) {
      const s = derive(example([gutachten(valuationDate, RELEASED)], { capitalizedItems: [capitalized(EXTENSION, '2025-05-05', '33000.00')] }));
      const all = JSON.stringify(s);
      expect(all).not.toContain('USEFUL_LIFE_START_TO_VERIFY');
      expect(all).not.toContain('SUBSEQUENT_COST_SHORTER_LIFE_TO_VERIFY');
    }
  });
});

describe('later costs on such a purchase (§59G Part 1 "Later costs")', () => {
  const withItem = (valuationDate: string | null, date: string, entry: Partial<ShorterUsefulLife> = RELEASED) =>
    derive(example([gutachten(valuationDate, entry)], { to: 2032, capitalizedItems: [capitalized(EXTENSION, date, '33000.00')] }));
  const partRow = (s: ReturnType<typeof derive>, year: number) => {
    const y = item(s).years.find((x) => x.year === year);
    return [year, amount(owner(y, A)?.amount), codes(owner(y, A)?.reasons ?? [])];
  };

  it('a FROM_START purchase: not computable in every year of the part, never at 1/33', () => {
    const s = withItem('2024-11-30', '2030-10-15');
    expect([2030, 2031].map((y) => partRow(s, y))).toEqual([
      [2030, null, ['SUBSEQUENT_COST_SHORTER_LIFE_NOT_SUPPORTED']],
      [2031, null, ['SUBSEQUENT_COST_SHORTER_LIFE_NOT_SUPPORTED']],
    ]);
    expect(owner(item(s).years[0], A)?.reasons[0]?.details).toEqual({ acquisitionId: W, usefulLifeYears: 33 });
  });

  it('a FROM_EVIDENCE_YEAR purchase: an item started before the Stichtag’s year at the band, not computed from it; one started in or after it: every year', () => {
    const before = withItem('2027-05-20', '2025-05-05');
    expect([2025, 2026, 2027, 2028].map((y) => partRow(before, y))).toEqual([
      [2025, '396.00', []],
      [2026, '396.00', []],
      [2027, null, ['SUBSEQUENT_COST_SHORTER_LIFE_NOT_SUPPORTED']],
      [2028, null, ['SUBSEQUENT_COST_SHORTER_LIFE_NOT_SUPPORTED']],
    ]);
    const after = withItem('2027-05-20', '2027-02-02');
    expect(partRow(after, 2027)).toEqual([2027, null, ['SUBSEQUENT_COST_SHORTER_LIFE_NOT_SUPPORTED']]);
  });

  it('an item after the evidenced remaining life ended: REMAINING_USEFUL_LIFE_ENDED, for FROM_START and FROM_EVIDENCE_YEAR', () => {
    // n 2 from 2024-04 ends 2026-03; n 2 from 2027 ends 2028-12.
    const fromStart = withItem('2024-11-30', '2027-03-03', { usefulLifeYears: 2 });
    expect(owner(item(fromStart).years[0], A)?.reasons).toEqual([{ code: 'REMAINING_USEFUL_LIFE_ENDED', details: { acquisitionId: W, lastMonth: '2026-03' } }]);
    const late = withItem('2027-05-20', '2029-03-03', { ...RELEASED, usefulLifeYears: 2 });
    expect(owner(item(late).years[0], A)?.reasons).toEqual([{ code: 'REMAINING_USEFUL_LIFE_ENDED', details: { acquisitionId: W, lastMonth: '2028-12' } }]);
    // Counter-check: within the life it is the Part 1 reason, not ENDED.
    expect(codes(owner(item(withItem('2024-11-30', '2025-03-03', { usefulLifeYears: 2 })).years[0], A)?.reasons ?? [])).toEqual([
      'SUBSEQUENT_COST_SHORTER_LIFE_NOT_SUPPORTED',
    ]);
  });

  it('a purchase without a Stichtag or with one before the contract year stops its later costs with its own reason', () => {
    for (const [valuationDate, code] of [
      [null, 'USEFUL_LIFE_VALUATION_DATE_MISSING'],
      ['2023-12-31', 'USEFUL_LIFE_EVIDENCE_BEFORE_PURCHASE'],
    ] as const) {
      expect(partRow(withItem(valuationDate, '2025-05-05', {}), 2025)).toEqual([2025, null, [code]]);
    }
  });

  it('an heir’s part keeps the band (its own pool), beside an owner in a shorter-life pool', () => {
    const s = derive({
      ...example([gutachten('2024-11-30')], { to: 2026 }),
      acquisitions: [purchase({ acquiredShare: { numerator: 3, denominator: 5 } })],
      ownerships: [ownership(A, '3/5', '2024-04-01', null, W), ownership(C, '2/5', '2024-01-01', null, null)],
      capitalizedItems: [
        capitalized(EXTENSION, '2025-05-05', '10000.00', [
          [A, '3/5'],
          [C, '2/5'],
        ]),
      ],
    });
    const y = item(s).years.find((x) => x.year === 2025);
    expect([amount(owner(y, A)?.amount), amount(owner(y, C)?.amount)]).toEqual([null, '80.00']);
  });
});

describe('the recorded inputs and the fingerprint (§60, §59G)', () => {
  it('a FROM_START component stores its Stichtag; a moved Stichtag changes the fingerprint from the first year; a band component has none', () => {
    const inputs = (entries: readonly ShorterUsefulLife[]) => live(example(entries), REGISTRY, 2040).inputs;
    const stored = inputs([gutachten('2024-11-30')]).components[0]?.acquisition;
    expect(stored?.shorterLifeValuationDate).toBe('2024-11-30');
    expect(inputs([]).components[0]?.acquisition).not.toHaveProperty('shorterLifeValuationDate');
    // A late evidence is recorded as BAND years (it is not used as a shorter life): no Stichtag stored.
    expect(inputs([gutachten('2027-05-20', RELEASED)]).components[0]?.acquisition).not.toHaveProperty('shorterLifeValuationDate');
    const a = inputs([gutachten('2024-11-30')]);
    const b = inputs([gutachten('2024-06-01')]);
    expect(inputFingerprint(a, 2024, identity)).not.toBe(inputFingerprint(b, 2024, identity));
    // Counter-check: the same Stichtag, the same fingerprint (the document's date is not an input).
    const c = inputs([gutachten('2024-11-30', { evidence: { ...gutachten(null).evidence, date: day('2025-01-01'), valuationDate: day('2024-11-30') } })]);
    expect(inputFingerprint(a, 2030, identity)).toBe(inputFingerprint(c, 2030, identity));
  });
});
