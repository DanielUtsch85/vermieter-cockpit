import express, { type Router } from 'express';
import { z } from 'zod';
import type { AfaItem, AfaLine, TaxYearItem, TaxYearLine, TaxYearSection, TaxYearTotals, TaxYearView } from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { distributionDto, flagsDto, plain, ref, uuid } from './tax-classification-dto.js';
import type { TaxationCommands } from './tax-classifications.js';
import { RESOURCE_ID, fieldErrors, sendValidationError } from './validation.js';

/** §58C: only `ownerPartyId`; any other parameter is `400`. */
const taxYearQuery = z.object({ ownerPartyId: uuid.optional() }).strict();

/** The tax-year view per PropertyReference and per owner (api-design.md §58C, VC-7-04; §58D, VC-X-29; the AfA, VC-8-05). */
export function taxYearRoutes(commands: TaxationCommands): Router {
  const router = express.Router();

  /**
   * §58C: the tax-year view. `400` for a malformed id, `year` (`INVALID_FORMAT` for anything but digits, `OUT_OF_RANGE`
   * outside 2000–2100), `ownerPartyId` or an unknown parameter; no version `ETag` (a derived read).
   */
  router.get('/property-references/:propertyReferenceId/tax-years/:year', (req, res, next) => {
    const errors: { field: string; code: string }[] = [];
    const rawId = req.params['propertyReferenceId'];
    if (rawId === undefined || !RESOURCE_ID.test(rawId)) errors.push({ field: 'propertyReferenceId', code: 'INVALID_FORMAT' });
    const rawYear = req.params['year'] ?? '';
    const year = Number(rawYear);
    if (!/^\d{1,9}$/.test(rawYear)) errors.push({ field: 'year', code: 'INVALID_FORMAT' });
    else if (year < 2000 || year > 2100) errors.push({ field: 'year', code: 'OUT_OF_RANGE' });
    const query = taxYearQuery.safeParse(req.query);
    if (!query.success) errors.push(...fieldErrors(query.error));
    if (errors.length > 0 || !query.success) {
      sendValidationError(res, errors);
      return;
    }
    commands
      .taxYear({
        principal: principalOf(res),
        propertyReferenceId: rawId.toLowerCase(),
        year,
        ownerPartyId: query.data.ownerPartyId ?? null,
      })
      .then((view) => res.json(taxYearDto(view)))
      .catch(next);
  });

  return router;
}

const refundDto = (r: TaxYearItem['refund']) =>
  r === null ? null : { kind: r.kind, ofYear: r.ofYear, ofYearSource: r.ofYearSource, presentation: r.presentation, line: r.line };

const loanAllocationDto = (a: TaxYearItem['loanAllocation']) =>
  a === null
    ? null
    : {
        loanId: a.loanId,
        allocationSetId: a.allocationSetId,
        validFrom: a.validFrom,
        validUntil: a.validUntil,
        basis: a.basis,
        share: a.share,
        propertyPart: a.propertyPart?.toJSON() ?? null,
      };

function taxYearItemDto(i: TaxYearItem) {
  const attribution = i.attribution as {
    readonly rule: { ruleCode: string; version: number } | null;
    readonly bookingYear?: number;
    readonly proposedYear: number;
    readonly overridden: boolean;
  } | null;
  return {
    sourceType: i.sourceType,
    sourceId: i.sourceId,
    sourcePosition: i.sourcePosition,
    transactionId: i.transactionId,
    date: i.date,
    dateSource: i.dateSource,
    taxYear: i.taxYear,
    direction: i.direction,
    amount: i.amount.toJSON(),
    lineAmount: i.lineAmount?.toJSON() ?? null,
    taxCategory: i.taxCategory,
    treatment: i.treatment,
    reviewState: i.reviewState,
    origin: i.origin,
    classificationId: i.classificationId,
    rule: ref(i.rule),
    treatmentRule: ref(i.treatmentRule),
    attribution:
      attribution === null
        ? null
        : {
            rule: ref(attribution.rule),
            ...(attribution.bookingYear === undefined ? {} : { bookingYear: attribution.bookingYear }),
            proposedYear: attribution.proposedYear,
            overridden: attribution.overridden,
          },
    refund: refundDto(i.refund),
    distribution:
      i.distribution === null
        ? null
        : {
            ...distributionDto(i.distribution),
            yearAmount: i.distribution.yearAmount.toJSON(),
            ...(i.distribution.ownerParts === null ? {} : { ownerParts: i.distribution.ownerParts.map((p) => ({ year: p.year, amount: p.amount.toJSON() })) }),
          },
    suggestion: plain(i.suggestion),
    share: i.share === null ? null : { ownershipId: i.share.ownershipId, share: i.share.share, amount: i.share.amount?.toJSON() ?? null },
    flags: flagsDto(i.flags),
    // §58D: the Loan's set on the booking date and the property's part, on an item from a Loan's interest split only.
    loanAllocation: loanAllocationDto(i.loanAllocation),
    // "nicht zugeordnet" (§58C, §58D): the reason, the candidates and the source's own tax meaning or the Loan's allocations.
    ...(i.notAttributed === null ? {} : { reason: i.notAttributed.reason, candidates: i.notAttributed.candidates, href: i.notAttributed.href }),
  };
}

const subtotalsDto = (s: TaxYearLine['subtotals']) => (s === null ? null : { immediate: s.immediate.toJSON(), distributed82b: s.distributed82b.toJSON() });

/** An AfA item (§58C "VC-8-05"): no `transactionId`, no `direction`, no split. */
const afaItemDto = (i: AfaItem) => ({
  assetId: i.assetId,
  assetType: i.assetType,
  description: i.description,
  componentId: i.componentId,
  kind: i.kind,
  acquisitionId: i.acquisitionId,
  source: i.source,
  basis: i.basis?.toJSON() ?? null,
  rate: i.rate,
  start: i.start,
  months: i.months,
  amount: i.amount.toJSON(),
  rule: ref(i.rule),
  share:
    i.share === null
      ? null
      : {
          ownershipId: i.share.ownershipId,
          share: i.share.share,
          amount: i.share.amount.toJSON(),
          ownershipIds: i.share.ownershipIds,
          partKey: i.share.partKey,
        },
  href: i.href,
  flags: flagsDto(i.flags),
});

const lineHead = (l: Omit<TaxYearLine, 'items'> | Omit<AfaLine, 'items'>) => ({
  line: l.line,
  taxCategory: l.taxCategory,
  total: l.total.toJSON(),
  itemCount: l.itemCount,
  subtotals: subtotalsDto(l.subtotals),
});

/** The cash lines, then (Werbungskosten) `AFA_BUILDING` and `AFA_SEPARATE_ASSETS` after `OTHER_EXPENSE`. */
const sectionDto = (s: TaxYearSection) => ({
  total: s.total.toJSON(),
  lines: [
    ...s.lines.map((l) => ({ ...lineHead(l), items: l.items.map(taxYearItemDto) })),
    ...(s.afaLines ?? []).map((l) => ({ ...lineHead(l), items: l.items.map(afaItemDto) })),
  ],
});

/** A capitalised item names the AfA component it became (VC-8-05). */
const capitalizedItemDto = (i: TaxYearItem) => ({
  ...taxYearItemDto(i),
  component:
    i.component === undefined || i.component === null
      ? null
      : {
          assetId: i.component.assetId,
          assetType: i.component.assetType,
          componentId: i.component.componentId,
          computable: i.component.computable,
          reasons: flagsDto(i.component.reasons),
        },
});

const depreciationDto = (d: TaxYearView['depreciation']) => ({
  status: d.status,
  amount: d.amount?.toJSON() ?? null,
  assets: d.assets.map((a) => ({ ...a, amount: a.amount?.toJSON() ?? null, reasons: flagsDto(a.reasons) })),
  gaps: d.gaps.map((g) => ({ ...g, details: plain(g.details) })),
  note: d.note,
});

const resultDto = (r: TaxYearView['result']) => ({ amount: r.amount.toJSON(), kind: r.kind, basis: r.basis });

function totalsDto(t: TaxYearTotals) {
  const summary = (s: TaxYearTotals['werbungskosten']) => ({
    total: s.total.toJSON(),
    lines: [...s.lines.map(lineHead), ...(s.afaLines ?? []).map(lineHead)],
  });
  return {
    einnahmen: summary(t.einnahmen),
    werbungskosten: summary(t.werbungskosten),
    result: resultDto(t.result),
    capitalized: { total: t.capitalized.total.toJSON() },
  };
}

function taxYearDto(v: TaxYearView) {
  return {
    propertyReferenceId: v.propertyReferenceId,
    year: v.year,
    ownerPartyId: v.ownerPartyId,
    level: v.level,
    computedOn: v.computedOn,
    einnahmen: sectionDto(v.einnahmen),
    werbungskosten: sectionDto(v.werbungskosten),
    depreciation: depreciationDto(v.depreciation),
    result: resultDto(v.result),
    capitalized: { total: v.capitalized.total.toJSON(), items: v.capitalized.items.map(capitalizedItemDto) },
    notInView: { items: v.notInView.items.map(taxYearItemDto) },
    unclassified: { items: v.unclassified.items.map(taxYearItemDto) },
    notAttributed: { items: v.notAttributed.items.map(taxYearItemDto) },
    acquisitions: v.acquisitions.map((a) => ({
      acquisitionId: a.acquisitionId,
      transferDate: a.transferDate,
      window: a.window,
      status: a.status,
      final: a.final,
      notFinalReasons: a.notFinalReasons,
      href: a.href,
    })),
    owners: v.owners === null ? null : v.owners.map((o) => ({ ownerPartyId: o.ownerPartyId, ownershipIds: o.ownershipIds, ...totalsDto(o) })),
    notOwned: v.notOwned === null ? null : totalsDto(v.notOwned),
    flags: flagsDto(v.flags),
    review: v.review,
    ruleVersions: v.ruleVersions,
  };
}
