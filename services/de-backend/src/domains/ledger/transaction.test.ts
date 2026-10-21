import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import {
  checkBusinessDate,
  checkPosting,
  checkVersion,
  manualTransactionFingerprint,
  parseBusinessDate,
  type BusinessDate,
  type FinancialAccount,
  type FinancialAccountId,
  type NewManualTransaction,
} from './index.js';

const REALM = '64b0c0ffee0000000000000a';
const account: FinancialAccount = {
  id: '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b' as FinancialAccountId,
  mreRealmId: REALM,
  accountType: 'BANK',
  displayName: 'Girokonto',
  currency: 'EUR',
  iban: null,
  status: 'OPEN',
  createdAt: new Date('2026-10-19T08:00:00Z'),
  closedAt: null,
  version: 1,
};
const rent: NewManualTransaction = {
  mreRealmId: REALM,
  financialAccountId: account.id,
  amount: Money.of('1250.00', 'EUR'),
  direction: 'INFLOW',
  bookingDate: '2026-09-01' as BusinessDate,
  valueDate: null,
  description: 'Miete September',
  propertyReferenceId: null,
};

describe('parseBusinessDate', () => {
  it.each(['2026-09-01', '2024-02-29', '1999-12-31'])('accepts %s', (value) => {
    expect(parseBusinessDate(value)).toBe(value);
  });

  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '2026-9-1', '2026-09-01T00:00:00Z', '01.09.2026', ''])(
    'rejects %j',
    (value) => {
      expect(parseBusinessDate(value)).toBeUndefined();
      expect(checkBusinessDate(value)).toEqual({ error: 'INVALID_FORMAT' });
    },
  );

  it.each([
    ['0202-03-01', 'a typo year (would book into the year 202)'],
    ['0050-01-01', 'a two-digit year (no Date.UTC mapping to 1950)'],
    ['1850-01-01', 'before 1900'],
    ['2101-01-01', 'after 2100'],
  ])('%s is OUT_OF_RANGE: %s', (value) => {
    expect(checkBusinessDate(value)).toEqual({ error: 'OUT_OF_RANGE' });
  });

  it.each(['1900-01-01', '2100-12-31'])('accepts the bound %s', (value) => {
    expect(checkBusinessDate(value)).toEqual({ date: value });
  });

  it('years below 100 are judged as themselves, not as 19xx', () => {
    // Year 48 is a leap year, year 50 is not; Date.UTC would have checked 1948 and 1950 instead.
    expect(checkBusinessDate('0048-02-29')).toEqual({ error: 'OUT_OF_RANGE' });
    expect(checkBusinessDate('0050-02-29')).toEqual({ error: 'INVALID_FORMAT' });
  });
});

describe('checkPosting', () => {
  it('accepts an open account of the same Realm and currency', () => {
    expect(checkPosting(account, rent)).toBeUndefined();
  });

  it.each([
    ['no account', undefined, 'ACCOUNT_NOT_FOUND'],
    ["another Realm's account", { ...account, mreRealmId: '64b0c0ffee0000000000000b' }, 'ACCOUNT_NOT_FOUND'],
    ['a closed account', { ...account, status: 'CLOSED' as const, closedAt: new Date() }, 'ACCOUNT_CLOSED'],
  ])('rejects %s', (_label, candidate, reason) => {
    expect(checkPosting(candidate, rent)).toBe(reason);
  });
});

describe('manualTransactionFingerprint', () => {
  it('ignores id case and amount notation, and differs on any business field', () => {
    const base = manualTransactionFingerprint(rent);
    expect(manualTransactionFingerprint({ ...rent, financialAccountId: rent.financialAccountId.toUpperCase() })).toBe(base);
    expect(manualTransactionFingerprint({ ...rent, amount: Money.of('1250', 'EUR') })).toBe(base);
    for (const change of [
      { amount: Money.of('1250.01', 'EUR') },
      { direction: 'OUTFLOW' as const },
      { bookingDate: '2026-09-02' as BusinessDate },
      { valueDate: '2026-09-01' as BusinessDate },
      { description: null },
      { propertyReferenceId: 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f' },
    ]) {
      expect(manualTransactionFingerprint({ ...rent, ...change })).not.toBe(base);
    }
  });
});

describe('checkVersion (api-design.md §16)', () => {
  it('no expected version, or the current one, passes; another one is a conflict naming both', () => {
    expect(checkVersion(3, undefined)).toBeUndefined();
    expect(checkVersion(3, 3)).toBeUndefined();
    expect(checkVersion(3, 2)).toEqual({ kind: 'VERSION_CONFLICT', expectedVersion: 2, currentVersion: 3 });
    expect(checkVersion(3, 4)).toEqual({ kind: 'VERSION_CONFLICT', expectedVersion: 4, currentVersion: 3 });
  });
});
