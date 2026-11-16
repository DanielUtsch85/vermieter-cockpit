import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_TYPES, accountTypeLabel, checkAccount, ibanRequired, normalizeIban } from './account-draft';

/**
 * The rules of „Konto anlegen“ (Issue #365) against the backend's source: the IBAN check is the one of `shared/iban.ts`
 * and the body is one the route's schema accepts (api-design.md §29.2). The backend modules are loaded here, in the test
 * only; the bundle takes types from `client-contract.ts` and nothing else of the backend.
 */
const backend = (path: string) => fileURLToPath(new URL(`../../../../services/de-backend/src/${path}`, import.meta.url));
const shared = (await import(/* @vite-ignore */ backend('shared/iban.ts'))) as { normalizeIban(input: string): string | undefined };
const route = (await import(/* @vite-ignore */ backend('api/financial-accounts.ts'))) as {
  createBody: { safeParse(value: unknown): { success: boolean; data?: unknown } };
};
const domain = (await import(/* @vite-ignore */ backend('domains/ledger/financial-account.ts'))) as { ACCOUNT_TYPES: readonly string[] };

/** Synthetic IBANs only: the standard German example and other published test numbers, plus typos of them. */
const IBANS = [
  'DE89370400440532013000',
  'DE89 3704 0044 0532 0130 00',
  'de89370400440532013000',
  ' DE89370400440532013000 ',
  'DE02120300000000202051',
  'GB82WEST12345698765432',
  'NL91ABNA0417164300',
  'FR1420041010050500013M02606',
  'DE89370400440532013001',
  'DE88370400440532013000',
  'DE8937040044053201300',
  'DE89-3704-0044-0532-0130-00',
  'DE89\t370400440532013000',
  'XX00000000000000000000',
  'DE00 0000 0000 0000 0000 01',
  '',
  ' ',
  'DE',
  'D E 8 9 3 7 0 4 0 0 4 4 0 5 3 2 0 1 3 0 0 0',
  `DE89${'1'.repeat(31)}`,
];

describe('client IBAN check: the backend check, case by case (shared/iban.ts)', () => {
  it('every sample is normalised or refused exactly as the backend does it', () => {
    for (const sample of IBANS) expect(normalizeIban(sample), JSON.stringify(sample)).toBe(shared.normalizeIban(sample));
  });

  it('spaces and lower case are allowed and normalised; a wrong check digit or length is refused', () => {
    expect(normalizeIban('de89 3704 0044 0532 0130 00')).toBe('DE89370400440532013000');
    expect(normalizeIban('DE89370400440532013001')).toBeUndefined();
    expect(normalizeIban('DE8937040044053201300')).toBeUndefined();
    expect(normalizeIban('DE89-3704-0044-0532-0130-00')).toBeUndefined();
  });
});

describe('IBAN required for bank and deposit accounts, optional for cash, clearing and other accounts (Entscheidung des Projektinhabers, 2026-11-16)', () => {
  it('the form offers exactly the five types of the backend', () => {
    expect(ACCOUNT_TYPES.map((type) => type.code).sort()).toEqual([...domain.ACCOUNT_TYPES].sort());
  });

  it('only BANK and SECURITY_DEPOSIT need an IBAN; OTHER, CASH and LOAN_SETTLEMENT may be created without one', () => {
    expect(ACCOUNT_TYPES.filter((type) => ibanRequired(type.code)).map((type) => type.code)).toEqual(['BANK', 'SECURITY_DEPOSIT']);
    expect(ACCOUNT_TYPES.filter((type) => !ibanRequired(type.code)).map((type) => type.code)).toEqual(['OTHER', 'CASH', 'LOAN_SETTLEMENT']);
    for (const type of ACCOUNT_TYPES) {
      const checked = checkAccount({ accountType: type.code, displayName: 'Testkonto', iban: '' });
      expect(checked.ok, type.code).toBe(!type.ibanRequired);
      if (!checked.ok) expect(checked.problems).toEqual(['IBAN_MISSING']);
    }
  });

  it('a bank account without IBAN is refused before anything is sent; with a valid one the IBAN is sent normalised', () => {
    expect(checkAccount({ accountType: 'BANK', displayName: 'Girokonto', iban: '   ' })).toEqual({ ok: false, problems: ['IBAN_MISSING'] });
    expect(checkAccount({ accountType: 'BANK', displayName: ' Girokonto ', iban: 'de89 3704 0044 0532 0130 00' })).toEqual({
      ok: true,
      body: { accountType: 'BANK', displayName: 'Girokonto', currency: 'EUR', iban: 'DE89370400440532013000' },
    });
  });

  it('a payment service as other account goes without IBAN; a deposit account still needs one', () => {
    expect(checkAccount({ accountType: 'OTHER', displayName: 'Zahlungsdienst', iban: ' ' })).toEqual({
      ok: true,
      body: { accountType: 'OTHER', displayName: 'Zahlungsdienst', currency: 'EUR' },
    });
    expect(checkAccount({ accountType: 'OTHER', displayName: 'Zahlungsdienst', iban: 'DE89370400440532013001' })).toEqual({
      ok: false,
      problems: ['IBAN_INVALID'],
    });
    expect(checkAccount({ accountType: 'SECURITY_DEPOSIT', displayName: 'Kaution', iban: '' })).toEqual({ ok: false, problems: ['IBAN_MISSING'] });
  });

  it('an optional IBAN is left out when empty and checked when typed', () => {
    expect(checkAccount({ accountType: 'CASH', displayName: 'Handkasse', iban: '' })).toEqual({
      ok: true,
      body: { accountType: 'CASH', displayName: 'Handkasse', currency: 'EUR' },
    });
    expect(checkAccount({ accountType: 'CASH', displayName: 'Handkasse', iban: 'DE89370400440532013001' })).toEqual({ ok: false, problems: ['IBAN_INVALID'] });
  });

  it('the name is required and at most 200 characters after trimming, as the route reads it', () => {
    expect(checkAccount({ accountType: 'CASH', displayName: '  ', iban: '' })).toEqual({ ok: false, problems: ['NAME_MISSING'] });
    expect(checkAccount({ accountType: 'CASH', displayName: 'x'.repeat(201), iban: '' })).toEqual({ ok: false, problems: ['NAME_TOO_LONG'] });
    expect(checkAccount({ accountType: 'CASH', displayName: ` ${'x'.repeat(200)} `, iban: '' }).ok).toBe(true);
    expect(checkAccount({ accountType: 'BANK', displayName: '', iban: 'x' })).toEqual({ ok: false, problems: ['NAME_MISSING', 'IBAN_INVALID'] });
  });

  it('every body the form sends passes the route schema, and every refused draft would be refused or is a form rule', () => {
    for (const type of ACCOUNT_TYPES) {
      for (const iban of IBANS) {
        for (const displayName of ['Konto', '', 'x'.repeat(201)]) {
          const checked = checkAccount({ accountType: type.code, displayName, iban });
          const raw = { accountType: type.code, displayName, currency: 'EUR', ...(iban.trim() === '' ? {} : { iban }) };
          if (checked.ok) expect(route.createBody.safeParse(checked.body).success, JSON.stringify(raw)).toBe(true);
          // The one rule of the form the backend does not have: a required IBAN left empty.
          else if (!(checked.problems.length === 1 && checked.problems[0] === 'IBAN_MISSING')) {
            expect(route.createBody.safeParse(raw).success, JSON.stringify(raw)).toBe(false);
          }
        }
      }
    }
  });

  it('an unknown type is named with its code', () => {
    expect(accountTypeLabel('BANK')).toBe('Bankkonto');
    expect(accountTypeLabel('CRYPTO')).toBe('Unbekannte Kontoart (CRYPTO)');
  });
});
