import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import {
  createFingerprint,
  planAmend,
  planClose,
  planReopen,
  planVoid,
  resolveNew,
  retainedAmountOf,
  type CloseCash,
  type CloseRequest,
  type DepositRequest,
  type SecurityDeposit,
  type SecurityDepositId,
} from './deposit.js';
import type { CountedCash } from './figures.js';

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
  closing: null,
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

  it('VOID: DEPOSIT_NOT_ACTIVE, even for equal values', () => {
    expect(planAmend(deposit({ status: 'VOID' }), { notes: null })).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', status: 'VOID' });
  });

  it('CLOSED (§47.4): notes only; any other changed field is DEPOSIT_NOT_ACTIVE, an equal one is no change', () => {
    const closed = deposit({ status: 'CLOSED' });
    expect(planAmend(closed, { notes: 'x' })).toMatchObject({ kind: 'AMEND', changed: ['notes'] });
    expect(planAmend(closed, { notes: null, interestBearing: true })).toEqual({ kind: 'UNCHANGED' });
    expect(planAmend(closed, { notes: 'x', interestBearing: false })).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', status: 'CLOSED' });
    expect(planAmend(closed, { expectedAmount: eur('2000.00') })).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', status: 'CLOSED' });
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

describe('planClose (§47.4)', () => {
  const at = (bookingDate: string, transactionId = `t-${bookingDate}`) => ({ transactionId, bookingDate: bookingDate as BusinessDate });
  const counted = (kind: CountedCash['kind'], amount: string, bookingDate = '2027-02-01', transactionId = `c-${bookingDate}-${amount}`): CountedCash => ({
    ...at(bookingDate, transactionId),
    financialAccountId: 'k',
    kind,
    amount: eur(amount),
  });
  const request = (reason: CloseRequest['reason'], closingNote: string | null = null): CloseRequest => ({
    closingDate: '2027-06-30' as BusinessDate,
    reason,
    closingNote,
  });
  const none: CloseCash = { counted: [], open: [] };
  const full: CloseCash = { counted: [counted('RECEIPT', '3000.00'), counted('REPAYMENT', '3000.00', '2027-06-01')], open: [] };

  it('RETURNED at held 0, RETAINED at held > 0, OTHER at any held: CLOSE with heldAtClosing', () => {
    expect(planClose(deposit(), request('RETURNED'), full)).toEqual({ kind: 'CLOSE', closing: { ...request('RETURNED'), heldAtClosing: eur('0.00') } });
    const part: CloseCash = { counted: [counted('RECEIPT', '3000.00'), counted('INTEREST', '4.20'), counted('REPAYMENT', '2500.00', '2027-06-01')], open: [] };
    expect(planClose(deposit(), request('RETAINED', 'Schaden'), part)).toMatchObject({ kind: 'CLOSE', closing: { heldAtClosing: eur('504.20') } });
    expect(planClose(deposit(), request('OTHER', 'x'), none)).toMatchObject({ kind: 'CLOSE', closing: { heldAtClosing: eur('0.00') } });
  });

  it('the order: no-op, not ACTIVE, cash after the date (booking-date order, counted and open), open cash, then held by reason', () => {
    const closedWith = deposit({ status: 'CLOSED', closing: { ...request('RETURNED'), heldAtClosing: eur('0.00') } });
    // Whatever the cash, the same values are a no-op; other values are not.
    expect(planClose(closedWith, request('RETURNED'), { counted: [], open: [at('2027-08-01')] })).toEqual({ kind: 'UNCHANGED' });
    expect(planClose(closedWith, request('RETURNED', 'x'), none)).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', status: 'CLOSED' });
    expect(planClose(closedWith, { ...request('RETURNED'), closingDate: '2027-07-01' as BusinessDate }, none)).toEqual({
      kind: 'DEPOSIT_NOT_ACTIVE',
      status: 'CLOSED',
    });
    expect(planClose(deposit({ status: 'VOID' }), request('OTHER', 'x'), none)).toEqual({ kind: 'DEPOSIT_NOT_ACTIVE', status: 'VOID' });
    const late: CloseCash = {
      counted: [counted('RECEIPT', '1.00', '2027-08-01', 'late'), counted('RECEIPT', '1.00', '2027-06-30', 'on')],
      open: [at('2027-07-01', 'open'), at('2027-06-01', 'early')],
    };
    expect(planClose(deposit(), request('OTHER', 'x'), late)).toEqual({ kind: 'CASH_AFTER_CLOSING_DATE', transactionIds: ['open', 'late'] });
    expect(
      planClose(deposit(), request('OTHER', 'x'), { counted: late.counted.slice(1), open: [at('2027-06-01', 'early'), at('2027-06-30', 'last')] }),
    ).toEqual({
      kind: 'UNCONFIRMED_CASH',
      transactionIds: ['early', 'last'],
    });
    expect(planClose(deposit(), request('RETURNED'), { counted: [counted('RECEIPT', '10.00')], open: [] })).toEqual({
      kind: 'DEPOSIT_STILL_HELD',
      held: eur('10.00'),
    });
    const over: CloseCash = { counted: [counted('RECEIPT', '10.00'), counted('REPAYMENT', '15.00')], open: [] };
    // More repaid than held is RETURNED, as §47.3's state (review on #136).
    expect(planClose(deposit(), request('RETURNED'), over)).toEqual({ kind: 'CLOSE', closing: { ...request('RETURNED'), heldAtClosing: eur('-5.00') } });
    expect(planClose(deposit(), request('RETAINED', 'x'), over)).toEqual({ kind: 'NOTHING_RETAINED', held: eur('-5.00') });
    expect(planClose(deposit(), request('RETAINED', 'x'), none)).toEqual({ kind: 'NOTHING_RETAINED', held: eur('0.00') });
  });
});

describe('planReopen and retainedAmountOf (§47.4)', () => {
  it('CLOSED → REOPEN; ACTIVE a no-op; VOID DEPOSIT_NOT_CLOSED', () => {
    expect(planReopen(deposit({ status: 'CLOSED' }))).toEqual({ kind: 'REOPEN' });
    expect(planReopen(deposit())).toEqual({ kind: 'UNCHANGED' });
    expect(planReopen(deposit({ status: 'VOID' }))).toEqual({ kind: 'DEPOSIT_NOT_CLOSED', status: 'VOID' });
  });

  it('retainedAmount: heldAtClosing for RETAINED and OTHER, never negative; 0 for RETURNED', () => {
    const closing = (reason: CloseRequest['reason'], held: string) => ({
      closingDate: '2027-06-30' as BusinessDate,
      reason,
      closingNote: 'x',
      heldAtClosing: eur(held),
    });
    expect(retainedAmountOf(closing('RETAINED', '500.00'))).toEqual(eur('500.00'));
    expect(retainedAmountOf(closing('OTHER', '12.00'))).toEqual(eur('12.00'));
    expect(retainedAmountOf(closing('OTHER', '-5.00'))).toEqual(eur('0.00'));
    expect(retainedAmountOf(closing('RETURNED', '0.00'))).toEqual(eur('0.00'));
    expect(retainedAmountOf(closing('RETURNED', '-5.00'))).toEqual(eur('0.00'));
  });
});
