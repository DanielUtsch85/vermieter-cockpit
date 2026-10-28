import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { checkMatch, isTermKey, planRelease, type MatchCash, type RentPaymentReconciliation, type RentPaymentReconciliationId } from './reconciliation.js';

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

  it('RELEASED is a no-op; SUGGESTED and REJECTED are not releasable', () => {
    expect(planRelease(reconciliation('RELEASED'), 'x', at, actor)).toEqual({ kind: 'UNCHANGED' });
    expect(planRelease(reconciliation('SUGGESTED'), 'x', at, actor)).toEqual({ kind: 'NOT_RELEASABLE', status: 'SUGGESTED' });
    expect(planRelease(reconciliation('REJECTED'), 'x', at, actor)).toEqual({ kind: 'NOT_RELEASABLE', status: 'REJECTED' });
  });
});
