import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import type { LoanAllocationSetView, LoanTermsId, SchedulePeriod } from '../financing/index.js';
import { attributionChanges, type AttributionInput, type ReferenceHistory } from './attribution-changes.js';
import type { HistoryRecord, LoanTermsHistory, ReconciliationHistory } from './attribution-history.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';

/**
 * §58E Part 1 (VC-X-28): the widened kinds of `ATTRIBUTION_INPUT_CHANGED`, each judged alone by the one rule: a
 * reconciliation confirmed or released, a Loan terms period added or voided, a RentalContractReference created (decided
 * by the owner on 2026-11-02); the 31-December rule on the record's `occurred_at` (Europe/Berlin); the histories rebuilt
 * from the records, an inconsistent one flagged and unused. Synthetic values only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const PR = '0000e28e-0000-4000-8000-000000000001';
const CTX = { propertyReferenceId: PR, fingerprinter };
const TENANT = '6512f0c2a1b2c3d4e5f6e2e1';
const RENT = '0000e28e-0000-4000-8000-0000000000a1';
const TX = '0000e28e-0000-4000-8000-0000000000b1';
const rec = (auditRecordId: string, action: string, iso: string): HistoryRecord => ({ auditRecordId, action, occurredAt: new Date(iso) });

describe('reconciliations (RECONCILIATION_CONFIRMED, RECONCILIATION_RELEASED)', () => {
  /** A January 2028 rent paid on 2027-12-29, the Tenant due on day 3, with the given reconciliations of its Transaction. */
  const input = (reconciliations: ReconciliationHistory[], override: number | null = null): AttributionInput => ({
    references: [],
    candidates: [],
    reconciliations: {
      candidates: [{ sourceId: RENT, transactionId: TX, bookingDate: day('2027-12-29'), financialCategoryCode: 'RENT_BASE', taxYearOverride: override }],
      reconciliations,
      rentDueDays: [{ mreTenantId: TENANT, rentDueDays: [{ validFrom: day('2026-01-01'), day: 3 }] }],
    },
  });
  const r = (id: string, term: string, confirmedNow: boolean, records: HistoryRecord[]): ReconciliationHistory => ({
    reconciliationId: id,
    transactionId: TX,
    mreTenantId: TENANT,
    mreRentTerm: term,
    confirmedNow,
    records,
  });
  const items = (i: AttributionInput, year: number) => attributionChanges(i, year, TAX_RULES, CTX).changes.map((c) => [c.kind, c.auditRecordId, c.items]);

  it('none to one, matched on 2028-01-05: only 2027 flagged (2027 to 2028), with the reconciliation keys', () => {
    const late = input([r('rec-1', '2028010100', true, [rec('a-1', 'CONFIRMED', '2028-01-05T10:00:00Z')])]);
    expect(items(late, 2027)).toEqual([['RECONCILIATION_CONFIRMED', 'a-1', [{ sourceId: RENT, yearBefore: 2027, yearAfter: 2028 }]]]);
    expect(items(late, 2028)).toEqual([]);
    expect(attributionChanges(late, 2027, TAX_RULES, CTX).changes[0]).toMatchObject({
      entityType: 'RentPaymentReconciliation',
      entityId: 'rec-1',
      keys: { reconciliationId: 'rec-1', transactionId: TX, mreTenantId: TENANT, mreRentTerm: '2028010100' },
    });
  });

  it('the 31-December rule on the record: on 2027-12-31 (Berlin) nothing; 23:30 UTC that day is 1 January in Berlin, flagged; after both years both', () => {
    const atTime = (iso: string) => input([r('rec-1', '2028010100', true, [rec('a-1', 'CONFIRMED', iso)])]);
    expect(items(atTime('2027-12-31T12:00:00Z'), 2027)).toEqual([]);
    expect(items(atTime('2027-12-31T23:30:00Z'), 2027)).toHaveLength(1);
    const both = atTime('2029-01-15T10:00:00Z');
    expect([items(both, 2027).length, items(both, 2028).length]).toEqual([1, 1]);
  });

  it('one to two terms (SEVERAL_TERMS) moves the rent back to its booking year; released and matched again gives two entries; a taxYear override raises nothing', () => {
    const second = input([
      r('rec-1', '2028010100', true, [rec('a-1', 'CONFIRMED', '2027-12-30T10:00:00Z')]),
      r('rec-2', '2028020100', true, [rec('a-2', 'CONFIRMED', '2029-02-01T10:00:00Z')]),
    ]);
    expect(items(second, 2028)).toEqual([['RECONCILIATION_CONFIRMED', 'a-2', [{ sourceId: RENT, yearBefore: 2028, yearAfter: 2027 }]]]);
    const again = input([
      r('rec-1', '2028010100', false, [rec('a-1', 'CONFIRMED', '2027-12-30T10:00:00Z'), rec('a-3', 'RELEASED', '2029-02-01T10:00:00Z')]),
      r('rec-2', '2028010100', true, [rec('a-4', 'CONFIRMED', '2029-02-02T10:00:00Z')]),
    ]);
    // Each judged alone: the release moves it to 2027, the new match back to 2028; both flag 2028 and 2027.
    expect(items(again, 2028).map((x) => [x[0], x[1]])).toEqual([
      ['RECONCILIATION_RELEASED', 'a-3'],
      ['RECONCILIATION_CONFIRMED', 'a-4'],
    ]);
    expect(
      attributionChanges(input([r('rec-1', '2028010100', true, [rec('a-1', 'CONFIRMED', '2029-01-15T10:00:00Z')])], 2027), 2027, TAX_RULES, CTX).changes,
    ).toEqual([]);
  });

  it('the history rebuilt from the records, not the current rows: a release recorded after the year end is found although nothing is CONFIRMED now', () => {
    const released = input([
      r('rec-1', '2028010100', false, [rec('a-1', 'CONFIRMED', '2027-12-30T10:00:00Z'), rec('a-2', 'RELEASED', '2028-02-01T10:00:00Z')]),
    ]);
    expect(items(released, 2027)).toEqual([['RECONCILIATION_RELEASED', 'a-2', [{ sourceId: RENT, yearBefore: 2028, yearAfter: 2027 }]]]);
  });

  it('an inconsistent history (CONFIRMED now without its record): ATTRIBUTION_HISTORY_INCONSISTENT with the entity, its records unused', () => {
    const broken = input([r('rec-1', '2028010100', true, [rec('a-2', 'RELEASED', '2028-02-01T10:00:00Z')])]);
    expect(attributionChanges(broken, 2027, TAX_RULES, CTX)).toEqual({
      changes: [],
      inconsistent: [{ entityType: 'RentPaymentReconciliation', entityId: 'rec-1' }],
    });
  });
});

describe('Loan terms (LOAN_TERMS_ADDED, LOAN_TERMS_VOIDED)', () => {
  const period = (id: string, firstPaymentDate: string, validFrom = '2027-01-01'): SchedulePeriod => ({
    id: id as LoanTermsId,
    validFrom: day(validFrom),
    interestRate: 3000n,
    repaymentModel: 'INTEREST_ONLY',
    scheduledPayment: null,
    firstPaymentDate: day(firstPaymentDate),
    principalAtStart: null,
    fixedRateUntil: null,
  });
  const set = (prs: string[]): LoanAllocationSetView =>
    ({
      id: 'set-1',
      loanId: 'loan-1',
      mreRealmId: 'r',
      status: 'VALID',
      validFrom: day('2027-01-01'),
      validUntil: null,
      basis: 'MANUAL',
      allocations: prs.map((p) => ({ propertyReferenceId: p, share: { numerator: 1n, denominator: BigInt(prs.length) }, acquisitionId: null })),
      notes: null,
      voidedAt: null,
      voidReason: null,
      createdAt: new Date(),
      version: 1,
    }) as unknown as LoanAllocationSetView;
  const loan = (terms: LoanTermsHistory['terms'], sets = [set([PR])]): AttributionInput => ({
    references: [],
    candidates: [],
    loans: [
      {
        loanId: 'loan-1',
        loan: { principalOriginal: Money.of('100000.00', 'EUR'), maturityDate: null, status: 'ACTIVE', closingDate: null },
        terms,
        candidates: [{ sourceId: 'int-1', bookingDate: day('2028-01-03'), financialCategoryCode: 'LOAN_INTEREST', taxYearOverride: null }],
        sets,
      },
    ],
  });
  const items = (i: AttributionInput, year: number) => attributionChanges(i, year, TAX_RULES, CTX).changes.map((c) => [c.kind, c.items]);
  const P1 = period('t-1', '2027-01-31');
  const P2 = period('t-2', '2027-01-20');

  it('voided on 2028-03-01 and a corrected period appended: the void alone moves the debit (2027 to 2028), flagged in 2027 only; the append raises nothing', () => {
    const input = loan([
      { period: P1, validNow: false, records: [rec('c-1', 'CREATED', '2026-12-01T10:00:00Z'), rec('v-1', 'VOIDED', '2028-03-01T10:00:00Z')] },
      { period: P2, validNow: true, records: [rec('c-2', 'CREATED', '2028-03-01T10:05:00Z')] },
    ]);
    expect(items(input, 2027)).toEqual([['LOAN_TERMS_VOIDED', [{ sourceId: 'int-1', yearBefore: 2027, yearAfter: 2028 }]]]);
    expect(items(input, 2028)).toEqual([]);
    expect(attributionChanges(input, 2027, TAX_RULES, CTX).changes[0]).toMatchObject({ keys: { loanId: 'loan-1', termsId: 't-1', validFrom: '2027-01-01' } });
  });

  it('a period added after the year end with another payment day moves the nearest due date across the year; one after the window moves nothing', () => {
    const added = loan([{ period: P1, validNow: true, records: [rec('c-1', 'CREATED', '2029-02-01T10:00:00Z')] }]);
    expect(items(added, 2027)).toEqual([['LOAN_TERMS_ADDED', [{ sourceId: 'int-1', yearBefore: 2028, yearAfter: 2027 }]]]);
    const later = loan([
      { period: P1, validNow: true, records: [rec('c-1', 'CREATED', '2026-12-01T10:00:00Z')] },
      { period: period('t-3', '2028-07-20', '2028-07-01'), validNow: true, records: [rec('c-3', 'CREATED', '2029-02-01T10:00:00Z')] },
    ]);
    expect(items(later, 2027)).toEqual([]);
  });

  it('a split concerning another PropertyReference only is no candidate; an inconsistent period is flagged and unused', () => {
    const elsewhere = loan(
      [{ period: P1, validNow: true, records: [rec('c-1', 'CREATED', '2029-02-01T10:00:00Z')] }],
      [set(['0000e28e-0000-4000-8000-0000000000ff'])],
    );
    expect(items(elsewhere, 2027)).toEqual([]);
    const broken = loan([{ period: P1, validNow: true, records: [] }]);
    expect(attributionChanges(broken, 2027, TAX_RULES, CTX).inconsistent).toEqual([{ entityType: 'LoanTerms', entityId: 't-1' }]);
  });
});

describe('a reference created (RENT_DUE_DAYS_CREATED, decided by the owner on 2026-11-02)', () => {
  const input = (created: { validFrom: BusinessDate; day: number }[], createdAt: string): AttributionInput => {
    const reference: ReferenceHistory = {
      rentalContractReferenceId: 'ref-1',
      mreTenantId: TENANT,
      rentDueDays: created,
      created,
      createdRecord: { auditRecordId: 'cr-1', createdAt: new Date(createdAt) },
      amendments: [],
    };
    return {
      references: [reference],
      candidates: [
        {
          sourceId: RENT,
          bookingDate: day('2027-12-29'),
          financialCategoryCode: 'RENT_BASE',
          mreTenantId: TENANT,
          mreRentTerm: '2028010100',
          taxYearOverride: null,
        },
      ],
    };
  };
  const items = (i: AttributionInput, year: number) => attributionChanges(i, year, TAX_RULES, CTX).changes.map((c) => [c.kind, c.items]);

  it('created on 2029-02-01 with day 1: flags 2027 and 2028 (2027 to 2028); with [] or day 15 nothing; created on 2027-12-30 nothing', () => {
    const one = input([{ validFrom: day('2026-01-01'), day: 1 }], '2029-02-01T10:00:00Z');
    const expected = [['RENT_DUE_DAYS_CREATED', [{ sourceId: RENT, yearBefore: 2027, yearAfter: 2028 }]]];
    expect([items(one, 2027), items(one, 2028)]).toEqual([expected, expected]);
    expect(attributionChanges(one, 2027, TAX_RULES, CTX).changes[0]?.keys).toEqual({
      rentalContractReferenceId: 'ref-1',
      changedEntries: [{ validFrom: '2026-01-01', from: null, to: 1 }],
    });
    expect(items(input([], '2029-02-01T10:00:00Z'), 2027)).toEqual([]);
    expect(items(input([{ validFrom: day('2026-01-01'), day: 15 }], '2029-02-01T10:00:00Z'), 2027)).toEqual([]);
    expect(items(input([{ validFrom: day('2026-01-01'), day: 1 }], '2027-12-30T10:00:00Z'), 2027)).toEqual([]);
  });
});
