import { describe, expect, it } from 'vitest';
import type {
  LinkOutcome,
  NewPropertyReference,
  PropertyReference,
  PropertyReferenceId,
  PropertyReferenceRepository,
} from '../domains/property-reference/index.js';
import type { AuditActor } from '../shared/index.js';
import { AccessError, type RealmPrincipal } from './access.js';
import {
  MrePropertyNotFoundError,
  MreUnavailableError,
  linkPropertyReference,
  type MrePropertyLookup,
} from './link-property-reference.js';

const REALM = '64b0c0ffee0000000000000a';
const PROPERTY = '6512f0c2a1b2c3d4e5f60718';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const at = new Date('2026-10-19T08:00:00Z');

/** In-memory repository recording the audit actors it was given. */
function memoryRepository(): PropertyReferenceRepository & { rows: PropertyReference[]; audits: AuditActor[] } {
  const rows: PropertyReference[] = [];
  const audits: AuditActor[] = [];
  const find = (realm: string, property: string) =>
    rows.find((r) => r.mreRealmId === realm && r.mrePropertyId === property);
  return {
    rows,
    audits,
    findByMreIdentity: async (realm, property) => find(realm, property),
    linkOnce: async (draft: NewPropertyReference, actor: AuditActor): Promise<LinkOutcome> => {
      const existing = find(draft.mreRealmId, draft.mrePropertyId);
      if (existing !== undefined) return { reference: existing, created: false };
      const reference: PropertyReference = {
        id: `ref-${rows.length + 1}` as PropertyReferenceId,
        mreRealmId: draft.mreRealmId,
        mrePropertyId: draft.mrePropertyId,
        externalReferenceState: 'ACTIVE',
        displayName: draft.displayName,
        cachedAddress: draft.cachedAddress,
        lastRefreshedAt: draft.refreshedAt,
        createdAt: draft.refreshedAt,
      };
      rows.push(reference);
      audits.push(actor);
      return { reference, created: true };
    },
  };
}

function lookupOf(result: Awaited<ReturnType<MrePropertyLookup>> | Error): MrePropertyLookup & { calls: string[][] } {
  const calls: string[][] = [];
  const lookup = async (auth: string, realm: string, property: string) => {
    calls.push([auth, realm, property]);
    if (result instanceof Error) throw result;
    return result;
  };
  return Object.assign(lookup, { calls });
}

const input = { principal, authorizationHeader: 'Bearer a.b.c', mreRealmId: REALM, mrePropertyId: PROPERTY };
const wohnung = { mrePropertyId: PROPERTY, name: 'Wohnung 1', address: { city: 'Berlin' } };

describe('linkPropertyReference', () => {
  it('creates a reference from the MRE Property, caching display data, audited as the caller', async () => {
    const repository = memoryRepository();
    const lookup = lookupOf(wohnung);
    const outcome = await linkPropertyReference({ repository, lookupMreProperty: lookup, now: () => at })(input);

    expect(outcome.created).toBe(true);
    expect(outcome.reference).toMatchObject({
      mreRealmId: REALM,
      mrePropertyId: PROPERTY,
      externalReferenceState: 'ACTIVE',
      displayName: 'Wohnung 1',
      cachedAddress: { city: 'Berlin' },
      lastRefreshedAt: at,
    });
    expect(lookup.calls).toEqual([['Bearer a.b.c', REALM, PROPERTY]]);
    expect(repository.audits).toEqual([{ actorType: 'USER', actorId: 'anna@example.com' }]);
  });

  it('a repeat returns the existing reference without asking MRE — even if the Property is gone upstream', async () => {
    const repository = memoryRepository();
    await linkPropertyReference({ repository, lookupMreProperty: lookupOf(wohnung) })(input);
    const gone = lookupOf(undefined);
    const repeat = await linkPropertyReference({ repository, lookupMreProperty: gone })(input);

    expect(repeat.created).toBe(false);
    expect(repeat.reference).toBe(repository.rows[0]);
    expect(gone.calls).toEqual([]);
    expect(repository.rows).toHaveLength(1);
    expect(repository.audits).toHaveLength(1);
  });

  it('rejects a body Realm other than the verified one (403), before touching DE or MRE', async () => {
    const repository = memoryRepository();
    const lookup = lookupOf(wohnung);
    const result = linkPropertyReference({ repository, lookupMreProperty: lookup })({
      ...input,
      mreRealmId: '64b0c0ffee0000000000000b',
    });
    await expect(result).rejects.toBeInstanceOf(AccessError);
    await expect(result).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(lookup.calls).toEqual([]);
    expect(repository.rows).toEqual([]);
  });

  it('MRE does not know the Property in this Realm → not found, nothing written', async () => {
    const repository = memoryRepository();
    const result = linkPropertyReference({ repository, lookupMreProperty: lookupOf(undefined) })(input);
    await expect(result).rejects.toBeInstanceOf(MrePropertyNotFoundError);
    await expect(result).rejects.toMatchObject({ mreRealmId: REALM, mrePropertyId: PROPERTY });
    expect(repository.rows).toEqual([]);
  });

  it.each([
    ['MRE unavailable', new MreUnavailableError('down')],
    ['MRE refuses the caller', new AccessError('FORBIDDEN', 'refused')],
  ])('%s → the error propagates, nothing written', async (_label, error) => {
    const repository = memoryRepository();
    await expect(linkPropertyReference({ repository, lookupMreProperty: lookupOf(error) })(input)).rejects.toBe(error);
    expect(repository.rows).toEqual([]);
  });
});
