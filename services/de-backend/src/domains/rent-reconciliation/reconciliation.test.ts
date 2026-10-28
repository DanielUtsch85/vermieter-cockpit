import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { checkMatch, coverageOf, isTermKey, matchedTotalOf, planConfirm, planReject, planRelease, staleBy, type MatchCash, type RentPaymentReconciliation, type RentPaymentReconciliationId } from './reconciliation.js';

const eur = (amount: string) => Money.of(amount, 'EUR');
const TENANT = '6512f0c2a1b2c3d4e5f60a01';
const cash = (overrides: Partial<MatchCash> = {}): MatchCash => ({
  status: 'CONFIRMED',
  direction: 'INFLOW',
  correctionRole: null,
  rentCash: eur('800.00'),
  confirmed: [],
  ...overrides,
});
const request = (amount = '800.00', term = '2027010100') => ({ mreTenantId: TENANT, mreRentTerm: term, matchedAmount: eur(amount) });
const confirmed = (amount: string, term: string, id = 'r1') => ({ id, mreTenantId: TENANT, mreRentTerm: term, matchedAmount: eur(amount) });

describe('isTermKey (§37.1: the form only)', () => {
  it.each(['2027010100', '2027022800', '2028022900', '2027123123', '1999010100'])('%s is a term key', (term) => {
    expect(isTermKey(term)).toBe(true);
  });
  it.each(['202701', '20270101000', '2027013200', '2027022900', '2027130100', '2027000100', '2027010024', '2027-01-01', 'abcdefghij', '2027010000'])(
    '%s is not',
    (term) => {
      expect(isTermKey(term)).toBe(false);
    },
  );
});

describe('checkMatch (§37.1 checks 2–7, P4-D3)', () => {
  it('follows the order: unknown, not counted, not INFLOW, no rent cash, already matched, exceeded', () => {
    expect(checkMatch(undefined, request())).toEqual({ kind: 'TRANSACTION_NOT_FOUND' });
    // Not counted comes before the direction: an unconfirmed OUTFLOW is not counted.
    expect(checkMatch(cash({ status: 'CLASSIFIED', direction: 'OUTFLOW' }), request())).toEqual({ kind: 'TRANSACTION_NOT_COUNTED', status: 'CLASSIFIED', correctionRole: null });
    expect(checkMatch(cash({ direction: 'OUTFLOW', rentCash: null }), request())).toEqual({ kind: 'TRANSACTION_NOT_INFLOW' });
    expect(checkMatch(cash({ rentCash: null }), request())).toEqual({ kind: 'NO_RENT_CASH' });
    expect(checkMatch(cash({ rentCash: eur('0.00') }), request())).toEqual({ kind: 'NO_RENT_CASH' });
    // Already matched comes before the amount: the same term twice is never "exceeded".
    expect(checkMatch(cash({ confirmed: [confirmed('800.00', '2027010100')] }), request('900.00'))).toEqual({ kind: 'ALREADY_MATCHED', reconciliationId: 'r1' });
    expect(checkMatch(cash(), request('800.01'))).toEqual({ kind: 'RENT_CASH_EXCEEDED', rentCash: eur('800.00'), available: eur('800.00') });
  });

  it('counted: CONFIRMED and RECONCILED, never a reversal or a CORRECTED original', () => {
    expect(checkMatch(cash({ status: 'RECONCILED' }), request())).toBeUndefined();
    expect(checkMatch(cash({ correctionRole: 'REPLACEMENT' }), request())).toBeUndefined();
    expect(checkMatch(cash({ correctionRole: 'REVERSAL' }), request())).toEqual({ kind: 'TRANSACTION_NOT_COUNTED', status: 'CONFIRMED', correctionRole: 'REVERSAL' });
    expect(checkMatch(cash({ status: 'CORRECTED' }), request())).toEqual({ kind: 'TRANSACTION_NOT_COUNTED', status: 'CORRECTED', correctionRole: null });
  });

  it('available = rent cash − CONFIRMED matches; exactly the rest is allowed, a cent more is not', () => {
    const two = cash({ confirmed: [confirmed('300.00', '2027010100'), confirmed('200.00', '2027020100', 'r2')] });
    expect(checkMatch(two, request('300.00', '2027030100'))).toBeUndefined();
    expect(checkMatch(two, request('300.01', '2027030100'))).toEqual({ kind: 'RENT_CASH_EXCEEDED', rentCash: eur('800.00'), available: eur('300.00') });
    // Another Tenant on the same term is another match.
    expect(checkMatch(cash({ confirmed: [confirmed('300.00', '2027010100')] }), { ...request('500.00'), mreTenantId: '6512f0c2a1b2c3d4e5f60a02' })).toBeUndefined();
  });
});

describe('planRelease (§37.1)', () => {
  const reconciliation = (status: RentPaymentReconciliation['status']): RentPaymentReconciliation => ({
    id: 'r1' as RentPaymentReconciliationId,
    mreRealmId: 'realm',
    status,
    transactionId: 't1',
    mreTenantId: TENANT,
    mreRentTerm: '2027010100',
    matchedAmount: eur('800.00'),
    confidence: null,
    suggestionReason: null,
    confirmedAt: new Date('2027-01-05T10:00:00Z'),
    confirmedBy: 'anna@example.com',
    releasedAt: null,
    releasedBy: null,
    releaseReason: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectReason: null,
    notes: null,
    mreWriteBackState: 'NOT_WRITTEN',
    createdAt: new Date('2027-01-05T10:00:00Z'),
    version: 1,
  });
  const actor = { actorType: 'USER', actorId: 'ben@example.com' } as const;
  const at = new Date('2027-02-01T09:00:00Z');

  it('CONFIRMED → RELEASED with the reason, the actor and version + 1', () => {
    expect(planRelease(reconciliation('CONFIRMED'), 'Irrtum', at, actor)).toEqual({
      kind: 'RELEASE',
      next: { ...reconciliation('CONFIRMED'), status: 'RELEASED', releasedAt: at, releasedBy: 'ben@example.com', releaseReason: 'Irrtum', version: 2 },
    });
  });

  it('planConfirm (§37.3): keeps or lowers the suggested amount, never raises it; CONFIRMED with that amount a no-op', () => {
    const suggested = reconciliation('SUGGESTED');
    expect(planConfirm(suggested, undefined)).toEqual({ kind: 'CONFIRM', amount: eur('800.00') });
    expect(planConfirm(suggested, eur('700.00'))).toEqual({ kind: 'CONFIRM', amount: eur('700.00') });
    expect(planConfirm(suggested, eur('800.01'))).toEqual({ kind: 'ABOVE_SUGGESTION', suggested: eur('800.00') });
    expect(planConfirm(reconciliation('CONFIRMED'), undefined)).toEqual({ kind: 'UNCHANGED' });
    expect(planConfirm(reconciliation('CONFIRMED'), eur('800.00'))).toEqual({ kind: 'UNCHANGED' });
    expect(planConfirm(reconciliation('CONFIRMED'), eur('700.00'))).toEqual({ kind: 'NOT_CONFIRMABLE', status: 'CONFIRMED' });
    expect(planConfirm(reconciliation('REJECTED'), undefined)).toEqual({ kind: 'NOT_CONFIRMABLE', status: 'REJECTED' });
    expect(planConfirm(reconciliation('RELEASED'), undefined)).toEqual({ kind: 'NOT_CONFIRMABLE', status: 'RELEASED' });
  });

  it('staleBy: above the open amount now (due − the term\'s CONFIRMED) is stale; exactly it is not', () => {
    expect(staleBy(eur('800.00'), eur('800.00'), eur('0.00'))).toBeUndefined();
    expect(staleBy(eur('400.00'), eur('800.00'), eur('400.00'))).toBeUndefined();
    expect(staleBy(eur('400.01'), eur('800.00'), eur('400.00'))).toEqual({ openAmount: eur('400.00') });
    expect(staleBy(eur('1.00'), eur('800.00'), eur('900.00'))).toEqual({ openAmount: eur('-100.00') });
  });

  it('planReject: SUGGESTED → REJECTED with the reason; REJECTED a no-op; CONFIRMED and RELEASED not rejectable', () => {
    expect(planReject(reconciliation('SUGGESTED'), 'falscher Mieter', at, actor)).toEqual({
      kind: 'REJECT',
      next: { ...reconciliation('SUGGESTED'), status: 'REJECTED', rejectedAt: at, rejectedBy: 'ben@example.com', rejectReason: 'falscher Mieter', version: 2 },
    });
    expect(planReject(reconciliation('REJECTED'), 'x', at, actor)).toEqual({ kind: 'UNCHANGED' });
    expect(planReject(reconciliation('CONFIRMED'), 'x', at, actor)).toEqual({ kind: 'NOT_REJECTABLE', status: 'CONFIRMED' });
    expect(planReject(reconciliation('RELEASED'), 'x', at, actor)).toEqual({ kind: 'NOT_REJECTABLE', status: 'RELEASED' });
  });

  it('RELEASED is a no-op; SUGGESTED and REJECTED are not releasable', () => {
    expect(planRelease(reconciliation('RELEASED'), 'x', at, actor)).toEqual({ kind: 'UNCHANGED' });
    expect(planRelease(reconciliation('SUGGESTED'), 'x', at, actor)).toEqual({ kind: 'NOT_RELEASABLE', status: 'SUGGESTED' });
    expect(planRelease(reconciliation('REJECTED'), 'x', at, actor)).toEqual({ kind: 'NOT_RELEASABLE', status: 'REJECTED' });
  });
});

describe('coverageOf (§37.2, BR-RENT-006/007)', () => {
  it.each([
    ['0.00', '0.00', 'MATCHED', '0.00'],
    ['800.00', '0.00', 'UNMATCHED', '800.00'],
    ['800.00', '799.99', 'PARTIALLY_MATCHED', '0.01'],
    ['800.00', '0.01', 'PARTIALLY_MATCHED', '799.99'],
    ['800.00', '800.00', 'MATCHED', '0.00'],
    ['800.00', '800.01', 'OVERPAID', '-0.01'],
    ['0.00', '5.00', 'OVERPAID', '-5.00'],
  ])('due %s, matched %s → %s, open %s', (due, matched, coverage, open) => {
    const result = coverageOf(eur(due), eur(matched));
    expect(result.coverage).toBe(coverage);
    expect(result.openAmount.amount).toBe(open);
  });

  it('matchedTotalOf sums CONFIRMED only; none is 0.00', () => {
    const r = (status: RentPaymentReconciliation['status'], amount: string) => ({ status, matchedAmount: eur(amount) });
    expect(matchedTotalOf([r('CONFIRMED', '300.00'), r('RELEASED', '500.00'), r('CONFIRMED', '200.00'), r('SUGGESTED', '9.00')]).amount).toBe('500.00');
    expect(matchedTotalOf([]).amount).toBe('0.00');
  });
});
