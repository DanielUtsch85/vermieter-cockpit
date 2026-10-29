import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { nearestEntry, proposePayment, type ProposalTransaction } from './payment-proposal.js';
import { scheduleOf, type LoanTermsId, type RepaymentModel, type SchedulePeriod } from './terms.js';

/** VC-3-05: the payment proposal of api-design.md §41.5, on §41.4's example Loan. */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const period = (overrides: Partial<SchedulePeriod> = {}): SchedulePeriod => ({
  id: 't1' as LoanTermsId,
  validFrom: day('2027-01-01'),
  interestRate: 6000n,
  repaymentModel: 'ANNUITY',
  scheduledPayment: eur('300.00'),
  firstPaymentDate: day('2027-01-31'),
  principalAtStart: null,
  fixedRateUntil: null,
  ...overrides,
});
const annuity = scheduleOf(eur('1000.00'), null, [period()]);
const tx = (overrides: Partial<ProposalTransaction> = {}): ProposalTransaction => ({
  id: 'tx',
  bookingDate: day('2027-03-01'),
  amount: 30_000n,
  direction: 'OUTFLOW',
  status: 'IMPORTED',
  splitCount: 0,
  ...overrides,
});
const model = (m: RepaymentModel) => () => m;

describe('proposePayment (§41.5)', () => {
  it('the example: 300.00 on 2027-03-01 matches entry 2 and proposes 3.53 interest and 296.47 principal, no flags', () => {
    expect(proposePayment(annuity, tx(), model('ANNUITY'))).toMatchObject({
      kind: 'PROPOSAL',
      entry: { number: 2, paymentDate: '2027-02-28' },
      interest: 353n,
      principal: 29_647n,
      unallocated: 0n,
      flags: [],
    });
  });

  it('400.00 the same day: the principal absorbs the difference, flagged', () => {
    expect(proposePayment(annuity, tx({ amount: 40_000n }), model('ANNUITY'))).toMatchObject({
      interest: 353n,
      principal: 39_647n,
      flags: [{ code: 'AMOUNT_DIFFERS_FROM_SCHEDULE', difference: 10_000n }],
    });
    expect(proposePayment(annuity, tx({ amount: 29_000n }), model('ANNUITY'))).toMatchObject({
      flags: [{ code: 'AMOUNT_DIFFERS_FROM_SCHEDULE', difference: -1_000n }],
    });
  });

  it('the nearest entry, and the earlier one on a tie', () => {
    expect(nearestEntry(annuity.entries, day('2027-01-01'))?.number).toBe(1);
    expect(nearestEntry(annuity.entries, day('2027-02-13'))?.number).toBe(1);
    // 2027-02-14 is 14 days after 2027-01-31 and 14 days before 2027-02-28.
    expect(nearestEntry(annuity.entries, day('2027-02-14'))?.number).toBe(1);
    expect(nearestEntry(annuity.entries, day('2027-02-15'))?.number).toBe(2);
    expect(nearestEntry(annuity.entries, day('2030-01-01'))?.number).toBe(4);
  });

  it('an amount below the interest: all interest, no principal, flagged', () => {
    expect(proposePayment(annuity, tx({ amount: 300n }), model('ANNUITY'))).toMatchObject({
      interest: 300n,
      principal: 0n,
      unallocated: 0n,
      flags: [{ code: 'AMOUNT_DIFFERS_FROM_SCHEDULE' }, { code: 'AMOUNT_BELOW_INTEREST' }],
    });
  });

  it('INTEREST_ONLY: the interest only, the rest unallocated and flagged', () => {
    const io = scheduleOf(eur('1000.00'), null, [period({ repaymentModel: 'INTEREST_ONLY', scheduledPayment: null })]);
    expect(proposePayment(io, tx({ amount: 10_000n }), model('INTEREST_ONLY'))).toMatchObject({
      interest: 500n,
      principal: 0n,
      unallocated: 9_500n,
      flags: [{ code: 'AMOUNT_DIFFERS_FROM_SCHEDULE', difference: 9_500n }, { code: 'REST_NOT_PLANNED' }],
    });
    expect(proposePayment(io, tx({ amount: 500n }), model('INTEREST_ONLY'))).toMatchObject({ interest: 500n, unallocated: 0n, flags: [] });
  });

  it('a Transaction with splits is still proposed, flagged ALREADY_SPLIT', () => {
    expect(proposePayment(annuity, tx({ splitCount: 2 }), model('ANNUITY'))).toMatchObject({ flags: [{ code: 'ALREADY_SPLIT' }] });
  });

  it('NOT_PROPOSABLE for an INFLOW or a confirmed Transaction; NO_SCHEDULE without payments', () => {
    expect(proposePayment(annuity, tx({ direction: 'INFLOW' }), model('ANNUITY'))).toEqual({ kind: 'NOT_PROPOSABLE', direction: 'INFLOW', status: 'IMPORTED' });
    for (const status of ['CONFIRMED', 'RECONCILED', 'CORRECTED', 'IGNORED']) {
      expect(proposePayment(annuity, tx({ status }), model('ANNUITY'))).toMatchObject({ kind: 'NOT_PROPOSABLE', status });
    }
    for (const status of ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED']) {
      expect(proposePayment(annuity, tx({ status }), model('ANNUITY')).kind).toBe('PROPOSAL');
    }
    expect(proposePayment(scheduleOf(eur('1000.00'), null, []), tx(), model('ANNUITY'))).toEqual({ kind: 'NO_SCHEDULE', endReason: 'NO_TERMS' });
  });
});
