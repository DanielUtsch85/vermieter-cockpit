import express, { type Response, type Router } from 'express';
import { z } from 'zod';
import {
  CLOSING_REASONS,
  LOAN_STATUSES,
  debtFrom,
  loanFieldErrors,
  type AmendLoan,
  type CloseLoan,
  type CreateLoan,
  type GetLoan,
  type ListLoans,
  type Loan,
  type LoanChanges,
  type VoidLoan,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { principalOf } from './access-middleware.js';
import { businessDate, definedOnly, optionalText, readId } from './acquisitions.js';
import { RESOURCE_ID, fieldErrors, money, readIdempotencyKey, readIfMatch, sendValidationError } from './validation.js';

const uuid = z
  .string()
  .regex(RESOURCE_ID)
  .transform((id) => id.toLowerCase());

/** 1–20 Parties, no duplicates (`DUPLICATE` at the later position). */
const borrowers = z
  .array(uuid)
  .min(1)
  .max(20)
  .superRefine((ids, ctx) => {
    ids.forEach((id, i) => {
      if (ids.indexOf(id) !== i) ctx.addIssue({ code: 'custom', path: [i], params: { code: 'DUPLICATE' } });
    });
  });

const texts = {
  contractNumber: optionalText(100).nullish(),
  sourceReferences: z.array(optionalText(500)).max(10).optional(),
  notes: optionalText(2000).nullish(),
};

const createBody = z
  .object({
    lenderPartyId: uuid,
    borrowerPartyIds: borrowers,
    principalOriginal: money,
    startDate: businessDate,
    disbursementDate: businessDate.nullish(),
    maturityDate: businessDate.nullish(),
    acquisitionId: uuid.nullish(),
    ...texts,
    // Documents do not exist yet: refused, never stored unchecked (as §33.2).
    documentIds: z.unknown().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.documentIds !== undefined) ctx.addIssue({ code: 'custom', path: ['documentIds'], params: { code: 'NOT_SUPPORTED' } });
    // Refinements run even after a field failed to parse: only check what parsed.
    if (body.principalOriginal instanceof Money && !body.principalOriginal.isPositive()) {
      ctx.addIssue({ code: 'custom', path: ['principalOriginal', 'amount'], params: { code: 'NOT_POSITIVE' } });
    }
    const start = typeof body.startDate === 'string' ? body.startDate : undefined;
    if (start !== undefined && typeof body.disbursementDate === 'string' && body.disbursementDate < start) {
      ctx.addIssue({ code: 'custom', path: ['disbursementDate'], params: { code: 'BEFORE_START_DATE' } });
    }
    if (start !== undefined && typeof body.lenderPartyId === 'string' && Array.isArray(body.borrowerPartyIds)) {
      for (const error of loanFieldErrors({
        lenderPartyId: body.lenderPartyId,
        borrowerPartyIds: body.borrowerPartyIds,
        startDate: start,
        disbursementDate: body.disbursementDate ?? null,
        maturityDate: body.maturityDate ?? null,
      })) {
        ctx.addIssue({ code: 'custom', path: error.field.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)), params: { code: error.code } });
      }
    }
  });

/** Fields fixed after creation (P3-D1): named in an amend, they are `400 NOT_AMENDABLE`, not unknown keys. */
const FIXED = ['principalOriginal', 'startDate', 'disbursementDate', 'acquisitionId'] as const;

const amendBody = z
  .object({
    lenderPartyId: uuid.optional(),
    borrowerPartyIds: borrowers.optional(),
    maturityDate: businessDate.nullable().optional(),
    ...texts,
    ...Object.fromEntries(FIXED.map((field) => [field, z.unknown().optional()])),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (Object.keys(body).length === 0) ctx.addIssue({ code: 'custom', params: { code: 'REQUIRED' } });
    for (const field of FIXED) {
      if (field in body) ctx.addIssue({ code: 'custom', path: [field], params: { code: 'NOT_AMENDABLE' } });
    }
  });

const voidBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

const closeBody = z
  .object({
    closingDate: businessDate,
    reason: z.enum(CLOSING_REASONS),
    refinancedByLoanId: uuid.nullish(),
    closingNote: optionalText(500).nullish(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // Refinements run even after a field failed to parse: only check what parsed.
    const refinanced = body.reason === 'REFINANCED';
    if (refinanced && (body.refinancedByLoanId ?? null) === null) ctx.addIssue({ code: 'custom', path: ['refinancedByLoanId'], params: { code: 'REQUIRED' } });
    if (!refinanced && typeof body.reason === 'string' && (body.refinancedByLoanId ?? null) !== null) {
      ctx.addIssue({ code: 'custom', path: ['refinancedByLoanId'], params: { code: 'NOT_ALLOWED_FOR_REASON' } });
    }
    if (body.reason === 'OTHER' && (body.closingNote ?? null) === null) ctx.addIssue({ code: 'custom', path: ['closingNote'], params: { code: 'REQUIRED' } });
  });

const listQuery = z
  .object({
    status: z.enum(LOAN_STATUSES).optional(),
    partyId: uuid.optional(),
    acquisitionId: uuid.optional(),
    page: z.coerce.number().int().min(1).max(1_000_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export interface LoanCommands {
  readonly create: CreateLoan;
  readonly get: GetLoan;
  readonly list: ListLoans;
  readonly amend: AmendLoan;
  readonly void: VoidLoan;
  readonly close: CloseLoan;
}

/** Loan API (api-design.md §41.1, backlog VC-3-01). */
export function loanRoutes(commands: LoanCommands): Router {
  const router = express.Router();

  router.post('/loans', express.json({ limit: '32kb' }), (req, res, next) => {
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
        lenderPartyId: body.lenderPartyId,
        borrowerPartyIds: body.borrowerPartyIds,
        principalOriginal: body.principalOriginal,
        startDate: body.startDate,
        disbursementDate: body.disbursementDate ?? null,
        maturityDate: body.maturityDate ?? null,
        contractNumber: body.contractNumber ?? null,
        acquisitionId: body.acquisitionId ?? null,
        sourceReferences: (body.sourceReferences ?? []).filter((reference): reference is string => reference !== null),
        notes: body.notes ?? null,
        ...(idempotency.key === undefined ? {} : { idempotencyKey: idempotency.key }),
      })
      .then(({ loan, replayed }) => {
        if (replayed) res.setHeader('Idempotent-Replayed', 'true');
        sendLoan(res.status(201), loan);
      })
      .catch(next);
  });

  router.get('/loans', (req, res, next) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const { page, pageSize, ...filter } = parsed.data;
    commands
      .list({ principal: principalOf(res), filter: definedOnly(filter), page: { page, pageSize } })
      .then((result) => res.json({ ...result, items: result.items.map(toDto) }))
      .catch(next);
  });

  router.get('/loans/:loanId', (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    commands
      .get({ principal: principalOf(res), loanId })
      .then((loan) => sendLoan(res, loan))
      .catch(next);
  });

  router.post('/loans/:loanId/amend', express.json({ limit: '32kb' }), (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = amendBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    const changes: LoanChanges = definedOnly({
      lenderPartyId: body.lenderPartyId,
      borrowerPartyIds: body.borrowerPartyIds,
      maturityDate: body.maturityDate,
      contractNumber: body.contractNumber,
      sourceReferences: body.sourceReferences?.filter((reference): reference is string => reference !== null),
      notes: body.notes,
    });
    commands
      .amend({ principal: principalOf(res), loanId, changes, ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }) })
      .then(({ loan }) => sendLoan(res, loan))
      .catch(next);
  });

  router.post('/loans/:loanId/void', express.json({ limit: '16kb' }), (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
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
        reason: parsed.data.reason,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ loan }) => sendLoan(res, loan))
      .catch(next);
  });

  router.post('/loans/:loanId/close', express.json({ limit: '16kb' }), (req, res, next) => {
    const loanId = readId(req.params['loanId'], 'loanId', res);
    if (loanId === undefined) return;
    const ifMatch = readIfMatch(req, res);
    if (ifMatch === undefined) return;
    const parsed = closeBody.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, fieldErrors(parsed.error));
      return;
    }
    const body = parsed.data;
    if (body.refinancedByLoanId === loanId) {
      sendValidationError(res, [{ field: 'refinancedByLoanId', code: 'SELF_REFERENCE' }]);
      return;
    }
    commands
      .close({
        principal: principalOf(res),
        loanId,
        closingDate: body.closingDate,
        reason: body.reason,
        refinancedByLoanId: body.refinancedByLoanId ?? null,
        closingNote: body.closingNote ?? null,
        ...(ifMatch.versions === undefined ? {} : { expectedVersions: ifMatch.versions }),
      })
      .then(({ loan }) => sendLoan(res, loan))
      .catch(next);
  });

  return router;
}

/** A single Loan with its version as `ETag` for the next `If-Match` (api-design.md §16.1). */
function sendLoan(res: Response, loan: Loan): void {
  res.setHeader('ETag', `"${loan.version}"`);
  res.json(toDto(loan));
}

function toDto(loan: Loan) {
  return {
    loanId: loan.id,
    mreRealmId: loan.mreRealmId,
    status: loan.status,
    lenderPartyId: loan.lenderPartyId,
    borrowerPartyIds: loan.borrowerPartyIds,
    principalOriginal: loan.principalOriginal.toJSON(),
    startDate: loan.startDate,
    disbursementDate: loan.disbursementDate,
    debtFrom: debtFrom(loan),
    maturityDate: loan.maturityDate,
    contractNumber: loan.contractNumber,
    acquisitionId: loan.acquisitionId,
    sourceReferences: loan.sourceReferences,
    notes: loan.notes,
    voidedAt: loan.voidedAt?.toISOString() ?? null,
    voidReason: loan.voidReason,
    closingDate: loan.closingDate,
    closingReason: loan.closingReason,
    refinancedByLoanId: loan.refinancedByLoanId,
    closingNote: loan.closingNote,
    createdAt: loan.createdAt.toISOString(),
    version: loan.version,
  };
}
