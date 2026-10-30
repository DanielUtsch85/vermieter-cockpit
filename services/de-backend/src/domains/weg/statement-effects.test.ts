import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { viewStatement, type AnnualStatement, type StatementCostLine, type WegAnnualStatementId } from './annual-statement.js';
import { deriveComparison, proposeSettlement, type CountedWegSplit, type Settlement, type WegCategory } from './statement-effects.js';

/** The ledger effects of a statement (api-design.md §51). Figures are invented. */
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;

const line = (position: number, classification: StatementCostLine['classification'], unitShare: string): StatementCostLine => ({
  position,
  account: `Konto ${position}`,
  group: classification === 'RECOVERABLE' ? 'RECOVERABLE' : 'NON_RECOVERABLE',
  allocationKey: 'Miteigentumsanteile',
  allocationTotal: null,
  allocationShare: null,
  totalAmount: eur(unitShare),
  unitShare: eur(unitShare),
  classification,
  classificationSource: 'PRINTED_GROUP',
});

/** Costs 1,500 (recoverable 1,000, non-recoverable 500), Hausgeld requested 1,800, reserve 600: a credit of 300. */
const statement = (overrides: Partial<AnnualStatement> = {}) =>
  viewStatement({
    id: 'st-1' as WegAnnualStatementId,
    mreRealmId: 'r',
    membershipId: 'm',
    financialYear: 2025,
    periodFrom: day('2025-01-01'),
    periodUntil: day('2025-12-31'),
    documentDate: null,
    resolutionDate: null,
    dueDate: null,
    supersedes: null,
    supersededBy: null,
    costLines: [line(1, 'RECOVERABLE', '1000.00'), line(2, 'NON_RECOVERABLE', '500.00')],
    recoverableSubtotal: eur('1000.00'),
    nonRecoverableSubtotal: eur('500.00'),
    totalCosts: eur('1500.00'),
    hausgeldRequested: eur('1800.00'),
    hausgeldPaid: eur('1800.00'),
    reserveRequested: eur('600.00'),
    reservePaid: eur('600.00'),
    settlementPeak: eur('-300.00'),
    settlementResult: null,
    reserve: {
      source: 'ANNUAL_STATEMENT',
      lines: [
        { position: 1, description: 'Dachreparatur', kind: 'WITHDRAWAL', opening: null, addition: null, withdrawal: eur('3000.00'), closing: null },
        { position: 2, description: 'Zuführung', kind: 'CONTRIBUTION', opening: null, addition: eur('9600.00'), withdrawal: null, closing: null },
      ],
      unitShareOpening: null,
      unitShareClosing: null,
    },
    status: 'CONFIRMED',
    confirmedAt: new Date(),
    voidedAt: null,
    voidReason: null,
    sourceReferences: [],
    notes: null,
    createdAt: new Date(),
    version: 2,
    ...overrides,
  });

/** Twelve months of the plan's two debits: Hausgeld 150 (100 recoverable, 50 not) and reserve 50. */
const year = (): CountedWegSplit[] =>
  Array.from({ length: 12 }, (_, i) => {
    const bookingDate = day(`2025-${String(i + 1).padStart(2, '0')}-02`);
    const split = (category: WegCategory, amount: string) => ({ transactionId: `t-${i}`, bookingDate, category, amount: eur(amount) });
    return [split('WEG_RECOVERABLE', '100.00'), split('WEG_NON_RECOVERABLE', '50.00'), split('WEG_RESERVE_CONTRIBUTION', '50.00')];
  }).flat();
const mea = { numerator: '250', denominator: '10000' };
const compare = (input: { statement?: ReturnType<typeof statement>; advances?: CountedWegSplit[]; settlements?: Settlement[]; uncounted?: string[] } = {}) =>
  deriveComparison({
    statement: input.statement ?? statement(),
    mea,
    advances: input.advances ?? year(),
    settlements: input.settlements ?? [],
    uncountedTransactionIds: input.uncounted ?? [],
  });
const amounts = (c: ReturnType<typeof compare>) =>
  Object.fromEntries(Object.entries(c.classes).map(([k, v]) => [k, [v.paid.amount, v.actual.amount, v.difference.amount]]));

describe('deriveComparison (§51)', () => {
  it('per class paid, actual and difference; Σ difference = settlementPeak + unpaidAdvances, exactly', () => {
    const c = compare();
    expect(amounts(c)).toEqual({
      RECOVERABLE: ['1200.00', '1000.00', '-200.00'],
      NON_RECOVERABLE: ['600.00', '500.00', '-100.00'],
      RESERVE: ['600.00', '600.00', '0.00'],
    });
    expect(c.advances).toEqual({ requested: eur('2400.00'), counted: eur('2400.00'), unpaidAdvances: eur('0.00') });
    expect(c.flags).toEqual([]);
  });

  it('an advance owed but not paid shows in unpaidAdvances, and the identity still holds', () => {
    const c = compare({ advances: year().filter((s) => s.transactionId !== 't-11') });
    expect(c.advances.unpaidAdvances).toEqual(eur('200.00'));
    expect(c.flags.map((f) => f.code)).toEqual(['PAID_DIFFERS_FROM_PRINTED', 'PAID_DIFFERS_FROM_PRINTED']);
    expect(c.flags[0]?.details).toEqual({ block: 'HAUSGELD', counted: eur('1650.00'), printed: eur('1800.00') });
  });

  it('more counted than requested: unpaidAdvances negative; a refund INFLOW counts negative', () => {
    const refund = { transactionId: 'r', bookingDate: day('2025-06-01'), category: 'WEG_NON_RECOVERABLE' as const, amount: eur('-20.00') };
    const extra = { ...refund, transactionId: 'x', amount: eur('70.00') };
    const c = compare({ advances: [...year(), refund, extra], statement: statement({ hausgeldPaid: eur('1850.00') }) });
    expect(c.classes.NON_RECOVERABLE.paid).toEqual(eur('650.00'));
    expect(c.advances.unpaidAdvances).toEqual(eur('-50.00'));
    expect(c.flags).toEqual([]);
  });

  it('reserve not printed: the reserve paid stays a difference of its own, the identity holds', () => {
    const c = compare({ statement: statement({ reserveRequested: null, reservePaid: null }) });
    expect(c.classes.RESERVE).toEqual({ paid: eur('600.00'), actual: eur('0.00'), difference: eur('-600.00') });
    expect(c.advances.requested).toEqual(eur('1800.00'));
    expect(c.flags).toEqual([]);
  });

  it('a line classified RESERVE is the reserve actual; the printed advance is not added twice (review on #151)', () => {
    const lines = [line(1, 'RECOVERABLE', '1000.00'), line(2, 'NON_RECOVERABLE', '400.00'), line(3, 'RESERVE', '100.00')];
    const c = compare({ statement: statement({ costLines: lines }) });
    expect(c.classes.RESERVE.actual).toEqual(eur('100.00'));
    expect(c.advances.requested).toEqual(eur('1800.00'));
    expect(c.flags).toEqual([{ code: 'RESERVE_COUNTED_TWICE', details: { lines: eur('100.00'), printed: eur('600.00') } }]);
  });

  it('PEAK_IDENTITY_DIFFERS when the printed peak does not follow from the lines', () => {
    const c = compare({ statement: statement({ settlementPeak: eur('-299.99') }) });
    expect(c.flags).toEqual([{ code: 'PEAK_IDENTITY_DIFFERS', details: { derived: eur('-300.00'), printed: eur('-299.99') } }]);
  });

  it('the settlement over the chain: settled, open, SETTLED_AGAINST_SUPERSEDED; SUPERSEDED; uncounted splits', () => {
    const settlements: Settlement[] = [
      { transactionId: 'b', statementId: 'st-1', bookingDate: day('2026-05-02'), amount: eur('-100.00') },
      { transactionId: 'a', statementId: 'st-0', bookingDate: day('2026-04-02'), amount: eur('-150.00') },
    ];
    const c = compare({ settlements, uncounted: ['u2', 'u1', 'u2'], statement: statement({ supersededBy: 'st-2' }) });
    expect(c.settlement.settledBy.map((s) => s.transactionId)).toEqual(['a', 'b']);
    expect(c.settlement).toMatchObject({ settled: eur('-250.00'), open: eur('-50.00') });
    expect(c.flags).toEqual([
      { code: 'UNCOUNTED_WEG_SPLITS', details: { transactionIds: ['u1', 'u2'] } },
      { code: 'SETTLED_AGAINST_SUPERSEDED', details: { transactionIds: ['a'] } },
      { code: 'SUPERSEDED', details: { supersededBy: 'st-2' } },
    ]);
  });

  it('one settledBy entry per Transaction and statement: a refund split over both classes', () => {
    const half = (amount: string): Settlement => ({ transactionId: 'r', statementId: 'st-1', bookingDate: day('2026-05-02'), amount: eur(amount) });
    expect(compare({ settlements: [half('-200.00'), half('-100.00')] }).settlement.settledBy).toEqual([half('-300.00')]);
  });

  it('the reserve withdrawals with the unit share by MEA, half-up', () => {
    expect(compare().reserveWithdrawals).toEqual([
      { position: 1, description: 'Dachreparatur', withdrawal: eur('3000.00'), unitShare: eur('75.00'), date: null },
    ]);
    // 0.10 × 125.5/1000 = 0.01255 → 0.01; 0.20 × 125.5/1000 = 0.0251 → 0.03 (rounded from 2.51 cents).
    const odd = (withdrawal: string) =>
      deriveComparison({
        statement: statement({
          reserve: {
            source: 'ASSET_REPORT',
            lines: [{ position: 1, description: 'x', kind: 'WITHDRAWAL', opening: null, addition: null, withdrawal: eur(withdrawal), closing: null }],
            unitShareOpening: null,
            unitShareClosing: null,
          },
        }),
        mea: { numerator: '125.5', denominator: '1000' },
        advances: year(),
        settlements: [],
        uncountedTransactionIds: [],
      }).reserveWithdrawals[0]?.unitShare;
    expect(odd('0.10')).toEqual(eur('0.01'));
    expect(odd('0.20')).toEqual(eur('0.03'));
    expect(odd('0.12')).toEqual(eur('0.02'));
  });
});

describe('proposeSettlement (§51)', () => {
  const classes = (recoverable: string, nonRecoverable: string) => ({
    settlementPeak: eur((Number(recoverable) + Number(nonRecoverable)).toFixed(2)),
    classes: {
      RECOVERABLE: { paid: eur('0'), actual: eur('0'), difference: eur(recoverable) },
      NON_RECOVERABLE: { paid: eur('0'), actual: eur('0'), difference: eur(nonRecoverable) },
      RESERVE: { paid: eur('0'), actual: eur('0'), difference: eur('99.00') },
    },
  });
  const split = (p: ReturnType<typeof proposeSettlement>) => p.splits.map((s) => [s.financialCategoryCode, s.amount.amount]);

  it('a refund over both classes in proportion; the reserve is not settled here', () => {
    const p = proposeSettlement(eur('300.00'), 'INFLOW', classes('-200.00', '-100.00'));
    expect(split(p)).toEqual([
      ['WEG_RECOVERABLE', '200.00'],
      ['WEG_NON_RECOVERABLE', '100.00'],
    ]);
    expect(p.flags).toEqual([]);
  });

  it('half-up with the rest on the larger part; an amount off the peak is flagged', () => {
    const p = proposeSettlement(eur('100.00'), 'OUTFLOW', classes('100.00', '200.00'));
    expect(split(p)).toEqual([
      ['WEG_RECOVERABLE', '33.33'],
      ['WEG_NON_RECOVERABLE', '66.67'],
    ]);
    expect(p.flags).toEqual([{ code: 'AMOUNT_DIFFERS_FROM_PEAK', details: { difference: eur('-200.00') } }]);
  });

  it('mixed signs: only the class of the payment sign, flagged', () => {
    const p = proposeSettlement(eur('30.00'), 'OUTFLOW', classes('50.00', '-20.00'));
    expect(split(p)).toEqual([['WEG_RECOVERABLE', '30.00']]);
    expect(p.flags.map((f) => f.code)).toEqual(['MIXED_DIFFERENCES']);
  });

  it('no class of the payment sign: all non-recoverable, flagged', () => {
    const p = proposeSettlement(eur('10.00'), 'OUTFLOW', { ...classes('-5.00', '0.00'), settlementPeak: eur('10.00') });
    expect(split(p)).toEqual([['WEG_NON_RECOVERABLE', '10.00']]);
    expect(p.flags.map((f) => f.code)).toEqual(['NO_MATCHING_DIFFERENCE']);
  });

  it('equal parts: the rest on the first, a share of 0 left out', () => {
    // Each half of 0.01 rounds up to 0.01; the rest (−0.01) goes to the first of equals, which drops to 0.
    expect(split(proposeSettlement(eur('0.01'), 'OUTFLOW', classes('1.00', '1.00')))).toEqual([['WEG_NON_RECOVERABLE', '0.01']]);
  });
});
