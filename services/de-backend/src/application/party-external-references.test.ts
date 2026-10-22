import { describe, expect, it } from 'vitest';
import type { ExternalReferenceId, PartyExternalReference, PartyExternalReferenceRepository, PartyId } from '../domains/party/index.js';
import type { RealmPrincipal } from './access.js';
import { ConcurrentUpdateError, VersionConflictError } from './errors.js';
import {
  ExternalReferenceInUseError,
  ExternalReferenceNotFoundError,
  MreTenantNotFoundError,
  PartyInactiveError,
  createExternalReference,
  endExternalReference,
  listExternalReferences,
} from './party-external-references.js';
import { PartyNotFoundError } from './parties.js';

/** VC-2-02 use cases (api-design.md §20.1): the order of checks, when MRE is asked, and each refusal as its error. */
const REALM = '64b0c0ffee0000000000000a';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const reference = { id: 'r1' as ExternalReferenceId, partyId: 'p1' as PartyId } as PartyExternalReference;
const key = { system: 'MRE', mreRealmId: REALM, entityType: 'tenant', externalId: TENANT };

const repository = (overrides: Partial<PartyExternalReferenceRepository>): PartyExternalReferenceRepository => ({
  checkClaim: () => Promise.reject(new Error('unused')),
  claim: () => Promise.reject(new Error('unused')),
  end: () => Promise.reject(new Error('unused')),
  list: () => Promise.reject(new Error('unused')),
  ...overrides,
});

describe('Party external reference use cases', () => {
  const input = { principal, authorizationHeader: 'Bearer t', partyId: 'p1', mreRealmId: REALM, externalId: TENANT };

  it('create: checks DE first, asks MRE only for a free key, then claims with the key and the actor', async () => {
    const asked: string[][] = [];
    const claims: unknown[][] = [];
    const create = createExternalReference({
      repository: repository({
        checkClaim: async () => ({ kind: 'CLAIM' }),
        claim: async (...args) => {
          claims.push(args);
          return { kind: 'CREATED', reference };
        },
      }),
      lookupMreTenant: async (...args) => {
        asked.push(args);
        return true;
      },
    });
    expect(await create(input)).toEqual({ reference, created: true });
    expect(asked).toEqual([['Bearer t', REALM, TENANT]]);
    expect(claims).toEqual([['p1', key, { actorType: 'USER', actorId: 'anna@example.com' }]]);
  });

  it('create: a repeat or a refusal from DE never asks MRE; an unlisted Tenant is MreTenantNotFoundError', async () => {
    const lookupMreTenant = async () => {
      throw new Error('MRE must not be asked');
    };
    const withCheck = (check: Awaited<ReturnType<PartyExternalReferenceRepository['checkClaim']>>) =>
      createExternalReference({ repository: repository({ checkClaim: async () => check }), lookupMreTenant })(input);
    expect(await withCheck({ kind: 'EXISTING', reference })).toEqual({ reference, created: false });
    await expect(withCheck({ kind: 'NOT_FOUND' })).rejects.toBeInstanceOf(PartyNotFoundError);
    await expect(withCheck({ kind: 'IN_USE', partyId: 'p2' as PartyId })).rejects.toMatchObject(new ExternalReferenceInUseError('p2'));
    await expect(withCheck({ kind: 'PARTY_INACTIVE' })).rejects.toBeInstanceOf(PartyInactiveError);

    const unlisted = createExternalReference({ repository: repository({ checkClaim: async () => ({ kind: 'CLAIM' }) }), lookupMreTenant: async () => false });
    await expect(unlisted(input)).rejects.toMatchObject(new MreTenantNotFoundError(TENANT));
  });

  it('create: another Realm in the body is FORBIDDEN before anything is read; the claim re-check decides a race', async () => {
    const create = createExternalReference({ repository: repository({}), lookupMreTenant: async () => true });
    await expect(create({ ...input, mreRealmId: '64b0c0ffee0000000000000b' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const raced = createExternalReference({
      repository: repository({ checkClaim: async () => ({ kind: 'CLAIM' }), claim: async () => ({ kind: 'IN_USE', partyId: 'p2' as PartyId }) }),
      lookupMreTenant: async () => true,
    });
    await expect(raced(input)).rejects.toBeInstanceOf(ExternalReferenceInUseError);
    // Lost every attempt (claimed and ended concurrently): a retryable refusal, not a server fault (review on #41).
    const contended = createExternalReference({
      repository: repository({ checkClaim: async () => ({ kind: 'CLAIM' }), claim: async () => ({ kind: 'CONTENDED' }) }),
      lookupMreTenant: async () => true,
    });
    await expect(contended(input)).rejects.toBeInstanceOf(ConcurrentUpdateError);
  });

  it('end and list turn their refusals into errors', async () => {
    const end = (outcome: Awaited<ReturnType<PartyExternalReferenceRepository['end']>>) =>
      endExternalReference({ repository: repository({ end: async () => outcome }) })({ principal, partyId: 'p1', externalReferenceId: 'r1' });
    expect(await end({ kind: 'ENDED', reference, changed: false })).toEqual({ reference, changed: false });
    await expect(end({ kind: 'NOT_FOUND' })).rejects.toBeInstanceOf(ExternalReferenceNotFoundError);
    await expect(end({ kind: 'VERSION_CONFLICT', expectedVersions: [1], currentVersion: 2 })).rejects.toBeInstanceOf(VersionConflictError);
    const list = listExternalReferences({ repository: repository({ list: async () => undefined }) });
    await expect(list({ principal, partyId: 'p1', filter: {}, page: { page: 1, pageSize: 50 } })).rejects.toBeInstanceOf(PartyNotFoundError);
  });
});
