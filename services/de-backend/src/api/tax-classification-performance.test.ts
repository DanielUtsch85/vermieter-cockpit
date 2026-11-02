import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnschaffungsnaheNotApplicableError,
  PerformanceEvidenceRequiredError,
  PerformanceNotAllowedError,
  PerformanceOutOfRangeError,
  PerformanceProgressExceedsAmountError,
  type CreateTaxClassificationInput,
} from '../application/index.js';
import { Money, type BusinessDate } from '../shared/index.js';
import { createApp } from './app.js';
import { commandsWith, type CommandOverrides } from './app.test-support.js';
import { admin, body, classification, post } from './tax-classifications.test-support.js';

/**
 * §59F "API" (VC-X-38): `performance` on `POST /api/v1/tax-classifications`, its field errors (`400`, all at once), the
 * new `422` answers, the reason `PERFORMANCE_REQUIRED` with its `cause`, and the DTO. No new route. Synthetic data only.
 */
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
const m = (amount: string) => ({ amount, currency: 'EUR' });

describe('performance on create (§59F "API")', () => {
  it('every field error at once; the lines that take it; accepted and passed on, absent when not given', async () => {
    const seen: CreateTaxClassificationInput[] = [];
    const base = await start({
      taxation: {
        create: async (input) => {
          seen.push(input);
          return {
            classification: {
              ...classification,
              performance: { from: '2027-05-01' as BusinessDate, until: '2027-05-31' as BusinessDate, progress: [], progressEstimated: null },
            },
            replayed: false,
          };
        },
      },
    });
    const send = (payload: unknown) => post(base, '/tax-classifications', payload);
    expect(await fields(await send({ ...body, performance: {} }))).toEqual([
      { field: 'performance.from', code: 'REQUIRED' },
      { field: 'performance.until', code: 'REQUIRED' },
    ]);
    expect(await fields(await send({ ...body, performance: { from: '2027-05-02', until: '2027-05-01' } }))).toEqual([
      { field: 'performance.until', code: 'OUT_OF_RANGE' },
    ]);
    const p = { from: '2027-05-01', until: '2027-05-31' };
    expect(
      await fields(
        await send({
          ...body,
          performance: {
            ...p,
            progress: [
              { through: '2027-04-30', amount: m('100.00') },
              { through: '2027-05-10', amount: m('0.00') },
              { through: '2027-05-10', amount: m('300.00') },
              { through: '2027-05-31', amount: m('200.00') },
            ],
          },
        }),
      ),
    ).toEqual([
      { field: 'performance.progress.1.amount.amount', code: 'NOT_POSITIVE' },
      { field: 'performance.progress.0.through', code: 'OUT_OF_RANGE' },
      { field: 'performance.progress.2.through', code: 'DUPLICATE' },
      { field: 'performance.progress.3.amount', code: 'OUT_OF_RANGE' },
      { field: 'performance.progress.3.through', code: 'OUT_OF_RANGE' },
      { field: 'performance.progressEstimated', code: 'REQUIRED' },
    ]);
    const six = Array.from({ length: 6 }, (_, i) => ({ through: `2027-05-0${i + 2}`, amount: m(`${i + 1}00.00`) }));
    expect(await fields(await send({ ...body, performance: { ...p, progress: six, progressEstimated: false } }))).toEqual([
      { field: 'performance.progress', code: 'OUT_OF_RANGE' },
    ]);
    expect(await fields(await send({ ...body, performance: { ...p, progressEstimated: true } }))).toEqual([
      { field: 'performance.progressEstimated', code: 'NOT_ALLOWED' },
    ]);
    expect(await fields(await send({ ...body, performance: { ...p, extra: 1 } }))).toEqual([{ field: 'performance', code: 'INVALID_FORMAT' }]);
    // The lines: not with NOT_RELEVANT, nor another line without CAPITALIZED, nor interest; CAPITALIZED of any other line yes.
    expect(await fields(await send({ ...body, taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', performance: p }))).toEqual([
      { field: 'performance', code: 'NOT_ALLOWED_WITH_TREATMENT' },
    ]);
    expect(await fields(await send({ ...body, taxCategory: 'INSURANCE', treatment: 'DEDUCTIBLE', performance: p }))).toEqual([
      { field: 'performance', code: 'NOT_ALLOWED_WITH_TREATMENT' },
    ]);
    expect(await fields(await send({ ...body, taxCategory: 'LOAN_INTEREST', treatment: 'CAPITALIZED', performance: p }))).toEqual([
      { field: 'performance', code: 'NOT_ALLOWED' },
    ]);
    expect(
      await fields(await send({ ...body, sourceType: 'DEPOSIT_CLOSING', taxCategory: 'RETAINED_DEPOSIT_DAMAGES', treatment: 'INCOME', performance: p })),
    ).toContainEqual({ field: 'performance', code: 'NOT_ALLOWED_WITH_TREATMENT' });
    const accepted = await send({
      ...body,
      taxCategory: 'OTHER_EXPENSE',
      treatment: 'CAPITALIZED',
      performance: { ...p, progress: [{ through: '2027-05-10', amount: m('300.00') }], progressEstimated: true },
    });
    expect(accepted.status).toBe(201);
    expect(seen.at(-1)?.performance).toEqual({
      from: '2027-05-01',
      until: '2027-05-31',
      progress: [{ through: '2027-05-10', amount: Money.of('300.00', 'EUR') }],
      progressEstimated: true,
    });
    expect(((await accepted.json()) as { performance: unknown }).performance).toEqual({
      from: '2027-05-01',
      until: '2027-05-31',
      progress: [],
      progressEstimated: null,
    });
    // Counter-check: a body without it passes nothing.
    await send(body);
    expect(Object.keys(seen.at(-1) ?? {})).not.toContain('performance');
  });

  it('the error answers: 400 NOT_ALLOWED on interest, the three 422s and PERFORMANCE_REQUIRED with its cause', async () => {
    const eur = (amount: string) => Money.of(amount, 'EUR');
    const day = (value: string) => value as BusinessDate;
    const ACQ = '7c6f1f9e-2f2c-4a8e-9d55-1f0d8c1e2a3d';
    const cases: [Error, number, Record<string, unknown>][] = [
      [new PerformanceNotAllowedError(), 400, { code: 'VALIDATION_ERROR', details: { fields: [{ field: 'performance', code: 'NOT_ALLOWED' }] } }],
      [
        new PerformanceProgressExceedsAmountError(eur('8400.00'), eur('8400.00')),
        422,
        {
          code: 'PERFORMANCE_PROGRESS_EXCEEDS_AMOUNT',
          details: { amountUsed: { amount: '8400.00', currency: 'EUR' }, amount: { amount: '8400.00', currency: 'EUR' } },
        },
      ],
      [new PerformanceEvidenceRequiredError(), 422, { code: 'PERFORMANCE_EVIDENCE_REQUIRED' }],
      [
        new PerformanceOutOfRangeError({
          sourceDate: day('2027-05-14'),
          from: day('2024-05-13'),
          until: day('2024-06-01'),
          allowedFrom: day('2024-05-14'),
          allowedUntil: day('2030-05-14'),
        }),
        422,
        {
          code: 'PERFORMANCE_OUT_OF_RANGE',
          details: { sourceDate: '2027-05-14', from: '2024-05-13', until: '2024-06-01', allowedFrom: '2024-05-14', allowedUntil: '2030-05-14' },
        },
      ],
      [
        new AnschaffungsnaheNotApplicableError('PERFORMANCE_REQUIRED', ACQ, 'STRADDLES_WINDOW'),
        422,
        { code: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE', details: { reason: 'PERFORMANCE_REQUIRED', acquisitionId: ACQ, cause: 'STRADDLES_WINDOW' } },
      ],
    ];
    for (const [error, status, expected] of cases) {
      const base = await start({ taxation: { create: async () => Promise.reject(error) } });
      const res = await post(base, '/tax-classifications', body);
      expect(res.status, error.name).toBe(status);
      expect(((await res.json()) as { error: unknown }).error, error.name).toMatchObject(expected);
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    }
  });
});
