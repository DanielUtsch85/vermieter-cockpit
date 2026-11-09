import type { ErrorRequestHandler, Response } from 'express';
import type { AccessError } from '../application/index.js';
import { access, answerFor, type ErrorAnswer } from './error-answers.js';
import { sendError } from './error-envelope.js';
import { NO_QUERY, readQuery, refuseQuery } from './validation.js';

export { sendError };

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
 * (`error-answers.ts`) gets its answer; anything else is a 500 without internals in the response. A JSON body is parsed
 * before the route's handler runs; its error is answered only once the query is valid (api-design.md §58W rule 5: the
 * body comes after the query), and only a command has a JSON body, which takes no query parameter (`NO_QUERY`).
 */
export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  const type = (error as { type?: unknown } | null)?.type;
  if ((type === 'entity.parse.failed' || type === 'entity.too.large') && refuseQuery(res, readQuery(NO_QUERY, req))) return;
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
