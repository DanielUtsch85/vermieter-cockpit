import { describe, expect, it } from 'vitest';
import { databaseUrl, PROPERTY_X30, REALM_A, usePhase2App } from './phase-2-acceptance.test-support.js';

/**
 * VC-X-30 (§28.1A), the second case of the Phase-2 acceptance (ACC2, invariant-suite.md §15) through the HTTP API on a
 * second property of the fake MRE: an existing owner buys the other half; the §26.2 change, the confirmation, §27.4 and
 * the guard end to end. Independent of the exit run in `phase-2-acceptance.e2e.test.ts`, in a schema of its own; the
 * setup is in `phase-2-acceptance.test-support.ts`.
 */
describe.skipIf(databaseUrl === undefined)('Phase 2 acceptance (roadmap exit): VC-X-30', () => {
  const { call, json, eur } = usePhase2App('phase_2_x30_e2e');

  it('VC-X-30 (§28.1A): an existing owner buys the other half; the change, the confirmation, §27.4 and the guard end to end', async () => {
    const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
    const { propertyReferenceId } = await json<{ propertyReferenceId: string }>(
      await A('POST', '/property-references/link', { mreRealmId: REALM_A, mrePropertyId: PROPERTY_X30 }),
      201,
    );
    const party = async (displayName: string) =>
      (await json<{ partyId: string }>(await A('POST', '/parties', { partyType: 'PERSON', displayName }), 201)).partyId;
    const anna = await party('Anna Erstkäuferin');
    const bernd = await party('Bernd Miteigentümer');
    const purchase = async (body: Record<string, unknown>, key: string) =>
      (await json<{ acquisitionId: string }>(await A('POST', '/acquisitions', { propertyReferenceId, ...body }, { 'idempotency-key': key }), 201))
        .acquisitionId;

    // W: Anna buys 1/2 in 2024; Bernd holds the other half.
    const w = await purchase(
      { purchasePrice: eur('180000.00'), acquiredShare: '1/2', contractDate: '2024-02-01', economicTransferDate: '2024-03-01', buyerPartyIds: [anna] },
      'x30-w',
    );
    const o1 = (
      await json<{ ownershipId: string }>(
        await A('POST', '/ownerships', { propertyReferenceId, ownerPartyId: anna, share: '1/2', validFrom: '2024-03-01', acquisitionId: w }),
        201,
      )
    ).ownershipId;
    const o2 = (
      await json<{ ownershipId: string }>(
        await A('POST', '/ownerships', { propertyReferenceId, ownerPartyId: bernd, share: '1/2', validFrom: '2024-03-01' }),
        201,
      )
    ).ownershipId;
    await json(await A('POST', `/acquisitions/${w}/confirm`, {}), 200);

    // X: Anna buys Bernd's half; one §26.2 change at the transfer date: O1 and O2 end on 2026-07-31, O3 = Anna 1/1 with X.
    const x = await purchase(
      {
        purchasePrice: eur('200000.00'),
        acquiredShare: '1/2',
        contractDate: '2026-06-15',
        economicTransferDate: '2026-08-01',
        buyerPartyIds: [anna],
        sellerPartyIds: [bernd],
      },
      'x30-x',
    );
    const change = await json<{ created: { ownershipId: string }[]; completeness: string }>(
      await A(
        'POST',
        `/property-references/${propertyReferenceId}/ownership-changes`,
        {
          effectiveDate: '2026-08-01',
          reason: 'Kauf des Anteils von Bernd',
          close: [o1, o2],
          create: [{ ownerPartyId: anna, share: '1/1' }],
          acquisitionId: x,
        },
        { 'idempotency-key': 'x30-change' },
      ),
      201,
    );
    expect(change.completeness).toBe('COMPLETE');
    const o3 = change.created[0]?.ownershipId ?? '';

    const allocation = async () =>
      json<{
        basis: string;
        owners: {
          ownerPartyId: string;
          ownershipId: string;
          share: string;
          shareBefore: string;
          acquiredShare: string;
          weight: string;
          purchasePrice: Money;
        }[];
      }>(await A('GET', `/acquisitions/${x}/owner-allocation`), 200);
    type Money = { amount: string; currency: string };
    const annaPart = {
      ownerPartyId: anna,
      ownershipId: o3,
      share: '1/1',
      shareBefore: '1/2',
      acquiredShare: '1/2',
      weight: '1/1',
      purchasePrice: eur('200000.00'),
    };
    expect(await allocation()).toMatchObject({ basis: 'PROVISIONAL', owners: [annaPart] });
    expect(await json(await A('POST', `/acquisitions/${x}/confirm`, {}), 200)).toMatchObject({ status: 'CONFIRMED' });
    expect(await allocation()).toMatchObject({ basis: 'CONFIRMED', owners: [annaPart] });
    // W is unaffected: Anna held nothing before 2024-03-01, so her weight there is 1/1 of W's half.
    expect(await json(await A('GET', `/acquisitions/${w}/owner-allocation`), 200)).toMatchObject({
      basis: 'CONFIRMED',
      owners: [{ ownerPartyId: anna, ownershipId: o1, share: '1/2', shareBefore: '0/1', acquiredShare: '1/2', weight: '1/1' }],
    });

    // The confirmed increase is fixed: O1 cannot be shortened (the guard of §28.1A) nor voided (W's own, §28.1).
    const shortened = await json<{ error: { code: string; details: unknown } }>(await A('POST', `/ownerships/${o1}/close`, { validUntil: '2026-06-30' }), 409);
    expect(shortened.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'ACQUISITION_CONFIRMED', acquisitionId: x, ownershipId: o3 } });
    const voided = await json<{ error: { details: unknown } }>(await A('POST', `/ownerships/${o1}/void`, { reason: 'Versehen' }), 409);
    expect(voided.error.details).toMatchObject({ reason: 'ACQUISITION_CONFIRMED', acquisitionId: w });
    // The seller's row is not guarded: Bernd's O2 can still be shortened (the days between show as INCOMPLETE).
    expect(await json(await A('POST', `/ownerships/${o2}/close`, { validUntil: '2026-07-30' }), 200)).toMatchObject({ validUntil: '2026-07-30' });
  });
});
