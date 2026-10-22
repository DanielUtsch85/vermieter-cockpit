/**
 * Refusals shared by several use cases (review on #39): each module raising them imports them from here, not from
 * another use case's module.
 */

/** An `Idempotency-Key` reused with a different payload (api-design.md §15 → 409). */
export class IdempotencyKeyConflictError extends Error {
  override readonly name = 'IdempotencyKeyConflictError';
}

/** `If-Match` named no version that is the current one (→ 412 VERSION_CONFLICT, api-design §16.1). */
export class VersionConflictError extends Error {
  override readonly name = 'VersionConflictError';

  constructor(
    readonly expectedVersions: readonly number[],
    readonly currentVersion: number,
  ) {
    super(`Expected version ${expectedVersions.join(' or ') || '(none)'}, the current version is ${currentVersion}`);
  }
}
