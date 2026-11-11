import { describe, expect, it } from 'vitest';
import type { TransactionDetailDto } from '../api/transactions';
import {
  bindCorrectionFieldErrors,
  checkCorrection,
  confirmable,
  correctable,
  correctionDraftFrom,
  intentFor,
  needsSplitsBeforeConfirm,
  toCorrectRequest,
  type CorrectionDraft,
} from './correction-draft';
import { detail, PROPERTY, split } from './fixtures.test-support';

const ORIGINAL: TransactionDetailDto = detail({
  status: 'CONFIRMED',
  version: 4,
  splits: [
    split(),
    split({ splitId: '7c5a9d8f-0e1b-4c23-9e45-e6f708192a3b', position: 2, amount: { amount: '150.00', currency: 'EUR' }, propertyReferenceId: null }),
  ],
});

let counter = 0;
const key = () => `k-${(counter += 1)}`;
const draft = (overrides: Partial<CorrectionDraft> = {}): CorrectionDraft => ({ ...correctionDraftFrom(ORIGINAL, key), reason: 'Tippfehler', ...overrides });

describe('which Transactions step 4 offers to confirm and to correct (api-design.md §34.2, §35.1)', () => {
  it('confirm: a status confirm takes, with a stored split set; without splits the page says to split first', () => {
    for (const status of ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED']) {
      expect(confirmable({ status, splits: [split()] }), status).toBe(true);
      expect(confirmable({ status, splits: [] }), status).toBe(false);
      expect(needsSplitsBeforeConfirm({ status, splits: [] }), status).toBe(true);
    }
    for (const status of ['CONFIRMED', 'RECONCILED', 'CORRECTED', 'IGNORED', 'SOMETHING_NEW']) {
      expect(confirmable({ status, splits: [split()] }), status).toBe(false);
      expect(needsSplitsBeforeConfirm({ status, splits: [] }), status).toBe(false);
    }
  });

  it('correct: CONFIRMED only and never a reversal; a replacement is corrected again', () => {
    expect(correctable({ status: 'CONFIRMED', correctionRole: null })).toBe(true);
    expect(correctable({ status: 'CONFIRMED', correctionRole: 'REPLACEMENT' })).toBe(true);
    expect(correctable({ status: 'CONFIRMED', correctionRole: 'REVERSAL' })).toBe(false);
    for (const status of ['IMPORTED', 'UNREVIEWED', 'CLASSIFIED', 'RECONCILED', 'CORRECTED', 'IGNORED', 'SOMETHING_NEW']) {
      expect(correctable({ status, correctionRole: null }), status).toBe(false);
    }
  });
});

describe('the correction request (api-design.md §35.2): only what changes', () => {
  it('starts from the original; unchanged it is not sendable (NO_CHANGE), and no reason is not either', () => {
    const start = correctionDraftFrom(ORIGINAL, key);
    expect(start).toMatchObject({
      reason: '',
      amount: '850,00',
      direction: 'INFLOW',
      bookingDate: '2026-03-01',
      valueDate: '2026-03-02',
      propertyReferenceId: '',
    });
    expect(checkCorrection(start, ORIGINAL).problems.get('reason')).toEqual(['REASON_MISSING']);
    const unchanged = checkCorrection(draft(), ORIGINAL);
    expect(unchanged.changed).toEqual([]);
    expect(unchanged.complete).toBe(false);
    expect(checkCorrection(draft({ reason: ' '.repeat(3) }), ORIGINAL).problems.get('reason')).toEqual(['REASON_MISSING']);
    expect(checkCorrection(draft({ reason: 'x'.repeat(501), description: 'neu' }), ORIGINAL).problems.get('reason')).toEqual(['REASON_TOO_LONG']);
    expect(checkCorrection(draft({ reason: 'x'.repeat(500), description: 'neu' }), ORIGINAL).complete).toBe(true);
  });

  it('a changed description alone: reason trimmed, nothing else; never an id, status, version or split of the detail', () => {
    const body = toCorrectRequest(draft({ reason: '  Falscher Zweck  ', description: ' Korrigierter Verwendungszweck ' }), ORIGINAL);
    expect(body).toEqual({ reason: 'Falscher Zweck', replacement: { description: 'Korrigierter Verwendungszweck' } });
    const text = JSON.stringify(body);
    for (const forbidden of ['transactionId', 'mreRealmId', 'status', 'version', 'splitId', 'position', 'financialAccountId', 'provenance']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('emptied value date, description and object are sent as null; a chosen object as its id', () => {
    const cleared = toCorrectRequest(draft({ valueDate: '', description: '' }), ORIGINAL);
    expect(cleared.replacement).toEqual({ valueDate: null, description: null });
    const withObject = toCorrectRequest(draft({ propertyReferenceId: PROPERTY }), ORIGINAL);
    expect(withObject.replacement).toEqual({ propertyReferenceId: PROPERTY });
    const original = { ...ORIGINAL, propertyReferenceId: PROPERTY };
    expect(toCorrectRequest({ ...correctionDraftFrom(original, key), reason: 'r', propertyReferenceId: '' }, original).replacement).toEqual({
      propertyReferenceId: null,
    });
  });

  it('a changed amount needs its own splits; the amount is sent exactly as typed, the splits cover it to the cent', () => {
    const amountOnly = checkCorrection(draft({ amount: '1.234,56' }), ORIGINAL);
    expect(amountOnly.splitsRequired).toBe(true);
    expect(amountOnly.complete).toBe(false);
    const rows = draft().rows.map((row, i) => ({ ...row, amount: i === 0 ? '1.084,56' : '150,00' }));
    const withSplits = draft({ amount: '1.234,56', changeSplits: true, rows });
    expect(checkCorrection(withSplits, ORIGINAL)).toMatchObject({ complete: true, amount: '1234.56', splits: { sum: '1234.56', exact: true } });
    const body = toCorrectRequest(withSplits, ORIGINAL);
    expect(body.replacement.amount).toEqual({ amount: '1234.56', currency: 'EUR' });
    expect(body.replacement.splits?.map((s) => s.amount.amount)).toEqual(['1084.56', '150.00']);
    // One cent too little: not sendable.
    const short = draft({ amount: '1.234,56', changeSplits: true, rows: rows.map((r, i) => (i === 1 ? { ...r, amount: '149,99' } : r)) });
    expect(checkCorrection(short, ORIGINAL)).toMatchObject({ complete: false, splits: { rest: '0.01' } });
  });

  it('the same amount written differently is no change (850 = 850,00); a cent more is one', () => {
    expect(checkCorrection(draft({ amount: '850' }), ORIGINAL).changed).toEqual([]);
    expect(checkCorrection(draft({ amount: '850,01' }), ORIGINAL).changed).toEqual(['amount']);
    expect(checkCorrection(draft({ amount: '850.01' }), ORIGINAL).problems.get('amount')).toEqual(['AMBIGUOUS']);
    // Compared in cents, not as text: an original sent as `850.5` and typed back as `850,50` is the same amount.
    const short = { ...ORIGINAL, amount: { amount: '850.5', currency: 'EUR' } };
    expect(checkCorrection({ ...correctionDraftFrom(short, key), reason: 'r', amount: '850,50' }, short).changed).toEqual([]);
    expect(checkCorrection({ ...correctionDraftFrom(short, key), reason: 'r', amount: '850,51' }, short).changed).toEqual(['amount']);
  });

  it('direction and dates: changed ones are sent, an empty booking date is refused', () => {
    expect(toCorrectRequest(draft({ direction: 'OUTFLOW', bookingDate: '2026-09-02' }), ORIGINAL).replacement).toEqual({
      direction: 'OUTFLOW',
      bookingDate: '2026-09-02',
    });
    expect(checkCorrection(draft({ bookingDate: '' }), ORIGINAL).problems.get('bookingDate')).toEqual(['BOOKING_DATE_MISSING']);
    expect(checkCorrection(draft({ direction: 'SIDEWAYS' }), ORIGINAL).problems.get('direction')).toEqual(['DIRECTION_INVALID']);
  });
});

describe('the Idempotency-Key of one intent (ui-guide.md §7.3)', () => {
  const body = toCorrectRequest(draft({ description: 'neu' }), ORIGINAL);

  it('the same body keeps the key; a changed body gets a new one; no intent (after a success) gets a new one', () => {
    const first = intentFor(undefined, body, key);
    expect(intentFor(first, JSON.parse(JSON.stringify(body)) as typeof body, key)).toBe(first);
    const changed = intentFor(first, { ...body, reason: 'anderer Grund' }, key);
    expect(changed.key).not.toBe(first.key);
    expect(intentFor(undefined, body, key).key).not.toBe(first.key);
  });
});

describe('field errors of a refused correction (§58X dotted names)', () => {
  it('binds the form fields and the replacement splits by row; the rest binds to nothing', () => {
    const bound = bindCorrectionFieldErrors(
      [
        { field: 'reason', code: 'REQUIRED' },
        { field: 'replacement.amount.amount', code: 'SCALE_EXCEEDED' },
        { field: 'replacement.bookingDate', code: 'OUT_OF_RANGE' },
        { field: 'replacement.splits.1.financialCategoryCode', code: 'UNKNOWN_CATEGORY' },
        { field: 'replacement.splits.5.amount', code: 'REQUIRED' },
        { field: 'replacement.financialAccountId', code: 'CURRENCY_MISMATCH' },
        { field: 'splits.0.amount', code: 'REQUIRED' },
        { field: '(body)', code: 'INVALID_FORMAT' },
      ],
      2,
    );
    expect([...bound.fields.keys()]).toEqual(['reason', 'amount', 'bookingDate']);
    expect([...bound.rows.keys()]).toEqual(['split-1-category']);
  });
});
