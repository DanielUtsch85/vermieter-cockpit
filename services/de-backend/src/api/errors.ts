import type { ErrorRequestHandler, Response } from 'express';
import type { AccessError } from '../application/index.js';
import { access, answerFor, type ErrorAnswer } from './error-answers.js';

/** Error envelope and categories of api-design.md §12–13. */
export function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
}

/** Sends an answer of the error table (or of a route's own refusal), with its headers. */
export function sendAnswer(res: Response, answer: ErrorAnswer): void {
  for (const [name, value] of Object.entries(answer.headers ?? {})) res.setHeader(name, value);
  sendError(res, answer.status, answer.code, answer.message, answer.details);
}

export function sendAccessError(res: Response, code: AccessError['code']): void {
  sendAnswer(res, access(code));
}

/**
 * The error handler: malformed or oversized JSON bodies are client errors; an error of the central table
 * (`error-answers.ts`) gets its answer; anything else is a 500 without internals in the response.
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
  const answer = answerFor(error);
  if (answer !== undefined) {
    sendAnswer(res, answer);
    return;
  }
  sendError(res, 500, 'INTERNAL_ERROR', 'Internal error.');
};
