import { expect } from 'vitest';
import { Money, type BusinessDate, type RuleRegistry, type RuleVersion } from '../../shared/index.js';
import type { CapitalizedItem } from '../../domains/depreciation/index.js';
import type { CapitalizedSource } from '../../domains/taxation/index.js';

/** The assertions of §59B "Load order", shared by the three cases: both Depreciation rules, eight codes, the mapping. */
export function assertLoaded(
  versions: readonly RuleVersion[],
  rules: RuleRegistry,
  toCapitalizedItem: (source: CapitalizedSource, propertyReferenceId: string) => CapitalizedItem,
): void {
  expect(versions.map((v) => `${v.ruleCode}@${v.version}`)).toEqual(['DE_AFA_BUILDING_LINEAR@1', 'DE_AFA_BUILDING_LINEAR@2', 'DE_AFA_MOVABLE_LINEAR@1']);
  expect(rules.codes()).toHaveLength(8);
  expect(rules.find({ ruleCode: 'DE_AFA_MOVABLE_LINEAR', version: 1 })).toBeDefined();
  const source: CapitalizedSource = {
    sourceType: 'WEG_ASSESSMENT_USE',
    sourceId: '0000eeee-0000-4000-8000-000000000091',
    sourcePosition: 1,
    propertyReferenceId: null,
    date: '2028-02-15' as BusinessDate,
    dateSource: 'USE',
    taxYear: 2028,
    lineAmount: Money.of('9000.00', 'EUR'),
    netAmount: null,
    classificationId: '0000eeee-0000-4000-8000-000000000082',
    reviewState: 'USER_CONFIRMED',
    taxCategory: 'WEG_SPENDING',
    treatment: 'CAPITALIZED',
    counts: true,
    anschaffungsnaheAcquisitionId: '0000cccc-0000-4000-8000-000000000002',
    loan: null,
    constructionPeriodInterestId: null,
    parts: [{ participant: 'NOT_OWNED', ownershipIds: [], share: { numerator: 1n, denominator: 1n }, amount: Money.of('9000.00', 'EUR') }],
    flags: [{ code: 'WITHDRAWAL_DATE_ASSUMED', details: {} }],
  };
  const { propertyReferenceId: _pr, ...rest } = source;
  expect(toCapitalizedItem(source, '0000eeee-0000-4000-8000-000000000001')).toEqual({ ...rest, propertyReferenceId: '0000eeee-0000-4000-8000-000000000001' });
}
