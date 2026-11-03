import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import { correctionRecordOf, type CorrectionHistory, type CorrectionSplit } from './attribution-corrections.js';
import { partChangeFingerprint, partChanges, PART_CHANGE_KINDS } from './attribution-parts.js';
import { allocationSet } from './attribution-parts.test-support.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { planAcknowledgement } from './tax-statements.js';

/**
 * §58I Part 2 (VC-X-50), pure: a split correction as the kinds `TRANSACTION_CORRECTED`, `TRANSACTION_REVERSED` of
 * `PROPERTY_PART_CHANGED` (Entscheidung des Projektinhabers, 2026-11-03, §58I Fragen 5 und 6: §58G's flag; every
 * correction after the year's end that changes P's sums of the year per financial category and direction). Example (b)
 * with its numbers: X, an inflow of 950.00 booked on 2027-11-03 with S1 `RENT_BASE` on P1, corrected on 2028-03-02 to Y
 * with S2 on P2; its variants, a reversal, a chain, a booking date across the year's edge, a Loan's interest, an
 * override; the history. Synthetic values only.
 */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const [P1, P2] = [1, 2].map((n) => `0000e50c-0000-4000-8000-00000000000${n}`) as [string, string];
/** X (the original), R its reversal, Y its replacement; R2 and Z of Y corrected again. */
const [X, R, Y, R2, Z] = ['a', 'b', 'c', 'd', 'e'].map((c) => `0000e50d-0000-4000-8000-${c.repeat(12)}`) as [string, string, string, string, string];
const [S1, S2, S3] = [1, 2, 3].map((n) => `0000e50e-0000-4000-8000-00000000000${n}`) as [string, string, string];
const LOAN = '0000e50f-0000-4000-8000-000000000001';
const REASON = 'Buchung auf falsches Objekt (synthetisch)';

const split = (sourceId: string, side: CorrectionSplit['side'], pr: string | null, o: Partial<CorrectionSplit> = {}): CorrectionSplit => ({
  sourceId,
  side,
  taxYear: 2027,
  financialCategoryCode: 'RENT_BASE',
  direction: 'INFLOW',
  amount: eur('950.00'),
  bookingDate: day('2027-11-03'),
  propertyReferenceId: pr,
  loanId: null,
  ...o,
});
/** X corrected (or reversed) with the record on `at` and the links as stored; the splits as given. */
const corrected = (
  splits: CorrectionSplit[],
  o: { at?: string; action?: 'CORRECTED' | 'REVERSED'; id?: string; replacement?: string; reversal?: string } = {},
): CorrectionHistory => {
  const action = o.action ?? 'CORRECTED';
  const replacement = action === 'CORRECTED' ? (o.replacement ?? Y) : null;
  return {
    transactionId: o.id ?? X,
    status: 'CORRECTED',
    reversalTransactionId: o.reversal ?? R,
    replacementTransactionId: replacement,
    records: [
      {
        auditRecordId: `a-${o.id ?? X}`,
        action,
        occurredAt: new Date(o.at ?? '2028-03-02T10:00:00Z'),
        reversalTransactionId: o.reversal ?? R,
        replacementTransactionId: replacement,
        reason: REASON,
      },
    ],
    splits,
  };
};
const EXAMPLE = corrected([split(S1, 'ORIGINAL', P1), split(S2, 'REPLACEMENT', P2)]);
const of = (pr: string, year: number, corrections: CorrectionHistory[]) =>
  partChanges({ loans: [], corrections }, year, { propertyReferenceId: pr, fingerprinter });
const items = (pr: string, year: number, corrections: CorrectionHistory[]) => of(pr, year, corrections).changes.map((c) => [c.kind, c.items]);
const item = (sourceId: string, stateBefore: string, partBefore: string | null, stateAfter: string, partAfter: string | null, taxYear = 2027) => ({
  sourceType: 'TRANSACTION_SPLIT',
  sourceId,
  taxYear,
  stateBefore,
  partBefore: partBefore === null ? null : eur(partBefore),
  stateAfter,
  partAfter: partAfter === null ? null : eur(partAfter),
});

describe('a split correction (§58I Part 2)', () => {
  it('example (b): P1 loses S1 (ATTRIBUTED 950.00 to NONE), P2 gains S2 (NONE to ATTRIBUTED 950.00); the entry s keys', () => {
    const p1 = of(P1, 2027, [EXAMPLE]);
    expect(p1.changes).toEqual([
      expect.objectContaining({
        kind: 'TRANSACTION_CORRECTED',
        entityType: 'Transaction',
        entityId: X,
        auditRecordId: `a-${X}`,
        keys: { transactionId: X, reversalTransactionId: R, replacementTransactionId: Y, reason: REASON },
        items: [item(S1, 'ATTRIBUTED', '950.00', 'NONE', null)],
      }),
    ]);
    expect(p1.inconsistent).toEqual([]);
    expect(items(P2, 2027, [EXAMPLE])).toEqual([['TRANSACTION_CORRECTED', [item(S2, 'NONE', null, 'ATTRIBUTED', '950.00')]]]);
    // Counter-check: a third PropertyReference sees nothing; neither does 2028 (S1 and S2 count in 2027).
    expect(of('0000e50c-0000-4000-8000-0000000000ff', 2027, [EXAMPLE]).changes).toEqual([]);
    expect(of(P1, 2028, [EXAMPLE]).changes).toEqual([]);
  });

  it('the 31-December rule: a correction recorded on 31 December 2027 raises nothing in 2027', () => {
    expect(of(P1, 2027, [corrected(EXAMPLE.splits as CorrectionSplit[], { at: '2027-12-31T20:00:00Z' })]).changes).toEqual([]);
    expect(of(P1, 2027, [corrected(EXAMPLE.splits as CorrectionSplit[], { at: '2028-01-01T08:00:00Z' })]).changes).toHaveLength(1);
  });

  it('a reversal: the original s splits leave, TRANSACTION_REVERSED with replacementTransactionId null', () => {
    const reversed = corrected([split(S1, 'ORIGINAL', P1)], { action: 'REVERSED' });
    expect(of(P1, 2027, [reversed]).changes).toEqual([
      expect.objectContaining({
        kind: 'TRANSACTION_REVERSED',
        keys: { transactionId: X, reversalTransactionId: R, replacementTransactionId: null, reason: REASON },
        items: [item(S1, 'ATTRIBUTED', '950.00', 'NONE', null)],
      }),
    ]);
  });

  it('a description-only and a Transaction propertyReferenceId-only correction move no sum: nothing', () => {
    // The replacement has the same split on P1 (a new id): the sums of RENT_BASE / INFLOW are equal on both sides.
    expect(of(P1, 2027, [corrected([split(S1, 'ORIGINAL', P1), split(S2, 'REPLACEMENT', P1)])]).changes).toEqual([]);
  });

  it('variant, an amount only (950.00 to 905.00 on P1): flagged with S1 and S2 (§58I Frage 6)', () => {
    const amount = corrected([split(S1, 'ORIGINAL', P1), split(S2, 'REPLACEMENT', P1, { amount: eur('905.00') })]);
    expect(items(P1, 2027, [amount])).toEqual([
      ['TRANSACTION_CORRECTED', [item(S1, 'ATTRIBUTED', '950.00', 'NONE', null), item(S2, 'NONE', null, 'ATTRIBUTED', '905.00')]],
    ]);
  });

  it('a category or a direction changed at the same amount: flagged, the sums are per financial category and direction', () => {
    const category = corrected([split(S1, 'ORIGINAL', P1), split(S2, 'REPLACEMENT', P1, { financialCategoryCode: 'OTHER_INCOME' })]);
    const direction = corrected([split(S1, 'ORIGINAL', P1), split(S2, 'REPLACEMENT', P1, { direction: 'OUTFLOW' })]);
    // Two splits of the replacement whose sum is the original's, in two categories: flagged too.
    const shared = corrected([
      split(S1, 'ORIGINAL', P1),
      split(S2, 'REPLACEMENT', P1, { amount: eur('900.00') }),
      split(S3, 'REPLACEMENT', P1, { amount: eur('50.00'), financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' }),
    ]);
    for (const c of [category, direction, shared]) expect(of(P1, 2027, [c]).changes).toHaveLength(1);
    // Counter-check: the same split split in two of one category and direction moves no sum.
    const same = corrected([
      split(S1, 'ORIGINAL', P1),
      split(S2, 'REPLACEMENT', P1, { amount: eur('900.00') }),
      split(S3, 'REPLACEMENT', P1, { amount: eur('50.00') }),
    ]);
    expect(of(P1, 2027, [same]).changes).toEqual([]);
  });

  it('a chain of two corrections: each step judged alone (X to Y on P2, Y to Z back on P1)', () => {
    const second = corrected([split(S2, 'ORIGINAL', P2), split(S3, 'REPLACEMENT', P1)], { id: Y, reversal: R2, replacement: Z, at: '2028-03-05T10:00:00Z' });
    expect(items(P1, 2027, [EXAMPLE, second])).toEqual([
      ['TRANSACTION_CORRECTED', [item(S1, 'ATTRIBUTED', '950.00', 'NONE', null)]],
      ['TRANSACTION_CORRECTED', [item(S3, 'NONE', null, 'ATTRIBUTED', '950.00')]],
    ]);
    expect(of(P2, 2027, [EXAMPLE, second]).changes.map((c) => [c.entityId, c.items.map((i) => [i.sourceId, i.stateAfter])])).toEqual([
      [X, [[S2, 'ATTRIBUTED']]],
      [Y, [[S2, 'NONE']]],
    ]);
  });

  it('a booking date corrected across the year s edge (2026-06-15 to 2027-06-15): the year left flagged, the year reached only once ended', () => {
    const moved = (at: string) =>
      corrected(
        [split(S1, 'ORIGINAL', P1, { taxYear: 2026, bookingDate: day('2026-06-15') }), split(S2, 'REPLACEMENT', P1, { bookingDate: day('2027-06-15') })],
        { at },
      );
    expect(items(P1, 2026, [moved('2028-02-01T10:00:00Z')])).toEqual([['TRANSACTION_CORRECTED', [item(S1, 'ATTRIBUTED', '950.00', 'NONE', null, 2026)]]]);
    expect(items(P1, 2027, [moved('2028-02-01T10:00:00Z')])).toEqual([['TRANSACTION_CORRECTED', [item(S2, 'NONE', null, 'ATTRIBUTED', '950.00')]]]);
    // Recorded during 2027: 2026 has ended, 2027 has not.
    expect([of(P1, 2026, [moved('2027-03-01T10:00:00Z')]).changes.length, of(P1, 2027, [moved('2027-03-01T10:00:00Z')]).changes.length]).toEqual([1, 0]);
  });

  it('a LOAN_INTEREST split corrected: P s part by its Loan s VALID sets (3/5 of 100.00 to 3/5 of 120.00); without a usable set nothing', () => {
    const sets = [
      allocationSet('set-1', '2027-01-01', [
        [P1, '3/5'],
        [P2, '2/5'],
      ]),
    ];
    const loan = (sourceId: string, side: CorrectionSplit['side'], amount: string, loanSets = sets) =>
      split(sourceId, side, null, { financialCategoryCode: 'LOAN_INTEREST', direction: 'OUTFLOW', amount: eur(amount), loanId: LOAN, loanSets });
    const c = corrected([loan(S1, 'ORIGINAL', '100.00'), loan(S2, 'REPLACEMENT', '120.00')]);
    expect(items(P1, 2027, [c])).toEqual([
      ['TRANSACTION_CORRECTED', [item(S1, 'ATTRIBUTED', '60.00', 'NONE', null), item(S2, 'NONE', null, 'ATTRIBUTED', '72.00')]],
    ]);
    expect(items(P2, 2027, [c])).toEqual([
      ['TRANSACTION_CORRECTED', [item(S1, 'ATTRIBUTED', '40.00', 'NONE', null), item(S2, 'NONE', null, 'ATTRIBUTED', '48.00')]],
    ]);
    // A set naming P that does not sum to 1/1: NOT_ATTRIBUTED on the counting side, NONE on the other; no figure, no change.
    const broken = [allocationSet('set-2', '2027-01-01', [[P1, '1/2']])];
    expect(of(P1, 2027, [corrected([loan(S1, 'ORIGINAL', '100.00', broken), loan(S2, 'REPLACEMENT', '120.00', broken)])]).changes).toEqual([]);
    // A principal split of the Loan is in no view.
    const principal = (sourceId: string, side: CorrectionSplit['side'], amount: string) =>
      split(sourceId, side, null, { financialCategoryCode: 'LOAN_PRINCIPAL', direction: 'OUTFLOW', amount: eur(amount), loanId: LOAN, loanSets: sets });
    expect(of(P1, 2027, [corrected([principal(S1, 'ORIGINAL', '100.00'), principal(S2, 'REPLACEMENT', '120.00')])]).changes).toEqual([]);
  });

  it('a taxYear override: the split counts in the overridden year, not its booking year', () => {
    // Booked 2028-01-02, overridden to 2027 (the replacement keeps none): 2027 loses it, 2028 gains it.
    const c = corrected(
      [split(S1, 'ORIGINAL', P1, { bookingDate: day('2028-01-02') }), split(S2, 'REPLACEMENT', P1, { bookingDate: day('2028-01-02'), taxYear: 2028 })],
      {
        at: '2029-02-01T10:00:00Z',
      },
    );
    expect(items(P1, 2027, [c])).toEqual([['TRANSACTION_CORRECTED', [item(S1, 'ATTRIBUTED', '950.00', 'NONE', null)]]]);
    expect(items(P1, 2028, [c])).toEqual([['TRANSACTION_CORRECTED', [item(S2, 'NONE', null, 'ATTRIBUTED', '950.00', 2028)]]]);
  });

  it('the history: CORRECTED now with exactly one record whose links are the Transaction s; otherwise ATTRIBUTION_HISTORY_INCONSISTENT with Transaction', () => {
    const noRecord = { ...EXAMPLE, records: [] };
    const otherLink = { ...EXAMPLE, replacementTransactionId: Z };
    const twice = { ...EXAMPLE, records: [...EXAMPLE.records, { ...(EXAMPLE.records[0] as CorrectionHistory['records'][number]), auditRecordId: 'a-2' }] };
    const notCorrected = { ...EXAMPLE, status: 'CONFIRMED' };
    const reversedWithReplacement = { ...EXAMPLE, records: [{ ...(EXAMPLE.records[0] as CorrectionHistory['records'][number]), action: 'REVERSED' }] };
    for (const h of [noRecord, otherLink, twice, notCorrected, reversedWithReplacement]) {
      expect(correctionRecordOf(h)).toBeUndefined();
      expect(of(P1, 2027, [h])).toEqual({ changes: [], inconsistent: [{ entityType: 'Transaction', entityId: X }] });
    }
    // Named only where a split of it is P s in the year: a third PropertyReference, or 2028, names nothing.
    expect(of('0000e50c-0000-4000-8000-0000000000ff', 2027, [noRecord]).inconsistent).toEqual([]);
    expect(of(P1, 2028, [noRecord]).inconsistent).toEqual([]);
    expect(correctionRecordOf(EXAMPLE)?.auditRecordId).toBe(`a-${X}`);
  });

  it('the fingerprint: the part shape of §58G, parts as exact cents; an existing kind s fingerprint byte for byte unchanged', () => {
    const [change] = of(P1, 2027, [EXAMPLE]).changes;
    expect(change?.changeFingerprint).toBe(
      fingerprinter.sha256Hex(
        `{"auditRecordId":"a-${X}","items":[{"partAfter":null,"partBefore":{"amount":"950.00","currency":"EUR"},"sourceId":"${S1}","sourceType":"TRANSACTION_SPLIT","stateAfter":"NONE","stateBefore":"ATTRIBUTED","taxYear":2027}],"kind":"TRANSACTION_CORRECTED","propertyReferenceId":"${P1}","year":2027}`,
      ),
    );
    const set = partChangeFingerprint(fingerprinter, {
      propertyReferenceId: P1,
      year: 2027,
      auditRecordId: 'r-1',
      kind: 'LOAN_ALLOCATION_SET_ADDED',
      items: [
        {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: S1,
          taxYear: 2027,
          stateBefore: 'ATTRIBUTED',
          partBefore: eur('1.00'),
          stateAfter: 'NONE',
          partAfter: null,
        },
      ],
    });
    expect(set).toBe(
      fingerprinter.sha256Hex(
        `{"auditRecordId":"r-1","items":[{"partAfter":null,"partBefore":{"amount":"1.00","currency":"EUR"},"sourceId":"${S1}","sourceType":"TRANSACTION_SPLIT","stateAfter":"NONE","stateBefore":"ATTRIBUTED","taxYear":2027}],"kind":"LOAN_ALLOCATION_SET_ADDED","propertyReferenceId":"${P1}","year":2027}`,
      ),
    );
  });

  it('acknowledged by its record: a Transaction record is one change (no CHANGE_AMBIGUOUS); the kinds are part kinds', () => {
    const changes = of(P1, 2027, [EXAMPLE]).changes;
    const [c] = changes;
    expect(planAcknowledgement(changes, { auditRecordId: `a-${X}`, expectedFingerprint: c?.changeFingerprint as string }, [])).toMatchObject({
      kind: 'CREATE',
    });
    expect(
      planAcknowledgement(changes, { auditRecordId: `a-${X}`, kind: 'TRANSACTION_REVERSED', expectedFingerprint: c?.changeFingerprint as string }, []),
    ).toEqual({
      kind: 'NOT_FLAGGED',
    });
    expect(PART_CHANGE_KINDS).toEqual(expect.arrayContaining(['TRANSACTION_CORRECTED', 'TRANSACTION_REVERSED']));
  });
});
