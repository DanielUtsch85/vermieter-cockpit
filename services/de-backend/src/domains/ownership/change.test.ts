import { describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../shared/index.js';
import { changeFingerprint, planChange, type OwnershipChange } from './change.js';
import type { Ownership, OwnershipId } from './ownership.js';

/** VC-2-04 domain rules (api-design.md §26.2, phase-2-plan P2-D5). */
const day = (value: string) => value as BusinessDate;
const ownership = (id: string, owner: string, share: [number, number], from: string, until: string | null = null, status: 'VALID' | 'VOID' = 'VALID'): Ownership =>
  ({
    id: id as OwnershipId,
    ownerPartyId: owner,
    share: { numerator: share[0], denominator: share[1] },
    validFrom: day(from),
    validUntil: until === null ? null : day(until),
    status,
    version: 1,
  }) as Ownership;
const half = (owner: string) => ({ ownerPartyId: owner, share: { numerator: 1, denominator: 2 }, sourceReferences: [], notes: null });
const a = ownership('a', 'anna', [1, 2], '2026-08-01');
const b = ownership('b', 'ben', [1, 2], '2026-08-01');
const effectiveDate = day('2030-01-01');

describe('planChange', () => {
  it('a sale to a third party at complete ownership: close Anna, create Dora; complete stays complete', () => {
    expect(planChange([a, b], { effectiveDate, close: ['a'], create: [half('dora')] })).toEqual({
      kind: 'CHANGE',
      closes: [{ ownership: a, validUntil: '2029-12-31' }],
    });
  });

  it('a share change of the same owner: close both halves, Anna takes the whole', () => {
    const plan = planChange([a, b], { effectiveDate, close: ['b', 'a'], create: [{ ...half('anna'), share: { numerator: 1, denominator: 1 } }] });
    // Closes come back in id order: the order they are written and locked.
    expect(plan).toMatchObject({ kind: 'CHANGE', closes: [{ ownership: { id: 'a' } }, { ownership: { id: 'b' } }] });
  });

  it('the listed Ownerships, in the order given: NOT_FOUND, VOID, STARTS_ON_OR_AFTER_EFFECTIVE_DATE, ALREADY_ENDED', () => {
    const voided = ownership('v', 'carl', [1, 4], '2026-08-01', null, 'VOID');
    const later = ownership('l', 'carl', [1, 4], '2030-01-01');
    const ended = ownership('e', 'carl', [1, 4], '2026-08-01', '2029-12-30');
    const existing = [a, b, voided, later, ended];
    const plan = (close: string[]) => planChange(existing, { effectiveDate, close, create: [] });
    expect(plan(['x', 'v'])).toEqual({ kind: 'INVALID_OWNERSHIP', ownershipId: 'x', reason: 'NOT_FOUND' });
    expect(plan(['v', 'x'])).toEqual({ kind: 'INVALID_OWNERSHIP', ownershipId: 'v', reason: 'VOID' });
    expect(plan(['l'])).toEqual({ kind: 'INVALID_OWNERSHIP', ownershipId: 'l', reason: 'STARTS_ON_OR_AFTER_EFFECTIVE_DATE' });
    expect(plan(['e'])).toEqual({ kind: 'INVALID_OWNERSHIP', ownershipId: 'e', reason: 'ALREADY_ENDED' });
  });

  it('a later planned end is shortened; one already ending on effectiveDate − 1 stays; a close-only change of nothing is UNCHANGED', () => {
    const planned = ownership('p', 'anna', [1, 2], '2026-08-01', '2040-12-31');
    const ending = ownership('q', 'ben', [1, 2], '2026-08-01', '2029-12-31');
    expect(planChange([planned, ending], { effectiveDate, close: ['p', 'q'], create: [{ ...half('carl'), share: { numerator: 1, denominator: 1 } }] })).toEqual({
      kind: 'CHANGE',
      closes: [{ ownership: planned, validUntil: '2029-12-31' }],
    });
    expect(planChange([ending], { effectiveDate, close: ['q'], create: [] })).toEqual({ kind: 'UNCHANGED' });
  });

  it('the invariants after the change, with the index of the create: overlap and a day above 1', () => {
    expect(planChange([a, b], { effectiveDate, close: ['a'], create: [half('dora'), half('ben')] })).toEqual({
      kind: 'OVERLAPPING_OWNERSHIP',
      ownershipId: 'b',
      createIndex: 1,
    });
    expect(planChange([a, b], { effectiveDate, close: [], create: [half('dora')] })).toEqual({
      kind: 'OWNERSHIP_TOTAL_EXCEEDS_ONE',
      date: '2030-01-01',
      shareSum: { numerator: 3n, denominator: 2n },
      createIndex: 0,
    });
  });

  it('complete before means complete after; an incomplete ownership may stay incomplete', () => {
    expect(planChange([a, b], { effectiveDate, close: ['a'], create: [{ ...half('dora'), share: { numerator: 1, denominator: 3 } }] })).toEqual({
      kind: 'OWNERSHIP_INCOMPLETE',
      date: '2030-01-01',
      shareSum: { numerator: 5n, denominator: 6n },
    });
    expect(planChange([a], { effectiveDate, close: ['a'], create: [{ ...half('dora'), share: { numerator: 1, denominator: 3 } }] })).toMatchObject({ kind: 'CHANGE' });
    // Leaving with nobody taking over: complete before, incomplete after.
    expect(planChange([a, b], { effectiveDate, close: ['a'], create: [] })).toMatchObject({ kind: 'OWNERSHIP_INCOMPLETE' });
  });

  it('the fingerprint ignores the order of close', () => {
    const change: OwnershipChange = { mreRealmId: 'r', propertyReferenceId: 'pr', effectiveDate, reason: 'Verkauf', close: ['a', 'b'], create: [half('dora')], acquisitionId: null };
    expect(changeFingerprint(change)).toBe(changeFingerprint({ ...change, close: ['b', 'a'] }));
    expect(changeFingerprint(change)).not.toBe(changeFingerprint({ ...change, reason: 'Erbfall' }));
  });
});
