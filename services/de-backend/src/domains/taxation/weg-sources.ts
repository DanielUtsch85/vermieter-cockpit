import type { BusinessDate, Money } from '../../shared/index.js';
import { yearOf } from './cash-timing.js';
import { centsOf, divideHalfUp, moneyOfCents } from './cents.js';
import {
  distributionRuleCheck,
  ruleSupersededFlags,
  supersedesCheck,
  treatmentFieldsCheck,
  type AcquisitionFacts,
  type CreateRefusal,
  type NewTaxClassification,
  type TaxClassification,
  type TreatmentSuggestion,
} from './classification.js';
import type { CheckEntryFlag } from './anschaffungsnahe.js';
import type { Distribution, DistributionFlag } from './distribution-82b.js';
import { WEG_SPENDING, type WegSpendingParameters } from './rules/de-weg-spending.js';
import type { RuleRegistry } from './rules/registry.js';
import type { RuleRef, RuleVersion } from './rules/rule-version.js';
import type { Origin, ReviewState, TaxCategory, Treatment, WegSourceType } from './vocabulary.js';

/**
 * What the WEG spends as a source of classification (api-design.md §58B, P7-D5, BFH IX R 19/24): a reserve withdrawal
 * of a statement (a line of its `reserve` section, by `position`) and a use of a Sonderumlage (an element of its
 * `uses`, by `position`). Each counts once, in the tax year of its date, as the user classifies it; the payments into
 * the funds stay `NOT_RELEVANT`. Nothing here writes a statement, an assessment or cash (ADR-006).
 */

/** Why a WEG source, or a classification of it, does not count (§58B), with its details. */
export type WegNotCounted =
  | { readonly reason: 'STATEMENT_NOT_CONFIRMED'; readonly details: { readonly status: string } }
  | { readonly reason: 'STATEMENT_SUPERSEDED'; readonly details: { readonly supersededBy: string | null } }
  | { readonly reason: 'NOT_A_WITHDRAWAL'; readonly details: { readonly kind: string; readonly withdrawal: Money | null } }
  | { readonly reason: 'ASSESSMENT_VOID'; readonly details: Record<string, never> }
  | { readonly reason: 'USE_REMOVED'; readonly details: { readonly position: number } }
  | {
      readonly reason: 'USE_CHANGED';
      readonly details: {
        readonly classified: { readonly date: BusinessDate; readonly unitShare: Money };
        readonly current: { readonly date: BusinessDate; readonly unitShare: Money };
      };
    };

export type DateSource = 'WITHDRAWAL' | 'PERIOD_END' | 'USE';

/** The other source of a `WEG_SPENDING_POSSIBLY_TWICE` pair. */
export interface OtherWegSource {
  readonly sourceType: WegSourceType;
  readonly sourceId: string;
  readonly sourcePosition: number;
}

export type WegSourceFlag =
  | { readonly code: 'WITHDRAWAL_DATE_ASSUMED'; readonly details: { readonly date: BusinessDate; readonly periodUntil: BusinessDate } }
  | {
      readonly code: 'WEG_FINANCIAL_YEAR_NOT_CALENDAR';
      readonly details: {
        readonly financialYear: number;
        readonly financialYearStartMonth: number;
        readonly periodFrom: BusinessDate;
        readonly periodUntil: BusinessDate;
      };
    }
  | { readonly code: 'USES_EXCEED_PAID'; readonly details: { readonly uses: Money; readonly paid: Money } };

export type WegTaxMeaningFlag =
  | { readonly code: 'NOT_COUNTED'; readonly details: { readonly notCountedReason: WegNotCounted['reason'] } & Record<string, unknown> }
  | WegSourceFlag
  | { readonly code: 'PREDECESSOR_CLASSIFIED'; readonly details: { readonly statementId: string; readonly classificationIds: readonly string[] } }
  | { readonly code: 'WEG_SPENDING_POSSIBLY_TWICE'; readonly details: { readonly otherSource: OtherWegSource } }
  | { readonly code: 'RULE_SUPERSEDED'; readonly details: { readonly ruleCode: string; readonly version: number; readonly applicableVersion: number } }
  | DistributionFlag
  | CheckEntryFlag;

/** A withdrawal or a use as tax reads it, independent of any classification. */
export interface WegSourceFacts {
  readonly sourceType: WegSourceType;
  /** The statement's or the assessment's id. */
  readonly sourceId: string;
  readonly sourcePosition: number;
  readonly membershipId: string;
  readonly propertyReferenceId: string;
  readonly description: string;
  /** The unit share; `0.00` for a reserve line without a positive withdrawal. */
  readonly amount: Money;
  readonly date: BusinessDate;
  readonly dateSource: DateSource;
  /** The calendar years an undated withdrawal's `taxYear` may choose (the period's); `null` with an own date. */
  readonly allowedTaxYears: readonly number[] | null;
  /** The WEG's first month of the financial year (§49.1), for `WEG_SPENDING_POSSIBLY_TWICE`. */
  readonly financialYearStartMonth: number;
  readonly notCounted: WegNotCounted | null;
  readonly sourceFlags: readonly WegSourceFlag[];
  /** The direct predecessor's current classifications of withdrawals (a superseding statement's only). */
  readonly predecessor: { readonly statementId: string; readonly classificationIds: readonly string[] } | null;
}

export interface WegTaxMeaning {
  readonly sourceType: WegSourceType;
  readonly sourceId: string;
  readonly sourcePosition: number;
  readonly membershipId: string;
  readonly propertyReferenceId: string;
  readonly date: BusinessDate;
  readonly dateSource: DateSource;
  readonly description: string;
  readonly amount: Money;
  readonly netAmount: Money | null;
  readonly counts: boolean;
  readonly notCountedReason: WegNotCounted['reason'] | null;
  readonly taxYear: number;
  readonly attribution: { readonly rule: null; readonly proposedYear: number; readonly overridden: boolean };
  readonly taxCategory: TaxCategory;
  readonly treatment: Treatment | null;
  readonly reviewState: ReviewState;
  readonly origin: Origin;
  /** `null` only for a default before 2000. */
  readonly rule: RuleRef | null;
  readonly treatmentRule: RuleRef | null;
  readonly classificationId: string | null;
  readonly distribution: Distribution | null;
  readonly suggestion: TreatmentSuggestion | null;
  readonly flags: readonly WegTaxMeaningFlag[];
}

/** A Miteigentumsanteil as the membership stores it (decimals with at most three places). */
export interface MeaFraction {
  readonly numerator: string;
  readonly denominator: string;
}

const thousandths = (part: string): bigint => {
  const [whole, fraction = ''] = part.split('.') as [string, string?];
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
};

/** §51's `unitShare`: the WEG's withdrawal × the MEA (`n/d`), rounded half-up to the cent; exact. */
export function withdrawalUnitShare(withdrawal: Money, mea: MeaFraction): Money {
  return moneyOfCents(divideHalfUp(centsOf(withdrawal) * thousandths(mea.numerator), thousandths(mea.denominator)));
}

/** The rule of the WEG sources applicable on `date`, typed. */
export function wegSpendingOn(registry: RuleRegistry, date: BusinessDate): RuleVersion<WegSpendingParameters> | undefined {
  return registry.select(WEG_SPENDING, date) as RuleVersion<WegSpendingParameters> | undefined;
}

/** A reserve line of the statement at `position`, as the statement and its membership give it. */
export function withdrawalFacts(input: {
  readonly statementId: string;
  readonly status: string;
  readonly supersededBy: string | null;
  readonly financialYear: number;
  readonly periodFrom: BusinessDate;
  readonly periodUntil: BusinessDate;
  readonly financialYearStartMonth: number;
  readonly membershipId: string;
  readonly propertyReferenceId: string;
  readonly mea: MeaFraction;
  readonly line: {
    readonly position: number;
    readonly description: string;
    readonly kind: string;
    readonly withdrawal: Money | null;
    readonly date: BusinessDate | null;
  };
  readonly predecessor: { readonly statementId: string; readonly classificationIds: readonly string[] } | null;
}): WegSourceFacts {
  const { line } = input;
  const amount = line.withdrawal !== null && line.withdrawal.isPositive() ? withdrawalUnitShare(line.withdrawal, input.mea) : moneyOfCents(0n);
  const notCounted: WegNotCounted | null =
    line.kind !== 'WITHDRAWAL' || !amount.isPositive()
      ? { reason: 'NOT_A_WITHDRAWAL', details: { kind: line.kind, withdrawal: line.withdrawal } }
      : input.status === 'SUPERSEDED'
        ? { reason: 'STATEMENT_SUPERSEDED', details: { supersededBy: input.supersededBy } }
        : input.status !== 'CONFIRMED'
          ? { reason: 'STATEMENT_NOT_CONFIRMED', details: { status: input.status } }
          : null;
  const date = line.date ?? input.periodUntil;
  const sourceFlags: WegSourceFlag[] = [];
  if (line.date === null) {
    // The assumption is never silent (P7-D5), and the end of a financial year that is not the calendar year may lie
    // in either calendar year the period touches; a short period inside a calendar financial year is no reason.
    sourceFlags.push({ code: 'WITHDRAWAL_DATE_ASSUMED', details: { date, periodUntil: input.periodUntil } });
    if (input.financialYearStartMonth !== 1) {
      sourceFlags.push({
        code: 'WEG_FINANCIAL_YEAR_NOT_CALENDAR',
        details: {
          financialYear: input.financialYear,
          financialYearStartMonth: input.financialYearStartMonth,
          periodFrom: input.periodFrom,
          periodUntil: input.periodUntil,
        },
      });
    }
  }
  return {
    sourceType: 'WEG_RESERVE_WITHDRAWAL',
    sourceId: input.statementId,
    sourcePosition: line.position,
    membershipId: input.membershipId,
    propertyReferenceId: input.propertyReferenceId,
    description: line.description,
    amount,
    date,
    dateSource: line.date === null ? 'PERIOD_END' : 'WITHDRAWAL',
    allowedTaxYears: line.date === null ? [...new Set([yearOf(input.periodFrom), yearOf(input.periodUntil)])] : null,
    financialYearStartMonth: input.financialYearStartMonth,
    notCounted,
    sourceFlags,
    predecessor: input.predecessor,
  };
}

/** A use of the assessment at `position`: it exists (a removed one has no meaning, §58B). */
export function useFacts(input: {
  readonly assessmentId: string;
  readonly storedStatus: string;
  readonly membershipId: string;
  readonly propertyReferenceId: string;
  readonly financialYearStartMonth: number;
  readonly use: { readonly position: number; readonly date: BusinessDate; readonly description: string; readonly unitShare: Money };
  /** The assessment's `USES_EXCEED_PAID` (§51A), carried onto each use, informative. */
  readonly usesExceedPaid: { readonly uses: Money; readonly paid: Money } | null;
}): WegSourceFacts {
  return {
    sourceType: 'WEG_ASSESSMENT_USE',
    sourceId: input.assessmentId,
    sourcePosition: input.use.position,
    membershipId: input.membershipId,
    propertyReferenceId: input.propertyReferenceId,
    description: input.use.description,
    amount: input.use.unitShare,
    date: input.use.date,
    dateSource: 'USE',
    allowedTaxYears: null,
    financialYearStartMonth: input.financialYearStartMonth,
    notCounted: input.storedStatus === 'VOID' ? { reason: 'ASSESSMENT_VOID', details: {} } : null,
    sourceFlags: input.usesExceedPaid === null ? [] : [{ code: 'USES_EXCEED_PAID', details: input.usesExceedPaid }],
    predecessor: null,
  };
}

/**
 * Why the source, or the classification of it, does not count; `null` when it counts. A use's classification
 * counts only while the use at its position has the classified date and unit share (`USE_CHANGED`); a changed
 * description alone changes nothing.
 */
export function wegNotCounted(facts: WegSourceFacts, classification: Pick<TaxClassification, 'assessmentUse'> | null): WegNotCounted | null {
  if (facts.notCounted !== null) return facts.notCounted;
  const classified = classification?.assessmentUse ?? null;
  if (facts.sourceType === 'WEG_ASSESSMENT_USE' && classified !== null) {
    if (classified.date !== facts.date || !classified.unitShare.equals(facts.amount)) {
      return { reason: 'USE_CHANGED', details: { classified, current: { date: facts.date, unitShare: facts.amount } } };
    }
  }
  return null;
}

/**
 * The tax meaning of a WEG source (§58B): its current classification, else the default of `DE_WEG_SPENDING`
 * (`UNCLASSIFIED`, no treatment, `NEEDS_REVIEW`) on its date. The § 82b parts and the check's flags are added by
 * `withTreatmentEffects`; `possiblyTwice` names the other sources of `WEG_SPENDING_POSSIBLY_TWICE`.
 */
export function deriveWegTaxMeaning(
  facts: WegSourceFacts,
  classification: TaxClassification | null,
  registry: RuleRegistry,
  today: BusinessDate,
  possiblyTwice: readonly OtherWegSource[] = [],
): WegTaxMeaning {
  const notCounted = wegNotCounted(facts, classification);
  const flags: WegTaxMeaningFlag[] = [];
  if (notCounted !== null) flags.push({ code: 'NOT_COUNTED', details: { notCountedReason: notCounted.reason, ...notCounted.details } });
  flags.push(...facts.sourceFlags);
  if (classification === null && facts.predecessor !== null && facts.predecessor.classificationIds.length > 0) {
    flags.push({
      code: 'PREDECESSOR_CLASSIFIED',
      details: { statementId: facts.predecessor.statementId, classificationIds: [...facts.predecessor.classificationIds].sort() },
    });
  }
  for (const otherSource of possiblyTwice) flags.push({ code: 'WEG_SPENDING_POSSIBLY_TWICE', details: { otherSource } });
  const proposedYear = yearOf(facts.date);
  const override = classification?.taxYear ?? null;
  const base = {
    sourceType: facts.sourceType,
    sourceId: facts.sourceId,
    sourcePosition: facts.sourcePosition,
    membershipId: facts.membershipId,
    propertyReferenceId: facts.propertyReferenceId,
    date: facts.date,
    dateSource: facts.dateSource,
    description: facts.description,
    amount: facts.amount,
    counts: notCounted === null,
    notCountedReason: notCounted?.reason ?? null,
    // No 10-day rule: § 11 Abs. 2 S. 2 EStG is about regularly recurring payments; the owner pays nothing here.
    taxYear: override ?? proposedYear,
    attribution: { rule: null, proposedYear, overridden: override !== null },
    distribution: null,
    suggestion: null,
  } as const;
  if (classification !== null) {
    flags.push(...ruleSupersededFlags(registry, today, [classification.rule, classification.treatmentRule]));
    return {
      ...base,
      netAmount: classification.netAmount,
      taxCategory: classification.taxCategory,
      treatment: classification.treatment,
      reviewState: classification.reviewState,
      origin: 'CLASSIFICATION',
      rule: classification.rule,
      treatmentRule: classification.treatmentRule,
      classificationId: classification.id,
      flags,
    };
  }
  const rule = wegSpendingOn(registry, facts.date);
  const meaning = rule?.parameters.default ?? { taxCategory: 'UNCLASSIFIED', treatment: null, reviewState: 'NEEDS_REVIEW' };
  return {
    ...base,
    netAmount: null,
    ...meaning,
    origin: 'DEFAULT',
    rule: rule === undefined ? null : { ruleCode: rule.ruleCode, version: rule.version },
    treatmentRule: null,
    classificationId: null,
    flags,
  };
}

/**
 * The checks of a create of a WEG source after it was found (§58B, in order): `taxYear` on a withdrawal with its own
 * date (`400 NOT_SUPPORTED`), the source counts, `DE_WEG_SPENDING` applies on its date (then `DE_82B_DISTRIBUTION` for
 * an election), the line and treatment are the WEG sources' (`TREATMENT_NOT_ALLOWED`), the election, the net amount,
 * the Acquisition named, an undated withdrawal's `taxYear` within its period's years, `supersedes`. Returns the rules
 * and what the classification stores of its source.
 */
export function planWegClassification(
  facts: WegSourceFacts,
  currentId: string | null,
  request: Pick<
    NewTaxClassification,
    'taxCategory' | 'treatment' | 'supersedes' | 'taxYear' | 'netAmount' | 'mostlyResidentialConfirmed' | 'anschaffungsnaheAcquisitionId'
  >,
  registry: RuleRegistry,
  acquisition?: AcquisitionFacts | null,
):
  | {
      readonly kind: 'CLASSIFY';
      readonly rule: RuleRef;
      readonly treatmentRule: RuleRef | null;
      readonly reserveWithdrawal: { readonly unitShare: Money } | null;
      readonly assessmentUse: { readonly date: BusinessDate; readonly unitShare: Money } | null;
    }
  | CreateRefusal {
  const taxYear = request.taxYear ?? null;
  if (taxYear !== null && facts.allowedTaxYears === null) return { kind: 'FIELD_NOT_SUPPORTED', field: 'taxYear' };
  const notCounted = wegNotCounted(facts, null);
  if (notCounted !== null) return { kind: 'WEG_SOURCE_NOT_COUNTED', sourceType: facts.sourceType, ...notCounted };
  const rule = wegSpendingOn(registry, facts.date);
  if (rule === undefined) return { kind: 'NO_APPLICABLE_RULE', ruleCode: WEG_SPENDING, date: facts.date };
  const source = { date: facts.date, direction: 'OUTFLOW', grossAmount: facts.amount, propertyReferenceId: facts.propertyReferenceId } as const;
  const distribution = distributionRuleCheck(source, request.treatment, registry);
  if (distribution !== undefined && 'kind' in distribution) return distribution;
  const lines = rule.parameters.lines;
  const allowedForLine = lines[request.taxCategory];
  if (allowedForLine === undefined || request.treatment === null || !allowedForLine.includes(request.treatment)) {
    return {
      kind: 'TREATMENT_NOT_ALLOWED',
      categoryType: null,
      sourceType: facts.sourceType,
      allowed: [...new Set(Object.values(lines).flat())] as Treatment[],
      taxCategories: Object.keys(lines) as TaxCategory[],
    };
  }
  const fields = treatmentFieldsCheck(source, request, distribution?.rule ?? null, acquisition, registry);
  if ('kind' in fields) return fields;
  if (taxYear !== null && !(facts.allowedTaxYears ?? []).includes(taxYear)) {
    return { kind: 'WITHDRAWAL_TAX_YEAR_OUT_OF_RANGE', taxYear, allowedYears: facts.allowedTaxYears ?? [] };
  }
  return (
    supersedesCheck(currentId, request.supersedes) ?? {
      kind: 'CLASSIFY',
      rule: { ruleCode: rule.ruleCode, version: rule.version },
      treatmentRule: fields.treatmentRule,
      reserveWithdrawal: facts.sourceType === 'WEG_RESERVE_WITHDRAWAL' ? { unitShare: facts.amount } : null,
      assessmentUse: facts.sourceType === 'WEG_ASSESSMENT_USE' ? { date: facts.date, unitShare: facts.amount } : null,
    }
  );
}

/** The financial year a date falls in, for a WEG whose year starts in `startMonth` (§49.1). */
export const financialYearOf = (date: BusinessDate, startMonth: number) => yearOf(date) - (Number(date.slice(5, 7)) < startMonth ? 1 : 0);

/**
 * `WEG_SPENDING_POSSIBLY_TWICE` (§58B, open question 4): a withdrawal and a use of the same membership with the same
 * unit share whose dates fall in the same financial year. Not detectable with certainty, so both are only flagged;
 * the user classifies one `NOT_RELEVANT`. Returns, by `sourceType/sourceId/position`, the other sources.
 */
export function possiblyTwice(sources: readonly WegSourceFacts[]): Map<string, OtherWegSource[]> {
  const found = new Map<string, OtherWegSource[]>();
  const counting = sources.filter((s) => s.notCounted === null);
  const withdrawals = counting.filter((s) => s.sourceType === 'WEG_RESERVE_WITHDRAWAL');
  const uses = counting.filter((s) => s.sourceType === 'WEG_ASSESSMENT_USE');
  const add = (of: WegSourceFacts, other: WegSourceFacts) => {
    const key = wegSourceKey(of);
    found.set(key, [...(found.get(key) ?? []), { sourceType: other.sourceType, sourceId: other.sourceId, sourcePosition: other.sourcePosition }]);
  };
  for (const w of withdrawals) {
    for (const u of uses) {
      if (
        w.membershipId === u.membershipId &&
        w.amount.equals(u.amount) &&
        financialYearOf(w.date, w.financialYearStartMonth) === financialYearOf(u.date, u.financialYearStartMonth)
      ) {
        add(w, u);
        add(u, w);
      }
    }
  }
  return found;
}

export const wegSourceKey = (s: { readonly sourceType: string; readonly sourceId: string; readonly sourcePosition: number | null }) =>
  `${s.sourceType}/${s.sourceId}/${s.sourcePosition ?? ''}`;
