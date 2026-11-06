import { describe, expect, it } from 'vitest';
import type { BusinessDate } from '../../shared/index.js';
import { testFingerprinter } from './fingerprinter.test-support.js';
import { ownershipAlignmentChanges, ownershipAlignmentEntry, type OwnershipAlignmentFact } from './ownership-alignment-changes.js';
import { ownershipStartChanges } from './ownership-start-changes.js';
import { matchAcknowledgement, planAcknowledgement, type TaxYearAcknowledgement } from './tax-statements.js';
import { reviewOf } from './tax-year-review.js';

/**
 * §58Q's year flag `OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER` (Entscheidung des Projektinhabers, 2026-11-05, Frage 7):
 * every year the former gap touches, `OPEN` when the act lies after that year's 31 December (Europe/Berlin), else
 * informative; closed by an acknowledgement of the new kind, opened again by its withdrawal. Synthetic values only.
 */
const day = (v: string) => v as BusinessDate;
const PR = '6f1c2a9e-0000-4000-8000-0000000000bb';
const KIND = 'OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER';
const fact = (o: Partial<OwnershipAlignmentFact> = {}): OwnershipAlignmentFact => ({
  acquisitionId: '6f1c2a9e-0000-4000-8000-0000000000b1',
  contractDate: day('2025-03-01'),
  economicTransferDate: day('2025-05-01'),
  auditRecordId: '6f1c2a9e-0000-4000-8000-0000000000f2',
  alignedAt: new Date('2026-02-10T10:00:00Z'),
  ...o,
});
const context = { propertyReferenceId: PR, fingerprinter: testFingerprinter };
const ack = (change: { auditRecordId: string; changeFingerprint: string }, status: 'ACTIVE' | 'WITHDRAWN' = 'ACTIVE'): TaxYearAcknowledgement =>
  ({
    acknowledgementId: 'k2',
    status,
    acknowledgedAt: new Date('2026-02-11T10:00:00Z'),
    acknowledgedBy: 'anna@example.com',
    change: { auditRecordId: change.auditRecordId, fingerprint: change.changeFingerprint },
  }) as unknown as TaxYearAcknowledgement;
const levels = (f: OwnershipAlignmentFact, years: number[]) => years.map((y) => ownershipAlignmentChanges([f], y, context)[0]?.level ?? null);

describe('OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER in the tax-year view (§58Q)', () => {
  it('the years of the former gap only; across a year end both years; a transfer on 1 January touches the old year only', () => {
    expect(levels(fact(), [2024, 2025, 2026])).toEqual([null, 'OPEN', null]);
    const across = fact({ contractDate: day('2024-12-01'), economicTransferDate: day('2025-02-01') });
    expect(levels(across, [2023, 2024, 2025, 2026])).toEqual([null, 'OPEN', 'OPEN', null]);
    const newYear = fact({ contractDate: day('2024-12-01'), economicTransferDate: day('2025-01-01') });
    expect(levels(newYear, [2024, 2025])).toEqual(['OPEN', null]);
    expect(ownershipAlignmentChanges([fact({ economicTransferDate: day('2025-03-01') })], 2025, context)).toEqual([]);
    expect(ownershipAlignmentChanges(undefined, 2025, context)).toEqual([]);
  });

  it('OPEN when the act lies after the year 31 December in Berlin, INFORMATIVE before; the day boundary in Europe/Berlin', () => {
    expect(levels(fact({ alignedAt: new Date('2025-06-01T10:00:00Z') }), [2025])).toEqual(['INFORMATIVE']);
    // 2025-12-31 23:30 UTC is 2026-01-01 in Berlin: after the year end.
    expect(levels(fact({ alignedAt: new Date('2025-12-31T23:30:00Z') }), [2025])).toEqual(['OPEN']);
    expect(levels(fact({ alignedAt: new Date('2025-12-31T22:30:00Z') }), [2025])).toEqual(['INFORMATIVE']);
    // Across a year end, acted in the second year: the first year open, the second informative.
    const across = fact({ contractDate: day('2024-12-01'), economicTransferDate: day('2025-02-01'), alignedAt: new Date('2025-03-01T10:00:00Z') });
    expect(levels(across, [2024, 2025])).toEqual(['OPEN', 'INFORMATIVE']);
  });

  it('the entry, the fingerprint per year and record, ordered by acquisitionId; the kind of §58N untouched', () => {
    const across = fact({ contractDate: day('2024-12-01'), economicTransferDate: day('2025-02-01') });
    const [a] = ownershipAlignmentChanges([across], 2024, context);
    const [b] = ownershipAlignmentChanges([across], 2025, context);
    expect(a?.changeFingerprint).not.toBe(b?.changeFingerprint);
    if (a === undefined) throw new Error('no change');
    expect(a).toMatchObject({ kind: KIND, entityType: 'Acquisition', entityId: across.acquisitionId, items: [] });
    expect(ownershipAlignmentEntry({ ...a, acknowledgement: null })).toEqual({
      acquisitionId: across.acquisitionId,
      contractDate: '2024-12-01',
      economicTransferDate: '2025-02-01',
      level: 'OPEN',
      auditRecordId: across.auditRecordId,
      alignedAt: '2026-02-10T10:00:00.000Z',
      changeFingerprint: a.changeFingerprint,
      acknowledgement: null,
    });
    // The same record under §58N's kind would fingerprint differently: the kind is part of it.
    const [start] = ownershipStartChanges(
      [
        {
          acquisitionId: a.entityId,
          ownershipStart: day('2024-12-01'),
          economicTransferDate: day('2025-02-01'),
          sellerHasAfaComponent: true,
          auditRecordId: a.auditRecordId,
          recordedAt: a.amendedAt,
        },
      ],
      2024,
      context,
    );
    expect(start?.changeFingerprint).not.toBe(a.changeFingerprint);
    const two = ownershipAlignmentChanges([fact({ acquisitionId: 'b' }), fact({ acquisitionId: 'a' })], 2025, context);
    expect(two.map((c) => c.entityId)).toEqual(['a', 'b']);
  });

  it('open until acknowledged; acknowledged informative; a withdrawal opens it again; an INFORMATIVE entry never holds the year', () => {
    const [change] = ownershipAlignmentChanges([fact()], 2025, context);
    if (change === undefined) throw new Error('no change');
    const flag = (acknowledgements: TaxYearAcknowledgement[]) => [
      { code: KIND, details: [ownershipAlignmentEntry({ ...change, acknowledgement: matchAcknowledgement(change, acknowledgements) })] },
    ];
    expect(reviewOf(flag([]), [])).toMatchObject({ final: false, open: [{ code: KIND, count: 1 }] });
    expect(reviewOf(flag([ack(change)]), [])).toMatchObject({ final: true, info: [{ code: KIND, count: 1 }] });
    expect(reviewOf(flag([ack(change, 'WITHDRAWN')]), []).final).toBe(false);
    const [info] = ownershipAlignmentChanges([fact({ alignedAt: new Date('2025-06-01T10:00:00Z') })], 2025, context);
    if (info === undefined) throw new Error('no change');
    expect(reviewOf([{ code: KIND, details: [ownershipAlignmentEntry({ ...info, acknowledgement: null })] }], []).final).toBe(true);
  });

  it('acknowledging: found by record and kind, the fingerprint compared, AMBIGUOUS never (one record, one kind), the no-op', () => {
    const [change] = ownershipAlignmentChanges([fact()], 2025, context);
    if (change === undefined) throw new Error('no change');
    const request = { auditRecordId: change.auditRecordId, expectedFingerprint: change.changeFingerprint };
    expect(planAcknowledgement([change], request, [])).toEqual({ kind: 'CREATE', change });
    expect(planAcknowledgement([change], { ...request, kind: KIND }, []).kind).toBe('CREATE');
    expect(planAcknowledgement([change], { ...request, kind: 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER' }, []).kind).toBe('NOT_FLAGGED');
    expect(planAcknowledgement([change], { ...request, expectedFingerprint: 'f'.repeat(64) }, []).kind).toBe('DIFFERS');
    expect(planAcknowledgement([change], request, [ack(change)]).kind).toBe('NOOP');
  });
});
