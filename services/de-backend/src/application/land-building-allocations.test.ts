import { describe, expect, it } from 'vitest';
import { allocationFingerprint, type LandBuildingAllocation, type LandBuildingAllocationRepository } from '../domains/acquisition/index.js';
import { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { AcquisitionCancelledError } from './acquisition-costs.js';
import { IdempotencyKeyConflictError } from './errors.js';
import { CurrentAllocationChangedError, createLandBuildingAllocation, listLandBuildingAllocations } from './land-building-allocations.js';
import { AcquisitionNotFoundError } from './ownerships.js';
import { PartyNotFoundError } from './parties.js';

/** VC-2-08 use cases (api-design.md §27.3): Realm, actor, fingerprint, and each refusal as its error. */
const REALM = '64b0c0ffee0000000000000a';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const eur = (amount: string) => Money.of(amount, 'EUR');
const fields = {
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
} as const;
const allocation = { id: 'l1' } as LandBuildingAllocation;

describe('createLandBuildingAllocation', () => {
  it('passes the Realm, actor and fingerprint; maps each refusal', async () => {
    const calls: unknown[] = [];
    const outcomes = [
      { kind: 'CREATED', allocation },
      { kind: 'IDEMPOTENCY_CONFLICT' },
      { kind: 'ACQUISITION_NOT_FOUND' },
      { kind: 'PARTY_NOT_FOUND', partyId: 'p' },
      { kind: 'ACQUISITION_CANCELLED' },
      { kind: 'CURRENT_ALLOCATION_CHANGED', currentAllocationId: 'l0' },
    ] as const;
    let i = 0;
    const repository: LandBuildingAllocationRepository = {
      create: async (...args) => {
        calls.push(args);
        return outcomes[i++] ?? { kind: 'ACQUISITION_NOT_FOUND' };
      },
      list: async () => undefined,
    };
    const create = createLandBuildingAllocation({ repository });
    const input = { principal, acquisitionId: 'a', ...fields };
    expect(await create({ ...input, idempotencyKey: 'k' })).toEqual({ allocation, replayed: false });
    const expected = { mreRealmId: REALM, acquisitionId: 'a', ...fields };
    expect(calls[0]).toEqual([expected, { actorType: 'USER', actorId: 'anna@example.com' }, { key: 'k', fingerprint: allocationFingerprint(expected) }]);
    await expect(create(input)).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(create(input)).rejects.toBeInstanceOf(AcquisitionNotFoundError);
    await expect(create(input)).rejects.toEqual(new PartyNotFoundError('p'));
    await expect(create(input)).rejects.toBeInstanceOf(AcquisitionCancelledError);
    await expect(create(input)).rejects.toEqual(new CurrentAllocationChangedError('l0'));
  });

  it('list: an unknown Acquisition is 404, not an empty history', async () => {
    const repository: LandBuildingAllocationRepository = { create: () => Promise.reject(new Error('unused')), list: async () => undefined };
    await expect(listLandBuildingAllocations({ repository })({ principal, acquisitionId: 'a' })).rejects.toBeInstanceOf(AcquisitionNotFoundError);
  });
});
