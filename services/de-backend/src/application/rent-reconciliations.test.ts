import { describe, expect, it } from 'vitest';
import type { RentPaymentReconciliation, RentReconciliationRepository } from '../domains/rent-reconciliation/index.js';
import { Money } from '../shared/index.js';
import type { RealmPrincipal } from './access.js';
import { IdempotencyKeyConflictError, MreUnavailableError, VersionConflictError } from './errors.js';
import {
  AboveSuggestionError,
  AlreadyMatchedError,
  NotConfirmableError,
  NotRejectableError,
  SuggestionStaleError,
  confirmReconciliation,
  rejectReconciliation,
  suggestReconciliations,
  MreRentTermNotFoundError,
  NoRentCashError,
  NotReleasableError,
  ReconciliationNotFoundError,
  RentCashExceededError,
  TransactionNotCountedError,
  TransactionNotInflowError,
  createReconciliation,
  getReconciliation,
  getTermCoverage,
  getTransactionCoverage,
  releaseReconciliation,
} from './rent-reconciliations.js';
import { AccessError } from './access.js';
import { TransactionNotFoundError } from './transaction-splits.js';

/** VC-4-01 use cases (api-design.md §37.1): when MRE is asked, the order DE → MRE → DE, each refusal as its error. */
const REALM = '64b0c0ffee00000000000016';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';
const principal: RealmPrincipal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' };
const reconciliation = { id: 'r1', version: 1 } as unknown as RentPaymentReconciliation;
const eur = (amount: string) => Money.of(amount, 'EUR');

const repository = (overrides: Partial<RentReconciliationRepository>): RentReconciliationRepository => ({
  precheck: () => Promise.reject(new Error('unused')),
  termSide: () => Promise.reject(new Error('unused')),
  transactionSide: () => Promise.reject(new Error('unused')),
  suggestionSnapshot: () => Promise.reject(new Error('unused')),
  writeSuggestions: () => Promise.reject(new Error('unused')),
  confirmPrecheck: () => Promise.reject(new Error('unused')),
  confirm: () => Promise.reject(new Error('unused')),
  reject: () => Promise.reject(new Error('unused')),
  create: () => Promise.reject(new Error('unused')),
  findById: () => Promise.reject(new Error('unused')),
  list: () => Promise.reject(new Error('unused')),
  release: () => Promise.reject(new Error('unused')),
  claimWriteBack: () => Promise.reject(new Error('unused')),
  recordWriteBack: () => Promise.reject(new Error('unused')),
  claimRemoval: () => Promise.reject(new Error('unused')),
  recordRemoval: () => Promise.reject(new Error('unused')),
  ...overrides,
});
const input = {
  principal,
  authorizationHeader: 'Bearer t',
  transactionId: 't1',
  mreTenantId: TENANT,
  mreRentTerm: '2027010100',
  matchedAmount: eur('800.00'),
  notes: null,
};
const neverAsked = async () => {
  throw new Error('MRE must not be asked');
};

describe('Rent reconciliation use cases', () => {
  it("create: DE checks first, then MRE with the caller's header, then the write with the actor and the key", async () => {
    const order: string[] = [];
    const created: unknown[][] = [];
    const create = createReconciliation({
      repository: repository({
        precheck: async (match, idempotency) => {
          order.push('precheck');
          expect(match).toEqual({
            mreRealmId: REALM,
            transactionId: 't1',
            mreTenantId: TENANT,
            mreRentTerm: '2027010100',
            matchedAmount: eur('800.00'),
            notes: null,
          });
          expect(idempotency?.key).toBe('k1');
          return { kind: 'PROCEED' };
        },
        create: async (...args) => {
          order.push('create');
          created.push(args);
          return { kind: 'CREATED', reconciliation };
        },
      }),
      lookupMreRentTerm: async (...args) => {
        order.push(`mre ${args.join(' ')}`);
        return true;
      },
    });
    expect(await create({ ...input, idempotencyKey: 'k1' })).toEqual({ reconciliation, replayed: false });
    expect(order).toEqual(['precheck', `mre Bearer t ${REALM} ${TENANT} 2027010100`, 'create']);
    expect(created[0]?.[1]).toEqual({ actorType: 'USER', actorId: 'anna@example.com' });
  });

  it('create: a replay or a refusal from the precheck never asks MRE', async () => {
    const withPrecheck = (outcome: Awaited<ReturnType<RentReconciliationRepository['precheck']>>) =>
      createReconciliation({ repository: repository({ precheck: async () => outcome }), lookupMreRentTerm: neverAsked })(input);
    expect(await withPrecheck({ kind: 'REPLAYED', reconciliation })).toEqual({ reconciliation, replayed: true });
    await expect(withPrecheck({ kind: 'IDEMPOTENCY_CONFLICT' })).rejects.toBeInstanceOf(IdempotencyKeyConflictError);
    await expect(withPrecheck({ kind: 'TRANSACTION_NOT_FOUND' })).rejects.toBeInstanceOf(TransactionNotFoundError);
    await expect(withPrecheck({ kind: 'TRANSACTION_NOT_COUNTED', status: 'CLASSIFIED', correctionRole: null })).rejects.toBeInstanceOf(
      TransactionNotCountedError,
    );
    await expect(withPrecheck({ kind: 'TRANSACTION_NOT_INFLOW' })).rejects.toBeInstanceOf(TransactionNotInflowError);
    await expect(withPrecheck({ kind: 'NO_RENT_CASH' })).rejects.toBeInstanceOf(NoRentCashError);
    await expect(withPrecheck({ kind: 'ALREADY_MATCHED', reconciliationId: 'r0' })).rejects.toBeInstanceOf(AlreadyMatchedError);
    await expect(withPrecheck({ kind: 'RENT_CASH_EXCEEDED', rentCash: eur('800.00'), available: eur('1.00') })).rejects.toMatchObject({
      constructor: RentCashExceededError,
      available: eur('1.00'),
    });
  });

  it('create: a term MRE does not return is MreRentTermNotFoundError; an MRE outage passes through; nothing is written', async () => {
    const make = (lookup: () => Promise<boolean>) =>
      createReconciliation({ repository: repository({ precheck: async () => ({ kind: 'PROCEED' }) }), lookupMreRentTerm: lookup })(input);
    await expect(make(async () => false)).rejects.toMatchObject({ constructor: MreRentTermNotFoundError, mreTenantId: TENANT, mreRentTerm: '2027010100' });
    await expect(
      make(async () => {
        throw new MreUnavailableError('down');
      }),
    ).rejects.toBeInstanceOf(MreUnavailableError);
  });

  it("create: a refusal under the locks (a change after the MRE read) is mapped like the precheck's", async () => {
    const create = createReconciliation({
      repository: repository({ precheck: async () => ({ kind: 'PROCEED' }), create: async () => ({ kind: 'ALREADY_MATCHED', reconciliationId: 'r0' }) }),
      lookupMreRentTerm: async () => true,
    });
    await expect(create(input)).rejects.toMatchObject({ constructor: AlreadyMatchedError, reconciliationId: 'r0' });
  });

  it('get: unknown and foreign look the same', async () => {
    const get = getReconciliation({ repository: repository({ findById: async () => undefined }) });
    await expect(get({ principal, reconciliationId: 'x' })).rejects.toBeInstanceOf(ReconciliationNotFoundError);
  });

  it('release: each outcome as its result or error', async () => {
    const release = (outcome: Awaited<ReturnType<RentReconciliationRepository['release']>>) =>
      releaseReconciliation({ repository: repository({ release: async () => outcome }), now: () => new Date(0) })({
        principal,
        reconciliationId: 'r1',
        reason: 'x',
      });
    expect(await release({ kind: 'RELEASED', reconciliation, changed: true })).toEqual({ reconciliation, changed: true });
    await expect(release({ kind: 'NOT_FOUND' })).rejects.toBeInstanceOf(ReconciliationNotFoundError);
    await expect(release({ kind: 'NOT_RELEASABLE', status: 'SUGGESTED' })).rejects.toBeInstanceOf(NotReleasableError);
    await expect(release({ kind: 'VERSION_CONFLICT', expectedVersions: [3], currentVersion: 1 })).rejects.toBeInstanceOf(VersionConflictError);
  });
});

describe('coverage reads (§37.2)', () => {
  const rec = (status: RentPaymentReconciliation['status'], amount: string) =>
    ({ id: `r-${status}-${amount}`, status, matchedAmount: eur(amount) }) as unknown as RentPaymentReconciliation;
  const side = [rec('CONFIRMED', '300.00'), rec('RELEASED', '500.00')];
  const term = { principal, authorizationHeader: 'Bearer t', mreTenantId: TENANT, mreRentTerm: '2027010100' };
  const withMre = (read: Parameters<typeof getTermCoverage>[0]['readMreRentTerm']) =>
    getTermCoverage({
      repository: repository({ termSide: async (realm, tenant, t) => (realm === REALM && tenant === TENANT && t === '2027010100' ? side : []) }),
      readMreRentTerm: read,
    })(term);

  it("AVAILABLE: MRE next to DE, MRE payments never summed; the caller's header and Realm", async () => {
    const asked: string[][] = [];
    const mre = { amountDue: eur('800.00'), payments: [{ date: null, amount: eur('800.00'), type: 'transfer', reference: null }] };
    const result = await withMre(async (...args) => {
      asked.push(args);
      return mre;
    });
    expect(result).toMatchObject({
      mreStatus: 'AVAILABLE',
      mre,
      matchedTotal: eur('300.00'),
      coverage: 'PARTIALLY_MATCHED',
      openAmount: eur('500.00'),
      reconciliations: side,
    });
    expect(asked).toEqual([['Bearer t', REALM, TENANT, '2027010100']]);
  });

  it("NOT_RETURNED and UNAVAILABLE keep DE's side; AccessError passes through", async () => {
    expect(await withMre(async () => undefined)).toMatchObject({
      mreStatus: 'NOT_RETURNED',
      mre: null,
      coverage: null,
      openAmount: null,
      matchedTotal: eur('300.00'),
      reconciliations: side,
    });
    expect(
      await withMre(async () => {
        throw new MreUnavailableError('down');
      }),
    ).toMatchObject({ mreStatus: 'UNAVAILABLE', mre: null, coverage: null, openAmount: null, matchedTotal: eur('300.00'), reconciliations: side });
    await expect(
      withMre(async () => {
        throw new AccessError('FORBIDDEN', 'refused');
      }),
    ).rejects.toBeInstanceOf(AccessError);
  });

  it('per Transaction: counted, rent cash, matched, available; not counted means no available; unknown is TransactionNotFoundError', async () => {
    const read = (s: Awaited<ReturnType<RentReconciliationRepository['transactionSide']>>) =>
      getTransactionCoverage({ repository: repository({ transactionSide: async () => s }) })({ principal, transactionId: 't1' });
    const base = { transactionId: 't1', status: 'CONFIRMED', direction: 'INFLOW', correctionRole: null, rentCash: eur('800.00'), reconciliations: side };
    expect(await read(base)).toMatchObject({ counted: true, matchedTotal: eur('300.00'), available: eur('500.00') });
    expect(await read({ ...base, status: 'CLASSIFIED' })).toMatchObject({ counted: false, available: null, matchedTotal: eur('300.00') });
    expect(await read({ ...base, correctionRole: 'REVERSAL' })).toMatchObject({ counted: false, available: null });
    expect(await read({ ...base, rentCash: null, reconciliations: [] })).toMatchObject({
      counted: true,
      rentCash: null,
      available: null,
      matchedTotal: eur('0.00'),
    });
    await expect(read(undefined)).rejects.toBeInstanceOf(TransactionNotFoundError);
  });
});

describe('suggestions (§37.3)', () => {
  const empty = { candidates: [], confirmedByTerm: new Map(), handled: [], open: [], history: [] };

  it("suggest: MRE months from-1 .. to+1 with the caller's header, the candidate dates of all their windows, open = due − confirmed, the neighbours never suggested", async () => {
    const asked: string[] = [];
    const snapshots: unknown[][] = [];
    const written: unknown[][] = [];
    const due: Record<string, string> = { '2026-12': '800.00', '2027-1': '800.00', '2027-2': '800.00', '2027-3': '800.00' };
    const suggest = suggestReconciliations({
      readMreMonth: async (header, realm, year, month) => {
        asked.push(`${header} ${realm} ${year}-${month}`);
        const key = `${year}-${month}`;
        const tenant = year === 2026 ? '6512f0c2a1b2c3d4e5f60a09' : TENANT;
        return [{ mreTenantId: tenant, term: `${year}${String(month).padStart(2, '0')}0100`, amountDue: eur(due[key] ?? '0.00') }];
      },
      repository: repository({
        suggestionSnapshot: async (...args) => {
          snapshots.push(args);
          return {
            ...empty,
            // t1 pays the open rest of January; t0 fits the neighbour December only.
            candidates: [
              { transactionId: 't0', bookingDate: '2026-12-02' as never, available: eur('800.00'), counterpartyIban: null, description: null },
              { transactionId: 't1', bookingDate: '2027-01-03' as never, available: eur('300.00'), counterpartyIban: null, description: null },
            ],
            confirmedByTerm: new Map([[`${TENANT}/2027010100`, eur('500.00')]]),
          };
        },
        writeSuggestions: async (...args) => {
          written.push(args);
          return [reconciliation];
        },
      }),
    });
    expect(await suggest({ principal, authorizationHeader: 'Bearer t', from: '2027-01', to: '2027-02' })).toEqual({
      from: '2027-01',
      to: '2027-02',
      items: [reconciliation],
    });
    expect(asked).toEqual([`Bearer t ${REALM} 2026-12`, `Bearer t ${REALM} 2027-1`, `Bearer t ${REALM} 2027-2`, `Bearer t ${REALM} 2027-3`]);
    expect(snapshots[0]?.slice(2)).toEqual(['2026-11-15', '2027-03-31']);
    expect(snapshots[0]?.[1]).toHaveLength(4);
    expect(written[0]?.[1]).toEqual([
      {
        transactionId: 't1',
        mreTenantId: TENANT,
        mreRentTerm: '2027010100',
        matchedAmount: eur('300.00'),
        confidence: 'MEDIUM',
        suggestionReason: 'EXACT_AMOUNT',
      },
    ]);
    expect(written[0]?.[2]).toEqual({ actorType: 'USER', actorId: 'anna@example.com' });
  });

  it('suggest: a year boundary; MRE down or refusing passes through and nothing is read from DE or written', async () => {
    const asked: string[] = [];
    await suggestReconciliations({
      readMreMonth: async (_h, _r, year, month) => {
        asked.push(`${year}-${month}`);
        return [];
      },
      repository: repository({ suggestionSnapshot: async () => empty, writeSuggestions: async () => [] }),
    })({ principal, authorizationHeader: 'Bearer t', from: '2027-12', to: '2027-12' });
    expect(asked).toEqual(['2027-11', '2027-12', '2028-1']);
    for (const error of [new MreUnavailableError('down'), new AccessError('FORBIDDEN', 'refused')]) {
      const suggest = suggestReconciliations({
        readMreMonth: async (_h, _r, _y, month) => {
          if (month === 2) throw error;
          return [];
        },
        repository: repository({}),
      });
      await expect(suggest({ principal, authorizationHeader: 'Bearer t', from: '2027-01', to: '2027-01' })).rejects.toBe(error);
    }
  });

  const suggestion = { id: 'r1', version: 1, transactionId: 't1', mreTenantId: TENANT, mreRentTerm: '2027010100' } as unknown as RentPaymentReconciliation;

  it("confirm: DE checks first, then MRE live with the caller's header, then the write with its amount due", async () => {
    const order: string[] = [];
    const confirm = confirmReconciliation({
      repository: repository({
        confirmPrecheck: async (id, realm, amount) => {
          order.push(`precheck ${id} ${realm} ${amount?.toString() ?? '-'}`);
          return { kind: 'PROCEED', reconciliation: suggestion, amount: eur('700.00') };
        },
        confirm: async (id, realm, amount, amountDue, actor, versions) => {
          order.push(`confirm ${id} ${amount?.toString()} ${amountDue.toString()} ${actor.actorId} ${versions?.join()}`);
          return { kind: 'CONFIRMED', reconciliation, changed: true };
        },
      }),
      readMreRentTerm: async (...args) => {
        order.push(`mre ${args.join(' ')}`);
        return { amountDue: eur('800.00'), payments: [] };
      },
    });
    expect(await confirm({ principal, authorizationHeader: 'Bearer t', reconciliationId: 'r1', matchedAmount: eur('700.00'), expectedVersions: [1] })).toEqual({
      reconciliation,
      changed: true,
    });
    expect(order).toEqual([
      `precheck r1 ${REALM} ${eur('700.00').toString()}`,
      `mre Bearer t ${REALM} ${TENANT} 2027010100`,
      `confirm r1 ${eur('700.00').toString()} ${eur('800.00').toString()} anna@example.com 1`,
    ]);
  });

  it('confirm: a no-op or a refusal from the precheck never asks MRE; refusals under the locks as their errors', async () => {
    const withPrecheck = (outcome: Awaited<ReturnType<RentReconciliationRepository['confirmPrecheck']>>) =>
      confirmReconciliation({ repository: repository({ confirmPrecheck: async () => outcome }), readMreRentTerm: neverAsked })({
        principal,
        authorizationHeader: 'Bearer t',
        reconciliationId: 'r1',
      });
    expect(await withPrecheck({ kind: 'UNCHANGED', reconciliation })).toEqual({ reconciliation, changed: false });
    await expect(withPrecheck({ kind: 'NOT_FOUND' })).rejects.toBeInstanceOf(ReconciliationNotFoundError);
    await expect(withPrecheck({ kind: 'NOT_CONFIRMABLE', status: 'REJECTED' })).rejects.toBeInstanceOf(NotConfirmableError);
    await expect(withPrecheck({ kind: 'ABOVE_SUGGESTION', suggested: eur('800.00') })).rejects.toMatchObject({
      constructor: AboveSuggestionError,
      suggested: eur('800.00'),
    });
    await expect(withPrecheck({ kind: 'TRANSACTION_NOT_COUNTED', status: 'CLASSIFIED', correctionRole: null })).rejects.toBeInstanceOf(
      TransactionNotCountedError,
    );
    await expect(withPrecheck({ kind: 'RENT_CASH_EXCEEDED', rentCash: eur('800.00'), available: eur('1.00') })).rejects.toBeInstanceOf(RentCashExceededError);

    const underLocks = (
      outcome: Awaited<ReturnType<RentReconciliationRepository['confirm']>>,
      term: { amountDue: Money; payments: [] } | null = { amountDue: eur('800.00'), payments: [] },
    ) =>
      confirmReconciliation({
        repository: repository({
          confirmPrecheck: async () => ({ kind: 'PROCEED', reconciliation: suggestion, amount: eur('800.00') }),
          confirm: async () => outcome,
        }),
        readMreRentTerm: async () => term ?? undefined,
      })({ principal, authorizationHeader: 'Bearer t', reconciliationId: 'r1' });
    await expect(underLocks({ kind: 'SUGGESTION_STALE', openAmount: eur('300.00') })).rejects.toMatchObject({
      constructor: SuggestionStaleError,
      openAmount: eur('300.00'),
    });
    await expect(underLocks({ kind: 'VERSION_CONFLICT', expectedVersions: [3], currentVersion: 1 })).rejects.toBeInstanceOf(VersionConflictError);
    await expect(underLocks({ kind: 'NOT_CONFIRMABLE', status: 'REJECTED' })).rejects.toBeInstanceOf(NotConfirmableError);
    await expect(underLocks({ kind: 'RENT_CASH_EXCEEDED', rentCash: eur('800.00'), available: eur('0.00') })).rejects.toBeInstanceOf(RentCashExceededError);
    // A term MRE no longer returns: nothing is written.
    await expect(underLocks({ kind: 'CONFIRMED', reconciliation, changed: true }, null)).rejects.toBeInstanceOf(MreRentTermNotFoundError);
  });

  it('reject: each outcome as its result or error', async () => {
    const reject = (outcome: Awaited<ReturnType<RentReconciliationRepository['reject']>>) =>
      rejectReconciliation({ repository: repository({ reject: async () => outcome }), now: () => new Date(0) })({
        principal,
        reconciliationId: 'r1',
        reason: 'x',
      });
    expect(await reject({ kind: 'REJECTED', reconciliation, changed: true })).toEqual({ reconciliation, changed: true });
    await expect(reject({ kind: 'NOT_FOUND' })).rejects.toBeInstanceOf(ReconciliationNotFoundError);
    await expect(reject({ kind: 'NOT_REJECTABLE', status: 'CONFIRMED' })).rejects.toBeInstanceOf(NotRejectableError);
    await expect(reject({ kind: 'VERSION_CONFLICT', expectedVersions: [3], currentVersion: 1 })).rejects.toBeInstanceOf(VersionConflictError);
  });
});
