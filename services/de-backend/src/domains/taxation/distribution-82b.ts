import type { BusinessDate, Money } from '../../shared/index.js';
import { yearOf } from './cash-timing.js';
import { centsOf, moneyOfCents } from './cents.js';
import { DISTRIBUTION_82B, type Distribution82bParameters } from './rules/de-82b-distribution.js';
import type { RuleRegistry } from './rules/registry.js';
import type { RuleRef, RuleVersion } from './rules/rule-version.js';

/**
 * The § 82b EStDV election and its parts (api-design.md §58B, P7-D6, checklist A5): derived on read, never stored, from
 * the gross amount, the first year (the source's tax year) and the number of years; the end of ownership folds the
 * rest into the year it ends (§ 82b Abs. 2). A building contributed to business assets, or no longer let, is not
 * recognised (DE knows neither): the parts then run on as derived until the user reclassifies the source.
 */

export interface DistributionPart {
  readonly year: number;
  readonly amount: Money;
}

export interface Distribution {
  readonly years: number;
  readonly firstYear: number;
  /** The effective parts, after any fold; they sum to the gross amount exactly. */
  readonly parts: readonly DistributionPart[];
  /** The year the rest was folded into; `null` without a fold. */
  readonly endYear: number | null;
  readonly rule: RuleRef;
}

/** An Ownership of the source's PropertyReference, `VALID` and valid on the source's date (§26.1). */
export interface DistributionOwnership {
  readonly id: string;
  readonly validUntil: BusinessDate | null;
}

export type DistributionFlag =
  | {
      readonly code: 'DISTRIBUTION_ENDED';
      readonly details: { readonly endYear: number; readonly ownershipIds: readonly string[]; readonly foldedYears: readonly number[] };
    }
  | { readonly code: 'OWNERSHIP_PARTLY_ENDED'; readonly details: { readonly ownershipIds: readonly string[] } };

/** The § 82b rule applicable on `date`, typed. */
export function distributionRuleOn(registry: RuleRegistry, date: BusinessDate): RuleVersion<Distribution82bParameters> | undefined {
  return registry.select(DISTRIBUTION_82B, date) as RuleVersion<Distribution82bParameters> | undefined;
}

/**
 * The parts of `amount` over `years` from `firstYear`: every part but the last is amount / years rounded down to the
 * cent, the last takes the rest (fewer than `years` cents more), so they sum to the amount exactly. When every owner
 * concerned has a `validUntil` and the latest lies before the last year, the parts after that year fall into it
 * (`DISTRIBUTION_ENDED`); when only some end within the distribution, the parts stay (`OWNERSHIP_PARTLY_ENDED`; the
 * per-owner fold is VC-7-04's).
 */
export function distribute(input: {
  readonly amount: Money;
  readonly firstYear: number;
  readonly years: number;
  readonly rule: RuleRef;
  readonly ownerships: readonly DistributionOwnership[];
}): { readonly distribution: Distribution; readonly flags: readonly DistributionFlag[] } {
  const total = centsOf(input.amount);
  const n = BigInt(input.years);
  // Rounded down to the cent (towards zero for a positive amount); the remainder goes to the last year.
  const each = total / n;
  const lastYear = input.firstYear + input.years - 1;
  const raw = Array.from({ length: input.years }, (_, i) => ({
    year: input.firstYear + i,
    cents: i === input.years - 1 ? total - each * (n - 1n) : each,
  }));
  const flags: DistributionFlag[] = [];
  let endYear: number | null = null;
  let parts = raw;
  const owners = input.ownerships;
  const ending = owners.filter((o) => o.validUntil !== null && yearOf(o.validUntil) < lastYear);
  if (owners.length > 0 && owners.every((o) => o.validUntil !== null)) {
    // An owner valid on the source's date ends on or after it; an override of the first year (± 1) may still lie
    // after that year: the fold then never moves a part before the first year.
    const latest = Math.max(input.firstYear, ...owners.map((o) => yearOf(o.validUntil as BusinessDate)));
    if (latest < lastYear) {
      endYear = latest;
      const kept = raw.filter((p) => p.year < latest);
      const folded = raw.filter((p) => p.year >= latest).reduce((sum, p) => sum + p.cents, 0n);
      parts = [...kept, { year: latest, cents: folded }];
      flags.push({
        code: 'DISTRIBUTION_ENDED',
        details: {
          endYear: latest,
          ownershipIds: owners.map((o) => o.id).sort(),
          foldedYears: raw.filter((p) => p.year > latest).map((p) => p.year),
        },
      });
    }
  } else if (ending.length > 0) {
    flags.push({ code: 'OWNERSHIP_PARTLY_ENDED', details: { ownershipIds: ending.map((o) => o.id).sort() } });
  }
  return {
    distribution: {
      years: input.years,
      firstYear: input.firstYear,
      parts: parts.map((p) => ({ year: p.year, amount: moneyOfCents(p.cents, input.amount.currency) })),
      endYear,
      rule: input.rule,
    },
    flags,
  };
}

/** The part of `year`, or undefined when the distribution has none. */
export const partOf = (distribution: Distribution, year: number): Money | undefined => distribution.parts.find((p) => p.year === year)?.amount;
