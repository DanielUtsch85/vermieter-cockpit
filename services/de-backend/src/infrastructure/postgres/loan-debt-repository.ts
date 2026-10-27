import { sql, type Kysely, type Transaction } from 'kysely';
import {
  checkStatement,
  compareStatement,
  planVoidStatement,
  withValidUntil,
  type CreateStatementOutcome,
  type DebtInputs,
  type Loan,
  type LoanBalanceStatement,
  type LoanBalanceStatementId,
  type LoanDebtRepository,
  type StatementData,
  type StatementStatus,
  type VoidStatementOutcome,
} from '../../domains/financing/index.js';
import { checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { setsOf } from './loan-allocation-repository.js';
import { countedSplitsOf, lockLoan, readLoanIn } from './loan-repository.js';
import { periodsOf } from './loan-terms-repository.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'LoanBalanceStatement';
const CREATE_SCOPE = 'loan.statement.create';

/** Every column, the date as `YYYY-MM-DD` text and the balance as text (exact). */
const COLUMNS = [
  'id',
  'mre_realm_id',
  'loan_id',
  'status',
  sql<string>`to_char(statement_date, 'YYYY-MM-DD')`.as('statement_date'),
  sql<string>`balance::text`.as('balance'),
  'currency',
  'source',
  'notes',
  'voided_at',
  'void_reason',
  'created_at',
  'version',
] as const;

interface StatementRow {
  id: string;
  mre_realm_id: string;
  loan_id: string;
  status: string;
  statement_date: string;
  balance: string;
  currency: string;
  source: string;
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
  version: number;
}

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateStatementOutcome) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of §41.6's reads and lender statements. */
export class PostgresLoanDebtRepository implements LoanDebtRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async debtInputs(loanId: string, mreRealmId: string): Promise<DebtInputs | undefined> {
    if (!UUID.test(loanId)) return undefined;
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      const loan = await readLoanIn(trx, loanId, mreRealmId);
      if (loan === undefined) return undefined;
      return inputsIn(trx, loan);
    });
  }

  async createStatement(
    loanId: string,
    mreRealmId: string,
    data: StatementData,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateStatementOutcome> {
    if (!UUID.test(loanId)) return { kind: 'LOAN_NOT_FOUND' };
    try {
      return await this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<CreateStatementOutcome> => {
        const ref = { mreRealmId, scope: CREATE_SCOPE, key: idempotency?.key ?? '' };
        if (idempotency !== undefined) {
          const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
          if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
          if (claim.kind === 'REPLAY') {
            // The comparison is derived at each read, so a replay derives it again.
            const loan = await readLoanIn(trx, loanId, mreRealmId);
            return { kind: 'REPLAYED', statement: compareStatement(loan as Loan, await countedSplitsOf(trx, loanId), fromSnapshot(claim.result)) };
          }
        }
        // P3-D8: the Loan row first; no Transaction is locked.
        const loan = await lockLoan(trx, loanId, mreRealmId);
        if (loan === undefined) throw new Rejected({ kind: 'LOAN_NOT_FOUND' });
        const refusal = checkStatement(loan, data.statementDate);
        if (refusal !== undefined) throw new Rejected(refusal);
        const { id } = await trx
          .insertInto('loan_balance_statement')
          .values({
            mre_realm_id: mreRealmId,
            loan_id: loanId,
            status: 'VALID' satisfies StatementStatus,
            statement_date: data.statementDate,
            balance: toNumericAmount(data.balance),
            currency: data.balance.currency,
            source: data.source,
            notes: data.notes,
            created_by: actor.actorId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const created = await readStatement(trx, id);
        if (idempotency !== undefined) await recordIdempotentResult(trx, ref, id, toSnapshot(created));
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CREATED', actor, {
          newVersion: 1,
          metadata: { loanId, statementDate: created.statementDate, balance: created.balance.toJSON(), source: created.source, notes: created.notes },
        });
        return { kind: 'CREATED', statement: compareStatement(loan, await countedSplitsOf(trx, loanId), created) };
      });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  async voidStatement(
    loanId: string,
    statementId: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidStatementOutcome> {
    if (!UUID.test(loanId) || !UUID.test(statementId)) return { kind: 'NOT_FOUND' };
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<VoidStatementOutcome> => {
      const loan = await lockLoan(trx, loanId, mreRealmId);
      if (loan === undefined) return { kind: 'NOT_FOUND' };
      const current = await trx.selectFrom('loan_balance_statement').select(COLUMNS).where('id', '=', statementId).where('loan_id', '=', loanId).executeTakeFirst();
      if (current === undefined) return { kind: 'NOT_FOUND' };
      const statement = toStatement(current);
      const plan = planVoidStatement(loan, statement, reason, at);
      if (plan.kind === 'UNCHANGED') return { kind: 'VOIDED', statement: compareStatement(loan, await countedSplitsOf(trx, loanId), statement), changed: false };
      if (plan.kind !== 'VOID') return plan;
      const conflict = checkVersion(statement.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      await trx
        .updateTable('loan_balance_statement')
        .set({ status: 'VOID', voided_at: at, void_reason: reason, version: plan.next.version, updated_at: at })
        .where('id', '=', statementId)
        .execute();
      const voided = await readStatement(trx, statementId);
      await writeAudit(trx, { type: ENTITY_TYPE, id: statementId }, 'VOIDED', actor, {
        previousVersion: statement.version,
        newVersion: voided.version,
        metadata: { loanId, reason },
      });
      return { kind: 'VOIDED', statement: compareStatement(loan, await countedSplitsOf(trx, loanId), voided), changed: true };
    });
  }
}

/** Everything §41.6 derives from, inside the caller's snapshot. */
async function inputsIn(trx: Transaction<Database>, loan: Loan): Promise<DebtInputs> {
  return {
    loan,
    periods: (await periodsOf(trx, loan.id)).filter((t) => t.status === 'VALID'),
    sets: withValidUntil(await setsOf(trx, loan.id)),
    splits: await countedSplitsOf(trx, loan.id),
    statements: (await trx.selectFrom('loan_balance_statement').select(COLUMNS).where('loan_id', '=', loan.id).orderBy('statement_date').orderBy('created_at').orderBy('id').execute()).map(
      toStatement,
    ),
  };
}

async function readStatement(trx: Transaction<Database>, id: string): Promise<LoanBalanceStatement> {
  return toStatement(await trx.selectFrom('loan_balance_statement').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

function toStatement(row: StatementRow): LoanBalanceStatement {
  return {
    id: row.id as LoanBalanceStatementId,
    loanId: row.loan_id,
    mreRealmId: row.mre_realm_id,
    status: row.status as StatementStatus,
    statementDate: row.statement_date as BusinessDate,
    balance: fromNumericAmount(row.balance, row.currency),
    source: row.source,
    notes: row.notes,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created statement as JSON for the idempotency store, without its comparison (derived at each read). */
function toSnapshot(s: LoanBalanceStatement): unknown {
  return { ...s, balance: s.balance.toJSON(), voidedAt: s.voidedAt?.toISOString() ?? null, createdAt: s.createdAt.toISOString() };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): LoanBalanceStatement {
  const s = result as Omit<LoanBalanceStatement, 'balance' | 'voidedAt' | 'createdAt'> & {
    balance: { amount: string; currency: string };
    voidedAt: string | null;
    createdAt: string;
  };
  return { ...s, balance: fromNumericAmount(s.balance.amount, s.balance.currency), voidedAt: s.voidedAt === null ? null : new Date(s.voidedAt), createdAt: new Date(s.createdAt) };
}
