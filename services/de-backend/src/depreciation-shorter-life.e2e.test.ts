import { describe, expect, it } from 'vitest';
import { PROPERTIES, REALM_B, databaseUrl, totalOf, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-41 Parts 1 and 2 end to end (api-design.md §59G "Tests the implementation must have", "End to end"), through the HTTP
 * API wired as in main.ts, on ACC8's purchase (synthetic: 254,400.00, transfer 2026-07-01, A 3/5, B 2/5): a Stichtag in
 * the first year (1/30 from the start), moved after the first year (the band before its year, nothing from it, the
 * release missing), released (`ADVISOR_CONFIRMED`, evidence, release note), an entry without a Stichtag as stored before
 * 0056 (not computable, never its document date); the history of each amend; no cash, split or classification
 * changed; another Realm neither reads nor writes the entry.
 */
describe.skipIf(databaseUrl === undefined)('the shorter useful life from its Stichtag (VC-X-41 Parts 1 and 2) end to end', () => {
  const api = useAcc8('shorter_life_e2e');
  const { at, post, get, call, schedule, view } = api;

  async function acc8(property: number) {
    at('2026-07-01');
    const pr = await api.link(PROPERTIES[property] as string);
    const [a, b] = [await api.party('Käuferin A'), await api.party('Käufer B')].sort() as [string, string];
    const { acquisitionId: w } = await api.purchase({
      pr,
      buyers: [a, b],
      share: '1/1',
      price: '300000.00',
      contract: '2026-05-20',
      transfer: '2026-07-01',
      costs: [
        ['REAL_ESTATE_TRANSFER_TAX', '15000.00'],
        ['NOTARY', '3000.00'],
        ['FINANCING_RELATED', '1200.00'],
      ],
      allocation: { total: '318000.00', land: '63600.00', building: '254400.00' },
    });
    await api.own(pr, a, '3/5', '2026-07-01', w);
    await api.own(pr, b, '2/5', '2026-07-01', w);
    await api.confirm(w);
    return { pr, a, b, w, building: await api.building(pr, [w]) };
  }
  /** The document dated 2026-08-10, or on the Stichtag when that is later (238-5: never a Stichtag after the document's date). */
  const entry = (w: string, valuationDate: string, extra: Record<string, unknown> = {}) => ({
    acquisitionId: w,
    usefulLifeYears: 30,
    evidence: {
      source: 'Gutachten zur Restnutzungsdauer (synthetisch)',
      date: valuationDate > '2026-08-10' ? valuationDate : '2026-08-10',
      valuationDate,
      documentReference: null,
    },
    reviewState: 'CONFIRMED',
    ...extra,
  });
  const amend = (assetId: string, e: Record<string, unknown>) => post(`/depreciation-assets/${assetId}/amend`, { shorterUsefulLives: [e] }, 200);
  const owners = (s: Json) => s.years.map((y: Json) => [y.year, y.status, y.amount?.amount ?? null, y.owners.map((o: Json) => o.amount?.amount ?? null)]);
  /** Every row of the cash, the splits, the classifications, the purchases and the Ownerships, with its version. */
  const moneyRows = async () => {
    const out: Record<string, unknown> = {};
    for (const table of [
      'ledger_transaction',
      'transaction_split',
      'tax_classification',
      'acquisition',
      'acquisition_cost',
      'land_building_allocation',
      'ownership',
    ]) {
      out[table] = (await api.ctx.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    }
    return JSON.stringify(out);
  };

  it(
    'a Stichtag in the first year, moved after it (band before, nothing from it), released; history kept; no money mutated',
    { timeout: 120_000 },
    async () => {
      const { pr, a, b, w, building } = await acc8(0);
      at('2029-02-15');
      const band = owners(await schedule(building, 'from=2026&to=2029'));
      const bandView2027 = totalOf(await view(pr, 2027), 'AFA_BUILDING');
      const before = await moneyRows();

      // A Stichtag in the first year: 1/30 from 2026-07, as before VC-X-41.
      const fromStart = await amend(building, entry(w, '2026-06-15'));
      expect(fromStart.shorterUsefulLives[0].evidence).toEqual({
        source: 'Gutachten zur Restnutzungsdauer (synthetisch)',
        date: '2026-08-10',
        valuationDate: '2026-06-15',
        documentReference: null,
      });
      const s1 = await schedule(building, 'from=2026&to=2027');
      expect(owners(s1)[0]).toEqual([2026, 'AVAILABLE', '4240.00', ['2544.00', '1696.00']]);
      const shorterFlag = s1.components[0].flags.find((f: Json) => f.code === 'SHORTER_USEFUL_LIFE');
      expect([shorterFlag?.details.method, shorterFlag?.details.lastMonth]).toEqual(['FROM_START', '2056-06']);

      // The Stichtag moved after the first year (only CONFIRMED): the band's years exactly as without an entry, nothing
      // from 2028 (never 0.00) while the release is missing (§59G Part 2: with the declared AfA per owner).
      await amend(building, entry(w, '2028-03-01'));
      const s2 = await schedule(building, 'from=2026&to=2029');
      expect(owners(s2).slice(0, 2)).toEqual(band.slice(0, 2));
      expect(owners(s2).slice(2)).toEqual([
        [2028, 'DEPRECIATION_NOT_AVAILABLE', null, [null, null]],
        [2029, 'DEPRECIATION_NOT_AVAILABLE', null, [null, null]],
      ]);
      const reasons2028 = s2.components[0].years.find((y: Json) => y.year === 2028).owners[0].reasons;
      expect(reasons2028.map((r: Json) => [r.code, r.details.missing ?? null])).toEqual([
        ['SHORTER_USEFUL_LIFE_RELEASE_MISSING', ['ADVISOR_CONFIRMED', 'EVIDENCE', 'RELEASE_NOTE', 'DECLARED_AFA']],
      ]);
      // The tax-year view: 2027 unchanged against the band (the schedule is unaffected there), 2028 not available.
      expect(totalOf(await view(pr, 2027), 'AFA_BUILDING')).toBe(bandView2027);
      expect(totalOf(await view(pr, 2027, a), 'AFA_BUILDING')).toBe('3052.80');
      const v2028 = await view(pr, 2028);
      expect([v2028.depreciation.status, v2028.depreciation.gaps.map((g: Json) => [g.code, g.details.reasons])]).toEqual([
        'DEPRECIATION_NOT_AVAILABLE',
        [['SHORTER_USEFUL_LIFE_RELEASE_MISSING', ['SHORTER_USEFUL_LIFE_RELEASE_MISSING']]],
      ]);

      // Released by the advisor with evidence and a release note: only the declared AfA per owner is still missing.
      const advisor = await api.party('Steuerberatung S');
      const releasedEntry = (extra: Record<string, unknown> = {}) =>
        entry(w, '2028-03-01', {
          reviewState: 'ADVISOR_CONFIRMED',
          advisorPartyId: advisor,
          releaseNote: 'Restwertmethode freigegeben, Steuerberatung, 2029-02-01 (synthetisch)',
          evidence: {
            source: 'Gutachten zur Restnutzungsdauer (synthetisch)',
            date: '2028-03-01',
            valuationDate: '2028-03-01',
            documentReference: 'Gutachten Nr. 0000-SYN',
          },
          ...extra,
        });
      const released = await amend(building, releasedEntry());
      expect(released.shorterUsefulLives[0]).toMatchObject({ reviewState: 'ADVISOR_CONFIRMED', releaseNote: expect.stringContaining('Restwertmethode') });
      const s3 = await schedule(building, 'from=2028&to=2028');
      expect(s3.components[0].years[0].owners[0].reasons.map((r: Json) => [r.code, r.details.missing])).toEqual([
        ['SHORTER_USEFUL_LIFE_RELEASE_MISSING', ['DECLARED_AFA']],
      ]);

      // §59G Part 2: each owner's declared AfA through 2027 recorded and matching (A 1,526.40 + 3,052.80, B 1,017.60 +
      // 2,035.20): from 2028-01 each owner's carried-forward residual value over 30 years (A 148,060.80 / 30, B 98,707.20 / 30).
      const declared = (amountA: string) => [
        { partyId: a, throughYear: 2027, amount: { amount: amountA, currency: 'EUR' }, evidenceReference: 'Steuerbescheide 2026–2027 (synthetisch)' },
        { partyId: b, throughYear: 2027, amount: { amount: '3052.80', currency: 'EUR' }, evidenceReference: 'Steuerbescheide 2026–2027 (synthetisch)' },
      ];
      const withDeclared = await amend(building, releasedEntry({ declaredAfa: declared('4579.20') }));
      expect(withDeclared.shorterUsefulLives[0].declaredAfa.map((r: Json) => [r.partyId, r.throughYear, r.amount.amount])).toEqual(
        [
          [a, 2027, '4579.20'],
          [b, 2027, '3052.80'],
        ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
      const s4 = await schedule(building, 'from=2026&to=2029');
      expect(owners(s4).slice(0, 2)).toEqual(band.slice(0, 2));
      const amountsOf = (s: Json, year: number) =>
        s.components[0].years.find((y: Json) => y.year === year).owners.map((o: Json) => [o.ownerPartyId, o.amount?.amount ?? null]);
      expect(Object.fromEntries(amountsOf(s4, 2028))).toEqual({ [a]: '4935.36', [b]: '3290.24' });
      expect(s4.components[0].rate.shorterUsefulLife).toMatchObject({ method: 'FROM_EVIDENCE_YEAR', fromYear: 2028, lastMonth: '2057-12' });
      expect(s4.components[0].years.find((y: Json) => y.year === 2028).rate).toEqual({ kind: 'SHORTER_USEFUL_LIFE', annualFraction: '97/3000' });
      expect(totalOf(await view(pr, 2028), 'AFA_BUILDING')).toBe('8225.60');
      // One cent off for A: A's years from 2028 not computable (DECLARED_AFA_DIFFERS, both amounts), B's computed.
      await amend(building, releasedEntry({ declaredAfa: declared('4579.21') }));
      const s5 = await schedule(building, 'from=2028&to=2028');
      const ownerA = s5.components[0].years[0].owners.find((o: Json) => o.ownerPartyId === a);
      expect(ownerA.reasons).toEqual([
        {
          code: 'DECLARED_AFA_DIFFERS',
          details: {
            acquisitionId: w,
            throughYear: 2027,
            declaredAfa: { amount: '4579.21', currency: 'EUR' },
            computedAfa: { amount: '4579.20', currency: 'EUR' },
          },
        },
      ]);
      expect(Object.fromEntries(amountsOf(s5, 2028))).toEqual({ [a]: null, [b]: '3290.24' });
      expect(s5.years[0].amount).toBeNull();

      // History: one AuditRecord per amend, each with the entry's old and new values; nothing overwritten.
      const records = (await api.ctx.pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [building]))
        .rows as { action: string; metadata: Json }[];
      expect(records.map((r) => r.action)).toEqual(['CREATED', 'AMENDED', 'AMENDED', 'AMENDED', 'AMENDED', 'AMENDED']);
      expect(
        records
          .slice(1)
          .map((r) => [r.metadata.changedEntries[0].from?.evidence.valuationDate ?? null, r.metadata.changedEntries[0].to.evidence.valuationDate]),
      ).toEqual([
        [null, '2026-06-15'],
        ['2026-06-15', '2028-03-01'],
        ['2028-03-01', '2028-03-01'],
        ['2028-03-01', '2028-03-01'],
        ['2028-03-01', '2028-03-01'],
      ]);
      expect(records[3]?.metadata.changedEntries[0]).toMatchObject({
        from: { reviewState: 'CONFIRMED', releaseNote: null },
        to: { reviewState: 'ADVISOR_CONFIRMED', releaseNote: expect.stringContaining('Restwertmethode') },
      });
      // §59G Part 2: the declared AfA in the history, from none to A's 4,579.20 and then to 4,579.21.
      expect(records.slice(4).map((r) => r.metadata.changedEntries[0].to.declaredAfa.find((x: Json) => x.partyId === a).amount.amount)).toEqual([
        '4579.20',
        '4579.21',
      ]);
      expect(records[4]?.metadata.changedEntries[0].from.declaredAfa).toEqual([]);
      // No cash, split, classification, purchase or Ownership row changed by any of it.
      expect(await moneyRows()).toBe(before);
    },
  );

  it(
    'an entry without a Stichtag (as stored before 0056): not computable in every year, its document date never read as one; amended, it computes',
    { timeout: 60_000 },
    async () => {
      const { w, building } = await acc8(1);
      at('2027-03-01');
      await amend(building, entry(w, '2026-06-15'));
      // The row as 0056 leaves an entry stored before it (the guard stops every write without a Stichtag, so the fixture lifts it).
      await api.ctx.pool.query(`ALTER TABLE depreciation_asset_useful_life DISABLE TRIGGER depreciation_asset_useful_life_valuation_date`);
      await api.ctx.pool.query(`UPDATE depreciation_asset_useful_life SET valuation_date = NULL WHERE asset_id = $1`, [building]);
      await api.ctx.pool.query(`ALTER TABLE depreciation_asset_useful_life ENABLE TRIGGER depreciation_asset_useful_life_valuation_date`);
      const read = await get(`/depreciation-assets/${building}`);
      expect(read.shorterUsefulLives[0].evidence).toMatchObject({ date: '2026-08-10', valuationDate: null });
      const s = await schedule(building, 'from=2026&to=2027');
      expect([s.components[0].status, s.components[0].reasons]).toEqual([
        'NOT_COMPUTABLE',
        [{ code: 'USEFUL_LIFE_VALUATION_DATE_MISSING', details: { acquisitionId: w, evidenceDate: '2026-08-10' } }],
      ]);
      expect(s.years.map((y: Json) => y.amount)).toEqual([null, null]);
      // 238-5 does not judge a legacy entry: an amend that does not restate the list passes, the entry still without its Stichtag.
      const noted = await post(`/depreciation-assets/${building}/amend`, { notes: 'Altbestand (synthetisch)' }, 200);
      expect(noted.shorterUsefulLives[0].evidence).toMatchObject({ date: '2026-08-10', valuationDate: null });
      // Restating the entry with its Stichtag is a change (its state reset unless named): here named, so it computes again.
      await amend(building, entry(w, '2026-06-15'));
      expect((await schedule(building, 'from=2026&to=2026')).years[0].amount.amount).toBe('4240.00');
    },
  );

  it('§59G Part 2: the declared AfA at the boundary: 400 per field, 422 DECLARED_AFA_NOT_APPLICABLE, another Realm’s owner 404, nothing written', async () => {
    const { a, w, building } = await acc8(4);
    at('2029-02-15');
    const row = (extra: Record<string, unknown> = {}) => ({
      partyId: a,
      throughYear: 2027,
      amount: { amount: '4579.20', currency: 'EUR' },
      evidenceReference: 'Steuerbescheide 2026–2027 (synthetisch)',
      ...extra,
    });
    const send = (declaredAfa: unknown, valuationDate = '2028-03-01', options = {}) =>
      call('POST', `/depreciation-assets/${building}/amend`, { shorterUsefulLives: [entry(w, valuationDate, { declaredAfa })] }, options);
    const lives = async () => JSON.stringify((await api.ctx.pool.query(`SELECT * FROM depreciation_asset_useful_life ORDER BY asset_id`)).rows);
    const audits = async () => (await api.ctx.pool.query(`SELECT count(*)::int AS n FROM audit_record`)).rows[0].n as number;
    const foreign = await call('POST', '/parties', { partyType: 'PERSON', displayName: 'Fremde Partei' }, { realm: REALM_B });
    const foreignId = ((await foreign.json()) as Json).partyId as string;
    const [lives0, audits0] = [await lives(), await audits()];
    for (const [body, field, code] of [
      [[row({ amount: { amount: '-0.01', currency: 'EUR' } })], 'shorterUsefulLives.0.declaredAfa.0.amount.amount', 'NEGATIVE_AMOUNT'],
      [[row({ evidenceReference: ' ' })], 'shorterUsefulLives.0.declaredAfa.0.evidenceReference', null],
      [[row({ throughYear: 1999 })], 'shorterUsefulLives.0.declaredAfa.0.throughYear', 'OUT_OF_RANGE'],
      [[row(), row()], 'shorterUsefulLives.0.declaredAfa.1.partyId', 'DUPLICATE'],
      [[{ ...row(), note: 'x' }], 'shorterUsefulLives.0.declaredAfa.0', null],
    ] as const) {
      const res = await send(body);
      const text = JSON.stringify(await res.json());
      expect([res.status, text.includes(field), code === null || text.includes(code)]).toEqual([400, true, true]);
    }
    // A Stichtag in the contract year (2026): the entry applies from the start, so no declared AfA belongs to it.
    const refused = await send([row()], '2026-06-15');
    expect([refused.status, ((await refused.json()) as Json).error]).toEqual([
      422,
      {
        code: 'DECLARED_AFA_NOT_APPLICABLE',
        message: "A declared AfA belongs only to a shorter useful life whose valuationDate lies after its Acquisition's contract year.",
        details: { index: 0, acquisitionId: w, valuationDate: '2026-06-15', contractDate: '2026-05-20' },
      },
    ]);
    // An owner of another Realm is not found; the asset itself from another Realm is 404 too.
    const notFound = await send([row({ partyId: foreignId })]);
    expect([notFound.status, ((await notFound.json()) as Json).error.details]).toEqual([404, { partyId: foreignId }]);
    expect((await send([row()], '2028-03-01', { realm: REALM_B })).status).toBe(404);
    expect([await lives(), await audits()]).toEqual([lives0, audits0]);
    // Counter-check: the valid body is accepted and read back.
    const ok = await send([row()]);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Json).shorterUsefulLives[0].declaredAfa).toEqual([row()]);
  });

  it('Realm isolation: another Realm can neither read nor amend the entry; a body without a Stichtag is 400 REQUIRED', async () => {
    const { w, building } = await acc8(2);
    await amend(building, entry(w, '2026-06-15'));
    expect((await call('GET', `/depreciation-assets/${building}`, undefined, { realm: REALM_B })).status).toBe(404);
    expect((await call('POST', `/depreciation-assets/${building}/amend`, { shorterUsefulLives: [entry(w, '2030-01-01')] }, { realm: REALM_B })).status).toBe(
      404,
    );
    expect((await get(`/depreciation-assets/${building}`)).shorterUsefulLives[0].evidence.valuationDate).toBe('2026-06-15');
    const { valuationDate: _v, ...withoutStichtag } = entry(w, 'x').evidence;
    const res = await call('POST', `/depreciation-assets/${building}/amend`, { shorterUsefulLives: [{ ...entry(w, 'x'), evidence: withoutStichtag }] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('shorterUsefulLives.0.evidence.valuationDate');
  });

  it(
    'decisions 238-3, 238-4, 238-5: an unreleased late evidence accepted on the evidence date, one day later refused 422 on create and amend, nothing written, another Realm 404 first',
    { timeout: 120_000 },
    async () => {
      const { pr, w, building } = await acc8(3);
      at('2029-02-15');
      const NOTE = 'Restwertmethode freigegeben, Steuerberatung, 2029-02-01 (synthetisch)';
      const late = (valuationDate: string, date: string, extra: Record<string, unknown> = {}) =>
        entry(w, valuationDate, { reviewState: 'UNREVIEWED', ...extra, evidence: { ...entry(w, valuationDate).evidence, date } });
      const createBody = (e: Record<string, unknown>) => ({
        propertyReferenceId: pr,
        buildingCompletionYear: 1995,
        reviewState: 'CONFIRMED',
        sourceReferences: ['Gutachten zur Restnutzungsdauer (synthetisch)'],
        shorterUsefulLives: [e],
      });
      const audits = async () => (await api.ctx.pool.query(`SELECT count(*)::int AS n FROM audit_record`)).rows[0].n as number;
      const assets = async () => (await api.ctx.pool.query(`SELECT id, version FROM depreciation_asset ORDER BY id`)).rows;
      const lives = async () => (await api.ctx.pool.query(`SELECT * FROM depreciation_asset_useful_life ORDER BY asset_id`)).rows;
      const keys = async () => (await api.ctx.pool.query(`SELECT count(*)::int AS n FROM idempotency_key`)).rows[0].n as number;
      const before = await moneyRows();

      // 238-5 on create: a Stichtag one day after the document's date is a structural 422, judged once the PropertyReference
      // is found and before the other checks (it has an ACTIVE building, which would be 409); nothing written, the key not kept.
      const [audits0, assets0, lives0, keys0] = [await audits(), await assets(), await lives(), await keys()];
      const refused = await call('POST', '/depreciation-assets', createBody(late('2028-03-02', '2028-03-01')), {
        headers: { 'idempotency-key': 'x41b-refused-create' },
      });
      expect([refused.status, ((await refused.json()) as Json).error]).toEqual([
        422,
        {
          code: 'VALUATION_DATE_AFTER_EVIDENCE_DATE',
          message: "A shorter useful life's valuationDate must not lie after its evidence's date.",
          details: { index: 0, acquisitionId: w, valuationDate: '2028-03-02', evidenceDate: '2028-03-01' },
        },
      ]);
      expect([await audits(), await assets(), await lives(), await keys()]).toEqual([audits0, assets0, lives0, keys0]);

      // Equal dates are allowed; 238-4: a late evidence, unconfirmed and not released, is accepted on create; 238-1: its
      // release note is accepted before any confirmation.
      await post(`/depreciation-assets/${building}/void`, { reason: 'Neu erfasst (synthetisch)' }, 200);
      const created = await post('/depreciation-assets', createBody(late('2028-03-01', '2028-03-01', { releaseNote: NOTE })));
      expect(created.shorterUsefulLives[0]).toMatchObject({
        reviewState: 'UNREVIEWED',
        releaseNote: NOTE,
        evidence: { date: '2028-03-01', valuationDate: '2028-03-01' },
      });
      const assetId = created.assetId as string;
      await api.methods(assetId, [w]);
      // 238-4 on amend: CONFIRMED, without its own documentReference and without a release note, accepted (200).
      await amend(assetId, late('2028-03-01', '2028-03-01', { reviewState: 'CONFIRMED' }));
      // 238-3: the asset's sourceReferences name a Gutachten, yet EVIDENCE stays missing: only the entry's own reference counts.
      const s = await schedule(assetId, 'from=2026&to=2028');
      const reasons2028 = s.components[0].years.find((y: Json) => y.year === 2028).owners[0].reasons;
      expect(reasons2028.map((r: Json) => [r.code, r.details.missing ?? null])).toEqual([
        ['SHORTER_USEFUL_LIFE_RELEASE_MISSING', ['ADVISOR_CONFIRMED', 'EVIDENCE', 'RELEASE_NOTE', 'DECLARED_AFA']],
      ]);
      const band = owners(s).slice(0, 2);

      // 238-5 on amend: moving the Stichtag one day after the document, or the document one day before it, is 422;
      // the asset, its entry, its version, the history and the schedule stay as they were.
      const current = await get(`/depreciation-assets/${assetId}`);
      const [audits1, assets1, lives1] = [await audits(), await assets(), await lives()];
      for (const moved of [late('2028-03-02', '2028-03-01', { reviewState: 'CONFIRMED' }), late('2028-03-01', '2028-02-29', { reviewState: 'CONFIRMED' })]) {
        const res = await call(
          'POST',
          `/depreciation-assets/${assetId}/amend`,
          { shorterUsefulLives: [moved] },
          { headers: { 'if-match': `"${current.version}"` } },
        );
        expect([res.status, ((await res.json()) as Json).error.code]).toEqual([422, 'VALUATION_DATE_AFTER_EVIDENCE_DATE']);
      }
      expect([await audits(), await assets(), await lives()]).toEqual([audits1, assets1, lives1]);
      expect(owners(await schedule(assetId, 'from=2026&to=2028')).slice(0, 2)).toEqual(band);
      // Counter-check: the same amend on the evidence date passes (a no-op here, the entry being unchanged).
      expect((await amend(assetId, late('2028-03-01', '2028-03-01', { reviewState: 'CONFIRMED' }))).version).toBe(current.version);

      // Realm isolation: another Realm gets 404 first, for a valid body and for the refused one alike; nothing written.
      for (const body of [late('2028-03-01', '2028-03-01'), late('2028-03-02', '2028-03-01')]) {
        expect((await call('POST', `/depreciation-assets/${assetId}/amend`, { shorterUsefulLives: [body] }, { realm: REALM_B })).status).toBe(404);
      }
      expect([await audits(), await assets(), await lives()]).toEqual([audits1, assets1, lives1]);
      // 238-3 with an advisor: ADVISOR_CONFIRMED and a release note, the asset's sourceReferences but no own reference:
      // EVIDENCE missing beside the declared AfA; with its own documentReference only the declared AfA (Part 2).
      const advisor = await api.party('Steuerberatung S');
      const byAdvisor = { reviewState: 'ADVISOR_CONFIRMED', advisorPartyId: advisor, releaseNote: NOTE };
      await amend(assetId, late('2028-03-01', '2028-03-01', byAdvisor));
      const missing2028 = async () =>
        (await schedule(assetId, 'from=2028&to=2028')).components[0].years[0].owners[0].reasons.map((r: Json) => [r.code, r.details.missing ?? null]);
      expect(await missing2028()).toEqual([['SHORTER_USEFUL_LIFE_RELEASE_MISSING', ['EVIDENCE', 'DECLARED_AFA']]]);
      const own = late('2028-03-01', '2028-03-01', byAdvisor);
      await amend(assetId, { ...own, evidence: { ...own.evidence, documentReference: 'Gutachten Nr. 0000-SYN' } });
      expect(await missing2028()).toEqual([['SHORTER_USEFUL_LIFE_RELEASE_MISSING', ['DECLARED_AFA']]]);
      // The band years are the same in every step: no amount moved by any decision.
      expect(owners(await schedule(assetId, 'from=2026&to=2028')).slice(0, 2)).toEqual(band);
      // No cash, split, classification, purchase or Ownership row changed by any of it.
      expect(await moneyRows()).toBe(before);
    },
  );
});
