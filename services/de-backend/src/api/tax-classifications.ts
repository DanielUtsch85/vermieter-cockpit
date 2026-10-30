import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  CREATE_REVIEW_STATES,
  LATER_TAX_CATEGORIES,
  LATER_TREATMENTS,
  ORIGINS,
  REVIEW_STATES,
  SOURCE_TYPES,
  SUPPORTED_SOURCE_TYPES,
  TAX_CATEGORIES,
  TREATMENTS,
  treatmentFits,
  type CreateTaxClassification,
  type GetTaxClassification,
  type GetTaxMeaning,
  type GetTaxRule,
  type ListTaxClassificationHistory,
  type ListTaxMeanings,
  type ListTaxRules,
  type ReviewStep,
  type ReviewTaxClassification,
  type TaxClassification,
  type TaxMeaning,
  type TaxRuleView,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { definedOnly, optionalText, readId } from './acquisitions.js';
import { RESOURCE_ID, fieldErrors, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const uuid = z
  .string()
  .regex(RESOURCE_ID)
  .transform((id) => id.toLowerCase());

const notSupported = (path: string, ctx: z.RefinementCtx) => ctx.addIssue({ code: 'custom', path: [path], params: { code: 'NOT_SUPPORTED' } });
const has = (list: readonly string[], value: unknown) => typeof value === 'string' && list.includes(value);

/** Fields of later items (VC-7-02, VC-7-03): accepted by name, answered `400 NOT_SUPPORTED` (§55). */
const LATER_FIELDS = ['taxYear', 'refundOfYear', 'netAmount', 'annuallyRecurring', 'distributionYears'] as const;

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
    taxYear: z.unknown().optional(),
    refundOfYear: z.unknown().optional(),
    netAmount: z.unknown().optional(),
    annuallyRecurring: z.unknown().optional(),
    distributionYears: z.unknown().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    for (const field of LATER_FIELDS) if (body[field] !== undefined) notSupported(field, ctx);
    if (body.sourceType !== undefined && !has(SUPPORTED_SOURCE_TYPES, body.sourceType)) notSupported('sourceType', ctx);
    if (has(LATER_TAX_CATEGORIES, body.taxCategory)) notSupported('taxCategory', ctx);
    if (has(LATER_TREATMENTS, body.treatment)) notSupported('treatment', ctx);
    else if (body.taxCategory !== undefined && body.treatment !== undefined && !treatmentFits(body.taxCategory, body.treatment)) {
      ctx.addIssue({ code: 'custom', path: ['treatment'], params: { code: 'TAX_CATEGORY_TREATMENT_MISMATCH' } });
    }
  });

const emptyBody = z.object({}).strict().optional();
const advisorBody = z
  .object({ advisorPartyId: uuid.nullish(), note: optionalText(2000).nullish() })
  .strict()
  .optional();
const markBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const historyQuery = z
  .object({ sourceType: z.enum(SOURCE_TYPES), sourceId: uuid })
  .strict()
  .superRefine((query, ctx) => {
    if (query.sourceType !== undefined && !has(SUPPORTED_SOURCE_TYPES, query.sourceType)) notSupported('sourceType', ctx);
  });
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
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export interface TaxationCommands {
  readonly create: CreateTaxClassification;
  readonly get: GetTaxClassification;
  readonly history: ListTaxClassificationHistory;
  readonly review: ReviewTaxClassification;
  readonly taxMeaning: GetTaxMeaning;
  readonly taxMeanings: ListTaxMeanings;
  readonly listRules: ListTaxRules;
  readonly getRule: GetTaxRule;
}

/** Tax classification and tax rules API (api-design.md §55–§58, backlog VC-7-01). */
export function taxationRoutes(commands: TaxationCommands): Router {
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

  router.get('/property-references/:propertyReferenceId/tax-meanings', (req, res, next) => {
    const propertyReferenceId = readId(req.params['propertyReferenceId'], 'propertyReferenceId', res);
    if (propertyReferenceId === undefined) return;
    const parsed = meaningsQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { year, reviewState, origin, taxCategory, page, pageSize } = parsed.data;
    commands
      .taxMeanings({
        principal: principalOf(res),
        propertyReferenceId,
        year,
        filter: definedOnly({
          reviewStates: reviewState,
          origins: origin,
          taxCategories: taxCategory,
        }),
        page: { page, pageSize },
      })
      .then((result) => res.json({ ...result, items: result.items.map(meaningDto) }))
      .catch(next);
  });

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
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: body.sourceId,
        taxCategory: body.taxCategory,
        treatment: body.treatment,
        reviewState: body.reviewState,
        supersedes: body.supersedes ?? null,
        notes: body.notes ?? null,
        sourceReferences: body.sourceReferences ?? [],
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
      .history({ principal: principalOf(res), sourceType: parsed.data.sourceType, sourceId: parsed.data.sourceId })
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
    taxCategory: c.taxCategory,
    treatment: c.treatment,
    reviewState: c.reviewState,
    rule: { ruleCode: c.rule.ruleCode, version: c.rule.version },
    advisorPartyId: c.advisorPartyId,
    notes: c.notes,
    sourceReferences: c.sourceReferences,
    supersedes: c.supersedes,
    supersededBy: c.supersededBy,
    supersededAt: c.supersededAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    createdBy: c.createdBy,
    version: c.version,
  };
}

function meaningDto(m: TaxMeaning) {
  return {
    splitId: m.splitId,
    transactionId: m.transactionId,
    bookingDate: m.bookingDate,
    direction: m.direction,
    amount: m.amount.toJSON(),
    financialCategoryCode: m.financialCategoryCode,
    propertyReferenceId: m.propertyReferenceId,
    counts: m.counts,
    taxCategory: m.taxCategory,
    treatment: m.treatment,
    reviewState: m.reviewState,
    origin: m.origin,
    rule: m.rule === null ? null : { ruleCode: m.rule.ruleCode, version: m.rule.version },
    classificationId: m.classificationId,
    flags: m.flags.map((f) => ({ code: f.code, details: f.details })),
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
