import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  CREATE_REVIEW_STATES,
  ORIGINS,
  REVIEW_STATES,
  SOURCE_TYPES,
  TAX_CATEGORIES,
  TREATMENTS,
  WEG_SOURCE_TYPES,
  isErhaltungLine,
  treatmentFits,
  type AnschaffungsnaheCheck,
  type CheckEntry,
  type CreateTaxClassification,
  type DepositTaxMeaning,
  type Distribution,
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
  type TaxListItem,
  type TaxMeaning,
  type TaxRuleView,
  type TaxYearItem,
  type TaxYearLine,
  type TaxYearSection,
  type TaxYearTotals,
  type TaxYearView,
  type WegTaxMeaning,
} from '../application/index.js';
import { Money, MoneyError } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { definedOnly, optionalText, readId } from './acquisitions.js';
import { RESOURCE_ID, fieldErrors, integerIn, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const uuid = z
  .string()
  .regex(RESOURCE_ID)
  .transform((id) => id.toLowerCase());

const issue = (ctx: z.RefinementCtx, path: string, code: string) => ctx.addIssue({ code: 'custom', path: [path], params: { code } });
const has = (list: readonly string[], value: unknown) => typeof value === 'string' && list.includes(value);

const taxYear = integerIn(2000, 2100);
/** A reserve line's or a use's `position` (§58B). */
const position = integerIn(1, 1000);

/** `netAmount` (§58B): Money in EUR, > 0, at most two decimals (`INVALID_FORMAT`). */
const netAmount = z.object({ amount: z.string(), currency: z.string() }).transform((value, ctx) => {
  try {
    const parsed = Money.of(value.amount, value.currency);
    if (parsed.currency !== 'EUR') {
      ctx.addIssue({ code: 'custom', path: ['currency'], params: { code: 'CURRENCY_MISMATCH' } });
      return z.NEVER;
    }
    if (!parsed.isPositive()) {
      ctx.addIssue({ code: 'custom', path: ['amount'], params: { code: 'NOT_POSITIVE' } });
      return z.NEVER;
    }
    return parsed;
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    ctx.addIssue({
      code: 'custom',
      path: error.code === 'UNSUPPORTED_CURRENCY' ? ['currency'] : ['amount'],
      params: { code: error.code === 'UNSUPPORTED_CURRENCY' ? 'UNSUPPORTED_CURRENCY' : 'INVALID_FORMAT' },
    });
    return z.NEVER;
  }
});

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
    if (body.sourceType !== undefined) {
      if (weg && !given(body.sourcePosition)) issue(ctx, 'sourcePosition', 'REQUIRED');
      if (!weg && given(body.sourcePosition)) issue(ctx, 'sourcePosition', 'NOT_ALLOWED');
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
    const weg = has(WEG_SOURCE_TYPES, query.sourceType);
    if (weg && query.sourcePosition === undefined) issue(ctx, 'sourcePosition', 'REQUIRED');
    if (!weg && query.sourcePosition !== undefined) issue(ctx, 'sourcePosition', 'NOT_ALLOWED');
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
    sourceType: csv(SOURCE_TYPES),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/** §58C: only `ownerPartyId`; any other parameter is `400`. */
const taxYearQuery = z.object({ ownerPartyId: uuid.optional() }).strict();

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

/** A position in a path (§58B): an integer 1–1000, else `400` at `position`. */
function readPosition(value: string | undefined, res: Response): number | undefined {
  if (value !== undefined && /^[1-9]\d{0,3}$/.test(value) && Number(value) <= 1000) return Number(value);
  sendValidationError(res, [{ field: 'position', code: 'INVALID_FORMAT' }]);
  return undefined;
}

/** Tax classification and tax rules API (api-design.md §55–§58B, backlog VC-7-01, VC-7-02, VC-7-03). */
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
        propertyReferenceId: (rawId as string).toLowerCase(),
        year,
        ownerPartyId: query.data.ownerPartyId ?? null,
      })
      .then((view) => res.json(taxYearDto(view)))
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

const ref = (r: { readonly ruleCode: string; readonly version: number } | null) => (r === null ? null : { ruleCode: r.ruleCode, version: r.version });

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
    netAmount: c.netAmount?.toJSON() ?? null,
    annuallyRecurring: c.annuallyRecurring,
    distributionYears: c.distributionYears,
    mostlyResidentialConfirmed: c.mostlyResidentialConfirmed,
    anschaffungsnaheAcquisitionId: c.anschaffungsnaheAcquisitionId,
    supersedes: c.supersedes,
    supersededBy: c.supersededBy,
    supersededAt: c.supersededAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    createdBy: c.createdBy,
    version: c.version,
  };
}

/** Money anywhere in a value as its JSON (`{ amount, currency }`), everything else as it is. */
const plain = (value: unknown): unknown => (value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown));
const flagsDto = (flags: readonly { readonly code: string; readonly details: unknown }[]) => flags.map((f) => ({ code: f.code, details: plain(f.details) }));

function distributionDto(d: Distribution | null) {
  return d === null
    ? null
    : {
        years: d.years,
        firstYear: d.firstYear,
        parts: d.parts.map((p) => ({ year: p.year, amount: p.amount.toJSON() })),
        endYear: d.endYear,
        rule: ref(d.rule),
      };
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

const refundDto = (r: TaxYearItem['refund']) =>
  r === null ? null : { kind: r.kind, ofYear: r.ofYear, ofYearSource: r.ofYearSource, presentation: r.presentation, line: r.line };

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
    // "nicht zugeordnet" (§58C): the reason, the candidates and the deposit's own tax meaning.
    ...(i.notAttributed === null ? {} : { reason: i.notAttributed.reason, candidates: i.notAttributed.candidates, href: i.notAttributed.href }),
  };
}

const subtotalsDto = (s: TaxYearLine['subtotals']) => (s === null ? null : { immediate: s.immediate.toJSON(), distributed82b: s.distributed82b.toJSON() });

const sectionDto = (s: TaxYearSection) => ({
  total: s.total.toJSON(),
  lines: s.lines.map((l) => ({
    taxCategory: l.taxCategory,
    total: l.total.toJSON(),
    itemCount: l.itemCount,
    subtotals: subtotalsDto(l.subtotals),
    items: l.items.map(taxYearItemDto),
  })),
});

const resultDto = (r: TaxYearView['result']) => ({ amount: r.amount.toJSON(), kind: r.kind, basis: r.basis });

function totalsDto(t: TaxYearTotals) {
  const summary = (s: TaxYearTotals['einnahmen']) => ({
    total: s.total.toJSON(),
    lines: s.lines.map((l) => ({ taxCategory: l.taxCategory, total: l.total.toJSON(), itemCount: l.itemCount, subtotals: subtotalsDto(l.subtotals) })),
  });
  return { einnahmen: summary(t.einnahmen), werbungskosten: summary(t.werbungskosten), result: resultDto(t.result), capitalized: { total: t.capitalized.total.toJSON() } };
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
    depreciation: v.depreciation,
    result: resultDto(v.result),
    capitalized: { total: v.capitalized.total.toJSON(), items: v.capitalized.items.map(taxYearItemDto) },
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
