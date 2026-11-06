import { describe, expect, it } from 'vitest';
import { PROPERTIES, REALM_B, databaseUrl, eur, expectOwnersAddUp, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-55 end to end over HTTP (api-design.md §58Q "Example (synthetic)"; Entscheidung des Projektinhabers, 2026-11-05,
 * §58Q Fragen 1–11): S bought P in 2015 through DE (W), sold it to A by legacy L (contract 2025-03-01, confirmed without
 * the date); §58N recorded the transfer 2025-05-01 and nobody got AfA in March and April. The act extends S's Ownership
 * to 2025-04-30 and moves A's to 2025-05-01 with evidence: S's AfA 400.00 → 800.00, A's 2,133.33 unchanged, the rent of
 * March and April moves from A to S, P's figures unchanged but the AfA section, 2024 and 2026 unchanged in every figure;
 * `OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER` gone, `OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER` open in 2025 until
 * acknowledged. The §28.1A case, the DRAFT path, the refusals, idempotency, Realm B, no cash mutated. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('aligning the Ownerships to the economic transfer end to end (VC-X-55)', () => {
  const api = useAcc8('acquisition_align_ownerships_e2e');
  const { at, call, json, classify, booked, post } = api;
  const EVIDENCE = ['Übergabeprotokoll 2025-05-01, Abschnitt 2 (synthetisch)'];
  const DATE_EVIDENCE = ['Übergabeprotokoll 2025-05-01 (synthetisch)'];
  const ALLOCATION_W = { total: '150000.00', land: '30000.00', building: '120000.00' };
  const ALLOCATION_L = { total: '200000.00', land: '40000.00', building: '160000.00' };
  const OLD_FLAG = 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER';
  const KIND = 'OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER';
  const align = (id: string, body: unknown, headers: Record<string, string> = {}, realm?: string) =>
    call('POST', `/acquisitions/${id}/align-ownerships-to-transfer`, body, { headers, ...(realm === undefined ? {} : { realm }) });
  const recordDate = async (id: string, date: string) =>
    json(await call('POST', `/acquisitions/${id}/economic-transfer-date`, { economicTransferDate: date, sourceReferences: DATE_EVIDENCE }));
  const money = (v: Json) => [
    v.einnahmen,
    v.werbungskosten.total,
    v.werbungskosten.lines.map((l: Json) => [l.line, l.taxCategory, l.total]),
    v.result,
    v.capitalized,
    v.notOwned,
  ];
  const withoutAfa = (v: Json) => [v.einnahmen, v.werbungskosten.lines.filter((l: Json) => !String(l.line).startsWith('AFA')), v.capitalized.total, v.notOwned];
  const afaOf = (v: Json) => v.werbungskosten.lines.find((l: Json) => l.line === 'AFA_BUILDING')?.total.amount;
  const rentOf = (v: Json, party: string) => v.owners.find((o: Json) => o.ownerPartyId === party)?.einnahmen.total.amount;
  const flag = (v: Json, code: string) => v.flags.find((f: Json) => f.code === code);
  const codes = (list: Json[]) => list.map((e: Json) => e.code);
  const count = async (sql: string, params: unknown[] = []) => Number((await api.ctx.pool.query(sql, params)).rows[0].n);
  const periods = async (pr: string) =>
    (
      await api.ctx.pool.query(
        `SELECT id, owner_party_id AS owner, to_char(valid_from, 'YYYY-MM-DD') AS f, to_char(valid_until, 'YYYY-MM-DD') AS u, version FROM ownership WHERE property_reference_id = $1 ORDER BY id`,
        [pr],
      )
    ).rows;
  /** Rent 1,000.00 a month, paid on the 3rd (the share date, §58C), 2024 to 2026, classified by the user. */
  async function rent(pr: string) {
    const account = await api.account();
    for (const year of [2024, 2025, 2026]) {
      for (let month = 1; month <= 12; month++) {
        const [split] = await booked(account, 'INFLOW', `${year}-${String(month).padStart(2, '0')}-03`, [
          { amount: eur('1000.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: pr },
        ]);
        await classify({ sourceId: split, taxCategory: 'RENT', treatment: 'INCOME' });
      }
    }
  }
  /** §58Q's example: W (S from 2015-07-01, dated), legacy L (A from 2025-03-01, S closed on 2025-02-28), the building. */
  async function example(index: number) {
    at('2015-08-01');
    const pr = await api.link(PROPERTIES[index] as string);
    const [s, a] = [await api.party('Verkäufer S (synthetisch)'), await api.party('Käuferin A (synthetisch)')];
    const { acquisitionId: w } = await api.purchase({
      pr,
      buyers: [s],
      share: '1/1',
      price: '150000.00',
      contract: '2015-06-01',
      transfer: '2015-07-01',
      allocation: ALLOCATION_W,
    });
    const oS = await api.own(pr, s, '1/1', '2015-07-01', w);
    await api.confirm(w);
    const legacy = await api.legacy({
      pr,
      buyers: [{ partyId: a, share: '1/1' }],
      sellers: [s],
      close: [oS],
      share: '1/1',
      price: '200000.00',
      contract: '2025-03-01',
      allocation: ALLOCATION_L,
    });
    const building = await api.building(pr, [w, legacy.acquisitionId]);
    return { pr, s, a, w, l: legacy.acquisitionId, oS, oA: legacy.ownershipIds[0] as string, building };
  }

  it(
    'the example: S 400.00 to 800.00, A 2133.33 unchanged, the rent of March and April moves to S, P unchanged but the AfA, 2024 and 2026 unchanged, the new flag open until acknowledged',
    { timeout: 180_000 },
    async () => {
      const { pr, s, a, w, l, oS, oA, building } = await example(0);
      await rent(pr);
      at('2026-01-15');
      expect((await recordDate(l, '2025-05-01')).flags).toEqual([
        { code: OLD_FLAG, level: 'OPEN', details: { acquisitionId: l, ownershipStart: '2025-03-01', economicTransferDate: '2025-05-01' } },
      ]);
      const component = async (id: string) => (await api.schedule(building, 'from=2024&to=2026')).components.find((c: Json) => c.acquisitionId === id);
      const year = (c: Json, y: number) => c.years.find((x: Json) => x.year === y)?.amount.amount;
      const views = async () => ({ 2024: await api.view(pr, 2024), 2025: await api.view(pr, 2025), 2026: await api.view(pr, 2026) });
      const before = await views();
      const [wBefore, lBefore] = [await component(w), await component(l)];
      expect([year(wBefore, 2024), year(wBefore, 2025), wBefore.owners[0].tenure]).toEqual([
        '2400.00',
        '400.00',
        { from: '2015-07-01', lastDay: '2025-02-28', lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' },
      ]);
      expect([year(lBefore, 2025), year(lBefore, 2026)]).toEqual(['2133.33', '3200.00']);
      expect([rentOf(before[2025], s), rentOf(before[2025], a), before[2025].einnahmen.total.amount]).toEqual(['2000.00', '10000.00', '12000.00']);
      expect(flag(before[2025], OLD_FLAG).details[0]).toMatchObject({ acquisitionId: l, level: 'OPEN' });
      // A recorded version of 2025 (§60, question 6): not a blocker, shown as changed afterwards.
      at('2026-02-01');
      await api.record(building, 2025);
      const cashBefore = await api.cashRows();
      const version = (await json(await call('GET', `/acquisitions/${l}`))).version as number;

      // The refusals first: nothing written.
      expect((await json(await align(l, { sourceReferences: [] }), 400)).error.details.fields).toEqual([{ field: 'sourceReferences', code: 'REQUIRED' }]);
      expect((await json(await align(l, {}), 400)).error.details.fields).toEqual([{ field: 'sourceReferences', code: 'REQUIRED' }]);
      expect((await json(await align(l, { sourceReferences: EVIDENCE, validUntil: '2025-04-30' }), 400)).error.code).toBe('VALIDATION_ERROR');
      expect((await align(l, { sourceReferences: EVIDENCE }, { 'if-match': `"${version - 1}"` })).status).toBe(412);
      expect((await align(l, { sourceReferences: EVIDENCE }, {}, REALM_B)).status).toBe(404);
      expect(await count(`SELECT count(*) AS n FROM audit_record WHERE entity_id = ANY($1) AND action LIKE '%_TO_ECONOMIC_TRANSFER'`, [[l, oS, oA]])).toBe(0);
      const untouched = await periods(pr);

      // The act on 2026-02-10.
      at('2026-02-10');
      const res = await align(l, { sourceReferences: EVIDENCE, notes: '  laut Protokoll  ' }, { 'if-match': `"${version}"` });
      const body = await json(res);
      expect(res.headers.get('etag')).toBe(`"${version + 1}"`);
      expect(body.acquisition).toMatchObject({
        acquisitionId: l,
        status: 'CONFIRMED',
        contractDate: '2025-03-01',
        economicTransferDate: '2025-05-01',
        transferDate: '2025-05-01',
        ownershipAlignedAt: '2026-02-10T10:00:00.000Z',
        ownershipAlignmentSourceReferences: EVIDENCE,
        version: version + 1,
        flags: [],
      });
      expect(body.extended.map((o: Json) => [o.ownershipId, o.ownerPartyId, o.validFrom, o.validUntil, o.version])).toEqual([
        [oS, s, '2015-07-01', '2025-04-30', 2],
      ]);
      expect(body.moved.map((o: Json) => [o.ownershipId, o.ownerPartyId, o.validFrom, o.validUntil, o.acquisitionId, o.version])).toEqual([
        [oA, a, '2025-05-01', null, l, 2],
      ]);
      expect([body.completeness, body.shareSum]).toEqual(['COMPLETE', '1/1']);
      // Never twice, with or without the same body.
      expect(await json(await align(l, { sourceReferences: EVIDENCE }), 409)).toMatchObject({
        error: { code: 'CONFLICT', details: { reason: 'OWNERSHIPS_ALREADY_ALIGNED', acquisitionId: l, ownershipStart: '2025-05-01' } },
      });
      // History: the rows keep their ids and shares; the AuditRecords show the old dates and the evidence.
      const after = await periods(pr);
      expect(after.map((r: Json) => r.id)).toEqual(untouched.map((r: Json) => r.id));
      const audits = (
        await api.ctx.pool.query(`SELECT entity_id, action, metadata FROM audit_record WHERE action IN ($1, $2, $3) ORDER BY action`, [
          'EXTENDED_TO_ECONOMIC_TRANSFER',
          'OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER',
          'START_MOVED_TO_ECONOMIC_TRANSFER',
        ])
      ).rows;
      expect(audits).toEqual([
        {
          entity_id: oS,
          action: 'EXTENDED_TO_ECONOMIC_TRANSFER',
          metadata: { acquisitionId: l, validUntil: { from: '2025-02-28', to: '2025-04-30' }, sourceReferences: EVIDENCE, notes: 'laut Protokoll' },
        },
        {
          entity_id: l,
          action: 'OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER',
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
          entity_id: oA,
          action: 'START_MOVED_TO_ECONOMIC_TRANSFER',
          metadata: { acquisitionId: l, validFrom: { from: '2025-03-01', to: '2025-05-01' }, sourceReferences: EVIDENCE, notes: 'laut Protokoll' },
        },
      ]);
      // The full history (the ACC8 harness wires no Ownership list): the corrected periods, nothing voided or added.
      const byId = (rows: Json[]) => Object.fromEntries(rows.map((r: Json) => [r.id, [r.owner, r.f, r.u]]));
      expect(byId(after)).toEqual({ [oS]: [s, '2015-07-01', '2025-04-30'], [oA]: [a, '2025-05-01', null] });
      expect(byId(untouched)).toEqual({ [oS]: [s, '2015-07-01', '2025-02-28'], [oA]: [a, '2025-03-01', null] });

      // §59A: S's AfA runs to the transfer, A's is unchanged in every year.
      const [wAfter, lAfter] = [await component(w), await component(l)];
      expect([year(wAfter, 2024), year(wAfter, 2025), wAfter.owners[0].tenure]).toEqual([
        '2400.00',
        '800.00',
        { from: '2015-07-01', lastDay: '2025-04-30', lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' },
      ]);
      expect([year(lAfter, 2025), year(lAfter, 2026), lAfter.start.date]).toEqual(['2133.33', '3200.00', '2025-05-01']);
      expect(lAfter.flags.map((f: Json) => f.code)).not.toContain(OLD_FLAG);
      // The views: 2024 and 2026 in every figure; 2025 P's figures but the AfA section (+400.00), the owners' parts moved.
      const now = await views();
      expect(money(now[2024])).toEqual(money(before[2024]));
      expect(now[2024].owners).toEqual(before[2024].owners);
      expect(money(now[2026])).toEqual(money(before[2026]));
      expect(now[2026].owners).toEqual(before[2026].owners);
      expect(withoutAfa(now[2025])).toEqual(withoutAfa(before[2025]));
      expect([afaOf(before[2025]), afaOf(now[2025])]).toEqual(['2533.33', '2933.33']);
      expect([rentOf(now[2025], s), rentOf(now[2025], a), now[2025].einnahmen.total.amount]).toEqual(['4000.00', '8000.00', '12000.00']);
      for (const y of [2024, 2025, 2026] as const) expectOwnersAddUp(now[y], `after ${y}`);
      // The flags: the old one gone; the new one open in 2025 only (the act lies after 2025-12-31), §60's change shown.
      expect(flag(now[2025], OLD_FLAG)).toBeUndefined();
      const [entry] = flag(now[2025], KIND).details;
      expect(entry).toMatchObject({
        acquisitionId: l,
        contractDate: '2025-03-01',
        economicTransferDate: '2025-05-01',
        level: 'OPEN',
        alignedAt: '2026-02-10T10:00:00.000Z',
        acknowledgement: null,
      });
      expect([flag(now[2024], KIND), flag(now[2026], KIND)]).toEqual([undefined, undefined]);
      expect(codes(now[2025].review.open)).toEqual(expect.arrayContaining([KIND, 'DEPRECIATION_CHANGED_SINCE_RECORDED']));
      // Acknowledged with the new kind (§58E Part 2): the flag closed, no figure moved.
      const figures = money(now[2025]);
      const ack = await post(`/property-references/${pr}/tax-years/2025/acknowledgements`, {
        auditRecordId: entry.auditRecordId,
        kind: KIND,
        expectedFingerprint: entry.changeFingerprint,
        reason: 'Verkäufer bis zum Übergang wirtschaftlicher Eigentümer (synthetisch)',
      });
      expect(ack.change).toMatchObject({ kind: KIND, entityType: 'Acquisition', entityId: l, items: [] });
      const acknowledged = await api.view(pr, 2025);
      expect(flag(acknowledged, KIND).details[0].acknowledgement?.acknowledgementId).toBe(ack.acknowledgementId);
      expect(codes(acknowledged.review.open)).not.toContain(KIND);
      expect(codes(acknowledged.review.info)).toContain(KIND);
      expect(money(acknowledged)).toEqual(figures);
      // Realm B: neither the Acquisition nor the year; no cash row written or changed.
      expect((await call('GET', `/acquisitions/${l}`, undefined, { realm: REALM_B })).status).toBe(404);
      expect((await call('GET', `/property-references/${pr}/tax-years/2025`, undefined, { realm: REALM_B })).status).toBe(404);
      expect(await api.cashRows()).toEqual(cashBefore);
    },
  );

  it(
    'an existing owner buying (§28.1A): S and the predecessor of A extended, the 1/1 of A moved, acquired 1/2 before and after, no disposal for A',
    { timeout: 120_000 },
    async () => {
      at('2015-08-01');
      const pr = await api.link(PROPERTIES[1] as string);
      const [s, a] = [await api.party('Verkäuferin S2 (synthetisch)'), await api.party('Käufer A2 (synthetisch)')];
      const { acquisitionId: w } = await api.purchase({
        pr,
        buyers: [a, s],
        share: '1/1',
        price: '150000.00',
        contract: '2015-06-01',
        transfer: '2015-07-01',
        allocation: ALLOCATION_W,
      });
      const [wA, wS] = [await api.own(pr, a, '1/2', '2015-07-01', w), await api.own(pr, s, '1/2', '2015-07-01', w)];
      await api.confirm(w);
      const { acquisitionId: x, ownershipIds } = await api.legacy({
        pr,
        buyers: [{ partyId: a, share: '1/1' }],
        sellers: [s],
        close: [wA, wS],
        share: '1/2',
        price: '100000.00',
        contract: '2025-03-01',
        allocation: { total: '100000.00', land: '20000.00', building: '80000.00' },
      });
      const building = await api.building(pr, [w, x]);
      at('2026-01-15');
      await recordDate(x, '2025-05-01');
      const ofX = async () => (await api.schedule(building, 'from=2025&to=2025')).components.find((c: Json) => c.acquisitionId === x);
      const before = (await ofX()).owners.map((o: Json) => [o.ownerPartyId, o.acquiredShare, o.weight]);
      expect(before).toEqual([[a, '1/2', '1/1']]);
      const body = await json(await align(x, { sourceReferences: EVIDENCE }));
      expect(body.extended.map((o: Json) => [o.ownershipId, o.validUntil])).toEqual(
        [
          [wA, '2025-04-30'],
          [wS, '2025-04-30'],
        ].sort((p, q) => (p[0] as string).localeCompare(q[0] as string)),
      );
      expect(body.moved.map((o: Json) => [o.ownershipId, o.share, o.validFrom])).toEqual([[ownershipIds[0], '1/1', '2025-05-01']]);
      expect([body.completeness, body.shareSum]).toEqual(['COMPLETE', '1/1']);
      expect((await ofX()).owners.map((o: Json) => [o.ownerPartyId, o.acquiredShare, o.weight])).toEqual(before);
      // A's tenure of W stays continuous: no disposal, W's component for A runs on.
      const ofW = (await api.schedule(building, 'from=2025&to=2026')).components.find((c: Json) => c.acquisitionId === w);
      const tenures = Object.fromEntries(ofW.owners.map((o: Json) => [o.ownerPartyId, o.tenure.lastDay]));
      expect([tenures[a], tenures[s]]).toEqual([null, '2025-04-30']);
    },
  );

  it(
    'the DRAFT path, the cases it does not apply to, CANCELLED 409 before 412, the key replayed and refused with another payload',
    { timeout: 120_000 },
    async () => {
      at('2026-01-15');
      const pr = await api.link(PROPERTIES[2] as string);
      const [s, a] = [await api.party('Verkäufer S3 (synthetisch)'), await api.party('Käuferin A3 (synthetisch)')];
      const { acquisitionId: w } = await api.purchase({
        pr,
        buyers: [s],
        share: '1/1',
        price: '150000.00',
        contract: '2020-01-01',
        transfer: '2020-01-01',
        allocation: ALLOCATION_W,
      });
      const oS = await api.own(pr, s, '1/1', '2020-01-01', w);
      await api.confirm(w);
      // A DRAFT created before the date: the buyer's row from the contract date, the seller's closed the day before.
      const { acquisitionId: d } = await api.purchase({
        pr,
        buyers: [a],
        sellers: [s],
        share: '1/1',
        price: '200000.00',
        contract: '2025-12-01',
        transfer: null,
        allocation: ALLOCATION_L,
      });
      // The close (the ACC8 harness wires no close route): every guard of the database runs.
      await api.ctx.pool.query(`UPDATE ownership SET valid_until = '2025-11-30', version = version + 1 WHERE id = $1`, [oS]);
      await api.own(pr, a, '1/1', '2025-12-01', d);
      // Not applicable before the date is recorded.
      expect((await json(await align(d, { sourceReferences: EVIDENCE }), 422)).error).toMatchObject({
        code: 'OWNERSHIP_EXTENSION_NOT_APPLICABLE',
        details: { reason: 'TRANSFER_DATE_NOT_RECORDED' },
      });
      await recordDate(d, '2026-01-01');
      // Before the act A is an owner in 2025 (December); after it A's only days of 2025 lie in the former gap (§58C).
      expect((await call('GET', `/property-references/${pr}/tax-years/2025?ownerPartyId=${a}`)).status).toBe(200);
      const key = { 'idempotency-key': 'vc-x-55-draft-1' };
      const first = await json(await align(d, { sourceReferences: EVIDENCE }, key));
      expect([first.acquisition.status, first.acquisition.transferDate, first.extended[0].validUntil, first.moved[0].validFrom]).toEqual([
        'DRAFT',
        '2026-01-01',
        '2025-12-31',
        '2026-01-01',
      ]);
      const replay = await align(d, { sourceReferences: EVIDENCE }, key);
      expect([replay.status, replay.headers.get('idempotent-replayed'), (await json(replay)).acquisition.version]).toEqual([
        200,
        'true',
        first.acquisition.version,
      ]);
      expect((await align(d, { sourceReferences: ['anderer Beleg (synthetisch)'] }, key)).status).toBe(409);
      expect((await json(await call('GET', `/property-references/${pr}/tax-years/2025?ownerPartyId=${a}`), 422)).error.code).toBe('NOT_AN_OWNER_IN_YEAR');
      // The seller becomes one in t − 1's year: S holds December 2025 now.
      expect((await call('GET', `/property-references/${pr}/tax-years/2025?ownerPartyId=${s}`)).status).toBe(200);
      // Confirmed on the transfer (ownershipStart = t); the year flag open in 2025 (the act lies after 2025-12-31).
      expect((await api.confirm(d)).status).toBe('CONFIRMED');
      expect(flag(await api.view(pr, 2025), KIND).details[0].level).toBe('OPEN');
      // Created with the date: its rows start on the transfer already.
      const pr2 = await api.link(PROPERTIES[3] as string);
      const dated = (
        await api.purchase({
          pr: pr2,
          buyers: [a],
          sellers: [s],
          share: '1/1',
          price: '200000.00',
          contract: '2025-12-01',
          transfer: '2026-01-01',
          allocation: ALLOCATION_L,
        })
      ).acquisitionId;
      expect((await json(await align(dated, { sourceReferences: EVIDENCE }), 422)).error.details.reason).toBe('TRANSFER_DATE_NOT_RECORDED');
      // The transfer on the contract date: no gap.
      const same = (
        await api.purchase({ pr: pr2, buyers: [a], share: '1/1', price: '200000.00', contract: '2025-12-01', transfer: null, allocation: ALLOCATION_L })
      ).acquisitionId;
      await recordDate(same, '2025-12-01');
      expect((await json(await align(same, { sourceReferences: EVIDENCE }), 422)).error.details.reason).toBe('TRANSFER_ON_CONTRACT_DATE');
      // An external seller without a row in DE: nothing to extend.
      const external = (
        await api.purchase({
          pr: pr2,
          buyers: [a],
          sellers: [s],
          share: '1/1',
          price: '200000.00',
          contract: '2025-12-01',
          transfer: null,
          allocation: ALLOCATION_L,
        })
      ).acquisitionId;
      await recordDate(external, '2026-01-01');
      expect((await json(await align(external, { sourceReferences: EVIDENCE }), 422)).error.details.reason).toBe('NO_SELLER_ROW');
      // CANCELLED: 409 ACQUISITION_CANCELLED, also with a stale If-Match (a final status answers before the version).
      await post(`/acquisitions/${external}/cancel`, { reason: 'geplatzt (synthetisch)' }, 200);
      expect((await json(await align(external, { sourceReferences: EVIDENCE }, { 'if-match': '"1"' }), 409)).error.details.reason).toBe(
        'ACQUISITION_CANCELLED',
      );
      expect(
        await count(`SELECT count(*) AS n FROM audit_record WHERE entity_id = ANY($1) AND action = 'OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER'`, [
          [dated, same, external],
        ]),
      ).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM audit_record WHERE entity_id = $1 AND action = 'OWNERSHIPS_ALIGNED_TO_ECONOMIC_TRANSFER'`, [d])).toBe(1);
    },
  );
});
