import { describe, expect, it } from 'vitest';
import { amount, codes, component, derive, ownerIn, withParameters, yearOf } from './schedule-purchase.test-support.js';
import { declared, example, gutachten, onDay, purchase, purchaseRows, spreadYears } from './schedule-residual.test-support.js';
import { A, B, C, D, W, X, asset, day, eur, ownership } from './schedule.test-support.js';

/**
 * §59G Part 2 per owner (VC-X-41 Part 2; Entscheidung des Projektinhabers, 2026-11-02): the residual value an owner
 * carries into the switch, a sale after it (the sold residual stays), a tenure ended before it (the entry changes
 * nothing), a share reduced before it (still not supported), `U` across a year of @1 and of @2, a residual value with a
 * fraction of a cent in the exact consumption, and `HISTORICAL_RULE_TO_VERIFY` from the switch. Synthetic.
 */

const sumOf = (values: readonly (string | null | undefined)[]) => {
  const cents = values.reduce((s, v) => s + BigInt((v ?? '0').replace('.', '')), 0n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
};
/** A second purchase of `share` by `buyer` from `seller`, transferred on `transfer` (its own component, §59A). */
const resale = (buyer: string, seller: string, transfer: string, contract: string) =>
  purchase({
    id: X,
    purchasePrice: eur('100000.00'),
    acquiredShare: { numerator: 2, denominator: 5 },
    contractDate: day(contract),
    economicTransferDate: day(transfer),
    sellerPartyIds: [seller],
    allocation: {
      id: '0000bbbb-0000-4000-8000-000000000042',
      method: 'PURCHASE_CONTRACT',
      reviewState: 'CONFIRMED',
      totalAllocableAmount: eur('100000.00'),
      buildingAmount: eur('100000.00'),
    },
  });

describe('the owners at the switch (§59G Part 2 "A share reduced or a tenure ended")', () => {
  it('B sells the whole 2/5 to C on 2032-07-01: B’s 2032 is 1,374.55, its residual 75,600.00 stays, nothing after; C’s own component with the same Gutachten is case 3', () => {
    const input = example([gutachten('2027-05-20'), gutachten('2027-05-20', { acquisitionId: X, declaredAfa: [] })], {
      acquisitions: [purchase(), resale(C, B, '2032-07-01', '2032-05-01')],
      ownerships: [ownership(A, '3/5', '2024-04-01', null, W), ownership(B, '2/5', '2024-04-01', '2032-06-30', W), ownership(C, '2/5', '2032-07-01', null, X)],
    });
    const s = derive(input);
    const w = component(s, 0);
    const y2032 = yearOf(w, 2032);
    expect([amount(ownerIn(y2032, B)?.amount), amount(ownerIn(y2032, B)?.residualValue)]).toEqual(['1374.55', '75600.00']);
    expect(ownerIn(yearOf(w, 2031), B)?.residualValue?.amount).toBe('76974.55');
    expect(ownerIn(yearOf(w, 2033), B)).toBeUndefined();
    // A runs on unchanged to 2059-12: the sale of B's share moves none of A's figures.
    expect(purchaseRows(input).map(([y, a]) => [y, a])).toEqual(purchaseRows(example([gutachten('2027-05-20')])).map(([y, a]) => [y, a]));
    // The component's residual value keeps B's sold residual (P8-D8).
    expect(amount(yearOf(w, 2032).residualValue)).toBe(sumOf([ownerIn(y2032, A)?.residualValue?.amount, '75600.00']));
    const x = component(s, 1);
    expect([x.status, codes(x.reasons)]).toEqual(['NOT_COMPUTABLE', ['USEFUL_LIFE_EVIDENCE_BEFORE_PURCHASE']]);
  });

  it('a tenure ended before YE never reaches the switch: B’s band years only, no declared AfA asked of B; A computed', () => {
    const input = example([gutachten('2027-05-20', { declaredAfa: [declared(A, '7920.00')] })], {
      acquisitions: [purchase(), resale(C, B, '2026-07-01', '2026-05-01')],
      ownerships: [ownership(A, '3/5', '2024-04-01', null, W), ownership(B, '2/5', '2024-04-01', '2026-06-30', W), ownership(C, '2/5', '2026-07-01', null, X)],
    });
    const w = component(derive(input), 0);
    expect(w.years.slice(0, 3).map((y) => [y.year, amount(ownerIn(y, B)?.amount)])).toEqual([
      [2024, '1440.00'],
      [2025, '1920.00'],
      [2026, '960.00'],
    ]);
    expect(ownerIn(yearOf(w, 2027), B)).toBeUndefined();
    expect(amount(ownerIn(yearOf(w, 2027), A)?.amount)).toBe('4123.64');
    expect(JSON.stringify(w)).not.toContain('SHORTER_USEFUL_LIFE_RELEASE_MISSING');
    expect(w.end).toEqual({ lastYear: 2059, lastMonth: '2059-12' });
  });

  it('a share reduced between the first year and the switch: that owner still not supported from YE (cause SHARE_REDUCED_BEFORE_SWITCH), the other owner computed', () => {
    const input = example([gutachten('2027-05-20')], {
      acquisitions: [purchase(), resale(D, A, '2026-07-01', '2026-05-01')],
      ownerships: [
        ownership(A, '3/5', '2024-04-01', '2026-06-30', W),
        ownership(A, '1/5', '2026-07-01', null, W),
        ownership(B, '2/5', '2024-04-01', null, W),
        ownership(D, '2/5', '2026-07-01', null, X),
      ],
    });
    const w = component(derive(input), 0);
    expect(ownerIn(yearOf(w, 2027), A)?.reasons).toEqual([
      {
        code: 'SHORTER_USEFUL_LIFE_RESIDUAL_NOT_SUPPORTED',
        details: {
          acquisitionId: W,
          evidenceDate: '2027-06-15',
          valuationDate: '2027-05-20',
          firstYear: 2024,
          fromYear: 2027,
          cause: 'SHARE_REDUCED_BEFORE_SWITCH',
        },
      },
    ]);
    expect(amount(ownerIn(yearOf(w, 2027), B)?.amount)).toBe('2749.09');
    expect(amount(ownerIn(yearOf(w, 2026), A)?.amount)).not.toBeNull();
  });
});

describe('the residual value itself (§59G open question 3)', () => {
  it('U exact across a band year of @1 and of @2 (start 2021-01, YE 2024, 2.5 %): 7.5 % consumed, then 1/20 of the rest a year', () => {
    const entry = onDay('2024-03-01', { usefulLifeYears: 20, declaredAfa: [declared(A, '10800.00', 2023), declared(B, '7200.00', 2023)] });
    const input = example([entry], {
      asset: asset({ buildingCompletionYear: 1920, shorterUsefulLives: [entry] }),
      acquisitions: [purchase({ contractDate: day('2020-11-01'), economicTransferDate: day('2021-01-01') })],
      ownerships: [ownership(A, '3/5', '2021-01-01', null, W), ownership(B, '2/5', '2021-01-01', null, W)],
      from: 2021,
    });
    const c = component(derive(input));
    expect(c.years.slice(0, 4).map((y) => [y.year, y.rule?.version, amount(ownerIn(y, A)?.amount), y.rate])).toEqual([
      [2021, 1, '3600.00', { kind: 'BAND', annualFraction: '1/40' }],
      [2022, 1, '3600.00', { kind: 'BAND', annualFraction: '1/40' }],
      [2023, 2, '3600.00', { kind: 'BAND', annualFraction: '1/40' }],
      [2024, 2, '6660.00', { kind: 'SHORTER_USEFUL_LIFE', annualFraction: '37/800' }],
    ]);
    expect(c.end).toEqual({ lastYear: 2043, lastMonth: '2043-12' });
    expect(sumOf(c.years.map((y) => ownerIn(y, A)?.amount?.amount))).toBe('144000.00');
  });

  it('a residual value with fractions of a cent in the exact consumption: spread from the rounded residual shown (94,500.05), the last year closing the basis', () => {
    const entry = gutachten('2027-05-20', { declaredAfa: [declared(A, '5500.00')] });
    const sole = (entries: readonly ReturnType<typeof gutachten>[]) =>
      example(entries, {
        acquisitions: [
          purchase({
            purchasePrice: eur('100000.05'),
            allocation: {
              id: '0000bbbb-0000-4000-8000-000000000043',
              method: 'PURCHASE_CONTRACT',
              reviewState: 'CONFIRMED',
              totalAllocableAmount: eur('100000.05'),
              buildingAmount: eur('100000.05'),
            },
          }),
        ],
        ownerships: [ownership(A, '1/1', '2024-04-01', null, W)],
      });
    const rows = purchaseRows(sole([entry]));
    // The band years as without an entry: 1,500.00075 → 1,500.00; 3,500.00175 → 3,500.00; 5,500.00275 → 5,500.00 (cumulative),
    // so the residual value shown is 94,500.05, the exact one 94,500.04725: ten of the 33 years differ between the two readings.
    expect(rows.slice(0, 3).map(([y, a]) => [y, a])).toEqual(
      purchaseRows(sole([]))
        .slice(0, 3)
        .map(([y, a]) => [y, a]),
    );
    expect(sumOf(rows.slice(0, 3).map(([, a]) => a))).toBe('5500.00');
    const spread = spreadYears(10_000_005n, 550_000n, 396, 2027);
    expect(rows.slice(3).map(([y, a]) => [y, a])).toEqual([...spread.entries()]);
    expect(sumOf(rows.map(([, a]) => a))).toBe('100000.05');
    // The declared AfA compares with the amount shown (5,500.00), never the exact 5,500.00275.
    expect(
      codes(ownerIn(yearOf(component(derive(sole([gutachten('2027-05-20', { declaredAfa: [declared(A, '5500.01')] })]))), 2027), A)?.reasons ?? []),
    ).toEqual(['DECLARED_AFA_DIFFERS']);
  });

  it('HISTORICAL_RULE_TO_VERIFY: absent with both thresholds confirmed, present from the switch with a test registry setting them open', () => {
    const open = withParameters((p) => ({ ...p, verified: { ...p.verified, shorterUsefulLifeThresholds: false } }));
    const confirmed = component(derive(example([gutachten('2027-05-20')])));
    expect(codes(ownerIn(yearOf(confirmed, 2027), A)?.flags ?? [])).toEqual([]);
    const reopened = component(derive(example([gutachten('2027-05-20')]), open));
    expect(codes(ownerIn(yearOf(reopened, 2026), A)?.flags ?? [])).toEqual([]);
    expect(codes(ownerIn(yearOf(reopened, 2027), A)?.flags ?? [])).toEqual(['HISTORICAL_RULE_TO_VERIFY']);
  });
});
