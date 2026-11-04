import { describe, expect, it } from 'vitest';
import { RuleRegistry } from '../../shared/index.js';
import { TAX_RULES, day, eur, performed } from './anschaffungsnahe-hausgeld.test-support.js';
import { costLineNotCounted, planCostLineClassification, type CostLineFacts } from './cost-line-classification.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';

/**
 * §58M (VC-X-27; Entscheidung des Projektinhabers, 2026-11-04, M1, M2, M8): the create's checks of a cost line's
 * classification after the line was found, in §58B's order. Synthetic figures.
 */
const facts: CostLineFacts = {
  statementId: 'st-2027',
  status: 'CONFIRMED',
  supersededBy: null,
  periodFrom: day('2027-01-01'),
  periodUntil: day('2027-12-31'),
  propertyReferenceId: 'pr-p',
  position: 3,
  account: 'Instandsetzung Fassade',
  classification: 'NON_RECOVERABLE',
  unitShare: eur('2000.00'),
};
const maintenance = { taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', supersedes: null } as const;
const plan = (
  f: Partial<CostLineFacts> = {},
  r: Partial<Parameters<typeof planCostLineClassification>[2]> = {},
  registry = TAX_RULES,
  currentId: string | null = null,
) => planCostLineClassification({ ...facts, ...f }, currentId, { ...maintenance, ...r }, registry);

describe('the classification of a cost line (§58M): the checks in order', () => {
  it('a NON_RECOVERABLE line of a CONFIRMED statement classifies under DE_ANSCHAFFUNGSNAHE@1, storing its unit share', () => {
    expect(plan()).toEqual({ kind: 'CLASSIFY', rule: { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 }, costLine: { unitShare: eur('2000.00') } });
    expect(plan({}, { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT' })).toMatchObject({ kind: 'CLASSIFY' });
  });

  it('the line before the statement: RECOVERABLE, RESERVE and 0.00 not counted, then SUPERSEDED, DRAFT and VOID', () => {
    const reason = (f: Partial<CostLineFacts>) => (plan(f) as { reason?: string }).reason;
    expect(reason({ classification: 'RECOVERABLE', status: 'DRAFT' })).toBe('COST_LINE_NOT_NON_RECOVERABLE');
    expect(reason({ classification: 'RESERVE' })).toBe('COST_LINE_NOT_NON_RECOVERABLE');
    expect(reason({ unitShare: eur('0.00') })).toBe('COST_LINE_NOT_NON_RECOVERABLE');
    expect(plan({ status: 'SUPERSEDED', supersededBy: 'st-2027b' })).toEqual({
      kind: 'WEG_SOURCE_NOT_COUNTED',
      sourceType: 'WEG_STATEMENT_COST_LINE',
      reason: 'STATEMENT_SUPERSEDED',
      details: { supersededBy: 'st-2027b' },
    });
    expect(reason({ status: 'DRAFT' })).toBe('STATEMENT_NOT_CONFIRMED');
    expect(reason({ status: 'VOID' })).toBe('STATEMENT_NOT_CONFIRMED');
    expect(costLineNotCounted(facts)).toBeNull();
  });

  it('NO_APPLICABLE_RULE before 2004 and without hausgeldMaintenance; then the line and treatment of the rule', () => {
    expect(plan({ periodFrom: day('2003-01-01'), periodUntil: day('2003-12-31') })).toEqual({
      kind: 'NO_APPLICABLE_RULE',
      ruleCode: 'DE_ANSCHAFFUNGSNAHE',
      date: '2003-12-31',
    });
    const without = TAXATION_RULE_VERSIONS.map((v) =>
      v.ruleCode === 'DE_ANSCHAFFUNGSNAHE' ? { ...v, parameters: { ...(v.parameters as object), hausgeldMaintenance: undefined } } : v,
    );
    expect(plan({}, {}, new RuleRegistry(without))).toMatchObject({ kind: 'NO_APPLICABLE_RULE' });
    expect(plan({}, { taxCategory: 'WEG_SPENDING' })).toEqual({
      kind: 'TREATMENT_NOT_ALLOWED',
      categoryType: null,
      sourceType: 'WEG_STATEMENT_COST_LINE',
      allowed: ['DEDUCTIBLE', 'NOT_RELEVANT'],
      taxCategories: ['MAINTENANCE', 'NOT_RELEVANT'],
    });
    expect(plan({}, { treatment: 'CAPITALIZED' })).toMatchObject({ kind: 'TREATMENT_NOT_ALLOWED' });
  });

  it('the net amount against the unit share (a credit by its absolute value), the performance around periodUntil, supersedes', () => {
    expect(plan({}, { netAmount: eur('2000.01') })).toMatchObject({ kind: 'NET_AMOUNT_EXCEEDS_GROSS' });
    expect(plan({ unitShare: eur('-500.00') }, { netAmount: eur('500.00') })).toMatchObject({ kind: 'CLASSIFY', costLine: { unitShare: eur('-500.00') } });
    expect(plan({ unitShare: eur('-500.00') }, { netAmount: eur('500.01') })).toMatchObject({ kind: 'NET_AMOUNT_EXCEEDS_GROSS' });
    expect(plan({}, { performance: performed('2030-12-31', '2031-01-01') })).toMatchObject({
      kind: 'PERFORMANCE_OUT_OF_RANGE',
      sourceDate: '2027-12-31',
      allowedUntil: '2030-12-31',
    });
    expect(plan({}, { performance: performed('2030-12-01', '2030-12-31') })).toMatchObject({ kind: 'CLASSIFY' });
    expect(plan({}, { performance: performed('2027-06-01', '2027-07-15', [['2027-06-30', '900.00']]) })).toEqual({ kind: 'PERFORMANCE_EVIDENCE_REQUIRED' });
    expect(plan({}, {}, TAX_RULES, 'c-1')).toEqual({ kind: 'CLASSIFICATION_EXISTS', currentClassificationId: 'c-1' });
  });
});
