import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  ASSESSMENT_PURPOSES,
  ASSESSMENT_STATUSES,
  instalmentsRefusal,
  type AmendSpecialAssessment,
  type AssessmentContent,
  type AssessmentView,
  type CreateSpecialAssessment,
  type GetSpecialAssessment,
  type ListSpecialAssessments,
  type ReplaceAssessmentUses,
  type VoidSpecialAssessment,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, definedOnly, optionalText, readId } from './acquisitions.js';
import { fieldErrors, money, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const positive = money.superRefine((m, ctx) => {
  if (m instanceof Money && !m.isPositive()) ctx.addIssue({ code: 'custom', params: { code: 'NOT_POSITIVE' } });
});

const instalment = z.object({ position: z.number().int().min(1).max(1000), dueDate: businessDate, amount: positive }).strict();
const use = z
  .object({ position: z.number().int().min(1).max(1000), date: businessDate, description: z.string().trim().min(1).max(200), unitShare: positive })
  .strict();

/** Positions unique, with `DUPLICATE` at the later one. */
const uniquePositions = (path: string, items: unknown, ctx: z.RefinementCtx) => {
  if (!Array.isArray(items)) return;
  items.forEach((item: { position?: unknown }, i, all: { position?: unknown }[]) => {
    if (all.findIndex((other) => other.position === item.position) !== i)
      ctx.addIssue({ code: 'custom', path: [path, i, 'position'], params: { code: 'DUPLICATE' } });
  });
};

const content = {
  description: z.string().trim().min(1).max(200),
  purpose: z.enum(ASSESSMENT_PURPOSES),
  totalAmount: money.nullish(),
  unitShare: positive,
  instalments: z.array(instalment).min(1).max(24),
  sourceReferences: z.array(optionalText(500)).max(10).optional(),
  notes: optionalText(2000).nullish(),
};

/** The instalments sum to the share and fall due in order (§51A); only checked once both parsed. */
const checkInstalments = (body: { unitShare?: unknown; instalments?: unknown }, ctx: z.RefinementCtx) => {
  uniquePositions('instalments', body.instalments, ctx);
  if (!(body.unitShare instanceof Money) || !Array.isArray(body.instalments)) return;
  const instalments = body.instalments as AssessmentContent['instalments'];
  if (instalments.some((i) => !(i.amount instanceof Money) || typeof i.dueDate !== 'string')) return;
  const refusal = instalmentsRefusal({ unitShare: body.unitShare, instalments });
  if (refusal !== undefined) ctx.addIssue({ code: 'custom', path: ['instalments'], params: { code: refusal } });
};

const createBody = z
  .object({ ...content, resolutionDate: businessDate, documentId: z.unknown().optional() })
  .strict()
  .superRefine((body, ctx) => {
    if (body.documentId !== undefined) ctx.addIssue({ code: 'custom', path: ['documentId'], params: { code: 'NOT_SUPPORTED' } });
    checkInstalments(body, ctx);
  });
const amendBody = z.object(content).strict().superRefine(checkInstalments);
const usesBody = z
  .object({ uses: z.array(use).max(50) })
  .strict()
  .superRefine((body, ctx) => uniquePositions('uses', body.uses, ctx));
const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const asOfQuery = z.object({ asOf: businessDate.optional() }).strict();
const listQuery = z
  .object({
    status: z
      .string()
      .transform((value) => value.split(','))
      .pipe(z.array(z.enum(ASSESSMENT_STATUSES)).min(1))
      .optional(),
    purpose: z
      .string()
      .transform((value) => value.split(','))
      .pipe(z.array(z.enum(ASSESSMENT_PURPOSES)).min(1))
      .optional(),
    asOf: businessDate.optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const contentOf = (body: z.infer<typeof amendBody>): AssessmentContent => ({
  description: body.description,
  purpose: body.purpose,
  totalAmount: body.totalAmount ?? null,
  unitShare: body.unitShare,
  instalments: body.instalments,
  sourceReferences: (body.sourceReferences ?? []).filter((reference): reference is string => reference !== null),
  notes: body.notes ?? null,
});

export interface WegSpecialAssessmentCommands {
  readonly create: CreateSpecialAssessment;
  readonly get: GetSpecialAssessment;
  readonly list: ListSpecialAssessments;
  readonly amend: AmendSpecialAssessment;
  readonly replaceUses: ReplaceAssessmentUses;
  readonly void: VoidSpecialAssessment;
}

/** Sonderumlage API (api-design.md §51A, backlog VC-6-05). */
export function wegSpecialAssessmentRoutes(commands: WegSpecialAssessmentCommands): Router {
  const router = express.Router();

  router.post('/weg-memberships/:membershipId/special-assessments', express.json({ limit: '64kb' }), (req, res, next) => {
    const membershipId = readId(req.params['membershipId'], 'membershipId', res);
    if (membershipId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .create({
        principal: principalOf(res),
        membershipId,
        resolutionDate: parsed.data.resolutionDate,
        ...contentOf(parsed.data),
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ assessment, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendAssessment(res.status(201), assessment);
      })
      .catch(next);
  });

  router.get('/weg-memberships/:membershipId/special-assessments', (req, res, next) => {
    const membershipId = readId(req.params['membershipId'], 'membershipId', res);
    if (membershipId === undefined) return;
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { page, pageSize, status, purpose, asOf } = parsed.data;
    commands
      .list({
        principal: principalOf(res),
        membershipId,
        filter: definedOnly({ statuses: status, purposes: purpose }),
        page: { page, pageSize },
        ...(asOf === undefined ? {} : { asOf }),
      })
      .then((result) =>
        res.json({
          ...result,
          items: result.items.map((a) => {
            const { uses: _uses, payments: _payments, ...item } = assessmentDto(a);
            return item;
          }),
        }),
      )
      .catch(next);
  });

  router.get('/weg-special-assessments/:assessmentId', (req, res, next) => {
    const assessmentId = readId(req.params['assessmentId'], 'assessmentId', res);
    if (assessmentId === undefined) return;
    const parsed = asOfQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .get({ principal: principalOf(res), assessmentId, ...(parsed.data.asOf === undefined ? {} : { asOf: parsed.data.asOf }) })
      .then((assessment) => sendAssessment(res, assessment))
      .catch(next);
  });

  router.post('/weg-special-assessments/:assessmentId/amend', express.json({ limit: '64kb' }), (req, res, next) => {
    const assessmentId = readId(req.params['assessmentId'], 'assessmentId', res);
    if (assessmentId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = amendBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .amend({
        principal: principalOf(res),
        assessmentId,
        value: contentOf(parsed.data),
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ assessment }) => sendAssessment(res, assessment))
      .catch(next);
  });

  router.post('/weg-special-assessments/:assessmentId/void', express.json({ limit: '16kb' }), (req, res, next) => {
    const assessmentId = readId(req.params['assessmentId'], 'assessmentId', res);
    if (assessmentId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = voidBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .void({
        principal: principalOf(res),
        assessmentId,
        value: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ assessment }) => sendAssessment(res, assessment))
      .catch(next);
  });

  router.put('/weg-special-assessments/:assessmentId/uses', express.json({ limit: '64kb' }), (req, res, next) => {
    const assessmentId = readId(req.params['assessmentId'], 'assessmentId', res);
    if (assessmentId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = usesBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .replaceUses({
        principal: principalOf(res),
        assessmentId,
        value: parsed.data.uses,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ assessment }) => sendAssessment(res, assessment))
      .catch(next);
  });

  return router;
}

function sendAssessment(res: Response, assessment: AssessmentView): void {
  res.setHeader('ETag', `"${assessment.version}"`);
  res.json(assessmentDto(assessment));
}

/** Money in details as JSON; everything else as it is. */
const detailsDto = (details: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(details).map(([key, value]) => [key, value instanceof Money ? value.toJSON() : value]));

function assessmentDto(a: AssessmentView) {
  return {
    assessmentId: a.id,
    mreRealmId: a.mreRealmId,
    membershipId: a.membershipId,
    description: a.description,
    resolutionDate: a.resolutionDate,
    purpose: a.purpose,
    totalAmount: a.totalAmount?.toJSON() ?? null,
    unitShare: a.unitShare.toJSON(),
    instalments: a.instalmentsCovered.map((i) => ({
      position: i.position,
      dueDate: i.dueDate,
      amount: i.amount.toJSON(),
      covered: i.covered.toJSON(),
      overdue: i.overdue,
    })),
    uses: a.uses.map((u) => ({ ...u, unitShare: u.unitShare.toJSON() })),
    paid: a.paid.toJSON(),
    outstanding: a.outstanding.toJSON(),
    payments: a.payments.map((p) => ({ ...p, amount: p.amount.toJSON() })),
    status: a.status,
    flags: a.flags.map((flag) => ({ code: flag.code, details: detailsDto(flag.details) })),
    voidedAt: a.voidedAt?.toISOString() ?? null,
    voidReason: a.voidReason,
    sourceReferences: a.sourceReferences,
    notes: a.notes,
    createdAt: a.createdAt.toISOString(),
    version: a.version,
  };
}
