import type { ConflictingTransactionDto, ImportBatchDto, ImportRowDto, ReviewItemDto } from '../api/imports';
import { ACCOUNT, REALM_A, TX, TX_REPLACEMENT } from '../transactions/fixtures.test-support';

/**
 * Synthetic import data shaped as the backend's mappings (`imports.ts` `toDto`, `toItemDto`, `toConflictDto`). No real
 * bank export, person, account or IBAN: the names are invented and every IBAN is a `DE00…` placeholder.
 */
export const BATCH = '6c5e9b8a-0d1f-4a23-9b45-e6f708192a3b';
export const EARLIER_BATCH = '7d6f0c9b-1e2a-4b34-8c56-f708192a3b4c';
export const ITEM = '8e7a1d0c-2f3b-4c45-9d67-08192a3b4c5d';
export const EARLIER_ITEM = '9f8b2e1d-3a4c-4d56-8e78-192a3b4c5d6e';
export const TX_CREATED = 'a09c3f2e-4b5d-4e67-9f89-2a3b4c5d6e7f';

/** A file in the column layout of the `vr-banking` preset (api-design.md §32.5), with invented values only. */
export const VR_CSV = [
  'Bezeichnung Auftragskonto;IBAN Auftragskonto;Buchungstag;Valutadatum;Name Zahlungsbeteiligter;IBAN Zahlungsbeteiligter;Verwendungszweck;Betrag;Waehrung;Saldo nach Buchung',
  'Testkonto;DE00 0000 0000 0000 0000 01;01.10.2026;02.10.2026;Erika Beispiel;DE00 0000 0000 0000 0000 02;Miete Oktober Testwohnung;850,00;EUR;1.850,00',
  'Testkonto;DE00 0000 0000 0000 0000 01;05.10.2026;05.10.2026;Muster Versorgung GmbH;DE00 0000 0000 0000 0000 03;Abschlag Testzaehler;-120,50;EUR;1.729,50',
].join('\n');

export function csvFile(name = 'umsaetze-oktober.csv', content: BlobPart = VR_CSV): File {
  return new File([content], name, { type: 'text/csv' });
}

export function batch(overrides: Partial<ImportBatchDto> = {}): ImportBatchDto {
  return {
    importBatchId: BATCH,
    mreRealmId: REALM_A,
    financialAccountId: ACCOUNT,
    adapterId: 'generic-csv',
    adapterVersion: '2',
    sourceFilename: 'umsaetze-oktober.csv',
    contentHash: '0'.repeat(64),
    status: 'COMPLETED',
    transactionCount: 1,
    duplicateCount: 0,
    needsReviewCount: 0,
    errorCount: 0,
    skippedCount: 0,
    importedAt: '2026-10-06T08:00:00.000Z',
    importedBy: 'vermieter@example.invalid',
    rows: [{ outcome: 'created', position: 1, transactionId: TX }],
    continuity: null,
    ...overrides,
  };
}

/** A batch with one row of every outcome, its own pending item and a reference to a pending item of an earlier batch. */
export function mixedBatch(overrides: Partial<ImportBatchDto> = {}): ImportBatchDto {
  const rows: ImportRowDto[] = [
    { outcome: 'created', position: 1, transactionId: TX },
    { outcome: 'duplicate', position: 2, duplicateOf: 'TRANSACTION', transactionId: TX_REPLACEMENT },
    { outcome: 'needs_review', position: 3, reviewItemId: ITEM, importBatchId: BATCH, reason: 'AMBIGUOUS_CROSS_FILE_MATCH', conflictingTransactionIds: [TX] },
    {
      outcome: 'needs_review',
      position: 4,
      reviewItemId: EARLIER_ITEM,
      importBatchId: EARLIER_BATCH,
      reason: 'EXTERNAL_ID_CONTENT_CONFLICT',
      conflictingTransactionIds: [TX],
    },
    { outcome: 'error', position: 5, errors: [{ field: 'amount', code: 'SCALE_EXCEEDED' }] },
    { outcome: 'skipped', position: 6, reason: 'ZERO_AMOUNT' },
  ];
  return batch({
    status: 'NEEDS_REVIEW',
    transactionCount: 1,
    duplicateCount: 1,
    needsReviewCount: 1,
    errorCount: 1,
    skippedCount: 1,
    rows,
    continuity: {
      order: 'OLDEST_FIRST',
      breaks: [{ position: 5, expectedBalanceAfter: '1234567890123456.78', balanceAfter: '-12.50' }],
      previousExport: 'GAP',
    },
    ...overrides,
  });
}

export function conflict(overrides: Partial<ConflictingTransactionDto> = {}): ConflictingTransactionDto {
  return {
    transactionId: TX,
    importBatchId: EARLIER_BATCH,
    bookingDate: '2026-10-01',
    valueDate: '2026-10-02',
    amount: { amount: '850.00', currency: 'EUR' },
    direction: 'INFLOW',
    counterpartyNameRaw: 'Erika Beispiel',
    counterpartyIbanRaw: 'DE00000000000000000002',
    description: 'Miete Oktober Testwohnung',
    externalTransactionId: null,
    ...overrides,
  };
}

export function reviewItem(overrides: Partial<ReviewItemDto> = {}): ReviewItemDto {
  return {
    reviewItemId: ITEM,
    importBatchId: BATCH,
    financialAccountId: ACCOUNT,
    adapterId: 'generic-csv',
    adapterVersion: '2',
    status: 'PENDING',
    ambiguityReason: 'AMBIGUOUS_CROSS_FILE_MATCH',
    normalizedRow: {
      bookingDate: '2026-10-01',
      valueDate: '2026-10-02',
      amount: { amount: '1234567890123456.78', currency: 'EUR' },
      direction: 'INFLOW',
      counterpartyNameRaw: 'Erika Beispiel',
      counterpartyIbanRaw: 'DE00000000000000000002',
      description: 'Miete Oktober Testwohnung (neue Datei)',
      externalTransactionId: null,
      balanceAfter: '-12.50',
      position: 3,
      statementKey: `sha256:${'0'.repeat(64)}`,
      rowKey: 'pos:3',
    },
    conflictingTransactionIds: [TX],
    conflictingTransactions: [conflict()],
    priorReviewItemIds: [],
    resolution: null,
    resolvedByAccountId: null,
    resolvedAt: null,
    createdTransactionId: null,
    createdAt: '2026-10-06T08:00:00.000Z',
    ...overrides,
  };
}

/** The answer of `…/resolve`: the item resolved as asked, without `conflictingTransactions` (§32.3a). */
export function resolved(resolution: 'CREATE' | 'SKIP', overrides: Partial<ReviewItemDto> = {}): ReviewItemDto {
  const { conflictingTransactions: _omitted, ...item } = reviewItem(overrides);
  return {
    ...item,
    status: 'RESOLVED',
    resolution,
    resolvedByAccountId: 'vermieter@example.invalid',
    resolvedAt: '2026-10-06T09:00:00.000Z',
    createdTransactionId: resolution === 'CREATE' ? TX_CREATED : null,
  };
}
