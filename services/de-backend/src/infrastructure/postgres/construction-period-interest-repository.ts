import { sql, type Kysely, type Transaction } from 'kysely';
import {
  canonicalFacts,
  pickFacts,
  planAmend,
  type ChangeRecordOutcome,
  type ConfirmStep,
  type ConstructionPeriodChanges,
  type ConstructionPeriodInterest,
  type ConstructionPeriodInterestRepository,
  type ConstructionPeriodReviewState,
  type ConstructionPeriodStatus,
  type CreateRecordOutcome,
  type NamingClassification,
  type NewConstructionPeriodInterest,
  type Treatment,
} from '../../domains/taxation/index.js';
import { checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import type { Database } from './schema.js';

/**
 * PostgreSQL implementation of the construction-period records (api-design.md §59E, migration 0055). Every command is
 * one READ COMMITTED transaction that writes the record's row first (create: inserts it), so a classification's create,
 * which writes the same row first as a no-op, serialises with amend, confirm and void. AuditRecords `CREATED`,
 * `AMENDED`, `CONFIRMED`, `VOIDED`.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'ConstructionPeriodInterest';
const SCOPE = 'construction-period-interest.create';
type Trx = Transaction<Database>;

class Rejected extends Error {
  constructor(readonly outcome: CreateRecordOutcome | ChangeRecordOutcome) {
    super(outcome.kind);
  }
}

const RECORD_COLUMNS = [
  'id',
  'mre_realm_id',
  'loan_id',
  'measure',
  sql<string>`to_char(herstellung_from, 'YYYY-MM-DD')`.as('herstellung_from'),
  sql<string | null>`to_char(herstellung_until, 'YYYY-MM-DD')`.as('herstellung_until'),
  'use_intent',
  'advance_expense_deductible',
  sql<string>`building_funds_share_numerator::text`.as('n'),
  sql<string>`building_funds_share_denominator::text`.as('d'),
  'earlier_years_treatment',
  'source_references',
  'notes',
  'review_state',
  'advisor_party_id',
  'status',
  'voided_at',
  'void_reason',
  'created_at',
  'created_by',
  'updated_at',
  'version',
] as const;

/** The records of the ids, with their PropertyReferences, in the caller's transaction. */
export async function recordsIn(trx: Trx, mreRealmId: string, ids: readonly string[]): Promise<Map<string, ConstructionPeriodInterest>> {
  const wanted = [...new Set(ids)].filter((id) => UUID.test(id));
  if (wanted.length === 0) return new Map();
  const rows = await trx
    .selectFrom('construction_period_interest')
    .select(RECORD_COLUMNS)
    .where('id', 'in', wanted)
    .where('mre_realm_id', '=', mreRealmId)
    .execute();
  const properties = await propertiesOf(
    trx,
    rows.map((r) => r.id),
  );
  return new Map(rows.map((r) => [r.id, toRecord(r, properties.get(r.id) ?? [])] as const));
}

async function propertiesOf(trx: Trx, ids: readonly string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const rows = await trx
    .selectFrom('construction_period_interest_property')
    .select(['record_id', 'property_reference_id'])
    .where('record_id', 'in', ids)
    .orderBy('property_reference_id')
    .execute();
  for (const r of rows) map.set(r.record_id, [...(map.get(r.record_id) ?? []), r.property_reference_id]);
  return map;
}

type RecordRow = {
  id: string;
  mre_realm_id: string;
  loan_id: string | null;
  measure: string;
  herstellung_from: string;
  herstellung_until: string | null;
  use_intent: string;
  advance_expense_deductible: boolean;
  n: string;
  d: string;
  earlier_years_treatment: string;
  source_references: string[];
  notes: string | null;
  review_state: string;
  advisor_party_id: string | null;
  status: string;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  version: number;
};

function toRecord(r: RecordRow, propertyReferenceIds: readonly string[]): ConstructionPeriodInterest {
  return {
    id: r.id,
    mreRealmId: r.mre_realm_id,
    loanId: r.loan_id,
    propertyReferenceIds: [...propertyReferenceIds].sort(),
    measure: r.measure,
    herstellungFrom: r.herstellung_from as BusinessDate,
    herstellungUntil: r.herstellung_until as BusinessDate | null,
    useIntent: r.use_intent,
    advanceExpenseDeductible: r.advance_expense_deductible,
    buildingFundsShare: { numerator: BigInt(r.n), denominator: BigInt(r.d) },
    earlierYearsTreatment: r.earlier_years_treatment,
    sourceReferences: r.source_references,
    notes: r.notes,
    reviewState: r.review_state as ConstructionPeriodReviewState,
    advisorPartyId: r.advisor_party_id,
    status: r.status as ConstructionPeriodStatus,
    voidedAt: r.voided_at,
    voidReason: r.void_reason,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

/** A record as JSON for the idempotency store and the AuditRecords. */
export function recordSnapshot(r: ConstructionPeriodInterest): Record<string, unknown> {
  return {
    ...r,
    buildingFundsShare: `${r.buildingFundsShare.numerator}/${r.buildingFundsShare.denominator}`,
    voidedAt: r.voidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function fromSnapshot(json: unknown): ConstructionPeriodInterest {
  const s = json as Record<string, unknown> & { buildingFundsShare: string; voidedAt: string | null; createdAt: string; updatedAt: string };
  const [n, d] = s.buildingFundsShare.split('/') as [string, string];
  return {
    ...(s as unknown as ConstructionPeriodInterest),
    buildingFundsShare: { numerator: BigInt(n), denominator: BigInt(d) },
    voidedAt: s.voidedAt === null ? null : new Date(s.voidedAt),
    createdAt: new Date(s.createdAt),
    updatedAt: new Date(s.updatedAt),
  };
}

const factsAudit = (r: ConstructionPeriodInterest) => {
  const s = recordSnapshot(r);
  return {
    loanId: s['loanId'],
    propertyReferenceIds: s['propertyReferenceIds'],
    measure: s['measure'],
    herstellungFrom: s['herstellungFrom'],
    herstellungUntil: s['herstellungUntil'],
    advanceExpenseDeductible: s['advanceExpenseDeductible'],
    buildingFundsShare: s['buildingFundsShare'],
    reviewState: s['reviewState'],
  };
};

/** Every PropertyReference of the Realm named, else the first unknown one (sorted). */
async function unknownProperty(trx: Trx, mreRealmId: string, ids: readonly string[]): Promise<string | undefined> {
  const invalid = [...ids].sort().find((id) => !UUID.test(id));
  if (invalid !== undefined) return invalid;
  const found = await trx.selectFrom('property_reference').select('id').where('id', 'in', ids).where('mre_realm_id', '=', mreRealmId).execute();
  return [...ids].sort().find((id) => !found.some((f) => f.id === id));
}

export class PostgresConstructionPeriodInterestRepository implements ConstructionPeriodInterestRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(
    input: NewConstructionPeriodInterest,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateRecordOutcome> {
    const record = canonicalFacts(input);
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateRecordOutcome> => {
          const ref = { mreRealmId: record.mreRealmId, scope: SCOPE, key: idempotency?.key ?? '' };
          if (idempotency !== undefined) {
            const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', record: fromSnapshot(claim.result) };
          }
          if (record.loanId !== null) {
            const loan = UUID.test(record.loanId)
              ? await trx.selectFrom('loan').select('id').where('id', '=', record.loanId).where('mre_realm_id', '=', record.mreRealmId).executeTakeFirst()
              : undefined;
            if (loan === undefined) throw new Rejected({ kind: 'LOAN_NOT_FOUND', loanId: record.loanId });
          }
          const unknown = await unknownProperty(trx, record.mreRealmId, record.propertyReferenceIds);
          if (unknown !== undefined) throw new Rejected({ kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceId: unknown });
          const row = await trx
            .insertInto('construction_period_interest')
            .values({
              mre_realm_id: record.mreRealmId,
              loan_id: record.loanId,
              ...factColumns(record),
              review_state: 'UNREVIEWED',
              advisor_party_id: null,
              voided_at: null,
              void_reason: null,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await insertProperties(trx, row.id, record.mreRealmId, record.propertyReferenceIds);
          const created = await readRecord(trx, row.id, record.mreRealmId);
          await writeAudit(trx, { type: ENTITY_TYPE, id: row.id }, 'CREATED', actor, { newVersion: created.version, metadata: factsAudit(created) });
          if (idempotency !== undefined) await recordIdempotentResult(trx, ref, row.id, recordSnapshot(created));
          return { kind: 'CREATED', record: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome as CreateRecordOutcome;
      throw error;
    }
  }

  amend(id: string, mreRealmId: string, changes: ConstructionPeriodChanges, actor: AuditActor, expectedVersions?: readonly number[]) {
    return this.change(id, mreRealmId, actor, expectedVersions, async (trx, current) => {
      const plan = planAmend(current, changes);
      if (plan.kind === 'RECORD_VOID') throw new Rejected({ kind: 'RECORD_VOID' });
      if (plan.changed.length === 0) return undefined;
      if (plan.changed.includes('propertyReferenceIds')) {
        const unknown = await unknownProperty(trx, mreRealmId, plan.facts.propertyReferenceIds);
        if (unknown !== undefined) throw new Rejected({ kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceId: unknown });
      }
      await trx
        .updateTable('construction_period_interest')
        .set({
          ...factColumns(plan.facts),
          review_state: plan.reviewState,
          advisor_party_id: plan.advisorPartyId,
          updated_at: new Date(),
          version: current.version + 1,
        })
        .where('id', '=', id)
        .execute();
      if (plan.changed.includes('propertyReferenceIds')) {
        const removed = current.propertyReferenceIds.filter((p) => !plan.facts.propertyReferenceIds.includes(p));
        const added = plan.facts.propertyReferenceIds.filter((p) => !current.propertyReferenceIds.includes(p));
        if (removed.length > 0)
          await trx.deleteFrom('construction_period_interest_property').where('record_id', '=', id).where('property_reference_id', 'in', removed).execute();
        await insertProperties(trx, id, mreRealmId, added);
      }
      return {
        action: 'AMENDED',
        metadata: {
          changedFields: plan.changed,
          ...(plan.reviewState === current.reviewState ? {} : { reviewState: { from: current.reviewState, to: plan.reviewState } }),
          from: factsOnly(pickFacts(current), plan.changed),
          to: factsOnly(plan.facts, plan.changed),
        },
      };
    });
  }

  confirm(id: string, mreRealmId: string, step: ConfirmStep, actor: AuditActor, expectedVersions?: readonly number[]) {
    return this.change(id, mreRealmId, actor, expectedVersions, async (trx, current) => {
      if (current.status === 'VOID') throw new Rejected({ kind: 'RECORD_VOID' });
      if (step.advisorPartyId !== null) {
        const party = UUID.test(step.advisorPartyId)
          ? await trx.selectFrom('party').select('id').where('id', '=', step.advisorPartyId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst()
          : undefined;
        if (party === undefined) throw new Rejected({ kind: 'PARTY_NOT_FOUND', partyId: step.advisorPartyId });
      }
      if (current.reviewState === step.reviewState && current.advisorPartyId === step.advisorPartyId) return undefined;
      await trx
        .updateTable('construction_period_interest')
        .set({ review_state: step.reviewState, advisor_party_id: step.advisorPartyId, updated_at: new Date(), version: current.version + 1 })
        .where('id', '=', id)
        .execute();
      return { action: 'CONFIRMED', metadata: { from: current.reviewState, to: step.reviewState, advisorPartyId: step.advisorPartyId } };
    });
  }

  void(id: string, mreRealmId: string, reason: string, actor: AuditActor, expectedVersions?: readonly number[]) {
    return this.change(id, mreRealmId, actor, expectedVersions, async (trx, current) => {
      if (current.status === 'VOID') throw new Rejected({ kind: 'RECORD_VOID' });
      await trx
        .updateTable('construction_period_interest')
        .set({ status: 'VOID', voided_at: new Date(), void_reason: reason, updated_at: new Date(), version: current.version + 1 })
        .where('id', '=', id)
        .execute();
      return { action: 'VOIDED', metadata: { reason } };
    });
  }

  /** Locks the record (`FOR UPDATE`), checks `If-Match`, applies `work` (undefined: nothing changed) and audits it. */
  private async change(
    id: string,
    mreRealmId: string,
    actor: AuditActor,
    expectedVersions: readonly number[] | undefined,
    work: (trx: Trx, current: ConstructionPeriodInterest) => Promise<{ action: string; metadata: Record<string, unknown> } | undefined>,
  ): Promise<ChangeRecordOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<ChangeRecordOutcome> => {
          const locked = await trx
            .selectFrom('construction_period_interest')
            .select('id')
            .where('id', '=', id)
            .where('mre_realm_id', '=', mreRealmId)
            .forUpdate()
            .executeTakeFirst();
          if (locked === undefined) return { kind: 'NOT_FOUND' };
          const current = await readRecord(trx, id, mreRealmId);
          const conflict = checkVersion(current.version, expectedVersions);
          if (conflict !== undefined) return conflict;
          const done = await work(trx, current);
          if (done === undefined) return { kind: 'CHANGED', record: current, changed: false };
          const changed = await readRecord(trx, id, mreRealmId);
          await writeAudit(trx, { type: ENTITY_TYPE, id }, done.action, actor, {
            previousVersion: current.version,
            newVersion: changed.version,
            metadata: done.metadata,
          });
          return { kind: 'CHANGED', record: changed, changed: true };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome as ChangeRecordOutcome;
      throw error;
    }
  }

  find(id: string, mreRealmId: string) {
    if (!UUID.test(id)) return Promise.resolve(undefined);
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const record = (await recordsIn(trx, mreRealmId, [id])).get(id);
        if (record === undefined) return undefined;
        const rows = await trx
          .selectFrom('tax_classification')
          .select(['id', 'transaction_split_id', 'treatment', 'review_state', 'superseded_at'])
          .where('construction_period_interest_id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .orderBy('created_at')
          .orderBy('id')
          .execute();
        const classifications: NamingClassification[] = rows.map((r) => ({
          classificationId: r.id,
          splitId: r.transaction_split_id as string,
          treatment: r.treatment as Treatment | null,
          reviewState: r.review_state,
          current: r.superseded_at === null,
        }));
        return { record, classifications };
      });
  }

  async list(mreRealmId: string, filter: { readonly loanId?: string; readonly propertyReferenceId?: string }) {
    if ((filter.loanId !== undefined && !UUID.test(filter.loanId)) || (filter.propertyReferenceId !== undefined && !UUID.test(filter.propertyReferenceId)))
      return [];
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        let query = trx.selectFrom('construction_period_interest as r').select('r.id').where('r.mre_realm_id', '=', mreRealmId);
        if (filter.loanId !== undefined) query = query.where('r.loan_id', '=', filter.loanId);
        if (filter.propertyReferenceId !== undefined) {
          const pr = filter.propertyReferenceId;
          query = query.where('r.id', 'in', (eb) =>
            eb.selectFrom('construction_period_interest_property').select('record_id').where('property_reference_id', '=', pr),
          );
        }
        const ids = (await query.orderBy('r.created_at').orderBy('r.id').execute()).map((r) => r.id);
        const records = await recordsIn(trx, mreRealmId, ids);
        return ids.map((i) => records.get(i) as ConstructionPeriodInterest);
      });
  }
}

function factColumns(f: ReturnType<typeof pickFacts>) {
  return {
    measure: f.measure,
    herstellung_from: f.herstellungFrom,
    herstellung_until: f.herstellungUntil,
    use_intent: f.useIntent,
    advance_expense_deductible: f.advanceExpenseDeductible,
    building_funds_share_numerator: f.buildingFundsShare.numerator.toString(),
    building_funds_share_denominator: f.buildingFundsShare.denominator.toString(),
    earlier_years_treatment: f.earlierYearsTreatment,
    source_references: [...f.sourceReferences],
    notes: f.notes,
  };
}

const factsOnly = (f: ReturnType<typeof pickFacts>, keys: readonly string[]) => {
  const s = { ...f, buildingFundsShare: `${f.buildingFundsShare.numerator}/${f.buildingFundsShare.denominator}` } as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, s[k]]));
};

async function insertProperties(trx: Trx, recordId: string, mreRealmId: string, ids: readonly string[]) {
  if (ids.length === 0) return;
  await trx
    .insertInto('construction_period_interest_property')
    .values(ids.map((p) => ({ record_id: recordId, mre_realm_id: mreRealmId, property_reference_id: p })))
    .execute();
}

async function readRecord(trx: Trx, id: string, mreRealmId: string): Promise<ConstructionPeriodInterest> {
  const record = (await recordsIn(trx, mreRealmId, [id])).get(id);
  if (record === undefined) throw new Error(`ConstructionPeriodInterest ${id} vanished inside its own transaction`);
  return record;
}
