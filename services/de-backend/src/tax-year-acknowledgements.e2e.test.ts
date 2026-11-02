import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './api/index.js';
import { commandsWith } from './api/app.test-support.js';
import {
  acknowledgeAttributionChange,
  confirmAllocationSet,
  confirmTransaction,
  createFinancialAccount,
  createLoan,
  createLoanAllocation,
  createLoanTerms,
  createManualTransaction,
  createParty,
  createReconciliation,
  createRentalContractReference,
  getTaxYearView,
  listAcknowledgements,
  listConfirmations,
  releaseReconciliation,
  setTransactionSplits,
  voidLoanTerms,
  withdrawAcknowledgement,
  withdrawConfirmation,
} from './application/index.js';
import { sha256Fingerprinter } from './infrastructure/hashing/index.js';
import {
  PostgresFinancialAccountRepository,
  PostgresLoanAllocationRepository,
  PostgresLoanRepository,
  PostgresLoanTermsRepository,
  PostgresPartyRepository,
  PostgresRentReconciliationRepository,
  PostgresRentalContractReferenceRepository,
  PostgresTaxClassificationRepository,
  PostgresTaxStatementRepository,
  PostgresTransactionRepository,
  PostgresTransactionSplitRepository,
  createDatabase,
  migrateToLatest,
} from './infrastructure/postgres/index.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { HttpMreClient } from './integrations/mre/index.js';
import { signJwt, startFakeMre, type FakeMre } from './integrations/mre/fake-mre.test-support.js';
import { cents, codes, type Json as View } from './phase-8-acceptance.test-support.js';
import { mrePrincipalVerifier, mreRentTermLookup, mreTenantLookup } from './wiring.js';

/**
 * VC-X-28 end to end (api-design.md §58E "Tests the implementation must have"), wired as in main.ts, synthetic values
 * only. Every AuditRecord time that matters is set explicitly (the settable clock of the history), so nothing asserted
 * depends on today's date. A rent matched after the year's end, then released; a Loan's terms voided and appended; a
 * `PURCHASE_PRICE` set confirmed, withdrawn and followed by a later set; Realm isolation and no cash mutated.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];
const REALM_A = '64b0c0ffee0000000000e28a';
const REALM_B = '64b0c0ffee0000000000e28b';
const T1 = '6512f0c2a1b2c3d4e5f6e281';

type Entry = { kind: string; auditRecordId: string; items: unknown[]; changeFingerprint: string; acknowledgement: unknown };

describe.skipIf(databaseUrl === undefined)('acknowledgements in the tax-year view (VC-X-28) end to end', () => {
  const schema = testSchemaName('tax_year_acknowledgements_e2e');
  let pool: pg.Pool;
  let mre: FakeMre;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const member = [{ name: 'Anna', email: 'anna@example.com', role: 'administrator' as const, registered: true }];
    mre = await startFakeMre([
      { _id: REALM_A, name: 'A', members: member, applications: [], tenants: [{ _id: T1, name: 'Mieterin Eins' }], rents: { [T1]: [2028010100] } },
      { _id: REALM_B, name: 'B', members: member, applications: [], tenants: [] },
    ]);
    const client = new HttpMreClient({ apiBaseUrl: mre.apiBaseUrl, timeoutMs: 2000 });
    const db = createDatabase(pool);
    const transactions = new PostgresTransactionRepository(db);
    const reconciliations = new PostgresRentReconciliationRepository(db);
    const terms = new PostgresLoanTermsRepository(db);
    const statements = new PostgresTaxStatementRepository(db);
    const app = createApp({
      isReady: async () => true,
      verifyPrincipal: mrePrincipalVerifier(client),
      ...commandsWith({
        parties: { create: createParty({ repository: new PostgresPartyRepository(db) }) },
        financialAccounts: { create: createFinancialAccount({ repository: new PostgresFinancialAccountRepository(db) }) },
        transactions: {
          createManual: createManualTransaction({ repository: transactions }),
          setSplits: setTransactionSplits({ repository: new PostgresTransactionSplitRepository(db) }),
          confirm: confirmTransaction({ repository: transactions }),
        },
        rentalContractReferences: {
          create: createRentalContractReference({ repository: new PostgresRentalContractReferenceRepository(db), lookupMreTenant: mreTenantLookup(client) }),
        },
        rentReconciliations: {
          create: createReconciliation({ repository: reconciliations, lookupMreRentTerm: mreRentTermLookup(client) }),
          release: releaseReconciliation({ repository: reconciliations }),
        },
        loans: { create: createLoan({ repository: new PostgresLoanRepository(db) }) },
        loanTerms: { create: createLoanTerms({ repository: terms }), void: voidLoanTerms({ repository: terms }) },
        loanAllocations: { create: createLoanAllocation({ repository: new PostgresLoanAllocationRepository(db) }) },
        taxation: { taxYear: getTaxYearView({ repository: new PostgresTaxClassificationRepository(db), fingerprinter: sha256Fingerprinter }) },
        taxStatements: {
          acknowledge: acknowledgeAttributionChange({ repository: statements, fingerprinter: sha256Fingerprinter }),
          listAcknowledgements: listAcknowledgements({ repository: statements }),
          withdrawAcknowledgement: withdrawAcknowledgement({ repository: statements }),
          confirm: confirmAllocationSet({ repository: statements }),
          listConfirmations: listConfirmations({ repository: statements }),
          withdrawConfirmation: withdrawConfirmation({ repository: statements }),
        },
      }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await mre.close();
    await pool.end();
  });

  const token = signJwt({ account: { email: 'anna@example.com' } }, undefined, 600);
  const call = (realm: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, organizationid: realm, 'content-type': 'application/json', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
  const json = async <T>(res: Response, status: number): Promise<T> => {
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as T;
  };
  const eur = (amount: string) => ({ amount, currency: 'EUR' });
  let counter = 0;
  let giro = '';
  const at = (id: string, iso: string) => pool.query(`UPDATE audit_record SET occurred_at = $2 WHERE id = $1`, [id, iso]);
  const recordOf = async (entityId: string, action: string) =>
    (await pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2`, [entityId, action])).rows[0].id as string;

  async function property(realm = REALM_A) {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f8e000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function booked(direction: 'INFLOW' | 'OUTFLOW', bookingDate: string, splits: Record<string, unknown>[]) {
    if (giro === '')
      giro = (
        await json<{ financialAccountId: string }>(await A('POST', '/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }), 201)
      ).financialAccountId;
    const total = splits.reduce((s: bigint, x) => s + (cents(x['amount'] as { amount: string; currency: string }) ?? 0n), 0n);
    const amount = eur(`${total / 100n}.${String(total % 100n).padStart(2, '0')}`);
    const { transactionId } = await json<{ transactionId: string }>(
      await A('POST', '/transactions', { financialAccountId: giro, amount, direction, bookingDate }),
      201,
    );
    const set = await json<{ splits: { splitId: string }[] }>(await A('PUT', `/transactions/${transactionId}/splits`, { splits }), 200);
    await json(await A('POST', `/transactions/${transactionId}/confirm`), 200);
    return { transactionId, splitId: set.splits[0]?.splitId as string };
  }
  const party = async (displayName: string, partyType = 'PERSON') =>
    (await json<{ partyId: string }>(await A('POST', '/parties', { partyType, displayName }), 201)).partyId;
  async function loan(startDate: string) {
    const lender = await party('Bank Beispiel (synthetisch)', 'ORGANIZATION');
    const borrower = await party('Anna Darlehen (synthetisch)');
    return (
      await json<{ loanId: string }>(
        await A('POST', '/loans', { lenderPartyId: lender, borrowerPartyIds: [borrower], principalOriginal: eur('100000.00'), startDate }),
        201,
      )
    ).loanId;
  }
  /** A cash line of either section by its `taxCategory`; an empty line when the view has none. */
  const lineOf = (v: View, category: string): View =>
    [...v.einnahmen.lines, ...v.werbungskosten.lines].find((l: View) => l.taxCategory === category) ?? { items: [], total: eur('0.00') };
  const view = async (pr: string, year: number) => json<View>(await A('GET', `/property-references/${pr}/tax-years/${year}`), 200);
  const changes = (v: View) => (v.flags.find((f: View) => f.code === 'ATTRIBUTION_INPUT_CHANGED')?.details ?? []) as Entry[];
  const level = (v: View, code: string) => [v.review.open.some((o: View) => o.code === code), v.review.info.some((o: View) => o.code === code)];
  const ackPath = (pr: string, year: number) => `/property-references/${pr}/tax-years/${year}/acknowledgements`;
  const acknowledge = (
    pr: string,
    year: number,
    entry: Pick<Entry, 'auditRecordId' | 'changeFingerprint'>,
    reason = 'Erklärung noch nicht abgegeben (synthetisch)',
  ) => A('POST', ackPath(pr, year), { auditRecordId: entry.auditRecordId, expectedFingerprint: entry.changeFingerprint, reason });

  it('a rent matched after the year end, then released: each change flags the years it moved, acknowledged per year and change', async () => {
    const pr = await property();
    const reference = await json<{ rentalContractReferenceId: string }>(
      await A('POST', '/rental-contract-references', { mreTenantId: T1, rentDueDays: [{ validFrom: '2026-01-01', day: 3 }] }),
      201,
    );
    await at(await recordOf(reference.rentalContractReferenceId, 'CREATED'), '2026-06-01T10:00:00Z');
    const rent = await booked('INFLOW', '2027-12-29', [{ amount: eur('800.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: pr }]);
    const before = await view(pr, 2027);
    expect(lineOf(before, 'RENT').items.map((i: View) => [i.sourceId, i.taxYear])).toEqual([[rent.splitId, 2027]]);
    const { reconciliationId } = await json<{ reconciliationId: string }>(
      await A('POST', '/rent-reconciliations', { transactionId: rent.transactionId, mreTenantId: T1, mreRentTerm: '2028010100', matchedAmount: eur('800.00') }),
      201,
    );
    const confirmed = await recordOf(reconciliationId, 'CONFIRMED');
    await at(confirmed, '2028-01-05T10:00:00Z');

    // Only 2027 is flagged: recorded after 31 December 2027, not after 31 December 2028.
    const v2027 = await view(pr, 2027);
    expect(lineOf(v2027, 'RENT').items).toEqual([]);
    expect(changes(v2027)).toEqual([
      expect.objectContaining({
        kind: 'RECONCILIATION_CONFIRMED',
        entityType: 'RentPaymentReconciliation',
        entityId: reconciliationId,
        reconciliationId,
        transactionId: rent.transactionId,
        mreTenantId: T1,
        mreRentTerm: '2028010100',
        auditRecordId: confirmed,
        amendedAt: '2028-01-05T10:00:00.000Z',
        items: [{ sourceId: rent.splitId, yearBefore: 2027, yearAfter: 2028 }],
        acknowledgement: null,
      }),
    ]);
    expect([level(v2027, 'ATTRIBUTION_INPUT_CHANGED'), v2027.review.final]).toEqual([[true, false], false]);
    const v2028 = await view(pr, 2028);
    expect(changes(v2028)).toEqual([]);
    expect(lineOf(v2028, 'RENT').items.map((i: View) => [i.sourceId, i.taxYear, codes(i.flags)])).toEqual([
      [rent.splitId, 2028, ['ATTRIBUTED_BY_10_DAY_RULE']],
    ]);

    // In 2028 the change is not flagged: refused; in 2027 accepted, the flag informative, the figures unchanged.
    const first = changes(v2027)[0] as Entry;
    const refused = await json<{ error: { code: string; details: unknown } }>(await acknowledge(pr, 2028, first), 409);
    expect(refused.error.details).toEqual({ reason: 'CHANGE_NOT_FLAGGED', auditRecordId: confirmed, year: 2028 });
    const differs = await json<{ error: { code: string } }>(await acknowledge(pr, 2027, { ...first, changeFingerprint: 'a'.repeat(64) }), 412);
    expect(differs.error.code).toBe('ATTRIBUTION_CHANGE_DIFFERS');
    const created = await acknowledge(pr, 2027, first);
    const ack = await json<{ acknowledgementId: string; status: string; version: number; change: unknown }>(created, 201);
    expect([created.headers.get('etag'), created.headers.get('location')]).toEqual(['"1"', `/api/v1${ackPath(pr, 2027)}/${ack.acknowledgementId}`]);
    expect(ack.change).toEqual({
      auditRecordId: confirmed,
      kind: 'RECONCILIATION_CONFIRMED',
      entityType: 'RentPaymentReconciliation',
      entityId: reconciliationId,
      recordedAt: '2028-01-05T10:00:00.000Z',
      fingerprint: first.changeFingerprint,
      items: [{ sourceId: rent.splitId, yearBefore: 2027, yearAfter: 2028 }],
    });
    // The same request again: the no-op, the same acknowledgement.
    expect((await json<{ acknowledgementId: string }>(await acknowledge(pr, 2027, first, 'ein anderer Grund'), 200)).acknowledgementId).toBe(
      ack.acknowledgementId,
    );
    const acknowledged = await view(pr, 2027);
    expect(changes(acknowledged)[0]?.acknowledgement).toEqual({
      acknowledgementId: ack.acknowledgementId,
      acknowledgedAt: expect.any(String),
      acknowledgedBy: 'anna@example.com',
    });
    expect(level(acknowledged, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([false, true]);
    expect([acknowledged.einnahmen, acknowledged.werbungskosten, acknowledged.result]).toEqual([v2027.einnahmen, v2027.werbungskosten, v2027.result]);

    // Released on 2029-02-01, after both years' ends: the rent moves back to 2027, a new change flags both years.
    await json(await A('POST', `/rent-reconciliations/${reconciliationId}/release`, { reason: 'Falsch zugeordnet (synthetisch)' }), 200);
    const released = await recordOf(reconciliationId, 'RELEASED');
    await at(released, '2029-02-01T10:00:00Z');
    const [r2027, r2028] = [await view(pr, 2027), await view(pr, 2028)];
    expect(changes(r2027).map((e) => [e.kind, e.items, e.acknowledgement === null])).toEqual([
      ['RECONCILIATION_CONFIRMED', [{ sourceId: rent.splitId, yearBefore: 2027, yearAfter: 2028 }], false],
      ['RECONCILIATION_RELEASED', [{ sourceId: rent.splitId, yearBefore: 2028, yearAfter: 2027 }], true],
    ]);
    expect(changes(r2028).map((e) => [e.kind, e.acknowledgement])).toEqual([['RECONCILIATION_RELEASED', null]]);
    expect([level(r2027, 'ATTRIBUTION_INPUT_CHANGED'), level(r2028, 'ATTRIBUTION_INPUT_CHANGED')]).toEqual([
      [true, false],
      [true, false],
    ]);
    // Acknowledged in 2028 only: 2028 informative, 2027 still open; then in 2027 too: both informative.
    await json(await acknowledge(pr, 2028, changes(r2028)[0] as Entry), 201);
    expect([level(await view(pr, 2028), 'ATTRIBUTION_INPUT_CHANGED'), level(await view(pr, 2027), 'ATTRIBUTION_INPUT_CHANGED')]).toEqual([
      [false, true],
      [true, false],
    ]);
    const second = await json<{ acknowledgementId: string }>(await acknowledge(pr, 2027, changes(r2027)[1] as Entry), 201);
    expect(level(await view(pr, 2027), 'ATTRIBUTION_INPUT_CHANGED')).toEqual([false, true]);

    // Withdrawn: open again; If-Match on the version; the repeat a no-op keeping the first reason.
    const withdraw = `${ackPath(pr, 2027)}/${second.acknowledgementId}/withdraw`;
    expect((await A('POST', withdraw, { reason: 'Irrtum' }, { 'if-match': '"7"' })).status).toBe(412);
    const withdrawn = await A('POST', withdraw, { reason: 'Irrtum (synthetisch)' }, { 'if-match': '"1"' });
    expect([withdrawn.headers.get('etag'), await json(withdrawn, 200)]).toEqual([
      '"2"',
      expect.objectContaining({ status: 'WITHDRAWN', withdrawReason: 'Irrtum (synthetisch)', withdrawnBy: 'anna@example.com', version: 2 }),
    ]);
    expect(await json(await A('POST', withdraw, { reason: 'anders' }), 200)).toMatchObject({ withdrawReason: 'Irrtum (synthetisch)', version: 2 });
    expect(level(await view(pr, 2027), 'ATTRIBUTION_INPUT_CHANGED')).toEqual([true, false]);
    const list = await json<{ items: { acknowledgementId: string; status: string }[] }>(await A('GET', ackPath(pr, 2027)), 200);
    expect(list.items.map((i: View) => [i.acknowledgementId, i.status])).toEqual([
      [second.acknowledgementId, 'WITHDRAWN'],
      [ack.acknowledgementId, 'ACTIVE'],
    ]);
    expect((await json<{ items: unknown[] }>(await A('GET', `${ackPath(pr, 2027)}?status=ACTIVE`), 200)).items).toHaveLength(1);
    // Acknowledging the same change again creates a new one.
    expect((await json<{ acknowledgementId: string }>(await acknowledge(pr, 2027, changes(r2027)[1] as Entry), 201)).acknowledgementId).not.toBe(
      second.acknowledgementId,
    );

    // Realm isolation: Realm B sees neither the PropertyReference nor its acknowledgements; its own AuditRecord id is not flagged here.
    expect((await call(REALM_B, 'GET', ackPath(pr, 2027))).status).toBe(404);
    expect(
      (await call(REALM_B, 'POST', ackPath(pr, 2027), { auditRecordId: confirmed, expectedFingerprint: first.changeFingerprint, reason: 'x' })).status,
    ).toBe(404);
    const foreign = await property(REALM_B);
    expect(
      (await call(REALM_B, 'POST', ackPath(foreign, 2027), { auditRecordId: confirmed, expectedFingerprint: first.changeFingerprint, reason: 'x' })).status,
    ).toBe(409);
  });

  it('a Loan terms period voided and a corrected one appended: the void alone moves the interest, flagged in 2027 only', async () => {
    const pr = await property();
    const L = await loan('2027-01-01');
    const { termsId } = await json<{ termsId: string }>(
      await A('POST', `/loans/${L}/terms`, { validFrom: '2027-01-01', interestRate: '3.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-01-31' }),
      201,
    );
    await at(await recordOf(termsId, 'CREATED'), '2026-12-01T10:00:00Z');
    await json(
      await A('POST', `/loans/${L}/allocations`, { validFrom: '2027-01-01', basis: 'MANUAL', allocations: [{ propertyReferenceId: pr, share: '1/1' }] }),
      201,
    );
    const debit = await booked('OUTFLOW', '2028-01-03', [{ amount: eur('250.00'), financialCategoryCode: 'LOAN_INTEREST', loanId: L }]);
    // Due on 2027-12-31: the 10-day rule puts the debit in 2027.
    expect(lineOf(await view(pr, 2027), 'LOAN_INTEREST').items.map((i: View) => i.sourceId)).toEqual([debit.splitId]);
    const snapshot = await rowsSnapshot(pool);

    await json(await A('POST', `/loans/${L}/terms/${termsId}/void`, { reason: 'Falscher Zahltag (synthetisch)' }), 200);
    const corrected = await json<{ termsId: string }>(
      await A('POST', `/loans/${L}/terms`, { validFrom: '2027-01-01', interestRate: '3.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-01-20' }),
      201,
    );
    const voided = await recordOf(termsId, 'VOIDED');
    await at(voided, '2028-03-01T10:00:00Z');
    await at(await recordOf(corrected.termsId, 'CREATED'), '2028-03-01T10:05:00Z');
    // Due 2027-12-20, outside the window: the debit takes its booking year 2028.
    const [v2027, v2028] = [await view(pr, 2027), await view(pr, 2028)];
    expect(lineOf(v2028, 'LOAN_INTEREST').items.map((i: View) => i.sourceId)).toEqual([debit.splitId]);
    expect(changes(v2027)).toEqual([
      expect.objectContaining({
        kind: 'LOAN_TERMS_VOIDED',
        entityType: 'LoanTerms',
        entityId: termsId,
        loanId: L,
        termsId,
        validFrom: '2027-01-01',
        auditRecordId: voided,
        items: [{ sourceId: debit.splitId, yearBefore: 2027, yearAfter: 2028 }],
        acknowledgement: null,
      }),
    ]);
    expect(changes(v2028)).toEqual([]);
    const entry = changes(v2027)[0] as Entry;
    expect((await json<{ error: { details: { reason: string } } }>(await acknowledge(pr, 2028, entry), 409)).error.details.reason).toBe('CHANGE_NOT_FLAGGED');
    await json(await acknowledge(pr, 2027, entry), 201);
    expect(level(await view(pr, 2027), 'ATTRIBUTION_INPUT_CHANGED')).toEqual([false, true]);
    // The views wrote nothing; the commands wrote only the acknowledgement, its item and its AuditRecord.
    const after = await rowsSnapshot(pool);
    expect([after['ledger_transaction'], after['transaction_split'], after['tax_classification']]).toEqual([
      snapshot['ledger_transaction'],
      snapshot['transaction_split'],
      snapshot['tax_classification'],
    ]);
    const viewsOnly = await rowsSnapshot(pool);
    await view(pr, 2027);
    await view(pr, 2028);
    expect(await rowsSnapshot(pool)).toEqual(viewsOnly);
  });

  it('a PURCHASE_PRICE set: open in both views, informative once confirmed, open again when withdrawn; a later set needs its own', async () => {
    const [P1, P2] = [await property(), await property()];
    const acquisition = async (pr: string, price: string) =>
      (
        await pool.query(
          `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, created_by)
           VALUES ($1, $2, 'DRAFT', $3, 'EUR', 1, 1, '2026-06-15', 'x') RETURNING id`,
          [REALM_A, pr, price],
        )
      ).rows[0].id as string;
    const [q1, q2] = [await acquisition(P1, '300000.00'), await acquisition(P2, '200000.00')];
    const L = await loan('2027-01-01');
    const priced = (validFrom: string) =>
      A('POST', `/loans/${L}/allocations`, {
        validFrom,
        basis: 'PURCHASE_PRICE',
        allocations: [
          { propertyReferenceId: P1, acquisitionId: q1 },
          { propertyReferenceId: P2, acquisitionId: q2 },
        ],
      });
    const S1 = (await json<{ allocationSetId: string }>(await priced('2027-01-01'), 201)).allocationSetId;
    const june = await booked('OUTFLOW', '2027-06-30', [{ amount: eur('250.00'), financialCategoryCode: 'LOAN_INTEREST', loanId: L }]);
    const priceFlag = (v: View, sourceId: string) =>
      lineOf(v, 'LOAN_INTEREST')
        .items.find((i: View) => i.sourceId === sourceId)
        ?.flags.find((f: View) => f.code === 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY')?.details as { confirmation: unknown } | undefined;
    const [b1, b2] = [await view(P1, 2027), await view(P2, 2027)];
    for (const v of [b1, b2]) {
      expect(priceFlag(v, june.splitId)?.confirmation).toBeNull();
      expect(level(v, 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY')).toEqual([true, false]);
    }
    expect([lineOf(b1, 'LOAN_INTEREST').total, lineOf(b2, 'LOAN_INTEREST').total]).toEqual([eur('150.00'), eur('100.00')]);

    const path = `/loans/${L}/allocations/${S1}/tax-confirmations`;
    const created = await A('POST', path, { reason: 'Darlehen finanziert beide Käufe im Verhältnis der Kaufpreise (synthetisch)' });
    const confirmation = await json<{ confirmationId: string; set: unknown }>(created, 201);
    expect([created.headers.get('etag'), created.headers.get('location')]).toEqual(['"1"', `/api/v1${path}/${confirmation.confirmationId}`]);
    expect(confirmation.set).toEqual({
      validFrom: '2027-01-01',
      basis: 'PURCHASE_PRICE',
      allocations: [
        { propertyReferenceId: P1, share: '3/5', acquisitionId: q1 },
        { propertyReferenceId: P2, share: '2/5', acquisitionId: q2 },
      ],
    });
    const [c1, c2] = [await view(P1, 2027), await view(P2, 2027)];
    for (const v of [c1, c2]) {
      expect(priceFlag(v, june.splitId)?.confirmation).toMatchObject({
        confirmationId: confirmation.confirmationId,
        confirmedBy: 'anna@example.com',
        advisorPartyId: null,
      });
      expect(lineOf(v, 'LOAN_INTEREST').items[0]?.loanAllocation?.taxConfirmation).toMatchObject({ confirmationId: confirmation.confirmationId });
      expect(level(v, 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY')).toEqual([false, true]);
    }
    // The figures do not depend on it.
    expect([lineOf(c1, 'LOAN_INTEREST').total, lineOf(c2, 'LOAN_INTEREST').total, c1.result, c2.result]).toEqual([
      lineOf(b1, 'LOAN_INTEREST').total,
      lineOf(b2, 'LOAN_INTEREST').total,
      b1.result,
      b2.result,
    ]);
    // A later PURCHASE_PRICE set: its items open, the earlier ones still confirmed.
    await json(await priced('2027-09-01'), 201);
    const october = await booked('OUTFLOW', '2027-10-29', [{ amount: eur('250.00'), financialCategoryCode: 'LOAN_INTEREST', loanId: L }]);
    const later = await view(P1, 2027);
    expect([priceFlag(later, june.splitId)?.confirmation === null, priceFlag(later, october.splitId)?.confirmation]).toEqual([false, null]);
    expect(level(later, 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY')).toEqual([true, true]);
    // Withdrawn: open again.
    await json(await A('POST', `${path}/${confirmation.confirmationId}/withdraw`, { reason: 'Verwendung unklar (synthetisch)' }, { 'if-match': '"1"' }), 200);
    expect(priceFlag(await view(P1, 2027), june.splitId)?.confirmation).toBeNull();
    expect((await json<{ items: { status: string }[] }>(await A('GET', path), 200)).items.map((i: View) => i.status)).toEqual(['WITHDRAWN']);
    // Realm isolation: Realm B neither confirms nor reads the set.
    expect((await call(REALM_B, 'POST', path, { reason: 'x' })).status).toBe(404);
    expect((await call(REALM_B, 'GET', path)).status).toBe(404);
  });
});
