import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import {
  checkPosting,
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
    },
  );
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
