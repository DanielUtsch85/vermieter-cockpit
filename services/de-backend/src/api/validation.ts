import type { Request, Response } from 'express';
import type { ZodError } from 'zod';
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
