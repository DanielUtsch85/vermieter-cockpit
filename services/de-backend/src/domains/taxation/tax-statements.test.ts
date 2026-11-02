import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import type { LoanAllocationSetView } from '../financing/index.js';
import { changeFingerprint, type AttributionInput } from './attribution-changes.js';
import type { TaxListItem, TaxMeaning } from './classification.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import { NO_DEPRECIATION } from './tax-year-depreciation.js';
import { flagIsOpen } from './tax-year-review.js';
import { buildTaxYearView, type TaxYearRead, type TaxYearView } from './tax-year-view.js';
import { matchAcknowledgement, nothingToConfirm, planAcknowledgement, type TaxYearAcknowledgement } from './tax-statements.js';
import type { ReviewState } from './vocabulary.js';

/**
 * §58E Parts 2 and 3 (VC-X-28), pure: the change fingerprint, the matching of an acknowledgement, the order of checks
 * of the command (steps 3–5), what needs no confirmation, and the levels in the view (codes kept, the level by state,
 * decided by the owner on 2026-11-01, question 6): `final` exactly when nothing else is open, and a statement replaces
 * neither missing evidence nor a computation (decided by the owner on 2026-11-02). Synthetic values only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2029-10-30');
const PR = '0000e28f-0000-4000-8000-000000000001';
const RENT = '0000e28f-0000-4000-8000-0000000000a1';
const TENANT = '6512f0c2a1b2c3d4e5f6e2f1';
const ITEMS = [{ sourceId: RENT, yearBefore: 2027, yearAfter: 2028 }];

/** A confirmed rent of 2028 (paid 2027-12-29); its review state is the caller's. */
function rent(reviewState: ReviewState = 'USER_CONFIRMED', taxYear = 2028): TaxListItem {
  const meaning: TaxMeaning = {
    splitId: RENT,
    sourceId: RENT,
    sourceType: 'TRANSACTION_SPLIT',
    transactionId: '0000e28f-0000-4000-8000-0000000000b1',
    position: 1,
    bookingDate: day('2027-12-29'),
    direction: 'INFLOW',
    amount: eur('800.00'),
    financialCategoryCode: 'RENT_BASE',
    categoryType: 'INCOME',
    propertyReferenceId: PR,
    transactionStatus: 'CONFIRMED',
    correctionRole: null,
    counts: true,
    taxCategory: 'RENT',
    treatment: 'INCOME',
    reviewState,
    origin: reviewState === 'SUGGESTED' ? 'DEFAULT' : 'CLASSIFICATION',
    rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
    classificationId: null,
    taxYear,
    attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: 2027, proposedYear: taxYear, overridden: false },
    refund: null,
    netAmount: null,
    performance: null,
    treatmentRule: null,
    distribution: null,
    suggestion: null,
    flags: [],
  };
  return { ...meaning, yearAmount: eur('800.00') };
}

/** The rent matched on 2029-02-01, after both years: one change, flagged in 2027 and 2028. */
const attribution: AttributionInput = {
  references: [],
  candidates: [],
  reconciliations: {
    candidates: [{ sourceId: RENT, transactionId: 'tx', bookingDate: day('2027-12-29'), financialCategoryCode: 'RENT_BASE', taxYearOverride: null }],
    reconciliations: [
      {
        reconciliationId: 'rec-1',
        transactionId: 'tx',
        mreTenantId: TENANT,
        mreRentTerm: '2028010100',
        confirmedNow: true,
        records: [{ auditRecordId: 'a-1', action: 'CONFIRMED', occurredAt: new Date('2029-02-01T10:00:00Z') }],
      },
    ],
    rentDueDays: [{ mreTenantId: TENANT, rentDueDays: [{ validFrom: day('2026-01-01'), day: 3 }] }],
  },
};
const ack = (
  year: number,
  o: Partial<TaxYearAcknowledgement> = {},
  fp = changeFingerprint(fingerprinter, { propertyReferenceId: PR, year, auditRecordId: 'a-1', kind: 'RECONCILIATION_CONFIRMED', items: ITEMS }),
): TaxYearAcknowledgement => ({
  acknowledgementId: `ack-${year}`,
  propertyReferenceId: PR,
  year,
  status: 'ACTIVE',
  change: {
    auditRecordId: 'a-1',
    kind: 'RECONCILIATION_CONFIRMED',
    entityType: 'RentPaymentReconciliation',
    entityId: 'rec-1',
    recordedAt: new Date('2029-02-01T10:00:00Z'),
    fingerprint: fp,
    items: ITEMS,
  },
  reason: 'Grund',
  acknowledgedAt: new Date('2029-03-01T10:00:00Z'),
  acknowledgedBy: 'anna@example.com',
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawReason: null,
  version: 1,
  ...o,
});
const readOf = (o: Partial<TaxYearRead> = {}): TaxYearRead => ({
  propertyReferenceId: PR,
  ownerPartyFound: null,
  sources: [{ item: rent(), listed: true }],
  unattributedDeposits: [],
  ownerships: [
    { id: 'own-a', partyId: 'aaaaaaaa-0000-4000-8000-000000000000', share: { numerator: 1, denominator: 1 }, validFrom: day('2020-01-01'), validUntil: null },
  ],
  checks: [],
  attribution,
  allocatedLoanInterest: [],
  loanAllocationSets: new Map(),
  depreciation: NO_DEPRECIATION(2028),
  ...o,
});
const viewOf = (read: TaxYearRead, year = 2028): TaxYearView => {
  const outcome = buildTaxYearView(read, { year, ownerPartyId: null, today, registry: TAX_RULES, fingerprinter });
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
};
const levelOf = (v: TaxYearView, code: string) => [v.review.open.some((o) => o.code === code), v.review.info.some((o) => o.code === code)];

describe('the change fingerprint (§58E Part 2)', () => {
  const fp = (o: Partial<Parameters<typeof changeFingerprint>[1]> = {}) =>
    changeFingerprint(fingerprinter, { propertyReferenceId: PR, year: 2028, auditRecordId: 'a-1', kind: 'RECONCILIATION_CONFIRMED', items: ITEMS, ...o });
  it('stable over item order and id case; different for another item, year, record or kind; equal at both levels of the view', () => {
    const two = [ITEMS[0] as (typeof ITEMS)[number], { sourceId: '0000e28f-0000-4000-8000-0000000000a0', yearBefore: 2028, yearAfter: 2027 }];
    expect(fp({ items: two })).toBe(fp({ items: [...two].reverse() }));
    expect(fp({ propertyReferenceId: PR.toUpperCase() })).toBe(fp());
    expect(new Set([fp(), fp({ items: two }), fp({ year: 2027 }), fp({ auditRecordId: 'a-2' }), fp({ kind: 'RECONCILIATION_RELEASED' })]).size).toBe(5);
    const v = viewOf(readOf());
    const year = (v.flags.find((f) => f.code === 'ATTRIBUTION_INPUT_CHANGED')?.details as { changeFingerprint: string }[])[0]?.changeFingerprint;
    const item = (v.einnahmen.lines[0]?.items[0]?.flags.find((f) => f.code === 'ATTRIBUTION_INPUT_CHANGED')?.details as { changeFingerprint: string }[])[0]
      ?.changeFingerprint;
    expect([year, item]).toEqual([fp(), fp()]);
  });
});

describe('matching and the order of checks (§58E Part 2)', () => {
  const change = { auditRecordId: 'a-1', changeFingerprint: ack(2028).change.fingerprint };
  it('matched by record and fingerprint only while ACTIVE; another fingerprint or a withdrawn one does not match', () => {
    expect(matchAcknowledgement(change, [ack(2028)])).toEqual({
      acknowledgementId: 'ack-2028',
      acknowledgedAt: '2029-03-01T10:00:00.000Z',
      acknowledgedBy: 'anna@example.com',
    });
    expect(matchAcknowledgement(change, [ack(2028, { status: 'WITHDRAWN' })])).toBeNull();
    expect(matchAcknowledgement({ ...change, changeFingerprint: 'x' }, [ack(2028)])).toBeNull();
    expect(matchAcknowledgement({ ...change, auditRecordId: 'a-2' }, [ack(2028)])).toBeNull();
  });
  it('steps 3 to 5: not flagged, differs, the no-op, create', () => {
    const changes = [
      {
        ...change,
        kind: 'RECONCILIATION_CONFIRMED',
        entityType: 'RentPaymentReconciliation',
        entityId: 'rec-1',
        amendedAt: new Date(),
        keys: {},
        items: ITEMS,
      },
    ] as const;
    expect(planAcknowledgement(changes, { auditRecordId: 'a-9', expectedFingerprint: change.changeFingerprint }, [])).toEqual({ kind: 'NOT_FLAGGED' });
    expect(planAcknowledgement(changes, { auditRecordId: 'a-1', expectedFingerprint: 'x' }, [])).toEqual({
      kind: 'DIFFERS',
      currentFingerprint: change.changeFingerprint,
    });
    expect(planAcknowledgement(changes, { auditRecordId: 'a-1', expectedFingerprint: change.changeFingerprint }, [ack(2028)]).kind).toBe('NOOP');
    expect(
      planAcknowledgement(changes, { auditRecordId: 'a-1', expectedFingerprint: change.changeFingerprint }, [ack(2028, { status: 'WITHDRAWN' })]).kind,
    ).toBe('CREATE');
  });
  it('nothing to confirm: a VOID Loan, a VOID set, a MANUAL set, one entry; a CLOSED Loan can be confirmed', () => {
    const entry = { propertyReferenceId: PR, share: { numerator: 1n, denominator: 2n }, acquisitionId: null };
    const set = { status: 'VALID', basis: 'PURCHASE_PRICE', allocations: [entry, entry] } as unknown as LoanAllocationSetView;
    expect(nothingToConfirm('VOID', set)).toBe('LOAN_VOID');
    expect(nothingToConfirm('ACTIVE', { ...set, status: 'VOID' })).toBe('SET_VOID');
    expect(nothingToConfirm('ACTIVE', { ...set, basis: 'MANUAL' })).toBe('NOT_PURCHASE_PRICE');
    expect(nothingToConfirm('ACTIVE', { ...set, allocations: [entry] })).toBe('SINGLE_ENTRY');
    expect([nothingToConfirm('ACTIVE', set), nothingToConfirm('CLOSED', set)]).toEqual([null, null]);
  });
});

describe('the levels in the view and final (§58E "In the view", "The effect on final")', () => {
  it('open with the change unacknowledged; informative and final once acknowledged in this year; open again when withdrawn or acknowledged in another year', () => {
    const open = viewOf(readOf());
    expect([levelOf(open, 'ATTRIBUTION_INPUT_CHANGED'), open.review.final]).toEqual([[true, false], false]);
    const done = viewOf(readOf({ acknowledgements: [ack(2028)] }));
    expect([levelOf(done, 'ATTRIBUTION_INPUT_CHANGED'), done.review.final, done.review.open]).toEqual([[false, true], true, []]);
    // The item flag too, by the same entries; the code is kept.
    const itemFlag = done.einnahmen.lines[0]?.items[0]?.flags.find((f) => f.code === 'ATTRIBUTION_INPUT_CHANGED');
    expect((itemFlag?.details as { acknowledgement: unknown }[])[0]?.acknowledgement).toMatchObject({ acknowledgementId: 'ack-2028' });
    for (const acknowledgements of [[ack(2028, { status: 'WITHDRAWN' })], [ack(2027, {}, ack(2027).change.fingerprint)], [ack(2028, {}, 'f'.repeat(64))]]) {
      expect(viewOf(readOf({ acknowledgements })).review.final).toBe(false);
    }
    // The figures do not move.
    expect([done.einnahmen.total, done.result, done.einnahmen.lines[0]?.items[0]?.lineAmount]).toEqual([
      open.einnahmen.total,
      open.result,
      open.einnahmen.lines[0]?.items[0]?.lineAmount,
    ]);
  });

  it('a statement replaces no other review: a rent needing review keeps its open flag, and the year stays not final', () => {
    const unconfirmed = viewOf(readOf({ sources: [{ item: rent('NEEDS_REVIEW'), listed: true }], acknowledgements: [ack(2028)] }));
    expect(levelOf(unconfirmed, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([false, true]);
    expect([unconfirmed.review.final, unconfirmed.review.open.length > 0]).toEqual([false, true]);
  });

  it('the price flag: open without and informative with the set confirmation; a USER_CONFIRMED classification clears nothing', () => {
    const item = { treatment: 'DEDUCTIBLE', origin: 'CLASSIFICATION', reviewState: 'USER_CONFIRMED' } as const;
    const confirmation = { confirmationId: 'c-1', confirmedAt: '2029-03-01T10:00:00.000Z', confirmedBy: 'x', advisorPartyId: null };
    expect(flagIsOpen('LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', item, { loanId: 'l', allocationSetId: 's', confirmation: null })).toBe(true);
    expect(flagIsOpen('LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', item, { loanId: 'l', allocationSetId: 's', confirmation })).toBe(false);
    expect(flagIsOpen('ATTRIBUTION_INPUT_CHANGED', item, [{ acknowledgement: null }])).toBe(true);
    expect(flagIsOpen('ATTRIBUTION_INPUT_CHANGED', item, [{ acknowledgement: {} }, { acknowledgement: null }])).toBe(true);
    expect(flagIsOpen('ATTRIBUTION_INPUT_CHANGED', item, [{ acknowledgement: {} }])).toBe(false);
    expect(flagIsOpen('ATTRIBUTION_HISTORY_INCONSISTENT', item, {})).toBe(true);
  });
});
