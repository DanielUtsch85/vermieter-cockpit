import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { cashKindOf, compareWithMre, deriveFigures, type CashKind, type CountedCash, type DepositView } from './figures.js';

/** VC-5-03's figures (api-design.md §47.3). */
const eur = (amount: string) => Money.of(amount, 'EUR');
const HOLDING = 'k';
const deposit = (overrides: { status?: 'ACTIVE' | 'CLOSED' | 'VOID'; expected?: string; holding?: string | null } = {}) => ({
  status: overrides.status ?? 'ACTIVE',
  expectedAmount: eur(overrides.expected ?? '3000.00'),
  holdingFinancialAccountId: overrides.holding === undefined ? HOLDING : overrides.holding,
  closing: null,
});
let n = 0;
const cash = (kind: CashKind, amount: string, account = HOLDING, transactionId = `t${++n}`): CountedCash => ({
  transactionId,
  bookingDate: '2027-02-01' as BusinessDate,
  financialAccountId: account,
  kind,
  amount: eur(amount),
});
const json = (m: Money) => m.amount;

describe('cashKindOf (§47.3)', () => {
  it('SECURITY_DEPOSIT by direction, interest as INTEREST, anything else none', () => {
    expect(cashKindOf('SECURITY_DEPOSIT', 'INFLOW')).toBe('RECEIPT');
    expect(cashKindOf('SECURITY_DEPOSIT', 'OUTFLOW')).toBe('REPAYMENT');
    expect(cashKindOf('SECURITY_DEPOSIT_INTEREST', 'INFLOW')).toBe('INTEREST');
    expect(cashKindOf('RENT_BASE', 'INFLOW')).toBeUndefined();
  });
});

describe('deriveFigures (§47.3)', () => {
  it('no cash: zeros, the whole amount outstanding, EXPECTED, no flags', () => {
    const f = deriveFigures(deposit(), []);
    expect([f.received, f.interestCredited, f.returned, f.held].map(json)).toEqual(['0.00', '0.00', '0.00', '0.00']);
    expect([json(f.outstanding), f.state, f.flags]).toEqual(['3000.00', 'EXPECTED', []]);
  });

  it('three instalments: PARTIALLY_RECEIVED, then RECEIVED; interest adds to held, never reduces outstanding', () => {
    const first = [cash('RECEIPT', '1000.00')];
    expect(deriveFigures(deposit(), first)).toMatchObject({ state: 'PARTIALLY_RECEIVED' });
    const withInterest = [...first, cash('INTEREST', '2.50')];
    const f = deriveFigures(deposit(), withInterest);
    expect([json(f.received), json(f.interestCredited), json(f.outstanding), json(f.held), f.state]).toEqual([
      '1000.00',
      '2.50',
      '2000.00',
      '1002.50',
      'PARTIALLY_RECEIVED',
    ]);
    const all = [...withInterest, cash('RECEIPT', '1000.00'), cash('RECEIPT', '1000.00')];
    expect(deriveFigures(deposit(), all)).toMatchObject({ state: 'RECEIVED', flags: [] });
    expect(json(deriveFigures(deposit(), all).outstanding)).toBe('0.00');
  });

  it('repayments: PARTIALLY_RETURNED, then RETURNED at held 0; more repaid than held is RETURNED with RETURNED_EXCEEDS_HELD', () => {
    const held = [cash('RECEIPT', '3000.00'), cash('INTEREST', '4.00')];
    expect(deriveFigures(deposit(), [...held, cash('REPAYMENT', '2000.00')])).toMatchObject({ state: 'PARTIALLY_RETURNED' });
    expect(deriveFigures(deposit(), [...held, cash('REPAYMENT', '3004.00')])).toMatchObject({ state: 'RETURNED', flags: [] });
    const over = deriveFigures(deposit(), [...held, cash('REPAYMENT', '3010.00')]);
    expect([over.state, json(over.held)]).toEqual(['RETURNED', '-6.00']);
    expect(over.flags).toEqual([{ code: 'RETURNED_EXCEEDS_HELD', details: { excess: eur('6.00') } }]);
  });

  it('a repayment before any receipt is RETURNED with the flag; RECEIVED needs a receipt', () => {
    expect(deriveFigures(deposit(), [cash('REPAYMENT', '1.00')])).toMatchObject({ state: 'RETURNED', flags: [{ code: 'RETURNED_EXCEEDS_HELD' }] });
  });

  it('RECEIVED_EXCEEDS_EXPECTED with the excess; outstanding stays 0', () => {
    const f = deriveFigures(deposit({ expected: '1500.00' }), [cash('RECEIPT', '1600.00')]);
    expect([f.state, json(f.outstanding)]).toEqual(['RECEIVED', '0.00']);
    expect(f.flags).toEqual([{ code: 'RECEIVED_EXCEEDS_EXPECTED', details: { excess: eur('100.00') } }]);
  });

  it('RECEIVED_OUTSIDE_HOLDING_ACCOUNT: receipts on another account, unique, in cash order; never without a holding account', () => {
    const list = [cash('RECEIPT', '1.00', 'giro', 'a'), cash('RECEIPT', '1.00', 'giro', 'a'), cash('RECEIPT', '1.00'), cash('RECEIPT', '1.00', 'giro', 'b')];
    // Interest and repayments elsewhere are not checked.
    const others = [cash('INTEREST', '1.00', 'giro'), cash('REPAYMENT', '1.00', 'giro')];
    expect(deriveFigures(deposit(), [...list, ...others]).flags).toEqual([
      { code: 'RECEIVED_OUTSIDE_HOLDING_ACCOUNT', details: { transactionIds: ['a', 'b'] } },
    ]);
    expect(deriveFigures(deposit({ holding: null }), list).flags).toEqual([]);
  });

  it('flags in order, several at once', () => {
    const f = deriveFigures(deposit({ expected: '10.00' }), [cash('RECEIPT', '20.00', 'giro', 'x'), cash('REPAYMENT', '30.00')]);
    expect(f.flags.map((flag) => flag.code)).toEqual(['RECEIVED_EXCEEDS_EXPECTED', 'RETURNED_EXCEEDS_HELD', 'RECEIVED_OUTSIDE_HOLDING_ACCOUNT']);
  });

  it('CLOSED comes first, whatever the cash', () => {
    expect(deriveFigures(deposit({ status: 'CLOSED' }), [cash('RECEIPT', '3000.00')])).toMatchObject({ state: 'CLOSED' });
  });
});

describe('HELD_CHANGED_AFTER_CLOSING and the MRE comparison (§47.4)', () => {
  const closedAt = (held: string) => ({
    ...deposit({ status: 'CLOSED' }),
    closing: { closingDate: '2027-06-30' as BusinessDate, reason: 'OTHER' as const, closingNote: 'x', heldAtClosing: eur(held) },
  });

  it('a CLOSED deposit whose held moved since the closing, after the other flags; none while held is unchanged', () => {
    expect(deriveFigures(closedAt('3000.00'), [cash('RECEIPT', '3000.00')]).flags).toEqual([]);
    expect(deriveFigures(closedAt('3000.00'), [cash('RECEIPT', '3100.00')]).flags).toEqual([
      { code: 'RECEIVED_EXCEEDS_EXPECTED', details: { excess: eur('100.00') } },
      { code: 'HELD_CHANGED_AFTER_CLOSING', details: { heldAtClosing: eur('3000.00'), held: eur('3100.00') } },
    ]);
    // An ACTIVE deposit carries no closing, so no such flag.
    expect(deriveFigures(deposit(), [cash('RECEIPT', '3100.00')]).flags.map((f) => f.code)).toEqual(['RECEIVED_EXCEEDS_EXPECTED']);
  });

  const view = (base: ReturnType<typeof deposit> | ReturnType<typeof closedAt>, set: CountedCash[]): DepositView =>
    ({ ...base, expectedAmount: base.expectedAmount, figures: deriveFigures(base, set) }) as unknown as DepositView;

  it('EXPECTED_DIFFERS_FROM_MRE with a guaranty set and different; none for null or equal (other scale included)', () => {
    const v = view(deposit(), []);
    expect(compareWithMre(v, { kind: 'FOUND', values: { guaranty: eur('2500.00'), guarantyPayback: null } })).toMatchObject({
      mre: { guaranty: eur('2500.00'), guarantyPayback: null },
      figures: { flags: [{ code: 'EXPECTED_DIFFERS_FROM_MRE', details: { guaranty: eur('2500.00'), expectedAmount: eur('3000.00') } }] },
    });
    expect(compareWithMre(v, { kind: 'FOUND', values: { guaranty: eur('3000'), guarantyPayback: null } }).figures.flags).toEqual([]);
    expect(compareWithMre(v, { kind: 'FOUND', values: { guaranty: null, guarantyPayback: null } }).figures.flags).toEqual([]);
  });

  it('RETURNED_DIFFERS_FROM_MRE only when CLOSED and guarantyPayback is set; a payback 0 is a value', () => {
    const repaid = [cash('RECEIPT', '3000.00'), cash('REPAYMENT', '3000.00')];
    const found = (payback: string | null) => ({ kind: 'FOUND' as const, values: { guaranty: null, guarantyPayback: payback === null ? null : eur(payback) } });
    expect(compareWithMre(view(closedAt('0.00'), repaid), found('2900.00')).figures.flags).toEqual([
      { code: 'RETURNED_DIFFERS_FROM_MRE', details: { guarantyPayback: eur('2900.00'), returned: eur('3000.00') } },
    ]);
    expect(compareWithMre(view(closedAt('0.00'), repaid), found('3000.00')).figures.flags).toEqual([]);
    expect(compareWithMre(view(closedAt('0.00'), repaid), found(null)).figures.flags).toEqual([]);
    // Nothing returned in DE: a payback 0 agrees, any other amount differs.
    expect(compareWithMre(view(closedAt('3000.00'), [cash('RECEIPT', '3000.00')]), found('0.00')).figures.flags).toEqual([]);
    expect(compareWithMre(view(closedAt('3000.00'), [cash('RECEIPT', '3000.00')]), found('5.00')).figures.flags.map((f) => f.code)).toEqual([
      'RETURNED_DIFFERS_FROM_MRE',
    ]);
    expect(compareWithMre(view(deposit(), repaid), found('2900.00')).figures.flags).toEqual([]);
  });

  it('MRE unavailable or the Tenant gone: mre null and the flag after the others', () => {
    const v = view(deposit({ expected: '10.00' }), [cash('RECEIPT', '20.00')]);
    expect(compareWithMre(v, { kind: 'UNAVAILABLE' })).toMatchObject({
      mre: null,
      figures: { flags: [{ code: 'RECEIVED_EXCEEDS_EXPECTED' }, { code: 'MRE_UNAVAILABLE', details: {} }] },
    });
    expect(compareWithMre(v, { kind: 'TENANT_NOT_FOUND' }).figures.flags.map((f) => f.code)).toEqual(['RECEIVED_EXCEEDS_EXPECTED', 'MRE_TENANT_NOT_FOUND']);
  });
});
