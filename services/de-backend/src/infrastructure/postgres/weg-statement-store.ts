import { type Kysely, type Transaction } from 'kysely';
import {
  changedHeaderFields,
  classificationsByAccount,
  financialYearOf,
  planConfirm,
  planVoid,
  resolveClassifications,
  sameContent,
  supersedesRefusal,
  viewStatement,
  type Classification,
  type ConfirmStatementOutcome,
  type CreateStatementOutcome,
  type NewAnnualStatement,
  type Page,
  type PageRequest,
  type ReplaceStatementOutcome,
  type StatementContent,
  type StatementCostLine,
  type StatementFilter,
  type StatementRefusal,
  type StatementStatus,
  type StatementView,
  type VoidStatementOutcome,
} from '../../domains/weg/index.js';
import { checkVersion, type AuditActor, type Money, type BusinessDate, type VersionConflict } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import {
  COLUMNS,
  LINE_COLUMNS,
  UUID,
  date,
  fromSnapshot,
  optionalDate,
  readOne,
  snapshotOf,
  toDomain,
  toStatement,
  toStoredReserve,
  type StatementRow,
} from './weg-statement-rows.js';

/** The statements' lifecycle (api-design.md §50): create, replace, confirm, void, find and list. */

const ENTITY_TYPE = 'WegAnnualStatement';
const CREATE_SCOPE = 'weg-annual-statement.create';
const CONFIRMED_KEY = 'weg_annual_statement_confirmed_key';

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

export async function createStatement(
  db: Kysely<Database>,
  statement: NewAnnualStatement,
  actor: AuditActor,
  idempotency?: { readonly key: string; readonly fingerprint: string },
): Promise<CreateStatementOutcome> {
  try {
    return await db
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

export async function replaceStatement(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  content: StatementContent,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<ReplaceStatementOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  try {
    return await db
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

export async function confirmStatement(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  at: Date,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<ConfirmStatementOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  try {
    return await db
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
      const statement = await db.selectFrom('weg_annual_statement').select(['membership_id', 'financial_year']).where('id', '=', id).executeTakeFirstOrThrow();
      return { kind: 'STATEMENT_EXISTS', statementId: (await confirmedOf(db, statement.membership_id, statement.financial_year)) ?? '' };
    }
    throw error;
  }
}

export async function voidStatement(
  db: Kysely<Database>,
  id: string,
  mreRealmId: string,
  reason: string,
  at: Date,
  actor: AuditActor,
  expectedVersions?: readonly number[],
): Promise<VoidStatementOutcome> {
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  return db
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

export async function findStatement(db: Kysely<Database>, id: string, mreRealmId: string): Promise<StatementView | undefined> {
  if (!UUID.test(id)) return undefined;
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute(async (trx) => {
      const row = await trx.selectFrom('weg_annual_statement').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
      return row === undefined ? undefined : viewStatement(await toStatement(trx, row));
    });
}

export async function listStatements(
  db: Kysely<Database>,
  membershipId: string,
  mreRealmId: string,
  filter: StatementFilter,
  page: PageRequest,
): Promise<Page<StatementView> | undefined> {
  if (!UUID.test(membershipId)) return undefined;
  return db
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
