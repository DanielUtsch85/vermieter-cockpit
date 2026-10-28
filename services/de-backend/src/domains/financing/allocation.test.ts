import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import {
  allocationFingerprint,
  checkAppendAllocation,
  planVoidAllocation,
  propertyLoansOf,
  selectPropertyLoans,
  setOn,
  sharesFromPrices,
  sumsToOne,
  type LoanAllocationSet,
  type LoanAllocationSetId,
} from './allocation.js';
import type { Loan, LoanId } from './loan.js';
import { withValidUntil } from './terms.js';

const day = (value: string) => value as BusinessDate;
const f = (n: bigint, d: bigint) => ({ numerator: n, denominator: d });

const loan: Loan = {
  id: 'l0000000-0000-4000-8000-000000000001' as LoanId,
  mreRealmId: 'realm',
  status: 'ACTIVE',
  lenderPartyId: 'bank',
  borrowerPartyIds: ['anna'],
  principalOriginal: Money.of('475000.00', 'EUR'),
  currency: 'EUR',
  startDate: day('2026-08-15'),
  disbursementDate: day('2026-09-01'),
  maturityDate: null,
  contractNumber: null,
  acquisitionId: null,
  sourceReferences: [],
  notes: null,
  voidedAt: null,
  voidReason: null,
  closingDate: null,
  closingReason: null,
  refinancedByLoanId: null,
  closingNote: null,
  createdAt: new Date('2026-08-15T00:00:00Z'),
  version: 1,
} as Loan;

const set = (id: string, validFrom: string, overrides: Partial<LoanAllocationSet> = {}): LoanAllocationSet => ({
  id: id as LoanAllocationSetId,
  loanId: loan.id,
  mreRealmId: 'realm',
  status: 'VALID',
  validFrom: day(validFrom),
  basis: 'MANUAL',
  allocations: [
    { propertyReferenceId: 'p1', share: f(1n, 2n), acquisitionId: null },
    { propertyReferenceId: 'p2', share: f(1n, 2n), acquisitionId: null },
  ],
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  version: 1,
  ...overrides,
});

describe('allocation shares (§41.3)', () => {
  it('derives exact, reduced shares from the purchase prices in cents', () => {
    expect(sharesFromPrices([30_000_000n, 17_500_000n])).toEqual([f(12n, 19n), f(7n, 19n)]);
    expect(sharesFromPrices([12_345_678n])).toEqual([f(1n, 1n)]);
  });

  it('keeps a denominator above 10 000 exact', () => {
    const shares = sharesFromPrices([10_000_001n, 9_999_999n]);
    expect(shares).toEqual([f(10_000_001n, 20_000_000n), f(9_999_999n, 20_000_000n)]);
    expect(sumsToOne(shares)).toBe(true);
  });

  it('sums manual shares exactly', () => {
    expect(sumsToOne([f(1n, 3n), f(1n, 3n), f(1n, 3n)])).toBe(true);
    expect(sumsToOne([f(1n, 3n), f(2n, 3n), f(1n, 10_000n)])).toBe(false);
    expect(sumsToOne([f(1n, 3n), f(1n, 3n)])).toBe(false);
    expect(sumsToOne([f(1n, 1n)])).toBe(true);
  });

  it('fingerprints the normalized request', () => {
    const request = {
      validFrom: day('2026-09-01'),
      basis: 'MANUAL' as const,
      allocations: [{ propertyReferenceId: 'p1', share: f(1n, 1n), acquisitionId: null }],
      notes: null,
    };
    expect(allocationFingerprint(loan.id, request)).toBe(allocationFingerprint(loan.id, { ...request }));
    expect(allocationFingerprint(loan.id, request)).not.toBe(allocationFingerprint(loan.id, { ...request, validFrom: day('2026-09-02') }));
  });
});

describe('sets over time (§41.3)', () => {
  const sets = withValidUntil([set('a', '2026-09-01'), set('v', '2027-01-01', { status: 'VOID' }), set('b', '2027-03-01')]);

  it('derives validUntil over the VALID sets only', () => {
    expect(sets.map((s) => [s.id, s.validUntil])).toEqual([
      ['a', '2027-02-28'],
      ['v', '2027-02-28'],
      ['b', null],
    ]);
  });

  it('finds the set covering a day, null before the first', () => {
    expect(setOn(sets, day('2026-08-31'))).toBeNull();
    expect(setOn(sets, day('2026-09-01'))?.id).toBe('a');
    expect(setOn(sets, day('2027-01-15'))?.id).toBe('a');
    expect(setOn(sets, day('2027-02-28'))?.id).toBe('a');
    expect(setOn(sets, day('2027-03-01'))?.id).toBe('b');
    expect(setOn(sets, day('2099-01-01'))?.id).toBe('b');
  });

  it('lists a property per set, newest first, and only the covering one with asOf', () => {
    const items = propertyLoansOf(loan, sets, 'p1');
    expect(items.map((i) => i.allocationSetId)).toEqual(['a', 'b']);
    expect(propertyLoansOf(loan, sets, 'p9')).toEqual([]);
    expect(selectPropertyLoans(items).map((i) => i.allocationSetId)).toEqual(['b', 'a']);
    expect(selectPropertyLoans(items, day('2027-02-28')).map((i) => i.allocationSetId)).toEqual(['a']);
    expect(selectPropertyLoans(items, day('2026-08-31'))).toEqual([]);
  });

  it('checks an append: ACTIVE, not before the debt, after the last VALID set', () => {
    const valid = [set('a', '2026-09-01')];
    expect(checkAppendAllocation({ ...loan, status: 'VOID' }, valid, day('2027-01-01'))).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'VOID' });
    expect(checkAppendAllocation(loan, [], day('2026-08-31'))).toEqual({ kind: 'ALLOCATION_BEFORE_DEBT', debtFrom: '2026-09-01' });
    expect(checkAppendAllocation(loan, valid, day('2026-09-01'))).toEqual({ kind: 'ALLOCATION_NOT_APPENDED', lastValidFrom: '2026-09-01' });
    expect(checkAppendAllocation(loan, valid, day('2026-09-02'))).toBeUndefined();
    expect(checkAppendAllocation(loan, [], day('2026-09-01'))).toBeUndefined();
  });

  it('voids only the last VALID set; a VOID one is a no-op', () => {
    const a = set('a', '2026-09-01');
    const b = set('b', '2027-03-01');
    const at = new Date('2027-04-01T00:00:00Z');
    expect(planVoidAllocation(loan, a, [a, b], 'x', at)).toEqual({ kind: 'ALLOCATION_NOT_LAST', laterAllocationSetId: 'b' });
    expect(planVoidAllocation(loan, { ...a, status: 'VOID' }, [b], 'x', at)).toEqual({ kind: 'UNCHANGED' });
    expect(planVoidAllocation({ ...loan, status: 'CLOSED' }, b, [a, b], 'x', at)).toEqual({ kind: 'LOAN_NOT_ACTIVE', status: 'CLOSED' });
    expect(planVoidAllocation(loan, b, [a, b], 'x', at)).toMatchObject({ kind: 'VOID', next: { status: 'VOID', voidReason: 'x', voidedAt: at, version: 2 } });
  });
});
