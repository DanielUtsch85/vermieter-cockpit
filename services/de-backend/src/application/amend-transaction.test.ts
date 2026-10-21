import { describe, expect, it } from 'vitest';
import type { AmendOutcome, IgnoreOutcome, RestoreOutcome, Transaction, UnconfirmedTransactionRepository } from '../domains/ledger/index.js';
import type { RealmPrincipal } from './access.js';
import {
  ImportedFieldsFixedError,
  TransactionNotAmendableError,
  TransactionNotIgnorableError,
  TransactionNotIgnoredError,
  amendTransaction,
  ignoreTransaction,
  restoreTransaction,
} from './amend-transaction.js';
import { FinancialAccountNotFoundError } from './financial-accounts.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import { TransactionNotFoundError } from './transaction-splits.js';
import { CurrencyMismatchError, FinancialAccountClosedError } from './transactions.js';

const REALM = '64b0c0ffee0000000000000a';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const transaction = { id: 't1' } as unknown as Transaction;

function repository(answers: { amend?: AmendOutcome; ignore?: IgnoreOutcome; restore?: RestoreOutcome }) {
  const calls: unknown[][] = [];
  const repo: UnconfirmedTransactionRepository = {
    amend: async (...args) => (calls.push(args), answers.amend as AmendOutcome),
    ignore: async (...args) => (calls.push(args), answers.ignore as IgnoreOutcome),
    restore: async (...args) => (calls.push(args), answers.restore as RestoreOutcome),
  };
  return { repo, calls };
}
const actor = { actorType: 'USER', actorId: 'anna@example.com' };

describe('amend / ignore / restore use cases (api-design.md §31.3–31.4)', () => {
  it('pass Realm and actor; return the Transaction', async () => {
    const { repo, calls } = repository({
      amend: { kind: 'AMENDED', transaction, changed: true, splitsDropped: false },
      ignore: { kind: 'IGNORED', transaction, replayed: true },
      restore: { kind: 'RESTORED', transaction },
    });
    expect(await amendTransaction({ repository: repo })({ principal, transactionId: 't1', changes: { description: 'x' } })).toEqual({
      transaction,
      changed: true,
      splitsDropped: false,
    });
    expect(await ignoreTransaction({ repository: repo })({ principal, transactionId: 't1', reason: 'r' })).toEqual({ transaction, replayed: true });
    expect(await restoreTransaction({ repository: repo })({ principal, transactionId: 't1' })).toEqual({ transaction });
    expect(calls).toEqual([
      ['t1', REALM, { description: 'x' }, actor, undefined],
      ['t1', REALM, 'r', actor, undefined],
      ['t1', REALM, actor, undefined],
    ]);
  });

  it('turn refusals into errors', async () => {
    const amendCases: [AmendOutcome, new (...args: never[]) => Error][] = [
      [{ kind: 'NOT_FOUND' }, TransactionNotFoundError],
      [{ kind: 'NOT_AMENDABLE', status: 'CONFIRMED' }, TransactionNotAmendableError],
      [{ kind: 'IMPORTED_FIELDS_FIXED', fields: ['amount'] }, ImportedFieldsFixedError],
      [{ kind: 'ACCOUNT_NOT_FOUND', financialAccountId: 'a' }, FinancialAccountNotFoundError],
      [{ kind: 'ACCOUNT_CLOSED', financialAccountId: 'a' }, FinancialAccountClosedError],
      [{ kind: 'CURRENCY_MISMATCH' }, CurrencyMismatchError],
      [{ kind: 'PROPERTY_REFERENCE_NOT_FOUND', propertyReferenceId: 'p' }, PropertyReferenceNotFoundError],
    ];
    for (const [outcome, type] of amendCases) {
      await expect(
        amendTransaction({ repository: repository({ amend: outcome }).repo })({ principal, transactionId: 't1', changes: {} }),
        outcome.kind,
      ).rejects.toBeInstanceOf(type);
    }
    await expect(
      ignoreTransaction({ repository: repository({ ignore: { kind: 'NOT_IGNORABLE', status: 'CONFIRMED' } }).repo })({ principal, transactionId: 't1', reason: 'r' }),
    ).rejects.toBeInstanceOf(TransactionNotIgnorableError);
    await expect(
      restoreTransaction({ repository: repository({ restore: { kind: 'NOT_IGNORED', status: 'CLASSIFIED' } }).repo })({ principal, transactionId: 't1' }),
    ).rejects.toBeInstanceOf(TransactionNotIgnoredError);
    await expect(
      restoreTransaction({ repository: repository({ restore: { kind: 'NOT_FOUND' } }).repo })({ principal, transactionId: 't1' }),
    ).rejects.toBeInstanceOf(TransactionNotFoundError);
  });
});
