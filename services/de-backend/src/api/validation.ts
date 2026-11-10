import type { Request, Response } from 'express';
import { z, type ZodError } from 'zod';
import { Money, MoneyError } from '../shared/index.js';
import { sendError } from './error-envelope.js';

/** DE resource ids (PostgreSQL uuid). */
export const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Client-generated key (api-design.md §15): visible ASCII, bounded length. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

export interface FieldError {
  readonly field: string;
  readonly code: string;
}

/**
 * Answers `400 VALIDATION_ERROR` with the fields given and, after them, the errors of the request's query when
 * `readQuery` refused it (api-design.md §58W rule 5): a malformed path id and the query's errors in one answer.
 */
export function sendValidationError(res: Response, fields: readonly FieldError[]): void {
  sendError(res, 400, 'VALIDATION_ERROR', 'Validation failed.', { fields: [...fields, ...(refusedQueries.get(res.req) ?? [])] });
}

/** The §90 code of a zod issue: a route's own code, REQUIRED for a missing field, anything else INVALID_FORMAT. */
function codeOf(issue: z.ZodIssue): string {
  return issue.code === 'custom' && typeof issue.params?.['code'] === 'string'
    ? issue.params['code']
    : issue.code === 'invalid_type' && issue.received === 'undefined'
      ? 'REQUIRED'
      : 'INVALID_FORMAT';
}

/**
 * zod issues as api-design §90 field errors (a missing field REQUIRED, anything else INVALID_FORMAT) for what is not a
 * JSON body: path parameters and the bank import's multipart metadata. A body is read with `readBody` (§58X).
 */
export function fieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({ field: issue.path.join('.') || '(body)', code: codeOf(issue) }));
}

export type BodyResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly errors: readonly FieldError[] };

/** The body of the five commands that take none (§58X rule 3): no body, an empty body or `{}`; any field is unknown. */
export const EMPTY_BODY = z.object({}).strict();

/** Body schemas found strict (§58X rule 2): each is walked once, at its first request. */
const strictSchemas = new WeakSet<z.ZodTypeAny>();

/** The zod types that hold no object (nothing to walk). */
const LEAVES: ReadonlySet<string> = new Set([
  'ZodString',
  'ZodNumber',
  'ZodNaN',
  'ZodBigInt',
  'ZodBoolean',
  'ZodDate',
  'ZodSymbol',
  'ZodUndefined',
  'ZodNull',
  'ZodAny',
  'ZodUnknown',
  'ZodNever',
  'ZodVoid',
  'ZodLiteral',
  'ZodEnum',
  'ZodNativeEnum',
]);

/**
 * Throws unless every object anywhere in `schema` refuses an unknown key (`.strict()`, no catch-all), under every
 * wrapper: refinements, transforms and preprocessing, optional, nullable, default, catch, readonly, brand, pipe, arrays,
 * sets, unions, discriminated unions, intersections, records, maps, tuples, promises and lazy schemas (§58X decision 6).
 * A type it does not know also throws, so a new wrapper cannot hide a non-strict object.
 */
export function assertStrictBody(schema: z.ZodTypeAny, at = '(body)', seen = new Set<z.ZodTypeAny>()): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const def = schema._def as Record<string, unknown> & { typeName?: string };
  const walk = (inner: unknown, path = at) => assertStrictBody(inner as z.ZodTypeAny, path, seen);
  const typeName = def.typeName ?? '';
  if (LEAVES.has(typeName)) return;
  switch (typeName) {
    case 'ZodObject': {
      const object = schema as z.AnyZodObject;
      if (object._def.unknownKeys !== 'strict' || !(object._def.catchall instanceof z.ZodNever)) throw new Error(`readBody: the object at ${at} is not strict`);
      for (const [key, value] of Object.entries(object.shape as Record<string, z.ZodTypeAny>)) walk(value, at === '(body)' ? key : `${at}.${key}`);
      return;
    }
    case 'ZodEffects':
      return walk(def['schema']);
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodCatch':
    case 'ZodReadonly':
      return walk(def['innerType']);
    case 'ZodBranded':
    case 'ZodPromise':
      return walk(def['type']);
    case 'ZodArray':
      return walk(def['type'], `${at}.*`);
    case 'ZodSet':
      return walk(def['valueType'], `${at}.*`);
    case 'ZodPipeline':
      walk(def['in']);
      return walk(def['out']);
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      for (const option of def['options'] as readonly z.ZodTypeAny[]) walk(option);
      return;
    case 'ZodIntersection':
      walk(def['left']);
      return walk(def['right']);
    case 'ZodRecord':
    case 'ZodMap':
      walk(def['keyType']);
      return walk(def['valueType'], `${at}.*`);
    case 'ZodTuple':
      (def['items'] as readonly z.ZodTypeAny[]).forEach((item, i) => walk(item, `${at}.${i}`));
      if (def['rest'] !== null && def['rest'] !== undefined) walk(def['rest'], `${at}.*`);
      return;
    case 'ZodLazy':
      return walk((def['getter'] as () => z.ZodTypeAny)());
    default:
      throw new Error(`readBody: cannot check a ${typeName || 'schema without a type name'} at ${at} for strictness`);
  }
}

/** A path of the parsed document as a set key (a key may contain a dot, so the joined field is not unique). */
const pathKey = (path: readonly (string | number)[]) => JSON.stringify(path.map(String));

/**
 * The unknown fields of `unknown` (set keys of their paths), in the order of the parsed document, depth first: each
 * object's keys as `Object.keys` gives them, an unknown field not descended into (§58X decision 7, edge cases).
 */
function inDocumentOrder(value: unknown, unknown: ReadonlySet<string>, path: readonly string[] = [], out: string[][] = []): string[][] {
  if (Array.isArray(value)) value.forEach((item, i) => inDocumentOrder(item, unknown, [...path, String(i)], out));
  else if (typeof value === 'object' && value !== null)
    for (const key of Object.keys(value)) {
      const at = [...path, key];
      if (unknown.has(pathKey(at))) out.push(at);
      else inDocumentOrder((value as Record<string, unknown>)[key], unknown, at, out);
    }
  return out;
}

/**
 * zod issues of a body as §90 field errors (§58X rules 1, 5): the schema's own errors in zod's order (a missing field
 * REQUIRED, a route's own code, anything else INVALID_FORMAT; the whole body `(body)`), then `extra`, then one
 * `INVALID_FORMAT` per unknown field, named by its dotted path with the array index, in the order of the document.
 */
function bodyErrors(error: ZodError | undefined, body: unknown, extra: readonly FieldError[]): FieldError[] {
  const own: FieldError[] = [];
  const unknown = new Map<string, readonly (string | number)[]>();
  for (const issue of error?.issues ?? []) {
    if (issue.code === 'unrecognized_keys') for (const key of issue.keys) unknown.set(pathKey([...issue.path, key]), [...issue.path, key]);
    else own.push({ field: issue.path.join('.') || '(body)', code: codeOf(issue) });
  }
  const ordered = inDocumentOrder(body, new Set(unknown.keys()));
  for (const at of ordered) unknown.delete(pathKey(at));
  // A key the walk did not find (none should remain) keeps zod's order, after the others.
  const paths = [...ordered, ...unknown.values()];
  return [...own, ...extra, ...paths.map((at) => ({ field: at.map(String).join('.'), code: 'INVALID_FORMAT' }))];
}

/**
 * The body of a command (api-design.md §58X), the only reader of a request's body in `src/api/` (the lint rule), the
 * twin of `readQuery`. The route's `express.json` has parsed it (no body and `{}` are the empty object; malformed JSON,
 * `null`, whitespace and an oversized body never reach the handler). The schema must be strict throughout
 * (`assertStrictBody`, once per schema; a route with a non-strict schema answers `500` on its first request). `also`
 * checks the raw body beside the schema (a rule zod would skip once a field failed): its errors come after the schema's
 * own, before the unknown fields. The caller answers a refusal with its route's status (`400`; the resolve `422`).
 */
export function readBody<S extends z.ZodTypeAny>(schema: S, req: Request, also?: (raw: unknown) => readonly FieldError[]): BodyResult<z.output<S>> {
  if (!strictSchemas.has(schema)) {
    assertStrictBody(schema);
    strictSchemas.add(schema);
  }
  const raw: unknown = req.body;
  if (raw === undefined) throw new Error('readBody: the route parses no JSON body (express.json)');
  const parsed = schema.safeParse(raw);
  const extra = also?.(raw) ?? [];
  if (parsed.success && extra.length === 0) return { ok: true, data: parsed.data as z.output<S> };
  return { ok: false, errors: bodyErrors(parsed.success ? undefined : parsed.error, raw, extra) };
}

/** The query of a route without parameters (§58W rule 1): every parameter is unknown. */
export const NO_QUERY = z.object({});

/** §11's paging, the one fragment of every paged route (§58W "Pagination consistent across routes"). */
export const PAGING = {
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
};

/** The same bounds without defaults: the two day-or-history reads, where `asOf` excludes paging (§26.1, §49.2). */
export const OPTIONAL_PAGING = { page: PAGING.page.removeDefault().optional(), pageSize: PAGING.pageSize.removeDefault().optional() };

export type QueryResult<T> = { readonly ok: true; readonly data: T } | QueryRefusal;
export interface QueryRefusal {
  readonly ok: false;
  readonly errors: readonly FieldError[];
}

/** The errors of every query `readQuery` refused, by request, for `sendValidationError`. */
const refusedQueries = new WeakMap<Request, readonly FieldError[]>();

/** The parameter names a query schema knows: the keys of its object, under any refinement. */
const knownKeysOf = new WeakMap<z.ZodTypeAny, ReadonlySet<string>>();
function knownKeys(schema: z.ZodTypeAny): ReadonlySet<string> {
  const cached = knownKeysOf.get(schema);
  if (cached !== undefined) return cached;
  let inner: z.ZodTypeAny = schema;
  while (inner instanceof z.ZodEffects) inner = inner.innerType() as z.ZodTypeAny;
  if (!(inner instanceof z.ZodObject)) throw new Error('readQuery: a query schema is an object');
  const keys = new Set(Object.keys(inner.shape as object));
  knownKeysOf.set(schema, keys);
  return keys;
}

/** The query string as the client sent it: the part of the request line's target after the first `?`. */
function rawQuery(req: Request): string {
  const target = req.originalUrl;
  const at = target.indexOf('?');
  return at === -1 ? '' : target.slice(at + 1);
}

/**
 * The query of a request (api-design.md §58W), the only reader of the query in `src/api/` (the lint rule). Read from the
 * raw query string with `URLSearchParams` (a key decoded, `+` a space, nothing dropped, no arrays or objects), not from
 * Express's `req.query`. Every key the schema does not know is refused by its name, as sent; a key given more than once,
 * known or not, is refused once; both `INVALID_FORMAT`, in the order of first appearance, after the schema's own errors
 * on the known parameters (each named by the parameter alone, a comma list without an index). The schema is strict by
 * construction: only its own keys reach it. A refused query is also remembered for `sendValidationError`, so a path
 * error answered before the handler checks the result carries the query's errors beside it (rule 5).
 */
export function readQuery<S extends z.ZodTypeAny>(schema: S, req: Request): QueryResult<z.output<S>> {
  const known = knownKeys(schema);
  const counts = new Map<string, { readonly first: string; count: number }>();
  for (const [key, value] of new URLSearchParams(rawQuery(req))) {
    const seen = counts.get(key);
    if (seen === undefined) counts.set(key, { first: value, count: 1 });
    else seen.count += 1;
  }
  const input = Object.create(null) as Record<string, string>;
  const refused: FieldError[] = [];
  const repeated = new Set<string>();
  for (const [key, { first, count }] of counts) {
    if (!known.has(key)) refused.push({ field: key, code: 'INVALID_FORMAT' });
    else {
      if (count > 1) {
        repeated.add(key);
        refused.push({ field: key, code: 'INVALID_FORMAT' });
      }
      input[key] = first;
    }
  }
  const parsed = schema.safeParse(input);
  const own = parsed.success
    ? []
    : parsed.error.issues
        .map((issue) => ({ field: issue.path.length === 0 ? '(query)' : String(issue.path[0]), code: codeOf(issue) }))
        .filter((error) => !repeated.has(error.field));
  if (parsed.success && refused.length === 0) return { ok: true, data: parsed.data as z.output<S> };
  const errors = [...own, ...refused];
  refusedQueries.set(req, errors);
  return { ok: false, errors };
}

/** Answers a refused query (`400`, with `sendValidationError`) and says so; the handler then returns. */
export function refuseQuery(res: Response, query: QueryResult<unknown>): query is QueryRefusal {
  if (query.ok) return false;
  sendValidationError(res, []);
  return true;
}

/**
 * The optional `Idempotency-Key` header: `{ key }` (key undefined when absent),
 * or `undefined` after answering 400 for a malformed one.
 */
export function readIdempotencyKey(req: Request, res: Response): { key: string | undefined } | undefined {
  const header = req.headers['idempotency-key'];
  if (header === undefined) return { key: undefined };
  if (typeof header === 'string' && IDEMPOTENCY_KEY.test(header)) return { key: header };
  sendValidationError(res, [{ field: 'Idempotency-Key', code: 'INVALID_FORMAT' }]);
  return undefined;
}

const VERSION_TAG = /^\d{1,9}$/;

/**
 * The entity tags of an `If-Match` list (RFC 9110 §8.8.3, §5.6.1): `"…"`, optionally weak (`W/"…"`), separated by
 * commas, with empty elements allowed. Read character by character, since a tag may itself contain a comma.
 * Undefined when the header is not such a list.
 */
function entityTags(header: string): { readonly weak: boolean; readonly opaque: string }[] | undefined {
  const tags: { weak: boolean; opaque: string }[] = [];
  let i = 0;
  const skipSpace = () => {
    while (header[i] === ' ' || header[i] === '\t') i++;
  };
  for (;;) {
    skipSpace();
    if (i === header.length) return tags;
    if (header[i] === ',') {
      i++; // an empty list element
      continue;
    }
    const weak = header.startsWith('W/', i);
    if (weak) i += 2;
    if (header[i] !== '"') return undefined;
    const end = header.indexOf('"', i + 1);
    if (end === -1) return undefined;
    const opaque = header.slice(i + 1, end);
    // etagc: %x21 / %x23-7E / obs-text — no control characters, no DEL.
    if (!/^[\x21\x23-\x7e\x80-\xff]*$/.test(opaque)) return undefined;
    tags.push({ weak, opaque });
    i = end + 1;
    skipSpace();
    if (i === header.length) return tags;
    if (header[i] !== ',') return undefined;
    i++;
  }
}

/**
 * The optional `If-Match` header (api-design.md §16.1, RFC 9110 §13.1.1) as the versions it names: `{ versions }`,
 * undefined when absent or `*`. A list matches if any of its tags does; `If-Match` compares strongly, so weak tags and
 * tags that are not a version never match and add nothing (an empty list then fails the check). Answers 400 and
 * returns `undefined` for a header that is not a list of entity tags.
 */
export function readIfMatch(req: Request, res: Response): { versions: readonly number[] | undefined } | undefined {
  const header = req.headers['if-match'];
  if (header === undefined || header.trim() === '*') return { versions: undefined };
  const tags = entityTags(header);
  if (tags === undefined || tags.length === 0) {
    sendValidationError(res, [{ field: 'If-Match', code: 'INVALID_FORMAT' }]);
    return undefined;
  }
  return { versions: tags.filter((t) => !t.weak && VERSION_TAG.test(t.opaque)).map((t) => Number(t.opaque)) };
}

/** Field codes for amounts (api-design.md §31.1: 400 for each). */
const MONEY_CODES: Record<MoneyError['code'], string> = {
  INVALID_AMOUNT: 'INVALID_FORMAT',
  AMOUNT_OUT_OF_RANGE: 'AMOUNT_OUT_OF_RANGE',
  SCALE_EXCEEDED: 'SCALE_EXCEEDED',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
};

/**
 * Money arrives as `{ amount: "1250.00", currency: "EUR" }` (api-design.md §86).
 * The amount must be a decimal string, never a JSON number (no float in transit),
 * non-negative (the sign is `direction`, data-model.md §17.4) and representable
 * in the currency's scale — rejected, never rounded.
 */
export const money = z
  .object({ amount: z.string(), currency: z.string() })
  .strict()
  .transform((value, ctx) => {
    try {
      const parsed = Money.of(value.amount, value.currency);
      if (parsed.isNegative()) {
        ctx.addIssue({ code: 'custom', path: ['amount'], params: { code: 'NEGATIVE_AMOUNT' } });
        return z.NEVER;
      }
      return parsed;
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      const path = error.code === 'UNSUPPORTED_CURRENCY' ? ['currency'] : ['amount'];
      ctx.addIssue({ code: 'custom', path, params: { code: MONEY_CODES[error.code] } });
      return z.NEVER;
    }
  });

/** An integer in `[min, max]`: another number is `OUT_OF_RANGE`, a non-integer `INVALID_FORMAT`. */
export const integerIn = (min: number, max: number) =>
  z
    .number()
    .int()
    .superRefine((value, ctx) => {
      if (value < min || value > max) ctx.addIssue({ code: 'custom', params: { code: 'OUT_OF_RANGE' } });
    });

/** A day of the month, 1–31 (VC-7-02, api-design §58A): in a shorter month it means the month's last day. */
export const dayOfMonth = integerIn(1, 31);

/** Money that may be negative, where the sign is part of the figure (a credit line, an Abrechnungsspitze; api-design.md §50). */
export const signedMoney = z
  .object({ amount: z.string(), currency: z.string() })
  .strict()
  .transform((value, ctx) => {
    try {
      return Money.of(value.amount, value.currency);
    } catch (error) {
      if (!(error instanceof MoneyError)) throw error;
      const path = error.code === 'UNSUPPORTED_CURRENCY' ? ['currency'] : ['amount'];
      ctx.addIssue({ code: 'custom', path, params: { code: MONEY_CODES[error.code] } });
      return z.NEVER;
    }
  });
