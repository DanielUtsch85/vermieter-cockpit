import { sql, type Kysely, type Transaction } from 'kysely';
import {
  checkAllocation,
  type AcquisitionStatus,
  type AllocationMethod,
  type AllocationReviewState,
  type CreateAllocationOutcome,
  type LandBuildingAllocation,
  type LandBuildingAllocationRepository,
  type NewAllocation,
} from '../../domains/acquisition/index.js';
import type { AuditActor, BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'LandBuildingAllocation';
const SCOPE = 'acquisition.allocation.create';

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateAllocationOutcome) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the allocation port (api-design.md §27.3). */
export class PostgresLandBuildingAllocationRepository implements LandBuildingAllocationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(
    allocation: NewAllocation,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateAllocationOutcome> {
    if (!UUID.test(allocation.acquisitionId)) return { kind: 'ACQUISITION_NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateAllocationOutcome> => {
          const ref = { mreRealmId: allocation.mreRealmId, scope: SCOPE, key: idempotency?.key ?? '' };
          if (idempotency !== undefined) {
            const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', allocation: fromSnapshot(claim.result) };
          }
          // The serialising no-op of §27.2: cancel, confirm, cost and payment writes and other allocations wait here.
          const acquisition = await trx
            .updateTable('acquisition')
            .set((eb) => ({ version: eb.ref('version') }))
            .where('id', '=', allocation.acquisitionId)
            .where('mre_realm_id', '=', allocation.mreRealmId)
            .returning(['status', sql<string>`to_char(coalesce(economic_transfer_date, contract_date), 'YYYY-MM-DD')`.as('transfer_date')])
            .executeTakeFirst();
          if (acquisition === undefined) throw new Rejected({ kind: 'ACQUISITION_NOT_FOUND' });
          const advisor = allocation.advisorPartyId;
          if (advisor !== null) {
            const party = await trx
              .selectFrom('party')
              .select('id')
              .where('id', '=', advisor)
              .where('mre_realm_id', '=', allocation.mreRealmId)
              .executeTakeFirst();
            if (party === undefined) throw new Rejected({ kind: 'PARTY_NOT_FOUND', partyId: advisor });
          }
          const current = await trx
            .selectFrom('land_building_allocation')
            .select('id')
            .where('acquisition_id', '=', allocation.acquisitionId)
            .where('superseded_at', 'is', null)
            .executeTakeFirst();
          const refusal = checkAllocation(acquisition.status as AcquisitionStatus, current?.id ?? null, allocation.supersedes);
          if (refusal !== undefined) throw new Rejected(refusal);

          // The old row first: the partial unique index of the current one cannot be deferred (review on #52).
          if (current !== undefined) {
            await trx
              .updateTable('land_building_allocation')
              .set({ superseded_at: sql<Date>`now()` })
              .where('id', '=', current.id)
              .execute();
          }
          const { id } = await trx
            .insertInto('land_building_allocation')
            .values({
              mre_realm_id: allocation.mreRealmId,
              acquisition_id: allocation.acquisitionId,
              total_allocable_amount: toNumericAmount(allocation.totalAllocableAmount),
              land_amount: toNumericAmount(allocation.landAmount),
              building_amount: toNumericAmount(allocation.buildingAmount),
              currency: allocation.totalAllocableAmount.currency,
              method: allocation.method,
              review_state: allocation.reviewState,
              effective_date: allocation.effectiveDate ?? acquisition.transfer_date,
              advisor_party_id: advisor,
              source_references: [...allocation.sourceReferences],
              notes: allocation.notes,
              supersedes_id: current?.id ?? null,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const created = (await allocationsOf(trx, allocation.acquisitionId, id))[0];
          if (created === undefined) throw new Error(`LandBuildingAllocation ${id} vanished`);
          if (idempotency !== undefined) await recordIdempotentResult(trx, ref, id, toSnapshot(created));
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CREATED', actor, {
            newVersion: 1,
            metadata: {
              acquisitionId: allocation.acquisitionId,
              totalAllocableAmount: created.totalAllocableAmount.toJSON(),
              landAmount: created.landAmount.toJSON(),
              buildingAmount: created.buildingAmount.toJSON(),
              method: created.method,
              reviewState: created.reviewState,
              effectiveDate: created.effectiveDate,
              supersedes: created.supersedesId,
            },
          });
          if (current !== undefined) {
            await writeAudit(trx, { type: ENTITY_TYPE, id: current.id }, 'SUPERSEDED', actor, { newVersion: 1, metadata: { supersededById: id } });
          }
          return { kind: 'CREATED', allocation: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  async list(
    acquisitionId: string,
    mreRealmId: string,
  ): Promise<{ readonly current: LandBuildingAllocation | null; readonly items: readonly LandBuildingAllocation[] } | undefined> {
    if (!UUID.test(acquisitionId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const acquisition = await trx
          .selectFrom('acquisition')
          .select('id')
          .where('id', '=', acquisitionId)
          .where('mre_realm_id', '=', mreRealmId)
          .executeTakeFirst();
        if (acquisition === undefined) return undefined;
        const items = await allocationsOf(trx, acquisitionId);
        return { current: items.find((a) => a.current) ?? null, items };
      });
  }
}

/** The Acquisition's allocations (or the one with `onlyId`), newest first, with the derived successor. */
async function allocationsOf(trx: Transaction<Database>, acquisitionId: string, onlyId?: string): Promise<LandBuildingAllocation[]> {
  let query = trx
    .selectFrom('land_building_allocation as a')
    .select([
      'a.id',
      'a.mre_realm_id',
      'a.acquisition_id',
      sql<string>`a.total_allocable_amount::text`.as('total'),
      sql<string>`a.land_amount::text`.as('land'),
      sql<string>`a.building_amount::text`.as('building'),
      'a.currency',
      'a.method',
      'a.review_state',
      sql<string>`to_char(a.effective_date, 'YYYY-MM-DD')`.as('effective_date'),
      'a.advisor_party_id',
      'a.source_references',
      'a.notes',
      'a.supersedes_id',
      'a.superseded_at',
      'a.created_at',
      sql<string | null>`(SELECT s.id FROM land_building_allocation s WHERE s.supersedes_id = a.id)`.as('superseded_by_id'),
    ])
    .where('a.acquisition_id', '=', acquisitionId);
  if (onlyId !== undefined) query = query.where('a.id', '=', onlyId);
  const rows = await query.orderBy('a.created_at', 'desc').orderBy('a.id', 'desc').execute();
  return rows.map((row) => {
    const total = fromNumericAmount(row.total, row.currency);
    const land = fromNumericAmount(row.land, row.currency);
    const building = fromNumericAmount(row.building, row.currency);
    return {
      id: row.id,
      mreRealmId: row.mre_realm_id,
      acquisitionId: row.acquisition_id,
      totalAllocableAmount: total,
      landAmount: land,
      buildingAmount: building,
      method: row.method as AllocationMethod,
      reviewState: row.review_state as AllocationReviewState,
      effectiveDate: row.effective_date as BusinessDate,
      advisorPartyId: row.advisor_party_id,
      sourceReferences: row.source_references,
      notes: row.notes,
      supersedesId: row.supersedes_id,
      supersededAt: row.superseded_at,
      supersededById: row.superseded_by_id,
      current: row.superseded_at === null,
      createdAt: row.created_at,
    };
  });
}

/** The created allocation as JSON for the idempotency store: Money as `{ amount, currency }`, timestamps ISO. */
function toSnapshot(a: LandBuildingAllocation): unknown {
  return {
    ...a,
    totalAllocableAmount: a.totalAllocableAmount.toJSON(),
    landAmount: a.landAmount.toJSON(),
    buildingAmount: a.buildingAmount.toJSON(),
    supersededAt: a.supersededAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): LandBuildingAllocation {
  type MoneyJson = { amount: string; currency: string };
  const s = result as Omit<LandBuildingAllocation, 'totalAllocableAmount' | 'landAmount' | 'buildingAmount' | 'supersededAt' | 'createdAt'> & {
    totalAllocableAmount: MoneyJson;
    landAmount: MoneyJson;
    buildingAmount: MoneyJson;
    supersededAt: string | null;
    createdAt: string;
  };
  return {
    ...s,
    totalAllocableAmount: fromNumericAmount(s.totalAllocableAmount.amount, s.totalAllocableAmount.currency),
    landAmount: fromNumericAmount(s.landAmount.amount, s.landAmount.currency),
    buildingAmount: fromNumericAmount(s.buildingAmount.amount, s.buildingAmount.currency),
    supersededAt: s.supersededAt === null ? null : new Date(s.supersededAt),
    createdAt: new Date(s.createdAt),
  };
}
