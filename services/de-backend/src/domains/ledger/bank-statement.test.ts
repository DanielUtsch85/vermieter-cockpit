import { describe, expect, it } from 'vitest';
import { checkStatementAccount } from './bank-statement.js';

describe('checkStatementAccount (#107)', () => {
  const ACCOUNT_IBAN = 'DE72660908000003061329';

  it('a file that does not name its account is not checked', () => {
    expect(checkStatementAccount(null, {})).toBeUndefined();
    expect(checkStatementAccount(ACCOUNT_IBAN, {})).toBeUndefined();
  });

  it('the same account passes; the account IBAN is compared without spaces and case', () => {
    expect(checkStatementAccount(ACCOUNT_IBAN, { accountIbans: [ACCOUNT_IBAN] })).toBeUndefined();
    expect(checkStatementAccount('de72 6609 0800 0003 0613 29', { accountIbans: [ACCOUNT_IBAN] })).toBeUndefined();
  });

  it('another account, several accounts, an empty column, or no IBAN to compare with are refused', () => {
    expect(checkStatementAccount(ACCOUNT_IBAN, { accountIbans: ['DE02120300000000202051'] })).toBe('ACCOUNT_IBAN_MISMATCH');
    expect(checkStatementAccount(ACCOUNT_IBAN, { accountIbans: [ACCOUNT_IBAN, 'DE02120300000000202051'] })).toBe('MIXED_ACCOUNT_IBANS');
    expect(checkStatementAccount(ACCOUNT_IBAN, { accountIbans: [] })).toBe('ACCOUNT_IBAN_MISSING');
    expect(checkStatementAccount(null, { accountIbans: [ACCOUNT_IBAN] })).toBe('ACCOUNT_HAS_NO_IBAN');
  });
});
