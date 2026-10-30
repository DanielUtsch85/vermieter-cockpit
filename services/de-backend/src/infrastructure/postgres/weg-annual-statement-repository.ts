import { sql, type Kysely, type Transaction } from 'kysely';
import {
  changedHeaderFields,
  classificationsByAccount,
  financialYearOf,
  normalizeQuantity,
  planConfirm,
  planVoid,
  resolveClassifications,
  sameContent,
  supersedesRefusal,
  viewStatement,
  type AnnualStatement,
  type Classification,
  type ClassificationSource,
  type ConfirmStatementOutcome,
  type CostGroup,
  type CreateStatementOutcome,
  type NewAnnualStatement,
  type Page,
  type PageRequest,
  type ReplaceStatementOutcome,
  type ReserveSection,
  type StatementContent,
  type StatementCostLine,
  type StatementFilter,
  type StatementRefusal,
  type StatementStatus,
  type StatementView,
  type VoidStatementOutcome,
  type WegAnnualStatementId,
  type WegAnnualStatementRepository,
  type ComparisonContext,
  type SettlementContext,
  type WegCategory,
  CLASS_OF_CATEGORY,
  meaFromColumns,
} from '../../domains/weg/index.js';
import type { SplitStatement } from '../../domains/ledger/index.js';
import { Money, checkVersion, type AuditActor, type BusinessDate, type VersionConflict } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'WegAnnualStatement';
const CREATE_SCOPE = 'weg-annual-statement.create';
const CONFIRMED_KEY = 'weg_annual_statement_confirmed_key';

const date = <C extends string>(column: C) => sql<string>`to_char(${sql.ref(column)}, 'YYYY-MM-DD')`.as(column);
const optionalDate = <C extends string>(column: C) => sql<string | null>`to_char(${sql.ref(column)}, 'YYYY-MM-DD')`.as(column);
const amount = <C extends string>(column: C) => sql<string>`${sql.ref(column)}::text`.as(column);
const optionalAmount = <C extends string>(column: C) => sql<string | null>`${sql.ref(column)}::text`.as(column);

/** Every column, Money as exact text and dates as `YYYY-MM-DD`. */
const COLUMNS = [
  'id',
  'mre_realm_id',
  'membership_id',
  'financial_year',
  date('period_from'),
  date('period_until'),
  optionalDate('document_date'),
  optionalDate('resolution_date'),
  optionalDate('due_date'),
  'supersedes_id',
  'superseded_by_id',
  amount('recoverable_subtotal'),
  amount('non_recoverable_subtotal'),
  amount('total_costs'),
  amount('hausgeld_requested'),
  amount('hausgeld_paid'),
  optionalAmount('reserve_requested'),
  optionalAmount('reserve_paid'),
  amount('settlement_peak'),
  optionalAmount('settlement_result'),
  'reserve',
  'status',
  'confirmed_at',
  'voided_at',
  'void_reason',
  'source_references',
  'notes',
  'created_at',
  'version',
] as const;

const LINE_COLUMNS = [
  'statement_id',
  'position',
  'account',
  'cost_group',
  'allocation_key',
  optionalAmount('allocation_total'),
  optionalAmount('allocation_share'),
  amount('total_amount'),
  amount('unit_share'),
  'classification',
  'classification_source',
] as const;

interface StatementRow {
  id: string;
  mre_realm_id: string;
  membership_id: string;
  financial_year: number;
  period_from: string;
  period_until: string;
  document_date: string | null;
  resolution_date: string | null;
  due_date: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  recoverable_subtotal: string;
  non_recoverable_subtotal: string;
  total_costs: string;
  hausgeld_requested: string;
  hausgeld_paid: string;
  reserve_requested: string | null;
  reserve_paid: string | null;
  settlement_peak: string;
  settlement_result: string | null;
  reserve: unknown;
  status: string;
  confirmed_at: Date | null;
  voided_at: Date | null;
  void_reason: string | null;
  source_references: string[];
  notes: string | null;
  created_at: Date;
  version: number;
}

interface LineRow {
  statement_id: string;
  position: number;
  account: string;
  cost_group: string;
  allocation_key: string;
  allocation_total: string | null;
  allocation_share: string | null;
  total_amount: string;
  unit_share: string;
  classification: string;
  classification_source: string;
}

type MoneyJson = { amount: string; currency: string } | null;

/** The reserve section as stored in `reserve` (jsonb), Money as its JSON. */
interface StoredReserve {
  source: ReserveSection['source'];
  lines: {
    position: number;
    description: string;
    kind: string;
    opening: MoneyJson;
    addition: MoneyJson;
    withdrawal: MoneyJson;
    closing: MoneyJson;
    /** VC-7-03 (§58B): absent on lines stored before, and on lines without one. */
    date?: string;
  }[];
  unitShareOpening: MoneyJson;
  unitShareClosing: MoneyJson;
}

/** The membership as create and replace see it, after the unit and the WEG were written (§50). */
interface LockedMembership {
  readonly id: string;
  readonly status: string;
  readonly validFrom: BusinessDate;
  readonly validUntil: BusinessDate | null;
  readonly startMonth: number;
}

class Rejected extends Error {
  constructor(readonly outcome: StatementRefusal | { readonly kind: 'STATEMENT_EXISTS'; readonly statementId: string }) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the Jahresabrechnung port (api-design.md §50). */
export class PostgresWegAnnualStatementRepository implements WegAnnualStatementRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async createStatement(
    statement: NewAnnualStatement,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateStatementOutcome> {
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateStatementOutcome> => {
          const keyed =
            idempotency === undefined
              ? undefined
              : { ref: { mreRealmId: statement.mreRealmId, scope: CREATE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
          if (keyed !== undefined) {
            const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', statement: viewStatement(fromSnapshot(claim.result)) };
          }
          const membership = await lockMembership(trx, statement.membershipId, statement.mreRealmId);
          if (membership === undefined) throw new Rejected({ kind: 'MEMBERSHIP_NOT_FOUND' });
          await checkContent(trx, membership, statement, statement.mreRealmId);
          const lines = resolveClassifications(statement.costLines, await previousClassifications(trx, membership.id, statement.financialYear));
          const inserted = await trx
            .insertInto('weg_annual_statement')
            .values({
              ...contentValues(statement),
              mre_realm_id: statement.mreRealmId,
              membership_id: statement.membershipId,
              status: 'DRAFT' satisfies StatementStatus,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await insertLines(trx, inserted.id, statement.mreRealmId, lines);
          const created = await readOne(trx, inserted.id);
          if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, inserted.id, await snapshotOf(trx, inserted.id));
          await writeAudit(trx, { type: ENTITY_TYPE, id: inserted.id }, 'CREATED', actor, {
            newVersion: created.version,
            metadata: {
              membershipId: created.membershipId,
              financialYear: created.financialYear,
              periodFrom: created.periodFrom,
              periodUntil: created.periodUntil,
              supersedes: created.supersedes,
              lineCount: created.costLines.length,
            },
          });
          const membershipVersion = await trx.selectFrom('weg_membership').select('version').where('id', '=', membership.id).executeTakeFirstOrThrow();
          await writeAudit(trx, { type: 'WegMembership', id: membership.id }, 'ANNUAL_STATEMENT_ADDED', actor, {
            newVersion: membershipVersion.version,
            metadata: { statementId: inserted.id },
          });
          return { kind: 'CREATED', statement: viewStatement(created) };
        });
    } catch (error) {
      if (error instanceof Rejected && error.outcome.kind !== 'STATEMENT_EXISTS') return error.outcome;
      throw error;
    }
  }

  async replaceStatement(
    id: string,
    mreRealmId: string,
    content: StatementContent,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ReplaceStatementOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<ReplaceStatementOutcome> => {
          const owner = await trx
            .selectFrom('weg_annual_statement')
            .select('membership_id')
            .where('id', '=', id)
            .where('mre_realm_id', '=', mreRealmId)
            .executeTakeFirst();
          if (owner === undefined) return { kind: 'NOT_FOUND' };
          // The locks of create (unit → WEG → membership), then the statement.
          const membership = await lockMembership(trx, owner.membership_id, mreRealmId);
          const row = await trx.selectFrom('weg_annual_statement').select(COLUMNS).where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
          if (membership === undefined) return { kind: 'NOT_FOUND' };
          const current = await toStatement(trx, row);
          if (current.status !== 'DRAFT') return { kind: 'STATEMENT_NOT_DRAFT', status: current.status };
          const statement = { ...content, membershipId: current.membershipId };
          await checkContent(trx, membership, statement, mreRealmId);
          const next = {
            ...content,
            costLines: resolveClassifications(content.costLines, await previousClassifications(trx, membership.id, content.financialYear)),
          };
          if (sameContent(current, next)) return { kind: 'REPLACED', statement: viewStatement(current), changed: false };
          const conflict = checkVersion(current.version, expectedVersions);
          if (conflict !== undefined) return conflict;
          await trx
            .updateTable('weg_annual_statement')
            .set({ ...contentValues(next), version: current.version + 1, updated_at: new Date() })
            .where('id', '=', id)
            .execute();
          await trx.deleteFrom('weg_statement_cost_line').where('statement_id', '=', id).execute();
          await insertLines(trx, id, mreRealmId, next.costLines);
          const replaced = await readOne(trx, id);
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'REPLACED', actor, {
            previousVersion: current.version,
            newVersion: replaced.version,
            metadata: { changedFields: changedHeaderFields(current, next), lineCount: { from: current.costLines.length, to: replaced.costLines.length } },
          });
          return { kind: 'REPLACED', statement: viewStatement(replaced), changed: true };
        });
    } catch (error) {
      if (error instanceof Rejected && error.outcome.kind !== 'STATEMENT_EXISTS') return error.outcome;
      throw error;
    }
  }

  async confirmStatement(id: string, mreRealmId: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ConfirmStatementOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<ConfirmStatementOutcome> => {
          // The superseded statement first, then this one (§50): a second confirm superseding it waits and sees it.
          let row: StatementRow | undefined;
          for (let attempt = 0; row === undefined; attempt += 1) {
            const named = await trx
              .selectFrom('weg_annual_statement')
              .select('supersedes_id')
              .where('id', '=', id)
              .where('mre_realm_id', '=', mreRealmId)
              .executeTakeFirst();
            if (named === undefined) return { kind: 'NOT_FOUND' };
            if (named.supersedes_id !== null)
              await trx.selectFrom('weg_annual_statement').select('id').where('id', '=', named.supersedes_id).forUpdate().execute();
            const locked = await trx.selectFrom('weg_annual_statement').select(COLUMNS).where('id', '=', id).forUpdate().executeTakeFirstOrThrow();
            // A replace may have named another predecessor in between: lock that one first, then this one again.
            if (locked.supersedes_id === named.supersedes_id || attempt >= 2) row = locked;
          }
          const current = await toStatement(trx, row);
          const step = planConfirm(current.status);
          if (step === 'UNCHANGED') return { kind: 'CONFIRMED', statement: viewStatement(current), changed: false };
          if (step === 'NOT_DRAFT') return { kind: 'STATEMENT_NOT_DRAFT', status: current.status };
          const predecessor = current.supersedes === null ? undefined : await readOne(trx, current.supersedes);
          if (current.supersedes !== null) {
            const reason = supersedesRefusal(predecessor, current);
            if (reason !== undefined) return { kind: 'INVALID_SUPERSEDES', reason, supersedes: current.supersedes };
          } else {
            const existing = await confirmedOf(trx, current.membershipId, current.financialYear);
            if (existing !== undefined) return { kind: 'STATEMENT_EXISTS', statementId: existing };
          }
          const conflict = checkVersion(current.version, expectedVersions);
          if (conflict !== undefined) return conflict;
          if (predecessor !== undefined) {
            await trx
              .updateTable('weg_annual_statement')
              .set({ status: 'SUPERSEDED', superseded_by_id: id, version: predecessor.version + 1, updated_at: at })
              .where('id', '=', predecessor.id)
              .execute();
            await writeAudit(trx, { type: ENTITY_TYPE, id: predecessor.id }, 'SUPERSEDED', actor, {
              previousVersion: predecessor.version,
              newVersion: predecessor.version + 1,
              metadata: { supersededBy: id },
            });
          }
          try {
            await trx
              .updateTable('weg_annual_statement')
              .set({ status: 'CONFIRMED', confirmed_at: at, confirmed_by: actor.actorId, version: current.version + 1, updated_at: at })
              .where('id', '=', id)
              .execute();
          } catch (error) {
            // A concurrent confirm of the year committed after the check above: the partial unique index decides.
            if (isConfirmedKeyViolation(error)) throw new Rejected({ kind: 'STATEMENT_EXISTS', statementId: '' });
            throw error;
          }
          const confirmed = await readOne(trx, id);
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CONFIRMED', actor, {
            previousVersion: current.version,
            newVersion: confirmed.version,
            metadata: { supersedes: confirmed.supersedes },
          });
          return { kind: 'CONFIRMED', statement: viewStatement(confirmed), changed: true };
        });
    } catch (error) {
      if (error instanceof Rejected && error.outcome.kind === 'STATEMENT_EXISTS') {
        const statement = await this.db
          .selectFrom('weg_annual_statement')
          .select(['membership_id', 'financial_year'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow();
        return { kind: 'STATEMENT_EXISTS', statementId: (await confirmedOf(this.db, statement.membership_id, statement.financial_year)) ?? '' };
      }
      throw error;
    }
  }

  async voidStatement(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidStatementOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<VoidStatementOutcome> => {
        const row = await trx
          .selectFrom('weg_annual_statement')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        const current = await toStatement(trx, row);
        const step = planVoid(current.status);
        if (step === 'UNCHANGED') return { kind: 'VOIDED', statement: viewStatement(current), changed: false };
        if (step === 'NOT_DRAFT') return { kind: 'STATEMENT_NOT_DRAFT', status: current.status };
        const conflict: VersionConflict | undefined = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('weg_annual_statement')
          .set({ status: 'VOID', voided_at: at, voided_by: actor.actorId, void_reason: reason, version: current.version + 1, updated_at: at })
          .where('id', '=', id)
          .execute();
        const voided = await readOne(trx, id);
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'VOIDED', actor, {
          previousVersion: current.version,
          newVersion: voided.version,
          metadata: { reason },
        });
        return { kind: 'VOIDED', statement: viewStatement(voided), changed: true };
      });
  }

  async findStatement(id: string, mreRealmId: string): Promise<StatementView | undefined> {
    if (!UUID.test(id)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const row = await trx.selectFrom('weg_annual_statement').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
        return row === undefined ? undefined : viewStatement(await toStatement(trx, row));
      });
  }

  async listStatements(membershipId: string, mreRealmId: string, filter: StatementFilter, page: PageRequest): Promise<Page<StatementView> | undefined> {
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
          let query = trx.selectFrom('weg_annual_statement').where('membership_id', '=', membershipId).where('mre_realm_id', '=', mreRealmId);
          if (filter.statuses !== undefined && filter.statuses.length > 0) query = query.where('status', 'in', [...filter.statuses]);
          if (filter.financialYear !== undefined) query = query.where('financial_year', '=', filter.financialYear);
          return query;
        };
        const { n } = await filtered()
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .executeTakeFirstOrThrow();
        const rows = await filtered()
          .select(COLUMNS)
          .orderBy('financial_year')
          .orderBy('created_at')
          .orderBy('id')
          .limit(page.pageSize)
          .offset((page.page - 1) * page.pageSize)
          .execute();
        // The lines feed the flags and sums; the list leaves them out of its items (§50).
        const lines =
          rows.length === 0
            ? []
            : await trx
                .selectFrom('weg_statement_cost_line')
                .select(LINE_COLUMNS)
                .where(
                  'statement_id',
                  'in',
                  rows.map((r) => r.id),
                )
                .execute();
        const items = rows.map((r) =>
          viewStatement(
            toDomain(
              r,
              lines.filter((l) => l.statement_id === r.id),
            ),
          ),
        );
        return { items, page: page.page, pageSize: page.pageSize, total: Number(n) };
      });
  }
  async comparisonContext(statementId: string, mreRealmId: string): Promise<ComparisonContext> {
    if (!UUID.test(statementId)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const row = await trx
          .selectFrom('weg_annual_statement')
          .select(COLUMNS)
          .where('id', '=', statementId)
          .where('mre_realm_id', '=', mreRealmId)
          .executeTakeFirst();
        if (row === undefined) return { kind: 'NOT_FOUND' };
        if (row.status !== 'CONFIRMED' && row.status !== 'SUPERSEDED') return { kind: 'STATEMENT_NOT_CONFIRMED', status: row.status };
        return comparisonOf(trx, await toStatement(trx, row));
      });
  }

  async settlementContext(transactionId: string, statementId: string, mreRealmId: string): Promise<SettlementContext> {
    if (!UUID.test(transactionId)) return { kind: 'TRANSACTION_NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx): Promise<SettlementContext> => {
        const tx = await trx
          .selectFrom('ledger_transaction')
          .select(['id', 'amount', 'currency', 'direction', 'status'])
          .where('id', '=', transactionId)
          .where('mre_realm_id', '=', mreRealmId)
          .executeTakeFirst();
        if (tx === undefined) return { kind: 'TRANSACTION_NOT_FOUND' };
        const row = UUID.test(statementId)
          ? await trx.selectFrom('weg_annual_statement').select(COLUMNS).where('id', '=', statementId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst()
          : undefined;
        if (row === undefined) return { kind: 'STATEMENT_NOT_FOUND' };
        if (!UNCONFIRMED.includes(tx.status)) return { kind: 'NOT_PROPOSABLE', status: tx.status };
        if (row.status !== 'CONFIRMED') return { kind: 'STATEMENT_NOT_CURRENT', status: row.status, supersededBy: row.superseded_by_id };
        const split = await trx.selectFrom('transaction_split').select('id').where('transaction_id', '=', tx.id).executeTakeFirst();
        return {
          kind: 'FOUND',
          transactionId: tx.id,
          amount: fromNumericAmount(tx.amount, tx.currency),
          direction: tx.direction as 'INFLOW' | 'OUTFLOW',
          alreadySplit: split !== undefined,
          comparison: await comparisonOf(trx, await toStatement(trx, row)),
        };
      });
  }
}

/**
 * The locks of every membership writer (§50): the unit (no-op write), the WEG (no-op write, reading the start month
 * under that lock), then the membership row `FOR UPDATE`; undefined for an unknown or foreign membership.
 */
async function lockMembership(trx: Transaction<Database>, membershipId: string, mreRealmId: string): Promise<LockedMembership | undefined> {
  if (!UUID.test(membershipId)) return undefined;
  const ofMembership = <C extends 'property_reference_id' | 'weg_id'>(column: C) =>
    trx.selectFrom('weg_membership').select(column).where('id', '=', membershipId).where('mre_realm_id', '=', mreRealmId);
  await trx
    .updateTable('property_reference')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', ofMembership('property_reference_id'))
    .execute();
  const weg = await trx
    .updateTable('weg')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', ofMembership('weg_id'))
    .returning('financial_year_start_month')
    .executeTakeFirst();
  const membership = await trx
    .selectFrom('weg_membership')
    .select(['id', 'status', date('valid_from'), optionalDate('valid_until')])
    .where('id', '=', membershipId)
    .where('mre_realm_id', '=', mreRealmId)
    .forUpdate()
    .executeTakeFirst();
  if (membership === undefined || weg === undefined) return undefined;
  return {
    id: membership.id,
    status: membership.status,
    validFrom: membership.valid_from as BusinessDate,
    validUntil: membership.valid_until as BusinessDate | null,
    startMonth: weg.financial_year_start_month,
  };
}

/** §50's order after the membership: period in the year, membership `ACTIVE`, period in the membership, `supersedes`. */
async function checkContent(
  trx: Transaction<Database>,
  membership: LockedMembership,
  statement: Pick<NewAnnualStatement, 'membershipId' | 'financialYear' | 'periodFrom' | 'periodUntil' | 'supersedes'>,
  mreRealmId: string,
): Promise<void> {
  const year = financialYearOf(statement.financialYear, membership.startMonth);
  for (const field of ['periodFrom', 'periodUntil'] as const) {
    const day = statement[field];
    if (day < year.from || day > year.until) throw new Rejected({ kind: 'PERIOD_OUTSIDE_YEAR', field, ...year });
  }
  if (membership.status !== 'ACTIVE') throw new Rejected({ kind: 'MEMBERSHIP_NOT_ACTIVE', membershipId: membership.id });
  if (statement.periodFrom < membership.validFrom || (membership.validUntil !== null && statement.periodUntil > membership.validUntil)) {
    throw new Rejected({ kind: 'STATEMENT_OUTSIDE_MEMBERSHIP', validFrom: membership.validFrom, validUntil: membership.validUntil });
  }
  if (statement.supersedes !== null) {
    const target = UUID.test(statement.supersedes)
      ? await trx
          .selectFrom('weg_annual_statement')
          .select(['membership_id', 'financial_year', 'status'])
          .where('id', '=', statement.supersedes)
          .where('mre_realm_id', '=', mreRealmId)
          .executeTakeFirst()
      : undefined;
    const reason = supersedesRefusal(
      target === undefined ? undefined : { membershipId: target.membership_id, financialYear: target.financial_year, status: target.status as StatementStatus },
      statement,
    );
    if (reason !== undefined) throw new Rejected({ kind: 'INVALID_SUPERSEDES', reason, supersedes: statement.supersedes });
  }
}

/** By account, the classifications of the membership's last `CONFIRMED` statement of an earlier year (P6-D8). */
async function previousClassifications(trx: Transaction<Database>, membershipId: string, financialYear: number): Promise<Map<string, Classification>> {
  const previous = await trx
    .selectFrom('weg_annual_statement')
    .select('id')
    .where('membership_id', '=', membershipId)
    .where('status', '=', 'CONFIRMED')
    .where('financial_year', '<', financialYear)
    .orderBy('financial_year', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (previous === undefined) return new Map();
  const lines = await trx
    .selectFrom('weg_statement_cost_line')
    .select(['account', 'position', 'classification'])
    .where('statement_id', '=', previous.id)
    .execute();
  return classificationsByAccount(lines.map((l) => ({ ...l, classification: l.classification as Classification })));
}

async function confirmedOf(db: Kysely<Database> | Transaction<Database>, membershipId: string, financialYear: number): Promise<string | undefined> {
  const row = await db
    .selectFrom('weg_annual_statement')
    .select('id')
    .where('membership_id', '=', membershipId)
    .where('financial_year', '=', financialYear)
    .where('status', '=', 'CONFIRMED')
    .executeTakeFirst();
  return row?.id;
}

function isConfirmedKeyViolation(error: unknown): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError.code === '23505' && pgError.constraint === CONFIRMED_KEY;
}

const optionalMoney = (m: Money | null) => (m === null ? null : toNumericAmount(m));

function contentValues(content: StatementContent<unknown>) {
  return {
    financial_year: content.financialYear,
    period_from: content.periodFrom,
    period_until: content.periodUntil,
    document_date: content.documentDate,
    resolution_date: content.resolutionDate,
    due_date: content.dueDate,
    supersedes_id: content.supersedes,
    recoverable_subtotal: toNumericAmount(content.recoverableSubtotal),
    non_recoverable_subtotal: toNumericAmount(content.nonRecoverableSubtotal),
    total_costs: toNumericAmount(content.totalCosts),
    hausgeld_requested: toNumericAmount(content.hausgeldRequested),
    hausgeld_paid: toNumericAmount(content.hausgeldPaid),
    reserve_requested: optionalMoney(content.reserveRequested),
    reserve_paid: optionalMoney(content.reservePaid),
    settlement_peak: toNumericAmount(content.settlementPeak),
    settlement_result: optionalMoney(content.settlementResult),
    currency: 'EUR',
    reserve: content.reserve === null ? null : JSON.stringify(toStoredReserve(content.reserve)),
    source_references: [...content.sourceReferences],
    notes: content.notes,
  };
}

async function insertLines(trx: Transaction<Database>, statementId: string, mreRealmId: string, lines: readonly StatementCostLine[]): Promise<void> {
  if (lines.length === 0) return;
  await trx
    .insertInto('weg_statement_cost_line')
    .values(
      lines.map((line) => ({
        mre_realm_id: mreRealmId,
        statement_id: statementId,
        position: line.position,
        account: line.account,
        cost_group: line.group,
        allocation_key: line.allocationKey,
        allocation_total: line.allocationTotal,
        allocation_share: line.allocationShare,
        total_amount: toNumericAmount(line.totalAmount),
        unit_share: toNumericAmount(line.unitShare),
        currency: 'EUR',
        classification: line.classification,
        classification_source: line.classificationSource,
      })),
    )
    .execute();
}

async function readOne(trx: Transaction<Database>, id: string): Promise<AnnualStatement> {
  return toStatement(trx, await trx.selectFrom('weg_annual_statement').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

async function toStatement(trx: Transaction<Database>, row: StatementRow): Promise<AnnualStatement> {
  return toDomain(row, await trx.selectFrom('weg_statement_cost_line').select(LINE_COLUMNS).where('statement_id', '=', row.id).execute());
}

const money = (value: string) => fromNumericAmount(value, 'EUR');
const moneyOrNull = (value: string | null) => (value === null ? null : money(value));
const fromJson = (json: MoneyJson) => (json === null ? null : Money.fromJSON(json));
const toJson = (m: Money | null): MoneyJson => (m === null ? null : m.toJSON());

function toStoredReserve(reserve: ReserveSection): StoredReserve {
  return {
    source: reserve.source,
    lines: reserve.lines.map((l) => ({
      position: l.position,
      description: l.description,
      kind: l.kind,
      opening: toJson(l.opening),
      addition: toJson(l.addition),
      withdrawal: toJson(l.withdrawal),
      closing: toJson(l.closing),
      ...(l.date === null || l.date === undefined ? {} : { date: l.date }),
    })),
    unitShareOpening: toJson(reserve.unitShareOpening),
    unitShareClosing: toJson(reserve.unitShareClosing),
  };
}

/** The stored `reserve` jsonb as the domain's section (also read by Taxation, §58B, without the cost lines). */
export const reserveFromJson = (stored: unknown): ReserveSection | null => (stored === null ? null : fromStoredReserve(stored as StoredReserve));

function fromStoredReserve(stored: StoredReserve): ReserveSection {
  return {
    source: stored.source,
    lines: stored.lines.map((l) => ({
      position: l.position,
      description: l.description,
      kind: l.kind as ReserveSection['lines'][number]['kind'],
      opening: fromJson(l.opening),
      addition: fromJson(l.addition),
      withdrawal: fromJson(l.withdrawal),
      closing: fromJson(l.closing),
      date: (l.date ?? null) as BusinessDate | null,
    })),
    unitShareOpening: fromJson(stored.unitShareOpening),
    unitShareClosing: fromJson(stored.unitShareClosing),
  };
}

function toDomain(row: StatementRow, lines: readonly LineRow[]): AnnualStatement {
  return {
    id: row.id as WegAnnualStatementId,
    mreRealmId: row.mre_realm_id,
    membershipId: row.membership_id,
    financialYear: row.financial_year,
    periodFrom: row.period_from as BusinessDate,
    periodUntil: row.period_until as BusinessDate,
    documentDate: row.document_date as BusinessDate | null,
    resolutionDate: row.resolution_date as BusinessDate | null,
    dueDate: row.due_date as BusinessDate | null,
    supersedes: row.supersedes_id,
    supersededBy: row.superseded_by_id,
    recoverableSubtotal: money(row.recoverable_subtotal),
    nonRecoverableSubtotal: money(row.non_recoverable_subtotal),
    totalCosts: money(row.total_costs),
    hausgeldRequested: money(row.hausgeld_requested),
    hausgeldPaid: money(row.hausgeld_paid),
    reserveRequested: moneyOrNull(row.reserve_requested),
    reservePaid: moneyOrNull(row.reserve_paid),
    settlementPeak: money(row.settlement_peak),
    settlementResult: moneyOrNull(row.settlement_result),
    costLines: [...lines]
      .sort((a, b) => a.position - b.position)
      .map((l) => ({
        position: l.position,
        account: l.account,
        group: l.cost_group as CostGroup,
        allocationKey: l.allocation_key,
        allocationTotal: l.allocation_total === null ? null : normalizeQuantity(l.allocation_total),
        allocationShare: l.allocation_share === null ? null : normalizeQuantity(l.allocation_share),
        totalAmount: money(l.total_amount),
        unitShare: money(l.unit_share),
        classification: l.classification as Classification,
        classificationSource: l.classification_source as ClassificationSource,
      })),
    reserve: row.reserve === null ? null : fromStoredReserve(row.reserve as StoredReserve),
    status: row.status as StatementStatus,
    confirmedAt: row.confirmed_at,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    sourceReferences: row.source_references,
    notes: row.notes,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created rows as JSON for the idempotency store: timestamps as ISO strings. */
interface StatementSnapshot {
  readonly row: Omit<StatementRow, 'created_at' | 'confirmed_at' | 'voided_at'> & { readonly created_at: string };
  readonly lines: readonly LineRow[];
}

async function snapshotOf(trx: Transaction<Database>, id: string): Promise<StatementSnapshot> {
  const {
    created_at,
    confirmed_at: _confirmed,
    voided_at: _voided,
    ...row
  } = await trx.selectFrom('weg_annual_statement').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow();
  const lines = await trx.selectFrom('weg_statement_cost_line').select(LINE_COLUMNS).where('statement_id', '=', id).execute();
  return { row: { ...row, created_at: created_at.toISOString() }, lines };
}

/** Written by snapshotOf in the same codebase, so its shape is trusted; a created statement is a `DRAFT`. */
function fromSnapshot(result: unknown): AnnualStatement {
  const { row, lines } = result as StatementSnapshot;
  return toDomain({ ...row, created_at: new Date(row.created_at), confirmed_at: null, voided_at: null }, lines);
}

/**
 * The statements named by a split set (§51), each **written** with P3-D8's no-op in id order after the Transaction and
 * the units (Transaction → PropertyReference → statement), with their status, unit and successor; foreign or unknown
 * ones are left out.
 */
export async function lockStatementsOf(trx: Transaction<Database>, mreRealmId: string, ids: readonly string[]): Promise<Map<string, SplitStatement>> {
  const found = new Map<string, SplitStatement>();
  for (const id of [...new Set(ids)].filter((i) => UUID.test(i)).sort()) {
    const row = await trx
      .updateTable('weg_annual_statement')
      .set((eb) => ({ version: eb.ref('version') }))
      .where('id', '=', id)
      .where('mre_realm_id', '=', mreRealmId)
      .returning(['status', 'membership_id', 'superseded_by_id'])
      .executeTakeFirst();
    if (row === undefined) continue;
    const membership = await trx.selectFrom('weg_membership').select('property_reference_id').where('id', '=', row.membership_id).executeTakeFirstOrThrow();
    found.set(id, { status: row.status, propertyReferenceId: membership.property_reference_id, supersededBy: row.superseded_by_id });
  }
  return found;
}

const UNCONFIRMED = ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'];
const COUNTED = ['CONFIRMED', 'RECONCILED'];

/** The signed amount of a split: an `OUTFLOW` positive, an `INFLOW` negative (§51). */
const signed = (amount: string, currency: string, direction: string) => {
  const money = fromNumericAmount(amount, currency);
  return direction === 'INFLOW' ? money.negate() : money;
};

/**
 * §51's inputs for a statement, in the caller's snapshot: the chain (the statement and those it supersedes,
 * transitively), the unit's counted WEG splits in the period that name no statement, the current settlements naming
 * the chain, and the uncounted WEG splits in the period.
 */
async function comparisonOf(trx: Transaction<Database>, statement: AnnualStatement): Promise<Extract<ComparisonContext, { kind: 'FOUND' }>> {
  const membership = await trx
    .selectFrom('weg_membership')
    .select(['property_reference_id', sql<string>`mea_numerator::text`.as('mea_numerator'), sql<string>`mea_denominator::text`.as('mea_denominator')])
    .where('id', '=', statement.membershipId)
    .executeTakeFirstOrThrow();
  const chain = [statement.id as string];
  for (let next = statement.supersedes; next !== null; ) {
    chain.push(next);
    const predecessor = await trx.selectFrom('weg_annual_statement').select('supersedes_id').where('id', '=', next).executeTakeFirstOrThrow();
    next = predecessor.supersedes_id;
  }
  const unit = membership.property_reference_id;
  const wegSplits = () =>
    trx
      .selectFrom('transaction_split as s')
      .innerJoin('financial_category as c', 'c.id', 's.financial_category_id')
      .innerJoin('ledger_transaction as t', 't.id', 's.transaction_id')
      .select([
        't.id as transaction_id',
        sql<string>`to_char(t.booking_date, 'YYYY-MM-DD')`.as('booking_date'),
        't.direction',
        't.status',
        's.amount',
        's.currency',
        'c.code',
        's.weg_annual_statement_id',
      ])
      .where('s.property_reference_id', '=', unit)
      .where('c.code', 'in', Object.keys(CLASS_OF_CATEGORY))
      .where((eb) => eb.or([eb('t.correction_role', 'is', null), eb('t.correction_role', '<>', 'REVERSAL')]));
  const inPeriod = await wegSplits().where('t.booking_date', '>=', statement.periodFrom).where('t.booking_date', '<=', statement.periodUntil).execute();
  const settlements = await wegSplits().where('s.weg_annual_statement_id', 'in', chain).where('t.status', 'in', COUNTED).execute();
  return {
    kind: 'FOUND',
    statement: viewStatement(statement),
    propertyReferenceId: unit,
    mea: meaFromColumns(membership.mea_numerator, membership.mea_denominator),
    advances: inPeriod
      .filter((r) => COUNTED.includes(r.status) && r.weg_annual_statement_id === null)
      .map((r) => ({
        transactionId: r.transaction_id,
        bookingDate: r.booking_date as BusinessDate,
        category: r.code as WegCategory,
        amount: signed(r.amount, r.currency, r.direction),
      })),
    settlements: settlements.map((r) => ({
      transactionId: r.transaction_id,
      statementId: r.weg_annual_statement_id as string,
      bookingDate: r.booking_date as BusinessDate,
      amount: signed(r.amount, r.currency, r.direction),
    })),
    uncountedTransactionIds: inPeriod.filter((r) => UNCONFIRMED.includes(r.status)).map((r) => r.transaction_id),
  };
}
