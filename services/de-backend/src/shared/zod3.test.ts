import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { array, asZod3, coercedInteger, integer, number, transform } from './zod3.js';

/**
 * VC-X-65: Zod 3's parsing on Zod 4. Every expectation is what Zod 3.25.76 answered for the same schema and input
 * (recorded on main b97f2d7 with the Zod 3 API: the paths of its issues, in order); each counter-check shows what Zod 4
 * answers without the helper, so the helper is what makes the difference. Synthetic values only.
 */

/** The paths of the issues of a parse, in order (`asZod3` applied, as every reader of issues does); `ok` when valid. */
function paths(schema: z.ZodType, value: unknown): string[] | 'ok' {
  const result = schema.safeParse(value);
  return result.success ? 'ok' : asZod3(result.error.issues).map((issue) => issue.path.join('.'));
}
const raw = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);
  return result.success ? 'ok' : result.error.issues.map((issue) => issue.path.join('.'));
};

/** A strict object whose refinement always adds an issue at `b`: `b` in the answer means the refinement ran. */
const parent = (inner: z.ZodType) =>
  z
    .object({ v: inner, b: z.number() })
    .strict()
    .superRefine((_body, ctx) => ctx.addIssue({ code: 'custom', path: ['b'] }));

describe('zod3.transform: runs on a valid value only; a failed input aborts the parent, its own issue does not', () => {
  const amountOf = (value: { amount: string }, ctx: z.core.$RefinementCtx<{ amount: string }>) => {
    if (value.amount === 'x') ctx.addIssue({ code: 'custom', path: ['amount'] });
    return value.amount;
  };

  it('a failed pattern before it: the parent refinement does not run (Zod 3: [v])', () => {
    expect(paths(parent(transform(z.string().regex(/^a$/), (v) => v)), { v: 'x', b: 1 })).toEqual(['v']);
    // Counter-check: Zod 4's own transform lets the refinement run.
    expect(
      raw(
        parent(
          z
            .string()
            .regex(/^a$/)
            .transform((v) => v),
        ),
        { v: 'x', b: 1 },
      ),
    ).toEqual(['v', 'b']);
  });

  it('its own issue: the parent refinement still runs (Zod 3: [v, b])', () => {
    const own = (v: string, ctx: z.core.$RefinementCtx<string>) => (ctx.addIssue({ code: 'custom' }), v);
    expect(paths(parent(transform(z.string(), own)), { v: 'x', b: 1 })).toEqual(['v', 'b']);
    expect(raw(parent(z.string().transform(own)), { v: 'x', b: 1 })).toEqual(['v']);
  });

  it('an unknown key before it: it does not run, the parent refinement does not run (Zod 3: [v])', () => {
    const amount = transform(z.object({ amount: z.string() }).strict(), amountOf);
    expect(paths(parent(amount), { v: { amount: 'x', zzz: 1 }, b: 1 })).toEqual(['v']);
    expect(raw(parent(z.object({ amount: z.string() }).strict().transform(amountOf)), { v: { amount: 'x', zzz: 1 }, b: 1 })).toEqual(['v', 'v.amount']);
  });

  it('a valid value is transformed; a string issue is its own issue too', () => {
    expect(transform(z.string(), (v) => v.toUpperCase()).parse('x')).toBe('X');
    expect(paths(parent(transform(z.string(), (v, ctx) => (ctx.addIssue('bad'), v))), { v: 'x', b: 1 })).toEqual(['v', 'b']);
  });
});

describe('zod3.number and zod3.integer: Zod 3 numbers and integers', () => {
  it('a number is any number but NaN, Infinity included; a wrong or missing one is invalid_type', () => {
    expect(paths(number(), Infinity)).toBe('ok');
    expect(paths(number(), -Infinity)).toBe('ok');
    expect(paths(number(), NaN)).toEqual(['']);
    expect(paths(number(), '1')).toEqual(['']);
    const missing = z.object({ n: number() }).safeParse({});
    expect(missing.success ? [] : missing.error.issues.map((i) => [i.path.join('.'), i.code])).toEqual([['n', 'invalid_type']]);
    // Counter-check: Zod 4's number refuses Infinity.
    expect(raw(z.number(), Infinity)).toEqual(['']);
  });

  it('a fraction is one issue, and the bounds are still checked (Zod 3: 40.5 in 1–31 is two)', () => {
    const day = integer(1, 31);
    expect(paths(day, 1.5)).toEqual(['']);
    expect(paths(day, 40.5)).toEqual(['', '']);
    expect(paths(day, Infinity)).toEqual(['', '']);
    expect(paths(day, 0)).toEqual(['']);
    expect(paths(day, 31)).toBe('ok');
    expect(paths(integer(), 1e21)).toBe('ok');
    // Counter-check: Zod 4's int aborts at the fraction and refuses an integer beyond 2^53.
    expect(raw(z.number().int().min(1).max(31), 40.5)).toEqual(['']);
    expect(raw(z.number().int(), 1e21)).toEqual(['']);
  });

  it('a refinement after a fraction still runs (Zod 3: two issues)', () => {
    const refined = integer().superRefine((_v, ctx) => ctx.addIssue({ code: 'custom' }));
    expect(paths(refined, 1.5)).toEqual(['', '']);
    expect(
      raw(
        z
          .number()
          .int()
          .superRefine((_v, ctx) => ctx.addIssue({ code: 'custom' })),
        1.5,
      ),
    ).toEqual(['']);
  });

  it('coercedInteger reads a query text as Zod 3 coerced it', () => {
    const page = coercedInteger(1, 200);
    expect(paths(page, 'x')).toEqual(['']);
    expect(paths(page, '')).toEqual(['']);
    expect(paths(page, 'Infinity')).toEqual(['', '']);
    expect(paths(page, '1.5')).toEqual(['']);
    expect(page.parse('1e2')).toBe(100);
    expect(paths(z.object({ p: page }), {})).toEqual(['p']);
    expect(raw(z.coerce.number().int().min(1).max(200), 'Infinity')).toEqual(['']);
  });
});

describe('asZod3: the issues in Zod 3 number and order', () => {
  it('a length check after a wrong type is dropped (Zod 3: one issue)', () => {
    expect(paths(z.object({ s: z.string().min(1) }), { s: [] })).toEqual(['s']);
    expect(raw(z.object({ s: z.string().min(1) }), { s: [] })).toEqual(['s', 's']);
  });

  it('an array size comes before its elements (Zod 3 checked it first)', () => {
    expect(paths(z.object({ a: array(z.string()).min(2) }), { a: [1] })).toEqual(['a', 'a.0']);
    expect(raw(z.object({ a: z.array(z.string()).min(2) }), { a: [1] })).toEqual(['a.0', 'a']);
  });
});

describe('zod3.array: every element is parsed, a maximum is a dirty issue (Zod 3)', () => {
  it('over its maximum, the elements are still checked and named (Zod 3: [a, a.0, a.1])', () => {
    expect(paths(z.object({ a: array(z.string()).max(1) }), { a: [1, 2] })).toEqual(['a', 'a.0', 'a.1']);
    expect(paths(z.object({ a: array(z.string()).min(1).max(1) }), { a: [1, 2] })).toEqual(['a', 'a.0', 'a.1']);
    // Counter-check: Zod 4 stops the array at its maximum.
    expect(raw(z.object({ a: z.array(z.string()).max(1) }), { a: [1, 2] })).toEqual(['a']);
  });

  it('over its maximum, the parent refinement still runs (Zod 3: dirty)', () => {
    expect(paths(parent(array(z.string()).max(1)), { v: ['x', 'y'], b: 1 })).toEqual(['v', 'b']);
    expect(raw(parent(z.array(z.string()).max(1)), { v: ['x', 'y'], b: 1 })).toEqual(['v']);
  });

  it('counter-check: a size issue of a valid type stays, in place', () => {
    expect(paths(z.object({ s: z.string().min(2), t: z.number() }), { s: 'x', t: 'y' })).toEqual(['s', 't']);
    expect(paths(z.object({ a: z.array(z.string()).min(2), b: z.string() }), { a: ['x'], b: 1 })).toEqual(['a', 'b']);
  });
});
