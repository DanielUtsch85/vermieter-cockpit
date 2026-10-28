import { describe, expect, it } from 'vitest';
import {
  businessDayOf,
  decideRow,
  importPostable,
  isSkippable,
  keepsExternalId,
  planResolution,
  sourceRowKey,
  summarize,
  type KnownReviewItem,
  type RowOutcome,
} from './bank-import.js';
import type { FinancialAccount } from './financial-account.js';
import type { ParsedStatement } from './bank-statement.js';
import type { BusinessDate } from './transaction.js';

const pending: KnownReviewItem = {
  id: 'item-1',
  importBatchId: 'batch-1',
  status: 'PENDING',
  resolution: null,
  createdTransactionId: null,
};
const resolved: KnownReviewItem = { ...pending, status: 'RESOLVED', resolution: 'CREATE', createdTransactionId: 'tx-9' };

describe('decideRow (data-model.md §70.1/§70.4, §20A)', () => {
  it('external-id branch: the same id with the same content is a duplicate', () => {
    expect(
      decideRow(true, {
        transactionByExternalId: { id: 'tx-2', contentFingerprint: 'fp' },
        contentFingerprint: 'fp',
        fingerprintMatches: [],
      }),
    ).toEqual({ kind: 'DUPLICATE_TRANSACTION', transactionId: 'tx-2' });
  });

  it('external-id branch: the same id with other content is a review item, never a duplicate (placeholder or reused id)', () => {
    expect(
      decideRow(true, {
        transactionByExternalId: { id: 'tx-2', contentFingerprint: 'fp-750' },
        contentFingerprint: 'fp-980',
        fingerprintMatches: [],
      }),
    ).toEqual({
      kind: 'NEW_REVIEW_ITEM',
      reason: 'EXTERNAL_ID_CONTENT_CONFLICT',
      conflictingTransactionIds: ['tx-2'],
      priorReviewItemIds: [],
    });
  });

  it('external-id branch: a new id whose content was imported before without an id is ambiguous, not new', () => {
    expect(decideRow(true, { contentFingerprint: 'fp', fallbackFingerprintMatches: ['tx-1'], fingerprintMatches: [] })).toEqual({
      kind: 'NEW_REVIEW_ITEM',
      reason: 'AMBIGUOUS_CROSS_FILE_MATCH',
      conflictingTransactionIds: ['tx-1'],
      priorReviewItemIds: [],
    });
    // Other-statement matches of the fallback branch do not concern an id row.
    expect(decideRow(true, { contentFingerprint: 'fp', fallbackFingerprintMatches: [], fingerprintMatches: ['tx-1'] })).toEqual({
      kind: 'CREATE',
    });
  });

  it('external-id branch: a review item for the row comes first (re-import of a conflict references it)', () => {
    expect(
      decideRow(true, {
        reviewItemByIdentity: pending,
        transactionByExternalId: { id: 'tx-2', contentFingerprint: 'other' },
        contentFingerprint: 'fp',
        fingerprintMatches: [],
      }),
    ).toEqual({ kind: 'REFERENCE_PENDING_ITEM', item: pending });
  });

  it('fallback branch: the full identity makes a duplicate, ahead of any ambiguity', () => {
    expect(
      decideRow(false, {
        transactionByIdentity: 'tx-1',
        otherAdapterVersion: { transactionIds: ['tx-0'], reviewItemIds: [] },
        fingerprintMatches: ['tx-5'],
      }),
    ).toEqual({ kind: 'DUPLICATE_TRANSACTION', transactionId: 'tx-1' });
  });

  it('fallback: a PENDING review item is referenced, a RESOLVED one is a duplicate — never a second item', () => {
    expect(decideRow(false, { reviewItemByIdentity: pending, fingerprintMatches: ['tx-5'] })).toEqual({
      kind: 'REFERENCE_PENDING_ITEM',
      item: pending,
    });
    expect(decideRow(false, { reviewItemByIdentity: resolved, fingerprintMatches: ['tx-5'] })).toEqual({
      kind: 'DUPLICATE_RESOLVED_ITEM',
      item: resolved,
    });
  });

  it('the same source row under another adapter version is a new review item, never automatic', () => {
    expect(decideRow(false, { otherAdapterVersion: { transactionIds: ['tx-0'], reviewItemIds: ['item-0'] }, fingerprintMatches: ['tx-5'] })).toEqual({
      kind: 'NEW_REVIEW_ITEM',
      reason: 'ADAPTER_VERSION_CONFLICT',
      conflictingTransactionIds: ['tx-0'],
      priorReviewItemIds: ['item-0'],
    });
  });

  it('the same content in another statement is ambiguous; nothing known creates', () => {
    expect(decideRow(false, { otherAdapterVersion: { transactionIds: [], reviewItemIds: [] }, fingerprintMatches: ['tx-5', 'tx-6'] })).toEqual({
      kind: 'NEW_REVIEW_ITEM',
      reason: 'AMBIGUOUS_CROSS_FILE_MATCH',
      conflictingTransactionIds: ['tx-5', 'tx-6'],
      priorReviewItemIds: [],
    });
    expect(decideRow(false, { fingerprintMatches: [] })).toEqual({ kind: 'CREATE' });
  });
});

describe('sourceRowKey', () => {
  const statement = (sourceStatementId: string | null) =>
    ({ adapterId: 'a', adapterVersion: '1', contentHash: 'abc', sourceStatementId, rows: [] }) as ParsedStatement;

  it('uses the content hash and position without source ids, the ids otherwise', () => {
    expect(sourceRowKey(statement(null), { position: 3, sourceRowId: null })).toEqual({ statementKey: 'sha256:abc', rowKey: 'pos:3' });
    expect(sourceRowKey(statement('st-7'), { position: 3, sourceRowId: 'r-1' })).toEqual({ statementKey: 'id:st-7', rowKey: 'id:r-1' });
  });
});

describe('importPostable', () => {
  const account = (closedAt: Date | null) => ({ status: closedAt === null ? 'OPEN' : 'CLOSED', closedAt }) as unknown as FinancialAccount;

  it('open accounts take every date; closed ones up to and including the (UTC) closing day', () => {
    expect(importPostable(account(null), '2099-01-01' as BusinessDate)).toBe(true);
    const closed = account(new Date('2026-09-30T21:30:00Z')); // 23:30 in Berlin (CEST)
    expect(importPostable(closed, '2026-09-30' as BusinessDate)).toBe(true);
    expect(importPostable(closed, '2026-10-01' as BusinessDate)).toBe(false);
  });

  it('the closing day is the Berlin calendar day, not the UTC one', () => {
    const closed = account(new Date('2025-12-31T23:30:00Z')); // 00:30 on 1 January in Berlin
    expect(businessDayOf(new Date('2025-12-31T23:30:00Z'))).toBe('2026-01-01');
    expect(importPostable(closed, '2026-01-01' as BusinessDate)).toBe(true);
    expect(importPostable(closed, '2026-01-02' as BusinessDate)).toBe(false);
  });
});

describe('summarize / isSkippable', () => {
  it('counts outcomes; needsReviewCount is only the own pending items', () => {
    const rows: RowOutcome[] = [
      { outcome: 'created', position: 1, transactionId: 't' },
      { outcome: 'duplicate', position: 2, duplicateOf: 'TRANSACTION', transactionId: 't' },
      {
        outcome: 'needs_review',
        position: 3,
        reviewItemId: 'i',
        importBatchId: 'old',
        reason: 'AMBIGUOUS_CROSS_FILE_MATCH',
        conflictingTransactionIds: [],
      },
      { outcome: 'error', position: 4, errors: [{ field: 'amount', code: 'REQUIRED' }] },
      { outcome: 'skipped', position: 5, reason: 'ZERO_AMOUNT' },
    ];
    expect(summarize(rows, 0)).toEqual({
      transactionCount: 1,
      duplicateCount: 1,
      needsReviewCount: 0,
      errorCount: 1,
      skippedCount: 1,
      status: 'COMPLETED',
    });
    expect(summarize(rows, 2)).toMatchObject({ needsReviewCount: 2, status: 'NEEDS_REVIEW' });
  });

  it('only a lone ZERO_AMOUNT is skipped; combined with real errors it stays an error', () => {
    expect(isSkippable([{ field: 'amount', code: 'ZERO_AMOUNT' }])).toBe(true);
    expect(
      isSkippable([
        { field: 'amount', code: 'ZERO_AMOUNT' },
        { field: 'bookingDate', code: 'REQUIRED' },
      ]),
    ).toBe(false);
  });
});

describe('planResolution / keepsExternalId (api-design.md §32.2, data-model.md §70.4)', () => {
  it('decides a PENDING item, replays the same resolution, refuses the other', () => {
    expect(planResolution({ status: 'PENDING', resolution: null }, 'CREATE')).toBe('APPLY');
    expect(planResolution({ status: 'RESOLVED', resolution: 'SKIP' }, 'SKIP')).toBe('REPLAY');
    expect(planResolution({ status: 'RESOLVED', resolution: 'SKIP' }, 'CREATE')).toBe('CONFLICT');
  });

  it('keeps the external id only when it belongs to nobody else', () => {
    expect(keepsExternalId('AMBIGUOUS_CROSS_FILE_MATCH', false)).toBe(true);
    expect(keepsExternalId('AMBIGUOUS_CROSS_FILE_MATCH', true)).toBe(false);
    expect(keepsExternalId('EXTERNAL_ID_CONTENT_CONFLICT', false)).toBe(false);
  });
});
