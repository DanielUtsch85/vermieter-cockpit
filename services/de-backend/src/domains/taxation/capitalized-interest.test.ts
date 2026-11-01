import { describe, expect, it } from 'vitest';
import { Money, centsOf, type BusinessDate } from '../../shared/index.js';
import { withValidUntil, type LoanAllocationSet, type LoanAllocationSetView } from '../financing/index.js';
import { yearOf } from './cash-timing.js';
import { capitalizedSourcesOf, type CapitalizedSourceInput } from './capitalized-items.js';
import type { TaxMeaning } from './classification.js';
import type { ConstructionPeriodView, InterestFacts } from './construction-period-interest.js';
import { DE_CONSTRUCTION_PERIOD_INTEREST_V1 } from './rules/de-construction-period-interest.js';
import { loanInterestOf, type ViewOwnership } from './tax-year-view.js';

/**
 * §59E (VC-X-36), pure: a capitalised Loan interest source enters P's basis with P's part (never the split's whole
 * amount), exactly once per PropertyReference of the covering set, on its booking date, with the owners' parts of P's
 * part on that date; §59E's example literally, each condition failing the source with its reason, and the property
 * test that a split's sources over all PropertyReferences of its set sum to the split, never more. Synthetic figures.
 */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const [P1, P2] = ['0000aaaa-0000-4000-8000-000000000001', '0000aaaa-0000-4000-8000-000000000002'];
const [A, B, C] = ['a', 'b', 'c'].map((c) => `${c.repeat(8)}-0000-4000-8000-000000000000`) as [string, string, string];
const L = '0000bbbb-0000-4000-8000-000000000001';
const R = '0000cccc-0000-4000-8000-000000000001';
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

/** A counting Loan interest split classified `CAPITALIZED` (no PropertyReference, 0027). */
function interest(
  amount: string,
  bookingDate: string,
  o: { treatment?: 'CAPITALIZED' | 'DEDUCTIBLE'; origin?: 'CLASSIFICATION' | 'DEFAULT' } = {},
): TaxMeaning {
  const sourceId = id();
  const date = day(bookingDate);
  return {
    splitId: sourceId,
    sourceId,
    sourceType: 'TRANSACTION_SPLIT',
    transactionId: id(),
    position: 1,
    bookingDate: date,
    direction: 'OUTFLOW',
    amount: eur(amount),
    financialCategoryCode: 'LOAN_INTEREST',
    categoryType: 'FINANCING',
    propertyReferenceId: null,
    transactionStatus: 'CONFIRMED',
    correctionRole: null,
    counts: true,
    taxCategory: 'LOAN_INTEREST',
    treatment: o.treatment ?? 'CAPITALIZED',
    reviewState: 'USER_CONFIRMED',
    origin: o.origin ?? 'CLASSIFICATION',
    rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
    classificationId: id(),
    taxYear: yearOf(date),
    attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: yearOf(date), proposedYear: yearOf(date), overridden: false },
    refund: null,
    netAmount: null,
    treatmentRule: null,
    distribution: null,
    suggestion: null,
    flags: [],
  };
}

const setOf = (shares: readonly (readonly [string, bigint, bigint])[], validFrom = '2028-01-01'): LoanAllocationSetView =>
  withValidUntil([
    {
      id: '0000eeee-0000-4000-8000-000000000001' as LoanAllocationSet['id'],
      loanId: L,
      mreRealmId: 'realm',
      status: 'VALID',
      validFrom: day(validFrom),
      basis: 'MANUAL',
      allocations: shares.map(([propertyReferenceId, numerator, denominator]) => ({
        propertyReferenceId,
        share: { numerator, denominator },
        acquisitionId: null,
      })),
      notes: null,
      voidedAt: null,
      voidReason: null,
      createdAt: new Date('2028-01-01T00:00:00Z'),
      version: 1,
    },
  ])[0] as LoanAllocationSetView;

const record = (o: Partial<ConstructionPeriodView> = {}): ConstructionPeriodView => ({
  id: R,
  loanId: L,
  propertyReferenceIds: [P1, P2],
  herstellungFrom: day('2028-01-15'),
  herstellungUntil: day('2028-10-31'),
  advanceExpenseDeductible: false,
  buildingFundsShare: { numerator: 1n, denominator: 1n },
  reviewState: 'CONFIRMED',
  status: 'VALID',
  deductibleSplitIds: [],
  capitalizedSplitIds: [],
  ...o,
});

const factsOf = (m: TaxMeaning, r: ConstructionPeriodView | null = record()): InterestFacts => ({
  splitId: m.sourceId,
  loanId: L,
  bookingDate: m.bookingDate,
  amountCents: centsOf(m.amount),
  transactionInterestCents: centsOf(m.amount),
  constructionPeriodInterestId: r?.id ?? null,
  record: r,
  policy: DE_CONSTRUCTION_PERIOD_INTEREST_V1.parameters,
});

const own = (party: string, n: number, d: number, from = '2026-07-01'): ViewOwnership => ({
  id: `own-${party}`,
  partyId: party,
  share: { numerator: n, denominator: d },
  validFrom: day(from),
  validUntil: null,
});
const OWNERS: Record<string, ViewOwnership[]> = { [P1]: [own(A, 3, 5), own(B, 2, 5)], [P2]: [own(C, 1, 1)] };

/** The sources of `pr` as the adapter builds them: §58D's ATTRIBUTED cases only, each with P's part and its facts. */
function sourcesOf(
  pr: string,
  splits: readonly TaxMeaning[],
  set: LoanAllocationSetView,
  r: ConstructionPeriodView | null = record(),
): CapitalizedSourceInput[] {
  const cases = loanInterestOf(
    pr,
    splits.map((m) => ({ item: { ...m, yearAmount: m.amount }, loanId: L })),
    new Map([[L, [set]]]),
  );
  return cases.flatMap((c, i): CapitalizedSourceInput[] =>
    c.kind !== 'ATTRIBUTED'
      ? []
      : [
          {
            meaning: splits[i] as TaxMeaning,
            anschaffungsnaheAcquisitionId: null,
            loan: { loanId: L, set: c.set, propertyCents: c.propertyCents },
            interest: factsOf(splits[i] as TaxMeaning, r),
          },
        ],
  );
}
const amounts = (items: ReturnType<typeof capitalizedSourcesOf>['items']) => items.map((i) => i.lineAmount.amount);
const partsOf = (item: ReturnType<typeof capitalizedSourcesOf>['items'][number] | undefined) =>
  Object.fromEntries((item?.parts ?? []).map((p) => [p.participant, p.amount.amount]));

describe('§59E: the example, literally', () => {
  const S = setOf([
    [P1, 3n, 5n],
    [P2, 2n, 5n],
  ]);
  const splits = [interest('500.00', '2028-03-31'), interest('450.01', '2028-06-30')];

  it('P1 300.00 and 270.01 (A 180.00/162.01, B 120.00/108.00), P2 200.00 and 180.00 (C), the odd cent to P1; over both 950.01 once', () => {
    const p1 = capitalizedSourcesOf(sourcesOf(P1, splits, S), OWNERS[P1] as ViewOwnership[], P1);
    const p2 = capitalizedSourcesOf(sourcesOf(P2, splits, S), OWNERS[P2] as ViewOwnership[], P2);
    expect(amounts(p1.items)).toEqual(['300.00', '270.01']);
    expect(amounts(p2.items)).toEqual(['200.00', '180.00']);
    expect(partsOf(p1.items[0])).toEqual({ [A]: '180.00', [B]: '120.00' });
    expect(partsOf(p1.items[1])).toEqual({ [A]: '162.01', [B]: '108.00' });
    expect(partsOf(p2.items[1])).toEqual({ [C]: '180.00' });
    const total = [...p1.items, ...p2.items].reduce((s, i) => s + centsOf(i.lineAmount), 0n);
    expect(total).toBe(95_001n);
    // The component's facts: the booking date, the Loan with P's share and part, the record.
    expect(p1.items[0]).toMatchObject({
      date: '2028-03-31',
      dateSource: 'BOOKING',
      constructionPeriodInterestId: R,
      loan: { loanId: L, allocationSetId: S.id, share: '3/5', propertyPart: eur('300.00') },
    });
    expect(p1.notSources).toEqual([]);
  });

  it('variants: R UNREVIEWED gives no source (RECORD_NOT_CONFIRMED); R naming P1 only leaves P2 without its items (PROPERTY_NOT_NAMED)', () => {
    const unreviewed = record({ reviewState: 'UNREVIEWED' });
    const none = capitalizedSourcesOf(sourcesOf(P1, splits, S, unreviewed), OWNERS[P1] as ViewOwnership[], P1);
    expect(none.items).toEqual([]);
    expect(none.notSources.map((n) => n.reason)).toEqual(['RECORD_NOT_CONFIRMED', 'RECORD_NOT_CONFIRMED']);
    const onlyP1 = record({ propertyReferenceIds: [P1] });
    expect(amounts(capitalizedSourcesOf(sourcesOf(P1, splits, S, onlyP1), OWNERS[P1] as ViewOwnership[], P1).items)).toEqual(['300.00', '270.01']);
    const p2 = capitalizedSourcesOf(sourcesOf(P2, splits, S, onlyP1), OWNERS[P2] as ViewOwnership[], P2);
    expect([p2.items, p2.notSources.map((n) => n.reason)]).toEqual([[], ['PROPERTY_NOT_NAMED', 'PROPERTY_NOT_NAMED']]);
  });

  it('a third split booked 2029-01-03 has its date on the booking day (its component starts 2029), whatever its tax year', () => {
    const late = { ...interest('100.00', '2029-01-03'), taxYear: 2028 };
    const [item] = capitalizedSourcesOf(sourcesOf(P1, [late], S, record({ herstellungUntil: null })), OWNERS[P1] as ViewOwnership[], P1).items;
    expect([item?.date, item?.taxYear, item?.lineAmount.amount]).toEqual(['2029-01-03', 2028, '60.00']);
  });
});

describe('§59E: the owners of P’s part on the booking date', () => {
  it('an owner change after the booking date (A sells to D on 2028-07-01): the part of a split of 2028-03-31 goes to A and B, never D', () => {
    const D = 'dddddddd-0000-4000-8000-000000000000';
    const owners = [own(A, 3, 5), own(B, 2, 5)].map((o) => (o.partyId === A ? { ...o, validUntil: day('2028-06-30') } : o));
    owners.push(own(D, 3, 5, '2028-07-01'));
    const S = setOf([[P1, 1n, 1n]]);
    const [item] = capitalizedSourcesOf(sourcesOf(P1, [interest('100.00', '2028-03-31')], S), owners, P1).items;
    expect(partsOf(item)).toEqual({ [A]: '60.00', [B]: '40.00' });
  });
});

describe('§59E: exactly once per part of P, never the whole split, never elsewhere', () => {
  const S = setOf([
    [P1, 3n, 5n],
    [P2, 2n, 5n],
  ]);

  it('NOT_ATTRIBUTED (before the set) and ELSEWHERE (not in the set) give no source; a later set leaves the part unchanged', () => {
    const early = interest('500.00', '2027-12-31');
    expect(capitalizedSourcesOf(sourcesOf(P1, [early], S), [], P1).items).toEqual([]);
    const elsewhere = setOf([[P2, 1n, 1n]]);
    expect(capitalizedSourcesOf(sourcesOf(P1, [interest('500.00', '2028-03-31')], elsewhere), [], P1).items).toEqual([]);
    const split = interest('500.00', '2028-03-31');
    const later = withValidUntil([
      { ...S, id: S.id, allocations: S.allocations } as unknown as LoanAllocationSet,
      {
        ...S,
        id: '0000eeee-0000-4000-8000-000000000002',
        validFrom: day('2028-07-01'),
        allocations: [{ propertyReferenceId: P1, share: { numerator: 1n, denominator: 1n }, acquisitionId: null }],
      } as unknown as LoanAllocationSet,
    ]);
    const cases = loanInterestOf(P1, [{ item: { ...split, yearAmount: split.amount }, loanId: L }], new Map([[L, later]]));
    expect(cases[0]).toMatchObject({ kind: 'ATTRIBUTED', propertyCents: 30_000n });
  });

  it('a Loan source read without its facts is never a source (held as without a record)', () => {
    const split = interest('500.00', '2028-03-31');
    const [input] = sourcesOf(P1, [split], S);
    const result = capitalizedSourcesOf([{ ...(input as CapitalizedSourceInput), interest: null }], [], P1);
    expect([result.items, result.notSources]).toEqual([[], [{ sourceId: split.sourceId, loanId: L, reason: 'CONSTRUCTION_PERIOD_INTEREST_MISSING' }]]);
  });

  it('a default (origin DEFAULT) and a DEDUCTIBLE classification are never a source', () => {
    const defaulted = interest('500.00', '2028-03-31', { origin: 'DEFAULT' });
    const deductible = interest('500.00', '2028-03-31', { treatment: 'DEDUCTIBLE' });
    expect(capitalizedSourcesOf(sourcesOf(P1, [defaulted, deductible], S), [], P1)).toEqual({ items: [], notSources: [] });
  });

  it('property test: over random sets (1–50 entries) and amounts, the sources over the set’s PropertyReferences sum to the split when all are named, never more', () => {
    let state = 59_005;
    const next = (n: number) => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state % n;
    };
    for (let run = 0; run < 200; run++) {
      const size = 1 + next(50);
      const prs = Array.from({ length: size }, (_, i) => `0000ffff-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
      // Integer weights summing to the denominator: shares that sum to exactly 1/1.
      const weights = prs.map(() => 1 + next(9));
      const denominator = BigInt(weights.reduce((s, w) => s + w, 0));
      const set = setOf(prs.map((pr, i) => [pr, BigInt(weights[i] as number), denominator] as const));
      const split = interest(`${next(100_000)}.${String(next(100)).padStart(2, '0')}`, '2028-05-05');
      const named = run % 2 === 0 ? prs : prs.filter(() => next(2) === 0);
      const total = prs
        .flatMap((pr) => capitalizedSourcesOf(sourcesOf(pr, [split], set, record({ propertyReferenceIds: named })), [], pr).items)
        .reduce((s, i) => s + centsOf(i.lineAmount), 0n);
      if (named.length === prs.length) expect(total, `run ${run}`).toBe(centsOf(split.amount));
      else expect(total <= centsOf(split.amount), `run ${run}`).toBe(true);
    }
  });
});
