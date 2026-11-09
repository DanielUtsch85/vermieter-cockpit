import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  ALLOCATION_BASES,
  ALLOCATION_STATUSES,
  MAX_ALLOCATIONS,
  formatShare,
  parseShare,
  sumsToOne,
  type CreateLoanAllocation,
  type GetLoanAllocationOn,
  type ListLoanAllocations,
  type ListPropertyLoans,
  type LoanAllocationSetView,
  type PropertyLoan,
  type RequestedAllocation,
  type VoidLoanAllocation,
} from '../application/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, optionalText, readId } from './acquisitions.js';
import { fieldErrors, NO_QUERY, readIdempotencyKey, readIfMatch, readQuery, refuseQuery, RESOURCE_ID, sendValidationError } from './validation.js';

const uuid = z
  .string()
  .regex(RESOURCE_ID)
  .transform((id) => id.toLowerCase());

/** §26.1's notation, `0 < n ≤ d ≤ 10000`; input may be unreduced, kept reduced. */
const share = z.string().transform((value, ctx) => {
  const result = parseShare(value);
  if ('share' in result) return { numerator: BigInt(result.share.numerator), denominator: BigInt(result.share.denominator) };
  ctx.addIssue({ code: 'custom', params: { code: result.error } });
  return z.NEVER;
});

/**
 * §58V rule 2: the part outside letting, `0 < share < 1` in §26.1's notation; `0/d` and `1/1` (or `d/d`) are
 * `OUT_OF_RANGE`, the share of a set keeping at least one PropertyReference.
 */
const outsideShare = z.string().transform((value, ctx) => {
  if (/^0\/[1-9][0-9]{0,8}$/.test(value)) {
    ctx.addIssue({ code: 'custom', params: { code: 'OUT_OF_RANGE' } });
    return z.NEVER;
  }
  const result = parseShare(value);
  if ('share' in result && result.share.numerator < result.share.denominator)
    return { numerator: BigInt(result.share.numerator), denominator: BigInt(result.share.denominator) };
  ctx.addIssue({ code: 'custom', params: { code: 'share' in result ? 'OUT_OF_RANGE' : result.error } });
  return z.NEVER;
});

/** §58V rule 4: 1–10 references of 1–500 characters, trimmed. */
export const MAX_USE_EVIDENCE = 10;

const createBody = z
  .object({
    validFrom: businessDate,
    basis: z.enum(ALLOCATION_BASES).default('MANUAL'),
    allocations: z
      .array(z.object({ propertyReferenceId: uuid, share: share.optional(), acquisitionId: uuid.optional() }).strict())
      .min(1)
      .max(MAX_ALLOCATIONS),
    notes: optionalText(2000).nullish(),
    // §58V (Entscheidung des Projektinhabers, 2026-11-07, questions 3–5): MANUAL only, with its evidence.
    outsideLetting: z.object({ share: outsideShare }).strict().nullish(),
    useEvidence: z.array(z.string().trim().min(1).max(500)).min(1).max(MAX_USE_EVIDENCE).nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // Refinements run even after a field failed to parse: only check what parsed.
    const entries = body.allocations;
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ALLOCATIONS || !entries.every((a) => typeof a === 'object' && a !== null))
      return;
    const properties = body.allocations.map((a) => a.propertyReferenceId);
    const acquisitions = body.allocations.map((a) => a.acquisitionId);
    body.allocations.forEach((a, i) => {
      if (properties.indexOf(a.propertyReferenceId) !== i)
        ctx.addIssue({ code: 'custom', path: ['allocations', i, 'propertyReferenceId'], params: { code: 'DUPLICATE' } });
      const [given, other] = body.basis === 'MANUAL' ? (['share', 'acquisitionId'] as const) : (['acquisitionId', 'share'] as const);
      if (a[given] === undefined) ctx.addIssue({ code: 'custom', path: ['allocations', i, given], params: { code: 'REQUIRED' } });
      if (a[other] !== undefined) ctx.addIssue({ code: 'custom', path: ['allocations', i, other], params: { code: 'NOT_ALLOWED_FOR_BASIS' } });
      if (body.basis === 'PURCHASE_PRICE' && a.acquisitionId !== undefined && acquisitions.indexOf(a.acquisitionId) !== i) {
        ctx.addIssue({ code: 'custom', path: ['allocations', i, 'acquisitionId'], params: { code: 'DUPLICATE' } });
      }
    });
    const outside = body.outsideLetting?.share;
    if (body.outsideLetting != null) {
      // §58V rule 3: a price key has no price for private use; a mixed Loan is a MANUAL set.
      if (body.basis === 'PURCHASE_PRICE') ctx.addIssue({ code: 'custom', path: ['outsideLetting'], params: { code: 'NOT_ALLOWED_FOR_BASIS' } });
      // §58V rule 4: the evidence of the use is required with the part.
      if (body.useEvidence == null) ctx.addIssue({ code: 'custom', path: ['useEvidence'], params: { code: 'REQUIRED' } });
    }
    const shares = body.allocations.flatMap((a) => (typeof a?.share?.numerator === 'bigint' ? [a.share] : []));
    // §58V rule 2: the PropertyReferences' shares plus the part outside letting sum to exactly 1/1.
    const outsideShares = typeof outside?.numerator === 'bigint' ? [outside] : [];
    if (body.basis === 'MANUAL' && shares.length === body.allocations.length && !sumsToOne([...shares, ...outsideShares])) {
      ctx.addIssue({ code: 'custom', path: ['allocations'], params: { code: 'SHARE_SUM_NOT_ONE' } });
    }
  });

const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const listQuery = z
  .object({ status: z.enum(ALLOCATION_STATUSES).optional(), asOf: businessDate.optional() })
  // A day's set is one set or none: the status filter belongs to the history only (§41.3).
  .refine((query) => query.asOf === undefined || query.status === undefined, { path: ['status'], params: { code: 'NOT_SUPPORTED' } });

const propertyQuery = z.object({ asOf: businessDate.optional() });

export interface LoanAllocationCommands {
  readonly create: CreateLoanAllocation;
  readonly void: VoidLoanAllocation;
  readonly list: ListLoanAllocations;
  readonly on: GetLoanAllocationOn;
  readonly propertyLoans: ListPropertyLoans;
}

/** Loan allocation sets (api-design.md §41.3, backlog VC-3-03). */
export function loanAllocationRoutes(commands: LoanAllocationCommands): Router {
  const router = express.Router();

  router.post('/loans/:loanId/allocations', express.json({ limit: '64kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    const allocations: RequestedAllocation[] = body.allocations.map((a) => ({
      propertyReferenceId: a.propertyReferenceId,
      share: a.share ?? null,
      acquisitionId: a.acquisitionId ?? null,
    }));
    commands
      .create({
        principal: principalOf(res),
        loanId,
        validFrom: body.validFrom,
        basis: body.basis,
        allocations,
        notes: body.notes ?? null,
        // §58V: only when given, so an old body's request (and fingerprint) is exactly as before.
        ...(body.outsideLetting == null ? {} : { outsideLetting: body.outsideLetting.share }),
        ...(body.useEvidence == null ? {} : { useEvidence: body.useEvidence }),
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ set, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendSet(res.status(201), set);
      })
      .catch(next);
  });

  router.post('/loans/:loanId/allocations/:allocationSetId/void', express.json({ limit: '16kb' }), (req, res, next) => {
    const query = readQuery(NO_QUERY, req);
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const allocationSetId = readId(req.params['allocationSetId'], 'allocationSetId', res);
    if (allocationSetId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    if (refuseQuery(res, query)) return;
    const parsed = voidBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .void({
        principal: principalOf(res),
        loanId,
        allocationSetId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ set }) => sendSet(res, set))
      .catch(next);
  });

  router.get('/loans/:loanId/allocations', (req, res, next) => {
    const parsed = readQuery(listQuery, req);
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    if (refuseQuery(res, parsed)) return;
    const { status, asOf } = parsed.data;
    const principal = principalOf(res);
    (asOf === undefined
      ? commands.list({ principal, loanId, ...(status === undefined ? {} : { status }) }).then((items) => ({ items: items.map(toDto) }))
      : commands.on({ principal, loanId, asOf }).then((set) => ({ asOf, set: set === null ? null : toDto(set) }))
    )
      .then((body) => res.json(body))
      .catch(next);
  });

  router.get('/property-references/:propertyReferenceId/loans', (req, res, next) => {
    const parsed = readQuery(propertyQuery, req);
    const propertyReferenceId = readId(req.params['propertyReferenceId'], 'propertyReferenceId', res);
    if (propertyReferenceId === undefined) return;
    if (refuseQuery(res, parsed)) return;
    commands
      .propertyLoans({ principal: principalOf(res), propertyReferenceId, ...(parsed.data.asOf === undefined ? {} : { asOf: parsed.data.asOf }) })
      .then((items) => res.json({ items: items.map(toPropertyLoanDto) }))
      .catch(next);
  });

  return router;
}

function sendSet(res: Response, set: LoanAllocationSetView): void {
  res.setHeader('ETag', `"${set.version}"`);
  res.json(toDto(set));
}

export function toDto(s: LoanAllocationSetView) {
  return {
    allocationSetId: s.id,
    loanId: s.loanId,
    status: s.status,
    validFrom: s.validFrom,
    validUntil: s.validUntil,
    basis: s.basis,
    allocations: s.allocations.map((a) => ({ propertyReferenceId: a.propertyReferenceId, share: formatShare(a.share), acquisitionId: a.acquisitionId })),
    // §58V rule 10: after allocations; null without.
    outsideLetting: s.outsideLetting == null ? null : { share: formatShare(s.outsideLetting.share) },
    useEvidence: s.useEvidence == null ? null : [...s.useEvidence],
    notes: s.notes,
    voidedAt: s.voidedAt?.toISOString() ?? null,
    voidReason: s.voidReason,
    createdAt: s.createdAt.toISOString(),
    version: s.version,
  };
}

function toPropertyLoanDto(i: PropertyLoan) {
  return {
    loanId: i.loanId,
    status: i.status,
    lenderPartyId: i.lenderPartyId,
    principalOriginal: i.principalOriginal.toJSON(),
    allocationSetId: i.allocationSetId,
    validFrom: i.validFrom,
    validUntil: i.validUntil,
    basis: i.basis,
    share: formatShare(i.share),
    // §58V rule 7: the set's part outside letting, null without.
    outsideLettingShare: i.outsideLettingShare === null ? null : formatShare(i.outsideLettingShare),
  };
}
