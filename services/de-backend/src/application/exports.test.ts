import { describe, expect, it } from 'vitest';
import type { TransactionExportHead } from '../domains/ledger/index.js';
import {
  ExportTooLargeError,
  PROPERTY_EXPORT_LIMIT,
  TRANSACTION_EXPORT_BATCH_SIZE,
  TRANSACTION_EXPORT_LIMIT,
  exportProperty,
  exportTransactions,
  type PropertyExportReads,
} from './exports.js';
import { PropertyReferenceNotFoundError } from './refresh-property-reference.js';

/** VC-X-04 (api-design.md §58S): the limits of both exports and what the property file collects, against fake reads. */
const principal = { email: 'anna@example.com', mreRealmId: '64b0c0ffee00000000058c0a', mreRole: 'administrator' as const };
const head = (transactionCount: number): TransactionExportHead => ({ generatedAt: new Date('2026-11-06T00:00:00Z'), transactionCount, rowCount: undefined });

describe('exportTransactions', () => {
  it('passes the batch size and rows; 100000 Transactions are exported, 100001 are EXPORT_TOO_LARGE before the sink head', async () => {
    expect([TRANSACTION_EXPORT_LIMIT, TRANSACTION_EXPORT_BATCH_SIZE]).toEqual([100_000, 500]);
    const run = async (count: number) => {
      const seen: unknown[] = [];
      const begun: number[] = [];
      const command = exportTransactions({
        queries: {
          exportAll: async (realm, filter, options, sink) => {
            seen.push({ realm, filter, options });
            await sink.begin(head(count));
          },
        },
      });
      await command({
        principal,
        filter: { current: true },
        withSplits: true,
        sink: { begin: (h) => void begun.push(h.transactionCount), batch: async () => undefined },
      });
      return { seen, begun };
    };
    expect(await run(100_000)).toEqual({
      seen: [{ realm: principal.mreRealmId, filter: { current: true }, options: { batchSize: 500, countRows: true } }],
      begun: [100_000],
    });
    await expect(run(100_001)).rejects.toEqual(new ExportTooLargeError(100_001, 100_000));
  });
});

/** Fake reads of one property: `extra` Ownerships beyond the first, and the Parties the records name. */
function reads(options: { readonly ownerships?: number } = {}) {
  const p = 'p';
  const found = <T>(value: T) => Promise.resolve(value);
  const ownershipCount = options.ownerships ?? 1;
  const looked: string[] = [];
  const r = {
    propertyReferences: { findById: (id: string) => found(id === p ? ({ id: p } as never) : undefined) },
    ownerships: {
      history: (_id: string, _realm: string, page: { pageSize: number }) =>
        found({
          items: Array.from({ length: Math.min(ownershipCount, page.pageSize) }, (_, i) => ({ id: `o${i}`, ownerPartyId: 'owner' })),
          page: 1,
          pageSize: page.pageSize,
          total: ownershipCount,
        } as never),
    },
    acquisitions: { findById: (id: string) => found({ id, buyerPartyIds: ['buyer'], sellerPartyIds: ['seller'] } as never) },
    acquisitionCosts: {
      listCosts: () => found([{ counterpartyPartyId: 'notary', classification: { advisorPartyId: 'advisor' } }] as never),
      listPayments: () => found({ purchasePrice: {}, items: [{ id: 'pay' }] } as never),
    },
    landBuildingAllocations: { list: () => found({ current: null, items: [{ advisorPartyId: 'taxAdvisor' }] } as never) },
    loans: { findById: (id: string) => found({ id, status: 'VOID', lenderPartyId: 'lender', borrowerPartyIds: ['buyer'] } as never) },
    loanTerms: { list: () => found([] as never) },
    loanAllocations: { list: () => found([] as never) },
    loanDebt: { debtInputs: () => found({ statements: [] } as never) },
    wegs: {
      findMembership: (id: string) => found({ id, wegId: 'w' } as never),
      findWeg: (id: string) => found({ id, administratorPartyId: 'hv' } as never),
    },
    securityDeposits: { findById: (id: string) => found({ id } as never) },
    parties: { findById: (id: string) => (looked.push(id), found({ id } as never)) },
    scope: {
      acquisitionIds: () => found(['a']),
      loanIds: () => found(['l']),
      membershipIds: () => found(['m']),
      deposits: () => found({ attributed: ['d'], severalCandidates: [{ securityDepositId: 'd2', candidates: ['p', 'q'] }] }),
    },
  } satisfies PropertyExportReads;
  return { reads: r, looked };
}

describe('exportProperty', () => {
  const run = (r: PropertyExportReads, limit?: number, propertyReferenceId = 'p') =>
    exportProperty({ snapshots: { read: (callback) => callback(r, new Date('2026-11-06T12:00:00Z')) }, ...(limit === undefined ? {} : { limit }) })({
      principal,
      propertyReferenceId,
    });

  it('collects every collection and the Parties named by every PartyId field, once each, by id; the statements of a VOID Loan too', async () => {
    const { reads: r, looked } = reads();
    const doc = await run(r);
    expect(doc.parties.map((x) => x.id)).toEqual(['advisor', 'buyer', 'hv', 'lender', 'notary', 'owner', 'seller', 'taxAdvisor']);
    expect(looked).toEqual(doc.parties.map((x) => x.id));
    expect(doc.loans).toHaveLength(1);
    expect(doc.loans[0]?.balanceStatements).toEqual([]);
    expect(doc.securityDepositsNotAttributed).toEqual([{ securityDepositId: 'd2', reason: 'SEVERAL_PROPERTY_REFERENCES', candidates: ['p', 'q'] }]);
    expect(doc.generatedAt.toISOString()).toBe('2026-11-06T12:00:00.000Z');
    expect(doc.mreRealmId).toBe(principal.mreRealmId);
  });

  it('an unknown PropertyReference is PropertyReferenceNotFoundError', async () => {
    await expect(run(reads().reads, undefined, 'x')).rejects.toBeInstanceOf(PropertyReferenceNotFoundError);
  });

  it('EXPORT_TOO_LARGE above 10000 records: counted over all collections, at the limit exported', async () => {
    expect(PROPERTY_EXPORT_LIMIT).toBe(10_000);
    // 1 property + 1 ownership + acquisition (1 + 1 cost + 1 payment + 1 allocation) + loan 1 + membership and WEG 2
    // + 1 deposit + 1 not attributed + 8 Parties = 19.
    await expect(run(reads().reads, 19)).resolves.toBeDefined();
    await expect(run(reads().reads, 18)).rejects.toEqual(new ExportTooLargeError(19, 18));
    // The Ownership history alone above the limit: refused with its total, before anything else is read.
    await expect(run(reads({ ownerships: 10_001 }).reads)).rejects.toEqual(new ExportTooLargeError(10_001, 10_000));
  });
});
