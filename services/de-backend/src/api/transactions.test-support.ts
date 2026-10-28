import type { PrincipalVerifier, Transaction } from '../application/index.js';
import { Money } from '../shared/index.js';

/** The shared fixtures of the Transaction route tests (#104): one Realm, account, PropertyReference and Transaction. Test support only. */
export const REALM = '64b0c0ffee0000000000000a';
export const ACCOUNT = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
export const PROPERTY = 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f';
export const transaction = {
  id: '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  mreRealmId: REALM,
  financialAccountId: ACCOUNT,
  amount: Money.of('1250.00', 'EUR'),
  direction: 'INFLOW',
  bookingDate: '2026-09-01',
  valueDate: null,
  description: 'Miete September',
  propertyReferenceId: PROPERTY,
  provenance: 'MANUAL',
  status: 'UNREVIEWED',
  createdAt: new Date('2026-10-19T08:00:00Z'),
  version: 1,
  confirmedAt: null,
  confirmedBy: null,
  correctionOfTransactionId: null,
  correctionRole: null,
  reversalTransactionId: null,
  replacementTransactionId: null,
  counterpartyNameRaw: null,
  counterpartyIbanRaw: null,
} as unknown as Transaction;

export const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({
  email: 'anna@example.com',
  mreRealmId: mreRealmId ?? '',
  mreRole: 'administrator',
});
