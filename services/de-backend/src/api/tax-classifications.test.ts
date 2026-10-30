import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AcquisitionCancelledError,
  AcquisitionNotFoundError,
  AnschaffungsnaheNotApplicableError,
  DistributionNotAllowedError,
  NetAmountExceedsGrossError,
  TaxFieldNotSupportedError,
  WegSourceNotCountedError,
  WegSourcePositionNotFoundError,
  WithdrawalTaxYearOutOfRangeError,
  type AnschaffungsnaheCheck,
  type WegTaxMeaning,
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
  treatmentRule: null,
  sourcePosition: null,
  reserveWithdrawal: null,
  assessmentUse: null,
  netAmount: null,
  annuallyRecurring: false,
  distributionYears: null,
  mostlyResidentialConfirmed: null,
  anschaffungsnaheAcquisitionId: null,
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
  netAmount: null,
  treatmentRule: null,
  distribution: null,
  suggestion: null,
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
      sourcePosition: null,
      rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
      treatmentRule: null,
      advisorPartyId: null,
      notes: 'Austausch Thermostatventile',
      sourceReferences: ['Rechnung 2026-117'],
      taxYear: null,
      refundOfYear: null,
      depositClosing: null,
      reserveWithdrawal: null,
      assessmentUse: null,
      netAmount: null,
      annuallyRecurring: false,
      distributionYears: null,
      mostlyResidentialConfirmed: null,
      anschaffungsnaheAcquisitionId: null,
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
    // VC-7-03 (§58B): the fields of VC-7-01's NOT_SUPPORTED are checked; see the §58B describe below.
    expect(await fields(await send({ ...body, netAmount: 2026 }))).toEqual([{ field: 'netAmount', code: 'INVALID_FORMAT' }]);
    // VC-7-02 (§58A): the years 2000–2100, a split's only.
    for (const field of ['taxYear', 'refundOfYear']) {
      for (const year of [1999, 2101]) expect(await fields(await send({ ...body, [field]: year }))).toEqual([{ field, code: 'OUT_OF_RANGE' }]);
      for (const year of [2026.5, '2026']) expect(await fields(await send({ ...body, [field]: year }))).toEqual([{ field, code: 'INVALID_FORMAT' }]);
      expect(
        await fields(await send({ ...body, sourceType: 'DEPOSIT_CLOSING', taxCategory: 'RETAINED_DEPOSIT_RENT', treatment: 'INCOME', [field]: 2026 })),
      ).toEqual([{ field, code: 'NOT_SUPPORTED' }]);
    }
    // VC-7-03 (§58B): the WEG sources take a sourcePosition; WEG_SPENDING and DISTRIBUTED_82B are lifted.
    for (const sourceType of ['WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE']) {
      expect(await fields(await send({ ...body, sourceType }))).toEqual([{ field: 'sourcePosition', code: 'REQUIRED' }]);
    }
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
    // VC-7-02 adds DE_CASH_TIMING (§58A), VC-7-03 three rules of its own (§58B), VC-8-01 Depreciation's DE_AFA_BUILDING_LINEAR (§59).
    expect(list.items.map((r) => r.ruleCode)).toEqual([
      'DE_82B_DISTRIBUTION',
      'DE_AFA_BUILDING_LINEAR',
      'DE_ANSCHAFFUNGSNAHE',
      'DE_CASH_TIMING',
      'DE_CATEGORY_DEFAULTS',
      'DE_WEG_SPENDING',
    ]);
    const defaults = list.items[4];
    expect(list.items[3]?.versions).toEqual([
      expect.objectContaining({ ruleCode: 'DE_CASH_TIMING', version: 1, legalBasis: '§ 11 Abs. 1 S. 2 und Abs. 2 S. 2 EStG', status: 'ACTIVE' }),
    ]);
    expect(list.items[0]?.versions).toEqual([
      expect.objectContaining({ ruleCode: 'DE_82B_DISTRIBUTION', version: 1, effectiveFrom: '2004-01-01', legalBasis: '§ 82b EStDV; § 84 Abs. 4a EStDV' }),
    ]);
    expect(list.items[2]?.versions[0]).toMatchObject({ effectiveFrom: '2004-01-01', parameters: { thresholdPercent: 15, windowYears: 3 } });
    expect(list.items[5]?.versions[0]).toMatchObject({ effectiveFrom: '2000-01-01', legalBasis: '§ 9 Abs. 1, § 11 Abs. 2 EStG; BFH IX R 19/24' });
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

describe('VC-7-03 (§58B)', () => {
  const ACQ = '7c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
  const wegBody = { sourceType: 'WEG_RESERVE_WITHDRAWAL', sourceId: SPLIT, sourcePosition: 2, taxCategory: 'WEG_SPENDING', treatment: 'DEDUCTIBLE' };

  it('every new 400 with its field; the new fields passed; a body without them unchanged', async () => {
    const seen: CreateTaxClassificationInput[] = [];
    const base = await start({
      taxation: {
        create: async (input) => {
          seen.push(input);
          return { classification, replayed: false };
        },
      },
    });
    const send = (payload: unknown) => post(base, '/tax-classifications', payload);
    const m = (amount: string, currency = 'EUR') => ({ amount, currency });
    expect(await fields(await send({ ...body, netAmount: m('0.00') }))).toEqual([{ field: 'netAmount.amount', code: 'NOT_POSITIVE' }]);
    expect(await fields(await send({ ...body, netAmount: m('-1.00') }))).toEqual([{ field: 'netAmount.amount', code: 'NOT_POSITIVE' }]);
    expect(await fields(await send({ ...body, netAmount: m('1.001') }))).toEqual([{ field: 'netAmount.amount', code: 'INVALID_FORMAT' }]);
    expect(await fields(await send({ ...body, taxCategory: 'INSURANCE', treatment: 'DEDUCTIBLE', netAmount: m('1.00') }))).toEqual([
      { field: 'netAmount', code: 'NOT_ALLOWED_WITH_TAX_CATEGORY' },
    ]);
    expect(await fields(await send({ ...body, taxCategory: 'INSURANCE', treatment: 'DEDUCTIBLE', annuallyRecurring: true }))).toEqual([
      { field: 'annuallyRecurring', code: 'NOT_ALLOWED_WITH_TAX_CATEGORY' },
    ]);
    expect((await send({ ...body, taxCategory: 'INSURANCE', treatment: 'DEDUCTIBLE', annuallyRecurring: false })).status).toBe(201);
    const election = { ...body, taxCategory: 'MAINTENANCE', treatment: 'DISTRIBUTED_82B' };
    expect(await fields(await send(election))).toEqual([
      { field: 'distributionYears', code: 'REQUIRED' },
      { field: 'mostlyResidentialConfirmed', code: 'REQUIRED' },
    ]);
    expect(await fields(await send({ ...election, distributionYears: 2.5, mostlyResidentialConfirmed: true }))).toEqual([
      { field: 'distributionYears', code: 'INVALID_FORMAT' },
    ]);
    for (const years of [1, 6]) {
      expect(await fields(await send({ ...election, distributionYears: years, mostlyResidentialConfirmed: true }))).toEqual([
        { field: 'distributionYears', code: 'OUT_OF_RANGE' },
      ]);
    }
    expect(await fields(await send({ ...body, distributionYears: 3, mostlyResidentialConfirmed: true }))).toEqual([
      { field: 'distributionYears', code: 'NOT_ALLOWED_WITH_TREATMENT' },
      { field: 'mostlyResidentialConfirmed', code: 'NOT_ALLOWED_WITH_TREATMENT' },
    ]);
    expect(await fields(await send({ ...election, taxCategory: 'INSURANCE', distributionYears: 3, mostlyResidentialConfirmed: true }))).toEqual([
      { field: 'treatment', code: 'TAX_CATEGORY_TREATMENT_MISMATCH' },
    ]);
    expect(await fields(await send({ ...body, treatment: 'DEDUCTIBLE', anschaffungsnaheAcquisitionId: ACQ }))).toEqual([
      { field: 'anschaffungsnaheAcquisitionId', code: 'NOT_ALLOWED_WITH_TREATMENT' },
    ]);
    expect(await fields(await send({ ...body, anschaffungsnaheAcquisitionId: 'x' }))).toEqual([
      { field: 'anschaffungsnaheAcquisitionId', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await send({ ...body, sourcePosition: 1 }))).toEqual([{ field: 'sourcePosition', code: 'NOT_ALLOWED' }]);
    expect(await fields(await send({ ...wegBody, sourcePosition: 1001 }))).toEqual([{ field: 'sourcePosition', code: 'OUT_OF_RANGE' }]);
    expect(await fields(await send({ ...wegBody, refundOfYear: 2026 }))).toEqual([{ field: 'refundOfYear', code: 'NOT_SUPPORTED' }]);
    expect(await fields(await send({ ...wegBody, sourceType: 'WEG_ASSESSMENT_USE', taxYear: 2026 }))).toEqual([{ field: 'taxYear', code: 'NOT_SUPPORTED' }]);
    // Accepted, and passed on.
    expect(
      (
        await send({
          ...wegBody,
          treatment: 'DISTRIBUTED_82B',
          distributionYears: 3,
          mostlyResidentialConfirmed: true,
          netAmount: m('840.34'),
          annuallyRecurring: false,
          taxYear: 2026,
        })
      ).status,
    ).toBe(201);
    expect(seen.at(-1)).toMatchObject({
      sourceType: 'WEG_RESERVE_WITHDRAWAL',
      sourcePosition: 2,
      distributionYears: 3,
      mostlyResidentialConfirmed: true,
      netAmount: Money.of('840.34', 'EUR'),
      taxYear: 2026,
    });
    expect((await send({ ...body, treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: ACQ.toUpperCase() })).status).toBe(201);
    expect(seen.at(-1)).toMatchObject({ anschaffungsnaheAcquisitionId: ACQ });
    await send(body);
    expect(Object.keys(seen.at(-1) ?? {})).not.toContain('sourcePosition');
    expect(Object.keys(seen.at(-1) ?? {})).not.toContain('netAmount');
  });

  it('the error mapping: NET_AMOUNT_EXCEEDS_GROSS, DISTRIBUTION_NOT_ALLOWED, ANSCHAFFUNGSNAHE_NOT_APPLICABLE, NO_APPLICABLE_RULE, the WEG ones', async () => {
    const cases: [Error, number, Record<string, unknown>][] = [
      [
        new NetAmountExceedsGrossError(Money.of('1000.01', 'EUR'), Money.of('1000.00', 'EUR')),
        422,
        {
          code: 'NET_AMOUNT_EXCEEDS_GROSS',
          details: { netAmount: { amount: '1000.01', currency: 'EUR' }, grossAmount: { amount: '1000.00', currency: 'EUR' } },
        },
      ],
      [new DistributionNotAllowedError('NOT_AN_OUTFLOW'), 422, { code: 'DISTRIBUTION_NOT_ALLOWED', details: { reason: 'NOT_AN_OUTFLOW' } }],
      [
        new AnschaffungsnaheNotApplicableError('OUTSIDE_WINDOW', ACQ),
        422,
        { code: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE', details: { reason: 'OUTSIDE_WINDOW', acquisitionId: ACQ } },
      ],
      [
        new NoApplicableTaxRuleError('DE_82B_DISTRIBUTION', '2003-12-31' as BusinessDate),
        409,
        { code: 'CONFLICT', details: { reason: 'NO_APPLICABLE_RULE', ruleCode: 'DE_82B_DISTRIBUTION', date: '2003-12-31' } },
      ],
      [new AcquisitionNotFoundError(ACQ), 404, { code: 'NOT_FOUND', details: { acquisitionId: ACQ } }],
      [
        new WegSourceNotCountedError('WEG_RESERVE_WITHDRAWAL', 'STATEMENT_SUPERSEDED', { supersededBy: OTHER }),
        409,
        {
          code: 'CONFLICT',
          details: { reason: 'SOURCE_NOT_COUNTED', sourceType: 'WEG_RESERVE_WITHDRAWAL', notCountedReason: 'STATEMENT_SUPERSEDED', supersededBy: OTHER },
        },
      ],
      [new TaxFieldNotSupportedError('taxYear'), 400, { code: 'VALIDATION_ERROR', details: { fields: [{ field: 'taxYear', code: 'NOT_SUPPORTED' }] } }],
      [
        new WithdrawalTaxYearOutOfRangeError(2027, [2025, 2026]),
        422,
        { code: 'TAX_YEAR_OUT_OF_RANGE', details: { taxYear: 2027, allowedYears: [2025, 2026] } },
      ],
      [
        new TreatmentNotAllowedError(null, [], [], 'TRANSACTION_SPLIT', 'WEG_SPENDING_ONLY_FOR_WEG_SOURCES'),
        422,
        { code: 'TREATMENT_NOT_ALLOWED', details: { sourceType: 'TRANSACTION_SPLIT', reason: 'WEG_SPENDING_ONLY_FOR_WEG_SOURCES' } },
      ],
      [
        new TreatmentNotAllowedError(
          null,
          ['DEDUCTIBLE', 'DISTRIBUTED_82B', 'CAPITALIZED', 'NOT_RELEVANT'],
          ['WEG_SPENDING', 'NOT_RELEVANT'],
          'WEG_ASSESSMENT_USE',
        ),
        422,
        {
          code: 'TREATMENT_NOT_ALLOWED',
          details: {
            sourceType: 'WEG_ASSESSMENT_USE',
            allowed: ['DEDUCTIBLE', 'DISTRIBUTED_82B', 'CAPITALIZED', 'NOT_RELEVANT'],
            allowedTaxCategories: ['WEG_SPENDING', 'NOT_RELEVANT'],
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

  const wegMeaning: WegTaxMeaning = {
    sourceType: 'WEG_RESERVE_WITHDRAWAL',
    sourceId: SPLIT,
    sourcePosition: 2,
    membershipId: OTHER,
    propertyReferenceId: PR,
    date: '2026-12-31' as BusinessDate,
    dateSource: 'PERIOD_END',
    description: 'Dach',
    amount: Money.of('500.00', 'EUR'),
    netAmount: null,
    counts: true,
    notCountedReason: null,
    taxYear: 2026,
    attribution: { rule: null, proposedYear: 2026, overridden: false },
    taxCategory: 'WEG_SPENDING',
    treatment: 'DISTRIBUTED_82B',
    reviewState: 'USER_CONFIRMED',
    origin: 'CLASSIFICATION',
    rule: { ruleCode: 'DE_WEG_SPENDING', version: 1 },
    treatmentRule: { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 },
    classificationId: CLASSIFICATION,
    distribution: {
      years: 2,
      firstYear: 2026,
      parts: [
        { year: 2026, amount: Money.of('250.00', 'EUR') },
        { year: 2027, amount: Money.of('250.00', 'EUR') },
      ],
      endYear: null,
      rule: { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 },
    },
    suggestion: { treatment: 'CAPITALIZED', reason: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', acquisitionIds: [ACQ], final: false },
    flags: [{ code: 'WITHDRAWAL_DATE_ASSUMED', details: { date: '2026-12-31' as BusinessDate, periodUntil: '2026-12-31' as BusinessDate } }],
  };
  const wegDto = {
    sourceType: 'WEG_RESERVE_WITHDRAWAL',
    sourceId: SPLIT,
    sourcePosition: 2,
    membershipId: OTHER,
    propertyReferenceId: PR,
    date: '2026-12-31',
    dateSource: 'PERIOD_END',
    description: 'Dach',
    amount: { amount: '500.00', currency: 'EUR' },
    netAmount: null,
    counts: true,
    notCountedReason: null,
    taxYear: 2026,
    attribution: { rule: null, proposedYear: 2026, overridden: false },
    taxCategory: 'WEG_SPENDING',
    treatment: 'DISTRIBUTED_82B',
    reviewState: 'USER_CONFIRMED',
    origin: 'CLASSIFICATION',
    rule: { ruleCode: 'DE_WEG_SPENDING', version: 1 },
    treatmentRule: { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 },
    classificationId: CLASSIFICATION,
    distribution: {
      years: 2,
      firstYear: 2026,
      parts: [
        { year: 2026, amount: { amount: '250.00', currency: 'EUR' } },
        { year: 2027, amount: { amount: '250.00', currency: 'EUR' } },
      ],
      endYear: null,
      rule: { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 },
    },
    suggestion: { treatment: 'CAPITALIZED', reason: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', acquisitionIds: [ACQ], final: false },
    flags: [{ code: 'WITHDRAWAL_DATE_ASSUMED', details: { date: '2026-12-31', periodUntil: '2026-12-31' } }],
  };

  it('GET the WEG sources’ meanings: the DTO; 404; 400 for a malformed id or position; the list item with yearAmount and the sourceType filter', async () => {
    const seen: unknown[] = [];
    const read = async ({ sourceId, position }: { sourceId: string; position: number }) => {
      seen.push([sourceId, position]);
      if (sourceId !== SPLIT || position !== 2) throw new WegSourcePositionNotFoundError('WEG_RESERVE_WITHDRAWAL', sourceId, position);
      return wegMeaning;
    };
    const base = await start({
      taxation: {
        withdrawalTaxMeaning: read,
        useTaxMeaning: async (input) => ({ ...(await read(input)), sourceType: 'WEG_ASSESSMENT_USE', dateSource: 'USE' }),
        taxMeanings: async (input) => {
          seen.push(input.filter);
          return { items: [{ ...wegMeaning, yearAmount: Money.of('250.00', 'EUR') }], page: 1, pageSize: 50, total: 1 };
        },
      },
    });
    const withdrawal = await get(base, `/weg-annual-statements/${SPLIT}/reserve-withdrawals/2/tax-meaning`);
    expect(withdrawal.status).toBe(200);
    expect(withdrawal.headers.get('etag') ?? 'W/').toMatch(/^W\//);
    expect(await withdrawal.json()).toEqual(wegDto);
    expect(await (await get(base, `/weg-special-assessments/${SPLIT}/uses/2/tax-meaning`)).json()).toEqual({
      ...wegDto,
      sourceType: 'WEG_ASSESSMENT_USE',
      dateSource: 'USE',
    });
    const missing = await get(base, `/weg-annual-statements/${SPLIT}/reserve-withdrawals/3/tax-meaning`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: unknown }).error).toMatchObject({ details: { sourceType: 'WEG_RESERVE_WITHDRAWAL', sourcePosition: 3 } });
    for (const position of ['0', '1001', 'x', '01', '1.5']) {
      expect(await fields(await get(base, `/weg-annual-statements/${SPLIT}/reserve-withdrawals/${position}/tax-meaning`))).toEqual([
        { field: 'position', code: 'INVALID_FORMAT' },
      ]);
    }
    expect(await fields(await get(base, `/weg-special-assessments/x/uses/1/tax-meaning`))).toEqual([{ field: 'assessmentId', code: 'INVALID_FORMAT' }]);
    const listed = (await (
      await get(base, `/property-references/${PR}/tax-meanings?year=2027&sourceType=WEG_RESERVE_WITHDRAWAL,WEG_ASSESSMENT_USE`)
    ).json()) as {
      items: unknown[];
    };
    expect(listed.items).toEqual([{ ...wegDto, yearAmount: { amount: '250.00', currency: 'EUR' } }]);
    expect(seen.at(-1)).toEqual({ sourceTypes: ['WEG_RESERVE_WITHDRAWAL', 'WEG_ASSESSMENT_USE'] });
    expect(await fields(await get(base, `/property-references/${PR}/tax-meanings?year=2027&sourceType=DEPOSIT`))).toEqual([
      { field: 'sourceType.0', code: 'INVALID_FORMAT' },
    ]);
  });

  it('GET the anschaffungsnahe check: the DTO; 404; 409 cancelled; 400 for any query parameter', async () => {
    const eur = (a: string) => Money.of(a, 'EUR');
    const check: AnschaffungsnaheCheck = {
      acquisitionId: ACQ,
      propertyReferenceId: PR,
      acquisitionStatus: 'CONFIRMED',
      transferDate: '2026-03-15' as BusinessDate,
      window: { from: '2026-03-15' as BusinessDate, until: '2029-03-15' as BusinessDate },
      acquiredShare: { numerator: 1, denominator: 1 },
      rule: { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 },
      status: 'ABOVE_THRESHOLD',
      notComputableReason: null,
      basis: {
        allocationId: OTHER,
        allocationReviewState: 'CONFIRMED',
        purchasePrice: eur('240000.00'),
        acquisitionCosts: eur('24000.00'),
        totalAllocableAmount: eur('264000.00'),
        buildingAmount: eur('198000.00'),
        basisAmount: eur('198000.00'),
      },
      thresholdPercent: 15,
      threshold: '29700.00',
      sum: eur('29926.05'),
      attributableAmount: eur('29926.05'),
      percentOfBasis: '15.11',
      sources: [
        {
          sourceType: 'WEG_ASSESSMENT_USE',
          sourceId: OTHER,
          sourcePosition: 1,
          date: '2027-06-10' as BusinessDate,
          taxYear: 2027,
          taxCategory: 'WEG_SPENDING',
          treatment: 'DEDUCTIBLE',
          reviewState: 'USER_CONFIRMED',
          origin: 'CLASSIFICATION',
          classificationId: CLASSIFICATION,
          grossAmount: eur('14800.00'),
          netAmount: null,
          amountUsed: eur('14800.00'),
          suggestedTreatment: 'CAPITALIZED',
          reason: null,
          flags: [{ code: 'VAT_NOT_SEPARATED', details: { acquisitionId: ACQ } }],
        },
      ],
      excluded: [],
      unclassified: [],
      affectedYears: [2027],
      final: false,
      flags: [{ code: 'NOT_FINAL', details: { reasons: ['GROSS_AMOUNTS', 'WINDOW_OPEN'] } }],
    };
    const base = await start({
      taxation: {
        anschaffungsnahe: async ({ acquisitionId }) => {
          if (acquisitionId === OTHER) throw new AcquisitionCancelledError(acquisitionId);
          if (acquisitionId !== ACQ) throw new AcquisitionNotFoundError(acquisitionId);
          return check;
        },
      },
    });
    const res = await get(base, `/acquisitions/${ACQ}/anschaffungsnahe-herstellungskosten`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      acquisitionId: ACQ,
      propertyReferenceId: PR,
      acquisitionStatus: 'CONFIRMED',
      transferDate: '2026-03-15',
      window: { from: '2026-03-15', until: '2029-03-15' },
      acquiredShare: '1/1',
      rule: { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 },
      status: 'ABOVE_THRESHOLD',
      notComputableReason: null,
      basis: {
        allocationId: OTHER,
        allocationReviewState: 'CONFIRMED',
        purchasePrice: { amount: '240000.00', currency: 'EUR' },
        acquisitionCosts: { amount: '24000.00', currency: 'EUR' },
        totalAllocableAmount: { amount: '264000.00', currency: 'EUR' },
        buildingAmount: { amount: '198000.00', currency: 'EUR' },
        basisAmount: { amount: '198000.00', currency: 'EUR' },
      },
      thresholdPercent: 15,
      threshold: { amount: '29700.00', currency: 'EUR' },
      sum: { amount: '29926.05', currency: 'EUR' },
      attributableAmount: { amount: '29926.05', currency: 'EUR' },
      percentOfBasis: '15.11',
      sources: [
        {
          sourceType: 'WEG_ASSESSMENT_USE',
          sourceId: OTHER,
          sourcePosition: 1,
          date: '2027-06-10',
          taxYear: 2027,
          taxCategory: 'WEG_SPENDING',
          treatment: 'DEDUCTIBLE',
          reviewState: 'USER_CONFIRMED',
          origin: 'CLASSIFICATION',
          classificationId: CLASSIFICATION,
          grossAmount: { amount: '14800.00', currency: 'EUR' },
          netAmount: null,
          amountUsed: { amount: '14800.00', currency: 'EUR' },
          suggestedTreatment: 'CAPITALIZED',
          reason: null,
          flags: [{ code: 'VAT_NOT_SEPARATED', details: { acquisitionId: ACQ } }],
        },
      ],
      excluded: [],
      unclassified: [],
      affectedYears: [2027],
      final: false,
      flags: [{ code: 'NOT_FINAL', details: { reasons: ['GROSS_AMOUNTS', 'WINDOW_OPEN'] } }],
    });
    expect((await get(base, `/acquisitions/${PARTY}/anschaffungsnahe-herstellungskosten`)).status).toBe(404);
    const cancelled = await get(base, `/acquisitions/${OTHER}/anschaffungsnahe-herstellungskosten`);
    expect(cancelled.status).toBe(409);
    expect(((await cancelled.json()) as { error: unknown }).error).toMatchObject({ details: { reason: 'ACQUISITION_CANCELLED' } });
    expect(await fields(await get(base, `/acquisitions/${ACQ}/anschaffungsnahe-herstellungskosten?asOf=2026-01-01`))).toEqual([
      { field: '(body)', code: 'INVALID_FORMAT' },
    ]);
    expect(await fields(await get(base, `/acquisitions/x/anschaffungsnahe-herstellungskosten`))).toEqual([{ field: 'acquisitionId', code: 'INVALID_FORMAT' }]);
  });
});
