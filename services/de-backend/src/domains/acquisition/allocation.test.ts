import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { allocationFingerprint, checkAdvisorReasonOnly, checkAllocation, shareOf, type LandBuildingAllocation, type NewAllocation } from './allocation.js';

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

  describe('checkAdvisorReasonOnly (§58T rule 3, decided 2026-11-06)', () => {
    const comparison = {
      method: 'BMF_TOOL',
      landValue: eur('120000.00'),
      buildingValue: eur('280000.00'),
      sourceReferences: ['Arbeitshilfe (synthetisch)'],
    } as const;
    const superseded = {
      id: 'e1',
      totalAllocableAmount: eur('400000.00'),
      landAmount: eur('40000.00'),
      buildingAmount: eur('360000.00'),
      method: 'PURCHASE_CONTRACT',
      reviewState: 'ADVISOR_CONFIRMED',
      effectiveDate: '2026-07-01' as BusinessDate,
      advisorPartyId: 'p1',
      sourceReferences: ['Kaufvertrag (synthetisch)'],
      notes: null,
      comparison,
      deviationReason: null,
    } as unknown as LandBuildingAllocation;
    const next = {
      totalAllocableAmount: eur('400000.00'),
      landAmount: eur('40000.00'),
      buildingAmount: eur('360000.00'),
      method: 'PURCHASE_CONTRACT',
      reviewState: 'ADVISOR_CONFIRMED',
      effectiveDate: '2026-07-01' as BusinessDate,
      advisorPartyId: 'p1',
      sourceReferences: ['Kaufvertrag (synthetisch)'],
      notes: null,
      supersedes: 'e1',
      comparison,
      deviationReason: 'Altlasten (synthetisch)',
    } as const;
    const refused = { kind: 'REVIEW_STATE_NOT_ALLOWED', supersededAllocationId: 'e1' };

    it('the narrow case is refused; advisorPartyId, sourceReferences and notes do not count as a change', () => {
      expect(checkAdvisorReasonOnly(superseded, next)).toEqual(refused);
      expect(checkAdvisorReasonOnly(superseded, { ...next, advisorPartyId: 'p2' })).toEqual(refused);
      expect(checkAdvisorReasonOnly(superseded, { ...next, advisorPartyId: null })).toEqual(refused);
      expect(checkAdvisorReasonOnly(superseded, { ...next, sourceReferences: ['anders (synthetisch)'] })).toEqual(refused);
      expect(checkAdvisorReasonOnly(superseded, { ...next, notes: 'Notiz (synthetisch)' })).toEqual(refused);
      // Another reason over a row that already carries one is still a reason-only change.
      expect(checkAdvisorReasonOnly({ ...superseded, deviationReason: 'alt (synthetisch)' }, next)).toEqual(refused);
    });

    it.each([
      ['totalAllocableAmount and buildingAmount', { totalAllocableAmount: eur('400000.01'), buildingAmount: eur('360000.01') }],
      ['landAmount and buildingAmount', { landAmount: eur('40000.01'), buildingAmount: eur('359999.99') }],
      ['method', { method: 'ADVISOR' }],
      ['effectiveDate', { effectiveDate: '2026-07-02' as BusinessDate }],
      ['comparison.method', { comparison: { ...comparison, method: 'APPRAISAL' } }],
      ['comparison.landValue', { comparison: { ...comparison, landValue: eur('120000.01') } }],
      ['comparison.buildingValue', { comparison: { ...comparison, buildingValue: eur('279999.99') } }],
      ['comparison.sourceReferences', { comparison: { ...comparison, sourceReferences: ['Gutachten (synthetisch)'] } }],
      ['comparison removed', { comparison: null }],
    ] as const)('a changed %s is a genuine re-confirmation: not refused', (_field, change) => {
      expect(checkAdvisorReasonOnly(superseded, { ...next, ...change })).toBeUndefined();
    });

    it('not refused: CONFIRMED sent, a CONFIRMED row superseded, no reason sent, the same reason repeated', () => {
      expect(checkAdvisorReasonOnly(superseded, { ...next, reviewState: 'CONFIRMED' })).toBeUndefined();
      expect(checkAdvisorReasonOnly({ ...superseded, reviewState: 'CONFIRMED' }, next)).toBeUndefined();
      expect(checkAdvisorReasonOnly(superseded, { ...next, deviationReason: null })).toBeUndefined();
      expect(checkAdvisorReasonOnly({ ...superseded, deviationReason: next.deviationReason }, next)).toBeUndefined();
      // Counter-check: the same pair with only the superseded row's state set back is refused again.
      expect(checkAdvisorReasonOnly({ ...superseded, reviewState: 'ADVISOR_CONFIRMED' }, next)).toEqual(refused);
    });
  });
});
