import { describe, expect, it } from 'vitest';
import { detail, PROPERTY, split } from './fixtures.test-support';
import {
  addRow,
  bindSplitFieldErrors,
  checkDraft,
  draftDiffers,
  draftFromDetail,
  firstBoundControl,
  MAX_SPLITS,
  referenceKinds,
  removeRow,
  splitsEditable,
  toSplitsRequest,
  withReferenceKind,
  type DraftRow,
} from './split-draft';

const LOAN = '6b4f8c7e-9d0a-4b12-8d34-d5e6f708192a';
const STATEMENT = '7c5a9d8f-0e1b-4c23-9e45-e6f708192a3b';
let counter = 0;
const newKey = () => `k${(counter += 1)}`;

const row = (overrides: Partial<DraftRow> = {}): DraftRow => ({
  key: newKey(),
  amount: '',
  financialCategoryCode: 'RENT_BASE',
  reference: { kind: 'none' },
  kept: undefined,
  description: '',
  ...overrides,
});

describe('step 3, which Transactions get the editor (ui-guide.md §6.3 status table)', () => {
  it('IMPORTED, UNREVIEWED and CLASSIFIED only; confirmed, corrected, ignored and unknown statuses never', () => {
    expect(['IMPORTED', 'UNREVIEWED', 'CLASSIFIED'].map(splitsEditable)).toEqual([true, true, true]);
    expect(['CONFIRMED', 'RECONCILED', 'CORRECTED', 'IGNORED', 'ARCHIVED', ''].map(splitsEditable)).toEqual([false, false, false, false, false, false]);
  });
});

describe('step 3, the draft from the detail (§8: no split id, position or status back into the request)', () => {
  it('without splits: one row over the whole amount, no category', () => {
    const rows = draftFromDetail(detail({ amount: { amount: '850.00', currency: 'EUR' } }), newKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: '850,00', financialCategoryCode: '', reference: { kind: 'none' }, description: '' });
  });

  it('with splits: category, amount, reference and description of each, nothing of the server ids', () => {
    const t = detail({
      splits: [
        split({ amount: { amount: '700.00', currency: 'EUR' }, description: 'Kaltmiete' }),
        split({
          splitId: 'x',
          position: 2,
          amount: { amount: '150.00', currency: 'EUR' },
          propertyReferenceId: null,
          loanId: LOAN,
          financialCategoryCode: 'LOAN_INTEREST',
        }),
      ],
    });
    const rows = draftFromDetail(t, newKey);
    expect(rows.map((r) => [r.amount, r.financialCategoryCode, r.reference, r.description])).toEqual([
      ['700,00', 'RENT_BASE', { kind: 'property', propertyReferenceId: PROPERTY }, 'Kaltmiete'],
      ['150,00', 'LOAN_INTEREST', { kind: 'loan', loanId: LOAN }, ''],
    ]);
    const body = JSON.stringify(toSplitsRequest(rows, 'EUR'));
    expect(body).not.toContain('splitId');
    expect(body).not.toContain('position');
    expect(body).not.toContain('status');
    expect(body).not.toContain('direction');
  });
});

describe('step 3, the exact sum (§6.4: no rounding tolerance)', () => {
  it('equal to the cent is complete; one cent more or less is not', () => {
    const rows = [row({ amount: '700,00' }), row({ amount: '150' })];
    expect(checkDraft(rows, '850.00')).toMatchObject({ sum: '850.00', rest: '0.00', exact: true, complete: true });
    expect(checkDraft([row({ amount: '700,00' }), row({ amount: '149,99' })], '850.00')).toMatchObject({ rest: '0.01', exact: false, complete: false });
    expect(checkDraft([row({ amount: '700,00' }), row({ amount: '150,01' })], '850.00')).toMatchObject({ rest: '-0.01', exact: false, complete: false });
  });

  it('beyond 2^53 cents the sum stays exact', () => {
    const rows = [row({ amount: '999.999.999.999.999.000,00' }), row({ amount: '999,99' })];
    expect(checkDraft(rows, '999999999999999999.99')).toMatchObject({ sum: '999999999999999999.99', exact: true, complete: true });
    expect(checkDraft(rows, '999999999999999999.98').exact).toBe(false);
  });

  it('an unreadable amount, a missing category or object keeps the draft incomplete even when the sum fits', () => {
    expect(checkDraft([row({ amount: '850,00', financialCategoryCode: '' })], '850.00')).toMatchObject({
      exact: true,
      complete: false,
      problems: [['CATEGORY_MISSING']],
    });
    expect(checkDraft([row({ amount: '850,00', reference: { kind: 'property', propertyReferenceId: '' } })], '850.00').problems).toEqual([
      ['PROPERTY_MISSING'],
    ]);
    expect(checkDraft([row({ amount: '850,00' }), row({ amount: '1.5' })], '850.00')).toMatchObject({
      exact: true,
      complete: false,
      problems: [[], ['AMBIGUOUS']],
    });
    expect(checkDraft([row({ amount: '850,00' })], '850.001').complete).toBe(false);
  });

  it('1 and 100 rows are fine, a 101st is never added and the last row is never removed', () => {
    const one = [row({ amount: '1,00' })];
    expect(checkDraft(one, '1.00').complete).toBe(true);
    expect(removeRow(one, one[0]?.key ?? '')).toBe(one);
    const hundred = Array.from({ length: MAX_SPLITS }, () => row({ amount: '0,01' }));
    expect(checkDraft(hundred, '1.00')).toMatchObject({ countOk: true, complete: true });
    expect(addRow(hundred, newKey)).toBe(hundred);
    expect(addRow(hundred.slice(1), newKey)).toHaveLength(MAX_SPLITS);
    const tooMany = [...hundred, row({ amount: '0,00' })];
    expect(checkDraft(tooMany, '1.00')).toMatchObject({ exact: true, countOk: false, complete: false });
    expect(checkDraft([], '0.00').complete).toBe(false);
  });
});

describe('step 3, the request body (api-design.md §33.2, ui-guide.md §5.3)', () => {
  it('the amounts are exactly what was typed, normalised; the currency is the Transaction one', () => {
    const rows = [
      row({ amount: ' 1.234,56 ', reference: { kind: 'property', propertyReferenceId: PROPERTY }, description: '  Miete  ' }),
      row({ amount: '0,4', financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' }),
    ];
    expect(toSplitsRequest(rows, 'EUR')).toEqual({
      splits: [
        { amount: { amount: '1234.56', currency: 'EUR' }, financialCategoryCode: 'RENT_BASE', propertyReferenceId: PROPERTY, description: 'Miete' },
        { amount: { amount: '0.40', currency: 'EUR' }, financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' },
      ],
    });
  });

  it('each reference kind sends its ids and no other (§6.4 exclusions)', () => {
    const kept = { kind: 'wegAnnualStatement', wegAnnualStatementId: STATEMENT, propertyReferenceId: PROPERTY } as const;
    const body = toSplitsRequest(
      [
        row({ amount: '1', reference: { kind: 'loan', loanId: LOAN } }),
        row({ amount: '1', reference: kept }),
        row({ amount: '1', reference: { kind: 'none' } }),
      ],
      'EUR',
    );
    expect(body.splits.map((s) => Object.keys(s).sort())).toEqual([
      ['amount', 'financialCategoryCode', 'loanId'],
      ['amount', 'financialCategoryCode', 'propertyReferenceId', 'wegAnnualStatementId'],
      ['amount', 'financialCategoryCode'],
    ]);
  });

  it('changing the kind removes the ids the new kind does not use; a kept reference can come back, a new one cannot be made', () => {
    const loanRow = row({ reference: { kind: 'loan', loanId: LOAN }, kept: { kind: 'loan', loanId: LOAN } });
    expect(referenceKinds(loanRow)).toEqual(['none', 'property', 'loan']);
    expect(referenceKinds(row())).toEqual(['none', 'property']);
    const property = withReferenceKind(loanRow, 'property');
    expect(property.reference).toEqual({ kind: 'property', propertyReferenceId: '' });
    expect(withReferenceKind(property, 'loan').reference).toEqual({ kind: 'loan', loanId: LOAN });
    expect(withReferenceKind(row(), 'loan').reference).toEqual({ kind: 'none' });
    const statement = row({ reference: { kind: 'wegAnnualStatement', wegAnnualStatementId: STATEMENT, propertyReferenceId: PROPERTY } });
    expect(withReferenceKind(statement, 'property').reference).toEqual({ kind: 'property', propertyReferenceId: PROPERTY });
    expect(withReferenceKind(statement, 'none').reference).toEqual({ kind: 'none' });
  });
});

describe('step 3, field errors bound to the row controls (§58X dotted paths, ui-guide.md §7.4)', () => {
  it('binds known names of sent rows; anything else stays unbound', () => {
    const fields = [
      { field: 'splits.1.amount.amount', code: 'SCALE_EXCEEDED' },
      { field: 'splits.0.financialCategoryCode', code: 'UNKNOWN_CATEGORY' },
      { field: 'splits.0.amount', code: 'INVALID_FORMAT' },
      { field: 'splits.1.amount.currency', code: 'CURRENCY_MISMATCH' },
      { field: 'splits.0.propertyReferenceId', code: 'NOT_ALLOWED_WITH_LOAN' },
      { field: 'splits.0.zzz', code: 'INVALID_FORMAT' },
      { field: 'splits.5.amount', code: 'INVALID_FORMAT' },
      { field: 'splits', code: 'CURRENCY_MISMATCH' },
      { field: '(body)', code: 'INVALID_FORMAT' },
      { field: 'If-Match', code: 'INVALID_FORMAT' },
    ];
    const bound = bindSplitFieldErrors(fields, 2);
    expect([...bound.keys()].sort()).toEqual(['split-0-amount', 'split-0-category', 'split-0-property', 'split-1-amount']);
    expect(bound.get('split-1-amount')?.map((e) => e.code)).toEqual(['SCALE_EXCEEDED', 'CURRENCY_MISMATCH']);
    expect(firstBoundControl(bound, 2)).toBe('split-0-category');
    expect(firstBoundControl(new Map(), 2)).toBeUndefined();
  });
});

describe('the unsaved draft that locks Buchung bestaetigen (Entscheidung des Projektinhabers, 2026-11-11)', () => {
  const stored = [
    split({ description: 'Kaltmiete' }),
    split({ position: 2, financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE', propertyReferenceId: null, amount: { amount: '150.00', currency: 'EUR' } }),
  ];
  const fresh = () => draftFromDetail(detail({ splits: stored }), newKey);

  it('the draft of the stored set is no change; the same amount typed otherwise and blanks around the text neither', () => {
    expect(draftDiffers(fresh(), stored, '850.00')).toBe(false);
    const [first, second] = fresh();
    if (first === undefined || second === undefined) throw new Error('two rows expected');
    expect(
      draftDiffers(
        [
          { ...first, amount: '700', description: ' Kaltmiete ' },
          { ...second, amount: '150,0' },
        ],
        stored,
        '850.00',
      ),
    ).toBe(false);
  });

  it('a changed amount, category, reference, description, an added, removed or swapped row is a change', () => {
    const [first, second] = fresh();
    if (first === undefined || second === undefined) throw new Error('two rows expected');
    for (const rows of [
      [{ ...first, amount: '699,99' }, second],
      [{ ...first, financialCategoryCode: 'RENT_OPERATING_COST_ADVANCE' }, second],
      [{ ...first, reference: { kind: 'none' as const } }, second],
      [first, { ...second, description: 'Nebenkosten' }],
      [first, second, row({ amount: '0,00' })],
      [first],
      [second, first],
      [{ ...first, amount: '7oo' }, second],
    ]) {
      expect(draftDiffers(rows, stored, '850.00')).toBe(true);
    }
  });

  it('without stored splits, the untouched draft over the whole amount is no change; a category chosen is one', () => {
    const [only] = draftFromDetail(detail({ splits: [] }), newKey);
    if (only === undefined) throw new Error('one row expected');
    expect(draftDiffers([only], [], '850.00')).toBe(false);
    expect(draftDiffers([{ ...only, financialCategoryCode: 'RENT_BASE' }], [], '850.00')).toBe(true);
  });
});
