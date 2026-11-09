import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateLoanAllocationInput, LoanAllocationSetView, PrincipalVerifier } from '../application/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/**
 * VC-X-43 HTTP contract (api-design.md §58V rules 2–4 and 10; Entscheidung des Projektinhabers, 2026-11-07, questions
 * 3–5): `outsideLetting` and `useEvidence` parsed strictly, the sum with the part, `MANUAL` only, the evidence required
 * with the part, `0` and `1/1` out of range, the DTO with and without. Synthetic ids and texts only.
 */
const REALM = '64b0c0ffee0000000000430a';
const LOAN = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e4301';
const SET = '1b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e4301';
const P1 = '2b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e4301';
const P2 = '3b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e4301';
const A1 = '4b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e4301';
const EVIDENCE = ['Auszahlungsbeleg der Bank vom 2027-01-04 (synthetisch)', 'Kaufvertrag Pkw vom 2027-01-05 (synthetisch)'];
const f = (n: bigint, d: bigint) => ({ numerator: n, denominator: d });
const set = (outside: boolean) =>
  ({
    id: SET,
    loanId: LOAN,
    mreRealmId: REALM,
    status: 'VALID',
    validFrom: '2027-01-01',
    validUntil: null,
    basis: 'MANUAL',
    allocations: [
      { propertyReferenceId: P1, share: f(1n, 2n), acquisitionId: null },
      { propertyReferenceId: P2, share: f(3n, 10n), acquisitionId: null },
    ],
    outsideLetting: outside ? { share: f(1n, 5n) } : null,
    useEvidence: outside ? EVIDENCE : null,
    notes: null,
    voidedAt: null,
    voidReason: null,
    createdAt: new Date('2027-01-02T10:00:00Z'),
    version: 1,
  }) as unknown as LoanAllocationSetView;

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

const headers = { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json' };
const post = (base: string, body: unknown) => fetch(`${base}/api/v1/loans/${LOAN}/allocations`, { method: 'POST', headers, body: JSON.stringify(body) });
const fields = async (res: Response) => ((await res.json()) as { error: { details: { fields: unknown[] } } }).error.details.fields;
const mixed = {
  validFrom: '2027-01-01',
  allocations: [
    { propertyReferenceId: P1, share: '1/2' },
    { propertyReferenceId: P2, share: '3/10' },
  ],
  outsideLetting: { share: '2/10' },
  useEvidence: [`  ${EVIDENCE[0]}  `, EVIDENCE[1]],
};

describe('POST /api/v1/loans/{id}/allocations with a part outside letting (§58V)', () => {
  it('201: the part reduced and the evidence trimmed reach the command; the DTO answers both after allocations', async () => {
    const seen: CreateLoanAllocationInput[] = [];
    const base = await start({
      loanAllocations: {
        create: async (input) => {
          seen.push(input);
          return { set: set(true), replayed: false };
        },
      },
    });
    const res = await post(base, mixed);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['outsideLetting']).toEqual({ share: '1/5' });
    expect(body['useEvidence']).toEqual(EVIDENCE);
    expect(Object.keys(body).slice(6, 9)).toEqual(['allocations', 'outsideLetting', 'useEvidence']);
    expect(seen[0]).toMatchObject({ basis: 'MANUAL', outsideLetting: f(1n, 5n), useEvidence: EVIDENCE });
  });

  it('without the part: the command gets neither key (an old body s request and fingerprint as before); the DTO answers null', async () => {
    const seen: CreateLoanAllocationInput[] = [];
    const base = await start({
      loanAllocations: {
        create: async (input) => {
          seen.push(input);
          return { set: set(false), replayed: false };
        },
      },
    });
    const res = await post(base, { validFrom: '2027-01-01', allocations: [{ propertyReferenceId: P1, share: '1/1' }] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ outsideLetting: null, useEvidence: null });
    expect(seen[0]).not.toHaveProperty('outsideLetting');
    expect(seen[0]).not.toHaveProperty('useEvidence');
    // useEvidence alone is allowed and passed on (optional for any set, question 5).
    const evidence = await post(base, { validFrom: '2027-01-01', allocations: [{ propertyReferenceId: P1, share: '1/1' }], useEvidence: [EVIDENCE[0]] });
    expect(evidence.status).toBe(201);
    expect(seen[1]).toMatchObject({ useEvidence: [EVIDENCE[0]] });
    expect(seen[1]).not.toHaveProperty('outsideLetting');
    // Explicit nulls are the same as absent.
    expect(
      (await post(base, { validFrom: '2027-01-01', allocations: [{ propertyReferenceId: P1, share: '1/1' }], outsideLetting: null, useEvidence: null })).status,
    ).toBe(201);
    expect(seen[2]).not.toHaveProperty('outsideLetting');
  });

  it('SHARE_SUM_NOT_ONE with the part: below and above 1/1; entries alone at 1/1 plus a part refused', async () => {
    const base = await start({});
    for (const outsideLetting of [{ share: '1/10' }, { share: '3/10' }]) {
      const res = await post(base, { ...mixed, outsideLetting });
      expect(res.status).toBe(400);
      expect(await fields(res)).toEqual([{ field: 'allocations', code: 'SHARE_SUM_NOT_ONE' }]);
    }
    const full = await post(base, { ...mixed, allocations: [{ propertyReferenceId: P1, share: '1/1' }] });
    expect(await fields(full)).toEqual([{ field: 'allocations', code: 'SHARE_SUM_NOT_ONE' }]);
  });

  it('NOT_ALLOWED_FOR_BASIS on PURCHASE_PRICE (question 3); REQUIRED useEvidence with the part (question 5)', async () => {
    const base = await start({});
    const price = await post(base, {
      validFrom: '2027-01-01',
      basis: 'PURCHASE_PRICE',
      allocations: [{ propertyReferenceId: P1, acquisitionId: A1 }],
      outsideLetting: { share: '1/5' },
      useEvidence: EVIDENCE,
    });
    expect(price.status).toBe(400);
    expect(await fields(price)).toEqual([{ field: 'outsideLetting', code: 'NOT_ALLOWED_FOR_BASIS' }]);
    const { useEvidence: _omitted, ...withoutEvidence } = mixed;
    const missing = await post(base, withoutEvidence);
    expect(await fields(missing)).toEqual([{ field: 'useEvidence', code: 'REQUIRED' }]);
    expect(await fields(await post(base, { ...mixed, useEvidence: null }))).toEqual([{ field: 'useEvidence', code: 'REQUIRED' }]);
  });

  it('the share: 0 and 1/1 (also 3/3) OUT_OF_RANGE, d over 10000 OUT_OF_RANGE, text INVALID_FORMAT; strict object', async () => {
    const base = await start({});
    for (const [share, code] of [
      ['0/5', 'OUT_OF_RANGE'],
      ['1/1', 'OUT_OF_RANGE'],
      ['3/3', 'OUT_OF_RANGE'],
      ['6/5', 'OUT_OF_RANGE'],
      ['1/10001', 'OUT_OF_RANGE'],
      ['ein Fünftel', 'INVALID_FORMAT'],
    ] as const) {
      const res = await post(base, { ...mixed, outsideLetting: { share } });
      expect(res.status, share).toBe(400);
      expect(await fields(res), share).toContainEqual({ field: 'outsideLetting.share', code });
    }
    const extra = await post(base, { ...mixed, outsideLetting: { share: '1/5', kind: 'PRIVATE' } });
    expect(extra.status).toBe(400);
    const missingShare = await post(base, { ...mixed, outsideLetting: {} });
    expect(missingShare.status).toBe(400);
  });

  it('useEvidence: 0 or 11 entries, an empty or blank entry and 501 characters refused; 10 entries of 500 accepted', async () => {
    const base = await start({ loanAllocations: { create: async () => ({ set: set(true), replayed: false }) } });
    const cases: unknown[][] = [[], Array.from({ length: 11 }, (_, i) => `Beleg ${i + 1} (synthetisch)`), [''], ['   '], ['x'.repeat(501)]];
    for (const useEvidence of cases) {
      const res = await post(base, { ...mixed, useEvidence });
      expect(res.status, JSON.stringify(useEvidence).slice(0, 40)).toBe(400);
      expect(((await fields(res)) as { field: string }[]).every((e) => e.field.startsWith('useEvidence'))).toBe(true);
    }
    expect((await post(base, { ...mixed, useEvidence: Array.from({ length: 10 }, () => 'x'.repeat(500)) })).status).toBe(201);
  });
});
