import { describe, expect, it } from 'vitest';
import type { RentTenantTermQueries, TenantTermReconciliation } from '../domains/rent-reconciliation/index.js';
import { Money } from '../shared/index.js';
import { AccessError } from './access.js';
import { MreUnavailableError } from './errors.js';
import type { MreMonthRentView } from './rent-reconciliations.js';
import { getTenantTerms, listRentTenants } from './rent-tenant-terms.js';

/** §37.7 (#364, VC-X-72) with stub ports: the merge of MRE's months and DE's matches, and when MRE degrades. */
const REALM = '64b0c0ffee00000000000017';
const TENANT = '6512f0c2a1b2c3d4e5f60a01';
const OTHER = '6512f0c2a1b2c3d4e5f60a02';
const principal = { email: 'anna@example.com', mreRealmId: REALM, mreRole: 'administrator' } as const;
const eur = (amount: string) => Money.of(amount, 'EUR');
const rec = (mreRentTerm: string, status: TenantTermReconciliation['status'], amount: string): TenantTermReconciliation => ({
  mreRentTerm,
  status,
  matchedAmount: eur(amount),
});

function harness(options: {
  readonly known?: boolean | Error;
  readonly months?: Record<string, readonly MreMonthRentView[] | Error>;
  readonly de?: readonly TenantTermReconciliation[];
}) {
  const monthsRead: string[] = [];
  const deReads: unknown[][] = [];
  const queries: RentTenantTermQueries = {
    tenants: async () => Promise.reject(new Error('not used')),
    tenantTerms: async (...args) => (deReads.push(args), options.de ?? []),
  };
  const use = getTenantTerms({
    queries,
    lookupMreTenant: async (auth, realm, tenant) => {
      expect([auth, realm, tenant]).toEqual(['Bearer t', REALM, TENANT]);
      if (options.known instanceof Error) throw options.known;
      return options.known ?? true;
    },
    readMreMonth: async (auth, realm, year, month) => {
      expect([auth, realm]).toEqual(['Bearer t', REALM]);
      const key = `${year}-${String(month).padStart(2, '0')}`;
      monthsRead.push(key);
      const answer = options.months?.[key] ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  const run = (from = '2027-01', to = '2027-03') => use({ principal, authorizationHeader: 'Bearer t', mreTenantId: TENANT, from, to });
  return { run, monthsRead, deReads };
}

const rent = (mreTenantId: string, term: string, amount: string): MreMonthRentView => ({ mreTenantId, term, amountDue: eur(amount) });

describe('getTenantTerms (§37.7 (b))', () => {
  it('AVAILABLE: a term on both sides, on the MRE side only and on the DE side only (inMre false), newest first', async () => {
    const { run, monthsRead, deReads } = harness({
      months: {
        '2027-02': [rent(TENANT, '2027020100', '800.00'), rent(OTHER, '2027020100', '650.00')],
        '2027-03': [rent(TENANT, '2027030100', '800.00')],
      },
      de: [rec('2027010100', 'CONFIRMED', '800.00'), rec('2027020100', 'CONFIRMED', '300.00')],
    });
    const result = await run();
    expect(monthsRead).toEqual(['2027-01', '2027-02', '2027-03']);
    expect(deReads).toEqual([[REALM, TENANT, '2027010000', '2027040000']]);
    expect(result).toEqual({
      mreTenantId: TENANT,
      from: '2027-01',
      to: '2027-03',
      mreStatus: 'AVAILABLE',
      items: [
        {
          mreRentTerm: '2027030100',
          month: '2027-03',
          inMre: true,
          amountDue: eur('800.00'),
          matchedTotal: eur('0.00'),
          reconciliationCount: 0,
          coverage: 'UNMATCHED',
          openAmount: eur('800.00'),
        },
        {
          mreRentTerm: '2027020100',
          month: '2027-02',
          inMre: true,
          amountDue: eur('800.00'),
          matchedTotal: eur('300.00'),
          reconciliationCount: 1,
          coverage: 'PARTIALLY_MATCHED',
          openAmount: eur('500.00'),
        },
        {
          mreRentTerm: '2027010100',
          month: '2027-01',
          inMre: false,
          amountDue: null,
          matchedTotal: eur('800.00'),
          reconciliationCount: 1,
          coverage: null,
          openAmount: null,
        },
      ],
    });
  });

  it('matchedTotal sums CONFIRMED only; the count is every status; coverage at its boundaries (as §37.2)', async () => {
    const { run } = harness({
      months: {
        '2027-01': [rent(TENANT, '2027010100', '800.00'), rent(TENANT, '2027011500', '800.00')],
        '2027-02': [rent(TENANT, '2027020100', '800.00')],
      },
      de: [
        rec('2027010100', 'CONFIRMED', '800.00'),
        rec('2027010100', 'RELEASED', '800.00'),
        rec('2027010100', 'SUGGESTED', '800.00'),
        rec('2027010100', 'REJECTED', '800.00'),
        rec('2027011500', 'CONFIRMED', '800.01'),
        rec('2027020100', 'CONFIRMED', '799.99'),
      ],
    });
    const items = (await run('2027-01', '2027-02')).items;
    expect(items.map((i) => [i.mreRentTerm, i.matchedTotal.amount, i.reconciliationCount, i.coverage, i.openAmount?.amount])).toEqual([
      ['2027020100', '799.99', 1, 'PARTIALLY_MATCHED', '0.01'],
      ['2027011500', '800.01', 1, 'OVERPAID', '-0.01'],
      ['2027010100', '800.00', 4, 'MATCHED', '0.00'],
    ]);
  });

  it('NOT_RETURNED for a Tenant MRE does not list: no month is read, and the DE side is answered', async () => {
    const { run, monthsRead } = harness({ known: false, de: [rec('2027020100', 'CONFIRMED', '800.00')] });
    const result = await run();
    expect(monthsRead).toEqual([]);
    expect(result.mreStatus).toBe('NOT_RETURNED');
    expect(result.items).toEqual([
      {
        mreRentTerm: '2027020100',
        month: '2027-02',
        inMre: null,
        amountDue: null,
        matchedTotal: eur('800.00'),
        reconciliationCount: 1,
        coverage: null,
        openAmount: null,
      },
    ]);
  });

  it('UNAVAILABLE when one month of the window fails, with the DE side and no partial MRE list', async () => {
    const { run } = harness({
      months: { '2027-01': [rent(TENANT, '2027010100', '800.00')], '2027-02': new MreUnavailableError('down') },
      de: [rec('2027030100', 'CONFIRMED', '100.00')],
    });
    const result = await run();
    expect(result.mreStatus).toBe('UNAVAILABLE');
    expect(result.items.map((i) => [i.mreRentTerm, i.inMre, i.amountDue, i.coverage])).toEqual([['2027030100', null, null, null]]);
  });

  it('UNAVAILABLE when the Tenant list fails; a refused token or caller stays an error', async () => {
    expect((await harness({ known: new MreUnavailableError('down') }).run()).mreStatus).toBe('UNAVAILABLE');
    await expect(harness({ known: new AccessError('UNAUTHENTICATED', 'x') }).run()).rejects.toBeInstanceOf(AccessError);
    await expect(harness({ months: { '2027-02': new AccessError('FORBIDDEN', 'x') } }).run()).rejects.toBeInstanceOf(AccessError);
  });

  it('the window edges: the months from and to are read, across a year; an MRE term of another month is not listed', async () => {
    const { run, monthsRead, deReads } = harness({
      months: {
        '2026-12': [rent(TENANT, '2026120100', '800.00'), rent(TENANT, '2026110100', '800.00')],
        '2027-01': [rent(TENANT, '2027010100', '800.00'), rent(TENANT, '2027020100', '800.00')],
      },
    });
    const result = await run('2026-12', '2027-01');
    expect(monthsRead).toEqual(['2026-12', '2027-01']);
    // The DE read's upper bound is the first key of the month after `to`, exclusive.
    expect(deReads).toEqual([[REALM, TENANT, '2026120000', '2027020000']]);
    expect(result.items.map((i) => i.mreRentTerm)).toEqual(['2027010100', '2026120100']);
  });

  it('a window of twelve months reads twelve months', async () => {
    const { run, monthsRead } = harness({});
    await run('2027-01', '2027-12');
    expect(monthsRead).toHaveLength(12);
  });
});

describe('listRentTenants (§37.7 (a))', () => {
  it('answers the DE page for the Realm of the caller', async () => {
    const page = { items: [], page: 3, pageSize: 10, total: 0 };
    const seen: unknown[] = [];
    const use = listRentTenants({
      queries: { tenants: async (...args) => (seen.push(args), page), tenantTerms: async () => Promise.reject(new Error('not used')) },
    });
    expect(await use({ principal, page: { page: 3, pageSize: 10 } })).toBe(page);
    expect(seen).toEqual([[REALM, { page: 3, pageSize: 10 }]]);
  });
});
