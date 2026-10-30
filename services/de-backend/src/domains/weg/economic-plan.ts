import { Money, type AuditActor, type BusinessDate, type VersionConflict } from '../../shared/index.js';
import type { Page, PageRequest } from './weg.js';

/**
 * The Wirtschaftsplan of one unit (data-model.md §29, api-design.md §49.5, phase-6-plan P6-D4), as the Verwalter's
 * Einzelwirtschaftsplan prints it: the monthly Hausgeld and Rücklage of the resolution from `effectiveFrom`, the unit's
 * share of the two cost groups (recoverable from a tenant or not), optional income and reserve figures and cost lines.
 * Planning data: it never creates a Transaction (BR-WEG-003). `ACTIVE` → `VOID`; a later resolution is a new plan with
 * a later `effectiveFrom`. The Hausgeld split proposal (§49.6) is a read over it.
 */

export type WegEconomicPlanId = string & { readonly __brand: 'WegEconomicPlanId' };

export const PLAN_STATUSES = ['ACTIVE', 'VOID'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const COST_GROUPS = ['RECOVERABLE', 'NON_RECOVERABLE'] as const;
export type CostGroup = (typeof COST_GROUPS)[number];

export interface PlanCostLine {
  readonly position: number;
  readonly description: string;
  /** As printed, e.g. `Miteigentumsanteile`, `Einheit`, a consumption key. */
  readonly allocationKey: string;
  readonly totalAmount: Money;
  readonly unitShare: Money;
  readonly group: CostGroup;
}

/** The figures of a plan; all Money is EUR and ≥ 0. */
export interface PlanFigures {
  readonly monthlyHausgeld: Money;
  readonly monthlyReserveContribution: Money;
  /** The unit's annual share of each group's subtotal, as printed. */
  readonly recoverableCosts: Money;
  readonly nonRecoverableCosts: Money;
  readonly income: Money | null;
  readonly annualReserveContribution: Money | null;
  readonly costLines: readonly PlanCostLine[];
}

export interface NewEconomicPlan extends PlanFigures {
  readonly mreRealmId: string;
  readonly membershipId: string;
  readonly financialYear: number;
  readonly effectiveFrom: BusinessDate;
  readonly resolutionDate: BusinessDate | null;
  /**
   * The day of the month the advances fall due by the Vorschussbeschluss (1–31; a shorter month's last day), or null
   * (VC-7-02, api-design §58A). Only the tax year reads it, never the Hausgeld proposal (§49.6). Omitted means null.
   */
  readonly advanceDueDay?: number | null;
  readonly sourceReferences: readonly string[];
  readonly notes: string | null;
}

export interface EconomicPlan extends NewEconomicPlan {
  readonly id: WegEconomicPlanId;
  readonly advanceDueDay: number | null;
  readonly status: PlanStatus;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

/** The monthly advance in its three components (P6-D4). */
export interface PlanComponents {
  readonly recoverable: Money;
  readonly nonRecoverable: Money;
  readonly reserve: Money;
}

export type PlanFlag =
  | { readonly code: 'NO_COST_GROUPS'; readonly details: Record<string, never> }
  | { readonly code: 'LINES_DIFFER_FROM_GROUPS'; readonly details: { readonly group: CostGroup; readonly lines: Money; readonly printed: Money } }
  | { readonly code: 'HAUSGELD_DIFFERS_FROM_PLAN'; readonly details: { readonly annual: Money; readonly planned: Money } }
  | { readonly code: 'RESERVE_DIFFERS_FROM_PLAN'; readonly details: { readonly annual: Money; readonly planned: Money } };

export interface PlanView extends EconomicPlan {
  readonly components: PlanComponents;
  readonly flags: readonly PlanFlag[];
}

/** EUR amounts as integer cents, exact. */
export const centsOf = (money: Money): bigint => {
  const [whole, fraction = ''] = money.amount.replace('-', '').split('.') as [string, string?];
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  return money.isNegative() ? -cents : cents;
};

export const eur = (cents: bigint): Money => {
  const abs = cents < 0n ? -cents : cents;
  return Money.of(`${cents < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`, 'EUR');
};

/** `numerator × part / whole` rounded half-up, for non-negative integers and `whole > 0`. */
const share = (numerator: bigint, part: bigint, whole: bigint): bigint => (2n * numerator * part + whole) / (2n * whole);

/** The Verwalter rounds the monthly amount: up to 12 cents a year are not a difference (§49.5). */
const TOLERANCE = 12n;

/**
 * The derived monthly components and the plan's own check (§49.5): `recoverable` by the ratio of the groups, rounded
 * half-up, `nonRecoverable` the rest of the Hausgeld, so both sum to it exactly; the income does not enter the ratio.
 * The flags never refuse: the printed plan wins (BR-WEG-006).
 */
export function derivePlan(plan: PlanFigures): { readonly components: PlanComponents; readonly flags: readonly PlanFlag[] } {
  const hausgeld = centsOf(plan.monthlyHausgeld);
  const recoverableCosts = centsOf(plan.recoverableCosts);
  const groups = recoverableCosts + centsOf(plan.nonRecoverableCosts);
  const recoverable = groups === 0n ? 0n : share(hausgeld, recoverableCosts, groups);
  const flags: PlanFlag[] = [];
  if (groups === 0n && hausgeld > 0n) flags.push({ code: 'NO_COST_GROUPS', details: {} });
  if (plan.costLines.length > 0) {
    for (const group of COST_GROUPS) {
      const lines = plan.costLines.filter((line) => line.group === group).reduce((sum, line) => sum + centsOf(line.unitShare), 0n);
      const printed = group === 'RECOVERABLE' ? plan.recoverableCosts : plan.nonRecoverableCosts;
      if (lines !== centsOf(printed)) flags.push({ code: 'LINES_DIFFER_FROM_GROUPS', details: { group, lines: eur(lines), printed } });
    }
  }
  const plannedHausgeld = groups - (plan.income === null ? 0n : centsOf(plan.income));
  const annualHausgeld = 12n * hausgeld;
  if (abs(annualHausgeld - plannedHausgeld) > TOLERANCE) {
    flags.push({ code: 'HAUSGELD_DIFFERS_FROM_PLAN', details: { annual: eur(annualHausgeld), planned: eur(plannedHausgeld) } });
  }
  if (plan.annualReserveContribution !== null) {
    const annualReserve = 12n * centsOf(plan.monthlyReserveContribution);
    if (abs(annualReserve - centsOf(plan.annualReserveContribution)) > TOLERANCE) {
      flags.push({ code: 'RESERVE_DIFFERS_FROM_PLAN', details: { annual: eur(annualReserve), planned: plan.annualReserveContribution } });
    }
  }
  return {
    components: { recoverable: eur(recoverable), nonRecoverable: eur(hausgeld - recoverable), reserve: plan.monthlyReserveContribution },
    flags,
  };
}

const abs = (value: bigint) => (value < 0n ? -value : value);

/** The financial year a plan is filed under, as a period of inclusive days. */
export function financialYearOf(financialYear: number, startMonth: number): { readonly from: BusinessDate; readonly until: BusinessDate } {
  const from = `${financialYear}-${String(startMonth).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(financialYear + 1, startMonth - 1, 1) - 86_400_000);
  return { from: from as BusinessDate, until: end.toISOString().slice(0, 10) as BusinessDate };
}

export const inFinancialYear = (day: BusinessDate, financialYear: number, startMonth: number): boolean => {
  const year = financialYearOf(financialYear, startMonth);
  return year.from <= day && day <= year.until;
};

/** The plan for a booking date (§49.6): the `ACTIVE` plan with the latest `effectiveFrom` on or before it. */
export function planFor<T extends Pick<EconomicPlan, 'status' | 'effectiveFrom' | 'createdAt'>>(plans: readonly T[], bookingDate: BusinessDate): T | undefined {
  return plans
    .filter((p) => p.status === 'ACTIVE' && p.effectiveFrom <= bookingDate)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0))[0];
}

/** Identity of a plan create for `Idempotency-Key` replays: the normalized body, with the membership. */
export function planFingerprint(plan: NewEconomicPlan): string {
  const money = (m: Money | null) => (m === null ? null : m.amount);
  return JSON.stringify([
    plan.membershipId,
    plan.financialYear,
    plan.effectiveFrom,
    plan.resolutionDate,
    plan.advanceDueDay ?? null,
    money(plan.monthlyHausgeld),
    money(plan.monthlyReserveContribution),
    money(plan.recoverableCosts),
    money(plan.nonRecoverableCosts),
    money(plan.income),
    money(plan.annualReserveContribution),
    plan.costLines.map((l) => [l.position, l.description, l.allocationKey, l.totalAmount.amount, l.unitShare.amount, l.group]),
    plan.sourceReferences,
    plan.notes,
  ]);
}

export const HAUSGELD_CASES = ['FULL', 'HAUSGELD_ONLY', 'RESERVE_ONLY', 'AMBIGUOUS', 'PROPORTIONAL'] as const;
export type HausgeldCase = (typeof HAUSGELD_CASES)[number];

export interface ProposedSplit {
  readonly financialCategoryCode: 'WEG_RECOVERABLE' | 'WEG_NON_RECOVERABLE' | 'WEG_RESERVE_CONTRIBUTION';
  readonly amount: Money;
}

export type ProposalFlag =
  | { readonly code: 'AMBIGUOUS_AMOUNT'; readonly details: { readonly cases: readonly HausgeldCase[] } }
  | { readonly code: 'AMOUNT_DIFFERS_FROM_PLAN'; readonly details: { readonly difference: Money } };

/**
 * The split proposal of §49.6 for an amount A against a plan with H = `monthlyHausgeld` and R = the reserve. Exact
 * matches in the order `FULL` (A = H + R), `HAUSGELD_ONLY` (A = H), `RESERVE_ONLY` (A = R); several that give the same
 * splits are the first of them, several that give different splits are `AMBIGUOUS` with no splits (review on #146);
 * otherwise `PROPORTIONAL`. A split of 0 is left out.
 */
export function proposeHausgeld(
  amount: Money,
  components: PlanComponents,
): { readonly case: HausgeldCase; readonly splits: readonly ProposedSplit[]; readonly flags: readonly ProposalFlag[] } {
  const a = centsOf(amount);
  const recoverable = centsOf(components.recoverable);
  const nonRecoverable = centsOf(components.nonRecoverable);
  const reserve = centsOf(components.reserve);
  const hausgeld = recoverable + nonRecoverable;
  const splitsOf = (parts: readonly [ProposedSplit['financialCategoryCode'], bigint][]) =>
    parts.filter(([, cents]) => cents !== 0n).map(([financialCategoryCode, cents]) => ({ financialCategoryCode, amount: eur(cents) }));
  const candidates: { readonly case: HausgeldCase; readonly splits: readonly ProposedSplit[] }[] = [];
  const full = splitsOf([
    ['WEG_RECOVERABLE', recoverable],
    ['WEG_NON_RECOVERABLE', nonRecoverable],
    ['WEG_RESERVE_CONTRIBUTION', reserve],
  ]);
  if (a === hausgeld + reserve) candidates.push({ case: 'FULL', splits: full });
  if (a === hausgeld)
    candidates.push({
      case: 'HAUSGELD_ONLY',
      splits: splitsOf([
        ['WEG_RECOVERABLE', recoverable],
        ['WEG_NON_RECOVERABLE', nonRecoverable],
      ]),
    });
  if (a === reserve) candidates.push({ case: 'RESERVE_ONLY', splits: splitsOf([['WEG_RESERVE_CONTRIBUTION', reserve]]) });
  const first = candidates[0];
  if (first !== undefined) {
    const key = (splits: readonly ProposedSplit[]) => JSON.stringify(splits.map((s) => [s.financialCategoryCode, s.amount.amount]));
    if (candidates.every((c) => key(c.splits) === key(first.splits))) return { case: first.case, splits: first.splits, flags: [] };
    return { case: 'AMBIGUOUS', splits: [], flags: [{ code: 'AMBIGUOUS_AMOUNT', details: { cases: candidates.map((c) => c.case) } }] };
  }
  // PROPORTIONAL: each part rounded half-up, the rest on the largest part (the first of equals).
  const parts: [ProposedSplit['financialCategoryCode'], bigint][] = [
    ['WEG_RECOVERABLE', recoverable],
    ['WEG_NON_RECOVERABLE', nonRecoverable],
    ['WEG_RESERVE_CONTRIBUTION', reserve],
  ];
  const whole = hausgeld + reserve;
  const shares = parts.map(([code, part]) => [code, whole === 0n ? 0n : share(a, part, whole)] as [ProposedSplit['financialCategoryCode'], bigint]);
  const largest = parts.reduce((best, [, part], i) => (part > (parts[best]?.[1] ?? -1n) ? i : best), 0);
  const rest = a - shares.reduce((sum, [, cents]) => sum + cents, 0n);
  const target = shares[largest];
  if (target !== undefined) target[1] += rest;
  return { case: 'PROPORTIONAL', splits: splitsOf(shares), flags: [{ code: 'AMOUNT_DIFFERS_FROM_PLAN', details: { difference: eur(a - whole) } }] };
}

export type CreatePlanOutcome =
  | { readonly kind: 'CREATED'; readonly plan: PlanView }
  | { readonly kind: 'REPLAYED'; readonly plan: PlanView }
  | { readonly kind: 'IDEMPOTENCY_CONFLICT' }
  | { readonly kind: 'MEMBERSHIP_NOT_FOUND' }
  | { readonly kind: 'MEMBERSHIP_NOT_ACTIVE' }
  | { readonly kind: 'EFFECTIVE_FROM_OUTSIDE_YEAR'; readonly from: BusinessDate; readonly until: BusinessDate }
  | { readonly kind: 'PLAN_OUTSIDE_MEMBERSHIP'; readonly validFrom: BusinessDate; readonly validUntil: BusinessDate | null }
  | { readonly kind: 'PLAN_EXISTS'; readonly economicPlanId: string };

export type VoidPlanOutcome =
  | { readonly kind: 'VOIDED'; readonly plan: PlanView; readonly changed: boolean }
  | { readonly kind: 'NOT_FOUND' }
  | VersionConflict;

/** What the proposal reads in one snapshot (§49.6), or why it cannot propose. */
export type ProposalContext =
  | {
      readonly kind: 'FOUND';
      readonly transactionId: string;
      readonly bookingDate: BusinessDate;
      readonly amount: Money;
      readonly propertyReferenceId: string;
      readonly membershipId: string;
      readonly plan: PlanView;
      readonly financialYearStartMonth: number;
      readonly alreadySplit: boolean;
    }
  | { readonly kind: 'TRANSACTION_NOT_FOUND' }
  | { readonly kind: 'PROPERTY_REFERENCE_NOT_FOUND' }
  | { readonly kind: 'NOT_PROPOSABLE'; readonly direction: string; readonly status: string }
  | { readonly kind: 'NO_UNIT' }
  | { readonly kind: 'NO_MEMBERSHIP'; readonly propertyReferenceId: string; readonly bookingDate: BusinessDate }
  | { readonly kind: 'NO_ECONOMIC_PLAN'; readonly membershipId: string; readonly bookingDate: BusinessDate };

export interface PlanFilter {
  readonly statuses?: readonly PlanStatus[];
  readonly financialYear?: number;
}

/** Persistence port, implemented in infrastructure/postgres. Everything is scoped to the given Realm. */
export interface WegEconomicPlanRepository {
  /** Claims the key, writes the unit (no-op), locks the membership `FOR UPDATE`, checks §49.5's order, inserts. */
  createPlan(plan: NewEconomicPlan, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreatePlanOutcome>;
  findPlan(id: string, mreRealmId: string): Promise<PlanView | undefined>;
  /** The membership's plans, `VOID` included, by `effectiveFrom`, `createdAt`, id; undefined for an unknown membership. */
  listPlans(membershipId: string, mreRealmId: string, filter: PlanFilter, page: PageRequest): Promise<Page<PlanView> | undefined>;
  voidPlan(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidPlanOutcome>;
  /** One `REPEATABLE READ READ ONLY` snapshot of the Transaction, the unit's membership and its plan for the date. */
  proposalContext(transactionId: string, mreRealmId: string, propertyReferenceId: string | null): Promise<ProposalContext>;
}
