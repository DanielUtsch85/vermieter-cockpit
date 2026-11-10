import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl, REALM_A, REALM_B, usePhase2App } from './phase-2-acceptance.test-support.js';

/**
 * VC-X-61 (api-design.md §58W "Unchanged guarantees"): a request that sends only supported parameters answers as before,
 * byte for byte, and a refused query reads nothing, writes nothing and calls no MRE, in either Realm.
 *
 * `before-vc-x-61.json` was recorded by this file on main f84b443 (the query handling before VC-X-61) with
 * `VC_X61_RECORD_BEFORE=1`: a fixture (two properties, owners, ownerships, an account, Transactions with splits, a Loan
 * with terms, allocations and payments, a WEG with a membership) is built through the HTTP API, and a sample of reads,
 * with every supported parameter at a valid value and with refusals of known parameters, is answered. Here the same
 * fixture is read again and the raw bodies must equal the record once ids are replaced by names and instants by a
 * marker. Synthetic data only.
 */
const golden = join(dirname(fileURLToPath(import.meta.url)), 'query-parameters-golden', 'before-vc-x-61.json');
const RECORD = process.env['VC_X61_RECORD_BEFORE'] === '1';

const P1 = '0000a061-0000-4000-8000-000000000001';
const P2 = '0000a061-0000-4000-8000-000000000002';
const O1 = '0000b061-0000-4000-8000-000000000001';
const O2 = '0000b061-0000-4000-8000-000000000002';
const BANK = '0000b061-0000-4000-8000-000000000009';
const ACQ1 = '0000c061-0000-4000-8000-000000000001';
const UNKNOWN_ID = '0000d061-0000-4000-8000-000000000001';

/** The raw body with every id named and every instant marked (byte-stable across runs). */
function normalize(text: string, names: ReadonlyMap<string, string>): string {
  const others = new Map<string, string>();
  return (
    text
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => {
        const lower = id.toLowerCase();
        const named = names.get(lower);
        if (named !== undefined) return named;
        if (!others.has(lower)) others.set(lower, `id-${others.size + 1}`);
        return others.get(lower) as string;
      })
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})/g, '<instant>')
      .replace(/"computedOn":"\d{4}-\d{2}-\d{2}"/g, '"computedOn":"<today>"')
      .replace(/kassenbuch-\d{4}-\d{2}-\d{2}/g, 'kassenbuch-<today>')
      // The property export's file name carries today's date too (found by VC-X-69's full run on the day after the record).
      .replace(/(objekt-[A-Za-z0-9-]+?-)\d{4}-\d{2}-\d{2}\.json/g, '$1<today>.json')
  );
}

describe.skipIf(databaseUrl === undefined)('valid queries answer as before VC-X-61, refused ones read nothing (§58W)', () => {
  const { ctx, call, json, eur } = usePhase2App('query_parameters_unchanged_e2e');
  let pool: pg.Pool;
  const names = new Map<string, string>();
  const name = (id: string, as: string) => {
    names.set(id.toLowerCase(), as);
    return id;
  };
  const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
  const created = async (path: string, body: unknown, key: string) => (await json<Record<string, string>>(await A('POST', path, body), 201))[key] as string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ({ pool } = ctx);
    for (const [id, n] of [
      [P1, 'P1'],
      [P2, 'P2'],
      [O1, 'O1'],
      [O2, 'O2'],
      [BANK, 'BANK'],
      [ACQ1, 'ACQ1'],
    ] as const)
      name(id, n);
    for (const [i, id] of [P1, P2].entries()) {
      await pool.query(
        `INSERT INTO property_reference (id, mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, $3, 'ACTIVE', 'x')`,
        [id, REALM_A, `6512f0c2a1b2c3d4e5f6a06${i + 1}`],
      );
    }
    for (const [id, display, type] of [
      [O1, 'Eigentümerin Eins', 'PERSON'],
      [O2, 'Eigentümer Zwei', 'PERSON'],
      [BANK, 'Bank Beispiel', 'ORGANIZATION'],
    ] as const) {
      await pool.query(`INSERT INTO party (id, mre_realm_id, party_type, display_name, status, created_by) VALUES ($1, $2, $3, $4, 'ACTIVE', 'x')`, [
        id,
        REALM_A,
        type,
        display,
      ]);
    }
    await pool.query(
      `INSERT INTO acquisition (id, mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, economic_transfer_date, created_by)
       VALUES ($1, $2, $3, 'DRAFT', '250000.00', 'EUR', 1, 1, '2020-01-01', '2020-01-01', 'x')`,
      [ACQ1, REALM_A, P1],
    );
    for (const [pr, owner, share] of [
      // One owner per property: a list orders by id, and the run's ids are random.
      [P1, O1, '1/1'],
      [P2, O2, '1/1'],
    ] as const) {
      name(
        await created('/ownerships', { propertyReferenceId: pr, ownerPartyId: owner, share, validFrom: '2026-01-01' }, 'ownershipId'),
        `OWN-${pr.slice(-1)}-${owner.slice(-1)}`,
      );
    }
    ids['loan'] = name(
      await created('/loans', { lenderPartyId: BANK, borrowerPartyIds: [O1, O2], principalOriginal: eur('100000.00'), startDate: '2027-01-01' }, 'loanId'),
      'L1',
    );
    name(
      await created(
        `/loans/${ids['loan']}/terms`,
        { validFrom: '2027-01-01', interestRate: '3.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-01-31' },
        'termsId',
      ),
      'TERMS',
    );
    name(
      await created(
        `/loans/${ids['loan']}/allocations`,
        {
          validFrom: '2027-01-01',
          allocations: [
            { propertyReferenceId: P1, share: '1/2' },
            { propertyReferenceId: P2, share: '1/2' },
          ],
        },
        'allocationSetId',
      ),
      'SET',
    );
    ids['giro'] = name(await created('/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }, 'financialAccountId'), 'GIRO');
    name(await created('/financial-accounts', { accountType: 'CASH', displayName: 'Bar', currency: 'EUR' }, 'financialAccountId'), 'CASH');
    let t = 0;
    const booked = async (
      direction: 'INFLOW' | 'OUTFLOW',
      bookingDate: string,
      splits: readonly Record<string, unknown>[] | null,
      propertyReferenceId?: string,
    ) => {
      const amount = (splits ?? [{ amount: eur('10.00') }]).reduce((s, x) => s + Number((x['amount'] as { amount: string }).amount.replace('.', '')), 0);
      const id = name(
        await created(
          '/transactions',
          {
            financialAccountId: ids['giro'],
            amount: eur((amount / 100).toFixed(2)),
            direction,
            bookingDate,
            ...(propertyReferenceId === undefined ? {} : { propertyReferenceId }),
          },
          'transactionId',
        ),
        `T${++t}`,
      );
      if (splits === null) return;
      const res = await json<{ splits: { splitId: string }[] }>(await A('PUT', `/transactions/${id}/splits`, { splits }), 200);
      res.splits.forEach((s, i) => name(s.splitId, `T${t}-S${i + 1}`));
      await json(await A('POST', `/transactions/${id}/confirm`), 200);
    };
    await booked('OUTFLOW', '2027-01-29', [{ amount: eur('250.00'), financialCategoryCode: 'LOAN_INTEREST', loanId: ids['loan'] }]);
    await booked('OUTFLOW', '2027-02-26', [
      { amount: eur('123.45'), financialCategoryCode: 'LOAN_INTEREST', loanId: ids['loan'] },
      { amount: eur('400.01'), financialCategoryCode: 'LOAN_PRINCIPAL', loanId: ids['loan'] },
    ]);
    await booked('OUTFLOW', '2027-03-15', [{ amount: eur('89.90'), financialCategoryCode: 'MAINTENANCE', propertyReferenceId: P1 }]);
    await booked('INFLOW', '2027-04-01', null, P1);
    const weg = name(await created('/wegs', { displayName: 'WEG Beispielstraße', administratorPartyId: BANK }, 'wegId'), 'WEG');
    name(
      await created(`/wegs/${weg}/memberships`, { propertyReferenceId: P1, miteigentumsanteil: '250/10000', validFrom: '2026-01-01' }, 'membershipId'),
      'MEM',
    );
  });

  /** A sample of reads of every kind with parameters: lists with filters and paging, single reads, the export. */
  const reads = () => {
    const L = ids['loan'] as string;
    const G = ids['giro'] as string;
    const W = [...names].find(([, v]) => v === 'WEG')?.[0] as string;
    const M = [...names].find(([, v]) => v === 'MEM')?.[0] as string;
    return [
      '/transactions',
      `/transactions?status=CONFIRMED,UNREVIEWED&provenance=MANUAL&financialAccountId=${G}&bookingDateFrom=2027-01-01&bookingDateTo=2027-12-31&page=1&pageSize=2`,
      '/transactions?page=2&pageSize=2',
      `/transactions?reviewable=true&current=true&propertyReferenceId=${P1}`,
      '/transactions?financialCategoryCode=LOAN_INTEREST',
      `/property-references/${P1}/transactions?status=CONFIRMED&pageSize=1`,
      '/financial-accounts?status=OPEN&accountType=BANK,CASH&page=1&pageSize=10',
      // A single match: the order of display names depends on the database collation (C locally, en_US in CI).
      '/parties?partyType=PERSON&status=ACTIVE&name=Zwei&page=1&pageSize=1',
      '/parties?name=Bank',
      '/property-references?externalReferenceState=ACTIVE&pageSize=1',
      `/property-references/${P1}/ownerships?asOf=2027-06-30`,
      `/property-references/${P1}/ownerships?page=1&pageSize=5`,
      `/acquisitions?propertyReferenceId=${P1}&status=DRAFT`,
      `/property-references/${P1}/acquisitions?status=DRAFT`,
      `/loans?status=ACTIVE&partyId=${BANK}&page=1&pageSize=5`,
      `/loans/${L}/terms?status=VALID`,
      `/loans/${L}/allocations?status=VALID`,
      `/loans/${L}/allocations?asOf=2027-06-30`,
      `/loans/${L}/schedule?from=2027-01-01&to=2027-06-30`,
      `/loans/${L}/remaining-debt?asOf=2027-06-30&perProperty=true`,
      `/loans/${L}/payments?year=2027&perProperty=true`,
      `/loans/${L}/balance-statements?status=VALID`,
      `/property-references/${P1}/loans?asOf=2027-06-30`,
      `/wegs?status=ACTIVE&administratorPartyId=${BANK}&page=1&pageSize=5`,
      `/wegs/${W}/memberships?status=ACTIVE&propertyReferenceId=${P1}`,
      `/property-references/${P1}/weg-memberships?asOf=2027-06-30`,
      `/weg-memberships/${M}/economic-plans?status=ACTIVE&financialYear=2027`,
      `/weg-memberships/${M}/annual-statements?financialYear=2027`,
      '/security-deposits?status=ACTIVE&page=1',
      '/rent-reconciliations?pageSize=5',
      '/financial-categories',
      '/tax-rules',
      '/exports/transactions.csv?rows=splits&dialect=excel-de',
      `/exports/transactions.csv?status=CONFIRMED&financialAccountId=${G}`,
      `/property-references/${P1}/export.json`,
      // Refusals of known parameters keep their answers (a list value without an index is §58W rule 7's change, not here).
      '/transactions?page=0',
      '/transactions?pageSize=201',
      '/transactions?bookingDateFrom=2027-02-01&bookingDateTo=2027-01-01',
      '/transactions?status=NOPE',
      `/loans/${L}/payments`,
      `/loans/${L}/allocations?asOf=2027-06-30&status=VALID`,
      `/property-references/${P1}/ownerships?asOf=2027-06-30&page=1`,
      `/loans/${L}/schedule?from=2027-06-30&to=2027-01-01`,
      `/parties?externalId=6512f0c2a1b2c3d4e5f6a061`,
    ];
  };

  it('every sampled read answers byte for byte as recorded before VC-X-61', { timeout: 60_000 }, async () => {
    const answers: Record<string, { status: number; contentType: string | null; disposition: string | null; text: string }> = {};
    for (const path of reads()) {
      const res = await A('GET', path);
      answers[normalize(path, names)] = {
        status: res.status,
        contentType: res.headers.get('content-type'),
        disposition: res.headers.get('content-disposition') === null ? null : normalize(res.headers.get('content-disposition') as string, names),
        text: normalize(await res.text(), names),
      };
    }
    if (RECORD) {
      writeFileSync(golden, `${JSON.stringify(answers, null, 2)}\n`);
      return;
    }
    const before = JSON.parse(readFileSync(golden, 'utf8')) as typeof answers;
    expect(Object.keys(answers)).toEqual(Object.keys(before));
    for (const [path, answer] of Object.entries(answers)) expect(answer, path).toEqual(before[path]);
    // Counter-check: the record holds the money of the fixture (the comparison is not of empty answers).
    expect(before['/transactions']?.text).toContain('"amount":"523.46"');
    expect(Object.values(before).filter((a) => a.status === 200).length).toBeGreaterThan(30);
  });

  /** Every table's row count and the sum of each of its numeric columns (`audit_record` and `idempotency_key` included). */
  const sums = async () => {
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'kysely%' ORDER BY table_name`,
    );
    const columns = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND data_type IN ('numeric', 'integer', 'bigint') AND table_name NOT LIKE 'kysely%' ORDER BY table_name, column_name`,
    );
    const out: Record<string, string> = {};
    for (const { table_name } of tables.rows as { table_name: string }[])
      out[`${table_name}.count`] = (await pool.query(`SELECT count(*)::text AS n FROM "${table_name}"`)).rows[0].n as string;
    for (const { table_name, column_name } of columns.rows as { table_name: string; column_name: string }[])
      out[`${table_name}.${column_name}`] = (await pool.query(`SELECT coalesce(sum("${column_name}"), 0)::text AS s FROM "${table_name}"`)).rows[0].s as string;
    return out;
  };
  /** The fake MRE's data calls (the access check's `/realms` calls aside). */
  const mreDataCalls = () => ctx.mre.requests.filter((r) => !r.path.startsWith('/api/v2/realms')).length;

  it('an unknown parameter reads nothing, writes nothing, calls no MRE, and answers the same in a Realm the data is not in', { timeout: 60_000 }, async () => {
    const L = ids['loan'] as string;
    const G = ids['giro'] as string;
    const T = [...names].find(([, v]) => v === 'T1')?.[0] as string;
    const refused: [string, string, unknown?][] = [
      ['GET', '/health'],
      ['GET', '/transactions'],
      ['GET', `/transactions/${T}`],
      ['GET', `/financial-accounts/${G}`],
      ['GET', '/parties'],
      ['GET', `/parties/${O1}`],
      ['GET', `/property-references/${P1}/ownerships`],
      ['GET', `/acquisitions/${ACQ1}`],
      ['GET', `/loans/${L}/payments?year=2027`],
      ['GET', '/wegs'],
      ['GET', '/security-deposits'],
      ['GET', `/rent-reconciliations/${UNKNOWN_ID}?checkMre=true`],
      ['GET', `/property-references/${P1}/export.json`],
      ['GET', '/exports/transactions.csv'],
      ['GET', '/financial-categories'],
      ['GET', '/tax-rules'],
      ['POST', '/transactions', { financialAccountId: G, amount: eur('1.00'), direction: 'INFLOW', bookingDate: '2027-05-01' }],
      ['POST', `/transactions/${T}/ignore`, { reason: 'synthetisch' }],
      ['POST', '/parties', { partyType: 'PERSON', displayName: 'Neue Person' }],
      ['POST', `/loans/${L}/terms`, { validFrom: '2027-06-01', interestRate: '4.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-06-30' }],
      ['POST', '/wegs', { displayName: 'WEG Zwei' }],
      ['POST', `/property-references/${P1}/refresh`],
      ['POST', `/financial-accounts/${G}/close`],
    ];
    const before = await sums();
    const mreBefore = mreDataCalls();
    for (const [method, path, body] of refused) {
      const url = `${path}${path.includes('?') ? '&' : '?'}zzz=1`;
      const answers = [];
      for (const realm of [REALM_A, REALM_B]) {
        const res = await call(realm, method, url, body);
        answers.push({ status: res.status, text: await res.text() });
      }
      expect(answers[0], `${method} ${path}`).toEqual({
        status: 400,
        text: JSON.stringify({
          error: { code: 'VALIDATION_ERROR', message: 'Validation failed.', details: { fields: [{ field: 'zzz', code: 'INVALID_FORMAT' }] } },
        }),
      });
      // Realm B owns none of these rows: the same answer, before any read, so nothing tells it they exist.
      expect(answers[1], `${method} ${path} (Realm B)`).toEqual(answers[0]);
    }
    expect(await sums()).toEqual(before);
    expect(mreDataCalls()).toBe(mreBefore);
    // Counter-checks: without the parameter the refresh calls MRE, the read of another Realm's row is 404, a command writes.
    await call(REALM_A, 'POST', `/property-references/${P1}/refresh`);
    expect(mreDataCalls()).toBeGreaterThan(mreBefore);
    expect((await call(REALM_B, 'GET', `/transactions/${T}`)).status).toBe(404);
    await json(await A('POST', '/parties', { partyType: 'PERSON', displayName: 'Neue Person' }), 201);
    expect((await sums())['party.count']).not.toBe(before['party.count']);
  });
});
