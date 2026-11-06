import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcquisitionCancelledError,
  AcquisitionNotFoundError,
  IdempotencyKeyConflictError,
  OwnershipExtensionBlockedError,
  OwnershipExtensionNotApplicableError,
  OwnershipsAlreadyAlignedError,
  VersionConflictError,
  type Acquisition,
  type AlignOwnershipsToTransfer,
  type Ownership,
  type PrincipalVerifier,
} from '../application/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith } from './app.test-support.js';

/**
 * `POST /acquisitions/{id}/align-ownerships-to-transfer` over HTTP (api-design.md §58Q "The command"; Entscheidung des
 * Projektinhabers, 2026-11-05, Fragen 3, 5, 9): the strict body (evidence `REQUIRED`, a `validUntil` key refused as
 * unknown), the id, `If-Match` and `Idempotency-Key` handed on, the answer with X's `ETag`, and the error answers.
 * Synthetic values only.
 */
const REALM = '64b0c0ffee0000000000005c';
const ID = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a55';
const day = (v: string) => v as BusinessDate;
const EVIDENCE = ['Übergabeprotokoll 2025-05-01, Abschnitt 2 (synthetisch)'];
const AT = new Date('2026-02-10T10:00:00Z');
const acquisition = {
  id: ID,
  mreRealmId: REALM,
  propertyReferenceId: '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a55',
  status: 'CONFIRMED',
  purchasePrice: Money.of('200000.00', 'EUR'),
  acquiredShare: { numerator: 1, denominator: 1 },
  contractDate: day('2025-03-01'),
  economicTransferDate: day('2025-05-01'),
  landRegistryTransferDate: null,
  buyerPartyIds: ['2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a55'],
  sellerPartyIds: ['3b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a55'],
  sourceReferences: [],
  notes: null,
  cancelledAt: null,
  cancellationReason: null,
  confirmedAt: new Date('2025-03-05T09:00:00Z'),
  createdAt: new Date('2025-02-20T09:00:00Z'),
  version: 4,
  economicTransferRecordedAt: new Date('2026-01-15T10:00:00Z'),
  economicTransferSourceReferences: ['Übergabeprotokoll (synthetisch)'],
  ownershipAlignedAt: AT,
  ownershipAlignmentSourceReferences: EVIDENCE,
  flags: [],
} as unknown as Acquisition;
const ownership = (id: string, from: string, until: string | null): Ownership =>
  ({
    id,
    mreRealmId: REALM,
    propertyReferenceId: acquisition.propertyReferenceId,
    ownerPartyId: acquisition.sellerPartyIds[0],
    share: { numerator: 1, denominator: 1 },
    validFrom: day(from),
    validUntil: until === null ? null : day(until),
    status: 'VALID',
    voidedAt: null,
    voidReason: null,
    acquisitionId: null,
    sourceReferences: [],
    notes: null,
    createdAt: new Date('2015-07-01T09:00:00Z'),
    version: 2,
  }) as unknown as Ownership;
const result = {
  acquisition,
  extended: [ownership('4b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a55', '2015-07-01', '2025-04-30')],
  moved: [{ ...ownership('5b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a55', '2025-05-01', null), acquisitionId: ID }],
  completeness: 'COMPLETE' as const,
  shareSum: { numerator: 1n, denominator: 1n },
};

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });
let server: Server | undefined;
async function start(align: AlignOwnershipsToTransfer): Promise<string> {
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith({ acquisitions: { alignOwnershipsToTransfer: align } }) }).listen(
    0,
    '127.0.0.1',
  );
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});
const headers = { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json' };
const post = (base: string, body: unknown, extra: Record<string, string> = {}, id = ID) =>
  fetch(`${base}/api/v1/acquisitions/${id}/align-ownerships-to-transfer`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; details?: unknown } }).error;

describe('POST /api/v1/acquisitions/{id}/align-ownerships-to-transfer', () => {
  it('200 with the Acquisition (transferDate = t, ownershipAlignedAt), the extended and moved Ownerships, completeness, shareSum; ETag of X', async () => {
    const seen: unknown[] = [];
    const base = await start(async (input) => {
      seen.push(input);
      return { result, replayed: false };
    });
    const res = await post(
      base,
      { sourceReferences: ['  Übergabeprotokoll 2025-05-01, Abschnitt 2 (synthetisch)  '], notes: '  laut Protokoll  ' },
      { 'if-match': '"3"' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"4"');
    expect(res.headers.get('idempotent-replayed')).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      acquisition: {
        acquisitionId: ID,
        transferDate: '2025-05-01',
        economicTransferDate: '2025-05-01',
        ownershipAlignedAt: '2026-02-10T10:00:00.000Z',
        ownershipAlignmentSourceReferences: EVIDENCE,
        version: 4,
      },
      extended: [{ ownershipId: '4b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a55', validFrom: '2015-07-01', validUntil: '2025-04-30', version: 2 }],
      moved: [{ ownershipId: '5b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a55', validFrom: '2025-05-01', validUntil: null, acquisitionId: ID }],
      completeness: 'COMPLETE',
      shareSum: '1/1',
    });
    expect(Object.keys(body).sort()).toEqual(['acquisition', 'completeness', 'extended', 'moved', 'shareSum']);
    // Texts trimmed; If-Match is X's version; no key without the header.
    expect(seen).toEqual([
      { principal: expect.anything(), acquisitionId: ID, align: { sourceReferences: EVIDENCE, notes: 'laut Protokoll' }, expectedVersions: [3] },
    ]);
  });

  it('the body: the evidence REQUIRED (missing or empty), at most 10 of at most 500, unknown keys (validUntil, validFrom) 400; the id', async () => {
    const base = await start(() => Promise.reject(new Error('not reached')));
    for (const body of [{}, { sourceReferences: [] }]) {
      const res = await post(base, body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).details).toEqual({ fields: [{ field: 'sourceReferences', code: 'REQUIRED' }] });
    }
    for (const body of [
      { sourceReferences: EVIDENCE, validUntil: '2025-04-30' },
      { sourceReferences: EVIDENCE, validFrom: '2025-05-01' },
      { sourceReferences: Array.from({ length: 11 }, () => 'x') },
      { sourceReferences: ['x'.repeat(501)] },
      { sourceReferences: ['   '] },
      { sourceReferences: EVIDENCE, notes: 'x'.repeat(2001) },
    ]) {
      expect((await post(base, body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await post(base, { sourceReferences: EVIDENCE }, {}, 'not-a-uuid')).status).toBe(400);
  });

  it('the key handed on, a replay marked; the answers of the order of checks: 404, 409 cancelled, 409 aligned, 412, 422 not applicable, 422 blocked, 409 key', async () => {
    const keys: unknown[] = [];
    let base = await start(async (input) => {
      keys.push(input.idempotencyKey);
      return { result, replayed: true };
    });
    const replay = await post(base, { sourceReferences: EVIDENCE }, { 'idempotency-key': 'k-55' });
    expect([replay.status, replay.headers.get('idempotent-replayed'), keys]).toEqual([200, 'true', ['k-55']]);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const cases: [Error, number, string, unknown][] = [
      [new AcquisitionNotFoundError(ID), 404, 'NOT_FOUND', { acquisitionId: ID }],
      [new AcquisitionCancelledError(ID), 409, 'CONFLICT', { reason: 'ACQUISITION_CANCELLED', acquisitionId: ID }],
      [
        new OwnershipsAlreadyAlignedError(ID, AT, day('2025-05-01')),
        409,
        'CONFLICT',
        { reason: 'OWNERSHIPS_ALREADY_ALIGNED', acquisitionId: ID, ownershipAlignedAt: '2026-02-10T10:00:00.000Z', ownershipStart: '2025-05-01' },
      ],
      [new VersionConflictError([3], 4), 412, 'VERSION_CONFLICT', undefined],
      [
        new OwnershipExtensionNotApplicableError(ID, 'NO_SELLER_ROW'),
        422,
        'OWNERSHIP_EXTENSION_NOT_APPLICABLE',
        { acquisitionId: ID, reason: 'NO_SELLER_ROW' },
      ],
      [
        new OwnershipExtensionBlockedError(ID, [
          { code: 'BUYER_ROW_ENDS_BEFORE_TRANSFER', ownershipId: 'o1', validUntil: day('2025-03-31') },
          { code: 'OWNERSHIP_TOTAL_EXCEEDS_ONE', date: day('2025-03-01'), shareSum: { numerator: 3n, denominator: 2n } },
          {
            code: 'CONFIRMATION_REQUIREMENTS',
            violations: [{ code: 'OWNERSHIP_INCOMPLETE', date: day('2025-05-01'), shareSum: { numerator: 1n, denominator: 2n } }],
          },
        ]),
        422,
        'OWNERSHIP_EXTENSION_BLOCKED',
        {
          acquisitionId: ID,
          blockedBy: [
            { code: 'BUYER_ROW_ENDS_BEFORE_TRANSFER', ownershipId: 'o1', validUntil: '2025-03-31' },
            { code: 'OWNERSHIP_TOTAL_EXCEEDS_ONE', date: '2025-03-01', shareSum: '3/2' },
            { code: 'CONFIRMATION_REQUIREMENTS', violations: [{ code: 'OWNERSHIP_INCOMPLETE', date: '2025-05-01', shareSum: '1/2' }] },
          ],
        },
      ],
      [new IdempotencyKeyConflictError('Idempotency-Key was already used with a different payload'), 409, 'CONFLICT', undefined],
    ];
    for (const [error, status, code, details] of cases) {
      base = await start(() => Promise.reject(error));
      const res = await post(base, { sourceReferences: EVIDENCE });
      const answer = await errorOf(res);
      expect([res.status, answer.code], error.name).toEqual([status, code]);
      if (details !== undefined) expect(answer.details, error.name).toEqual(details);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });
});
