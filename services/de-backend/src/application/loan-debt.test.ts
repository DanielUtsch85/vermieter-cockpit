import { describe, expect, it } from 'vitest';
import type { DebtInputs, Loan, LoanDebtRepository } from '../domains/financing/index.js';
import { Money } from '../shared/index.js';
import {
  StatementBeforeDebtError,
  LoanBalanceStatementNotFoundError,
  LoanNotAllocatedError,
  createBalanceStatement,
  getLoanPayments,
  getRemainingDebt,
  listBalanceStatements,
  voidBalanceStatement,
} from './loan-debt.js';
import { LoanNotActiveError, LoanNotFoundError } from './loans.js';

/** VC-3-06: the refusals of api-design.md §41.6 and the default `asOf`, over a fake repository. */
const principal = { email: 'anna@example.com', mreRealmId: 'realm', mreRole: 'administrator' } as const;
const loan = {
  id: 'l',
  status: 'ACTIVE',
  principalOriginal: Money.of('1000.00', 'EUR'),
  startDate: '2027-01-01',
  disbursementDate: null,
  maturityDate: null,
} as unknown as Loan;
const inputs = (overrides: Partial<DebtInputs> = {}): DebtInputs => ({ loan, periods: [], sets: [], splits: [], statements: [], ...overrides });
const repo = (found: DebtInputs | undefined, writes: Partial<LoanDebtRepository> = {}) => ({ debtInputs: async () => found, ...writes }) as LoanDebtRepository;

describe('getRemainingDebt (§41.6)', () => {
  it('asOf defaults to today in Europe/Berlin: 23:30 UTC on 2027-03-14 is already 2027-03-15 there', async () => {
    const read = getRemainingDebt({ repository: repo(inputs()), now: () => new Date('2027-03-14T23:30:00Z') });
    expect(await read({ principal, loanId: 'l', perProperty: false })).toMatchObject({ asOf: '2027-03-15', actual: 100_000n, planned: null });
    expect(await read({ principal, loanId: 'l', asOf: '2027-01-02' as never, perProperty: false })).toMatchObject({ asOf: '2027-01-02' });
  });

  it('refuses in order: Loan 404, VOID 409, LOAN_NOT_ALLOCATED with asOf', async () => {
    const read = (found: DebtInputs | undefined) =>
      getRemainingDebt({ repository: repo(found) })({ principal, loanId: 'l', asOf: '2027-02-01' as never, perProperty: true });
    await expect(read(undefined)).rejects.toBeInstanceOf(LoanNotFoundError);
    await expect(read(inputs({ loan: { ...loan, status: 'VOID' } }))).rejects.toBeInstanceOf(LoanNotActiveError);
    await expect(read(inputs())).rejects.toMatchObject(new LoanNotAllocatedError('l', { asOf: '2027-02-01' as never }));
  });
});

describe('getLoanPayments (§41.6)', () => {
  it('refuses in order: 404, VOID 409; a Loan-level read whatever the allocation', async () => {
    const read = (found: DebtInputs | undefined, perProperty = false) =>
      getLoanPayments({ repository: repo(found) })({ principal, loanId: 'l', year: 2027, perProperty });
    await expect(read(undefined)).rejects.toBeInstanceOf(LoanNotFoundError);
    await expect(read(inputs({ loan: { ...loan, status: 'VOID' } }))).rejects.toBeInstanceOf(LoanNotActiveError);
    const splits = [{ transactionId: 't', bookingDate: '2027-01-31' as never, category: 'LOAN_INTEREST' as const, amount: 500n }];
    expect(await read(inputs({ splits }))).toEqual({ year: 2027, interest: 500n, principal: 0n, payments: 1 });
    await expect(read(inputs({ splits }), true)).rejects.toMatchObject({ details: { bookingDate: '2027-01-31' } });
  });
});

describe('statements (§41.6)', () => {
  const data = { statementDate: '2027-01-31' as never, balance: Money.of('1.00', 'EUR'), source: 'Brief', notes: null };

  it('create maps each refusal; the fingerprint is passed with a key only', async () => {
    const seen: unknown[] = [];
    const create = (outcome: Awaited<ReturnType<LoanDebtRepository['createStatement']>>) =>
      createBalanceStatement({
        repository: repo(undefined, {
          createStatement: async (...args) => {
            seen.push(args[4]);
            return outcome;
          },
        }),
      });
    await expect(create({ kind: 'LOAN_NOT_FOUND' })({ principal, loanId: 'l', ...data })).rejects.toBeInstanceOf(LoanNotFoundError);
    await expect(create({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' })({ principal, loanId: 'l', ...data })).rejects.toBeInstanceOf(LoanNotActiveError);
    await expect(
      create({ kind: 'STATEMENT_BEFORE_DEBT', debtFrom: '2027-02-01' as never })({ principal, loanId: 'l', ...data, idempotencyKey: 'k' }),
    ).rejects.toMatchObject(new StatementBeforeDebtError('2027-02-01' as never));
    expect(seen).toEqual([undefined, undefined, { key: 'k', fingerprint: JSON.stringify(['l', '2027-01-31', '1.00', 'Brief', null]) }]);
  });

  it('void maps NOT_FOUND; list refuses 404 and a VOID Loan', async () => {
    const voiding = voidBalanceStatement({ repository: repo(undefined, { voidStatement: async () => ({ kind: 'NOT_FOUND' }) }) });
    await expect(voiding({ principal, loanId: 'l', statementId: 's', reason: 'x' })).rejects.toBeInstanceOf(LoanBalanceStatementNotFoundError);
    await expect(listBalanceStatements({ repository: repo(undefined) })({ principal, loanId: 'l' })).rejects.toBeInstanceOf(LoanNotFoundError);
    await expect(listBalanceStatements({ repository: repo(inputs({ loan: { ...loan, status: 'VOID' } })) })({ principal, loanId: 'l' })).rejects.toBeInstanceOf(
      LoanNotActiveError,
    );
    expect(await listBalanceStatements({ repository: repo(inputs()) })({ principal, loanId: 'l' })).toEqual([]);
  });
});
