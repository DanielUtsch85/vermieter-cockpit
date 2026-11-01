import { RuleRegistry, centsOf, type Money } from '../../shared/index.js';
import type { CapitalizedItem } from './capitalized-item.js';
import { DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2, type BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import { deriveSchedule, type ComponentYear, type DepreciationSchedule, type ScheduleInput } from './schedule.js';
import type { ItemComponent } from './schedule-items.js';
import { A, B, W, capitalized, eur } from './schedule.test-support.js';

/**
 * The helpers and items of the capitalised items' tests (api-design.md §59B): `schedule-items.test.ts`,
 * `schedule-items-owners.test.ts` and `schedule-separate-asset.test.ts`. Moved out of `schedule-items.test.ts`
 * unchanged (issue #191); no `expect` here.
 */
export const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
export const withParameters = (change: (p: BuildingLinearParameters) => BuildingLinearParameters) =>
  new RuleRegistry([
    { ...DE_AFA_BUILDING_LINEAR_V1, parameters: change(DE_AFA_BUILDING_LINEAR_V1.parameters) },
    { ...DE_AFA_BUILDING_LINEAR_V2, parameters: change(DE_AFA_BUILDING_LINEAR_V2.parameters) },
    ...DEPRECIATION_RULE_VERSIONS.filter((v) => v.ruleCode !== 'DE_AFA_BUILDING_LINEAR'),
  ]);
export const monthOfDate = withParameters((p) => ({ ...p, subsequentCostStart: { ...p.subsequentCostStart, method: 'MONTH_OF_DATE' } }));
export const perItem = withParameters((p) => ({ ...p, subsequentCostEnd: { ...p.subsequentCostEnd, method: 'PER_ITEM_SERIES' } }));
export const startVerified = withParameters((p) => ({ ...p, subsequentCostStart: { ...p.subsequentCostStart, verified: true } }));

export const REPAIR = '0000eeee-0000-4000-8000-000000000071';
export const USE = '0000eeee-0000-4000-8000-000000000091';
export const EXTENSION = '0000eeee-0000-4000-8000-000000000072';
export const REFUND = '0000eeee-0000-4000-8000-000000000073';
export const KITCHEN_SPLIT = '0000eeee-0000-4000-8000-000000000061';
export const repair = (overrides: Partial<CapitalizedItem> = {}) =>
  capitalized(REPAIR, '2027-03-10', '35700.00', undefined, { netAmount: eur('30000.00'), anschaffungsnaheAcquisitionId: W, ...overrides });
export const use = (overrides: Partial<CapitalizedItem> = {}) =>
  capitalized(USE, '2028-02-15', '9000.00', undefined, {
    sourceType: 'WEG_ASSESSMENT_USE',
    sourcePosition: 1,
    dateSource: 'USE',
    taxCategory: 'WEG_SPENDING',
    anschaffungsnaheAcquisitionId: W,
    ...overrides,
  });
export const derive = (input: ScheduleInput, reg: RuleRegistry = registry) => deriveSchedule(input, reg);
export const items = (s: DepreciationSchedule) => s.components.filter((c): c is ItemComponent => c.kind === 'CAPITALIZED_ITEM');
export const item = (s: DepreciationSchedule, i = 0) => items(s)[i] as ItemComponent;
export const yearOf = (c: ItemComponent, year: number) => c.years.find((y) => y.year === year) as ComponentYear;
export const amount = (m: Money | null | undefined) => (m === null || m === undefined ? null : m.amount);
export const owner = (y: ComponentYear | undefined, party: string) => y?.owners.find((o) => o.ownerPartyId === party);
export const ownerAmounts = (y: ComponentYear | undefined) => [amount(owner(y, A)?.amount), amount(owner(y, B)?.amount)];
export const codes = (flags: readonly { code: string }[]) => flags.map((f) => f.code);
export const cents = (m: Money | null | undefined) => (m === null || m === undefined ? 0n : centsOf(m));
export function random(seed: number) {
  let state = seed;
  return (max: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % max;
  };
}
