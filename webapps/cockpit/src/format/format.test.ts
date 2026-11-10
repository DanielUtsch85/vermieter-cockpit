import { describe, expect, it } from 'vitest';
import { formatBusinessDate, formatTimestamp } from './dates';
import { formatDecimal, formatMoney, formatTransactionAmount, negateDecimal } from './money';

const NBSP = '\u00a0';
const eur = (amount: string) => formatMoney({ amount, currency: 'EUR' });

describe('MoneyText formatting from the API string (ui-guide.md §5.2), de-DE', () => {
  it('formats the API amount with thousands points, a decimal comma and the euro sign', () => {
    expect(eur('850.00')).toBe(`850,00${NBSP}€`);
    expect(eur('1234.56')).toBe(`1.234,56${NBSP}€`);
    expect(eur('1000000.00')).toBe(`1.000.000,00${NBSP}€`);
    expect(eur('0.00')).toBe(`0,00${NBSP}€`);
    expect(eur('999.99')).toBe(`999,99${NBSP}€`);
  });

  it('never rounds: every digit of the string is shown, missing places are padded to two', () => {
    expect(eur('0.995')).toBe(`0,995${NBSP}€`);
    expect(eur('2.675')).toBe(`2,675${NBSP}€`);
    expect(eur('1.005')).toBe(`1,005${NBSP}€`);
    expect(eur('0.1')).toBe(`0,10${NBSP}€`);
    expect(eur('7')).toBe(`7,00${NBSP}€`);
  });

  it('negative values keep their minus; a negative zero is zero', () => {
    expect(eur('-12.30')).toBe(`-12,30${NBSP}€`);
    expect(eur('-1234567.89')).toBe(`-1.234.567,89${NBSP}€`);
    expect(eur('-0.00')).toBe(`0,00${NBSP}€`);
    expect(eur('-0')).toBe(`0,00${NBSP}€`);
  });

  it('large values with the backend limit of 18 integer digits stay exact (beyond 2^53 cents)', () => {
    expect(eur('999999999999999999.99')).toBe(`999.999.999.999.999.999,99${NBSP}€`);
    expect(eur('123456789012345678.01')).toBe(`123.456.789.012.345.678,01${NBSP}€`);
    expect(eur('-900719925474099.93')).toBe(`-900.719.925.474.099,93${NBSP}€`);
    // Number would have lost the last digits here: the string formatting does not.
    expect(String(Number('999999999999999999.99'))).not.toBe('999999999999999999.99');
  });

  it('within the exact range of Number it says the same as Intl.NumberFormat of the browser', () => {
    const intl = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
    for (const amount of ['0.00', '0.01', '5.10', '850.00', '1234.56', '-12.30', '-1234.50', '1000000.00', '99999999.99']) {
      expect(eur(amount)).toBe(intl.format(Number(amount)));
    }
  });

  it('leading zeros are dropped, other currencies are named by their code', () => {
    expect(eur('0007.50')).toBe(`7,50${NBSP}€`);
    expect(formatMoney({ amount: '10.00', currency: 'CHF' })).toBe(`10,00${NBSP}CHF`);
  });

  it('anything that is not a decimal string or a currency code is unreadable, never a guess', () => {
    for (const amount of ['', '1,50', '1.234,56', '1e3', '+1.00', ' 1.00', '1.', '.5', 'NaN', '0x10', '1 000.00']) {
      expect(eur(amount), amount).toBeUndefined();
    }
    expect(formatMoney({ amount: '1.00', currency: 'eur' })).toBeUndefined();
    expect(formatMoney({ amount: '1.00', currency: '' })).toBeUndefined();
    expect(formatDecimal('abc')).toBeUndefined();
  });

  it('the direction gives the sign of a Transaction: out is minus, in is without sign', () => {
    expect(formatTransactionAmount({ amount: '850.00', currency: 'EUR' }, 'OUTFLOW')).toBe(`-850,00${NBSP}€`);
    expect(formatTransactionAmount({ amount: '850.00', currency: 'EUR' }, 'INFLOW')).toBe(`850,00${NBSP}€`);
    expect(formatTransactionAmount({ amount: '0.00', currency: 'EUR' }, 'OUTFLOW')).toBe(`0,00${NBSP}€`);
    // An unknown direction adds no sign: nothing is invented.
    expect(formatTransactionAmount({ amount: '1.00', currency: 'EUR' }, 'SIDEWAYS')).toBe(`1,00${NBSP}€`);
    expect(negateDecimal('-5.00')).toBe('5.00');
    expect(negateDecimal('5.00')).toBe('-5.00');
  });
});

describe('DateText (ui-guide.md §5.2)', () => {
  it('a business date is rearranged as text and does not move with the time zone', () => {
    expect(formatBusinessDate('2026-03-01')).toBe('01.03.2026');
    expect(formatBusinessDate('1900-01-01')).toBe('01.01.1900');
    expect(formatBusinessDate('2100-12-31')).toBe('31.12.2100');
    // The same day whatever the zone: no Date is involved (a UTC midnight would be 31.12. in America).
    const zone = process.env['TZ'];
    for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
      process.env['TZ'] = tz;
      expect(formatBusinessDate('2027-01-01')).toBe('01.01.2027');
      // Counter-check: the trap this avoids. Through Date (UTC midnight), Los Angeles shows the day before.
      if (tz === 'America/Los_Angeles') expect(new Date('2027-01-01').toLocaleDateString('de-DE')).toBe('31.12.2026');
    }
    if (zone === undefined) delete process.env['TZ'];
    else process.env['TZ'] = zone;
  });

  it('anything else is unreadable', () => {
    for (const value of ['', '2026-3-1', '01.03.2026', '2026-03-01T00:00:00Z', '20260301']) expect(formatBusinessDate(value), value).toBeUndefined();
  });

  it('a timestamp is shown in Europe/Berlin, across midnight and the change to summer time', () => {
    expect(formatTimestamp('2026-03-31T23:30:00.000Z')).toBe('01.04.2026, 01:30');
    expect(formatTimestamp('2026-01-15T23:30:00.000Z')).toBe('16.01.2026, 00:30');
    expect(formatTimestamp('2026-03-29T00:59:00.000Z')).toBe('29.03.2026, 01:59');
    expect(formatTimestamp('2026-03-29T01:00:00.000Z')).toBe('29.03.2026, 03:00');
    expect(formatTimestamp('not a time')).toBeUndefined();
  });
});
