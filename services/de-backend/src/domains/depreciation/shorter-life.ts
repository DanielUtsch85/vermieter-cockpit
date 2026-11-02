import type { BusinessDate } from '../../shared/index.js';
import { isConfirmed, type ShorterUsefulLife } from './asset.js';
import { monthLabel, yearOfDate } from './exact.js';
import type { ShorterUsefulLifeParameters } from './rules/de-afa-building-linear.js';
import type { Flag } from './schedule-model.js';

/**
 * From when a confirmed shorter useful life applies (api-design.md §59G Part 1, VC-X-41; Prüfbericht 2026-11-01,
 * Frage 8; the owner's decisions of 2026-11-02). Judged per purchase component on the entry's **valuation date**
 * (Bewertungsstichtag), never on the document's date:
 *
 * - no valuation date (an entry from before migration 0056): not computed in any year (`USEFUL_LIFE_VALUATION_DATE_MISSING`);
 * - its year before the contract year: not the buyer's remaining life (`USEFUL_LIFE_EVIDENCE_BEFORE_PURCHASE`);
 * - its year not after the component's first year: `1/n` from the start (`FROM_START`), the figures of before VC-X-41;
 * - its year after the first year (`FROM_EVIDENCE_YEAR`): the band's rate before its year and, when `n` is below the
 *   band's threshold, not computed from its year (`SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED`, Part 1), with
 *   `SHORTER_USEFUL_LIFE_RELEASE_MISSING` beside it while the rule's `lateEvidenceRelease` is not met (by the owner:
 *   `ADVISOR_CONFIRMED`, its evidence and a release note). Judged on `n` alone (§59G open question 4 is still open):
 *   below the threshold it is not computed from its year under either reading, and not below it, it is not shorter
 *   under either reading.
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
      /** Part 2's last month `L` (December of `YE + n − 1`); a later cost starting after it needs a new evidence. */
      readonly lastMonth: number;
      readonly shorter: boolean;
      readonly shorterThanYears: number | null;
      /** What the release of a late evidence lacks (`lateEvidenceRelease`), in this order; `[]` when released. */
      readonly releaseMissing: readonly string[];
    };

/**
 * What the release of a late evidence lacks for the rule's `lateEvidenceRelease`, in this order; `[]` when released. The
 * evidence is named by the entry's `documentReference` or the asset's `sourceReferences` (§59G).
 */
export function releaseMissing(
  entry: ShorterUsefulLife,
  release: ShorterUsefulLifeParameters['lateEvidenceRelease'],
  sourceReferences: readonly string[],
): string[] {
  const missing: string[] = [];
  if (entry.reviewState !== release.reviewState) missing.push(release.reviewState);
  if (release.evidence && entry.evidence.documentReference === null && sourceReferences.length === 0) missing.push('EVIDENCE');
  if (release.releaseNote && entry.releaseNote === null) missing.push('RELEASE_NOTE');
  return missing;
}

export function shorterLifeCaseOf(c: {
  readonly entry: ShorterUsefulLife | undefined;
  readonly contractDate: BusinessDate;
  /** The asset's `sourceReferences` (an evidence named there counts for the release). */
  readonly sourceReferences: readonly string[];
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
  return {
    kind: 'FROM_EVIDENCE_YEAR',
    entry,
    firstYear: c.firstYear,
    fromYear: evidenceYear,
    lastMonth: (evidenceYear + entry.usefulLifeYears - 1) * 12 + 11,
    // A threshold that cannot be read is never taken as "not shorter": the years from the evidence stay not computed.
    shorter: shorterThanYears === null || entry.usefulLifeYears < shorterThanYears,
    shorterThanYears,
    releaseMissing: releaseMissing(entry, parameters.lateEvidenceRelease, c.sourceReferences),
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
