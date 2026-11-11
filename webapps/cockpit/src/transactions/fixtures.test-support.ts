import type {
  FinancialAccountDto,
  FinancialCategoryDto,
  PageDto,
  PropertyReferenceDto,
  TransactionDetailDto,
  TransactionDto,
  TransactionSplitDto,
} from '../api/transactions';

/** Synthetic DTOs shaped as the backend's mappings (`toDto`, `toSplitDto`); no real person, account or IBAN. */
export const REALM_A = '64b7f0c2a1b2c3d4e5f60718';
export const REALM_B = '64b7f0c2a1b2c3d4e5f60719';
export const ACCOUNT = '0b8f2c1e-3d4a-4b5c-8d6e-7f8091a2b3c4';
export const PROPERTY = '1c9a3d2f-4e5b-4c6d-9e7f-8091a2b3c4d5';
export const TX = '2d0b4e3a-5f6c-4d7e-8f90-91a2b3c4d5e6';
export const TX_REVERSAL = '3e1c5f4b-6a7d-4e8f-9a01-a2b3c4d5e6f7';
export const TX_REPLACEMENT = '4f2d6a5c-7b8e-4f90-8b12-b3c4d5e6f708';

export function transaction(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    transactionId: TX,
    mreRealmId: REALM_A,
    financialAccountId: ACCOUNT,
    amount: { amount: '850.00', currency: 'EUR' },
    direction: 'INFLOW',
    bookingDate: '2026-03-01',
    valueDate: '2026-03-02',
    description: 'Miete Maerz Testwohnung',
    propertyReferenceId: null,
    provenance: 'BANK_CSV',
    status: 'IMPORTED',
    createdAt: '2026-03-02T08:15:00.000Z',
    version: 3,
    confirmedAt: null,
    confirmedBy: null,
    correctionOfTransactionId: null,
    correctionRole: null,
    reversalTransactionId: null,
    replacementTransactionId: null,
    counterpartyNameRaw: 'Erika Beispiel',
    counterpartyIbanRaw: 'DE00 0000 0000 0000 0000 00',
    ...overrides,
  };
}

export function split(overrides: Partial<TransactionSplitDto> = {}): TransactionSplitDto {
  return {
    splitId: '5a3e7b6d-8c9f-4a01-9c23-c4d5e6f70819',
    position: 1,
    amount: { amount: '700.00', currency: 'EUR' },
    financialCategoryCode: 'RENT_BASE',
    propertyReferenceId: PROPERTY,
    loanId: null,
    securityDepositId: null,
    wegAnnualStatementId: null,
    wegSpecialAssessmentId: null,
    description: null,
    ...overrides,
  };
}

export function detail(overrides: Partial<TransactionDetailDto> = {}): TransactionDetailDto {
  return { ...transaction(), splits: [], ...overrides };
}

export function page<T>(items: readonly T[], overrides: Partial<PageDto<T>> = {}): PageDto<T> {
  return { items, page: 1, pageSize: 50, total: items.length, ...overrides };
}

export function account(overrides: Partial<FinancialAccountDto> = {}): FinancialAccountDto {
  return {
    financialAccountId: ACCOUNT,
    mreRealmId: REALM_A,
    accountType: 'BANK',
    displayName: 'Girokonto Testbank',
    currency: 'EUR',
    iban: null,
    status: 'OPEN',
    createdAt: '2026-01-01T09:00:00.000Z',
    closedAt: null,
    version: 1,
    ...overrides,
  };
}

export function property(overrides: Partial<PropertyReferenceDto> = {}): PropertyReferenceDto {
  return {
    propertyReferenceId: PROPERTY,
    mreRealmId: REALM_A,
    mrePropertyId: '64b7f0c2a1b2c3d4e5f60720',
    externalReferenceState: 'ACTIVE',
    displayName: 'Testhaus Wohnung 1',
    cachedAddress: null,
    cachedSurface: null,
    lastRefreshedAt: null,
    lastObservedAt: null,
    createdAt: '2026-01-01T09:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

export function category(overrides: Partial<FinancialCategoryDto> = {}): FinancialCategoryDto {
  return { code: 'RENT_BASE', name: 'Kaltmiete', categoryType: 'INCOME', active: true, ...overrides };
}

/**
 * The `201` answer of `POST …/correct` for `TX` (api-design.md §35.3, `transaction-lifecycle.ts`): the original
 * `CORRECTED` with its links, the reversal (same amount and dates, opposite direction) and the replacement with the
 * changes given. Synthetic, as the backend's `toDto` shapes it.
 */
export function correctionAnswer(replacement: Partial<TransactionDto> = {}, original: Partial<TransactionDto> = {}) {
  const base = transaction({ status: 'CONFIRMED', confirmedAt: '2026-03-05T10:00:00.000Z', confirmedBy: 'vermieter@example.invalid', ...original });
  const linked = {
    provenance: 'CORRECTION',
    status: 'CONFIRMED',
    version: 1,
    correctionOfTransactionId: base.transactionId,
    confirmedAt: '2026-04-01T09:00:00.000Z',
  } as const;
  return {
    original: { ...base, status: 'CORRECTED', version: base.version + 1, reversalTransactionId: TX_REVERSAL, replacementTransactionId: TX_REPLACEMENT },
    reversal: { ...base, ...linked, transactionId: TX_REVERSAL, correctionRole: 'REVERSAL', direction: base.direction === 'INFLOW' ? 'OUTFLOW' : 'INFLOW' },
    replacement: { ...base, ...linked, transactionId: TX_REPLACEMENT, correctionRole: 'REPLACEMENT', ...replacement },
  } satisfies { original: TransactionDto; reversal: TransactionDto; replacement: TransactionDto };
}
