import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { entryStatus, planAmend, planIgnore, planRestore } from './amend-transaction.js';
import type { BusinessDate, Provenance, Transaction, TransactionStatus } from './transaction.js';

const eur = (amount: string) => Money.of(amount, 'EUR');
const tx = (status: TransactionStatus, provenance: Provenance = 'MANUAL'): Transaction =>
  ({
    id: 't1',
    mreRealmId: 'r',
    financialAccountId: 'a1',
    amount: eur('1250.00'),
    direction: 'INFLOW',
    bookingDate: '2026-09-01',
    valueDate: '2026-09-02',
    description: 'Miete',
    propertyReferenceId: null,
    provenance,
    status,
    createdAt: new Date(),
    version: 2,
    confirmedAt: null,
    confirmedBy: null,
    correctionOfTransactionId: null,
    correctionRole: null,
    reversalTransactionId: null,
    replacementTransactionId: null,
  }) as unknown as Transaction;

describe('planAmend (api-design.md §31.3)', () => {
  it('overlays the changes; omitted keeps, null clears; lists what changed', () => {
    expect(planAmend(tx('UNREVIEWED'), { bookingDate: '2026-09-03' as BusinessDate, valueDate: null, description: 'Miete' })).toEqual({
      kind: 'AMEND',
      values: {
        financialAccountId: 'a1',
        amount: eur('1250.00'),
        direction: 'INFLOW',
        bookingDate: '2026-09-03',
        valueDate: null,
        description: 'Miete',
        propertyReferenceId: null,
      },
      changed: ['bookingDate', 'valueDate'],
      dropSplits: false,
      nextStatus: 'UNREVIEWED',
    });
  });

  it('nothing different is UNCHANGED; "1250" equals "1250.00"', () => {
    expect(planAmend(tx('CLASSIFIED'), {})).toEqual({ kind: 'UNCHANGED' });
    expect(planAmend(tx('CLASSIFIED'), { amount: eur('1250'), description: 'Miete' })).toEqual({ kind: 'UNCHANGED' });
  });

  it('a changed amount drops the split set of a CLASSIFIED Transaction and returns it to its entry status', () => {
    expect(planAmend(tx('CLASSIFIED'), { amount: eur('1200.00') })).toMatchObject({ dropSplits: true, nextStatus: 'UNREVIEWED' });
    expect(planAmend(tx('CLASSIFIED'), { direction: 'OUTFLOW' })).toMatchObject({ dropSplits: false, nextStatus: 'CLASSIFIED' });
    expect(planAmend(tx('UNREVIEWED'), { amount: eur('1200.00') })).toMatchObject({ dropSplits: false, nextStatus: 'UNREVIEWED' });
  });

  it('an imported Transaction keeps the statement’s cash fields; description and PropertyReference may change', () => {
    expect(planAmend(tx('IMPORTED', 'BANK_CSV'), { amount: eur('1.00'), bookingDate: '2026-09-03' as BusinessDate })).toEqual({
      kind: 'IMPORTED_FIELDS_FIXED',
      fields: ['amount', 'bookingDate'],
    });
    // Repeating a cash field's current value is fine.
    expect(planAmend(tx('CLASSIFIED', 'BANK_CSV'), { amount: eur('1250.00'), description: 'Kaltmiete' })).toMatchObject({
      kind: 'AMEND',
      changed: ['description'],
      nextStatus: 'CLASSIFIED',
    });
  });

  it('confirmed and ignored Transactions are not amendable', () => {
    for (const status of ['CONFIRMED', 'RECONCILED', 'CORRECTED', 'IGNORED'] as TransactionStatus[]) {
      expect(planAmend(tx(status), { description: 'x' }), status).toEqual({ kind: 'NOT_AMENDABLE', status });
    }
  });
});

describe('planIgnore / planRestore (api-design.md §31.4)', () => {
  it('ignores any unconfirmed state; repeating is a no-op; confirmed states are refused', () => {
    for (const status of ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'] as TransactionStatus[]) expect(planIgnore(status)).toEqual({ kind: 'IGNORE' });
    expect(planIgnore('IGNORED')).toEqual({ kind: 'ALREADY_IGNORED' });
    for (const status of ['CONFIRMED', 'RECONCILED', 'CORRECTED'] as TransactionStatus[]) {
      expect(planIgnore(status)).toEqual({ kind: 'NOT_IGNORABLE', status });
    }
  });

  it('restores to CLASSIFIED with splits, else to the entry status', () => {
    expect(planRestore(tx('IGNORED'), true)).toEqual({ kind: 'RESTORE', nextStatus: 'CLASSIFIED' });
    expect(planRestore(tx('IGNORED'), false)).toEqual({ kind: 'RESTORE', nextStatus: 'UNREVIEWED' });
    expect(planRestore(tx('IGNORED', 'BANK_CSV'), false)).toEqual({ kind: 'RESTORE', nextStatus: 'IMPORTED' });
    expect(planRestore(tx('CLASSIFIED'), true)).toEqual({ kind: 'NOT_IGNORED', status: 'CLASSIFIED' });
    expect(entryStatus('BANK_API')).toBe('IMPORTED');
  });
});
