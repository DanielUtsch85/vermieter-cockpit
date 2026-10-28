import { describe, expect, it } from 'vitest';
import type { RentPaymentReconciliation, RentReconciliationRepository, WriteBackResult, WriteBackTerm } from '../domains/rent-reconciliation/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { AccessError, type RealmPrincipal } from './access.js';
import { MreUnavailableError, VersionConflictError } from './errors.js';
import { ReconciliationNotFoundError, WriteBackInProgressError } from './rent-reconciliations.js';
import { NotWritableError, WriteBackFailedError, getReconciliationWithPresence, writeBackToMre, type MreWriteBackTermWriter } from './rent-write-back.js';

/** VC-4-04's use case (api-design.md §37.4): the order claim → read → PATCH → verify → record, and each outcome. */
const REALM = '64b0c0ffee00000000000016';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';
const ID = '0b6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3b';
const MARKER = `DE-RPR-${ID}`;
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const eur = (amount: string) => Money.of(amount, 'EUR');
const reconciliation = { id: ID, mreTenantId: TENANT, mreRentTerm: '2027010100', matchedAmount: eur('800.00'), mreWriteBackState: 'PENDING', version: 2 } as unknown as RentPaymentReconciliation;
const theirs = { date: '02/01/2027', amount: 50, type: 'cash', reference: '', description: 'Bar' };
const mine = { date: '03/01/2027', amount: 800, type: 'transfer', reference: MARKER, description: '' };
const term = (payments: WriteBackTerm['payments'] = [theirs], overrides: Partial<WriteBackTerm> = {}): WriteBackTerm => ({
  mreTenantId: TENANT,
  term: '2027010100',
  vatRatio: 0,
  payments,
  promo: 0,
  notepromo: '',
  extracharge: 0,
  noteextracharge: '',
  description: 'Januar',
  ...overrides,
});
const input = { principal, authorizationHeader: 'Bearer t', reconciliationId: ID };

/** A repository that claims, and records what it is told, logging the order. */
function world(options: { claim?: Awaited<ReturnType<RentReconciliationRepository['claimWriteBack']>>; reads?: (WriteBackTerm | undefined | Error)[]; write?: Awaited<ReturnType<MreWriteBackTermWriter>> | Error; leaseLost?: boolean } = {}) {
  const order: string[] = [];
  const recorded: WriteBackResult[] = [];
  const reads = [...(options.reads ?? [term()])];
  const repository = {
    claimWriteBack: async (id: string, realm: string, leaseMs: number, actor: { actorId: string }, versions?: readonly number[]) => {
      order.push(`claim ${id} ${realm} ${leaseMs} ${actor.actorId} ${versions?.join() ?? '-'}`);
      return options.claim ?? { kind: 'CLAIMED', reconciliation, attemptId: 'a1', bookingDate: '2027-01-03' as BusinessDate };
    },
    recordWriteBack: async (_id: string, _realm: string, attemptId: string, result: WriteBackResult) => {
      order.push(`record ${attemptId} ${result.kind}${result.kind === 'FAILED' ? ` ${result.error}` : result.kind === 'WRITTEN' ? ` patched=${result.patched}` : ''}`);
      recorded.push(result);
      if (options.leaseLost === true) return { kind: 'LEASE_LOST' } as const;
      const state = result.kind === 'WRITTEN' ? 'WRITTEN' : result.kind === 'FAILED' ? 'FAILED' : 'NOT_WRITTEN';
      return { kind: 'RECORDED', reconciliation: { ...reconciliation, mreWriteBackState: state, version: 3 } as RentPaymentReconciliation } as const;
    },
    findById: async () => ({ ...reconciliation, mreWriteBackState: 'WRITTEN' }) as RentPaymentReconciliation,
  } as unknown as RentReconciliationRepository;
  const readTerm = async (...args: string[]) => {
    order.push(`read ${args.join(' ')}`);
    const next = reads.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const writeTerm: MreWriteBackTermWriter = async (header, realm, tenant, t, write) => {
    order.push(`patch ${header} ${realm} ${tenant} ${t} ${JSON.stringify(write.payments.map((p) => p.reference))}`);
    if (options.write instanceof Error) throw options.write;
    return options.write ?? { kind: 'ANSWERED', term: term([theirs, mine]) };
  };
  return { order, recorded, run: writeBackToMre({ repository, readTerm, writeTerm, leaseMs: 10_000 }), repository, readTerm };
}

describe('writeBackToMre (§37.4)', () => {
  it('claim → read → PATCH (the term read plus DE’s payment) → verify → record WRITTEN, each with the caller’s header and Realm', async () => {
    const w = world();
    expect(await w.run({ ...input, expectedVersions: [1] })).toMatchObject({ changed: true, reconciliation: { mreWriteBackState: 'WRITTEN' } });
    expect(w.order).toEqual([
      `claim ${ID} ${REALM} 10000 anna@example.com 1`,
      `read Bearer t ${REALM} ${TENANT} 2027010100`,
      `patch Bearer t ${REALM} ${TENANT} 2027010100 ["","${MARKER}"]`,
      'record a1 WRITTEN patched=true',
    ]);
    expect(w.recorded[0]).toEqual({ kind: 'WRITTEN', patched: true, payment: { date: '03/01/2027', amount: eur('800.00'), type: 'transfer', reference: MARKER } });
  });

  it('claim refusals never ask MRE: WRITTEN is a no-op, the others their errors', async () => {
    const refused = async (claim: Awaited<ReturnType<RentReconciliationRepository['claimWriteBack']>>) => {
      const w = world({ claim });
      const outcome = w.run(input).catch((error: unknown) => error);
      const result = await outcome;
      expect(w.order).toHaveLength(1);
      return result;
    };
    expect(await refused({ kind: 'UNCHANGED', reconciliation })).toEqual({ reconciliation, changed: false });
    expect(await refused({ kind: 'NOT_FOUND' })).toBeInstanceOf(ReconciliationNotFoundError);
    expect(await refused({ kind: 'NOT_WRITABLE', status: 'RELEASED' })).toBeInstanceOf(NotWritableError);
    expect(await refused({ kind: 'WRITE_BACK_IN_PROGRESS', reconciliationId: 'r2' })).toMatchObject({ constructor: WriteBackInProgressError, reconciliationId: 'r2' });
    expect(await refused({ kind: 'VERSION_CONFLICT', expectedVersions: [1], currentVersion: 2 })).toBeInstanceOf(VersionConflictError);
  });

  it('the marker already there once: an earlier attempt wrote it → WRITTEN without a PATCH; twice or changed → MRE_PAYMENT_CHANGED', async () => {
    const found = world({ reads: [term([theirs, mine])] });
    await found.run(input);
    expect(found.order.some((o) => o.startsWith('patch'))).toBe(false);
    expect(found.order.at(-1)).toBe('record a1 WRITTEN patched=false');
    const twice = world({ reads: [term([mine, mine])] });
    await expect(twice.run(input)).rejects.toMatchObject({ constructor: WriteBackFailedError, code: 'MRE_PAYMENT_CHANGED' });
    expect(twice.order.some((o) => o.startsWith('patch'))).toBe(false);
  });

  it('under VAT with a promo: back to NOT_WRITTEN, no PATCH, MRE_TERM_NOT_ROUND_TRIPPABLE', async () => {
    const w = world({ reads: [term([theirs], { vatRatio: 0.2, promo: 10 })] });
    await expect(w.run(input)).rejects.toMatchObject({ code: 'MRE_TERM_NOT_ROUND_TRIPPABLE', reconciliation: { mreWriteBackState: 'NOT_WRITTEN' } });
    expect(w.order.at(-1)).toBe('record a1 NOT_WRITTEN');
    expect(w.order.some((o) => o.startsWith('patch'))).toBe(false);
  });

  it('the read: not returned → MRE_RENT_TERM_NOT_FOUND; down → MRE_UNAVAILABLE; refused → MRE_FORBIDDEN recorded and the AccessError kept', async () => {
    await expect(world({ reads: [undefined] }).run(input)).rejects.toMatchObject({ code: 'MRE_RENT_TERM_NOT_FOUND', reconciliation: { mreWriteBackState: 'FAILED' } });
    await expect(world({ reads: [new MreUnavailableError('down')] }).run(input)).rejects.toMatchObject({ code: 'MRE_UNAVAILABLE' });
    const refused = world({ reads: [new AccessError('FORBIDDEN', 'no')] });
    await expect(refused.run(input)).rejects.toBeInstanceOf(AccessError);
    expect(refused.recorded).toEqual([{ kind: 'FAILED', error: 'MRE_FORBIDDEN' }]);
  });

  it('a lost answer → the second read finds DE’s payment → WRITTEN; still absent → MRE_UNAVAILABLE or MRE_WRITE_REFUSED', async () => {
    const lost = world({ reads: [term(), term([theirs, mine])], write: { kind: 'NO_ANSWER' } });
    await lost.run(input);
    expect(lost.order.filter((o) => o.startsWith('read'))).toHaveLength(2);
    expect(lost.order.at(-1)).toBe('record a1 WRITTEN patched=true');
    await expect(world({ reads: [term(), term()], write: { kind: 'NO_ANSWER' } }).run(input)).rejects.toMatchObject({ code: 'MRE_UNAVAILABLE' });
    await expect(world({ reads: [term(), term()], write: { kind: 'REFUSED', status: 500 } }).run(input)).rejects.toMatchObject({ code: 'MRE_WRITE_REFUSED' });
    await expect(world({ reads: [term(), new MreUnavailableError('down')], write: { kind: 'NO_ANSWER' } }).run(input)).rejects.toMatchObject({ code: 'MRE_UNAVAILABLE' });
    await expect(world({ reads: [term(), undefined], write: { kind: 'NO_ANSWER' } }).run(input)).rejects.toMatchObject({ code: 'MRE_RENT_TERM_NOT_FOUND' });
  });

  it('an answer without DE’s payment, or with the term’s other content changed → MRE_TERM_CHANGED', async () => {
    await expect(world({ reads: [term(), term()], write: { kind: 'ANSWERED', term: term() } }).run(input)).rejects.toMatchObject({ code: 'MRE_TERM_CHANGED' });
    const edited = term([{ ...theirs, amount: 60 }, mine]);
    await expect(world({ reads: [term(), edited], write: { kind: 'ANSWERED', term: edited } }).run(input)).rejects.toMatchObject({ code: 'MRE_TERM_CHANGED' });
    // A wrong answer but a right second read: WRITTEN.
    await expect(world({ reads: [term(), term([theirs, mine])], write: { kind: 'ANSWERED', term: term() } }).run(input)).resolves.toMatchObject({ changed: true });
  });

  it('the PATCH refused for the caller: MRE_FORBIDDEN recorded, the AccessError kept; a lost lease records nothing and is WRITE_BACK_IN_PROGRESS', async () => {
    const refused = world({ write: new AccessError('UNAUTHENTICATED', 'expired') });
    await expect(refused.run(input)).rejects.toMatchObject({ constructor: AccessError, code: 'UNAUTHENTICATED' });
    expect(refused.recorded).toEqual([{ kind: 'FAILED', error: 'MRE_FORBIDDEN' }]);
    await expect(world({ leaseLost: true }).run(input)).rejects.toMatchObject({ constructor: WriteBackInProgressError, reconciliationId: ID });
  });
});

describe('getReconciliationWithPresence (§37.4)', () => {
  it('PRESENT, MISSING (also for a term gone), UNAVAILABLE; null without an MRE call when nothing was written; a refused caller passes through', async () => {
    const presence = async (state: string, read: WriteBackTerm | undefined | Error) => {
      const asked: string[] = [];
      const get = getReconciliationWithPresence({
        repository: { findById: async () => ({ ...reconciliation, mreWriteBackState: state }) } as unknown as RentReconciliationRepository,
        readTerm: async (...args) => {
          asked.push(args.join(' '));
          if (read instanceof Error) throw read;
          return read;
        },
      });
      const result = await get(input);
      return { presence: result.mrePresence, asked };
    };
    expect(await presence('WRITTEN', term([theirs, mine]))).toEqual({ presence: 'PRESENT', asked: [`Bearer t ${REALM} ${TENANT} 2027010100`] });
    expect((await presence('REMOVAL_REQUIRED', term())).presence).toBe('MISSING');
    expect((await presence('WRITTEN', undefined)).presence).toBe('MISSING');
    expect((await presence('WRITTEN', new MreUnavailableError('down'))).presence).toBe('UNAVAILABLE');
    expect(await presence('NOT_WRITTEN', term())).toEqual({ presence: null, asked: [] });
    expect(await presence('FAILED', term())).toEqual({ presence: null, asked: [] });
    await expect(presence('WRITTEN', new AccessError('FORBIDDEN', 'no'))).rejects.toBeInstanceOf(AccessError);
    const unknown = getReconciliationWithPresence({ repository: { findById: async () => undefined } as unknown as RentReconciliationRepository, readTerm: async () => undefined });
    await expect(unknown(input)).rejects.toBeInstanceOf(ReconciliationNotFoundError);
  });
});
