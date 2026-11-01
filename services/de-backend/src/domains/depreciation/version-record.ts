import type { BusinessDate, RuleRegistry } from '../../shared/index.js';
import { isConfirmed } from './asset.js';
import { canonicalJson, type Fingerprinter } from './fingerprint.js';
import { isOpen } from './schedule-review.js';
import { activeIn, compareYear, liveSchedule, type LiveSchedule } from './version-compare.js';
import { inputFingerprint, outputFingerprint, truncateInputs } from './version-fingerprint.js';
import type { NewScheduleVersion, RecordDecision, RecordRead, RecordRequest, VersionFlag } from './version-model.js';

/**
 * The record command's decision (api-design.md §60 "Order of checks", steps 3–9), taken in the command's own snapshot:
 * the asset `ACTIVE`, every year of the run with a figure, something to record, coverage never shrinking, the
 * precondition, the no-op, and the recorded years it would change named exactly. Pure: the repository executes it.
 */

const ASSET_REASONS = ['ASSET_NOT_CONFIRMED', 'COMPLETION_YEAR_MISSING', 'NO_CAPITALIZED_ITEMS'];

/** Identity of a record for `Idempotency-Key` replays: the normalised body (§60, §15). */
export function recordFingerprint(request: RecordRequest): string {
  return canonicalJson({
    throughYear: request.throughYear,
    reason: request.reason,
    expectedInputFingerprint: request.expectedInputFingerprint,
    acceptChangedYears: [...request.acceptChangedYears].sort((a, b) => a - b),
  });
}

export function planRecord(
  read: RecordRead,
  request: RecordRequest,
  context: { readonly registry: RuleRegistry; readonly fingerprinter: Fingerprinter; readonly today: BusinessDate; readonly recordedBy: string },
): RecordDecision {
  const { schedule: snapshot, current } = read;
  const { asset } = snapshot;
  const { throughYear } = request;
  // 3. A VOID asset takes no record (§59's answer).
  if (asset.status !== 'ACTIVE') return { kind: 'REFUSED', refusal: { kind: 'ASSET_NOT_ACTIVE', status: asset.status } };
  const live: LiveSchedule = liveSchedule(snapshot, context.registry, context.fingerprinter, context.today, throughYear);
  const fromYear = live.schedule.range.from;
  const run = Array.from({ length: Math.max(0, throughYear - fromYear + 1) }, (_, i) => fromYear + i);
  // 4. Every year of the run has a figure.
  const reasons = live.schedule.reasons.filter((r) => ASSET_REASONS.includes(r.code)).map((r) => r.code);
  const incomplete = live.schedule.years.filter((y) => y.year <= throughYear && y.status !== 'AVAILABLE');
  if (reasons.length > 0 || incomplete.length > 0) {
    const years = incomplete.map((y) => ({
      year: y.year,
      status: y.status,
      components: live.schedule.components.flatMap((c) => {
        const cy = c.years.find((x) => x.year === y.year);
        const codes = [...new Set([...c.reasons, ...(cy?.reasons ?? [])].map((r) => r.code))];
        return cy === undefined || cy.calculationStatus !== 'NOT_CALCULABLE' ? [] : [{ componentId: c.componentId, reasons: codes }];
      }),
    }));
    return { kind: 'REFUSED', refusal: { kind: 'SCHEDULE_NOT_COMPLETE', details: { reasons, years } } };
  }
  // 5. Something to record.
  if (!run.some((year) => activeIn(live, year))) {
    const firstYear = live.schedule.components.length === 0 ? null : fromYear;
    return { kind: 'REFUSED', refusal: { kind: 'NOTHING_TO_RECORD', throughYear, firstYear } };
  }
  // 6. Coverage never shrinks.
  if (current !== null && current.throughYear > throughYear) {
    return { kind: 'REFUSED', refusal: { kind: 'THROUGH_YEAR_BEFORE_CURRENT', currentVersionId: current.versionId, currentThroughYear: current.throughYear } };
  }
  // 7. The precondition: the figures the person saw, or nothing.
  const fingerprint = inputFingerprint(live.inputs, throughYear, context.fingerprinter);
  if (fingerprint !== request.expectedInputFingerprint) {
    return {
      kind: 'REFUSED',
      refusal: { kind: 'SCHEDULE_CHANGED', throughYear, expectedInputFingerprint: request.expectedInputFingerprint, currentInputFingerprint: fingerprint },
    };
  }
  const compared = current === null ? [] : current.years.map((y) => compareYear(current, live, y.year, context.fingerprinter));
  // 8. The no-op: the same run, every year unchanged.
  if (current !== null && current.throughYear === throughYear && current.fromYear === fromYear && compared.every((c) => c.state === 'UNCHANGED')) {
    return { kind: 'NOOP', version: current };
  }
  // 9. The recorded years it would change, named exactly.
  const changed = compared.filter((c) => c.state === 'CHANGED_SINCE_RECORDED');
  const accepted = [...request.acceptChangedYears].sort((a, b) => a - b);
  const changedYears = changed.map((c) => c.year);
  if (current !== null && canonicalJson(changedYears) !== canonicalJson(accepted)) {
    return {
      kind: 'REFUSED',
      refusal: {
        kind: 'RECORDED_YEARS_WOULD_CHANGE',
        currentVersionId: current.versionId,
        changedYears: changed.map((c) => ({ year: c.year, recorded: c.recorded, derived: c.derived, causes: c.causes })),
        acceptChangedYears: accepted,
      },
    };
  }
  if (current === null && accepted.length > 0) {
    return {
      kind: 'REFUSED',
      refusal: { kind: 'RECORDED_YEARS_WOULD_CHANGE', currentVersionId: '', changedYears: [], acceptChangedYears: accepted },
    };
  }
  return {
    kind: 'RECORD',
    version: newVersion(live, request, fromYear, context),
    changedYears: changed.map((c) => ({ year: c.year, recorded: c.recorded ?? 0n, derived: c.derived })),
  };
}

function newVersion(
  live: LiveSchedule,
  request: RecordRequest,
  fromYear: number,
  context: { readonly fingerprinter: Fingerprinter; readonly today: BusinessDate; readonly recordedBy: string },
): NewScheduleVersion {
  const { throughYear } = request;
  const { fingerprinter } = context;
  const inputs = truncateInputs(live.inputs, throughYear);
  const entries = live.entries.filter((e) => e.year >= fromYear && e.year <= throughYear);
  const years = live.schedule.years
    .filter((y) => y.year >= fromYear && y.year <= throughYear)
    .map((y) => ({
      year: y.year,
      amount: live.totals.get(y.year)?.amount ?? 0n,
      residualValue: live.totals.get(y.year)?.residualValue ?? 0n,
      inputFingerprint: inputFingerprint(live.inputs, y.year, fingerprinter),
      outputFingerprint: outputFingerprint(
        entries.filter((e) => e.year === y.year),
        fingerprinter,
      ),
    }));
  // The flags that stood, the code and its level only (the details are re-derived on read).
  const flags = new Map<string, VersionFlag>();
  const note = (f: VersionFlag) => flags.set(canonicalJson(f), f);
  for (const f of live.schedule.flags) note({ year: null, componentId: null, partKey: null, code: f.code, level: isOpen(f.code) ? 'OPEN' : 'INFORMATIVE' });
  for (const y of live.schedule.years.filter((x) => x.year >= fromYear && x.year <= throughYear)) {
    for (const f of y.flags) {
      const ids = (f.details['componentIds'] as readonly string[] | undefined) ?? [null];
      for (const componentId of ids) note({ year: y.year, componentId, partKey: null, code: f.code, level: isOpen(f.code) ? 'OPEN' : 'INFORMATIVE' });
    }
  }
  const asset = live.schedule.asset;
  if (!isConfirmed(asset.reviewState as never)) throw new Error('planRecord: an unconfirmed asset reached the record');
  return {
    assetId: live.schedule.assetId,
    propertyReferenceId: live.schedule.propertyReferenceId,
    fromYear,
    throughYear,
    reason: request.reason,
    recordedBy: context.recordedBy,
    computedOn: context.today,
    calculationVersion: inputs.calculationVersion,
    inputFingerprint: inputFingerprint(live.inputs, throughYear, fingerprinter),
    outputFingerprint: outputFingerprint(entries, fingerprinter),
    inputs,
    years,
    entries,
    flags: [...flags.values()],
  };
}
