import { describe, expect, it } from 'vitest';
import { changeFingerprint, createFingerprint, type ChangeResult, type Ownership, type OwnershipChangeRepository, type OwnershipRepository } from '../domains/ownership/index.js';
import type { BusinessDate } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import {
  InvalidOwnershipError,
  OverlappingOwnershipError,
  OwnerInactiveError,
  OwnershipIncompleteError,
  OwnershipNotFoundError,
  OwnershipTotalExceedsOneError,
  changeOwnership,
  closeOwnership,
  createOwnership,
  getOwnership,
  readPropertyOwnerships,
  voidOwnership,
} from './ownerships.js';
import { PartyNotFoundError } from './parties.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';

/** VC-2-03 use cases (api-design.md §26.1): Realm, actor, fingerprint, and each refusal as its error. */
const REALM = '64b0c0ffee0000000000000a';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const day = (value: string) => value as BusinessDate;
const fields = {
  propertyReferenceId: 'pr',
  ownerPartyId: 'p',
  share: { numerator: 1, denominator: 2 },
  validFrom: day('2026-08-01'),
  validUntil: null,
  acquisitionId: null,
  sourceReferences: [],
  notes: null,
};
const ownership = { id: 'o1' } as Ownership;

const repository = (overrides: Partial<OwnershipRepository>): OwnershipRepository => ({
  create: () => Promise.reject(new Error('unused')),
  findById: async () => undefined,
  close: () => Promise.reject(new Error('unused')),
  void: () => Promise.reject(new Error('unused')),
  on: async () => undefined,
  history: async () => undefined,
  ...overrides,
});

describe('Ownership use cases', () => {
  it('create: in the caller Realm with the fingerprint of the normalized payload; each refusal as its error', async () => {
    const calls: unknown[][] = [];
    const create = createOwnership({
      repository: repository({
        create: async (...args) => {
          calls.push(args);
          return { kind: 'CREATED', ownership };
        },
      }),
    });
    expect(await create({ principal, ...fields, idempotencyKey: 'k' })).toEqual({ ownership, replayed: false });
    const expected = { mreRealmId: REALM, ...fields };
    expect(calls).toEqual([[expected, { actorType: 'USER', actorId: 'anna@example.com' }, { key: 'k', fingerprint: createFingerprint(expected) }]]);

    const refused = (outcome: Awaited<ReturnType<OwnershipRepository['create']>>) =>
      createOwnership({ repository: repository({ create: async () => outcome }) })({ principal, ...fields });
    expect(await refused({ kind: 'REPLAYED', ownership })).toEqual({ ownership, replayed: true });
    await expect(refused({ kind: 'IDEMPOTENCY_CONFLICT' })).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(refused({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' })).rejects.toBeInstanceOf(PropertyReferenceNotFoundError);
    await expect(refused({ kind: 'PARTY_NOT_FOUND' })).rejects.toBeInstanceOf(PartyNotFoundError);
    await expect(refused({ kind: 'PARTY_INACTIVE' })).rejects.toBeInstanceOf(OwnerInactiveError);
    await expect(refused({ kind: 'OVERLAPPING_OWNERSHIP', ownershipId: 'o0' as Ownership['id'] })).rejects.toMatchObject(new OverlappingOwnershipError('o0'));
    await expect(
      refused({ kind: 'OWNERSHIP_TOTAL_EXCEEDS_ONE', date: day('2027-01-01'), shareSum: { numerator: 3n, denominator: 2n } }),
    ).rejects.toBeInstanceOf(OwnershipTotalExceedsOneError);
  });

  it('get, close, void and the reads turn their refusals into errors', async () => {
    await expect(getOwnership({ repository: repository({}) })({ principal, ownershipId: 'o' })).rejects.toBeInstanceOf(OwnershipNotFoundError);
    const close = (outcome: Awaited<ReturnType<OwnershipRepository['close']>>) =>
      closeOwnership({ repository: repository({ close: async () => outcome }) })({ principal, ownershipId: 'o', validUntil: day('2030-12-31') });
    await expect(close({ kind: 'NOT_FOUND' })).rejects.toBeInstanceOf(OwnershipNotFoundError);
    await expect(close({ kind: 'INVALID_OWNERSHIP', reason: 'ALREADY_ENDED' })).rejects.toMatchObject({ reason: 'ALREADY_ENDED' });
    await expect(close({ kind: 'INVALID_OWNERSHIP', reason: 'VOID' })).rejects.toBeInstanceOf(InvalidOwnershipError);
    await expect(close({ kind: 'VERSION_CONFLICT', expectedVersions: [1], currentVersion: 2 })).rejects.toBeInstanceOf(VersionConflictError);
    const voided = (outcome: Awaited<ReturnType<OwnershipRepository['void']>>) =>
      voidOwnership({ repository: repository({ void: async () => outcome }) })({ principal, ownershipId: 'o', reason: 'x' });
    await expect(voided({ kind: 'NOT_FOUND' })).rejects.toBeInstanceOf(OwnershipNotFoundError);
    await expect(voided({ kind: 'VERSION_CONFLICT', expectedVersions: [1], currentVersion: 2 })).rejects.toBeInstanceOf(VersionConflictError);
    const read = readPropertyOwnerships({ repository: repository({}) });
    await expect(read({ principal, propertyReferenceId: 'pr', asOf: day('2026-08-01') })).rejects.toBeInstanceOf(PropertyReferenceNotFoundError);
    await expect(read({ principal, propertyReferenceId: 'pr', page: { page: 1, pageSize: 50 } })).rejects.toBeInstanceOf(PropertyReferenceNotFoundError);
  });
});

describe('Ownership change use case', () => {
  const change = { propertyReferenceId: 'pr', effectiveDate: day('2030-01-01'), reason: 'Verkauf', close: ['o1'], create: [], acquisitionId: null };
  const result = { propertyReferenceId: 'pr' } as ChangeResult;
  const changer = (outcome: Awaited<ReturnType<OwnershipChangeRepository['change']>>, calls: unknown[][] = []) =>
    changeOwnership({
      repository: {
        change: async (...args) => {
          calls.push(args);
          return outcome;
        },
      },
    });

  it('in the caller Realm with the fingerprint; CREATED, REPLAYED and UNCHANGED as statuses', async () => {
    const calls: unknown[][] = [];
    expect(await changer({ kind: 'CHANGED', result, replayed: false }, calls)({ principal, ...change, idempotencyKey: 'k' })).toEqual({ result, status: 'CREATED' });
    const expected = { mreRealmId: REALM, ...change };
    expect(calls).toEqual([[expected, { actorType: 'USER', actorId: 'anna@example.com' }, { key: 'k', fingerprint: changeFingerprint(expected) }]]);
    expect(await changer({ kind: 'CHANGED', result, replayed: true })({ principal, ...change })).toEqual({ result, status: 'REPLAYED' });
    expect(await changer({ kind: 'UNCHANGED', result })({ principal, ...change })).toEqual({ result, status: 'UNCHANGED' });
  });

  it('each refusal as its error', async () => {
    const refused = (outcome: Awaited<ReturnType<OwnershipChangeRepository['change']>>) => changer(outcome)({ principal, ...change });
    await expect(refused({ kind: 'IDEMPOTENCY_CONFLICT' })).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(refused({ kind: 'PROPERTY_REFERENCE_NOT_FOUND' })).rejects.toBeInstanceOf(PropertyReferenceNotFoundError);
    await expect(refused({ kind: 'INVALID_OWNERSHIP', ownershipId: 'o1', reason: 'NOT_FOUND' })).rejects.toMatchObject({ ownershipId: 'o1', reason: 'NOT_FOUND' });
    await expect(refused({ kind: 'PARTY_NOT_FOUND', partyId: 'p' })).rejects.toBeInstanceOf(PartyNotFoundError);
    await expect(refused({ kind: 'PARTY_INACTIVE', partyId: 'p' })).rejects.toBeInstanceOf(OwnerInactiveError);
    await expect(refused({ kind: 'OVERLAPPING_OWNERSHIP', ownershipId: 'o2' as Ownership['id'], createIndex: 0 })).rejects.toBeInstanceOf(OverlappingOwnershipError);
    await expect(
      refused({ kind: 'OWNERSHIP_TOTAL_EXCEEDS_ONE', date: day('2030-01-01'), shareSum: { numerator: 3n, denominator: 2n }, createIndex: 0 }),
    ).rejects.toBeInstanceOf(OwnershipTotalExceedsOneError);
    await expect(refused({ kind: 'OWNERSHIP_INCOMPLETE', date: day('2030-01-01'), shareSum: { numerator: 5n, denominator: 6n } })).rejects.toBeInstanceOf(
      OwnershipIncompleteError,
    );
  });
});
