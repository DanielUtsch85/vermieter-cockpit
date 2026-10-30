import type { Kysely, Transaction } from 'kysely';
import {
  planReferenceAmend,
  type AmendReferenceOutcome,
  type CreateReferenceOutcome,
  type NewRentalContractReference,
  type RentDueDay,
  type RentalContractReference,
  type RentalContractReferenceFields,
  type RentalContractReferenceId,
  type RentalContractReferenceRepository,
} from '../../domains/rental-contract-reference/index.js';
import { checkVersion, type AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'RentalContractReference';
const CREATE_SCOPE = 'rental-contract-reference.create';
const COLUMNS = ['id', 'mre_realm_id', 'mre_tenant_id', 'rent_due_days', 'notes', 'source_references', 'created_at', 'created_by', 'version'] as const;

interface ReferenceRow {
  id: string;
  mre_realm_id: string;
  mre_tenant_id: string;
  rent_due_days: unknown;
  notes: string | null;
  source_references: string[];
  created_at: Date;
  created_by: string;
  version: number;
}

/**
 * PostgreSQL implementation of the RentalContractReference port (api-design.md §58A). One reference per MRE Tenant and
 * Realm (`rental_contract_reference_tenant_key`); an amend locks the row only. `rent_due_days` is checked by the
 * database too (`rental_contract_reference_due_days_valid`).
 */
export class PostgresRentalContractReferenceRepository implements RentalContractReferenceRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createReference(
    reference: NewRentalContractReference,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateReferenceOutcome> {
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<CreateReferenceOutcome> => {
        const keyed =
          idempotency === undefined
            ? undefined
            : { ref: { mreRealmId: reference.mreRealmId, scope: CREATE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
        if (keyed !== undefined) {
          const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
          if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
          if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', reference: fromSnapshot(claim.result) };
        }
        // A concurrent create of the same Tenant waits on the unique key and then sees the winner (READ COMMITTED).
        const inserted = await trx
          .insertInto('rental_contract_reference')
          .values({
            mre_realm_id: reference.mreRealmId,
            mre_tenant_id: reference.mreTenantId,
            rent_due_days: JSON.stringify(reference.rentDueDays),
            notes: reference.notes,
            source_references: [...reference.sourceReferences],
            created_by: actor.actorId,
          })
          .onConflict((oc) => oc.columns(['mre_realm_id', 'mre_tenant_id']).doNothing())
          .returning('id')
          .executeTakeFirst();
        if (inserted === undefined) {
          const existing = await trx
            .selectFrom('rental_contract_reference')
            .select('id')
            .where('mre_realm_id', '=', reference.mreRealmId)
            .where('mre_tenant_id', '=', reference.mreTenantId)
            .executeTakeFirstOrThrow();
          // Nothing was written; the claimed key goes with the rollback.
          throw new ReferenceExists(existing.id);
        }
        const created = await readOne(trx, inserted.id);
        await writeAudit(trx, { type: ENTITY_TYPE, id: created.id }, 'CREATED', actor, {
          newVersion: created.version,
          metadata: { mreTenantId: created.mreTenantId, rentDueDays: created.rentDueDays },
        });
        if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, created.id, toSnapshot(created));
        return { kind: 'CREATED', reference: created };
      })
      .catch((error: unknown) => {
        if (error instanceof ReferenceExists) return { kind: 'REFERENCE_EXISTS', rentalContractReferenceId: error.id } as const;
        throw error;
      });
  }

  async amendReference(
    id: string,
    mreRealmId: string,
    requested: Partial<RentalContractReferenceFields>,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<AmendReferenceOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<AmendReferenceOutcome> => {
        const row = await trx
          .selectFrom('rental_contract_reference')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = toDomain(row);
        const changes: RentalContractReferenceFields = {
          rentDueDays: requested.rentDueDays ?? current.rentDueDays,
          notes: requested.notes === undefined ? current.notes : requested.notes,
          sourceReferences: requested.sourceReferences ?? current.sourceReferences,
        };
        const plan = planReferenceAmend(current, changes);
        if (plan.changedFields.length === 0) return { kind: 'AMENDED', reference: current, changed: false };
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('rental_contract_reference')
          .set({
            rent_due_days: JSON.stringify(changes.rentDueDays),
            notes: changes.notes,
            source_references: [...changes.sourceReferences],
            updated_at: new Date(),
            version: current.version + 1,
          })
          .where('id', '=', id)
          .execute();
        const amended = await readOne(trx, id);
        // §58A: the entries changed are listed; VC-7-04 flags each year whose attribution such a correction touched.
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'AMENDED', actor, {
          previousVersion: current.version,
          newVersion: amended.version,
          metadata: { changedFields: plan.changedFields, ...(plan.changedEntries.length === 0 ? {} : { changedEntries: plan.changedEntries }) },
        });
        return { kind: 'AMENDED', reference: amended, changed: true };
      });
  }

  async findReference(id: string, mreRealmId: string): Promise<RentalContractReference | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db
      .selectFrom('rental_contract_reference')
      .select(COLUMNS)
      .where('id', '=', id)
      .where('mre_realm_id', '=', mreRealmId)
      .executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }

  async findByTenant(mreTenantId: string, mreRealmId: string): Promise<RentalContractReference | undefined> {
    const row = await this.db
      .selectFrom('rental_contract_reference')
      .select(COLUMNS)
      .where('mre_tenant_id', '=', mreTenantId)
      .where('mre_realm_id', '=', mreRealmId)
      .executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }
}

class ReferenceExists extends Error {
  constructor(readonly id: string) {
    super('REFERENCE_EXISTS');
  }
}

async function readOne(trx: Transaction<Database>, id: string): Promise<RentalContractReference> {
  return toDomain(await trx.selectFrom('rental_contract_reference').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

function toDomain(row: ReferenceRow): RentalContractReference {
  return {
    id: row.id as RentalContractReferenceId,
    mreRealmId: row.mre_realm_id,
    mreTenantId: row.mre_tenant_id,
    // Checked by `rental_contract_reference_due_days_valid`: an array of `{ validFrom, day }`.
    rentDueDays: row.rent_due_days as RentDueDay[],
    notes: row.notes,
    sourceReferences: row.source_references,
    createdAt: row.created_at,
    createdBy: row.created_by,
    version: row.version,
  };
}

interface ReferenceSnapshot {
  readonly row: Omit<ReferenceRow, 'created_at'> & { readonly created_at: string };
}

function toSnapshot(r: RentalContractReference): ReferenceSnapshot {
  return {
    row: {
      id: r.id,
      mre_realm_id: r.mreRealmId,
      mre_tenant_id: r.mreTenantId,
      rent_due_days: r.rentDueDays,
      notes: r.notes,
      source_references: [...r.sourceReferences],
      created_at: r.createdAt.toISOString(),
      created_by: r.createdBy,
      version: r.version,
    },
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): RentalContractReference {
  const { row } = result as ReferenceSnapshot;
  return toDomain({ ...row, created_at: new Date(row.created_at) });
}
