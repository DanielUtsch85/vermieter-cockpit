import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { ownershipStart, type Acquisition, type AcquisitionId } from './acquisition.js';
import { ownershipStartFlag, planRecordTransferDate, recordTransferDateFingerprint } from './transfer-date.js';

/**
 * §58N (VC-X-52; Entscheidung des Projektinhabers, 2026-11-04, Fragen 1–5): the command's plan in its order of checks,
 * `ownershipStart` (option (b)) and the flag. Synthetic values only.
 */
const day = (value: string) => value as BusinessDate;
const AT = new Date('2026-11-04T10:00:00Z');
const legacy: Acquisition = {
  id: 'a1' as AcquisitionId,
  mreRealmId: 'r',
  propertyReferenceId: 'pr',
  status: 'CONFIRMED',
  purchasePrice: Money.of('200000.00', 'EUR'),
  acquiredShare: { numerator: 1, denominator: 1 },
  contractDate: day('2025-03-01'),
  economicTransferDate: null,
  landRegistryTransferDate: null,
  buyerPartyIds: ['a'],
  sellerPartyIds: ['s'],
  sourceReferences: ['Kaufvertrag (synthetisch)'],
  notes: null,
  cancelledAt: null,
  cancellationReason: null,
  confirmedAt: new Date('2025-03-05T09:00:00Z'),
  createdAt: new Date('2025-02-20T09:00:00Z'),
  version: 2,
  economicTransferRecordedAt: null,
  economicTransferSourceReferences: null,
  flags: [],
};
const body = { economicTransferDate: day('2025-05-01'), sourceReferences: ['Übergabeprotokoll 2025-05-01 (synthetisch)'], notes: null };

describe('recording the economic transfer date (§58N)', () => {
  it('a CONFIRMED and a DRAFT take the same command: the date, its time and evidence, version + 1, status and confirmedAt unchanged', () => {
    for (const current of [legacy, { ...legacy, status: 'DRAFT' as const, confirmedAt: null, version: 1 }]) {
      const plan = planRecordTransferDate(current, body, AT);
      expect(plan).toEqual({
        kind: 'RECORD',
        next: {
          ...current,
          economicTransferDate: '2025-05-01',
          economicTransferRecordedAt: AT,
          economicTransferSourceReferences: ['Übergabeprotokoll 2025-05-01 (synthetisch)'],
          version: current.version + 1,
        },
      });
    }
  });

  it('the order of checks: CANCELLED before a stale version and an early date; already set before the version; the version before 422', () => {
    const cancelled = { ...legacy, status: 'CANCELLED' as const, confirmedAt: null, cancelledAt: AT, cancellationReason: 'x' };
    expect(planRecordTransferDate(cancelled, { ...body, economicTransferDate: day('2025-01-01') }, AT, [9])).toEqual({ kind: 'ACQUISITION_CANCELLED' });
    const dated = { ...legacy, economicTransferDate: day('2025-05-01') };
    // Also with the same date: a set date is never confirmed again.
    expect(planRecordTransferDate(dated, body, AT, [9])).toEqual({ kind: 'TRANSFER_DATE_ALREADY_SET', economicTransferDate: '2025-05-01' });
    expect(planRecordTransferDate(dated, { ...body, economicTransferDate: day('2025-06-01') }, AT)).toEqual({
      kind: 'TRANSFER_DATE_ALREADY_SET',
      economicTransferDate: '2025-05-01',
    });
    expect(planRecordTransferDate(legacy, { ...body, economicTransferDate: day('2025-01-01') }, AT, [1])).toEqual({
      kind: 'VERSION_CONFLICT',
      expectedVersions: [1],
      currentVersion: 2,
    });
    expect(planRecordTransferDate(legacy, { ...body, economicTransferDate: day('2025-02-28') }, AT, [2])).toEqual({
      kind: 'BEFORE_CONTRACT_DATE',
      contractDate: '2025-03-01',
    });
  });

  it('the edges: the transfer on the contract date accepted, one day before refused, a date after today accepted', () => {
    expect(planRecordTransferDate(legacy, { ...body, economicTransferDate: day('2025-03-01') }, AT).kind).toBe('RECORD');
    expect(planRecordTransferDate(legacy, { ...body, economicTransferDate: day('2025-02-28') }, AT).kind).toBe('BEFORE_CONTRACT_DATE');
    expect(planRecordTransferDate(legacy, { ...body, economicTransferDate: day('2031-12-31') }, AT).kind).toBe('RECORD');
  });

  it('the fingerprint: the id lower-case, the date, the evidence as given and the notes', () => {
    expect(recordTransferDateFingerprint('A1', body)).toBe(recordTransferDateFingerprint('a1', body));
    expect(recordTransferDateFingerprint('a1', body)).not.toBe(recordTransferDateFingerprint('a1', { ...body, notes: 'n' }));
    expect(recordTransferDateFingerprint('a1', body)).not.toBe(recordTransferDateFingerprint('a1', { ...body, sourceReferences: ['other'] }));
  });
});

describe('ownershipStart and the flag (§58N option (b), Frage 5)', () => {
  it('ownershipStart: undated the contract date, created with a date that date, recorded later the contract date', () => {
    expect(ownershipStart(legacy)).toBe('2025-03-01');
    expect(ownershipStart({ ...legacy, economicTransferDate: day('2025-05-01') })).toBe('2025-05-01');
    expect(ownershipStart({ ...legacy, economicTransferDate: day('2025-05-01'), economicTransferRecordedAt: AT })).toBe('2025-03-01');
  });

  it('the flag only when the dates differ and not cancelled: OPEN with a seller holding an AfA component, INFORMATIVE without', () => {
    const recorded = { ...legacy, economicTransferDate: day('2025-05-01'), economicTransferRecordedAt: AT };
    const details = { acquisitionId: 'a1', ownershipStart: '2025-03-01', economicTransferDate: '2025-05-01' };
    expect(ownershipStartFlag(recorded, true)).toEqual({ code: 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER', level: 'OPEN', details });
    expect(ownershipStartFlag(recorded, false)).toEqual({ code: 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER', level: 'INFORMATIVE', details });
    // Equal dates, a date set on create, no date: no flag.
    expect(ownershipStartFlag({ ...recorded, economicTransferDate: day('2025-03-01') }, true)).toBeNull();
    expect(ownershipStartFlag({ ...recorded, economicTransferRecordedAt: null }, true)).toBeNull();
    expect(ownershipStartFlag(legacy, true)).toBeNull();
    // A DRAFT dated, then cancelled: no flag at either level.
    const cancelled = { ...recorded, status: 'CANCELLED' as const, confirmedAt: null };
    expect([ownershipStartFlag(cancelled, true), ownershipStartFlag(cancelled, false)]).toEqual([null, null]);
    // Counter-check: the same as DRAFT carries it.
    expect(ownershipStartFlag({ ...cancelled, status: 'DRAFT' }, true)?.level).toBe('OPEN');
  });
});
