import { sql, type Kysely, type Transaction } from 'kysely';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import {
  isPartKind,
  nothingToConfirm,
  type ChangeItem,
  type PartItem,
  type AcknowledgeOutcome,
  type ConfirmOutcome,
  type LoanAllocationTaxConfirmation,
  type RuleRegistry,
  type TaxStatementStatus,
  type TaxStatementRepository,
  type TaxYearAcknowledgement,
  type WithdrawOutcome,
} from '../../domains/taxation/index.js';
import type { LoanStatus } from '../../domains/financing/index.js';
import { checkVersion } from '../../shared/index.js';
import { attributionInputOf } from './attribution-reads.js';
import { partChangeInputOf } from './part-reads.js';
import { allocatedLoanInterest } from './tax-year-reads.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { setsOfLoans } from './loan-allocation-repository.js';
import type { Database } from './schema.js';
import { UUID } from './tax-classification-rows.js';
import { acknowledgementsOf, confirmationsOf } from './tax-statement-rows.js';

/**
 * PostgreSQL implementation of §58E's statements (api-design.md §58E "Concurrency and locks", migration 0060). An
 * acknowledgement is one `REPEATABLE READ` read-write transaction: the key, the PropertyReference (no-op write), the
 * year's changes derived in this snapshot (Part 1, not the view) and the use case's decision, then the rows, the
 * AuditRecord and the key; a serialisation failure (`40001`) is answered as such and the use case retries. A
 * confirmation is one `READ COMMITTED` transaction: the key, the Loan row (P3-D8's no-op), then the set and its rows read
 * under it. No input is locked; nothing outside the tables of 0060 and 0063 (§58G, the part items) and the AuditRecords is written.
 */

const ACKNOWLEDGEMENT = 'TaxYearAcknowledgement';
const CONFIRMATION = 'LoanAllocationTaxConfirmation';
const ACKNOWLEDGE_SCOPE = 'tax-year.acknowledgement.create';
const CONFIRM_SCOPE = 'loan.allocation.tax-confirmation.create';

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected<O> extends Error {
  constructor(readonly outcome: O) {
    super('rejected');
  }
}

/** What a key stores (§15): the answer as recorded; a statement changes only by its withdrawal, so it is re-read. */
interface StatementSnapshot {
  readonly kind: 'CREATED' | 'UNCHANGED';
  readonly id: string;
  readonly status: TaxStatementStatus;
  readonly version: number;
}

const isSerializationFailure = (error: unknown) => (error as { code?: string } | null)?.code === '40001';

/** The statement as recorded with the key: its status and version of then, whatever withdrew it since. */
const asRecorded = <S extends { readonly status: TaxStatementStatus; readonly version: number }>(stored: S, snapshot: StatementSnapshot): S =>
  stored.status === snapshot.status
    ? stored
    : { ...stored, status: snapshot.status, version: snapshot.version, withdrawnAt: null, withdrawnBy: null, withdrawReason: null };

export class PostgresTaxStatementRepository implements TaxStatementRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly registry: RuleRegistry = TAX_RULES,
    /**
     * Test seam only (§58E "Concurrency" tests): awaited inside the acknowledgement's transaction after the derivation,
     * before the no-op check's insert, so a test can hold it there. `main.ts` never sets it.
     */
    private readonly afterDerivation?: () => Promise<void>,
  ) {}

  async acknowledge(input: Parameters<TaxStatementRepository['acknowledge']>[0]): Promise<AcknowledgeOutcome> {
    const { propertyReferenceId, year, mreRealmId, actor, reason, today, idempotency, decide } = input;
    if (!UUID.test(propertyReferenceId)) return { kind: 'NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx): Promise<AcknowledgeOutcome> => {
          // 1. The key.
          const ref = { mreRealmId, scope: ACKNOWLEDGE_SCOPE, key: idempotency?.key ?? '' };
          if (idempotency !== undefined) {
            const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') {
              const snapshot = claim.result as StatementSnapshot;
              const [stored] = await acknowledgementsOf(trx, mreRealmId, propertyReferenceId, year, null, [snapshot.id]);
              if (stored === undefined) throw new Error(`TaxYearAcknowledgement ${snapshot.id} of a recorded key vanished`);
              return { kind: snapshot.kind, acknowledgement: asRecorded(stored, snapshot), replayed: true };
            }
          }
          // 2. The PropertyReference (no-op write): two acknowledgements of one change meet here.
          const written = await sql`UPDATE property_reference SET version = version WHERE id = ${propertyReferenceId} AND mre_realm_id = ${mreRealmId}`.execute(
            trx,
          );
          if (Number(written.numAffectedRows ?? 0n) === 0) throw new Rejected<AcknowledgeOutcome>({ kind: 'NOT_FOUND' });
          // 3. The year's changes of both flags in this snapshot (§58E Part 1, §58G), and the decision (steps 3–5).
          const attribution = await attributionInputOf(trx, mreRealmId, propertyReferenceId, year, this.registry);
          const wide = await allocatedLoanInterest(trx, this.registry, mreRealmId, propertyReferenceId, year, today, true);
          const parts = await partChangeInputOf(trx, wide);
          const active = await acknowledgementsOf(trx, mreRealmId, propertyReferenceId, year, ['ACTIVE']);
          const decision = decide({ attribution, parts }, active);
          if (this.afterDerivation !== undefined) await this.afterDerivation();
          if (decision.kind === 'NOT_FLAGGED' || decision.kind === 'AMBIGUOUS' || decision.kind === 'DIFFERS') throw new Rejected<AcknowledgeOutcome>(decision);
          const record = async (kind: StatementSnapshot['kind'], acknowledgement: TaxYearAcknowledgement) => {
            if (idempotency !== undefined) {
              const snapshot: StatementSnapshot = {
                kind,
                id: acknowledgement.acknowledgementId,
                status: acknowledgement.status,
                version: acknowledgement.version,
              };
              await recordIdempotentResult(trx, ref, acknowledgement.acknowledgementId, snapshot);
            }
          };
          if (decision.kind === 'NOOP') {
            await record('UNCHANGED', decision.acknowledgement);
            return { kind: 'UNCHANGED', acknowledgement: decision.acknowledgement, replayed: false };
          }
          // 4. The acknowledgement and its items, the AuditRecord, the key.
          const c = decision.change;
          const inserted = await trx
            .insertInto('tax_year_acknowledgement')
            .values({
              mre_realm_id: mreRealmId,
              property_reference_id: propertyReferenceId,
              tax_year: year,
              audit_record_id: c.auditRecordId,
              change_kind: c.kind,
              change_entity_type: c.entityType,
              change_entity_id: c.entityId,
              change_recorded_at: c.amendedAt,
              change_fingerprint: c.changeFingerprint,
              reason,
              acknowledged_by: actor.actorId,
              status: 'ACTIVE',
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          // §58G: a part kind's items in the part shape (0063), a year kind's in 0060's table; the shape guard checks it.
          if (isPartKind(c.kind)) {
            await trx
              .insertInto('tax_year_acknowledgement_part_item')
              .values(
                (c.items as readonly PartItem[]).map((i) => ({
                  acknowledgement_id: inserted.id,
                  mre_realm_id: mreRealmId,
                  source_type: i.sourceType,
                  source_id: i.sourceId,
                  tax_year: i.taxYear,
                  state_before: i.stateBefore,
                  part_before: i.partBefore?.amount ?? null,
                  state_after: i.stateAfter,
                  part_after: i.partAfter?.amount ?? null,
                })),
              )
              .execute();
          } else {
            await trx
              .insertInto('tax_year_acknowledgement_item')
              .values(
                (c.items as readonly ChangeItem[]).map((i) => ({
                  acknowledgement_id: inserted.id,
                  mre_realm_id: mreRealmId,
                  source_id: i.sourceId,
                  year_before: i.yearBefore,
                  year_after: i.yearAfter,
                })),
              )
              .execute();
          }
          const [created] = await acknowledgementsOf(trx, mreRealmId, propertyReferenceId, year, null, [inserted.id]);
          if (created === undefined) throw new Error(`TaxYearAcknowledgement ${inserted.id} vanished`);
          await writeAudit(trx, { type: ACKNOWLEDGEMENT, id: inserted.id }, 'ACKNOWLEDGED', actor, {
            newVersion: 1,
            metadata: {
              propertyReferenceId,
              year,
              auditRecordId: c.auditRecordId,
              kind: c.kind,
              entityType: c.entityType,
              entityId: c.entityId,
              changeFingerprint: c.changeFingerprint,
              items: created.change.items.map((i) =>
                'stateBefore' in i ? { ...i, partBefore: i.partBefore?.toJSON() ?? null, partAfter: i.partAfter?.toJSON() ?? null } : i,
              ),
              reason,
            },
          });
          await record('CREATED', created);
          return { kind: 'CREATED', acknowledgement: created, replayed: false };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome as AcknowledgeOutcome;
      if (isSerializationFailure(error)) return { kind: 'SERIALIZATION_FAILURE' };
      throw error;
    }
  }

  async withdrawAcknowledgement(input: Parameters<TaxStatementRepository['withdrawAcknowledgement']>[0]): Promise<WithdrawOutcome<TaxYearAcknowledgement>> {
    const { propertyReferenceId, year, acknowledgementId, mreRealmId, actor, reason, expectedVersions } = input;
    if (!UUID.test(propertyReferenceId) || !UUID.test(acknowledgementId)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<WithdrawOutcome<TaxYearAcknowledgement>> => {
        const written = await sql`UPDATE property_reference SET version = version WHERE id = ${propertyReferenceId} AND mre_realm_id = ${mreRealmId}`.execute(
          trx,
        );
        if (Number(written.numAffectedRows ?? 0n) === 0) return { kind: 'NOT_FOUND' };
        const locked = await trx
          .selectFrom('tax_year_acknowledgement')
          .select(['id', 'status', 'version'])
          .where('id', '=', acknowledgementId)
          .where('mre_realm_id', '=', mreRealmId)
          .where('property_reference_id', '=', propertyReferenceId)
          .where('tax_year', '=', year)
          .forUpdate()
          .executeTakeFirst();
        if (locked === undefined) return { kind: 'NOT_FOUND' };
        const read = async () => (await acknowledgementsOf(trx, mreRealmId, propertyReferenceId, year, null, [acknowledgementId]))[0] as TaxYearAcknowledgement;
        // Already withdrawn: the no-op keeps the first reason, whatever the version (§58E).
        if (locked.status === 'WITHDRAWN') return { kind: 'WITHDRAWN', statement: await read(), changed: false };
        const conflict = checkVersion(locked.version, expectedVersions);
        if (conflict !== undefined) return { kind: 'VERSION_CONFLICT', currentVersion: locked.version };
        await trx
          .updateTable('tax_year_acknowledgement')
          .set({ status: 'WITHDRAWN', withdrawn_at: new Date(), withdrawn_by: actor.actorId, withdraw_reason: reason, version: locked.version + 1 })
          .where('id', '=', acknowledgementId)
          .execute();
        await writeAudit(trx, { type: ACKNOWLEDGEMENT, id: acknowledgementId }, 'WITHDRAWN', actor, {
          previousVersion: locked.version,
          newVersion: locked.version + 1,
          metadata: { reason },
        });
        return { kind: 'WITHDRAWN', statement: await read(), changed: true };
      });
  }

  async listAcknowledgements(
    propertyReferenceId: string,
    year: number,
    mreRealmId: string,
    statuses: readonly TaxStatementStatus[] | null,
  ): Promise<readonly TaxYearAcknowledgement[] | undefined> {
    if (!UUID.test(propertyReferenceId)) return undefined;
    return this.snapshot(async (trx) => {
      const known = await trx
        .selectFrom('property_reference')
        .select('id')
        .where('id', '=', propertyReferenceId)
        .where('mre_realm_id', '=', mreRealmId)
        .executeTakeFirst();
      return known === undefined ? undefined : acknowledgementsOf(trx, mreRealmId, propertyReferenceId, year, statuses);
    });
  }

  async confirm(input: Parameters<TaxStatementRepository['confirm']>[0]): Promise<ConfirmOutcome> {
    const { loanId, allocationSetId, mreRealmId, actor, reason, advisorPartyId, idempotency } = input;
    if (!UUID.test(loanId)) return { kind: 'LOAN_NOT_FOUND' };
    if (!UUID.test(allocationSetId)) return { kind: 'SET_NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<ConfirmOutcome> => {
          // 1. The key.
          const ref = { mreRealmId, scope: CONFIRM_SCOPE, key: idempotency?.key ?? '' };
          if (idempotency !== undefined) {
            const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') {
              const snapshot = claim.result as StatementSnapshot;
              const [stored] = await confirmationsOf(trx, mreRealmId, [allocationSetId], null, [snapshot.id]);
              if (stored === undefined) throw new Error(`LoanAllocationTaxConfirmation ${snapshot.id} of a recorded key vanished`);
              return { kind: snapshot.kind, confirmation: asRecorded(stored, snapshot), replayed: true };
            }
          }
          // 2. The Loan row (P3-D8's no-op): a confirmation serialises with every set append and void of the Loan.
          const loan = await sql<{ status: string }>`
            UPDATE loan SET version = version WHERE id = ${loanId} AND mre_realm_id = ${mreRealmId} RETURNING status
          `.execute(trx);
          const loanStatus = loan.rows[0]?.status as LoanStatus | undefined;
          if (loanStatus === undefined) throw new Rejected<ConfirmOutcome>({ kind: 'LOAN_NOT_FOUND' });
          // 3. The set and its rows, read under the Loan's lock (a void committed meanwhile is seen).
          const set = (await setsOfLoans(trx, mreRealmId, [loanId])).get(loanId)?.find((s) => s.id === allocationSetId);
          if (set === undefined) throw new Rejected<ConfirmOutcome>({ kind: 'SET_NOT_FOUND' });
          if (advisorPartyId !== null) {
            const party = UUID.test(advisorPartyId)
              ? await trx.selectFrom('party').select('id').where('id', '=', advisorPartyId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst()
              : undefined;
            if (party === undefined) throw new Rejected<ConfirmOutcome>({ kind: 'ADVISOR_NOT_FOUND' });
          }
          // 4. Nothing to confirm; 5. the no-op.
          const cause = nothingToConfirm(loanStatus, set);
          if (cause !== null) throw new Rejected<ConfirmOutcome>({ kind: 'NOTHING_TO_CONFIRM', cause });
          const [active] = await confirmationsOf(trx, mreRealmId, [allocationSetId], ['ACTIVE']);
          const record = async (kind: StatementSnapshot['kind'], confirmation: LoanAllocationTaxConfirmation) => {
            if (idempotency !== undefined) {
              const snapshot: StatementSnapshot = { kind, id: confirmation.confirmationId, status: confirmation.status, version: confirmation.version };
              await recordIdempotentResult(trx, ref, confirmation.confirmationId, snapshot);
            }
          };
          if (active !== undefined) {
            await record('UNCHANGED', active);
            return { kind: 'UNCHANGED', confirmation: active, replayed: false };
          }
          // 6. Insert, AuditRecord, key.
          const inserted = await trx
            .insertInto('loan_allocation_tax_confirmation')
            .values({
              mre_realm_id: mreRealmId,
              allocation_set_id: allocationSetId,
              reason,
              advisor_party_id: advisorPartyId,
              confirmed_by: actor.actorId,
              status: 'ACTIVE',
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          const [created] = await confirmationsOf(trx, mreRealmId, [allocationSetId], null, [inserted.id]);
          if (created === undefined) throw new Error(`LoanAllocationTaxConfirmation ${inserted.id} vanished`);
          await writeAudit(trx, { type: CONFIRMATION, id: inserted.id }, 'CONFIRMED', actor, {
            newVersion: 1,
            metadata: {
              loanId,
              allocationSetId,
              basis: created.set.basis,
              validFrom: created.set.validFrom,
              allocations: created.set.allocations,
              reason,
              advisorPartyId,
            },
          });
          await record('CREATED', created);
          return { kind: 'CREATED', confirmation: created, replayed: false };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome as ConfirmOutcome;
      throw error;
    }
  }

  async withdrawConfirmation(input: Parameters<TaxStatementRepository['withdrawConfirmation']>[0]): Promise<WithdrawOutcome<LoanAllocationTaxConfirmation>> {
    const { loanId, allocationSetId, confirmationId, mreRealmId, actor, reason, expectedVersions } = input;
    if (!UUID.test(loanId) || !UUID.test(allocationSetId) || !UUID.test(confirmationId)) return { kind: 'NOT_FOUND' };
    return this.db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<WithdrawOutcome<LoanAllocationTaxConfirmation>> => {
        const loan = await sql`UPDATE loan SET version = version WHERE id = ${loanId} AND mre_realm_id = ${mreRealmId}`.execute(trx);
        if (Number(loan.numAffectedRows ?? 0n) === 0) return { kind: 'NOT_FOUND' };
        const locked = await trx
          .selectFrom('loan_allocation_tax_confirmation as c')
          .innerJoin('loan_allocation_set as s', 's.id', 'c.allocation_set_id')
          .select(['c.id', 'c.status', 'c.version'])
          .where('c.id', '=', confirmationId)
          .where('c.allocation_set_id', '=', allocationSetId)
          .where('c.mre_realm_id', '=', mreRealmId)
          .where('s.loan_id', '=', loanId)
          .forUpdate('c')
          .executeTakeFirst();
        if (locked === undefined) return { kind: 'NOT_FOUND' };
        const read = async () => (await confirmationsOf(trx, mreRealmId, [allocationSetId], null, [confirmationId]))[0] as LoanAllocationTaxConfirmation;
        if (locked.status === 'WITHDRAWN') return { kind: 'WITHDRAWN', statement: await read(), changed: false };
        const conflict = checkVersion(locked.version, expectedVersions);
        if (conflict !== undefined) return { kind: 'VERSION_CONFLICT', currentVersion: locked.version };
        await trx
          .updateTable('loan_allocation_tax_confirmation')
          .set({ status: 'WITHDRAWN', withdrawn_at: new Date(), withdrawn_by: actor.actorId, withdraw_reason: reason, version: locked.version + 1 })
          .where('id', '=', confirmationId)
          .execute();
        await writeAudit(trx, { type: CONFIRMATION, id: confirmationId }, 'WITHDRAWN', actor, {
          previousVersion: locked.version,
          newVersion: locked.version + 1,
          metadata: { reason },
        });
        return { kind: 'WITHDRAWN', statement: await read(), changed: true };
      });
  }

  async listConfirmations(loanId: string, allocationSetId: string, mreRealmId: string) {
    if (!UUID.test(loanId)) return 'LOAN_NOT_FOUND' as const;
    if (!UUID.test(allocationSetId)) return 'SET_NOT_FOUND' as const;
    return this.snapshot(async (trx) => {
      const loan = await trx.selectFrom('loan').select('id').where('id', '=', loanId).where('mre_realm_id', '=', mreRealmId).executeTakeFirst();
      if (loan === undefined) return 'LOAN_NOT_FOUND' as const;
      const set = await trx
        .selectFrom('loan_allocation_set')
        .select('id')
        .where('id', '=', allocationSetId)
        .where('loan_id', '=', loanId)
        .where('mre_realm_id', '=', mreRealmId)
        .executeTakeFirst();
      if (set === undefined) return 'SET_NOT_FOUND' as const;
      return confirmationsOf(trx, mreRealmId, [allocationSetId], null);
    });
  }

  private snapshot<T>(work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(work);
  }
}
