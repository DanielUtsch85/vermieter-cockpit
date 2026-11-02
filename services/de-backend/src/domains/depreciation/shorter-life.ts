import type { BusinessDate } from '../../shared/index.js';
import { isConfirmed, type ShorterUsefulLife } from './asset.js';
import { monthLabel, monthOf, yearOfDate } from './exact.js';
import type { ShorterUsefulLifeParameters } from './rules/de-afa-building-linear.js';
import type { Flag } from './schedule-model.js';

/**
 * From when a confirmed shorter useful life applies (api-design.md §59G, VC-X-41; Prüfbericht 2026-11-01, Frage 8; the
 * owner's decisions of 2026-11-02). Judged per purchase component on the entry's **valuation date** (Bewertungsstichtag),
 * never on the document's date:
 *
 * - no valuation date (an entry from before migration 0056): not computed in any year (`USEFUL_LIFE_VALUATION_DATE_MISSING`);
 * - its year before the contract year: not the buyer's remaining life (`USEFUL_LIFE_EVIDENCE_BEFORE_PURCHASE`; open
 *   question 5, Entscheidung des Projektinhabers, 2026-11-02: stays not computable);
 * - its year not after the component's first year: `1/n` from the start (`FROM_START`), the figures of before VC-X-41;
 * - its year after the first year (`FROM_EVIDENCE_YEAR`): the band's rate before the switch month `S` and, when shorter,
 *   the carried-forward residual value spread from `S` through the last month `L` (Part 2, `residual-value.ts`); with
 *   the rule's `fromEvidenceYear: NOT_COMPUTABLE` (Part 1's guard) not computed from its year.
 *
 * Shorter, for a late evidence (open question 4, Entscheidung des Projektinhabers, 2026-11-02): the useful life from the
 * component's first year, `(YE − Y1) + n`, below the band's `shorterThanYears` of the version selected for `YE`
 * (§ 7 Abs. 4 S. 2 EStG compares the building's actual useful life, which for a buyer runs from the purchase).
 *
 * An entry not confirmed, or a component without a start, is not judged here (`USEFUL_LIFE_NOT_CONFIRMED` and
 * `TRANSFER_DATE_MISSING` stop it already).
 */

export const SHORTER_LIFE_BLOCKING_REASONS = ['USEFUL_LIFE_VALUATION_DATE_MISSING', 'USEFUL_LIFE_EVIDENCE_BEFORE_PURCHASE'] as const;
export const isShorterLifeBlockingReason = (code: string) => (SHORTER_LIFE_BLOCKING_REASONS as readonly string[]).includes(code);

export type ShorterLifeCase =
  | { readonly kind: 'NOT_JUDGED' }
  | { readonly kind: 'BLOCKED'; readonly reason: Flag }
  | { readonly kind: 'FROM_START'; readonly entry: ShorterUsefulLife; readonly firstYear: number }
  | {
      readonly kind: 'FROM_EVIDENCE_YEAR';
      readonly entry: ShorterUsefulLife;
      readonly firstYear: number;
      readonly fromYear: number;
      /** The switch month `S`: January of `YE` (`FROM_JANUARY`), or the Stichtag's month (`FROM_VALUATION_MONTH`). */
      readonly switchMonth: number;
      /** The last month `L`: `S + 12·n − 1` (December of `YE + n − 1` under `FROM_JANUARY`). */
      readonly lastMonth: number;
      readonly shorter: boolean;
      readonly shorterThanYears: number | null;
      /** `(YE − Y1) + n`: the useful life from the component's first year, judged against `shorterThanYears`. */
      readonly yearsFromFirstYear: number;
      /** What the release lacks on the entry itself (`lateEvidenceRelease`, without the per-owner `DECLARED_AFA`); `[]` when released. */
      readonly releaseMissing: readonly string[];
      /** Part 2 (`RESIDUAL_OVER_REMAINING_LIFE`) or Part 1's guard (`NOT_COMPUTABLE`). */
      readonly fromEvidenceYear: ShorterUsefulLifeParameters['fromEvidenceYear'];
    };

/**
 * What the release of a late evidence lacks on the entry for the rule's `lateEvidenceRelease`, in this order; `[]` when
 * released. The evidence is the entry's own `evidence.documentReference` alone (`ENTRY_DOCUMENT_REFERENCE`): the asset's
 * `sourceReferences` name no dated evidence and do not count (§59G; Entscheidung des Projektinhabers, 2026-11-02, 238-3).
 * The declared AfA is per owner (`declaredAfaMissing`), so it follows these.
 */
export function releaseMissing(entry: ShorterUsefulLife, release: ShorterUsefulLifeParameters['lateEvidenceRelease']): string[] {
  const missing: string[] = [];
  if (entry.reviewState !== release.reviewState) missing.push(release.reviewState);
  if (release.evidence === 'ENTRY_DOCUMENT_REFERENCE' && entry.evidence.documentReference === null) missing.push('EVIDENCE');
  if (release.releaseNote && entry.releaseNote === null) missing.push('RELEASE_NOTE');
  return missing;
}

/**
 * §59G Part 2 (Entscheidung des Projektinhabers, 2026-11-02, open question 11): an owner's declared AfA through `YE − 1`,
 * or `undefined` when none is recorded for the owner. One declared through another year is counted as none (#250's
 * reading): it does not state the AfA behind the residual value at the switch.
 */
export const declaredAfaOf = (entry: ShorterUsefulLife, partyId: string, fromYear: number) =>
  entry.declaredAfa.find((r) => r.partyId === partyId && r.throughYear === fromYear - 1);

export function shorterLifeCaseOf(c: {
  readonly entry: ShorterUsefulLife | undefined;
  readonly contractDate: BusinessDate;
  /** The year of the component's first month; `null` without a start. */
  readonly firstYear: number | null;
  /** Of the version of the component's first year, else the latest; `undefined` without any version. */
  readonly parameters: ShorterUsefulLifeParameters | undefined;
  /** The band's `shorterThanYears` in the version selected for `year`; `null` when it cannot be read. */
  readonly thresholdOf: (year: number) => number | null;
}): ShorterLifeCase {
  const { entry, parameters } = c;
  if (entry === undefined || !isConfirmed(entry.reviewState) || parameters === undefined) return { kind: 'NOT_JUDGED' };
  const valuationDate = entry.evidence.valuationDate;
  const evidenceDate = entry.evidence.date;
  if (valuationDate === null) {
    return { kind: 'BLOCKED', reason: { code: 'USEFUL_LIFE_VALUATION_DATE_MISSING', details: { acquisitionId: entry.acquisitionId, evidenceDate } } };
  }
  const evidenceYear = yearOfDate(valuationDate);
  if (evidenceYear < yearOfDate(c.contractDate)) {
    return {
      kind: 'BLOCKED',
      reason: {
        code: 'USEFUL_LIFE_EVIDENCE_BEFORE_PURCHASE',
        details: { acquisitionId: entry.acquisitionId, evidenceDate, valuationDate, contractDate: c.contractDate },
      },
    };
  }
  if (c.firstYear === null) return { kind: 'NOT_JUDGED' };
  if (evidenceYear <= c.firstYear) return { kind: 'FROM_START', entry, firstYear: c.firstYear };
  const shorterThanYears = c.thresholdOf(evidenceYear);
  const n = entry.usefulLifeYears;
  // Open question 4: the useful life from the first year (`thresholdYears: FROM_FIRST_YEAR`), never `n` alone.
  const yearsFromFirstYear = evidenceYear - c.firstYear + n;
  const switchMonth = parameters.evidenceYearCounts === 'FROM_VALUATION_MONTH' ? monthOf(valuationDate) : evidenceYear * 12;
  return {
    kind: 'FROM_EVIDENCE_YEAR',
    entry,
    firstYear: c.firstYear,
    fromYear: evidenceYear,
    switchMonth,
    lastMonth: switchMonth + 12 * n - 1,
    // A threshold that cannot be read is never taken as "not shorter": the years from the evidence stay not computed.
    shorter: shorterThanYears === null || yearsFromFirstYear < shorterThanYears,
    shorterThanYears,
    yearsFromFirstYear,
    releaseMissing: releaseMissing(entry, parameters.lateEvidenceRelease),
    fromEvidenceYear: parameters.fromEvidenceYear,
  };
}

/** The informative `SHORTER_USEFUL_LIFE` of a component whose shorter life applies (§59G "Reasons, flags"). */
export function shorterLifeFlag(c: Extract<ShorterLifeCase, { kind: 'FROM_START' | 'FROM_EVIDENCE_YEAR' }>, lastMonth: number | null): Flag {
  return {
    code: 'SHORTER_USEFUL_LIFE',
    details: {
      usefulLifeYears: c.entry.usefulLifeYears,
      valuationDate: c.entry.evidence.valuationDate,
      evidenceDate: c.entry.evidence.date,
      method: c.kind,
      fromYear: c.kind === 'FROM_START' ? c.firstYear : c.fromYear,
      lastMonth: lastMonth === null ? null : monthLabel(lastMonth),
    },
  };
}
