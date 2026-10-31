import { sql, type Kysely, type Transaction } from 'kysely';
import {
  checkAppendAllocation,
  planVoidAllocation,
  propertyLoansOf,
  sharesFromPrices,
  withValidUntil,
  type Allocation,
  type AllocationBasis,
  type AllocationRequest,
  type AllocationStatus,
  type CreateAllocationOutcome,
  type LoanAllocationRepository,
  type LoanAllocationSet,
  type LoanAllocationSetId,
  type LoanAllocationSetView,
  type PropertyLoan,
  type VoidAllocationOutcome,
} from '../../domains/financing/index.js';
import { formatShare } from '../../domains/ownership/index.js';
import { checkVersion, type AuditActor, type BusinessDate } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { lockLoan, readLoanIn } from './loan-repository.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'LoanAllocationSet';
const CREATE_SCOPE = 'loan.allocation.create';

const SET_COLUMNS = [
  'id',
  'mre_realm_id',
  'loan_id',
  'status',
  sql<string>`to_char(valid_from, 'YYYY-MM-DD')`.as('valid_from'),
  'basis',
  'notes',
  'voided_at',
  'void_reason',
  'created_at',
  'version',
] as const;

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: CreateAllocationOutcome) {
    super(outcome.kind);
  }
}

/** PostgreSQL implementation of the allocation port (api-design.md §41.3). */
export class PostgresLoanAllocationRepository implements LoanAllocationRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(
    loanId: string,
    mreRealmId: string,
    request: AllocationRequest,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateAllocationOutcome> {
    if (!UUID.test(loanId)) return { kind: 'LOAN_NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CreateAllocationOutcome> => {
          const ref = { mreRealmId, scope: CREATE_SCOPE, key: idempotency?.key ?? '' };
          if (idempotency !== undefined) {
            const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'REPLAYED', set: fromSnapshot(claim.result) };
          }
          // P3-D8: the Loan row first; PropertyReferences and Acquisitions are only read; no Transaction is locked.
          const loan = await lockLoan(trx, loanId, mreRealmId);
          if (loan === undefined) throw new Rejected({ kind: 'LOAN_NOT_FOUND' });
          const valid = (await setsOf(trx, loanId)).filter((s) => s.status === 'VALID');
          const refusal = checkAppendAllocation(loan, valid, request.validFrom);
          if (refusal !== undefined) throw new Rejected(refusal);
          const allocations = await resolve(trx, mreRealmId, request);

          const { id } = await trx
            .insertInto('loan_allocation_set')
            .values({
              mre_realm_id: mreRealmId,
              loan_id: loanId,
              status: 'VALID' satisfies AllocationStatus,
              valid_from: request.validFrom,
              basis: request.basis,
              notes: request.notes,
              created_by: actor.actorId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('loan_allocation')
            .values(
              allocations.map((a, position) => ({
                set_id: id,
                mre_realm_id: mreRealmId,
                position,
                property_reference_id: a.propertyReferenceId,
                share_numerator: a.share.numerator.toString(),
                share_denominator: a.share.denominator.toString(),
                acquisition_id: a.acquisitionId,
              })),
            )
            .execute();
          const created = await viewOf(trx, loanId, id);
          if (idempotency !== undefined) await recordIdempotentResult(trx, ref, id, toSnapshot(created));
          await writeAudit(trx, { type: ENTITY_TYPE, id }, 'CREATED', actor, {
            newVersion: 1,
            metadata: {
              loanId,
              validFrom: created.validFrom,
              basis: created.basis,
              allocations: created.allocations.map((a) => ({
                propertyReferenceId: a.propertyReferenceId,
                share: formatShare(a.share),
                acquisitionId: a.acquisitionId,
              })),
            },
          });
          return { kind: 'CREATED', set: created };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  async void(
    loanId: string,
    setId: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidAllocationOutcome> {
    if (!UUID.test(loanId) || !UUID.test(setId)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<VoidAllocationOutcome> => {
        const loan = await lockLoan(trx, loanId, mreRealmId);
        if (loan === undefined) return { kind: 'NOT_FOUND' };
        const sets = await setsOf(trx, loanId);
        const current = sets.find((s) => s.id === setId);
        if (current === undefined) return { kind: 'NOT_FOUND' };
        const plan = planVoidAllocation(
          loan,
          current,
          sets.filter((s) => s.status === 'VALID'),
          reason,
          at,
        );
        if (plan.kind === 'UNCHANGED')
          return { kind: 'VOIDED', set: withValidUntil(sets).find((s) => s.id === setId) as LoanAllocationSetView, changed: false };
        if (plan.kind !== 'VOID') return plan;
        const conflict = checkVersion(current.version, expectedVersions);
        if (conflict !== undefined) return conflict;
        await trx
          .updateTable('loan_allocation_set')
          .set({ status: 'VOID', voided_at: at, void_reason: reason, version: plan.next.version, updated_at: at })
          .where('id', '=', setId)
          .execute();
        const voided = await viewOf(trx, loanId, setId);
        await writeAudit(trx, { type: ENTITY_TYPE, id: setId }, 'VOIDED', actor, {
          previousVersion: current.version,
          newVersion: voided.version,
          metadata: { loanId, reason },
        });
        return { kind: 'VOIDED', set: voided, changed: true };
      });
  }

  async list(loanId: string, mreRealmId: string): Promise<readonly LoanAllocationSetView[] | undefined> {
    if (!UUID.test(loanId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const loan = await trx.selectFrom('loan').select('id').where('id', '=', loanId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
        return loan === undefined ? undefined : withValidUntil(await setsOf(trx, loanId));
      });
  }

  async loansOf(propertyReferenceId: string, mreRealmId: string): Promise<readonly PropertyLoan[] | undefined> {
    if (!UUID.test(propertyReferenceId)) return undefined;
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => {
        const property = await trx
          .selectFrom('property_reference')
          .select('id')
          .where('id', '=', propertyReferenceId)
          .where('mre_realm_id', '=', mreRealmId)
          .executeTakeFirst();
        if (property === undefined) return undefined;
        const loanIds = await trx
          .selectFrom('loan_allocation as a')
          .innerJoin('loan_allocation_set as s', 's.id', 'a.set_id')
          .innerJoin('loan as l', 'l.id', 's.loan_id')
          .select('s.loan_id')
          .distinct()
          .where('a.property_reference_id', '=', propertyReferenceId)
          .where('a.mre_realm_id', '=', mreRealmId)
          .where('l.status', '<>', 'VOID')
          .execute();
        const items: PropertyLoan[] = [];
        for (const { loan_id } of loanIds) {
          const loan = await readLoanIn(trx, loan_id, mreRealmId);
          if (loan === undefined) continue;
          items.push(...propertyLoansOf(loan, withValidUntil(await setsOf(trx, loan_id)), propertyReferenceId));
        }
        return items;
      });
  }
}

/**
 * Check 6 and 7 of §41.3 in the order given, then the stored entries: a `MANUAL` share as given (reduced at the API),
 * a `PURCHASE_PRICE` share from the Acquisitions' prices in cents. Read without a lock: ids, Realm, property and price
 * never change, and a cancel racing the set is "set, then cancel" (§41.3).
 */
async function resolve(trx: Transaction<Database>, mreRealmId: string, request: AllocationRequest): Promise<Allocation[]> {
  for (const { propertyReferenceId } of request.allocations) {
    const found = await trx
      .selectFrom('property_reference')
      .select('id')
      .where('id', '=', propertyReferenceId)
      .where('mre_realm_id', '=', mreRealmId)
      .executeTakeFirst();
    if (found === undefined) throw new Rejected({ kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceId });
  }
  if (request.basis === 'MANUAL') {
    return request.allocations.map((a) => ({ propertyReferenceId: a.propertyReferenceId, share: a.share as NonNullable<typeof a.share>, acquisitionId: null }));
  }
  const prices: bigint[] = [];
  for (const { propertyReferenceId, acquisitionId } of request.allocations) {
    const id = acquisitionId as string;
    const acquisition = await trx
      .selectFrom('acquisition')
      .select(['status', sql<string>`(purchase_price * 100)::bigint::text`.as('cents')])
      .where('id', '=', id)
      .where('mre_realm_id', '=', mreRealmId)
      .where('property_reference_id', '=', propertyReferenceId)
      .executeTakeFirst();
    if (acquisition === undefined) throw new Rejected({ kind: 'ACQUISITION_NOT_FOUND', acquisitionId: id });
    if (acquisition.status === 'CANCELLED') throw new Rejected({ kind: 'ACQUISITION_CANCELLED', acquisitionId: id });
    prices.push(BigInt(acquisition.cents));
  }
  const shares = sharesFromPrices(prices);
  return request.allocations.map((a, i) => ({
    propertyReferenceId: a.propertyReferenceId,
    share: shares[i] as NonNullable<(typeof shares)[number]>,
    acquisitionId: a.acquisitionId,
  }));
}

const selectSets = (trx: Transaction<Database>) => trx.selectFrom('loan_allocation_set').select(SET_COLUMNS);
type SetRow = Awaited<ReturnType<ReturnType<typeof selectSets>['execute']>>[number];

/** The Loan's sets in `validFrom`, then `createdAt` order, each with its entries in the order given. */
export async function setsOf(trx: Transaction<Database>, loanId: string): Promise<LoanAllocationSet[]> {
  const rows = await selectSets(trx).where('loan_id', '=', loanId).orderBy('valid_from').orderBy('created_at').orderBy('id').execute();
  return withEntries(trx, rows);
}

/**
 * `setsOf` batched over several Loans of the Realm (api-design.md §58D "Performance": one query for the sets by
 * `loan_allocation_set_loan_idx`, one for their entries), in the caller's transaction; a Loan without a set maps to `[]`.
 */
export async function setsOfLoans(trx: Transaction<Database>, mreRealmId: string, loanIds: readonly string[]): Promise<Map<string, LoanAllocationSet[]>> {
  const byLoan = new Map<string, LoanAllocationSet[]>(loanIds.map((id) => [id, []]));
  if (loanIds.length === 0) return byLoan;
  const rows = await selectSets(trx)
    .where('mre_realm_id', '=', mreRealmId)
    .where('loan_id', 'in', [...byLoan.keys()])
    .orderBy('loan_id')
    .orderBy('valid_from')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  for (const set of await withEntries(trx, rows)) byLoan.get(set.loanId)?.push(set);
  return byLoan;
}

async function withEntries(trx: Transaction<Database>, rows: readonly SetRow[]): Promise<LoanAllocationSet[]> {
  if (rows.length === 0) return [];
  const entries = await trx
    .selectFrom('loan_allocation')
    .select(['set_id', 'property_reference_id', sql<string>`share_numerator::text`.as('n'), sql<string>`share_denominator::text`.as('d'), 'acquisition_id'])
    .where(
      'set_id',
      'in',
      rows.map((r) => r.id),
    )
    .orderBy('set_id')
    .orderBy('position')
    .execute();
  return rows.map((row) => ({
    id: row.id as LoanAllocationSetId,
    loanId: row.loan_id,
    mreRealmId: row.mre_realm_id,
    status: row.status as AllocationStatus,
    validFrom: row.valid_from as BusinessDate,
    basis: row.basis as AllocationBasis,
    allocations: entries
      .filter((e) => e.set_id === row.id)
      .map((e) => ({
        propertyReferenceId: e.property_reference_id,
        share: { numerator: BigInt(e.n), denominator: BigInt(e.d) },
        acquisitionId: e.acquisition_id,
      })),
    notes: row.notes,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    createdAt: row.created_at,
    version: row.version,
  }));
}

async function viewOf(trx: Transaction<Database>, loanId: string, id: string): Promise<LoanAllocationSetView> {
  return withValidUntil(await setsOf(trx, loanId)).find((s) => s.id === id) as LoanAllocationSetView;
}

/** The created set as JSON for the idempotency store: shares as `"n/d"`, timestamps ISO. */
function toSnapshot(s: LoanAllocationSetView): unknown {
  return {
    ...s,
    allocations: s.allocations.map((a) => ({ ...a, share: formatShare(a.share) })),
    voidedAt: s.voidedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

/** Written by toSnapshot in the same codebase, so its shape is trusted. */
function fromSnapshot(result: unknown): LoanAllocationSetView {
  const s = result as Omit<LoanAllocationSetView, 'allocations' | 'voidedAt' | 'createdAt'> & {
    allocations: { propertyReferenceId: string; share: string; acquisitionId: string | null }[];
    voidedAt: string | null;
    createdAt: string;
  };
  return {
    ...s,
    allocations: s.allocations.map((a) => {
      const [n = '', d = ''] = a.share.split('/');
      return { ...a, share: { numerator: BigInt(n), denominator: BigInt(d) } };
    }),
    voidedAt: s.voidedAt === null ? null : new Date(s.voidedAt),
    createdAt: new Date(s.createdAt),
  };
}
