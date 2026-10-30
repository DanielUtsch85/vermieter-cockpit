import { type Response } from 'express';
import { z } from 'zod';
import {
  CATEGORY_CODE,
  type CurrencyMismatchError,
  LoanClosedOnError,
  LoanNotActiveError,
  DIRECTIONS,
  checkBusinessDate,
  type TransactionFilter,
  type TransactionPage,
  type TransactionStatus,
  REVIEWABLE_STATUSES,
  TRANSACTION_STATUSES,
  PROVENANCES,
  type Transaction,
  type TransactionSplit,
} from '../application/index.js';
import { sendError } from './errors.js';
import { RESOURCE_ID, money } from './validation.js';

/** The Transaction API's request schemas and response mapping, shared by its route files (api-design.md §30–§35). */

/** `YYYY-MM-DD` within 1900–2100 (api-design.md §88): INVALID_FORMAT or OUT_OF_RANGE. */
export const businessDate = z.string().transform((value, ctx) => {
  const result = checkBusinessDate(value);
  if ('date' in result) return result.date;
  ctx.addIssue({ code: 'custom', params: { code: result.error } });
  return z.NEVER;
});

export const createBody = z.object({
  financialAccountId: z.string().regex(RESOURCE_ID),
  amount: money,
  direction: z.enum(DIRECTIONS),
  bookingDate: businessDate,
  // Explicit null means the same as omitted (the usual JSON idiom for "empty").
  valueDate: businessDate.nullish(),
  description: z.string().trim().max(500).nullish(),
  propertyReferenceId: z.string().regex(RESOURCE_ID).nullish(),
  // RentalContractReference does not exist yet: refuse rather than store an unchecked id.
  rentalContractReferenceId: z.undefined(),
  // Manual creation only; other provenances come from imports (data-model.md §17.6).
  provenance: z.literal('MANUAL').optional(),
});

/** References of a split whose entities do not exist yet (data-model.md §18): refused, not stored unchecked. */
const NOT_YET_SUPPORTED = ['rentalContractReferenceId', 'wegId', 'maintenanceProjectId', 'acquisitionId', 'taxClassificationId'] as const;

export const split = z
  .object({
    amount: money,
    financialCategoryCode: z.string().regex(CATEGORY_CODE),
    propertyReferenceId: z.string().regex(RESOURCE_ID).nullish(),
    // A Loan payment's interest or principal (§41.5); the rest of its rules need the database.
    loanId: z.string().regex(RESOURCE_ID).nullish(),
    // A security deposit's receipt, repayment or interest credit (§47.2); the rest of its rules need the database.
    securityDepositId: z.string().regex(RESOURCE_ID).nullish(),
    // The settlement of a Jahresabrechnung (§51); the rest of its rules need the database.
    wegAnnualStatementId: z.string().regex(RESOURCE_ID).nullish(),
    // A Sonderumlage's payment or refund (§51A); the rest of its rules need the database.
    wegSpecialAssessmentId: z.string().regex(RESOURCE_ID).nullish(),
    description: z.string().trim().max(500).nullish(),
    // A split has no direction of its own: it inherits the Transaction's (§17.4).
    direction: z.undefined(),
    ...Object.fromEntries(NOT_YET_SUPPORTED.map((key) => [key, z.undefined()])),
  })
  .strict()
  // A Loan reaches its properties only through its allocation (§41.3), so never both on one split (§41.5).
  .superRefine((s, ctx) => {
    if (typeof s.loanId === 'string' && typeof s.propertyReferenceId === 'string') {
      ctx.addIssue({ code: 'custom', path: ['propertyReferenceId'], params: { code: 'NOT_ALLOWED_WITH_LOAN' } });
    }
    // A deposit is neither a property's income or cost nor a Loan's cash (BR-DEP-001, §47.2).
    if (typeof s.securityDepositId === 'string') {
      for (const field of ['propertyReferenceId', 'loanId'] as const) {
        if (typeof s[field] === 'string') ctx.addIssue({ code: 'custom', path: [field], params: { code: 'NOT_ALLOWED_WITH_SECURITY_DEPOSIT' } });
      }
    }
    // A settlement is the unit's WEG cash, never a Loan's or a deposit's (§51).
    if (typeof s.wegAnnualStatementId === 'string') {
      for (const field of ['loanId', 'securityDepositId'] as const) {
        if (typeof s[field] === 'string') ctx.addIssue({ code: 'custom', path: [field], params: { code: 'NOT_ALLOWED_WITH_WEG_STATEMENT' } });
      }
    }
    // A Sonderumlage's cash is the unit's WEG cash of its own: never a Loan's, a deposit's or a statement's (§51A).
    if (typeof s.wegSpecialAssessmentId === 'string') {
      for (const field of ['loanId', 'securityDepositId', 'wegAnnualStatementId'] as const) {
        if (typeof s[field] === 'string') ctx.addIssue({ code: 'custom', path: [field], params: { code: 'NOT_ALLOWED_WITH_WEG_ASSESSMENT' } });
      }
    }
  });

type SplitBody = z.infer<typeof split>;

/** A split as the use cases take it: lower-case ids, empty description = none. */
export function toSplitInput(s: SplitBody) {
  return {
    amount: s.amount,
    financialCategoryCode: s.financialCategoryCode,
    propertyReferenceId: s.propertyReferenceId?.toLowerCase() ?? null,
    loanId: s.loanId?.toLowerCase() ?? null,
    securityDepositId: s.securityDepositId?.toLowerCase() ?? null,
    wegAnnualStatementId: s.wegAnnualStatementId?.toLowerCase() ?? null,
    wegSpecialAssessmentId: s.wegSpecialAssessmentId?.toLowerCase() ?? null,
    description: s.description === undefined || s.description === null || s.description === '' ? null : s.description,
  };
}

/** `correct` (api-design.md §35.2): the replacement names only the fields that differ; null clears an optional one. */
export const correctBody = z
  .object({
    reason: z.string().trim().min(1).max(500),
    replacement: z
      .object({
        financialAccountId: z.string().regex(RESOURCE_ID).optional(),
        amount: money.optional(),
        direction: z.enum(DIRECTIONS).optional(),
        bookingDate: businessDate.optional(),
        valueDate: businessDate.nullable().optional(),
        description: z.string().trim().max(500).nullable().optional(),
        propertyReferenceId: z.string().regex(RESOURCE_ID).nullable().optional(),
        splits: z.array(split).min(1).max(100).optional(),
      })
      .strict(),
  })
  .strict();

/** A comma-separated list of known values, any of them (`status`, `provenance`). */
const anyOf = <T extends string>(values: readonly T[]) =>
  z.string().transform((value, ctx) => {
    const items = value.split(',').map((s) => s.trim());
    if (items.some((s) => !(values as readonly string[]).includes(s))) {
      ctx.addIssue({ code: 'custom', params: { code: 'INVALID_FORMAT' } });
      return z.NEVER;
    }
    return items as T[];
  });

/** `GET /transactions` (api-design.md §30.1): filters and page; unknown parameters are refused. */
const listFields = z.object({
  financialAccountId: z.string().regex(RESOURCE_ID).optional(),
  status: anyOf(TRANSACTION_STATUSES).optional(),
  provenance: anyOf(PROVENANCES).optional(),
  reviewable: z.enum(['true']).optional(),
  current: z.enum(['true']).optional(),
  propertyReferenceId: z.string().regex(RESOURCE_ID).optional(),
  financialCategoryCode: z.string().regex(CATEGORY_CODE).optional(),
  bookingDateFrom: businessDate.optional(),
  bookingDateTo: businessDate.optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const dateRange = {
  check: (q: { bookingDateFrom?: string | undefined; bookingDateTo?: string | undefined }) =>
    q.bookingDateFrom === undefined || q.bookingDateTo === undefined || q.bookingDateFrom <= q.bookingDateTo,
  issue: { path: ['bookingDateTo'], params: { code: 'INVALID_RANGE' } },
};

export const listQuery = listFields.strict().refine(dateRange.check, dateRange.issue);

/** `GET /property-references/{id}/transactions`: the same, with the PropertyReference in the path. */
export const propertyReferenceListQuery = listFields.omit({ propertyReferenceId: true }).strict().refine(dateRange.check, dateRange.issue);

type ListQuery = z.infer<typeof listQuery>;

/** The filter of a parsed list query (§30.1). */
export function listFilter(q: Omit<ListQuery, 'propertyReferenceId'> & { propertyReferenceId?: string | undefined }): TransactionFilter {
  // `reviewable=true` is the statuses IMPORTED and UNREVIEWED; with `status` too, both must hold.
  const reviewable: readonly TransactionStatus[] | undefined = q.reviewable === 'true' ? REVIEWABLE_STATUSES : undefined;
  const statuses = q.status !== undefined && reviewable !== undefined ? q.status.filter((s) => reviewable.includes(s)) : (q.status ?? reviewable);
  return {
    ...(q.financialAccountId === undefined ? {} : { financialAccountId: q.financialAccountId.toLowerCase() }),
    ...(statuses === undefined ? {} : { statuses }),
    ...(q.provenance === undefined ? {} : { provenances: q.provenance }),
    ...(q.propertyReferenceId === undefined ? {} : { propertyReferenceId: q.propertyReferenceId.toLowerCase() }),
    ...(q.financialCategoryCode === undefined ? {} : { financialCategoryCode: q.financialCategoryCode }),
    ...(q.bookingDateFrom === undefined ? {} : { bookingDateFrom: q.bookingDateFrom }),
    ...(q.bookingDateTo === undefined ? {} : { bookingDateTo: q.bookingDateTo }),
    ...(q.current === 'true' ? { current: true as const } : {}),
  };
}

/**
 * The fields a replacement's currency mismatch points at (backlog VC-X-18): a requested amount or split by its
 * path; a copied one by the changed `financialAccountId`, whose currency it no longer matches.
 */
export function replacementCurrencyFields(error: CurrencyMismatchError, body: { readonly amount?: unknown; readonly splits?: unknown }) {
  const fields = [
    ...(error.where.amount ? [body.amount === undefined ? 'replacement.financialAccountId' : 'replacement.amount.currency'] : []),
    ...error.where.splitPositions.map((p) => (body.splits === undefined ? 'replacement.financialAccountId' : `replacement.splits.${p - 1}.amount.currency`)),
  ];
  return [...new Set(fields)].map((field) => ({ field, code: 'CURRENCY_MISMATCH' }));
}

export function sendPage(res: Response, result: TransactionPage): void {
  res.json({ items: result.items.map(toDto), page: result.page, pageSize: result.pageSize, total: result.total });
}

/** `amend` (api-design.md §31.3): only the fields to change, at least one; null clears an optional one. */
export const amendBody = z
  .object({
    financialAccountId: z.string().regex(RESOURCE_ID).optional(),
    amount: money.optional(),
    direction: z.enum(DIRECTIONS).optional(),
    bookingDate: businessDate.optional(),
    valueDate: businessDate.nullable().optional(),
    description: z.string().trim().max(500).nullable().optional(),
    propertyReferenceId: z.string().regex(RESOURCE_ID).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'no field to change', params: { code: 'REQUIRED' } });

export const ignoreBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

/** `reverse` (api-design.md §35.9): only the reason. */
export const reverseBody = ignoreBody;

/** The Transaction's version as entity tag, for a later `If-Match` (api-design.md §16). */
export function setVersionTag(res: Response, version: number): void {
  res.setHeader('ETag', `"${version}"`);
}

export function toSplitDto(s: TransactionSplit) {
  return {
    splitId: s.id,
    position: s.position,
    amount: s.amount.toJSON(),
    financialCategoryCode: s.financialCategoryCode,
    propertyReferenceId: s.propertyReferenceId,
    loanId: s.loanId,
    securityDepositId: s.securityDepositId,
    wegAnnualStatementId: s.wegAnnualStatementId ?? null,
    wegSpecialAssessmentId: s.wegSpecialAssessmentId ?? null,
    description: s.description,
  };
}

export function toDto(transaction: Transaction) {
  return {
    transactionId: transaction.id,
    mreRealmId: transaction.mreRealmId,
    financialAccountId: transaction.financialAccountId,
    amount: transaction.amount.toJSON(),
    direction: transaction.direction,
    bookingDate: transaction.bookingDate,
    valueDate: transaction.valueDate,
    description: transaction.description,
    propertyReferenceId: transaction.propertyReferenceId,
    provenance: transaction.provenance,
    status: transaction.status,
    createdAt: transaction.createdAt.toISOString(),
    version: transaction.version,
    confirmedAt: transaction.confirmedAt?.toISOString() ?? null,
    confirmedBy: transaction.confirmedBy,
    correctionOfTransactionId: transaction.correctionOfTransactionId,
    correctionRole: transaction.correctionRole,
    reversalTransactionId: transaction.reversalTransactionId,
    replacementTransactionId: transaction.replacementTransactionId,
    counterpartyNameRaw: transaction.counterpartyNameRaw,
    counterpartyIbanRaw: transaction.counterpartyIbanRaw,
  };
}

/** `splits.0.direction` → NOT_ALLOWED, `splits.0.wegId` → NOT_SUPPORTED. */
export function splitFieldCode(field: string, code: string): string {
  const key = field.split('.').at(-1) ?? '';
  if (key === 'direction') return 'NOT_ALLOWED';
  return (NOT_YET_SUPPORTED as readonly string[]).includes(key) ? 'NOT_SUPPORTED' : code;
}

/** The refusals of §41.5 on a split with `loanId` (splits and `correct`); false for anything else. */
export function sendLoanSplitError(res: Response, error: unknown): boolean {
  if (error instanceof LoanNotActiveError) {
    sendError(res, 409, 'CONFLICT', `The Loan is ${error.status}; no split can name it.`, {
      reason: 'LOAN_NOT_ACTIVE',
      loanId: error.loanId,
      status: error.status,
    });
  } else if (error instanceof LoanClosedOnError) {
    sendLoanClosed(res, error);
  } else {
    return false;
  }
  return true;
}

/** §41.7: a split, or a booking date, after a `CLOSED` Loan's closing date. */
export function sendLoanClosed(res: Response, error: LoanClosedOnError): void {
  sendError(res, 409, 'CONFLICT', `The Loan was closed on ${error.closingDate}; nothing after it can name it.`, {
    reason: 'LOAN_CLOSED',
    loanId: error.loanId,
    closingDate: error.closingDate,
  });
}
