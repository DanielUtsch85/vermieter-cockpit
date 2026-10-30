import type { Money } from '../../shared/index.js';
import type { CheckEntryFlag } from './anschaffungsnahe.js';
import type { TaxClassification, TreatmentSuggestion } from './classification.js';
import { distribute, type Distribution, type DistributionFlag, type DistributionOwnership } from './distribution-82b.js';

/**
 * The derived effects of a meaning's treatment (api-design.md §58B): the § 82b parts of an election, and the
 * anschaffungsnahe check's flags and suggestion. Both are derived on read and change nothing: `treatment`,
 * `reviewState` and `origin` stay as they are (P7-D8).
 */

/** The parts of a `DISTRIBUTED_82B` classification, from the gross amount and the source's tax year; else `null`. */
export function distributionOf(
  classification: Pick<TaxClassification, 'treatment' | 'distributionYears' | 'treatmentRule'> | null,
  amount: Money,
  firstYear: number,
  ownerships: readonly DistributionOwnership[],
): { readonly distribution: Distribution; readonly flags: readonly DistributionFlag[] } | null {
  if (classification === null || classification.treatment !== 'DISTRIBUTED_82B') return null;
  if (classification.distributionYears === null || classification.treatmentRule === null) return null;
  return distribute({ amount, firstYear, years: classification.distributionYears, rule: classification.treatmentRule, ownerships });
}

/** The meaning with its parts and the check's flags and suggestion. */
export function withTreatmentEffects<
  M extends { readonly flags: readonly unknown[]; readonly distribution: Distribution | null; readonly suggestion: TreatmentSuggestion | null },
>(
  meaning: M,
  distribution: { readonly distribution: Distribution; readonly flags: readonly DistributionFlag[] } | null,
  check: { readonly flags: readonly CheckEntryFlag[]; readonly suggestion: TreatmentSuggestion | null },
): M {
  return {
    ...meaning,
    distribution: distribution?.distribution ?? null,
    suggestion: check.suggestion,
    flags: [...meaning.flags, ...(distribution?.flags ?? []), ...check.flags],
  };
}
