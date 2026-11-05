import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import type { LoanAllocationSetView, LoanTermsId, SchedulePeriod } from '../financing/index.js';
import { attributionChanges, type AttributionInput } from './attribution-changes.js';
import type { HistoryRecord, LoanTermsHistory } from './attribution-history.js';
import { CHANGE_KINDS } from './attribution-rule.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import { planAcknowledgement } from './tax-statements.js';

/**
 * §58H Part 1 (VC-X-49), pure: a Loan closed as the kind `LOAN_CLOSED` of `ATTRIBUTION_INPUT_CHANGED`, judged alone by
 * §58E's rule (the schedule over the terms as now without and with the closing, the 31-December rule on the record);
 * the example of §58H with its numbers (Loan M due on the 6th, the last debit of 61.20 on 2028-01-03, its interest period
 * 2027-12-07 to 2028-01-06 counting in 2027 before the closing and in 2028 after it); the history (`CLOSED` is final).
 * Entscheidung des Projektinhabers, 2026-11-03, §58H Frage 4: Part 1 with Part 2, one migration. Synthetic values only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const P3 = '0000e49a-0000-4000-8000-000000000003';
const OTHER = '0000e49a-0000-4000-8000-0000000000ff';
const CTX = { propertyReferenceId: P3, fingerprinter };
const M = '0000e49b-0000-4000-8000-000000000001';
const DEBIT = '0000e49c-0000-4000-8000-000000000001';
const rec = (auditRecordId: string, action: string, iso: string): HistoryRecord => ({ auditRecordId, action, occurredAt: new Date(iso) });

/** M's terms: interest only, monthly, the first payment due on 2026-01-06 (so every payment on the 6th). */
const TERMS: SchedulePeriod = {
  id: 'terms-m' as LoanTermsId,
  validFrom: day('2026-01-01'),
  interestRate: 3000n,
  repaymentModel: 'INTEREST_ONLY',
  scheduledPayment: null,
  firstPaymentDate: day('2026-01-06'),
  principalAtStart: null,
  fixedRateUntil: null,
  paymentIntervalMonths: 1,
};
/** `MANUAL` 1/1 to P3 from 2026-01-01 (the example), or to another PropertyReference. */
const set = (pr = P3): LoanAllocationSetView =>
  ({
    id: 'set-m',
    loanId: M,
    mreRealmId: 'r',
    status: 'VALID',
    validFrom: day('2026-01-01'),
    validUntil: null,
    basis: 'MANUAL',
    allocations: [{ propertyReferenceId: pr, share: { numerator: 1n, denominator: 1n }, acquisitionId: null }],
    notes: null,
    voidedAt: null,
    voidReason: null,
    createdAt: new Date('2026-01-01T10:00:00Z'),
    version: 1,
  }) as unknown as LoanAllocationSetView;

interface Options {
  readonly status?: 'ACTIVE' | 'CLOSED';
  readonly closingDate?: string | null;
  readonly closing?: HistoryRecord[] | undefined;
  readonly override?: number | null;
  readonly pr?: string;
}
/** M with its one terms period (recorded in 2025), the debit of 2028-01-03 and, by default, closed REPAID on 2028-01-03 recorded on 2028-02-15. */
function input(o: Options = {}): AttributionInput {
  const status = o.status ?? 'CLOSED';
  const closingDate = o.closingDate === undefined ? (status === 'CLOSED' ? '2028-01-03' : null) : o.closingDate;
  const loan: LoanTermsHistory = {
    loanId: M,
    loan: {
      principalOriginal: Money.of('24480.00', 'EUR'),
      maturityDate: null,
      status,
      closingDate: closingDate === null ? null : day(closingDate),
      closingReason: status === 'CLOSED' ? 'REPAID' : null,
    },
    terms: [{ period: TERMS, validNow: true, records: [rec('t-1', 'CREATED', '2025-12-01T10:00:00Z')] }],
    candidates: [{ sourceId: DEBIT, bookingDate: day('2028-01-03'), financialCategoryCode: 'LOAN_INTEREST', taxYearOverride: o.override ?? null }],
    sets: [set(o.pr)],
    ...('closing' in o ? (o.closing === undefined ? {} : { closing: o.closing }) : { closing: [rec('closed-1', 'CLOSED', '2028-02-15T10:00:00Z')] }),
  };
  return { references: [], candidates: [], loans: [loan] };
}
const run = (i: AttributionInput, year: number) => attributionChanges(i, year, TAX_RULES, CTX);
const items = (i: AttributionInput, year: number) => run(i, year).changes.map((c) => [c.kind, c.auditRecordId, c.items]);

describe('LOAN_CLOSED: the example of §58H (the debit of 61.20 on 2028-01-03, M closed REPAID on 2028-01-03)', () => {
  it('recorded on 2028-02-15: 2027 flagged (2027 to 2028) with the keys loanId, closingDate, closingReason; 2028 not (the record lies in 2028)', () => {
    const closed = input();
    expect(items(closed, 2027)).toEqual([['LOAN_CLOSED', 'closed-1', [{ sourceId: DEBIT, yearBefore: 2027, yearAfter: 2028 }]]]);
    expect(run(closed, 2027).changes[0]).toMatchObject({
      kind: 'LOAN_CLOSED',
      entityType: 'Loan',
      entityId: M,
      amendedAt: new Date('2028-02-15T10:00:00Z'),
      keys: { loanId: M, closingDate: '2028-01-03', closingReason: 'REPAID' },
    });
    expect(items(closed, 2028)).toEqual([]);
    expect(run(closed, 2027).inconsistent).toEqual([]);
  });

  it('recorded on 2029-01-10 instead: both years flagged, the same item', () => {
    const late = input({ closing: [rec('closed-1', 'CLOSED', '2029-01-10T10:00:00Z')] });
    const expected = [['LOAN_CLOSED', 'closed-1', [{ sourceId: DEBIT, yearBefore: 2027, yearAfter: 2028 }]]];
    expect([items(late, 2027), items(late, 2028)]).toEqual([expected, expected]);
  });

  it('the 31-December rule for 2028: on 2028-12-31 (Berlin) nothing, on 2029-01-01 flagged; 23:30 UTC on 31 December is 1 January in Berlin', () => {
    const at = (iso: string) => input({ closing: [rec('closed-1', 'CLOSED', iso)] });
    expect(items(at('2028-12-31T12:00:00Z'), 2028)).toEqual([]);
    expect(items(at('2029-01-01T10:00:00Z'), 2028)).toHaveLength(1);
    expect(items(at('2028-12-31T23:30:00Z'), 2028)).toHaveLength(1);
  });

  it('the closing judged against the schedule: a closing whose omitted entries were nobody s nearest moves nothing (closed on 2028-06-30)', () => {
    expect(items(input({ closingDate: '2028-06-30' }), 2027)).toEqual([]);
    expect(items(input({ closingDate: '2028-06-30' }), 2028)).toEqual([]);
    // Counter-check: closed on 2028-01-05, the entry of 2028-01-06 is omitted: the move again.
    expect(items(input({ closingDate: '2028-01-05' }), 2027)).toHaveLength(1);
  });

  it('a taxYear override on the debit: no year moves (both sides the overridden year), nothing flagged', () => {
    expect(items(input({ override: 2027 }), 2027)).toEqual([]);
    expect(items(input({ override: 2028 }), 2028)).toEqual([]);
  });

  it('a debit concerning another PropertyReference only is no candidate of P3', () => {
    expect(items(input({ pr: OTHER }), 2027)).toEqual([]);
  });
});

describe('LOAN_CLOSED: the history (CLOSED is final, §41.7)', () => {
  it('a CLOSED Loan without its record, a record on an ACTIVE Loan and two CLOSED records: ATTRIBUTION_HISTORY_INCONSISTENT with Loan, the record unused', () => {
    const inconsistent = [{ entityType: 'Loan', entityId: M }];
    for (const broken of [
      input({ closing: [] }),
      input({ status: 'ACTIVE', closingDate: null }),
      input({ closing: [rec('closed-1', 'CLOSED', '2028-02-15T10:00:00Z'), rec('closed-2', 'CLOSED', '2028-02-16T10:00:00Z')] }),
    ]) {
      expect(run(broken, 2027)).toMatchObject({ changes: [], inconsistent });
    }
    // Counter-check: an ACTIVE Loan without a record is consistent and nothing moves.
    expect(run(input({ status: 'ACTIVE', closingDate: null, closing: [] }), 2027)).toEqual({ changes: [], inconsistent: [] });
  });

  it('a reader that gives no closing records judges no closing (and flags nothing)', () => {
    expect(run(input({ closing: undefined }), 2027)).toEqual({ changes: [], inconsistent: [] });
  });

  it('the terms kinds keep reading the closing as now: a terms period voided after the year judged with the closing on both sides', () => {
    const closed = input();
    const loan = (closed.loans ?? [])[0] as LoanTermsHistory;
    const second: SchedulePeriod = { ...TERMS, id: 'terms-n' as LoanTermsId, validFrom: day('2027-07-01'), firstPaymentDate: day('2027-07-20') };
    const voided: AttributionInput = {
      ...closed,
      loans: [
        {
          ...loan,
          terms: [
            loan.terms[0] as LoanTermsHistory['terms'][number],
            { period: second, validNow: false, records: [rec('t-2', 'CREATED', '2027-06-01T10:00:00Z'), rec('t-2v', 'VOIDED', '2028-03-01T10:00:00Z')] },
          ],
        },
      ],
    };
    // Under the second period the nearest entry is 2027-12-20 (out of the window): 2028 with and without it once closed;
    // the void moves nothing, the closing still moves the debit (its own change).
    expect(items(voided, 2027).map((x) => x[0])).toEqual(['LOAN_CLOSED']);
  });
});

describe('LOAN_CLOSED among the kinds and in the order of checks', () => {
  it('the kind is a year kind; its fingerprint is its own; acknowledged by auditRecordId alone (the record is one change) or with its kind', () => {
    expect(CHANGE_KINDS).toContain('LOAN_CLOSED');
    const [change] = run(input(), 2027).changes;
    if (change === undefined) throw new Error('no change');
    const other = run(input({ closing: [rec('closed-2', 'CLOSED', '2028-02-15T10:00:00Z')] }), 2027).changes[0];
    expect(other?.changeFingerprint).not.toBe(change.changeFingerprint);
    expect(run(input(), 2027).changes[0]?.changeFingerprint).toBe(change.changeFingerprint);
    const request = { auditRecordId: 'closed-1', expectedFingerprint: change.changeFingerprint };
    expect(planAcknowledgement([change], request, [])).toEqual({ kind: 'CREATE', change });
    expect(planAcknowledgement([change], { ...request, kind: 'LOAN_CLOSED' }, [])).toEqual({ kind: 'CREATE', change });
    expect(planAcknowledgement([change], { ...request, kind: 'LOAN_TERMS_VOIDED' }, [])).toEqual({ kind: 'NOT_FLAGGED' });
    expect(planAcknowledgement([change], { ...request, expectedFingerprint: 'a'.repeat(64) }, [])).toEqual({
      kind: 'DIFFERS',
      currentFingerprint: change.changeFingerprint,
    });
  });
});
