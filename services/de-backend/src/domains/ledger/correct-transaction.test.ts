import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { correctionFingerprint, opposite, planCorrection, type CorrectionOriginal } from './correct-transaction.js';
import type { FinancialAccountId } from './financial-account.js';
import type { SplitInput } from './transaction-split.js';
import type { BusinessDate, TransactionId, TransactionStatus } from './transaction.js';

const eur = (amount: string) => Money.of(amount, 'EUR');
const split = (amount: string, code = 'RENT_BASE'): SplitInput => ({
  amount: eur(amount),
  financialCategoryCode: code,
  propertyReferenceId: null,
  description: null,
});
const original = (overrides: Partial<CorrectionOriginal> = {}): CorrectionOriginal => ({
  financialAccountId: 'a1' as FinancialAccountId,
  amount: eur('1250.00'),
  direction: 'INFLOW',
  bookingDate: '2026-09-01' as BusinessDate,
  valueDate: '2026-09-02' as BusinessDate,
  description: 'Miete',
  propertyReferenceId: 'p1',
  status: 'CONFIRMED',
  correctionRole: null,
  reversalTransactionId: null,
  replacementTransactionId: null,
  ...overrides,
});
const splits = [split('1000.00'), split('250.00', 'RENT_OPERATING_COST_ADVANCE')];

describe('planCorrection (api-design.md §35)', () => {
  it('overlays the request on the original; omitted fields are copied, null clears', () => {
    const plan = planCorrection(original(), splits, { bookingDate: '2026-09-03' as BusinessDate, valueDate: null, description: null });
    expect(plan).toEqual({
      kind: 'CORRECT',
      replacement: {
        financialAccountId: 'a1',
        amount: eur('1250.00'),
        direction: 'INFLOW',
        bookingDate: '2026-09-03',
        valueDate: null,
        description: null,
        propertyReferenceId: 'p1',
        splits,
        splitsRequested: false,
      },
    });
    const requested = planCorrection(original(), splits, { splits: [split('1250.00')] });
    expect(requested).toMatchObject({ kind: 'CORRECT', replacement: { splits: [split('1250.00')], splitsRequested: true } });
  });

  it('only a confirmed Transaction that is not a reversal is correctable', () => {
    for (const status of ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED', 'IGNORED', 'RECONCILED'] as TransactionStatus[]) {
      expect(planCorrection(original({ status }), splits, { description: 'x' }), status).toEqual({ kind: 'NOT_CORRECTABLE', status });
    }
    expect(planCorrection(original({ correctionRole: 'REVERSAL' }), splits, { description: 'x' })).toEqual({
      kind: 'NOT_CORRECTABLE',
      status: 'CONFIRMED',
      correctionRole: 'REVERSAL',
    });
    // A replacement is an ordinary confirmed Transaction: the chain goes on.
    expect(planCorrection(original({ correctionRole: 'REPLACEMENT' }), splits, { description: 'x' }).kind).toBe('CORRECT');
  });

  it('a CORRECTED original names its existing correction', () => {
    const corrected = original({ status: 'CORRECTED', reversalTransactionId: 'r' as TransactionId, replacementTransactionId: 'n' as TransactionId });
    expect(planCorrection(corrected, splits, {})).toEqual({ kind: 'ALREADY_CORRECTED', reversalTransactionId: 'r', replacementTransactionId: 'n' });
  });

  it('NO_CHANGE only when nothing at all differs; description or PropertyReference alone is a change', () => {
    expect(planCorrection(original(), splits, {})).toEqual({ kind: 'NO_CHANGE' });
    expect(
      planCorrection(original(), splits, { amount: eur('1250'), description: 'Miete', splits: [split('1000'), split('250', 'RENT_OPERATING_COST_ADVANCE')] }),
    ).toEqual({ kind: 'NO_CHANGE' });
    expect(planCorrection(original(), splits, { description: 'Miete Sept.' }).kind).toBe('CORRECT');
    expect(planCorrection(original(), splits, { propertyReferenceId: null }).kind).toBe('CORRECT');
    expect(planCorrection(original(), splits, { splits: [split('250.00', 'RENT_OPERATING_COST_ADVANCE'), split('1000.00')] }).kind).toBe(
      'CORRECT',
    );
  });

  it('a reversal has the opposite direction', () => {
    expect(opposite('INFLOW')).toBe('OUTFLOW');
    expect(opposite('OUTFLOW')).toBe('INFLOW');
  });

  it('the fingerprint tells "omitted" from "null" and ignores id case and amount notation', () => {
    const base = { reason: 'r', replacement: {} };
    expect(correctionFingerprint('ABC', base)).toBe(correctionFingerprint('abc', base));
    expect(correctionFingerprint('a', { reason: 'r', replacement: { valueDate: null } })).not.toBe(correctionFingerprint('a', base));
    expect(correctionFingerprint('a', { reason: 'r', replacement: { amount: eur('1250') } })).toBe(
      correctionFingerprint('a', { reason: 'r', replacement: { amount: eur('1250.00') } }),
    );
    expect(correctionFingerprint('a', { reason: 'r2', replacement: {} })).not.toBe(correctionFingerprint('a', base));
  });
});
