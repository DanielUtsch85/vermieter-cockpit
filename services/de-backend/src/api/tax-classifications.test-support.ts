import type { PrincipalVerifier, TaxClassification, TaxMeaning } from '../application/index.js';
import { Money, type BusinessDate } from '../shared/index.js';

/** The shared fixtures and request helpers of the Taxation route tests (VC-7-01): one classification and one meaning. Test support only. */
export const REALM = '64b0c0ffee000000000000a7';
export const SPLIT = '1c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
export const TX = '2c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
export const PR = '3c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
export const CLASSIFICATION = '4c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
export const OTHER = '5c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
export const PARTY = '6c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';

export const classification: TaxClassification = {
  id: CLASSIFICATION as TaxClassification['id'],
  mreRealmId: REALM,
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: SPLIT,
  taxCategory: 'MAINTENANCE',
  treatment: 'CAPITALIZED',
  reviewState: 'USER_CONFIRMED',
  rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
  treatmentRule: null,
  sourcePosition: null,
  reserveWithdrawal: null,
  assessmentUse: null,
  netAmount: null,
  annuallyRecurring: false,
  distributionYears: null,
  mostlyResidentialConfirmed: null,
  anschaffungsnaheAcquisitionId: null,
  constructionPeriodInterestId: null,
  advisorPartyId: null,
  notes: 'Austausch Thermostatventile',
  sourceReferences: ['Rechnung 2026-117'],
  taxYear: null,
  refundOfYear: null,
  depositClosing: null,
  supersedes: OTHER,
  supersededBy: null,
  supersededAt: null,
  createdAt: new Date('2026-10-30T10:00:00Z'),
  createdBy: 'anna@example.com',
  version: 3,
};

export const meaning: TaxMeaning = {
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: SPLIT,
  splitId: SPLIT,
  transactionId: TX,
  position: 1,
  bookingDate: '2026-03-02' as BusinessDate,
  direction: 'OUTFLOW',
  amount: Money.of('120.00', 'EUR'),
  financialCategoryCode: 'MAINTENANCE',
  categoryType: 'OPERATING_EXPENSE',
  propertyReferenceId: PR,
  transactionStatus: 'CONFIRMED',
  correctionRole: 'REPLACEMENT',
  counts: true,
  taxCategory: 'MAINTENANCE',
  treatment: 'DEDUCTIBLE',
  reviewState: 'SUGGESTED',
  origin: 'DEFAULT',
  rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
  classificationId: null,
  taxYear: 2026,
  attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: 2026, proposedYear: 2026, overridden: false },
  refund: null,
  netAmount: null,
  treatmentRule: null,
  distribution: null,
  suggestion: null,
  flags: [{ code: 'CLASSIFICATION_ON_CORRECTED_SPLIT', details: { originalTransactionId: OTHER, classificationIds: [CLASSIFICATION] } }],
};

export const body = {
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: SPLIT,
  taxCategory: 'MAINTENANCE',
  treatment: 'CAPITALIZED',
  reviewState: 'USER_CONFIRMED',
  supersedes: null,
  notes: 'Austausch Thermostatventile',
  sourceReferences: ['Rechnung 2026-117'],
};

export const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });

const headers = { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json' };
export const post = (base: string, path: string, payload: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(payload) });
export const get = (base: string, path: string) => fetch(`${base}/api/v1${path}`, { headers });
