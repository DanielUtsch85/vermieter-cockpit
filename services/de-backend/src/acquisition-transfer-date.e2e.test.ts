import { describe, expect, it } from 'vitest';
import { PROPERTIES, REALM_B, databaseUrl, eur, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-52 end to end over HTTP (api-design.md §58N "Example (synthetic)"; Entscheidung des Projektinhabers, 2026-11-04,
 * §58N Fragen 1–8): legacy L (contract 2025-03-01, confirmed without the date, inserted as CONFIRMED) gets its transfer
 * 2025-05-01 with evidence: the anschaffungsnahe check is computed, the AfA starts in May 2025, every figure of 2024 and
 * every section of 2025 but the AfA stay; the Ownerships stay from the contract date (`transferDate` = `ownershipStart`)
 * and `OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER` names the gap: informative with an external seller, open with a seller
 * holding an AfA component in the Realm, closed by an acknowledgement (§58E Part 2). The DRAFT path to `confirm`, the
 * refusals, idempotency, Realm B, the AuditRecords. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('recording the economic transfer date end to end (VC-X-52)', () => {
  const api = useAcc8('acquisition_transfer_date_e2e');
  const { at, call, json, classify, booked, post } = api;
  const EVIDENCE = ['Übergabeprotokoll 2025-05-01 (synthetisch)'];
  const ALLOCATION = { total: '200000.00', land: '40000.00', building: '160000.00' };
  const KIND = 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER';
  const record = (id: string, body: unknown, headers: Record<string, string> = {}, realm?: string) =>
    call('POST', `/acquisitions/${id}/economic-transfer-date`, body, { headers, ...(realm === undefined ? {} : { realm }) });
  const money = (v: Json) => [
    v.einnahmen,
    v.werbungskosten.total,
    v.werbungskosten.lines.map((l: Json) => [l.line, l.taxCategory, l.total]),
    v.result,
    v.capitalized,
    v.owners,
  ];
  const withoutAfa = (v: Json) => [
    v.einnahmen,
    v.werbungskosten.lines.filter((l: Json) => !String(l.line).startsWith('AFA')),
    v.capitalized.total,
    v.notInView,
  ];
  const count = async (sql: string, params: unknown[] = []) => Number((await api.ctx.pool.query(sql, params)).rows[0].n);
  const flag = (v: Json) => v.flags.find((f: Json) => f.code === KIND);
  const codes = (list: Json[]) => list.map((e: Json) => e.code);
  /** The repair of the example (30,000.00, performed 2025-04-07 – 04-25) and a 2024 item, both deductible. */
  async function spending(pr: string) {
    const account = await api.account();
    const [early] = await booked(account, 'OUTFLOW', '2024-11-15', [{ amount: eur('500.00'), financialCategoryCode: 'MAINTENANCE', propertyReferenceId: pr }]);
    await classify({
      sourceId: early,
      taxCategory: 'MAINTENANCE',
      treatment: 'DEDUCTIBLE',
      netAmount: eur('500.00'),
      performance: { from: '2024-11-04', until: '2024-11-08' },
    });
    const [repair] = await booked(account, 'OUTFLOW', '2025-05-10', [
      { amount: eur('30000.00'), financialCategoryCode: 'MAINTENANCE', propertyReferenceId: pr },
    ]);
    await classify({
      sourceId: repair,
      taxCategory: 'MAINTENANCE',
      treatment: 'DEDUCTIBLE',
      netAmount: eur('30000.00'),
      performance: { from: '2025-04-07', until: '2025-04-25' },
      sourceReferences: ['Rechnung des Handwerkers (synthetisch)'],
    });
  }

  it(
    'the example with an external seller: the check computed, the AfA from May 2025, 2024 unchanged, the flag informative, 2025 final once recorded',
    { timeout: 120_000 },
    async () => {
      at('2025-06-01');
      const pr = await api.link(PROPERTIES[0] as string);
      const [a, s] = [await api.party('Käuferin A (synthetisch)'), await api.party('Verkäufer S (synthetisch)')];
      const { acquisitionId: l, allocationId } = await api.legacy({
        pr,
        buyers: [{ partyId: a, share: '1/1' }],
        sellers: [s],
        share: '1/1',
        price: '200000.00',
        contract: '2025-03-01',
        allocation: ALLOCATION,
      });
      const building = await api.building(pr, [l]);
      await spending(pr);
      at('2028-10-15');
      // Before: the date missing everywhere.
      const read = async () => json(await call('GET', `/acquisitions/${l}`));
      expect(await read()).toMatchObject({
        status: 'CONFIRMED',
        economicTransferDate: null,
        transferDate: '2025-03-01',
        economicTransferSourceReferences: null,
        flags: [],
      });
      expect((await api.check(l)).notComputableReason).toBe('TRANSFER_DATE_MISSING');
      const before = { 2024: await api.view(pr, 2024), 2025: await api.view(pr, 2025) };
      expect(codes(before[2025].review.open)).toContain('ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL');
      const component = async () => (await api.schedule(building, 'from=2024&to=2026')).components.find((c: Json) => c.acquisitionId === l);
      expect(codes((await component()).reasons)).toContain('TRANSFER_DATE_MISSING');
      const cashBefore = await api.cashRows();

      // The refusals first: nothing written.
      const version = (await read()).version as number;
      expect((await json(await record(l, { economicTransferDate: '2025-05-01', sourceReferences: [] }), 400)).error.details.fields).toEqual([
        { field: 'sourceReferences', code: 'REQUIRED' },
      ]);
      expect((await json(await record(l, { economicTransferDate: '2025-05-01' }), 400)).error.details.fields).toEqual([
        { field: 'sourceReferences', code: 'REQUIRED' },
      ]);
      expect((await json(await record(l, { economicTransferDate: '2025-05-01', sourceReferences: EVIDENCE, other: 1 }), 400)).error.code).toBe(
        'VALIDATION_ERROR',
      );
      expect((await json(await record(l, { economicTransferDate: '2025-02-28', sourceReferences: EVIDENCE }), 422)).error).toMatchObject({
        code: 'BEFORE_CONTRACT_DATE',
        details: { contractDate: '2025-03-01' },
      });
      expect((await record(l, { economicTransferDate: '2025-05-01', sourceReferences: EVIDENCE }, { 'if-match': '"1"' })).status).toBe(412);
      expect((await record(l, { economicTransferDate: '2025-05-01', sourceReferences: EVIDENCE }, {}, REALM_B)).status).toBe(404);
      expect((await read()).version).toBe(version);
      expect(await count(`SELECT count(*) AS n FROM audit_record WHERE entity_id = $1`, [l])).toBe(0);

      // The command.
      const res = await record(
        l,
        { economicTransferDate: '2025-05-01', sourceReferences: EVIDENCE, notes: '  laut Protokoll  ' },
        { 'if-match': `"${version}"` },
      );
      const body = await json(res);
      expect(res.headers.get('etag')).toBe(`"${version + 1}"`);
      expect(body).toMatchObject({
        status: 'CONFIRMED',
        economicTransferDate: '2025-05-01',
        transferDate: '2025-03-01',
        economicTransferSourceReferences: EVIDENCE,
        version: version + 1,
        flags: [{ code: KIND, level: 'INFORMATIVE', details: { acquisitionId: l, ownershipStart: '2025-03-01', economicTransferDate: '2025-05-01' } }],
      });
      expect(await json(await record(l, { economicTransferDate: '2025-05-01', sourceReferences: EVIDENCE }), 409)).toMatchObject({
        error: { code: 'CONFLICT', details: { reason: 'TRANSFER_DATE_ALREADY_SET', economicTransferDate: '2025-05-01' } },
      });
      // §27.3 under (b): a new allocation's default effectiveDate is still the day the Ownerships begin.
      const superseding = await post(`/acquisitions/${l}/land-building-allocation`, {
        totalAllocableAmount: eur(ALLOCATION.total),
        landAmount: eur(ALLOCATION.land),
        buildingAmount: eur(ALLOCATION.building),
        method: 'PURCHASE_CONTRACT',
        reviewState: 'CONFIRMED',
        supersedes: allocationId,
      });
      expect(superseding.effectiveDate).toBe('2025-03-01');
      const history = (await api.ctx.pool.query(`SELECT action, new_version, metadata FROM audit_record WHERE entity_id = $1`, [l])).rows;
      expect(history).toEqual([
        {
          action: 'ECONOMIC_TRANSFER_DATE_RECORDED',
          new_version: version + 1,
          metadata: {
            economicTransferDate: '2025-05-01',
            sourceReferences: EVIDENCE,
            notes: 'laut Protokoll',
            contractDate: '2025-03-01',
            status: 'CONFIRMED',
            ownershipStart: '2025-03-01',
          },
        },
      ]);

      // After: the check from the transfer, the repair (performed before it) outside the window.
      const check = await api.check(l);
      expect(check.notComputableReason ?? null).toBeNull();
      expect([check.status, check.transferDate, check.window, check.sources, check.final]).toEqual([
        'NOT_ABOVE_THRESHOLD',
        '2025-05-01',
        { from: '2025-05-01', until: '2028-05-01' },
        [],
        true,
      ]);
      // The AfA from May 2025: 160,000.00 × 2 % × 8/12; the flag informative on the component.
      const after = await component();
      expect([after.status, after.start?.date, after.years.find((y: Json) => y.year === 2025)?.amount.amount]).toEqual(['COMPUTABLE', '2025-05-01', '2133.33']);
      expect(after.flags.find((f: Json) => f.code === KIND)?.details).toEqual({
        acquisitionId: l,
        ownershipStart: '2025-03-01',
        economicTransferDate: '2025-05-01',
        level: 'INFORMATIVE',
      });
      // 2024 unchanged in every figure; 2025 in every section but the AfA.
      const v2024 = await api.view(pr, 2024);
      const v2025 = await api.view(pr, 2025);
      expect(money(v2024)).toEqual(money(before[2024]));
      expect(withoutAfa(v2025)).toEqual(withoutAfa(before[2025]));
      expect(v2025.werbungskosten.lines.find((l: Json) => l.line === 'AFA_BUILDING')?.total.amount).toBe('2133.33');
      expect(flag(v2025).details).toEqual([
        expect.objectContaining({
          acquisitionId: l,
          ownershipStart: '2025-03-01',
          economicTransferDate: '2025-05-01',
          level: 'INFORMATIVE',
          acknowledgement: null,
        }),
      ]);
      expect([flag(v2024), flag(await api.view(pr, 2026))]).toEqual([undefined, undefined]);
      expect(codes(v2025.review.open)).not.toContain('ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL');
      expect(codes(v2025.review.open)).not.toContain(KIND);
      expect(codes(v2025.review.info)).toContain(KIND);
      // §27.4 under (b): the Ownership from the contract date stays; recorded, 2025 is final.
      expect(
        (await api.ctx.pool.query(`SELECT to_char(valid_from, 'YYYY-MM-DD') AS d FROM ownership WHERE acquisition_id = $1`, [l])).rows.map((r) => r.d),
      ).toEqual(['2025-03-01']);
      await api.record(building, 2025);
      expect((await api.view(pr, 2025)).review).toMatchObject({ final: true, open: [] });
      expect(await api.cashRows()).toEqual(cashBefore);
    },
  );

  it(
    'a seller with an AfA component in the Realm: the flag OPEN in 2025 only, the year not final until acknowledged; the gap shown in the schedule',
    { timeout: 120_000 },
    async () => {
      at('2025-06-01');
      const pr = await api.link(PROPERTIES[1] as string);
      const [a, s] = [await api.party('Käufer A2 (synthetisch)'), await api.party('Verkäuferin S2 (synthetisch)')];
      // S2 bought P2 in 2023 through DE: her Ownership carries K, a part of K's AfA component.
      const { acquisitionId: k } = await api.purchase({
        pr,
        buyers: [s],
        share: '1/1',
        price: '150000.00',
        contract: '2023-06-01',
        transfer: '2023-06-01',
        allocation: { total: '150000.00', land: '30000.00', building: '120000.00' },
      });
      const sRow = await api.own(pr, s, '1/1', '2023-06-01', k);
      await api.confirm(k);
      const { acquisitionId: l } = await api.legacy({
        pr,
        buyers: [{ partyId: a, share: '1/1' }],
        sellers: [s],
        close: [sRow],
        share: '1/1',
        price: '200000.00',
        contract: '2025-03-01',
        allocation: ALLOCATION,
      });
      const building = await api.building(pr, [k, l]);
      const recorded = await json(await record(l, { economicTransferDate: '2025-05-01', sourceReferences: EVIDENCE }));
      expect(recorded.flags.map((f: Json) => f.level)).toEqual(['OPEN']);
      at('2028-10-15');
      // The gap: S2's tenure ends on 2025-02-28 (contract − 1), A2's AfA starts on 2025-05-01; nobody between.
      const schedule = await api.schedule(building, 'from=2025&to=2025');
      const ofK = schedule.components.find((c: Json) => c.acquisitionId === k);
      const ofL = schedule.components.find((c: Json) => c.acquisitionId === l);
      expect([ofK.owners[0].tenure.lastDay, ofL.start.date]).toEqual(['2025-02-28', '2025-05-01']);
      expect(ofL.flags.find((f: Json) => f.code === KIND)?.details.level).toBe('OPEN');
      await api.record(building, 2025);
      const v2025 = await api.view(pr, 2025);
      const entry = flag(v2025).details[0];
      expect(entry).toMatchObject({ acquisitionId: l, level: 'OPEN', acknowledgement: null });
      expect([v2025.review.final, codes(v2025.review.open)]).toEqual([false, [KIND]]);
      expect([flag(await api.view(pr, 2024)), flag(await api.view(pr, 2026))]).toEqual([undefined, undefined]);
      // Acknowledged (§58E Part 2, the new kind): 2025 final, no figure moved.
      const figures = money(v2025);
      const ack = await post(`/property-references/${pr}/tax-years/2025/acknowledgements`, {
        auditRecordId: entry.auditRecordId,
        kind: KIND,
        expectedFingerprint: entry.changeFingerprint,
        reason: 'Verlängerung der Verkäufer-Ownership folgt mit VC-X-55 (synthetisch)',
      });
      expect(ack.change).toMatchObject({ kind: KIND, entityType: 'Acquisition', entityId: l, items: [] });
      const acknowledged = await api.view(pr, 2025);
      expect([acknowledged.review.final, flag(acknowledged).details[0].acknowledgement?.acknowledgementId]).toEqual([true, ack.acknowledgementId]);
      expect(money(acknowledged)).toEqual(figures);
      // Realm B sees neither the Acquisition nor the year.
      expect((await call('GET', `/acquisitions/${l}`, undefined, { realm: REALM_B })).status).toBe(404);
      expect((await call('GET', `/property-references/${pr}/tax-years/2025`, undefined, { realm: REALM_B })).status).toBe(404);
    },
  );

  it(
    'the DRAFT path: dated then confirmed; the transfer on the contract date without a flag; a date after today with the rows on it (from the contract date refused, VC-X-57); CANCELLED 409; the key replayed; a dated DRAFT without a flag',
    { timeout: 120_000 },
    async () => {
      at('2026-11-04');
      const pr = await api.link(PROPERTIES[2] as string);
      const a = await api.party('Käufer D (synthetisch)');
      const { acquisitionId: d } = await api.purchase({
        pr,
        buyers: [a],
        share: '1/1',
        price: '200000.00',
        contract: '2026-03-01',
        transfer: null,
        allocation: ALLOCATION,
      });
      await api.own(pr, a, '1/1', '2026-03-01', d);
      const key = { 'idempotency-key': 'vc-x-52-draft-1' };
      const first = await json(await record(d, { economicTransferDate: '2026-03-01', sourceReferences: ['Kaufvertrag § 5 (synthetisch)'] }, key));
      expect([first.status, first.economicTransferDate, first.transferDate, first.flags]).toEqual(['DRAFT', '2026-03-01', '2026-03-01', []]);
      const replay = await record(d, { economicTransferDate: '2026-03-01', sourceReferences: ['Kaufvertrag § 5 (synthetisch)'] }, key);
      expect([replay.status, replay.headers.get('idempotent-replayed')]).toEqual([200, 'true']);
      expect((await record(d, { economicTransferDate: '2026-04-01', sourceReferences: ['x'] }, key)).status).toBe(409);
      expect((await api.confirm(d)).status).toBe('CONFIRMED');
      // A date after today (Frage 3): accepted; since VC-X-57 (§58R rules 1 and 4, Entscheidung des Projektinhabers,
      // 2026-11-06) the DRAFT is confirmed with its Ownership from the recorded date, not from the contract date.
      const pr2 = await api.link(PROPERTIES[3] as string);
      const { acquisitionId: future } = await api.purchase({
        pr: pr2,
        buyers: [a],
        share: '1/1',
        price: '200000.00',
        contract: '2026-10-01',
        transfer: null,
        allocation: ALLOCATION,
      });
      expect(
        (await json(await record(future, { economicTransferDate: '2027-01-01', sourceReferences: ['Kaufvertrag § 5 (synthetisch)'] }))).economicTransferDate,
      ).toBe('2027-01-01');
      expect((await json(await call('GET', `/acquisitions/${future}`))).transferDate).toBe('2027-01-01');
      await api.own(pr2, a, '1/1', '2027-01-01', future);
      expect((await api.confirm(future)).status).toBe('CONFIRMED');
      // Counter-check (the old expectation): the same DRAFT with its Ownership from the contract date is refused, 422.
      const prOld = await api.link(PROPERTIES[6] as string);
      const { acquisitionId: old } = await api.purchase({
        pr: prOld,
        buyers: [a],
        share: '1/1',
        price: '200000.00',
        contract: '2026-10-01',
        transfer: null,
        allocation: ALLOCATION,
      });
      await api.own(prOld, a, '1/1', '2026-10-01', old);
      await record(old, { economicTransferDate: '2027-01-01', sourceReferences: ['Kaufvertrag § 5 (synthetisch)'] });
      const refused = await json(await call('POST', `/acquisitions/${old}/confirm`, {}), 422);
      expect(codes(refused.error.details.violations)[0]).toBe('OWNERSHIP_NOT_FROM_TRANSFER_DATE');
      expect((await json(await call('GET', `/acquisitions/${old}`))).status).toBe('DRAFT');
      // CANCELLED: 409 ACQUISITION_CANCELLED, also with a stale If-Match.
      const pr3 = await api.link(PROPERTIES[4] as string);
      const { acquisitionId: gone } = await api.purchase({
        pr: pr3,
        buyers: [a],
        share: '1/1',
        price: '200000.00',
        contract: '2026-03-01',
        transfer: null,
        allocation: ALLOCATION,
      });
      await post(`/acquisitions/${gone}/cancel`, { reason: 'geplatzt (synthetisch)' }, 200);
      expect(
        (await json(await record(gone, { economicTransferDate: '2026-03-01', sourceReferences: EVIDENCE }, { 'if-match': '"1"' }), 409)).error.details.reason,
      ).toBe('ACQUISITION_CANCELLED');
      expect(await count(`SELECT count(*) AS n FROM audit_record WHERE entity_id = $1 AND action = 'ECONOMIC_TRANSFER_DATE_RECORDED'`, [gone])).toBe(0);
      // A DRAFT dated later (§58R rule 7, Frage 5): neither the Acquisition's flag nor the year flag, before and after a cancel.
      const pr4 = await api.link(PROPERTIES[5] as string);
      const { acquisitionId: dropped } = await api.purchase({
        pr: pr4,
        buyers: [a],
        share: '1/1',
        price: '200000.00',
        contract: '2026-03-01',
        transfer: null,
        allocation: ALLOCATION,
      });
      const dated = await json(await record(dropped, { economicTransferDate: '2026-05-01', sourceReferences: EVIDENCE }));
      expect([dated.transferDate, dated.flags]).toEqual(['2026-05-01', []]);
      expect(flag(await api.view(pr4, 2026))).toBeUndefined();
      await post(`/acquisitions/${dropped}/cancel`, { reason: 'geplatzt (synthetisch)' }, 200);
      expect(flag(await api.view(pr4, 2026))).toBeUndefined();
      expect((await json(await call('GET', `/acquisitions/${dropped}`))).flags).toEqual([]);
      expect(await count(`SELECT count(*) AS n FROM audit_record WHERE entity_id = $1 AND action = 'ECONOMIC_TRANSFER_DATE_RECORDED'`, [d])).toBe(1);
    },
  );
});
