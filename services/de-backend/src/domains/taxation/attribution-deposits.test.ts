import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import { attributionChanges, type AttributionInput } from './attribution-changes.js';
import { depositPartOn, type DepositPartHistory, type DepositReconciliationHistory } from './attribution-deposits.js';
import type { HistoryRecord } from './attribution-history.js';
import { PART_CHANGE_KINDS, partChanges, type PartChange } from './attribution-parts.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import { planAcknowledgement } from './tax-statements.js';

/**
 * §58H Part 2 (VC-X-49), pure: the deposit's PropertyReference moving with a reconciliation of its Tenant as the kinds
 * `DEPOSIT_RECONCILIATION_CONFIRMED`, `DEPOSIT_RECONCILIATION_RELEASED` of `PROPERTY_PART_CHANGED` (Entscheidung des
 * Projektinhabers, 2026-11-03, §58H Frage 2), judged by §58G's rule (P's part before and after the record, the record
 * after 31 December; `NOT_ATTRIBUTED` ↔ `NONE` no change, §58G Frage 3); the example of §58H with its numbers (D closed
 * on 2027-06-30 with 300.00 retained, the 80.00 on P2 matched on 2028-02-10 and released on 2028-02-20); one record as
 * two changes (`CHANGE_AMBIGUOUS`, §58G Frage 4). Synthetic values only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const [P1, P2, P3] = [1, 2, 3].map((n) => `0000e49d-0000-4000-8000-00000000000${n}`) as [string, string, string];
const T = '6512f0c2a1b2c3d4e5f6e491';
const D = '0000e49e-0000-4000-8000-000000000001';
const rec = (auditRecordId: string, action: string, iso: string): HistoryRecord => ({ auditRecordId, action, occurredAt: new Date(iso) });
const ctx = (propertyReferenceId: string) => ({ propertyReferenceId, fingerprinter });

const reconciliation = (id: string, prs: string[], confirmedNow: boolean, records: HistoryRecord[], term = '2027030100'): DepositReconciliationHistory => ({
  reconciliationId: id,
  transactionId: `tx-${id}`,
  mreRentTerm: term,
  confirmedNow,
  records,
  propertyReferenceIds: prs,
});
/** T's rent on P1, reconciled during 2027. */
const ON_P1 = reconciliation('rec-1', [P1], true, [rec('a-1', 'CONFIRMED', '2027-03-05T10:00:00Z')]);
/** The 80.00 on P2 (booked 2027-05-03) matched on 2028-02-10, and with `released` released on 2028-02-20. */
const onP2 = (released: boolean) =>
  reconciliation(
    'rec-2',
    [P2],
    !released,
    [rec('a-2', 'CONFIRMED', '2028-02-10T10:00:00Z'), ...(released ? [rec('a-3', 'RELEASED', '2028-02-20T10:00:00Z')] : [])],
    '2027050100',
  );
const deposit = (reconciliations: DepositReconciliationHistory[], o: Partial<DepositPartHistory> = {}): DepositPartHistory => ({
  securityDepositId: D,
  mreTenantId: T,
  closingDate: day('2027-06-30'),
  retainedAmount: eur('300.00'),
  reconciliations,
  ...o,
});
const run = (pr: string, year: number, deposits: DepositPartHistory[]) => partChanges({ loans: [], deposits }, year, ctx(pr));
/** Each change as [kind, auditRecordId, items as [sourceType, sourceId, stateBefore, partBefore, stateAfter, partAfter]]. */
const summary = (changes: readonly PartChange[]) =>
  changes.map((c) => [
    c.kind,
    c.auditRecordId,
    c.items.map((i) => [i.sourceType, i.sourceId, i.stateBefore, i.partBefore?.amount ?? null, i.stateAfter, i.partAfter?.amount ?? null]),
  ]);

describe('the example of §58H: D moved to SEVERAL_PROPERTY_REFERENCES and back', () => {
  it('matched on 2028-02-10: P1 2027 flagged ATTRIBUTED 300.00 to NOT_ATTRIBUTED; P2 2027 not (NONE to NOT_ATTRIBUTED); 2028 not', () => {
    const moved = [deposit([ON_P1, onP2(false)])];
    expect(summary(run(P1, 2027, moved).changes)).toEqual([
      ['DEPOSIT_RECONCILIATION_CONFIRMED', 'a-2', [['DEPOSIT_CLOSING', D, 'ATTRIBUTED', '300.00', 'NOT_ATTRIBUTED', null]]],
    ]);
    expect(run(P1, 2027, moved).changes[0]).toMatchObject({
      entityType: 'RentPaymentReconciliation',
      entityId: 'rec-2',
      amendedAt: new Date('2028-02-10T10:00:00Z'),
      keys: { reconciliationId: 'rec-2', transactionId: 'tx-rec-2', mreTenantId: T, mreRentTerm: '2027050100', securityDepositIds: [D] },
      items: [{ taxYear: 2027 }],
    });
    expect(run(P2, 2027, moved).changes).toEqual([]);
    // The deposit's tax year is its closing date's: nothing in 2028.
    expect(run(P1, 2028, moved).changes).toEqual([]);
  });

  it('released on 2028-02-20: P1 gains a second entry NOT_ATTRIBUTED to ATTRIBUTED 300.00, the first unchanged; P2 still nothing', () => {
    const back = [deposit([ON_P1, onP2(true)])];
    expect(summary(run(P1, 2027, back).changes)).toEqual([
      ['DEPOSIT_RECONCILIATION_CONFIRMED', 'a-2', [['DEPOSIT_CLOSING', D, 'ATTRIBUTED', '300.00', 'NOT_ATTRIBUTED', null]]],
      ['DEPOSIT_RECONCILIATION_RELEASED', 'a-3', [['DEPOSIT_CLOSING', D, 'NOT_ATTRIBUTED', null, 'ATTRIBUTED', '300.00']]],
    ]);
    // Each judged alone: the first change's fingerprint is the same after the release.
    expect(run(P1, 2027, back).changes[0]?.changeFingerprint).toBe(run(P1, 2027, [deposit([ON_P1, onP2(false)])]).changes[0]?.changeFingerprint);
    expect(run(P2, 2027, back).changes).toEqual([]);
  });

  it('the reconciliations are read at any date: the match of 2027 (during the year) is no change, the later ones are', () => {
    // Counter-check of the 31-December rule: the same records before 2027-12-31 (Berlin) flag nothing.
    const early = [
      deposit([
        ON_P1,
        reconciliation('rec-2', [P2], false, [rec('a-2', 'CONFIRMED', '2027-08-10T10:00:00Z'), rec('a-3', 'RELEASED', '2027-12-31T12:00:00Z')], '2027050100'),
      ]),
    ];
    expect(run(P1, 2027, early).changes).toEqual([]);
    const midnight = [deposit([ON_P1, reconciliation('rec-2', [P2], true, [rec('a-2', 'CONFIRMED', '2027-12-31T23:30:00Z')], '2027050100')])];
    expect(summary(run(P1, 2027, midnight).changes).map((x) => x[1])).toEqual(['a-2']);
  });
});

describe('the state steps of a deposit (§58G Frage 3) and its candidates', () => {
  it('NO_RECONCILED_RENT to P1 (the first match after the year): only P1 flagged, none of the Realm s other views', () => {
    const first = [deposit([reconciliation('rec-1', [P1], true, [rec('a-1', 'CONFIRMED', '2028-02-10T10:00:00Z')])])];
    expect(summary(run(P1, 2027, first).changes)).toEqual([
      ['DEPOSIT_RECONCILIATION_CONFIRMED', 'a-1', [['DEPOSIT_CLOSING', D, 'NOT_ATTRIBUTED', null, 'ATTRIBUTED', '300.00']]],
    ]);
    for (const pr of [P2, P3]) expect(run(pr, 2027, first).changes).toEqual([]);
  });

  it('P1 to P2 directly (P1 released, then P2 matched): P1 ATTRIBUTED to NOT_ATTRIBUTED and P2 NOT_ATTRIBUTED to ATTRIBUTED', () => {
    const swapped = [
      deposit([
        reconciliation('rec-1', [P1], false, [rec('a-1', 'CONFIRMED', '2027-03-05T10:00:00Z'), rec('a-2', 'RELEASED', '2028-02-10T10:00:00Z')]),
        reconciliation('rec-2', [P2], true, [rec('a-3', 'CONFIRMED', '2028-02-11T10:00:00Z')]),
      ]),
    ];
    // The release leaves D without a reconciled rent (every view lists it): P2 NONE to NOT_ATTRIBUTED is no change.
    expect(summary(run(P1, 2027, swapped).changes)).toEqual([
      ['DEPOSIT_RECONCILIATION_RELEASED', 'a-2', [['DEPOSIT_CLOSING', D, 'ATTRIBUTED', '300.00', 'NOT_ATTRIBUTED', null]]],
    ]);
    expect(summary(run(P2, 2027, swapped).changes)).toEqual([
      ['DEPOSIT_RECONCILIATION_CONFIRMED', 'a-3', [['DEPOSIT_CLOSING', D, 'NOT_ATTRIBUTED', null, 'ATTRIBUTED', '300.00']]],
    ]);
    // P3 (another view of the Realm): NONE to NOT_ATTRIBUTED and back, never a change.
    expect(run(P3, 2027, swapped).changes).toEqual([]);
  });

  it('depositPartOn: one PropertyReference P, another one, none, several with P, several without P', () => {
    const r = (prs: string[]) => [reconciliation('x', prs, true, [])];
    expect(depositPartOn(P1, r([P1]), eur('300.00'))).toEqual({ state: 'ATTRIBUTED', part: eur('300.00') });
    expect(depositPartOn(P1, r([P2]), eur('300.00'))).toEqual({ state: 'NONE', part: null });
    expect(depositPartOn(P1, [], eur('300.00'))).toEqual({ state: 'NOT_ATTRIBUTED', part: null });
    expect(depositPartOn(P1, r([P1, P2]), eur('300.00'))).toEqual({ state: 'NOT_ATTRIBUTED', part: null });
    expect(depositPartOn(P3, r([P1, P2]), eur('300.00'))).toEqual({ state: 'NONE', part: null });
    // Two reconciliations on P1 are one PropertyReference.
    expect(depositPartOn(P1, [...r([P1]), reconciliation('y', [P1], true, [])], eur('300.00')).state).toBe('ATTRIBUTED');
  });

  it('a deposit closed in another year is no candidate of 2027; one with nothing retained is none at all', () => {
    const moved = (o: Partial<DepositPartHistory>) => [deposit([ON_P1, onP2(false)], o)];
    expect(run(P1, 2027, moved({ closingDate: day('2026-06-30') })).changes).toEqual([]);
    // Closed in 2026, both records lie after its end: the first match (to P1) and the second (to several) both move it.
    expect(summary(run(P1, 2026, moved({ closingDate: day('2026-06-30') })).changes).map((x) => x[1])).toEqual(['a-1', 'a-2']);
    expect(run(P1, 2027, moved({ retainedAmount: eur('0.00') })).changes).toEqual([]);
  });

  it('two deposits of the Tenant closed in the year: one change per record naming both', () => {
    const second = '0000e49e-0000-4000-8000-000000000002';
    const both = [deposit([ON_P1, onP2(false)]), deposit([ON_P1, onP2(false)], { securityDepositId: second, retainedAmount: eur('120.00') })];
    const [change] = run(P1, 2027, both).changes;
    expect(summary(run(P1, 2027, both).changes)).toEqual([
      [
        'DEPOSIT_RECONCILIATION_CONFIRMED',
        'a-2',
        [
          ['DEPOSIT_CLOSING', D, 'ATTRIBUTED', '300.00', 'NOT_ATTRIBUTED', null],
          ['DEPOSIT_CLOSING', second, 'ATTRIBUTED', '120.00', 'NOT_ATTRIBUTED', null],
        ],
      ],
    ]);
    expect(change?.keys).toMatchObject({ securityDepositIds: [D, second] });
  });

  it('an inconsistent reconciliation (CONFIRMED now without its record): ATTRIBUTION_HISTORY_INCONSISTENT where the deposit concerns P, its records unused', () => {
    const broken = [deposit([ON_P1, reconciliation('rec-2', [P2], true, [rec('a-3', 'RELEASED', '2028-02-20T10:00:00Z')])])];
    expect(run(P1, 2027, broken)).toEqual({ changes: [], inconsistent: [{ entityType: 'RentPaymentReconciliation', entityId: 'rec-2' }] });
    expect(run(P2, 2027, broken).inconsistent).toEqual([{ entityType: 'RentPaymentReconciliation', entityId: 'rec-2' }]);
    // P3: neither among the candidates nor listing D (it has two): not named.
    expect(run(P3, 2027, broken).inconsistent).toEqual([]);
  });
});

describe('one record as two changes (§58G Frage 4: CHANGE_AMBIGUOUS arises here)', () => {
  /** T's January 2028 rent paid on P1 on 2027-12-30, due day 1, matched on 2028-02-10: its first reconciliation. */
  const record = rec('a-9', 'CONFIRMED', '2028-02-10T10:00:00Z');
  const RENT = '0000e49f-0000-4000-8000-000000000001';
  const attribution: AttributionInput = {
    references: [],
    candidates: [],
    reconciliations: {
      candidates: [{ sourceId: RENT, transactionId: 'tx-rec-9', bookingDate: day('2027-12-30'), financialCategoryCode: 'RENT_BASE', taxYearOverride: null }],
      reconciliations: [
        { reconciliationId: 'rec-9', transactionId: 'tx-rec-9', mreTenantId: T, mreRentTerm: '2028010100', confirmedNow: true, records: [record] },
      ],
      rentDueDays: [{ mreTenantId: T, rentDueDays: [{ validFrom: day('2026-01-01'), day: 1 }] }],
    },
  };
  const deposits = [deposit([reconciliation('rec-9', [P1], true, [record], '2028010100')])];

  it('RECONCILIATION_CONFIRMED (the rent 2027 to 2028) and DEPOSIT_RECONCILIATION_CONFIRMED (D to P1) in P1 2027, two fingerprints', () => {
    const year = attributionChanges(attribution, 2027, TAX_RULES, ctx(P1)).changes;
    const part = run(P1, 2027, deposits).changes;
    expect(year.map((c) => [c.kind, c.auditRecordId, c.items])).toEqual([
      ['RECONCILIATION_CONFIRMED', 'a-9', [{ sourceId: RENT, yearBefore: 2027, yearAfter: 2028 }]],
    ]);
    expect(summary(part)).toEqual([['DEPOSIT_RECONCILIATION_CONFIRMED', 'a-9', [['DEPOSIT_CLOSING', D, 'NOT_ATTRIBUTED', null, 'ATTRIBUTED', '300.00']]]]);
    const changes = [...year, ...part];
    expect(new Set(changes.map((c) => c.changeFingerprint)).size).toBe(2);
    const [y, p] = changes as [PartChange, PartChange];
    expect(planAcknowledgement(changes, { auditRecordId: 'a-9', expectedFingerprint: p.changeFingerprint }, [])).toEqual({
      kind: 'AMBIGUOUS',
      kinds: ['DEPOSIT_RECONCILIATION_CONFIRMED', 'RECONCILIATION_CONFIRMED'],
    });
    expect(
      planAcknowledgement(changes, { auditRecordId: 'a-9', kind: 'DEPOSIT_RECONCILIATION_CONFIRMED', expectedFingerprint: p.changeFingerprint }, []),
    ).toEqual({ kind: 'CREATE', change: p });
    expect(planAcknowledgement(changes, { auditRecordId: 'a-9', kind: 'RECONCILIATION_CONFIRMED', expectedFingerprint: y.changeFingerprint }, [])).toEqual({
      kind: 'CREATE',
      change: y,
    });
    // The fingerprint of the other kind under a kind: 412, never the other change.
    expect(planAcknowledgement(changes, { auditRecordId: 'a-9', kind: 'RECONCILIATION_CONFIRMED', expectedFingerprint: p.changeFingerprint }, [])).toEqual({
      kind: 'DIFFERS',
      currentFingerprint: y.changeFingerprint,
    });
  });

  it('the deposit kinds are part kinds; no kind of a WEG economic plan exists (§58H Frage 1)', () => {
    expect(PART_CHANGE_KINDS).toEqual([
      'LOAN_ALLOCATION_SET_ADDED',
      'LOAN_ALLOCATION_SET_VOIDED',
      'DEPOSIT_RECONCILIATION_CONFIRMED',
      'DEPOSIT_RECONCILIATION_RELEASED',
      // §58I Part 2 (VC-X-50): the split corrections.
      'TRANSACTION_CORRECTED',
      'TRANSACTION_REVERSED',
    ]);
    expect(PART_CHANGE_KINDS.some((k) => k.startsWith('WEG_'))).toBe(false);
  });
});
