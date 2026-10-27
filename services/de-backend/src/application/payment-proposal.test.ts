import { describe, expect, it } from 'vitest';
import type { Loan, LoanTerms, LoanTermsRepository } from '../domains/financing/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { NoScheduleError, PaymentNotProposableError, ProposalTransactionNotFoundError, getLoanSchedule, getPaymentProposal } from './loan-terms.js';
import { LoanClosedOnError, LoanNotActiveError, LoanNotFoundError } from './loans.js';

/** VC-3-05: the proposal's order of refusals (api-design.md §41.5) over a fake repository. */
const principal = { email: 'anna@example.com', mreRealmId: 'realm', mreRole: 'administrator' } as const;
const day = (value: string) => value as BusinessDate;
const loan = { id: 'l', status: 'ACTIVE', principalOriginal: Money.of('1000.00', 'EUR'), maturityDate: null } as unknown as Loan;
const period = {
  id: 't1',
  status: 'VALID',
  validFrom: day('2027-01-01'),
  interestRate: 6000n,
  repaymentModel: 'ANNUITY',
  scheduledPayment: Money.of('300.00', 'EUR'),
  firstPaymentDate: day('2027-01-31'),
  principalAtStart: null,
} as unknown as LoanTerms;
const transaction = { id: 'tx', bookingDate: day('2027-03-01'), amount: 30_000n, direction: 'OUTFLOW', status: 'IMPORTED', splitCount: 0 };
const with_ = (inputs: Awaited<ReturnType<LoanTermsRepository['proposalInputs']>>) =>
  getPaymentProposal({ repository: { proposalInputs: async () => inputs } as unknown as LoanTermsRepository });
const call = (inputs: Awaited<ReturnType<LoanTermsRepository['proposalInputs']>>) => with_(inputs)({ principal, loanId: 'l', transactionId: 'tx' });

describe('getPaymentProposal (§41.5)', () => {
  it('proposes from the schedule', async () => {
    expect(await call({ kind: 'FOUND', loan, periods: [period], transaction })).toMatchObject({
      loanId: 'l',
      transactionId: 'tx',
      bookingDate: '2027-03-01',
      amount: 30_000n,
      interest: 353n,
      principal: 29_647n,
      entry: { number: 2 },
    });
  });

  it('refuses in order: Loan 404, Transaction 404, VOID Loan, NOT_PROPOSABLE, NO_SCHEDULE', async () => {
    await expect(call({ kind: 'LOAN_NOT_FOUND' })).rejects.toBeInstanceOf(LoanNotFoundError);
    await expect(call({ kind: 'TRANSACTION_NOT_FOUND' })).rejects.toBeInstanceOf(ProposalTransactionNotFoundError);
    const voided = { ...loan, status: 'VOID' } as Loan;
    await expect(call({ kind: 'FOUND', loan: voided, periods: [], transaction: { ...transaction, direction: 'INFLOW' } })).rejects.toBeInstanceOf(LoanNotActiveError);
    await expect(call({ kind: 'FOUND', loan, periods: [], transaction: { ...transaction, status: 'CONFIRMED' } })).rejects.toBeInstanceOf(PaymentNotProposableError);
    await expect(call({ kind: 'FOUND', loan, periods: [], transaction })).rejects.toBeInstanceOf(NoScheduleError);
  });

  it('a CLOSED Loan (§41.7): a Transaction after the closing date is LOAN_CLOSED, after the VOID check; on it the cut plan proposes', async () => {
    const closed = { ...loan, status: 'CLOSED', closingDate: day('2027-02-28') } as Loan;
    await expect(call({ kind: 'FOUND', loan: closed, periods: [period], transaction })).rejects.toMatchObject(new LoanClosedOnError('l', day('2027-02-28')));
    expect(await call({ kind: 'FOUND', loan: closed, periods: [period], transaction: { ...transaction, bookingDate: day('2027-02-28') } })).toMatchObject({ entry: { number: 2 } });
    // Cut before the first payment, the plan has no entry left to propose.
    const early = { ...loan, status: 'CLOSED', closingDate: day('2027-01-15') } as Loan;
    await expect(call({ kind: 'FOUND', loan: early, periods: [period], transaction: { ...transaction, bookingDate: day('2027-01-15') } })).rejects.toMatchObject({ endReason: 'CLOSED' });
  });
});

describe('getLoanSchedule (§41.4, §41.7)', () => {
  it('a CLOSED Loan\'s plan is cut at its closing date with endReason CLOSED', async () => {
    const read = (l: Loan) => getLoanSchedule({ repository: { scheduleInputs: async () => ({ loan: l, periods: [period] }) } as unknown as LoanTermsRepository })({ principal, loanId: 'l' });
    expect((await read(loan)).summary).toMatchObject({ payments: 4, endReason: 'PAID_OFF' });
    const closed = await read({ ...loan, status: 'CLOSED', closingDate: day('2027-02-28') } as Loan);
    expect([closed.entries.length, closed.summary.endReason, closed.summary.balanceDue]).toEqual([2, 'CLOSED', 40_853n]);
  });
});
