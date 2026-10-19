import { describe, expect, it } from 'vitest';
import { createFingerprint, planClose, type FinancialAccount, type FinancialAccountId } from './index.js';

const open: FinancialAccount = {
  id: 'fa-1' as FinancialAccountId,
  mreRealmId: '64b0c0ffee0000000000000a',
  accountType: 'BANK',
  displayName: 'Girokonto',
  currency: 'EUR',
  iban: 'DE89370400440532013000',
  status: 'OPEN',
  createdAt: new Date('2026-10-19T08:00:00Z'),
  closedAt: null,
  version: 1,
};
const at = new Date('2026-12-31T12:00:00Z');

describe('planClose', () => {
  it('closes an open account, keeping it and bumping the version', () => {
    expect(planClose(open, at)).toEqual({ next: { ...open, status: 'CLOSED', closedAt: at, version: 2 }, changed: true });
  });

  it('closing a closed account is a no-op (safe retry)', () => {
    const closed = planClose(open, at).next;
    expect(planClose(closed, new Date('2027-01-01T00:00:00Z'))).toEqual({ next: closed, changed: false });
  });
});

describe('createFingerprint', () => {
  const draft = { mreRealmId: open.mreRealmId, accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR', iban: null } as const;

  it('is equal for equal normalized payloads and differs on any field', () => {
    expect(createFingerprint(draft)).toBe(createFingerprint({ ...draft }));
    for (const change of [{ accountType: 'CASH' }, { displayName: 'Tagesgeld' }, { iban: 'DE89370400440532013000' }] as const) {
      expect(createFingerprint({ ...draft, ...change })).not.toBe(createFingerprint(draft));
    }
  });
});
