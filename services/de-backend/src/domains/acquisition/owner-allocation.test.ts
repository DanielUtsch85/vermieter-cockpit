import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import type { Acquisition, AcquisitionId, ConfirmationOwnership } from './acquisition.js';
import type { CostCategory } from './cost.js';
import { fromCents, largestRemainder, planOwnerAllocation, toCents, type OwnerAllocationInput, type OwnerPart } from './owner-allocation.js';

/** VC-2-09 domain rules (api-design.md §27.4, phase-2-plan P2-D10, review F4/F4b). */
const eur = (amount: string) => Money.of(amount, 'EUR');
const day = (value: string) => value as BusinessDate;
const D = day('2026-08-01');
const acquisition = (buyers: string[], overrides: Partial<Acquisition> = {}): Acquisition => ({
  id: 'a1' as AcquisitionId,
  mreRealmId: 'r',
  propertyReferenceId: 'pr',
  status: 'CONFIRMED',
  purchasePrice: eur('300000.00'),
  acquiredShare: { numerator: 1, denominator: 1 },
  contractDate: day('2026-06-15'),
  economicTransferDate: D,
  landRegistryTransferDate: null,
  buyerPartyIds: buyers,
  sellerPartyIds: [],
  sourceReferences: [],
  notes: null,
  cancelledAt: null,
  cancellationReason: null,
  confirmedAt: new Date(),
  createdAt: new Date(),
  version: 2,
  ...overrides,
});
const own = (id: string, owner: string, n: number, d: number, from = '2026-08-01'): ConfirmationOwnership => ({
  id,
  ownerPartyId: owner,
  share: { numerator: n, denominator: d },
  validFrom: day(from),
});
const input = (overrides: Partial<OwnerAllocationInput> = {}): OwnerAllocationInput => ({
  acquisition: acquisition(['p1']),
  own: [own('o1', 'p1', 1, 1)],
  costs: new Map(),
  allocation: null,
  ...overrides,
});
const amounts = (
  plan: ReturnType<typeof planOwnerAllocation>,
  pick: (o: { landAmount: Money | null; buildingAmount: Money | null; totalAllocableAmount: Money | null }) => Money | null,
) => (plan.kind === 'ALLOCATED' ? plan.owners.map((o) => pick(o)?.amount) : []);

describe('largestRemainder', () => {
  it('floor first, the rest to the largest remainders, ties by key', () => {
    const third = { numerator: 1n, denominator: 3n };
    expect(
      largestRemainder(100n, [
        { key: 'b', weight: third },
        { key: 'a', weight: third },
        { key: 'c', weight: third },
      ]),
    ).toEqual(
      new Map([
        ['b', 33n],
        ['a', 34n],
        ['c', 33n],
      ]),
    );
    expect(largestRemainder(0n, [{ key: 'a', weight: { numerator: 1n, denominator: 1n } }])).toEqual(new Map([['a', 0n]]));
    expect(() => largestRemainder(-1n, [])).toThrow(RangeError);
  });

  it('compares remainders as fractions across denominators, not as raw numerators', () => {
    // 1 cent by 1/6, 1/3, 1/2: the raw remainders are all 1, the fractional ones 1/6, 1/3, 1/2; the cent goes to c.
    const weights = [
      { key: 'a', weight: { numerator: 1n, denominator: 6n } },
      { key: 'b', weight: { numerator: 1n, denominator: 3n } },
      { key: 'c', weight: { numerator: 1n, denominator: 2n } },
    ];
    expect(largestRemainder(1n, weights)).toEqual(
      new Map([
        ['a', 0n],
        ['b', 0n],
        ['c', 1n],
      ]),
    );
  });

  it('stays exact above 2^53 cents, where a floating-point variant is off by one (review on #55)', () => {
    // Number(9007199254740995n) is 9007199254740996: any float step would overshoot here.
    expect(largestRemainder(9_007_199_254_740_995n, [{ key: 'a', weight: { numerator: 1n, denominator: 1n } }])).toEqual(
      new Map([['a', 9_007_199_254_740_995n]]),
    );
    const third = { numerator: 1n, denominator: 3n };
    const parts = largestRemainder(99_999_999_999_999_999_999n, [
      { key: 'a', weight: third },
      { key: 'b', weight: third },
      { key: 'c', weight: third },
    ]);
    expect([...parts.values()]).toEqual([33_333_333_333_333_333_333n, 33_333_333_333_333_333_333n, 33_333_333_333_333_333_333n]);
    const odd = largestRemainder(9_007_199_254_740_995n, [
      { key: 'a', weight: third },
      { key: 'b', weight: third },
      { key: 'c', weight: third },
    ]);
    expect([...odd.values()]).toEqual([3_002_399_751_580_332n, 3_002_399_751_580_332n, 3_002_399_751_580_331n]);
    expect([...odd.values()].reduce((x, y) => x + y, 0n)).toBe(9_007_199_254_740_995n);
  });

  it('cents round-trip exactly', () => {
    for (const amount of ['0.00', '0.01', '0.10', '12.34', '999999999999999.99']) expect(fromCents(toCents(eur(amount)), 'EUR').amount).toBe(amount);
  });
});

describe('planOwnerAllocation', () => {
  it('the review counterexample: weights 3/7, 3/7, 1/7, land 0.10, building 0.01 → land 4/4/2, building 1/0/0, total 5/4/2', () => {
    const plan = planOwnerAllocation(
      input({
        acquisition: acquisition(['p1', 'p2', 'p3']),
        own: [own('o1', 'p1', 3, 7), own('o2', 'p2', 3, 7), own('o3', 'p3', 1, 7)],
        allocation: { id: 'l1', landAmount: eur('0.10'), buildingAmount: eur('0.01') },
      }),
    );
    expect(amounts(plan, (o) => o.landAmount)).toEqual(['0.04', '0.04', '0.02']);
    expect(amounts(plan, (o) => o.buildingAmount)).toEqual(['0.01', '0.00', '0.00']);
    expect(amounts(plan, (o) => o.totalAllocableAmount)).toEqual(['0.05', '0.04', '0.02']);
    // Distributing the total 0.11 directly would give 5/5/1: the reason totals are derived (F4b).
    expect([
      ...largestRemainder(
        11n,
        [3n, 3n, 1n].map((n, i) => ({ key: `p${i + 1}`, weight: { numerator: n, denominator: 7n } })),
      ).values(),
    ]).toEqual([5n, 5n, 1n]);
  });

  it('a partial acquisition: the buyer of 1/2 has weight 1/1 and carries everything; costs per category, totals derived', () => {
    const plan = planOwnerAllocation(
      input({
        acquisition: acquisition(['p1'], { acquiredShare: { numerator: 1, denominator: 2 } }),
        own: [own('o1', 'p1', 1, 2)],
        costs: new Map<CostCategory, Money>([
          ['NOTARY', eur('4000.00')],
          ['BROKER', eur('10000.00')],
        ]),
      }),
    );
    expect(plan).toMatchObject({ kind: 'ALLOCATED', basis: 'CONFIRMED', allocationId: null });
    if (plan.kind !== 'ALLOCATED') return;
    const [only] = plan.owners;
    expect(only?.weight).toEqual({ numerator: 1n, denominator: 1n });
    expect(only?.purchasePrice.amount).toBe('300000.00');
    expect([...(only?.costs.keys() ?? [])]).toEqual(['BROKER', 'NOTARY']);
    expect(only?.costsTotal.amount).toBe('14000.00');
    expect(only?.landAmount).toBeNull();
    expect(plan.totals.costsTotal.amount).toBe('14000.00');
  });

  it('status: CANCELLED refused; a DRAFT only with requirements 2–5 met (PROVISIONAL), else the violations', () => {
    expect(planOwnerAllocation(input({ acquisition: acquisition(['p1'], { status: 'CANCELLED' }) }))).toEqual({ kind: 'ACQUISITION_CANCELLED' });
    const draft = acquisition(['p1', 'p2'], { status: 'DRAFT', acquiredShare: { numerator: 1, denominator: 2 } });
    expect(planOwnerAllocation(input({ acquisition: draft, own: [own('o1', 'p1', 1, 4), own('o2', 'p2', 1, 4)] }))).toMatchObject({ basis: 'PROVISIONAL' });
    const stranger = planOwnerAllocation(input({ acquisition: draft, own: [own('o1', 'p1', 1, 4), own('o2', 'x', 1, 4)] }));
    expect(stranger).toMatchObject({
      kind: 'OWNERSHIP_BASIS_INCOMPLETE',
      violations: [{ code: 'OWNER_NOT_A_BUYER' }, { code: 'BUYER_WITHOUT_OWNERSHIP', partyId: 'p2' }],
    });
    const twice = planOwnerAllocation(input({ acquisition: draft, own: [own('o1', 'p1', 1, 8), own('o3', 'p1', 1, 8, '2027-01-01'), own('o2', 'p2', 1, 4)] }));
    expect(twice).toMatchObject({ kind: 'OWNERSHIP_BASIS_INCOMPLETE', violations: [{ code: 'OWNERSHIP_NOT_FROM_TRANSFER_DATE', ownershipId: 'o3' }] });
  });

  it('property: parts ≥ 0, every column exact, per-owner totals equal their parts, each part within a cent of A·w', () => {
    // mulberry32: a deterministic 32-bit generator (integer arithmetic only, so it never collapses to a fixed point).
    let seed = 20261026;
    const random = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const categories: CostCategory[] = ['REAL_ESTATE_TRANSFER_TAX', 'NOTARY', 'LAND_REGISTRY', 'BROKER'];
    for (let round = 0; round < 400; round++) {
      // Random weights summing to 1: integer parts over a random denominator up to 10 000, as reduced shares.
      const owners = 1 + random(20);
      const denominator = Math.max(owners, 1 + random(10_000));
      const cuts = new Set<number>();
      while (cuts.size < owners - 1) cuts.add(1 + random(denominator - 1));
      const points = [0, ...[...cuts].sort((x, y) => x - y), denominator];
      const ownerships = points.slice(1).map((p, i) => {
        const n = p - (points[i] ?? 0);
        const g = (function gcdN(a: number, b: number): number {
          return b === 0 ? a : gcdN(b, a % b);
        })(n, denominator);
        return own(`o${i}`, `p${String(i).padStart(2, '0')}`, n / g, denominator / g);
      });
      // Up to just under 10^19 cents, far above 2^53 (≈ 9·10^15), so a floating-point step would show (review on #55);
      // bounded so that the sums of up to four categories stay within Money's 18 integer digits.
      const cents = () =>
        (BigInt(random(100_000_000)) * 100_000_000_000n + BigInt(random(1_000_000_000)) * 100n + BigInt(random(100))) % 10_000_000_000_000_000_000n;
      const amount = (c: bigint) => fromCents(c, 'EUR');
      const priceCents = cents() + 1n;
      const costs = new Map<CostCategory, Money>(categories.slice(0, random(5)).map((c) => [c, amount(cents())]));
      const [land, building] = [cents(), cents()];
      const plan = planOwnerAllocation({
        acquisition: acquisition(
          ownerships.map((o) => o.ownerPartyId),
          { purchasePrice: amount(priceCents) },
        ),
        own: ownerships,
        costs,
        allocation: { id: 'l', landAmount: amount(land), buildingAmount: amount(building) },
      });
      if (plan.kind !== 'ALLOCATED') throw new Error(plan.kind);
      const parts: readonly OwnerPart[] = plan.owners;
      const column = (pick: (o: OwnerPart) => Money | null) => parts.reduce((s, o) => s + toCents(pick(o) as Money), 0n);
      expect(column((o) => o.purchasePrice)).toBe(priceCents);
      expect(column((o) => o.landAmount)).toBe(land);
      expect(column((o) => o.buildingAmount)).toBe(building);
      for (const [category, total] of costs) expect(column((o) => o.costs.get(category) ?? null)).toBe(toCents(total));
      for (const o of parts) {
        expect(toCents(o.purchasePrice) >= 0n).toBe(true);
        expect(toCents(o.totalAllocableAmount as Money)).toBe(toCents(o.landAmount as Money) + toCents(o.buildingAmount as Money));
        expect(toCents(o.costsTotal)).toBe([...o.costs.values()].reduce((s, c) => s + toCents(c), 0n));
        // |part − A·w| < 1 cent  ⇔  |part·den − A·num| < den.
        const diff = toCents(o.purchasePrice) * o.weight.denominator - priceCents * o.weight.numerator;
        expect(diff < o.weight.denominator && -diff < o.weight.denominator).toBe(true);
      }
    }
  });
});
