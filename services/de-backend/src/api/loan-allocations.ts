import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  ALLOCATION_BASES,
  ALLOCATION_STATUSES,
  AcquisitionNotFoundError,
  AllocationNotLastError,
  AllocationRefusedError,
  IdempotencyKeyConflictError,
  LoanAllocationSetNotFoundError,
  LoanNotActiveError,
  LoanNotFoundError,
  MAX_ALLOCATIONS,
  PropertyReferenceNotFoundError,
  VersionConflictError,
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
import { sendError } from './errors.js';
import { RESOURCE_ID, fieldErrors, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

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

const createBody = z
  .object({
    validFrom: businessDate,
    basis: z.enum(ALLOCATION_BASES).default('MANUAL'),
    allocations: z
      .array(z.object({ propertyReferenceId: uuid, share: share.optional(), acquisitionId: uuid.optional() }).strict())
      .min(1)
      .max(MAX_ALLOCATIONS),
    notes: optionalText(2000).nullish(),
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
    const shares = body.allocations.flatMap((a) => (typeof a?.share?.numerator === 'bigint' ? [a.share] : []));
    if (body.basis === 'MANUAL' && shares.length === body.allocations.length && !sumsToOne(shares)) {
      ctx.addIssue({ code: 'custom', path: ['allocations'], params: { code: 'SHARE_SUM_NOT_ONE' } });
    }
  });

const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const listQuery = z
  .object({ status: z.enum(ALLOCATION_STATUSES).optional(), asOf: businessDate.optional() })
  .strict()
  // A day's set is one set or none: the status filter belongs to the history only (§41.3).
  .refine((query) => query.asOf === undefined || query.status === undefined, { path: ['status'], params: { code: 'NOT_SUPPORTED' } });

const propertyQuery = z.object({ asOf: businessDate.optional() }).strict();

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
  const fail = (res: Response, next: (error: unknown) => void) => (error: unknown) => {
    if (!sendAllocationError(res, error)) next(error);
  };

  router.post('/loans/:loanId/allocations', express.json({ limit: '64kb' }), (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const idempotency = readIdempotencyKey(req, res);
    if (idempotency === undefined) return;
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
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ set, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendSet(res.status(201), set);
      })
      .catch(fail(res, next));
  });

  router.post('/loans/:loanId/allocations/:allocationSetId/void', express.json({ limit: '16kb' }), (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const allocationSetId = readId(req.params['allocationSetId'], 'allocationSetId', res);
    if (allocationSetId === undefined) return;
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
        loanId,
        allocationSetId,
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ set }) => sendSet(res, set))
      .catch(fail(res, next));
  });

  router.get('/loans/:loanId/allocations', (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { status, asOf } = parsed.data;
    const principal = principalOf(res);
    (asOf === undefined
      ? commands.list({ principal, loanId, ...(status === undefined ? {} : { status }) }).then((items) => ({ items: items.map(toDto) }))
      : commands.on({ principal, loanId, asOf }).then((set) => ({ asOf, set: set === null ? null : toDto(set) }))
    )
      .then((body) => res.json(body))
      .catch(fail(res, next));
  });

  router.get('/property-references/:propertyReferenceId/loans', (req, res, next) => {
    const propertyReferenceId = readId(req.params['propertyReferenceId'], 'propertyReferenceId', res);
    if (propertyReferenceId === undefined) return;
    const parsed = propertyQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    commands
      .propertyLoans({ principal: principalOf(res), propertyReferenceId, ...(parsed.data.asOf === undefined ? {} : { asOf: parsed.data.asOf }) })
      .then((items) => res.json({ items: items.map(toPropertyLoanDto) }))
      .catch(fail(res, next));
  });

  return router;
}

function sendSet(res: Response, set: LoanAllocationSetView): void {
  res.setHeader('ETag', `"${set.version}"`);
  res.json(toDto(set));
}

/** The refusals of §41.3; false for anything else (→ the error handler). */
function sendAllocationError(res: Response, error: unknown): boolean {
  if (error instanceof LoanNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Loan not found.', { loanId: error.loanId });
  } else if (error instanceof LoanAllocationSetNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Allocation set not found.', { allocationSetId: error.allocationSetId });
  } else if (error instanceof PropertyReferenceNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'PropertyReference not found.', { propertyReferenceId: error.propertyReferenceId });
  } else if (error instanceof AcquisitionNotFoundError) {
    sendError(res, 404, 'NOT_FOUND', 'Acquisition not found for this PropertyReference.', { acquisitionId: error.acquisitionId });
  } else if (error instanceof LoanNotActiveError) {
    sendError(res, 409, 'CONFLICT', `The Loan is ${error.status}; its allocation cannot change.`, { reason: 'LOAN_NOT_ACTIVE', status: error.status });
  } else if (error instanceof AllocationNotLastError) {
    sendError(res, 409, 'CONFLICT', 'Only the last set is voided.', { reason: 'ALLOCATION_NOT_LAST', laterAllocationSetId: error.laterAllocationSetId });
  } else if (error instanceof AllocationRefusedError) {
    const r = error.refusal;
    const details =
      r.kind === 'ALLOCATION_BEFORE_DEBT'
        ? { debtFrom: r.debtFrom }
        : r.kind === 'ALLOCATION_NOT_APPENDED'
          ? { lastValidFrom: r.lastValidFrom }
          : { acquisitionId: r.acquisitionId };
    sendError(res, 422, r.kind, 'The set cannot be appended.', details);
  } else if (error instanceof VersionConflictError) {
    sendError(res, 412, 'VERSION_CONFLICT', 'The set changed since the version given in If-Match.', {
      expectedVersions: error.expectedVersions,
      currentVersion: error.currentVersion,
    });
  } else if (error instanceof IdempotencyKeyConflictError) {
    sendError(res, 409, 'CONFLICT', 'Idempotency-Key was already used with a different payload.');
  } else {
    return false;
  }
  return true;
}

function toDto(s: LoanAllocationSetView) {
  return {
    allocationSetId: s.id,
    loanId: s.loanId,
    status: s.status,
    validFrom: s.validFrom,
    validUntil: s.validUntil,
    basis: s.basis,
    allocations: s.allocations.map((a) => ({ propertyReferenceId: a.propertyReferenceId, share: formatShare(a.share), acquisitionId: a.acquisitionId })),
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
  };
}
