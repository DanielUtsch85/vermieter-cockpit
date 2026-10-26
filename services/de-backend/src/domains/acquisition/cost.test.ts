import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { checkLink, costFingerprint, isCurrentTransaction, notCountingReason, paymentStatusOf, planUnlink, planVoidCost, type LinkContext } from './cost.js';

/** VC-2-06 domain rules (api-design.md §27.2, phase-2-plan P2-D7). */
const eur = (amount: string) => Money.of(amount, 'EUR');
const context = (overrides: Partial<LinkContext> = {}): LinkContext => ({
  acquisitionStatus: 'DRAFT',
  transaction: { amount: eur('100.00'), status: 'CONFIRMED', direction: 'OUTFLOW', correctionRole: null },
  linkedOnTransaction: eur('0.00'),
  expected: eur('80.00'),
  paid: eur('0.00'),
  ...overrides,
});

describe('the derived paid state', () => {
  it('EXPECTED without, PARTIALLY_PAID below, PAID at the amount', () => {
    expect(paymentStatusOf(eur('10.00'), eur('0.00'))).toBe('EXPECTED');
    expect(paymentStatusOf(eur('10.00'), eur('9.99'))).toBe('PARTIALLY_PAID');
    expect(paymentStatusOf(eur('10.00'), eur('10.00'))).toBe('PAID');
  });

  it('a Transaction is current when CONFIRMED or RECONCILED and not a reversal (§35.3)', () => {
    expect(isCurrentTransaction('CONFIRMED', null)).toBe(true);
    expect(isCurrentTransaction('RECONCILED', 'REPLACEMENT')).toBe(true);
    expect(isCurrentTransaction('CONFIRMED', 'REVERSAL')).toBe(false);
    expect(isCurrentTransaction('CORRECTED', null)).toBe(false);
    expect(isCurrentTransaction('CLASSIFIED', null)).toBe(false);
  });

  it('names the first reason a payment counts nowhere: unlinked, then cancelled, then corrected', () => {
    expect(notCountingReason({ unlinked: true, acquisitionStatus: 'CANCELLED', transactionCurrent: false })).toBe('UNLINKED');
    expect(notCountingReason({ unlinked: false, acquisitionStatus: 'CANCELLED', transactionCurrent: false })).toBe('ACQUISITION_CANCELLED');
    expect(notCountingReason({ unlinked: false, acquisitionStatus: 'CONFIRMED', transactionCurrent: false })).toBe('TRANSACTION_CORRECTED');
    expect(notCountingReason({ unlinked: false, acquisitionStatus: 'CONFIRMED', transactionCurrent: true })).toBeNull();
  });
});

describe('checkLink', () => {
  it('accepts a link up to both caps exactly', () => {
    expect(checkLink(eur('80.00'), context())).toBeUndefined();
    expect(checkLink(eur('20.00'), context({ linkedOnTransaction: eur('80.00'), paid: eur('60.00') }))).toBeUndefined();
  });

  it('refuses in the order of §27.2', () => {
    const corrected = { amount: eur('100.00'), status: 'CORRECTED', direction: 'INFLOW', correctionRole: null };
    expect(checkLink(eur('1.00'), context({ acquisitionStatus: 'CANCELLED', costStatus: 'VOID', transaction: corrected }))).toEqual({ kind: 'ACQUISITION_CANCELLED' });
    expect(checkLink(eur('1.00'), context({ costStatus: 'VOID', transaction: corrected }))).toEqual({ kind: 'COST_VOID' });
    expect(checkLink(eur('1.00'), context({ transaction: corrected }))).toEqual({ kind: 'TRANSACTION_NOT_CURRENT', status: 'CORRECTED', correctionRole: null });
    expect(checkLink(eur('1.00'), context({ transaction: { ...corrected, status: 'CONFIRMED', correctionRole: 'REVERSAL' } }))).toMatchObject({
      kind: 'TRANSACTION_NOT_CURRENT',
      correctionRole: 'REVERSAL',
    });
    expect(checkLink(eur('1.00'), context({ transaction: { ...corrected, status: 'CONFIRMED' } }))).toEqual({ kind: 'NOT_OUTFLOW' });
  });

  it('per Transaction over the live payments, then per cost or price over the counting ones', () => {
    const transaction = checkLink(eur('20.01'), context({ linkedOnTransaction: eur('80.00') }));
    expect(transaction?.kind).toBe('PAYMENT_EXCEEDS_TRANSACTION');
    if (transaction?.kind === 'PAYMENT_EXCEEDS_TRANSACTION') expect(transaction.available.amount).toBe('20.00');
    const cost = checkLink(eur('30.01'), context({ costStatus: 'ACTIVE', paid: eur('50.00') }));
    expect(cost?.kind).toBe('PAYMENT_EXCEEDS_COST');
    if (cost?.kind === 'PAYMENT_EXCEEDS_COST') expect([cost.expected.amount, cost.paid.amount, cost.remaining.amount]).toEqual(['80.00', '50.00', '30.00']);
    expect(checkLink(eur('80.01'), context())?.kind).toBe('PAYMENT_EXCEEDS_PRICE');
  });
});

describe('void and unlink', () => {
  it('void: CANCELLED first, a VOID cost is a no-op, linked payments refuse it (sorted ids)', () => {
    expect(planVoidCost({ status: 'VOID' }, 'CANCELLED', [])).toEqual({ kind: 'ACQUISITION_CANCELLED' });
    expect(planVoidCost({ status: 'VOID' }, 'DRAFT', ['p'])).toEqual({ kind: 'UNCHANGED' });
    expect(planVoidCost({ status: 'ACTIVE' }, 'CONFIRMED', ['p2', 'p1'])).toEqual({ kind: 'COST_HAS_PAYMENTS', paymentIds: ['p1', 'p2'] });
    expect(planVoidCost({ status: 'ACTIVE' }, 'CONFIRMED', [])).toEqual({ kind: 'VOID' });
  });

  it('unlink: CANCELLED first, an unlinked payment is a no-op', () => {
    expect(planUnlink({ unlinkedAt: new Date() }, 'CANCELLED')).toEqual({ kind: 'ACQUISITION_CANCELLED' });
    expect(planUnlink({ unlinkedAt: new Date() }, 'DRAFT')).toEqual({ kind: 'UNCHANGED' });
    expect(planUnlink({ unlinkedAt: null }, 'CONFIRMED')).toEqual({ kind: 'UNLINK' });
  });

  it('the cost fingerprint includes the Acquisition, so one key never creates a cost on two Acquisitions', () => {
    const cost = { mreRealmId: 'r', category: 'NOTARY', amount: eur('1.00'), incurredDate: null, counterpartyPartyId: null, sourceReferences: [], notes: null } as const;
    expect(costFingerprint({ ...cost, acquisitionId: 'a' })).not.toBe(costFingerprint({ ...cost, acquisitionId: 'b' }));
  });
});
