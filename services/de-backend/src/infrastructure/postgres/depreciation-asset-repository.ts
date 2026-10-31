import type { Kysely } from 'kysely';
import type {
  AmendAssetOutcome,
  AssetAmendment,
  AssetRead,
  AssetStatus,
  ConfirmAssetOutcome,
  ConfirmReviewState,
  CreateAssetOutcome,
  DepreciationAssetRepository,
  NewDepreciationAsset,
  VoidAssetOutcome,
} from '../../domains/depreciation/index.js';
import type { AuditActor, RuleRef } from '../../shared/index.js';
import type { CapitalizedSourcesReader } from './capitalized-items.js';
import { findAsset, listForPropertyReference } from './depreciation-asset-reads.js';
import * as store from './depreciation-asset-store.js';
import type { Database } from './schema.js';

export { depreciationSnapshot, readAsset } from './depreciation-asset-reads.js';

/**
 * PostgreSQL implementation of the DepreciationAsset port (api-design.md §59, §59B, migrations 0049, 0051). Every command
 * is one READ COMMITTED transaction in the lock order of every writer of a PropertyReference (§26.1, §28.1): the key, the
 * PropertyReference (no-op write), the advisors (no lock), the entries' Acquisitions `FOR SHARE` in id order, a
 * separate asset's new items (read and derived through Taxation's derivation, no lock), the asset (`FOR UPDATE`, or the
 * `ACTIVE` building on create). An amend writes its entries and its items as a difference. The reads run in one
 * `REPEATABLE READ READ ONLY` snapshot. Nothing outside the three tables and the AuditRecords is written (P8-D14).
 *
 * One class for the one port, delegating along its cuts: the commands in `depreciation-asset-store.ts`; a separate
 * asset's items (their checks and links, §59B) in `depreciation-separate-assets.ts`; the reads and the snapshot in
 * `depreciation-asset-reads.ts`; the rows, their mapping and the idempotency snapshot in `depreciation-asset-rows.ts`.
 */
export class PostgresDepreciationAssetRepository implements DepreciationAssetRepository {
  private readonly capitalizedSources: CapitalizedSourcesReader | undefined;
  private readonly now: () => Date;

  /**
   * `capitalizedSources` is the tax repository's reader (§59B), passed by the composition root: without it an item of a
   * separate asset cannot be checked, and a command naming one fails loudly instead of linking it unchecked.
   */
  constructor(
    private readonly db: Kysely<Database>,
    options: { readonly capitalizedSources?: CapitalizedSourcesReader; readonly now?: () => Date } = {},
  ) {
    this.capitalizedSources = options.capitalizedSources;
    this.now = options.now ?? (() => new Date());
  }

  create(asset: NewDepreciationAsset, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateAssetOutcome> {
    return store.create(this.db, this.capitalizedSources, this.now, asset, actor, idempotency);
  }

  amend(id: string, mreRealmId: string, amendment: AssetAmendment, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendAssetOutcome> {
    return store.amend(this.db, this.capitalizedSources, this.now, id, mreRealmId, amendment, actor, expectedVersions);
  }

  confirm(
    id: string,
    mreRealmId: string,
    request: { readonly reviewState: ConfirmReviewState; readonly advisorPartyId: string | null; readonly note: string | null },
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ConfirmAssetOutcome> {
    return store.confirm(this.db, id, mreRealmId, request, actor, expectedVersions);
  }

  void(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidAssetOutcome> {
    return store.voidAsset(this.db, id, mreRealmId, reason, at, actor, expectedVersions);
  }

  find(id: string, mreRealmId: string): Promise<AssetRead | undefined> {
    return findAsset(this.db, id, mreRealmId);
  }

  listForPropertyReference(
    propertyReferenceId: string,
    mreRealmId: string,
    statuses: readonly AssetStatus[] | null,
  ): Promise<readonly AssetRead[] | undefined> {
    return listForPropertyReference(this.db, propertyReferenceId, mreRealmId, statuses);
  }

  /** VC-8-01 stores no rule reference: the rate is derived (P8-D1). VC-8-04's recorded versions will. */
  storedRuleReferences(): Promise<readonly RuleRef[]> {
    return Promise.resolve([]);
  }
}
