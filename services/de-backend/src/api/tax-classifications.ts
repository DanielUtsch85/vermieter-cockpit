import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  CREATE_REVIEW_STATES,
  SOURCE_TYPES,
  TAX_CATEGORIES,
  TREATMENTS,
  WEG_SOURCE_TYPES,
  isErhaltungLine,
  performanceJson,
  treatmentFits,
  treatmentPartsJson,
  type CreateTaxClassification,
  type GetAnschaffungsnaheCheck,
  type GetDepositTaxMeaning,
  type GetTaxClassification,
  type GetTaxMeaning,
  type GetTaxRule,
  type GetTaxYearView,
  type GetWegTaxMeaning,
  type ListTaxClassificationHistory,
  type ListTaxMeanings,
  type ListTaxRules,
  type ReviewStep,
  type ReviewTaxClassification,
  type TaxClassification,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { definedOnly, optionalText, readId } from './acquisitions.js';
import { interestPeriodBody, performanceBody, performanceFieldIssue, positiveEur } from './tax-classification-performance.js';
import { ref, uuid } from './tax-classification-dto.js';
import { taxMeaningRoutes } from './tax-meanings.js';
import { taxYearRoutes } from './tax-years.js';
import { fieldErrors, integerIn, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const issue = (ctx: z.RefinementCtx, path: string, code: string) => ctx.addIssue({ code: 'custom', path: [path], params: { code } });
const has = (list: readonly string[], value: unknown) => typeof value === 'string' && list.includes(value);
/** The sources named with a `sourcePosition`: the WEG ones (§58B) and a statement's cost line (§58M). */
const POSITIONED = [...WEG_SOURCE_TYPES, 'WEG_STATEMENT_COST_LINE'] as const;
/** §58M: what a cost line's classification never takes (check-only; the Hausgeld is deducted when paid). */
const NOT_FOR_COST_LINES = [
  'anschaffungsnaheAcquisitionId',
  'partialTreatment',
  'distributionYears',
  'mostlyResidentialConfirmed',
  'taxYear',
  'refundOfYear',
] as const;

const taxYear = integerIn(2000, 2100);
/** A reserve line's or a use's `position` (§58B). */
const position = integerIn(1, 1000);

/** `netAmount` (§58B): Money in EUR, > 0, at most two decimals (`INVALID_FORMAT`). */
const netAmount = positiveEur;

const createBody = z
  .object({
    sourceType: z.enum(SOURCE_TYPES),
    sourceId: uuid,
    taxCategory: z.enum(TAX_CATEGORIES),
    treatment: z.enum(TREATMENTS).nullable(),
    reviewState: z.enum(CREATE_REVIEW_STATES).default('USER_CONFIRMED'),
    supersedes: uuid.nullish(),
    notes: optionalText(2000).nullish(),
    sourceReferences: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    taxYear: taxYear.nullish(),
    refundOfYear: taxYear.nullish(),
    // VC-7-03 (§58B).
    sourcePosition: position.nullish(),
    netAmount: netAmount.nullish(),
    annuallyRecurring: z.boolean().optional(),
    distributionYears: integerIn(2, 5).nullish(),
    mostlyResidentialConfirmed: z.boolean().nullish(),
    anschaffungsnaheAcquisitionId: uuid.nullish(),
    // §59E: Bauzeitzinsen, a split's only.
    constructionPeriodInterestId: uuid.nullish(),
    // §59F: the period of performance.
    performance: performanceBody.nullish(),
    // §59F, VC-X-38 Part 2: the partial treatment of a source straddling the window (its parts derived by DE).
    partialTreatment: z.boolean().optional(),
    // §58L (VC-X-40, L4): the interest period of a Loan's interest split, from the lender's statement.
    interestPeriod: interestPeriodBody.nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const given = (value: unknown) => value !== undefined && value !== null;
    const weg = has(WEG_SOURCE_TYPES, body.sourceType);
    if (body.sourceType === 'DEPOSIT_CLOSING') {
      for (const field of ['taxYear', 'refundOfYear'] as const) if (given(body[field])) issue(ctx, field, 'NOT_SUPPORTED');
    }
    // A withdrawal or a use is never a refund; a use has its own date, so no taxYear (§58B).
    if (weg && given(body.refundOfYear)) issue(ctx, 'refundOfYear', 'NOT_SUPPORTED');
    if (body.sourceType === 'WEG_ASSESSMENT_USE' && given(body.taxYear)) issue(ctx, 'taxYear', 'NOT_SUPPORTED');
    // §58L: a split's only (the split's Loan and category are checked when it is read).
    if (given(body.interestPeriod) && body.sourceType !== undefined && body.sourceType !== 'TRANSACTION_SPLIT') issue(ctx, 'interestPeriod', 'NOT_SUPPORTED');
    if (body.sourceType !== undefined) {
      const positioned = has(POSITIONED, body.sourceType);
      if (positioned && !given(body.sourcePosition)) issue(ctx, 'sourcePosition', 'REQUIRED');
      if (!positioned && given(body.sourcePosition)) issue(ctx, 'sourcePosition', 'NOT_ALLOWED');
    }
    // §58M: a cost line is MAINTENANCE/DEDUCTIBLE or NOT_RELEVANT, and takes none of a treatment's fields.
    if (body.sourceType === 'WEG_STATEMENT_COST_LINE') {
      const refused = NOT_FOR_COST_LINES.filter((field) => given(body[field]) && body[field] !== false);
      const fits =
        (body.taxCategory === 'MAINTENANCE' && body.treatment === 'DEDUCTIBLE') || (body.taxCategory === 'NOT_RELEVANT' && body.treatment === 'NOT_RELEVANT');
      for (const field of refused) issue(ctx, field, 'NOT_ALLOWED_WITH_TREATMENT');
      if (body.taxCategory !== undefined && body.treatment !== undefined && !fits) issue(ctx, 'treatment', 'NOT_ALLOWED_WITH_TREATMENT');
      // The general field rules below would name the same fields again.
      if (refused.length > 0 || !fits) return;
    }
    const category = body.taxCategory;
    if (category === undefined || body.treatment === undefined) return;
    const erhaltung = isErhaltungLine(category);
    if (given(body.netAmount) && !erhaltung) issue(ctx, 'netAmount', 'NOT_ALLOWED_WITH_TAX_CATEGORY');
    if (body.annuallyRecurring === true && !erhaltung) issue(ctx, 'annuallyRecurring', 'NOT_ALLOWED_WITH_TAX_CATEGORY');
    const election = body.treatment === 'DISTRIBUTED_82B';
    for (const field of ['distributionYears', 'mostlyResidentialConfirmed'] as const) {
      if (election && !given(body[field])) issue(ctx, field, 'REQUIRED');
      if (!election && given(body[field])) issue(ctx, field, 'NOT_ALLOWED_WITH_TREATMENT');
    }
    if (given(body.anschaffungsnaheAcquisitionId) && !(body.treatment === 'CAPITALIZED' && erhaltung)) {
      issue(ctx, 'anschaffungsnaheAcquisitionId', 'NOT_ALLOWED_WITH_TREATMENT');
    }
    if (!treatmentFits(category, body.treatment)) issue(ctx, 'treatment', 'TAX_CATEGORY_TREATMENT_MISMATCH');
    if (given(body.performance)) {
      const performanceIssue = performanceFieldIssue(body);
      if (performanceIssue !== null) issue(ctx, 'performance', performanceIssue);
    }
    // VC-X-38 Part 2: only as a capitalisation on the check, with the performance its parts are derived from.
    if (body.partialTreatment === true) {
      if (!(body.treatment === 'CAPITALIZED' && erhaltung && given(body.anschaffungsnaheAcquisitionId))) {
        issue(ctx, 'partialTreatment', 'NOT_ALLOWED_WITH_TREATMENT');
      } else if (!given(body.performance)) {
        issue(ctx, 'performance', 'REQUIRED');
      }
    }
    // §59E check 5 (its treatment part) and a split only; never together with an anschaffungsnahe link (one treatmentRule).
    if (
      given(body.constructionPeriodInterestId) &&
      (body.sourceType !== 'TRANSACTION_SPLIT' ||
        (body.treatment !== 'CAPITALIZED' && body.treatment !== 'DEDUCTIBLE') ||
        given(body.anschaffungsnaheAcquisitionId))
    ) {
      issue(ctx, 'constructionPeriodInterestId', 'NOT_ALLOWED');
    }
  });

const emptyBody = z.object({}).strict().optional();
const advisorBody = z
  .object({ advisorPartyId: uuid.nullish(), note: optionalText(2000).nullish() })
  .strict()
  .optional();
const markBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const queryPosition = z.coerce.number().int().min(1).max(1000);
const historyQuery = z
  .object({ sourceType: z.enum(SOURCE_TYPES), sourceId: uuid, sourcePosition: queryPosition.optional() })
  .strict()
  .superRefine((query, ctx) => {
    if (query.sourceType === undefined) return;
    const positioned = has(POSITIONED, query.sourceType);
    if (positioned && query.sourcePosition === undefined) issue(ctx, 'sourcePosition', 'REQUIRED');
    if (!positioned && query.sourcePosition !== undefined) issue(ctx, 'sourcePosition', 'NOT_ALLOWED');
  });

export interface TaxationCommands {
  readonly create: CreateTaxClassification;
  readonly get: GetTaxClassification;
  readonly history: ListTaxClassificationHistory;
  readonly review: ReviewTaxClassification;
  readonly taxMeaning: GetTaxMeaning;
  /** VC-7-02 (§58A): the retained deposit's meaning. */
  readonly depositTaxMeaning: GetDepositTaxMeaning;
  /** VC-7-03 (§58B): a reserve withdrawal's and a use's meaning, and the anschaffungsnahe check. */
  readonly withdrawalTaxMeaning: GetWegTaxMeaning;
  readonly useTaxMeaning: GetWegTaxMeaning;
  readonly anschaffungsnahe: GetAnschaffungsnaheCheck;
  readonly taxMeanings: ListTaxMeanings;
  /** VC-7-04 (§58C): the tax-year view per PropertyReference and per owner. */
  readonly taxYear: GetTaxYearView;
  readonly listRules: ListTaxRules;
  readonly getRule: GetTaxRule;
}

/**
 * Tax classification and tax rules API (api-design.md §55–§58B, backlog VC-7-01, VC-7-02, VC-7-03). The tax rules and
 * meanings (tax-meanings.ts) and the tax-year view (tax-years.ts) are mounted first, in the order they were registered.
 */
export function taxationRoutes(commands: TaxationCommands): Router {
  const router = express.Router();
  router.use(taxMeaningRoutes(commands));
  router.use(taxYearRoutes(commands));

  router.post('/tax-classifications', express.json({ limit: '64kb' }), (req, res, next) => {
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    commands
      .create({
        principal: principalOf(res),
        sourceType: body.sourceType,
        sourceId: body.sourceId,
        taxCategory: body.taxCategory,
        treatment: body.treatment,
        reviewState: body.reviewState,
        supersedes: body.supersedes ?? null,
        notes: body.notes ?? null,
        sourceReferences: body.sourceReferences ?? [],
        taxYear: body.taxYear ?? null,
        refundOfYear: body.refundOfYear ?? null,
        // §58B's fields only when given: a body without them keeps the request (and fingerprint) of VC-7-02.
        ...definedOnly({
          sourcePosition: body.sourcePosition ?? undefined,
          netAmount: body.netAmount ?? undefined,
          annuallyRecurring: body.annuallyRecurring,
          distributionYears: body.distributionYears ?? undefined,
          mostlyResidentialConfirmed: body.mostlyResidentialConfirmed ?? undefined,
          anschaffungsnaheAcquisitionId: body.anschaffungsnaheAcquisitionId ?? undefined,
          constructionPeriodInterestId: body.constructionPeriodInterestId ?? undefined,
          performance: body.performance ?? undefined,
          // Only when asked for, so a body without it keeps its request (and fingerprint).
          partialTreatment: body.partialTreatment === true ? true : undefined,
          interestPeriod: body.interestPeriod ?? undefined,
        }),
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ classification, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.setHeader('Location', `/api/v1/tax-classifications/${classification.id}`);
        sendClassification(res.status(201), classification);
      })
      .catch(next);
  });

  router.get('/tax-classifications', (req, res, next) => {
    const parsed = historyQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .history({
        principal: principalOf(res),
        sourceType: parsed.data.sourceType,
        sourceId: parsed.data.sourceId,
        sourcePosition: parsed.data.sourcePosition ?? null,
      })
      .then((items) => res.json({ items: items.map(classificationDto) }))
      .catch(next);
  });

  router.get('/tax-classifications/:classificationId', (req, res, next) => {
    const classificationId = readId(req.params['classificationId'], 'classificationId', res);
    if (classificationId === undefined) return;
    commands
      .get({ principal: principalOf(res), classificationId })
      .then((classification) => sendClassification(res, classification))
      .catch(next);
  });

  /** §57's three steps: `If-Match`, the body read by `stepOf`. */
  const reviewRoute = (path: string, stepOf: (body: unknown) => { step: ReviewStep } | { error: z.ZodError }) =>
    router.post(`/tax-classifications/:classificationId/${path}`, express.json({ limit: '16kb' }), (req, res, next) => {
      const classificationId = readId(req.params['classificationId'], 'classificationId', res);
      if (classificationId === undefined) return;
      const ifMatch = readIfMatch(req, res);
      if (ifMatch === undefined) return;
      const read = stepOf(req.body);
      if ('error' in read) {
        sendValidationError(res, fieldErrors(read.error));
        return;
      }
      commands
        .review({
          principal: principalOf(res),
          classificationId,
          step: read.step,
          ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
        })
        .then(({ classification }) => sendClassification(res, classification))
        .catch(next);
    });

  reviewRoute('confirm', (body) => {
    const parsed = emptyBody.safeParse(body);
    return parsed.success ? { step: { kind: 'CONFIRM' } } : { error: parsed.error };
  });
  reviewRoute('advisor-confirm', (body) => {
    const parsed = advisorBody.safeParse(body);
    if (!parsed.success) return { error: parsed.error };
    return { step: { kind: 'ADVISOR_CONFIRM', advisorPartyId: parsed.data?.advisorPartyId ?? null, note: parsed.data?.note ?? null } };
  });
  reviewRoute('mark-needs-review', (body) => {
    const parsed = markBody.safeParse(body);
    return parsed.success ? { step: { kind: 'MARK_NEEDS_REVIEW', reason: parsed.data.reason } } : { error: parsed.error };
  });

  return router;
}

function sendClassification(res: Response, classification: TaxClassification): void {
  res.setHeader('ETag', `"${classification.version}"`);
  res.json(classificationDto(classification));
}

function classificationDto(c: TaxClassification) {
  return {
    classificationId: c.id,
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    sourcePosition: c.sourcePosition,
    taxCategory: c.taxCategory,
    treatment: c.treatment,
    reviewState: c.reviewState,
    rule: { ruleCode: c.rule.ruleCode, version: c.rule.version },
    treatmentRule: ref(c.treatmentRule),
    advisorPartyId: c.advisorPartyId,
    notes: c.notes,
    sourceReferences: c.sourceReferences,
    taxYear: c.taxYear,
    refundOfYear: c.refundOfYear,
    depositClosing: c.depositClosing === null ? null : { closingDate: c.depositClosing.closingDate, retainedAmount: c.depositClosing.retainedAmount.toJSON() },
    reserveWithdrawal: c.reserveWithdrawal === null ? null : { unitShare: c.reserveWithdrawal.unitShare.toJSON() },
    assessmentUse: c.assessmentUse === null ? null : { date: c.assessmentUse.date, unitShare: c.assessmentUse.unitShare.toJSON() },
    // §58M: present only on a cost line's classification (the printed unit share as classified).
    ...((c.costLine ?? null) === null ? {} : { costLine: { unitShare: c.costLine?.unitShare.toJSON() } }),
    netAmount: c.netAmount?.toJSON() ?? null,
    annuallyRecurring: c.annuallyRecurring,
    distributionYears: c.distributionYears,
    mostlyResidentialConfirmed: c.mostlyResidentialConfirmed,
    anschaffungsnaheAcquisitionId: c.anschaffungsnaheAcquisitionId,
    constructionPeriodInterestId: c.constructionPeriodInterestId,
    performance: c.performance === null ? null : performanceJson(c.performance),
    // VC-X-38 Part 2: present only on a partial treatment (the window part CAPITALIZED, the rest DEDUCTIBLE).
    ...((c.treatmentParts ?? null) === null ? {} : { treatmentParts: treatmentPartsJson(c.treatmentParts ?? []) }),
    // §58L (VC-X-40): present only when recorded (a Loan's interest split).
    ...((c.interestPeriod ?? null) === null ? {} : { interestPeriod: { from: c.interestPeriod?.from, until: c.interestPeriod?.until } }),
    supersedes: c.supersedes,
    supersededBy: c.supersededBy,
    supersededAt: c.supersededAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    createdBy: c.createdBy,
    version: c.version,
  };
}
