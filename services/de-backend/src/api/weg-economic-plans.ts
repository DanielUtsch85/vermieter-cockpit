import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  COST_GROUPS,
  PLAN_STATUSES,
  type CreateEconomicPlan,
  type GetEconomicPlan,
  type GetHausgeldProposal,
  type HausgeldProposal,
  type ListEconomicPlans,
  type PlanFlag,
  type PlanView,
  type VoidEconomicPlan,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, definedOnly, optionalText, readId } from './acquisitions.js';
import { RESOURCE_ID, fieldErrors, money, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const uuid = z
  .string()
  .regex(RESOURCE_ID)
  .transform((id) => id.toLowerCase());

const costLine = z
  .object({
    position: z.number().int().min(1).max(1000),
    description: z.string().trim().min(1).max(200),
    allocationKey: z.string().trim().min(1).max(100),
    totalAmount: money,
    unitShare: money,
    group: z.enum(COST_GROUPS),
  })
  .strict();

const planBody = z
  .object({
    financialYear: z.number().int().min(1900).max(2200),
    effectiveFrom: businessDate,
    resolutionDate: businessDate.nullish(),
    monthlyHausgeld: money,
    monthlyReserveContribution: money,
    recoverableCosts: money,
    nonRecoverableCosts: money,
    income: money.nullish(),
    annualReserveContribution: money.nullish(),
    costLines: z.array(costLine).max(100).optional(),
    sourceReferences: z.array(optionalText(500)).max(10).optional(),
    notes: optionalText(2000).nullish(),
    documentId: z.unknown().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.documentId !== undefined) ctx.addIssue({ code: 'custom', path: ['documentId'], params: { code: 'NOT_SUPPORTED' } });
    // Refinements run even after a field failed to parse: only check what parsed.
    if (body.monthlyHausgeld instanceof Money && body.monthlyReserveContribution instanceof Money) {
      if (!body.monthlyHausgeld.isPositive() && !body.monthlyReserveContribution.isPositive()) {
        ctx.addIssue({ code: 'custom', path: ['monthlyHausgeld', 'amount'], params: { code: 'NOT_POSITIVE' } });
      }
    }
    (body.costLines ?? []).forEach((line, i, lines) => {
      if (lines.findIndex((other) => other.position === line.position) !== i) {
        ctx.addIssue({ code: 'custom', path: ['costLines', i, 'position'], params: { code: 'DUPLICATE' } });
      }
    });
  });

const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const listQuery = z
  .object({
    status: z
      .string()
      .transform((value) => value.split(','))
      .pipe(z.array(z.enum(PLAN_STATUSES)).min(1))
      .optional(),
    financialYear: z.coerce.number().int().min(1900).max(2200).optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const proposalQuery = z.object({ propertyReferenceId: uuid.optional() }).strict();

export interface WegEconomicPlanCommands {
  readonly create: CreateEconomicPlan;
  readonly get: GetEconomicPlan;
  readonly list: ListEconomicPlans;
  readonly void: VoidEconomicPlan;
  readonly hausgeldProposal: GetHausgeldProposal;
}

/** Wirtschaftsplan and Hausgeld proposal API (api-design.md §49.5–§49.6, backlog VC-6-02). */
export function wegEconomicPlanRoutes(commands: WegEconomicPlanCommands): Router {
  const router = express.Router();

  router.post('/weg-memberships/:membershipId/economic-plans', express.json({ limit: '64kb' }), (req, res, next) => {
    const membershipId = readId(req.params['membershipId'], 'membershipId', res);
    if (membershipId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    const parsed = planBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    commands
      .create({
        principal: principalOf(res),
        membershipId,
        financialYear: body.financialYear,
        effectiveFrom: body.effectiveFrom,
        resolutionDate: body.resolutionDate ?? null,
        monthlyHausgeld: body.monthlyHausgeld,
        monthlyReserveContribution: body.monthlyReserveContribution,
        recoverableCosts: body.recoverableCosts,
        nonRecoverableCosts: body.nonRecoverableCosts,
        income: body.income ?? null,
        annualReserveContribution: body.annualReserveContribution ?? null,
        costLines: body.costLines ?? [],
        sourceReferences: (body.sourceReferences ?? []).filter((reference): reference is string => reference !== null),
        notes: body.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ plan, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendPlan(res.status(201), plan);
      })
      .catch(next);
  });

  router.get('/weg-memberships/:membershipId/economic-plans', (req, res, next) => {
    const membershipId = readId(req.params['membershipId'], 'membershipId', res);
    if (membershipId === undefined) return;
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { page, pageSize, status, financialYear } = parsed.data;
    commands
      .list({ principal: principalOf(res), membershipId, filter: definedOnly({ statuses: status, financialYear }), page: { page, pageSize } })
      .then((result) => res.json({ ...result, items: result.items.map(planDto) }))
      .catch(next);
  });

  router.get('/weg-economic-plans/:planId', (req, res, next) => {
    const economicPlanId = readId(req.params['planId'], 'planId', res);
    if (economicPlanId === undefined) return;
    commands
      .get({ principal: principalOf(res), economicPlanId })
      .then((plan) => sendPlan(res, plan))
      .catch(next);
  });

  router.post('/weg-economic-plans/:planId/void', express.json({ limit: '16kb' }), (req, res, next) => {
    const economicPlanId = readId(req.params['planId'], 'planId', res);
    if (economicPlanId === undefined) return;
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
        economicPlanId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ plan }) => sendPlan(res, plan))
      .catch(next);
  });

  router.get('/transactions/:transactionId/hausgeld-proposal', (req, res, next) => {
    const transactionId = readId(req.params['transactionId'], 'transactionId', res);
    if (transactionId === undefined) return;
    const parsed = proposalQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .hausgeldProposal({ principal: principalOf(res), transactionId, propertyReferenceId: parsed.data.propertyReferenceId ?? null })
      .then((proposal) => res.json(proposalDto(proposal)))
      .catch(next);
  });

  return router;
}

function sendPlan(res: Response, plan: PlanView): void {
  res.setHeader('ETag', `"${plan.version}"`);
  res.json(planDto(plan));
}

/** Money in details as JSON; everything else as it is. */
const detailsDto = (details: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(details).map(([key, value]) => [key, value instanceof Money ? value.toJSON() : value]));

const flagDto = (flag: { readonly code: string; readonly details: Record<string, unknown> }) => ({ code: flag.code, details: detailsDto(flag.details) });

function planDto(plan: PlanView) {
  return {
    economicPlanId: plan.id,
    mreRealmId: plan.mreRealmId,
    membershipId: plan.membershipId,
    financialYear: plan.financialYear,
    effectiveFrom: plan.effectiveFrom,
    resolutionDate: plan.resolutionDate,
    monthlyHausgeld: plan.monthlyHausgeld.toJSON(),
    monthlyReserveContribution: plan.monthlyReserveContribution.toJSON(),
    recoverableCosts: plan.recoverableCosts.toJSON(),
    nonRecoverableCosts: plan.nonRecoverableCosts.toJSON(),
    income: plan.income?.toJSON() ?? null,
    annualReserveContribution: plan.annualReserveContribution?.toJSON() ?? null,
    costLines: plan.costLines.map((line) => ({ ...line, totalAmount: line.totalAmount.toJSON(), unitShare: line.unitShare.toJSON() })),
    components: {
      recoverable: plan.components.recoverable.toJSON(),
      nonRecoverable: plan.components.nonRecoverable.toJSON(),
      reserve: plan.components.reserve.toJSON(),
    },
    flags: plan.flags.map((flag: PlanFlag) => flagDto(flag)),
    status: plan.status,
    voidedAt: plan.voidedAt?.toISOString() ?? null,
    voidReason: plan.voidReason,
    sourceReferences: plan.sourceReferences,
    notes: plan.notes,
    createdAt: plan.createdAt.toISOString(),
    version: plan.version,
  };
}

function proposalDto(proposal: HausgeldProposal) {
  return {
    transactionId: proposal.transactionId,
    bookingDate: proposal.bookingDate,
    amount: proposal.amount.toJSON(),
    propertyReferenceId: proposal.propertyReferenceId,
    membershipId: proposal.membershipId,
    economicPlanId: proposal.economicPlanId,
    case: proposal.case,
    splits: proposal.splits.map((s) => ({
      financialCategoryCode: s.financialCategoryCode,
      propertyReferenceId: s.propertyReferenceId,
      amount: s.amount.toJSON(),
    })),
    flags: proposal.flags.map((flag) => flagDto(flag)),
  };
}
