import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import {
  changedHeaderFields,
  classificationsByAccount,
  deriveStatement,
  normalizeQuantity,
  planConfirm,
  planVoid,
  resolveClassifications,
  sameContent,
  statementFingerprint,
  supersedesRefusal,
  type NewStatementCostLine,
  type StatementContent,
  type StatementCostLine,
} from './annual-statement.js';

/** The Jahresabrechnung (api-design.md §50). Figures are invented; the structure follows a real Einzelabrechnung. */
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;

const line = (overrides: Partial<StatementCostLine> = {}): StatementCostLine => ({
  position: 1,
  account: 'Hausmeister',
  group: 'RECOVERABLE',
  allocationKey: 'Miteigentumsanteile',
  allocationTotal: '10000',
  allocationShare: '250',
  totalAmount: eur('4000.00'),
  unitShare: eur('100.00'),
  classification: 'RECOVERABLE',
  classificationSource: 'PRINTED_GROUP',
  ...overrides,
});

const statement = (overrides: Partial<StatementContent<StatementCostLine>> = {}): StatementContent<StatementCostLine> => ({
  financialYear: 2025,
  periodFrom: day('2025-01-01'),
  periodUntil: day('2025-12-31'),
  documentDate: null,
  resolutionDate: null,
  dueDate: null,
  supersedes: null,
  costLines: [
    line(),
    line({ position: 2, account: 'Versicherung', totalAmount: eur('2000.00'), unitShare: eur('50.00') }),
    line({
      position: 3,
      account: 'Verwaltung',
      group: 'NON_RECOVERABLE',
      allocationKey: 'Einheit',
      allocationTotal: '20',
      allocationShare: '1',
      totalAmount: eur('1200.00'),
      unitShare: eur('60.00'),
      classification: 'NON_RECOVERABLE',
    }),
    line({
      position: 4,
      account: 'Zinserträge',
      group: 'NON_RECOVERABLE',
      totalAmount: eur('-40.00'),
      unitShare: eur('-1.00'),
      classification: 'NON_RECOVERABLE',
    }),
  ],
  recoverableSubtotal: eur('150.00'),
  nonRecoverableSubtotal: eur('59.00'),
  totalCosts: eur('209.00'),
  hausgeldRequested: eur('240.00'),
  hausgeldPaid: eur('220.00'),
  reserveRequested: eur('120.00'),
  reservePaid: eur('120.00'),
  settlementPeak: eur('-31.00'),
  settlementResult: eur('-11.00'),
  reserve: {
    source: 'ANNUAL_STATEMENT',
    lines: [
      { position: 1, description: 'Anfangsbestand', kind: 'OPENING', opening: eur('10000.00'), addition: null, withdrawal: null, closing: eur('10000.00') },
      {
        position: 2,
        description: 'Zuführung',
        kind: 'CONTRIBUTION',
        opening: eur('10000.00'),
        addition: eur('4800.00'),
        withdrawal: eur('800.00'),
        closing: eur('14000.00'),
      },
    ],
    unitShareOpening: eur('250.00'),
    unitShareClosing: eur('350.00'),
  },
  sourceReferences: [],
  notes: null,
  ...overrides,
});

const codes = (content: StatementContent<StatementCostLine>) => deriveStatement(content).flags.map((f) => f.code);

describe('deriveStatement', () => {
  it('a consistent statement has no flags; signed lines sum exactly', () => {
    expect(deriveStatement(statement()).flags).toEqual([]);
  });

  it('LINES_DIFFER_FROM_SUBTOTAL per printed group, with the sum of the lines and the printed subtotal', () => {
    const flags = deriveStatement(
      statement({ nonRecoverableSubtotal: eur('60.00'), totalCosts: eur('210.00'), settlementPeak: eur('-30.00'), settlementResult: eur('-10.00') }),
    ).flags;
    expect(flags).toEqual([{ code: 'LINES_DIFFER_FROM_SUBTOTAL', details: { group: 'NON_RECOVERABLE', lines: eur('59.00'), printed: eur('60.00') } }]);
  });

  it('SUBTOTALS_DIFFER_FROM_TOTAL, SETTLEMENT_DIFFERS and RESULT_DIFFERS, exact in cents', () => {
    const flags = deriveStatement(statement({ totalCosts: eur('209.01') })).flags;
    expect(flags).toContainEqual({ code: 'SUBTOTALS_DIFFER_FROM_TOTAL', details: { subtotals: eur('209.00'), printed: eur('209.01') } });
    expect(flags).toContainEqual({ code: 'SETTLEMENT_DIFFERS', details: { derived: eur('-30.99'), printed: eur('-31.00') } });
    expect(flags).toContainEqual({ code: 'RESULT_DIFFERS', details: { derived: eur('-10.99'), printed: eur('-11.00') } });
    // No printed Abrechnungsergebnis: nothing to compare.
    expect(codes(statement({ totalCosts: eur('209.01'), settlementResult: null }))).not.toContain('RESULT_DIFFERS');
  });

  it('LINE_SHARE_DIFFERS beyond one cent, rounded half away from zero, signed lines included', () => {
    // 4000.00 × 250 / 10000 = 100.00; printed 100.01 is within a cent, 100.02 is not.
    expect(
      codes(
        statement({
          costLines: [line({ unitShare: eur('100.01') })],
          recoverableSubtotal: eur('100.01'),
          nonRecoverableSubtotal: eur('0'),
          totalCosts: eur('100.01'),
          settlementPeak: eur('-139.99'),
          settlementResult: null,
        }),
      ),
    ).toEqual([]);
    const flags = deriveStatement(
      statement({
        costLines: [line({ unitShare: eur('100.02') })],
        recoverableSubtotal: eur('100.02'),
        nonRecoverableSubtotal: eur('0'),
        totalCosts: eur('100.02'),
        settlementPeak: eur('-139.98'),
        settlementResult: null,
      }),
    ).flags;
    expect(flags).toEqual([{ code: 'LINE_SHARE_DIFFERS', details: { position: 1, derived: eur('100.00'), printed: eur('100.02') } }]);
    // -0.05 × 1/2 = -0.025 → -0.03 (half away from zero); printed -0.01 is two cents off.
    const negative = deriveStatement(
      statement({
        costLines: [line({ totalAmount: eur('-0.05'), allocationTotal: '2', allocationShare: '1', unitShare: eur('-0.01') })],
        recoverableSubtotal: eur('-0.01'),
        nonRecoverableSubtotal: eur('0'),
        totalCosts: eur('-0.01'),
        settlementPeak: eur('-240.01'),
        settlementResult: null,
      }),
    ).flags;
    expect(negative).toEqual([{ code: 'LINE_SHARE_DIFFERS', details: { position: 1, derived: eur('-0.03'), printed: eur('-0.01') } }]);
    // Without both quantities, or with a total of 0, there is nothing to derive.
    const unknown = {
      recoverableSubtotal: eur('7.00'),
      nonRecoverableSubtotal: eur('0'),
      totalCosts: eur('7.00'),
      settlementPeak: eur('-233.00'),
      settlementResult: null,
    };
    expect(codes(statement({ costLines: [line({ allocationShare: null, unitShare: eur('7.00') })], ...unknown }))).toEqual([]);
    expect(codes(statement({ costLines: [line({ allocationTotal: '0', allocationShare: '0', unitShare: eur('7.00') })], ...unknown }))).toEqual([]);
  });

  it('RESERVE_DIFFERS: opening + addition − withdrawal ≠ closing; nothing estimated where not printed', () => {
    const reserve = statement().reserve!;
    const off = { ...reserve, lines: [{ ...reserve.lines[1]!, closing: eur('14000.01') }] };
    expect(deriveStatement(statement({ reserve: off })).flags).toEqual([
      { code: 'RESERVE_DIFFERS', details: { position: 2, derived: eur('14000.00'), printed: eur('14000.01') } },
    ]);
    const unprinted = { ...reserve, lines: [{ ...reserve.lines[1]!, opening: null, closing: eur('1.00') }] };
    expect(codes(statement({ reserve: unprinted }))).toEqual([]);
    expect(codes(statement({ reserve: null }))).toEqual([]);
  });

  it('CLASSIFIED_AGAINST_GROUP lists the lines classified apart from their printed group', () => {
    const lines = statement().costLines.map((l) => (l.position === 2 ? { ...l, classification: 'RESERVE' as const } : l));
    expect(deriveStatement(statement({ costLines: lines })).flags).toEqual([{ code: 'CLASSIFIED_AGAINST_GROUP', details: { positions: [2] } }]);
  });

  it('byClassification sums the unitShare per classification, not per printed group', () => {
    const lines = statement().costLines.map((l) => (l.position === 2 ? { ...l, classification: 'RESERVE' as const } : l));
    expect(deriveStatement(statement({ costLines: lines })).byClassification).toEqual({
      RECOVERABLE: eur('100.00'),
      NON_RECOVERABLE: eur('59.00'),
      RESERVE: eur('50.00'),
    });
  });
});

describe('classification (P6-D8)', () => {
  const entered = (
    account: string,
    classification: NewStatementCostLine['classification'],
    group: NewStatementCostLine['group'] = 'RECOVERABLE',
  ): NewStatementCostLine => {
    const { classificationSource: _source, ...rest } = line({ account, group });
    return { ...rest, classification };
  };

  it("the user's, else the previous statement's by account, else the printed group; with its source", () => {
    const previous = new Map([['Versicherung', 'NON_RECOVERABLE' as const]]);
    const resolved = resolveClassifications(
      [
        entered('Hausmeister', 'RESERVE'),
        { ...entered('Versicherung', null), position: 2 },
        { ...entered('Verwaltung', null, 'NON_RECOVERABLE'), position: 3 },
      ],
      previous,
    );
    expect(resolved.map((l) => [l.classification, l.classificationSource])).toEqual([
      ['RESERVE', 'USER'],
      ['NON_RECOVERABLE', 'PREVIOUS_STATEMENT'],
      ['NON_RECOVERABLE', 'PRINTED_GROUP'],
    ]);
  });

  it('by account the first line by position wins', () => {
    const byAccount = classificationsByAccount([
      { account: 'Wasser', position: 5, classification: 'NON_RECOVERABLE' },
      { account: 'Wasser', position: 2, classification: 'RECOVERABLE' },
    ]);
    expect(byAccount.get('Wasser')).toBe('RECOVERABLE');
  });
});

describe('lifecycle', () => {
  it('confirm from DRAFT; CONFIRMED is a no-op; SUPERSEDED and VOID are not a draft', () => {
    expect([planConfirm('DRAFT'), planConfirm('CONFIRMED'), planConfirm('SUPERSEDED'), planConfirm('VOID')]).toEqual([
      'CONFIRM',
      'UNCHANGED',
      'NOT_DRAFT',
      'NOT_DRAFT',
    ]);
  });

  it('void from DRAFT only; VOID is a no-op', () => {
    expect([planVoid('DRAFT'), planVoid('VOID'), planVoid('CONFIRMED'), planVoid('SUPERSEDED')]).toEqual(['VOID', 'UNCHANGED', 'NOT_DRAFT', 'NOT_DRAFT']);
  });

  it('supersedes: a CONFIRMED statement of the same membership and year, else why not', () => {
    const own = { membershipId: 'm', financialYear: 2025 };
    expect(supersedesRefusal(undefined, own)).toBe('NOT_FOUND');
    expect(supersedesRefusal({ membershipId: 'n', financialYear: 2025, status: 'CONFIRMED' }, own)).toBe('OTHER_MEMBERSHIP');
    expect(supersedesRefusal({ membershipId: 'm', financialYear: 2024, status: 'CONFIRMED' }, own)).toBe('OTHER_YEAR');
    expect(supersedesRefusal({ membershipId: 'm', financialYear: 2025, status: 'SUPERSEDED' }, own)).toBe('NOT_CONFIRMED');
    expect(supersedesRefusal({ membershipId: 'm', financialYear: 2025, status: 'CONFIRMED' }, own)).toBeUndefined();
  });
});

describe('content', () => {
  it('sameContent ignores the order of the lines and sees every change', () => {
    const base = statement();
    expect(sameContent(base, statement({ costLines: [...base.costLines].reverse() }))).toBe(true);
    expect(sameContent(base, statement({ notes: 'x' }))).toBe(false);
    expect(
      sameContent(base, statement({ costLines: base.costLines.map((l) => (l.position === 1 ? { ...l, classificationSource: 'USER' as const } : l)) })),
    ).toBe(false);
  });

  it('changedHeaderFields names the header fields, the reserve and the references', () => {
    expect(changedHeaderFields(statement(), statement({ settlementPeak: eur('-30.00'), notes: 'n', reserve: null, sourceReferences: ['S. 3'] }))).toEqual([
      'settlementPeak',
      'notes',
      'sourceReferences',
      'reserve',
    ]);
  });

  it('the fingerprint is the content as entered, with the membership', () => {
    const { costLines, ...rest } = statement();
    const entered = {
      ...rest,
      mreRealmId: 'r',
      membershipId: 'm',
      costLines: costLines.map(({ classificationSource: _s, ...l }) => ({ ...l, classification: null })),
    };
    expect(statementFingerprint(entered)).toBe(statementFingerprint({ ...entered, mreRealmId: 'other' }));
    expect(statementFingerprint(entered)).not.toBe(statementFingerprint({ ...entered, membershipId: 'n' }));
  });

  it('normalizeQuantity drops trailing zeros', () => {
    expect([normalizeQuantity('10000.000'), normalizeQuantity('125.500'), normalizeQuantity('007.1')]).toEqual(['10000', '125.5', '7.1']);
  });
});
