/**
 * Refusals shared by several use cases (review on #39): each module raising them imports them from here, not from
 * another use case's module.
 */

/** An `Idempotency-Key` reused with a different payload (api-design.md §15 → 409). */
export class IdempotencyKeyConflictError extends Error {
  override readonly name = 'IdempotencyKeyConflictError';
}

/** MRE could not be asked (unreachable, timed out, unexpected answer): nothing is written (api-design.md §77 → 503). */
export class MreUnavailableError extends Error {
  override readonly name = 'MreUnavailableError';
}

/**
 * Concurrent writers kept taking the same resource away (e.g. an external reference claimed and ended again on every
 * attempt): the command gave up without writing; the client may retry (→ 503, review on #41).
 */
export class ConcurrentUpdateError extends Error {
  override readonly name = 'ConcurrentUpdateError';
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

/** The Transaction's currency differs from its account's; there is no FX handling (data-model.md §17.7). */
export class CurrencyMismatchError extends Error {
  override readonly name = 'CurrencyMismatchError';

  constructor(
    message: string,
    /** Where, when known: the amount, and the splits by position (1-based), so the API can name the field. */
    readonly where: { readonly amount: boolean; readonly splitPositions: readonly number[] } = { amount: true, splitPositions: [] },
  ) {
    super(message);
  }
}
