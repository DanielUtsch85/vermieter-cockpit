import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import type { ScheduleCost, ScheduleInput } from './schedule.js';
import { DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2 } from './rules/de-afa-building-linear.js';
import { acc8, acquisition, asset, eur } from './schedule.test-support.js';
import { amount, codes, component, derive, withParameters } from './schedule-purchase.test-support.js';
import { inputFingerprint } from './version-fingerprint.js';
import { identity, live } from './version.test-support.js';

/**
 * VC-X-42 (api-design.md §59D "The basis function", "Recorded versions and the fingerprint"): a purchase whose
 * `NOTARY` cost is not classified, or only by an unconfirmed classification, is `NOT_COMPUTABLE` with
 * `ACQUISITION_COST_UNCLASSIFIED` in every year, never 0.00; its basis shows the lower bound and the unclassified costs;
 * the classifications that decided are stored inputs and change the fingerprint. Synthetic (ACC8's purchase: price
 * 300,000.00, transfer tax 15,000.00, notary 3,000.00, financing 1,200.00; building 254,400.00 of 318,000.00).
 */
const NOTARY = '0000ffff-0000-4000-8000-000000000052';
const owners = acc8().ownerships;
const withNotary = (classification: ScheduleCost['classification']): ScheduleInput => {
  const base = acquisition();
  const costs = base.costs.map((c) => (c.id === NOTARY ? { ...c, classification } : c));
  return acc8({ acquisitions: [acquisition({ acquiredShare: { numerator: 1, denominator: 1 }, costs })], ownerships: owners });
};
const confirmedAs = (id: string, parts: readonly (readonly [string, string])[], reviewState = 'CONFIRMED') => ({
  id,
  reviewState,
  parts: parts.map(([purpose, value]) => ({ purpose, amount: eur(value) })),
});
const C1 = '0000ffff-0000-4000-8000-000000000071';
const C2 = '0000ffff-0000-4000-8000-000000000072';
const registry = new RuleRegistry([DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2]);

describe('the purchase component with an unclassified cost (§59D)', () => {
  it('no classification: NOT_COMPUTABLE with ACQUISITION_COST_UNCLASSIFIED (the cost named) in every year, never 0.00; the basis shows both bounds', () => {
    const s = derive(withNotary(null));
    const c = component(s);
    expect([c.status, c.reasons]).toEqual(['NOT_COMPUTABLE', [{ code: 'ACQUISITION_COST_UNCLASSIFIED', details: { costIds: [NOTARY] } }]]);
    for (const y of c.years) expect([y.amount, y.cumulative, y.residualValue, y.calculationStatus]).toEqual([null, null, null, 'NOT_CALCULABLE']);
    for (const y of s.years) expect([y.status, y.amount]).toEqual(['DEPRECIATION_NOT_AVAILABLE', null]);
    expect([amount(c.basis.amount), amount(c.basis.amountWithUnclassified), amount(c.basis.acquisitionCosts)]).toEqual(['252000.00', '254400.00', '15000.00']);
    expect(c.basis.unclassifiedCosts).toEqual([{ costId: NOTARY, category: 'NOTARY', amount: eur('3000.00'), classificationReviewState: null }]);
    expect(s.review.open.map((o) => o.code)).toContain('ACQUISITION_COST_UNCLASSIFIED');
  });

  it('an UNREVIEWED or NEEDS_REVIEW classification still holds it; confirmed it decides (OWNERSHIP_TRANSFER in, NOT_ACQUISITION_COST out)', () => {
    for (const state of ['UNREVIEWED', 'NEEDS_REVIEW']) {
      const c = component(derive(withNotary(confirmedAs(C1, [['OWNERSHIP_TRANSFER', '3000.00']], state))));
      expect([c.status, codes(c.reasons), c.basis.unclassifiedCosts[0]?.classificationReviewState]).toEqual([
        'NOT_COMPUTABLE',
        ['ACQUISITION_COST_UNCLASSIFIED'],
        state,
      ]);
    }
    const counted = component(derive(withNotary(confirmedAs(C1, [['OWNERSHIP_TRANSFER', '3000.00']]))));
    expect([counted.status, amount(counted.basis.amount), counted.basis.unclassifiedCosts]).toEqual(['COMPUTABLE', '254400.00', []]);
    const excluded = component(derive(withNotary(confirmedAs(C1, [['NOT_ACQUISITION_COST', '3000.00']]))));
    expect([excluded.status, amount(excluded.basis.amount)]).toEqual(['COMPUTABLE', '252000.00']);
    expect(excluded.basis.excludedCosts.map((e) => [e.category, e.purpose, amount(e.amount)])).toEqual([
      ['FINANCING_RELATED', null, '1200.00'],
      ['NOTARY', 'NOT_ACQUISITION_COST', '3000.00'],
    ]);
  });

  it('the reason comes after the basis reasons and before the others: an unconfirmed allocation is ALLOCATION_NOT_CONFIRMED alone; no method entry adds its own', () => {
    const base = withNotary(null);
    const allocationOpen: ScheduleInput = {
      ...base,
      acquisitions: base.acquisitions.map((a) => ({ ...a, allocation: a.allocation === null ? null : { ...a.allocation, reviewState: 'UNREVIEWED' } })),
    };
    expect(codes(component(derive(allocationOpen)).reasons)).toEqual(['ALLOCATION_NOT_CONFIRMED']);
    expect(codes(component(derive({ ...base, asset: asset({ purchaseMethods: [] }) })).reasons)).toEqual([
      'ACQUISITION_COST_UNCLASSIFIED',
      'DEPRECIATION_METHOD_NOT_CONFIRMED',
    ]);
  });

  it('the policy is the rule of the start: a version that needs no classification for NOTARY counts it by its category', () => {
    const looser = withParameters((p) => ({ ...p, basis: { ...p.basis, costClassification: { ...p.basis.costClassification, requiredFor: ['OTHER'] } } }));
    const c = component(derive(withNotary(null), looser));
    expect([c.status, amount(c.basis.amount)]).toEqual(['COMPUTABLE', '254400.00']);
  });
});

describe('the classifications in the stored inputs and the fingerprint (§59D, §60)', () => {
  const inputsOf = (input: ScheduleInput) => live(input, registry, 2035).inputs.components[0]?.acquisition;
  const fp = (input: ScheduleInput, year: number) => inputFingerprint(live(input, registry, 2035).inputs, year, identity);

  it('a two-part notary cost: in both the counted and the excluded ids, the totals by part, the classification id stored', () => {
    const q = inputsOf(
      withNotary(
        confirmedAs(C1, [
          ['OWNERSHIP_TRANSFER', '2000.00'],
          ['FINANCING', '1000.00'],
        ]),
      ),
    );
    expect(q).toMatchObject({
      countedCostIds: ['0000ffff-0000-4000-8000-000000000051', NOTARY],
      countedCostsTotal: 1_700_000n,
      excludedCostIds: [NOTARY, '0000ffff-0000-4000-8000-000000000053'],
      excludedCostsTotal: 220_000n,
      costClassificationIds: [C1],
    });
  });

  it('a superseding classification with the same purpose changes every year’s fingerprint from the component’s first year; the same one does not', () => {
    const first = withNotary(confirmedAs(C1, [['OWNERSHIP_TRANSFER', '3000.00']]));
    const superseding = withNotary(confirmedAs(C2, [['OWNERSHIP_TRANSFER', '3000.00']]));
    for (const year of [2026, 2027, 2030]) {
      expect(fp(superseding, year), String(year)).not.toBe(fp(first, year));
      expect(fp(withNotary(confirmedAs(C1, [['OWNERSHIP_TRANSFER', '3000.00']])), year)).toBe(fp(first, year));
    }
    expect(inputsOf(first)?.costClassificationIds).toEqual([C1]);
    // A cost without a classification decided by its category stores none.
    expect(inputsOf(acc8({ acquisitions: [acquisition({ costs: acquisition().costs.filter((c) => c.id !== NOTARY) })] }))?.costClassificationIds).toEqual([]);
  });
});
