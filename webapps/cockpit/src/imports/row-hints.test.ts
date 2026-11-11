import { describe, expect, it } from 'vitest';
import type { ImportRowDto } from '../api/imports';
import { BATCH, ITEM } from './fixtures.test-support';
import { rowHasHint } from './row-hints';

/** The rule of the row table's default (Entscheidung des Projektinhabers, 2026-11-11), outcome by outcome. */

const TX = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('rowHasHint: which rows the import result shows by default', () => {
  it('a new booking and a duplicate of a booking or of a decided review item have no hint', () => {
    const plain: ImportRowDto[] = [
      { outcome: 'created', position: 1, transactionId: TX },
      { outcome: 'duplicate', position: 2, duplicateOf: 'TRANSACTION', transactionId: TX },
      {
        outcome: 'duplicate',
        position: 3,
        duplicateOf: 'RESOLVED_REVIEW_ITEM',
        reviewItemId: ITEM,
        importBatchId: BATCH,
        resolution: 'CREATE',
        createdTransactionId: TX,
      },
      { outcome: 'duplicate', position: 4, duplicateOf: 'RESOLVED_REVIEW_ITEM', reviewItemId: ITEM, importBatchId: BATCH, resolution: 'SKIP' },
    ];
    expect(plain.map(rowHasHint)).toEqual([false, false, false, false]);
  });

  it('a review item, an error, a skipped row and anything unknown have a hint', () => {
    const hinted: ImportRowDto[] = [
      { outcome: 'needs_review', position: 1, reviewItemId: ITEM, importBatchId: BATCH, reason: 'AMBIGUOUS_CROSS_FILE_MATCH', conflictingTransactionIds: [TX] },
      { outcome: 'error', position: 2, errors: [{ field: 'amount', code: 'SCALE_EXCEEDED' }] },
      { outcome: 'skipped', position: 3, reason: 'ZERO_AMOUNT' },
      { outcome: 'merged', position: 4 } as never,
      { outcome: 'duplicate', position: 5, duplicateOf: 'SOMETHING_NEW', transactionId: TX } as never,
    ];
    expect(hinted.map(rowHasHint)).toEqual([true, true, true, true, true]);
  });
});
