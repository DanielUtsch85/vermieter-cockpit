import { describe, expect, it } from 'vitest';
import { addCents, centsToDecimal, compareCents, decimalToCents, decimalToInput, differenceAsDecimal, parseAmountInput } from './split-amount';

const ok = (amount: string, cents: string) => ({ ok: true, amount, cents });
const refused = (problem: string) => ({ ok: false, problem });

describe('step 3, amount input of a split (ui-guide.md §5.2: German input, normalised explicitly, never guessed)', () => {
  it('reads German amounts exactly: comma decimals, point thousands, one or two places', () => {
    expect(parseAmountInput('1,5')).toEqual(ok('1.50', '150'));
    expect(parseAmountInput('1.234,56')).toEqual(ok('1234.56', '123456'));
    expect(parseAmountInput('1234,56')).toEqual(ok('1234.56', '123456'));
    expect(parseAmountInput('700')).toEqual(ok('700.00', '70000'));
    expect(parseAmountInput('0,01')).toEqual(ok('0.01', '1'));
    expect(parseAmountInput('0')).toEqual(ok('0.00', '0'));
    expect(parseAmountInput('0012,5')).toEqual(ok('12.50', '1250'));
    expect(parseAmountInput('1.234.567,89')).toEqual(ok('1234567.89', '123456789'));
  });

  it('leading and trailing spaces are ignored, spaces inside are not read', () => {
    expect(parseAmountInput('  850,00 ')).toEqual(ok('850.00', '85000'));
    expect(parseAmountInput('\t1,5\n')).toEqual(ok('1.50', '150'));
    expect(parseAmountInput('1 234,56')).toEqual(refused('INVALID'));
  });

  it('empty is its own problem, not zero', () => {
    expect(parseAmountInput('')).toEqual(refused('EMPTY'));
    expect(parseAmountInput('   ')).toEqual(refused('EMPTY'));
  });

  it('a third place is refused, never rounded', () => {
    expect(parseAmountInput('0,001')).toEqual(refused('TOO_MANY_DECIMALS'));
    expect(parseAmountInput('1,005')).toEqual(refused('TOO_MANY_DECIMALS'));
    expect(parseAmountInput('1.234,567')).toEqual(refused('TOO_MANY_DECIMALS'));
  });

  it('negative amounts are refused: a split has no direction (§6.4)', () => {
    expect(parseAmountInput('-1,00')).toEqual(refused('NEGATIVE'));
    expect(parseAmountInput(' -0')).toEqual(refused('NEGATIVE'));
    expect(parseAmountInput('\u22125')).toEqual(refused('NEGATIVE'));
  });

  it('a point alone is ambiguous (German thousands or English decimal) and refused', () => {
    expect(parseAmountInput('1.234')).toEqual(refused('AMBIGUOUS'));
    expect(parseAmountInput('1234.56')).toEqual(refused('AMBIGUOUS'));
    expect(parseAmountInput('1.5')).toEqual(refused('AMBIGUOUS'));
  });

  it('anything else is not an amount', () => {
    for (const text of ['1,234.56', '+5', '1e3', '12,', ',5', '1..2,00', '12.34,56', 'EUR 5', '5 €', '1,2,3', '0x10', 'NaN']) {
      expect(parseAmountInput(text), text).toEqual(refused('INVALID'));
    }
  });

  it('18 digits before the comma are read exactly, 19 are refused (the backend limit)', () => {
    expect(parseAmountInput('999.999.999.999.999.999,99')).toEqual(ok('999999999999999999.99', '99999999999999999999'));
    expect(parseAmountInput('9999999999999999999')).toEqual(refused('TOO_LARGE'));
    // counter-check: Number would have changed the value
    expect(String(Number('99999999999999999999'))).not.toBe('99999999999999999999');
  });
});

describe('step 3, cents as digit strings (no Number, no BigInt, no floating point)', () => {
  it('adds and compares beyond 2^53 cents exactly', () => {
    expect(addCents('99999999999999999999', '1')).toBe('100000000000000000000');
    expect(addCents('0', '0')).toBe('0');
    expect(addCents('5', '95')).toBe('100');
    expect(compareCents('100', '99')).toBe(1);
    expect(compareCents('99', '100')).toBe(-1);
    expect(compareCents('9007199254740993', '9007199254740993')).toBe(0);
    expect(compareCents('9007199254740993', '9007199254740992')).toBe(1);
  });

  it('the difference is signed and exact to the cent', () => {
    expect(differenceAsDecimal('85000', '84999')).toBe('0.01');
    expect(differenceAsDecimal('84999', '85000')).toBe('-0.01');
    expect(differenceAsDecimal('85000', '85000')).toBe('0.00');
    expect(differenceAsDecimal('100000000000000000000', '1')).toBe('999999999999999999.99');
  });

  it('converts between the API decimal, cents and the input text', () => {
    expect(decimalToCents('850.00')).toBe('85000');
    expect(decimalToCents('850.5')).toBe('85050');
    expect(decimalToCents('850')).toBe('85000');
    expect(decimalToCents('0.01')).toBe('1');
    expect(decimalToCents('1.005')).toBeUndefined();
    expect(decimalToCents('-1.00')).toBeUndefined();
    expect(decimalToCents('1,00')).toBeUndefined();
    expect(centsToDecimal('1')).toBe('0.01');
    expect(centsToDecimal('0', true)).toBe('0.00');
    expect(centsToDecimal('150', true)).toBe('-1.50');
    expect(decimalToInput('1234.5')).toBe('1234,50');
    expect(decimalToInput('999999999999999999.99')).toBe('999999999999999999,99');
    expect(decimalToInput('x')).toBeUndefined();
  });

  it('typed, normalised and read back: the same amount', () => {
    for (const text of ['0,01', '1,5', '1.234,56', '999.999.999.999.999.999,99']) {
      const parsed = parseAmountInput(text);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parseAmountInput(decimalToInput(parsed.amount) ?? '')).toEqual(parsed);
    }
  });
});
