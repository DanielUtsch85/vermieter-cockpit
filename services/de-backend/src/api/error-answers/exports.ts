import { ExportTooLargeError } from '../../application/index.js';
import { answer, on } from './answer.js';

/** The answers to the export module's errors (part of the central table, `../error-answers.ts`; api-design.md §58S). */
export const EXPORT_ANSWERS = [
  on(ExportTooLargeError, (error) =>
    answer(409, 'CONFLICT', 'The export is too large; narrow the filter (e.g. by year).', {
      reason: 'EXPORT_TOO_LARGE',
      total: error.total,
      limit: error.limit,
    }),
  ),
];
