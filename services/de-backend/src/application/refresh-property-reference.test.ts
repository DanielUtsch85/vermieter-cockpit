import { describe, expect, it } from 'vitest';
import { ExactDecimal } from '../shared/index.js';
import { AccessError, type RealmPrincipal } from './access.js';
import { MreUnavailableError, linkPropertyReference } from './link-property-reference.js';
import { lookupOf, memoryRepository } from './property-reference.test-support.js';
import { PropertyReferenceNotFoundError, refreshPropertyReference } from './refresh-property-reference.js';

const REALM = '64b0c0ffee0000000000000a';
const PROPERTY = '6512f0c2a1b2c3d4e5f60718';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const linkedAt = new Date('2026-10-19T08:00:00Z');
const refreshedAt = new Date('2026-10-20T09:00:00Z');
const wohnung = { mrePropertyId: PROPERTY, name: 'Wohnung 1', address: { city: 'Berlin' }, surface: ExactDecimal.of('64.5') };

async function linked() {
  const repository = memoryRepository();
  const { reference } = await linkPropertyReference({ repository, lookupMreProperty: lookupOf(wohnung), now: () => linkedAt })({
    principal,
    authorizationHeader: 'Bearer a.b.c',
    mreRealmId: REALM,
    mrePropertyId: PROPERTY,
  });
  return { repository, id: reference.id };
}

const input = (propertyReferenceId: string, caller: RealmPrincipal = principal) => ({
  principal: caller,
  authorizationHeader: 'Bearer a.b.c',
  propertyReferenceId,
});

describe('refreshPropertyReference', () => {
  it('re-reads the Property with the caller token and takes over changed values, audited as the caller', async () => {
    const { repository, id } = await linked();
    const lookup = lookupOf({ ...wohnung, name: 'Wohnung 1 (EG)' });
    const refreshed = await refreshPropertyReference({ repository, lookupMreProperty: lookup, now: () => refreshedAt })(input(id));

    expect(refreshed).toMatchObject({ displayName: 'Wohnung 1 (EG)', version: 2, lastRefreshedAt: refreshedAt });
    expect(lookup.calls).toEqual([['Bearer a.b.c', REALM, PROPERTY]]);
    expect(repository.audits.at(-1)).toEqual({ action: 'REFRESHED', actor: { actorType: 'USER', actorId: 'anna@example.com' } });
  });

  it('a Property no longer in MRE marks the reference MISSING instead of failing', async () => {
    const { repository, id } = await linked();
    const refreshed = await refreshPropertyReference({
      repository,
      lookupMreProperty: lookupOf(undefined),
      now: () => refreshedAt,
    })(input(id));
    expect(refreshed).toMatchObject({
      externalReferenceState: 'MISSING',
      displayName: 'Wohnung 1',
      lastRefreshedAt: linkedAt,
      lastObservedAt: refreshedAt,
    });
    expect(repository.rows).toHaveLength(1);
  });

  it('takes observedAt before the MRE request, so a slow response cannot pass for a newer one', async () => {
    const { repository, id } = await linked();
    const clock = [new Date('2026-10-20T09:00:00Z'), new Date('2026-10-20T09:00:09Z')];
    const order: string[] = [];
    const lookup = async () => (order.push('lookup'), wohnung);
    const now = () => (order.push('now'), clock.shift() ?? new Date(0));
    const refreshed = await refreshPropertyReference({ repository, lookupMreProperty: lookup, now })(input(id));
    expect(order).toEqual(['now', 'lookup']);
    expect(refreshed.lastObservedAt).toEqual(new Date('2026-10-20T09:00:00Z'));
  });

  it("another Realm's reference is not found, and MRE is not asked", async () => {
    const { repository, id } = await linked();
    const lookup = lookupOf(wohnung);
    const other = { ...principal, mreRealmId: '64b0c0ffee0000000000000b' };
    await expect(refreshPropertyReference({ repository, lookupMreProperty: lookup })(input(id, other))).rejects.toBeInstanceOf(
      PropertyReferenceNotFoundError,
    );
    expect(lookup.calls).toEqual([]);
  });

  it.each([
    ['MRE unavailable', new MreUnavailableError('down')],
    ['MRE refuses the caller', new AccessError('FORBIDDEN', 'refused')],
  ])('%s → the error propagates, the reference is unchanged', async (_label, error) => {
    const { repository, id } = await linked();
    const before = repository.rows[0];
    await expect(refreshPropertyReference({ repository, lookupMreProperty: lookupOf(error) })(input(id))).rejects.toBe(error);
    expect(repository.rows[0]).toBe(before);
    expect(repository.audits).toHaveLength(1);
  });
});
