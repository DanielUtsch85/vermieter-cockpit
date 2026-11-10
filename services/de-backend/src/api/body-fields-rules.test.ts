import { describe, expect, it } from 'vitest';
import { UUID, useCountedApp } from './route-walk.test-support.js';

/**
 * VC-X-69 (api-design.md §58X "Tests the implementation needs" (3)–(7)): each rule exact on the routes it concerns. The
 * name with its dotted path and index, the order (the schema's own errors, then the unknown fields in document order,
 * depth first), the edge cases, the four bodies that dropped a field and the amounts, the five commands without a body
 * and their body variants, the path and the query before the body. No database. Synthetic values only.
 */

const { calls, send } = useCountedApp();
const F = (...fields: string[]) => fields.map((field) => ({ field, code: 'INVALID_FORMAT' }));
const eur = (amount: string) => ({ amount, currency: 'EUR' });
const split = (extra: Record<string, unknown> = {}) => ({ amount: eur('1.00'), financialCategoryCode: 'MAINTENANCE', ...extra });
const SPLITS = `/api/v1/transactions/${UUID}/splits`;
const CORRECT = `/api/v1/transactions/${UUID}/correct`;
const IGNORE = `/api/v1/transactions/${UUID}/ignore`;
const RESOLVE = `/api/v1/imports/${UUID}/review-items/${UUID}/resolve`;
const fieldsOf = async (method: string, url: string, body: unknown) => {
  calls.length = 0;
  const answer = await send(method, url, typeof body === 'string' ? body : JSON.stringify(body));
  expect(calls, url).toHaveLength(0);
  return answer.fields;
};

describe('the name: the dotted path as sent, with the array index (decision 1)', () => {
  it.each<[string, string, string, unknown, string[]]>([
    ['a top-level field', 'POST', '/api/v1/parties', { partyType: 'PERSON', displayName: 'x', zzz: 1 }, ['zzz']],
    ['in the first split', 'PUT', SPLITS, { splits: [split({ zzz: 1 })] }, ['splits.0.zzz']],
    ['two in the second split, in document order', 'PUT', SPLITS, { splits: [split(), split({ zzz: 1, yyy: 2 })] }, ['splits.1.zzz', 'splits.1.yyy']],
    ['in an amount of a split', 'PUT', SPLITS, { splits: [split({ amount: { ...eur('1.00'), zzz: 1 } })] }, ['splits.0.amount.zzz']],
    ['in the replacement', 'POST', CORRECT, { reason: 'x', replacement: { zzz: 1 } }, ['replacement.zzz']],
    ['in a split of the replacement', 'POST', CORRECT, { reason: 'x', replacement: { splits: [split({ zzz: 1 })] } }, ['replacement.splits.0.zzz']],
    ['in the amount of the replacement', 'POST', CORRECT, { reason: 'x', replacement: { amount: { ...eur('1.00'), zzz: 1 } } }, ['replacement.amount.zzz']],
  ])('%s', async (_label, method, url, body, expected) => {
    expect(await fieldsOf(method, url, body)).toEqual(F(...expected));
  });

  it.each<[string, string, unknown, string]>([
    ['an instalment', '/api/v1/weg-memberships/' + UUID + '/special-assessments', { instalments: [{ zzz: 1 }] }, 'instalments.0.zzz'],
    ['a rent due day', '/api/v1/rental-contract-references', { rentDueDays: [{ validFrom: '2027-01-01', day: 1, zzz: 1 }] }, 'rentDueDays.0.zzz'],
    ['the amount of POST /transactions (money)', '/api/v1/transactions', { amount: { ...eur('1.00'), zzz: 1 } }, 'amount.zzz'],
    [
      'a signed amount (signedMoney)',
      `/api/v1/weg-memberships/${UUID}/annual-statements`,
      { settlementPeak: { ...eur('-1.00'), zzz: 1 } },
      'settlementPeak.zzz',
    ],
    ['a positive EUR amount (positiveEur)', '/api/v1/tax-classifications', { netAmount: { ...eur('1.00'), zzz: 1 } }, 'netAmount.zzz'],
    [
      'a progress point of a performance',
      '/api/v1/tax-classifications',
      { performance: { progress: [{ through: '2027-01-01', amount: eur('1.00'), zzz: 1 }] } },
      'performance.progress.0.zzz',
    ],
  ])('in %s, after the schema own errors', async (_label, url, body, expected) => {
    const fields = (await fieldsOf('POST', url, body)) ?? [];
    expect(fields.at(-1)).toEqual({ field: expected, code: 'INVALID_FORMAT' });
    expect(fields.filter((f) => f.field.endsWith('zzz'))).toHaveLength(1);
  });
});

describe('the code and the status (decision 2)', () => {
  it('INVALID_FORMAT with the route status: 400, and 422 on the resolve of a review item', async () => {
    expect(await send('POST', '/api/v1/parties', '{"zzz":1}')).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(await send('POST', RESOLVE, '{"resolution":"SKIP","zzz":1}')).toEqual({ status: 422, code: 'VALIDATION_ERROR', fields: F('zzz') });
    // Its known field keeps its 422 beside the unknown one.
    expect(await send('POST', RESOLVE, '{"resolution":"MAYBE","zzz":1}')).toEqual({
      status: 422,
      code: 'VALIDATION_ERROR',
      fields: [{ field: 'resolution', code: 'INVALID_FORMAT' }, ...F('zzz')],
    });
  });
});

describe('the order: the schema own errors first, then the unknown fields in document order, depth first (decision 7)', () => {
  it('top level: partyType and displayName before zzz and yyy, whatever the order sent', async () => {
    expect(await fieldsOf('POST', '/api/v1/parties', '{"zzz":1,"partyType":"X","yyy":2}')).toEqual([
      { field: 'partyType', code: 'INVALID_FORMAT' },
      { field: 'displayName', code: 'REQUIRED' },
      ...F('zzz', 'yyy'),
    ]);
  });

  it('nested: the known error of a split first, then aaa, the amount key, the split key and bbb as the document holds them', async () => {
    const body = '{"aaa":1,"splits":[{"amount":{"amount":"1.00","currency":"EUR","q":1},"financialCategoryCode":"x","zzz":1}],"bbb":2}';
    expect(await fieldsOf('PUT', SPLITS, body)).toEqual([
      { field: 'splits.0.financialCategoryCode', code: 'INVALID_FORMAT' },
      ...F('aaa', 'splits.0.amount.q', 'splits.0.zzz', 'bbb'),
    ]);
  });

  it('a key that looks like an array index comes first, as the parser iterates it', async () => {
    expect(await fieldsOf('POST', IGNORE, '{"reason":"x","zzz":1,"aaa":2,"1":3}')).toEqual(F('1', 'zzz', 'aaa'));
  });

  it('a refused known field beside an unknown one: the known one with its own code first', async () => {
    expect(await fieldsOf('PUT', SPLITS, { splits: [split({ zzz: 1, direction: 'INFLOW' })] })).toEqual([
      { field: 'splits.0.direction', code: 'NOT_ALLOWED' },
      ...F('splits.0.zzz'),
    ]);
  });
});

describe('edge cases (§58X "Edge cases")', () => {
  it.each<[string, string, string[]]>([
    ['__proto__', '{"reason":"x","__proto__":{"a":1}}', ['__proto__']],
    ['constructor', '{"reason":"x","constructor":1}', ['constructor']],
    ['toString', '{"reason":"x","toString":1}', ['toString']],
    ['hasOwnProperty', '{"reason":"x","hasOwnProperty":1}', ['hasOwnProperty']],
    ['a key differing only in case', '{"Reason":"y","reason":"x"}', ['Reason']],
    ['a key with a dot', '{"reason":"x","a.b":1}', ['a.b']],
    ['the empty key (as the query: field "", decision of 2026-11-10)', '{"reason":"x","":1}', ['']],
    ['an unknown field inside an unknown field, not descended into', '{"reason":"x","zzz":{"a":1,"b":{"c":2}}}', ['zzz']],
    [
      '1,001 unknown fields, each named',
      `{"reason":"x",${Array.from({ length: 1001 }, (_, i) => `"u${i}":1`).join(',')}}`,
      Array.from({ length: 1001 }, (_, i) => `u${i}`),
    ],
  ])('%s is named as sent', async (_label, body, expected) => {
    expect(await fieldsOf('POST', IGNORE, body)).toEqual(F(...expected));
  });

  it('__proto__ inside a split is named with its path', async () => {
    const body = `{"splits":[{"amount":{"amount":"1.00","currency":"EUR"},"financialCategoryCode":"MAINTENANCE","__proto__":{"x":1}}]}`;
    expect(await fieldsOf('PUT', SPLITS, body)).toEqual(F('splits.0.__proto__'));
  });

  it('a field a body knows only to refuse it keeps its code (NOT_SUPPORTED, NOT_ALLOWED), and an unknown one comes after it', async () => {
    const tx = { financialAccountId: UUID, amount: eur('1.00'), direction: 'INFLOW', bookingDate: '2027-01-01' };
    expect(await fieldsOf('POST', '/api/v1/transactions', { ...tx, rentalContractReferenceId: UUID, zzz: 1 })).toEqual([
      { field: 'rentalContractReferenceId', code: 'NOT_SUPPORTED' },
      ...F('zzz'),
    ]);
    expect(await fieldsOf('PUT', SPLITS, { splits: [split({ wegId: UUID })] })).toEqual([{ field: 'splits.0.wegId', code: 'NOT_SUPPORTED' }]);
  });

  it('an unknown field named like a refused split field is not given that field code (direction beside splits, in an amount)', async () => {
    expect(await fieldsOf('PUT', SPLITS, { splits: [split()], direction: 'INFLOW' })).toEqual(F('direction'));
    expect(await fieldsOf('PUT', SPLITS, { splits: [split({ amount: { ...eur('1.00'), direction: 'x', wegId: 'y' } })] })).toEqual(
      F('splits.0.amount.direction', 'splits.0.amount.wegId'),
    );
  });

  it('a key given twice: the last value wins, as JSON parsing reads it (decision 9)', async () => {
    calls.length = 0;
    await send('POST', IGNORE, '{"reason":"first","reason":"last"}');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toMatchObject({ reason: 'last' });
  });

  it('the whole body: [] and a scalar stay (body) INVALID_FORMAT, malformed JSON and null stay not valid JSON', async () => {
    expect(await send('POST', IGNORE, '[]')).toEqual({ status: 400, code: 'VALIDATION_ERROR', fields: F('(body)') });
    expect(await send('POST', IGNORE, '[{"zzz":1}]')).toEqual({ status: 400, code: 'VALIDATION_ERROR', fields: F('(body)') });
    for (const body of ['null', '"x"', '1', '  ', '{"a":'])
      expect(await send('POST', IGNORE, body), body).toEqual({ status: 400, code: 'VALIDATION_ERROR', fields: undefined });
  });
});

describe('the four bodies that dropped an unknown field are strict (§58X (b), test 4)', () => {
  const tx = { financialAccountId: UUID, amount: eur('1.00'), direction: 'INFLOW', bookingDate: '2027-01-01' };
  it.each<[string, string, Record<string, unknown>, string, Record<string, unknown>]>([
    [
      'POST /financial-accounts',
      '/api/v1/financial-accounts',
      { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' },
      'financialAccounts.create',
      { accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null },
    ],
    [
      'POST /property-references/link',
      '/api/v1/property-references/link',
      { mreRealmId: '64b0c0ffee0000000000000a', mrePropertyId: '6512f0c2a1b2c3d4e5f60901' },
      'propertyReferences.link',
      { authorizationHeader: 'Bearer a.b.c', mreRealmId: '64b0c0ffee0000000000000a', mrePropertyId: '6512f0c2a1b2c3d4e5f60901' },
    ],
    [
      'POST /transactions',
      '/api/v1/transactions',
      tx,
      'transactions.createManual',
      { financialAccountId: UUID, direction: 'INFLOW', bookingDate: '2027-01-01' },
    ],
    [
      'the resolve of a review item',
      RESOLVE,
      { resolution: 'SKIP' },
      'imports.resolveReviewItem',
      { importBatchId: UUID, reviewItemId: UUID, resolution: 'SKIP' },
    ],
  ])('%s: known fields plus zzz are refused; without zzz the command gets the known fields only', async (_label, url, body, command, args) => {
    calls.length = 0;
    const refused = await send('POST', url, JSON.stringify({ ...body, zzz: 1 }));
    expect([refused.status, refused.fields, calls.length]).toEqual([url === RESOLVE ? 422 : 400, F('zzz'), 0]);
    await send('POST', url, JSON.stringify(body));
    expect(calls.map((c) => `${c.module}.${c.command}`)).toEqual([command]);
    expect(calls[0]?.args).toMatchObject(args);
    expect(JSON.stringify(calls[0]?.args)).not.toContain('zzz');
  });
});

/** The five commands without a body (§58X (c)), each with valid ids, and their command. */
const BODYLESS: [string, string][] = [
  [`/api/v1/financial-accounts/${UUID}/close`, 'financialAccounts.close'],
  [`/api/v1/property-references/${UUID}/refresh`, 'propertyReferences.refresh'],
  [`/api/v1/transactions/${UUID}/confirm`, 'transactions.confirm'],
  [`/api/v1/transactions/${UUID}/restore`, 'transactions.restore'],
  [`/api/v1/parties/${UUID}/external-references/${UUID}/end`, 'externalReferences.end'],
];

describe('the five commands without a body (§58X rule 3, decision 4)', () => {
  const NOT_JSON = { status: 400, code: 'VALIDATION_ERROR', fields: undefined };
  const variants: [string, string | undefined, string, 'reached' | Record<string, unknown>][] = [
    ['no body', undefined, 'application/json', 'reached'],
    ['an empty body with a JSON content type', '', 'application/json', 'reached'],
    ['{}', '{}', 'application/json', 'reached'],
    ['{"zzz":1}', '{"zzz":1}', 'application/json', { status: 400, code: 'VALIDATION_ERROR', fields: F('zzz') }],
    ['{"zzz":1,"yyy":2}', '{"zzz":1,"yyy":2}', 'application/json', { status: 400, code: 'VALIDATION_ERROR', fields: F('zzz', 'yyy') }],
    ['[]', '[]', 'application/json', { status: 400, code: 'VALIDATION_ERROR', fields: F('(body)') }],
    ['null', 'null', 'application/json', NOT_JSON],
    ['"x"', '"x"', 'application/json', NOT_JSON],
    ['1', '1', 'application/json', NOT_JSON],
    ['whitespace', '   ', 'application/json', NOT_JSON],
    ['malformed JSON', '{"a":', 'application/json', NOT_JSON],
    ['a text body (not read, as on every command)', 'zzz', 'text/plain', 'reached'],
    ['a form body (not read, as on every command)', 'zzz=1', 'application/x-www-form-urlencoded', 'reached'],
  ];

  it.each(BODYLESS)('%s: every variant answers as decided; the allowed ones reach the command with the arguments of no body', async (url, command) => {
    calls.length = 0;
    await send('POST', url);
    const withoutBody = calls[0]?.args;
    expect(calls.map((c) => `${c.module}.${c.command}`)).toEqual([command]);
    for (const [label, body, contentType, expected] of variants) {
      calls.length = 0;
      const answer = await send('POST', url, body, contentType);
      if (expected === 'reached') {
        expect([answer.status, calls.length], label).toEqual([500, 1]);
        expect(calls[0]?.args, label).toEqual(withoutBody);
      } else {
        expect(answer, label).toEqual(expected);
        expect(calls, label).toHaveLength(0);
      }
    }
  });

  it.each(BODYLESS)('%s: over 16 KiB is 413; just under it an unknown field is named (the limit is 16 KiB)', async (url) => {
    const pad = (bytes: number) => `{"zzz":"${'x'.repeat(bytes - '{"zzz":""}'.length)}"}`;
    expect(await send('POST', url, pad(16 * 1024 + 1))).toEqual({ status: 413, code: 'VALIDATION_ERROR', fields: undefined });
    expect(await send('POST', url, pad(16 * 1024))).toEqual({ status: 400, code: 'VALIDATION_ERROR', fields: F('zzz') });
  });
});

describe('the path and the query before the body (rule 4, decisions 3 and 6 of §58W)', () => {
  const FIVE = [
    [`/api/v1/property-references/not-an-id/tax-years/2027/acknowledgements`, ['propertyReferenceId']],
    [`/api/v1/property-references/${UUID}/tax-years/x/acknowledgements/not-an-id/withdraw`, ['acknowledgementId', 'year']],
    [`/api/v1/loans/not-an-id/allocations/${UUID}/tax-confirmations`, ['loanId']],
    [`/api/v1/loans/${UUID}/allocations/not-an-id/tax-confirmations/not-an-id/withdraw`, ['allocationSetId', 'confirmationId']],
    [`/api/v1/depreciation-assets/not-an-id/schedule-versions`, ['assetId']],
  ] as const;

  it.each(FIVE)('%s: a malformed path answers the path alone, never the body (until VC-X-69 both)', async (url, names) => {
    const answer = await send('POST', url, '{"zzz":1}');
    expect([answer.status, answer.fields?.map((f) => f.field)]).toEqual([400, names]);
  });

  it.each(FIVE)('%s with valid ids: the body is read and its unknown field named after its own errors', async (url) => {
    const valid = url.replace(/not-an-id/g, UUID).replace('/tax-years/x/', '/tax-years/2027/');
    const fields = (await fieldsOf('POST', valid, '{"zzz":1}')) ?? [];
    expect(fields.at(-1)).toEqual({ field: 'zzz', code: 'INVALID_FORMAT' });
    expect(fields.slice(0, -1).every((f) => f.code === 'REQUIRED')).toBe(true);
  });

  it('a refused query with an unknown nested body field answers the query alone (VC-X-61 unchanged)', async () => {
    expect(await send('PUT', `${SPLITS}?q=1`, JSON.stringify({ splits: [split({ zzz: 1 })] }))).toEqual({
      status: 400,
      code: 'VALIDATION_ERROR',
      fields: F('q'),
    });
    expect(await send('POST', `/api/v1/transactions/${UUID}/confirm?q=1`, '{"zzz":1}')).toEqual({ status: 400, code: 'VALIDATION_ERROR', fields: F('q') });
  });

  it('a malformed id with a refused query and an unknown field: the path and the query, not the body', async () => {
    expect(await send('POST', '/api/v1/depreciation-assets/not-an-id/schedule-versions?q=1', '{"zzz":1}')).toEqual({
      status: 400,
      code: 'VALIDATION_ERROR',
      fields: [{ field: 'assetId', code: 'INVALID_FORMAT' }, ...F('q')],
    });
  });
});
