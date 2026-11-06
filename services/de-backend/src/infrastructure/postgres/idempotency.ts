import { sql, type Transaction } from 'kysely';
import { IDEMPOTENCY_RETENTION_MS } from './idempotency-retention.js';
import type { Database } from './schema.js';

/**
 * `Idempotency-Key` store (api-design.md §15), shared by all commands that accept one.
 *
 * Call inside the transaction that creates the resource, and set its isolation
 * level to READ COMMITTED: the INSERT claims the key, a concurrent claim of the
 * same key waits on the primary key until the first transaction commits, and the
 * SELECT that follows (a new statement, new snapshot) then sees that winner.
 *
 * A replay answers with the result **as recorded when the key was first used**,
 * never with the resource's current state: a retried create gets the same
 * answer as the original, even after the resource changed since.
 *
 * VC-X-12 (api-design.md §15 "Retention"): a key expires seven days after its
 * creation, and a request with an expired key is a new request, whatever its
 * payload. Before the INSERT the claim deletes the key's row if it is expired
 * (on the transaction's clock, `now()`, the one that stamped `created_at`), so an
 * expired row the cleanup has not reached yet is never replayed. Concurrent
 * requests with one expired key: the first DELETE locks the row; the others'
 * DELETE waits on that lock and, once the first commits, finds the row gone (0
 * rows) — they then meet the first's fresh row at the INSERT exactly as with a
 * new key and replay its result; if the first rolls back, the next one deletes
 * the expired row itself. A fresh row a concurrent claim just inserted is never
 * deleted (not expired, and invisible to the DELETE's snapshot). So exactly one
 * request executes. Under REPEATABLE READ (two callers) the waiting DELETE ends
 * in a serialization failure instead, which those callers already answer; never
 * a second execution.
 */
export type IdempotencyClaim =
  /** The key is new: create the resource, then `recordIdempotentResult`. */
  | { readonly kind: 'CLAIMED' }
  /** Same key, same payload: the result the first request recorded (JSON, as stored). */
  | { readonly kind: 'REPLAY'; readonly result: unknown }
  /** Same key, different payload. */
  | { readonly kind: 'CONFLICT' };

export interface IdempotencyKeyRef {
  readonly mreRealmId: string;
  /** The command, e.g. `financial-account.create`: keys never collide across commands. */
  readonly scope: string;
  readonly key: string;
}

/** `created_at` at or before this is expired, on the transaction's clock. */
const expiredBefore = () => sql<Date>`now() - make_interval(secs => ${IDEMPOTENCY_RETENTION_MS / 1000}::double precision)`;

export async function claimIdempotencyKey(trx: Transaction<Database>, ref: IdempotencyKeyRef, fingerprint: string): Promise<IdempotencyClaim> {
  // VC-X-12: an expired key is a new request; its row (and result snapshot) goes before the claim, under its row lock.
  await trx
    .deleteFrom('idempotency_key')
    .where('mre_realm_id', '=', ref.mreRealmId)
    .where('scope', '=', ref.scope)
    .where('key', '=', ref.key)
    .where('created_at', '<=', expiredBefore())
    .execute();
  const claimed = await trx
    .insertInto('idempotency_key')
    .values({ mre_realm_id: ref.mreRealmId, scope: ref.scope, key: ref.key, request_fingerprint: fingerprint })
    .onConflict((oc) => oc.columns(['mre_realm_id', 'scope', 'key']).doNothing())
    .returning('key')
    .executeTakeFirst();
  if (claimed !== undefined) return { kind: 'CLAIMED' };

  const existing = await trx
    .selectFrom('idempotency_key')
    .select(['request_fingerprint', 'result'])
    .where('mre_realm_id', '=', ref.mreRealmId)
    .where('scope', '=', ref.scope)
    .where('key', '=', ref.key)
    .executeTakeFirstOrThrow();
  if (existing.request_fingerprint !== fingerprint) return { kind: 'CONFLICT' };
  // Recorded in the claiming transaction before it committed, so never null here.
  if (existing.result === null) throw new Error(`idempotency key ${ref.scope}/${ref.key} has no recorded result`);
  return { kind: 'REPLAY', result: existing.result };
}

/**
 * The key as a read-only precheck sees it (a create's precheck before an external call): `undefined` when it is unknown,
 * expired (VC-X-12: a new request) or claimed by a request still running with the same payload (create decides).
 */
export async function peekIdempotencyKey(
  trx: Transaction<Database>,
  ref: IdempotencyKeyRef,
  fingerprint: string,
): Promise<Exclude<IdempotencyClaim, { kind: 'CLAIMED' }> | undefined> {
  const existing = await trx
    .selectFrom('idempotency_key')
    .select(['request_fingerprint', 'result'])
    .where('mre_realm_id', '=', ref.mreRealmId)
    .where('scope', '=', ref.scope)
    .where('key', '=', ref.key)
    .where('created_at', '>', expiredBefore())
    .executeTakeFirst();
  if (existing === undefined) return undefined;
  if (existing.request_fingerprint !== fingerprint) return { kind: 'CONFLICT' };
  return existing.result === null ? undefined : { kind: 'REPLAY', result: existing.result };
}

/** Binds a claimed key to the created resource and its result (same transaction as the claim). */
export async function recordIdempotentResult(trx: Transaction<Database>, ref: IdempotencyKeyRef, resourceId: string, result: unknown): Promise<void> {
  await trx
    .updateTable('idempotency_key')
    .set({ resource_id: resourceId, result: JSON.stringify(result) })
    .where('mre_realm_id', '=', ref.mreRealmId)
    .where('scope', '=', ref.scope)
    .where('key', '=', ref.key)
    .execute();
}
