import { describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../shared/index.js';
import {
  membershipOn,
  overlappingMembership,
  planMembershipAmend,
  planMembershipEnd,
  planMembershipVoid,
  planWegAmend,
  planWegVoid,
  type Weg,
  type WegId,
  type WegMembership,
  type WegMembershipId,
} from './weg.js';

/** WEG and membership plans (api-design.md §49.1–§49.2, phase-6-plan P6-D1). */
const day = (value: string) => value as BusinessDate;
const at = new Date('2026-10-29T12:00:00Z');

const weg = (overrides: Partial<Weg> = {}): Weg => ({
  id: 'w1' as WegId,
  mreRealmId: 'r',
  status: 'ACTIVE',
  displayName: 'Musterstraße 1',
  administratorPartyId: null,
  financialYearStartMonth: 1,
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: at,
  version: 1,
  ...overrides,
});

const membership = (overrides: Partial<WegMembership> = {}): WegMembership => ({
  id: 'm1' as WegMembershipId,
  mreRealmId: 'r',
  wegId: 'w1',
  propertyReferenceId: 'p1',
  mea: { numerator: '125.5', denominator: '10000' },
  validFrom: day('2024-01-01'),
  validUntil: null,
  status: 'ACTIVE',
  voidedAt: null,
  voidReason: null,
  sourceReferences: [],
  notes: null,
  createdAt: at,
  version: 1,
  ...overrides,
});

describe('one WEG per unit at a time', () => {
  const existing = [
    membership({ id: 'a' as WegMembershipId, validFrom: day('2020-01-01'), validUntil: day('2023-12-31') }),
    membership({ id: 'b' as WegMembershipId, validFrom: day('2024-01-01'), validUntil: null }),
    membership({ id: 'v' as WegMembershipId, validFrom: day('2010-01-01'), validUntil: null, status: 'VOID' }),
  ];

  it('an overlap with an ACTIVE membership, inclusive at both ends', () => {
    expect(overlappingMembership(existing, { validFrom: day('2023-12-31'), validUntil: day('2023-12-31') })?.id).toBe('a');
    expect(overlappingMembership(existing, { validFrom: day('2030-01-01'), validUntil: null })?.id).toBe('b');
    expect(overlappingMembership(existing, { validFrom: day('2019-01-01'), validUntil: day('2020-01-01') })?.id).toBe('a');
  });

  it('no overlap before the first, between none, and never with a VOID one', () => {
    expect(overlappingMembership(existing, { validFrom: day('2015-01-01'), validUntil: day('2019-12-31') })).toBeUndefined();
    expect(overlappingMembership(existing.slice(0, 1), { validFrom: day('2024-01-01'), validUntil: null })).toBeUndefined();
  });

  it('the membership on a day', () => {
    expect(membershipOn(existing, day('2023-12-31'))?.id).toBe('a');
    expect(membershipOn(existing, day('2024-01-01'))?.id).toBe('b');
    expect(membershipOn(existing, day('2019-12-31'))).toBeNull();
  });
});

describe('WEG amend and void', () => {
  it('changes only what differs; the same values are a no-op', () => {
    expect(planWegAmend(weg(), { displayName: 'Musterstraße 1', notes: null })).toEqual({ kind: 'UNCHANGED' });
    expect(planWegAmend(weg(), { displayName: 'Neu', financialYearStartMonth: 7 })).toMatchObject({
      kind: 'AMEND',
      changed: ['displayName', 'financialYearStartMonth'],
      newAdministratorId: null,
    });
  });

  it('a newly named administrator is checked; clearing it is not', () => {
    expect(planWegAmend(weg(), { administratorPartyId: 'p' })).toMatchObject({ kind: 'AMEND', newAdministratorId: 'p' });
    expect(planWegAmend(weg({ administratorPartyId: 'p' }), { administratorPartyId: null })).toMatchObject({ kind: 'AMEND', newAdministratorId: null });
    expect(planWegAmend(weg({ administratorPartyId: 'p' }), { administratorPartyId: 'p' })).toEqual({ kind: 'UNCHANGED' });
  });

  it('a VOID WEG is not amended, not even with its own values', () => {
    expect(planWegAmend(weg({ status: 'VOID' }), { displayName: 'Musterstraße 1' })).toEqual({ kind: 'WEG_NOT_ACTIVE', status: 'VOID' });
  });

  it('void: refused while memberships hang off it, a no-op once VOID', () => {
    expect(planWegVoid(weg(), 'Fehler', at, ['m2', 'm1'])).toEqual({ kind: 'WEG_HAS_MEMBERSHIPS', membershipIds: ['m1', 'm2'] });
    expect(planWegVoid(weg(), 'Fehler', at, [])).toMatchObject({ kind: 'VOID', next: { status: 'VOID', voidReason: 'Fehler', version: 2 } });
    expect(planWegVoid(weg({ status: 'VOID' }), 'x', at, ['m1'])).toEqual({ kind: 'UNCHANGED' });
  });
});

describe('membership amend, end and void', () => {
  it('amend: only references and notes; the same values are a no-op; VOID is refused', () => {
    const current = membership({ sourceReferences: ['TE Nr. 4'], notes: 'n' });
    expect(planMembershipAmend(current, { sourceReferences: ['TE Nr. 4'], notes: 'n' })).toEqual({ kind: 'UNCHANGED' });
    expect(planMembershipAmend(current, { sourceReferences: [] })).toMatchObject({ kind: 'AMEND', changed: ['sourceReferences'] });
    expect(planMembershipAmend(current, { notes: null })).toMatchObject({ kind: 'AMEND', changed: ['notes'] });
    expect(planMembershipAmend(membership({ status: 'VOID' }), { notes: 'x' })).toEqual({ kind: 'MEMBERSHIP_NOT_ACTIVE' });
  });

  it('end: sets or shortens, never extends; the same day is a no-op', () => {
    expect(planMembershipEnd(membership(), day('2025-06-30'))).toMatchObject({ kind: 'END', next: { validUntil: '2025-06-30', version: 2 } });
    expect(planMembershipEnd(membership(), day('2024-01-01'))).toMatchObject({ kind: 'END' });
    const ending = membership({ validUntil: day('2025-06-30') });
    expect(planMembershipEnd(ending, day('2025-06-30'))).toEqual({ kind: 'UNCHANGED' });
    expect(planMembershipEnd(ending, day('2025-01-31'))).toMatchObject({ kind: 'END', next: { validUntil: '2025-01-31' } });
    expect(planMembershipEnd(ending, day('2025-07-01'))).toEqual({ kind: 'INVALID_MEMBERSHIP', reason: 'ALREADY_ENDED' });
    expect(planMembershipEnd(membership(), day('2023-12-31'))).toEqual({ kind: 'INVALID_MEMBERSHIP', reason: 'STARTS_AFTER_END' });
    expect(planMembershipEnd(membership({ status: 'VOID' }), day('2025-06-30'))).toEqual({ kind: 'MEMBERSHIP_NOT_ACTIVE' });
  });

  it('void: once; a second void keeps the first reason', () => {
    expect(planMembershipVoid(membership(), 'falscher MEA', at)).toMatchObject({ kind: 'VOID', next: { status: 'VOID', voidReason: 'falscher MEA' } });
    expect(planMembershipVoid(membership({ status: 'VOID', voidReason: 'erst' }), 'zweit', at)).toEqual({ kind: 'UNCHANGED' });
  });
});
