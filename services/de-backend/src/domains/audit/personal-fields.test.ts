import { describe, expect, it } from 'vitest';
import { PARTY_FIELDS } from '../party/index.js';
import {
  AUDIT_MARKER,
  AUDIT_MARKER_PATTERN,
  AUDIT_PERSONAL_FIELDS,
  AUDIT_RETENTION_YEARS,
  auditDueFrom,
  auditRetentionCutoff,
  auditRetentionEndsOn,
  berlinStartOfYear,
  berlinYear,
  isAuditRecordDue,
  pseudonymiseAuditMetadata,
} from './index.js';

/**
 * VC-X-24 (api-design.md §58U rules 1–3; Entscheidung des Projektinhabers, 2026-11-06): the creation year in
 * Europe/Berlin on both sides of midnight UTC, of a daylight-saving change and of 29 February; due exactly from
 * `01.01.(Y + 11) 00:00` Berlin, not one millisecond before; the marker replaces only the listed, non-null values. No
 * database. Synthetic values only.
 */
const t = (iso: string) => new Date(iso);
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

describe('the creation year in Europe/Berlin', () => {
  it('31.12 23:30 UTC is already 1 January in Berlin: the record is of the next year', () => {
    expect(berlinYear(t('2026-12-31T23:30:00Z'))).toBe(2027);
    expect(berlinYear(t('2026-12-31T22:59:59.999Z'))).toBe(2026);
    expect(berlinYear(t('2026-12-31T23:00:00.000Z'))).toBe(2027);
  });

  it('counter-check: the same instants read in UTC give the old year (the year boundary differs between UTC and Berlin)', () => {
    expect(t('2026-12-31T23:30:00Z').getUTCFullYear()).toBe(2026);
    expect(berlinYear(t('2027-01-01T00:30:00+01:00'))).toBe(2027);
  });

  it('a daylight-saving change does not move the year; midsummer midnight lies at 22:00 UTC', () => {
    expect(berlinYear(t('2026-03-29T00:30:00Z'))).toBe(2026);
    expect(berlinYear(t('2026-10-25T01:30:00Z'))).toBe(2026);
    expect(berlinStartOfYear(2027).toISOString()).toBe('2026-12-31T23:00:00.000Z');
  });

  it('29 February of a leap year is of that year and its retention ends on 31.12 ten years later', () => {
    const leap = t('2028-02-29T12:00:00Z');
    expect([berlinYear(leap), auditRetentionEndsOn(leap), auditDueFrom(leap).toISOString()]).toEqual([2028, '2038-12-31', '2038-12-31T23:00:00.000Z']);
    expect(isAuditRecordDue(leap, t('2038-12-31T22:59:59.999Z'))).toBe(false);
    expect(isAuditRecordDue(leap, t('2038-12-31T23:00:00.000Z'))).toBe(true);
    // 29 February 2036, inside retention: not due.
    expect(isAuditRecordDue(leap, t('2036-02-29T12:00:00Z'))).toBe(false);
  });
});

describe('ten years from the end of the creation year', () => {
  const record = t('2026-03-05T09:00:00Z');

  it('the spec example: created 2026-03-05, retention to 31.12.2036, due from 01.01.2037 00:00 Berlin', () => {
    expect(AUDIT_RETENTION_YEARS).toBe(10);
    expect([auditRetentionEndsOn(record), auditDueFrom(record).toISOString()]).toEqual(['2036-12-31', '2036-12-31T23:00:00.000Z']);
  });

  it('due exactly at 01.01.(Y + 11) 00:00 Berlin, not one millisecond before', () => {
    const due = auditDueFrom(record);
    expect(isAuditRecordDue(record, due)).toBe(true);
    expect(isAuditRecordDue(record, ms(due, -1))).toBe(false);
    expect(isAuditRecordDue(record, ms(due, 1))).toBe(true);
  });

  it('counter-check: one year early (01.01.(Y + 10)) and at the end of retention it is not due', () => {
    expect(isAuditRecordDue(record, t('2036-01-01T00:00:00+01:00'))).toBe(false);
    expect(isAuditRecordDue(record, t('2036-12-31T23:59:59.999+01:00'))).toBe(false);
  });

  it('a record written at 01.01.(Y) 00:00 Berlin exactly is of year Y; one millisecond before it is of Y − 1', () => {
    const start = berlinStartOfYear(2027);
    const now = t('2037-06-01T12:00:00Z');
    expect([berlinYear(start), isAuditRecordDue(start, now)]).toEqual([2027, false]);
    expect([berlinYear(ms(start, -1)), isAuditRecordDue(ms(start, -1), now)]).toEqual([2026, true]);
  });

  it('the record of 31.12.2026 23:30 UTC is of 2027 and due from 01.01.2038, not 2037', () => {
    const late = t('2026-12-31T23:30:00Z');
    expect([auditRetentionEndsOn(late), auditDueFrom(late).toISOString()]).toEqual(['2037-12-31', '2037-12-31T23:00:00.000Z']);
    expect(isAuditRecordDue(late, t('2037-06-01T00:00:00Z'))).toBe(false);
  });

  it('the cutoff at now is 01.01.(N − 10) 00:00 Berlin; no record written in 2026 is due before 2037', () => {
    expect(auditRetentionCutoff(t('2037-01-01T00:00:00+01:00')).toISOString()).toBe('2026-12-31T23:00:00.000Z');
    expect(auditRetentionCutoff(t('2036-12-31T23:59:59.999+01:00')).toISOString()).toBe('2025-12-31T23:00:00.000Z');
    expect(isAuditRecordDue(t('2026-11-06T12:00:00Z'), t('2036-12-31T22:59:59.999Z'))).toBe(false);
  });
});

describe('the marker replaces the personal values', () => {
  it('the allow-list is the seven Party fields, exactly those amend may change, and no other entity type', () => {
    expect(AUDIT_PERSONAL_FIELDS).toEqual({ Party: [...PARTY_FIELDS] });
    expect(AUDIT_MARKER).toBe('[entfernt:v1]');
    expect([AUDIT_MARKER_PATTERN.test(AUDIT_MARKER), AUDIT_MARKER_PATTERN.test('[entfernt:v2]'), AUDIT_MARKER_PATTERN.test('[entfernt]')]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('each from and to of every listed field is replaced; null stays null; the keys and field names stay', () => {
    const metadata = {
      changes: {
        displayName: { from: 'Erika Beispiel', to: 'Erika Muster' },
        firstName: { from: 'Erika', to: 'Eri' },
        lastName: { from: 'Beispiel', to: 'Muster' },
        legalName: { from: null, to: 'Beispiel GmbH (synthetisch)' },
        registrationNumber: { from: 'HRB 0000', to: null },
        email: { from: 'erika.alt@example.org', to: 'erika.neu@example.org' },
        phone: { from: '+49 30 0000000', to: '+49 30 0000001' },
      },
    };
    const copy = structuredClone(metadata);
    const result = pseudonymiseAuditMetadata('Party', metadata);
    const m = AUDIT_MARKER;
    expect(result?.metadata).toEqual({
      changes: {
        displayName: { from: m, to: m },
        firstName: { from: m, to: m },
        lastName: { from: m, to: m },
        legalName: { from: null, to: m },
        registrationNumber: { from: m, to: null },
        email: { from: m, to: m },
        phone: { from: m, to: m },
      },
    });
    expect(result?.paths).toEqual([
      'changes.displayName.from',
      'changes.displayName.to',
      'changes.firstName.from',
      'changes.firstName.to',
      'changes.lastName.from',
      'changes.lastName.to',
      'changes.legalName.to',
      'changes.registrationNumber.from',
      'changes.email.from',
      'changes.email.to',
      'changes.phone.from',
      'changes.phone.to',
    ]);
    expect(metadata).toEqual(copy);
  });

  it('a key outside the list stays as written, at every level', () => {
    const metadata = { changes: { email: { from: 'a@example.org', to: 'b@example.org', note: 'bleibt' }, status: { from: 'x', to: 'y' } }, other: 'bleibt' };
    expect(pseudonymiseAuditMetadata('Party', metadata)?.metadata).toEqual({
      changes: { email: { from: AUDIT_MARKER, to: AUDIT_MARKER, note: 'bleibt' }, status: { from: 'x', to: 'y' } },
      other: 'bleibt',
    });
  });

  it('nothing to replace: another entity type, no listed field, only null values or markers', () => {
    expect(pseudonymiseAuditMetadata('Weg', { changes: { displayName: { from: 'WEG Beispielweg 1', to: 'WEG Beispielweg 2' } } })).toBeUndefined();
    expect(pseudonymiseAuditMetadata('Loan', { changes: { notes: { from: 'Notiz', to: null } } })).toBeUndefined();
    expect(pseudonymiseAuditMetadata('Party', { changes: { email: { from: null, to: null } } })).toBeUndefined();
    expect(pseudonymiseAuditMetadata('Party', { changes: { email: { from: AUDIT_MARKER, to: AUDIT_MARKER } } })).toBeUndefined();
    expect(pseudonymiseAuditMetadata('Party', null)).toBeUndefined();
    expect(pseudonymiseAuditMetadata('Party', { changes: [] })).toBeUndefined();
  });

  it('counter-check: the same record of a Party with one value is replaced', () => {
    expect(pseudonymiseAuditMetadata('Party', { changes: { email: { from: null, to: 'c@example.org' } } })).toEqual({
      metadata: { changes: { email: { from: null, to: AUDIT_MARKER } } },
      paths: ['changes.email.to'],
    });
  });
});
