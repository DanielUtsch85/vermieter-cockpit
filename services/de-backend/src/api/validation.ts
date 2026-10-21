import type { Request, Response } from 'express';
import { z, type ZodError } from 'zod';
import { Money, MoneyError } from '../shared/index.js';
import { sendError } from './errors.js';

/** DE resource ids (PostgreSQL uuid). */
export const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Client-generated key (api-design.md §15): visible ASCII, bounded length. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

export interface FieldError {
  readonly field: string;
  readonly code: string;
}

export function sendValidationError(res: Response, fields: readonly FieldError[]): void {
  sendError(res, 400, 'VALIDATION_ERROR', 'Validation failed.', { fields });
}

/** zod issues as api-design §90 field errors: a missing field is REQUIRED, anything else INVALID_FORMAT. */
export function fieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    code:
      issue.code === 'custom' && typeof issue.params?.['code'] === 'string'
        ? issue.params['code']
        : issue.code === 'invalid_type' && issue.received === 'undefined'
          ? 'REQUIRED'
          : 'INVALID_FORMAT',
  }));
}

/**
 * The optional `Idempotency-Key` header: `{ key }` (key undefined when absent),
 * or `undefined` after answering 400 for a malformed one.
 */
export function readIdempotencyKey(req: Request, res: Response): { key: string | undefined } | undefined {
  const header = req.headers['idempotency-key'];
  if (header === undefined) return { key: undefined };
  if (typeof header === 'string' && IDEMPOTENCY_KEY.test(header)) return { key: header };
  sendValidationError(res, [{ field: 'Idempotency-Key', code: 'INVALID_FORMAT' }]);
  return undefined;
}

/** One entity tag of `If-Match` (RFC 9110 §8.8.3): `"…"`, optionally weak (`W/"…"`). */
const ENTITY_TAG = /^(W\/)?"([\x21\x23-\x7e]*)"$/;
const VERSION_TAG = /^\d{1,9}$/;

/**
 * The optional `If-Match` header (api-design.md §16.1, RFC 9110 §13.1.1) as the versions it names: `{ versions }`,
 * undefined when absent or `*`. A list matches if any of its tags does; `If-Match` compares strongly, so weak tags and
 * tags that are not a version never match and add nothing (an empty list then fails the check). Answers 400 and
 * returns `undefined` for a header that is not a list of entity tags.
 */
export function readIfMatch(req: Request, res: Response): { versions: readonly number[] | undefined } | undefined {
  const header = req.headers['if-match'];
  if (header === undefined || header.trim() === '*') return { versions: undefined };
  const versions: number[] = [];
  for (const entry of header.split(',')) {
    const tag = ENTITY_TAG.exec(entry.trim());
    if (tag === null) {
      sendValidationError(res, [{ field: 'If-Match', code: 'INVALID_FORMAT' }]);
      return undefined;
    }
    const [, weak, opaque = ''] = tag;
    if (weak === undefined && VERSION_TAG.test(opaque)) versions.push(Number(opaque));
  }
  return { versions };
}

/** Field codes for amounts (api-design.md §31.1: 400 for each). */
const MONEY_CODES: Record<MoneyError['code'], string> = {
  INVALID_AMOUNT: 'INVALID_FORMAT',
  AMOUNT_OUT_OF_RANGE: 'AMOUNT_OUT_OF_RANGE',
  SCALE_EXCEEDED: 'SCALE_EXCEEDED',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
};

/**
 * Money arrives as `{ amount: "1250.00", currency: "EUR" }` (api-design.md §86).
 * The amount must be a decimal string, never a JSON number (no float in transit),
 * non-negative (the sign is `direction`, data-model.md §17.4) and representable
 * in the currency's scale — rejected, never rounded.
 */
export const money = z.object({ amount: z.string(), currency: z.string() }).transform((value, ctx) => {
  try {
    const parsed = Money.of(value.amount, value.currency);
    if (parsed.isNegative()) {
      ctx.addIssue({ code: 'custom', path: ['amount'], params: { code: 'NEGATIVE_AMOUNT' } });
      return z.NEVER;
    }
    return parsed;
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    const path = error.code === 'UNSUPPORTED_CURRENCY' ? ['currency'] : ['amount'];
    ctx.addIssue({ code: 'custom', path, params: { code: MONEY_CODES[error.code] } });
    return z.NEVER;
  }
});
