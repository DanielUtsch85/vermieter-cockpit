import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import type { LoanAllocationSetId, LoanAllocationSetView } from './allocation.js';
import { planClose, type CloseRequest } from './close.js';
import { checkStatement, debtOn, debtPerProperty, type CountedSplit } from './debt.js';
import { planVoid, type Loan, type LoanId } from './loan.js';
import { closedSchedule, loanSchedule, scheduleOf, type LoanTermsId, type SchedulePeriod } from './terms.js';

/** VC-3-07: closing a Loan (api-design.md §41.7), on §41.4's example Loan of 1 000.00 from 2027-01-01. */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const loanOf = (overrides: Partial<Loan> = {}): Loan => ({
  id: 'l0000000-0000-4000-8000-000000000001' as LoanId,
  mreRealmId: 'realm',
  status: 'ACTIVE',
  lenderPartyId: 'bank',
  borrowerPartyIds: ['anna'],
  principalOriginal: eur('1000.00'),
  startDate: day('2027-01-01'),
  disbursementDate: null,
  maturityDate: null,
  contractNumber: null,
  acquisitionId: null,
  sourceReferences: [],
  notes: null,
  voidedAt: null,
  voidReason: null,
  closingDate: null,
  closingReason: null,
  refinancedByLoanId: null,
  closingNote: null,
  createdAt: new Date('2027-01-01T00:00:00Z'),
  version: 3,
  ...overrides,
});
const loan = loanOf();
const successor = loanOf({ id: 'l0000000-0000-4000-8000-000000000002' as LoanId });
const principal = (bookingDate: string, amount: bigint): CountedSplit => ({ transactionId: `tx-${bookingDate}`, bookingDate: day(bookingDate), category: 'LOAN_PRINCIPAL', amount });
const request = (overrides: Partial<CloseRequest> = {}): CloseRequest => ({ closingDate: day('2027-06-30'), reason: 'OTHER', refinancedByLoanId: null, closingNote: 'Vergleich', ...overrides });
const refinanced = request({ reason: 'REFINANCED', refinancedByLoanId: successor.id, closingNote: null });
const period: SchedulePeriod = {
  id: 't1' as LoanTermsId,
  validFrom: day('2027-01-01'),
  interestRate: 6000n,
  repaymentModel: 'ANNUITY',
  scheduledPayment: eur('300.00'),
  firstPaymentDate: day('2027-01-31'),
  principalAtStart: null,
};

describe('planClose (§41.7)', () => {
  it('the order of checks: not ACTIVE, before the debt, the refinancing Loan, splits after the date, REPAID at 0', () => {
    const after = [{ transactionId: 'b', bookingDate: day('2027-08-01') }, { transactionId: 'a', bookingDate: day('2027-07-01') }, { transactionId: 'b', bookingDate: day('2027-08-01') }];
    expect(planClose(loanOf({ status: 'VOID' }), request({ closingDate: day('2026-01-01') }), undefined, after, [])).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
    expect(planClose(loan, request({ closingDate: day('2026-12-31'), reason: 'REFINANCED' }), undefined, after, [])).toEqual({ kind: 'CLOSING_BEFORE_DEBT', debtFrom: '2027-01-01' });
    expect(planClose(loan, refinanced, undefined, after, [])).toEqual({ kind: 'REFINANCING_LOAN_NOT_FOUND', refinancedByLoanId: successor.id });
    expect(planClose(loan, refinanced, loanOf({ status: 'CLOSED' }), after, [])).toEqual({ kind: 'REFINANCING_LOAN_NOT_ACTIVE', status: 'CLOSED' });
    expect(planClose(loan, refinanced, successor, after, [])).toEqual({ kind: 'SPLITS_AFTER_CLOSING', transactionIds: ['a', 'b'] });
    expect(planClose(loan, request({ reason: 'REPAID', closingNote: null }), undefined, after, [principal('2027-01-31', 1n)])).toEqual({ kind: 'SPLITS_AFTER_CLOSING', transactionIds: ['a', 'b'] });
    expect(planClose(loan, request({ reason: 'REPAID', closingNote: null }), undefined, [], [principal('2027-01-31', 99_999n)])).toEqual({ kind: 'REMAINING_DEBT_NOT_ZERO', actual: 1n });
  });

  it('REPAID: a rest, an overpayment, payments after the date not counted; at 0 it closes with settledAmount 0', () => {
    const repaid = request({ reason: 'REPAID', closingNote: null });
    expect(planClose(loan, repaid, undefined, [], [principal('2027-01-31', 100_001n)])).toEqual({ kind: 'REMAINING_DEBT_NOT_ZERO', actual: -1n });
    expect(planClose(loan, repaid, undefined, [], [principal('2027-01-31', 60_000n), principal('2027-07-31', 40_000n)])).toEqual({ kind: 'REMAINING_DEBT_NOT_ZERO', actual: 40_000n });
    expect(planClose(loan, repaid, undefined, [], [principal('2027-01-31', 60_000n), principal('2027-06-30', 40_000n)])).toMatchObject({
      kind: 'CLOSE',
      settledAmount: 0n,
      next: { status: 'CLOSED', closingDate: '2027-06-30', closingReason: 'REPAID', refinancedByLoanId: null, closingNote: null, version: 4 },
    });
  });

  it('REFINANCED: settledAmount is the rest the other Loan took over; OTHER keeps its note', () => {
    expect(planClose(loan, refinanced, successor, [], [principal('2027-01-31', 30_000n)])).toMatchObject({ kind: 'CLOSE', settledAmount: 70_000n, next: { refinancedByLoanId: successor.id } });
    expect(planClose(loan, request(), undefined, [], [])).toMatchObject({ kind: 'CLOSE', settledAmount: 100_000n, next: { closingReason: 'OTHER', closingNote: 'Vergleich' } });
  });

  it('a repeat with the same values is a no-op; other values are LOAN_NOT_ACTIVE', () => {
    const done = loanOf({ status: 'CLOSED', closingDate: day('2027-06-30'), closingReason: 'OTHER', closingNote: 'Vergleich' });
    expect(planClose(done, request(), undefined, [], [])).toEqual({ kind: 'UNCHANGED' });
    expect(planClose(done, request({ closingNote: 'anders' }), undefined, [], [])).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'CLOSED' });
    expect(planClose(done, request({ closingDate: day('2027-07-01') }), undefined, [], [])).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'CLOSED' });
  });
});

describe('void of a successor (§41.7, review on #71)', () => {
  it('LOAN_REFINANCES after LOAN_HAS_SPLITS; a CLOSED Loan stays LOAN_CLOSED first', () => {
    const at = new Date();
    expect(planVoid(loan, 'x', at, [], ['z', 'a', 'z'])).toEqual({ kind: 'LOAN_REFINANCES', loanIds: ['a', 'z'] });
    expect(planVoid(loan, 'x', at, ['tx'], ['a'])).toEqual({ kind: 'LOAN_HAS_SPLITS', transactionIds: ['tx'] });
    expect(planVoid(loanOf({ status: 'CLOSED' }), 'x', at, [], ['a'])).toEqual({ kind: 'LOAN_CLOSED' });
    expect(planVoid(loan, 'x', at, [], []).kind).toBe('VOID');
  });
});

describe('effects of CLOSED (§41.7)', () => {
  const done = (closingDate: string, overrides: Partial<Loan> = {}) => loanOf({ status: 'CLOSED', closingDate: day(closingDate), closingReason: 'REFINANCED', refinancedByLoanId: successor.id, ...overrides });
  const paid = [principal('2027-01-31', 29_500n), principal('2027-02-28', 29_647n)];

  it('the remaining debt: as derived on the date, 0 after it; principalPaid stays; NO_TERMS keeps null', () => {
    const closed = done('2027-03-15');
    expect(debtOn(closed, [period], paid, day('2027-03-15'))).toMatchObject({ principalPaid: 59_147n, actual: 40_853n, planned: 40_853n, difference: 0n });
    expect(debtOn(closed, [period], paid, day('2027-03-16'))).toEqual({ principalPaid: 59_147n, actual: 0n, planned: 0n, difference: 0n, planEndReason: 'CLOSED' });
    expect(debtOn(closed, [], paid, day('2028-01-01'))).toEqual({ principalPaid: 59_147n, actual: 0n, planned: null, difference: null, planEndReason: 'NO_TERMS' });
    // Not a closed Loan: the same day shows the debt left.
    expect(debtOn(loan, [period], paid, day('2027-03-16'))).toMatchObject({ actual: 40_853n });
  });

  it('per property after the date: zeros', () => {
    const set: LoanAllocationSetView = {
      id: 's' as LoanAllocationSetId,
      loanId: loan.id,
      mreRealmId: 'realm',
      status: 'VALID',
      validFrom: day('2027-01-01'),
      validUntil: null,
      basis: 'MANUAL',
      allocations: [
        { propertyReferenceId: 'p-a', share: { numerator: 2n, denominator: 3n }, acquisitionId: null },
        { propertyReferenceId: 'p-b', share: { numerator: 1n, denominator: 3n }, acquisitionId: null },
      ],
      notes: null,
      voidedAt: null,
      voidReason: null,
      createdAt: new Date(),
      version: 1,
    };
    expect(debtPerProperty(debtOn(done('2027-03-15'), [period], paid, day('2027-04-01')), set).map((i) => [i.actual, i.planned, i.difference])).toEqual([
      [0n, 0n, 0n],
      [0n, 0n, 0n],
    ]);
  });

  it('the schedule: entries after the date omitted, the summary over the rest, endReason CLOSED; a plan ended before keeps its reason', () => {
    const cut = closedSchedule(scheduleOf(eur('1000.00'), null, [period]), day('2027-03-15'));
    expect(cut.entries.map((e) => e.number)).toEqual([1, 2]);
    expect(cut.summary).toEqual({
      payments: 2,
      firstPaymentDate: '2027-01-31',
      lastPaymentDate: '2027-02-28',
      totalInterest: 853n,
      totalPrincipal: 59_147n,
      balanceDue: 40_853n,
      endReason: 'CLOSED',
    });
    expect(closedSchedule(scheduleOf(eur('1000.00'), null, [period]), day('2026-12-31')).summary).toMatchObject({ payments: 0, balanceDue: 100_000n, endReason: 'CLOSED' });
    expect(loanSchedule(done('2027-05-01'), [period]).summary).toMatchObject({ payments: 4, endReason: 'PAID_OFF' });
    expect(loanSchedule(done('2027-03-15'), [period]).summary.endReason).toBe('CLOSED');
    expect(loanSchedule(loanOf(), [period]).summary.endReason).toBe('PAID_OFF');
  });

  it('statements: on the closing date allowed, after it refused, after the debt check', () => {
    const closed = done('2027-06-30');
    expect(checkStatement(closed, day('2027-06-30'))).toBeUndefined();
    expect(checkStatement(closed, day('2027-07-01'))).toEqual({ kind: 'STATEMENT_AFTER_CLOSING', closingDate: '2027-06-30' });
    expect(checkStatement(closed, day('2026-12-31'))).toEqual({ kind: 'STATEMENT_BEFORE_DEBT', debtFrom: '2027-01-01' });
  });
});
