import { sql, type Kysely, type Transaction } from 'kysely';
import {
  checkClassification,
  type AcquisitionCostClassification,
  type AcquisitionCostClassificationRepository,
  type AcquisitionStatus,
  type ClassificationPurpose,
  type ClassificationReviewState,
  type CostStatus,
  type CreateClassificationOutcome,
  type NewCostClassification,
} from '../../domains/acquisition/index.js';
import type { AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'AcquisitionCostClassification';
const SCOPE = 'acquisition.cost.classification.create';

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateClassificationOutcome) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the classification port (api-design.md §59D, migration 0054). */
export class PostgresAcquisitionCostClassificationRepository implements AcquisitionCostClassificationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(
    classification: NewCostClassification,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateClassificationOutcome> {
    if (!UUID.test(classification.acquisitionId)) return { kind: 'ACQUISITION_NOT_FOUND' };
    if (!UUID.test(classification.costId)) return { kind: 'COST_NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateClassificationOutcome> => {
          const ref = { mreRealmId: classification.mreRealmId, scope: SCOPE, key: idempotency?.key ?? '' };
          if (idempotency !== undefined) {
            const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', classification: fromSnapshot(claim.result) };
          }
          // The serialising no-op of §27.2: cancel, confirm, the cost's void and every cost write wait here.
          const acquisition = await trx
            .updateTable('acquisition')
            .set((eb) => ({ version: eb.ref('version') }))
            .where('id', '=', classification.acquisitionId)
            .where('mre_realm_id', '=', classification.mreRealmId)
            .returning(['status'])
            .executeTakeFirst();
          if (acquisition === undefined) throw new Rejected({ kind: 'ACQUISITION_NOT_FOUND' });
          const cost = await trx
            .selectFrom('acquisition_cost')
            .select(['status', 'category', 'currency', sql<string>`amount::text`.as('amount')])
            .where('id', '=', classification.costId)
            .where('acquisition_id', '=', classification.acquisitionId)
            .executeTakeFirst();
          if (cost === undefined) throw new Rejected({ kind: 'COST_NOT_FOUND' });
          const advisor = classification.advisorPartyId;
          if (advisor !== null) {
            const party = await trx
              .selectFrom('party')
              .select('id')
              .where('id', '=', advisor)
              .where('mre_realm_id', '=', classification.mreRealmId)
              .executeTakeFirst();
            if (party === undefined) throw new Rejected({ kind: 'PARTY_NOT_FOUND', partyId: advisor });
          }
          const current = await trx
            .selectFrom('acquisition_cost_classification')
            .select('id')
            .where('cost_id', '=', classification.costId)
            .where('superseded_at', 'is', null)
            .executeTakeFirst();
          const refusal = checkClassification(
            acquisition.status as AcquisitionStatus,
            { status: cost.status as CostStatus, category: cost.category, amount: fromNumericAmount(cost.amount, cost.currency) },
            current?.id ?? null,
            classification,
          );
          if (refusal !== undefined) throw new Rejected(refusal);

          // The old row first: the partial unique index of the current one cannot be deferred (as §27.3).
          if (current !== undefined) {
            await trx
              .updateTable('acquisition_cost_classification')
              .set({ superseded_at: sql<Date>`now()` })
              .where('id', '=', current.id)
              .execute();
          }
          const { id } = await trx
            .insertInto('acquisition_cost_classification')
            .values({
              mre_realm_id: classification.mreRealmId,
              acquisition_id: classification.acquisitionId,
              cost_id: classification.costId,
              description: classification.description,
              source_references: [...classification.sourceReferences],
              review_state: classification.reviewState,
              advisor_party_id: advisor,
              notes: classification.notes,
              supersedes_id: current?.id ?? null,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('acquisition_cost_classification_part')
            .values(
              classification.parts.map((p, i) => ({
                classification_id: id,
                position: i + 1,
                purpose: p.purpose,
                amount: toNumericAmount(p.amount),
                currency: p.amount.currency,
              })),
            )
            .execute();
          const created = (await costClassificationsOf(trx, { costIds: [classification.costId], onlyId: id }))[0];
          if (created === undefined) throw new Error(`AcquisitionCostClassification ${id} vanished`);
          if (idempotency !== undefined) await recordIdempotentResult(trx, ref, id, toSnapshot(created));
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CREATED', actor, {
            newVersion: 1,
            metadata: {
              acquisitionId: classification.acquisitionId,
              costId: classification.costId,
              parts: created.parts.map((p) => ({ purpose: p.purpose, amount: p.amount.toJSON() })),
              reviewState: created.reviewState,
              supersedes: created.supersedesId,
            },
          });
          if (current !== undefined) {
            await writeAudit(trx, { type: ENTITY_TYPE, id: current.id }, 'SUPERSEDED', actor, { newVersion: 1, metadata: { supersededById: id } });
          }
          return { kind: 'CREATED', classification: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  async list(
    acquisitionId: string,
    costId: string,
    mreRealmId: string,
  ): Promise<
    | { readonly kind: 'FOUND'; readonly current: AcquisitionCostClassification | null; readonly items: readonly AcquisitionCostClassification[] }
    | { readonly kind: 'ACQUISITION_NOT_FOUND' }
    | { readonly kind: 'COST_NOT_FOUND' }
  > {
    if (!UUID.test(acquisitionId)) return { kind: 'ACQUISITION_NOT_FOUND' };
    if (!UUID.test(costId)) return { kind: 'COST_NOT_FOUND' };
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
        if (acquisition === undefined) return { kind: 'ACQUISITION_NOT_FOUND' as const };
        const cost = await trx
          .selectFrom('acquisition_cost')
          .select('id')
          .where('id', '=', costId)
          .where('acquisition_id', '=', acquisitionId)
          .executeTakeFirst();
        if (cost === undefined) return { kind: 'COST_NOT_FOUND' as const };
        const items = await costClassificationsOf(trx, { costIds: [costId] });
        return { kind: 'FOUND' as const, current: items.find((c) => c.current) ?? null, items };
      });
  }
}

/**
 * The classifications of these costs (or the one with `onlyId`, or only the current ones), newest first per cost, with
 * their parts by position and the derived successor. Read by the cost reads and the basis readers (§59A, §58B) in their
 * own snapshot.
 */
export async function costClassificationsOf(
  trx: Transaction<Database>,
  filter: { readonly costIds: readonly string[]; readonly onlyId?: string; readonly currentOnly?: boolean },
): Promise<AcquisitionCostClassification[]> {
  if (filter.costIds.length === 0) return [];
  let query = trx
    .selectFrom('acquisition_cost_classification as c')
    .select([
      'c.id',
      'c.mre_realm_id',
      'c.acquisition_id',
      'c.cost_id',
      'c.description',
      'c.source_references',
      'c.review_state',
      'c.advisor_party_id',
      'c.notes',
      'c.supersedes_id',
      'c.superseded_at',
      'c.created_at',
      sql<string | null>`(SELECT s.id FROM acquisition_cost_classification s WHERE s.supersedes_id = c.id)`.as('superseded_by_id'),
    ])
    .where('c.cost_id', 'in', [...filter.costIds]);
  if (filter.onlyId !== undefined) query = query.where('c.id', '=', filter.onlyId);
  if (filter.currentOnly === true) query = query.where('c.superseded_at', 'is', null);
  const rows = await query.orderBy('c.cost_id').orderBy('c.created_at', 'desc').orderBy('c.id', 'desc').execute();
  if (rows.length === 0) return [];
  const parts = await trx
    .selectFrom('acquisition_cost_classification_part')
    .select(['classification_id', 'position', 'purpose', 'currency', sql<string>`amount::text`.as('amount')])
    .where(
      'classification_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('classification_id')
    .orderBy('position')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    mreRealmId: row.mre_realm_id,
    acquisitionId: row.acquisition_id,
    costId: row.cost_id,
    parts: parts
      .filter((p) => p.classification_id === row.id)
      .map((p) => ({ purpose: p.purpose as ClassificationPurpose, amount: fromNumericAmount(p.amount, p.currency) })),
    description: row.description,
    sourceReferences: row.source_references,
    reviewState: row.review_state as ClassificationReviewState,
    advisorPartyId: row.advisor_party_id,
    notes: row.notes,
    supersedesId: row.supersedes_id,
    supersededAt: row.superseded_at,
    supersededById: row.superseded_by_id,
    current: row.superseded_at === null,
    createdAt: row.created_at,
  }));
}

/** The current classification per cost (at most one, the index `acquisition_cost_classification_current`). */
export async function currentClassificationByCost(trx: Transaction<Database>, costIds: readonly string[]): Promise<Map<string, AcquisitionCostClassification>> {
  const found = new Map<string, AcquisitionCostClassification>();
  for (const c of await costClassificationsOf(trx, { costIds, currentOnly: true })) {
    // Checked here too, so a read that saw two current ones fails instead of taking whichever comes first.
    if (found.has(c.costId)) throw new Error(`two current classifications for cost ${c.costId}`);
    found.set(c.costId, c);
  }
  return found;
}

/** The created classification as JSON for the idempotency store: Money as `{ amount, currency }`, timestamps ISO. */
export function toSnapshot(c: AcquisitionCostClassification): unknown {
  return {
    ...c,
    parts: c.parts.map((p) => ({ purpose: p.purpose, amount: p.amount.toJSON() })),
    supersededAt: c.supersededAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
export function fromSnapshot(result: unknown): AcquisitionCostClassification {
  const s = result as Omit<AcquisitionCostClassification, 'parts' | 'supersededAt' | 'createdAt'> & {
    parts: { purpose: ClassificationPurpose; amount: { amount: string; currency: string } }[];
    supersededAt: string | null;
    createdAt: string;
  };
  return {
    ...s,
    parts: s.parts.map((p) => ({ purpose: p.purpose, amount: fromNumericAmount(p.amount.amount, p.amount.currency) })),
    supersededAt: s.supersededAt === null ? null : new Date(s.supersededAt),
    createdAt: new Date(s.createdAt),
  };
}
