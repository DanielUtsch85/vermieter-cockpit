import type { Kysely } from 'kysely';
import type {
  AmendDepositOutcome,
  CloseDepositOutcome,
  CloseRequest,
  CreateDepositOutcome,
  CreatePrecheck,
  DepositChanges,
  DepositFilter,
  DepositPage,
  DepositRequest,
  DepositView,
  NewDeposit,
  ReopenDepositOutcome,
  SecurityDepositRepository,
  VoidDepositOutcome,
} from '../../domains/security-deposit/index.js';
import type { AuditActor } from '../../shared/index.js';
import type { Database } from './schema.js';
import * as closing from './security-deposit-closing.js';
import * as store from './security-deposit-store.js';

export { lockDepositsOf } from './security-deposit-rows.js';

/**
 * PostgreSQL implementation of the SecurityDeposit port (api-design.md §47.1).
 *
 * One class for the one port, delegating along the domain's cuts: the record (the precheck, create, find, list, amend,
 * void) in `security-deposit-store.ts`; its closing (§47.4's close and reopen) in `security-deposit-closing.ts`. The
 * rows, their mapping, the idempotency snapshot, §47.3's counted cash and the deposit locks of a split write (P5-D9)
 * are in `security-deposit-rows.ts`.
 */
export class PostgresSecurityDepositRepository implements SecurityDepositRepository {
  constructor(private readonly db: Kysely<Database>) {}

  createPrecheck(request: DepositRequest, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreatePrecheck> {
    return store.createPrecheck(this.db, request, idempotency);
  }

  create(deposit: NewDeposit, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateDepositOutcome> {
    return store.create(this.db, deposit, actor, idempotency);
  }

  findById(id: string, mreRealmId: string): Promise<DepositView | undefined> {
    return store.findById(this.db, id, mreRealmId);
  }

  list(mreRealmId: string, filter: DepositFilter, page: { readonly page: number; readonly pageSize: number }): Promise<DepositPage> {
    return store.list(this.db, mreRealmId, filter, page);
  }

  amend(id: string, mreRealmId: string, changes: DepositChanges, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendDepositOutcome> {
    return store.amend(this.db, id, mreRealmId, changes, actor, expectedVersions);
  }

  void(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidDepositOutcome> {
    return store.voidDeposit(this.db, id, mreRealmId, reason, at, actor, expectedVersions);
  }

  close(id: string, mreRealmId: string, request: CloseRequest, actor: AuditActor, expectedVersions?: readonly number[]): Promise<CloseDepositOutcome> {
    return closing.close(this.db, id, mreRealmId, request, actor, expectedVersions);
  }

  reopen(id: string, mreRealmId: string, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ReopenDepositOutcome> {
    return closing.reopen(this.db, id, mreRealmId, actor, expectedVersions);
  }
}
