import { describe, expect, it } from 'vitest';
import { createFingerprint, type PartyRepository } from '../domains/party/index.js';
import type { RealmPrincipal } from './access.js';
import { PartyFieldNotAllowedError, PartyNotFoundError, amendParty, createParty, deactivateParty, getParty } from './parties.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';

/** VC-2-01 use cases (api-design.md §19.1): Realm, actor, fingerprint, and each refusal as its error. */
const REALM = '64b0c0ffee0000000000000a';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const data = { displayName: 'X GmbH', firstName: null, lastName: null, legalName: 'X GmbH', registrationNumber: null, email: null, phone: null };

const repository = (overrides: Partial<PartyRepository>): PartyRepository => ({
  create: () => Promise.reject(new Error('unused')),
  findById: async () => undefined,
  list: () => Promise.reject(new Error('unused')),
  amend: () => Promise.reject(new Error('unused')),
  deactivate: () => Promise.reject(new Error('unused')),
  ...overrides,
});

describe('Party use cases', () => {
  it('create: in the caller Realm with the fingerprint of the normalized payload; refuses the other type before the repository', async () => {
    const calls: unknown[][] = [];
    const create = createParty({
      repository: repository({
        create: async (...args) => {
          calls.push(args);
          return { kind: 'IDEMPOTENCY_CONFLICT' };
        },
      }),
    });
    await expect(create({ principal, partyType: 'ORGANIZATION', ...data, idempotencyKey: 'k' })).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    const party = { mreRealmId: REALM, partyType: 'ORGANIZATION' as const, ...data };
    expect(calls).toEqual([[party, { actorType: 'USER', actorId: 'anna@example.com' }, { key: 'k', fingerprint: createFingerprint(party) }]]);
    await expect(create({ principal, partyType: 'PERSON', ...data })).rejects.toMatchObject(
      new PartyFieldNotAllowedError('PERSON', ['legalName']),
    );
    expect(calls).toHaveLength(1);
  });

  it('get, amend and deactivate turn their refusals into errors', async () => {
    await expect(getParty({ repository: repository({}) })({ principal, partyId: 'p' })).rejects.toBeInstanceOf(PartyNotFoundError);
    const amend = (outcome: Awaited<ReturnType<PartyRepository['amend']>>) =>
      amendParty({ repository: repository({ amend: async () => outcome }) })({ principal, partyId: 'p', changes: {} });
    await expect(amend({ kind: 'NOT_FOUND' })).rejects.toBeInstanceOf(PartyNotFoundError);
    await expect(amend({ kind: 'VERSION_CONFLICT', expectedVersions: [1], currentVersion: 2 })).rejects.toBeInstanceOf(VersionConflictError);
    await expect(amend({ kind: 'NOT_ALLOWED_FOR_TYPE', partyType: 'PERSON', fields: ['legalName'] })).rejects.toMatchObject({ fields: ['legalName'] });
    const deactivate = (outcome: Awaited<ReturnType<PartyRepository['deactivate']>>) =>
      deactivateParty({ repository: repository({ deactivate: async () => outcome }) })({ principal, partyId: 'p', reason: 'x' });
    await expect(deactivate({ kind: 'NOT_FOUND' })).rejects.toBeInstanceOf(PartyNotFoundError);
    await expect(deactivate({ kind: 'VERSION_CONFLICT', expectedVersions: [1], currentVersion: 2 })).rejects.toBeInstanceOf(VersionConflictError);
  });
});
