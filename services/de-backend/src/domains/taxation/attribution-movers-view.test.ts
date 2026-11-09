import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import { attributionChanges, type AttributionChange } from './attribution-changes.js';
import type { CorrectionHistory } from './attribution-corrections.js';
import { partChanges, type PartChange } from './attribution-parts.js';
import { interest } from './attribution-parts.test-support.js';
import type { DepositClosingHistory, DepositClosingState } from './attribution-reopen.js';
import type { TaxMeaning } from './classification.js';
import { deriveDepositTaxMeaning, type DepositTaxMeaning } from './deposit-closing.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import type { TaxYearAcknowledgement } from './tax-statements.js';
import { NO_DEPRECIATION } from './tax-year-depreciation.js';
import { flagIsOpen, notCountedIsOpen } from './tax-year-review.js';
import { buildTaxYearView, type TaxYearItem, type TaxYearRead, type TaxYearView } from './tax-year-view.js';

/**
 * §58I (VC-X-50) in the view, pure: the deposit kinds as `ATTRIBUTION_INPUT_CHANGED` (the year flag, the item flag on
 * the deposit now in `year`), the correction kinds as `PROPERTY_PART_CHANGED` (the item flag on the split now in P's
 * view), the levels by state and `final`, the figures never moved by a flag or an acknowledgement; and `NOT_COUNTED`
 * with `CLOSING_CHANGED` or `USE_CHANGED` open (Entscheidung des Projektinhabers, 2026-11-03, §58I Frage 4), every
 * other reason informative. Example (a) and (b) with their numbers. Synthetic values only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2028-10-30');
const [P1, P2] = [1, 2].map((n) => `0000e50a-0000-4000-8000-00000000001${n}`) as [string, string];
const D = '0000e50b-0000-4000-8000-000000000011';
const T = '6512f0c2a1b2c3d4e5f6e50b';
const OWNER = 'aaaaaaaa-0000-4000-8000-0000000000e5';
const FIRST: DepositClosingState = { closingDate: day('2027-12-20'), reason: 'RETAINED', heldAtClosing: eur('300.00') };
const rec = (auditRecordId: string, action: string, iso: string, closing: DepositClosingState | null = null) => ({
  auditRecordId,
  action,
  occurredAt: new Date(iso),
  closing,
});
const CREATED = rec('c-0', 'CREATED', '2027-01-05T10:00:00Z');
const CLOSED_1 = rec('c-1', 'CLOSED', '2027-12-20T10:00:00Z', FIRST);
const REOPENED = rec('c-2', 'REOPENED', '2028-02-12T10:00:00Z', FIRST);
const CLOSED_AGAIN = rec('c-3', 'CLOSED', '2028-02-14T10:00:00Z', FIRST);

/** D as the view lists it: closed on `closingDate` with `retained`, classified (USER_CONFIRMED) of `classified`'s closing. */
function depositItem(closingDate: string, retained: string, classifiedCloses: boolean): DepositTaxMeaning {
  const meaning = deriveDepositTaxMeaning(
    { securityDepositId: D, status: 'CLOSED', closingDate: day(closingDate), retainedAmount: eur(retained), propertyReferenceId: P1, propertyCandidates: [P1] },
    null,
    TAX_RULES,
    today,
  );
  return {
    ...meaning,
    taxCategory: 'RETAINED_DEPOSIT_DAMAGES',
    treatment: 'INCOME',
    reviewState: 'USER_CONFIRMED',
    origin: 'CLASSIFICATION',
    counts: classifiedCloses,
    flags: classifiedCloses ? [] : [{ code: 'NOT_COUNTED', details: { depositStatus: 'CLOSED', retainedAmount: eur(retained), reason: 'CLOSING_CHANGED' } }],
  };
}
const history = (records: DepositClosingHistory['records'], now: DepositClosingState | null): DepositClosingHistory => ({
  securityDepositId: D,
  mreTenantId: T,
  status: now === null ? 'ACTIVE' : 'CLOSED',
  closing: now,
  records,
});
function read(
  pr: string,
  year: number,
  o: { sources?: TaxYearRead['sources']; deposits?: DepositClosingHistory[]; corrections?: CorrectionHistory[]; acks?: TaxYearAcknowledgement[] } = {},
): TaxYearRead {
  return {
    propertyReferenceId: pr,
    ownerPartyFound: null,
    sources: o.sources ?? [],
    unattributedDeposits: [],
    ownerships: [{ id: `own-${pr}`, partyId: OWNER, share: { numerator: 1, denominator: 1 }, validFrom: day('2026-01-01'), validUntil: null }],
    checks: [],
    attribution: { references: [], candidates: [], deposits: o.deposits ?? [] },
    allocatedLoanInterest: [],
    loanAllocationSets: new Map(),
    depreciation: NO_DEPRECIATION(year),
    parts: { loans: [], corrections: o.corrections ?? [] },
    acknowledgements: o.acks ?? [],
  };
}
const viewOf = (r: TaxYearRead, year: number): TaxYearView => {
  const outcome = buildTaxYearView(r, { year, ownerPartyId: null, today, registry: TAX_RULES, fingerprinter });
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
};
const level = (v: TaxYearView, code: string) => [v.review.open.some((o) => o.code === code), v.review.info.some((o) => o.code === code)];
const entries = (v: TaxYearView, code: string) => (v.flags.find((f) => f.code === code)?.details ?? []) as { kind: string; items: unknown[] }[];
const itemFlag = (i: TaxYearItem | undefined, code: string) => (i?.flags.find((f) => f.code === code)?.details ?? []) as { kind: string }[];
const ackOf = (pr: string, year: number, c: AttributionChange | PartChange): TaxYearAcknowledgement => ({
  acknowledgementId: `ack-${c.auditRecordId}`,
  propertyReferenceId: pr,
  year,
  status: 'ACTIVE',
  change: {
    auditRecordId: c.auditRecordId,
    kind: c.kind,
    entityType: c.entityType,
    entityId: c.entityId,
    recordedAt: c.amendedAt,
    fingerprint: c.changeFingerprint,
    items: c.items,
  },
  reason: 'Erklärung noch nicht abgegeben (synthetisch)',
  acknowledgedAt: new Date('2028-03-01T10:00:00Z'),
  acknowledgedBy: 'anna@example.com',
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawReason: null,
  version: 1,
});
const lineOf = (v: TaxYearView, category: string) => v.einnahmen.lines.find((l) => l.taxCategory === category);

describe('§58I Part 1 in the view: a deposit reopened and closed anew', () => {
  it('example (a), 2027 after the reopen: D in no list, income without its 300.00, the year flag open and not final; acknowledged: informative and final', () => {
    const deposits = [history([CREATED, CLOSED_1, REOPENED], null)];
    const v = viewOf(read(P1, 2027, { deposits }), 2027);
    expect([lineOf(v, 'RETAINED_DEPOSIT_DAMAGES')?.items, v.einnahmen.total.amount]).toEqual([[], '0.00']);
    expect(entries(v, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([
      expect.objectContaining({ kind: 'DEPOSIT_REOPENED', entityType: 'SecurityDeposit', items: [{ sourceId: D, yearBefore: 2027, yearAfter: null }] }),
    ]);
    expect([level(v, 'ATTRIBUTION_INPUT_CHANGED'), v.review.final]).toEqual([[true, false], false]);
    const [change] = attributionChanges(read(P1, 2027, { deposits }).attribution, 2027, TAX_RULES, { propertyReferenceId: P1, fingerprinter }).changes;
    const acked = viewOf(read(P1, 2027, { deposits, acks: [ackOf(P1, 2027, change as AttributionChange)] }), 2027);
    expect([level(acked, 'ATTRIBUTION_INPUT_CHANGED'), acked.review.final, acked.einnahmen.total]).toEqual([[false, true], true, v.einnahmen.total]);
  });

  it('variant, a reopen by mistake: D back in 2027 s line (300.00) with the item flag of the DEPOSIT_CLOSED entry; two entries', () => {
    const deposits = [history([CREATED, CLOSED_1, REOPENED, CLOSED_AGAIN], FIRST)];
    const v = viewOf(
      read(P1, 2027, { deposits, sources: [{ item: { ...depositItem('2027-12-20', '300.00', true), yearAmount: eur('300.00') }, listed: true }] }),
      2027,
    );
    expect(lineOf(v, 'RETAINED_DEPOSIT_DAMAGES')?.total.amount).toBe('300.00');
    expect(entries(v, 'ATTRIBUTION_INPUT_CHANGED').map((e) => e.kind)).toEqual(['DEPOSIT_REOPENED', 'DEPOSIT_CLOSED']);
    // The item flag names every change that moved D (its sourceType is a deposit closing: the kind tells, §58I Frage 3).
    expect(itemFlag(lineOf(v, 'RETAINED_DEPOSIT_DAMAGES')?.items[0], 'ATTRIBUTION_INPUT_CHANGED').map((e) => e.kind)).toEqual([
      'DEPOSIT_REOPENED',
      'DEPOSIT_CLOSED',
    ]);
  });

  it('example (a), 2028: D closed anew with a confirmed classification of the old closing is NOT_COUNTED (CLOSING_CHANGED), open, 2028 not final (§58I Frage 4)', () => {
    const second: DepositClosingState = { closingDate: day('2028-01-10'), reason: 'RETAINED', heldAtClosing: eur('250.00') };
    const deposits = [history([CREATED, CLOSED_1, REOPENED, rec('c-3', 'CLOSED', '2028-02-14T10:00:00Z', second)], second)];
    const stale = depositItem('2028-01-10', '250.00', false);
    const v = viewOf(read(P1, 2028, { deposits, sources: [{ item: { ...stale, yearAmount: eur('250.00') }, listed: true }] }), 2028);
    expect([v.unclassified.items.map((i) => i.sourceId), entries(v, 'ATTRIBUTION_INPUT_CHANGED')]).toEqual([[D], []]);
    expect([level(v, 'NOT_COUNTED'), v.review.final]).toEqual([[true, false], false]);
    // A new classification of the new closing: D counts, 250.00 in 2028's line, final.
    const fresh = depositItem('2028-01-10', '250.00', true);
    const after = viewOf(read(P1, 2028, { deposits, sources: [{ item: { ...fresh, yearAmount: eur('250.00') }, listed: true }] }), 2028);
    expect([lineOf(after, 'RETAINED_DEPOSIT_DAMAGES')?.total.amount, after.review.final]).toEqual(['250.00', true]);
  });

  it('NOT_COUNTED open only for CLOSING_CHANGED and USE_CHANGED; a source that does not count stays informative', () => {
    const item = { treatment: null, origin: 'CLASSIFICATION', reviewState: 'USER_CONFIRMED' } as const;
    expect(flagIsOpen('NOT_COUNTED', item, { depositStatus: 'CLOSED', reason: 'CLOSING_CHANGED' })).toBe(true);
    expect(flagIsOpen('NOT_COUNTED', item, { notCountedReason: 'USE_CHANGED' })).toBe(true);
    for (const details of [
      { depositStatus: 'ACTIVE', reason: 'NOT_CLOSED' },
      { depositStatus: 'CLOSED', reason: 'NOTHING_RETAINED' },
      { notCountedReason: 'USE_REMOVED' },
      { notCountedReason: 'ASSESSMENT_VOID' },
      { transactionStatus: 'CORRECTED', correctionRole: null },
      undefined,
    ]) {
      expect(notCountedIsOpen(details)).toBe(false);
      expect(flagIsOpen('NOT_COUNTED', item, details)).toBe(false);
    }
  });
});

describe('§58I Part 2 in the view: a rent split corrected from P1 to P2 (example b)', () => {
  const S1 = '0000e50e-0000-4000-8000-000000000011';
  const S2 = '0000e50e-0000-4000-8000-000000000012';
  const corrections: CorrectionHistory[] = [
    {
      transactionId: 'tx-x',
      status: 'CORRECTED',
      reversalTransactionId: 'tx-r',
      replacementTransactionId: 'tx-y',
      records: [
        {
          auditRecordId: 'a-x',
          action: 'CORRECTED',
          occurredAt: new Date('2028-03-02T10:00:00Z'),
          reversalTransactionId: 'tx-r',
          replacementTransactionId: 'tx-y',
          reason: 'Falsches Objekt (synthetisch)',
        },
      ],
      splits: (
        [
          [S1, 'ORIGINAL', P1],
          [S2, 'REPLACEMENT', P2],
        ] as const
      ).map(([sourceId, side, pr]) => ({
        sourceId,
        side,
        taxYear: 2027,
        financialCategoryCode: 'RENT_BASE',
        direction: 'INFLOW',
        amount: eur('950.00'),
        bookingDate: day('2027-11-03'),
        propertyReferenceId: pr,
        loanId: null,
      })),
    },
  ];
  /** S2 as P2's view lists it: RENT / INCOME by default, with P7-D2's flag (its original was classified). */
  const s2 = (): TaxMeaning =>
    ({
      ...(interest('950.00', '2027-11-03', 2027, S2).item as TaxMeaning),
      transactionId: 'tx-y',
      direction: 'INFLOW',
      financialCategoryCode: 'RENT_BASE',
      categoryType: 'INCOME',
      propertyReferenceId: P2,
      correctionRole: 'REPLACEMENT',
      taxCategory: 'RENT',
      treatment: 'INCOME',
      reviewState: 'NEEDS_REVIEW',
      origin: 'CATEGORY_DEFAULT',
      classificationId: null,
      flags: [{ code: 'CLASSIFICATION_ON_CORRECTED_SPLIT', details: {} }],
    }) as unknown as TaxMeaning;

  it('P2 2027: the RENT line has S2 (950.00) with the item flag; the year flag open; acknowledged informative, P7-D2 s flag still open', () => {
    const v = viewOf(read(P2, 2027, { corrections, sources: [{ item: { ...s2(), yearAmount: eur('950.00') }, listed: true }] }), 2027);
    expect(lineOf(v, 'RENT')?.total.amount).toBe('950.00');
    expect(entries(v, 'PROPERTY_PART_CHANGED')).toEqual([
      expect.objectContaining({ kind: 'TRANSACTION_CORRECTED', entityType: 'Transaction', transactionId: 'tx-x' }),
    ]);
    expect(itemFlag(lineOf(v, 'RENT')?.items[0], 'PROPERTY_PART_CHANGED').map((e) => e.kind)).toEqual(['TRANSACTION_CORRECTED']);
    expect([level(v, 'PROPERTY_PART_CHANGED'), level(v, 'CLASSIFICATION_ON_CORRECTED_SPLIT'), v.review.final]).toEqual([[true, false], [true, false], false]);
    const [change] = partChanges(read(P2, 2027, { corrections }).parts, 2027, { propertyReferenceId: P2, fingerprinter }).changes;
    const acked = viewOf(
      read(P2, 2027, { corrections, sources: [{ item: { ...s2(), yearAmount: eur('950.00') }, listed: true }], acks: [ackOf(P2, 2027, change as PartChange)] }),
      2027,
    );
    expect([level(acked, 'PROPERTY_PART_CHANGED'), level(acked, 'CLASSIFICATION_ON_CORRECTED_SPLIT'), acked.einnahmen.total]).toEqual([
      [false, true],
      [true, false],
      v.einnahmen.total,
    ]);
  });

  it('P1 2027: S1 is in no list (corrected), the year flag names it, not final', () => {
    const v = viewOf(read(P1, 2027, { corrections }), 2027);
    expect([lineOf(v, 'RENT')?.items, entries(v, 'PROPERTY_PART_CHANGED').map((e) => e.items), v.review.final]).toEqual([
      [],
      [
        [
          {
            sourceType: 'TRANSACTION_SPLIT',
            sourceId: S1,
            taxYear: 2027,
            stateBefore: 'ATTRIBUTED',
            partBefore: eur('950.00').toJSON(),
            stateAfter: 'NONE',
            partAfter: null,
          },
        ],
      ],
      false,
    ]);
  });
});
