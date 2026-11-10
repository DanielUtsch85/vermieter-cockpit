import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appForInventory, listRoutes } from './route-inventory.js';
import { fill, key, malformed, paramsOf, countedApp, valueOf } from './route-walk.test-support.js';

/**
 * VC-X-69 (api-design.md §58X "Tests the implementation needs" (1), (2), (6)): every JSON command of the inventory, with
 * every command rejecting and counted, names an unknown body field by itself before any command runs, with its route's
 * status; every body schema is strict throughout (`readBody` checks it at the first request, so a non-strict one answers
 * 500 here); a malformed path id is answered before the body. No database. Synthetic values only.
 */

/** The bank import (multipart; its adapter owns its options, §58X decision 5), exempted by a literal of one path. */
const EXEMPT = ['/api/v1/imports/bank-transactions'];
/** The route whose body errors are `422` (§32.2, §58X decision 2). */
const RESOLVE = '/api/v1/imports/:importBatchId/review-items/:reviewItemId/resolve';
/** The five commands that take no body (§58X (c), rule 3). */
const BODYLESS = [
  'POST /api/v1/financial-accounts/:financialAccountId/close',
  'POST /api/v1/parties/:partyId/external-references/:externalReferenceId/end',
  'POST /api/v1/property-references/:propertyReferenceId/refresh',
  'POST /api/v1/transactions/:transactionId/confirm',
  'POST /api/v1/transactions/:transactionId/restore',
];

const { calls, send, start, stop } = countedApp();
beforeAll(start);
afterAll(stop);
const routes = listRoutes(appForInventory());
const commands = routes.filter((r) => r.method === 'POST' || r.method === 'PUT');
const json = commands.filter((r) => !EXEMPT.includes(r.path));
const statusOf = (path: string) => (path === RESOLVE ? 422 : 400);
const url = (path: string) => fill(path, valueOf);
const UNKNOWN = [
  { field: 'zzz', code: 'INVALID_FORMAT' },
  { field: 'yyy', code: 'INVALID_FORMAT' },
];

describe('every JSON command names an unknown body field by itself (§58X rules 1, 2, 6)', () => {
  it('the inventory has 92 POST and PUT routes; only the bank import is exempted, by a literal of one path', () => {
    expect(commands).toHaveLength(92);
    expect(commands.filter((r) => EXEMPT.includes(r.path)).map(key)).toEqual(['POST /api/v1/imports/bank-transactions']);
    expect(json).toHaveLength(91);
    for (const name of BODYLESS) expect(json.map(key)).toContain(name);
  });

  it('{"zzz":1,"yyy":2} with valid path ids ends with exactly zzz and yyy, INVALID_FORMAT, the route status, no command', async () => {
    const wrong: string[] = [];
    for (const r of json) {
      calls.length = 0;
      const answer = await send(r.method, url(r.path), '{"zzz":1,"yyy":2}');
      const fields = answer.fields ?? [];
      const ok =
        answer.status === statusOf(r.path) &&
        answer.code === 'VALIDATION_ERROR' &&
        JSON.stringify(fields.slice(-2)) === JSON.stringify(UNKNOWN) &&
        // Before them only the schema's own errors (an empty amend is `(body)` REQUIRED), never an unknown field at `(body)`.
        fields.slice(0, -2).every((f) => !(f.field === '(body)' && f.code === 'INVALID_FORMAT') && f.field !== 'zzz' && f.field !== 'yyy') &&
        calls.length === 0;
      if (!ok) wrong.push(`${key(r)}: ${answer.status} ${JSON.stringify(fields)} calls=${calls.length}`);
    }
    expect(wrong).toEqual([]);
  });

  it('the five commands without a body answer exactly zzz and yyy; the resolve answers 422', async () => {
    for (const name of BODYLESS) {
      const path = name.slice('POST '.length);
      expect(await send('POST', url(path), '{"zzz":1,"yyy":2}'), name).toEqual({ status: 400, code: 'VALIDATION_ERROR', fields: UNKNOWN });
    }
    expect(await send('POST', url(RESOLVE), '{"resolution":"SKIP","zzz":1}')).toEqual({
      status: 422,
      code: 'VALIDATION_ERROR',
      fields: [{ field: 'zzz', code: 'INVALID_FORMAT' }],
    });
  });

  it('counter-check: with {} no route names zzz, and exactly the 15 commands without a required field reach their command', async () => {
    const reached: string[] = [];
    for (const r of json) {
      calls.length = 0;
      const answer = await send(r.method, url(r.path), '{}');
      expect(JSON.stringify(answer.fields ?? []), key(r)).not.toContain('zzz');
      if (answer.status === 500 && calls.length === 1) reached.push(key(r));
    }
    expect(reached).toHaveLength(15);
    for (const name of BODYLESS) expect(reached).toContain(name);
  });

  it('counter-check: the exemption is real: the bank import refuses a JSON body as it did, without reading a field', async () => {
    calls.length = 0;
    const answer = await send('POST', '/api/v1/imports/bank-transactions', '{"zzz":1}');
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer.fields ?? [])).not.toContain('zzz');
    expect(calls).toHaveLength(0);
  });
});

describe('the body is read after the path (§58X rule 4, Entscheidung des Projektinhabers, 2026-11-10, question 3)', () => {
  it('every JSON command with a checked path parameter: a malformed id and an unknown field answer the path only', async () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const r of json) {
      const names = paramsOf(r.path).filter((name) => malformed(name) !== undefined);
      if (names.length === 0) continue;
      checked += 1;
      calls.length = 0;
      const answer = await send(
        r.method,
        fill(r.path, (name) => malformed(name) ?? valueOf(name)),
        '{"zzz":1}',
      );
      const fields = answer.fields ?? [];
      const ok = answer.status === 400 && fields.length > 0 && fields.every((f) => names.includes(f.field)) && calls.length === 0;
      if (!ok) wrong.push(`${key(r)}: ${answer.status} ${JSON.stringify(fields)}`);
    }
    expect(wrong).toEqual([]);
    // §58X (f): 76 of the 92 have a checked path id; the bank import has none.
    expect(checked).toBe(76);
  });
});
