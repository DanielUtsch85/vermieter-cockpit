import { z } from 'zod';
import type { Performance } from '../application/index.js';
import { Money, MoneyError } from '../shared/index.js';
import { businessDate } from './acquisitions.js';

/** The body's Money of §58B and §59F (`netAmount`, a point's `amount`): EUR, > 0, at most two decimals (`INVALID_FORMAT`). */
export const positiveEur = z.object({ amount: z.string(), currency: z.string() }).transform((value, ctx) => {
  try {
    const parsed = Money.of(value.amount, value.currency);
    if (parsed.currency !== 'EUR') {
      ctx.addIssue({ code: 'custom', path: ['currency'], params: { code: 'CURRENCY_MISMATCH' } });
      return z.NEVER;
    }
    if (!parsed.isPositive()) {
      ctx.addIssue({ code: 'custom', path: ['amount'], params: { code: 'NOT_POSITIVE' } });
      return z.NEVER;
    }
    return parsed;
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    ctx.addIssue({
      code: 'custom',
      path: error.code === 'UNSUPPORTED_CURRENCY' ? ['currency'] : ['amount'],
      params: { code: error.code === 'UNSUPPORTED_CURRENCY' ? 'UNSUPPORTED_CURRENCY' : 'INVALID_FORMAT' },
    });
    return z.NEVER;
  }
});

const issue = (ctx: z.RefinementCtx, path: (string | number)[], code: string) => ctx.addIssue({ code: 'custom', path, params: { code } });

/**
 * `performance` (api-design.md §59F "API"): `from` and `until` required, `until` not before `from`; 0–5 points, each
 * `through` in [`from`, `until`), dates and amounts strictly ascending, no duplicate date; `progressEstimated` exactly
 * with points. Every field error at once.
 */
export const performanceBody = z
  .object({
    from: businessDate,
    until: businessDate,
    progress: z.array(z.object({ through: businessDate, amount: positiveEur }).strict()).optional(),
    progressEstimated: z.boolean().optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // A field that failed its own parse holds no value here (zod's NEVER): only parsed values are compared.
    const date = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    const money = (value: unknown): Money | null => (value instanceof Money ? value : null);
    const progress = body.progress ?? [];
    const from = date(body.from);
    const until = date(body.until);
    if (from !== null && until !== null && until < from) issue(ctx, ['until'], 'OUT_OF_RANGE');
    if (progress.length > 5) issue(ctx, ['progress'], 'OUT_OF_RANGE');
    const seen = new Set<string>();
    progress.forEach((point, i) => {
      const through = date(point.through);
      const before = progress[i - 1];
      const amount = money(point.amount);
      const beforeAmount = money(before?.amount);
      if (amount !== null && beforeAmount !== null && amount.compare(beforeAmount) <= 0) issue(ctx, ['progress', i, 'amount'], 'OUT_OF_RANGE');
      if (through === null) return;
      if (seen.has(through)) issue(ctx, ['progress', i, 'through'], 'DUPLICATE');
      seen.add(through);
      const beforeThrough = date(before?.through);
      if ((from !== null && through < from) || (until !== null && through >= until) || (beforeThrough !== null && through < beforeThrough)) {
        issue(ctx, ['progress', i, 'through'], 'OUT_OF_RANGE');
      }
    });
    if (progress.length === 0 && body.progressEstimated !== undefined) issue(ctx, ['progressEstimated'], 'NOT_ALLOWED');
    if (progress.length > 0 && body.progressEstimated === undefined) issue(ctx, ['progressEstimated'], 'REQUIRED');
  })
  .transform(
    (body): Performance => ({
      from: body.from,
      until: body.until,
      progress: body.progress ?? [],
      progressEstimated: (body.progress ?? []).length === 0 ? null : (body.progressEstimated ?? null),
    }),
  );

/** The lines that take a performance (§59F "Allowed on"): never with `NOT_RELEVANT`, on a deposit or on an interest line. */
export function performanceFieldIssue(body: {
  readonly sourceType?: string;
  readonly taxCategory?: string;
  readonly treatment?: string | null;
}): string | null {
  if (body.taxCategory === 'LOAN_INTEREST' || body.taxCategory === 'FINANCING_COSTS') return 'NOT_ALLOWED';
  const erhaltung = body.taxCategory === 'MAINTENANCE' || body.taxCategory === 'WEG_SPENDING';
  if (body.sourceType === 'DEPOSIT_CLOSING' || body.treatment === 'NOT_RELEVANT' || !(erhaltung || body.treatment === 'CAPITALIZED')) {
    return 'NOT_ALLOWED_WITH_TREATMENT';
  }
  return null;
}
