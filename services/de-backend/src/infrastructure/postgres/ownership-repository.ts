import type { Kysely } from 'kysely';
import type {
  ChangeOwnershipOutcome,
  CloseOwnershipOutcome,
  CreateOwnershipOutcome,
  NewOwnership,
  Ownership,
  OwnershipChange,
  OwnershipChangeRepository,
  OwnershipDay,
  OwnershipPage,
  OwnershipRepository,
  VoidOwnershipOutcome,
} from '../../domains/ownership/index.js';
import type { AuditActor, BusinessDate } from '../../shared/index.js';
import * as changes from './ownership-change-store.js';
import * as store from './ownership-store.js';
import type { Database } from './schema.js';

/**
 * PostgreSQL implementation of the Ownership ports (api-design.md §26.1, §26.2).
 *
 * One class for the two ports, delegating along them: the Ownership port (create, find, close, void, the ownership on a
 * day, the history) in `ownership-store.ts`; the OwnershipChange port (§26.2's change) in `ownership-change-store.ts`.
 * The rows, their mapping, the idempotency snapshot, the shared reads and locks and the Acquisition guards are in
 * `ownership-rows.ts`.
 */
export class PostgresOwnershipRepository implements OwnershipRepository, OwnershipChangeRepository {
  constructor(private readonly db: Kysely<Database>) {}

  create(ownership: NewOwnership, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateOwnershipOutcome> {
    return store.create(this.db, ownership, actor, idempotency);
  }

  change(change: OwnershipChange, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<ChangeOwnershipOutcome> {
    return changes.change(this.db, change, actor, idempotency);
  }

  findById(id: string, mreRealmId: string): Promise<Ownership | undefined> {
    return store.findById(this.db, id, mreRealmId);
  }

  close(id: string, mreRealmId: string, validUntil: BusinessDate, actor: AuditActor, expectedVersions?: readonly number[]): Promise<CloseOwnershipOutcome> {
    return store.close(this.db, id, mreRealmId, validUntil, actor, expectedVersions);
  }

  void(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidOwnershipOutcome> {
    return store.voidOwnership(this.db, id, mreRealmId, reason, at, actor, expectedVersions);
  }

  on(propertyReferenceId: string, mreRealmId: string, asOf: BusinessDate): Promise<OwnershipDay | undefined> {
    return store.on(this.db, propertyReferenceId, mreRealmId, asOf);
  }

  history(propertyReferenceId: string, mreRealmId: string, page: { readonly page: number; readonly pageSize: number }): Promise<OwnershipPage | undefined> {
    return store.history(this.db, propertyReferenceId, mreRealmId, page);
  }
}
