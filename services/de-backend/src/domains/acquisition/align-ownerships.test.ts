import { describe, expect, it } from 'vitest';
import { Money, addDays, type BusinessDate } from '../../shared/index.js';
import { ownershipStart, type Acquisition, type AcquisitionId } from './acquisition.js';
import { alignOwnershipsFingerprint, planAlignOwnerships, type AlignOwnership, type AlignPlan } from './align-ownerships.js';
import { ownershipStartFlag } from './transfer-date.js';

/**
 * §58Q (VC-X-55; Entscheidung des Projektinhabers, 2026-11-05, Fragen 1–4, 9): the plan of the act in its order of
 * checks, its rows (all sellers, all buyers, all predecessors), each blocker alone and all at once in order, the edges
 * (a one-day gap, a gap across a year end, 29 February), `ownershipStart` for every kind of Acquisition and the flag gone
 * once aligned. Synthetic values only.
 */
const day = (value: string) => value as BusinessDate;
const AT = new Date('2026-02-10T10:00:00Z');
const INPUT = { sourceReferences: ['Übergabeprotokoll 2025-05-01, Abschnitt 2 (synthetisch)'], notes: null };
const legacy = (o: Partial<Acquisition> = {}): Acquisition => ({
  id: 'l' as AcquisitionId,
  mreRealmId: 'r',
  propertyReferenceId: 'pr',
  status: 'CONFIRMED',
  purchasePrice: Money.of('200000.00', 'EUR'),
  acquiredShare: { numerator: 1, denominator: 1 },
  contractDate: day('2025-03-01'),
  economicTransferDate: day('2025-05-01'),
  landRegistryTransferDate: null,
  buyerPartyIds: ['a'],
  sellerPartyIds: ['s'],
  sourceReferences: [],
  notes: null,
  cancelledAt: null,
  cancellationReason: null,
  confirmedAt: new Date('2025-03-05T09:00:00Z'),
  createdAt: new Date('2025-02-20T09:00:00Z'),
  version: 3,
  economicTransferRecordedAt: new Date('2026-01-15T10:00:00Z'),
  economicTransferSourceReferences: ['Übergabeprotokoll (synthetisch)'],
  ownershipAlignedAt: null,
  ownershipAlignmentSourceReferences: null,
  flags: [],
  ...o,
});
const row = (
  id: string,
  owner: string,
  from: string,
  until: string | null,
  acquisitionId: string | null = null,
  share: [number, number] = [1, 1],
): AlignOwnership => ({
  id,
  ownerPartyId: owner,
  share: { numerator: share[0], denominator: share[1] },
  validFrom: day(from),
  validUntil: until === null ? null : day(until),
  acquisitionId,
});
/** The example's rows: S (W) to the day before the contract, A (L) from the contract date. */
const example = (c = '2025-03-01') => [row('o-s', 's', '2015-07-01', addDays(day(c), -1), 'w'), row('o-a', 'a', c, null, 'l')];
const plan = (a: Acquisition, rows: readonly AlignOwnership[], versions?: number[]) => planAlignOwnerships(a, rows, INPUT, AT, versions);
const steps = (p: AlignPlan) => (p.kind === 'ALIGN' ? { sellers: p.sellers, predecessors: p.predecessors, moved: p.moved } : p);

describe('the act of §58Q, planned', () => {
  it('the example: S to t − 1, A from t, X aligned with the new evidence and version + 1; ownershipStart becomes t', () => {
    const p = plan(legacy(), example());
    expect(steps(p)).toEqual({
      sellers: [{ ownershipId: 'o-s', from: '2025-02-28', to: '2025-04-30' }],
      predecessors: [],
      moved: [{ ownershipId: 'o-a', from: '2025-03-01', to: '2025-05-01' }],
    });
    if (p.kind !== 'ALIGN') throw new Error(p.kind);
    expect([p.next.ownershipAlignedAt, p.next.ownershipAlignmentSourceReferences, p.next.version, p.next.status]).toEqual([
      AT,
      INPUT.sourceReferences,
      4,
      'CONFIRMED',
    ]);
    expect([ownershipStart(legacy()), ownershipStart(p.next)]).toEqual(['2025-03-01', '2025-05-01']);
  });

  it('the order of checks: cancelled before a stale version; aligned before the version; the version before 422; none without If-Match', () => {
    const cancelled = legacy({ status: 'CANCELLED', confirmedAt: null, cancelledAt: AT, cancellationReason: 'x' });
    expect(plan(cancelled, [], [1])).toEqual({ kind: 'ACQUISITION_CANCELLED' });
    const aligned = legacy({ ownershipAlignedAt: AT, ownershipAlignmentSourceReferences: ['x'] });
    expect(plan(aligned, example(), [1])).toEqual({ kind: 'OWNERSHIPS_ALREADY_ALIGNED', ownershipAlignedAt: AT, ownershipStart: '2025-05-01' });
    expect(plan(legacy({ economicTransferRecordedAt: null, economicTransferDate: null }), [], [2])).toEqual({
      kind: 'VERSION_CONFLICT',
      expectedVersions: [2],
      currentVersion: 3,
    });
    expect(plan(legacy(), example(), [3]).kind).toBe('ALIGN');
    expect(plan(legacy(), example()).kind).toBe('ALIGN');
    // 422 not applicable before 422 blocked.
    const blocked = [...example(), row('o-k', 's', '2025-03-01', null)];
    expect(plan(legacy({ economicTransferRecordedAt: null }), blocked)).toEqual({
      kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE',
      reason: 'TRANSFER_DATE_NOT_RECORDED',
    });
  });

  it('not applicable: undated, created with the date, t = c, no seller row ending on c − 1 (one day before or after is not it)', () => {
    const na = (reason: string) => ({ kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE', reason });
    expect(plan(legacy({ economicTransferDate: null, economicTransferRecordedAt: null }), example())).toEqual(na('TRANSFER_DATE_NOT_RECORDED'));
    expect(plan(legacy({ economicTransferRecordedAt: null }), example())).toEqual(na('TRANSFER_DATE_NOT_RECORDED'));
    expect(plan(legacy({ economicTransferDate: day('2025-03-01') }), example())).toEqual(na('TRANSFER_ON_CONTRACT_DATE'));
    for (const end of ['2025-02-27', '2025-03-01']) {
      const rows = [row('o-s', 's', '2015-07-01', end, 'w'), row('o-a', 'a', '2025-03-02', null, 'l')];
      expect(plan(legacy(), rows), end).toEqual(na('NO_SELLER_ROW'));
    }
    // A row of someone else ending on c − 1 is not a seller row either.
    expect(plan(legacy(), [row('o-x', 'x', '2015-07-01', '2025-02-28'), row('o-a', 'a', '2025-03-01', null, 'l')])).toEqual(na('NO_SELLER_ROW'));
  });

  it('the edges: a one-day gap (t = c + 1), a gap across a year end, a transfer on 1 March of a leap year (t − 1 = 29 February)', () => {
    const one = steps(plan(legacy({ economicTransferDate: day('2025-03-02') }), example()));
    expect(one).toMatchObject({ sellers: [{ to: '2025-03-01' }], moved: [{ to: '2025-03-02' }] });
    const year = steps(plan(legacy({ contractDate: day('2024-12-01'), economicTransferDate: day('2025-02-01') }), example('2024-12-01')));
    expect(year).toMatchObject({ sellers: [{ from: '2024-11-30', to: '2025-01-31' }], moved: [{ from: '2024-12-01', to: '2025-02-01' }] });
    const leap = steps(plan(legacy({ contractDate: day('2024-01-15'), economicTransferDate: day('2024-03-01') }), example('2024-01-15')));
    expect(leap).toMatchObject({ sellers: [{ from: '2024-01-14', to: '2024-02-29' }], moved: [{ to: '2024-03-01' }] });
  });

  it('every seller row, every buyer row, every buyer predecessor: two sellers, an external seller beside one with a row, §28.1A', () => {
    const two = legacy({ sellerPartyIds: ['s', 't', 'ext'], buyerPartyIds: ['a', 'b'] });
    const rows = [
      row('o-s', 's', '2015-07-01', '2025-02-28', 'w', [1, 2]),
      row('o-t', 't', '2015-07-01', '2025-02-28', 'w', [1, 2]),
      row('o-a', 'a', '2025-03-01', null, 'l', [1, 2]),
      row('o-b', 'b', '2025-03-01', null, 'l', [1, 2]),
    ];
    expect(steps(plan(two, rows))).toEqual({
      sellers: [
        { ownershipId: 'o-s', from: '2025-02-28', to: '2025-04-30' },
        { ownershipId: 'o-t', from: '2025-02-28', to: '2025-04-30' },
      ],
      predecessors: [],
      moved: [
        { ownershipId: 'o-a', from: '2025-03-01', to: '2025-05-01' },
        { ownershipId: 'o-b', from: '2025-03-01', to: '2025-05-01' },
      ],
    });
    // §28.1A: A held 1/2 beside S 1/2 and buys S's half; A's 1/2 is the predecessor, extended too.
    const increase = legacy({ acquiredShare: { numerator: 1, denominator: 2 } });
    const held = [
      row('o-a1', 'a', '2015-07-01', '2025-02-28', 'w', [1, 2]),
      row('o-s', 's', '2015-07-01', '2025-02-28', 'w', [1, 2]),
      row('o-a', 'a', '2025-03-01', null, 'l'),
    ];
    expect(steps(plan(increase, held))).toEqual({
      sellers: [{ ownershipId: 'o-s', from: '2025-02-28', to: '2025-04-30' }],
      predecessors: [{ ownershipId: 'o-a1', from: '2025-02-28', to: '2025-04-30' }],
      moved: [{ ownershipId: 'o-a', from: '2025-03-01', to: '2025-05-01' }],
    });
    // Without the predecessor extended, 5a/5b on t would fail (A held nothing on t − 1): the plan never leaves it.
    expect(plan(increase, held).kind).toBe('ALIGN');
  });

  it('each blocker alone, then all at once in code then id order; a buyer row ending on or after t is moved, its successors untouched', () => {
    const blocked = (rows: readonly AlignOwnership[], a = legacy()) => plan(a, rows);
    const base = example();
    expect(blocked([...base, row('o-k', 's', '2025-03-01', null, null, [1, 4])])).toEqual({
      kind: 'OWNERSHIP_EXTENSION_BLOCKED',
      blockedBy: [{ code: 'SELLER_KEEPS_PART', ownershipId: 'o-k' }],
    });
    expect(blocked([...base, row('o-g', 's', '2025-04-01', null)])).toEqual({
      kind: 'OWNERSHIP_EXTENSION_BLOCKED',
      blockedBy: [{ code: 'SELLER_ROW_IN_GAP', ownershipId: 'o-g', validFrom: '2025-04-01' }],
    });
    // A seller row from t is not in the gap (bought back on the transfer day).
    expect(blocked([...base.map((r) => (r.id === 'o-a' ? { ...r, validUntil: day('2025-06-30') } : r)), row('o-g', 's', '2025-07-01', null)]).kind).toBe(
      'ALIGN',
    );
    expect(blocked([base[0] as AlignOwnership, row('o-a', 'a', '2025-03-01', '2025-03-31', 'l')])).toEqual({
      kind: 'OWNERSHIP_EXTENSION_BLOCKED',
      blockedBy: [{ code: 'BUYER_ROW_ENDS_BEFORE_TRANSFER', ownershipId: 'o-a', validUntil: '2025-03-31' }],
    });
    const endsOnT = steps(plan(legacy(), [base[0] as AlignOwnership, row('o-a', 'a', '2025-03-01', '2025-05-01', 'l'), row('o-c', 'c', '2025-05-02', null)]));
    expect(endsOnT).toMatchObject({ moved: [{ ownershipId: 'o-a', to: '2025-05-01' }] });
    // A buyer of X holding a share on c − 1 by a row not ending on c − 1 (B, without a row of X yet).
    const withB = legacy({ buyerPartyIds: ['a', 'b'] });
    expect(blocked([...base, row('o-b', 'b', '2015-07-01', null, null, [1, 2])], withB)).toEqual({
      kind: 'OWNERSHIP_EXTENSION_BLOCKED',
      blockedBy: [{ code: 'BUYER_PREDECESSOR_NOT_ADJACENT', partyId: 'b' }],
    });
    // All at once: every blocker listed, by code, then by id.
    const all = [
      base[0] as AlignOwnership,
      row('o-a', 'a', '2025-03-01', '2025-03-31', 'l'),
      row('o-b', 'b', '2015-07-01', null, null, [1, 2]),
      row('o-k2', 's', '2025-03-01', null, null, [1, 8]),
      row('o-k1', 's', '2025-03-01', null, null, [1, 8]),
      row('o-g', 's', '2025-04-01', null),
    ];
    expect(blocked(all, withB)).toEqual({
      kind: 'OWNERSHIP_EXTENSION_BLOCKED',
      blockedBy: [
        { code: 'BUYER_PREDECESSOR_NOT_ADJACENT', partyId: 'b' },
        { code: 'BUYER_ROW_ENDS_BEFORE_TRANSFER', ownershipId: 'o-a', validUntil: '2025-03-31' },
        { code: 'SELLER_KEEPS_PART', ownershipId: 'o-k1' },
        { code: 'SELLER_KEEPS_PART', ownershipId: 'o-k2' },
        { code: 'SELLER_ROW_IN_GAP', ownershipId: 'o-g', validFrom: '2025-04-01' },
      ],
    });
  });

  it('after the blockers, the invariants over the state after the act; for a CONFIRMED X requirements 2 to 6 on t, not for a DRAFT', () => {
    // D 1/2 from c beside A 1/2 (L): S extended overlaps D on c, the sum 3/2.
    const half = legacy({ acquiredShare: { numerator: 1, denominator: 2 } });
    const rows = [
      row('o-s', 's', '2015-07-01', '2025-02-28', 'w'),
      row('o-d', 'd', '2025-03-01', null, 'm', [1, 2]),
      row('o-a', 'a', '2025-03-01', null, 'l', [1, 2]),
    ];
    expect(plan(half, rows)).toEqual({
      kind: 'OWNERSHIP_EXTENSION_BLOCKED',
      blockedBy: [{ code: 'OWNERSHIP_TOTAL_EXCEEDS_ONE', date: '2025-03-01', shareSum: { numerator: 3n, denominator: 2n } }],
    });
    // A's predecessor extended over another row of A inside the gap (a broken record): OVERLAPPING_OWNERSHIP with it.
    const pred = [
      row('o-p', 'a', '2015-07-01', '2025-02-28', 'w', [1, 2]),
      row('o-s', 's', '2015-07-01', '2025-02-28', 'w', [1, 2]),
      row('o-a', 'a', '2025-03-01', null, 'l'),
      row('o-x', 'a', '2025-04-01', '2025-04-15', null, [1, 4]),
    ];
    expect(plan(half, pred)).toEqual({ kind: 'OWNERSHIP_EXTENSION_BLOCKED', blockedBy: [{ code: 'OVERLAPPING_OWNERSHIP', ownershipId: 'o-x' }] });
    // The requirements on t: a CONFIRMED X whose buyer B holds no row of X (requirement 4) is refused, a DRAFT is not.
    const missing = legacy({ buyerPartyIds: ['a', 'b'] });
    const blocked = plan(missing, example());
    expect(blocked).toMatchObject({
      kind: 'OWNERSHIP_EXTENSION_BLOCKED',
      blockedBy: [{ code: 'CONFIRMATION_REQUIREMENTS', violations: [{ code: 'BUYER_WITHOUT_OWNERSHIP', partyId: 'b' }] }],
    });
    expect(plan({ ...missing, status: 'DRAFT', confirmedAt: null }, example()).kind).toBe('ALIGN');
    // An inactive buyer is not re-checked (requirement 1): nothing of the Parties is read.
    expect(plan(legacy(), example()).kind).toBe('ALIGN');
  });
});

describe('ownershipStart and the flag of §58N with the alignment', () => {
  it('undated, created with the date, recorded later, aligned', () => {
    const facts = { contractDate: day('2025-03-01') };
    expect(ownershipStart({ ...facts, economicTransferDate: null })).toBe('2025-03-01');
    expect(ownershipStart({ ...facts, economicTransferDate: day('2025-05-01') })).toBe('2025-05-01');
    expect(ownershipStart({ ...facts, economicTransferDate: day('2025-05-01'), economicTransferRecordedAt: AT })).toBe('2025-03-01');
    expect(ownershipStart({ ...facts, economicTransferDate: day('2025-05-01'), economicTransferRecordedAt: AT, ownershipAlignedAt: AT })).toBe('2025-05-01');
  });

  it('the flag of §58N is gone once aligned (counter-check: raised before)', () => {
    expect(ownershipStartFlag(legacy(), true)?.level).toBe('OPEN');
    expect(ownershipStartFlag(legacy({ ownershipAlignedAt: AT, ownershipAlignmentSourceReferences: ['x'] }), true)).toBeNull();
  });

  it('the fingerprint: the id in lower case, the evidence as given, the notes', () => {
    expect(alignOwnershipsFingerprint('L-ID', INPUT)).toBe(alignOwnershipsFingerprint('l-id', INPUT));
    expect(alignOwnershipsFingerprint('l', INPUT)).not.toBe(alignOwnershipsFingerprint('l', { ...INPUT, notes: 'x' }));
  });
});
