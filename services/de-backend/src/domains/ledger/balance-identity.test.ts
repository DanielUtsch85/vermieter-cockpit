import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { balanceIdentityKey, canonicalBalance, inFileContinuity, previousExport, uniqueBalanceIdentities } from './balance-identity.js';
import type { ParsedRow } from './bank-statement.js';
import type { BusinessDate } from './transaction.js';

/** A data row: a signed amount and the balance after it. */
function row(position: number, bookingDate: string, signed: string, balanceAfter: string | null): ParsedRow {
  const negative = signed.startsWith('-');
  return {
    kind: 'ROW',
    position,
    sourceRowId: null,
    contentFingerprint: `fp-${position}`,
    row: {
      bookingDate: bookingDate as BusinessDate,
      valueDate: null,
      amount: Money.of(negative ? signed.slice(1) : signed, 'EUR'),
      direction: negative ? 'OUTFLOW' : 'INFLOW',
      counterpartyIbanRaw: null,
      counterpartyNameRaw: null,
      description: 'x',
      externalTransactionId: null,
      balanceAfter,
    },
  };
}

describe('balance identity (data-model.md §70.6)', () => {
  it('the key is date, amount, direction and balance; the balance in the currency scale', () => {
    const key = (balanceAfter: string, direction: 'INFLOW' | 'OUTFLOW' = 'OUTFLOW') =>
      balanceIdentityKey({ bookingDate: '2026-10-01' as BusinessDate, amount: Money.of('9.96', 'EUR'), direction, balanceAfter });
    expect(key('5.1')).toBe(key('5.10'));
    expect(key('5.10')).not.toBe(key('5.11'));
    expect(key('5.10')).not.toBe(key('5.10', 'INFLOW'));
    expect(canonicalBalance('-0', 'EUR')).toBe('0.00');
    expect(canonicalBalance('-12.5', 'EUR')).toBe('-12.50');
  });

  it('only an identity unique in its file is used: a debit, its return and the debit again leave both debits out', () => {
    const rows = [
      row(1, '2026-10-01', '-100.00', '900.00'),
      row(2, '2026-10-01', '100.00', '1000.00'),
      row(3, '2026-10-01', '-100.00', '900.00'),
      row(4, '2026-10-02', '-5.00', null),
    ];
    expect([...uniqueBalanceIdentities(rows)]).toEqual([2]);
  });
});

describe('continuity (data-model.md §70.6)', () => {
  const oldestFirst = [row(1, '2026-09-01', '-10.00', '90.00'), row(2, '2026-09-02', '-20.00', '70.00'), row(3, '2026-09-03', '5.00', '75.00')];

  it('a chained file, oldest first or newest first: no break; the oldest row and its balance before', () => {
    expect(inFileContinuity(oldestFirst)).toEqual({
      order: 'OLDEST_FIRST',
      breaks: [],
      oldest: { position: 1, bookingDate: '2026-09-01', identityKey: expect.any(String), balanceBefore: '100.00' },
    });
    const newestFirst = [...oldestFirst].reverse().map((r, i) => ({ ...r, position: i + 1 }));
    expect(inFileContinuity(newestFirst)).toMatchObject({ order: 'NEWEST_FIRST', breaks: [], oldest: { position: 3, balanceBefore: '100.00' } });
  });

  it('a filtered file breaks where bookings are missing; the break names the expected and the actual balance', () => {
    const filtered = [row(1, '2026-09-01', '-10.00', '90.00'), row(2, '2026-09-05', '-20.00', '50.00'), row(3, '2026-09-06', '5.00', '55.00')];
    expect(inFileContinuity(filtered)?.breaks).toEqual([{ position: 2, expectedBalanceAfter: '70.00', balanceAfter: '50.00' }]);
  });

  it('one day only: the order with fewer breaks; rows without a balance are left out; none at all: no report', () => {
    const sameDay = [row(1, '2026-09-01', '-20.00', '70.00'), row(2, '2026-09-01', '-10.00', '90.00'), row(3, '2026-09-01', '1.00', null)];
    expect(inFileContinuity(sameDay)).toMatchObject({ order: 'NEWEST_FIRST', breaks: [], oldest: { position: 2, balanceBefore: '100.00' } });
    expect(inFileContinuity([row(1, '2026-09-01', '1.00', null)])).toBeUndefined();
  });

  it('previous export: an imported oldest row overlaps, a known balance before chains, other balances mean a gap', () => {
    expect(previousExport({ oldestImported: true, continuesFromKnown: false, anyEarlierBalance: true })).toBe('OVERLAPS');
    expect(previousExport({ oldestImported: false, continuesFromKnown: true, anyEarlierBalance: true })).toBe('CHAINS');
    expect(previousExport({ oldestImported: false, continuesFromKnown: false, anyEarlierBalance: true })).toBe('GAP');
    expect(previousExport({ oldestImported: false, continuesFromKnown: false, anyEarlierBalance: false })).toBe('NO_EARLIER_BALANCE');
  });
});
