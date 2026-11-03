import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import type { DepositPartHistory, DepositReconciliationHistory } from './attribution-deposits.js';
import type { HistoryRecord } from './attribution-history.js';
import { deriveDepositTaxMeaning, type DepositTaxMeaning } from './deposit-closing.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import type { TaxClassification } from './tax-classification.js';
import { NO_DEPRECIATION } from './tax-year-depreciation.js';
import { TAX_YEAR_ITEM_LIMIT, buildTaxYearView, type TaxYearItem, type TaxYearRead, type TaxYearView } from './tax-year-view.js';

/**
 * §58J (VC-X-51) in the view, pure: a deposit closing without a PropertyReference whose classification names an earlier
 * closing (`counts: false`, `NOT_COUNTED` with `CLOSING_CHANGED`) is listed in `notAttributed` in the views §58C lists it
 * in without a classification, its `NOT_COUNTED` open, `UNATTRIBUTED_ITEMS` counting it, never summed; the cap counts it,
 * `NOT_AN_OWNER_IN_YEAR` does not read it, §58H's item flag lands on it. Entscheidung des Projektinhabers, 2026-11-03,
 * §58J Fragen 1–4. The example of §58J with its numbers. Synthetic values only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2029-10-30');
const [P1, P2, P3] = [1, 2, 3].map((n) => `0000e51a-0000-4000-8000-00000000000${n}`) as [string, string, string];
const [A, B, C] = ['a', 'b', 'c'].map((c) => `${c.repeat(8)}-0000-4000-8000-0000000000e5`) as [string, string, string];
const OWNER_OF: Record<string, string> = { [P1]: A, [P2]: B, [P3]: C };
const D = '0000e51b-0000-4000-8000-000000000001';
const E = '0000e51b-0000-4000-8000-000000000002';
const T = '6512f0c2a1b2c3d4e5f6e51a';
const OLD_CLASSIFICATION = '0000e51c-0000-4000-8000-000000000001';
const NEW_CLASSIFICATION = '0000e51c-0000-4000-8000-000000000002';
let seq = 0;
const fillerId = () => `0000e51f-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** A confirmed classification (`RETAINED_DEPOSIT_DAMAGES` / `INCOME`) of the closing on `closingDate` with `retained`. */
const classification = (id: string, closingDate: string, retained: string) =>
  ({
    id,
    taxCategory: 'RETAINED_DEPOSIT_DAMAGES',
    treatment: 'INCOME',
    reviewState: 'USER_CONFIRMED',
    rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
    depositClosing: { closingDate: day(closingDate), retainedAmount: eur(retained) },
  }) as unknown as TaxClassification;
/** The classification of the first closing (2027-12-20, 300.00), stale since D was closed anew. */
const STALE = classification(OLD_CLASSIFICATION, '2027-12-20', '300.00');
/** Classified anew: the closing of 2028-01-10 with 250.00. */
const FRESH = classification(NEW_CLASSIFICATION, '2028-01-10', '250.00');

/** D closed anew on 2028-01-10 with 250.00 retained, its Tenant's rent on `candidates`, with the classification given. */
const depositD = (candidates: readonly string[], c: TaxClassification | null = STALE, securityDepositId = D): DepositTaxMeaning =>
  deriveDepositTaxMeaning(
    {
      securityDepositId,
      status: 'CLOSED',
      closingDate: day('2028-01-10'),
      retainedAmount: eur('250.00'),
      propertyReferenceId: candidates.length === 1 ? (candidates[0] as string) : null,
      propertyCandidates: candidates,
    },
    c,
    TAX_RULES,
    today,
  );
/** E: another Tenant's deposit attributed to P1, 120.00 retained on 2028-03-31, classified: the figure D must not move. */
const depositE = deriveDepositTaxMeaning(
  {
    securityDepositId: E,
    status: 'CLOSED',
    closingDate: day('2028-03-31'),
    retainedAmount: eur('120.00'),
    propertyReferenceId: P1,
    propertyCandidates: [P1],
  },
  classification('0000e51c-0000-4000-8000-000000000003', '2028-03-31', '120.00'),
  TAX_RULES,
  today,
);

function readOf(pr: string, o: { unattributed?: DepositTaxMeaning[]; sources?: TaxYearRead['sources']; deposits?: DepositPartHistory[] } = {}): TaxYearRead {
  return {
    propertyReferenceId: pr,
    ownerPartyFound: null,
    sources: o.sources ?? (pr === P1 ? [{ item: { ...depositE, yearAmount: depositE.amount }, listed: true }] : []),
    unattributedDeposits: o.unattributed ?? [],
    ownerships: [{ id: `own-${pr}`, partyId: OWNER_OF[pr] as string, share: { numerator: 1, denominator: 1 }, validFrom: day('2026-01-01'), validUntil: null }],
    checks: [],
    attribution: { references: [], candidates: [] },
    allocatedLoanInterest: [],
    loanAllocationSets: new Map(),
    depreciation: NO_DEPRECIATION(2028),
    parts: { loans: [], deposits: o.deposits ?? [] },
  };
}
const outcomeOf = (r: TaxYearRead, ownerPartyId: string | null = null) =>
  buildTaxYearView(r, { year: 2028, ownerPartyId, today, registry: TAX_RULES, fingerprinter });
const viewOf = (r: TaxYearRead, ownerPartyId: string | null = null): TaxYearView => {
  const outcome = outcomeOf(r, ownerPartyId);
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
};
const listed = (v: TaxYearView) => v.notAttributed.items.map((i) => i.sourceId);
const flagOf = (i: TaxYearItem | undefined, code: string) => i?.flags.find((f) => f.code === code)?.details;
const yearFlag = (v: TaxYearView, code: string) => v.flags.find((f) => f.code === code)?.details;
const openOf = (v: TaxYearView) => v.review.open.map((o) => [o.code, o.count]);
/** Every figure of a view: the sections with their lines, the AfA, the result, the capitalised, the owners and NOT_OWNED. */
const money = (v: TaxYearView) => ({
  einnahmen: v.einnahmen,
  werbungskosten: v.werbungskosten,
  depreciation: v.depreciation,
  result: v.result,
  capitalized: v.capitalized,
  unclassified: v.unclassified,
  notInView: v.notInView,
  owners: v.owners,
  notOwned: v.notOwned,
});

describe('§58J: an unattributed deposit closed anew since its classification', () => {
  it('the meaning: counts false with NOT_COUNTED CLOSING_CHANGED, the stale classification kept (the input of every case here)', () => {
    const d = depositD([P1, P2]);
    expect([d.counts, d.taxYear, d.amount, d.classificationId, d.reviewState, d.taxCategory]).toEqual([
      false,
      2028,
      eur('250.00'),
      OLD_CLASSIFICATION,
      'USER_CONFIRMED',
      'RETAINED_DEPOSIT_DAMAGES',
    ]);
    expect(d.flags.map((f) => f.code)).toEqual(['NOT_COUNTED', 'NO_PROPERTY_REFERENCE']);
  });

  it('the example, 2028 at the property level: listed in P1 and P2 with NOT_COUNTED open and UNATTRIBUTED_ITEMS 1, not final; not in P3', () => {
    const d = depositD([P1, P2]);
    for (const pr of [P1, P2]) {
      const v = viewOf(readOf(pr, { unattributed: [d] }));
      expect(listed(v), pr).toEqual([D]);
      const item = v.notAttributed.items[0];
      expect([
        item?.amount,
        item?.lineAmount,
        item?.share,
        item?.taxCategory,
        item?.treatment,
        item?.reviewState,
        item?.origin,
        item?.classificationId,
      ]).toEqual([eur('250.00'), null, null, 'RETAINED_DEPOSIT_DAMAGES', 'INCOME', 'USER_CONFIRMED', 'CLASSIFICATION', OLD_CLASSIFICATION]);
      expect(item?.notAttributed).toEqual({ reason: 'SEVERAL_PROPERTY_REFERENCES', candidates: [P1, P2], href: `/api/v1/security-deposits/${D}/tax-meaning` });
      expect(item?.flags).toEqual([
        { code: 'NOT_COUNTED', details: { depositStatus: 'CLOSED', retainedAmount: eur('250.00'), reason: 'CLOSING_CHANGED' } },
        { code: 'NO_PROPERTY_REFERENCE', details: { reason: 'SEVERAL_PROPERTY_REFERENCES', candidates: [P1, P2] } },
      ]);
      expect(yearFlag(v, 'UNATTRIBUTED_ITEMS'), pr).toEqual({ count: 1 });
      expect(openOf(v).sort(), pr).toEqual([
        ['NOT_COUNTED', 1],
        ['UNATTRIBUTED_ITEMS', 1],
      ]);
      expect(v.review.final, pr).toBe(false);
    }
    const p3 = viewOf(readOf(P3, { unattributed: [d] }));
    expect([listed(p3), yearFlag(p3, 'UNATTRIBUTED_ITEMS'), openOf(p3), p3.review.final]).toEqual([[], undefined, [], true]);
  });

  it('the example at the owner level: in A s view of P1 and B s of P2 with share null, the owner figures unchanged; not in C s of P3', () => {
    const d = depositD([P1, P2]);
    for (const [pr, owner] of [
      [P1, A],
      [P2, B],
    ] as const) {
      const v = viewOf(readOf(pr, { unattributed: [d] }), owner);
      expect([listed(v), v.notAttributed.items[0]?.share, v.notAttributed.items[0]?.lineAmount, yearFlag(v, 'UNATTRIBUTED_ITEMS'), v.review.final]).toEqual([
        [D],
        null,
        null,
        { count: 1 },
        false,
      ]);
      expect(money(v)).toEqual(money(viewOf(readOf(pr), owner)));
    }
    expect(listed(viewOf(readOf(P3, { unattributed: [d] }), C))).toEqual([]);
  });

  it('unchanged money sums: every line, section, result, owner and notOwned equal to the view without D; D in no line', () => {
    const d = depositD([P1, P2]);
    const v = viewOf(readOf(P1, { unattributed: [d] }));
    const without = viewOf(readOf(P1));
    expect(money(v)).toEqual(money(without));
    expect([v.einnahmen.total.amount, v.einnahmen.lines.find((l) => l.taxCategory === 'RETAINED_DEPOSIT_DAMAGES')?.total.amount]).toEqual(['120.00', '120.00']);
    expect(v.einnahmen.lines.flatMap((l) => l.items.map((i) => i.sourceId))).toEqual([E]);
    expect([v.result, v.owners?.map((o) => o.result)]).toEqual([without.result, without.owners?.map((o) => o.result)]);
    expect(v.unclassified.items.map((i) => i.sourceId)).toEqual([]);
  });

  it('variant NO_RECONCILED_RENT: listed in every view of the Realm (P1, P2 and P3), as with no classification at all', () => {
    const d = depositD([]);
    const unclassified = depositD([], null);
    expect(unclassified.counts).toBe(true);
    for (const pr of [P1, P2, P3]) {
      const v = viewOf(readOf(pr, { unattributed: [d] }));
      expect([listed(v), v.notAttributed.items[0]?.notAttributed?.reason, yearFlag(v, 'UNATTRIBUTED_ITEMS'), v.review.final], pr).toEqual([
        [D],
        'NO_RECONCILED_RENT',
        { count: 1 },
        false,
      ]);
      expect(flagOf(v.notAttributed.items[0], 'NOT_COUNTED'), pr).toMatchObject({ reason: 'CLOSING_CHANGED' });
      expect(listed(viewOf(readOf(pr, { unattributed: [unclassified] }))), pr).toEqual([D]);
    }
  });

  it('classified anew: NOT_COUNTED gone, UNATTRIBUTED_ITEMS stays, still listed in P1 and P2 only, figures unchanged', () => {
    const anew = depositD([P1, P2], FRESH);
    expect(anew.counts).toBe(true);
    for (const pr of [P1, P2]) {
      const v = viewOf(readOf(pr, { unattributed: [anew] }));
      expect([
        listed(v),
        flagOf(v.notAttributed.items[0], 'NOT_COUNTED'),
        v.notAttributed.items[0]?.classificationId,
        yearFlag(v, 'UNATTRIBUTED_ITEMS'),
      ]).toEqual([[D], undefined, NEW_CLASSIFICATION, { count: 1 }]);
      expect([openOf(v), v.review.final]).toEqual([[['UNATTRIBUTED_ITEMS', 1]], false]);
      expect(money(v)).toEqual(money(viewOf(readOf(pr))));
    }
    expect(listed(viewOf(readOf(P3, { unattributed: [anew] })))).toEqual([]);
  });

  it('UNATTRIBUTED_ITEMS counts the stale and the fitting deposit alike (Frage 2)', () => {
    const other = depositD([], null, '0000e51b-0000-4000-8000-000000000003');
    const v = viewOf(readOf(P1, { unattributed: [depositD([P1, P2]), other] }));
    expect([listed(v), yearFlag(v, 'UNATTRIBUTED_ITEMS')]).toEqual([[D, other.sourceId], { count: 2 }]);
  });

  it('the cap counts D: at the limit with D TAX_YEAR_TOO_LARGE, without D a view', () => {
    const fillers = Array.from({ length: TAX_YEAR_ITEM_LIMIT }, () => depositD([], null, fillerId()));
    const read = (extra: DepositTaxMeaning[]) => readOf(P3, { unattributed: [...fillers, ...extra] });
    expect(outcomeOf(read([])).kind).toBe('VIEW');
    expect(outcomeOf(read([depositD([P1, P3])]))).toEqual({ kind: 'TAX_YEAR_TOO_LARGE', itemCount: TAX_YEAR_ITEM_LIMIT + 1, limit: TAX_YEAR_ITEM_LIMIT });
  });

  it('NOT_AN_OWNER_IN_YEAR is unchanged with D: C is no owner of P1, with or without D', () => {
    expect(outcomeOf(readOf(P1, { unattributed: [depositD([P1, P2])] }), C)).toEqual({ kind: 'NOT_AN_OWNER_IN_YEAR' });
    expect(outcomeOf(readOf(P1), C)).toEqual({ kind: 'NOT_AN_OWNER_IN_YEAR' });
  });

  it('a §58H part change of D after the year s end: the year flag and now its item flag on D s notAttributed entry', () => {
    const rec = (auditRecordId: string, action: string, iso: string): HistoryRecord => ({ auditRecordId, action, occurredAt: new Date(iso) });
    const reconciliation = (id: string, pr: string, records: HistoryRecord[]): DepositReconciliationHistory => ({
      reconciliationId: id,
      transactionId: `tx-${id}`,
      mreRentTerm: '2027030100',
      confirmedNow: true,
      records,
      propertyReferenceIds: [pr],
    });
    // T's rent on P1 reconciled in 2027; the booking error on P2 matched on 2029-02-10: D moves ATTRIBUTED to NOT_ATTRIBUTED for P1's 2028.
    const deposits: DepositPartHistory[] = [
      {
        securityDepositId: D,
        mreTenantId: T,
        closingDate: day('2028-01-10'),
        retainedAmount: eur('250.00'),
        reconciliations: [
          reconciliation('rec-1', P1, [rec('a-1', 'CONFIRMED', '2027-03-05T10:00:00Z')]),
          reconciliation('rec-2', P2, [rec('a-2', 'CONFIRMED', '2029-02-10T10:00:00Z')]),
        ],
      },
    ];
    const v = viewOf(readOf(P1, { unattributed: [depositD([P1, P2])], deposits }));
    const entries = yearFlag(v, 'PROPERTY_PART_CHANGED') as { kind: string; auditRecordId: string }[];
    expect(entries.map((e) => [e.kind, e.auditRecordId])).toEqual([['DEPOSIT_RECONCILIATION_CONFIRMED', 'a-2']]);
    expect(listed(v)).toEqual([D]);
    expect(flagOf(v.notAttributed.items[0], 'PROPERTY_PART_CHANGED')).toEqual([
      expect.objectContaining({
        kind: 'DEPOSIT_RECONCILIATION_CONFIRMED',
        stateBefore: 'ATTRIBUTED',
        partBefore: { amount: '250.00', currency: 'EUR' },
        stateAfter: 'NOT_ATTRIBUTED',
        partAfter: null,
      }),
    ]);
    expect(money(v)).toEqual(money(viewOf(readOf(P1, { deposits }))));
  });

  it('counter-check: an attributed deposit with CLOSING_CHANGED stays in unclassified, not in notAttributed, never summed', () => {
    const attributed = depositD([P1]);
    expect([attributed.counts, attributed.propertyReferenceId]).toEqual([false, P1]);
    const v = viewOf(readOf(P1, { sources: [{ item: { ...attributed, yearAmount: attributed.amount }, listed: true }] }));
    expect([listed(v), v.unclassified.items.map((i) => i.sourceId), v.einnahmen.total.amount, yearFlag(v, 'UNATTRIBUTED_ITEMS')]).toEqual([
      [],
      [D],
      '0.00',
      undefined,
    ]);
    expect([openOf(v), v.review.final]).toEqual([[['NOT_COUNTED', 1]], false]);
  });
});
