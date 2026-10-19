import { describe, expect, it } from 'vitest';
import type {
  BusinessDate,
  CreateTransactionOutcome,
  NewManualTransaction,
  Transaction,
  TransactionId,
  TransactionRepository,
} from '../domains/ledger/index.js';
import { Money, type AuditActor } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { FinancialAccountNotFoundError, IdempotencyKeyConflictError } from './financial-accounts.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';
import { CurrencyMismatchError, FinancialAccountClosedError, createManualTransaction } from './transactions.js';

const REALM = '64b0c0ffee0000000000000a';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const input = {
  principal,
  financialAccountId: '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b',
  amount: Money.of('1250.00', 'EUR'),
  direction: 'INFLOW',
  bookingDate: '2026-09-01' as BusinessDate,
  valueDate: null,
  description: null,
  propertyReferenceId: 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f',
} as const;

/** A repository answering one fixed outcome and recording what it was given. */
function repositoryAnswering(outcome: CreateTransactionOutcome | ((t: NewManualTransaction) => CreateTransactionOutcome)) {
  const calls: { transaction: NewManualTransaction; actor: AuditActor; idempotency?: { key: string; fingerprint: string } }[] = [];
  const repository: TransactionRepository = {
    createManual: async (transaction, actor, idempotency) => {
      calls.push({ transaction, actor, ...(idempotency === undefined ? {} : { idempotency }) });
      return typeof outcome === 'function' ? outcome(transaction) : outcome;
    },
  };
  return { repository, calls };
}

const created = (t: NewManualTransaction): CreateTransactionOutcome => ({
  kind: 'CREATED',
  transaction: {
    ...t,
    id: 'tx-1' as TransactionId,
    financialAccountId: t.financialAccountId,
    provenance: 'MANUAL',
    status: 'UNREVIEWED',
    createdAt: new Date('2026-10-19T08:00:00Z'),
    version: 1,
  } as Transaction,
});

describe('createManualTransaction', () => {
  it("creates in the caller's Realm, audited as the caller, with a fingerprint only when a key is given", async () => {
    const { repository, calls } = repositoryAnswering(created);
    const create = createManualTransaction({ repository });
    const { transaction, replayed } = await create(input);
    expect(replayed).toBe(false);
    expect(transaction).toMatchObject({ mreRealmId: REALM, provenance: 'MANUAL', status: 'UNREVIEWED' });
    expect(calls[0]?.actor).toEqual({ actorType: 'USER', actorId: 'anna@example.com' });
    expect(calls[0]?.idempotency).toBeUndefined();

    await create({ ...input, idempotencyKey: 'k-1' });
    expect(calls[1]?.idempotency?.key).toBe('k-1');
    expect(calls[1]?.idempotency?.fingerprint).toEqual(expect.any(String));
  });

  it('a replay is reported as such', async () => {
    const { repository } = repositoryAnswering((t) => ({ ...(created(t) as { transaction: Transaction }), kind: 'REPLAYED' }));
    expect((await createManualTransaction({ repository })({ ...input, idempotencyKey: 'k-1' })).replayed).toBe(true);
  });

  it.each([
    [{ kind: 'IDEMPOTENCY_CONFLICT' }, IdempotencyKeyConflictError],
    [{ kind: 'REJECTED', reason: 'ACCOUNT_NOT_FOUND' }, FinancialAccountNotFoundError],
    [{ kind: 'REJECTED', reason: 'ACCOUNT_CLOSED' }, FinancialAccountClosedError],
    [{ kind: 'REJECTED', reason: 'CURRENCY_MISMATCH' }, CurrencyMismatchError],
    [{ kind: 'REJECTED', reason: 'PROPERTY_REFERENCE_NOT_FOUND' }, PropertyReferenceNotFoundError],
  ] as const)('%o → %o', async (outcome, errorType) => {
    const { repository } = repositoryAnswering(outcome);
    await expect(createManualTransaction({ repository })(input)).rejects.toBeInstanceOf(errorType);
  });
});
