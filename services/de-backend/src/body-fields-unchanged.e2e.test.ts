import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl, PROPERTY, REALM_A, REALM_B, TENANT, usePhase2App } from './phase-2-acceptance.test-support.js';

/**
 * VC-X-69 (api-design.md §58X "Unchanged guarantees", "Tests the implementation needs" (8)): a command that sends only
 * known fields answers as before, byte for byte, and a refused body reads nothing, writes nothing and calls no MRE, in
 * either Realm.
 *
 * `before-vc-x-69.json` was recorded by this file on main ff680ba (the body handling before VC-X-69) with
 * `VC_X69_RECORD_BEFORE=1`: a fixture is built through the HTTP API, and every command of the sample (the four bodies
 * that were not strict, `PUT …/splits`, `correct` with a replacement and its splits, the resolve of a review item, the five
 * commands that answered path and body together, the five commands without a body, and refusals of known fields) is
 * answered. Here the same commands run again and the raw answers must equal the record once ids are replaced by names and
 * instants by a marker. No sample reads a list ordered by name (the collation differs between CI and local databases).
 * Synthetic data only.
 */
const golden = join(dirname(fileURLToPath(import.meta.url)), 'body-fields-golden', 'before-vc-x-69.json');
const RECORD = process.env['VC_X69_RECORD_BEFORE'] === '1';

const UNKNOWN_ID = '0000d069-0000-4000-8000-000000000001';
const FINGERPRINT = 'a'.repeat(64);

/** The raw text with every id named and every instant marked (byte-stable across runs). */
function normalize(text: string, names: ReadonlyMap<string, string>): string {
  const others = new Map<string, string>();
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (id) => {
      const lower = id.toLowerCase();
      const named = names.get(lower);
      if (named !== undefined) return named;
      if (!others.has(lower)) others.set(lower, `id-${others.size + 1}`);
      return others.get(lower) as string;
    })
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})/g, '<instant>');
}

type Recorded = { status: number; contentType: string | null; location: string | null; etag: string | null; text: string };

describe.skipIf(databaseUrl === undefined)('known bodies answer as before VC-X-69, refused ones read nothing (§58X)', () => {
  const { ctx, call, eur, headers } = usePhase2App('body_fields_unchanged_e2e', { taxStatements: true });
  let pool: pg.Pool;
  const names = new Map<string, string>();
  const ids: Record<string, string> = {};
  const answers: Record<string, Recorded> = {};

  /** Sends a command in Realm A, records its answer under `label` and names the id at `key` of a JSON answer as `as`. */
  const step = async (label: string, method: string, path: string, body?: unknown, extra?: Record<string, string>, key?: string, as?: string) => {
    const res = await call(REALM_A, method, path, body, extra);
    const text = await res.text();
    if (key !== undefined && as !== undefined && res.status < 300) {
      const id = (JSON.parse(text) as Record<string, string>)[key] as string;
      names.set(id.toLowerCase(), as);
      ids[as] = id;
    }
    answers[label] = {
      status: res.status,
      contentType: res.headers.get('content-type'),
      location: res.headers.get('location') === null ? null : normalize(res.headers.get('location') as string, names),
      // Express's weak tag hashes the raw body (random ids): its length is kept, the hash is not.
      etag: res.headers.get('etag')?.replace(/^W\/"([0-9a-f]+)-[^"]*"$/, 'W/"$1-<hash>"') ?? null,
      text: normalize(text, names),
    };
    return text;
  };

  beforeAll(async () => {
    ({ pool } = ctx);
    await step('POST /parties (person)', 'POST', '/parties', { partyType: 'PERSON', displayName: 'Eigentümerin Eins' }, undefined, 'partyId', 'O1');
    await step('POST /parties (organization)', 'POST', '/parties', { partyType: 'ORGANIZATION', displayName: 'Bank Beispiel' }, undefined, 'partyId', 'BANK');
    await step('POST /parties (unknown type)', 'POST', '/parties', { partyType: 'X', displayName: 'Niemand' });
    await step(
      'POST /property-references/link',
      'POST',
      '/property-references/link',
      { mreRealmId: REALM_A, mrePropertyId: PROPERTY },
      undefined,
      'propertyReferenceId',
      'P1',
    );
    await step('POST /property-references/link (malformed id)', 'POST', '/property-references/link', { mreRealmId: REALM_A, mrePropertyId: 'x' });
    await step('POST …/refresh (no body)', 'POST', `/property-references/${ids['P1']}/refresh`);
    await step('POST …/refresh ({})', 'POST', `/property-references/${ids['P1']}/refresh`, {});
    await step(
      'POST /parties/{id}/external-references',
      'POST',
      `/parties/${ids['O1']}/external-references`,
      { system: 'MRE', entityType: 'tenant', mreRealmId: REALM_A, externalId: TENANT },
      undefined,
      'externalReferenceId',
      'EXT',
    );
    await step('POST …/external-references/{id}/end (no body)', 'POST', `/parties/${ids['O1']}/external-references/${ids['EXT']}/end`);
    await step(
      'POST /financial-accounts',
      'POST',
      '/financial-accounts',
      { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' },
      undefined,
      'financialAccountId',
      'GIRO',
    );
    await step(
      'POST /financial-accounts (with iban)',
      'POST',
      '/financial-accounts',
      { accountType: 'BANK', displayName: 'Tagesgeld', currency: 'EUR', iban: 'DE89 3704 0044 0532 0130 00' },
      undefined,
      'financialAccountId',
      'TAGESGELD',
    );
    await step('POST /financial-accounts (missing fields)', 'POST', '/financial-accounts', {});
    await step(
      'POST /financial-accounts (cash)',
      'POST',
      '/financial-accounts',
      { accountType: 'CASH', displayName: 'Bar', currency: 'EUR' },
      undefined,
      'financialAccountId',
      'CASH',
    );
    await step('POST /financial-accounts/{id}/close ({})', 'POST', `/financial-accounts/${ids['CASH']}/close`, {});
    await step(
      'POST /ownerships',
      'POST',
      '/ownerships',
      { propertyReferenceId: ids['P1'], ownerPartyId: ids['O1'], share: '1/1', validFrom: '2026-01-01' },
      undefined,
      'ownershipId',
      'OWN',
    );
    await step(
      'POST /loans',
      'POST',
      '/loans',
      { lenderPartyId: ids['BANK'], borrowerPartyIds: [ids['O1']], principalOriginal: eur('100000.00'), startDate: '2027-01-01' },
      undefined,
      'loanId',
      'L1',
    );
    await step(
      'POST /loans/{id}/terms',
      'POST',
      `/loans/${ids['L1']}/terms`,
      { validFrom: '2027-01-01', interestRate: '3.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-01-31' },
      undefined,
      'termsId',
      'TERMS',
    );
    await step(
      'POST /loans/{id}/allocations',
      'POST',
      `/loans/${ids['L1']}/allocations`,
      { validFrom: '2027-01-01', allocations: [{ propertyReferenceId: ids['P1'], share: '1/1' }] },
      undefined,
      'allocationSetId',
      'SET',
    );
    const transaction = { financialAccountId: ids['GIRO'], amount: eur('523.46'), direction: 'OUTFLOW', bookingDate: '2027-02-26' };
    await step('POST /transactions', 'POST', '/transactions', { ...transaction, description: 'Rate Februar' }, undefined, 'transactionId', 'T1');
    await step('POST /transactions (scale exceeded)', 'POST', '/transactions', { ...transaction, amount: eur('1.234') });
    await step('POST /transactions (no fields)', 'POST', '/transactions', {});
    await step('POST /transactions (rentalContractReferenceId)', 'POST', '/transactions', { ...transaction, rentalContractReferenceId: UNKNOWN_ID });
    const splits = [
      { amount: eur('123.45'), financialCategoryCode: 'LOAN_INTEREST', loanId: ids['L1'] },
      { amount: eur('400.01'), financialCategoryCode: 'LOAN_PRINCIPAL', loanId: ids['L1'], description: 'Tilgung' },
    ];
    const splitText = await step('PUT /transactions/{id}/splits', 'PUT', `/transactions/${ids['T1']}/splits`, { splits });
    (JSON.parse(splitText) as { splits: { splitId: string }[] }).splits.forEach((s, i) => names.set(s.splitId.toLowerCase(), `T1-S${i + 1}`));
    await step('PUT /transactions/{id}/splits (direction)', 'PUT', `/transactions/${ids['T1']}/splits`, {
      splits: [{ ...splits[0], direction: 'INFLOW' }, splits[1]],
    });
    await step('POST /transactions/{id}/confirm (no body)', 'POST', `/transactions/${ids['T1']}/confirm`);
    await step('POST /transactions/{id}/correct', 'POST', `/transactions/${ids['T1']}/correct`, {
      reason: 'Betrag laut Kontoauszug (synthetisch)',
      replacement: {
        amount: eur('523.47'),
        description: 'Rate Februar, korrigiert',
        splits: [
          { amount: eur('123.46'), financialCategoryCode: 'LOAN_INTEREST', loanId: ids['L1'] },
          { amount: eur('400.01'), financialCategoryCode: 'LOAN_PRINCIPAL', loanId: ids['L1'] },
        ],
      },
    });
    await step('POST /transactions/{id}/correct (empty replacement split)', 'POST', `/transactions/${ids['T1']}/correct`, {
      reason: 'x',
      replacement: { splits: [{ financialCategoryCode: 'LOAN_INTEREST' }] },
    });
    await step(
      'POST /transactions (second)',
      'POST',
      '/transactions',
      { ...transaction, amount: eur('10.00'), direction: 'INFLOW' },
      undefined,
      'transactionId',
      'T2',
    );
    await step('POST /transactions/{id}/ignore', 'POST', `/transactions/${ids['T2']}/ignore`, { reason: 'Doppelt erfasst (synthetisch)' });
    await step('POST /transactions/{id}/restore ({})', 'POST', `/transactions/${ids['T2']}/restore`, {});
    await step('POST /wegs', 'POST', '/wegs', { displayName: 'WEG Beispielstraße', administratorPartyId: ids['BANK'] }, undefined, 'wegId', 'WEG');
    await step(
      'POST /wegs/{id}/memberships',
      'POST',
      `/wegs/${ids['WEG']}/memberships`,
      { propertyReferenceId: ids['P1'], miteigentumsanteil: '250/10000', validFrom: '2026-01-01' },
      undefined,
      'membershipId',
      'MEM',
    );
    // §58E and §60: the five commands that answered path and body together, each with a valid path and body.
    const ack = `/property-references/${ids['P1']}/tax-years/2027/acknowledgements`;
    await step('POST …/acknowledgements', 'POST', ack, { auditRecordId: UNKNOWN_ID, expectedFingerprint: FINGERPRINT, reason: 'Gesehen (synthetisch)' });
    await step('POST …/acknowledgements (missing fields)', 'POST', ack, {});
    await step('POST …/acknowledgements/{id}/withdraw', 'POST', `${ack}/${UNKNOWN_ID}/withdraw`, { reason: 'Zurück (synthetisch)' });
    const confirmations = `/loans/${ids['L1']}/allocations/${ids['SET']}/tax-confirmations`;
    await step('POST …/tax-confirmations', 'POST', confirmations, { reason: 'Bestätigt (synthetisch)', advisorPartyId: null });
    await step('POST …/tax-confirmations/{id}/withdraw', 'POST', `${confirmations}/${UNKNOWN_ID}/withdraw`, { reason: 'Zurück (synthetisch)' });
    await step('POST /depreciation-assets/{id}/schedule-versions', 'POST', `/depreciation-assets/${UNKNOWN_ID}/schedule-versions`, {
      // A year before today's, so the answer does not move with the date.
      throughYear: 2025,
      reason: 'AfA 2025 (synthetisch)',
      expectedInputFingerprint: FINGERPRINT,
    });
    // The resolve of a review item: a reordered file goes to review (§32.2).
    const header = 'Buchungstag;Wertstellung;Betrag;Empfaenger;Verwendungszweck';
    const rows = ['01.09.2026;01.09.2026;1.250,00;Max Mieter;Miete September', '02.09.2026;02.09.2026;-310,40;WEG Musterstr.;Hausgeld'];
    const multipart = async (file: string) => {
      const form = new FormData();
      const columnMapping = {
        bookingDate: 'Buchungstag',
        valueDate: 'Wertstellung',
        amount: 'Betrag',
        counterpartyName: 'Empfaenger',
        description: 'Verwendungszweck',
      };
      form.append('metadata', JSON.stringify({ financialAccountId: ids['GIRO'], adapterId: 'generic-csv', adapterVersion: '1', columnMapping }));
      form.append('file', new Blob([file]), 'umsatz.csv');
      return (await (await fetch(`${ctx.base}/api/v1/imports/bank-transactions`, { method: 'POST', headers: headers(REALM_A), body: form })).json()) as {
        importBatchId: string;
      };
    };
    await multipart([header, ...rows].join('\r\n'));
    const batch = await multipart([header, rows[1], rows[0]].join('\r\n'));
    names.set(batch.importBatchId.toLowerCase(), 'BATCH');
    ids['BATCH'] = batch.importBatchId;
    const items = (await (await call(REALM_A, 'GET', `/imports/${batch.importBatchId}/review-items`)).json()) as { items: { reviewItemId: string }[] };
    items.items.forEach((item, i) => names.set(item.reviewItemId.toLowerCase(), `ITEM-${i + 1}`));
    const resolve = (i: number) => `/imports/${batch.importBatchId}/review-items/${items.items[i]?.reviewItemId}/resolve`;
    ids['RESOLVE'] = resolve(0);
    await step('POST …/review-items/{id}/resolve (SKIP)', 'POST', resolve(0), { resolution: 'SKIP' });
    await step('POST …/review-items/{id}/resolve (CREATE)', 'POST', resolve(1), { resolution: 'CREATE' });
    await step('POST …/review-items/{id}/resolve (unknown value)', 'POST', resolve(1), { resolution: 'MAYBE' });
    await step('POST …/review-items/{id}/resolve (no fields)', 'POST', resolve(1), {});
  }, 120_000);

  it('every sampled command answers byte for byte as recorded before VC-X-69', () => {
    if (RECORD) {
      writeFileSync(golden, `${JSON.stringify(answers, null, 2)}\n`);
      return;
    }
    const before = JSON.parse(readFileSync(golden, 'utf8')) as typeof answers;
    expect(Object.keys(answers)).toEqual(Object.keys(before));
    for (const [label, answer] of Object.entries(answers)) expect(answer, label).toEqual(before[label]);
    // Counter-checks: the record holds written money and the bodyless commands' successes (not a comparison of refusals).
    expect(before['PUT /transactions/{id}/splits']?.text).toContain('"amount":"400.01"');
    expect(before['POST /transactions/{id}/confirm (no body)']?.status).toBe(200);
    expect(before['POST …/external-references/{id}/end (no body)']?.status).toBe(200);
    expect(Object.values(before).filter((a) => a.status < 300).length).toBeGreaterThan(20);
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
  /** The AuditRecords as stored, in id order (the history itself, not only its count). */
  const history = async () => (await pool.query(`SELECT to_jsonb(a)::text AS row FROM audit_record a ORDER BY id`)).rows.map((r: { row: string }) => r.row);
  /** The fake MRE's data calls (the access check's `/realms` calls aside). */
  const mreDataCalls = () => ctx.mre.requests.filter((r) => !r.path.startsWith('/api/v2/realms')).length;

  it.skipIf(RECORD)(
    'an unknown body field reads nothing, writes nothing, calls no MRE, and answers the same in a Realm the data is not in',
    { timeout: 60_000 },
    async () => {
      const eurZ = { amount: '1.00', currency: 'EUR', zzz: 1 };
      const split = { amount: eur('1.00'), financialCategoryCode: 'MAINTENANCE' };
      const refused: [string, string, unknown, string][] = [
        ['POST', '/parties', { partyType: 'PERSON', displayName: 'Neue Person', zzz: 1 }, 'zzz'],
        ['POST', `/parties/${ids['O1']}/amend`, { displayName: 'Anders', zzz: 1 }, 'zzz'],
        ['POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Neu', currency: 'EUR', zzz: 1 }, 'zzz'],
        ['POST', `/financial-accounts/${ids['GIRO']}/close`, { zzz: 1 }, 'zzz'],
        ['POST', '/property-references/link', { mreRealmId: REALM_A, mrePropertyId: PROPERTY, zzz: 1 }, 'zzz'],
        ['POST', `/property-references/${ids['P1']}/refresh`, { zzz: 1 }, 'zzz'],
        ['POST', `/parties/${ids['O1']}/external-references`, { system: 'MRE', entityType: 'tenant', mreRealmId: REALM_A, externalId: TENANT, zzz: 1 }, 'zzz'],
        ['POST', `/parties/${ids['O1']}/external-references/${ids['EXT']}/end`, { zzz: 1 }, 'zzz'],
        ['POST', '/ownerships', { propertyReferenceId: ids['P1'], ownerPartyId: ids['BANK'], share: '1/2', validFrom: '2027-01-01', zzz: 1 }, 'zzz'],
        [
          'POST',
          `/loans/${ids['L1']}/terms`,
          { validFrom: '2027-06-01', interestRate: '4.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-06-30', zzz: 1 },
          'zzz',
        ],
        [
          'POST',
          `/loans/${ids['L1']}/allocations`,
          { validFrom: '2027-06-01', allocations: [{ propertyReferenceId: ids['P1'], share: '1/1', zzz: 1 }] },
          'allocations.0.zzz',
        ],
        ['POST', '/transactions', { financialAccountId: ids['GIRO'], amount: eurZ, direction: 'INFLOW', bookingDate: '2027-05-01' }, 'amount.zzz'],
        ['PUT', `/transactions/${ids['T2']}/splits`, { splits: [{ ...split, zzz: 1 }] }, 'splits.0.zzz'],
        ['PUT', `/transactions/${ids['T2']}/splits`, { splits: [{ ...split, amount: eurZ }] }, 'splits.0.amount.zzz'],
        ['POST', `/transactions/${ids['T1']}/correct`, { reason: 'x', replacement: { description: 'y', zzz: 1 } }, 'replacement.zzz'],
        ['POST', `/transactions/${ids['T2']}/confirm`, { zzz: 1 }, 'zzz'],
        ['POST', `/transactions/${ids['T2']}/ignore`, { reason: 'x', zzz: 1 }, 'zzz'],
        ['POST', '/wegs', { displayName: 'WEG Zwei', zzz: 1 }, 'zzz'],
        ['POST', `/wegs/${ids['WEG']}/memberships`, { propertyReferenceId: ids['P1'], miteigentumsanteil: '1/10', validFrom: '2027-01-01', zzz: 1 }, 'zzz'],
        ['POST', ids['RESOLVE'] as string, { resolution: 'CREATE', zzz: 1 }, 'zzz'],
        [
          'POST',
          `/property-references/${ids['P1']}/tax-years/2027/acknowledgements`,
          { auditRecordId: UNKNOWN_ID, expectedFingerprint: FINGERPRINT, reason: 'x', zzz: 1 },
          'zzz',
        ],
        ['POST', `/loans/${ids['L1']}/allocations/${ids['SET']}/tax-confirmations`, { reason: 'x', zzz: 1 }, 'zzz'],
        [
          'POST',
          `/depreciation-assets/${UNKNOWN_ID}/schedule-versions`,
          { throughYear: 2025, reason: 'x', expectedInputFingerprint: FINGERPRINT, zzz: 1 },
          'zzz',
        ],
        ['POST', '/acquisitions', { zzz: 1 }, 'zzz'],
        ['POST', '/tax-classifications', { zzz: 1 }, 'zzz'],
      ];
      const before = await sums();
      const audit = await history();
      const mreBefore = mreDataCalls();
      for (const [method, path, body, unknown] of refused) {
        const answers = [];
        for (const realm of [REALM_A, REALM_B]) {
          const res = await call(realm, method, path, body);
          answers.push({ status: res.status, text: await res.text() });
        }
        const fields =
          (JSON.parse(answers[0]?.text ?? '{}') as { error?: { details?: { fields?: { field: string; code: string }[] } } }).error?.details?.fields ?? [];
        expect([answers[0]?.status, fields.at(-1)], `${method} ${path}`).toEqual([
          path.endsWith('/resolve') ? 422 : 400,
          { field: unknown, code: 'INVALID_FORMAT' },
        ]);
        // Realm B owns none of these rows: the same answer, before any read, so nothing tells it they exist.
        expect(answers[1], `${method} ${path} (Realm B)`).toEqual(answers[0]);
      }
      expect(await sums()).toEqual(before);
      expect(await history()).toEqual(audit);
      expect(mreDataCalls()).toBe(mreBefore);
      // Counter-checks: without the field the refresh calls MRE, the read of another Realm's row is 404, a command writes history.
      await call(REALM_A, 'POST', `/property-references/${ids['P1']}/refresh`, {});
      expect(mreDataCalls()).toBeGreaterThan(mreBefore);
      expect((await call(REALM_B, 'GET', `/transactions/${ids['T1']}`)).status).toBe(404);
      expect((await call(REALM_A, 'POST', '/parties', { partyType: 'PERSON', displayName: 'Neue Person' })).status).toBe(201);
      expect((await sums())['party.count']).not.toBe(before['party.count']);
      expect((await history()).length).toBeGreaterThan(audit.length);
    },
  );
});
