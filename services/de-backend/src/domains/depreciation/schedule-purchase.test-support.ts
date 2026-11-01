import { RuleRegistry, type Money } from '../../shared/index.js';
import type { DepreciationAsset } from './asset.js';
import { DE_AFA_BUILDING_LINEAR_V1, DE_AFA_BUILDING_LINEAR_V2, type BuildingLinearParameters } from './rules/de-afa-building-linear.js';
import { DEPRECIATION_RULE_VERSIONS } from './rules/versions.js';
import {
  deriveSchedule,
  type ComponentYear,
  type DepreciationSchedule,
  type ScheduleAcquisition,
  type ScheduleComponent,
  type ScheduleInput,
} from './schedule.js';
import { A, acquisition, asset, day, eur, ownership } from './schedule.test-support.js';

/**
 * The helpers of the purchase schedule's tests (api-design.md §59A): `schedule.test.ts`, `schedule-tenure.test.ts` and
 * `schedule-rules.test.ts`. Moved out of `schedule.test.ts` unchanged (issue #191); no `expect` here.
 */
export const registry = new RuleRegistry(DEPRECIATION_RULE_VERSIONS);
export const derive = (input: ScheduleInput, reg: RuleRegistry = registry) => deriveSchedule(input, reg);
export const amount = (m: Money | null | undefined) => (m === null || m === undefined ? null : m.amount);
export const component = (s: DepreciationSchedule, i = 0) => s.components[i] as ScheduleComponent;
export const yearOf = (c: ScheduleComponent, year: number) => c.years.find((y) => y.year === year) as ComponentYear;
export const ownerIn = (y: ComponentYear, partyId: string) => y.owners.find((o) => o.ownerPartyId === partyId);
export const codes = (flags: readonly { code: string }[]) => flags.map((f) => f.code);
export const cents = (m: Money | null | undefined) => BigInt((m?.amount ?? '0').replace('.', ''));
/** A registry whose rule versions both carry other parameters. */
export const withParameters = (change: (p: BuildingLinearParameters) => BuildingLinearParameters) =>
  new RuleRegistry([
    { ...DE_AFA_BUILDING_LINEAR_V1, parameters: change(DE_AFA_BUILDING_LINEAR_V1.parameters) },
    { ...DE_AFA_BUILDING_LINEAR_V2, parameters: change(DE_AFA_BUILDING_LINEAR_V2.parameters) },
  ]);
/** A sole owner A of `acq` (1/1) from its transfer date. */
export const sole = (acq: Partial<ScheduleAcquisition>, assetFacts: Partial<DepreciationAsset> = {}, extra: Partial<ScheduleInput> = {}): ScheduleInput => {
  const a = acquisition(acq);
  return {
    asset: asset(assetFacts),
    acquisitions: [a],
    ownerships: [ownership(A, '1/1', a.economicTransferDate ?? a.contractDate, null, a.id)],
    today: day('2026-10-30'),
    from: 2000,
    to: 2100,
    ownerPartyId: null,
    ...extra,
  };
};
/** An Acquisition whose basis is exactly `basis` (price = total = building, no costs). */
export const exactBasis = (basis: string, overrides: Partial<ScheduleAcquisition> = {}): Partial<ScheduleAcquisition> => ({
  purchasePrice: eur(basis),
  costs: [],
  allocation: {
    id: '0000bbbb-0000-4000-8000-000000000031',
    method: 'PURCHASE_CONTRACT',
    reviewState: 'CONFIRMED',
    totalAllocableAmount: eur(basis),
    buildingAmount: eur(basis),
  },
  ...overrides,
});
/** A deterministic generator (synthetic inputs, reproducible failures). */
export function random(seed: number) {
  let state = seed;
  return (max: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % max;
  };
}
