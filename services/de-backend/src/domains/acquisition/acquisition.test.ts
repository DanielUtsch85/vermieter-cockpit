import { describe, expect, it } from 'vitest';
import { Money, type BusinessDate } from '../../shared/index.js';
import {
  buyerIncreases,
  createFingerprint,
  planCancel,
  planConfirm,
  structureViolations,
  sumOf,
  transferDate,
  type Acquisition,
  type AcquisitionId,
  type ConfirmationInput,
  type ConfirmationOwnership,
  type NewAcquisition,
} from './acquisition.js';

/** VC-2-05 domain rules (api-design.md §27.1, phase-2-plan P2-D6). */
const day = (value: string) => value as BusinessDate;
const data: NewAcquisition = {
  mreRealmId: 'r',
  propertyReferenceId: 'pr',
  purchasePrice: Money.of('350000.00', 'EUR'),
  acquiredShare: { numerator: 1, denominator: 1 },
  contractDate: day('2026-06-15'),
  economicTransferDate: null,
  landRegistryTransferDate: null,
  buyerPartyIds: ['b'],
  sellerPartyIds: [],
  sourceReferences: [],
  notes: null,
};
const acquisition: Acquisition = {
  ...data,
  id: 'a1' as AcquisitionId,
  status: 'DRAFT',
  cancelledAt: null,
  cancellationReason: null,
  confirmedAt: null,
  createdAt: new Date('2026-10-25T08:00:00Z'),
  version: 1,
};

describe('Acquisition', () => {
  it('the transfer date is the economic transfer, or the contract while that is unset (P2-D6)', () => {
    expect(transferDate(data)).toBe('2026-06-15');
    expect(transferDate({ ...data, economicTransferDate: day('2026-08-01') })).toBe('2026-08-01');
  });

  it('cancel: a draft without VALID Ownerships; a repeat is UNCHANGED; confirmed is final; carried by Ownerships is refused', () => {
    const at = new Date('2026-10-25T10:00:00Z');
    expect(planCancel(acquisition, 'geplatzt', at, [])).toEqual({
      kind: 'CANCEL',
      next: { ...acquisition, status: 'CANCELLED', cancelledAt: at, cancellationReason: 'geplatzt', version: 2 },
    });
    expect(planCancel({ ...acquisition, status: 'CANCELLED' }, 'anders', at, ['o1'])).toEqual({ kind: 'UNCHANGED' });
    expect(planCancel({ ...acquisition, status: 'CONFIRMED' }, 'x', at, [])).toEqual({ kind: 'ACQUISITION_CONFIRMED' });
    expect(planCancel(acquisition, 'x', at, ['o2', 'o1'])).toEqual({ kind: 'ACQUISITION_HAS_VALID_OWNERSHIPS', ownershipIds: ['o1', 'o2'] });
  });

  it('the fingerprint is the normalized payload, the party order included', () => {
    expect(createFingerprint(data)).toBe(createFingerprint({ ...data }));
    expect(createFingerprint(data)).not.toBe(createFingerprint({ ...data, purchasePrice: Money.of('350000.01', 'EUR') }));
    expect(createFingerprint({ ...data, buyerPartyIds: ['a', 'b'] })).not.toBe(createFingerprint({ ...data, buyerPartyIds: ['b', 'a'] }));
  });
});

describe('planConfirm (§28.1)', () => {
  const at = new Date('2026-10-26T10:00:00Z');
  const draft: Acquisition = {
    ...acquisition,
    economicTransferDate: day('2026-08-01'),
    buyerPartyIds: ['b2', 'b1'],
    acquiredShare: { numerator: 1, denominator: 2 },
  };
  const own = (id: string, owner: string, n: number, d: number, from = '2026-08-01'): ConfirmationOwnership => ({
    id,
    ownerPartyId: owner,
    share: { numerator: n, denominator: d },
    validFrom: day(from),
    validUntil: null,
  });
  const active = new Map([
    ['b1', 'ACTIVE'],
    ['b2', 'ACTIVE'],
  ]);

  it('confirms when the buyers hold exactly the acquired share from the transfer date and the day is complete', () => {
    const mine = [own('o1', 'b1', 1, 4), own('o2', 'b2', 1, 4)];
    expect(
      planConfirm(draft, { buyerStatuses: active, own: mine, onTransferDate: [...mine, own('o3', 'k', 1, 2, '2020-01-01')], beforeTransferDate: [] }, at),
    ).toEqual({
      kind: 'CONFIRM',
      next: { ...draft, status: 'CONFIRMED', confirmedAt: at, version: 2 },
    });
  });

  it('status first: CONFIRMED is a no-op, CANCELLED is refused, whatever the requirements', () => {
    const none = { buyerStatuses: new Map(), own: [], onTransferDate: [], beforeTransferDate: [] };
    expect(planConfirm({ ...draft, status: 'CONFIRMED' }, none, at)).toEqual({ kind: 'UNCHANGED' });
    expect(planConfirm({ ...draft, status: 'CANCELLED' }, none, at)).toEqual({ kind: 'ACQUISITION_CANCELLED' });
  });

  it('reports all requirements in their order, ids sorted within each (5 as §28.1A: 5a, then 5b with byBuyer)', () => {
    const plan = planConfirm(
      draft,
      {
        buyerStatuses: new Map([
          ['b1', 'INACTIVE'],
          ['b2', 'INACTIVE'],
        ]),
        own: [own('o2', 'x', 1, 8), own('o1', 'b1', 1, 4, '2026-08-02')],
        onTransferDate: [own('o2', 'x', 1, 8)],
        beforeTransferDate: [],
      },
      at,
    );
    // b1's only Ownership starts after the transfer date, so it holds nothing on it: its increase is 0 (5a), and the
    // increases sum to 0 (5b). Before VC-X-30 step 5 summed the full shares of o1 and o2 (3/8), a non-buyer's included.
    const zero = { numerator: 0n, denominator: 1n };
    expect(plan).toEqual({
      kind: 'CONFIRMATION_BLOCKED',
      violations: [
        { code: 'BUYER_INACTIVE', partyId: 'b1' },
        { code: 'BUYER_INACTIVE', partyId: 'b2' },
        { code: 'OWNERSHIP_NOT_FROM_TRANSFER_DATE', ownershipId: 'o1', validFrom: '2026-08-02', transferDate: '2026-08-01' },
        { code: 'OWNER_NOT_A_BUYER', ownershipId: 'o2', ownerPartyId: 'x' },
        { code: 'BUYER_WITHOUT_OWNERSHIP', partyId: 'b2' },
        { code: 'BUYER_SHARE_NOT_INCREASED', partyId: 'b1', shareBefore: zero, share: zero },
        {
          code: 'SHARE_SUM_MISMATCH',
          expected: { numerator: 1n, denominator: 2n },
          actual: zero,
          byBuyer: [{ partyId: 'b1', shareBefore: zero, share: zero, acquired: zero }],
        },
        { code: 'OWNERSHIP_INCOMPLETE', date: '2026-08-01', shareSum: { numerator: 1n, denominator: 8n } },
      ],
    });
  });

  it('sums exactly and reduced, beyond what a double holds', () => {
    expect(
      sumOf([
        { numerator: 1, denominator: 3 },
        { numerator: 1, denominator: 6 },
      ]),
    ).toEqual({ numerator: 1n, denominator: 2n });
    expect(sumOf([])).toEqual({ numerator: 0n, denominator: 1n });
    const sevenths = Array.from({ length: 7 }, () => ({ numerator: 1, denominator: 7 }));
    expect(sumOf(sevenths)).toEqual({ numerator: 1n, denominator: 1n });
  });
});

describe('VC-X-30: the acquired share is the increase over the day before (§28.1A)', () => {
  const at = new Date('2026-10-31T10:00:00Z');
  const D = '2026-08-01';
  const f = (numerator: bigint, denominator: bigint) => ({ numerator, denominator });
  const zero = f(0n, 1n);
  /** A `VALID` Ownership `[from, until]`. */
  const row = (id: string, owner: string, n: number, d: number, from: string, until: string | null = null): ConfirmationOwnership => ({
    id,
    ownerPartyId: owner,
    share: { numerator: n, denominator: d },
    validFrom: day(from),
    validUntil: until === null ? null : day(until),
  });
  const draft = (buyers: string[], n: number, d: number, transfer = D): Acquisition => ({
    ...acquisition,
    economicTransferDate: day(transfer),
    buyerPartyIds: buyers,
    sellerPartyIds: [],
    acquiredShare: { numerator: n, denominator: d },
  });
  /** Every buyer active; `rows` all rows of the PropertyReference, `on`/`before` as the repository reads them. */
  const input = (x: Acquisition, rows: readonly ConfirmationOwnership[], ownIds: readonly string[]): ConfirmationInput => {
    const d = transferDate(x);
    const dayBefore = day(new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
    const covers = (o: ConfirmationOwnership, t: string) => o.validFrom <= t && (o.validUntil === null || o.validUntil >= t);
    return {
      buyerStatuses: new Map(x.buyerPartyIds.map((b) => [b, 'ACTIVE'])),
      own: rows.filter((o) => ownIds.includes(o.id)),
      onTransferDate: rows.filter((o) => covers(o, d)),
      beforeTransferDate: rows.filter((o) => covers(o, dayBefore)),
    };
  };
  const confirmed = (x: Acquisition) => ({ kind: 'CONFIRM', next: { ...x, status: 'CONFIRMED', confirmedAt: at, version: 2 } });

  it('A held nothing and buys B’s 1/2: the full share, as before VC-X-30', () => {
    const x = draft(['A'], 1, 2);
    const rows = [row('b', 'B', 1, 2, '2020-01-01', '2026-07-31'), row('c', 'C', 1, 2, '2020-01-01'), row('x', 'A', 1, 2, D)];
    expect(planConfirm(x, input(x, rows, ['x']), at)).toEqual(confirmed(x));
    expect(
      buyerIncreases(x, [rows[2] as ConfirmationOwnership], [rows[1], rows[2]] as ConfirmationOwnership[], [rows[0], rows[1]] as ConfirmationOwnership[]),
    ).toEqual([{ partyId: 'A', shareBefore: zero, share: f(1n, 2n), acquired: f(1n, 2n) }]);
  });

  it('A 1/2 (W) buys B’s 1/2 (the row model): 1/1 − 1/2 = 1/2 confirms X of 1/2; X of 1/1 is refused with byBuyer', () => {
    const rows = [row('o1', 'A', 1, 2, '2024-03-01', '2026-07-31'), row('o2', 'B', 1, 2, '2024-03-01', '2026-07-31'), row('o3', 'A', 1, 1, D)];
    const x = draft(['A'], 1, 2);
    expect(planConfirm(x, input(x, rows, ['o3']), at)).toEqual(confirmed(x));
    // Counter-check: the full share of o3 is never compared with acquiredShare.
    const wrong = draft(['A'], 1, 1);
    expect(planConfirm(wrong, input(wrong, rows, ['o3']), at)).toEqual({
      kind: 'CONFIRMATION_BLOCKED',
      violations: [
        {
          code: 'SHARE_SUM_MISMATCH',
          expected: f(1n, 1n),
          actual: f(1n, 2n),
          byBuyer: [{ partyId: 'A', shareBefore: f(1n, 2n), share: f(1n, 1n), acquired: f(1n, 2n) }],
        },
      ],
    });
  });

  it('a partial increase (A 1/4 → 3/4, B 3/4 → 1/4 without X) and several sellers (A 1/3 → 1/1, X of 2/3) confirm', () => {
    const partial = draft(['A'], 1, 2);
    const partialRows = [
      row('a', 'A', 1, 4, '2020-01-01', '2026-07-31'),
      row('b', 'B', 3, 4, '2020-01-01', '2026-07-31'),
      row('b2', 'B', 1, 4, D),
      row('x', 'A', 3, 4, D),
    ];
    expect(planConfirm(partial, input(partial, partialRows, ['x']), at)).toEqual(confirmed(partial));
    const several = draft(['A'], 2, 3);
    const severalRows = [
      row('a', 'A', 1, 3, '2020-01-01', '2026-07-31'),
      row('b', 'B', 1, 3, '2020-01-01', '2026-07-31'),
      row('c', 'C', 1, 3, '2020-01-01', '2026-07-31'),
      row('x', 'A', 1, 1, D),
    ];
    expect(planConfirm(several, input(several, severalRows, ['x']), at)).toEqual(confirmed(several));
  });

  it('two buyers, one already an owner: A 1/2 → 3/4 and new C — → 1/4 make up 1/2', () => {
    const x = draft(['C', 'A'], 1, 2);
    const rows = [
      row('a', 'A', 1, 2, '2020-01-01', '2026-07-31'),
      row('b', 'B', 1, 2, '2020-01-01', '2026-07-31'),
      row('xa', 'A', 3, 4, D),
      row('xc', 'C', 1, 4, D),
    ];
    expect(planConfirm(x, input(x, rows, ['xa', 'xc']), at)).toEqual(confirmed(x));
  });

  it('5a: a buyer whose share stays (A 1/2 → 1/2) is refused alone; 5b holds (0 + 1/2)', () => {
    const x = draft(['A', 'C'], 1, 2);
    const rows = [
      row('a', 'A', 1, 2, '2020-01-01', '2026-07-31'),
      row('b', 'B', 1, 2, '2020-01-01', '2026-07-31'),
      row('xa', 'A', 1, 2, D),
      row('xc', 'C', 1, 2, D),
    ];
    expect(planConfirm(x, input(x, rows, ['xa', 'xc']), at)).toEqual({
      kind: 'CONFIRMATION_BLOCKED',
      violations: [{ code: 'BUYER_SHARE_NOT_INCREASED', partyId: 'A', shareBefore: f(1n, 2n), share: f(1n, 2n) }],
    });
  });

  it('5a: a decrease recorded as a purchase (A 1/2 → 1/4 beside C — → 3/4) is refused alone; 5b holds (−1/4 + 3/4)', () => {
    const x = draft(['A', 'C'], 1, 2);
    const rows = [
      row('a', 'A', 1, 2, '2020-01-01', '2026-07-31'),
      row('b', 'B', 1, 2, '2020-01-01', '2026-07-31'),
      row('xa', 'A', 1, 4, D),
      row('xc', 'C', 3, 4, D),
    ];
    expect(planConfirm(x, input(x, rows, ['xa', 'xc']), at)).toEqual({
      kind: 'CONFIRMATION_BLOCKED',
      violations: [{ code: 'BUYER_SHARE_NOT_INCREASED', partyId: 'A', shareBefore: f(1n, 2n), share: f(1n, 4n) }],
    });
    // byBuyer as 5b would report it: the negative part is exact, never clipped.
    const increases = buyerIncreases(x, input(x, rows, ['xa', 'xc']).own, input(x, rows, []).onTransferDate, input(x, rows, []).beforeTransferDate);
    expect(increases.map((b) => b.acquired)).toEqual([f(-1n, 4n), f(3n, 4n)]);
  });

  it('A sold, then buys again after a gap: nothing on d − 1, the full share counts', () => {
    const x = draft(['A'], 1, 2);
    const rows = [
      row('old', 'A', 1, 2, '2020-01-01', '2025-12-31'),
      row('b', 'B', 1, 2, '2020-01-01', '2026-07-31'),
      row('c', 'C', 1, 2, '2026-01-01'),
      row('x', 'A', 1, 2, D),
    ];
    expect(planConfirm(x, input(x, rows, ['x']), at)).toEqual(confirmed(x));
  });

  it('other owners changing on d (C sells to D in Y) are independent: increases are per buyer of X', () => {
    const x = draft(['A'], 1, 4);
    const rows = [
      row('a', 'A', 1, 4, '2020-01-01', '2026-07-31'),
      row('b', 'B', 1, 4, '2020-01-01', '2026-07-31'),
      row('c', 'C', 1, 2, '2020-01-01', '2026-07-31'),
      row('x', 'A', 1, 2, D),
      row('y', 'D', 1, 2, D),
    ];
    expect(planConfirm(x, input(x, rows, ['x']), at)).toEqual(confirmed(x));
  });

  it('not expressible: the same buyer in two Acquisitions on one day, or buying and selling on one day', () => {
    // A 1/3 buys B's 1/3 in X and C's 1/3 in Y; one row 1/1 carries X.
    const rows = [
      row('a', 'A', 1, 3, '2020-01-01', '2026-07-31'),
      row('b', 'B', 1, 3, '2020-01-01', '2026-07-31'),
      row('c', 'C', 1, 3, '2020-01-01', '2026-07-31'),
      row('x', 'A', 1, 1, D),
    ];
    const x = draft(['A'], 1, 3);
    expect(planConfirm(x, input(x, rows, ['x']), at)).toMatchObject({ violations: [{ code: 'SHARE_SUM_MISMATCH', actual: f(2n, 3n) }] });
    const y = { ...draft(['A'], 1, 3), id: 'y' as AcquisitionId };
    expect(planConfirm(y, input(y, rows, []), at)).toMatchObject({
      violations: [
        { code: 'BUYER_WITHOUT_OWNERSHIP', partyId: 'A' },
        { code: 'SHARE_SUM_MISMATCH', actual: zero, byBuyer: [] },
      ],
    });
    // A 1/2 buys B's 1/2 in X and sells 1/4 to D in Y: the net change is 1/4.
    const net = [
      row('a', 'A', 1, 2, '2020-01-01', '2026-07-31'),
      row('b', 'B', 1, 2, '2020-01-01', '2026-07-31'),
      row('x', 'A', 3, 4, D),
      row('d', 'D', 1, 4, D),
    ];
    const half = draft(['A'], 1, 2);
    expect(planConfirm(half, input(half, net, ['x']), at)).toMatchObject({ violations: [{ code: 'SHARE_SUM_MISMATCH', actual: f(1n, 4n) }] });
  });

  it('the day-before boundary: d − 2 (a gap) counts nothing, d − 1 counts, a row from d is no predecessor; 1 January, 1 March of a leap year', () => {
    const x = draft(['A'], 1, 2);
    const own = [row('x', 'A', 1, 1, D)];
    const held = (before: ConfirmationOwnership[]) => buyerIncreases(x, own, own, before)[0]?.shareBefore;
    // The domain reads only rows that cover d − 1, whatever it is given.
    expect(held([row('gap', 'A', 1, 2, '2020-01-01', '2026-07-30')])).toEqual(zero);
    expect(held([row('pre', 'A', 1, 2, '2020-01-01', '2026-07-31')])).toEqual(f(1n, 2n));
    expect(held(own)).toEqual(zero);
    for (const [transfer, last] of [
      ['2027-01-01', '2026-12-31'],
      ['2028-03-01', '2028-02-29'],
    ] as const) {
      const y = draft(['A'], 1, 2, transfer);
      const yOwn = [row('x', 'A', 1, 1, transfer)];
      expect(buyerIncreases(y, yOwn, yOwn, [row('pre', 'A', 1, 2, '2020-01-01', last)])[0]?.acquired).toEqual(f(1n, 2n));
      expect(buyerIncreases(y, yOwn, yOwn, [row('gap', 'A', 1, 2, '2020-01-01', '2026-06-30')])[0]?.acquired).toEqual(f(1n, 1n));
    }
  });

  it('structureViolations: 5a for every buyer by partyId, then 5b; a buyer without an Ownership is requirement 4’s only', () => {
    const x = draft(['C', 'A', 'B'], 1, 2);
    const rows = [
      row('a', 'A', 1, 2, '2020-01-01', '2026-07-31'),
      row('c', 'C', 1, 4, '2020-01-01', '2026-07-31'),
      row('xa', 'A', 1, 2, D),
      row('xc', 'C', 1, 4, D),
    ];
    const i = input(x, rows, ['xa', 'xc']);
    expect(structureViolations(x, i.own, i.onTransferDate, i.beforeTransferDate)).toEqual([
      { code: 'BUYER_WITHOUT_OWNERSHIP', partyId: 'B' },
      { code: 'BUYER_SHARE_NOT_INCREASED', partyId: 'A', shareBefore: f(1n, 2n), share: f(1n, 2n) },
      { code: 'BUYER_SHARE_NOT_INCREASED', partyId: 'C', shareBefore: f(1n, 4n), share: f(1n, 4n) },
      {
        code: 'SHARE_SUM_MISMATCH',
        expected: f(1n, 2n),
        actual: zero,
        byBuyer: [
          { partyId: 'A', shareBefore: f(1n, 2n), share: f(1n, 2n), acquired: zero },
          { partyId: 'C', shareBefore: f(1n, 4n), share: f(1n, 4n), acquired: zero },
        ],
      },
    ]);
  });
});
