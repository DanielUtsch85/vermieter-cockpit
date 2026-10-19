import { describe, expect, it } from 'vitest';
import { ExactDecimal } from '../../shared/index.js';
import { planRefresh, type MreObservation, type PropertyReference, type PropertyReferenceId } from './index.js';

const linkedAt = new Date('2026-10-19T08:00:00Z');
const later = new Date('2026-10-20T09:00:00Z');

const current: PropertyReference = {
  id: 'ref-1' as PropertyReferenceId,
  mreRealmId: '64b0c0ffee0000000000000a',
  mrePropertyId: '6512f0c2a1b2c3d4e5f60718',
  externalReferenceState: 'ACTIVE',
  displayName: 'Wohnung 1',
  cachedAddress: { street1: 'Musterstraße 1', city: 'Berlin' },
  cachedSurface: ExactDecimal.of('64.5'),
  lastRefreshedAt: linkedAt,
  createdAt: linkedAt,
  version: 1,
};

const found = (overrides: Partial<Extract<MreObservation, { kind: 'FOUND' }>> = {}): MreObservation => ({
  kind: 'FOUND',
  observedAt: later,
  displayName: 'Wohnung 1',
  cachedAddress: { city: 'Berlin', street1: 'Musterstraße 1' },
  cachedSurface: ExactDecimal.of('64.50'),
  ...overrides,
});

describe('planRefresh', () => {
  it('unchanged MRE values: only lastRefreshedAt moves, no version bump, no audited change', () => {
    const plan = planRefresh(current, found());
    expect(plan.change).toBeUndefined();
    expect(plan.next).toMatchObject({ externalReferenceState: 'ACTIVE', displayName: 'Wohnung 1', version: 1, lastRefreshedAt: later });
  });

  it.each([
    ['displayName', { displayName: 'Wohnung 1 (EG)' }],
    ['displayName', { displayName: null }],
    ['cachedAddress', { cachedAddress: { street1: 'Musterstraße 1', city: 'Hamburg' } }],
    ['cachedAddress', { cachedAddress: null }],
    ['cachedSurface', { cachedSurface: ExactDecimal.of('65') }],
    ['cachedSurface', { cachedSurface: null }],
  ] as const)('a changed %s is taken over, versioned and audited as REFRESHED', (field, overrides) => {
    const plan = planRefresh(current, found(overrides));
    expect(plan.change).toEqual({ action: 'REFRESHED', fields: [field] });
    expect(plan.next).toMatchObject({ ...overrides, version: 2, lastRefreshedAt: later, externalReferenceState: 'ACTIVE' });
  });

  it('not found in MRE: MISSING, cached values and lastRefreshedAt kept, audited as MARKED_MISSING', () => {
    const plan = planRefresh(current, { kind: 'NOT_FOUND', observedAt: later });
    expect(plan.change).toEqual({ action: 'MARKED_MISSING', fields: ['externalReferenceState'] });
    expect(plan.next).toEqual({ ...current, externalReferenceState: 'MISSING', version: 2 });
  });

  it('still not found: nothing changes', () => {
    const missing = { ...current, externalReferenceState: 'MISSING' as const, version: 2 };
    expect(planRefresh(missing, { kind: 'NOT_FOUND', observedAt: later })).toEqual({ next: missing });
  });

  it('found again after MISSING: ACTIVE again, audited with the state among the changed fields', () => {
    const missing = { ...current, externalReferenceState: 'MISSING' as const, version: 2 };
    const plan = planRefresh(missing, found({ displayName: 'Neu' }));
    expect(plan.change).toEqual({ action: 'REFRESHED', fields: ['externalReferenceState', 'displayName'] });
    expect(plan.next).toMatchObject({ externalReferenceState: 'ACTIVE', displayName: 'Neu', version: 3 });
  });

  it('never touches identity or creation data', () => {
    const { next } = planRefresh(current, found({ displayName: 'X', cachedSurface: null }));
    expect(next).toMatchObject({
      id: current.id,
      mreRealmId: current.mreRealmId,
      mrePropertyId: current.mrePropertyId,
      createdAt: current.createdAt,
    });
  });
});
