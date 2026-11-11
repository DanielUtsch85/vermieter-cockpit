import { envelope } from '../api/fetch.test-support';
import { ApiError, CLIENT_CODES } from '../api/errors';
import type { Money } from './real-mappings.test-support';

/**
 * The data model of the Durchstich's fake backend (fake-backend.test-support.ts): the synthetic file, the backend's
 * domain objects as its repositories return them (only the fields the DTO mappings read), and the answers every route
 * shares. Only synthetic data: invented names, `DE00…` placeholders, `@example.invalid`.
 */

export const EMAIL = 'vermieter@example.invalid';
export const CSV_NAME = 'umsaetze-oktober.csv';
/** The October rent term of the synthetic Tenant (MRE's key `YYYYMMDDHH`). */
export const TERM_OCT = '2026100100';
export const ACCOUNT_IBAN = 'DE00 0000 0000 0000 0000 01';

/** A file in the column layout of `vr-banking`: the rent, a payment, and a row that collides with an earlier booking. */
export const DURCHSTICH_CSV = [
  'Bezeichnung Auftragskonto;IBAN Auftragskonto;Buchungstag;Valutadatum;Name Zahlungsbeteiligter;IBAN Zahlungsbeteiligter;Verwendungszweck;Betrag;Waehrung;Saldo nach Buchung',
  `Testkonto;${ACCOUNT_IBAN};01.10.2026;02.10.2026;Erika Beispiel;DE00 0000 0000 0000 0000 02;Miete Oktober Testwohnung;850,00;EUR;1.850,00`,
  `Testkonto;${ACCOUNT_IBAN};05.10.2026;05.10.2026;Muster Versorgung GmbH;DE00 0000 0000 0000 0000 03;Abschlag Testzaehler;-120,50;EUR;1.729,50`,
  `Testkonto;${ACCOUNT_IBAN};15.10.2026;15.10.2026;Test Versicherung AG;DE00 0000 0000 0000 0000 04;Gutschrift Testversicherung Nachtrag;400,00;EUR;2.129,50`,
].join('\n');

export const NOW = new Date('2026-11-11T09:00:00.000Z');
export const RENT_CATEGORIES = new Set(['RENT_BASE', 'RENT_OPERATING_COST_ADVANCE']);

export interface Sent {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly form: FormData | undefined;
}

/** One injected fault: the answer instead of the server's, or the server's work done and its answer lost. */
export type Fault = { readonly answer: () => Response } | { readonly lose: true };

/* The backend's domain objects, as its repositories return them (only the fields the mappings read). */
export interface Split {
  id: string;
  position: number;
  amount: Money;
  financialCategoryCode: string;
  propertyReferenceId: string | null;
  loanId: null;
  securityDepositId: null;
  wegAnnualStatementId: null;
  wegSpecialAssessmentId: null;
  description: string | null;
}

export interface Tx {
  id: string;
  mreRealmId: string;
  financialAccountId: string;
  amount: Money;
  direction: 'INFLOW' | 'OUTFLOW';
  bookingDate: string;
  valueDate: string | null;
  description: string | null;
  propertyReferenceId: string | null;
  provenance: string;
  status: string;
  createdAt: Date;
  version: number;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  correctionOfTransactionId: string | null;
  correctionRole: 'REVERSAL' | 'REPLACEMENT' | null;
  reversalTransactionId: string | null;
  replacementTransactionId: string | null;
  counterpartyNameRaw: string | null;
  counterpartyIbanRaw: string | null;
  splits: Split[];
  importBatchId: string | null;
  identity: string | null;
}

export interface Rec {
  id: string;
  mreRealmId: string;
  status: string;
  transactionId: string;
  mreTenantId: string;
  mreRentTerm: string;
  matchedAmount: Money;
  suggestedAmount: Money;
  confidence: string;
  suggestionReason: string;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  releasedAt: Date | null;
  releasedBy: string | null;
  releaseReason: string | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectReason: string | null;
  notes: null;
  mreWriteBackState: string;
  mreWriteBackLeaseUntil: Date | null;
  mreWrittenBackAt: Date | null;
  mreWrittenBackBy: string | null;
  mrePayment: { date: string; amount: Money; type: string; reference: string } | null;
  mreWriteBackError: string | null;
  mreWriteBackFailedAt: Date | null;
  mreLastLeaseUntil: Date | null;
  mreRemovedAt: Date | null;
  mreRemovedBy: string | null;
  createdAt: Date;
  version: number;
}

export interface Batch {
  id: string;
  mreRealmId: string;
  financialAccountId: string;
  adapterId: string;
  adapterVersion: string;
  sourceFilename: string | null;
  contentHash: string;
  status: string;
  transactionCount: number;
  duplicateCount: number;
  needsReviewCount: number;
  errorCount: number;
  skippedCount: number;
  importedAt: Date;
  importedBy: string;
  rows: Record<string, unknown>[];
  continuity: null;
}

export interface Item {
  id: string;
  importBatchId: string;
  mreRealmId: string;
  financialAccountId: string;
  adapterId: string;
  adapterVersion: string;
  sourceStatementKey: string;
  sourceRowKey: string;
  normalizedRow: Record<string, unknown>;
  ambiguityReason: string;
  conflictingTransactionIds: string[];
  priorReviewItemIds: string[];
  status: 'PENDING' | 'RESOLVED';
  resolution: 'CREATE' | 'SKIP' | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdTransactionId: string | null;
  createdAt: Date;
}

/** An MRE payment of a rent term, as MRE stores it (DE's carries its marker `DE-RPR-<id>`). */
export interface MrePayment {
  date: string;
  amount: Money;
  type: string;
  reference: string | null;
}

let counter = 0;
/** A new id, as the backend's UUIDs look (version 4 layout), deterministic per run. */
export const newId = () => `00000000-0000-4000-8000-${(counter += 1).toString(16).padStart(12, '0')}`;

export const notFound = () => envelope(404, 'NOT_FOUND');
export const conflict = (reason: string, details: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  envelope(409, 'CONFLICT', { reason, ...details }, headers);
export const invalid = (field = '(body)') => envelope(400, 'VALIDATION_ERROR', { fields: [{ field, code: 'INVALID_FORMAT' }] });
export const ifMatchVersion = (headers: Headers): number | undefined => {
  const tag = headers.get('if-match');
  return tag === null || !/^"\d+"$/.test(tag) ? undefined : Number(tag.slice(1, -1));
};
/** German bank text to a canonical decimal string, by string operations only (`-1.234,50` → `-1234.50`). */
export const decimalOf = (text: string) => text.replace(/\./g, '').replace(',', '.');
export const isoDateOf = (text: string) => `${text.slice(6, 10)}-${text.slice(3, 5)}-${text.slice(0, 2)}`;

/** The authenticator does not answer : as `createMreAuthenticator` reports it. */
export const unreachable = () => Promise.reject(new ApiError(0, CLIENT_CODES.network, 'The MRE authenticator did not answer.'));
