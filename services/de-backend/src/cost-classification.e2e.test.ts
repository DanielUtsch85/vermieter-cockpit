import { describe, expect, it } from 'vitest';
import { PROPERTIES, REALM_B, codes, databaseUrl, eur, useAcc8, type Json } from './phase-8-acceptance.test-support.js';

/**
 * VC-X-42 end to end (api-design.md §59D "Tests the implementation must have"), through the HTTP API against PostgreSQL:
 * a purchase with an `OTHER` cost (the schedule `NOT_COMPUTABLE`, the 15 % check by the bounds), classified `UNREVIEWED`
 * (still unclassified), confirmed `NOT_ACQUISITION_COST` (excluded, computed), superseded by `OWNERSHIP_TRANSFER` (in,
 * the fingerprint changed); a land-charge notary cost classified `FINANCING` (excluded from both bases); Realm
 * isolation. Synthetic figures: price 300,000.00, transfer tax 15,000.00, `OTHER` 3,000.00, notary 2,000.00 (land
 * charge), financing 1,200.00; building 256,000.00 of 320,000.00 (4/5). The clock is set explicitly.
 */
describe.skipIf(databaseUrl === undefined)('acquisition costs in the basis only when classified (§59D) end to end', () => {
  const api = useAcc8('cost_classification_e2e');
  const { at, post, get, call, schedule, check } = api;
  const classify = (w: string, costId: string, parts: readonly (readonly [string, string])[], reviewState: string, supersedes: string | null) =>
    post(`/acquisitions/${w}/costs/${costId}/classifications`, {
      parts: parts.map(([purpose, amount]) => ({ purpose, amount: eur(amount) })),
      description: 'Rechnung (synthetisch)',
      reviewState,
      supersedes,
    });

  it('unclassified, unreviewed, excluded, counted; the land charge out of both bases; Realm isolation', { timeout: 120_000 }, async () => {
    at('2026-07-01');
    const pr = await api.link(PROPERTIES[0] as string);
    const buyer = await api.party('Käuferin A');
    const { acquisitionId: w, costIds } = await api.purchase({
      pr,
      buyers: [buyer],
      share: '1/1',
      price: '300000.00',
      contract: '2026-05-20',
      transfer: '2026-07-01',
      costs: [
        ['REAL_ESTATE_TRANSFER_TAX', '15000.00'],
        ['OTHER', '3000.00'],
        ['NOTARY', '2000.00'],
        ['FINANCING_RELATED', '1200.00'],
      ],
      allocation: { total: '320000.00', land: '64000.00', building: '256000.00' },
      classify: false,
    });
    const [other, notary] = [costIds[1] as string, costIds[2] as string];
    await api.own(pr, buyer, '1/1', '2026-07-01', w);
    await api.confirm(w);
    const building = await api.building(pr, [w]);
    // The notary invoice of the land charge: a financing cost, never in a basis (question 24).
    await classify(w, notary, [['FINANCING', '2000.00']], 'CONFIRMED', null);
    at('2027-02-15');

    // OTHER without a classification: not computable, never 0.00; the basis 252,000.00 = 315,000.00 × 4/5, with it 254,400.00.
    const open = await schedule(building, 'from=2026&to=2026');
    const c0 = open.components[0];
    expect([c0.status, c0.reasons, open.years[0].amount]).toEqual([
      'NOT_COMPUTABLE',
      [{ code: 'ACQUISITION_COST_UNCLASSIFIED', details: { costIds: [other] } }],
      null,
    ]);
    expect(c0.basis).toMatchObject({
      amount: eur('252000.00'),
      basisAmountWithUnclassified: eur('254400.00'),
      acquisitionCosts: eur('15000.00'),
      unclassifiedCosts: [{ costId: other, category: 'OTHER', amount: eur('3000.00'), classificationReviewState: null }],
    });
    expect(c0.basis.excludedCosts).toEqual([
      { category: 'FINANCING_RELATED', purpose: null, amount: eur('1200.00') },
      { category: 'NOTARY', purpose: 'FINANCING', amount: eur('2000.00') },
    ]);
    // The 15 % check by the bounds: nothing summed is not above 15 % of the lower bound, not final.
    const firstCheck = await check(w);
    expect([firstCheck.status, firstCheck.final, firstCheck.threshold, firstCheck.thresholdWithUnclassified]).toEqual([
      'NOT_ABOVE_THRESHOLD',
      false,
      { amount: '37800.00', currency: 'EUR' },
      { amount: '38160.00', currency: 'EUR' },
    ]);
    expect(firstCheck.flags.find((f: Json) => f.code === 'NOT_FINAL').details.reasons).toContain('ACQUISITION_COSTS_UNCLASSIFIED');
    expect(firstCheck.basis).toMatchObject({ basisAmount: eur('252000.00'), basisAmountWithUnclassified: eur('254400.00') });

    // UNREVIEWED: still unclassified; the cost answers its classification.
    const unreviewed = await classify(w, other, [['OWNERSHIP_TRANSFER', '3000.00']], 'UNREVIEWED', null);
    const held = await schedule(building, 'from=2026&to=2026');
    expect([held.components[0].status, held.components[0].basis.unclassifiedCosts[0].classificationReviewState]).toEqual(['NOT_COMPUTABLE', 'UNREVIEWED']);
    const listed = await get(`/acquisitions/${w}/costs`);
    expect(listed.items.find((c: Json) => c.costId === other).classification).toMatchObject({ classificationId: unreviewed.classificationId, current: true });

    // Confirmed NOT_ACQUISITION_COST: excluded, computed: 252,000.00 × 2 % × 6/12 = 2,520.00.
    const excluded = await classify(w, other, [['NOT_ACQUISITION_COST', '3000.00']], 'CONFIRMED', unreviewed.classificationId);
    const computed = await schedule(building, 'from=2026&to=2026');
    expect([computed.components[0].status, computed.components[0].basis.amount, computed.years[0].amount]).toEqual([
      'COMPUTABLE',
      eur('252000.00'),
      eur('2520.00'),
    ]);
    const before = computed.years[0].inputFingerprint;

    // Superseded by OWNERSHIP_TRANSFER: in the basis (254,400.00, 2,544.00), the fingerprint changed; the check's basis too.
    const counted = await classify(w, other, [['OWNERSHIP_TRANSFER', '3000.00']], 'CONFIRMED', excluded.classificationId);
    const after = await schedule(building, 'from=2026&to=2026');
    expect([after.components[0].basis.amount, after.years[0].amount, codes(after.components[0].reasons)]).toEqual([eur('254400.00'), eur('2544.00'), []]);
    expect(after.years[0].inputFingerprint).not.toBe(before);
    const lastCheck = await check(w);
    expect([lastCheck.basis.basisAmount, lastCheck.thresholdWithUnclassified, lastCheck.basis.unclassifiedCosts]).toEqual([eur('254400.00'), null, []]);
    // The history, newest first; a retry without a key is refused by supersedes.
    const history = await get(`/acquisitions/${w}/costs/${other}/classifications`);
    expect(history.items.map((c: Json) => [c.classificationId, c.current])).toEqual([
      [counted.classificationId, true],
      [excluded.classificationId, false],
      [unreviewed.classificationId, false],
    ]);
    expect(
      (
        await call('POST', `/acquisitions/${w}/costs/${other}/classifications`, {
          parts: [{ purpose: 'FINANCING', amount: eur('3000.00') }],
          description: 'x',
          supersedes: excluded.classificationId,
        })
      ).status,
    ).toBe(409);
    // A FINANCING_RELATED cost takes no other purpose.
    const financing = (await get(`/acquisitions/${w}/costs`)).items.find((c: Json) => c.category === 'FINANCING_RELATED').costId;
    const refused = await call('POST', `/acquisitions/${w}/costs/${financing}/classifications`, {
      parts: [{ purpose: 'OWNERSHIP_TRANSFER', amount: eur('1200.00') }],
      description: 'x',
      supersedes: null,
    });
    expect(refused.status).toBe(422);

    // Realm isolation: Realm B sees neither the history nor may it classify.
    const path = `/acquisitions/${w}/costs/${other}/classifications`;
    expect((await call('GET', path, undefined, { realm: REALM_B })).status).toBe(404);
    expect(
      (
        await call(
          'POST',
          path,
          { parts: [{ purpose: 'FINANCING', amount: eur('3000.00') }], description: 'x', supersedes: counted.classificationId },
          { realm: REALM_B },
        )
      ).status,
    ).toBe(404);
    expect((await get(path)).current.classificationId).toBe(counted.classificationId);
  });
});
