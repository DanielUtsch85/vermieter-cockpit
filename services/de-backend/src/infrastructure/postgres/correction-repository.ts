import type { Kysely, Transaction as Trx } from 'kysely';
import {
  checkDepositSplits,
  checkLoanSplits,
  type SplitLoan,
  checkVersion,
  currencyMismatch,
  opposite,
  planCorrection,
  type CorrectionRepository,
  type CorrectionRequest,
  type CorrectionResult,
  type CorrectionRole,
  type CorrectOutcome,
  type Direction,
  type PlannedReplacement,
  type SplitInput,
  type Transaction,
  type TransactionStatus,
} from '../../domains/ledger/index.js';
import { Money, type AuditActor } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import { toFinancialAccount } from './financial-account-repository.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import { lockLoansOf } from './loan-repository.js';
import { lockDepositsOf } from './security-deposit-repository.js';
import { fromNumericAmount, toNumericAmount } from './money-column.js';
import type { Database } from './schema.js';
import { COLUMNS, UUID, fromSnapshot, toDomain, toSnapshot } from './transaction-repository.js';

const SCOPE = 'transaction.correct';
/** `reverse` (§35.9) has its own key scope: the same key on `correct` and on `reverse` are different requests. */
const REVERSE_SCOPE = 'transaction.reverse';

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: Exclude<CorrectOutcome, { kind: 'CORRECTED' }>) {
    super(outcome.kind);
  }
}

/** A stored split of the original: what the reversal mirrors and the replacement may copy. */
interface StoredSplit extends SplitInput {
  readonly financialCategoryId: string;
  readonly categoryActive: boolean;
}

/**
 * PostgreSQL implementation of `correct` (api-design.md §35). Reversal and
 * replacement are written unconfirmed, get their splits and are then confirmed
 * (the triggers of 0009/0010 allow nothing else); the deferred chain check of
 * 0011 runs at commit.
 */
export class PostgresCorrectionRepository implements CorrectionRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async correct(
    originalId: string,
    mreRealmId: string,
    request: CorrectionRequest,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
    expectedVersions?: readonly number[],
  ): Promise<CorrectOutcome> {
    if (!UUID.test(originalId)) return { kind: 'NOT_FOUND' };
    try {
      // READ COMMITTED explicitly: the idempotency claim relies on it (idempotency.ts).
      return await this.db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx): Promise<CorrectOutcome> => {
          const keyed =
            idempotency === undefined
              ? undefined
              : {
                  ref: { mreRealmId, scope: request.replacement === null ? REVERSE_SCOPE : SCOPE, key: idempotency.key },
                  fingerprint: idempotency.fingerprint,
                };
          if (keyed !== undefined) {
            const claim = await claimIdempotencyKey(trx, keyed.ref, keyed.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return { kind: 'CORRECTED', result: fromResultSnapshot(claim.result), replayed: true };
          }

          // Lock order (§35.5): the original first, then the account(s).
          const locked = await trx
            .selectFrom('ledger_transaction')
            .select('id')
            .where('id', '=', originalId)
            .where('mre_realm_id', '=', mreRealmId)
            .forUpdate()
            .executeTakeFirst();
          if (locked === undefined) throw new Rejected({ kind: 'NOT_FOUND' });
          // Read after the lock, in a new statement: a request that waited on a concurrent correction must see its
          // reversal and replacement. Under READ COMMITTED the locking statement re-reads only the locked row itself;
          // the link subqueries of COLUMNS would still run on its older snapshot.
          const original = toDomain(await trx.selectFrom('ledger_transaction').select(COLUMNS).where('id', '=', locked.id).executeTakeFirstOrThrow());
          const originalSplits = await storedSplits(trx, original.id);

          // §37.1: the CONFIRMED rent reconciliations naming the original, read under its lock; the trigger of 0030 is the
          // backstop at the status step.
          const reconciled = await trx
            .selectFrom('rent_payment_reconciliation')
            .select('id')
            .where('transaction_id', '=', original.id)
            .where('status', '=', 'CONFIRMED')
            .orderBy('id')
            .execute();
          const plan = planCorrection(
            original,
            originalSplits,
            request.replacement,
            reconciled.map((r) => r.id),
          );
          if (plan.kind !== 'CORRECT') throw new Rejected(plan);
          const conflict = checkVersion(original.version, expectedVersions);
          if (conflict !== undefined) throw new Rejected(conflict);
          const replacement = plan.replacement;
          // §41.5, P3-D8: every Loan the correction writes, the original's (the reversal mirrors them) and the
          // replacement's, locked FOR UPDATE in id order after the original, before any split is inserted. The split
          // trigger writes them again in position order, which is then a no-op on rows already held (review on #68).
          const loans = await lockLoansOf(trx, mreRealmId, [...loanIdsOf(originalSplits), ...(replacement === null ? [] : loanIdsOf(replacement.splits))]);
          // §47.2, P5-D9: then every security deposit the correction writes, the same way.
          const deposits = await lockDepositsOf(trx, mreRealmId, [
            ...depositIdsOf(originalSplits),
            ...(replacement === null ? [] : depositIdsOf(replacement.splits)),
          ]);
          // Reverse only (§35.9): no replacement to check; the reversal goes to the original's account, closed or not.
          const categoryIds = replacement === null ? undefined : await this.checkReplacement(trx, mreRealmId, original, replacement, loans, deposits);

          const reversalId = await insertCorrection(trx, actor, original, 'REVERSAL', {
            financialAccountId: original.financialAccountId,
            amount: original.amount,
            direction: opposite(original.direction),
            bookingDate: original.bookingDate,
            valueDate: original.valueDate,
            description: original.description,
            propertyReferenceId: original.propertyReferenceId,
            // A mirror of the original's splits, inactive categories included: the reversal must cancel it exactly.
            splits: originalSplits,
          });
          const replacementId =
            replacement === null || categoryIds === undefined
              ? null
              : await insertCorrection(trx, actor, original, 'REPLACEMENT', {
                  ...replacement,
                  splits: replacement.splits.map((s) => ({ ...s, financialCategoryId: categoryIds.get(s.financialCategoryCode) as string })),
                });
          const corrected = await trx
            .updateTable('ledger_transaction')
            .set((eb) => ({ status: 'CORRECTED', version: eb('version', '+', 1), updated_at: new Date() }))
            .where('id', '=', original.id)
            .returning(COLUMNS)
            .executeTakeFirstOrThrow();
          const written = await trx
            .selectFrom('ledger_transaction')
            .select(COLUMNS)
            .where('id', 'in', replacementId === null ? [reversalId] : [reversalId, replacementId])
            .execute();
          const byId = new Map(written.map((r) => [r.id, toDomain(r)]));
          const result: CorrectionResult = {
            original: toDomain(corrected),
            reversal: byId.get(reversalId) as Transaction,
            replacement: replacementId === null ? null : (byId.get(replacementId) as Transaction),
          };

          // One AuditRecord for the whole act (§35.4, §35.9); reversal and replacement are found from it via their link.
          await writeAudit(trx, { type: 'Transaction', id: original.id }, replacement === null ? 'REVERSED' : 'CORRECTED', actor, {
            previousVersion: original.version,
            newVersion: result.original.version,
            metadata: {
              reason: request.reason,
              previousStatus: original.status,
              reversalTransactionId: reversalId,
              ...(replacement === null ? {} : { replacementTransactionId: replacementId, changes: changes(original, originalSplits, replacement) }),
            },
          });
          if (keyed !== undefined) await recordIdempotentResult(trx, keyed.ref, original.id, toResultSnapshot(result));
          return { kind: 'CORRECTED', result, replayed: false };
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      throw error;
    }
  }

  /**
   * Accounts (locked `FOR SHARE` in id order, so a concurrent close waits), currency, exact split sum and the
   * PropertyReferences of the replacement. The original's own account may be closed (§35.2).
   */
  /** `check`, then `categoryIds`: everything the replacement needs before it is written. */
  private async checkReplacement(
    trx: Trx<Database>,
    mreRealmId: string,
    original: Transaction,
    replacement: PlannedReplacement,
    loans: ReadonlyMap<string, SplitLoan>,
    deposits: ReadonlyMap<string, string>,
  ): Promise<Map<string, string>> {
    await this.check(trx, mreRealmId, original, replacement);
    const categoryIds = await this.categoryIds(trx, replacement);
    // §41.5: the replacement's splits with loanId, against the Loans locked in `correct`. The reversal mirrors the
    // original's splits and needs no check: a Loan with splits is never VOID (loan_void_unreferenced).
    const refusal = checkLoanSplits({ direction: replacement.direction, reversal: false, bookingDate: replacement.bookingDate }, replacement.splits, loans);
    if (refusal !== undefined) throw new Rejected(refusal);
    // §47.2: the same for its splits with securityDepositId; a deposit with splits is never VOID either.
    const depositRefusal = checkDepositSplits({ direction: replacement.direction, reversal: false }, replacement.splits, deposits);
    if (depositRefusal !== undefined) throw new Rejected(depositRefusal);
    return categoryIds;
  }

  private async check(trx: Trx<Database>, mreRealmId: string, original: Transaction, replacement: PlannedReplacement): Promise<void> {
    const ids = [...new Set([original.financialAccountId as string, replacement.financialAccountId])].filter((id) => UUID.test(id)).sort();
    const accounts = new Map<string, ReturnType<typeof toFinancialAccount>>();
    for (const id of ids) {
      const account = await trx
        .selectFrom('financial_account')
        .selectAll()
        .where('id', '=', id)
        .where('mre_realm_id', '=', mreRealmId)
        .forShare()
        .executeTakeFirst();
      if (account !== undefined) accounts.set(id, toFinancialAccount(account));
    }
    const target = accounts.get(replacement.financialAccountId);
    if (target === undefined) throw new Rejected({ kind: 'ACCOUNT_NOT_FOUND', financialAccountId: replacement.financialAccountId });
    if (target.id !== original.financialAccountId && target.status === 'CLOSED') {
      throw new Rejected({ kind: 'ACCOUNT_CLOSED', financialAccountId: target.id });
    }
    const currency = target.currency;
    const mismatch = currencyMismatch(replacement, currency);
    if (mismatch !== undefined) throw new Rejected({ kind: 'CURRENCY_MISMATCH', ...mismatch });
    const actual = Money.sum(
      replacement.splits.map((s) => s.amount),
      currency,
    );
    if (!actual.equals(replacement.amount)) throw new Rejected({ kind: 'SUM_MISMATCH', expected: replacement.amount, actual });

    const references = [
      ...new Set([replacement.propertyReferenceId, ...replacement.splits.map((s) => s.propertyReferenceId)].filter((id): id is string => id !== null)),
    ];
    if (references.length > 0) {
      const valid = references.filter((id) => UUID.test(id));
      const found =
        valid.length === 0
          ? []
          : await trx.selectFrom('property_reference').select('id').where('id', 'in', valid).where('mre_realm_id', '=', mreRealmId).execute();
      const missing = references.filter((id) => !found.some((f) => f.id === id));
      if (missing.length > 0) throw new Rejected({ kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceIds: missing });
    }
  }

  /** Category ids of the replacement's splits: requested ones must exist and be active (400), copied ones still be active (422). */
  private async categoryIds(trx: Trx<Database>, replacement: PlannedReplacement): Promise<Map<string, string>> {
    const codes = [...new Set(replacement.splits.map((s) => s.financialCategoryCode))];
    const rows = await trx.selectFrom('financial_category').select(['id', 'code', 'active']).where('code', 'in', codes).execute();
    const unusable = codes.filter((code) => !rows.some((r) => r.code === code && r.active));
    if (unusable.length > 0) {
      throw new Rejected(replacement.splitsRequested ? { kind: 'UNKNOWN_CATEGORY', codes: unusable } : { kind: 'INACTIVE_CATEGORY', codes: unusable });
    }
    return new Map(rows.map((r) => [r.code, r.id]));
  }
}

interface NewCorrection {
  readonly financialAccountId: string;
  readonly amount: Money;
  readonly direction: Direction;
  readonly bookingDate: string;
  readonly valueDate: string | null;
  readonly description: string | null;
  readonly propertyReferenceId: string | null;
  readonly splits: readonly (SplitInput & { readonly financialCategoryId: string })[];
}

/** Inserts a reversal or replacement unconfirmed, writes its splits, then confirms it (§35.6). */
async function insertCorrection(trx: Trx<Database>, actor: AuditActor, original: Transaction, role: CorrectionRole, record: NewCorrection): Promise<string> {
  const { id } = await trx
    .insertInto('ledger_transaction')
    .values({
      mre_realm_id: original.mreRealmId,
      financial_account_id: record.financialAccountId,
      amount: toNumericAmount(record.amount),
      currency: record.amount.currency,
      direction: record.direction,
      booking_date: record.bookingDate,
      value_date: record.valueDate,
      description: record.description,
      property_reference_id: record.propertyReferenceId,
      provenance: 'CORRECTION',
      status: 'CLASSIFIED' satisfies TransactionStatus,
      created_by: actor.actorId,
      correction_of_transaction_id: original.id,
      correction_role: role,
      // A correction changes amount, dates or splits, never who paid: it keeps the original's counterparty (#111). The
      // import identity (§70) stays on the original alone, so re-imports still dedupe against it.
      counterparty_name_raw: original.counterpartyNameRaw,
      counterparty_iban_raw: original.counterpartyIbanRaw,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('transaction_split')
    .values(
      record.splits.map((split, i) => ({
        transaction_id: id,
        mre_realm_id: original.mreRealmId,
        position: i + 1,
        amount: toNumericAmount(split.amount),
        currency: split.amount.currency,
        financial_category_id: split.financialCategoryId,
        property_reference_id: split.propertyReferenceId,
        loan_id: split.loanId,
        security_deposit_id: split.securityDepositId,
        description: split.description,
        created_by: actor.actorId,
      })),
    )
    .execute();
  await trx
    .updateTable('ledger_transaction')
    .set({ status: 'CONFIRMED', confirmed_at: new Date(), confirmed_by: actor.actorId })
    .where('id', '=', id)
    .execute();
  return id;
}

const loanIdsOf = (splits: readonly SplitInput[]) => splits.flatMap((s) => (s.loanId === null ? [] : [s.loanId]));
const depositIdsOf = (splits: readonly SplitInput[]) => splits.flatMap((s) => (s.securityDepositId === null ? [] : [s.securityDepositId]));

async function storedSplits(trx: Trx<Database>, transactionId: string): Promise<StoredSplit[]> {
  const rows = await trx
    .selectFrom('transaction_split')
    .innerJoin('financial_category', 'financial_category.id', 'transaction_split.financial_category_id')
    .select([
      'transaction_split.amount',
      'transaction_split.currency',
      'transaction_split.property_reference_id',
      'transaction_split.loan_id',
      'transaction_split.security_deposit_id',
      'transaction_split.description',
      'transaction_split.financial_category_id',
      'financial_category.code',
      'financial_category.active',
    ])
    .where('transaction_split.transaction_id', '=', transactionId)
    .orderBy('transaction_split.position')
    .execute();
  return rows.map((r) => ({
    amount: fromNumericAmount(r.amount, r.currency),
    financialCategoryCode: r.code,
    propertyReferenceId: r.property_reference_id,
    loanId: r.loan_id,
    securityDepositId: r.security_deposit_id,
    description: r.description,
    financialCategoryId: r.financial_category_id,
    categoryActive: r.active,
  }));
}

/** Old and new value of every field the correction changes (§35.4), splits as a whole. */
function changes(original: Transaction, originalSplits: readonly SplitInput[], replacement: PlannedReplacement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const scalar = (field: string, from: unknown, to: unknown) => {
    if (JSON.stringify(from) !== JSON.stringify(to)) out[field] = { from, to };
  };
  scalar('financialAccountId', original.financialAccountId, replacement.financialAccountId);
  scalar('amount', original.amount.toJSON(), replacement.amount.toJSON());
  scalar('direction', original.direction, replacement.direction);
  scalar('bookingDate', original.bookingDate, replacement.bookingDate);
  scalar('valueDate', original.valueDate, replacement.valueDate);
  scalar('description', original.description, replacement.description);
  scalar('propertyReferenceId', original.propertyReferenceId, replacement.propertyReferenceId);
  const splitJson = (splits: readonly SplitInput[]) =>
    splits.map((s) => ({
      amount: s.amount.toJSON(),
      financialCategoryCode: s.financialCategoryCode,
      propertyReferenceId: s.propertyReferenceId,
      loanId: s.loanId,
      securityDepositId: s.securityDepositId,
      description: s.description,
    }));
  scalar('splits', splitJson(originalSplits), splitJson(replacement.splits));
  return out;
}

function toResultSnapshot(result: CorrectionResult): Record<string, unknown> {
  return {
    original: toSnapshot(result.original),
    reversal: toSnapshot(result.reversal),
    replacement: result.replacement === null ? null : toSnapshot(result.replacement),
  };
}

function fromResultSnapshot(snapshot: unknown): CorrectionResult {
  const s = snapshot as Record<'original' | 'reversal' | 'replacement', unknown>;
  return {
    original: fromSnapshot(s.original),
    reversal: fromSnapshot(s.reversal),
    replacement: s.replacement === null ? null : fromSnapshot(s.replacement),
  };
}
