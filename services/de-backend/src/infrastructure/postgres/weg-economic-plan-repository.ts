import { sql, type Kysely, type Transaction } from 'kysely';
import {
  derivePlan,
  financialYearOf,
  inFinancialYear,
  planFor,
  type CreatePlanOutcome,
  type EconomicPlan,
  type NewEconomicPlan,
  type Page,
  type PageRequest,
  type PlanCostLine,
  type PlanFilter,
  type PlanStatus,
  type PlanView,
  type ProposalContext,
  type VoidPlanOutcome,
  type WegEconomicPlanId,
  type WegEconomicPlanRepository,
} from '../../domains/weg/index.js';
import { Money, checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'WegEconomicPlan';
const CREATE_SCOPE = 'weg-economic-plan.create';
const UNCONFIRMED = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'];

/** Every column, Money as exact text and dates as `YYYY-MM-DD`. */
const COLUMNS = [
  'id',
  'mre_realm_id',
  'membership_id',
  'financial_year',
  sql<string>`to_char(effective_from, 'YYYY-MM-DD')`.as('effective_from'),
  sql<string | null>`to_char(resolution_date, 'YYYY-MM-DD')`.as('resolution_date'),
  sql<string>`monthly_hausgeld::text`.as('monthly_hausgeld'),
  sql<string>`monthly_reserve_contribution::text`.as('monthly_reserve_contribution'),
  sql<string>`recoverable_costs::text`.as('recoverable_costs'),
  sql<string>`non_recoverable_costs::text`.as('non_recoverable_costs'),
  sql<string | null>`income::text`.as('income'),
  sql<string | null>`annual_reserve_contribution::text`.as('annual_reserve_contribution'),
  'currency',
  'cost_lines',
  'status',
  'voided_at',
  'void_reason',
  'source_references',
  'notes',
  'created_at',
  'version',
] as const;

interface PlanRow {
  id: string;
  mre_realm_id: string;
  membership_id: string;
  financial_year: number;
  effective_from: string;
  resolution_date: string | null;
  monthly_hausgeld: string;
  monthly_reserve_contribution: string;
  recoverable_costs: string;
  non_recoverable_costs: string;
  income: string | null;
  annual_reserve_contribution: string | null;
  currency: string;
  cost_lines: unknown;
  status: string;
  voided_at: Date | null;
  void_reason: string | null;
  source_references: string[];
  notes: string | null;
  created_at: Date;
  version: number;
}

/** A cost line as stored in `cost_lines` (jsonb), Money as its JSON. */
interface StoredCostLine {
  position: number;
  description: string;
  allocationKey: string;
  totalAmount: { amount: string; currency: string };
  unitShare: { amount: string; currency: string };
  group: PlanCostLine['group'];
}

class Rejected extends Error {
  constructor(readonly outcome: CreatePlanOutcome) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the Wirtschaftsplan port (api-design.md §49.5–§49.6). */
export class PostgresWegEconomicPlanRepository implements WegEconomicPlanRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createPlan(plan: NewEconomicPlan, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreatePlanOutcome> {
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreatePlanOutcome> => {
          const keyed =
            idempotency === undefined
              ? undefined
              : { ref: { mreRealmId: plan.mreRealmId, scope: CREATE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
          if (keyed !== undefined) {
            const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', plan: view(fromSnapshot(claim.result)) };
          }
          // Locks as every membership writer (§49.5): the unit (no-op write), then the membership row.
          if (!UUID.test(plan.membershipId)) throw new Rejected({ kind: 'MEMBERSHIP_NOT_FOUND' });
          await trx
            .updateTable('property_reference')
            .set((eb) => ({ version: eb.ref('version') }))
            .where('id', '=', (eb) =>
              eb.selectFrom('weg_membership').select('property_reference_id').where('id', '=', plan.membershipId).where('mre_realm_id', '=', plan.mreRealmId),
            )
            .execute();
          const membership = await trx
            .selectFrom('weg_membership')
            .innerJoin('weg', 'weg.id', 'weg_membership.weg_id')
            .select([
              'weg_membership.id',
              'weg_membership.status',
              sql<string>`to_char(weg_membership.valid_from, 'YYYY-MM-DD')`.as('valid_from'),
              sql<string | null>`to_char(weg_membership.valid_until, 'YYYY-MM-DD')`.as('valid_until'),
              'weg.financial_year_start_month',
            ])
            .where('weg_membership.id', '=', plan.membershipId)
            .where('weg_membership.mre_realm_id', '=', plan.mreRealmId)
            .forUpdate('weg_membership')
            .executeTakeFirst();
          if (membership === undefined) throw new Rejected({ kind: 'MEMBERSHIP_NOT_FOUND' });
          if (!inFinancialYear(plan.effectiveFrom, plan.financialYear, membership.financial_year_start_month)) {
            throw new Rejected({ kind: 'EFFECTIVE_FROM_OUTSIDE_YEAR', ...financialYearOf(plan.financialYear, membership.financial_year_start_month) });
          }
          if (membership.status !== 'ACTIVE') throw new Rejected({ kind: 'MEMBERSHIP_NOT_ACTIVE' });
          const validFrom = membership.valid_from as BusinessDate;
          const validUntil = membership.valid_until as BusinessDate | null;
          if (plan.effectiveFrom < validFrom || (validUntil !== null && plan.effectiveFrom > validUntil)) {
            throw new Rejected({ kind: 'PLAN_OUTSIDE_MEMBERSHIP', validFrom, validUntil });
          }
          const inserted = await trx
            .insertInto('weg_economic_plan')
            .values({
              mre_realm_id: plan.mreRealmId,
              membership_id: plan.membershipId,
              financial_year: plan.financialYear,
              effective_from: plan.effectiveFrom,
              resolution_date: plan.resolutionDate,
              monthly_hausgeld: toNumericAmount(plan.monthlyHausgeld),
              monthly_reserve_contribution: toNumericAmount(plan.monthlyReserveContribution),
              recoverable_costs: toNumericAmount(plan.recoverableCosts),
              non_recoverable_costs: toNumericAmount(plan.nonRecoverableCosts),
              income: plan.income === null ? null : toNumericAmount(plan.income),
              annual_reserve_contribution: plan.annualReserveContribution === null ? null : toNumericAmount(plan.annualReserveContribution),
              currency: 'EUR',
              cost_lines: JSON.stringify(plan.costLines.map(toStoredLine)),
              status: 'ACTIVE' satisfies PlanStatus,
              source_references: [...plan.sourceReferences],
              notes: plan.notes,
              created_by: actor.actorId,
            })
            .onConflict((oc) => oc.columns(['membership_id', 'effective_from']).where('status', '=', 'ACTIVE').doNothing())
            .returning('id')
            .executeTakeFirst();
          if (inserted === undefined) {
            const existing = await trx
              .selectFrom('weg_economic_plan')
              .select('id')
              .where('membership_id', '=', plan.membershipId)
              .where('effective_from', '=', plan.effectiveFrom)
              .where('status', '=', 'ACTIVE')
              .executeTakeFirst();
            throw new Rejected({ kind: 'PLAN_EXISTS', economicPlanId: existing?.id ?? '' });
          }
          const created = await readOne(trx, inserted.id);
          if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, inserted.id, toSnapshot(created));
          await writeAudit(trx, { type: ENTITY_TYPE, id: inserted.id }, 'CREATED', actor, {
            newVersion: created.version,
            metadata: {
              membershipId: created.membershipId,
              financialYear: created.financialYear,
              effectiveFrom: created.effectiveFrom,
              monthlyHausgeld: created.monthlyHausgeld.toJSON(),
              monthlyReserveContribution: created.monthlyReserveContribution.toJSON(),
            },
          });
          const membershipVersion = await trx.selectFrom('weg_membership').select('version').where('id', '=', plan.membershipId).executeTakeFirstOrThrow();
          await writeAudit(trx, { type: 'WegMembership', id: plan.membershipId }, 'ECONOMIC_PLAN_ADDED', actor, {
            newVersion: membershipVersion.version,
            metadata: { economicPlanId: inserted.id },
          });
          return { kind: 'CREATED', plan: view(created) };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  async findPlan(id: string, mreRealmId: string): Promise<PlanView | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.selectFrom('weg_economic_plan').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
    return row === undefined ? undefined : view(toPlan(row));
  }

  async listPlans(membershipId: string, mreRealmId: string, filter: PlanFilter, page: PageRequest): Promise<Page<PlanView> | undefined> {
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
        const filtered = () => {
          let query = trx.selectFrom('weg_economic_plan').where('membership_id', '=', membershipId).where('mre_realm_id', '=', mreRealmId);
          if (filter.statuses !== undefined && filter.statuses.length > 0) query = query.where('status', 'in', [...filter.statuses]);
          if (filter.financialYear !== undefined) query = query.where('financial_year', '=', filter.financialYear);
          return query;
        };
        const { n } = await filtered()
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        const rows = await filtered()
          .select(COLUMNS)
          .orderBy('effective_from')
          .orderBy('created_at')
          .orderBy('id')
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize)
          .execute();
        return { items: rows.map((r) => view(toPlan(r))), page: page.page, pageSize: page.pageSize, total: Number(n) };
      });
  }

  async voidPlan(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidPlanOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<VoidPlanOutcome> => {
        const row = await trx
          .selectFrom('weg_economic_plan')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = toPlan(row);
        if (current.status === 'VOID') return { kind: 'VOIDED', plan: view(current), changed: false };
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('weg_economic_plan')
          .set({ status: 'VOID', voided_at: at, voided_by: actor.actorId, void_reason: reason, version: current.version + 1, updated_at: at })
          .where('id', '=', id)
          .execute();
        const voided = await readOne(trx, id);
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'VOIDED', actor, {
          previousVersion: current.version,
          newVersion: voided.version,
          metadata: { reason },
        });
        return { kind: 'VOIDED', plan: view(voided), changed: true };
      });
  }

  async proposalContext(transactionId: string, mreRealmId: string, propertyReferenceId: string | null): Promise<ProposalContext> {
    if (!UUID.test(transactionId)) return { kind: 'TRANSACTION_NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx): Promise<ProposalContext> => {
        const tx = await trx
          .selectFrom('ledger_transaction')
          .select([
            'id',
            'amount',
            'currency',
            'direction',
            'status',
            'property_reference_id',
            sql<string>`to_char(booking_date, 'YYYY-MM-DD')`.as('booking_date'),
          ])
          .where('id', '=', transactionId)
          .where('mre_realm_id', '=', mreRealmId)
          .executeTakeFirst();
        if (tx === undefined) return { kind: 'TRANSACTION_NOT_FOUND' };
        if (propertyReferenceId !== null) {
          const unit = UUID.test(propertyReferenceId)
            ? await trx
                .selectFrom('property_reference')
                .select('id')
                .where('id', '=', propertyReferenceId)
                .where('mre_realm_id', '=', mreRealmId)
                .executeTakeFirst()
            : undefined;
          if (unit === undefined) return { kind: 'PROPERTY_REFERENCE_NOT_FOUND' };
        }
        if (tx.direction !== 'OUTFLOW' || !UNCONFIRMED.includes(tx.status)) return { kind: 'NOT_PROPOSABLE', direction: tx.direction, status: tx.status };
        const unit = propertyReferenceId ?? tx.property_reference_id;
        if (unit === null) return { kind: 'NO_UNIT' };
        const bookingDate = tx.booking_date as BusinessDate;
        const membership = await trx
          .selectFrom('weg_membership')
          .innerJoin('weg', 'weg.id', 'weg_membership.weg_id')
          .select(['weg_membership.id', 'weg.financial_year_start_month'])
          .where('weg_membership.property_reference_id', '=', unit)
          .where('weg_membership.mre_realm_id', '=', mreRealmId)
          .where('weg_membership.status', '=', 'ACTIVE')
          .where('weg_membership.valid_from', '<=', bookingDate)
          .where((eb) => eb.or([eb('weg_membership.valid_until', 'is', null), eb('weg_membership.valid_until', '>=', bookingDate)]))
          .executeTakeFirst();
        if (membership === undefined) return { kind: 'NO_MEMBERSHIP', propertyReferenceId: unit, bookingDate };
        const plans = (
          await trx.selectFrom('weg_economic_plan').select(COLUMNS).where('membership_id', '=', membership.id).where('status', '=', 'ACTIVE').execute()
        ).map(toPlan);
        const plan = planFor(plans, bookingDate);
        if (plan === undefined) return { kind: 'NO_ECONOMIC_PLAN', membershipId: membership.id, bookingDate };
        const split = await trx.selectFrom('transaction_split').select('id').where('transaction_id', '=', tx.id).executeTakeFirst();
        return {
          kind: 'FOUND',
          transactionId: tx.id,
          bookingDate,
          amount: fromNumericAmount(tx.amount, tx.currency),
          propertyReferenceId: unit,
          membershipId: membership.id,
          plan: view(plan),
          financialYearStartMonth: membership.financial_year_start_month,
          alreadySplit: split !== undefined,
        };
      });
  }
}

async function readOne(trx: Transaction<Database>, id: string): Promise<EconomicPlan> {
  return toPlan(await trx.selectFrom('weg_economic_plan').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

const view = (plan: EconomicPlan): PlanView => ({ ...plan, ...derivePlan(plan) });

const money = (amount: string) => fromNumericAmount(amount, 'EUR');

function toStoredLine(line: PlanCostLine): StoredCostLine {
  return { ...line, totalAmount: line.totalAmount.toJSON(), unitShare: line.unitShare.toJSON() };
}

function toPlan(row: PlanRow): EconomicPlan {
  const lines = row.cost_lines as StoredCostLine[];
  return {
    id: row.id as WegEconomicPlanId,
    mreRealmId: row.mre_realm_id,
    membershipId: row.membership_id,
    financialYear: row.financial_year,
    effectiveFrom: row.effective_from as BusinessDate,
    resolutionDate: row.resolution_date as BusinessDate | null,
    monthlyHausgeld: money(row.monthly_hausgeld),
    monthlyReserveContribution: money(row.monthly_reserve_contribution),
    recoverableCosts: money(row.recoverable_costs),
    nonRecoverableCosts: money(row.non_recoverable_costs),
    income: row.income === null ? null : money(row.income),
    annualReserveContribution: row.annual_reserve_contribution === null ? null : money(row.annual_reserve_contribution),
    costLines: lines.map((l) => ({ ...l, totalAmount: Money.fromJSON(l.totalAmount), unitShare: Money.fromJSON(l.unitShare) })),
    status: row.status as PlanStatus,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    sourceReferences: row.source_references,
    notes: row.notes,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created plan as JSON for the idempotency store: Money as JSON, timestamps as ISO strings. */
interface PlanSnapshot {
  readonly row: Omit<PlanRow, 'created_at' | 'voided_at'> & { readonly created_at: string; readonly voided_at: string | null };
}

function toSnapshot(plan: EconomicPlan): PlanSnapshot {
  const amount = (m: Money | null) => (m === null ? null : m.amount);
  return {
    row: {
      id: plan.id,
      mre_realm_id: plan.mreRealmId,
      membership_id: plan.membershipId,
      financial_year: plan.financialYear,
      effective_from: plan.effectiveFrom,
      resolution_date: plan.resolutionDate,
      monthly_hausgeld: plan.monthlyHausgeld.amount,
      monthly_reserve_contribution: plan.monthlyReserveContribution.amount,
      recoverable_costs: plan.recoverableCosts.amount,
      non_recoverable_costs: plan.nonRecoverableCosts.amount,
      income: amount(plan.income),
      annual_reserve_contribution: amount(plan.annualReserveContribution),
      currency: 'EUR',
      cost_lines: plan.costLines.map(toStoredLine),
      status: plan.status,
      void_reason: plan.voidReason,
      source_references: [...plan.sourceReferences],
      notes: plan.notes,
      version: plan.version,
      created_at: plan.createdAt.toISOString(),
      voided_at: plan.voidedAt?.toISOString() ?? null,
    },
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): EconomicPlan {
  const { row } = result as PlanSnapshot;
  return toPlan({ ...row, created_at: new Date(row.created_at), voided_at: row.voided_at === null ? null : new Date(row.voided_at) });
}
