import { describe, expect, it } from 'vitest';
import {
  costFingerprint,
  paymentFingerprint,
  type AcquisitionCost,
  type AcquisitionCostRepository,
  type AcquisitionPayment,
} from '../domains/acquisition/index.js';
import { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import {
  AcquisitionCancelledError,
  AcquisitionCostNotFoundError,
  AcquisitionPaymentNotFoundError,
  CostHasPaymentsError,
  PaymentRefusedError,
  createAcquisitionCost,
  linkAcquisitionPayment,
  listAcquisitionCosts,
  listAcquisitionPayments,
  unlinkAcquisitionPayment,
  voidAcquisitionCost,
} from './acquisition-costs.js';
import { IdempotencyKeyConflictError, VersionConflictError } from './errors.js';
import { AcquisitionNotFoundError } from './ownerships.js';
import { PartyNotFoundError } from './parties.js';
import { TransactionNotFoundError } from './transaction-splits.js';

/** VC-2-06 use cases (api-design.md §27.2): Realm, actor, fingerprint, and each refusal as its error. */
const REALM = '64b0c0ffee0000000000000a';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const eur = (amount: string) => Money.of(amount, 'EUR');
const costFields = { category: 'NOTARY', amount: eur('10.00'), incurredDate: null, counterpartyPartyId: null, sourceReferences: [], notes: null } as const;
const paymentFields = { transactionId: 't', acquisitionCostId: 'c', amount: eur('5.00') } as const;
const cost = { id: 'c' } as AcquisitionCost;
const payment = { id: 'p' } as AcquisitionPayment;
const unused = () => Promise.reject(new Error('unused'));
const repository = (overrides: Partial<AcquisitionCostRepository>): AcquisitionCostRepository => ({
  createCost: unused,
  voidCost: unused,
  listCosts: async () => undefined,
  linkPayment: unused,
  unlinkPayment: unused,
  listPayments: async () => undefined,
  ...overrides,
});

describe('createAcquisitionCost', () => {
  it('passes the Realm, the actor and the fingerprint; maps each refusal', async () => {
    const calls: unknown[] = [];
    const outcomes = [
      { kind: 'CREATED', cost },
      { kind: 'IDEMPOTENCY_CONFLICT' },
      { kind: 'ACQUISITION_NOT_FOUND' },
      { kind: 'PARTY_NOT_FOUND', partyId: 'x' },
      { kind: 'ACQUISITION_CANCELLED' },
    ] as const;
    let i = 0;
    const create = createAcquisitionCost({
      repository: repository({
        createCost: async (...args) => {
          calls.push(args);
          return outcomes[i++] ?? { kind: 'ACQUISITION_CANCELLED' };
        },
      }),
    });
    expect(await create({ principal, acquisitionId: 'a', idempotencyKey: 'k', ...costFields })).toEqual({ cost, replayed: false });
    const expected = { mreRealmId: REALM, acquisitionId: 'a', ...costFields };
    expect(calls[0]).toEqual([expected, { actorType: 'USER', actorId: 'anna@example.com' }, { key: 'k', fingerprint: costFingerprint(expected) }]);
    await expect(create({ principal, acquisitionId: 'a', ...costFields })).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(create({ principal, acquisitionId: 'a', ...costFields })).rejects.toBeInstanceOf(AcquisitionNotFoundError);
    await expect(create({ principal, acquisitionId: 'a', ...costFields })).rejects.toBeInstanceOf(PartyNotFoundError);
    await expect(create({ principal, acquisitionId: 'a', ...costFields })).rejects.toBeInstanceOf(AcquisitionCancelledError);
  });
});

describe('voidAcquisitionCost and unlinkAcquisitionPayment', () => {
  it('map their refusals', async () => {
    const voids = [
      { kind: 'NOT_FOUND' },
      { kind: 'ACQUISITION_CANCELLED' },
      { kind: 'COST_HAS_PAYMENTS', paymentIds: ['p'] },
      { kind: 'VERSION_CONFLICT', expectedVersions: [2], currentVersion: 1 },
    ] as const;
    let v = 0;
    const voidCost = voidAcquisitionCost({ repository: repository({ voidCost: async () => voids[v++] ?? { kind: 'VOIDED', cost, changed: true } }) });
    const input = { principal, acquisitionId: 'a', costId: 'c', reason: 'x' };
    await expect(voidCost(input)).rejects.toBeInstanceOf(AcquisitionCostNotFoundError);
    await expect(voidCost(input)).rejects.toBeInstanceOf(AcquisitionCancelledError);
    await expect(voidCost(input)).rejects.toEqual(new CostHasPaymentsError('c', ['p']));
    await expect(voidCost(input)).rejects.toBeInstanceOf(VersionConflictError);
    expect(await voidCost(input)).toEqual({ cost, changed: true });

    const unlinks = [{ kind: 'NOT_FOUND' }, { kind: 'ACQUISITION_CANCELLED' }] as const;
    let u = 0;
    const unlink = unlinkAcquisitionPayment({
      repository: repository({ unlinkPayment: async () => unlinks[u++] ?? { kind: 'UNLINKED', payment, changed: false } }),
    });
    const unlinkInput = { principal, acquisitionId: 'a', paymentId: 'p', reason: 'x' };
    await expect(unlink(unlinkInput)).rejects.toBeInstanceOf(AcquisitionPaymentNotFoundError);
    await expect(unlink(unlinkInput)).rejects.toBeInstanceOf(AcquisitionCancelledError);
    expect(await unlink(unlinkInput)).toEqual({ payment, changed: false });
  });
});

describe('linkAcquisitionPayment', () => {
  it('passes the fingerprint; the 404s and CANCELLED get their own errors, the rest a PaymentRefusedError', async () => {
    const calls: unknown[] = [];
    const outcomes = [
      { kind: 'REPLAYED', payment },
      { kind: 'COST_NOT_FOUND' },
      { kind: 'TRANSACTION_NOT_FOUND' },
      { kind: 'ACQUISITION_CANCELLED' },
      { kind: 'NOT_OUTFLOW' },
    ] as const;
    let i = 0;
    const link = linkAcquisitionPayment({
      repository: repository({
        linkPayment: async (...args) => {
          calls.push(args);
          return outcomes[i++] ?? { kind: 'ACQUISITION_NOT_FOUND' };
        },
      }),
    });
    expect(await link({ principal, acquisitionId: 'a', idempotencyKey: 'k', ...paymentFields })).toEqual({ payment, replayed: true });
    const expected = { mreRealmId: REALM, acquisitionId: 'a', ...paymentFields };
    expect((calls[0] as unknown[])[2]).toEqual({ key: 'k', fingerprint: paymentFingerprint(expected) });
    await expect(link({ principal, acquisitionId: 'a', ...paymentFields })).rejects.toEqual(new AcquisitionCostNotFoundError('c'));
    await expect(link({ principal, acquisitionId: 'a', ...paymentFields })).rejects.toEqual(new TransactionNotFoundError('t'));
    await expect(link({ principal, acquisitionId: 'a', ...paymentFields })).rejects.toBeInstanceOf(AcquisitionCancelledError);
    await expect(link({ principal, acquisitionId: 'a', ...paymentFields })).rejects.toEqual(new PaymentRefusedError({ kind: 'NOT_OUTFLOW' }));
    await expect(link({ principal, acquisitionId: 'a', ...paymentFields })).rejects.toBeInstanceOf(AcquisitionNotFoundError);
  });
});

describe('the reads', () => {
  it('an unknown or foreign Acquisition is 404, not an empty list', async () => {
    await expect(listAcquisitionCosts({ repository: repository({}) })({ principal, acquisitionId: 'a', filter: {} })).rejects.toBeInstanceOf(
      AcquisitionNotFoundError,
    );
    await expect(listAcquisitionPayments({ repository: repository({}) })({ principal, acquisitionId: 'a', filter: {} })).rejects.toBeInstanceOf(
      AcquisitionNotFoundError,
    );
    expect(await listAcquisitionCosts({ repository: repository({ listCosts: async () => [cost] }) })({ principal, acquisitionId: 'a', filter: {} })).toEqual([
      cost,
    ]);
  });
});
