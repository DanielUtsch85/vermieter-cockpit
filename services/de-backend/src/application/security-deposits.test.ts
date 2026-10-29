import { describe, expect, it } from 'vitest';
import {
  deriveFigures,
  type DepositView,
  type SecurityDeposit,
  type SecurityDepositId,
  type SecurityDepositRepository,
} from '../domains/security-deposit/index.js';
import { Money } from '../shared/index.js';
import { AccessError } from './access.js';
import { MreUnavailableError } from './errors.js';
import { getDeposit, type MreTenantDepositReader } from './security-deposits.js';

/** VC-5-04's `checkMre` (api-design.md §47.4): after the read, never an error when MRE cannot be asked. */
const principal = { email: 'anna@example.com', mreRealmId: 'r', mreRole: 'administrator' } as const;
const record: SecurityDeposit = {
  id: 'd1' as SecurityDepositId,
  mreRealmId: 'r',
  status: 'ACTIVE',
  mreTenantId: '6512f0c2a1b2c3d4e5f60a01',
  expectedAmount: Money.of('3000.00', 'EUR'),
  expectedAmountSource: 'REQUEST',
  holdingFinancialAccountId: null,
  interestBearing: true,
  notes: null,
  voidedAt: null,
  voidReason: null,
  closing: null,
  createdAt: new Date('2027-01-01T00:00:00Z'),
  version: 1,
};
const view: DepositView = { ...record, figures: deriveFigures(record, []), cash: [] };

function wiring(reader: MreTenantDepositReader) {
  const calls: unknown[][] = [];
  const repository = { findById: async (id: string) => (id === 'd1' ? view : undefined) } as unknown as SecurityDepositRepository;
  const get = getDeposit({
    repository,
    readMreTenant: async (...args) => {
      calls.push(args);
      return reader(...args);
    },
  });
  return { get, calls };
}

describe('getDeposit with checkMre (§47.4)', () => {
  it('without checkMre MRE is not asked; with it, the caller’s token, the Realm and the Tenant', async () => {
    const { get, calls } = wiring(async () => ({ guaranty: Money.of('2500.00', 'EUR'), guarantyPayback: null }));
    expect(await get({ principal, securityDepositId: 'd1' })).toBe(view);
    expect(calls).toEqual([]);
    const compared = await get({ principal, securityDepositId: 'd1', checkMre: { authorizationHeader: 'Bearer t' } });
    expect(calls).toEqual([['Bearer t', 'r', '6512f0c2a1b2c3d4e5f60a01']]);
    expect(compared.mre).toEqual({ guaranty: Money.of('2500.00', 'EUR'), guarantyPayback: null });
    expect(compared.figures.flags.map((f) => f.code)).toEqual(['EXPECTED_DIFFERS_FROM_MRE']);
  });

  it('MRE unavailable and the Tenant gone are flags; MRE refusing the caller stays an error; an unknown deposit never asks MRE', async () => {
    const down = wiring(async () => Promise.reject(new MreUnavailableError('down')));
    expect((await down.get({ principal, securityDepositId: 'd1', checkMre: { authorizationHeader: 'x' } })).figures.flags.map((f) => f.code)).toEqual([
      'MRE_UNAVAILABLE',
    ]);
    const gone = wiring(async () => undefined);
    expect(await gone.get({ principal, securityDepositId: 'd1', checkMre: { authorizationHeader: 'x' } })).toMatchObject({
      mre: null,
      figures: { flags: [{ code: 'MRE_TENANT_NOT_FOUND' }] },
    });
    const refused = wiring(async () => Promise.reject(new AccessError('FORBIDDEN', 'no')));
    await expect(refused.get({ principal, securityDepositId: 'd1', checkMre: { authorizationHeader: 'x' } })).rejects.toBeInstanceOf(AccessError);
    await expect(refused.get({ principal, securityDepositId: 'd2', checkMre: { authorizationHeader: 'x' } })).rejects.toMatchObject({
      name: 'SecurityDepositNotFoundError',
    });
    expect(refused.calls).toHaveLength(1);
  });
});
