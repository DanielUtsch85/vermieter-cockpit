import type pg from 'pg';
import type { Express } from 'express';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl, PHASE_2, PROPERTY, REALM_A, REALM_B, routesOf, TENANT, usePhase2App } from './phase-2-acceptance.test-support.js';

/**
 * VC-2-10: the Phase-2 exit of `docs/roadmap.md` as one acceptance run through the HTTP API (ACC2,
 * invariant-suite.md §15), wired as in main.ts: an acquisition with purchase price, transaction costs and a
 * land/building split drives the owner-level allocation; ownership changes over time are queryable; ownership shares
 * are validated; every Phase-2 route is Realm-isolated; every write leaves its AuditRecord. The second case (VC-X-30,
 * §28.1A) is in `phase-2-ownership-change.e2e.test.ts`; the setup is in `phase-2-acceptance.test-support.ts`.
 */
describe.skipIf(databaseUrl === undefined)('Phase 2 acceptance (roadmap exit)', () => {
  const { ctx, call, json, eur, cents } = usePhase2App('phase_2_e2e');
  let pool: pg.Pool;
  let app: Express;
  beforeAll(() => {
    ({ pool, app } = ctx);
  });

  it('runs the Phase-2 exit end to end: acquisition, owner-level allocation, ownership over time, validation, isolation, audit', async () => {
    const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);

    // The property and its parties: Sven sells to Anna and Ben; Carl comes later; the notary is a counterparty.
    const { propertyReferenceId } = await json<{ propertyReferenceId: string }>(
      await A('POST', '/property-references/link', { mreRealmId: REALM_A, mrePropertyId: PROPERTY }),
      201,
    );
    const party = async (displayName: string, partyType = 'PERSON') =>
      (await json<{ partyId: string }>(await A('POST', '/parties', { partyType, displayName }), 201)).partyId;
    const sven = await party('Sven Verkäufer');
    const anna = await party('Anna Käuferin');
    const ben = await party('Ben Käufer');
    const carl = await party('Carl Dritter');
    const notary = await party('Notariat Dr. Weber', 'ORGANIZATION');
    // The ownerPartyId tie-break: with 1/2 each, the odd cent of every column goes to the smaller id.
    const [first, second] = [anna, ben].sort() as [string, string];

    // Ownership over time, part 1: Sven holds 1/1 since 2020.
    const svens = await json<{ ownershipId: string }>(
      await A('POST', '/ownerships', { propertyReferenceId, ownerPartyId: sven, share: '1/1', validFrom: '2020-01-01' }),
      201,
    );

    // The acquisition draft: 300,000.00 for the whole property, transferred on 2026-08-01.
    const draft = await json<{ acquisitionId: string; status: string; transferDate: string; acquiredShare: string }>(
      await A(
        'POST',
        '/acquisitions',
        {
          propertyReferenceId,
          purchasePrice: eur('300000.00'),
          acquiredShare: '1/1',
          contractDate: '2026-06-15',
          economicTransferDate: '2026-08-01',
          buyerPartyIds: [anna, ben],
          sellerPartyIds: [sven],
        },
        { 'idempotency-key': 'acc2-acquisition' },
      ),
      201,
    );
    expect(draft).toMatchObject({ status: 'DRAFT', transferDate: '2026-08-01', acquiredShare: '1/1' });
    const acquisition = `/acquisitions/${draft.acquisitionId}`;

    // Share validation, part 1: neither the allocation nor the confirmation runs on a draft without its Ownerships.
    const incomplete = await json<{ error: { details: { reason: string; violations: { code: string }[] } } }>(
      await A('GET', `${acquisition}/owner-allocation`),
      409,
    );
    expect(incomplete.error.details.reason).toBe('OWNERSHIP_BASIS_INCOMPLETE');
    const blocked = await json<{ error: { code: string; details: { violations: { code: string }[] } } }>(await A('POST', `${acquisition}/confirm`, {}), 422);
    expect(blocked.error.code).toBe('CONFIRMATION_BLOCKED');
    expect(blocked.error.details.violations).toEqual([
      // Buyers in id order.
      { code: 'BUYER_WITHOUT_OWNERSHIP', partyId: first },
      { code: 'BUYER_WITHOUT_OWNERSHIP', partyId: second },
      { code: 'SHARE_SUM_MISMATCH', expected: '1/1', actual: '0/1', byBuyer: [] },
    ]);
    expect(incomplete.error.details.violations).toEqual(blocked.error.details.violations);

    // Transaction costs: the transfer tax, an odd notary amount, a wrong broker fee voided and entered again.
    const cost = async (category: string, amount: string, extra: Record<string, unknown> = {}) =>
      (
        await json<{ costId: string }>(
          await A('POST', `${acquisition}/costs`, { category, amount: eur(amount), ...extra }, { 'idempotency-key': `acc2-${category}-${amount}` }),
          201,
        )
      ).costId;
    const tax = await cost('REAL_ESTATE_TRANSFER_TAX', '18000.00', { incurredDate: '2026-07-01' });
    const notaryFee = await cost('NOTARY', '1234.57', { counterpartyPartyId: notary });
    const wrongBroker = await cost('BROKER', '10000.00');
    expect(await json(await A('POST', `${acquisition}/costs/${wrongBroker}/void`, { reason: 'Courtage falsch erfasst' }), 200)).toMatchObject({
      status: 'VOID',
    });
    const broker = await cost('BROKER', '10710.00');

    // A confirmed bank Transaction pays the price and the tax; the rest of the costs stay expected.
    const { financialAccountId } = await json<{ financialAccountId: string }>(
      await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Anderkonto', currency: 'EUR' }),
      201,
    );
    const { transactionId } = await json<{ transactionId: string }>(
      await A('POST', '/transactions', {
        financialAccountId,
        amount: eur('318000.00'),
        direction: 'OUTFLOW',
        bookingDate: '2026-07-30',
        description: 'Kaufpreis und Grunderwerbsteuer',
      }),
      201,
    );
    await json(
      await A('PUT', `/transactions/${transactionId}/splits`, {
        splits: [{ amount: eur('318000.00'), financialCategoryCode: 'ACQUISITION', propertyReferenceId }],
      }),
      200,
    );
    await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
    const pricePayment = await json<{ paymentId: string; counting: boolean }>(
      await A('POST', `${acquisition}/payments`, { transactionId, amount: eur('300000.00') }, { 'idempotency-key': 'acc2-pay-price' }),
      201,
    );
    expect(pricePayment.counting).toBe(true);
    await json(
      await A('POST', `${acquisition}/payments`, { transactionId, acquisitionCostId: tax, amount: eur('18000.00') }, { 'idempotency-key': 'acc2-pay-tax' }),
      201,
    );
    // The Transaction is used up: one cent more is refused.
    const exceeding = await json<{ error: { details: { reason: string } } }>(
      await A('POST', `${acquisition}/payments`, { transactionId, acquisitionCostId: notaryFee, amount: eur('0.01') }),
      409,
    );
    expect(exceeding.error.details.reason).toBe('PAYMENT_EXCEEDS_TRANSACTION');
    expect(await json(await A('GET', `${acquisition}/payments`), 200)).toMatchObject({
      purchasePrice: { amount: eur('300000.00'), paidAmount: eur('300000.00'), paymentStatus: 'PAID' },
      items: [{}, {}],
    });
    const costs = await json<{ items: { costId: string; status: string; paymentStatus: string | null }[] }>(await A('GET', `${acquisition}/costs`), 200);
    expect(costs.items.map((c) => [c.costId, c.status, c.paymentStatus])).toEqual([
      [tax, 'ACTIVE', 'PAID'],
      [notaryFee, 'ACTIVE', 'EXPECTED'],
      [wrongBroker, 'VOID', null],
      [broker, 'ACTIVE', 'EXPECTED'],
    ]);

    // The land/building split: entered from the contract, then corrected with the BMF tool (supersede).
    const allocation = (body: Record<string, unknown>, key: string) =>
      A('POST', `${acquisition}/land-building-allocation`, { reviewState: 'UNREVIEWED', ...body }, { 'idempotency-key': key });
    const entered = await json<{ allocationId: string }>(
      await allocation(
        {
          totalAllocableAmount: eur('300000.00'),
          landAmount: eur('60000.00'),
          buildingAmount: eur('240000.00'),
          method: 'PURCHASE_CONTRACT',
          supersedes: null,
        },
        'acc2-alloc-1',
      ),
      201,
    );
    const corrected = await json<{ allocationId: string; current: boolean }>(
      await allocation(
        {
          totalAllocableAmount: eur('329944.57'),
          landAmount: eur('82486.15'),
          buildingAmount: eur('247458.42'),
          method: 'BMF_TOOL',
          supersedes: entered.allocationId,
        },
        'acc2-alloc-2',
      ),
      201,
    );
    expect(corrected.current).toBe(true);
    // A second correction naming the old one is refused: it is no longer current.
    expect(
      (
        await allocation(
          { totalAllocableAmount: eur('1.00'), landAmount: eur('0.00'), buildingAmount: eur('1.00'), method: 'OTHER', supersedes: entered.allocationId },
          'acc2-alloc-x',
        )
      ).status,
    ).toBe(409);
    const history = await json<{ current: { allocationId: string }; items: { allocationId: string; current: boolean; supersededById: string | null }[] }>(
      await A('GET', `${acquisition}/land-building-allocations`),
      200,
    );
    expect(history.current.allocationId).toBe(corrected.allocationId);
    expect(history.items.map((a) => [a.allocationId, a.current, a.supersededById])).toEqual([
      [corrected.allocationId, true, null],
      [entered.allocationId, false, corrected.allocationId],
    ]);

    // Ownership over time, part 2: one atomic change on the transfer date (WF-002).
    const change = await json<{
      closed: { ownershipId: string; validUntil: string }[];
      created: { ownershipId: string; ownerPartyId: string; share: string; acquisitionId: string }[];
      completeness: string;
    }>(
      await A(
        'POST',
        `/property-references/${propertyReferenceId}/ownership-changes`,
        {
          effectiveDate: '2026-08-01',
          reason: 'Verkauf an Anna und Ben',
          close: [svens.ownershipId],
          create: [
            { ownerPartyId: anna, share: '1/2' },
            { ownerPartyId: ben, share: '1/2' },
          ],
          acquisitionId: draft.acquisitionId,
        },
        { 'idempotency-key': 'acc2-change' },
      ),
      201,
    );
    expect(change.closed).toEqual([expect.objectContaining({ ownershipId: svens.ownershipId, validUntil: '2026-07-31' })]);
    expect(change.created.map((o) => [o.ownerPartyId, o.share, o.acquisitionId])).toEqual(
      expect.arrayContaining([
        [anna, '1/2', draft.acquisitionId],
        [ben, '1/2', draft.acquisitionId],
      ]),
    );
    expect(change.completeness).toBe('COMPLETE');
    const annas = change.created.find((o) => o.ownerPartyId === anna)?.ownershipId ?? '';

    // Share validation, part 2: a third half on the transfer date would sum to 3/2; nothing is written.
    const ownershipsBefore = await pool.query(`SELECT count(*) FROM ownership`);
    const overShare = await json<{ error: { code: string; details: unknown } }>(
      await A('POST', '/ownerships', { propertyReferenceId, ownerPartyId: carl, share: '1/2', validFrom: '2026-08-01' }),
      422,
    );
    expect(overShare.error).toMatchObject({ code: 'OWNERSHIP_TOTAL_EXCEEDS_ONE', details: { date: '2026-08-01', shareSum: '3/2' } });
    expect((await pool.query(`SELECT count(*) FROM ownership`)).rows).toEqual(ownershipsBefore.rows);

    // With its structure in place the draft previews as PROVISIONAL; then it is confirmed, once.
    expect(await json(await A('GET', `${acquisition}/owner-allocation`), 200)).toMatchObject({ basis: 'PROVISIONAL' });
    expect(await json(await A('POST', `${acquisition}/confirm`, {}), 200)).toMatchObject({ status: 'CONFIRMED', version: 2 });
    const again = await A('POST', `${acquisition}/confirm`, {});
    expect(again.status).toBe(200);
    expect(again.headers.get('idempotent-replayed')).toBe('true');

    // It drives the owner-level allocation: 1/2 each, every column exact to the cent, the odd cent by ownerPartyId.
    type Money = { amount: string; currency: string };
    type Part = {
      ownerPartyId: string;
      ownershipId: string;
      share: string;
      shareBefore: string;
      acquiredShare: string;
      weight: string;
      purchasePrice: Money;
      costs: Record<string, Money>;
      costsTotal: Money;
      landAmount: Money;
      buildingAmount: Money;
      totalAllocableAmount: Money;
    };
    const split = await json<{
      basis: string;
      allocationId: string;
      owners: Part[];
      totals: Omit<Part, 'ownerPartyId' | 'ownershipId' | 'share' | 'shareBefore' | 'acquiredShare' | 'weight'>;
    }>(await A('GET', `${acquisition}/owner-allocation`), 200);
    expect(split).toMatchObject({ basis: 'CONFIRMED', allocationId: corrected.allocationId });
    const expected = (owner: string, odd: boolean) => ({
      ownerPartyId: owner,
      ownershipId: change.created.find((o) => o.ownerPartyId === owner)?.ownershipId,
      share: '1/2',
      // Neither held a share the day before: the full share is bought (§28.1A).
      shareBefore: '0/1',
      acquiredShare: '1/2',
      weight: '1/2',
      purchasePrice: eur('150000.00'),
      costs: { BROKER: eur('5355.00'), NOTARY: eur(odd ? '617.29' : '617.28'), REAL_ESTATE_TRANSFER_TAX: eur('9000.00') },
      costsTotal: eur(odd ? '14972.29' : '14972.28'),
      landAmount: eur(odd ? '41243.08' : '41243.07'),
      buildingAmount: eur('123729.21'),
      totalAllocableAmount: eur(odd ? '164972.29' : '164972.28'),
    });
    expect(split.owners).toEqual([expected(first, true), expected(second, false)]);
    expect(split.totals).toEqual({
      purchasePrice: eur('300000.00'),
      costs: { BROKER: eur('10710.00'), NOTARY: eur('1234.57'), REAL_ESTATE_TRANSFER_TAX: eur('18000.00') },
      costsTotal: eur('29944.57'),
      landAmount: eur('82486.15'),
      buildingAmount: eur('247458.42'),
      totalAllocableAmount: eur('329944.57'),
    });
    // Every column sums exactly to its total; each owner's totals are the sum of their parts (F4b).
    const sum = (values: Money[]) => values.reduce((s, m) => s + cents(m), 0n);
    for (const column of ['purchasePrice', 'costsTotal', 'landAmount', 'buildingAmount', 'totalAllocableAmount'] as const) {
      expect(sum(split.owners.map((o) => o[column])), column).toBe(cents(split.totals[column]));
    }
    for (const category of Object.keys(split.totals.costs)) {
      expect(sum(split.owners.map((o) => o.costs[category] as Money)), category).toBe(cents(split.totals.costs[category] as Money));
    }
    for (const o of split.owners) {
      expect(sum(Object.values(o.costs))).toBe(cents(o.costsTotal));
      expect(cents(o.landAmount) + cents(o.buildingAmount)).toBe(cents(o.totalAllocableAmount));
    }

    // Ownership over time, part 3: queryable before, on and after the transfer date, and as a history.
    const owners = async (asOf: string) => {
      const day = await json<{ completeness: string; shareSum: string; items: { ownerPartyId: string; share: string }[] }>(
        await A('GET', `/property-references/${propertyReferenceId}/ownerships?asOf=${asOf}`),
        200,
      );
      return { completeness: day.completeness, shareSum: day.shareSum, owners: day.items.map((o) => `${o.ownerPartyId}:${o.share}`).sort() };
    };
    expect(await owners('2026-07-31')).toEqual({ completeness: 'COMPLETE', shareSum: '1/1', owners: [`${sven}:1/1`] });
    expect(await owners('2026-08-01')).toEqual({ completeness: 'COMPLETE', shareSum: '1/1', owners: [`${anna}:1/2`, `${ben}:1/2`].sort() });
    expect(await owners('2030-01-01')).toEqual({ completeness: 'COMPLETE', shareSum: '1/1', owners: [`${anna}:1/2`, `${ben}:1/2`].sort() });
    expect(await owners('2019-12-31')).toEqual({ completeness: 'NONE', shareSum: '0/1', owners: [] });
    const all = await json<{ items: { ownerPartyId: string; validFrom: string; validUntil: string | null; status: string }[]; total: number }>(
      await A('GET', `/property-references/${propertyReferenceId}/ownerships`),
      200,
    );
    expect(all.total).toBe(3);
    expect(all.items.map((o) => `${o.ownerPartyId} ${o.validFrom}..${o.validUntil ?? ''} ${o.status}`).sort()).toEqual(
      [`${sven} 2020-01-01..2026-07-31 VALID`, `${anna} 2026-08-01.. VALID`, `${ben} 2026-08-01.. VALID`].sort(),
    );

    // Share validation, part 3: the confirmed purchase is final; its Ownerships cannot be voided, the Acquisition not cancelled.
    const voided = await json<{ error: { details: unknown } }>(await A('POST', `/ownerships/${annas}/void`, { reason: 'Versehen' }), 409);
    expect(voided.error.details).toMatchObject({ reason: 'ACQUISITION_CONFIRMED', acquisitionId: draft.acquisitionId });
    const cancelled = await json<{ error: { details: unknown } }>(await A('POST', `${acquisition}/cancel`, { reason: 'x' }), 409);
    expect(cancelled.error.details).toMatchObject({ reason: 'ACQUISITION_CONFIRMED' });

    // Realm isolation: every Phase-2 route, given Realm A's ids, answers Realm B with 404 and writes nothing.
    const { externalReferenceId } = await json<{ externalReferenceId: string }>(
      await A('POST', `/parties/${anna}/external-references`, { system: 'MRE', entityType: 'tenant', mreRealmId: REALM_A, externalId: TENANT }),
      201,
    );
    const ids: Record<string, string> = {
      partyId: anna,
      externalReferenceId,
      ownershipId: annas,
      propertyReferenceId,
      acquisitionId: draft.acquisitionId,
      costId: notaryFee,
      paymentId: pricePayment.paymentId,
    };
    type Row = { readonly expect: 404 | 'EMPTY_LIST' | 'OWN_REALM'; readonly body?: unknown };
    const routes: Record<string, Row> = {
      'POST /parties': { expect: 'OWN_REALM', body: { partyType: 'PERSON', displayName: 'Bea aus B' } },
      'GET /parties': { expect: 'EMPTY_LIST' },
      'GET /parties/:partyId': { expect: 404 },
      'POST /parties/:partyId/amend': { expect: 404, body: { phone: '0171' } },
      'POST /parties/:partyId/deactivate': { expect: 404, body: { reason: 'x' } },
      'POST /parties/:partyId/external-references': { expect: 404, body: { system: 'MRE', entityType: 'tenant', mreRealmId: REALM_B, externalId: TENANT } },
      'POST /parties/:partyId/external-references/:externalReferenceId/end': { expect: 404 },
      'GET /parties/:partyId/external-references': { expect: 404 },
      'POST /ownerships': { expect: 404, body: { propertyReferenceId, ownerPartyId: carl, share: '1/2', validFrom: '2031-01-01' } },
      'GET /ownerships/:ownershipId': { expect: 404 },
      'POST /ownerships/:ownershipId/close': { expect: 404, body: { validUntil: '2030-12-31' } },
      'POST /ownerships/:ownershipId/void': { expect: 404, body: { reason: 'x' } },
      'POST /property-references/:propertyReferenceId/ownership-changes': {
        expect: 404,
        body: { effectiveDate: '2031-01-01', reason: 'x', close: [annas], create: [{ ownerPartyId: carl, share: '1/2' }] },
      },
      'GET /property-references/:propertyReferenceId/ownerships': { expect: 404 },
      'POST /acquisitions': {
        expect: 404,
        body: { propertyReferenceId, purchasePrice: eur('1.00'), contractDate: '2031-01-01', buyerPartyIds: [carl] },
      },
      'GET /acquisitions': { expect: 'EMPTY_LIST' },
      'GET /acquisitions/:acquisitionId': { expect: 404 },
      'POST /acquisitions/:acquisitionId/cancel': { expect: 404, body: { reason: 'x' } },
      'POST /acquisitions/:acquisitionId/confirm': { expect: 404, body: {} },
      'GET /property-references/:propertyReferenceId/acquisitions': { expect: 404 },
      'GET /acquisitions/:acquisitionId/owner-allocation': { expect: 404 },
      'POST /acquisitions/:acquisitionId/land-building-allocation': {
        expect: 404,
        body: { totalAllocableAmount: eur('1.00'), landAmount: eur('0.00'), buildingAmount: eur('1.00'), method: 'OTHER', supersedes: corrected.allocationId },
      },
      'GET /acquisitions/:acquisitionId/land-building-allocations': { expect: 404 },
      'POST /acquisitions/:acquisitionId/costs': { expect: 404, body: { category: 'OTHER', amount: eur('1.00') } },
      'POST /acquisitions/:acquisitionId/costs/:costId/void': { expect: 404, body: { reason: 'x' } },
      'GET /acquisitions/:acquisitionId/costs': { expect: 404 },
      'POST /acquisitions/:acquisitionId/payments': { expect: 404, body: { transactionId, acquisitionCostId: notaryFee, amount: eur('1.00') } },
      'POST /acquisitions/:acquisitionId/payments/:paymentId/unlink': { expect: 404, body: { reason: 'x' } },
      'GET /acquisitions/:acquisitionId/payments': { expect: 404 },
    };
    // The table is the app's Phase-2 routes, no more and no fewer: a new route without a row turns this red.
    expect(Object.keys(routes).sort()).toEqual(
      routesOf(app)
        .filter((route) => PHASE_2.test(route))
        .sort(),
    );

    // "Writes nothing" is checked by the AuditRecord count: every write writes one (P2-D11), so a write slipping
    // through for Realm B would raise it.
    const auditBefore = await pool.query(`SELECT count(*) FROM audit_record`);
    const own: string[] = [];
    // Creating rows last, so Realm B's own lists are still empty when read.
    const ordered = Object.entries(routes).sort(([, x], [, y]) => Number(x.expect === 'OWN_REALM') - Number(y.expect === 'OWN_REALM'));
    for (const [route, row] of ordered) {
      const [method = '', template = ''] = route.split(' ');
      const path = template.replace(/:(\w+)/g, (_, name: string) => ids[name] ?? `missing-${name}`);
      const res = await call(REALM_B, method, path, row.body);
      if (row.expect === 404) {
        expect(res.status, route).toBe(404);
        expect(((await res.json()) as { error: { code: string } }).error.code, route).toBe('NOT_FOUND');
      } else if (row.expect === 'EMPTY_LIST') {
        expect(await json(res, 200), route).toMatchObject({ items: [], total: 0 });
      } else {
        // Takes no id: what it creates belongs to Realm B, and Realm A cannot see it.
        own.push((await json<{ partyId: string }>(res, 201)).partyId);
      }
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_record`)).rows[0].n).toBe(Number(auditBefore.rows[0].count) + own.length);
    for (const partyId of own) expect((await A('GET', `/parties/${partyId}`)).status).toBe(404);

    // After confirmation a later sale still ends Anna's Ownership: close is allowed.
    expect(await json(await A('POST', `/ownerships/${annas}/close`, { validUntil: '2030-12-31' }), 200)).toMatchObject({
      validUntil: '2030-12-31',
      status: 'VALID',
    });

    // Traceability: every Phase-2 write of the acquisition left its AuditRecord.
    const audit = await pool.query<{ entity_type: string; entity_id: string; action: string }>(
      `SELECT entity_type, entity_id, action FROM audit_record
       WHERE entity_type IN ('Acquisition', 'AcquisitionCost', 'AcquisitionPayment', 'LandBuildingAllocation')`,
    );
    const key = (r: { entity_type: string; entity_id: string; action: string }) => `${r.entity_type} ${r.entity_id} ${r.action}`;
    const taxPayment = (
      await json<{ items: { paymentId: string; acquisitionCostId: string | null }[] }>(await A('GET', `${acquisition}/payments`), 200)
    ).items.find((p) => p.acquisitionCostId === tax)?.paymentId;
    expect(audit.rows.map(key).sort()).toEqual(
      [
        `Acquisition ${draft.acquisitionId} CREATED`,
        `Acquisition ${draft.acquisitionId} CONFIRMED`,
        `AcquisitionCost ${tax} CREATED`,
        `AcquisitionCost ${notaryFee} CREATED`,
        `AcquisitionCost ${wrongBroker} CREATED`,
        `AcquisitionCost ${wrongBroker} VOIDED`,
        `AcquisitionCost ${broker} CREATED`,
        `AcquisitionPayment ${pricePayment.paymentId} LINKED`,
        `AcquisitionPayment ${taxPayment} LINKED`,
        `LandBuildingAllocation ${entered.allocationId} CREATED`,
        `LandBuildingAllocation ${entered.allocationId} SUPERSEDED`,
        `LandBuildingAllocation ${corrected.allocationId} CREATED`,
      ].sort(),
    );
  });
});
