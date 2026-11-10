import express, { type Request, type RequestHandler, type Response } from 'express';
import { z, type ZodError } from 'zod';
import { Money, MoneyError, zod3 } from '../shared/index.js';
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

/**
 * The §90 code of an issue zod raised itself, as Zod 3 read it (VC-X-65): a missing value is `REQUIRED` where Zod 3
 * reported `invalid_type` with `received: "undefined"` (every type, and an enumeration: Zod 4 reports an enumeration's
 * missing value as `invalid_value`), anything else `INVALID_FORMAT` (a missing literal too, Zod 3's `invalid_literal`).
 * Zod 4 drops the input from a finished issue, so the code is decided while the issue is raised, in the error map of the
 * parse (`parse`), and carried as the issue's message.
 */
const ISSUE_CODES: z.core.$ZodErrorMap = (issue) => {
  if (issue.input !== undefined) return INVALID_FORMAT_MARK;
  if (issue.code === 'invalid_type') return REQUIRED_MARK;
  if (issue.code === 'invalid_value' && issue.inst instanceof z.ZodEnum) return REQUIRED_MARK;
  return INVALID_FORMAT_MARK;
};
const REQUIRED_MARK = 'vc:REQUIRED';
const INVALID_FORMAT_MARK = 'vc:INVALID_FORMAT';

/** Parses `value` with the error map that gives every issue its §90 code (`fieldErrors` reads it). */
export function parse<S extends z.ZodType>(schema: S, value: unknown): z.ZodSafeParseResult<z.output<S>> {
  return schema.safeParse(value, { error: ISSUE_CODES });
}

/** The §90 code of a zod issue: a route's own code, REQUIRED for a missing field, anything else INVALID_FORMAT. */
function codeOf(issue: z.core.$ZodIssue): string {
  if (issue.code === 'custom' && typeof issue.params?.['code'] === 'string') return issue.params['code'];
  if (issue.message === REQUIRED_MARK) return 'REQUIRED';
  if (issue.message === INVALID_FORMAT_MARK) return 'INVALID_FORMAT';
  // A refinement's own message without a code of its own (none today) reads as Zod 3 read it.
  if (issue.code === 'custom') return 'INVALID_FORMAT';
  throw new Error('validation: a zod error not parsed with `parse` (its codes are unknown)');
}

/**
 * zod issues as api-design §90 field errors (a missing field REQUIRED, anything else INVALID_FORMAT) for what is not a
 * JSON body: path parameters and the bank import's multipart metadata, parsed with `parse`. A body is read with
 * `readBody` (§58X).
 */
export function fieldErrors(error: ZodError): FieldError[] {
  return zod3.asZod3(error.issues).map((issue) => ({ field: issue.path.join('.') || '(body)', code: codeOf(issue) }));
}

export type BodyResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly errors: readonly FieldError[] };

/** The body of the five commands that take none (§58X rule 3): no body, an empty body or `{}`; any field is unknown. */
export const EMPTY_BODY = z.object({}).strict();

/** Body schemas found strict (§58X rule 2): each is walked once, at its first request. */
const strictSchemas = new WeakSet<z.ZodType>();

/** The zod types that hold no object (nothing to walk); a transform is a function, the output side of a pipe. */
const LEAVES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'nan',
  'bigint',
  'boolean',
  'date',
  'symbol',
  'undefined',
  'null',
  'any',
  'unknown',
  'never',
  'void',
  'literal',
  'enum',
  'transform',
  // A value checked by a function only (`zod3.number`): no object inside.
  'custom',
]);

/**
 * Throws unless every object anywhere in `schema` refuses an unknown key (`.strict()`: the catch-all `never`), under
 * every wrapper: pipes (transforms and preprocessing), optional, nullable, default, prefault, catch, readonly,
 * non-optional, arrays, sets, unions (discriminated ones too), intersections, records, maps, tuples, promises and lazy
 * schemas (§58X decision 6). Refinements are checks of the schema itself and a brand is a type only (Zod 4), so neither
 * wraps anything. A type it does not know also throws, so a new wrapper cannot hide a non-strict object.
 */
export function assertStrictBody(schema: z.ZodType, at = '(body)', seen = new Set<z.ZodType>()): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  const def = schema._zod.def as unknown as Record<string, unknown> & { readonly type: string };
  const walk = (inner: unknown, path = at) => assertStrictBody(inner as z.ZodType, path, seen);
  if (LEAVES.has(def.type)) return;
  switch (def.type) {
    case 'object': {
      if (!(def['catchall'] instanceof z.ZodNever)) throw new Error(`readBody: the object at ${at} is not strict`);
      for (const [key, value] of Object.entries(def['shape'] as Record<string, z.ZodType>)) walk(value, at === '(body)' ? key : `${at}.${key}`);
      return;
    }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'catch':
    case 'readonly':
    case 'nonoptional':
    case 'promise':
      return walk(def['innerType']);
    case 'array':
      return walk(def['element'], `${at}.*`);
    case 'set':
      return walk(def['valueType'], `${at}.*`);
    case 'pipe':
      walk(def['in']);
      return walk(def['out']);
    case 'union':
      for (const option of def['options'] as readonly z.ZodType[]) walk(option);
      return;
    case 'intersection':
      walk(def['left']);
      return walk(def['right']);
    case 'record':
    case 'map':
      walk(def['keyType']);
      return walk(def['valueType'], `${at}.*`);
    case 'tuple':
      (def['items'] as readonly z.ZodType[]).forEach((item, i) => walk(item, `${at}.${i}`));
      if (def['rest'] !== null && def['rest'] !== undefined) walk(def['rest'], `${at}.*`);
      return;
    case 'lazy':
      return walk((def['getter'] as () => z.ZodType)());
    default:
      throw new Error(`readBody: cannot check a ${def.type || 'schema without a type'} at ${at} for strictness`);
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
  for (const issue of zod3.asZod3(error?.issues ?? [])) {
    // A body is parsed JSON: every path segment is a key or an index, never a symbol.
    const path = issue.path as (string | number)[];
    if (issue.code === 'unrecognized_keys') for (const key of issue.keys) unknown.set(pathKey([...path, key]), [...path, key]);
    else own.push({ field: path.join('.') || '(body)', code: codeOf(issue) });
  }
  const ordered = inDocumentOrder(body, new Set(unknown.keys()));
  for (const at of ordered) unknown.delete(pathKey(at));
  // A key the walk did not find (none should remain) keeps zod's order, after the others.
  const paths = [...ordered, ...unknown.values()];
  return [...own, ...extra, ...paths.map((at) => ({ field: at.map(String).join('.'), code: 'INVALID_FORMAT' }))];
}

/**
 * The JSON body parser of a command route, `express.json` as Express 4 ran it (VC-X-66; the only JSON parser in
 * `src/api/`, by the lint rule). Express 5's parser (body-parser 2) leaves the body `undefined` when there is none or its
 * type is not JSON, where Express 4's was `{}`: so a command without a body, or with a text, form or multipart body,
 * still reaches `readBody` with the empty object and answers its fields. And body-parser 2 decodes `br`, which Express 4
 * refused as an unsupported encoding (`415`, `encoding.unsupported`, answered `500` by the error handler): refused here the
 * same way, before the parser reads anything.
 */
export function jsonBody(limit: string): ReturnType<typeof express.json> {
  const parser = express.json({ limit });
  const handler: RequestHandler = (req, res, next) => {
    const encoding = req.headers['content-encoding'];
    if (typeof encoding === 'string' && encoding.toLowerCase() === 'br' && typeof req.is('application/json') === 'string') {
      next(
        Object.assign(new Error('unsupported content encoding "br"'), {
          status: 415,
          statusCode: 415,
          expose: true,
          encoding: 'br',
          type: 'encoding.unsupported',
        }),
      );
      return;
    }
    parser(req, res, (error?: unknown) => {
      if (error === undefined && req.body === undefined) req.body = {};
      next(error);
    });
  };
  // Typed as `express.json` is, so a route's path parameters stay inferred from its path (a `RequestHandler` would widen
  // them to Express 5's `string | string[]`).
  return handler as unknown as ReturnType<typeof express.json>;
}

/**
 * The body of a command (api-design.md §58X), the only reader of a request's body in `src/api/` (the lint rule), the
 * twin of `readQuery`. The route's `jsonBody` has parsed it (no body and `{}` are the empty object; malformed JSON,
 * `null`, whitespace and an oversized body never reach the handler). The schema must be strict throughout
 * (`assertStrictBody`, once per schema; a route with a non-strict schema answers `500` on its first request). `also`
 * checks the raw body beside the schema (a rule zod would skip once a field failed): its errors come after the schema's
 * own, before the unknown fields. The caller answers a refusal with its route's status (`400`; the resolve `422`).
 */
export function readBody<S extends z.ZodType>(schema: S, req: Request, also?: (raw: unknown) => readonly FieldError[]): BodyResult<z.output<S>> {
  if (!strictSchemas.has(schema)) {
    assertStrictBody(schema);
    strictSchemas.add(schema);
  }
  const raw: unknown = req.body;
  if (raw === undefined) throw new Error('readBody: the route parses no JSON body (jsonBody)');
  const parsed = parse(schema, raw);
  const extra = also?.(raw) ?? [];
  if (parsed.success && extra.length === 0) return { ok: true, data: parsed.data };
  return { ok: false, errors: bodyErrors(parsed.success ? undefined : parsed.error, raw, extra) };
}

/**
 * A path parameter as Express matched it. Express 5's types allow a list (a wildcard segment); no route has one, so a
 * parameter is a string or absent, and anything else reads as absent (the route's own `INVALID_FORMAT`). VC-X-66.
 */
export function pathParam(req: Pick<Request, 'params'>, name: string): string | undefined {
  const value: unknown = req.params[name];
  return typeof value === 'string' ? value : undefined;
}

/** The query of a route without parameters (§58W rule 1): every parameter is unknown. */
export const NO_QUERY = z.object({});

/** §11's paging, the one fragment of every paged route (§58W "Pagination consistent across routes"). */
export const PAGING = {
  page: zod3.coercedInteger(1, 1_000_000).default(1),
  pageSize: zod3.coercedInteger(1, 200).default(50),
};

/** The same bounds without defaults: the two day-or-history reads, where `asOf` excludes paging (§26.1, §49.2). */
export const OPTIONAL_PAGING = { page: PAGING.page.unwrap().optional(), pageSize: PAGING.pageSize.unwrap().optional() };

export type QueryResult<T> = { readonly ok: true; readonly data: T } | QueryRefusal;
export interface QueryRefusal {
  readonly ok: false;
  readonly errors: readonly FieldError[];
}

/** The errors of every query `readQuery` refused, by request, for `sendValidationError`. */
const refusedQueries = new WeakMap<Request, readonly FieldError[]>();

/** The parameter names a query schema knows: the keys of its object, under any refinement or transform. */
const knownKeysOf = new WeakMap<z.ZodType, ReadonlySet<string>>();
function knownKeys(schema: z.ZodType): ReadonlySet<string> {
  const cached = knownKeysOf.get(schema);
  if (cached !== undefined) return cached;
  // Zod 4: a refinement is a check of the object itself; a transform is a pipe out of it.
  let inner: z.ZodType = schema;
  while (inner instanceof z.ZodPipe) inner = inner.in as z.ZodType;
  if (!(inner instanceof z.ZodObject)) throw new Error('readQuery: a query schema is an object');
  const keys = new Set(Object.keys(inner.shape));
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
export function readQuery<S extends z.ZodType>(schema: S, req: Request): QueryResult<z.output<S>> {
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
  const parsed = parse(schema, input);
  const own = parsed.success
    ? []
    : zod3
        .asZod3(parsed.error.issues)
        .map((issue) => ({ field: issue.path.length === 0 ? '(query)' : String(issue.path[0]), code: codeOf(issue) }))
        .filter((error) => !repeated.has(error.field));
  if (parsed.success && refused.length === 0) return { ok: true, data: parsed.data };
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
export const money = zod3.transform(z.object({ amount: z.string(), currency: z.string() }).strict(), (value, ctx) => {
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
  zod3.integer().superRefine((value, ctx) => {
    if (value < min || value > max) ctx.addIssue({ code: 'custom', params: { code: 'OUT_OF_RANGE' } });
  });

/** A day of the month, 1–31 (VC-7-02, api-design §58A): in a shorter month it means the month's last day. */
export const dayOfMonth = integerIn(1, 31);

/** Money that may be negative, where the sign is part of the figure (a credit line, an Abrechnungsspitze; api-design.md §50). */
export const signedMoney = zod3.transform(z.object({ amount: z.string(), currency: z.string() }).strict(), (value, ctx) => {
  try {
    return Money.of(value.amount, value.currency);
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
    const path = error.code === 'UNSUPPORTED_CURRENCY' ? ['currency'] : ['amount'];
    ctx.addIssue({ code: 'custom', path, params: { code: MONEY_CODES[error.code] } });
    return z.NEVER;
  }
});
