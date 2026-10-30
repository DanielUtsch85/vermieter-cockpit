import { describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../shared/index.js';
import {
  changedEntries,
  dueDayOn,
  planReferenceAmend,
  referenceFingerprint,
  rentDueDaysError,
  type RentDueDay,
  type RentalContractReference,
  type RentalContractReferenceId,
} from './reference.js';

/** VC-7-02 (api-design.md §58A): the due days over time, their checks, the changed entries of an amend. Figures are invented. */
const day = (value: string) => value as BusinessDate;
const due = (entries: [string, number][]): RentDueDay[] => entries.map(([validFrom, d]) => ({ validFrom: day(validFrom), day: d }));

const reference = (overrides: Partial<RentalContractReference> = {}): RentalContractReference => ({
  id: 'r-1' as RentalContractReferenceId,
  mreRealmId: 'realm',
  mreTenantId: '6512f0c2a1b2c3d4e5f6a7b8',
  rentDueDays: due([
    ['2025-01-01', 3],
    ['2028-01-01', 15],
  ]),
  notes: null,
  sourceReferences: [],
  createdAt: new Date('2026-10-30T10:00:00Z'),
  createdBy: 'anna@example.com',
  version: 1,
  ...overrides,
});

describe('rentDueDays (§58A)', () => {
  it('a term takes the entry with the latest validFrom on or before its first day; before the first entry none', () => {
    const days = reference().rentDueDays;
    expect(dueDayOn(days, day('2027-01-01'))).toBe(3);
    expect(dueDayOn(days, day('2028-01-01'))).toBe(15);
    expect(dueDayOn(days, day('2029-01-01'))).toBe(15);
    expect(dueDayOn(days, day('2024-12-01'))).toBeUndefined();
    expect(dueDayOn([], day('2027-01-01'))).toBeUndefined();
  });

  it('validFrom unique and ascending, each day 1–31, at most 20 entries', () => {
    expect(rentDueDaysError(reference().rentDueDays)).toBeUndefined();
    expect(rentDueDaysError([])).toBeUndefined();
    expect(
      rentDueDaysError(
        due([
          ['2028-01-01', 15],
          ['2025-01-01', 3],
        ]),
      ),
    ).toEqual({ index: 1, code: 'NOT_ASCENDING' });
    expect(
      rentDueDaysError(
        due([
          ['2025-01-01', 3],
          ['2025-01-01', 4],
        ]),
      ),
    ).toEqual({ index: 1, code: 'NOT_ASCENDING' });
    expect(rentDueDaysError(due([['2025-01-01', 0]]))).toEqual({ index: 0, code: 'OUT_OF_RANGE' });
    expect(rentDueDaysError(due([['2025-01-01', 32]]))).toEqual({ index: 0, code: 'OUT_OF_RANGE' });
    const many = Array.from({ length: 21 }, (_, i) => ({ validFrom: day(`${2000 + i}-01-01`), day: 1 }));
    expect(rentDueDaysError(many.slice(0, 20))).toBeUndefined();
    expect(rentDueDaysError(many)).toEqual({ index: 20, code: 'OUT_OF_RANGE' });
  });
});

describe('amend (§58A)', () => {
  it('the changed entries: changed, removed and added, by validFrom; the same values are a no-op', () => {
    const current = reference();
    expect(planReferenceAmend(current, { rentDueDays: current.rentDueDays, notes: null, sourceReferences: [] })).toEqual({
      changedFields: [],
      changedEntries: [],
    });
    const next = due([
      ['2025-01-01', 5],
      ['2030-01-01', 1],
    ]);
    expect(changedEntries(current.rentDueDays, next)).toEqual([
      { validFrom: '2025-01-01', from: 3, to: 5 },
      { validFrom: '2028-01-01', from: 15, to: null },
      { validFrom: '2030-01-01', from: null, to: 1 },
    ]);
    expect(planReferenceAmend(current, { rentDueDays: next, notes: 'Nachtrag', sourceReferences: ['Nachtrag 1'] }).changedFields).toEqual([
      'rentDueDays',
      'notes',
      'sourceReferences',
    ]);
  });

  it('the fingerprint is the normalized body with the Tenant', () => {
    const a = referenceFingerprint(reference());
    expect(a).toBe(referenceFingerprint(reference({ id: 'other' as RentalContractReferenceId, version: 4 })));
    expect(a).not.toBe(referenceFingerprint({ ...reference(), rentDueDays: [] }));
  });
});
