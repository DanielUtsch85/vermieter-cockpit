import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate, type RuleVersion } from '../../shared/index.js';
import type { BasisCost } from '../acquisition/index.js';
import { checkAnschaffungsnahe, NOT_COMPUTABLE_REASONS, type CheckAcquisition, type CheckSource } from './anschaffungsnahe.js';
import { DE_ANSCHAFFUNGSNAHE_V1, type AnschaffungsnaheParameters } from './rules/de-anschaffungsnahe.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';

/**
 * The 15 % check with unclassified acquisition costs (api-design.md §59D "The 15 % check's denominator", open question 2,
 * decided by the owner on 2026-11-01): decided by the two bounds, `NOT_COMPUTABLE` only in between, `NOT_FINAL`
 * (`ACQUISITION_COSTS_UNCLASSIFIED`) otherwise. Synthetic figures: price 240,000.00, transfer tax 24,000.00 and an
 * `OTHER` cost of 4,000.00; building 198,000.00 of 264,000.00 (3/4). Lower bound 198,000.00 (threshold 29,700.00),
 * upper bound 201,000.00 (threshold 30,150.00).
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');

const acquisition: CheckAcquisition = {
  id: 'acq-1',
  propertyReferenceId: 'pr-1',
  status: 'CONFIRMED',
  transferDate: day('2026-03-15'),
  acquiredShare: { numerator: 1, denominator: 1 },
  purchasePrice: eur('240000.00'),
};
const allocation = { id: 'al-1', reviewState: 'CONFIRMED', totalAllocableAmount: eur('264000.00'), buildingAmount: eur('198000.00') };
const other = (classification: BasisCost['classification'] = null): BasisCost => ({
  id: 'cost-other',
  category: 'OTHER',
  amount: eur('4000.00'),
  classification,
});
const transferTax: BasisCost = { id: 'cost-rett', category: 'REAL_ESTATE_TRANSFER_TAX', amount: eur('24000.00'), classification: null };
const confirmedAs = (purpose: string, reviewState = 'CONFIRMED') => ({ id: 'cl-1', reviewState, parts: [{ purpose, amount: eur('4000.00') }] });

/** A summed source with a net amount, mid-window: nothing else holds the result from being final. */
const source = (net: string): CheckSource => ({
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: 's-1',
  sourcePosition: null,
  date: day('2027-05-14'),
  taxYear: 2027,
  taxCategory: 'MAINTENANCE',
  treatment: 'DEDUCTIBLE',
  reviewState: 'USER_CONFIRMED',
  origin: 'CLASSIFICATION',
  classificationId: 'c-1',
  grossAmount: eur(net),
  direction: 'OUTFLOW',
  netAmount: eur(net),
  annuallyRecurring: false,
  anschaffungsnaheAcquisitionId: null,
  sourceFlags: [],
});
const check = (net: string, costs: readonly BasisCost[] = [transferTax, other()], registry: RuleRegistry = TAX_RULES, alloc = allocation) =>
  checkAnschaffungsnahe({ acquisition, costs, allocation: alloc, sources: [source(net)], statements: [], today: day('2030-01-01') }, registry);
const notFinal = (c: ReturnType<typeof check>) => c.flags.find((f) => f.code === 'NOT_FINAL')?.details;

describe('the anschaffungsnahe check with unclassified acquisition costs (§59D)', () => {
  it('above 15 % of the upper bound: ABOVE_THRESHOLD whatever the classification, not final (ACQUISITION_COSTS_UNCLASSIFIED), the suggestion kept', () => {
    const c = check('30150.01');
    expect([c.status, c.notComputableReason, c.final]).toEqual(['ABOVE_THRESHOLD', null, false]);
    expect(notFinal(c)).toEqual({ reasons: ['ACQUISITION_COSTS_UNCLASSIFIED'] });
    expect([c.threshold, c.thresholdWithUnclassified, c.percentOfBasis]).toEqual(['29700.00', '30150.00', '15.23']);
    expect(c.basis).toMatchObject({ basisAmount: eur('198000.00'), basisAmountWithUnclassified: eur('201000.00'), acquisitionCosts: eur('24000.00') });
    expect(c.basis?.unclassifiedCosts).toEqual([{ costId: 'cost-other', category: 'OTHER', amount: eur('4000.00'), classificationReviewState: null }]);
    expect(c.sources[0]?.suggestedTreatment).toBe('CAPITALIZED');
    expect(c.sources[0]?.flags).toContainEqual({
      code: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN',
      details: { acquisitionId: 'acq-1', final: false, rule: { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 } },
    });
  });

  it('not above 15 % of the lower bound: NOT_ABOVE_THRESHOLD, not final (ACQUISITION_COSTS_UNCLASSIFIED)', () => {
    for (const net of ['29700.00', '1000.00']) {
      const c = check(net);
      expect([c.status, c.notComputableReason, c.final, c.affectedYears]).toEqual(['NOT_ABOVE_THRESHOLD', null, false, []]);
      expect(notFinal(c)).toEqual({ reasons: ['ACQUISITION_COSTS_UNCLASSIFIED'] });
    }
  });

  it('in between (above the lower bound, not above the upper): NOT_COMPUTABLE with ACQUISITION_COST_UNCLASSIFIED, never decided on a guess', () => {
    expect(NOT_COMPUTABLE_REASONS).toContain('ACQUISITION_COST_UNCLASSIFIED');
    for (const net of ['29700.01', '30000.00', '30150.00']) {
      const c = check(net);
      expect([c.status, c.notComputableReason, c.threshold, c.thresholdWithUnclassified, c.percentOfBasis, c.affectedYears]).toEqual([
        'NOT_COMPUTABLE',
        'ACQUISITION_COST_UNCLASSIFIED',
        null,
        null,
        null,
        null,
      ]);
      expect(c.sources[0]?.suggestedTreatment).toBeNull();
      expect(c.basis).toMatchObject({ basisAmount: eur('198000.00'), basisAmountWithUnclassified: eur('201000.00') });
    }
  });

  it('an UNREVIEWED or NEEDS_REVIEW classification still holds the cost unclassified; a confirmed NOT_ACQUISITION_COST excludes it', () => {
    for (const state of ['UNREVIEWED', 'NEEDS_REVIEW'])
      expect(check('30000.00', [transferTax, other(confirmedAs('OWNERSHIP_TRANSFER', state))]).status).toBe('NOT_COMPUTABLE');
    const excluded = check('29700.01', [transferTax, other(confirmedAs('NOT_ACQUISITION_COST'))]);
    expect([excluded.status, excluded.final, excluded.threshold, excluded.thresholdWithUnclassified]).toEqual(['ABOVE_THRESHOLD', true, '29700.00', null]);
  });

  it('all classified: as before, one basis, final when nothing else holds it (OWNERSHIP_TRANSFER in: 201,000.00, threshold 30,150.00)', () => {
    const classified = [transferTax, other(confirmedAs('OWNERSHIP_TRANSFER', 'ADVISOR_CONFIRMED'))];
    const below = check('30150.00', classified);
    expect([below.status, below.final, below.flags, below.threshold, below.thresholdWithUnclassified]).toEqual([
      'NOT_ABOVE_THRESHOLD',
      true,
      [],
      '30150.00',
      null,
    ]);
    expect(below.basis).toMatchObject({ basisAmount: eur('201000.00'), basisAmountWithUnclassified: eur('201000.00'), unclassifiedCosts: [] });
    expect(check('30150.01', classified).status).toBe('ABOVE_THRESHOLD');
  });

  it('an earlier reason of the basis comes first: an unconfirmed allocation is ALLOCATION_NOT_CONFIRMED, the costs still listed', () => {
    const c = check('50000.00', [transferTax, other()], TAX_RULES, { ...allocation, reviewState: 'UNREVIEWED' });
    expect([c.status, c.notComputableReason]).toEqual(['NOT_COMPUTABLE', 'ALLOCATION_NOT_CONFIRMED']);
    expect(c.basis?.unclassifiedCosts.map((u) => u.costId)).toEqual(['cost-other']);
  });

  it('the policy is the rule parameter: a version whose costClassification needs nothing for OTHER counts the cost by its category', () => {
    const looser: RuleVersion<AnschaffungsnaheParameters> = {
      ...DE_ANSCHAFFUNGSNAHE_V1,
      parameters: { ...DE_ANSCHAFFUNGSNAHE_V1.parameters, costClassification: { ...DE_ANSCHAFFUNGSNAHE_V1.parameters.costClassification, requiredFor: [] } },
    };
    const c = check('30000.00', [transferTax, other()], new RuleRegistry([looser]));
    expect([c.status, c.final, c.basis?.basisAmount]).toEqual(['NOT_ABOVE_THRESHOLD', true, eur('201000.00')]);
  });
});
