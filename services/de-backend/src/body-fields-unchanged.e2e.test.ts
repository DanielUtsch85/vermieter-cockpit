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
    await step('POST /financial-accounts', 'POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }, undefined, 'financialAccountId', 'GIRO');
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
    await step('POST /financial-accounts (cash)', 'POST', '/financial-accounts', { accountType: 'CASH', displayName: 'Bar', currency: 'EUR' }, undefined, 'financialAccountId', 'CASH');
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
    await step(
      'POST /transactions/{id}/correct',
      'POST',
      `/transactions/${ids['T1']}/correct`,
      {
        reason: 'Betrag laut Kontoauszug (synthetisch)',
        replacement: {
          amount: eur('523.47'),
          description: 'Rate Februar, korrigiert',
          splits: [
            { amount: eur('123.46'), financialCategoryCode: 'LOAN_INTEREST', loanId: ids['L1'] },
            { amount: eur('400.01'), financialCategoryCode: 'LOAN_PRINCIPAL', loanId: ids['L1'] },
          ],
        },
      },
    );
    await step('POST /transactions/{id}/correct (empty replacement split)', 'POST', `/transactions/${ids['T1']}/correct`, {
      reason: 'x',
      replacement: { splits: [{ financialCategoryCode: 'LOAN_INTEREST' }] },
    });
    await step('POST /transactions (second)', 'POST', '/transactions', { ...transaction, amount: eur('10.00'), direction: 'INFLOW' }, undefined, 'transactionId', 'T2');
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
      const columnMapping = { bookingDate: 'Buchungstag', valueDate: 'Wertstellung', amount: 'Betrag', counterpartyName: 'Empfaenger', description: 'Verwendungszweck' };
      form.append('metadata', JSON.stringify({ financialAccountId: ids['GIRO'], adapterId: 'generic-csv', adapterVersion: '1', columnMapping }));
      form.append('file', new Blob([file]), 'umsatz.csv');
      return (await (await fetch(`${ctx.base}/api/v1/imports/bank-transactions`, { method: 'POST', headers: headers(REALM_A), body: form })).json()) as {
        importBatchId: string;
      };
    };
    await multipart([header, ...rows].join('\r\n'));
    const batch = await multipart([header, rows[1], rows[0]].join('\r\n'));
    names.set(batch.importBatchId.toLowerCase(), 'BATCH');
    const items = (await (await call(REALM_A, 'GET', `/imports/${batch.importBatchId}/review-items`)).json()) as { items: { reviewItemId: string }[] };
    items.items.forEach((item, i) => names.set(item.reviewItemId.toLowerCase(), `ITEM-${i + 1}`));
    const resolve = (i: number) => `/imports/${batch.importBatchId}/review-items/${items.items[i]?.reviewItemId}/resolve`;
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
});
