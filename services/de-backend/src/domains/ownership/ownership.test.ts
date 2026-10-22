import { describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../shared/index.js';
import { checkInvariants, ownershipOn, planClose, planVoid, type Ownership, type OwnershipId } from './ownership.js';

/** VC-2-03 domain rules (api-design.md §26.1, phase-2-plan P2-D4). */
const day = (value: string) => value as BusinessDate;
let n = 0;
const ownership = (owner: string, share: [number, number], from: string, until: string | null = null, status: 'VALID' | 'VOID' = 'VALID'): Ownership => ({
  id: `o${++n}` as OwnershipId,
  mreRealmId: 'r',
  propertyReferenceId: 'pr',
  ownerPartyId: owner,
  share: { numerator: share[0], denominator: share[1] },
  validFrom: day(from),
  validUntil: until === null ? null : day(until),
  status,
  voidedAt: status === 'VOID' ? new Date() : null,
  voidReason: status === 'VOID' ? 'x' : null,
  acquisitionId: null,
  sourceReferences: [],
  notes: null,
  createdAt: new Date(),
  version: 1,
});
const candidate = (owner: string, share: [number, number], from: string, until: string | null = null) => ({
  ownerPartyId: owner,
  share: { numerator: share[0], denominator: share[1] },
  validFrom: day(from),
  validUntil: until === null ? null : day(until),
});

describe('Ownership', () => {
  it('no overlap per owner: inclusive dates, adjacent periods are fine; other owners and VOID ones do not count', () => {
    const a = ownership('anna', [1, 2], '2026-08-01', '2030-12-31');
    expect(checkInvariants([a], candidate('anna', [1, 2], '2031-01-01'))).toBeUndefined();
    expect(checkInvariants([a], candidate('anna', [1, 2], '2030-12-31', '2030-12-31'))).toEqual({ kind: 'OVERLAPPING_OWNERSHIP', ownershipId: a.id });
    expect(checkInvariants([a], candidate('anna', [1, 4], '2020-01-01', null))).toEqual({ kind: 'OVERLAPPING_OWNERSHIP', ownershipId: a.id });
    expect(checkInvariants([a], candidate('ben', [1, 2], '2026-08-01'))).toBeUndefined();
    expect(checkInvariants([{ ...a, status: 'VOID' }], candidate('anna', [1, 1], '2026-08-01'))).toBeUndefined();
  });

  it('no day above 1: the first such day and its exact sum, found where a period starts inside the new one', () => {
    const existing = [ownership('anna', [1, 2], '2026-08-01'), ownership('ben', [1, 3], '2028-01-01', '2028-12-31')];
    // 1/2 + 1/6 is fine until Ben starts; then 1/2 + 1/3 + 1/6 = 1 exactly: still fine.
    expect(checkInvariants(existing, candidate('carl', [1, 6], '2027-01-01'))).toBeUndefined();
    // 1/2 + 1/3 + 1/4 > 1 only from 2028-01-01, the day Ben starts.
    expect(checkInvariants(existing, candidate('carl', [1, 4], '2027-01-01'))).toEqual({
      kind: 'OWNERSHIP_TOTAL_EXCEEDS_ONE',
      date: '2028-01-01',
      shareSum: { numerator: 13n, denominator: 12n },
    });
    // Ending before Ben starts avoids it; starting after he ends too.
    expect(checkInvariants(existing, candidate('carl', [1, 4], '2027-01-01', '2027-12-31'))).toBeUndefined();
    expect(checkInvariants(existing, candidate('carl', [1, 2], '2029-01-01'))).toBeUndefined();
    expect(checkInvariants(existing, candidate('carl', [2, 3], '2026-08-01'))).toMatchObject({ kind: 'OWNERSHIP_TOTAL_EXCEEDS_ONE', date: '2026-08-01' });
  });

  it('a day: COMPLETE at exactly 1, INCOMPLETE below, NONE without; VOID and periods not covering it are left out', () => {
    const rows = [
      ownership('anna', [1, 2], '2026-08-01', '2035-03-31'),
      ownership('ben', [1, 2], '2026-08-01', '2035-03-31'),
      ownership('anna', [1, 1], '2035-04-01'),
      ownership('ben', [1, 3], '2040-01-01', null, 'VOID'),
    ];
    expect(ownershipOn(rows, day('2030-01-01'))).toMatchObject({ completeness: 'COMPLETE', shareSum: { numerator: 1n, denominator: 1n }, items: [{ ownerPartyId: 'anna' }, { ownerPartyId: 'ben' }] });
    expect(ownershipOn(rows, day('2035-03-31')).items).toHaveLength(2);
    expect(ownershipOn(rows, day('2041-01-01'))).toMatchObject({ completeness: 'COMPLETE', items: [{ share: { numerator: 1, denominator: 1 } }] });
    expect(ownershipOn(rows.slice(0, 1), day('2030-01-01'))).toMatchObject({ completeness: 'INCOMPLETE', shareSum: { numerator: 1n, denominator: 2n } });
    expect(ownershipOn(rows, day('2026-07-31'))).toEqual({ asOf: '2026-07-31', completeness: 'NONE', shareSum: { numerator: 0n, denominator: 1n }, items: [] });
  });

  it('close sets or shortens, never extends; the same day is UNCHANGED; VOID or before validFrom are refused', () => {
    const open = ownership('anna', [1, 2], '2026-08-01');
    expect(planClose(open, day('2030-12-31'))).toMatchObject({ kind: 'CLOSE', next: { validUntil: '2030-12-31', version: 2 } });
    expect(planClose(open, day('2026-08-01'))).toMatchObject({ kind: 'CLOSE' });
    expect(planClose(open, day('2026-07-31'))).toEqual({ kind: 'INVALID_OWNERSHIP', reason: 'STARTS_ON_OR_AFTER_EFFECTIVE_DATE' });
    const ending = { ...open, validUntil: day('2035-03-31') };
    expect(planClose(ending, day('2030-12-31'))).toMatchObject({ kind: 'CLOSE', next: { validUntil: '2030-12-31' } });
    expect(planClose(ending, day('2035-03-31'))).toEqual({ kind: 'UNCHANGED' });
    expect(planClose(ending, day('2035-04-01'))).toEqual({ kind: 'INVALID_OWNERSHIP', reason: 'ALREADY_ENDED' });
    expect(planClose({ ...open, status: 'VOID' }, day('2030-12-31'))).toEqual({ kind: 'INVALID_OWNERSHIP', reason: 'VOID' });
  });

  it('void once; a repeat is UNCHANGED, keeping the first reason', () => {
    const o = ownership('anna', [1, 2], '2026-08-01');
    const at = new Date('2026-10-22T10:00:00Z');
    expect(planVoid(o, 'Tippfehler', at)).toEqual({ kind: 'VOID', next: { ...o, status: 'VOID', voidedAt: at, voidReason: 'Tippfehler', version: 2 } });
    expect(planVoid({ ...o, status: 'VOID' }, 'anders', at)).toEqual({ kind: 'UNCHANGED' });
  });
});
