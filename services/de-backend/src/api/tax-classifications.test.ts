import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdvisorConfirmedError,
  ClassificationExistsError,
  ClassificationSupersededError,
  DepositNotCountedError,
  NoApplicableTaxRuleError,
  NotCurrentClassificationError,
  PartyNotFoundError,
  PropertyReferenceNotFoundError,
  RefundYearOutOfRangeError,
  SecurityDepositNotFoundError,
  SourceNotCountedError,
  TaxClassificationNotFoundError,
  TaxRuleNotFoundError,
  TaxRuleNotRegisteredError,
  TaxSourceNotFoundError,
  TaxYearOutOfRangeError,
  TreatmentNotAllowedError,
  VersionConflictError,
  getTaxRule,
  listTaxRules,
  type CreateTaxClassificationInput,
  type DepositTaxMeaning,
  type PrincipalVerifier,
  type ReviewStep,
  type TaxClassification,
  type TaxMeaning,
} from '../application/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';

/** VC-7-01 HTTP contract (api-design.md §55–§58): every 400, the error mapping, the DTOs. Figures are invented. */
const REALM = '64b0c0ffee000000000000a7';
const SPLIT = '1c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const TX = '2c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const PR = '3c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const CLASSIFICATION = '4c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const OTHER = '5c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
const PARTY = '6c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';

const classification: TaxClassification = {
  id: CLASSIFICATION as TaxClassification['id'],
  mreRealmId: REALM,
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: SPLIT,
  taxCategory: 'MAINTENANCE',
  treatment: 'CAPITALIZED',
  reviewState: 'USER_CONFIRMED',
  rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
  advisorPartyId: null,
  notes: 'Austausch Thermostatventile',
  sourceReferences: ['Rechnung 2026-117'],
  taxYear: null,
  refundOfYear: null,
  depositClosing: null,
  supersedes: OTHER,
  supersededBy: null,
  supersededAt: null,
  createdAt: new Date('2026-10-30T10:00:00Z'),
  createdBy: 'anna@example.com',
  version: 3,
};

const meaning: TaxMeaning = {
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: SPLIT,
  splitId: SPLIT,
  transactionId: TX,
  position: 1,
  bookingDate: '2026-03-02' as BusinessDate,
  direction: 'OUTFLOW',
  amount: Money.of('120.00', 'EUR'),
  financialCategoryCode: 'MAINTENANCE',
  categoryType: 'OPERATING_EXPENSE',
  propertyReferenceId: PR,
  transactionStatus: 'CONFIRMED',
  correctionRole: 'REPLACEMENT',
  counts: true,
  taxCategory: 'MAINTENANCE',
  treatment: 'DEDUCTIBLE',
  reviewState: 'SUGGESTED',
  origin: 'DEFAULT',
  rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
  classificationId: null,
  taxYear: 2026,
  attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: 2026, proposedYear: 2026, overridden: false },
  refund: null,
  flags: [{ code: 'CLASSIFICATION_ON_CORRECTED_SPLIT', details: { originalTransactionId: OTHER, classificationIds: [CLASSIFICATION] } }],
};

const body = {
  sourceType: 'TRANSACTION_SPLIT',
  sourceId: SPLIT,
  taxCategory: 'MAINTENANCE',
  treatment: 'CAPITALIZED',
  reviewState: 'USER_CONFIRMED',
  supersedes: null,
  notes: 'Austausch Thermostatventile',
  sourceReferences: ['Rechnung 2026-117'],
};

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
const post = (base: string, path: string, payload: unknown, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(payload) });
const get = (base: string, path: string) => fetch(`${base}/api/v1${path}`, { headers });
const fields = async (res: Response) => {
  expect(res.status).toBe(400);
  return ((await res.json()) as { error: { details: { fields: { field: string; code: string }[] } } }).error.details.fields;
};

describe('POST /tax-classifications (§56)', () => {
  it('201 with the DTO, ETag and Location; the defaults; Idempotency-Key passed and a replay marked', async () => {
    const seen: CreateTaxClassificationInput[] = [];
    const base = await start({
      taxation: {
        create: async (input) => {
          seen.push(input);
          return { classification, replayed: input.idempotencyKey === 'again' };
        },
      },
    });
    const res = await post(base, '/tax-classifications', body, { 'idempotency-key': 'k1' });
    expect(res.status).toBe(201);
    expect(res.headers.get('etag')).toBe('"3"');
    expect(res.headers.get('location')).toBe(`/api/v1/tax-classifications/${CLASSIFICATION}`);
    expect(await res.json()).toEqual({
      classificationId: CLASSIFICATION,
      sourceType: 'TRANSACTION_SPLIT',
      sourceId: SPLIT,
      taxCategory: 'MAINTENANCE',
      treatment: 'CAPITALIZED',
      reviewState: 'USER_CONFIRMED',
      rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
      advisorPartyId: null,
      notes: 'Austausch Thermostatventile',
      sourceReferences: ['Rechnung 2026-117'],
      taxYear: null,
      refundOfYear: null,
      depositClosing: null,
      supersedes: OTHER,
      supersededBy: null,
      supersededAt: null,
      createdAt: '2026-10-30T10:00:00.000Z',
      createdBy: 'anna@example.com',
      version: 3,
    });
    expect(seen[0]).toMatchObject({ ...body, idempotencyKey: 'k1', principal: { mreRealmId: REALM } });
    const minimal = await post(base, '/tax-classifications', {
      sourceType: 'TRANSACTION_SPLIT',
      sourceId: SPLIT.toUpperCase(),
      taxCategory: 'OTHER_EXPENSE',
      treatment: 'DEDUCTIBLE',
    });
    expect(minimal.status).toBe(201);
    expect(seen[1]).toMatchObject({ sourceId: SPLIT, reviewState: 'USER_CONFIRMED', supersedes: null, notes: null, sourceReferences: [] });
    const replayed = await post(base, '/tax-classifications', body, { 'idempotency-key': 'again' });
    expect(replayed.headers.get('idempotent-replayed')).toBe('true');
    // VC-7-02 (§58A): the years of a split, and a deposit as the source.
    await post(base, '/tax-classifications', { ...body, taxYear: 2025, refundOfYear: 2024 });
    expect(seen[3]).toMatchObject({ sourceType: 'TRANSACTION_SPLIT', taxYear: 2025, refundOfYear: 2024 });
    await post(base, '/tax-classifications', { ...body, sourceType: 'DEPOSIT_CLOSING', taxCategory: 'RETAINED_DEPOSIT_RENT', treatment: 'INCOME' });
    expect(seen[4]).toMatchObject({ sourceType: 'DEPOSIT_CLOSING', sourceId: SPLIT, taxCategory: 'RETAINED_DEPOSIT_RENT', taxYear: null, refundOfYear: null });
  });

  it('every 400: shape, enums, SUGGESTED and ADVISOR_CONFIRMED, NOT_SUPPORTED fields, the fit', async () => {
    const base = await start({});
    const send = (payload: unknown) => post(base, '/tax-classifications', payload);
    expect(await fields(await send({}))).toEqual(
      expect.arrayContaining([
        { field: 'sourceType', code: 'REQUIRED' },
        { field: 'sourceId', code: 'REQUIRED' },
        { field: 'taxCategory', code: 'REQUIRED' },
        { field: 'treatment', code: 'REQUIRED' },
      ]),
    );
    expect(await fields(await send({ ...body, sourceId: 'x' }))).toEqual([{ field: 'sourceId', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send({ ...body, taxCategory: 'RENTS' }))).toEqual([{ field: 'taxCategory', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send({ ...body, treatment: 'DEDUCT' }))).toEqual([{ field: 'treatment', code: 'INVALID_FORMAT' }]);
    for (const reviewState of ['SUGGESTED', 'ADVISOR_CONFIRMED']) {
      expect(await fields(await send({ ...body, reviewState }))).toEqual([{ field: 'reviewState', code: 'INVALID_FORMAT' }]);
    }
    expect(await fields(await send({ ...body, supersedes: 'x' }))).toEqual([{ field: 'supersedes', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send({ ...body, notes: 'x'.repeat(2001) }))).toEqual([{ field: 'notes', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send({ ...body, sourceReferences: [''] }))).toEqual([{ field: 'sourceReferences.0', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send({ ...body, sourceReferences: Array.from({ length: 21 }, (_, i) => `R${i}`) }))).toEqual([
      { field: 'sourceReferences', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await send({ ...body, jurisdiction: 'DE' }))).toEqual([{ field: '(body)', code: 'INVALID_FORMAT' }]);
    for (const field of ['netAmount', 'annuallyRecurring', 'distributionYears']) {
      expect(await fields(await send({ ...body, [field]: 2026 }))).toEqual([{ field, code: 'NOT_SUPPORTED' }]);
    }
    // VC-7-02 (§58A): the years 2000–2100, a split's only.
    for (const field of ['taxYear', 'refundOfYear']) {
      for (const year of [1999, 2101]) expect(await fields(await send({ ...body, [field]: year }))).toEqual([{ field, code: 'OUT_OF_RANGE' }]);
      for (const year of [2026.5, '2026']) expect(await fields(await send({ ...body, [field]: year }))).toEqual([{ field, code: 'INVALID_FORMAT' }]);
      expect(
        await fields(await send({ ...body, sourceType: 'DEPOSIT_CLOSING', taxCategory: 'RETAINED_DEPOSIT_RENT', treatment: 'INCOME', [field]: 2026 })),
      ).toEqual([{ field, code: 'NOT_SUPPORTED' }]);
    }
    for (const sourceType of ['WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE']) {
      expect(await fields(await send({ ...body, sourceType }))).toEqual([{ field: 'sourceType', code: 'NOT_SUPPORTED' }]);
    }
    expect(await fields(await send({ ...body, taxCategory: 'WEG_SPENDING' }))).toEqual([{ field: 'taxCategory', code: 'NOT_SUPPORTED' }]);
    expect(await fields(await send({ ...body, treatment: 'DISTRIBUTED_82B' }))).toEqual([{ field: 'treatment', code: 'NOT_SUPPORTED' }]);
    for (const [taxCategory, treatment] of [
      ['RENT', 'DEDUCTIBLE'],
      ['MAINTENANCE', 'INCOME'],
      ['MAINTENANCE', null],
      ['NOT_RELEVANT', 'DEDUCTIBLE'],
      ['UNCLASSIFIED', 'NOT_RELEVANT'],
    ]) {
      expect(await fields(await send({ ...body, taxCategory, treatment }))).toEqual([{ field: 'treatment', code: 'TAX_CATEGORY_TREATMENT_MISMATCH' }]);
    }
    const key = await post(base, '/tax-classifications', body, { 'idempotency-key': 'ä' });
    expect(await fields(key)).toEqual([{ field: 'Idempotency-Key', code: 'INVALID_FORMAT' }]);
  });

  it('the error mapping of a create', async () => {
    const cases: [Error, number, Record<string, unknown>][] = [
      [new TaxSourceNotFoundError('TRANSACTION_SPLIT', SPLIT), 404, { code: 'NOT_FOUND', details: { sourceType: 'TRANSACTION_SPLIT', sourceId: SPLIT } }],
      [
        new SourceNotCountedError('CLASSIFIED', null),
        409,
        { code: 'CONFLICT', details: { reason: 'SOURCE_NOT_COUNTED', transactionStatus: 'CLASSIFIED', correctionRole: null } },
      ],
      [
        new TreatmentNotAllowedError('WEG_FUNDS', ['NOT_RELEVANT']),
        422,
        { code: 'TREATMENT_NOT_ALLOWED', details: { categoryType: 'WEG_FUNDS', allowed: ['NOT_RELEVANT'] } },
      ],
      [new ClassificationExistsError(OTHER), 409, { code: 'CONFLICT', details: { reason: 'CLASSIFICATION_EXISTS', currentClassificationId: OTHER } }],
      [new NotCurrentClassificationError(null), 409, { code: 'CONFLICT', details: { reason: 'NOT_CURRENT_CLASSIFICATION', currentClassificationId: null } }],
      [
        new NoApplicableTaxRuleError('DE_CATEGORY_DEFAULTS', '1999-12-31' as BusinessDate),
        409,
        { code: 'CONFLICT', details: { reason: 'NO_APPLICABLE_RULE', ruleCode: 'DE_CATEGORY_DEFAULTS', date: '1999-12-31' } },
      ],
      // VC-7-02 (§58A).
      [new TaxYearOutOfRangeError(2024, 2026), 422, { code: 'TAX_YEAR_OUT_OF_RANGE', details: { taxYear: 2024, bookingYear: 2026 } }],
      [new RefundYearOutOfRangeError(2027, 2026), 422, { code: 'REFUND_YEAR_OUT_OF_RANGE', details: { refundOfYear: 2027, taxYear: 2026 } }],
      [
        new DepositNotCountedError('ACTIVE', Money.of('0.00', 'EUR'), 'NOT_CLOSED'),
        409,
        {
          code: 'CONFLICT',
          details: {
            reason: 'SOURCE_NOT_COUNTED',
            depositStatus: 'ACTIVE',
            retainedAmount: { amount: '0.00', currency: 'EUR' },
            notCountedReason: 'NOT_CLOSED',
          },
        },
      ],
      [
        new TreatmentNotAllowedError(null, ['INCOME', 'NOT_RELEVANT'], ['RETAINED_DEPOSIT_RENT', 'RETAINED_DEPOSIT_DAMAGES', 'NOT_RELEVANT']),
        422,
        {
          code: 'TREATMENT_NOT_ALLOWED',
          details: {
            sourceType: 'DEPOSIT_CLOSING',
            allowed: ['INCOME', 'NOT_RELEVANT'],
            allowedTaxCategories: ['RETAINED_DEPOSIT_RENT', 'RETAINED_DEPOSIT_DAMAGES', 'NOT_RELEVANT'],
          },
        },
      ],
    ];
    for (const [error, status, answer] of cases) {
      const base = await start({ taxation: { create: () => Promise.reject(error) } });
      const res = await post(base, '/tax-classifications', body);
      expect(res.status, error.name).toBe(status);
      expect(((await res.json()) as { error: unknown }).error).toMatchObject(answer);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });
});

describe('§57 steps', () => {
  it('confirm, advisor-confirm and mark-needs-review: the step, If-Match, ETag; their 400s', async () => {
    const seen: { step: ReviewStep; expectedVersions?: readonly number[] }[] = [];
    const base = await start({
      taxation: {
        review: async ({ step, expectedVersions }) => {
          seen.push({ step, ...(expectedVersions === undefined ? {} : { expectedVersions }) });
          return { classification, changed: true };
        },
      },
    });
    const path = (step: string) => `/tax-classifications/${CLASSIFICATION}/${step}`;
    const confirmed = await post(base, path('confirm'), {}, { 'if-match': '"3"' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get('etag')).toBe('"3"');
    expect((await post(base, path('advisor-confirm'), { advisorPartyId: PARTY, note: 'geprüft' })).status).toBe(200);
    expect((await post(base, path('advisor-confirm'), {})).status).toBe(200);
    expect((await post(base, path('mark-needs-review'), { reason: 'Beleg fehlt' })).status).toBe(200);
    expect(seen).toEqual([
      { step: { kind: 'CONFIRM' }, expectedVersions: [3] },
      { step: { kind: 'ADVISOR_CONFIRM', advisorPartyId: PARTY, note: 'geprüft' } },
      { step: { kind: 'ADVISOR_CONFIRM', advisorPartyId: null, note: null } },
      { step: { kind: 'MARK_NEEDS_REVIEW', reason: 'Beleg fehlt' } },
    ]);
    expect(await fields(await post(base, path('confirm'), { reviewState: 'USER_CONFIRMED' }))).toEqual([{ field: '(body)', code: 'INVALID_FORMAT' }]);
    expect(await fields(await post(base, path('advisor-confirm'), { advisorPartyId: 'x' }))).toEqual([{ field: 'advisorPartyId', code: 'INVALID_FORMAT' }]);
    expect(await fields(await post(base, path('mark-needs-review'), {}))).toEqual([{ field: 'reason', code: 'REQUIRED' }]);
    expect(await fields(await post(base, path('mark-needs-review'), { reason: 'x'.repeat(501) }))).toEqual([{ field: 'reason', code: 'INVALID_FORMAT' }]);
    expect(await fields(await post(base, path('confirm'), {}, { 'if-match': 'nope' }))).toEqual([{ field: 'If-Match', code: 'INVALID_FORMAT' }]);
    expect(await fields(await post(base, '/tax-classifications/x/confirm', {}))).toEqual([{ field: 'classificationId', code: 'INVALID_FORMAT' }]);
  });

  it('the error mapping of a step', async () => {
    const cases: [Error, number, Record<string, unknown>][] = [
      [new TaxClassificationNotFoundError(CLASSIFICATION), 404, { code: 'NOT_FOUND', details: { classificationId: CLASSIFICATION } }],
      [new ClassificationSupersededError(OTHER), 409, { code: 'CONFLICT', details: { reason: 'CLASSIFICATION_SUPERSEDED', supersededBy: OTHER } }],
      [new AdvisorConfirmedError('x'), 409, { code: 'CONFLICT', details: { reason: 'ADVISOR_CONFIRMED' } }],
      [new SourceNotCountedError('CORRECTED', null), 409, { code: 'CONFLICT', details: { reason: 'SOURCE_NOT_COUNTED', transactionStatus: 'CORRECTED' } }],
      [new TaxRuleNotRegisteredError('DE_CATEGORY_DEFAULTS', 9), 409, { code: 'CONFLICT', details: { reason: 'RULE_NOT_REGISTERED', version: 9 } }],
      [new PartyNotFoundError(PARTY), 404, { code: 'NOT_FOUND', details: { partyId: PARTY } }],
      [new VersionConflictError([2], 3), 412, { code: 'VERSION_CONFLICT', details: { expectedVersions: [2], currentVersion: 3 } }],
    ];
    for (const [error, status, answer] of cases) {
      const base = await start({ taxation: { review: () => Promise.reject(error) } });
      const res = await post(base, `/tax-classifications/${CLASSIFICATION}/confirm`, {});
      expect(res.status, error.name).toBe(status);
      expect(((await res.json()) as { error: unknown }).error).toMatchObject(answer);
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });
});

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
    expect(await fields(await get(base, `/tax-classifications?sourceType=WEG_RESERVE_WITHDRAWAL&sourceId=${SPLIT}`))).toEqual([
      { field: 'sourceType', code: 'NOT_SUPPORTED' },
    ]);
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
      splitId: SPLIT,
      transactionId: TX,
      bookingDate: '2026-03-02',
      direction: 'OUTFLOW',
      amount: { amount: '120.00', currency: 'EUR' },
      financialCategoryCode: 'MAINTENANCE',
      propertyReferenceId: PR,
      counts: true,
      taxCategory: 'MAINTENANCE',
      treatment: 'DEDUCTIBLE',
      reviewState: 'SUGGESTED',
      origin: 'DEFAULT',
      rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
      classificationId: null,
      taxYear: 2026,
      attribution: { rule: { ruleCode: 'DE_CASH_TIMING', version: 1 }, bookingYear: 2026, proposedYear: 2026, overridden: false },
      refund: null,
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
        taxMeanings: async (input) => ({ items: [meaning, deposit], page: input.page.page, pageSize: input.page.pageSize, total: 2 }),
      },
    });
    const res = await get(base, `/security-deposits/${OTHER}/tax-meaning`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expected);
    expect((await get(base, `/security-deposits/${SPLIT}/tax-meaning`)).status).toBe(404);
    expect(await fields(await get(base, `/security-deposits/x/tax-meaning`))).toEqual([{ field: 'depositId', code: 'INVALID_FORMAT' }]);
    const listed = (await (await get(base, `/property-references/${PR}/tax-meanings?year=2026`)).json()) as { items: { sourceType: string }[] };
    expect(listed.items.map((i) => i.sourceType)).toEqual(['TRANSACTION_SPLIT', 'DEPOSIT_CLOSING']);
    expect(listed.items[1]).toEqual(expected);
  });

  it('GET tax-meanings?year=: filters and paging passed; year required 2000–2100; pageSize ≤ 200; 404', async () => {
    const seen: unknown[] = [];
    const base = await start({
      taxation: {
        taxMeanings: async (input) => {
          if (input.propertyReferenceId !== PR) throw new PropertyReferenceNotFoundError(input.propertyReferenceId);
          seen.push({ year: input.year, filter: input.filter, page: input.page });
          return { items: [meaning], page: input.page.page, pageSize: input.page.pageSize, total: 1 };
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
    // VC-7-02 adds DE_CASH_TIMING (§58A).
    expect(list.items.map((r) => r.ruleCode)).toEqual(['DE_CASH_TIMING', 'DE_CATEGORY_DEFAULTS']);
    const defaults = list.items[1];
    expect(list.items[0]?.versions).toEqual([
      expect.objectContaining({ ruleCode: 'DE_CASH_TIMING', version: 1, legalBasis: '§ 11 Abs. 1 S. 2 und Abs. 2 S. 2 EStG', status: 'ACTIVE' }),
    ]);
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
