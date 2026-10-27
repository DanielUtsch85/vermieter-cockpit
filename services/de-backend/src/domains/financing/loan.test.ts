import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { createFingerprint, debtFrom, fieldErrors, planAmend, planVoid, type Loan, type LoanId } from './loan.js';

/** VC-3-01 rules of api-design.md §41.1 that need no database. */
const day = (value: string) => value as BusinessDate;
const A = '0a000000-0000-4000-8000-000000000001';
const B = '0b000000-0000-4000-8000-000000000002';
const C = '0c000000-0000-4000-8000-000000000003';

const loan: Loan = {
  id: 'f0000000-0000-4000-8000-000000000000' as LoanId,
  mreRealmId: 'realm',
  status: 'ACTIVE',
  lenderPartyId: A,
  borrowerPartyIds: [B],
  principalOriginal: Money.of('250000.00', 'EUR'),
  startDate: day('2026-08-15'),
  disbursementDate: day('2026-09-01'),
  maturityDate: day('2046-09-01'),
  contractNumber: 'D-123',
  acquisitionId: null,
  sourceReferences: [],
  notes: null,
  voidedAt: null,
  voidReason: null,
  closingDate: null,
  closingReason: null,
  refinancedByLoanId: null,
  closingNote: null,
  createdAt: new Date('2026-08-15T10:00:00Z'),
  version: 1,
};

describe('debtFrom', () => {
  it('is the disbursement date, or the start date while that is unset', () => {
    expect(debtFrom(loan)).toBe('2026-09-01');
    expect(debtFrom({ ...loan, disbursementDate: null })).toBe('2026-08-15');
  });
});

describe('fieldErrors', () => {
  it('finds the lender among the borrowers at its position', () => {
    expect(fieldErrors({ ...loan, borrowerPartyIds: [B, A] })).toEqual([{ field: 'borrowerPartyIds.1', code: 'LENDER_IS_BORROWER' }]);
  });

  it('wants maturity after the debt starts, the disbursement date or else the start date', () => {
    expect(fieldErrors({ ...loan, maturityDate: day('2026-09-01') })).toEqual([{ field: 'maturityDate', code: 'NOT_AFTER_DISBURSEMENT' }]);
    expect(fieldErrors({ ...loan, maturityDate: day('2026-09-02') })).toEqual([]);
    expect(fieldErrors({ ...loan, disbursementDate: null, maturityDate: day('2026-08-16') })).toEqual([]);
    expect(fieldErrors({ ...loan, maturityDate: null })).toEqual([]);
  });
});

describe('planAmend', () => {
  it('answers a VOID or CLOSED Loan with LOAN_NOT_ACTIVE, a no-op included (review on #59)', () => {
    expect(planAmend({ ...loan, status: 'VOID' }, { notes: null })).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
    expect(planAmend({ ...loan, status: 'CLOSED' }, { contractNumber: 'D-123' })).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'CLOSED' });
  });

  it('is a no-op when every value equals the current one', () => {
    expect(planAmend(loan, { contractNumber: 'D-123', borrowerPartyIds: [B], notes: null })).toEqual({ kind: 'UNCHANGED' });
  });

  it('names the changed fields and the Parties named anew, in id order', () => {
    expect(planAmend(loan, { borrowerPartyIds: [C, B], notes: 'Zinsbindung 10 Jahre' })).toMatchObject({
      kind: 'AMEND',
      changed: ['borrowerPartyIds', 'notes'],
      newPartyIds: [C],
    });
    // A borrower who stays is not named anew; a new lender is.
    expect(planAmend(loan, { lenderPartyId: C })).toMatchObject({ kind: 'AMEND', changed: ['lenderPartyId'], newPartyIds: [C] });
  });

  it('allows a swap of lender and borrower', () => {
    expect(planAmend(loan, { lenderPartyId: B, borrowerPartyIds: [A] })).toMatchObject({ kind: 'AMEND', newPartyIds: [] });
  });

  it('checks the merged values: the lender amended to a current borrower, or a maturity too early', () => {
    expect(planAmend(loan, { lenderPartyId: B })).toEqual({ kind: 'INVALID', errors: [{ field: 'borrowerPartyIds.0', code: 'LENDER_IS_BORROWER' }] });
    expect(planAmend(loan, { maturityDate: day('2026-08-31') })).toEqual({ kind: 'INVALID', errors: [{ field: 'maturityDate', code: 'NOT_AFTER_DISBURSEMENT' }] });
  });
});

describe('planVoid', () => {
  const at = new Date('2026-10-01T00:00:00Z');

  it('voids an ACTIVE Loan without splits, version + 1', () => {
    expect(planVoid(loan, 'Doppelt erfasst', at, [])).toEqual({ kind: 'VOID', next: { ...loan, status: 'VOID', voidedAt: at, voidReason: 'Doppelt erfasst', version: 2 } });
  });

  it('is a no-op on a VOID Loan and refuses a CLOSED one', () => {
    expect(planVoid({ ...loan, status: 'VOID' }, 'x', at, [])).toEqual({ kind: 'UNCHANGED' });
    expect(planVoid({ ...loan, status: 'CLOSED' }, 'x', at, [])).toEqual({ kind: 'LOAN_CLOSED' });
  });

  it('refuses while splits reference it, naming each Transaction once', () => {
    expect(planVoid(loan, 'x', at, [C, B, C])).toEqual({ kind: 'LOAN_HAS_SPLITS', transactionIds: [B, C] });
  });
});

describe('createFingerprint', () => {
  it('differs for every field of the payload', () => {
    const base = { ...loan };
    const variants = [
      { lenderPartyId: C },
      { borrowerPartyIds: [C] },
      { principalOriginal: Money.of('250000.01', 'EUR') },
      { startDate: day('2026-08-16') },
      { disbursementDate: null },
      { maturityDate: null },
      { contractNumber: null },
      { acquisitionId: C },
      { sourceReferences: ['x'] },
      { notes: 'x' },
    ];
    const prints = new Set([createFingerprint(base), ...variants.map((v) => createFingerprint({ ...base, ...v }))]);
    expect(prints.size).toBe(variants.length + 1);
  });
});
