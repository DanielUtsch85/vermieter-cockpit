import { centsOf, divideHalfUp, moneyOfCents, type BusinessDate, type Money } from '../../shared/index.js';
import { partInWindow, type Performance } from './performance.js';

/**
 * The partial treatment of a source straddling the anschaffungsnahe window (api-design.md §59F "As implemented (VC-X-38
 * Part 2)"; Entscheidung des Projektinhabers, 2026-11-02, 239-2): one classification, two parts, as the parts of §59D.
 * The part performed in the window is `CAPITALIZED` on the check, the rest `DEDUCTIBLE`. The amounts come from the
 * evidenced progress points only: an estimated point is ignored (239-1), and nothing is spread by calendar days. No cash
 * correction: the source's amount, its cash year and its owners stay as they are.
 */

export interface TreatmentPart {
  /** 1 the part in the window, 2 the rest. */
  readonly position: 1 | 2;
  readonly treatment: 'CAPITALIZED' | 'DEDUCTIBLE';
  /** Of the source's amount (the split's amount, the withdrawal's or use's unit share), unsigned; > 0. */
  readonly amount: Money;
}

/** Why the evidenced points do not determine a partial treatment (`422 ANSCHAFFUNGSNAHE_NOT_APPLICABLE`). */
export type PartialTreatmentRefusal =
  /** The performance lies wholly in the window: it is capitalised whole, not in parts. */
  | { readonly cause: 'NOT_STRADDLING' }
  /** The evidenced points around an edge leave the part in the window open (`lower` < `upper`); it is never estimated. */
  | { readonly cause: 'SPLIT_NOT_EVIDENCED'; readonly lower: Money; readonly upper: Money };

/**
 * The two parts of `amount` for a performance straddling `window`, or why there are none. `amountUsed` is the amount
 * the points are stated in (`netAmount`, else the gross amount, §58B). The part in the window is exact only when an
 * evidenced point (or the period's own start or end) lies on each straddled edge. With a net amount the gross part in
 * the window is `amount × inWindow / amountUsed`, half-up to the cent (`grossWindowPart` `PRO_RATA_HALF_UP`); the rest is
 * `amount` less it, so the parts sum to `amount` exactly. Both parts are > 0: the window part is > 0 and below the amount
 * used (the points ascend strictly and lie below it), and the amount used is at most the gross amount.
 */
export function partialTreatmentParts(
  performance: Performance,
  amount: Money,
  amountUsed: Money,
  window: { readonly from: BusinessDate; readonly until: BusinessDate },
): { readonly parts: readonly TreatmentPart[] } | PartialTreatmentRefusal {
  if (performance.from >= window.from && performance.until <= window.until) return { cause: 'NOT_STRADDLING' };
  const used = centsOf(amountUsed);
  const { lower, upper } = partInWindow(performance, used, window);
  if (lower !== upper || lower <= 0n || lower >= used) {
    return { cause: 'SPLIT_NOT_EVIDENCED', lower: moneyOfCents(lower, amount.currency), upper: moneyOfCents(upper, amount.currency) };
  }
  const gross = centsOf(amount);
  const capitalized = used === gross ? lower : divideHalfUp(gross * lower, used);
  return {
    parts: [
      { position: 1, treatment: 'CAPITALIZED', amount: moneyOfCents(capitalized, amount.currency) },
      { position: 2, treatment: 'DEDUCTIBLE', amount: moneyOfCents(gross - capitalized, amount.currency) },
    ],
  };
}

/** The parts as the API, the AuditRecord and the view show them. */
export const treatmentPartsJson = (parts: readonly TreatmentPart[]) =>
  parts.map((p) => ({ position: p.position, treatment: p.treatment, amount: p.amount.toJSON() }));

/** The amount of the part with `treatment`, or `undefined` (no partial treatment). */
export const partAmountOf = (parts: readonly TreatmentPart[] | null | undefined, treatment: TreatmentPart['treatment']): Money | undefined =>
  parts?.find((p) => p.treatment === treatment)?.amount;
