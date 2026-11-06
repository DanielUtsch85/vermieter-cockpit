import { describe, expect, it } from 'vitest';
import { PROPERTIES, REALM_B, databaseUrl, eur, expectOwnersAddUp, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-57 end to end over HTTP (api-design.md §58R "Example (synthetic)"; ADR-044; Entscheidung des Projektinhabers,
 * 2026-11-06, §58R Fragen 1–10): S bought P in 2015 through DE (W); the DRAFT N sells it to A (contract 2025-03-01,
 * created without the date). N dated 2025-05-01 by §58N before any row, the ownership change on the transfer, `confirm`:
 * from the outset S's AfA 800.00 and A's 2,133.33 in 2025, the rent S 4,000.00 / A 8,000.00 / P 12,000.00, no flag,
 * 2024 and 2026 as they are. The old draft N2 (rows from the contract date before the date): 422 with the four
 * violations, aligned by §58Q, confirmed, every figure equal to N's. Legacy L keeps §58N's rule; Realm B 404; no cash
 * row written or changed. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('the Ownerships from the economic transfer on confirm end to end (VC-X-57)', () => {
  const api = useAcc8('acquisition_ownership_start_e2e');
  const { at, call, json, classify, booked, post } = api;
  const DATE_EVIDENCE = ['Übergabeprotokoll 2025-05-01 (synthetisch)'];
  const ALLOCATION_W = { total: '150000.00', land: '30000.00', building: '120000.00' };
  const ALLOCATION_N = { total: '200000.00', land: '40000.00', building: '160000.00' };
  const OLD_FLAG = 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER';
  const NEW_FLAG = 'OWNERSHIP_EXTENDED_TO_ECONOMIC_TRANSFER';
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
  const rentOf = (v: Json, party: string) => v.owners.find((o: Json) => o.ownerPartyId === party)?.einnahmen.total.amount;
  const afaOf = (v: Json, party: string) =>
    v.owners.find((o: Json) => o.ownerPartyId === party)?.werbungskosten.lines.find((l: Json) => l.line === 'AFA_BUILDING')?.total.amount;
  const flagCodes = (v: Json) => v.flags.map((f: Json) => f.code);
  const codes = (list: Json[]) => list.map((e: Json) => e.code);
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
  /** W (S from 2015-07-01) and the DRAFT N (A buys from S, contract 2025-03-01, without the date), the building, the rent. */
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
    at('2025-02-20');
    const { acquisitionId: n } = await api.purchase({
      pr,
      buyers: [a],
      sellers: [s],
      share: '1/1',
      price: '200000.00',
      contract: '2025-03-01',
      transfer: null,
      allocation: ALLOCATION_N,
    });
    const building = await api.building(pr, [w, n]);
    await rent(pr);
    return { pr, s, a, w, n, oS, building };
  }
  const views = async (pr: string) => ({ 2024: await api.view(pr, 2024), 2025: await api.view(pr, 2025), 2026: await api.view(pr, 2026) });
  /** The figures of the three years by role (S, A, P), every id left out (two properties, two sets of rows), as JSON. */
  const figures = (v: Record<number, Json>, s: string, a: string) =>
    JSON.stringify(
      [2024, 2025, 2026].map((y) => [money(v[y]), rentOf(v[y], s) ?? null, rentOf(v[y], a) ?? null, afaOf(v[y], s) ?? null, afaOf(v[y], a) ?? null]),
      (key, value: unknown) => (key.endsWith('Id') ? undefined : value),
    );

  it(
    'N: dated before any row, the change on t, confirmed from the outset: S 800.00, A 2133.33, rent S 4000.00 / A 8000.00 / P 12000.00, no flag; N2 refused, aligned, equal in every figure',
    { timeout: 300_000 },
    async () => {
      const x = await example(0);
      const y = await example(1);
      // Every cash row is booked: from here on no command of the test writes or changes one.
      const cashBefore = await api.cashRows();
      at('2025-04-10');
      const dated = await recordDate(x.n, '2025-05-01');
      // §58R rule 1 branch 3: before the confirmation the recorded date is the start; no §58N flag (Frage 5).
      expect([dated.status, dated.transferDate, dated.flags]).toEqual(['DRAFT', '2025-05-01', []]);
      await post(
        `/property-references/${x.pr}/ownership-changes`,
        { effectiveDate: '2025-05-01', reason: 'Übergang (synthetisch)', close: [x.oS], create: [{ ownerPartyId: x.a, share: '1/1' }], acquisitionId: x.n },
        201,
        { headers: { 'idempotency-key': 'vc-x-57-n' } },
      );
      const confirmed = await api.confirm(x.n);
      expect([confirmed.status, confirmed.transferDate, confirmed.economicTransferDate, confirmed.flags]).toEqual([
        'CONFIRMED',
        '2025-05-01',
        '2025-05-01',
        [],
      ]);
      // §27.1's shape is unchanged: the stored day is shown as transferDate, not as a field of its own (Frage 4).
      expect(Object.keys(confirmed)).not.toContain('confirmedOwnershipStart');
      at('2026-02-01');
      const component = async (id: string) => (await api.schedule(x.building, 'from=2024&to=2026')).components.find((c: Json) => c.acquisitionId === id);
      const year = (c: Json, y: number) => c.years.find((r: Json) => r.year === y)?.amount.amount;
      const [w, n] = [await component(x.w), await component(x.n)];
      expect([year(w, 2024), year(w, 2025), w.owners[0].tenure]).toEqual([
        '2400.00',
        '800.00',
        { from: '2015-07-01', lastDay: '2025-04-30', lastDaySource: 'BUYER_ECONOMIC_TRANSFER_DATE' },
      ]);
      expect([year(n, 2025), year(n, 2026), n.start.date]).toEqual(['2133.33', '3200.00', '2025-05-01']);
      expect(codes(n.flags)).not.toContain(OLD_FLAG);
      const now = await views(x.pr);
      expect([rentOf(now[2025], x.s), rentOf(now[2025], x.a), now[2025].einnahmen.total.amount]).toEqual(['4000.00', '8000.00', '12000.00']);
      expect([afaOf(now[2025], x.s), afaOf(now[2025], x.a)]).toEqual(['800.00', '2133.33']);
      for (const y of [2024, 2025, 2026] as const) {
        expectOwnersAddUp(now[y], `N ${y}`);
        expect(flagCodes(now[y])).not.toContain(OLD_FLAG);
        expect(flagCodes(now[y])).not.toContain(NEW_FLAG);
      }
      // History: reads wrote nothing; the AuditRecord of the confirmation names the day.
      const audits = async () => Number((await api.ctx.pool.query(`SELECT count(*) AS n FROM audit_record`)).rows[0].n);
      const before = await audits();
      await views(x.pr);
      await call('GET', `/acquisitions/${x.n}`);
      expect(await audits()).toBe(before);
      const record = (await api.ctx.pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'CONFIRMED'`, [x.n])).rows;
      expect(record.map((r) => r.metadata.transferDate)).toEqual(['2025-05-01']);
      // §58Q on N: nothing to align.
      expect((await json(await call('POST', `/acquisitions/${x.n}/align-ownerships-to-transfer`, { sourceReferences: ['x'] }), 422)).error.details.reason).toBe(
        'CONFIRMED_FROM_TRANSFER',
      );

      // N2: the rows from the contract date written before the date was recorded.
      at('2025-02-25');
      await post(
        `/property-references/${y.pr}/ownership-changes`,
        { effectiveDate: '2025-03-01', reason: 'Kaufvertrag (synthetisch)', close: [y.oS], create: [{ ownerPartyId: y.a, share: '1/1' }], acquisitionId: y.n },
        201,
        { headers: { 'idempotency-key': 'vc-x-57-n2' } },
      );
      at('2025-04-10');
      await recordDate(y.n, '2025-05-01');
      const refused = await json(await call('POST', `/acquisitions/${y.n}/confirm`, {}), 422);
      expect(refused.error.details.violations.map((v: Json) => v.code)).toEqual([
        'OWNERSHIP_NOT_FROM_TRANSFER_DATE',
        'BUYER_SHARE_NOT_INCREASED',
        'SHARE_SUM_MISMATCH',
        'SELLER_SHARE_CHANGED_BEFORE_TRANSFER',
      ]);
      expect(refused.error.details.violations[3]).toEqual({
        code: 'SELLER_SHARE_CHANGED_BEFORE_TRANSFER',
        partyId: y.s,
        shareOnContractEve: '1/1',
        shareOnTransferEve: '0/1',
      });
      expect((await json(await call('GET', `/acquisitions/${y.n}`))).status).toBe('DRAFT');
      expect(
        (await json(await call('POST', `/acquisitions/${y.n}/align-ownerships-to-transfer`, { sourceReferences: ['Übergabeprotokoll (synthetisch)'] })))
          .acquisition.status,
      ).toBe('DRAFT');
      expect((await api.confirm(y.n)).status).toBe('CONFIRMED');
      at('2026-02-01');
      const repaired = await views(y.pr);
      // One fixture, two paths: every figure by role byte-identical; only §58Q's own flag (the act on a DRAFT) differs.
      expect(figures(repaired, y.s, y.a)).toBe(figures(now, x.s, x.a));
      // Legacy is untouched by the rule: a CONFIRMED L dated by §58N keeps the contract date and its flag.
      const pr3 = await api.link(PROPERTIES[2] as string);
      const l = await api.party('Käufer L (synthetisch)');
      const legacy = await api.legacy({
        pr: pr3,
        buyers: [{ partyId: l, share: '1/1' }],
        share: '1/1',
        price: '200000.00',
        contract: '2025-03-01',
        allocation: ALLOCATION_N,
      });
      const ofL = await recordDate(legacy.acquisitionId, '2025-05-01');
      expect([ofL.transferDate, codes(ofL.flags)]).toEqual(['2025-03-01', [OLD_FLAG]]);
      // Realm B: neither N nor its year; no cash row written or changed.
      expect((await call('GET', `/acquisitions/${x.n}`, undefined, { realm: REALM_B })).status).toBe(404);
      expect((await call('POST', `/acquisitions/${y.n}/confirm`, {}, { realm: REALM_B })).status).toBe(404);
      expect((await call('GET', `/property-references/${x.pr}/tax-years/2025`, undefined, { realm: REALM_B })).status).toBe(404);
      expect(await api.cashRows()).toEqual(cashBefore);
    },
  );
});
