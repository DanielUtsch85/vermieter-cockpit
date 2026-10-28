import { sql, type Kysely, type Transaction } from 'kysely';
import {
  checkAppend,
  formatRate,
  parseRate,
  planVoidTerms,
  withValidUntil,
  type CreateTermsOutcome,
  type Loan,
  type LoanTerms,
  type LoanTermsData,
  type LoanTermsId,
  type LoanTermsRepository,
  type LoanTermsView,
  type RepaymentModel,
  type TermsStatus,
  type VoidTermsOutcome,
} from '../../domains/financing/index.js';
import { checkVersion, type AuditActor, type BusinessDate, type Money } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { lockLoan, readLoanIn } from './loan-repository.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'LoanTerms';
const CREATE_SCOPE = 'loan.terms.create';

/** Every column, the dates as `YYYY-MM-DD` text and the numbers as text (exact). */
const COLUMNS = [
  'id',
  'mre_realm_id',
  'loan_id',
  'status',
  sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from'),
  sql<string>`interest_rate::text`.as('interest_rate'),
  'repayment_model',
  sql<string | null>`scheduled_payment::text`.as('scheduled_payment'),
  sql<string>`to_char(first_payment_date, 'YYYY-MM-DD')`.as('first_payment_date'),
  sql<string | null>`principal_at_start::text`.as('principal_at_start'),
  sql<string | null>`to_char(fixed_rate_until, 'YYYY-MM-DD')`.as('fixed_rate_until'),
  sql<string | null>`initial_repayment_rate::text`.as('initial_repayment_rate'),
  sql<string | null>`special_repayment_limit::text`.as('special_repayment_limit'),
  'currency',
  'notes',
  'voided_at',
  'void_reason',
  'created_at',
  'version',
] as const;

interface TermsRow {
  id: string;
  mre_realm_id: string;
  loan_id: string;
  status: string;
  valid_from: string;
  interest_rate: string;
  repayment_model: string;
  scheduled_payment: string | null;
  first_payment_date: string;
  principal_at_start: string | null;
  fixed_rate_until: string | null;
  initial_repayment_rate: string | null;
  special_repayment_limit: string | null;
  currency: string;
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
  version: number;
}

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateTermsOutcome) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the terms port (api-design.md §41.2). */
export class PostgresLoanTermsRepository implements LoanTermsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(
    loanId: string,
    mreRealmId: string,
    terms: LoanTermsData,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateTermsOutcome> {
    if (!UUID.test(loanId)) return { kind: 'LOAN_NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateTermsOutcome> => {
          const ref = { mreRealmId, scope: CREATE_SCOPE, key: idempotency?.key ?? '' };
          if (idempotency !== undefined) {
            const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', terms: fromSnapshot(claim.result) };
          }
          // P3-D8: the Loan row first; no Transaction is locked.
          const loan = await lockLoan(trx, loanId, mreRealmId);
          if (loan === undefined) throw new Rejected({ kind: 'LOAN_NOT_FOUND' });
          const valid = (await periodsOf(trx, loanId)).filter((t) => t.status === 'VALID');
          const refusal = checkAppend(loan, valid, terms);
          if (refusal !== undefined) throw new Rejected(refusal);

          const { id } = await trx
            .insertInto('loan_terms')
            .values({
              mre_realm_id: mreRealmId,
              loan_id: loanId,
              status: 'VALID' satisfies TermsStatus,
              valid_from: terms.validFrom,
              interest_rate: formatRate(terms.interestRate),
              repayment_model: terms.repaymentModel,
              scheduled_payment: terms.scheduledPayment === null ? null : toNumericAmount(terms.scheduledPayment),
              first_payment_date: terms.firstPaymentDate,
              principal_at_start: terms.principalAtStart === null ? null : toNumericAmount(terms.principalAtStart),
              fixed_rate_until: terms.fixedRateUntil,
              initial_repayment_rate: terms.initialRepaymentRate === null ? null : formatRate(terms.initialRepaymentRate),
              special_repayment_limit: terms.specialRepaymentLimit === null ? null : toNumericAmount(terms.specialRepaymentLimit),
              currency: loan.principalOriginal.currency,
              notes: terms.notes,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const created = await viewOf(trx, loanId, id);
          if (idempotency !== undefined) await recordIdempotentResult(trx, ref, id, toSnapshot(created));
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CREATED', actor, {
            newVersion: 1,
            metadata: {
              loanId,
              validFrom: created.validFrom,
              interestRate: formatRate(created.interestRate),
              repaymentModel: created.repaymentModel,
              scheduledPayment: created.scheduledPayment?.toJSON() ?? null,
              firstPaymentDate: created.firstPaymentDate,
              principalAtStart: created.principalAtStart?.toJSON() ?? null,
              fixedRateUntil: created.fixedRateUntil,
              initialRepaymentRate: created.initialRepaymentRate === null ? null : formatRate(created.initialRepaymentRate),
              specialRepaymentLimit: created.specialRepaymentLimit?.toJSON() ?? null,
              notes: created.notes,
            },
          });
          return { kind: 'CREATED', terms: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  async void(
    loanId: string,
    termsId: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidTermsOutcome> {
    if (!UUID.test(loanId) || !UUID.test(termsId)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<VoidTermsOutcome> => {
        const loan = await lockLoan(trx, loanId, mreRealmId);
        if (loan === undefined) return { kind: 'NOT_FOUND' };
        const periods = await periodsOf(trx, loanId);
        const current = periods.find((t) => t.id === termsId);
        if (current === undefined) return { kind: 'NOT_FOUND' };
        const plan = planVoidTerms(
          loan,
          current,
          periods.filter((t) => t.status === 'VALID'),
          reason,
          at,
        );
        if (plan.kind === 'UNCHANGED') return { kind: 'VOIDED', terms: withValidUntil(periods).find((t) => t.id === termsId) as LoanTermsView, changed: false };
        if (plan.kind !== 'VOID') return plan;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('loan_terms')
          .set({ status: 'VOID', voided_at: at, void_reason: reason, version: plan.next.version, updated_at: at })
          .where('id', '=', termsId)
          .execute();
        const voided = await viewOf(trx, loanId, termsId);
        await writeAudit(trx, { type: ENTITY_TYPE, id: termsId }, 'VOIDED', actor, {
          previousVersion: current.version,
          newVersion: voided.version,
          metadata: { loanId, reason },
        });
        return { kind: 'VOIDED', terms: voided, changed: true };
      });
  }

  async list(loanId: string, mreRealmId: string, status?: TermsStatus): Promise<readonly LoanTermsView[] | undefined> {
    if (!UUID.test(loanId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const loan = await trx.selectFrom('loan').select('id').where('id', '=', loanId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
        if (loan === undefined) return undefined;
        const views = withValidUntil(await periodsOf(trx, loanId));
        return status === undefined ? views : views.filter((t) => t.status === status);
      });
  }

  async proposalInputs(loanId: string, transactionId: string, mreRealmId: string): ReturnType<LoanTermsRepository['proposalInputs']> {
    if (!UUID.test(loanId)) return { kind: 'LOAN_NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const loan = await readLoanIn(trx, loanId, mreRealmId);
        if (loan === undefined) return { kind: 'LOAN_NOT_FOUND' as const };
        const row = UUID.test(transactionId)
          ? await trx
              .selectFrom('ledger_transaction')
              .select([
                'id',
                sql<string>`to_char(booking_date, 'YYYY-MM-DD')`.as('booking_date'),
                sql<string>`(amount * 100)::bigint::text`.as('cents'),
                'direction',
                'status',
                (eb) =>
                  eb
                    .selectFrom('transaction_split')
                    .select(eb.fn.countAll<string>().as('n'))
                    .whereRef('transaction_split.transaction_id', '=', 'ledger_transaction.id')
                    .as('split_count'),
              ])
              .where('id', '=', transactionId)
              .where('mre_realm_id', '=', mreRealmId)
              .executeTakeFirst()
          : undefined;
        if (row === undefined) return { kind: 'TRANSACTION_NOT_FOUND' as const };
        return {
          kind: 'FOUND' as const,
          loan,
          periods: (await periodsOf(trx, loanId)).filter((t) => t.status === 'VALID'),
          transaction: {
            id: row.id,
            bookingDate: row.booking_date as BusinessDate,
            amount: BigInt(row.cents),
            direction: row.direction,
            status: row.status,
            splitCount: Number(row.split_count ?? 0),
          },
        };
      });
  }

  async scheduleInputs(loanId: string, mreRealmId: string): Promise<{ readonly loan: Loan; readonly periods: readonly LoanTerms[] } | undefined> {
    if (!UUID.test(loanId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const loan = await readLoanIn(trx, loanId, mreRealmId);
        if (loan === undefined) return undefined;
        return { loan, periods: (await periodsOf(trx, loanId)).filter((t) => t.status === 'VALID') };
      });
  }
}

/** The Loan's periods in `validFrom`, then `createdAt` order. */
export async function periodsOf(trx: Transaction<Database>, loanId: string): Promise<LoanTerms[]> {
  const rows = await trx
    .selectFrom('loan_terms')
    .select(COLUMNS)
    .where('loan_id', '=', loanId)
    .orderBy('valid_from')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  return rows.map(toTerms);
}

async function viewOf(trx: Transaction<Database>, loanId: string, id: string): Promise<LoanTermsView> {
  return withValidUntil(await periodsOf(trx, loanId)).find((t) => t.id === id) as LoanTermsView;
}

/** `numeric::text` with scale ≤ 3 (CHECK) is always a valid rate string. */
const rate = (text: string) => parseRate(text) as bigint;
const money = (amount: string | null, currency: string): Money | null => (amount === null ? null : fromNumericAmount(amount, currency));

function toTerms(row: TermsRow): LoanTerms {
  return {
    id: row.id as LoanTermsId,
    loanId: row.loan_id,
    mreRealmId: row.mre_realm_id,
    status: row.status as TermsStatus,
    validFrom: row.valid_from as BusinessDate,
    interestRate: rate(row.interest_rate),
    repaymentModel: row.repayment_model as RepaymentModel,
    scheduledPayment: money(row.scheduled_payment, row.currency),
    firstPaymentDate: row.first_payment_date as BusinessDate,
    principalAtStart: money(row.principal_at_start, row.currency),
    fixedRateUntil: row.fixed_rate_until as BusinessDate | null,
    initialRepaymentRate: row.initial_repayment_rate === null ? null : rate(row.initial_repayment_rate),
    specialRepaymentLimit: money(row.special_repayment_limit, row.currency),
    notes: row.notes,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created period as JSON for the idempotency store: rates and Money as text, timestamps ISO. */
function toSnapshot(t: LoanTermsView): unknown {
  return {
    ...t,
    interestRate: formatRate(t.interestRate),
    initialRepaymentRate: t.initialRepaymentRate === null ? null : formatRate(t.initialRepaymentRate),
    scheduledPayment: t.scheduledPayment?.toJSON() ?? null,
    principalAtStart: t.principalAtStart?.toJSON() ?? null,
    specialRepaymentLimit: t.specialRepaymentLimit?.toJSON() ?? null,
    voidedAt: t.voidedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): LoanTermsView {
  type MoneyJson = { amount: string; currency: string } | null;
  const s = result as Omit<
    LoanTermsView,
    'interestRate' | 'initialRepaymentRate' | 'scheduledPayment' | 'principalAtStart' | 'specialRepaymentLimit' | 'voidedAt' | 'createdAt'
  > & {
    interestRate: string;
    initialRepaymentRate: string | null;
    scheduledPayment: MoneyJson;
    principalAtStart: MoneyJson;
    specialRepaymentLimit: MoneyJson;
    voidedAt: string | null;
    createdAt: string;
  };
  const m = (j: MoneyJson) => (j === null ? null : fromNumericAmount(j.amount, j.currency));
  return {
    ...s,
    interestRate: parseRate(s.interestRate) as bigint,
    initialRepaymentRate: s.initialRepaymentRate === null ? null : (parseRate(s.initialRepaymentRate) as bigint),
    scheduledPayment: m(s.scheduledPayment),
    principalAtStart: m(s.principalAtStart),
    specialRepaymentLimit: m(s.specialRepaymentLimit),
    voidedAt: s.voidedAt === null ? null : new Date(s.voidedAt),
    createdAt: new Date(s.createdAt),
  };
}
