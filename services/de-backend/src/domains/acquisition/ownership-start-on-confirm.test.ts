import { describe, expect, it } from 'vitest';
import { Money, addDays, type BusinessDate } from '../../shared/index.js';
import {
  ownershipStart,
  planConfirm,
  structureViolations,
  type Acquisition,
  type AcquisitionId,
  type ConfirmationInput,
  type ConfirmationOwnership,
  type OwnershipStartFacts,
} from './acquisition.js';
import { planAlignOwnerships } from './align-ownerships.js';
import { ownershipStartFlag } from './transfer-date.js';

/**
 * §58R (VC-X-57; ADR-044; Entscheidung des Projektinhabers, 2026-11-06, Fragen 1–7): `ownershipStart` by rule 1, each
 * branch alone and against the next, the old rule as an oracle for every Acquisition confirmed before; `planConfirm` on
 * `t` for a `DRAFT` dated by §58N, requirement 7 in each case of rule 3 and its edges (`t = c`, `t = c + 1`, a gap across
 * a year end, 29 February), skipped while requirement 0 fails, N2's four violations in order, `structureViolations`
 * (§27.4) without it; §58N's flag and §58Q's `CONFIRMED_FROM_TRANSFER`. Synthetic values only.
 */
const day = (value: string) => value as BusinessDate;
const AT = new Date('2026-11-06T10:00:00Z');
const RECORDED = new Date('2026-01-15T10:00:00Z');
const f = (numerator: bigint, denominator: bigint) => ({ numerator, denominator });

/** N of §58R's example: buyer A, seller S, contract 2025-03-01, dated 2025-05-01 by §58N while a `DRAFT`. */
const n = (o: Partial<Acquisition> = {}): Acquisition => ({
  id: 'n' as AcquisitionId,
  mreRealmId: 'r',
  propertyReferenceId: 'pr',
  status: 'DRAFT',
  purchasePrice: Money.of('200000.00', 'EUR'),
  acquiredShare: { numerator: 1, denominator: 1 },
  contractDate: day('2025-03-01'),
  economicTransferDate: day('2025-05-01'),
  landRegistryTransferDate: null,
  buyerPartyIds: ['A'],
  sellerPartyIds: ['S'],
  sourceReferences: [],
  notes: null,
  cancelledAt: null,
  cancellationReason: null,
  confirmedAt: null,
  createdAt: new Date('2025-02-20T09:00:00Z'),
  version: 2,
  economicTransferRecordedAt: RECORDED,
  economicTransferSourceReferences: ['Übergabeprotokoll 2025-05-01 (synthetisch)'],
  ownershipAlignedAt: null,
  ownershipAlignmentSourceReferences: null,
  confirmedOwnershipStart: null,
  flags: [],
  ...o,
});
const row = (id: string, owner: string, from: string, until: string | null = null, share: [number, number] = [1, 1]): ConfirmationOwnership => ({
  id,
  ownerPartyId: owner,
  share: { numerator: share[0], denominator: share[1] },
  validFrom: day(from),
  validUntil: until === null ? null : day(until),
});
const covers = (o: ConfirmationOwnership, d: string) => o.validFrom <= d && (o.validUntil === null || o.validUntil >= d);
/** As the repository reads them: own rows by id, the PropertyReference on `d` and `d − 1`, the sellers' rows. */
const input = (x: Acquisition, rows: readonly ConfirmationOwnership[], ownIds: readonly string[]): ConfirmationInput => {
  const d = ownershipStart(x);
  return {
    buyerStatuses: new Map(x.buyerPartyIds.map((b) => [b, 'ACTIVE'])),
    own: rows.filter((o) => ownIds.includes(o.id)),
    onTransferDate: rows.filter((o) => covers(o, d)),
    beforeTransferDate: rows.filter((o) => covers(o, addDays(d, -1))),
    sellerRows: rows.filter((o) => x.sellerPartyIds.includes(o.ownerPartyId)),
  };
};
const confirm = (x: Acquisition, rows: readonly ConfirmationOwnership[], ownIds: readonly string[]) => planConfirm(x, input(x, rows, ownIds), AT);
const codes = (plan: ReturnType<typeof planConfirm>) => (plan.kind === 'CONFIRMATION_BLOCKED' ? plan.violations.map((v) => v.code) : plan.kind);

/** The rule before VC-X-57 (0072's), kept as the oracle for every Acquisition confirmed before. */
const before57 = (a: OwnershipStartFacts): BusinessDate =>
  a.ownershipAlignedAt != null && a.economicTransferDate !== null
    ? a.economicTransferDate
    : a.economicTransferRecordedAt != null
      ? a.contractDate
      : (a.economicTransferDate ?? a.contractDate);

describe('ownershipStart by §58R rule 1', () => {
  const c = day('2025-03-01');
  const t = day('2025-05-01');
  it('each branch alone and against the next in its order', () => {
    // 1: stored; it wins over 4 (a CONFIRMED row with a date recorded later).
    expect(
      ownershipStart({ status: 'CONFIRMED', contractDate: c, economicTransferDate: t, economicTransferRecordedAt: RECORDED, confirmedOwnershipStart: t }),
    ).toBe(t);
    // 2: aligned; it wins over 4.
    expect(
      ownershipStart({ status: 'CONFIRMED', contractDate: c, economicTransferDate: t, economicTransferRecordedAt: RECORDED, ownershipAlignedAt: AT }),
    ).toBe(t);
    // 3: not CONFIRMED: undated, created with a date, dated by §58N (wins over 4), CANCELLED.
    expect(ownershipStart({ status: 'DRAFT', contractDate: c, economicTransferDate: null })).toBe(c);
    expect(ownershipStart({ status: 'DRAFT', contractDate: c, economicTransferDate: t })).toBe(t);
    expect(ownershipStart({ status: 'DRAFT', contractDate: c, economicTransferDate: t, economicTransferRecordedAt: RECORDED })).toBe(t);
    expect(ownershipStart({ status: 'CANCELLED', contractDate: c, economicTransferDate: t, economicTransferRecordedAt: RECORDED })).toBe(t);
    // 4: CONFIRMED with a date recorded later (legacy, or a DRAFT confirmed under §58N before VC-X-57).
    expect(ownershipStart({ status: 'CONFIRMED', contractDate: c, economicTransferDate: t, economicTransferRecordedAt: RECORDED })).toBe(c);
    // 5: CONFIRMED created with a date; undated legacy.
    expect(ownershipStart({ status: 'CONFIRMED', contractDate: c, economicTransferDate: t })).toBe(t);
    expect(ownershipStart({ status: 'CONFIRMED', contractDate: c, economicTransferDate: null })).toBe(c);
  });

  it('every Acquisition confirmed before VC-X-57 reads as before, seeded over the dates and markers (the old rule as oracle)', () => {
    let seed = 57;
    const next = (k: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % k;
    };
    for (let i = 0; i < 500; i++) {
      const contract = addDays(day('2016-01-01'), next(4000));
      const facts: OwnershipStartFacts = {
        status: 'CONFIRMED',
        contractDate: contract,
        economicTransferDate: next(4) === 0 ? null : addDays(contract, next(400)),
        economicTransferRecordedAt: next(2) === 0 ? null : RECORDED,
        ownershipAlignedAt: next(3) === 0 ? AT : null,
        confirmedOwnershipStart: null,
      };
      expect(ownershipStart(facts), JSON.stringify(facts)).toBe(before57(facts));
    }
  });
});

describe('planConfirm on the transfer (§58R rules 2, 3, 5)', () => {
  const S_TO_T = row('os', 'S', '2015-07-01', '2025-04-30');
  const A_FROM_T = row('oa', 'A', '2025-05-01');

  it('N: a DRAFT dated by §58N with the rows on t is confirmed and stores the day; with the rows from c it is refused (the turned case)', () => {
    expect(confirm(n(), [S_TO_T, A_FROM_T], ['oa'])).toEqual({
      kind: 'CONFIRM',
      next: { ...n(), status: 'CONFIRMED', confirmedAt: AT, confirmedOwnershipStart: '2025-05-01', version: 3 },
    });
    expect(codes(confirm(n(), [row('os', 'S', '2015-07-01', '2025-02-28'), row('oa', 'A', '2025-03-01')], ['oa']))).toContain(
      'OWNERSHIP_NOT_FROM_TRANSFER_DATE',
    );
  });

  it('N2: exactly the four violations of the example, in order', () => {
    const plan = confirm(n(), [row('os', 'S', '2015-07-01', '2025-02-28'), row('oa2', 'A', '2025-03-01')], ['oa2']);
    expect(plan).toEqual({
      kind: 'CONFIRMATION_BLOCKED',
      violations: [
        { code: 'OWNERSHIP_NOT_FROM_TRANSFER_DATE', ownershipId: 'oa2', validFrom: '2025-03-01', transferDate: '2025-05-01' },
        { code: 'BUYER_SHARE_NOT_INCREASED', partyId: 'A', shareBefore: f(1n, 1n), share: f(1n, 1n) },
        {
          code: 'SHARE_SUM_MISMATCH',
          expected: f(1n, 1n),
          actual: f(0n, 1n),
          byBuyer: [{ partyId: 'A', shareBefore: f(1n, 1n), share: f(1n, 1n), acquired: f(0n, 1n) }],
        },
        { code: 'SELLER_SHARE_CHANGED_BEFORE_TRANSFER', partyId: 'S', shareOnContractEve: f(1n, 1n), shareOnTransferEve: f(0n, 1n) },
      ],
    });
  });

  it('requirement 7: sold at the contract fails alone, sold on t passes, a seller keeping a part passes, an external seller passes', () => {
    const created = n({ economicTransferRecordedAt: null, economicTransferSourceReferences: null });
    expect(confirm(created, [row('os', 'S', '2015-07-01', '2025-02-28'), A_FROM_T], ['oa'])).toEqual({
      kind: 'CONFIRMATION_BLOCKED',
      violations: [{ code: 'SELLER_SHARE_CHANGED_BEFORE_TRANSFER', partyId: 'S', shareOnContractEve: f(1n, 1n), shareOnTransferEve: f(0n, 1n) }],
    });
    expect(confirm(created, [S_TO_T, A_FROM_T], ['oa']).kind).toBe('CONFIRM');
    const part = n({ acquiredShare: { numerator: 3, denominator: 4 } });
    const keeps = [S_TO_T, row('os2', 'S', '2025-05-01', null, [1, 4]), row('oa', 'A', '2025-05-01', null, [3, 4])];
    expect(confirm(part, keeps, ['oa']).kind).toBe('CONFIRM');
    // Counter-check: the kept part already on c (S 1/4 from the contract) changes S on t − 1 and fails.
    const early = [row('os', 'S', '2015-07-01', '2025-02-28'), row('os2', 'S', '2025-03-01', null, [1, 4]), row('oa', 'A', '2025-05-01', null, [3, 4])];
    expect(confirm(part, early, ['oa'])).toMatchObject({
      violations: [{ code: 'SELLER_SHARE_CHANGED_BEFORE_TRANSFER', shareOnContractEve: f(1n, 1n), shareOnTransferEve: f(1n, 4n) }],
    });
    // External: DE holds no row of S (0/1 on both days); the buyer from t alone makes the PropertyReference complete.
    expect(confirm(n(), [A_FROM_T], ['oa']).kind).toBe('CONFIRM');
  });

  it('requirement 7 with two sellers: only the failing one, by partyId', () => {
    const x = n({ sellerPartyIds: ['T', 'S'] });
    const rows = [row('os', 'S', '2015-07-01', '2025-04-30', [1, 2]), row('ot', 'T', '2015-07-01', '2025-02-28', [1, 2]), A_FROM_T];
    expect(confirm(x, rows, ['oa'])).toEqual({
      kind: 'CONFIRMATION_BLOCKED',
      violations: [{ code: 'SELLER_SHARE_CHANGED_BEFORE_TRANSFER', partyId: 'T', shareOnContractEve: f(1n, 2n), shareOnTransferEve: f(0n, 1n) }],
    });
  });

  it('the edges: t = c compares one day, t = c + 1, a gap across a year end, 29 February', () => {
    const edge = (c: string, t: string, sellerEnd: string) => {
      const x = n({ contractDate: day(c), economicTransferDate: day(t) });
      return codes(confirm(x, [row('os', 'S', '2015-07-01', sellerEnd), row('oa', 'A', t)], ['oa']));
    };
    expect(edge('2025-03-01', '2025-03-01', '2025-02-28')).toBe('CONFIRM');
    expect(edge('2025-03-01', '2025-03-02', '2025-03-01')).toBe('CONFIRM');
    expect(edge('2025-03-01', '2025-03-02', '2025-02-28')).toEqual(['SELLER_SHARE_CHANGED_BEFORE_TRANSFER']);
    expect(edge('2024-12-01', '2025-01-01', '2024-12-31')).toBe('CONFIRM');
    expect(edge('2024-12-01', '2025-01-01', '2024-11-30')).toEqual(['SELLER_SHARE_CHANGED_BEFORE_TRANSFER']);
    expect(edge('2028-01-15', '2028-03-01', '2028-02-29')).toBe('CONFIRM');
    expect(edge('2028-01-15', '2028-03-01', '2028-02-28')).toEqual(['SELLER_SHARE_CHANGED_BEFORE_TRANSFER']);
  });

  it('requirement 7 is not evaluated while requirement 0 fails (the undated DRAFT: its date is unknown)', () => {
    const undated = n({ economicTransferDate: null, economicTransferRecordedAt: null, economicTransferSourceReferences: null });
    expect(codes(confirm(undated, [row('os', 'S', '2015-07-01', '2025-02-28'), row('oa', 'A', '2025-03-01')], ['oa']))).toEqual(['TRANSFER_DATE_MISSING']);
  });

  it('structureViolations (§27.4) does not read requirement 7: N2 gives its three structure violations only', () => {
    const rows = [row('os', 'S', '2015-07-01', '2025-02-28'), row('oa2', 'A', '2025-03-01')];
    const i = input(n(), rows, ['oa2']);
    expect(structureViolations(n(), i.own, i.onTransferDate, i.beforeTransferDate).map((v) => v.code)).toEqual([
      'OWNERSHIP_NOT_FROM_TRANSFER_DATE',
      'BUYER_SHARE_NOT_INCREASED',
      'SHARE_SUM_MISMATCH',
    ]);
  });
});

describe('the flag of §58N and §58Q after VC-X-57 (§58R rules 7 and 8)', () => {
  it('no flag for a dated DRAFT or an Acquisition confirmed from the transfer; legacy L keeps it (counter-check)', () => {
    expect(ownershipStartFlag(n(), true)).toBeNull();
    expect(ownershipStartFlag(n({ status: 'CONFIRMED', confirmedAt: AT, confirmedOwnershipStart: day('2025-05-01') }), true)).toBeNull();
    expect(ownershipStartFlag(n({ status: 'CONFIRMED', confirmedAt: AT }), true)).toMatchObject({
      level: 'OPEN',
      details: { ownershipStart: '2025-03-01', economicTransferDate: '2025-05-01' },
    });
  });

  it('§58Q on N confirmed from the transfer: CONFIRMED_FROM_TRANSFER, after TRANSFER_ON_CONTRACT_DATE and before NO_SELLER_ROW', () => {
    const confirmed = n({ status: 'CONFIRMED', confirmedAt: AT, confirmedOwnershipStart: day('2025-05-01') });
    const input = { sourceReferences: ['x'], notes: null };
    expect(planAlignOwnerships(confirmed, [], input, AT)).toEqual({ kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE', reason: 'CONFIRMED_FROM_TRANSFER' });
    expect(planAlignOwnerships({ ...confirmed, economicTransferDate: day('2025-03-01'), confirmedOwnershipStart: day('2025-03-01') }, [], input, AT)).toEqual({
      kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE',
      reason: 'TRANSFER_ON_CONTRACT_DATE',
    });
    // Counter-check: the same rows without the stored day (legacy) answer NO_SELLER_ROW.
    expect(planAlignOwnerships({ ...confirmed, confirmedOwnershipStart: null }, [], input, AT)).toEqual({
      kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE',
      reason: 'NO_SELLER_ROW',
    });
  });
});
