import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zod3 } from '../shared/index.js';
import { assertStrictBody, EMPTY_BODY, money, readBody, signedMoney } from './validation.js';
import { positiveEur } from './tax-classification-performance.js';

/**
 * VC-X-69 (api-design.md §58X test 2, decision 6; review of #317): `readBody` refuses a schema with a non-strict object
 * anywhere in it, under every wrapper zod has, before any request is parsed with it. One deliberately non-strict schema
 * per wrapper type must be found; its strict twin must pass. No database.
 */

const loose = z.object({ a: z.string() });
const strict = loose.strict();

/**
 * Each wrapper around `inner`: the non-strict one must throw, the same around the strict object must not. Zod 4 (VC-X-65)
 * names its types by `def.type`; a refinement is a check of the object itself and a brand a type only, so both leave the
 * object in place (still found), and `zod3.transform` is a pipe with a check before it.
 */
const WRAPPERS: [string, (inner: z.ZodType) => z.ZodType][] = [
  ['the object itself', (inner) => inner],
  ['a field of a strict object', (inner) => z.object({ x: inner }).strict()],
  ['pipe: transform', (inner) => inner.transform((v: unknown) => v)],
  ['pipe: zod3.transform', (inner) => zod3.transform(inner, (v: unknown) => v)],
  ['check: refine', (inner) => inner.refine(() => true)],
  ['check: superRefine', (inner) => inner.superRefine(() => undefined)],
  ['pipe: preprocess', (inner) => z.preprocess((v) => v, inner)],
  ['optional', (inner) => inner.optional()],
  ['nullable', (inner) => inner.nullable()],
  ['nullish', (inner) => inner.nullish()],
  ['default', (inner) => inner.default({ a: '' })],
  ['prefault', (inner) => inner.prefault({ a: '' })],
  ['nonoptional', (inner) => inner.optional().nonoptional()],
  ['catch', (inner) => inner.catch({ a: '' })],
  ['readonly', (inner) => inner.readonly()],
  ['brand', (inner) => inner.brand<'B'>()],
  ['pipe out', (inner) => z.unknown().pipe(inner)],
  ['pipe in', (inner) => inner.pipe(z.unknown())],
  ['array', (inner) => z.array(inner)],
  ['set', (inner) => z.set(inner)],
  ['union', (inner) => z.union([z.string(), inner])],
  ['discriminated union', (inner) => z.discriminatedUnion('k', [z.object({ k: z.literal('s') }).strict(), z.object({ k: z.literal('l'), v: inner }).strict()])],
  ['intersection right', (inner) => z.intersection(z.object({}).strict(), inner)],
  ['intersection left', (inner) => z.intersection(inner, z.object({}).strict())],
  ['record', (inner) => z.record(z.string(), inner)],
  ['map', (inner) => z.map(z.string(), inner)],
  ['tuple items', (inner) => z.tuple([z.string(), inner])],
  ['tuple rest', (inner) => z.tuple([z.string()]).rest(inner)],
  ['promise', (inner) => z.promise(inner)],
  ['lazy', (inner) => z.lazy(() => inner)],
  ['two wrappers deep (array of optional refined)', (inner) => z.array(inner.refine(() => true).optional())],
];

describe('assertStrictBody finds a non-strict object under every wrapper (§58X decision 6)', () => {
  it.each(WRAPPERS)('%s: non-strict throws, strict passes', (_label, wrap) => {
    expect(() => assertStrictBody(wrap(loose))).toThrow(/is not strict/);
    expect(() => assertStrictBody(wrap(strict))).not.toThrow();
  });

  it('a discriminated union whose option is itself non-strict is found', () => {
    expect(() => assertStrictBody(z.discriminatedUnion('k', [z.object({ k: z.literal('a') }).strict(), z.object({ k: z.literal('b') })]))).toThrow(
      /is not strict/,
    );
  });

  it('passthrough, strip and a catch-all are not strict; the message names the path', () => {
    expect(() => assertStrictBody(z.object({ x: loose.passthrough() }).strict())).toThrow('readBody: the object at x is not strict');
    expect(() => assertStrictBody(z.object({ x: z.array(strict.strip()) }).strict())).toThrow('readBody: the object at x.* is not strict');
    expect(() => assertStrictBody(strict.catchall(z.string()))).toThrow('readBody: the object at (body) is not strict');
  });

  it('a recursive lazy schema is walked once and terminates', () => {
    type Node = { children?: Node[] | undefined };
    const node: z.ZodType<Node> = z.lazy(() => z.object({ children: z.array(node).optional() }).strict());
    expect(() => assertStrictBody(node)).not.toThrow();
    const looseNode: z.ZodType<Node> = z.lazy(() => z.object({ children: z.array(looseNode).optional() }));
    expect(() => assertStrictBody(looseNode)).toThrow(/is not strict/);
  });

  it('a zod type it does not know throws, so a new wrapper cannot hide an object', () => {
    // `file` is a Zod 4 type the walk does not list (no route takes one): refused, not passed.
    expect(() => assertStrictBody(z.file())).toThrow('readBody: cannot check a file at (body) for strictness');
    expect(() => assertStrictBody(z.object({ x: z.file() }).strict())).toThrow('readBody: cannot check a file at x for strictness');
  });

  it('the leaves of Zod 3 parsing pass: zod3.number, zod3.integer, zod3.coercedInteger, a transform output', () => {
    for (const schema of [zod3.number(), zod3.integer(1, 2), zod3.coercedInteger(1, 2), zod3.transform(z.string(), (v) => v)])
      expect(() => assertStrictBody(z.object({ x: schema }).strict())).not.toThrow();
  });

  it('the amount objects are strict (money, signedMoney, positiveEur) and EMPTY_BODY is', () => {
    for (const schema of [money, signedMoney, positiveEur, EMPTY_BODY]) expect(() => assertStrictBody(schema)).not.toThrow();
    // Counter-check: their objects as they were before VC-X-69 are found.
    expect(() => assertStrictBody(z.object({ amount: z.string(), currency: z.string() }).transform((v) => v))).toThrow(/is not strict/);
  });
});

describe('readBody (§58X decision 6)', () => {
  const req = (body: unknown) => ({ body }) as Request;

  it('refuses a non-strict schema at its first request, every time, before parsing', () => {
    const schema = z.object({ reason: z.string() });
    expect(() => readBody(schema, req({ reason: 'x' }))).toThrow(/is not strict/);
    expect(() => readBody(schema, req({ reason: 'x' }))).toThrow(/is not strict/);
  });

  it('a route without jsonBody is a programming error (no silent empty body)', () => {
    expect(() => readBody(EMPTY_BODY, req(undefined))).toThrow('readBody: the route parses no JSON body (jsonBody)');
  });

  it('returns the parsed data, or the errors: own, then the raw check, then the unknown fields', () => {
    const schema = z.object({ reason: z.string(), n: z.number().optional() }).strict();
    expect(readBody(schema, req({ reason: 'x' }))).toEqual({ ok: true, data: { reason: 'x' } });
    const also = () => [{ field: 'n', code: 'NOT_ALLOWED' }];
    expect(readBody(schema, req({ zzz: 1, n: 'x' }), also)).toEqual({
      ok: false,
      errors: [
        { field: 'reason', code: 'REQUIRED' },
        { field: 'n', code: 'INVALID_FORMAT' },
        { field: 'n', code: 'NOT_ALLOWED' },
        { field: 'zzz', code: 'INVALID_FORMAT' },
      ],
    });
    // The raw check alone refuses a body the schema accepts.
    expect(readBody(schema, req({ reason: 'x' }), also)).toEqual({ ok: false, errors: [{ field: 'n', code: 'NOT_ALLOWED' }] });
  });
});
