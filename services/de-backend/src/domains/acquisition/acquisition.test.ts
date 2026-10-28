import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { createFingerprint, planCancel, planConfirm, sumOf, transferDate, type Acquisition, type AcquisitionId, type NewAcquisition } from './acquisition.js';

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

describe('planConfirm (§28.1)', () => {
  const at = new Date('2026-10-26T10:00:00Z');
  const draft: Acquisition = {
    ...acquisition,
    economicTransferDate: day('2026-08-01'),
    buyerPartyIds: ['b2', 'b1'],
    acquiredShare: { numerator: 1, denominator: 2 },
  };
  const own = (id: string, owner: string, n: number, d: number, from = '2026-08-01') => ({
    id,
    ownerPartyId: owner,
    share: { numerator: n, denominator: d },
    validFrom: day(from),
  });
  const active = new Map([
    ['b1', 'ACTIVE'],
    ['b2', 'ACTIVE'],
  ]);

  it('confirms when the buyers hold exactly the acquired share from the transfer date and the day is complete', () => {
    const mine = [own('o1', 'b1', 1, 4), own('o2', 'b2', 1, 4)];
    expect(planConfirm(draft, { buyerStatuses: active, own: mine, onTransferDate: [...mine, own('o3', 'k', 1, 2, '2020-01-01')] }, at)).toEqual({
      kind: 'CONFIRM',
      next: { ...draft, status: 'CONFIRMED', confirmedAt: at, version: 2 },
    });
  });

  it('status first: CONFIRMED is a no-op, CANCELLED is refused, whatever the requirements', () => {
    const none = { buyerStatuses: new Map(), own: [], onTransferDate: [] };
    expect(planConfirm({ ...draft, status: 'CONFIRMED' }, none, at)).toEqual({ kind: 'UNCHANGED' });
    expect(planConfirm({ ...draft, status: 'CANCELLED' }, none, at)).toEqual({ kind: 'ACQUISITION_CANCELLED' });
  });

  it('reports all six requirements in their order, ids sorted within each', () => {
    const plan = planConfirm(
      draft,
      {
        buyerStatuses: new Map([
          ['b1', 'INACTIVE'],
          ['b2', 'INACTIVE'],
        ]),
        own: [own('o2', 'x', 1, 8), own('o1', 'b1', 1, 4, '2026-08-02')],
        onTransferDate: [own('o2', 'x', 1, 8)],
      },
      at,
    );
    expect(plan).toEqual({
      kind: 'CONFIRMATION_BLOCKED',
      violations: [
        { code: 'BUYER_INACTIVE', partyId: 'b1' },
        { code: 'BUYER_INACTIVE', partyId: 'b2' },
        { code: 'OWNERSHIP_NOT_FROM_TRANSFER_DATE', ownershipId: 'o1', validFrom: '2026-08-02', transferDate: '2026-08-01' },
        { code: 'OWNER_NOT_A_BUYER', ownershipId: 'o2', ownerPartyId: 'x' },
        { code: 'BUYER_WITHOUT_OWNERSHIP', partyId: 'b2' },
        { code: 'SHARE_SUM_MISMATCH', expected: { numerator: 1n, denominator: 2n }, actual: { numerator: 3n, denominator: 8n } },
        { code: 'OWNERSHIP_INCOMPLETE', date: '2026-08-01', shareSum: { numerator: 1n, denominator: 8n } },
      ],
    });
  });

  it('sums exactly and reduced, beyond what a double holds', () => {
    expect(
      sumOf([
        { numerator: 1, denominator: 3 },
        { numerator: 1, denominator: 6 },
      ]),
    ).toEqual({ numerator: 1n, denominator: 2n });
    expect(sumOf([])).toEqual({ numerator: 0n, denominator: 1n });
    const sevenths = Array.from({ length: 7 }, () => ({ numerator: 1, denominator: 7 }));
    expect(sumOf(sevenths)).toEqual({ numerator: 1n, denominator: 1n });
  });
});
