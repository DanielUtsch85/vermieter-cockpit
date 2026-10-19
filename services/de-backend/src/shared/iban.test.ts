import { describe, expect, it } from 'vitest';
import { normalizeIban } from './iban.js';

describe('normalizeIban', () => {
  it.each([
    ['DE89370400440532013000', 'DE89370400440532013000'],
    ['DE89 3704 0044 0532 0130 00', 'DE89370400440532013000'],
    ['de89370400440532013000', 'DE89370400440532013000'],
    ['GB82WEST12345698765432', 'GB82WEST12345698765432'],
    ['AT611904300234573201', 'AT611904300234573201'],
    ['NO9386011117947', 'NO9386011117947'],
  ])('accepts %j as %j', (input, expected) => {
    expect(normalizeIban(input)).toBe(expected);
  });

  it.each([
    ['wrong check digits', 'DE88370400440532013000'],
    ['one digit changed', 'DE89370400440532013001'],
    ['too short', 'DE8937040044'],
    ['too long', `DE89${'1'.repeat(31)}`],
    ['no country code', '8937040044053201300000'],
    ['special characters', 'DE89-3704-0044-0532-0130-00'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    expect(normalizeIban(input)).toBeUndefined();
  });
});
