import { describe, expect, it } from 'vitest';
import { Money } from '../../shared/index.js';
import { insertConfirmedAsBeforeVcX34 } from './legacy-acquisition.test-support.js';
import { ownershipAlignmentFactsOf, ownershipStartFactsOf } from './ownership-start-reads.js';
import { createDatabase } from './database.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { AT, EVIDENCE, OTHER_REALM, REALM, actor, databaseUrl, day, useAlignSchema } from './align-ownerships.test-support.js';

/**
 * §58Q (VC-X-55, migration 0072; Entscheidung des Projektinhabers, 2026-11-05, Fragen 1–11) through the repository: the
 * example end to end (versions + 1 on each row and on L, the three AuditRecords with old and new dates and the evidence),
 * every refusal writing nothing, idempotency, Realm isolation, history (reads write nothing), the year-flag reads, and
 * concurrency under READ COMMITTED. Synthetic values only.
 */
describe.skipIf(databaseUrl === undefined)('aligning the Ownerships to the economic transfer through the repository (§58Q)', () => {
  const t = useAlignSchema('acquisition_align_ownerships_test');
  const { example, align, periods, acquisitionRow, audits, own, party, recordDate, propertyReference } = t;
  const count = async (sql: string, params: unknown[] = []) => Number((await t.ctx.pool.query(sql, params)).rows[0].n);
  const snapshot = async (pr: string, ids: readonly string[]) => ({
    rows: await periods(pr),
    acquisitions: await Promise.all(ids.map(acquisitionRow)),
    audits: await count(`SELECT count(*) AS n FROM audit_record`),
    keys: await count(`SELECT count(*) AS n FROM idempotency_key`),
  });
  /** A DRAFT through the repository (a 1/1 purchase at 100,000.00 unless said otherwise). */
  const draft = async (pr: string, o: { buyers: string[]; sellers?: string[]; contract?: string; transfer?: string | null; share?: [number, number] }) => {
    const created = await t.ctx.acquisitions.create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        purchasePrice: Money.of('100000.00', 'EUR'),
        acquiredShare: { numerator: o.share?.[0] ?? 1, denominator: o.share?.[1] ?? 1 },
        contractDate: day(o.contract ?? '2025-03-01'),
        economicTransferDate: o.transfer == null ? null : day(o.transfer),
        landRegistryTransferDate: null,
        buyerPartyIds: o.buyers,
        sellerPartyIds: o.sellers ?? [],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.acquisition.id;
  };

  it('the example: S extended to 2025-04-30, A moved to 2025-05-01, L aligned; versions + 1; three AuditRecords with old and new dates', async () => {
    const { pr, s, a, l, oS, oA } = await example();
    const before = await acquisitionRow(l);
    const outcome = await align(l, { input: { sourceReferences: EVIDENCE, notes: 'laut Protokoll' } });
    if (outcome.kind !== 'ALIGNED') throw new Error(outcome.kind);
    const { acquisition, extended, moved, completeness, shareSum } = outcome.result;
    expect([acquisition.version, acquisition.ownershipAlignedAt, acquisition.ownershipAlignmentSourceReferences, acquisition.flags]).toEqual([
      before.version + 1,
      AT,
      EVIDENCE,
      [],
    ]);
    expect(extended.map((o) => [o.id, o.ownerPartyId, o.validFrom, o.validUntil, o.version])).toEqual([[oS, s, '2015-06-01', '2025-04-30', 2]]);
    expect(moved.map((o) => [o.id, o.ownerPartyId, o.validFrom, o.validUntil, o.version, o.acquisitionId])).toEqual([[oA, a, '2025-05-01', null, 2, l]]);
    expect([completeness, shareSum]).toEqual(['COMPLETE', { numerator: 1n, denominator: 1n }]);
    const after = await acquisitionRow(l);
    // Only the marker, its evidence and the version changed on L.
    expect({ ...after, ownership_aligned_at: null, ownership_alignment_source_references: null, version: before.version }).toEqual(before);
    const records = await audits([l, oS, oA]);
    // One transaction, one timestamp: by action.
    const byAction = (x: { action: string }, y: { action: string }) => (x.action < y.action ? -1 : 1);
    expect(records.filter((r) => r.action !== 'ECONOMIC_TRANSFER_DATE_RECORDED').sort(byAction)).toEqual([
      {
        entity_type: 'Ownership',
        entity_id: oS,
        action: 'EXTENDED_TO_ECONOMIC_TRANSFER',
        previous_version: 1,
        new_version: 2,
        metadata: { acquisitionId: l, validUntil: { from: '2025-02-28', to: '2025-04-30' }, sourceReferences: EVIDENCE, notes: 'laut Protokoll' },
      },
      {
        entity_type: 'Acquisition',
        entity_id: l,
        action: 'OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER',
        previous_version: before.version,
        new_version: before.version + 1,
        metadata: {
          contractDate: '2025-03-01',
          economicTransferDate: '2025-05-01',
          ownershipStart: { from: '2025-03-01', to: '2025-05-01' },
          status: 'CONFIRMED',
          extendedOwnershipIds: [oS],
          movedOwnershipIds: [oA],
          sourceReferences: EVIDENCE,
          notes: 'laut Protokoll',
        },
      },
      {
        entity_type: 'Ownership',
        entity_id: oA,
        action: 'START_MOVED_TO_ECONOMIC_TRANSFER',
        previous_version: 1,
        new_version: 2,
        metadata: { acquisitionId: l, validFrom: { from: '2025-03-01', to: '2025-05-01' }, sourceReferences: EVIDENCE, notes: 'laut Protokoll' },
      },
    ]);
    // History: reads write nothing; the full history shows the moved periods under the same ids.
    const auditCount = await count(`SELECT count(*) AS n FROM audit_record`);
    expect((await t.ctx.acquisitions.findById(l, REALM))?.ownershipAlignedAt).toEqual(AT);
    expect(await periods(pr)).toEqual(
      [
        [oA, a, '2025-05-01', null, 2],
        [oS, s, '2015-06-01', '2025-04-30', 2],
      ].sort((x, y) => ((x[0] as string) < (y[0] as string) ? -1 : 1)),
    );
    expect(await count(`SELECT count(*) AS n FROM audit_record`)).toBe(auditCount);
    // The year flags' reads: §58N's fact gone, §58Q's there with the act's record.
    const recordId = (await t.ctx.pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = 'OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER'`, [l]))
      .rows[0].id;
    await createDatabase(t.ctx.pool)
      .transaction()
      .execute(async (trx) => {
        expect(await ownershipStartFactsOf(trx, REALM, pr)).toEqual([]);
        expect(await ownershipAlignmentFactsOf(trx, REALM, pr)).toEqual([
          { acquisitionId: l, contractDate: '2025-03-01', economicTransferDate: '2025-05-01', auditRecordId: recordId, alignedAt: AT },
        ]);
      });
  });

  it('every refusal writes nothing: cancelled (also with a stale version), already aligned, a stale version, not applicable, blocked', async () => {
    // Already aligned: 409 with the time and the day, also for a retry with the same body and a stale version.
    const done = await example();
    await align(done.l);
    let state = await snapshot(done.pr, [done.l]);
    expect(await align(done.l)).toEqual({ kind: 'OWNERSHIPS_ALREADY_ALIGNED', ownershipAlignedAt: AT, ownershipStart: '2025-05-01' });
    expect((await align(done.l, { expectedVersions: [1] })).kind).toBe('OWNERSHIPS_ALREADY_ALIGNED');
    expect(await snapshot(done.pr, [done.l])).toEqual(state);
    // A stale If-Match on X's version: 412, nothing written; the current version passes (below).
    const x = await example();
    state = await snapshot(x.pr, [x.l]);
    const version = (await acquisitionRow(x.l)).version as number;
    expect(await align(x.l, { expectedVersions: [version - 1] })).toEqual({
      kind: 'VERSION_CONFLICT',
      expectedVersions: [version - 1],
      currentVersion: version,
    });
    expect(await snapshot(x.pr, [x.l])).toEqual(state);
    expect((await align(x.l, { expectedVersions: [version] })).kind).toBe('ALIGNED');
    // Not applicable: undated, created with the date (here: a DRAFT dated on create), t = c, no seller row.
    const undated = await example({ transfer: null });
    state = await snapshot(undated.pr, [undated.l]);
    expect(await align(undated.l)).toEqual({ kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE', reason: 'TRANSFER_DATE_NOT_RECORDED' });
    const same = await example({ transfer: '2025-03-01' });
    expect(await align(same.l)).toEqual({ kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE', reason: 'TRANSFER_ON_CONTRACT_DATE' });
    const pr = await propertyReference();
    const [b, seller] = [await party('Käufer B (synthetisch)'), await party('Externe Verkäuferin (synthetisch)')];
    const dated = await draft(pr, { buyers: [b], sellers: [seller], transfer: '2025-05-01' });
    expect(await align(dated)).toEqual({ kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE', reason: 'TRANSFER_DATE_NOT_RECORDED' });
    const external = await draft(pr, { buyers: [b], sellers: [seller] });
    await recordDate(external, '2025-05-01');
    expect(await align(external)).toEqual({ kind: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE', reason: 'NO_SELLER_ROW' });
    // Cancelled: 409 also with a stale version (a final status answers before the version).
    expect((await t.ctx.acquisitions.cancel(external, REALM, 'geplatzt (synthetisch)', AT, actor)).kind).toBe('CANCELLED');
    expect(await align(external, { expectedVersions: [1] })).toEqual({ kind: 'ACQUISITION_CANCELLED' });
    // Blocked: A resold to C on 2025-04-01 (inside the gap) and S keeping 1/4 from the contract date.
    const resold = await example();
    const c = await party('Käufer C (synthetisch)');
    await t.ctx.pool.query(`UPDATE ownership SET valid_until = '2025-03-31', version = version + 1 WHERE id = $1`, [resold.oA]);
    const oC = await own(resold.pr, { owner: c, from: '2025-04-01' });
    state = await snapshot(resold.pr, [resold.l]);
    expect(await align(resold.l)).toEqual({
      kind: 'OWNERSHIP_EXTENSION_BLOCKED',
      blockedBy: [{ code: 'BUYER_ROW_ENDS_BEFORE_TRANSFER', ownershipId: resold.oA, validUntil: '2025-03-31' }],
    });
    expect(await snapshot(resold.pr, [resold.l])).toEqual(state);
    expect((await periods(resold.pr)).some((r) => r[0] === oC)).toBe(true);
    expect(
      await count(`SELECT count(*) AS n FROM audit_record WHERE action LIKE '%_TO_ECONOMIC_TRANSFER' AND entity_id = ANY($1)`, [
        [undated.l, same.l, resold.l, resold.oA, dated, external],
      ]),
    ).toBe(0);
  });

  it('the invariants over the state after the act: S sold one half to A (L, dated later) and one to D (M, dated on create); extending S is OWNERSHIP_TOTAL_EXCEEDS_ONE on c', async () => {
    const pr = await propertyReference();
    const [s, a, d] = [await party('Verkäufer S (synthetisch)'), await party('Käuferin A (synthetisch)'), await party('Käufer D (synthetisch)')];
    const w = await insertConfirmedAsBeforeVcX34(t.ctx.pool, {
      mreRealmId: REALM,
      propertyReferenceId: pr,
      contractDate: '2015-06-01',
      buyers: [{ partyId: s, share: [1, 1] }],
    });
    await t.ctx.pool.query(`UPDATE ownership SET valid_until = '2025-02-28' WHERE id = $1`, [w.ownershipIds[0]]);
    const m = await draft(pr, { buyers: [d], sellers: [s], transfer: '2025-03-01', share: [1, 2] });
    await own(pr, { owner: d, share: [1, 2], from: '2025-03-01', acquisitionId: m });
    const l = await insertConfirmedAsBeforeVcX34(t.ctx.pool, {
      mreRealmId: REALM,
      propertyReferenceId: pr,
      contractDate: '2025-03-01',
      acquiredShare: [1, 2],
      buyers: [{ partyId: a, share: [1, 2] }],
      sellerPartyIds: [s],
    });
    await recordDate(l.acquisitionId, '2025-05-01');
    const state = await snapshot(pr, [l.acquisitionId, m]);
    expect(await align(l.acquisitionId)).toEqual({
      kind: 'OWNERSHIP_EXTENSION_BLOCKED',
      blockedBy: [{ code: 'OWNERSHIP_TOTAL_EXCEEDS_ONE', date: '2025-03-01', shareSum: { numerator: 3n, denominator: 2n } }],
    });
    expect(await snapshot(pr, [l.acquisitionId, m])).toEqual(state);
  });

  it('a seller keeping a part (§28.1A partial sale) is refused as SELLER_KEEPS_PART, not by the invariants', async () => {
    const pr = await propertyReference();
    const [s, a] = [await party('Verkäufer S (synthetisch)'), await party('Käuferin A (synthetisch)')];
    const w = await insertConfirmedAsBeforeVcX34(t.ctx.pool, {
      mreRealmId: REALM,
      propertyReferenceId: pr,
      contractDate: '2015-06-01',
      buyers: [{ partyId: s, share: [1, 1] }],
    });
    // S 1/1 until 2025-02-28, then S 1/4 (no Acquisition) and A 3/4 (L) from 2025-03-01.
    await t.ctx.pool.query(`UPDATE ownership SET valid_until = '2025-02-28' WHERE id = $1`, [w.ownershipIds[0]]);
    const kept = await own(pr, { owner: s, share: [1, 4], from: '2025-03-01' });
    const l = await insertConfirmedAsBeforeVcX34(t.ctx.pool, {
      mreRealmId: REALM,
      propertyReferenceId: pr,
      contractDate: '2025-03-01',
      acquiredShare: [3, 4],
      buyers: [{ partyId: a, share: [3, 4] }],
      sellerPartyIds: [s],
    });
    await recordDate(l.acquisitionId, '2025-05-01');
    const state = await snapshot(pr, [l.acquisitionId]);
    expect(await align(l.acquisitionId)).toEqual({ kind: 'OWNERSHIP_EXTENSION_BLOCKED', blockedBy: [{ code: 'SELLER_KEEPS_PART', ownershipId: kept }] });
    expect(await snapshot(pr, [l.acquisitionId])).toEqual(state);
  });

  it('idempotency: the replay answers the recorded body; another payload with the same key 409; nothing written twice', async () => {
    const { pr, l } = await example();
    const first = await align(l, { key: 'vc-x-55-k1' });
    if (first.kind !== 'ALIGNED') throw new Error(first.kind);
    const state = await snapshot(pr, [l]);
    const replay = await align(l, { key: 'vc-x-55-k1' });
    expect(replay.kind === 'ALIGNED' && [replay.replayed, replay.result]).toEqual([true, first.result]);
    expect(await align(l, { key: 'vc-x-55-k1', input: { sourceReferences: ['anderer Beleg (synthetisch)'], notes: null } })).toEqual({
      kind: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await snapshot(pr, [l])).toEqual(state);
  });

  it('Realm isolation: L of Realm B is 404 from Realm A; Realm B identical legacy data untouched and still flagged', async () => {
    const b = await example({ realm: OTHER_REALM });
    const a = await example();
    const state = await snapshot(b.pr, [b.l]);
    expect(await align(b.l)).toEqual({ kind: 'NOT_FOUND' });
    expect(await align(b.l, { realm: REALM })).toEqual({ kind: 'NOT_FOUND' });
    expect((await align(a.l)).kind).toBe('ALIGNED');
    expect(await snapshot(b.pr, [b.l])).toEqual({ ...state, audits: state.audits + 3 });
    const db = createDatabase(t.ctx.pool);
    await db.transaction().execute(async (trx) => {
      expect((await ownershipStartFactsOf(trx, OTHER_REALM, b.pr)).map((f) => f.acquisitionId)).toEqual([b.l]);
      expect(await ownershipAlignmentFactsOf(trx, OTHER_REALM, b.pr)).toEqual([]);
      // Realm A's PropertyReference read with Realm B's id: nothing.
      expect(await ownershipAlignmentFactsOf(trx, OTHER_REALM, a.pr)).toEqual([]);
    });
    expect((await t.ctx.acquisitions.findById(b.l, OTHER_REALM))?.flags.map((f) => f.code)).toEqual(['OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER']);
  });

  it('concurrency (READ COMMITTED): two acts at once, one aligns, the other answers OWNERSHIPS_ALREADY_ALIGNED; the act and confirm of a DRAFT in both orders', async () => {
    const { l } = await example();
    const both = await Promise.all([align(l), align(l)]);
    expect(both.map((o) => o.kind).sort()).toEqual(['ALIGNED', 'OWNERSHIPS_ALREADY_ALIGNED']);
    expect(await count(`SELECT count(*) AS n FROM audit_record WHERE entity_id = $1 AND action = 'OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER'`, [l])).toBe(1);
    for (const order of ['confirm first', 'align first', 'at once'] as const) {
      const pr = await propertyReference();
      const [s, a] = [await party('Verkäufer S (synthetisch)'), await party('Käuferin A (synthetisch)')];
      const w = await insertConfirmedAsBeforeVcX34(t.ctx.pool, {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        contractDate: '2015-06-01',
        buyers: [{ partyId: s, share: [1, 1] }],
      });
      await t.ctx.pool.query(`UPDATE ownership SET valid_until = '2025-02-28' WHERE id = $1`, [w.ownershipIds[0]]);
      const d = await draft(pr, { buyers: [a], sellers: [s] });
      await own(pr, { owner: a, from: '2025-03-01', acquisitionId: d });
      await recordDate(d, '2025-05-01');
      const confirm = () => t.ctx.acquisitions.confirm(d, REALM, AT, actor);
      const kinds =
        order === 'confirm first'
          ? [(await confirm()).kind, (await align(d)).kind]
          : order === 'align first'
            ? [(await align(d)).kind, (await confirm()).kind]
            : (await Promise.all([confirm(), align(d)])).map((o) => o.kind);
      expect([order, ...kinds.sort()]).toEqual([order, 'ALIGNED', 'CONFIRMED']);
      const row = await acquisitionRow(d);
      expect([row.status, row.ownership_aligned_at !== null]).toEqual(['CONFIRMED', true]);
      // Both orders end in the same state: the buyer's row from the transfer, the seller's to the day before.
      expect((await periods(pr)).map((r) => [r[1], r[2], r[3]]).sort()).toEqual(
        [
          [a, '2025-05-01', null],
          [s, '2015-06-01', '2025-04-30'],
        ].sort(),
      );
    }
  });

  it('concurrency (READ COMMITTED): the act against a §26.2 change dated inside the gap (exactly one succeeds) and against a close of the buyer row after t (both succeed)', async () => {
    const ownerships = new PostgresOwnershipRepository(createDatabase(t.ctx.pool));
    for (let run = 0; run < 3; run++) {
      const x = await example();
      const c = await party('Käufer C (synthetisch)');
      const change = () =>
        ownerships.change(
          {
            mreRealmId: REALM,
            propertyReferenceId: x.pr,
            effectiveDate: day('2025-04-01'),
            reason: 'Weiterverkauf (synthetisch)',
            close: [x.oA],
            create: [{ ownerPartyId: c, share: { numerator: 1, denominator: 1 }, sourceReferences: [], notes: null }],
            acquisitionId: null,
          },
          actor,
        );
      const kinds = (
        run === 0
          ? [(await change()).kind, (await align(x.l)).kind]
          : run === 1
            ? [(await align(x.l)).kind, (await change()).kind]
            : (await Promise.all([change(), align(x.l)])).map((o) => o.kind)
      ).sort();
      // Either the change first (the act then BUYER_ROW_ENDS_BEFORE_TRANSFER) or the act first (A's row then starts after 2025-04-01).
      expect([
        ['CHANGED', 'OWNERSHIP_EXTENSION_BLOCKED'],
        ['ALIGNED', 'INVALID_OWNERSHIP'],
      ]).toContainEqual(kinds);
      const rows = await periods(x.pr);
      expect(
        rows.filter((r) => r[1] === x.s).map((r) => r[3]),
        `run ${run}`,
      ).toEqual([kinds.includes('ALIGNED') ? '2025-04-30' : '2025-02-28']);
    }
    for (let run = 0; run < 2; run++) {
      const x = await example();
      const close = () => ownerships.close(x.oA, REALM, day('2025-12-31'), actor);
      const kinds = run === 0 ? (await Promise.all([close(), align(x.l)])).map((o) => o.kind) : [(await align(x.l)).kind, (await close()).kind];
      expect(kinds.sort()).toEqual(['ALIGNED', 'CLOSED']);
      expect((await periods(x.pr)).find((r) => r[0] === x.oA)?.slice(2, 4)).toEqual(['2025-05-01', '2025-12-31']);
    }
  });
});
