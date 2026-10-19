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
  lastObservedAt: linkedAt,
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
    expect(plan.stale).toBe(false);
    expect(plan.next).toMatchObject({
      externalReferenceState: 'ACTIVE',
      displayName: 'Wohnung 1',
      version: 1,
      lastRefreshedAt: later,
      lastObservedAt: later,
    });
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
    expect(plan.next).toEqual({ ...current, externalReferenceState: 'MISSING', version: 2, lastObservedAt: later });
  });

  it('still not found: only lastObservedAt moves', () => {
    const missing = { ...current, externalReferenceState: 'MISSING' as const, version: 2 };
    expect(planRefresh(missing, { kind: 'NOT_FOUND', observedAt: later })).toEqual({
      next: { ...missing, lastObservedAt: later },
      stale: false,
    });
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

  describe('stale observations (MRE is read outside the row lock)', () => {
    const t1 = new Date('2026-10-20T09:00:00Z');
    const t2 = new Date('2026-10-20T09:00:05Z');

    it('an older FOUND after a newer FOUND is discarded: no old name, no backwards lastRefreshedAt, no version, no audit', () => {
      const newer = planRefresh(current, found({ observedAt: t2, displayName: 'NEU (t2)' })).next;
      const plan = planRefresh(newer, found({ observedAt: t1, displayName: 'ALT (t1)' }));
      expect(plan).toEqual({ next: newer, stale: true });
      expect(plan.next).toMatchObject({ displayName: 'NEU (t2)', lastRefreshedAt: t2, lastObservedAt: t2, version: 2 });
    });

    it('an older FOUND after a newer NOT_FOUND is discarded: the reference stays MISSING', () => {
      const missing = planRefresh(current, { kind: 'NOT_FOUND', observedAt: t2 }).next;
      const plan = planRefresh(missing, found({ observedAt: t1 }));
      expect(plan).toEqual({ next: missing, stale: true });
      expect(plan.next.externalReferenceState).toBe('MISSING');
    });

    it('an older NOT_FOUND after a newer FOUND is discarded: the reference stays ACTIVE', () => {
      const active = planRefresh(current, found({ observedAt: t2, displayName: 'NEU (t2)' })).next;
      expect(planRefresh(active, { kind: 'NOT_FOUND', observedAt: t1 })).toEqual({ next: active, stale: true });
    });

    it('an observation that started at the same instant as the last applied one is discarded too', () => {
      const applied = planRefresh(current, found({ observedAt: t2, displayName: 'NEU (t2)' })).next;
      expect(planRefresh(applied, found({ observedAt: t2, displayName: 'other' })).stale).toBe(true);
    });

    it('an observation older than the link lookup is discarded', () => {
      expect(planRefresh(current, found({ observedAt: new Date(linkedAt.getTime() - 1), displayName: 'X' })).stale).toBe(true);
    });

    it('a reference without lastObservedAt accepts any observation', () => {
      expect(planRefresh({ ...current, lastObservedAt: null }, found({ observedAt: linkedAt, displayName: 'X' })).stale).toBe(false);
    });
  });
});
