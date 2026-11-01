import { AccessError, ConcurrentUpdateError, IdempotencyKeyConflictError, MreUnavailableError, VersionConflictError } from '../../application/index.js';
import { access, answer, on } from './answer.js';

/** The answers to errors every module can throw: access, concurrency, idempotency, MRE (part of the central table, `../error-answers.ts`). */
export const COMMON_ANSWERS = [
  on(AccessError, (error) => access(error.code)),
  on(ConcurrentUpdateError, () => ({
    ...answer(503, 'CONCURRENT_UPDATE', 'The data kept changing concurrently; nothing was written. Retry.'),
    headers: { 'Retry-After': '1' },
  })),
  on(IdempotencyKeyConflictError, () => answer(409, 'CONFLICT', 'Idempotency-Key was already used with a different payload.')),
  on(MreUnavailableError, () => answer(503, 'EXTERNAL_SYSTEM_ERROR', 'MRE is unavailable; nothing was written.')),
  on(VersionConflictError, (error) =>
    answer(412, 'VERSION_CONFLICT', 'The resource changed since the version given in If-Match.', {
      expectedVersions: error.expectedVersions,
      currentVersion: error.currentVersion,
    }),
  ),
];
