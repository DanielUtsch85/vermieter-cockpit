import { sql, type Kysely, type Transaction } from 'kysely';
import {
  planAmend,
  planVoid,
  type AmendLoanOutcome,
  type CreateLoanOutcome,
  type Loan,
  type LoanChanges,
  type LoanFilter,
  type LoanId,
  type LoanPage,
  type LoanRepository,
  type LoanStatus,
  type NewLoan,
  type VoidLoanOutcome,
} from '../../domains/financing/index.js';
import { checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'Loan';
const CREATE_SCOPE = 'loan.create';

/** Every column, the dates as `YYYY-MM-DD` text and the principal as text (exact). */
const COLUMNS = [
  'id',
  'mre_realm_id',
  'status',
  'lender_party_id',
  'borrower_party_ids',
  sql<string>`principal_original::text`.as('principal_original'),
  'currency',
  sql<string>`to_char(start_date, 'YYYY-MM-DD')`.as('start_date'),
  sql<string | null>`to_char(disbursement_date, 'YYYY-MM-DD')`.as('disbursement_date'),
  sql<string | null>`to_char(maturity_date, 'YYYY-MM-DD')`.as('maturity_date'),
  'contract_number',
  'acquisition_id',
  'source_references',
  'notes',
  'voided_at',
  'void_reason',
  'created_at',
  'version',
] as const;

interface LoanRow {
  id: string;
  mre_realm_id: string;
  status: string;
  lender_party_id: string;
  borrower_party_ids: string[];
  principal_original: string;
  currency: string;
  start_date: string;
  disbursement_date: string | null;
  maturity_date: string | null;
  contract_number: string | null;
  acquisition_id: string | null;
  source_references: string[];
  notes: string | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_at: Date;
  version: number;
}

/** Column of each amendable field. */
const COLUMN = {
  lenderPartyId: 'lender_party_id',
  borrowerPartyIds: 'borrower_party_ids',
  maturityDate: 'maturity_date',
  contractNumber: 'contract_number',
  sourceReferences: 'source_references',
  notes: 'notes',
} as const;

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateLoanOutcome) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the Loan port (api-design.md §41.1). */
export class PostgresLoanRepository implements LoanRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(loan: NewLoan, actor: AuditActor, idempotency?: { readonly key: string; readonly fingerprint: string }): Promise<CreateLoanOutcome> {
    try {
      return await this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<CreateLoanOutcome> => {
        const keyed =
          idempotency === undefined
            ? undefined
            : { ref: { mreRealmId: loan.mreRealmId, scope: CREATE_SCOPE, key: idempotency.key }, fingerprint: idempotency.fingerprint };
        if (keyed !== undefined) {
          const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
          if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
          if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', loan: fromSnapshot(claim.result) };
        }
        // Lender, then each borrower, in the order given (§41.1); all locked FOR SHARE in id order first.
        const named = [loan.lenderPartyId, ...loan.borrowerPartyIds];
        const status = await lockParties(trx, named, loan.mreRealmId);
        for (const partyId of named) {
          if (!status.has(partyId)) throw new Rejected({ kind: 'PARTY_NOT_FOUND', partyId });
        }
        if (loan.acquisitionId !== null) {
          const acquisition = await trx
            .selectFrom('acquisition')
            .select('id')
            .where('id', '=', loan.acquisitionId)
            .where('mre_realm_id', '=', loan.mreRealmId)
            .executeTakeFirst();
          if (acquisition === undefined) throw new Rejected({ kind: 'ACQUISITION_NOT_FOUND', acquisitionId: loan.acquisitionId });
        }
        for (const partyId of named) {
          if (status.get(partyId) !== 'ACTIVE') throw new Rejected({ kind: 'PARTY_INACTIVE', partyId });
        }

        const { id } = await trx
          .insertInto('loan')
          .values({
            mre_realm_id: loan.mreRealmId,
            status: 'ACTIVE' satisfies LoanStatus,
            lender_party_id: loan.lenderPartyId,
            borrower_party_ids: [...loan.borrowerPartyIds],
            principal_original: toNumericAmount(loan.principalOriginal),
            currency: loan.principalOriginal.currency,
            start_date: loan.startDate,
            disbursement_date: loan.disbursementDate,
            maturity_date: loan.maturityDate,
            contract_number: loan.contractNumber,
            acquisition_id: loan.acquisitionId,
            source_references: [...loan.sourceReferences],
            notes: loan.notes,
            created_by: actor.actorId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        const created = await readOne(trx, id);
        if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, id, toSnapshot(created));
        await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CREATED', actor, {
          newVersion: created.version,
          metadata: {
            principalOriginal: created.principalOriginal.toJSON(),
            startDate: created.startDate,
            disbursementDate: created.disbursementDate,
            maturityDate: created.maturityDate,
            lenderPartyId: created.lenderPartyId,
            borrowerPartyIds: created.borrowerPartyIds,
            acquisitionId: created.acquisitionId,
          },
        });
        return { kind: 'CREATED', loan: created };
      });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  async findById(id: string, mreRealmId: string): Promise<Loan | undefined> {
    if (!UUID.test(id)) return undefined;
    const row = await this.db.selectFrom('loan').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
    return row === undefined ? undefined : toLoan(row);
  }

  async list(mreRealmId: string, filter: LoanFilter, page: { readonly page: number; readonly pageSize: number }): Promise<LoanPage> {
    // Count and page in one snapshot, so `total` and `items` agree.
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(async (trx) => {
      const filtered = () => {
        let query = trx.selectFrom('loan').where('mre_realm_id', '=', mreRealmId);
        if (filter.status !== undefined) query = query.where('status', '=', filter.status);
        if (filter.acquisitionId !== undefined) query = query.where('acquisition_id', '=', filter.acquisitionId);
        const partyId = filter.partyId;
        if (partyId !== undefined) {
          query = query.where((eb) => eb.or([eb('lender_party_id', '=', partyId), eb(sql<boolean>`borrower_party_ids @> ARRAY[${partyId}]::uuid[]`, '=', true)]));
        }
        return query;
      };
      const { n } = await filtered()
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const rows = await filtered()
        .select(COLUMNS)
        .orderBy('start_date', 'desc')
        .orderBy('created_at', 'desc')
        .orderBy('id')
        .limit(page.pageSize)
        .offset((page.page - 1) * page.pageSize)
        .execute();
      return { items: rows.map(toLoan), page: page.page, pageSize: page.pageSize, total: Number(n) };
    });
  }

  async amend(id: string, mreRealmId: string, changes: LoanChanges, actor: AuditActor, expectedVersions?: readonly number[]): Promise<AmendLoanOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<AmendLoanOutcome> => {
      // Parties → Loan (§41.1): every Party the changes name, a superset of the newly named ones, FOR SHARE first.
      const named = [...(changes.lenderPartyId === undefined ? [] : [changes.lenderPartyId]), ...(changes.borrowerPartyIds ?? [])];
      const status = await lockParties(trx, named, mreRealmId);
      const row = await trx.selectFrom('loan').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).forUpdate().executeTakeFirst();
      if (row === undefined) return { kind: 'NOT_FOUND' };
      const current = toLoan(row);
      const plan = planAmend(current, changes);
      if (plan.kind === 'UNCHANGED') return { kind: 'AMENDED', loan: current, changed: false };
      if (plan.kind !== 'AMEND') return plan;
      for (const partyId of plan.newPartyIds) {
        if (!status.has(partyId)) return { kind: 'PARTY_NOT_FOUND', partyId };
      }
      for (const partyId of plan.newPartyIds) {
        if (status.get(partyId) !== 'ACTIVE') return { kind: 'PARTY_INACTIVE', partyId };
      }
      const conflict = checkVersion(current.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      await trx
        .updateTable('loan')
        .set((eb) => ({
          ...Object.fromEntries(plan.changed.map((field) => [COLUMN[field], toColumn(plan.values[field])])),
          version: eb('version', '+', 1),
          updated_at: new Date(),
        }))
        .where('id', '=', id)
        .execute();
      const amended = await readOne(trx, id);
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'AMENDED', actor, {
        previousVersion: current.version,
        newVersion: amended.version,
        metadata: { changes: Object.fromEntries(plan.changed.map((field) => [field, { from: current[field], to: amended[field] }])) },
      });
      return { kind: 'AMENDED', loan: amended, changed: true };
    });
  }

  async void(id: string, mreRealmId: string, reason: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<VoidLoanOutcome> {
    if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
    return this.db.transaction().setIsolationLevel('read committed').execute(async (trx): Promise<VoidLoanOutcome> => {
      const row = await trx.selectFrom('loan').select(COLUMNS).where('id', '=', id).where('mre_realm_id', '=', mreRealmId).forUpdate().executeTakeFirst();
      if (row === undefined) return { kind: 'NOT_FOUND' };
      const current = toLoan(row);
      // No split can carry a loanId before VC-3-05 adds the column; then its Transactions are read here, unlocked (P3-D8).
      const plan = planVoid(current, reason, at, []);
      if (plan.kind === 'UNCHANGED') return { kind: 'VOIDED', loan: current, changed: false };
      if (plan.kind !== 'VOID') return plan;
      const conflict = checkVersion(current.version, expectedVersions);
      if (conflict !== undefined) return conflict;
      await trx.updateTable('loan').set({ status: plan.next.status, voided_at: at, void_reason: reason, version: plan.next.version, updated_at: at }).where('id', '=', id).execute();
      const voided = await readOne(trx, id);
      await writeAudit(trx, { type: ENTITY_TYPE, id }, 'VOIDED', actor, {
        previousVersion: current.version,
        newVersion: voided.version,
        metadata: { reason },
      });
      return { kind: 'VOIDED', loan: voided, changed: true };
    });
  }
}

/** The Parties of the Realm among `ids`, locked `FOR SHARE` in id order, with their status. */
async function lockParties(trx: Transaction<Database>, ids: readonly string[], mreRealmId: string): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter((id) => UUID.test(id)).sort();
  if (unique.length === 0) return new Map();
  const rows = await trx.selectFrom('party').select(['id', 'status']).where('id', 'in', unique).where('mre_realm_id', '=', mreRealmId).orderBy('id').forShare().execute();
  return new Map(rows.map((p) => [p.id, p.status]));
}

/** An amendable value as its column takes it (arrays copied, dates as text). */
function toColumn(value: unknown): unknown {
  return Array.isArray(value) ? [...(value as unknown[])] : value;
}

async function readOne(trx: Transaction<Database>, id: string): Promise<Loan> {
  return toLoan(await trx.selectFrom('loan').select(COLUMNS).where('id', '=', id).executeTakeFirstOrThrow());
}

function toLoan(row: LoanRow): Loan {
  return {
    id: row.id as LoanId,
    mreRealmId: row.mre_realm_id,
    status: row.status as LoanStatus,
    lenderPartyId: row.lender_party_id,
    borrowerPartyIds: row.borrower_party_ids,
    principalOriginal: fromNumericAmount(row.principal_original, row.currency),
    startDate: row.start_date as BusinessDate,
    disbursementDate: row.disbursement_date as BusinessDate | null,
    maturityDate: row.maturity_date as BusinessDate | null,
    contractNumber: row.contract_number,
    acquisitionId: row.acquisition_id,
    sourceReferences: row.source_references,
    notes: row.notes,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    version: row.version,
  };
}

/** The created Loan as JSON for the idempotency store: Money as `{ amount, currency }`, timestamps ISO. */
interface LoanSnapshot extends Omit<Loan, 'principalOriginal' | 'createdAt' | 'voidedAt'> {
  readonly principalOriginal: { readonly amount: string; readonly currency: string };
  readonly createdAt: string;
  readonly voidedAt: string | null;
}

function toSnapshot(loan: Loan): LoanSnapshot {
  return {
    ...loan,
    principalOriginal: { amount: loan.principalOriginal.amount, currency: loan.principalOriginal.currency },
    createdAt: loan.createdAt.toISOString(),
    voidedAt: loan.voidedAt?.toISOString() ?? null,
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): Loan {
  const s = result as LoanSnapshot;
  return {
    ...s,
    id: s.id as LoanId,
    principalOriginal: fromNumericAmount(s.principalOriginal.amount, s.principalOriginal.currency),
    createdAt: new Date(s.createdAt),
    voidedAt: s.voidedAt === null ? null : new Date(s.voidedAt),
  };
}
