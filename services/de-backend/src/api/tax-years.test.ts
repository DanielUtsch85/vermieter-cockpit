import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getTaxYearView,
  type LoanAllocationSetView,
  type PrincipalVerifier,
  type TaxClassificationRepository,
  type TaxMeaning,
  type TaxYearRead,
} from '../application/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith } from './app.test-support.js';

/**
 * VC-7-04 HTTP contract (api-design.md §58C): every 400, the 404s for the PropertyReference and for `ownerPartyId`,
 * `NOT_AN_OWNER_IN_YEAR` (and an owner by an item only), `TAX_YEAR_TOO_LARGE`, the DTO of each place, no `ETag`. The
 * use case is the real one over a repository returning a synthetic read; figures and ids are invented.
 */
const REALM = '64b0c0ffee000000000000a8';
const PR = '3c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const A = 'aaaaaaaa-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const B = 'bbbbbbbb-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const STRANGER = 'cccccccc-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const SELLER = 'dddddddd-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const admin: PrincipalVerifier = async (_auth, mreRealmId) => ({ email: 'anna@example.com', mreRealmId: mreRealmId ?? '', mreRole: 'administrator' });
let server: Server | undefined;

function meaning(
  amount: string,
  taxCategory: TaxMeaning['taxCategory'],
  treatment: TaxMeaning['treatment'],
  bookingDate: string,
  taxYear = Number(bookingDate.slice(0, 4)),
) {
  const sourceId = id();
  const m: TaxMeaning = {
    splitId: sourceId,
    sourceId,
    sourceType: 'TRANSACTION_SPLIT',
    transactionId: id(),
    position: 1,
    bookingDate: day(bookingDate),
    direction: taxCategory === 'RENT' ? 'INFLOW' : 'OUTFLOW',
    amount: eur(amount),
    financialCategoryCode: 'X',
    categoryType: 'OPERATING_EXPENSE',
    propertyReferenceId: PR,
    transactionStatus: 'CONFIRMED',
    correctionRole: null,
    counts: true,
    taxCategory,
    treatment,
    reviewState: treatment === null ? 'NEEDS_REVIEW' : 'SUGGESTED',
    origin: 'DEFAULT',
    rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
    classificationId: null,
    taxYear,
    attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: Number(bookingDate.slice(0, 4)), proposedYear: taxYear, overridden: false },
    refund: null,
    netAmount: null,
    treatmentRule: null,
    distribution: null,
    suggestion: null,
    flags: taxYear === Number(bookingDate.slice(0, 4)) ? [] : [{ code: 'ATTRIBUTED_BY_10_DAY_RULE', details: { bookingDate: day(bookingDate) } as never }],
  };
  return { item: { ...m, yearAmount: m.amount }, listed: true };
}

const rent = meaning('750.01', 'RENT', 'INCOME', '2027-03-01');
const lateRent = meaning('750.01', 'RENT', 'INCOME', '2026-12-29', 2027);
const repair = meaning('5000.00', 'MAINTENANCE', 'CAPITALIZED', '2027-04-01');
const principal = meaning('2400.00', 'NOT_RELEVANT', 'NOT_RELEVANT', '2027-05-01');
const other = meaning('70.00', 'UNCLASSIFIED', null, '2027-05-02');
const deposit = id();

/** No depreciation asset, the property owned in the year (`NO_ASSET`): the Phase-7 fixtures' state (VC-8-05). */
const PHASE_7_DEPRECIATION: TaxYearRead['depreciation'] = { year: 2027, assets: [], withoutAsset: { acquisitionIds: [], items: [], ownershipInYear: true } };

const reads: TaxYearRead = {
  propertyReferenceId: PR,
  ownerPartyFound: null,
  sources: [lateRent, rent, repair, principal, other],
  unattributedDeposits: [
    {
      securityDepositId: deposit,
      sourceId: deposit,
      sourceType: 'DEPOSIT_CLOSING',
      status: 'CLOSED',
      closingDate: day('2027-06-30'),
      retainedAmount: eur('400.00'),
      amount: eur('400.00'),
      propertyReferenceId: null,
      propertyCandidates: [],
      counts: true,
      taxYear: 2027,
      taxCategory: 'UNCLASSIFIED',
      treatment: null,
      reviewState: 'NEEDS_REVIEW',
      origin: 'DEFAULT',
      rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
      classificationId: null,
      flags: [{ code: 'NO_PROPERTY_REFERENCE', details: { reason: 'NO_RECONCILED_RENT' } }],
    },
  ],
  ownerships: [
    { id: id(), partyId: A, share: { numerator: 1, denominator: 2 }, validFrom: day('2026-01-01'), validUntil: null },
    { id: id(), partyId: B, share: { numerator: 1, denominator: 2 }, validFrom: day('2027-01-01'), validUntil: null },
    // The seller held the share until the end of 2026; the rent paid on 29 December 2026 counts in 2027.
    { id: id(), partyId: SELLER, share: { numerator: 1, denominator: 2 }, validFrom: day('2020-01-01'), validUntil: day('2026-12-31') },
  ],
  checks: [],
  attribution: { references: [], candidates: [] },
  allocatedLoanInterest: [],
  loanAllocationSets: new Map(),
  depreciation: PHASE_7_DEPRECIATION,
};

async function start(read: (pr: string, owner: string | null) => TaxYearRead | undefined): Promise<string> {
  const repository = {
    readTaxYear: async (pr: string, _realm: string, _year: number, owner: string | null) => read(pr, owner),
  } as unknown as TaxClassificationRepository;
  const taxYear = getTaxYearView({ repository, now: () => new Date('2026-10-30T10:00:00Z') });
  server = createApp({ isReady: async () => true, verifyPrincipal: admin, ...commandsWith({ taxation: { taxYear } }) }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const get = (base: string, path: string) =>
  fetch(`${base}/api/v1${path}`, { headers: { authorization: 'Bearer a.b.c', organizationid: REALM, 'content-type': 'application/json' } });
const fields = async (res: Response) => {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: { details: { fields: { field: string; code: string }[] } } }).error.details.fields;
};
const known = (pr: string, owner: string | null) =>
  pr !== PR ? undefined : { ...reads, ownerPartyFound: owner === null ? null : [A, B, STRANGER, SELLER].includes(owner) };

describe('GET /property-references/{id}/tax-years/{year} (§58C)', () => {
  it('every 400: the id, year (INVALID_FORMAT, OUT_OF_RANGE), ownerPartyId, an unknown parameter', async () => {
    const base = await start(known);
    expect(await fields(await get(base, `/property-references/x/tax-years/2027`))).toEqual([{ field: 'propertyReferenceId', code: 'INVALID_FORMAT' }]);
    for (const year of ['20x7', '-2027', '2027.0', '+2027']) {
      expect(await fields(await get(base, `/property-references/${PR}/tax-years/${encodeURIComponent(year)}`)), year).toEqual([
        { field: 'year', code: 'INVALID_FORMAT' },
      ]);
    }
    for (const year of ['1999', '2101', '0']) {
      expect(await fields(await get(base, `/property-references/${PR}/tax-years/${year}`)), year).toEqual([{ field: 'year', code: 'OUT_OF_RANGE' }]);
    }
    expect(await fields(await get(base, `/property-references/${PR}/tax-years/2027?ownerPartyId=x`))).toEqual([
      { field: 'ownerPartyId', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await get(base, `/property-references/${PR}/tax-years/2027?year=2027`))).toEqual([{ field: '(body)', code: 'INVALID_FORMAT' }]);
    expect((await get(base, `/property-references/${PR}/tax-years/2000`)).status).toBe(200);
    expect((await get(base, `/property-references/${PR}/tax-years/2100`)).status).toBe(200);
  });

  it('404 for the PropertyReference and for ownerPartyId; NOT_AN_OWNER_IN_YEAR; an owner by an item only; TAX_YEAR_TOO_LARGE', async () => {
    const base = await start(known);
    const other = 'eeeeeeee-2f2c-4a8e-9d55-1f0d8c1e2a3d';
    const missing = await get(base, `/property-references/${other}/tax-years/2027`);
    expect([missing.status, ((await missing.json()) as { error: { details: unknown } }).error.details]).toEqual([404, { propertyReferenceId: other }]);
    const party = await get(base, `/property-references/${PR}/tax-years/2027?ownerPartyId=${other}`);
    expect([party.status, ((await party.json()) as { error: { code: string; details: unknown } }).error]).toEqual([
      404,
      expect.objectContaining({ code: 'NOT_FOUND', details: { ownerPartyId: other } }),
    ]);
    const stranger = await get(base, `/property-references/${PR}/tax-years/2027?ownerPartyId=${STRANGER}`);
    expect([stranger.status, ((await stranger.json()) as { error: { code: string; details: unknown } }).error]).toEqual([
      422,
      expect.objectContaining({ code: 'NOT_AN_OWNER_IN_YEAR', details: { ownerPartyId: STRANGER, year: 2027 } }),
    ]);
    // The seller holds no Ownership in 2027 but shares the rent paid on 29 December 2026 (the 10-day rule).
    const seller = await get(base, `/property-references/${PR}/tax-years/2027?ownerPartyId=${SELLER}`);
    expect(seller.status).toBe(200);
    const sellerView = (await seller.json()) as { level: string; einnahmen: { total: unknown; lines: { items: { share: unknown }[] }[] } };
    expect(sellerView.level).toBe('OWNER');
    expect(sellerView.einnahmen.total).toEqual({ amount: '375.00', currency: 'EUR' });
    const big = await start(() => ({ ...reads, sources: Array.from({ length: 5001 }, () => principal) }));
    const tooLarge = await get(big, `/property-references/${PR}/tax-years/2027`);
    expect([tooLarge.status, ((await tooLarge.json()) as { error: { code: string; details: unknown } }).error]).toEqual([
      409,
      expect.objectContaining({
        code: 'CONFLICT',
        details: { reason: 'TAX_YEAR_TOO_LARGE', itemCount: 5002, limit: 5000, pagedList: `/api/v1/property-references/${PR}/tax-meanings?year=2027` },
      }),
    ]);
  });

  it('the DTO of each place, the owners and notOwned, flags, review and ruleVersions; no ETag', async () => {
    const base = await start(known);
    const res = await get(base, `/property-references/${PR}/tax-years/2027`);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')?.startsWith('W/')).toBe(true);
    const v = (await res.json()) as Record<string, unknown> & {
      einnahmen: { total: unknown; lines: { taxCategory: string; total: unknown; itemCount: number; subtotals: unknown; items: Record<string, unknown>[] }[] };
      werbungskosten: { lines: { taxCategory: string; subtotals: unknown }[] };
      capitalized: { total: unknown; items: Record<string, unknown>[] };
      notInView: { items: Record<string, unknown>[] };
      unclassified: { items: Record<string, unknown>[] };
      notAttributed: { items: Record<string, unknown>[] };
      owners: { ownerPartyId: string; result: unknown }[];
      notOwned: unknown;
      flags: { code: string }[];
      review: { final: boolean };
    };
    expect(v).toMatchObject({
      propertyReferenceId: PR,
      year: 2027,
      ownerPartyId: null,
      level: 'PROPERTY',
      computedOn: '2026-10-30',
      depreciation: { status: 'DEPRECIATION_NOT_AVAILABLE', amount: null },
      result: { amount: { amount: '1500.02', currency: 'EUR' }, kind: 'SURPLUS', basis: 'BEFORE_DEPRECIATION' },
      acquisitions: [],
      notOwned: null,
    });
    const rentLine = v.einnahmen.lines[0];
    expect(rentLine).toMatchObject({ taxCategory: 'RENT', total: { amount: '1500.02', currency: 'EUR' }, itemCount: 2, subtotals: null });
    expect(rentLine?.items[0]).toEqual({
      sourceType: 'TRANSACTION_SPLIT',
      sourceId: lateRent.item.sourceId,
      sourcePosition: null,
      transactionId: lateRent.item.transactionId,
      date: '2026-12-29',
      dateSource: 'BOOKING',
      taxYear: 2027,
      direction: 'INFLOW',
      amount: { amount: '750.01', currency: 'EUR' },
      lineAmount: { amount: '750.01', currency: 'EUR' },
      taxCategory: 'RENT',
      treatment: 'INCOME',
      reviewState: 'SUGGESTED',
      origin: 'DEFAULT',
      classificationId: null,
      rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
      treatmentRule: null,
      attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: 2026, proposedYear: 2027, overridden: false },
      refund: null,
      distribution: null,
      suggestion: null,
      share: null,
      flags: [
        { code: 'ATTRIBUTED_BY_10_DAY_RULE', details: { bookingDate: '2026-12-29' } },
        { code: 'SHARE_DATE_OUTSIDE_TAX_YEAR', details: { shareDate: '2026-12-29', nearestDayOfYear: '2027-01-01' } },
      ],
      loanAllocation: null,
    });
    expect(v.werbungskosten.lines.find((l) => l.taxCategory === 'MAINTENANCE')?.subtotals).toEqual({
      immediate: { amount: '0.00', currency: 'EUR' },
      distributed82b: { amount: '0.00', currency: 'EUR' },
    });
    expect(v.capitalized).toMatchObject({
      total: { amount: '5000.00', currency: 'EUR' },
      items: [{ sourceId: repair.item.sourceId, lineAmount: { amount: '5000.00' } }],
    });
    expect(v.notInView.items).toEqual([expect.objectContaining({ sourceId: principal.item.sourceId, lineAmount: null })]);
    expect(v.unclassified.items).toEqual([expect.objectContaining({ sourceId: other.item.sourceId, lineAmount: null })]);
    expect(v.notAttributed.items).toEqual([
      expect.objectContaining({
        sourceType: 'DEPOSIT_CLOSING',
        sourceId: deposit,
        dateSource: 'CLOSING',
        lineAmount: null,
        share: null,
        reason: 'NO_RECONCILED_RENT',
        candidates: [],
        href: `/api/v1/security-deposits/${deposit}/tax-meaning`,
      }),
    ]);
    // The late rent is A's and the seller's; March's A's and B's: 375.01 + 375.01, 375.00, 375.00 (A < B < SELLER by id).
    expect(v.owners.map((o) => [o.ownerPartyId, o.result])).toEqual([
      [A, { amount: { amount: '750.02', currency: 'EUR' }, kind: 'SURPLUS', basis: 'BEFORE_DEPRECIATION' }],
      [B, { amount: { amount: '375.00', currency: 'EUR' }, kind: 'SURPLUS', basis: 'BEFORE_DEPRECIATION' }],
      [SELLER, { amount: { amount: '375.00', currency: 'EUR' }, kind: 'SURPLUS', basis: 'BEFORE_DEPRECIATION' }],
    ]);
    expect(v.flags.map((f) => f.code)).toEqual(['DEPRECIATION_NOT_AVAILABLE', 'UNATTRIBUTED_ITEMS']);
    expect(v.review.final).toBe(false);
    expect(v['ruleVersions']).toEqual([
      expect.objectContaining({ ruleCode: 'DE_CASH_TIMING', version: 1, status: 'ACTIVE', itemCount: 5 }),
      expect.objectContaining({ ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1, status: 'ACTIVE', itemCount: 6 }),
    ]);
    // The owner level: the share on the item, owners and notOwned null.
    const owner = (await (await get(base, `/property-references/${PR}/tax-years/2027?ownerPartyId=${B}`)).json()) as {
      owners: unknown;
      notOwned: unknown;
      einnahmen: { lines: { items: { share: unknown; lineAmount: unknown }[] }[] };
      capitalized: { items: { share: unknown }[] };
      notInView: { items: { share: { amount: unknown } }[] };
    };
    expect([owner.owners, owner.notOwned]).toEqual([null, null]);
    expect(owner.einnahmen.lines[0]?.items).toEqual([
      expect.objectContaining({
        lineAmount: { amount: '375.00', currency: 'EUR' },
        share: { ownershipId: reads.ownerships[1]?.id, share: '1/2', amount: { amount: '375.00', currency: 'EUR' } },
      }),
    ]);
    expect(owner.notInView.items[0]?.share.amount).toBeNull();
  });

  it('§58D: loanAllocation on a Loan item (null elsewhere), the property’s part at the owner level; a split entry in notAttributed; the open flags', async () => {
    const loanId = id();
    const setId = id();
    const otherPr = 'ffffffff-2f2c-4a8e-9d55-1f0d8c1e2a3d';
    const loanSplit = (amount: string, bookingDate: string) => {
      const m = meaning(amount, 'LOAN_INTEREST', 'DEDUCTIBLE', bookingDate);
      return { item: { ...m.item, propertyReferenceId: null }, loanId };
    };
    const [attributed, gap] = [loanSplit('100.01', '2027-03-01'), loanSplit('40.00', '2027-01-15')];
    const priced = {
      id: setId as LoanAllocationSetView['id'],
      loanId,
      mreRealmId: REALM,
      status: 'VALID' as const,
      validFrom: day('2027-02-01'),
      validUntil: null,
      basis: 'PURCHASE_PRICE' as const,
      allocations: [
        { propertyReferenceId: PR, share: { numerator: 3n, denominator: 5n }, acquisitionId: id() },
        { propertyReferenceId: otherPr, share: { numerator: 2n, denominator: 5n }, acquisitionId: id() },
      ],
      notes: null,
      voidedAt: null,
      voidReason: null,
      createdAt: new Date('2027-02-01T08:00:00Z'),
      version: 1,
    } satisfies LoanAllocationSetView;
    const read: TaxYearRead = {
      ...reads,
      sources: [rent],
      unattributedDeposits: [],
      allocatedLoanInterest: [attributed, gap],
      loanAllocationSets: new Map([[loanId, [priced]]]),
    };
    const base = await start((pr, owner) => (pr === PR ? { ...read, ownerPartyFound: owner === null ? null : true } : undefined));
    type Item = Record<string, unknown> & { sourceId: string; flags: { code: string; details: unknown }[] };
    type View = {
      einnahmen: { lines: { items: Item[] }[] };
      werbungskosten: { lines: { taxCategory: string; items: Item[] }[] };
      notAttributed: { items: Item[] };
    };
    const v = (await (await get(base, `/property-references/${PR}/tax-years/2027`)).json()) as View & {
      flags: { code: string; details: unknown }[];
      review: { open: unknown[] };
    };
    expect(v.einnahmen.lines[0]?.items[0]?.['loanAllocation']).toBeNull();
    const item = v.werbungskosten.lines.find((l) => l.taxCategory === 'LOAN_INTEREST')?.items[0] as Item;
    expect(item).toMatchObject({
      sourceId: attributed.item.sourceId,
      amount: { amount: '100.01', currency: 'EUR' },
      lineAmount: { amount: '60.01', currency: 'EUR' },
    });
    expect(item['loanAllocation']).toEqual({
      loanId,
      allocationSetId: setId,
      validFrom: '2027-02-01',
      validUntil: null,
      basis: 'PURCHASE_PRICE',
      share: '3/5',
      propertyPart: { amount: '60.01', currency: 'EUR' },
    });
    expect(item.flags).toEqual([{ code: 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', details: { loanId, allocationSetId: setId } }]);
    expect(v.notAttributed.items).toEqual([
      expect.objectContaining({
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: gap.item.sourceId,
        lineAmount: null,
        share: null,
        reason: 'NO_LOAN_ALLOCATION',
        candidates: [PR, otherPr].sort(),
        href: `/api/v1/loans/${loanId}/allocations?asOf=2027-01-15`,
        loanAllocation: { loanId, allocationSetId: null, validFrom: null, validUntil: null, basis: null, share: null, propertyPart: null },
      }),
    ]);
    expect(v.flags.find((f) => f.code === 'LOAN_INTEREST_NOT_ATTRIBUTED')?.details).toEqual({
      loanIds: [loanId],
      interestTotal: { amount: '40.00', currency: 'EUR' },
      splitIds: [gap.item.sourceId],
    });
    expect(v.review.open).toEqual(
      expect.arrayContaining([
        { code: 'LOAN_INTEREST_NOT_ATTRIBUTED', count: 1 },
        { code: 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', count: 1 },
      ]),
    );
    // The owner level: A's half of the property's part, propertyPart still the property's.
    const a = (await (await get(base, `/property-references/${PR}/tax-years/2027?ownerPartyId=${A}`)).json()) as View;
    const own = a.werbungskosten.lines.find((l) => l.taxCategory === 'LOAN_INTEREST')?.items[0] as Item;
    expect(own['lineAmount']).toEqual({ amount: '30.01', currency: 'EUR' });
    expect(own['share']).toMatchObject({ share: '1/2', amount: { amount: '30.01', currency: 'EUR' } });
    expect((own['loanAllocation'] as { propertyPart: unknown }).propertyPart).toEqual({ amount: '60.01', currency: 'EUR' });
    expect(a.notAttributed.items.map((i) => [i.sourceId, i['share']])).toEqual([[gap.item.sourceId, null]]);
  });

  it('VC-8-05: Line.line, the AfA lines and AfaItem, depreciation, capitalized.component and result.basis at both levels', async () => {
    const asset = 'eeeeeeee-0000-4000-8000-000000000010';
    const acquisition = 'eeeeeeee-0000-4000-8000-000000000002';
    const flag = (code: string, level: 'OPEN' | 'INFORMATIVE') => ({ code, level, details: {}, ownerPartyIds: [] });
    const part = (owner: string, amount: string, share: string) => ({
      partKey: `OWNER:${owner}`,
      ownerPartyId: owner,
      ownershipIds: [`own-${owner}`],
      share,
      months: 12,
      fraction: '1/50',
      amount: eur(amount),
      reasons: [],
      flags: [],
    });
    const itemStart = { date: day('2027-01-01'), dateSource: 'ITEM_DATE', method: 'START_OF_YEAR', month: '2027-01', firstYearMonths: 12 };
    const rate = { kind: 'BAND', rate: '1/50', ratePercent: '2', usefulLifeYears: null, legalBasis: '§ 7 Abs. 4 S. 1 Nr. 2 Buchst. b EStG' };
    const rule = { ruleCode: 'DE_AFA_BUILDING_LINEAR', version: 2 };
    const component = (componentId: string, kind: 'ACQUISITION' | 'CAPITALIZED_ITEM', amount: string, parts: ReturnType<typeof part>[]) => ({
      componentId,
      kind,
      acquisitionId: kind === 'ACQUISITION' ? acquisition : null,
      source: kind === 'ACQUISITION' ? null : { sourceType: 'TRANSACTION_SPLIT', sourceId: repair.item.sourceId, sourcePosition: null },
      computable: true,
      reasons: [],
      basis: eur(kind === 'ACQUISITION' ? '254400.00' : '5000.00'),
      rate,
      start:
        kind === 'ACQUISITION'
          ? { ...itemStart, date: day('2026-07-01'), dateSource: 'ECONOMIC_TRANSFER_DATE', method: 'TRANSFER_DATE', month: '2026-07', firstYearMonths: 6 }
          : itemStart,
      months: 12,
      amount: eur(amount),
      rule,
      parts,
      flags: kind === 'ACQUISITION' ? [] : [flag('SUBSEQUENT_COST_START_TO_VERIFY', 'OPEN')],
    });
    const components = [
      component(`ACQUISITION:${acquisition}`, 'ACQUISITION', '2544.00', [part(A, '1272.00', '1/2'), part(B, '1272.00', '1/2')]),
      component(`TRANSACTION_SPLIT:${repair.item.sourceId}`, 'CAPITALIZED_ITEM', '100.00', [part(A, '50.00', '1/2'), part(B, '50.00', '1/2')]),
    ];
    const depreciation: TaxYearRead['depreciation'] = {
      year: 2027,
      withoutAsset: null,
      assets: [
        {
          assetId: asset,
          assetType: 'BUILDING',
          description: null,
          reviewState: 'CONFIRMED',
          reasons: [],
          components,
          componentIndex: components.map((c) => ({ componentId: c.componentId, source: c.source, computable: true, reasons: [] })),
          yearFlags: [],
          recording: {
            state: 'NOT_RECORDED',
            versionId: null,
            versionNumber: null,
            throughYear: null,
            reproducible: null,
            flags: [flag('DEPRECIATION_SCHEDULE_NOT_RECORDED', 'OPEN')],
          },
        },
      ],
    };
    const base = await start((pr, owner) =>
      pr !== PR ? undefined : { ...reads, depreciation, ownerPartyFound: owner === null ? null : [A, B].includes(owner) },
    );
    type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const v = (await (await get(base, `/property-references/${PR}/tax-years/2027`)).json()) as Json;
    const lines = v['werbungskosten'].lines as Json[];
    expect(
      lines.every((l) => (l['line'] === 'AFA_BUILDING' || l['line'] === 'AFA_SEPARATE_ASSETS' ? l['taxCategory'] === null : l['line'] === l['taxCategory'])),
    ).toBe(true);
    expect(lines.slice(-3).map((l) => [l['line'], l['taxCategory'], l['total'].amount, l['itemCount']])).toEqual([
      ['OTHER_EXPENSE', 'OTHER_EXPENSE', '0.00', 0],
      ['AFA_BUILDING', null, '2644.00', 2],
      ['AFA_SEPARATE_ASSETS', null, '0.00', 0],
    ]);
    expect(lines.at(-2)?.['items'][0]).toEqual({
      assetId: asset,
      assetType: 'BUILDING',
      description: null,
      componentId: `ACQUISITION:${acquisition}`,
      kind: 'ACQUISITION',
      acquisitionId: acquisition,
      source: null,
      basis: { amount: '254400.00', currency: 'EUR' },
      rate,
      start: { date: '2026-07-01', dateSource: 'ECONOMIC_TRANSFER_DATE', method: 'TRANSFER_DATE', month: '2026-07', firstYearMonths: 6 },
      months: 12,
      amount: { amount: '2544.00', currency: 'EUR' },
      rule,
      share: null,
      href: `/api/v1/depreciation-assets/${asset}/schedule?from=2027&to=2027`,
      flags: [],
    });
    expect(v['depreciation']).toEqual({
      status: 'AVAILABLE',
      amount: { amount: '2644.00', currency: 'EUR' },
      assets: [
        {
          assetId: asset,
          assetType: 'BUILDING',
          description: null,
          reviewState: 'CONFIRMED',
          status: 'AVAILABLE',
          amount: { amount: '2644.00', currency: 'EUR' },
          itemCount: 2,
          reasons: [],
          recording: { state: 'NOT_RECORDED', versionId: null, versionNumber: null, throughYear: null, reproducible: null },
          href: `/api/v1/depreciation-assets/${asset}/schedule?from=2027&to=2027`,
        },
      ],
      gaps: [],
      note: 'Ergebnis nach AfA.',
    });
    expect(v['result']).toEqual({ amount: { amount: '-1143.98', currency: 'EUR' }, kind: 'LOSS', basis: 'AFTER_DEPRECIATION' });
    expect(v['capitalized'].items[0].component).toEqual({
      assetId: asset,
      assetType: 'BUILDING',
      componentId: `TRANSACTION_SPLIT:${repair.item.sourceId}`,
      computable: true,
      reasons: [],
    });
    expect((v['owners'] as Json[]).map((o) => [o['ownerPartyId'], (o['werbungskosten'].lines as Json[]).slice(-2), o['result'].basis])).toEqual([
      [
        A,
        [
          { line: 'AFA_BUILDING', taxCategory: null, total: { amount: '1322.00', currency: 'EUR' }, itemCount: 2, subtotals: null },
          { line: 'AFA_SEPARATE_ASSETS', taxCategory: null, total: { amount: '0.00', currency: 'EUR' }, itemCount: 0, subtotals: null },
        ],
        'AFTER_DEPRECIATION',
      ],
      [
        B,
        [
          { line: 'AFA_BUILDING', taxCategory: null, total: { amount: '1322.00', currency: 'EUR' }, itemCount: 2, subtotals: null },
          { line: 'AFA_SEPARATE_ASSETS', taxCategory: null, total: { amount: '0.00', currency: 'EUR' }, itemCount: 0, subtotals: null },
        ],
        'AFTER_DEPRECIATION',
      ],
      [SELLER, expect.any(Array), 'AFTER_DEPRECIATION'],
    ]);
    expect((v['flags'] as Json[]).map((f) => f['code'])).toEqual(['DEPRECIATION_SCHEDULE_NOT_RECORDED', 'UNATTRIBUTED_ITEMS']);
    expect(v['review'].open).toEqual(expect.arrayContaining([{ code: 'SUBSEQUENT_COST_START_TO_VERIFY', count: 1 }]));
    const a = (await (await get(base, `/property-references/${PR}/tax-years/2027?ownerPartyId=${A}`)).json()) as Json;
    const own = (a['werbungskosten'].lines as Json[]).at(-2)?.['items'][1];
    expect([own.amount, own.share, own.href]).toEqual([
      { amount: '50.00', currency: 'EUR' },
      { ownershipId: `own-${A}`, share: '1/2', amount: { amount: '50.00', currency: 'EUR' }, ownershipIds: [`own-${A}`], partKey: `OWNER:${A}` },
      `/api/v1/depreciation-assets/${asset}/schedule?from=2027&to=2027&ownerPartyId=${A}`,
    ]);
    expect(a['result'].basis).toBe('AFTER_DEPRECIATION');
  });
});
