import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AcquisitionCancelledError, AcquisitionNotFoundError, OwnershipBasisIncompleteError, type PrincipalVerifier } from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-2-09 HTTP contract (api-design.md §27.4). */
const REALM = '64b0c0ffee0000000000000a';
const ACQ = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const eur = (amount: string) => Money.of(amount, 'EUR');
const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });
let server: Server | undefined;

async function start(commands: CommandOverrides): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith(commands) }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const get = (base: string, path: string) => fetch(`${base}/api/v1${path}`, { headers: { authorization: 'Bearer a.b.c', organizationid: REALM } });

describe('GET /api/v1/acquisitions/{id}/owner-allocation', () => {
  it('200 with owners (fractions as n/d, costs by category) and totals', async () => {
    const base = await start({
      ownerAllocation: {
        get: async () => ({
          kind: 'ALLOCATED',
          basis: 'CONFIRMED',
          allocationId: null,
          owners: [
            {
              ownerPartyId: 'p1',
              ownershipId: 'o1',
              share: { numerator: 1n, denominator: 2n },
              weight: { numerator: 1n, denominator: 1n },
              purchasePrice: eur('300000.00'),
              costs: new Map([['NOTARY', eur('4000.00')]]),
              costsTotal: eur('4000.00'),
              landAmount: null,
              buildingAmount: null,
              totalAllocableAmount: null,
            },
          ],
          totals: {
            purchasePrice: eur('300000.00'),
            costs: new Map([['NOTARY', eur('4000.00')]]),
            costsTotal: eur('4000.00'),
            landAmount: null,
            buildingAmount: null,
            totalAllocableAmount: null,
          },
        }),
      },
    });
    const res = await get(base, `/acquisitions/${ACQ}/owner-allocation`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      acquisitionId: ACQ,
      basis: 'CONFIRMED',
      allocationId: null,
      owners: [
        {
          ownerPartyId: 'p1',
          ownershipId: 'o1',
          share: '1/2',
          weight: '1/1',
          purchasePrice: { amount: '300000.00', currency: 'EUR' },
          costs: { NOTARY: { amount: '4000.00', currency: 'EUR' } },
          costsTotal: { amount: '4000.00', currency: 'EUR' },
          landAmount: null,
          buildingAmount: null,
          totalAllocableAmount: null,
        },
      ],
      totals: {
        purchasePrice: { amount: '300000.00', currency: 'EUR' },
        costs: { NOTARY: { amount: '4000.00', currency: 'EUR' } },
        costsTotal: { amount: '4000.00', currency: 'EUR' },
        landAmount: null,
        buildingAmount: null,
        totalAllocableAmount: null,
      },
    });
  });

  it('404, 409 ACQUISITION_CANCELLED, 409 OWNERSHIP_BASIS_INCOMPLETE with the violations, 400', async () => {
    const errors: unknown[] = [
      new AcquisitionNotFoundError(ACQ),
      new AcquisitionCancelledError(ACQ),
      new OwnershipBasisIncompleteError(ACQ, [
        { code: 'SHARE_SUM_MISMATCH', expected: { numerator: 1n, denominator: 1n }, actual: { numerator: 1n, denominator: 2n } },
      ]),
    ];
    const base = await start({
      ownerAllocation: {
        get: async () => {
          throw errors.shift();
        },
      },
    });
    const path = `/acquisitions/${ACQ}/owner-allocation`;
    expect((await get(base, path)).status).toBe(404);
    expect(await (await get(base, path)).json()).toMatchObject({ error: { code: 'CONFLICT', details: { reason: 'ACQUISITION_CANCELLED' } } });
    expect(await (await get(base, path)).json()).toMatchObject({
      error: {
        code: 'CONFLICT',
        details: { reason: 'OWNERSHIP_BASIS_INCOMPLETE', violations: [{ code: 'SHARE_SUM_MISMATCH', expected: '1/1', actual: '1/2' }] },
      },
    });
    expect((await get(base, `${path}?asOf=2026-01-01`)).status).toBe(400);
    expect((await get(base, '/acquisitions/x/owner-allocation')).status).toBe(400);
  });
});
