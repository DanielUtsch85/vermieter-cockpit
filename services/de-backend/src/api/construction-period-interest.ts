import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  MAX_CONSTRUCTION_PERIOD_PROPERTIES,
  parseShare,
  type AmendConstructionPeriodInterest,
  type ConfirmConstructionPeriodInterest,
  type ConstructionPeriodInterest,
  type CreateConstructionPeriodInterest,
  type GetConstructionPeriodInterest,
  type ListConstructionPeriodInterest,
  type NamingClassification,
  type VoidConstructionPeriodInterest,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, optionalText, readId } from './acquisitions.js';
import { RESOURCE_ID, fieldErrors, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const uuid = z
  .string()
  .regex(RESOURCE_ID)
  .transform((id) => id.toLowerCase());

const issue = (ctx: z.RefinementCtx, path: (string | number)[], code: string) => ctx.addIssue({ code: 'custom', path, params: { code } });

/** `"n/d"` with `0 < n ≤ d ≤ 10000` (§59E `buildingFundsShare`), kept reduced. */
const fundsShare = z.string().transform((value, ctx) => {
  const result = parseShare(value);
  if ('share' in result) return { numerator: BigInt(result.share.numerator), denominator: BigInt(result.share.denominator) };
  issue(ctx, [], result.error);
  return z.NEVER;
});

/** 1–50 PropertyReferences, no duplicates (`DUPLICATE` at the later position). */
const propertyReferenceIds = z.array(uuid).superRefine((ids, ctx) => {
  if (ids.length < 1 || ids.length > MAX_CONSTRUCTION_PERIOD_PROPERTIES) issue(ctx, [], 'OUT_OF_RANGE');
  ids.forEach((id, i) => {
    if (ids.indexOf(id) !== i) issue(ctx, [i], 'DUPLICATE');
  });
});

const text = (max: number) => z.string().trim().min(1).max(max);
const references = z.array(text(500)).min(1).max(20);

const facts = {
  propertyReferenceIds,
  measure: text(200),
  herstellungFrom: businessDate,
  herstellungUntil: businessDate.nullish(),
  useIntent: text(1000),
  advanceExpenseDeductible: z.boolean(),
  buildingFundsShare: fundsShare,
  earlierYearsTreatment: text(2000),
  sourceReferences: references,
  notes: optionalText(2000).nullish(),
};

/** The period ordered (`OUT_OF_RANGE` on `herstellungUntil`), checked on what parsed. */
const periodOrdered = (body: { herstellungFrom?: unknown; herstellungUntil?: unknown }, ctx: z.RefinementCtx) => {
  if (typeof body.herstellungFrom === 'string' && typeof body.herstellungUntil === 'string' && body.herstellungUntil < body.herstellungFrom) {
    issue(ctx, ['herstellungUntil'], 'OUT_OF_RANGE');
  }
};

const createBody = z
  .object({ loanId: uuid.nullish(), ...facts })
  .strict()
  .superRefine(periodOrdered);
// The Loan never changes (0055's frozen guard): an amend names the facts only, each optional.
const amendBody = z
  .object(Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof facts]: z.ZodOptional<(typeof facts)[K]> })
  .strict()
  .superRefine(periodOrdered);
const confirmBody = z
  .object({ reviewState: z.enum(['CONFIRMED', 'ADVISOR_CONFIRMED']), advisorPartyId: uuid.nullish() })
  .strict()
  .superRefine((b, ctx) => {
    const advisor = b.advisorPartyId !== undefined && b.advisorPartyId !== null;
    if (b.reviewState === 'ADVISOR_CONFIRMED' && !advisor) issue(ctx, ['advisorPartyId'], 'REQUIRED');
    if (b.reviewState === 'CONFIRMED' && advisor) issue(ctx, ['advisorPartyId'], 'NOT_ALLOWED');
  });
const voidBody = z.object({ reason: text(500) }).strict();
const listQuery = z.object({ loanId: uuid.optional(), propertyReferenceId: uuid.optional() }).strict();

export interface ConstructionPeriodInterestCommands {
  readonly create: CreateConstructionPeriodInterest;
  readonly get: GetConstructionPeriodInterest;
  readonly list: ListConstructionPeriodInterest;
  readonly amend: AmendConstructionPeriodInterest;
  readonly confirm: ConfirmConstructionPeriodInterest;
  readonly void: VoidConstructionPeriodInterest;
}

/** The construction-period records of Bauzeitzinsen (api-design.md §59E "Routes", backlog VC-X-36). */
export function constructionPeriodInterestRoutes(commands: ConstructionPeriodInterestCommands): Router {
  const router = express.Router();
  const base = '/construction-period-interest';

  router.post(base, express.json({ limit: '64kb' }), (req, res, next) => {
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const b = parsed.data;
    commands
      .create({
        principal: principalOf(res),
        loanId: b.loanId ?? null,
        propertyReferenceIds: b.propertyReferenceIds,
        measure: b.measure,
        herstellungFrom: b.herstellungFrom,
        herstellungUntil: b.herstellungUntil ?? null,
        useIntent: b.useIntent,
        advanceExpenseDeductible: b.advanceExpenseDeductible,
        buildingFundsShare: b.buildingFundsShare,
        earlierYearsTreatment: b.earlierYearsTreatment,
        sourceReferences: b.sourceReferences,
        notes: b.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ record, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        res.setHeader('Location', `/api/v1${base}/${record.id}`);
        send(res.status(201), record);
      })
      .catch(next);
  });

  router.get(base, (req, res, next) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      sendValidationError(res, fieldErrors(query.error));
      return;
    }
    commands
      .list({ principal: principalOf(res), ...definedOf(query.data) })
      .then((records) => res.json({ items: records.map(recordDto) }))
      .catch(next);
  });

  router.get(`${base}/:recordId`, (req, res, next) => {
    const id = readId(req.params['recordId'], 'recordId', res);
    if (id === undefined) return;
    const query = z.object({}).strict().safeParse(req.query);
    if (!query.success) {
      sendValidationError(res, fieldErrors(query.error));
      return;
    }
    commands
      .get({ principal: principalOf(res), id })
      .then(({ record, classifications }) => {
        res.setHeader('ETag', `"${record.version}"`);
        res.json({ ...recordDto(record), classifications: classifications.map(namingDto) });
      })
      .catch(next);
  });

  const change = <B extends z.ZodTypeAny>(
    path: string,
    schema: B,
    run: (input: { principal: ReturnType<typeof principalOf>; id: string; body: z.infer<B>; expectedVersions?: readonly number[] }) => Promise<{
      readonly record: ConstructionPeriodInterest;
    }>,
  ) =>
    router.post(`${base}/:recordId/${path}`, express.json({ limit: '64kb' }), (req, res, next) => {
      const id = readId(req.params['recordId'], 'recordId', res);
      if (id === undefined) return;
      const ifMatch = readIfMatch(req, res);
      if (ifMatch === undefined) return;
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        sendValidationError(res, fieldErrors(parsed.error));
        return;
      }
      run({
        principal: principalOf(res),
        id,
        body: parsed.data as z.infer<B>,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
        .then(({ record }) => send(res, record))
        .catch(next);
    });

  change('amend', amendBody, ({ body, ...rest }) => commands.amend({ ...rest, changes: definedOf(body) }));
  change('confirm', confirmBody, ({ body, ...rest }) =>
    commands.confirm({
      ...rest,
      step:
        body.reviewState === 'ADVISOR_CONFIRMED'
          ? { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: body.advisorPartyId as string }
          : { reviewState: 'CONFIRMED', advisorPartyId: null },
    }),
  );
  change('void', voidBody, ({ body, ...rest }) => commands.void({ ...rest, reason: body.reason }));

  return router;
}

const definedOf = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };

function send(res: Response, record: ConstructionPeriodInterest): void {
  res.setHeader('ETag', `"${record.version}"`);
  res.json(recordDto(record));
}

/** A record as the API shows it. */
export function recordDto(r: ConstructionPeriodInterest) {
  return {
    constructionPeriodInterestId: r.id,
    loanId: r.loanId,
    propertyReferenceIds: r.propertyReferenceIds,
    measure: r.measure,
    herstellungFrom: r.herstellungFrom,
    herstellungUntil: r.herstellungUntil,
    useIntent: r.useIntent,
    advanceExpenseDeductible: r.advanceExpenseDeductible,
    buildingFundsShare: `${r.buildingFundsShare.numerator}/${r.buildingFundsShare.denominator}`,
    earlierYearsTreatment: r.earlierYearsTreatment,
    sourceReferences: r.sourceReferences,
    notes: r.notes,
    reviewState: r.reviewState,
    advisorPartyId: r.advisorPartyId,
    status: r.status,
    voidedAt: r.voidedAt?.toISOString() ?? null,
    voidReason: r.voidReason,
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
    updatedAt: r.updatedAt.toISOString(),
    version: r.version,
  };
}

const namingDto = (c: NamingClassification) => ({
  classificationId: c.classificationId,
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: c.splitId,
  treatment: c.treatment,
  reviewState: c.reviewState,
  current: c.current,
});
