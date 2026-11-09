import { describe, expect, it, vi } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import type { Fraction } from '../ownership/index.js';

import type * as acquisition from '../acquisition/index.js';
import {
  OUTSIDE_LETTING_KEY,
  allocationFingerprint,
  debtOfSet,
  distribute,
  distributeSet,
  paymentsInYear,
  setShares,
  sumsToOne,
  withValidUntil,
  type Loan,
  type LoanAllocationSet,
} from './index.js';

// The weights each `largestRemainder` call receives, to show that a set without a part outside letting hands it exactly
// the entries' weights (§58V "Effect on existing sets", item 2; mutation M6).
const calls = vi.hoisted(() => [] as { key: string; weight: { numerator: bigint; denominator: bigint } }[][]);
vi.mock('../acquisition/index.js', async (original) => {
  const actual = await original<typeof acquisition>();
  return {
    ...actual,
    largestRemainder: (amount: bigint, weights: readonly { key: string; weight: Fraction }[]) => {
      calls.push(weights.map((w) => ({ ...w })));
      return actual.largestRemainder(amount, weights);
    },
  };
});

/**
 * VC-X-43 (api-design.md §58V; Entscheidung des Projektinhabers, 2026-11-07, questions 7 and 8): the part outside
 * letting in `distribute` (one largest remainder over the entries and the part, the part first on a tie), in Financing's
 * per-property reads beside `items`, and the fingerprint appended only when present. The section's synthetic example,
 * the tie, a property test over random sets and the unchanged input for sets without the part.
 */

const f = (n: bigint, d: bigint): Fraction => ({ numerator: n, denominator: d });
const day = (value: string) => value as BusinessDate;
const [P1, P2] = ['0000aaaa-0000-4000-8000-000000000001', '0000aaaa-0000-4000-8000-000000000002'];

const set = (id: string, validFrom: string, entries: readonly [string, Fraction][], outside: Fraction | null): LoanAllocationSet => ({
  id: id as LoanAllocationSet['id'],
  loanId: 'L',
  mreRealmId: 'realm',
  status: 'VALID',
  validFrom: day(validFrom),
  basis: 'MANUAL',
  allocations: entries.map(([propertyReferenceId, share]) => ({ propertyReferenceId, share, acquisitionId: null })),
  outsideLetting: outside === null ? null : { share: outside },
  useEvidence: outside === null ? null : ['Auszahlungsbeleg der Bank vom 2027-01-04 (synthetisch)'],
  notes: null,
  voidedAt: null,
  voidReason: null,
  createdAt: new Date('2027-01-01T00:00:00Z'),
  version: 1,
});
const S1 = set(
  's1',
  '2027-01-01',
  [
    [P1, f(1n, 2n)],
    [P2, f(3n, 10n)],
  ],
  f(1n, 5n),
);
const S2 = set(
  's2',
  '2027-04-16',
  [
    [P1, f(5n, 8n)],
    [P2, f(3n, 8n)],
  ],
  null,
);

/** A seeded generator (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An independent reference: floors, then one cent each by remainder, ties with the part outside letting first. */
function reference(total: bigint, weights: readonly { key: string; weight: Fraction; outside: boolean }[]): Map<string, bigint> {
  const abs = total < 0n ? -total : total;
  const rows = weights.map((w) => ({ ...w, exact: abs * w.weight.numerator }));
  const result = new Map(rows.map((r) => [r.key, r.exact / r.weight.denominator]));
  let rest = abs - [...result.values()].reduce((s, v) => s + v, 0n);
  const sorted = [...rows].sort((x, y) => {
    const left = (x.exact % x.weight.denominator) * y.weight.denominator;
    const right = (y.exact % y.weight.denominator) * x.weight.denominator;
    if (left !== right) return left > right ? -1 : 1;
    if (x.outside !== y.outside) return x.outside ? -1 : 1;
    return x.key < y.key ? -1 : x.key > y.key ? 1 : 0;
  });
  for (const r of sorted) {
    if (rest === 0n) break;
    result.set(r.key, (result.get(r.key) ?? 0n) + 1n);
    rest -= 1n;
  }
  if (total < 0n) for (const [k, v] of result) result.set(k, -v);
  return result;
}

describe('§58V rule 5: distribute over the entries and the part outside letting', () => {
  it('the example: 450.01 by 1/2, 3/10 and 1/5 gives P1 225.01, P2 135.00, outside letting 90.00', () => {
    expect(distributeSet(45_001n, S1.allocations, f(1n, 5n))).toEqual({ parts: [22_501n, 13_500n], outsideLetting: 9_000n });
  });

  it('the tie: 1.01 by 1/2 and outside letting 1/2 gives the cent to the part outside letting (P1 0.50, outside 0.51)', () => {
    expect(distributeSet(101n, [{ propertyReferenceId: P1, share: f(1n, 2n) }], f(1n, 2n))).toEqual({ parts: [50n], outsideLetting: 51n });
    // The key sorts before every lowercase uuid, also one of zeros.
    expect(OUTSIDE_LETTING_KEY < '00000000-0000-0000-0000-000000000000').toBe(true);
    expect(distributeSet(101n, [{ propertyReferenceId: '00000000-0000-4000-8000-000000000000', share: f(1n, 2n) }], f(1n, 2n)).outsideLetting).toBe(51n);
  });

  it('a negative total: by its absolute value, the sign restored on each part, the part outside letting included', () => {
    expect(distributeSet(-45_001n, S1.allocations, f(1n, 5n))).toEqual({ parts: [-22_501n, -13_500n], outsideLetting: -9_000n });
    expect(distributeSet(0n, S1.allocations, f(1n, 5n))).toEqual({ parts: [0n, 0n], outsideLetting: 0n });
  });

  it('property: 2000 random sets (1–50 entries, d ≤ 10000, a part outside letting in about half) and signed amounts sum exactly; each part as the reference', () => {
    const next = rng(4307);
    let withPart = 0;
    for (let c = 0; c < 2000; c++) {
      const n = 1 + Math.floor(next() * 50);
      const outside = next() < 0.5;
      const k = n + (outside ? 1 : 0);
      const d = BigInt(k + Math.floor(next() * (10_000 - k)));
      // k positive integers summing to d.
      const cuts = new Set<bigint>();
      while (cuts.size < k - 1) cuts.add(1n + BigInt(Math.floor(next() * Number(d - 1n))));
      const bounds = [0n, ...[...cuts].sort((x, y) => (x < y ? -1 : 1)), d];
      const nums = bounds.slice(1).map((b, i) => b - (bounds[i] as bigint));
      const reduce = (num: bigint) => {
        let [a, b] = [num, d];
        while (b !== 0n) [a, b] = [b, a % b];
        return f(num / a, d / a);
      };
      const entries = nums
        .slice(0, n)
        .map((num, i) => ({ propertyReferenceId: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`, share: reduce(num) }));
      const part = outside ? reduce(nums[n] as bigint) : null;
      if (part !== null) withPart++;
      expect(sumsToOne([...entries.map((e) => e.share), ...(part === null ? [] : [part])])).toBe(true);
      const total = BigInt(Math.floor((next() - 0.3) * 2e9));
      const got = distributeSet(total, entries, part);
      const sum = got.parts.reduce((s, p) => s + p, 0n) + (got.outsideLetting ?? 0n);
      expect(sum, `case ${c}`).toBe(total);
      const ref = reference(total, [
        ...entries.map((e) => ({ key: e.propertyReferenceId, weight: e.share, outside: false })),
        ...(part === null ? [] : [{ key: 'outside', weight: part, outside: true }]),
      ]);
      expect(got.parts, `case ${c}`).toEqual(entries.map((e) => ref.get(e.propertyReferenceId)));
      expect(got.outsideLetting, `case ${c}`).toBe(part === null ? null : ref.get('outside'));
    }
    expect(withPart).toBeGreaterThan(800);
  });

  it('without a part: largestRemainder receives exactly the entries weights (no key of weight 0), as distribute did before 0077', () => {
    calls.length = 0;
    expect(distributeSet(45_001n, S2.allocations, null)).toEqual({ parts: distribute(45_001n, S2.allocations), outsideLetting: null });
    expect(calls).toEqual([
      [
        { key: P1, weight: f(5n, 8n) },
        { key: P2, weight: f(3n, 8n) },
      ],
      [
        { key: P1, weight: f(5n, 8n) },
        { key: P2, weight: f(3n, 8n) },
      ],
    ]);
    calls.length = 0;
    distributeSet(45_001n, S1.allocations, f(1n, 5n));
    expect(calls[0]?.map((w) => w.key)).toEqual([P1, P2, OUTSIDE_LETTING_KEY]);
  });

  it('setShares and sumsToOne: the part counts; entries alone at 1/1 plus a part are not usable, nor entries below one without it', () => {
    expect(setShares(S1)).toEqual([f(1n, 2n), f(3n, 10n), f(1n, 5n)]);
    expect(sumsToOne(setShares(S1))).toBe(true);
    expect(sumsToOne(S1.allocations.map((a) => a.share))).toBe(false);
    expect(
      sumsToOne(setShares({ allocations: [{ propertyReferenceId: P1, share: f(1n, 1n), acquisitionId: null }], outsideLetting: { share: f(1n, 5n) } })),
    ).toBe(false);
    expect(setShares({ allocations: S2.allocations })).toEqual([f(5n, 8n), f(3n, 8n)]);
  });
});

describe('§58V rule 7: Financing per property, the part outside letting beside the items', () => {
  const view = withValidUntil([S1, S2]);

  it('remaining debt 199,000.00 by S1: P1 99,500.00, P2 59,700.00, outsideLetting 39,800.00; the identity holds; difference derived', () => {
    const s1 = view[0] as (typeof view)[number];
    const out = debtOfSet({ actual: 19_900_000n, planned: null }, s1);
    expect(out.items.map((i) => [i.propertyReferenceId, i.actual, i.planned, i.difference])).toEqual([
      [P1, 9_950_000n, null, null],
      [P2, 5_970_000n, null, null],
    ]);
    expect(out.outsideLetting).toEqual({ share: f(1n, 5n), actual: 3_980_000n, planned: null, difference: null });
    const planned = debtOfSet({ actual: 10_001n, planned: 10_000n }, s1);
    const sum = (k: 'actual' | 'planned' | 'difference') =>
      planned.items.reduce((s, i) => s + (i[k] as bigint), 0n) + ((planned.outsideLetting?.[k] as bigint | null) ?? 0n);
    expect([sum('actual'), sum('planned'), sum('difference')]).toEqual([10_001n, 10_000n, 1n]);
    expect(planned.outsideLetting?.difference).toBe((planned.outsideLetting?.actual as bigint) - (planned.outsideLetting?.planned as bigint));
    expect(debtOfSet({ actual: 19_900_000n, planned: null }, view[1] as (typeof view)[number]).outsideLetting).toBeNull();
  });

  it('a repayment plan behind the actual debt: outsideLetting.difference is its actual minus its planned; the differences sum to the total', () => {
    const s1 = view[0] as (typeof view)[number];
    // Actual 199,000.00 against a planned 195,000.00 (synthetic): the part outside letting 39,800.00 against 39,000.00.
    const debt = { actual: 19_900_000n, planned: 19_500_000n };
    const out = debtOfSet(debt, s1);
    const outside = out.outsideLetting as NonNullable<typeof out.outsideLetting>;
    expect([outside.actual, outside.planned, outside.difference]).toEqual([3_980_000n, 3_900_000n, 80_000n]);
    expect(outside.difference).toBe(outside.actual - (outside.planned as bigint));
    expect(out.items.map((i) => [i.actual, i.planned, i.difference])).toEqual([
      [9_950_000n, 9_750_000n, 200_000n],
      [5_970_000n, 5_850_000n, 120_000n],
    ]);
    const differences = out.items.reduce((s, i) => s + (i.difference as bigint), 0n) + (outside.difference as bigint);
    expect(differences).toBe(debt.actual - debt.planned);
    // With an odd cent: actual 100.01 against planned 99.98 (the parts round apart); the identity still holds.
    const odd = debtOfSet({ actual: 10_001n, planned: 9_998n }, s1);
    const oddOutside = odd.outsideLetting as NonNullable<typeof odd.outsideLetting>;
    expect(oddOutside.difference).toBe(oddOutside.actual - (oddOutside.planned as bigint));
    expect(odd.items.reduce((s, i) => s + (i.difference as bigint), 0n) + (oddOutside.difference as bigint)).toBe(3n);
  });

  it('payments of 2027: March by S1 (P1 225.01, P2 135.00, outside 90.00), April booked 2027-04-30 by S2 (outside 0); items stay properties', () => {
    const loan = {
      id: 'L',
      status: 'ACTIVE',
      principalOriginal: Money.of('200000.00', 'EUR'),
      startDate: day('2027-01-01'),
      disbursementDate: null,
    } as unknown as Loan;
    const splits = [
      { transactionId: 't1', bookingDate: day('2027-03-31'), category: 'LOAN_INTEREST' as const, amount: 45_001n },
      { transactionId: 't1', bookingDate: day('2027-03-31'), category: 'LOAN_PRINCIPAL' as const, amount: 100_000n },
      { transactionId: 't2', bookingDate: day('2027-04-30'), category: 'LOAN_INTEREST' as const, amount: 60_000n },
    ];
    const out = paymentsInYear({ loan, periods: [], sets: view, splits, statements: [] }, 2027, true);
    expect(out).toEqual({
      kind: 'PER_PROPERTY',
      payments: { year: 2027, interest: 105_001n, principal: 100_000n, payments: 2 },
      items: [
        { propertyReferenceId: P1, interest: 22_501n + 37_500n, principal: 50_000n },
        { propertyReferenceId: P2, interest: 13_500n + 22_500n, principal: 30_000n },
      ],
      outsideLetting: { interest: 9_000n, principal: 20_000n },
    });
    // Only S2 in 2028: no split had a part, so outsideLetting is null.
    const later = paymentsInYear(
      { loan, periods: [], sets: view, splits: [{ ...splits[2], bookingDate: day('2028-01-31') } as never], statements: [] },
      2028,
      true,
    );
    expect(later.kind === 'PER_PROPERTY' ? later.outsideLetting : 'x').toBeNull();
  });
});

describe('§58V rule 10: the idempotency fingerprint', () => {
  const body = {
    validFrom: day('2027-01-01'),
    basis: 'MANUAL' as const,
    allocations: [
      { propertyReferenceId: P1, share: f(1n, 2n), acquisitionId: null },
      { propertyReferenceId: P2, share: f(1n, 2n), acquisitionId: null },
    ],
    notes: null,
  };

  it('an old body keeps its fixed vector (nothing appended, also with null fields); the new fields are appended when present', () => {
    const old = `["L","2027-01-01","MANUAL",[["${P1}","1/2",null],["${P2}","1/2",null]],null]`;
    expect(allocationFingerprint('L', body)).toBe(old);
    expect(allocationFingerprint('L', { ...body, outsideLetting: null, useEvidence: null })).toBe(old);
    expect(allocationFingerprint('L', { ...body, outsideLetting: f(1n, 5n), useEvidence: ['Beleg (synthetisch)'] })).toBe(
      `${old.slice(0, -1)},["outsideLetting","1/5"],["useEvidence",["Beleg (synthetisch)"]]]`,
    );
    expect(allocationFingerprint('L', { ...body, useEvidence: ['Beleg (synthetisch)'] })).not.toBe(old);
  });
});
