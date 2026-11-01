import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  ORIGINS,
  REVIEW_STATES,
  SOURCE_TYPES,
  TAX_CATEGORIES,
  type AnschaffungsnaheCheck,
  type CheckEntry,
  type DepositTaxMeaning,
  type GetWegTaxMeaning,
  type TaxListItem,
  type TaxMeaning,
  type TaxRuleView,
  type WegTaxMeaning,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { definedOnly, readId } from './acquisitions.js';
import { distributionDto, flagsDto, plain, ref } from './tax-classification-dto.js';
import type { TaxationCommands } from './tax-classifications.js';
import { fieldErrors, sendValidationError } from './validation.js';

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(values)).min(1))
    .optional();
const meaningsQuery = z
  .object({
    year: z.coerce.number().int().min(2000).max(2100),
    reviewState: csv(REVIEW_STATES),
    origin: csv(ORIGINS),
    taxCategory: csv(TAX_CATEGORIES),
    sourceType: csv(SOURCE_TYPES),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/** A position in a path (§58B): an integer 1–1000, else `400` at `position`. */
function readPosition(value: string | undefined, res: Response): number | undefined {
  if (value !== undefined && /^[1-9]\d{0,3}$/.test(value) && Number(value) <= 1000) return Number(value);
  sendValidationError(res, [{ field: 'position', code: 'INVALID_FORMAT' }]);
  return undefined;
}

/** The tax rules and the derived tax meanings (api-design.md §55, §58–§58B; VC-7-01, VC-7-02, VC-7-03). */
export function taxMeaningRoutes(commands: TaxationCommands): Router {
  const router = express.Router();

  router.get('/tax-rules', (_req, res, next) => {
    commands
      .listRules()
      .then((rules) => res.json({ items: rules.map(ruleDto) }))
      .catch(next);
  });

  router.get('/tax-rules/:ruleCode', (req, res, next) => {
    commands
      .getRule({ ruleCode: req.params['ruleCode'] ?? '' })
      .then((rule) => res.json(ruleDto(rule)))
      .catch(next);
  });

  router.get('/transaction-splits/:splitId/tax-meaning', (req, res, next) => {
    const splitId = readId(req.params['splitId'], 'splitId', res);
    if (splitId === undefined) return;
    commands
      .taxMeaning({ principal: principalOf(res), splitId })
      .then((meaning) => res.json(meaningDto(meaning)))
      .catch(next);
  });

  router.get('/security-deposits/:depositId/tax-meaning', (req, res, next) => {
    const depositId = readId(req.params['depositId'], 'depositId', res);
    if (depositId === undefined) return;
    commands
      .depositTaxMeaning({ principal: principalOf(res), depositId })
      .then((meaning) => res.json(depositMeaningDto(meaning)))
      .catch(next);
  });

  /** §58B: the two WEG sources, by their row and position; no `ETag` (a derived read). */
  const wegRoute = (path: string, idParam: string, read: GetWegTaxMeaning) =>
    router.get(path, (req, res, next) => {
      const sourceId = readId(req.params[idParam], idParam, res);
      if (sourceId === undefined) return;
      const at = readPosition(req.params['position'], res);
      if (at === undefined) return;
      read({ principal: principalOf(res), sourceId, position: at })
        .then((meaning) => res.json(wegMeaningDto(meaning)))
        .catch(next);
    });
  wegRoute('/weg-annual-statements/:statementId/reserve-withdrawals/:position/tax-meaning', 'statementId', (input) => commands.withdrawalTaxMeaning(input));
  wegRoute('/weg-special-assessments/:assessmentId/uses/:position/tax-meaning', 'assessmentId', (input) => commands.useTaxMeaning(input));

  router.get('/acquisitions/:acquisitionId/anschaffungsnahe-herstellungskosten', (req, res, next) => {
    const acquisitionId = readId(req.params['acquisitionId'], 'acquisitionId', res);
    if (acquisitionId === undefined) return;
    const query = z.object({}).strict().safeParse(req.query);
    if (!query.success) {
      sendValidationError(res, fieldErrors(query.error));
      return;
    }
    commands
      .anschaffungsnahe({ principal: principalOf(res), acquisitionId })
      .then((check) => res.json(checkDto(check)))
      .catch(next);
  });

  router.get('/property-references/:propertyReferenceId/tax-meanings', (req, res, next) => {
    const propertyReferenceId = readId(req.params['propertyReferenceId'], 'propertyReferenceId', res);
    if (propertyReferenceId === undefined) return;
    const parsed = meaningsQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { year, reviewState, origin, taxCategory, sourceType, page, pageSize } = parsed.data;
    commands
      .taxMeanings({
        principal: principalOf(res),
        propertyReferenceId,
        year,
        filter: definedOnly({
          reviewStates: reviewState,
          origins: origin,
          taxCategories: taxCategory,
          sourceTypes: sourceType,
        }),
        page: { page, pageSize },
      })
      .then((result) => res.json({ ...result, items: result.items.map(itemDto) }))
      .catch(next);
  });

  return router;
}

const itemDto = (item: TaxListItem) => ({
  ...(item.sourceType === 'DEPOSIT_CLOSING' ? depositMeaningDto(item) : item.sourceType === 'TRANSACTION_SPLIT' ? meaningDto(item) : wegMeaningDto(item)),
  yearAmount: item.yearAmount.toJSON(),
});

function meaningDto(m: TaxMeaning) {
  return {
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    sourcePosition: null,
    splitId: m.splitId,
    transactionId: m.transactionId,
    bookingDate: m.bookingDate,
    direction: m.direction,
    amount: m.amount.toJSON(),
    netAmount: m.netAmount?.toJSON() ?? null,
    financialCategoryCode: m.financialCategoryCode,
    propertyReferenceId: m.propertyReferenceId,
    counts: m.counts,
    taxCategory: m.taxCategory,
    treatment: m.treatment,
    reviewState: m.reviewState,
    origin: m.origin,
    rule: ref(m.rule),
    treatmentRule: ref(m.treatmentRule),
    classificationId: m.classificationId,
    taxYear: m.taxYear,
    attribution: {
      rule: ref(m.attribution.rule),
      bookingYear: m.attribution.bookingYear,
      proposedYear: m.attribution.proposedYear,
      overridden: m.attribution.overridden,
    },
    refund:
      m.refund === null
        ? null
        : { kind: m.refund.kind, ofYear: m.refund.ofYear, ofYearSource: m.refund.ofYearSource, presentation: m.refund.presentation, line: m.refund.line },
    distribution: distributionDto(m.distribution),
    suggestion: plain(m.suggestion),
    flags: flagsDto(m.flags),
  };
}

function wegMeaningDto(m: WegTaxMeaning) {
  return {
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    sourcePosition: m.sourcePosition,
    membershipId: m.membershipId,
    propertyReferenceId: m.propertyReferenceId,
    date: m.date,
    dateSource: m.dateSource,
    description: m.description,
    amount: m.amount.toJSON(),
    netAmount: m.netAmount?.toJSON() ?? null,
    counts: m.counts,
    notCountedReason: m.notCountedReason,
    taxYear: m.taxYear,
    attribution: { rule: null, proposedYear: m.attribution.proposedYear, overridden: m.attribution.overridden },
    taxCategory: m.taxCategory,
    treatment: m.treatment,
    reviewState: m.reviewState,
    origin: m.origin,
    rule: ref(m.rule),
    treatmentRule: ref(m.treatmentRule),
    classificationId: m.classificationId,
    distribution: distributionDto(m.distribution),
    suggestion: plain(m.suggestion),
    flags: flagsDto(m.flags),
  };
}

function depositMeaningDto(m: DepositTaxMeaning) {
  return {
    sourceType: m.sourceType,
    sourceId: m.sourceId,
    sourcePosition: null,
    securityDepositId: m.securityDepositId,
    status: m.status,
    closingDate: m.closingDate,
    propertyReferenceId: m.propertyReferenceId,
    counts: m.counts,
    taxYear: m.taxYear,
    amount: m.amount.toJSON(),
    taxCategory: m.taxCategory,
    treatment: m.treatment,
    reviewState: m.reviewState,
    origin: m.origin,
    rule: ref(m.rule),
    classificationId: m.classificationId,
    flags: flagsDto(m.flags),
  };
}

function entryDto(e: CheckEntry) {
  return {
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    sourcePosition: e.sourcePosition,
    date: e.date,
    taxYear: e.taxYear,
    taxCategory: e.taxCategory,
    treatment: e.treatment,
    reviewState: e.reviewState,
    origin: e.origin,
    classificationId: e.classificationId,
    grossAmount: e.grossAmount.toJSON(),
    netAmount: e.netAmount?.toJSON() ?? null,
    amountUsed: e.amountUsed.toJSON(),
    suggestedTreatment: e.suggestedTreatment,
    reason: e.reason,
    flags: flagsDto(e.flags),
  };
}

function checkDto(c: AnschaffungsnaheCheck) {
  return {
    acquisitionId: c.acquisitionId,
    propertyReferenceId: c.propertyReferenceId,
    acquisitionStatus: c.acquisitionStatus,
    transferDate: c.transferDate,
    window: c.window,
    acquiredShare: `${c.acquiredShare.numerator}/${c.acquiredShare.denominator}`,
    rule: ref(c.rule),
    status: c.status,
    notComputableReason: c.notComputableReason,
    basis: plain(c.basis),
    thresholdPercent: c.thresholdPercent,
    threshold: c.threshold === null ? null : { amount: c.threshold, currency: 'EUR' },
    // §59D: the threshold of the upper bound (with the unclassified costs); null when equal or not computable.
    thresholdWithUnclassified: c.thresholdWithUnclassified === null ? null : { amount: c.thresholdWithUnclassified, currency: 'EUR' },
    sum: c.sum.toJSON(),
    attributableAmount: c.attributableAmount.toJSON(),
    percentOfBasis: c.percentOfBasis,
    sources: c.sources.map(entryDto),
    excluded: c.excluded.map(entryDto),
    unclassified: c.unclassified.map(entryDto),
    affectedYears: c.affectedYears,
    final: c.final,
    flags: flagsDto(c.flags),
  };
}

function ruleDto(rule: TaxRuleView) {
  return {
    ruleCode: rule.ruleCode,
    versions: rule.versions.map((v) => ({
      ruleCode: v.ruleCode,
      version: v.version,
      title: v.title,
      legalBasis: v.legalBasis,
      effectiveFrom: v.effectiveFrom,
      effectiveTo: v.effectiveTo,
      parameters: v.parameters,
      source: v.source,
      status: v.status,
    })),
  };
}
