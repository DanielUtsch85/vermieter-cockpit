import type { ErrorRequestHandler, Response } from 'express';
import type { AccessError } from '../application/index.js';

/** Error envelope and categories of api-design.md §12–13. */
export function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
}

const ACCESS: Record<AccessError['code'], { status: number; code: string; message: string }> = {
  UNAUTHENTICATED: { status: 401, code: 'UNAUTHORIZED', message: 'A valid MRE access token is required.' },
  FORBIDDEN: { status: 403, code: 'FORBIDDEN', message: 'No access to this Realm.' },
  AUTH_UNAVAILABLE: { status: 503, code: 'EXTERNAL_SYSTEM_ERROR', message: 'Authentication service unavailable.' },
};

export function sendAccessError(res: Response, code: AccessError['code']): void {
  const mapped = ACCESS[code];
  if (mapped.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
  sendError(res, mapped.status, mapped.code, mapped.message);
}

/**
 * Last-resort handler: malformed or oversized JSON bodies are client errors;
 * anything else is a 500 without internals in the response.
 */
export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  const type = (error as { type?: unknown } | null)?.type;
  if (type === 'entity.parse.failed') {
    sendError(res, 400, 'VALIDATION_ERROR', 'Request body is not valid JSON.');
    return;
  }
  if (type === 'entity.too.large') {
    sendError(res, 413, 'VALIDATION_ERROR', 'Request body is too large.');
    return;
  }
  sendError(res, 500, 'INTERNAL_ERROR', 'Internal error.');
};
