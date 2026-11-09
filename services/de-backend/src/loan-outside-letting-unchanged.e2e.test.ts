import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { stageAudit } from './infrastructure/postgres/audit-stage.test-support.js';
import { databaseUrl, REALM_A, usePhase2App } from './phase-2-acceptance.test-support.js';

/**
 * VC-X-43 (api-design.md §58V "Effect on existing sets"): every figure, flag, fingerprint and response body of the sets
 * that exist before 0077 is the same after it, but the new `null` fields. A fixture of every existing kind (a single
 * entry without a schedule, three MANUAL entries with an odd cent and a day before the first set, a period over a set
 * change, a multi-entry PURCHASE_PRICE set, a VOID set, a set recorded after the year end so a part change carries its
 * fingerprint, an idempotent create) is built through the HTTP API and read: the tax-year views of 2027 and 2028 at both
 * levels, §41.6's two per-property reads, the sets, `GET /property-references/{id}/loans`, the JSON export, the
 * Kassenbuch CSV, the stored idempotency fingerprint and every table's row count and money sums.
 *
 * `before-0077.json` was recorded by this file on main 9284f29 (the code and schema before 0077) with
 * `VC_X43_RECORD_BEFORE=1`; here the same fixture is read after 0077 and must equal it once the keys `outsideLetting`,
 * `useEvidence` and `outsideLettingShare` are removed where they are `null` (and they must be there). Ids are replaced
 * by names, timestamps and `computedOn` by markers, fingerprints (which hash the run's random ids) by first occurrence.
 * Synthetic data only.
 */
const golden = join(dirname(fileURLToPath(import.meta.url)), 'loan-outside-letting-golden', 'before-0077.json');
const RECORD = process.env['VC_X43_RECORD_BEFORE'] === '1';
const NEW_KEYS = new Set(['outsideLetting', 'useEvidence', 'outsideLettingShare']);

const P1 = '0000a043-0000-4000-8000-000000000001';
const P2 = '0000a043-0000-4000-8000-000000000002';
const P3 = '0000a043-0000-4000-8000-000000000003';
const O1 = '0000b043-0000-4000-8000-000000000001';
const O2 = '0000b043-0000-4000-8000-000000000002';
const O3 = '0000b043-0000-4000-8000-000000000003';
const BANK = '0000b043-0000-4000-8000-000000000009';
const ACQ1 = '0000c043-0000-4000-8000-000000000001';
const ACQ2 = '0000c043-0000-4000-8000-000000000002';

/** The response with every id named and every instant marked (structure-stable across runs). */
function normalize(value: unknown, names: ReadonlyMap<string, string>): unknown {
  const others = new Map<string, string>();
  const text = (s: string) =>
    s
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => {
        const lower = id.toLowerCase();
        const named = names.get(lower);
        if (named !== undefined) return named;
        if (!others.has(lower)) others.set(lower, `id-${others.size + 1}`);
        return others.get(lower) as string;
      })
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})/g, '<instant>')
      // §58E/§58G fingerprints hash the (random) ids of the run: named by first occurrence, as the ids. Their inputs
      // (P, year, audit record, kind, items with states and parts) are all compared here, and the hash function is untouched.
      .replace(/^[0-9a-f]{64}$/, (hash) => {
        if (!others.has(hash)) others.set(hash, `fingerprint-${others.size + 1}`);
        return others.get(hash) as string;
      });
  const walk = (v: unknown, key?: string): unknown => {
    if (key === 'computedOn' || key === 'exportedOn' || key === 'today') return '<today>';
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value);
}

/**
 * §58C follow-up (Entscheidung des Projektinhabers, 2026-11-09, after this record): every item flag of a tax-year view
 * carries `level`. The record is kept as recorded before 0077; here `level` is removed from the item flags of a view
 * (every `flags` array but the year's at the body's root) and counted, each `OPEN` or `INFORMATIVE`.
 */
function withoutItemFlagLevels(body: unknown, seen: { count: number }): unknown {
  const walk = (v: unknown, root: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x, false));
    if (v === null || typeof v !== 'object') return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        if (k !== 'flags' || root || !Array.isArray(x)) return [k, walk(x, false)];
        return [
          k,
          x.map((flag: Record<string, unknown>) => {
            const { level, ...rest } = flag;
            expect(['OPEN', 'INFORMATIVE']).toContain(level);
            seen.count += 1;
            return rest;
          }),
        ];
      }),
    );
  };
  return walk(body, true);
}

/** Removes the new keys where they are `null`; counts them, so the test can show they were answered. */
function withoutNewNulls(value: unknown, seen: { count: number }): unknown {
  if (Array.isArray(value)) return value.map((x) => withoutNewNulls(x, seen));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([k, x]) => {
        if (NEW_KEYS.has(k) && x === null) {
          seen.count += 1;
          return [];
        }
        return [[k, withoutNewNulls(x, seen)]];
      }),
    );
  }
  return value;
}

describe.skipIf(databaseUrl === undefined)('existing allocation sets unchanged by 0077 (VC-X-43, §58V)', () => {
  const { ctx, call, json, eur } = usePhase2App('loan_outside_unchanged_e2e');
  let pool: pg.Pool;
  const names = new Map<string, string>();
  const name = (id: string, as: string) => {
    names.set(id.toLowerCase(), as);
    return id;
  };
  const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
  const created = async (path: string, body: unknown, key: string, extra?: Record<string, string>) =>
    (await json<Record<string, string>>(await A('POST', path, body, extra), 201))[key] as string;

  beforeAll(async () => {
    ({ pool } = ctx);
    for (const [id, n] of [
      [P1, 'P1'],
      [P2, 'P2'],
      [P3, 'P3'],
      [O1, 'O1'],
      [O2, 'O2'],
      [O3, 'O3'],
      [BANK, 'BANK'],
      [ACQ1, 'ACQ1'],
      [ACQ2, 'ACQ2'],
    ] as const)
      name(id, n);
    for (const [i, id] of [P1, P2, P3].entries()) {
      await pool.query(
        `INSERT INTO property_reference (id, mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, $3, 'ACTIVE', 'x')`,
        [id, REALM_A, `6512f0c2a1b2c3d4e5f6a04${i + 1}`],
      );
    }
    for (const [id, display, type] of [
      [O1, 'Eigentümerin Eins', 'PERSON'],
      [O2, 'Eigentümer Zwei', 'PERSON'],
      [O3, 'Eigentümerin Drei', 'PERSON'],
      [BANK, 'Bank Beispiel', 'ORGANIZATION'],
    ] as const) {
      await pool.query(`INSERT INTO party (id, mre_realm_id, party_type, display_name, status, created_by) VALUES ($1, $2, $3, $4, 'ACTIVE', 'x')`, [
        id,
        REALM_A,
        type,
        display,
      ]);
    }
    for (const [pr, owner, share] of [
      [P1, O1, '1/2'],
      [P1, O2, '1/2'],
      [P2, O3, '1/1'],
      [P3, O3, '1/1'],
    ] as const) {
      name(
        await created('/ownerships', { propertyReferenceId: pr, ownerPartyId: owner, share, validFrom: '2026-01-01' }, 'ownershipId'),
        `OWN-${pr.slice(-1)}-${owner.slice(-1)}`,
      );
    }
    // Acquisitions transferred long ago (no anschaffungsnahe window in 2027/2028), prices 300,000.00 and 200,000.01.
    for (const [id, pr, price] of [
      [ACQ1, P1, '300000.00'],
      [ACQ2, P2, '200000.01'],
    ] as const) {
      await pool.query(
        `INSERT INTO acquisition (id, mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, economic_transfer_date, created_by)
         VALUES ($1, $2, $3, 'DRAFT', $4, 'EUR', 1, 1, '2020-01-01', '2020-01-01', 'x')`,
        [id, REALM_A, pr, price],
      );
    }
    const loan = async (n: string, principal: string) =>
      name(
        await created('/loans', { lenderPartyId: BANK, borrowerPartyIds: [O1, O3], principalOriginal: eur(principal), startDate: '2027-01-01' }, 'loanId'),
        n,
      );
    const terms = async (loanId: string) =>
      name(
        await created(
          `/loans/${loanId}/terms`,
          { validFrom: '2027-01-01', interestRate: '3.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-01-31' },
          'termsId',
        ),
        `TERMS-${names.get(loanId)}`,
      );
    const set = async (loanId: string, n: string, body: unknown, extra?: Record<string, string>) =>
      name(await created(`/loans/${loanId}/allocations`, body, 'allocationSetId', extra), n);
    const L1 = await loan('L1', '100000.00');
    const L2 = await loan('L2', '180000.00');
    const L3 = await loan('L3', '90000.00');
    const L4 = await loan('L4', '50000.00');
    await terms(L2);
    await terms(L3);
    await terms(L4);
    // L1: one entry, no schedule (§58L rule 8). L2: three MANUAL entries from February, then halves from 2027-04-16.
    await set(L1, 'S1', { validFrom: '2027-01-01', allocations: [{ propertyReferenceId: P3, share: '1/1' }] });
    const thirds = [P1, P2, P3].map((propertyReferenceId) => ({ propertyReferenceId, share: '1/3' }));
    await set(L2, 'S2A', { validFrom: '2027-02-01', basis: 'MANUAL', allocations: thirds }, { 'idempotency-key': 'vc-x-43-unchanged-1' });
    const halves = await set(L2, 'S2B', {
      validFrom: '2027-04-16',
      allocations: [
        { propertyReferenceId: P1, share: '1/2' },
        { propertyReferenceId: P2, share: '1/2' },
      ],
    });
    // L3: a multi-entry PURCHASE_PRICE set. L4: its only set VOID.
    await set(L3, 'S3', {
      validFrom: '2027-01-01',
      basis: 'PURCHASE_PRICE',
      allocations: [
        { propertyReferenceId: P1, acquisitionId: ACQ1 },
        { propertyReferenceId: P2, acquisitionId: ACQ2 },
      ],
    });
    const voided = await set(L4, 'S4', { validFrom: '2027-01-01', allocations: [{ propertyReferenceId: P1, share: '1/1' }] });
    await json(await A('POST', `/loans/${L4}/allocations/${voided}/void`, { reason: 'falsches Objekt (synthetisch)' }), 200);
    // S2B recorded after the year end: a part change of 2027 with its fingerprint (§58G).
    await stageAudit(pool, `UPDATE audit_record SET occurred_at = '2028-02-10T10:00:00Z' WHERE entity_id = $1 AND action = 'CREATED'`, [halves]);

    const giro = name(await created('/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }, 'financialAccountId'), 'GIRO');
    let t = 0;
    const debit = async (bookingDate: string, splits: readonly [string, string, string][]) => {
      const amount = splits.reduce((s, [a]) => s + Number(a.replace('.', '')), 0);
      const id = name(
        await created(
          '/transactions',
          { financialAccountId: giro, amount: eur((amount / 100).toFixed(2)), direction: 'OUTFLOW', bookingDate },
          'transactionId',
        ),
        `T${++t}`,
      );
      const res = await json<{ splits: { splitId: string }[] }>(
        await A('PUT', `/transactions/${id}/splits`, {
          splits: splits.map(([a, financialCategoryCode, loanId]) => ({ amount: eur(a), financialCategoryCode, loanId })),
        }),
        200,
      );
      res.splits.forEach((s, i) => name(s.splitId, `T${t}-S${i + 1}`));
      await json(await A('POST', `/transactions/${id}/confirm`), 200);
    };
    await debit('2027-01-29', [['451.20', 'LOAN_INTEREST', L2]]);
    await debit('2027-02-26', [['123.45', 'LOAN_INTEREST', L1]]);
    await debit('2027-03-31', [
      ['100.00', 'LOAN_INTEREST', L2],
      ['400.00', 'LOAN_PRINCIPAL', L2],
    ]);
    await debit('2027-04-30', [['300.00', 'LOAN_INTEREST', L2]]);
    await debit('2027-05-31', [['77.77', 'LOAN_INTEREST', L3]]);
    await debit('2027-06-30', [['50.00', 'LOAN_INTEREST', L4]]);
    await debit('2028-01-31', [['449.99', 'LOAN_INTEREST', L2]]);
  });

  it('the views of 2027 and 2028 at both levels, Financing, the sets, the export, the CSV, the fingerprints and the money sums equal the record before 0077', async () => {
    const read = async (path: string) => {
      const res = await A('GET', path);
      const type = res.headers.get('content-type') ?? '';
      return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
    };
    const reads: Record<string, unknown> = {};
    for (const [pr, owners] of [
      [P1, [O1, O2]],
      [P2, [O3]],
      [P3, [O3]],
    ] as const) {
      for (const year of [2027, 2028]) {
        reads[`view ${names.get(pr)} ${year}`] = await read(`/property-references/${pr}/tax-years/${year}`);
        for (const o of owners)
          reads[`view ${names.get(pr)} ${year} ${names.get(o)}`] = await read(`/property-references/${pr}/tax-years/${year}?ownerPartyId=${o}`);
      }
      reads[`loans of ${names.get(pr)}`] = await read(`/property-references/${pr}/loans`);
      // The export lists the Loans by their (random) ids: sorted by name here, the order of ids is no figure.
      const exported = await read(`/property-references/${pr}/export.json`);
      const byName = (l: { loan: { loanId: string } }) => names.get(l.loan.loanId) ?? '';
      (exported.body as { loans: { loan: { loanId: string } }[] }).loans.sort((x, y) => (byName(x) < byName(y) ? -1 : 1));
      reads[`export ${names.get(pr)}`] = exported;
    }
    for (const n of ['L1', 'L2', 'L3', 'L4']) {
      const id = [...names].find(([, v]) => v === n)?.[0] as string;
      reads[`sets ${n}`] = await read(`/loans/${id}/allocations`);
      for (const asOf of ['2027-03-31', '2027-12-31']) reads[`debt ${n} ${asOf}`] = await read(`/loans/${id}/remaining-debt?asOf=${asOf}&perProperty=true`);
      for (const year of [2027, 2028]) reads[`payments ${n} ${year}`] = await read(`/loans/${id}/payments?year=${year}&perProperty=true`);
    }
    reads['csv'] = await read('/exports/transactions.csv?rows=splits');
    reads['idempotency'] = (await pool.query(`SELECT scope, key, request_fingerprint FROM idempotency_key WHERE scope = 'loan.allocation.create'`)).rows;
    // Every table's row count and the sum of each of its numeric columns.
    const columns = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND data_type IN ('numeric', 'integer', 'bigint') AND table_name NOT LIKE 'kysely%' ORDER BY table_name, column_name`,
    );
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'kysely%' ORDER BY table_name`,
    );
    const sums: Record<string, string> = {};
    for (const { table_name } of tables.rows as { table_name: string }[]) {
      sums[`${table_name}.count`] = (await pool.query(`SELECT count(*)::text AS n FROM "${table_name}"`)).rows[0].n as string;
    }
    for (const { table_name, column_name } of columns.rows as { table_name: string; column_name: string }[]) {
      sums[`${table_name}.${column_name}`] = (await pool.query(`SELECT coalesce(sum("${column_name}"), 0)::text AS s FROM "${table_name}"`)).rows[0]
        .s as string;
    }
    reads['sums'] = sums;
    const now = normalize(reads, names);

    if (RECORD) {
      writeFileSync(golden, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    const seen = { count: 0 };
    const levels = { count: 0 };
    const after = Object.fromEntries(
      Object.entries(withoutNewNulls(now, seen) as Record<string, { status: number; body: unknown }>).map(([key, r]) => [
        key,
        key.startsWith('view ') ? { ...r, body: withoutItemFlagLevels(r.body, levels) } : r,
      ]),
    );
    const before = JSON.parse(readFileSync(golden, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(after as object)).toEqual(Object.keys(before));
    for (const key of Object.keys(before)) expect((after as Record<string, unknown>)[key], key).toEqual(before[key]);
    // The new fields are answered (as null) on the sets, the items, the segments, Financing and the export.
    expect(seen.count).toBeGreaterThan(50);
    // The item flags of the views carry their level (the price key's flag on the Loan items among them).
    expect(levels.count).toBeGreaterThan(0);
    // The record itself proves its case: the odd cent, the part change's fingerprint, the price key's flag, the VOID set.
    const text = JSON.stringify(before);
    for (const needle of ['"amount":"33.34"', 'PROPERTY_PART_CHANGED', 'changeFingerprint', 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', '"status":"VOID"'])
      expect(text, needle).toContain(needle);
  });
});
