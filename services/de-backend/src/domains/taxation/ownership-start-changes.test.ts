import { describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../shared/index.js';
import { testFingerprinter } from './fingerprinter.test-support.js';
import { ownershipStartChanges, ownershipStartEntry, ownershipStartIsOpen, type OwnershipStartFact } from './ownership-start-changes.js';
import { matchAcknowledgement, planAcknowledgement, type TaxYearAcknowledgement } from './tax-statements.js';
import { reviewOf } from './tax-year-review.js';

/**
 * §58N's flag in the tax-year view (Entscheidung des Projektinhabers, 2026-11-04, Frage 5): the years of the gap
 * between `ownershipStart` and the recorded transfer, the level by the seller, open until an acknowledgement of the
 * kind `OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER` (§58E Part 2) matches. Synthetic values only.
 */
const day = (v: string) => v as BusinessDate;
const PR = '6f1c2a9e-0000-4000-8000-0000000000aa';
const fact = (o: Partial<OwnershipStartFact> = {}): OwnershipStartFact => ({
  acquisitionId: '6f1c2a9e-0000-4000-8000-0000000000a1',
  ownershipStart: day('2025-03-01'),
  economicTransferDate: day('2025-05-01'),
  sellerHasAfaComponent: false,
  auditRecordId: '6f1c2a9e-0000-4000-8000-0000000000f1',
  recordedAt: new Date('2026-11-04T10:00:00Z'),
  ...o,
});
const context = { propertyReferenceId: PR, fingerprinter: testFingerprinter };
const ack = (change: { auditRecordId: string; changeFingerprint: string }, status: 'ACTIVE' | 'WITHDRAWN' = 'ACTIVE'): TaxYearAcknowledgement =>
  ({
    acknowledgementId: 'k1',
    status,
    acknowledgedAt: new Date('2026-11-05T10:00:00Z'),
    acknowledgedBy: 'anna@example.com',
    change: { auditRecordId: change.auditRecordId, fingerprint: change.changeFingerprint },
  }) as unknown as TaxYearAcknowledgement;

describe('OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER in the tax-year view (§58N)', () => {
  it('the years of the gap only: 2025 for 2025-03-01 to 2025-05-01; 2024 and 2025 for 2024-11-01 to 2025-02-01; none for a transfer on Jan 1', () => {
    expect(ownershipStartChanges([fact()], 2025, context).map((c) => c.entityId)).toEqual([fact().acquisitionId]);
    expect(ownershipStartChanges([fact()], 2024, context)).toEqual([]);
    expect(ownershipStartChanges([fact()], 2026, context)).toEqual([]);
    const across = fact({ ownershipStart: day('2024-11-01'), economicTransferDate: day('2025-02-01') });
    expect([2023, 2024, 2025, 2026].map((y) => ownershipStartChanges([across], y, context).length)).toEqual([0, 1, 1, 0]);
    // The gap ends on Dec 31: a transfer on Jan 1 touches the year before only.
    const newYear = fact({ ownershipStart: day('2024-12-01'), economicTransferDate: day('2025-01-01') });
    expect([2024, 2025].map((y) => ownershipStartChanges([newYear], y, context).length)).toEqual([1, 0]);
    // Equal dates are no change.
    expect(ownershipStartChanges([fact({ economicTransferDate: day('2025-03-01') })], 2025, context)).toEqual([]);
  });

  it('the level: OPEN with a seller holding an AfA component, INFORMATIVE without; no items; the fingerprint per year', () => {
    const [open] = ownershipStartChanges([fact({ sellerHasAfaComponent: true })], 2025, context);
    const [info] = ownershipStartChanges([fact()], 2025, context);
    expect([open?.level, info?.level, open?.items, open?.kind, open?.entityType]).toEqual([
      'OPEN',
      'INFORMATIVE',
      [],
      'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER',
      'Acquisition',
    ]);
    const across = fact({ ownershipStart: day('2024-11-01'), economicTransferDate: day('2025-02-01') });
    expect(ownershipStartChanges([across], 2024, context)[0]?.changeFingerprint).not.toBe(ownershipStartChanges([across], 2025, context)[0]?.changeFingerprint);
  });

  it('open while an OPEN entry is not acknowledged; an INFORMATIVE entry never holds the year; a withdrawn one counts not', () => {
    const [change] = ownershipStartChanges([fact({ sellerHasAfaComponent: true })], 2025, context);
    if (change === undefined) throw new Error('no change');
    const entry = (acknowledgements: TaxYearAcknowledgement[]) =>
      ownershipStartEntry({ ...change, acknowledgement: matchAcknowledgement(change, acknowledgements) });
    const flag = (details: unknown) => [{ code: 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER', details }];
    expect(ownershipStartIsOpen([entry([])])).toBe(true);
    expect(reviewOf(flag([entry([])]), []).final).toBe(false);
    expect(reviewOf(flag([entry([ack(change)])]), []).final).toBe(true);
    expect(reviewOf(flag([entry([ack(change, 'WITHDRAWN')])]), []).final).toBe(false);
    const [info] = ownershipStartChanges([fact()], 2025, context);
    if (info === undefined) throw new Error('no change');
    const infoEntry = ownershipStartEntry({ ...info, acknowledgement: null });
    expect(reviewOf(flag([infoEntry]), []).final).toBe(true);
    expect(reviewOf(flag([infoEntry]), []).info).toEqual([{ code: 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER', count: 1 }]);
  });

  it('acknowledging: the change found by its record and kind, its fingerprint compared, the no-op over an ACTIVE one', () => {
    const [change] = ownershipStartChanges([fact({ sellerHasAfaComponent: true })], 2025, context);
    if (change === undefined) throw new Error('no change');
    const request = { auditRecordId: change.auditRecordId, expectedFingerprint: change.changeFingerprint };
    expect(planAcknowledgement([change], request, [])).toEqual({ kind: 'CREATE', change });
    expect(planAcknowledgement([change], { ...request, kind: 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER' }, []).kind).toBe('CREATE');
    expect(planAcknowledgement([change], { ...request, kind: 'LOAN_CLOSED' }, []).kind).toBe('NOT_FLAGGED');
    expect(planAcknowledgement([change], { ...request, expectedFingerprint: 'f'.repeat(64) }, []).kind).toBe('DIFFERS');
    expect(planAcknowledgement([change], request, [ack(change)]).kind).toBe('NOOP');
    expect(planAcknowledgement([], request, []).kind).toBe('NOT_FLAGGED');
  });
});
