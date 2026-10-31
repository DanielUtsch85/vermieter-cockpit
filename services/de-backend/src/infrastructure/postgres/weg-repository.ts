import type { Kysely } from 'kysely';
import type {
  AmendMembershipOutcome,
  AmendWegOutcome,
  CreateMembershipOutcome,
  CreateWegOutcome,
  EndMembershipOutcome,
  MembershipChanges,
  MembershipFilter,
  NewMembership,
  NewWeg,
  Page,
  PageRequest,
  VoidMembershipOutcome,
  VoidWegOutcome,
  Weg,
  WegChanges,
  WegFilter,
  WegMembership,
  WegRepository,
} from '../../domains/weg/index.js';
import type { AuditActor, BusinessDate } from '../../shared/index.js';
import type { Database } from './schema.js';
import * as memberships from './weg-membership-store.js';
import * as wegs from './weg-store.js';

export { unitsWithMembershipOn } from './weg-membership-store.js';

/**
 * PostgreSQL implementation of the WEG port (api-design.md §49.1–§49.2).
 *
 * One class for the one port, delegating along the domain's cuts: the WEG itself (create, find, list, amend, void) in
 * `weg-store.ts`; its memberships (create, find, list, the unit's history, amend, end, void) and §49.3's
 * `unitsWithMembershipOn` in `weg-membership-store.ts`. The rows, their reads and their mapping are in `weg-rows.ts`.
 */
export class PostgresWegRepository implements WegRepository {
  constructor(private readonly db: Kysely<Database>) {}

  createWeg(weg: NewWeg, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateWegOutcome> {
    return wegs.createWeg(this.db, weg, actor, idempotency);
  }

  findWeg(id: string, mreRealmId: string): Promise<Weg | undefined> {
    return wegs.findWeg(this.db, id, mreRealmId);
  }

  listWegs(mreRealmId: string, filter: WegFilter, page: PageRequest): Promise<Page<Weg>> {
    return wegs.listWegs(this.db, mreRealmId, filter, page);
  }

  amendWeg(id: string, mreRealmId: string, changes: WegChanges, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendWegOutcome> {
    return wegs.amendWeg(this.db, id, mreRealmId, changes, actor, expectedVersions);
  }

  voidWeg(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidWegOutcome> {
    return wegs.voidWeg(this.db, id, mreRealmId, reason, at, actor, expectedVersions);
  }

  createMembership(
    membership: NewMembership,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateMembershipOutcome> {
    return memberships.createMembership(this.db, membership, actor, idempotency);
  }

  findMembership(id: string, mreRealmId: string): Promise<WegMembership | undefined> {
    return memberships.findMembership(this.db, id, mreRealmId);
  }

  listMemberships(wegId: string, mreRealmId: string, filter: MembershipFilter, page: PageRequest): Promise<Page<WegMembership> | undefined> {
    return memberships.listMemberships(this.db, wegId, mreRealmId, filter, page);
  }

  unitHistory(propertyReferenceId: string, mreRealmId: string, page: PageRequest): Promise<Page<WegMembership> | undefined> {
    return memberships.unitHistory(this.db, propertyReferenceId, mreRealmId, page);
  }

  unitOn(propertyReferenceId: string, mreRealmId: string, asOf: BusinessDate): Promise<WegMembership | null | undefined> {
    return memberships.unitOn(this.db, propertyReferenceId, mreRealmId, asOf);
  }

  amendMembership(
    id: string,
    mreRealmId: string,
    changes: MembershipChanges,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<AmendMembershipOutcome> {
    return memberships.amendMembership(this.db, id, mreRealmId, changes, actor, expectedVersions);
  }

  endMembership(
    id: string,
    mreRealmId: string,
    validUntil: BusinessDate,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<EndMembershipOutcome> {
    return memberships.endMembership(this.db, id, mreRealmId, validUntil, actor, expectedVersions);
  }

  voidMembership(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidMembershipOutcome> {
    return memberships.voidMembership(this.db, id, mreRealmId, reason, at, actor, expectedVersions);
  }
}
