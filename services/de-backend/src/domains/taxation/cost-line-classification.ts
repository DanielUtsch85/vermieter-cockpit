import type { BusinessDate, Money, RuleRef, RuleRegistry, RuleVersion } from '../../shared/index.js';
import type { CostLineGroup } from './anschaffungsnahe-hausgeld.js';
import { supersedesCheck, treatmentFieldsCheck, type CreateRefusal, type TreatmentRequest } from './classification-checks.js';
import { ANSCHAFFUNGSNAHE, type AnschaffungsnaheParameters } from './rules/de-anschaffungsnahe.js';
import type { NewTaxClassification } from './tax-classification.js';
import type { Treatment, TaxCategory } from './vocabulary.js';
import type { WegNotCounted } from './weg-sources.js';

/**
 * The classification of a WEG statement cost line (api-design.md §58M, VC-X-27; Entscheidung des Projektinhabers,
 * 2026-11-04, M1, M2, M8): a check-only fact. A person judges a `NON_RECOVERABLE` line of a `CONFIRMED` statement as
 * maintenance (`MAINTENANCE`/`DEDUCTIBLE`, with `netAmount`, `annuallyRecurring` and `performance`) or as not maintenance
 * for the 15 % check (`NOT_RELEVANT`); the rule is `DE_ANSCHAFFUNGSNAHE` on the statement's `periodUntil`. It never
 * says anything about the deductibility of the Hausgeld, which `WEG_HAUSGELD` decides.
 */

/** A cost line as a classification reads it, with its statement. */
export interface CostLineFacts {
  readonly statementId: string;
  readonly status: string;
  readonly supersededBy: string | null;
  readonly periodFrom: BusinessDate;
  readonly periodUntil: BusinessDate;
  readonly propertyReferenceId: string;
  readonly position: number;
  readonly account: string;
  readonly classification: CostLineGroup;
  /** The printed unit share, signed. */
  readonly unitShare: Money;
}

const JUDGED_WITHOUT_RULE: readonly CostLineGroup[] = ['NON_RECOVERABLE'];

/** The rule of a cost line: `DE_ANSCHAFFUNGSNAHE` on the statement's `periodUntil`, when it has `hausgeldMaintenance`. */
export function costLineRuleOn(registry: RuleRegistry, date: BusinessDate): RuleVersion<AnschaffungsnaheParameters> | undefined {
  const rule = registry.select(ANSCHAFFUNGSNAHE, date) as RuleVersion<AnschaffungsnaheParameters> | undefined;
  return rule?.parameters.hausgeldMaintenance === undefined ? undefined : rule;
}

/**
 * Why a cost line, or a classification of it, does not count (§58M); `null` when it counts. The line first (as a reserve
 * line's `NOT_A_WITHDRAWAL`, §58B), then the statement: a `RECOVERABLE` or `RESERVE` line, or one of 0.00, is never judged.
 */
export function costLineNotCounted(facts: CostLineFacts, judgedLines: readonly CostLineGroup[] = JUDGED_WITHOUT_RULE): WegNotCounted | null {
  if (!judgedLines.includes(facts.classification) || facts.unitShare.isZero()) {
    return { reason: 'COST_LINE_NOT_NON_RECOVERABLE', details: { classification: facts.classification, unitShare: facts.unitShare } };
  }
  if (facts.status === 'SUPERSEDED') return { reason: 'STATEMENT_SUPERSEDED', details: { supersededBy: facts.supersededBy } };
  if (facts.status !== 'CONFIRMED') return { reason: 'STATEMENT_NOT_CONFIRMED', details: { status: facts.status } };
  return null;
}

/**
 * The checks of a create of a cost line after it was found (§58M, in §58B's order): the line and its statement count,
 * the rule applies on `periodUntil` (`NO_APPLICABLE_RULE`), the line and treatment are the rule's (`TREATMENT_NOT_ALLOWED`),
 * the net amount (against the unit share's absolute value), the performance (plausible around `periodUntil`), `supersedes`.
 * The fields a cost line never takes are refused by the API (`400 NOT_ALLOWED_WITH_TREATMENT`).
 */
export function planCostLineClassification(
  facts: CostLineFacts,
  currentId: string | null,
  request: Pick<NewTaxClassification, 'taxCategory' | 'treatment' | 'supersedes'> & Partial<TreatmentRequest>,
  registry: RuleRegistry,
): { readonly kind: 'CLASSIFY'; readonly rule: RuleRef; readonly costLine: { readonly unitShare: Money } } | CreateRefusal {
  const rule = costLineRuleOn(registry, facts.periodUntil);
  const q = rule?.parameters.hausgeldMaintenance;
  const notCounted = costLineNotCounted(facts, q?.judgedLines);
  if (notCounted !== null) return { kind: 'WEG_SOURCE_NOT_COUNTED', sourceType: 'WEG_STATEMENT_COST_LINE', ...notCounted };
  if (rule === undefined || q === undefined) return { kind: 'NO_APPLICABLE_RULE', ruleCode: ANSCHAFFUNGSNAHE, date: facts.periodUntil };
  if (!q.lines.some((l) => l.taxCategory === request.taxCategory && l.treatment === request.treatment)) {
    return {
      kind: 'TREATMENT_NOT_ALLOWED',
      categoryType: null,
      sourceType: 'WEG_STATEMENT_COST_LINE',
      allowed: [...new Set(q.lines.map((l) => l.treatment))] as Treatment[],
      taxCategories: [...new Set(q.lines.map((l) => l.taxCategory))] as TaxCategory[],
    };
  }
  const negative = facts.unitShare.isNegative();
  const source = {
    date: facts.periodUntil,
    direction: negative ? 'INFLOW' : 'OUTFLOW',
    grossAmount: negative ? facts.unitShare.negate() : facts.unitShare,
    propertyReferenceId: facts.propertyReferenceId,
  } as const;
  const fields = treatmentFieldsCheck(source, { ...request, anschaffungsnaheAcquisitionId: null }, null, undefined, registry);
  if ('kind' in fields) return fields;
  return (
    supersedesCheck(currentId, request.supersedes) ?? {
      kind: 'CLASSIFY',
      rule: { ruleCode: rule.ruleCode, version: rule.version },
      costLine: { unitShare: facts.unitShare },
    }
  );
}
