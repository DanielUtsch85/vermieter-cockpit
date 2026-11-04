import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import { checkAnschaffungsnahe, checkFlagsOf, type AnschaffungsnaheCheck, type CheckAcquisition, type CheckSource } from './anschaffungsnahe.js';
import { treatmentFieldsCheck } from './classification-checks.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import { NO_DEPRECIATION } from './tax-year-depreciation.js';
import { buildTaxYearView, type TaxYearRead, type TaxYearView } from './tax-year-view.js';

/**
 * §58K (VC-X-34; tax review of 2026-11-01, questions 3 and 14, mündlich bestätigt durch den Steuerberater, laut
 * Projektinhaber am 2026-11-01; Entscheidung des Projektinhabers, 2026-11-04, K1–K3): without `economicTransferDate` the
 * check is `NOT_COMPUTABLE`, `TRANSFER_DATE_MISSING`, `final: false`, nothing derived from the contract date; the view
 * lists it in every year from the contract's year on; a capitalisation on it is refused. §58K's example (synthetic): Q
 * with contract 2026-02-01 and no transfer date, basis 240,000.00, a repair of 40,000.00 performed 2026-05-04 – 06-30.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2026-10-30');

const Q: CheckAcquisition = {
  id: 'acq-q',
  propertyReferenceId: 'pr-1',
  status: 'CONFIRMED',
  transferDate: null,
  contractDate: day('2026-02-01'),
  acquiredShare: { numerator: 1, denominator: 1 },
  purchasePrice: eur('300000.00'),
};
/** Q′: the same purchase with the transfer of economic ownership on 2026-03-15. */
const Q2: CheckAcquisition = { ...Q, id: 'acq-q2', transferDate: day('2026-03-15') };
const allocation = { id: 'al-1', reviewState: 'CONFIRMED', totalAllocableAmount: eur('300000.00'), buildingAmount: eur('240000.00') };
const repair: CheckSource = {
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: 'S1',
  sourcePosition: null,
  date: day('2026-07-10'),
  dateSource: 'BOOKING',
  taxYear: 2026,
  taxCategory: 'MAINTENANCE',
  treatment: 'DEDUCTIBLE',
  reviewState: 'USER_CONFIRMED',
  origin: 'CLASSIFICATION',
  classificationId: 'c-S1',
  grossAmount: eur('40000.00'),
  direction: 'OUTFLOW',
  netAmount: eur('40000.00'),
  annuallyRecurring: false,
  anschaffungsnaheAcquisitionId: null,
  performance: { from: day('2026-05-04'), until: day('2026-06-30'), progress: [], progressEstimated: null },
  sourceFlags: [],
};
const unclassified: CheckSource = { ...repair, sourceId: 'U1', taxCategory: 'UNCLASSIFIED', treatment: null, performance: null };
const statement = { id: 'st-1', periodFrom: day('2026-01-01'), periodUntil: day('2026-12-31') };
const check = (acquisition: CheckAcquisition, overrides: Partial<Parameters<typeof checkAnschaffungsnahe>[0]> = {}) =>
  checkAnschaffungsnahe({ acquisition, costs: [], allocation, sources: [repair, unclassified], statements: [statement], today, ...overrides }, TAX_RULES);

describe('the check without economicTransferDate (§58K "The rule")', () => {
  it('the example: Q NOT_COMPUTABLE, TRANSFER_DATE_MISSING with contractDate, final false, nothing read, no suggestion on the repair', () => {
    const q = check(Q);
    expect(q).toEqual({
      acquisitionId: 'acq-q',
      propertyReferenceId: 'pr-1',
      acquisitionStatus: 'CONFIRMED',
      transferDate: null,
      contractDate: '2026-02-01',
      window: null,
      searchRange: null,
      outerBound: null,
      acquiredShare: { numerator: 1, denominator: 1 },
      rule: null,
      status: 'NOT_COMPUTABLE',
      notComputableReason: 'TRANSFER_DATE_MISSING',
      basis: {
        allocationId: 'al-1',
        allocationReviewState: 'CONFIRMED',
        purchasePrice: eur('300000.00'),
        acquisitionCosts: eur('0.00'),
        totalAllocableAmount: eur('300000.00'),
        buildingAmount: eur('240000.00'),
        basisAmount: eur('240000.00'),
        basisAmountWithUnclassified: eur('240000.00'),
        unclassifiedCosts: [],
      },
      thresholdPercent: null,
      threshold: null,
      thresholdWithUnclassified: null,
      sum: eur('0.00'),
      attributableAmount: eur('0.00'),
      percentOfBasis: null,
      sumUpper: eur('0.00'),
      attributableAmountUpper: eur('0.00'),
      percentOfBasisUpper: null,
      sources: [],
      excluded: [],
      unclassified: [],
      undetermined: [],
      outsideSearchRange: [],
      affectedYears: null,
      final: false,
      flags: [
        { code: 'NOT_FINAL', details: { reasons: ['TRANSFER_DATE_MISSING'] } },
        { code: 'TRANSFER_DATE_MISSING', details: { contractDate: '2026-02-01' } },
      ],
    });
    // No source carries a flag or a suggestion from Q (no WEG statement either: no window to overlap).
    expect(checkFlagsOf([q], repair)).toEqual({ flags: [], suggestion: null });
  });

  it('Q′ with economicTransferDate: computed from it, ABOVE_THRESHOLD, the repair suggested; the contract date changes nothing', () => {
    const q2 = check(Q2);
    expect([q2.status, q2.transferDate, q2.window, q2.rule, q2.sum, q2.threshold, q2.affectedYears]).toEqual([
      'ABOVE_THRESHOLD',
      '2026-03-15',
      { from: '2026-03-15', until: '2029-03-15' },
      { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 },
      eur('40000.00'),
      '36000.00',
      [2026],
    ]);
    expect(q2.flags.map((f) => f.code)).toEqual(['NOT_FINAL', 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED']);
    expect(checkFlagsOf([q2], repair).suggestion).toMatchObject({ treatment: 'CAPITALIZED', acquisitionIds: ['acq-q2'] });
    // Field by field: any contract date on or before the transfer gives the same check, apart from the internal field.
    for (const contract of ['2026-03-15', '2020-01-01', '2004-06-30']) {
      expect({ ...check({ ...Q2, contractDate: day(contract) }), contractDate: null }).toEqual({ ...q2, contractDate: null });
    }
  });

  it('the transfer date equal to the contract date: computed from that day, as any transfer date', () => {
    const same = check({ ...Q2, transferDate: day('2026-02-01') });
    expect([same.status, same.window, same.notComputableReason]).toEqual(['ABOVE_THRESHOLD', { from: '2026-02-01', until: '2029-02-01' }, null]);
  });

  it('the order: TRANSFER_DATE_MISSING before NO_APPLICABLE_RULE and before the basis reasons; a DRAFT names it too', () => {
    // A contract of 2003 (before DE_ANSCHAFFUNGSNAHE@1): with a transfer date of 2003 NO_APPLICABLE_RULE, without one TRANSFER_DATE_MISSING.
    const old = { ...Q, contractDate: day('2003-06-01') };
    expect(check({ ...old, transferDate: day('2003-06-01') }).notComputableReason).toBe('NO_APPLICABLE_RULE');
    expect(check(old).notComputableReason).toBe('TRANSFER_DATE_MISSING');
    expect(check(Q, { allocation: null }).notComputableReason).toBe('TRANSFER_DATE_MISSING');
    expect(check(Q2, { allocation: null }).notComputableReason).toBe('NO_ALLOCATION');
    const draft = check({ ...Q, status: 'DRAFT' });
    expect([draft.notComputableReason, draft.final]).toEqual(['TRANSFER_DATE_MISSING', false]);
    expect(check({ ...Q2, status: 'DRAFT' }).notComputableReason).toBe('ACQUISITION_NOT_CONFIRMED');
  });

  it('the contract date never used: three contract dates over 2004 to 2100 give the same check apart from contractDate', () => {
    const of = (contract: string) => check({ ...Q, contractDate: day(contract) });
    const strip = (c: AnschaffungsnaheCheck) => ({
      ...c,
      contractDate: null,
      flags: c.flags.map((f) => (f.code === 'TRANSFER_DATE_MISSING' ? { code: f.code, details: {} } : f)),
    });
    const [a, b, c] = ['2004-01-01', '2026-05-04', '2100-12-31'].map(of) as [AnschaffungsnaheCheck, AnschaffungsnaheCheck, AnschaffungsnaheCheck];
    expect(strip(b)).toEqual(strip(a));
    expect(strip(c)).toEqual(strip(a));
    expect(c.flags.find((f) => f.code === 'TRANSFER_DATE_MISSING')?.details).toEqual({ contractDate: '2100-12-31' });
    // Counter-check: a source within three years of a contract date, never read without the transfer date.
    expect([b.sources, b.unclassified, b.sum]).toEqual([[], [], eur('0.00')]);
  });
});

describe('a capitalisation on the check without economicTransferDate (treatmentFieldsCheck, §58K)', () => {
  const source = { date: day('2026-07-10'), direction: 'OUTFLOW', grossAmount: eur('40000.00'), propertyReferenceId: 'pr-1' } as const;
  const request = {
    taxCategory: 'MAINTENANCE',
    treatment: 'CAPITALIZED',
    anschaffungsnaheAcquisitionId: 'acq-q',
    performance: { from: day('2026-05-04'), until: day('2026-06-30'), progress: [], progressEstimated: null },
  } as const;
  const facts = { id: 'acq-q', propertyReferenceId: 'pr-1', status: 'CONFIRMED', transferDate: null };
  const fields = (acquisition: Parameters<typeof treatmentFieldsCheck>[3]) => treatmentFieldsCheck(source, request, null, acquisition, TAX_RULES);
  it('refused TRANSFER_DATE_MISSING after OTHER_PROPERTY_REFERENCE and ACQUISITION_NOT_CONFIRMED, before NO_APPLICABLE_RULE; dated accepted', () => {
    expect(fields(facts)).toEqual({ kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE', reason: 'TRANSFER_DATE_MISSING', acquisitionId: 'acq-q' });
    expect(fields({ ...facts, propertyReferenceId: 'pr-2' })).toMatchObject({ reason: 'OTHER_PROPERTY_REFERENCE' });
    expect(fields({ ...facts, status: 'DRAFT' })).toMatchObject({ reason: 'ACQUISITION_NOT_CONFIRMED' });
    expect(fields({ ...facts, transferDate: day('2003-06-01') })).toMatchObject({ reason: 'NO_APPLICABLE_RULE' });
    // Counter-checks: from 2026-03-15 accepted; from 2026-06-01 (the work begun before it) refused STRADDLES_WINDOW.
    expect(fields({ ...facts, transferDate: day('2026-03-15') })).toEqual({ treatmentRule: { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 } });
    expect(fields({ ...facts, transferDate: day('2026-06-01') })).toMatchObject({ reason: 'PERFORMANCE_REQUIRED', cause: 'STRADDLES_WINDOW' });
  });
});

describe('the tax-year view lists the check from the contract year on (§58K, buildTaxYearView)', () => {
  const PR = '0000aaaa-0000-4000-8000-0000000058a1';
  const readOf = (checks: AnschaffungsnaheCheck[], year: number): TaxYearRead => ({
    propertyReferenceId: PR,
    ownerPartyFound: null,
    sources: [],
    unattributedDeposits: [],
    ownerships: [
      { id: 'own-1', partyId: 'aaaaaaaa-0000-4000-8000-0000000058a1', share: { numerator: 1, denominator: 1 }, validFrom: day('2026-02-01'), validUntil: null },
    ],
    checks,
    attribution: { references: [], candidates: [] },
    allocatedLoanInterest: [],
    loanAllocationSets: new Map(),
    depreciation: NO_DEPRECIATION(year),
  });
  const viewOf = (checks: AnschaffungsnaheCheck[], year: number): TaxYearView => {
    const outcome = buildTaxYearView(readOf(checks, year), { year, ownerPartyId: null, today, registry: TAX_RULES, fingerprinter });
    if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
    return outcome.view;
  };
  const q = { ...check(Q), propertyReferenceId: PR };
  const q2 = { ...check(Q2), propertyReferenceId: PR };
  const notFinal = (v: TaxYearView) => v.flags.find((f) => f.code === 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL')?.details;

  it('Q in 2026 and every later year asked up to 2100, not in 2025; ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL names it; figures unchanged', () => {
    expect(viewOf([q], 2025).acquisitions).toEqual([]);
    expect(notFinal(viewOf([q], 2025))).toBeUndefined();
    for (const year of [2026, 2027, 2028, 2029, 2030, 2050, 2100]) {
      const v = viewOf([q], year);
      expect(v.acquisitions).toEqual([
        {
          acquisitionId: 'acq-q',
          transferDate: null,
          window: null,
          status: 'NOT_COMPUTABLE',
          final: false,
          notFinalReasons: ['TRANSFER_DATE_MISSING'],
          href: '/api/v1/acquisitions/acq-q/anschaffungsnahe-herstellungskosten',
        },
      ]);
      expect(notFinal(v)).toEqual({ acquisitionIds: ['acq-q'] });
      // The rule for `final` stays §58C's: open, so the year is not final; counter-check: without the check it is.
      const without = viewOf([], year);
      expect([v.review.final, v.review.open.some((o) => o.code === 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL'), without.review.final]).toEqual([false, true, true]);
      // The money: every section, the result and the owners as without the check (the check never changes a figure).
      expect([v.einnahmen, v.werbungskosten, v.result, v.owners, v.capitalized]).toEqual([
        without.einnahmen,
        without.werbungskosten,
        without.result,
        without.owners,
        without.capitalized,
      ]);
    }
  });

  it('Q′ only in the years its window overlaps (2026 to 2029); a CANCELLED undated Acquisition in no year', () => {
    expect([2025, 2026, 2029, 2030].map((year) => viewOf([q2], year).acquisitions.map((a) => [a.acquisitionId, a.transferDate, a.window]))).toEqual([
      [],
      [['acq-q2', '2026-03-15', { from: '2026-03-15', until: '2029-03-15' }]],
      [['acq-q2', '2026-03-15', { from: '2026-03-15', until: '2029-03-15' }]],
      [],
    ]);
    expect(viewOf([{ ...q, acquisitionStatus: 'CANCELLED' }], 2027).acquisitions).toEqual([]);
    expect(viewOf([q, q2], 2030).acquisitions.map((a) => a.acquisitionId)).toEqual(['acq-q']);
  });

  it('a dated check of NO_APPLICABLE_RULE (transfer before DE_ANSCHAFFUNGSNAHE@1) stays out of every year and opens no year', () => {
    // As implemented 3: only a check without a transfer date is listed from the contract year on; one of NO_APPLICABLE_RULE
    // also has no window but a transfer date, and stays out as before VC-X-34.
    const old = { ...check({ ...Q, id: 'acq-old', contractDate: day('2003-06-01'), transferDate: day('2003-06-01') }), propertyReferenceId: PR };
    expect([old.status, old.notComputableReason, old.window, old.transferDate]).toEqual(['NOT_COMPUTABLE', 'NO_APPLICABLE_RULE', null, '2003-06-01']);
    for (const year of [2003, 2004, 2010, 2026, 2100]) {
      const v = viewOf([old], year);
      expect(v.acquisitions).toEqual([]);
      expect(notFinal(v)).toBeUndefined();
      expect(v.review.open.some((o) => o.code === 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL')).toBe(false);
    }
    // Counter-check: next to the undated Q (contract 2026) only Q is listed and named, and only from 2026 on.
    const both = viewOf([old, q], 2010);
    expect([both.acquisitions, notFinal(both)]).toEqual([[], undefined]);
    const later = viewOf([old, q], 2026);
    expect([later.acquisitions.map((a) => a.acquisitionId), notFinal(later)]).toEqual([['acq-q'], { acquisitionIds: ['acq-q'] }]);
  });
});
