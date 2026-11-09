import type { Response } from 'express';

/**
 * Error envelope and categories of api-design.md §12–13. A module of its own so that `validation.ts` can answer with it
 * while `errors.ts`'s handler reads the query through `validation.ts` (§58W), without an import cycle.
 */
export function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
}
