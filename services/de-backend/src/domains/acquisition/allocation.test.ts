import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { allocationFingerprint, checkAllocation, shareOf, type NewAllocation } from './allocation.js';

/** VC-2-08 domain rules (api-design.md §27.3, phase-2-plan P2-D9). */
const eur = (amount: string) => Money.of(amount, 'EUR');

describe('land/building allocation', () => {
  it('shares are display values: half-even to four places, they need not add to exactly one', () => {
    expect(shareOf(eur('66100.00'), eur('330500.00'))).toBe('0.2000');
    expect(shareOf(eur('1.00'), eur('3.00'))).toBe('0.3333');
    expect(shareOf(eur('2.00'), eur('3.00'))).toBe('0.6667');
    expect(shareOf(eur('0.00'), eur('10.00'))).toBe('0.0000');
    // Half-even: 0.00005 rounds to the even 0.0000, 0.00015 to 0.0002.
    expect(shareOf(eur('0.01'), eur('200.00'))).toBe('0.0000');
    expect(shareOf(eur('0.03'), eur('200.00'))).toBe('0.0002');
  });

  it('checkAllocation: CANCELLED first, then supersedes must name the current one (null for none)', () => {
    expect(checkAllocation('CANCELLED', 'x', 'y')).toEqual({ kind: 'ACQUISITION_CANCELLED' });
    expect(checkAllocation('DRAFT', null, null)).toBeUndefined();
    expect(checkAllocation('CONFIRMED', 'a1', 'a1')).toBeUndefined();
    expect(checkAllocation('DRAFT', 'a1', null)).toEqual({ kind: 'CURRENT_ALLOCATION_CHANGED', currentAllocationId: 'a1' });
    expect(checkAllocation('DRAFT', null, 'a0')).toEqual({ kind: 'CURRENT_ALLOCATION_CHANGED', currentAllocationId: null });
  });

  it('the fingerprint covers the Acquisition and supersedes', () => {
    const base: NewAllocation = {
      mreRealmId: 'r',
      acquisitionId: 'a',
      totalAllocableAmount: eur('10.00'),
      landAmount: eur('2.00'),
      buildingAmount: eur('8.00'),
      method: 'OTHER',
      reviewState: 'UNREVIEWED',
      effectiveDate: null,
      advisorPartyId: null,
      sourceReferences: [],
      notes: null,
      supersedes: null,
    };
    expect(allocationFingerprint(base)).not.toBe(allocationFingerprint({ ...base, acquisitionId: 'b' }));
    expect(allocationFingerprint(base)).not.toBe(allocationFingerprint({ ...base, supersedes: 'x' }));
  });
});
