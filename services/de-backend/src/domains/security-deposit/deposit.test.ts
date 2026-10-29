import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { createFingerprint, planAmend, planVoid, resolveNew, type DepositRequest, type SecurityDeposit, type SecurityDepositId } from './deposit.js';

/** VC-5-01's rules (api-design.md §47.1). */
const eur = (amount: string) => Money.of(amount, 'EUR');
const request = (overrides: Partial<DepositRequest> = {}): DepositRequest => ({
  mreRealmId: 'r',
  mreTenantId: '6512f0c2a1b2c3d4e5f60a01',
  expectedAmount: null,
  holdingFinancialAccountId: null,
  interestBearing: true,
  notes: null,
  ...overrides,
});
const deposit = (overrides: Partial<SecurityDeposit> = {}): SecurityDeposit => ({
  id: 'd1' as SecurityDepositId,
  mreRealmId: 'r',
  status: 'ACTIVE',
  mreTenantId: '6512f0c2a1b2c3d4e5f60a01',
  expectedAmount: eur('3000.00'),
  expectedAmountSource: 'REQUEST',
  holdingFinancialAccountId: null,
  interestBearing: true,
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2027-01-01T00:00:00Z'),
  version: 1,
  ...overrides,
});

describe('resolveNew (P5-D1)', () => {
  it("the request's amount wins and is REQUEST; MRE's guaranty is ignored then", () => {
    expect(resolveNew(request({ expectedAmount: eur('2500.00') }), eur('3000.00'))).toMatchObject({
      expectedAmount: eur('2500.00'),
      expectedAmountSource: 'REQUEST',
    });
  });

  it("without an amount: MRE's guaranty, MRE_GUARANTY", () => {
    expect(resolveNew(request(), eur('3000.00'))).toMatchObject({ expectedAmount: eur('3000.00'), expectedAmountSource: 'MRE_GUARANTY' });
  });

  it('without an amount and no positive guaranty (null, 0): undefined (EXPECTED_AMOUNT_REQUIRED)', () => {
    expect(resolveNew(request(), null)).toBeUndefined();
    expect(resolveNew(request(), eur('0.00'))).toBeUndefined();
  });
});

describe('createFingerprint', () => {
  it('is equal for equal requests and differs on any field', () => {
    expect(createFingerprint(request())).toBe(createFingerprint(request()));
    for (const change of [
      { mreTenantId: '6512f0c2a1b2c3d4e5f60a02' },
      { expectedAmount: eur('1.00') },
      { holdingFinancialAccountId: 'a' },
      { interestBearing: false },
      { notes: 'x' },
    ]) {
      expect(createFingerprint(request(change))).not.toBe(createFingerprint(request()));
    }
  });
});

describe('planAmend (§47.1)', () => {
  it('a changed amount and account; the newly named account is returned for its check', () => {
    expect(planAmend(deposit(), { expectedAmount: eur('3100.00'), holdingFinancialAccountId: 'acc' })).toMatchObject({
      kind: 'AMEND',
      changed: ['expectedAmount', 'holdingFinancialAccountId'],
      newHoldingAccountId: 'acc',
    });
  });

  it('equal values, an equal amount of other scale included, are a no-op', () => {
    expect(planAmend(deposit(), { expectedAmount: eur('3000'), interestBearing: true, notes: null })).toEqual({ kind: 'UNCHANGED' });
  });

  it('clearing the account names none to check', () => {
    expect(planAmend(deposit({ holdingFinancialAccountId: 'acc' }), { holdingFinancialAccountId: null })).toMatchObject({
      kind: 'AMEND',
      newHoldingAccountId: null,
    });
  });

  it('not ACTIVE: DEPOSIT_NOT_ACTIVE, even for equal values', () => {
    expect(planAmend(deposit({ status: 'VOID' }), { notes: null })).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', status: 'VOID' });
    expect(planAmend(deposit({ status: 'CLOSED' }), { notes: 'x' })).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', status: 'CLOSED' });
  });
});

describe('planVoid (§47.1)', () => {
  const at = new Date('2027-02-01T00:00:00Z');

  it('ACTIVE → VOID with time, reason and version + 1', () => {
    expect(planVoid(deposit(), 'Irrtum', at, [])).toEqual({
      kind: 'VOID',
      next: { ...deposit(), status: 'VOID', voidedAt: at, voidReason: 'Irrtum', version: 2 },
    });
  });

  it('VOID: a no-op; CLOSED: DEPOSIT_CLOSED; with splits: DEPOSIT_HAS_SPLITS, ids unique and sorted', () => {
    expect(planVoid(deposit({ status: 'VOID' }), 'x', at, ['t1'])).toEqual({ kind: 'UNCHANGED' });
    expect(planVoid(deposit({ status: 'CLOSED' }), 'x', at, [])).toEqual({ kind: 'DEPOSIT_CLOSED' });
    expect(planVoid(deposit(), 'x', at, ['t2', 't1', 't2'])).toEqual({ kind: 'DEPOSIT_HAS_SPLITS', transactionIds: ['t1', 't2'] });
  });
});
