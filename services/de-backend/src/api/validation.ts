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

const VERSION_TAG = /^\d{1,9}$/;

/**
 * The entity tags of an `If-Match` list (RFC 9110 §8.8.3, §5.6.1): `"…"`, optionally weak (`W/"…"`), separated by
 * commas, with empty elements allowed. Read character by character, since a tag may itself contain a comma.
 * Undefined when the header is not such a list.
 */
function entityTags(header: string): { readonly weak: boolean; readonly opaque: string }[] | undefined {
  const tags: { weak: boolean; opaque: string }[] = [];
  let i = 0;
  const skipSpace = () => {
    while (header[i] === ' ' || header[i] === '\t') i++;
  };
  for (;;) {
    skipSpace();
    if (i === header.length) return tags;
    if (header[i] === ',') {
      i++; // an empty list element
      continue;
    }
    const weak = header.startsWith('W/', i);
    if (weak) i += 2;
    if (header[i] !== '"') return undefined;
    const end = header.indexOf('"', i + 1);
    if (end === -1) return undefined;
    const opaque = header.slice(i + 1, end);
    // etagc: %x21 / %x23-7E / obs-text — no control characters, no DEL.
    if (!/^[\x21\x23-\x7e\x80-\xff]*$/.test(opaque)) return undefined;
    tags.push({ weak, opaque });
    i = end + 1;
    skipSpace();
    if (i === header.length) return tags;
    if (header[i] !== ',') return undefined;
    i++;
  }
}

/**
 * The optional `If-Match` header (api-design.md §16.1, RFC 9110 §13.1.1) as the versions it names: `{ versions }`,
 * undefined when absent or `*`. A list matches if any of its tags does; `If-Match` compares strongly, so weak tags and
 * tags that are not a version never match and add nothing (an empty list then fails the check). Answers 400 and
 * returns `undefined` for a header that is not a list of entity tags.
 */
export function readIfMatch(req: Request, res: Response): { versions: readonly number[] | undefined } | undefined {
  const header = req.headers['if-match'];
  if (header === undefined || header.trim() === '*') return { versions: undefined };
  const tags = entityTags(header);
  if (tags === undefined || tags.length === 0) {
    sendValidationError(res, [{ field: 'If-Match', code: 'INVALID_FORMAT' }]);
    return undefined;
  }
  return { versions: tags.filter((t) => !t.weak && VERSION_TAG.test(t.opaque)).map((t) => Number(t.opaque)) };
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

/** Money that may be negative, where the sign is part of the figure (a credit line, an Abrechnungsspitze; api-design.md §50). */
export const signedMoney = z.object({ amount: z.string(), currency: z.string() }).transform((value, ctx) => {
  try {
    return Money.of(value.amount, value.currency);
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    const path = error.code === 'UNSUPPORTED_CURRENCY' ? ['currency'] : ['amount'];
    ctx.addIssue({ code: 'custom', path, params: { code: MONEY_CODES[error.code] } });
    return z.NEVER;
  }
});
