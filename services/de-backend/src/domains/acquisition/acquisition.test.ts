import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { createFingerprint, planCancel, transferDate, type Acquisition, type AcquisitionId, type NewAcquisition } from './acquisition.js';

/** VC-2-05 domain rules (api-design.md §27.1, phase-2-plan P2-D6). */
const day = (value: string) => value as BusinessDate;
const data: NewAcquisition = {
  mreRealmId: 'r',
  propertyReferenceId: 'pr',
  purchasePrice: Money.of('350000.00', 'EUR'),
  acquiredShare: { numerator: 1, denominator: 1 },
  contractDate: day('2026-06-15'),
  economicTransferDate: null,
  landRegistryTransferDate: null,
  buyerPartyIds: ['b'],
  sellerPartyIds: [],
  sourceReferences: [],
  notes: null,
};
const acquisition: Acquisition = {
  ...data,
  id: 'a1' as AcquisitionId,
  status: 'DRAFT',
  cancelledAt: null,
  cancellationReason: null,
  confirmedAt: null,
  createdAt: new Date('2026-10-25T08:00:00Z'),
  version: 1,
};

describe('Acquisition', () => {
  it('the transfer date is the economic transfer, or the contract while that is unset (P2-D6)', () => {
    expect(transferDate(data)).toBe('2026-06-15');
    expect(transferDate({ ...data, economicTransferDate: day('2026-08-01') })).toBe('2026-08-01');
  });

  it('cancel: a draft without VALID Ownerships; a repeat is UNCHANGED; confirmed is final; carried by Ownerships is refused', () => {
    const at = new Date('2026-10-25T10:00:00Z');
    expect(planCancel(acquisition, 'geplatzt', at, [])).toEqual({
      kind: 'CANCEL',
      next: { ...acquisition, status: 'CANCELLED', cancelledAt: at, cancellationReason: 'geplatzt', version: 2 },
    });
    expect(planCancel({ ...acquisition, status: 'CANCELLED' }, 'anders', at, ['o1'])).toEqual({ kind: 'UNCHANGED' });
    expect(planCancel({ ...acquisition, status: 'CONFIRMED' }, 'x', at, [])).toEqual({ kind: 'ACQUISITION_CONFIRMED' });
    expect(planCancel(acquisition, 'x', at, ['o2', 'o1'])).toEqual({ kind: 'ACQUISITION_HAS_VALID_OWNERSHIPS', ownershipIds: ['o1', 'o2'] });
  });

  it('the fingerprint is the normalized payload, the party order included', () => {
    expect(createFingerprint(data)).toBe(createFingerprint({ ...data }));
    expect(createFingerprint(data)).not.toBe(createFingerprint({ ...data, purchasePrice: Money.of('350000.01', 'EUR') }));
    expect(createFingerprint({ ...data, buyerPartyIds: ['a', 'b'] })).not.toBe(createFingerprint({ ...data, buyerPartyIds: ['b', 'a'] }));
  });
});
