import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import type { DepreciationAsset } from './asset.js';
import type { PurchaseMethod } from './purchase-method.js';
import { DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2 } from './rules/de-afa-building-linear.js';
import type { ScheduleInput } from './schedule.js';
import { A, B, W, X, acc8, acquisition, asset, capitalized, day, ownership, standard } from './schedule.test-support.js';
import { amount, codes, component, derive, ownerIn, sole, yearOf } from './schedule-purchase.test-support.js';
import { EXTENSION, item, owner } from './schedule-items.test-support.js';
import { inputFingerprint } from './version-fingerprint.js';
import { identity, live } from './version.test-support.js';

/**
 * VC-X-37 (api-design.md §59C "The gate in the schedule", "Items of such a purchase", "Recorded versions and the
 * fingerprint"): no confirmed STANDARD method entry, no figure, in every year and never 0.00; the reason's place among
 * §59A's; an item part under such a purchase; the parameter from the registry (the version of the start year); the
 * entry in the stored inputs and the fingerprint. Synthetic (ACC8's purchase).
 */
// One set of Ownerships for every input: the fixtures number their ids, and an id is an input of the fingerprint.
const owners = acc8().ownerships;
const withMethods = (purchaseMethods: readonly PurchaseMethod[], extra: Partial<DepreciationAsset> = {}): ScheduleInput =>
  acc8({ asset: asset({ purchaseMethods, ...extra }), ownerships: owners });

describe('no confirmed STANDARD entry, no figure (§59C)', () => {
  const reviewStates = ['UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED', 'ADVISOR_CONFIRMED'] as const;

  it('the matrix: no entry, each review state × STANDARD and NOT_SUPPORTED; only a confirmed STANDARD entry computes', () => {
    const outcome = (entries: PurchaseMethod[]) => {
      const c = component(derive(withMethods(entries)));
      return [c.status, codes(c.reasons)];
    };
    expect(outcome([])).toEqual(['NOT_COMPUTABLE', ['DEPRECIATION_METHOD_NOT_CONFIRMED']]);
    for (const reviewState of reviewStates) {
      const confirmed = reviewState === 'CONFIRMED' || reviewState === 'ADVISOR_CONFIRMED';
      expect(outcome([standard({ reviewState })]), reviewState).toEqual(
        confirmed ? ['COMPUTABLE', []] : ['NOT_COMPUTABLE', ['DEPRECIATION_METHOD_NOT_CONFIRMED']],
      );
      expect(outcome([standard({ reviewState, method: 'DEGRESSIVE_7_5' })]), reviewState).toEqual([
        'NOT_COMPUTABLE',
        [confirmed ? 'DEPRECIATION_METHOD_NOT_SUPPORTED' : 'DEPRECIATION_METHOD_NOT_CONFIRMED'],
      ]);
    }
    // Counter-check: an entry of another purchase does not count for this one.
    expect(outcome([standard({ acquisitionId: X })])).toEqual(['NOT_COMPUTABLE', ['DEPRECIATION_METHOD_NOT_CONFIRMED']]);
  });

  it('never 0.00: amount, cumulative and residualValue null in the component, its owners and the schedule’s years; the review counts it open', () => {
    for (const entries of [[], [standard({ reviewState: 'UNREVIEWED' })], [standard({ consideration: 'PARTLY_PAID' })]]) {
      const s = derive(withMethods(entries));
      const c = component(s);
      for (const y of c.years) {
        expect([y.amount, y.cumulative, y.residualValue, y.calculationStatus]).toEqual([null, null, null, 'NOT_CALCULABLE']);
        for (const o of y.owners) expect([o.amount, o.residualValue, o.calculationStatus]).toEqual([null, null, 'NOT_CALCULABLE']);
      }
      for (const y of s.years) {
        expect([y.status, y.amount, y.residualValue, y.owners?.map((o) => o.amount)]).toEqual(['DEPRECIATION_NOT_AVAILABLE', null, null, [null, null]]);
      }
      expect(s.status).toBe('DEPRECIATION_NOT_AVAILABLE');
      expect(s.review.open.map((o) => o.code)).toContain(c.reasons[0]?.code);
      expect(s.review.info.map((o) => o.code)).not.toContain(c.reasons[0]?.code);
    }
  });

  it('the details: NOT_SUPPORTED names the confirmed state and the causes; the component shows the entry with its status', () => {
    const c = component(derive(withMethods([standard({ reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: B, specialDepreciation: ['SPECIAL_7B'] })])));
    expect(c.reasons).toEqual([
      { code: 'DEPRECIATION_METHOD_NOT_SUPPORTED', details: { acquisitionId: W, reviewState: 'ADVISOR_CONFIRMED', causes: ['SPECIAL_7B'] } },
    ]);
    expect(c.method).toEqual({
      consideration: 'PAID',
      method: 'LINEAR_7_4',
      specialDepreciation: ['SPECIAL_7B'],
      subsidiesReceived: false,
      newBuildingByConversion: false,
      otherSpecialCase: false,
      otherSpecialCaseNote: null,
      reviewState: 'ADVISOR_CONFIRMED',
      advisorPartyId: B,
      notes: null,
      methodStatus: 'NOT_SUPPORTED',
      causes: ['SPECIAL_7B'],
    });
    expect(component(derive(withMethods([]))).method).toBeNull();
    // A confirmed STANDARD entry: §59A's example to the cent.
    const ok = component(derive(withMethods([standard()])));
    expect([amount(yearOf(ok, 2026).amount), amount(yearOf(ok, 2027).amount), ok.method?.methodStatus]).toEqual(['2544.00', '5088.00', 'STANDARD']);
  });

  it('evaluated for every listed component: a DRAFT and one without economicTransferDate carry it beside their own reasons', () => {
    expect(codes(component(derive(sole({ status: 'DRAFT' }, { purchaseMethods: [] }))).reasons)).toEqual([
      'ACQUISITION_NOT_CONFIRMED',
      'DEPRECIATION_METHOD_NOT_CONFIRMED',
    ]);
    const noStart = component(derive(sole({ economicTransferDate: null }, { purchaseMethods: [] })));
    expect(noStart.reasons).toEqual([
      { code: 'TRANSFER_DATE_MISSING', details: { contractDate: '2026-05-15' } },
      {
        code: 'DEPRECIATION_METHOD_NOT_CONFIRMED',
        details: { acquisitionId: W, reviewState: null, methodStatus: null, causes: null, newBuildingInCompletionYear: false },
      },
    ]);
  });

  it('the order: TRANSFER_DATE_MISSING, HISTORICAL_RULE_NOT_SUPPORTED, the method reason, BUYER_ALREADY_OWNER; a pre-2006 purchase with a confirmed STANDARD entry stays not computable', () => {
    const early = sole({ contractDate: day('2004-05-01'), economicTransferDate: day('2004-06-01') }, { buildingCompletionYear: 1990 });
    expect(codes(component(derive(early)).reasons)).toEqual(['HISTORICAL_RULE_NOT_SUPPORTED']);
    expect(component(derive(early)).status).toBe('NOT_COMPUTABLE');
    const unpaid = sole(
      { contractDate: day('2004-05-01'), economicTransferDate: day('2004-06-01') },
      { buildingCompletionYear: 1990, purchaseMethods: [standard({ consideration: 'UNPAID' })] },
    );
    expect(codes(component(derive(unpaid)).reasons)).toEqual(['HISTORICAL_RULE_NOT_SUPPORTED', 'DEPRECIATION_METHOD_NOT_SUPPORTED']);
    // The legacy 1/1 workaround of §28.1A (X confirmed with acquiredShare 1/1 by a buyer who already held 1/2), X without
    // an entry: the method reason before BUYER_ALREADY_OWNER.
    const legacy: ScheduleInput = {
      ...acc8({ from: 2028, to: 2029 }),
      asset: asset({ purchaseMethods: [standard({ acquisitionId: W })] }),
      acquisitions: [
        acquisition({ economicTransferDate: day('2026-01-01') }),
        acquisition({ id: X, sellerPartyIds: [B], contractDate: day('2028-06-01'), economicTransferDate: day('2028-07-01') }),
      ],
      ownerships: [
        ownership(A, '1/2', '2026-01-01', '2028-06-30', W),
        ownership(B, '1/2', '2026-01-01', '2028-06-30', W),
        ownership(A, '1/1', '2028-07-01', null, X),
      ],
    };
    expect(codes(component(derive(legacy), 1).reasons)).toEqual(['DEPRECIATION_METHOD_NOT_CONFIRMED', 'BUYER_ALREADY_OWNER']);
  });

  it('the shorter useful life is independent: a STANDARD entry with a confirmed shorter life is computed as today', () => {
    const c = component(
      derive(
        acc8({
          asset: asset({
            shorterUsefulLives: [{ acquisitionId: W, usefulLifeYears: 30, evidence: standard().evidence, reviewState: 'CONFIRMED', advisorPartyId: null }],
          }),
        }),
      ),
    );
    expect([c.status, codes(c.flags), c.rate?.kind]).toEqual(['COMPUTABLE', ['SHORTER_USEFUL_LIFE'], 'SHORTER_USEFUL_LIFE']);
  });
});

describe('the parameter from the registry, the version of the start year (§59C "The rule")', () => {
  const v1 = DE_AFA_BUILDING_LINEAR_V1.parameters;
  // A test registry whose @1 alone admits the degressive method: a 2020 start reads @1, a 2026 start reads @2.
  const differing = new RuleRegistry([
    {
      ...DE_AFA_BUILDING_LINEAR_V1,
      parameters: { ...v1, methodStatus: { ...v1.methodStatus, standard: { ...v1.methodStatus.standard, methods: ['DEGRESSIVE_7_5'] } } },
    },
    DE_AFA_BUILDING_LINEAR_V2,
  ]);
  const degressive = { purchaseMethods: [standard({ method: 'DEGRESSIVE_7_5' })] };

  it('a 2020 start reads @1 (computed under the test standard), a 2026 start reads @2 (not supported)', () => {
    const at2020 = component(derive(sole({ contractDate: day('2020-03-01'), economicTransferDate: day('2020-04-01') }, degressive), differing));
    const at2026 = component(derive(sole({}, degressive), differing));
    expect([at2020.status, at2020.method?.methodStatus]).toEqual(['COMPUTABLE', 'STANDARD']);
    expect([at2026.status, codes(at2026.reasons)]).toEqual(['NOT_COMPUTABLE', ['DEPRECIATION_METHOD_NOT_SUPPORTED']]);
  });

  it('another standard in both versions changes the status: a test registry admitting UNPAID computes an unpaid purchase', () => {
    const p = DE_AFA_BUILDING_LINEAR_V2.parameters.methodStatus;
    const both = (x: typeof v1) => ({ ...x, methodStatus: { ...p, standard: { ...p.standard, consideration: ['PAID', 'UNPAID'] } } });
    const admitting = new RuleRegistry([
      { ...DE_AFA_BUILDING_LINEAR_V1, parameters: both(DE_AFA_BUILDING_LINEAR_V1.parameters) },
      { ...DE_AFA_BUILDING_LINEAR_V2, parameters: both(DE_AFA_BUILDING_LINEAR_V2.parameters) },
    ]);
    const unpaid = withMethods([standard({ consideration: 'UNPAID' })]);
    expect(component(derive(unpaid, admitting)).status).toBe('COMPUTABLE');
    expect(component(derive(unpaid)).status).toBe('NOT_COMPUTABLE');
  });
});

describe('an item part under a purchase with a method reason (§59C "Items of such a purchase")', () => {
  // A bought 3/5 (W, its confirmed STANDARD entry), B 2/5 (X); a capitalised extension of 12,000.00 in 2027.
  const twoPurchases = (entries: PurchaseMethod[]): ScheduleInput => ({
    ...acc8({ from: 2027, to: 2028 }),
    asset: asset({ purchaseMethods: entries }),
    acquisitions: [acquisition({ acquiredShare: { numerator: 3, denominator: 5 } }), acquisition({ id: X, acquiredShare: { numerator: 2, denominator: 5 } })],
    ownerships: [ownership(A, '3/5', '2026-07-01', null, W), ownership(B, '2/5', '2026-07-01', null, X)],
    capitalizedItems: [capitalized(EXTENSION, '2027-05-02', '12000.00')],
  });

  it('B’s part is not computable in every year with B’s purchase reason; A’s part is computed; the component stays COMPUTABLE', () => {
    const c = item(derive(twoPurchases([standard({ acquisitionId: W })])));
    expect(c.status).toBe('COMPUTABLE');
    for (const year of [2027, 2028]) {
      const y = c.years.find((x) => x.year === year);
      expect([amount(owner(y, A)?.amount), owner(y, A)?.calculationStatus]).toEqual(['144.00', 'PROVISIONAL']);
      expect(owner(y, B)).toMatchObject({
        amount: null,
        calculationStatus: 'NOT_CALCULABLE',
        reasons: [{ code: 'DEPRECIATION_METHOD_NOT_CONFIRMED', details: { acquisitionId: X } }],
      });
    }
    // A confirmed NOT_SUPPORTED entry of X: DEPRECIATION_METHOD_NOT_SUPPORTED on B's part, never computed linearly.
    const notSupported = item(derive(twoPurchases([standard({ acquisitionId: W }), standard({ acquisitionId: X, method: 'DEGRESSIVE_7_5A' })])));
    expect(owner(notSupported.years[0], B)?.reasons).toEqual([{ code: 'DEPRECIATION_METHOD_NOT_SUPPORTED', details: { acquisitionId: X } }]);
    // Counter-check: both entries confirmed STANDARD, both parts computed.
    const both = item(derive(twoPurchases([standard({ acquisitionId: W }), standard({ acquisitionId: X })])));
    expect(both.years[0]?.owners.map((o) => amount(o.amount))).toEqual(['144.00', '96.00']);
  });

  it('a purchase of the owner’s pool with a method reason stops the part too, never the end read from a linear assumption', () => {
    // A bought W (3/5, confirmed) and later X (a further 2/5, no entry): A's item part reads the pool of both purchases.
    const input: ScheduleInput = {
      ...acc8({ from: 2029, to: 2029 }),
      asset: asset({ purchaseMethods: [standard({ acquisitionId: W })] }),
      acquisitions: [
        acquisition({ acquiredShare: { numerator: 3, denominator: 5 } }),
        acquisition({ id: X, contractDate: day('2028-05-01'), economicTransferDate: day('2028-07-01'), acquiredShare: { numerator: 2, denominator: 5 } }),
      ],
      ownerships: [ownership(A, '3/5', '2026-07-01', '2028-06-30', W), ownership(A, '1/1', '2028-07-01', null, X)],
      capitalizedItems: [capitalized(EXTENSION, '2029-05-02', '12000.00', [[A, '1/1']])],
    };
    expect(ownerIn(item(derive(input)).years[0] as never, A)?.reasons).toEqual([{ code: 'DEPRECIATION_METHOD_NOT_CONFIRMED', details: { acquisitionId: X } }]);
  });
});

describe('the entry in the stored inputs and the fingerprint (§59C "Recorded versions and the fingerprint")', () => {
  const fp = (input: ScheduleInput, year: number) =>
    inputFingerprint(live(input, new RuleRegistry([DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2]), 2035).inputs, year, identity);

  it('the purchase component’s inputs carry the entry’s facts and review state; confirming by the advisor or removing it changes every year’s fingerprint', () => {
    const confirmed = withMethods([standard()]);
    const inputs = live(confirmed, new RuleRegistry([DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2]), 2035).inputs;
    expect(inputs.components[0]?.method).toEqual({
      consideration: 'PAID',
      method: 'LINEAR_7_4',
      specialDepreciation: [],
      subsidiesReceived: false,
      newBuildingByConversion: false,
      otherSpecialCase: false,
      reviewState: 'CONFIRMED',
    });
    const advisor = withMethods([standard({ reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: B })]);
    const removed = withMethods([]);
    for (const year of [2026, 2027, 2030]) {
      expect(fp(advisor, year), String(year)).not.toBe(fp(confirmed, year));
      expect(fp(removed, year), String(year)).not.toBe(fp(confirmed, year));
    }
    // Counter-check: the evidence and the notes are not inputs.
    const annotated = withMethods([standard({ notes: 'geprüft (synthetisch)', evidence: { ...standard().evidence, source: 'Anlage V 2025' } })]);
    expect(fp(annotated, 2027)).toBe(fp(confirmed, 2027));
  });
});
