import { describe, expect, it } from 'vitest';
import { PROPERTIES, REALM_B, databaseUrl, eur, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-34 end to end over HTTP (api-design.md §58K "Example (synthetic)"; tax review of 2026-11-01, questions 3 and 14,
 * mündlich bestätigt durch den Steuerberater, laut Projektinhaber am 2026-11-01; Entscheidung des Projektinhabers,
 * 2026-11-04, K1–K5): Q with contract 2026-02-01 and no `economicTransferDate` is refused by `confirm` (K4), confirmed
 * as legacy data past the repository; its check is `NOT_COMPUTABLE` (`TRANSFER_DATE_MISSING`), P's views of 2026–2029
 * and later list it, 2025 does not, a capitalisation on it is `422`; Q′ with transfer 2026-03-15 is computed as before.
 * The repair 40,000.00, performed 2026-05-04 – 06-30. History, unchanged money, Realm isolation. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('the anschaffungsnahe check without economicTransferDate end to end (VC-X-34)', () => {
  const api = useAcc8('tax_year_transfer_date_e2e');
  const { at, call, json, classify, booked } = api;
  const purchase = async (index: number, transfer: string | null) => {
    const pr = await api.link(PROPERTIES[index] as string);
    const owner = await api.party(`Eigentümerin ${index} (synthetisch)`);
    const { acquisitionId } = await api.purchase({
      pr,
      buyers: [owner],
      share: '1/1',
      price: '300000.00',
      contract: '2026-02-01',
      transfer,
      allocation: { total: '300000.00', land: '60000.00', building: '240000.00' },
    });
    await api.own(pr, owner, '1/1', transfer ?? '2026-02-01', acquisitionId);
    return { pr, owner, acquisitionId };
  };
  /** Legacy data (§58N open question 7): confirmed before VC-X-34 without the date, inserted as CONFIRMED. */
  const legacyPurchase = async (index: number) => {
    const pr = await api.link(PROPERTIES[index] as string);
    const owner = await api.party(`Eigentümerin ${index} (synthetisch)`);
    const { acquisitionId } = await api.legacy({
      pr,
      buyers: [{ partyId: owner, share: '1/1' }],
      share: '1/1',
      price: '300000.00',
      contract: '2026-02-01',
      allocation: { total: '300000.00', land: '60000.00', building: '240000.00' },
    });
    return { pr, owner, acquisitionId };
  };
  const repairOf = async (pr: string) => {
    const account = await api.account();
    const [s] = await booked(account, 'OUTFLOW', '2026-07-10', [{ amount: eur('40000.00'), financialCategoryCode: 'MAINTENANCE', propertyReferenceId: pr }]);
    const classificationId = await classify({
      sourceId: s,
      taxCategory: 'MAINTENANCE',
      treatment: 'DEDUCTIBLE',
      netAmount: eur('40000.00'),
      performance: { from: '2026-05-04', until: '2026-06-30' },
      sourceReferences: ['Rechnung des Handwerkers (synthetisch)'],
    });
    return { s: s as string, classificationId };
  };
  const capitalise = (sourceId: string, supersedes: string, acquisitionId: string) =>
    call('POST', '/tax-classifications', {
      sourceType: 'TRANSACTION_SPLIT',
      sourceId,
      taxCategory: 'MAINTENANCE',
      treatment: 'CAPITALIZED',
      reviewState: 'USER_CONFIRMED',
      anschaffungsnaheAcquisitionId: acquisitionId,
      sourceReferences: ['Rechnung des Handwerkers (synthetisch)'],
      netAmount: eur('40000.00'),
      performance: { from: '2026-05-04', until: '2026-06-30' },
      supersedes,
    });
  const money = (v: Json) => [
    v.einnahmen.total,
    v.werbungskosten.total,
    v.werbungskosten.lines.map((l: Json) => [l.line, l.total]),
    v.result,
    v.capitalized.total,
  ];
  const count = async (sql: string, params: unknown[] = []) => Number((await api.ctx.pool.query(sql, params)).rows[0].n);

  it(
    'the example of §58K: confirm refused, the check NOT_COMPUTABLE, every year from 2026 listed, the capitalisation 422; Q′ as before; money, history, Realm',
    { timeout: 120_000 },
    async () => {
      at('2026-03-01');
      // K4: the record without the transfer date is incomplete and is not confirmed; nothing written (a DRAFT of its own).
      const { acquisitionId: undatedDraft } = await purchase(4, null);
      const acquisitionRow = async (id: string) => (await api.ctx.pool.query(`SELECT to_jsonb(a) AS row FROM acquisition a WHERE id = $1`, [id])).rows;
      const draftRow = await acquisitionRow(undatedDraft);
      const refused = await json(await call('POST', `/acquisitions/${undatedDraft}/confirm`, {}), 422);
      expect(refused.error).toMatchObject({
        code: 'CONFIRMATION_BLOCKED',
        details: { violations: [{ code: 'TRANSFER_DATE_MISSING', contractDate: '2026-02-01' }] },
      });
      expect(await acquisitionRow(undatedDraft)).toEqual(draftRow);
      expect(
        await count(`SELECT count(*) AS n FROM audit_record WHERE entity_type = 'Acquisition' AND entity_id = $1 AND action = 'CONFIRMED'`, [undatedDraft]),
      ).toBe(0);
      // Legacy data: confirmed before VC-X-34; since 0067 (§58N) inserted as CONFIRMED, never through the transition.
      const { pr: p, acquisitionId: q } = await legacyPurchase(0);
      const { pr: p2, acquisitionId: q2 } = await purchase(1, '2026-03-15');
      await api.confirm(q2);
      at('2026-10-30');
      const r = await repairOf(p);
      const r2 = await repairOf(p2);
      const cashBefore = await api.cashRows();
      const auditsBefore = await count(`SELECT count(*) AS n FROM audit_record`);

      const check = await api.check(q);
      expect(check).toMatchObject({
        acquisitionId: q,
        transferDate: null,
        window: null,
        searchRange: null,
        outerBound: null,
        rule: null,
        status: 'NOT_COMPUTABLE',
        notComputableReason: 'TRANSFER_DATE_MISSING',
        threshold: null,
        percentOfBasis: null,
        affectedYears: null,
        sources: [],
        excluded: [],
        unclassified: [],
        undetermined: [],
        outsideSearchRange: [],
        final: false,
      });
      expect([check.sum.amount, check.sumUpper.amount, check.basis.basisAmount.amount]).toEqual(['0.00', '0.00', '240000.00']);
      expect(check.flags).toEqual([
        { code: 'NOT_FINAL', details: { reasons: ['TRANSFER_DATE_MISSING'] } },
        { code: 'TRANSFER_DATE_MISSING', details: { contractDate: '2026-02-01' } },
      ]);
      expect('contractDate' in check).toBe(false);
      // Q′: from the transfer, ABOVE_THRESHOLD (40,000.00 > 36,000.00), the repair suggested.
      const dated = await api.check(q2);
      expect([
        dated.status,
        dated.transferDate,
        dated.window,
        dated.sum.amount,
        dated.threshold.amount,
        dated.sources.map((e: Json) => e.suggestedTreatment),
      ]).toEqual(['ABOVE_THRESHOLD', '2026-03-15', { from: '2026-03-15', until: '2029-03-15' }, '40000.00', '36000.00', ['CAPITALIZED']]);

      // The views: 2025 without Q; 2026–2029 and 2035 with it; Q′ only 2026–2029.
      expect((await api.view(p, 2025)).acquisitions).toEqual([]);
      for (const year of [2026, 2027, 2028, 2029, 2035]) {
        const v = await api.view(p, year);
        expect(v.acquisitions).toEqual([
          {
            acquisitionId: q,
            transferDate: null,
            window: null,
            status: 'NOT_COMPUTABLE',
            final: false,
            notFinalReasons: ['TRANSFER_DATE_MISSING'],
            href: `/api/v1/acquisitions/${q}/anschaffungsnahe-herstellungskosten`,
          },
        ]);
        expect(v.flags.find((f: Json) => f.code === 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL').details).toEqual({ acquisitionIds: [q] });
        expect(v.review.final).toBe(false);
      }
      for (const [year, listed] of [
        [2025, []],
        [2026, [q2]],
        [2029, [q2]],
        [2030, []],
      ] as const) {
        expect((await api.view(p2, year)).acquisitions.map((a: Json) => a.acquisitionId)).toEqual(listed);
      }
      // Unchanged money: the repair stays DEDUCTIBLE on MAINTENANCE 40,000.00 in 2026, the same in both views.
      const [v2026, w2026] = [await api.view(p, 2026), await api.view(p2, 2026)];
      expect(money(v2026)).toEqual(money(w2026));
      expect(v2026.werbungskosten.lines.find((l: Json) => l.taxCategory === 'MAINTENANCE').total.amount).toBe('40000.00');
      // Reading the check and the views wrote no row.
      expect(await count(`SELECT count(*) AS n FROM audit_record`)).toBe(auditsBefore);
      expect(await api.cashRows()).toEqual(cashBefore);

      // The capitalisation on Q: 422 ANSCHAFFUNGSNAHE_NOT_APPLICABLE (TRANSFER_DATE_MISSING), nothing stored; on Q′ 201.
      const classifications = () => count(`SELECT count(*) AS n FROM tax_classification`);
      const before = await classifications();
      const notApplicable = await json(await capitalise(r.s, r.classificationId, q), 422);
      expect(notApplicable.error).toMatchObject({ code: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE', details: { reason: 'TRANSFER_DATE_MISSING', acquisitionId: q } });
      expect(await classifications()).toBe(before);
      const capitalised = await json(await capitalise(r2.s, r2.classificationId, q2), 201);
      expect(capitalised.anschaffungsnaheAcquisitionId).toBe(q2);
      // History: the accepted one a TAX_CLASSIFIED, the superseded one a TAX_CLASSIFICATION_SUPERSEDED; none for the refused.
      const actions = async (splitId: string) =>
        (
          await api.ctx.pool.query(
            `SELECT action FROM audit_record WHERE entity_type = 'TaxClassification'
               AND entity_id IN (SELECT id::text FROM tax_classification WHERE transaction_split_id = $1) ORDER BY occurred_at, action`,
            [splitId],
          )
        ).rows.map((row) => row.action);
      expect(await actions(r.s)).toEqual(['TAX_CLASSIFIED']);
      expect((await actions(r2.s)).sort()).toEqual(['TAX_CLASSIFIED', 'TAX_CLASSIFIED', 'TAX_CLASSIFICATION_SUPERSEDED'].sort());
      expect(await api.cashRows()).toEqual(cashBefore);

      // Realm isolation: Realm B reads neither check nor view of Realm A, and cannot confirm Q′.
      expect((await call('GET', `/acquisitions/${q}/anschaffungsnahe-herstellungskosten`, undefined, { realm: REALM_B })).status).toBe(404);
      expect((await call('GET', `/property-references/${p}/tax-years/2026`, undefined, { realm: REALM_B })).status).toBe(404);
      expect((await call('POST', `/acquisitions/${q}/confirm`, {}, { realm: REALM_B })).status).toBe(404);
    },
  );

  it(
    'the transfer on the contract date: confirm accepted, the check computed from that day; an already confirmed undated one is a no-op',
    { timeout: 60_000 },
    async () => {
      at('2026-03-01');
      const pr = await api.link(PROPERTIES[2] as string);
      const owner = await api.party('Eigentümer C (synthetisch)');
      const { acquisitionId } = await api.purchase({
        pr,
        buyers: [owner],
        share: '1/1',
        price: '300000.00',
        contract: '2026-02-01',
        transfer: '2026-02-01',
        allocation: { total: '300000.00', land: '60000.00', building: '240000.00' },
      });
      await api.own(pr, owner, '1/1', '2026-02-01', acquisitionId);
      expect((await api.confirm(acquisitionId)).status).toBe('CONFIRMED');
      const check = await api.check(acquisitionId);
      expect([check.status, check.transferDate, check.window, check.notComputableReason]).toEqual([
        'NOT_ABOVE_THRESHOLD',
        '2026-02-01',
        { from: '2026-02-01', until: '2029-02-01' },
        null,
      ]);
      // Status first (§28.1's order): a legacy Acquisition already confirmed answers 200 unchanged, whatever its date.
      const { acquisitionId: legacy } = await legacyPurchase(3);
      const replay = await call('POST', `/acquisitions/${legacy}/confirm`, {});
      expect([replay.status, replay.headers.get('idempotent-replayed')]).toEqual([200, 'true']);
    },
  );
});
