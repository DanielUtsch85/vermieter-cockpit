import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  FINGERPRINT,
  SCHEDULE_VERSION_STATUSES,
  centsText,
  type GetScheduleVersion,
  type ListScheduleVersions,
  type RecordScheduleVersion,
  type Reproduction,
  type ScheduleVersion,
  type ScheduleVersionStatus,
  type ScheduleVersionView,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { readId } from './acquisitions.js';
import { RESOURCE_ID, fieldErrors, integerIn, readIdempotencyKey, sendValidationError } from './validation.js';

/**
 * Recorded depreciation schedule versions (api-design.md §60, backlog VC-8-04): the record command and the two reads.
 * Request validation stays here (`400`, all field errors at once); the recording switch is the use case's first check
 * after it ("The recording switch", decided 2026-10-31, third set).
 */

export interface ScheduleVersionCommands {
  readonly recordVersion: RecordScheduleVersion;
  readonly listVersions: ListScheduleVersions;
  readonly getVersion: GetScheduleVersion;
}

const issue = (ctx: z.RefinementCtx, path: (string | number)[], code: string) => ctx.addIssue({ code: 'custom', path, params: { code } });

/** §60 "Body": strict; `throughYear` 2000–2100 (today's year is the use case's check), the fingerprint 64 lower-case hex. */
const recordBody = z
  .object({
    throughYear: integerIn(2000, 2100),
    reason: z.string().trim().min(1).max(500),
    expectedInputFingerprint: z.string().regex(FINGERPRINT),
    acceptChangedYears: z
      .array(integerIn(2000, 2100))
      .max(101)
      .superRefine((years, ctx) => {
        years.forEach((year, i) => {
          if (years.indexOf(year) !== i) issue(ctx, [i], 'DUPLICATE');
        });
      })
      .optional(),
  })
  .strict();

const listQuery = z
  .object({
    status: z
      .string()
      .transform((value, ctx) => {
        const statuses = value.split(',');
        if (statuses.some((s) => !(SCHEDULE_VERSION_STATUSES as readonly string[]).includes(s))) {
          issue(ctx, [], 'INVALID_FORMAT');
          return z.NEVER;
        }
        return [...new Set(statuses)] as ScheduleVersionStatus[];
      })
      .optional(),
  })
  .strict();

export function scheduleVersionRoutes(commands: ScheduleVersionCommands): Router {
  const router = express.Router();

  router.post('/depreciation-assets/:assetId/schedule-versions', express.json({ limit: '32kb' }), (req, res, next) => {
    const errors: { field: string; code: string }[] = [];
    const rawId = req.params['assetId'];
    if (rawId === undefined || !RESOURCE_ID.test(rawId)) errors.push({ field: 'assetId', code: 'INVALID_FORMAT' });
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = recordBody.safeParse(req.body);
    if (!parsed.success) errors.push(...fieldErrors(parsed.error));
    if (errors.length > 0 || !parsed.success || rawId === undefined) {
      sendValidationError(res, errors);
      return;
    }
    commands
      .recordVersion({
        principal: principalOf(res),
        assetId: rawId.toLowerCase(),
        throughYear: parsed.data.throughYear,
        reason: parsed.data.reason,
        expectedInputFingerprint: parsed.data.expectedInputFingerprint,
        acceptChangedYears: parsed.data.acceptChangedYears ?? [],
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ version, created, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.setHeader('Location', `/api/v1/depreciation-assets/${version.assetId}/schedule-versions/${version.versionId}`);
        sendVersion(res.status(created ? 201 : 200), { version, reproduction: null, comparison: null });
      })
      .catch(next);
  });

  router.get('/depreciation-assets/:assetId/schedule-versions', (req, res, next) => {
    const assetId = readId(req.params['assetId'], 'assetId', res);
    if (assetId === undefined) return;
    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      sendValidationError(
        res,
        fieldErrors(query.error).map((e) => ({ ...e, field: e.field === '(body)' ? 'status' : e.field })),
      );
      return;
    }
    commands
      .listVersions({ principal: principalOf(res), assetId, statuses: query.data.status ?? null })
      .then((versions) => res.json({ items: versions.map(headerDto) }))
      .catch(next);
  });

  router.get('/depreciation-assets/:assetId/schedule-versions/:versionId', (req, res, next) => {
    const assetId = readId(req.params['assetId'], 'assetId', res);
    if (assetId === undefined) return;
    const versionId = readId(req.params['versionId'], 'versionId', res);
    if (versionId === undefined) return;
    commands
      .getVersion({ principal: principalOf(res), assetId, versionId })
      .then((view) => sendVersion(res, view))
      .catch(next);
  });

  return router;
}

const money = (cents: bigint | null, currency: string) => (cents === null ? null : { amount: centsText(cents), currency });

/** The header, the rule versions and the year rows (the list's item, §60 "Reads"). */
function headerDto(v: ScheduleVersion) {
  const currency = v.inputs.currency;
  return {
    versionId: v.versionId,
    assetId: v.assetId,
    propertyReferenceId: v.propertyReferenceId,
    versionNumber: v.versionNumber,
    status: v.status,
    supersedesVersionId: v.supersedesVersionId,
    supersededByVersionId: v.supersededByVersionId,
    supersededAt: v.supersededAt?.toISOString() ?? null,
    fromYear: v.fromYear,
    throughYear: v.throughYear,
    reason: v.reason,
    recordedAt: v.recordedAt.toISOString(),
    recordedBy: v.recordedBy,
    computedOn: v.computedOn,
    calculationVersion: v.calculationVersion,
    inputFingerprint: v.inputFingerprint,
    outputFingerprint: v.outputFingerprint,
    ruleVersions: v.inputs.rules,
    years: v.years.map((y) => ({ year: y.year, amount: money(y.amount, currency), residualValue: money(y.residualValue, currency) })),
    version: v.version,
  };
}

/** The whole version (§60 "Response") with `reproduction` and `comparison` (`null` on the command's answer). */
function sendVersion(
  res: Response,
  view: { readonly version: ScheduleVersion; readonly reproduction: Reproduction | null; readonly comparison: ScheduleVersionView['comparison'] },
) {
  const v = view.version;
  const currency = v.inputs.currency;
  const a = v.inputs.asset;
  res.setHeader('ETag', `"${v.version}"`);
  res.json({
    ...headerDto(v),
    asset: {
      assetType: a.assetType,
      assetVersion: a.assetVersion,
      depreciationMethod: a.depreciationMethod,
      ...(a.assetType === 'SEPARATE_ASSET'
        ? { description: a.description, usefulLifeYears: a.usefulLifeYears, acquiredOn: a.acquiredOn }
        : { buildingCompletionYear: a.buildingCompletionYear }),
      reviewState: a.reviewState,
    },
    components: v.inputs.components.map((c) => ({
      componentId: c.componentId,
      kind: c.kind,
      inputs:
        c.acquisition !== null
          ? {
              acquisitionId: c.acquisition.acquisitionId,
              purchasePrice: money(c.acquisition.purchasePrice, currency),
              countedCosts: { ids: c.acquisition.countedCostIds, total: money(c.acquisition.countedCostsTotal, currency) },
              excludedCosts: { ids: c.acquisition.excludedCostIds, total: money(c.acquisition.excludedCostsTotal, currency) },
              allocationId: c.acquisition.allocationId,
              allocationReviewState: c.acquisition.allocationReviewState,
              totalAllocableAmount: money(c.acquisition.totalAllocableAmount, currency),
              buildingAmount: money(c.acquisition.buildingAmount, currency),
              shorterUsefulLife:
                c.acquisition.shorterLifeReviewState === null
                  ? null
                  : { usefulLifeYears: c.rate.usefulLifeYears, reviewState: c.acquisition.shorterLifeReviewState },
            }
          : c.item === null
            ? null
            : { ...c.item, lineAmount: money(c.basis, currency) },
      basis: money(c.basis, currency),
      start: { date: c.start.date, dateSource: c.start.dateSource, method: c.start.method, month: c.start.month },
      rate: c.rate,
      parts: c.parts.map((p) => ({
        partKey: p.partKey,
        ownerPartyId: p.ownerPartyId,
        ownershipIds: p.ownershipIds,
        share: p.share,
        weight: p.weight,
        basis: money(p.basis, currency),
        firstMonth: p.firstMonth,
        rate: { kind: p.rateKind, usefulLifeYears: p.usefulLifeYears },
        tenure: { from: p.tenureFrom, lastDay: p.lastDay, lastDaySource: p.lastDaySource },
        poolKey: p.poolKey,
        fractions: p.fractions,
      })),
    })),
    years: v.years.map((y) => {
      const entries = v.entries.filter((e) => e.year === y.year);
      const owners = [...new Set(entries.filter((e) => e.partKey !== 'NOT_OWNED').map((e) => e.partKey))].sort().map((partKey) => ({
        partKey,
        ownerPartyId: partKey.slice('OWNER:'.length),
        amount: money(
          entries.filter((e) => e.partKey === partKey).reduce((s, e) => s + e.amount, 0n),
          currency,
        ),
      }));
      const notOwned = entries.filter((e) => e.partKey === 'NOT_OWNED');
      return {
        year: y.year,
        amount: money(y.amount, currency),
        residualValue: money(y.residualValue, currency),
        inputFingerprint: y.inputFingerprint,
        outputFingerprint: y.outputFingerprint,
        owners,
        notOwned:
          notOwned.length === 0
            ? null
            : money(
                notOwned.reduce((s, e) => s + e.amount, 0n),
                currency,
              ),
        entries: entries.map((e) => ({
          componentId: e.componentId,
          partKey: e.partKey,
          months: e.months,
          fraction: e.fraction,
          amount: money(e.amount, currency),
          cumulative: money(e.cumulative, currency),
          residualValue: money(e.residualValue, currency),
        })),
        flags: v.flags.filter((f) => f.year === y.year).map((f) => ({ code: f.code, level: f.level, componentId: f.componentId, partKey: f.partKey })),
      };
    }),
    flags: v.flags.filter((f) => f.year === null).map((f) => ({ code: f.code, level: f.level })),
    reproduction: view.reproduction,
    comparison: view.comparison,
  });
}
