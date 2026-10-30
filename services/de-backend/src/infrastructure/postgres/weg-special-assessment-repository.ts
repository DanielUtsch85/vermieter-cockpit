import { sql, type Kysely, type Transaction } from 'kysely';
import type { SplitAssessment } from '../../domains/ledger/index.js';
import {
  changedAssessmentFields,
  deriveAssessment,
  sameAssessmentContent,
  sameUses,
  type AmendAssessmentOutcome,
  type AssessmentContent,
  type AssessmentFilter,
  type AssessmentPurpose,
  type AssessmentUse,
  type AssessmentView,
  type CreateAssessmentOutcome,
  type NewSpecialAssessment,
  type Page,
  type PageRequest,
  type SpecialAssessment,
  type VoidAssessmentOutcome,
  type WegSpecialAssessmentId,
  type WegSpecialAssessmentRepository,
} from '../../domains/weg/index.js';
import { Money, checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'WegSpecialAssessment';
const CREATE_SCOPE = 'weg-special-assessment.create';
const COUNTED = ['CONFIRMED', 'RECONCILED'];
const UNCONFIRMED = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'];

/** Every column, Money as exact text and dates as `YYYY-MM-DD`. */
const COLUMNS = [
  'id',
  'mre_realm_id',
  'membership_id',
  'description',
  sql<string>`to_char(resolution_date, 'YYYY-MM-DD')`.as('resolution_date'),
  'purpose',
  sql<string | null>`total_amount::text`.as('total_amount'),
  sql<string>`unit_share::text`.as('unit_share'),
  'instalments',
  'uses',
  'status',
  'voided_at',
  'void_reason',
  'source_references',
  'notes',
  'created_at',
  'version',
] as const;

interface AssessmentRow {
  id: string;
  mre_realm_id: string;
  membership_id: string;
  description: string;
  resolution_date: string;
  purpose: string;
  total_amount: string | null;
  unit_share: string;
  instalments: unknown;
  uses: unknown;
  status: string;
  voided_at: Date | null;
  void_reason: string | null;
  source_references: string[];
  notes: string | null;
  created_at: Date;
  version: number;
}

type MoneyJson = { amount: string; currency: string };
interface StoredInstalment {
  position: number;
  dueDate: string;
  amount: MoneyJson;
}
interface StoredUse {
  position: number;
  date: string;
  description: string;
  unitShare: MoneyJson;
}

class Rejected extends Error {
  constructor(readonly outcome: CreateAssessmentOutcome) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the Sonderumlage port (api-design.md §51A). */
export class PostgresWegSpecialAssessmentRepository implements WegSpecialAssessmentRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createAssessment(
    assessment: NewSpecialAssessment,
    actor: AuditActor,
    asOf: BusinessDate,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateAssessmentOutcome> {
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateAssessmentOutcome> => {
          const keyed =
            idempotency === undefined
              ? undefined
              : { ref: { mreRealmId: assessment.mreRealmId, scope: CREATE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
          if (keyed !== undefined) {
            const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', assessment: deriveAssessment(fromSnapshot(claim.result), [], [], asOf) };
          }
          if (!UUID.test(assessment.membershipId)) throw new Rejected({ kind: 'MEMBERSHIP_NOT_FOUND' });
          // The locks of every membership writer (§51A): the unit (no-op write), then the membership row.
          await trx
            .updateTable('property_reference')
            .set((eb) => ({ version: eb.ref('version') }))
            .where('id', '=', (eb) =>
              eb
                .selectFrom('weg_membership')
                .select('property_reference_id')
                .where('id', '=', assessment.membershipId)
                .where('mre_realm_id', '=', assessment.mreRealmId),
            )
            .execute();
          const membership = await trx
            .selectFrom('weg_membership')
            .select([
              'id',
              'status',
              sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from'),
              sql<string | null>`to_char(valid_until, 'YYYY-MM-DD')`.as('valid_until'),
            ])
            .where('id', '=', assessment.membershipId)
            .where('mre_realm_id', '=', assessment.mreRealmId)
            .forUpdate()
            .executeTakeFirst();
          if (membership === undefined) throw new Rejected({ kind: 'MEMBERSHIP_NOT_FOUND' });
          if (membership.status !== 'ACTIVE') throw new Rejected({ kind: 'MEMBERSHIP_NOT_ACTIVE', membershipId: membership.id });
          const validFrom = membership.valid_from as BusinessDate;
          const validUntil = membership.valid_until as BusinessDate | null;
          if (assessment.resolutionDate < validFrom || (validUntil !== null && assessment.resolutionDate > validUntil)) {
            throw new Rejected({ kind: 'ASSESSMENT_OUTSIDE_MEMBERSHIP', validFrom, validUntil });
          }
          const inserted = await trx
            .insertInto('weg_special_assessment')
            .values({
              ...contentValues(assessment),
              mre_realm_id: assessment.mreRealmId,
              membership_id: assessment.membershipId,
              resolution_date: assessment.resolutionDate,
              status: 'ACTIVE',
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const created = await readOne(trx, inserted.id);
          if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, inserted.id, toSnapshot(created));
          await writeAudit(trx, { type: ENTITY_TYPE, id: inserted.id }, 'CREATED', actor, {
            newVersion: created.version,
            metadata: { membershipId: created.membershipId, resolutionDate: created.resolutionDate, unitShare: created.unitShare.toJSON() },
          });
          const membershipVersion = await trx.selectFrom('weg_membership').select('version').where('id', '=', membership.id).executeTakeFirstOrThrow();
          await writeAudit(trx, { type: 'WegMembership', id: membership.id }, 'SPECIAL_ASSESSMENT_ADDED', actor, {
            newVersion: membershipVersion.version,
            metadata: { assessmentId: inserted.id },
          });
          return { kind: 'CREATED', assessment: deriveAssessment(created, [], [], asOf) };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  amendAssessment(
    id: string,
    mreRealmId: string,
    content: AssessmentContent,
    actor: AuditActor,
    asOf: BusinessDate,
    expectedVersions?: readonly number[],
  ): Promise<AmendAssessmentOutcome> {
    return this.change(id, mreRealmId, asOf, expectedVersions, actor, {
      same: (current) => sameAssessmentContent(current, content),
      write: async (trx, current) => {
        await trx
          .updateTable('weg_special_assessment')
          .set({ ...contentValues(content), version: current.version + 1, updated_at: new Date() })
          .where('id', '=', id)
          .execute();
        return { action: 'AMENDED', metadata: { changedFields: changedAssessmentFields(current, content) } };
      },
    });
  }

  replaceUses(
    id: string,
    mreRealmId: string,
    uses: readonly AssessmentUse[],
    actor: AuditActor,
    asOf: BusinessDate,
    expectedVersions?: readonly number[],
  ): Promise<AmendAssessmentOutcome> {
    return this.change(id, mreRealmId, asOf, expectedVersions, actor, {
      same: (current) => sameUses(current.uses, uses),
      write: async (trx, current) => {
        await trx
          .updateTable('weg_special_assessment')
          .set({ uses: JSON.stringify(uses.map(toStoredUse)), version: current.version + 1, updated_at: new Date() })
          .where('id', '=', id)
          .execute();
        return { action: 'USES_REPLACED', metadata: { count: { from: current.uses.length, to: uses.length } } };
      },
    });
  }

  /** Amend and uses: the row `FOR UPDATE`, `VOID` refused, the no-op before `If-Match`, then the write and its AuditRecord. */
  private async change(
    id: string,
    mreRealmId: string,
    asOf: BusinessDate,
    expectedVersions: readonly number[] | undefined,
    actor: AuditActor,
    step: {
      readonly same: (current: SpecialAssessment) => boolean;
      readonly write: (trx: Transaction<Database>, current: SpecialAssessment) => Promise<{ action: string; metadata: Record<string, unknown> }>;
    },
  ): Promise<AmendAssessmentOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<AmendAssessmentOutcome> => {
        const row = await trx
          .selectFrom('weg_special_assessment')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = toDomain(row);
        if (current.storedStatus === 'VOID') return { kind: 'ASSESSMENT_NOT_ACTIVE' };
        if (step.same(current)) return { kind: 'AMENDED', assessment: await viewOf(trx, current, asOf), changed: false };
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        const done = await step.write(trx, current);
        const changed = await readOne(trx, id);
        await writeAudit(trx, { type: ENTITY_TYPE, id }, done.action, actor, {
          previousVersion: current.version,
          newVersion: changed.version,
          metadata: done.metadata,
        });
        return { kind: 'AMENDED', assessment: await viewOf(trx, changed, asOf), changed: true };
      });
  }

  async voidAssessment(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    asOf: BusinessDate,
    expectedVersions?: readonly number[],
  ): Promise<VoidAssessmentOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<VoidAssessmentOutcome> => {
        const row = await trx
          .selectFrom('weg_special_assessment')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = toDomain(row);
        if (current.storedStatus === 'VOID') return { kind: 'VOIDED', assessment: await viewOf(trx, current, asOf), changed: false };
        // Read after the lock: a split writer writes this row first, so it committed before or waits (§51A).
        const referencing = await trx
          .selectFrom('transaction_split')
          .select('transaction_id')
          .distinct()
          .where('weg_special_assessment_id', '=', id)
          .orderBy('transaction_id')
          .execute();
        if (referencing.length > 0) return { kind: 'ASSESSMENT_HAS_SPLITS', transactionIds: referencing.map((r) => r.transaction_id) };
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('weg_special_assessment')
          .set({ status: 'VOID', voided_at: at, voided_by: actor.actorId, void_reason: reason, version: current.version + 1, updated_at: at })
          .where('id', '=', id)
          .execute();
        const voided = await readOne(trx, id);
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'VOIDED', actor, {
          previousVersion: current.version,
          newVersion: voided.version,
          metadata: { reason },
        });
        return { kind: 'VOIDED', assessment: await viewOf(trx, voided, asOf), changed: true };
      });
  }

  async findAssessment(id: string, mreRealmId: string, asOf: BusinessDate): Promise<AssessmentView | undefined> {
    if (!UUID.test(id)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const row = await trx
          .selectFrom('weg_special_assessment')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .executeTakeFirst();
        return row === undefined ? undefined : viewOf(trx, toDomain(row), asOf);
      });
  }

  async listAssessments(
    membershipId: string,
    mreRealmId: string,
    filter: AssessmentFilter,
    page: PageRequest,
    asOf: BusinessDate,
  ): Promise<Page<AssessmentView> | undefined> {
    if (!UUID.test(membershipId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const membership = await trx
          .selectFrom('weg_membership')
          .select('id')
          .where('id', '=', membershipId)
          .where('mre_realm_id', '=', mreRealmId)
          .executeTakeFirst();
        if (membership === undefined) return undefined;
        let query = trx.selectFrom('weg_special_assessment').select(COLUMNS).where('membership_id', '=', membershipId).where('mre_realm_id', '=', mreRealmId);
        if (filter.purposes !== undefined && filter.purposes.length > 0) query = query.where('purpose', 'in', [...filter.purposes]);
        const rows = await query.orderBy('resolution_date').orderBy('created_at').orderBy('id').execute();
        // The status is derived: filter after deriving, then page (a membership has few assessments).
        const views = await Promise.all(rows.map((r) => viewOf(trx, toDomain(r), asOf)));
        const filtered = filter.statuses !== undefined && filter.statuses.length > 0 ? views.filter((v) => filter.statuses?.includes(v.status)) : views;
        const items = filtered.slice((page.page - 1) * page.pageSize, page.page * page.pageSize);
        return { items, page: page.page, pageSize: page.pageSize, total: filtered.length };
      });
  }
}

/**
 * The statuses, units and ids of the assessments named by a split set (§51A), each **written** with P3-D8's no-op in id
 * order after the Transaction, the units and the statements (Transaction → PropertyReference → assessment); foreign or
 * unknown ones are left out.
 */
export async function lockAssessmentsOf(trx: Transaction<Database>, mreRealmId: string, ids: readonly string[]): Promise<Map<string, SplitAssessment>> {
  const found = new Map<string, SplitAssessment>();
  for (const id of [...new Set(ids)].filter((i) => UUID.test(i)).sort()) {
    const row = await trx
      .updateTable('weg_special_assessment')
      .set((eb) => ({ version: eb.ref('version') }))
      .where('id', '=', id)
      .where('mre_realm_id', '=', mreRealmId)
      .returning(['status', 'membership_id'])
      .executeTakeFirst();
    if (row === undefined) continue;
    const membership = await trx.selectFrom('weg_membership').select('property_reference_id').where('id', '=', row.membership_id).executeTakeFirstOrThrow();
    found.set(id, { status: row.status, propertyReferenceId: membership.property_reference_id });
  }
  return found;
}

/** An assessment of the Realm with its derived figures (also read by Taxation, §58B); undefined when unknown. */
export async function readAssessmentViewIn(trx: Transaction<Database>, id: string, mreRealmId: string, asOf: BusinessDate): Promise<AssessmentView | undefined> {
  const row = await trx.selectFrom('weg_special_assessment').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
  return row === undefined ? undefined : viewOf(trx, toDomain(row), asOf);
}

async function viewOf(trx: Transaction<Database>, assessment: SpecialAssessment, asOf: BusinessDate): Promise<AssessmentView> {
  const rows = await trx
    .selectFrom('transaction_split as s')
    .innerJoin('ledger_transaction as t', 't.id', 's.transaction_id')
    .select(['t.id', sql<string>`to_char(t.booking_date, 'YYYY-MM-DD')`.as('booking_date'), 't.direction', 't.status', 's.amount', 's.currency'])
    .where('s.weg_special_assessment_id', '=', assessment.id)
    .where((eb) => eb.or([eb('t.correction_role', 'is', null), eb('t.correction_role', '<>', 'REVERSAL')]))
    .execute();
  const counted = new Map<string, { bookingDate: BusinessDate; cents: Money }>();
  for (const r of rows.filter((x) => COUNTED.includes(x.status))) {
    const amount = fromNumericAmount(r.amount, r.currency);
    const signed = r.direction === 'INFLOW' ? amount.negate() : amount;
    const seen = counted.get(r.id);
    counted.set(r.id, { bookingDate: r.booking_date as BusinessDate, cents: seen === undefined ? signed : seen.cents.add(signed) });
  }
  const payments = [...counted.entries()].map(([transactionId, p]) => ({ transactionId, bookingDate: p.bookingDate, amount: p.cents }));
  const uncounted = rows.filter((x) => UNCONFIRMED.includes(x.status)).map((x) => x.id);
  return deriveAssessment(assessment, payments, uncounted, asOf);
}

async function readOne(trx: Transaction<Database>, id: string): Promise<SpecialAssessment> {
  return toDomain(await trx.selectFrom('weg_special_assessment').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

const toStoredUse = (u: AssessmentUse): StoredUse => ({ position: u.position, date: u.date, description: u.description, unitShare: u.unitShare.toJSON() });

function contentValues(content: AssessmentContent) {
  return {
    description: content.description,
    purpose: content.purpose,
    total_amount: content.totalAmount === null ? null : toNumericAmount(content.totalAmount),
    unit_share: toNumericAmount(content.unitShare),
    currency: 'EUR',
    instalments: JSON.stringify(content.instalments.map((i) => ({ position: i.position, dueDate: i.dueDate, amount: i.amount.toJSON() }))),
    source_references: [...content.sourceReferences],
    notes: content.notes,
  };
}

function toDomain(row: AssessmentRow): SpecialAssessment {
  return {
    id: row.id as WegSpecialAssessmentId,
    mreRealmId: row.mre_realm_id,
    membershipId: row.membership_id,
    description: row.description,
    resolutionDate: row.resolution_date as BusinessDate,
    purpose: row.purpose as AssessmentPurpose,
    totalAmount: row.total_amount === null ? null : fromNumericAmount(row.total_amount, 'EUR'),
    unitShare: fromNumericAmount(row.unit_share, 'EUR'),
    instalments: (row.instalments as StoredInstalment[]).map((i) => ({
      position: i.position,
      dueDate: i.dueDate as BusinessDate,
      amount: Money.fromJSON(i.amount),
    })),
    uses: (row.uses as StoredUse[]).map((u) => ({
      position: u.position,
      date: u.date as BusinessDate,
      description: u.description,
      unitShare: Money.fromJSON(u.unitShare),
    })),
    storedStatus: row.status as 'ACTIVE' | 'VOID',
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    sourceReferences: row.source_references,
    notes: row.notes,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created row as JSON for the idempotency store. */
interface AssessmentSnapshot {
  readonly row: Omit<AssessmentRow, 'created_at' | 'voided_at'> & { readonly created_at: string };
}

function toSnapshot(a: SpecialAssessment): AssessmentSnapshot {
  return {
    row: {
      id: a.id,
      mre_realm_id: a.mreRealmId,
      membership_id: a.membershipId,
      description: a.description,
      resolution_date: a.resolutionDate,
      purpose: a.purpose,
      total_amount: a.totalAmount === null ? null : a.totalAmount.amount,
      unit_share: a.unitShare.amount,
      instalments: a.instalments.map((i) => ({ position: i.position, dueDate: i.dueDate, amount: i.amount.toJSON() })),
      uses: a.uses.map(toStoredUse),
      status: a.storedStatus,
      void_reason: a.voidReason,
      source_references: [...a.sourceReferences],
      notes: a.notes,
      version: a.version,
      created_at: a.createdAt.toISOString(),
    },
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted; a created assessment is `ACTIVE`. */
function fromSnapshot(result: unknown): SpecialAssessment {
  const { row } = result as AssessmentSnapshot;
  return toDomain({ ...row, created_at: new Date(row.created_at), voided_at: null });
}
