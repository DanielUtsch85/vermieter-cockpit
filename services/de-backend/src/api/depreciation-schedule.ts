import express, { type Router } from 'express';
import type { ComponentYear, Flag, ItemComponent, OwnerYear, RecordedSchedule, RecordedScheduleYear, ScheduleComponent } from '../application/index.js';
import type { Money } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { scheduleQuery } from './depreciation-asset-dto.js';
import type { DepreciationAssetCommands } from './depreciation-assets.js';
import { RESOURCE_ID, fieldErrors, sendValidationError } from './validation.js';

/** The schedule of a DepreciationAsset (api-design.md §59A, §59B; backlogs VC-8-02, VC-8-03). */
export function depreciationScheduleRoutes(commands: DepreciationAssetCommands): Router {
  const router = express.Router();

  /**
   * §59A: the schedule of the purchase, derived on read. `400` for a malformed `assetId`, `from`, `to`, `ownerPartyId`
   * or an unknown parameter, all at once, and `to` < `from` at `to`; no version `ETag` (a derived read).
   */
  router.get('/depreciation-assets/:assetId/schedule', (req, res, next) => {
    const errors: { field: string; code: string }[] = [];
    const rawId = req.params['assetId'];
    if (rawId === undefined || !RESOURCE_ID.test(rawId)) errors.push({ field: 'assetId', code: 'INVALID_FORMAT' });
    const query = scheduleQuery.safeParse(req.query);
    if (!query.success) errors.push(...fieldErrors(query.error));
    else if (query.data.from !== undefined && query.data.to !== undefined && query.data.to < query.data.from)
      errors.push({ field: 'to', code: 'OUT_OF_RANGE' });
    if (errors.length > 0 || !query.success || rawId === undefined) {
      sendValidationError(res, errors);
      return;
    }
    commands
      .schedule({
        principal: principalOf(res),
        assetId: rawId.toLowerCase(),
        ...(query.data.from === undefined ? {} : { from: query.data.from }),
        ...(query.data.to === undefined ? {} : { to: query.data.to }),
        ownerPartyId: query.data.ownerPartyId ?? null,
      })
      .then((schedule) => res.json(scheduleDto(schedule)))
      .catch(next);
  });

  return router;
}

const money = (m: Money | null) => (m === null ? null : m.toJSON());
const flagDto = (f: Flag) => ({ code: f.code, details: f.details });

/** §59A's response: Money as §86, fractions as `"n/d"`, months as `YYYY-MM`, flags as `{ code, details }`. */
function scheduleDto(s: RecordedSchedule) {
  const ownerYear = (o: OwnerYear) => ({
    ownerPartyId: o.ownerPartyId,
    months: o.months,
    fraction: o.fraction,
    amount: money(o.amount),
    residualValue: money(o.residualValue),
    calculationStatus: o.calculationStatus,
    reasons: o.reasons.map(flagDto),
    flags: o.flags.map(flagDto),
  });
  const componentYear = (y: ComponentYear) => ({
    year: y.year,
    rule: y.rule,
    months: y.months,
    amount: money(y.amount),
    cumulative: money(y.cumulative),
    residualValue: money(y.residualValue),
    calculationStatus: y.calculationStatus,
    reasons: y.reasons.map(flagDto),
    owners: y.owners.map(ownerYear),
    notOwned: money(y.notOwned),
    flags: y.flags.map(flagDto),
  });
  // §59B: a component of `kind` `CAPITALIZED_ITEM`.
  const itemComponent = (c: ItemComponent) => ({
    componentId: c.componentId,
    kind: c.kind,
    source: c.source,
    status: c.status,
    reasons: c.reasons.map(flagDto),
    basis: { amount: money(c.basis.amount), netAmount: money(c.basis.netAmount), amountUsed: c.basis.amountUsed },
    start: c.start,
    rate: c.rate,
    end: c.end,
    owners: c.owners.map((o) => ({ ...o, basis: money(o.basis) })),
    notOwned: c.notOwned === null ? null : { share: c.notOwned.share, basis: money(c.notOwned.basis) },
    years: c.years.map(componentYear),
    flags: c.flags.map(flagDto),
  });
  const component = (c: ScheduleComponent) => ({
    componentId: c.componentId,
    kind: c.kind,
    acquisitionId: c.acquisitionId,
    acquisitionStatus: c.acquisitionStatus,
    status: c.status,
    reasons: c.reasons.map(flagDto),
    // §59C: the purchase's method entry (without the evidence) with its status, `null` without one.
    method: c.method,
    basis: {
      amount: money(c.basis.amount),
      purchasePrice: money(c.basis.purchasePrice),
      acquisitionCosts: money(c.basis.acquisitionCosts),
      excludedCosts: c.basis.excludedCosts.map((e) => ({ category: e.category, amount: money(e.amount) })),
      allocationId: c.basis.allocationId,
      allocationMethod: c.basis.allocationMethod,
      allocationReviewState: c.basis.allocationReviewState,
      totalAllocableAmount: money(c.basis.totalAllocableAmount),
      buildingAmount: money(c.basis.buildingAmount),
    },
    start: c.start,
    rate: c.rate,
    end: c.end,
    owners: c.owners.map((o) => ({ ...o, basis: money(o.basis) })),
    years: c.years.map(componentYear),
    flags: c.flags.map(flagDto),
  });
  const year = (y: RecordedScheduleYear) => ({
    year: y.year,
    status: y.status,
    calculationStatus: y.calculationStatus,
    amount: money(y.amount),
    residualValue: money(y.residualValue),
    owners: y.owners === null ? null : y.owners.map((o) => ({ ownerPartyId: o.ownerPartyId, amount: money(o.amount) })),
    notOwned: money(y.notOwned),
    reasons: y.reasons.map(flagDto),
    flags: y.flags.map(flagDto),
    // §60: the asset's input fingerprint (the record command's precondition) and the year's recording state.
    inputFingerprint: y.inputFingerprint,
    recording: y.recording,
  });
  return {
    assetId: s.assetId,
    propertyReferenceId: s.propertyReferenceId,
    assetType: s.assetType,
    level: s.level,
    ownerPartyId: s.ownerPartyId,
    computedOn: s.computedOn,
    range: s.range,
    status: s.status,
    reasons: s.reasons.map(flagDto),
    flags: s.flags.map(flagDto),
    asset: s.asset,
    components: s.components.map((c) => (c.kind === 'CAPITALIZED_ITEM' ? itemComponent(c) : component(c))),
    excludedItems: s.excludedItems,
    years: s.years.map(year),
    review: s.review,
    ruleVersions: s.ruleVersions,
    recordedVersion: s.recordedVersion === null ? null : { ...s.recordedVersion, recordedAt: s.recordedVersion.recordedAt.toISOString() },
    // Only the installation's switch (§60, decided 2026-10-31, third set, open question 10); no figure depends on it.
    recordingEnabled: s.recordingEnabled,
  };
}
