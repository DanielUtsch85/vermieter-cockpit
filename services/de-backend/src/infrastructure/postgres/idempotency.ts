import type { Transaction } from 'kysely';
import type { Database } from './schema.js';

/**
 * `Idempotency-Key` store (api-design.md §15), shared by all commands that accept one.
 *
 * Call inside the transaction that creates the resource, and set its isolation
 * level to READ COMMITTED: the INSERT claims the key, a concurrent claim of the
 * same key waits on the primary key until the first transaction commits, and the
 * SELECT that follows (a new statement, new snapshot) then sees that winner.
 */
export type IdempotencyClaim =
  /** The key is new: create the resource, then `recordIdempotentResource`. */
  | { readonly kind: 'CLAIMED' }
  /** Same key, same payload: the resource an earlier request created. */
  | { readonly kind: 'REPLAY'; readonly resourceId: string }
  /** Same key, different payload. */
  | { readonly kind: 'CONFLICT' };

export interface IdempotencyKeyRef {
  readonly mreRealmId: string;
  /** The command, e.g. `financial-account.create`: keys never collide across commands. */
  readonly scope: string;
  readonly key: string;
}

export async function claimIdempotencyKey(
  trx: Transaction<Database>,
  ref: IdempotencyKeyRef,
  fingerprint: string,
): Promise<IdempotencyClaim> {
  const claimed = await trx
    .insertInto('idempotency_key')
    .values({ mre_realm_id: ref.mreRealmId, scope: ref.scope, key: ref.key, request_fingerprint: fingerprint })
    .onConflict((oc) => oc.columns(['mre_realm_id', 'scope', 'key']).doNothing())
    .returning('key')
    .executeTakeFirst();
  if (claimed !== undefined) return { kind: 'CLAIMED' };

  const existing = await trx
    .selectFrom('idempotency_key')
    .select(['request_fingerprint', 'resource_id'])
    .where('mre_realm_id', '=', ref.mreRealmId)
    .where('scope', '=', ref.scope)
    .where('key', '=', ref.key)
    .executeTakeFirstOrThrow();
  if (existing.request_fingerprint !== fingerprint) return { kind: 'CONFLICT' };
  // Set in the claiming transaction before it committed, so never null here.
  if (existing.resource_id === null) throw new Error(`idempotency key ${ref.scope}/${ref.key} has no resource`);
  return { kind: 'REPLAY', resourceId: existing.resource_id };
}

/** Binds a claimed key to the resource created for it (same transaction as the claim). */
export async function recordIdempotentResource(
  trx: Transaction<Database>,
  ref: IdempotencyKeyRef,
  resourceId: string,
): Promise<void> {
  await trx
    .updateTable('idempotency_key')
    .set({ resource_id: resourceId })
    .where('mre_realm_id', '=', ref.mreRealmId)
    .where('scope', '=', ref.scope)
    .where('key', '=', ref.key)
    .execute();
}
