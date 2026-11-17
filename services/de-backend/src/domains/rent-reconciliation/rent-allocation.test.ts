import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { availableOf, isCounted, matchedTotalOf, rentAllocationOf, type RentPaymentReconciliation } from './reconciliation.js';

/** §30.1A: the list's `rentAllocation`, from §37.2's `rentCash`, `matchedTotal` and `available`. */

const eur = (amount: string) => Money.of(amount, 'EUR');
const allocatable = { counted: true, direction: 'INFLOW', rentCash: eur('850.00') };
const stateAt = (matched: string) => rentAllocationOf({ ...allocatable, matchedTotal: eur(matched) })?.state;

describe('rentAllocationOf (api-design.md §30.1A)', () => {
  it('NONE at 0, PARTIAL from one cent to rent cash − one cent, FULL at rent cash', () => {
    expect(stateAt('0.00')).toBe('NONE');
    expect(stateAt('0.01')).toBe('PARTIAL');
    expect(stateAt('849.99')).toBe('PARTIAL');
    expect(stateAt('850.00')).toBe('FULL');
  });

  it('carries the three amounts: rentAmount = rentCash, allocatedAmount = matchedTotal, freeAmount = rent cash − allocated', () => {
    const allocation = rentAllocationOf({ ...allocatable, matchedTotal: eur('600.00') });
    expect(allocation).toEqual({ state: 'PARTIAL', rentAmount: eur('850.00'), allocatedAmount: eur('600.00'), freeAmount: eur('250.00') });
    expect(rentAllocationOf({ ...allocatable, matchedTotal: eur('850.00') })?.freeAmount).toEqual(eur('0.00'));
  });

  it('null for each reason: not counted, OUTFLOW, no rent split, a rent share of 0.00', () => {
    expect(rentAllocationOf({ ...allocatable, counted: false, matchedTotal: eur('0.00') })).toBeNull();
    expect(rentAllocationOf({ ...allocatable, direction: 'OUTFLOW', matchedTotal: eur('0.00') })).toBeNull();
    expect(rentAllocationOf({ ...allocatable, rentCash: null, matchedTotal: eur('0.00') })).toBeNull();
    expect(rentAllocationOf({ ...allocatable, rentCash: eur('0.00'), matchedTotal: eur('0.00') })).toBeNull();
  });

  it('counted (§37.1): CONFIRMED or RECONCILED, never a reversal; UNREVIEWED, IMPORTED, IGNORED and CORRECTED are not', () => {
    expect(isCounted('CONFIRMED', null)).toBe(true);
    expect(isCounted('RECONCILED', null)).toBe(true);
    expect(isCounted('CONFIRMED', 'REPLACEMENT')).toBe(true);
    expect(isCounted('CONFIRMED', 'REVERSAL')).toBe(false);
    for (const status of ['UNREVIEWED', 'IMPORTED', 'IGNORED', 'CORRECTED']) expect(isCounted(status, null), status).toBe(false);
    expect(isCounted('CORRECTED', 'ORIGINAL')).toBe(false);
  });

  it('freeAmount equals availableOf, and allocatedAmount matchedTotalOf, for the same reconciliations (RELEASED, SUGGESTED, REJECTED not summed)', () => {
    const r = (status: RentPaymentReconciliation['status'], amount: string) => ({ status, matchedAmount: eur(amount) });
    const reconciliations = [r('CONFIRMED', '300.00'), r('CONFIRMED', '200.00'), r('RELEASED', '100.00'), r('SUGGESTED', '50.00'), r('REJECTED', '20.00')];
    const matchedTotal = matchedTotalOf(reconciliations);
    const allocation = rentAllocationOf({ ...allocatable, matchedTotal });
    const confirmed = reconciliations
      .filter((c) => c.status === 'CONFIRMED')
      .map((c, i) => ({ id: `r${i}`, mreTenantId: '6512f0c2a1b2c3d4e5f60a01', mreRentTerm: `20270${i + 1}0100`, matchedAmount: c.matchedAmount }));
    const available = availableOf({ status: 'CONFIRMED', direction: 'INFLOW', correctionRole: null, rentCash: eur('850.00'), confirmed });
    expect(allocation?.allocatedAmount).toEqual(eur('500.00'));
    expect(allocation?.freeAmount).toEqual(available);
    expect(available).toEqual(eur('350.00'));
  });
});
