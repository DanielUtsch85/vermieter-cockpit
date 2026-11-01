import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PropertyReferenceNotFoundError,
  SecurityDepositNotFoundError,
  TaxClassificationNotFoundError,
  TaxRuleNotFoundError,
  TaxSourceNotFoundError,
  getTaxRule,
  listTaxRules,
  type DepositTaxMeaning,
} from '../application/index.js';
import { Money } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';
import { CLASSIFICATION, OTHER, PR, SPLIT, TX, admin, classification, get, meaning } from './tax-classifications.test-support.js';

/** VC-7-01 HTTP contract of the reads (api-design.md §55) and the tax rules (§58): the DTOs, their 400s and 404s. Figures are invented. */
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

const fields = async (res: Response) => {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: { details: { fields: { field: string; code: string }[] } } }).error.details.fields;
};

describe('reads (§55)', () => {
  it('GET one with ETag; the history of a source; their 400s and 404s', async () => {
    const base = await start({
      taxation: {
        get: async ({ classificationId }) => {
          if (classificationId !== CLASSIFICATION) throw new TaxClassificationNotFoundError(classificationId);
          return classification;
        },
        history: async ({ sourceId }) => {
          if (sourceId !== SPLIT) throw new TaxSourceNotFoundError('TRANSACTION_SPLIT', sourceId);
          return [classification];
        },
      },
    });
    const one = await get(base, `/tax-classifications/${CLASSIFICATION}`);
    expect(one.status).toBe(200);
    expect(one.headers.get('etag')).toBe('"3"');
    expect((await get(base, `/tax-classifications/${OTHER}`)).status).toBe(404);
    const history = await get(base, `/tax-classifications?sourceType=TRANSACTION_SPLIT&sourceId=${SPLIT}`);
    expect(((await history.json()) as { items: { classificationId: string }[] }).items.map((c) => c.classificationId)).toEqual([CLASSIFICATION]);
    expect((await get(base, `/tax-classifications?sourceType=TRANSACTION_SPLIT&sourceId=${OTHER}`)).status).toBe(404);
    expect(await fields(await get(base, `/tax-classifications?sourceId=${SPLIT}`))).toEqual([{ field: 'sourceType', code: 'REQUIRED' }]);
    // VC-7-03 (§58B): a WEG source's history by its position.
    expect(await fields(await get(base, `/tax-classifications?sourceType=WEG_RESERVE_WITHDRAWAL&sourceId=${SPLIT}`))).toEqual([
      { field: 'sourcePosition', code: 'REQUIRED' },
    ]);
    expect(await fields(await get(base, `/tax-classifications?sourceType=TRANSACTION_SPLIT&sourceId=${SPLIT}&sourcePosition=1`))).toEqual([
      { field: 'sourcePosition', code: 'NOT_ALLOWED' },
    ]);
    expect(await fields(await get(base, `/tax-classifications?sourceType=WEG_ASSESSMENT_USE&sourceId=${SPLIT}&sourcePosition=1001`))).toEqual([
      { field: 'sourcePosition', code: 'INVALID_FORMAT' },
    ]);
    expect((await get(base, `/tax-classifications?sourceType=WEG_ASSESSMENT_USE&sourceId=${SPLIT}&sourcePosition=2`)).status).toBe(200);
    expect(await fields(await get(base, `/tax-classifications?sourceType=TRANSACTION_SPLIT&sourceId=x`))).toEqual([
      { field: 'sourceId', code: 'INVALID_FORMAT' },
    ]);
  });

  it('GET tax-meaning: the DTO without ETag; 404', async () => {
    const base = await start({
      taxation: {
        taxMeaning: async ({ splitId }) => {
          if (splitId !== SPLIT) throw new TaxSourceNotFoundError('TRANSACTION_SPLIT', splitId);
          return meaning;
        },
      },
    });
    const res = await get(base, `/transaction-splits/${SPLIT}/tax-meaning`);
    expect(res.status).toBe(200);
    // No version ETag (a derived read); Express's own weak validator may be present.
    expect(res.headers.get('etag') ?? 'W/').toMatch(/^W\//);
    expect(await res.json()).toEqual({
      sourceType: 'TRANSACTION_SPLIT',
      sourceId: SPLIT,
      sourcePosition: null,
      splitId: SPLIT,
      transactionId: TX,
      bookingDate: '2026-03-02',
      direction: 'OUTFLOW',
      amount: { amount: '120.00', currency: 'EUR' },
      netAmount: null,
      financialCategoryCode: 'MAINTENANCE',
      propertyReferenceId: PR,
      counts: true,
      taxCategory: 'MAINTENANCE',
      treatment: 'DEDUCTIBLE',
      reviewState: 'SUGGESTED',
      origin: 'DEFAULT',
      rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
      treatmentRule: null,
      classificationId: null,
      taxYear: 2026,
      attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: 2026, proposedYear: 2026, overridden: false },
      refund: null,
      distribution: null,
      suggestion: null,
      flags: [{ code: 'CLASSIFICATION_ON_CORRECTED_SPLIT', details: { originalTransactionId: OTHER, classificationIds: [CLASSIFICATION] } }],
    });
    const missing = await get(base, `/transaction-splits/${OTHER}/tax-meaning`);
    expect(missing.status).toBe(404);
    expect(await fields(await get(base, `/transaction-splits/x/tax-meaning`))).toEqual([{ field: 'splitId', code: 'INVALID_FORMAT' }]);
  });

  it('GET security-deposits/{id}/tax-meaning (§58A): the DTO with Money as JSON; 404; 400; the deposit as a list item', async () => {
    const deposit: DepositTaxMeaning = {
      sourceType: 'DEPOSIT_CLOSING',
      sourceId: OTHER,
      securityDepositId: OTHER,
      status: 'ACTIVE',
      closingDate: null,
      retainedAmount: Money.of('0.00', 'EUR'),
      propertyReferenceId: PR,
      propertyCandidates: [PR],
      counts: false,
      taxYear: null,
      amount: Money.of('0.00', 'EUR'),
      taxCategory: 'RETAINED_DEPOSIT_RENT',
      treatment: 'INCOME',
      reviewState: 'USER_CONFIRMED',
      origin: 'CLASSIFICATION',
      rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
      classificationId: CLASSIFICATION,
      flags: [{ code: 'NOT_COUNTED', details: { depositStatus: 'ACTIVE', retainedAmount: Money.of('0.00', 'EUR'), reason: 'NOT_CLOSED' } }],
    };
    const expected = {
      sourceType: 'DEPOSIT_CLOSING',
      sourceId: OTHER,
      sourcePosition: null,
      securityDepositId: OTHER,
      status: 'ACTIVE',
      closingDate: null,
      propertyReferenceId: PR,
      counts: false,
      taxYear: null,
      amount: { amount: '0.00', currency: 'EUR' },
      taxCategory: 'RETAINED_DEPOSIT_RENT',
      treatment: 'INCOME',
      reviewState: 'USER_CONFIRMED',
      origin: 'CLASSIFICATION',
      rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
      classificationId: CLASSIFICATION,
      flags: [{ code: 'NOT_COUNTED', details: { depositStatus: 'ACTIVE', retainedAmount: { amount: '0.00', currency: 'EUR' }, reason: 'NOT_CLOSED' } }],
    };
    const base = await start({
      taxation: {
        depositTaxMeaning: async ({ depositId }) => {
          if (depositId !== OTHER) throw new SecurityDepositNotFoundError(depositId);
          return deposit;
        },
        taxMeanings: async (input) => ({
          items: [
            { ...meaning, yearAmount: meaning.amount },
            { ...deposit, yearAmount: deposit.amount },
          ],
          page: input.page.page,
          pageSize: input.page.pageSize,
          total: 2,
        }),
      },
    });
    const res = await get(base, `/security-deposits/${OTHER}/tax-meaning`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expected);
    expect((await get(base, `/security-deposits/${SPLIT}/tax-meaning`)).status).toBe(404);
    expect(await fields(await get(base, `/security-deposits/x/tax-meaning`))).toEqual([{ field: 'depositId', code: 'INVALID_FORMAT' }]);
    const listed = (await (await get(base, `/property-references/${PR}/tax-meanings?year=2026`)).json()) as { items: { sourceType: string }[] };
    expect(listed.items.map((i) => i.sourceType)).toEqual(['TRANSACTION_SPLIT', 'DEPOSIT_CLOSING']);
    // VC-7-03 (§58B): each item with its sourcePosition and the amount of the year.
    expect(listed.items[1]).toEqual({ ...expected, yearAmount: { amount: '0.00', currency: 'EUR' } });
  });

  it('GET tax-meanings?year=: filters and paging passed; year required 2000–2100; pageSize ≤ 200; 404', async () => {
    const seen: unknown[] = [];
    const base = await start({
      taxation: {
        taxMeanings: async (input) => {
          if (input.propertyReferenceId !== PR) throw new PropertyReferenceNotFoundError(input.propertyReferenceId);
          seen.push({ year: input.year, filter: input.filter, page: input.page });
          return { items: [{ ...meaning, yearAmount: meaning.amount }], page: input.page.page, pageSize: input.page.pageSize, total: 1 };
        },
      },
    });
    const path = (query: string) => `/property-references/${PR}/tax-meanings?${query}`;
    const res = await get(base, path('year=2026&reviewState=SUGGESTED,NEEDS_REVIEW&origin=DEFAULT&taxCategory=MAINTENANCE&page=2&pageSize=10'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ page: 2, pageSize: 10, total: 1, items: [{ splitId: SPLIT, amount: { amount: '120.00' } }] });
    await get(base, path('year=2026'));
    expect(seen).toEqual([
      {
        year: 2026,
        filter: { reviewStates: ['SUGGESTED', 'NEEDS_REVIEW'], origins: ['DEFAULT'], taxCategories: ['MAINTENANCE'] },
        page: { page: 2, pageSize: 10 },
      },
      { year: 2026, filter: {}, page: { page: 1, pageSize: 50 } },
    ]);
    expect(await fields(await get(base, path('')))).toEqual([{ field: 'year', code: 'INVALID_FORMAT' }]);
    for (const year of ['1999', '2101', 'x', '2026.5'])
      expect(await fields(await get(base, path(`year=${year}`)))).toEqual([{ field: 'year', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, path('year=2026&pageSize=201')))).toEqual([{ field: 'pageSize', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, path('year=2026&reviewState=MAYBE')))).toEqual([{ field: 'reviewState.0', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, path('year=2026&origin=X')))).toEqual([{ field: 'origin.0', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, path('year=2026&taxCategory=X')))).toEqual([{ field: 'taxCategory.0', code: 'INVALID_FORMAT' }]);
    expect(await fields(await get(base, path('year=2026&other=1')))).toEqual([{ field: '(body)', code: 'INVALID_FORMAT' }]);
    expect((await get(base, `/property-references/${OTHER}/tax-meanings?year=2026`)).status).toBe(404);
  });
});

describe('GET /tax-rules (§58)', () => {
  it('every rule with its versions and status; one rule; 404 for an unknown one', async () => {
    const now = () => new Date('2026-10-30T10:00:00Z');
    const base = await start({ taxation: { listRules: listTaxRules({ now }), getRule: getTaxRule({ now }) } });
    const list = (await (await get(base, '/tax-rules')).json()) as { items: { ruleCode: string; versions: Record<string, unknown>[] }[] };
    // VC-7-02 adds DE_CASH_TIMING (§58A), VC-7-03 three rules of its own (§58B), VC-8-01 Depreciation's DE_AFA_BUILDING_LINEAR (§59),
    // VC-8-03 DE_AFA_MOVABLE_LINEAR (§59B), VC-X-36 DE_CONSTRUCTION_PERIOD_INTEREST (§59E).
    expect(list.items.map((r) => r.ruleCode)).toEqual([
      'DE_82B_DISTRIBUTION',
      'DE_AFA_BUILDING_LINEAR',
      'DE_AFA_MOVABLE_LINEAR',
      'DE_ANSCHAFFUNGSNAHE',
      'DE_CASH_TIMING',
      'DE_CATEGORY_DEFAULTS',
      'DE_CONSTRUCTION_PERIOD_INTEREST',
      'DE_WEG_SPENDING',
    ]);
    const defaults = list.items[5];
    expect(list.items[2]?.versions).toEqual([expect.objectContaining({ ruleCode: 'DE_AFA_MOVABLE_LINEAR', version: 1, status: 'ACTIVE' })]);
    expect(list.items[4]?.versions).toEqual([
      expect.objectContaining({ ruleCode: 'DE_CASH_TIMING', version: 1, legalBasis: '§ 11 Abs. 1 S. 2 und Abs. 2 S. 2 EStG', status: 'ACTIVE' }),
    ]);
    expect(list.items[0]?.versions).toEqual([
      expect.objectContaining({ ruleCode: 'DE_82B_DISTRIBUTION', version: 1, effectiveFrom: '2004-01-01', legalBasis: '§ 82b EStDV; § 84 Abs. 4a EStDV' }),
    ]);
    expect(list.items[3]?.versions[0]).toMatchObject({ effectiveFrom: '2004-01-01', parameters: { thresholdPercent: 15, windowYears: 3 } });
    expect(list.items[7]?.versions[0]).toMatchObject({ effectiveFrom: '2000-01-01', legalBasis: '§ 9 Abs. 1, § 11 Abs. 2 EStG; BFH IX R 19/24' });
    // VC-X-36 (§59E): Bauzeitzinsen.
    expect(list.items[6]?.versions[0]).toMatchObject({ effectiveFrom: '2000-01-01', parameters: { capitalizedRequiresRecord: true } });
    expect(defaults?.versions).toEqual([
      expect.objectContaining({
        ruleCode: 'DE_CATEGORY_DEFAULTS',
        version: 1,
        legalBasis: '§ 8, § 9, § 11, § 21 EStG',
        effectiveFrom: '2000-01-01',
        effectiveTo: null,
        status: 'ACTIVE',
      }),
    ]);
    const parameters = defaults?.versions[0]?.['parameters'] as { defaults: Record<string, unknown> };
    expect(parameters.defaults['MAINTENANCE']).toEqual({ taxCategory: 'MAINTENANCE', treatment: 'DEDUCTIBLE', reviewState: 'SUGGESTED' });
    const one = await get(base, '/tax-rules/DE_CATEGORY_DEFAULTS');
    expect(await one.json()).toEqual(defaults);
    const missing = await get(base, '/tax-rules/DE_UNKNOWN');
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: unknown }).error).toMatchObject({ code: 'NOT_FOUND', details: { ruleCode: 'DE_UNKNOWN' } });
    // The error class is mapped too when thrown by another implementation.
    expect(new TaxRuleNotFoundError('X').ruleCode).toBe('X');
  });
});
