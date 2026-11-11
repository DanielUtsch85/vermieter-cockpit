import type {
  RentReconciliationDto,
  RentReconciliationReadDto,
  SuggestResultDto,
  TermCoverageDto,
  TransactionRentCoverageDto,
} from '../api/rent-reconciliations';
import { REALM_A, TX } from '../transactions/fixtures.test-support';

/** Synthetic DTOs of step 6, shaped as the backend's `toDto`, `toTermDto` and `toTransactionDto`; no real person or account. */
export const REC = '8d6b0e9f-1a2c-4d34-8f56-f708192a3b4c';
export const REC_2 = '9e7c1fa0-2b3d-4e45-9a67-0819203a4b5d';
export const TENANT = '64b7f0c2a1b2c3d4e5f60720';
export const TERM = '2026030100';

export function reconciliation(overrides: Partial<RentReconciliationDto> = {}): RentReconciliationDto {
  return {
    reconciliationId: REC,
    mreRealmId: REALM_A,
    status: 'SUGGESTED',
    transactionId: TX,
    mreTenantId: TENANT,
    mreRentTerm: TERM,
    matchedAmount: { amount: '850.00', currency: 'EUR' },
    confidence: 'MEDIUM',
    suggestionReason: 'EXACT_AMOUNT',
    confirmedAt: null,
    confirmedBy: null,
    releasedAt: null,
    releasedBy: null,
    releaseReason: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectReason: null,
    notes: null,
    mreWriteBackState: 'NOT_WRITTEN',
    mreWriteBackLeaseUntil: null,
    mreWrittenBackAt: null,
    mreWrittenBackBy: null,
    mrePayment: null,
    mreWriteBackError: null,
    mreWriteBackFailedAt: null,
    mreLastLeaseUntil: null,
    mreRemovedAt: null,
    mreRemovedBy: null,
    createdAt: '2026-03-05T08:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

export const read = (overrides: Partial<RentReconciliationDto> = {}): RentReconciliationReadDto => ({ ...reconciliation(overrides), mrePresence: null });

/** A suggestion confirmed with the amount given (version + 1), as the server answers `confirm`. */
export function confirmed(amount = '850.00', overrides: Partial<RentReconciliationDto> = {}): RentReconciliationDto {
  return reconciliation({
    status: 'CONFIRMED',
    matchedAmount: { amount, currency: 'EUR' },
    confirmedAt: '2026-03-06T09:00:00.000Z',
    confirmedBy: 'vermieter@example.invalid',
    version: 2,
    ...overrides,
  });
}

export function written(overrides: Partial<RentReconciliationDto> = {}): RentReconciliationDto {
  return confirmed('850.00', {
    mreWriteBackState: 'WRITTEN',
    mreWrittenBackAt: '2026-03-06T10:00:00.000Z',
    mreWrittenBackBy: 'vermieter@example.invalid',
    mrePayment: { date: '01/03/2026', amount: { amount: '850.00', currency: 'EUR' }, type: 'transfer', reference: `DE-RPR-${REC}` },
    mreLastLeaseUntil: '2026-03-06T10:02:00.000Z',
    version: 4,
    ...overrides,
  });
}

export function released(state: RentReconciliationDto['mreWriteBackState'], overrides: Partial<RentReconciliationDto> = {}): RentReconciliationDto {
  return written({
    status: 'RELEASED',
    mreWriteBackState: state,
    releasedAt: '2026-03-07T09:00:00.000Z',
    releasedBy: 'vermieter@example.invalid',
    releaseReason: 'Falsche Buchung',
    version: 5,
    ...overrides,
  });
}

export function suggestResult(
  items: readonly RentReconciliationDto[],
  skipped = { unconfirmed: 0, noRentCash: 0 },
  window = { from: '2026-03', to: '2026-04' },
): SuggestResultDto {
  return { ...window, items, skipped };
}

export function termCoverage(overrides: Partial<TermCoverageDto> = {}): TermCoverageDto {
  return {
    mreTenantId: TENANT,
    mreRentTerm: TERM,
    reconciliations: [confirmed('800.00')],
    matchedTotal: { amount: '800.00', currency: 'EUR' },
    mreStatus: 'AVAILABLE',
    mre: {
      amountDue: { amount: '850.00', currency: 'EUR' },
      payments: [{ date: '2026-03-02', amount: { amount: '850.00', currency: 'EUR' }, type: 'cash', reference: null }],
    },
    coverage: 'PARTIALLY_MATCHED',
    openAmount: { amount: '50.00', currency: 'EUR' },
    ...overrides,
  };
}

export function transactionCoverage(overrides: Partial<TransactionRentCoverageDto> = {}): TransactionRentCoverageDto {
  return {
    transactionId: TX,
    status: 'CONFIRMED',
    direction: 'INFLOW',
    correctionRole: null,
    counted: true,
    rentCash: { amount: '850.00', currency: 'EUR' },
    matchedTotal: { amount: '800.00', currency: 'EUR' },
    available: { amount: '50.00', currency: 'EUR' },
    reconciliations: [confirmed('800.00')],
    ...overrides,
  };
}
