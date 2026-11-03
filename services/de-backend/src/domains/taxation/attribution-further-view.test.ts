import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import type { DepositPartHistory, DepositReconciliationHistory } from './attribution-deposits.js';
import type { HistoryRecord } from './attribution-history.js';
import { partChanges, type PartChange } from './attribution-parts.js';
import { attributeTaxYear, hausgeldTiming } from './cash-timing.js';
import { deriveDepositTaxMeaning } from './deposit-closing.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import type { TaxYearAcknowledgement } from './tax-statements.js';
import { NO_DEPRECIATION } from './tax-year-depreciation.js';
import { buildTaxYearView, type TaxYearItem, type TaxYearRead, type TaxYearView } from './tax-year-view.js';

/**
 * §58H (VC-X-49) in the view, pure: the deposit's part change as the year flag `PROPERTY_PART_CHANGED` and the item
 * flag on the deposit now in P's view (attributed in a line, or listed not attributed), the level by state, `final`, the
 * figures as now (never moved by a flag or an acknowledgement), an inconsistent reconciliation named once; and the WEG
 * economic plan moving nothing under `DE_CASH_TIMING@1` (Entscheidung des Projektinhabers, 2026-11-03, §58H Frage 1).
 * The example of §58H with its numbers. Synthetic values only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2028-10-30');
const [P1, P2] = [1, 2].map((n) => `0000e4a0-0000-4000-8000-00000000000${n}`) as [string, string];
const T = '6512f0c2a1b2c3d4e5f6e4a1';
const D = '0000e4a1-0000-4000-8000-000000000001';
const rec = (auditRecordId: string, action: string, iso: string): HistoryRecord => ({ auditRecordId, action, occurredAt: new Date(iso) });
const r = (id: string, pr: string, confirmedNow: boolean, records: HistoryRecord[]): DepositReconciliationHistory => ({
  reconciliationId: id,
  transactionId: `tx-${id}`,
  mreRentTerm: '2027030100',
  confirmedNow,
  records,
  propertyReferenceIds: [pr],
});
const ON_P1 = r('rec-1', P1, true, [rec('a-1', 'CONFIRMED', '2027-03-05T10:00:00Z')]);
const MATCHED = r('rec-2', P2, true, [rec('a-2', 'CONFIRMED', '2028-02-10T10:00:00Z')]);
const RELEASED = r('rec-2', P2, false, [rec('a-2', 'CONFIRMED', '2028-02-10T10:00:00Z'), rec('a-3', 'RELEASED', '2028-02-20T10:00:00Z')]);
const history = (reconciliations: DepositReconciliationHistory[]): DepositPartHistory => ({
  securityDepositId: D,
  mreTenantId: T,
  closingDate: day('2027-06-30'),
  retainedAmount: eur('300.00'),
  reconciliations,
});

/** P's read of 2027 with D's reconciliations as given and D as now derived from them (classified RETAINED_DEPOSIT_RENT / INCOME). */
function readOf(pr: string, reconciliations: DepositReconciliationHistory[], extra: Partial<TaxYearRead> = {}): TaxYearRead {
  const candidates = [...new Set(reconciliations.filter((x) => x.confirmedNow).flatMap((x) => x.propertyReferenceIds))].sort();
  const meaning = deriveDepositTaxMeaning(
    {
      securityDepositId: D,
      status: 'CLOSED',
      closingDate: day('2027-06-30'),
      retainedAmount: eur('300.00'),
      propertyReferenceId: candidates.length === 1 ? (candidates[0] as string) : null,
      propertyCandidates: candidates,
    },
    null,
    TAX_RULES,
    today,
  );
  const classified = {
    ...meaning,
    taxCategory: 'RETAINED_DEPOSIT_RENT',
    treatment: 'INCOME',
    reviewState: 'USER_CONFIRMED',
    origin: 'CLASSIFICATION',
  } as typeof meaning;
  const attributed = classified.propertyReferenceId === pr;
  return {
    propertyReferenceId: pr,
    ownerPartyFound: null,
    sources: attributed ? [{ item: { ...classified, yearAmount: classified.amount }, listed: true }] : [],
    unattributedDeposits: classified.propertyReferenceId === null ? [classified] : [],
    ownerships: [
      {
        id: `own-${pr}`,
        partyId: 'aaaaaaaa-0000-4000-8000-0000000004a0',
        share: { numerator: 1, denominator: 1 },
        validFrom: day('2026-01-01'),
        validUntil: null,
      },
    ],
    checks: [],
    attribution: { references: [], candidates: [] },
    allocatedLoanInterest: [],
    loanAllocationSets: new Map(),
    depreciation: NO_DEPRECIATION(2027),
    parts: { loans: [], deposits: [history(reconciliations)] },
    ...extra,
  };
}
const viewOf = (read: TaxYearRead): TaxYearView => {
  const outcome = buildTaxYearView(read, { year: 2027, ownerPartyId: null, today, registry: TAX_RULES, fingerprinter });
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
};
const line = (v: TaxYearView) => v.einnahmen.lines.find((l) => l.taxCategory === 'RETAINED_DEPOSIT_RENT' && l.items.length > 0);
const level = (v: TaxYearView, code = 'PROPERTY_PART_CHANGED') => [v.review.open.some((o) => o.code === code), v.review.info.some((o) => o.code === code)];
type Entry = { kind: string; auditRecordId: string; acknowledgement: unknown; items: unknown[] };
const entries = (v: TaxYearView) => (v.flags.find((f) => f.code === 'PROPERTY_PART_CHANGED')?.details ?? []) as Entry[];
const itemFlag = (i: TaxYearItem | undefined) => (i?.flags.find((f) => f.code === 'PROPERTY_PART_CHANGED')?.details ?? []) as Entry[];
const codes = (v: TaxYearView) => v.flags.map((f) => f.code);
const ackOf = (c: PartChange): TaxYearAcknowledgement => ({
  acknowledgementId: `ack-${c.auditRecordId}`,
  propertyReferenceId: P1,
  year: 2027,
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

describe('the deposit of §58H in the views of 2027', () => {
  it('before the match: P1 line RETAINED_DEPOSIT_RENT 300.00, no flag, final; P2 nothing', () => {
    const [v1, v2] = [viewOf(readOf(P1, [ON_P1])), viewOf(readOf(P2, [ON_P1]))];
    expect([line(v1)?.total.amount, entries(v1), v1.review.final]).toEqual(['300.00', [], true]);
    expect([line(v2), v2.notAttributed.items, entries(v2), v2.review.final]).toEqual([undefined, [], [], true]);
  });

  it('matched on 2028-02-10: P1 income 300.00 lower, D listed not attributed with the item flag, the year flag open, not final; P2 lists D unflagged', () => {
    const before = viewOf(readOf(P1, [ON_P1]));
    const v1 = viewOf(readOf(P1, [ON_P1, MATCHED]));
    expect(line(v1)).toBeUndefined();
    expect(BigInt(before.einnahmen.total.amount.replace('.', '')) - BigInt(v1.einnahmen.total.amount.replace('.', ''))).toBe(30000n);
    expect(entries(v1).map((e) => [e.kind, e.auditRecordId, e.acknowledgement])).toEqual([['DEPOSIT_RECONCILIATION_CONFIRMED', 'a-2', null]]);
    expect(entries(v1)[0]).toMatchObject({
      entityType: 'RentPaymentReconciliation',
      entityId: 'rec-2',
      reconciliationId: 'rec-2',
      mreTenantId: T,
      securityDepositIds: [D],
      items: [
        {
          sourceType: 'DEPOSIT_CLOSING',
          sourceId: D,
          taxYear: 2027,
          stateBefore: 'ATTRIBUTED',
          partBefore: eur('300.00').toJSON(),
          stateAfter: 'NOT_ATTRIBUTED',
          partAfter: null,
        },
      ],
    });
    const listed = v1.notAttributed.items.find((i) => i.sourceId === D);
    expect(itemFlag(listed).map((e) => [e.kind, (e as unknown as { stateAfter: string }).stateAfter])).toEqual([
      ['DEPOSIT_RECONCILIATION_CONFIRMED', 'NOT_ATTRIBUTED'],
    ]);
    expect([level(v1), v1.review.final, codes(v1)]).toEqual([[true, false], false, ['PROPERTY_PART_CHANGED', 'UNATTRIBUTED_ITEMS']]);
    const v2 = viewOf(readOf(P2, [ON_P1, MATCHED]));
    expect([v2.notAttributed.items.map((i) => [i.sourceId, itemFlag(i).length]), entries(v2), codes(v2)]).toEqual([[[D, 0]], [], ['UNATTRIBUTED_ITEMS']]);
  });

  it('released on 2028-02-20: D is P1 s again (300.00 in its line with the item flag of both entries), two entries open until both are acknowledged', () => {
    const read = readOf(P1, [ON_P1, RELEASED]);
    const v1 = viewOf(read);
    expect([line(v1)?.total.amount, codes(v1)]).toEqual(['300.00', ['PROPERTY_PART_CHANGED']]);
    expect(entries(v1).map((e) => e.kind)).toEqual(['DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED']);
    expect(itemFlag(line(v1)?.items[0]).map((e) => e.kind)).toEqual(['DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED']);
    const changes = partChanges(read.parts, 2027, { propertyReferenceId: P1, fingerprinter }).changes as [PartChange, PartChange];
    const one = viewOf(readOf(P1, [ON_P1, RELEASED], { acknowledgements: [ackOf(changes[0])] }));
    expect([level(one), one.review.final]).toEqual([[true, false], false]);
    const both = viewOf(readOf(P1, [ON_P1, RELEASED], { acknowledgements: changes.map(ackOf) }));
    expect([level(both), both.review.final, both.review.open]).toEqual([[false, true], true, []]);
    // The acknowledgements change no figure.
    expect([both.einnahmen.total, line(both)?.total, both.result]).toEqual([v1.einnahmen.total, line(v1)?.total, v1.result]);
    // A withdrawn acknowledgement does not count.
    const withdrawn = viewOf(readOf(P1, [ON_P1, RELEASED], { acknowledgements: changes.map((c) => ({ ...ackOf(c), status: 'WITHDRAWN' as const })) }));
    expect(level(withdrawn)).toEqual([true, false]);
  });

  it('an inconsistent reconciliation read by both flags is named once in ATTRIBUTION_HISTORY_INCONSISTENT', () => {
    const broken = r('rec-2', P2, true, [rec('a-3', 'RELEASED', '2028-02-20T10:00:00Z')]);
    const read = readOf(P1, [ON_P1, broken], {
      attribution: {
        references: [],
        candidates: [],
        reconciliations: {
          candidates: [{ sourceId: 'x', transactionId: 'tx-rec-2', bookingDate: day('2027-12-30'), financialCategoryCode: 'RENT_BASE', taxYearOverride: null }],
          reconciliations: [
            { reconciliationId: 'rec-2', transactionId: 'tx-rec-2', mreTenantId: T, mreRentTerm: '2028010100', confirmedNow: true, records: broken.records },
          ],
          rentDueDays: [],
        },
      },
    });
    expect(viewOf(read).flags.filter((f) => f.code === 'ATTRIBUTION_HISTORY_INCONSISTENT')).toEqual([
      { code: 'ATTRIBUTION_HISTORY_INCONSISTENT', details: { entityType: 'RentPaymentReconciliation', entityId: 'rec-2' } },
    ]);
  });
});

describe('the WEG economic plan of §58H moves nothing under DE_CASH_TIMING@1 (§58H Frage 1)', () => {
  const debit = { bookingDate: day('2027-12-30'), financialCategoryCode: 'WEG_RECOVERABLE' };
  it('E1 advanceDueDay 1: due 2028-01-01, proposedYear 2028, the year 2027; E2 day 28: due 2027-12-28, no proposal, 2027; no plan: day 1 assumed, 2027', () => {
    const e1 = attributeTaxYear(debit, hausgeldTiming(debit.bookingDate, 1), null, TAX_RULES);
    expect([e1.taxYear, e1.attribution.proposedYear, e1.flags.map((f) => f.code)]).toEqual([2027, 2028, ['ECONOMIC_PERIOD_ASSUMED']]);
    const e2 = attributeTaxYear(debit, hausgeldTiming(debit.bookingDate, 28), null, TAX_RULES);
    expect([hausgeldTiming(debit.bookingDate, 28)]).toMatchObject([{ dueDate: '2027-12-28', economicYear: 2027 }]);
    expect([e2.taxYear, e2.attribution.proposedYear, e2.flags]).toEqual([2027, 2027, []]);
    const none = attributeTaxYear(debit, { kind: 'NO_ECONOMIC_PERIOD', reason: 'NO_ECONOMIC_PLAN' }, null, TAX_RULES);
    expect(none.taxYear).toBe(2027);
    // The rule in force for the booking date is DE_CASH_TIMING@1, the one whose Hausgeld never moves.
    expect(e1.attribution.rule).toEqual({ ruleCode: 'DE_CASH_TIMING', version: 1 });
  });
});
