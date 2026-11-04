import { addDays, type BusinessDate, type Money } from '../../shared/index.js';
import { yearOf } from './cash-timing.js';
import { performedOutside } from './performance.js';
import type { HausgeldMaintenanceParameters } from './rules/de-anschaffungsnahe.js';
import type { TaxClassification } from './tax-classification.js';
import type { CheckSource } from './anschaffungsnahe.js';

/**
 * Maintenance paid from the Hausgeld in the anschaffungsnahe check (api-design.md §58M, VC-X-27; tax review of
 * 2026-11-01, question 16, mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01; Entscheidung
 * des Projektinhabers, 2026-11-04): a `NON_RECOVERABLE` cost line of a `CONFIRMED` statement is a source of the check,
 * and only of the check, once a person has judged it (`MAINTENANCE`/`DEDUCTIBLE`, or `NOT_RELEVANT`); it is dated by its
 * performance (§59F), never by the statement. The statements read are those overlapping the read range (S to W + 365
 * days, M3); every financial year of that range needs its `CONFIRMED` statement (M7, symmetric); a later statement's
 * judged line performed in the window is listed beyond the search range. Derived on read; never a figure of the view.
 */

type Range = { readonly from: BusinessDate; readonly until: BusinessDate };

/** The stored classification of a cost line (§50): only the groups of the rule's `judgedLines` must be judged. */
export type CostLineGroup = 'RECOVERABLE' | 'NON_RECOVERABLE' | 'RESERVE';

export interface HausgeldLine {
  readonly position: number;
  readonly account: string;
  readonly classification: CostLineGroup;
  /** The printed unit share, signed (a credit line is negative). */
  readonly unitShare: Money;
  /** The line's current classification (`WEG_STATEMENT_COST_LINE`); `null`: not judged. */
  readonly current: TaxClassification | null;
}

/** A `CONFIRMED` statement of a membership of the PropertyReference, with its cost lines. */
export interface HausgeldStatement {
  readonly id: string;
  readonly membershipId: string;
  readonly financialYear: number;
  readonly periodFrom: BusinessDate;
  readonly periodUntil: BusinessDate;
  readonly lines: readonly HausgeldLine[];
}

/** An `ACTIVE` membership of the PropertyReference, for the financial years that need a statement. */
export interface HausgeldMembership {
  readonly id: string;
  readonly validFrom: BusinessDate;
  readonly validUntil: BusinessDate | null;
  readonly financialYearStartMonth: number;
}

export interface HausgeldInput {
  readonly statements: readonly HausgeldStatement[];
  readonly memberships: readonly HausgeldMembership[];
}

export const NO_HAUSGELD: HausgeldInput = { statements: [], memberships: [] };

export interface UnjudgedLine {
  readonly statementId: string;
  readonly position: number;
  readonly account: string;
  readonly unitShare: Money;
}

export interface MissingStatement {
  readonly membershipId: string;
  readonly financialYear: number;
}

export interface HausgeldReading {
  /** The judged `MAINTENANCE` lines of the statements read, and a later statement's judged line performed in the window. */
  readonly sources: readonly CheckSource[];
  readonly unjudged: readonly UnjudgedLine[];
  readonly missing: readonly MissingStatement[];
}

/** The statements' read range (§58M, M3 and M7: one parameter for both): `statementsFrom` to `statementsUntil`. */
export function readRangeOf(window: Range, ranges: { readonly searchRange: Range; readonly outerBound: Range }, q: HausgeldMaintenanceParameters): Range {
  const from = q.statementsFrom === 'WINDOW_START' ? window.from : ranges.searchRange.from;
  const until =
    q.statementsUntil === 'WINDOW_END' ? window.until : q.statementsUntil === 'SEARCH_RANGE_END' ? ranges.searchRange.until : ranges.outerBound.until;
  return { from, until };
}

const overlaps = (a: Range, b: Range) => a.from <= b.until && a.until >= b.from;
const judged = (q: HausgeldMaintenanceParameters, c: TaxClassification) => q.lines.some((l) => l.taxCategory === c.taxCategory && l.treatment === c.treatment);

/** A judged maintenance line as a source of the check: the printed unit share, dated by the period's end (shown only). */
function costLineSource(st: HausgeldStatement, line: HausgeldLine, c: TaxClassification, later: boolean): CheckSource {
  const negative = line.unitShare.isNegative();
  return {
    sourceType: 'WEG_STATEMENT_COST_LINE',
    sourceId: st.id,
    sourcePosition: line.position,
    date: st.periodUntil,
    dateSource: 'STATEMENT_PERIOD_END',
    // The year the Hausgeld holding it began to be paid: shown, and 236-4's "from" year; never `affectedYears`.
    taxYear: yearOf(st.periodFrom),
    taxCategory: c.taxCategory,
    treatment: c.treatment,
    reviewState: c.reviewState,
    origin: 'CLASSIFICATION',
    classificationId: c.id,
    grossAmount: negative ? line.unitShare.negate() : line.unitShare,
    direction: negative ? 'INFLOW' : 'OUTFLOW',
    netAmount: c.netAmount,
    annuallyRecurring: c.annuallyRecurring,
    anschaffungsnaheAcquisitionId: null,
    performance: c.performance,
    treatmentParts: null,
    sourceFlags: [],
    costLine: { statementPeriod: { from: st.periodFrom, until: st.periodUntil }, account: line.account, later },
  };
}

/** The financial year a date falls in (as `weg-sources.ts`' `financialYearOf`, §49.1). */
const financialYearOf = (date: BusinessDate, startMonth: number) => yearOf(date) - (Number(date.slice(5, 7)) < startMonth ? 1 : 0);

/** The last day of financial year `year` of a WEG whose year starts in `startMonth` (§49.1). */
function financialYearEnd(year: number, startMonth: number): BusinessDate {
  const next = startMonth === 1 ? `${year + 1}-01-01` : `${year + 1}-${String(startMonth).padStart(2, '0')}-01`;
  return addDays(next as BusinessDate, -1);
}

/**
 * What the check reads of the Hausgeld (§58M): the statements overlapping `read`, their judged maintenance lines (sources)
 * and unjudged lines; the financial years of `read` without a `CONFIRMED` statement, or not ended on `today` (M7); a
 * later statement's (beyond `read`, within the outer bound) judged maintenance line performed in the window (M3).
 */
export function readHausgeld(
  input: HausgeldInput,
  window: Range,
  read: Range,
  outerBound: Range,
  q: HausgeldMaintenanceParameters,
  today: BusinessDate,
): HausgeldReading {
  const sources: CheckSource[] = [];
  const unjudged: UnjudgedLine[] = [];
  const statements = [...input.statements].sort((a, b) => (a.periodUntil !== b.periodUntil ? (a.periodUntil < b.periodUntil ? -1 : 1) : a.id < b.id ? -1 : 1));
  for (const st of statements) {
    const period = { from: st.periodFrom, until: st.periodUntil };
    const isRead = overlaps(period, read);
    // A statement ending before the read range is never read (the Hausgeld before the transfer was not the buyer's).
    const later = !isRead && st.periodFrom > read.until && st.periodFrom <= outerBound.until;
    if (!isRead && !later) continue;
    for (const line of [...st.lines].sort((a, b) => a.position - b.position)) {
      if (!q.judgedLines.includes(line.classification) || line.unitShare.isZero()) continue;
      const c = line.current;
      if (isRead) {
        if (c === null || !judged(q, c)) unjudged.push({ statementId: st.id, position: line.position, account: line.account, unitShare: line.unitShare });
        else if (c.taxCategory === 'MAINTENANCE') sources.push(costLineSource(st, line, c, false));
      } else if (
        c !== null &&
        judged(q, c) &&
        c.taxCategory === 'MAINTENANCE' &&
        !c.annuallyRecurring &&
        c.performance !== null &&
        !performedOutside(c.performance, window)
      ) {
        // M3: a later-recorded line with performance in the window lands in SOURCES_OUTSIDE_SEARCH_RANGE, not in nothing.
        sources.push(costLineSource(st, line, c, true));
      }
    }
  }
  const missing: MissingStatement[] = [];
  for (const m of [...input.memberships].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const from = m.validFrom > read.from ? m.validFrom : read.from;
    const until = m.validUntil !== null && m.validUntil < read.until ? m.validUntil : read.until;
    if (from > until) continue;
    for (let year = financialYearOf(from, m.financialYearStartMonth); year <= financialYearOf(until, m.financialYearStartMonth); year += 1) {
      const end = financialYearEnd(year, m.financialYearStartMonth);
      const ended = today > (m.validUntil !== null && m.validUntil < end ? m.validUntil : end);
      const confirmed = input.statements.some((s) => s.membershipId === m.id && s.financialYear === year);
      // A year not ended has no final statement yet: missing as well (§58M, M7).
      if (!confirmed || !ended) missing.push({ membershipId: m.id, financialYear: year });
    }
  }
  return { sources, unjudged, missing };
}

/** The cost lines merged into the sources' list order: after the sources of the same date (§58M, the per-property list). */
export function mergeCostLines(sources: readonly CheckSource[], lines: readonly CheckSource[]): CheckSource[] {
  const merged = [...sources];
  for (const line of lines) {
    let at = merged.length;
    while (at > 0 && (merged[at - 1] as CheckSource).date > line.date) at -= 1;
    merged.splice(at, 0, line);
  }
  return merged;
}
