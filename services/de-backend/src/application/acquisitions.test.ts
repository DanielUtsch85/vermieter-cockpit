import { describe, expect, it } from 'vitest';
import { createFingerprint, type Acquisition, type AcquisitionRepository } from '../domains/acquisition/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import {
  AcquisitionConfirmedError,
  AcquisitionHasValidOwnershipsError,
  ConfirmationBlockedError,
  cancelAcquisition,
  confirmAcquisition,
  createAcquisition,
  getAcquisition,
  listPropertyAcquisitions,
} from './acquisitions.js';
import { AcquisitionCancelledError } from './acquisition-costs.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { AcquisitionNotFoundError, OwnerInactiveError } from './ownerships.js';
import { PartyNotFoundError } from './parties.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';

/** VC-2-05 use cases (api-design.md §27.1): Realm, actor, fingerprint, and each refusal as its error. */
const REALM = '64b0c0ffee0000000000000a';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const fields = {
  propertyReferenceId: 'pr',
  purchasePrice: Money.of('1000.00', 'EUR'),
  acquiredShare: { numerator: 1, denominator: 1 },
  contractDate: '2026-06-15' as BusinessDate,
  economicTransferDate: null,
  landRegistryTransferDate: null,
  buyerPartyIds: ['b'],
  sellerPartyIds: [],
  sourceReferences: [],
  notes: null,
};
const acquisition = { id: 'a1' } as Acquisition;
const repository = (overrides: Partial<AcquisitionRepository>): AcquisitionRepository => ({
  create: () => Promise.reject(new Error('unused')),
  findById: async () => undefined,
  list: async () => ({ items: [], page: 1, pageSize: 50, total: 0 }),
  cancel: () => Promise.reject(new Error('unused')),
  confirm: () => Promise.reject(new Error('unused')),
  ...overrides,
});

describe('Acquisition use cases', () => {
  it('create: in the caller Realm with the fingerprint; each refusal as its error', async () => {
    const calls: unknown[][] = [];
    const create = createAcquisition({
      repository: repository({
        create: async (...args) => {
          calls.push(args);
          return { kind: 'CREATED', acquisition };
        },
      }),
    });
    expect(await create({ principal, ...fields, idempotencyKey: 'k' })).toEqual({ acquisition, replayed: false });
    const expected = { mreRealmId: REALM, ...fields };
    expect(calls).toEqual([[expected, { actorType: 'USER', actorId: 'anna@example.com' }, { key: 'k', fingerprint: createFingerprint(expected) }]]);
    const refused = (outcome: Awaited<ReturnType<AcquisitionRepository['create']>>) =>
      createAcquisition({ repository: repository({ create: async () => outcome }) })({ principal, ...fields });
    expect(await refused({ kind: 'REPLAYED', acquisition })).toEqual({ acquisition, replayed: true });
    await expect(refused({ kind: 'IDEMPOTENCY_CONFLICT' })).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(refused({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' })).rejects.toBeInstanceOf(PropertyReferenceNotFoundError);
    await expect(refused({ kind: 'PARTY_NOT_FOUND', partyId: 'p' })).rejects.toBeInstanceOf(PartyNotFoundError);
    await expect(refused({ kind: 'PARTY_INACTIVE', partyId: 'p' })).rejects.toBeInstanceOf(OwnerInactiveError);
  });

  it('get, cancel and the PropertyReference list turn their refusals into errors', async () => {
    await expect(getAcquisition({ repository: repository({}) })({ principal, acquisitionId: 'a' })).rejects.toBeInstanceOf(AcquisitionNotFoundError);
    const cancel = (outcome: Awaited<ReturnType<AcquisitionRepository['cancel']>>) =>
      cancelAcquisition({ repository: repository({ cancel: async () => outcome }) })({ principal, acquisitionId: 'a', reason: 'x' });
    await expect(cancel({ kind: 'NOT_FOUND' })).rejects.toBeInstanceOf(AcquisitionNotFoundError);
    await expect(cancel({ kind: 'ACQUISITION_CONFIRMED' })).rejects.toBeInstanceOf(AcquisitionConfirmedError);
    await expect(cancel({ kind: 'ACQUISITION_HAS_VALID_OWNERSHIPS', ownershipIds: ['o1'] })).rejects.toMatchObject(
      new AcquisitionHasValidOwnershipsError('a', ['o1']),
    );
    await expect(cancel({ kind: 'VERSION_CONFLICT', expectedVersions: [1], currentVersion: 2 })).rejects.toBeInstanceOf(VersionConflictError);
    const list = listPropertyAcquisitions({ repository: repository({}), propertyReferences: { findById: async () => undefined } });
    await expect(list({ principal, propertyReferenceId: 'pr', filter: {}, page: { page: 1, pageSize: 50 } })).rejects.toBeInstanceOf(PropertyReferenceNotFoundError);
  });
});

describe('confirmAcquisition', () => {
  it('passes the Realm, actor and If-Match; maps each refusal', async () => {
    const calls: unknown[] = [];
    const outcomes = [
      { kind: 'CONFIRMED', acquisition, changed: true, ownershipIds: ['o'] },
      { kind: 'NOT_FOUND' },
      { kind: 'ACQUISITION_CANCELLED' },
      { kind: 'CONFIRMATION_BLOCKED', violations: [{ code: 'BUYER_WITHOUT_OWNERSHIP', partyId: 'b' }] },
      { kind: 'VERSION_CONFLICT', expectedVersions: [1], currentVersion: 2 },
    ] as const;
    let i = 0;
    const at = new Date('2026-10-26T10:00:00Z');
    const confirm = confirmAcquisition({
      repository: repository({
        confirm: async (...args) => {
          calls.push(args);
          return outcomes[i++] ?? { kind: 'NOT_FOUND' };
        },
      }),
      now: () => at,
    });
    expect(await confirm({ principal, acquisitionId: 'a1', expectedVersions: [1] })).toEqual({ acquisition, changed: true });
    expect(calls[0]).toEqual(['a1', REALM, at, { actorType: 'USER', actorId: 'anna@example.com' }, [1]]);
    await expect(confirm({ principal, acquisitionId: 'a1' })).rejects.toBeInstanceOf(AcquisitionNotFoundError);
    await expect(confirm({ principal, acquisitionId: 'a1' })).rejects.toBeInstanceOf(AcquisitionCancelledError);
    await expect(confirm({ principal, acquisitionId: 'a1' })).rejects.toEqual(new ConfirmationBlockedError('a1', [{ code: 'BUYER_WITHOUT_OWNERSHIP', partyId: 'b' }]));
    await expect(confirm({ principal, acquisitionId: 'a1' })).rejects.toBeInstanceOf(VersionConflictError);
  });
});
