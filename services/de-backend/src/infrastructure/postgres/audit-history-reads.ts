import type { Transaction } from 'kysely';
import type { HistoryRecord } from '../../domains/taxation/index.js';
import type { Database } from './schema.js';

/**
 * The AuditRecords of entities already selected in the Realm, by `audit_record_entity_idx` (`audit_record` has no Realm
 * column), in `(occurred_at, id)` order: the histories of §58E, §58G, §58H and §58I (`attribution-reads.ts`,
 * `part-reads.ts`, `mover-reads.ts`).
 */
export async function recordsOf(trx: Transaction<Database>, entityType: string, ids: readonly string[], actions: readonly string[]) {
  if (ids.length === 0) return [];
  return trx
    .selectFrom('audit_record')
    .select(['id', 'entity_id', 'action', 'new_version', 'occurred_at', 'metadata'])
    .where('entity_type', '=', entityType)
    .where('entity_id', 'in', [...ids])
    .where('action', 'in', [...actions])
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();
}

export const history = (records: Awaited<ReturnType<typeof recordsOf>>, id: string): HistoryRecord[] =>
  records.filter((r) => r.entity_id === id).map((r) => ({ auditRecordId: r.id, action: r.action, occurredAt: r.occurred_at }));
