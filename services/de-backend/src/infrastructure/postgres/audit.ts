import type { Transaction } from 'kysely';
import type { AuditActor } from '../../shared/index.js';
import type { Database } from './schema.js';

/**
 * Writes an AuditRecord (data-model.md §57). Always inside the transaction of
 * the change it describes, so a change never exists without its audit trail.
 */
export async function writeAudit(
  trx: Transaction<Database>,
  entity: { readonly type: string; readonly id: string },
  action: string,
  actor: AuditActor,
  details: { previousVersion?: number; newVersion: number; metadata: Record<string, unknown> },
): Promise<void> {
  await trx
    .insertInto('audit_record')
    .values({
      entity_type: entity.type,
      entity_id: entity.id,
      action,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      previous_version: details.previousVersion ?? null,
      new_version: details.newVersion,
      metadata: JSON.stringify(details.metadata),
    })
    .execute();
}
