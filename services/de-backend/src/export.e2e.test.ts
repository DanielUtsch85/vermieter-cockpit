import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl, PROPERTY, PROPERTY_X30, REALM_A, REALM_B, usePhase2App } from './phase-2-acceptance.test-support.js';

/**
 * VC-X-04 end to end (api-design.md §58S "Tests the implementation needs", JSON), wired as in main.ts: a property with
 * records in every status, built through the HTTP API (deposits and their rent reconciliations seeded in SQL, since
 * the reconciliation needs MRE's rent terms). Each collection has a VOID or CANCELLED member; every element of the file
 * is deep-equal to its single read; deposits by §58A; the Parties named, INACTIVE included; Realm isolation; no write.
 */
describe.skipIf(databaseUrl === undefined)('the property export end to end (VC-X-04, 58S)', () => {
  const { ctx, call, json, eur } = usePhase2App('export_e2e');
  let pool: pg.Pool;
  const A = (method: string, path: string, body?: unknown, extra?: Record<string, string>) => call(REALM_A, method, path, body, extra);
  const read = async (path: string, realm = REALM_A) => json<Record<string, unknown> & { items?: unknown[] }>(await call(realm, 'GET', path), 200);
  const id: Record<string, string> = {};

  beforeAll(async () => {
    ({ pool } = ctx);
    const created = async (path: string, body: unknown, key: string, status = 201) =>
      (await json<Record<string, string>>(await A('POST', path, body), status))[key] as string;
    id['p'] = await created('/property-references/link', { mreRealmId: REALM_A, mrePropertyId: PROPERTY }, 'propertyReferenceId');
    id['q'] = await created('/property-references/link', { mreRealmId: REALM_A, mrePropertyId: PROPERTY_X30 }, 'propertyReferenceId');
    const party = (displayName: string, partyType = 'PERSON') => created('/parties', { partyType, displayName }, 'partyId');
    for (const [key, name, type] of [
      ['seller', 'Sven Verkäufer', 'PERSON'],
      ['buyer', 'Berta Käuferin', 'PERSON'],
      ['notary', 'Notariat Muster', 'ORGANIZATION'],
      ['bank', 'Testbank AG', 'ORGANIZATION'],
      ['oldBank', 'Altbank AG', 'ORGANIZATION'],
      ['hv', 'Hausverwaltung Muster', 'ORGANIZATION'],
      ['unrelated', 'Niemand Beteiligt', 'PERSON'],
    ] as const) {
      id[key] = await party(name, type);
    }
    const p = id['p'];
    const q = id['q'];

    // Ownerships: 1/2 by mistake, voided, recorded again as 1/1.
    const wrong = await created('/ownerships', { propertyReferenceId: p, ownerPartyId: id['seller'], share: '1/2', validFrom: '2020-01-01' }, 'ownershipId');
    await json(await A('POST', `/ownerships/${wrong}/void`, { reason: 'Anteil falsch erfasst' }), 200);
    await created('/ownerships', { propertyReferenceId: p, ownerPartyId: id['seller'], share: '1/1', validFrom: '2020-01-01' }, 'ownershipId');

    // Acquisitions: a draft with a voided cost, an unlinked payment and a land/building split; a cancelled one.
    const acquisition = (contractDate: string) =>
      created(
        '/acquisitions',
        {
          propertyReferenceId: p,
          purchasePrice: eur('200000.00'),
          acquiredShare: '1/1',
          contractDate,
          economicTransferDate: '2026-08-01',
          buyerPartyIds: [id['buyer']],
          sellerPartyIds: [id['seller']],
        },
        'acquisitionId',
      );
    id['a2'] = await acquisition('2026-06-20');
    id['a1'] = await acquisition('2026-06-15');
    await json(await A('POST', `/acquisitions/${id['a2']}/cancel`, { reason: 'Kauf geplatzt' }), 200);
    const a1 = `/acquisitions/${id['a1']}`;
    await created(`${a1}/costs`, { category: 'NOTARY', amount: eur('1234.57'), counterpartyPartyId: id['notary'] }, 'costId');
    const broker = await created(`${a1}/costs`, { category: 'BROKER', amount: eur('100.00') }, 'costId');
    await json(await A('POST', `${a1}/costs/${broker}/void`, { reason: 'falsch' }), 200);
    id['giro'] = await created('/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }, 'financialAccountId');
    const booked = async (amount: string, direction: string, bookingDate: string, splits: unknown[], account = id['giro']) => {
      const t = await created('/transactions', { financialAccountId: account, amount: eur(amount), direction, bookingDate }, 'transactionId');
      await json(await A('PUT', `/transactions/${t}/splits`, { splits }), 200);
      await json(await A('POST', `/transactions/${t}/confirm`), 200);
      return t;
    };
    const price = await booked('200000.00', 'OUTFLOW', '2026-07-30', [
      { amount: eur('200000.00'), financialCategoryCode: 'ACQUISITION', propertyReferenceId: p },
    ]);
    const payment = await created(`${a1}/payments`, { transactionId: price, amount: eur('200000.00') }, 'paymentId');
    await json(await A('POST', `${a1}/payments/${payment}/unlink`, { reason: 'falsch zugeordnet' }), 200);
    await json(
      await A('POST', `${a1}/land-building-allocation`, {
        reviewState: 'UNREVIEWED',
        totalAllocableAmount: eur('200000.00'),
        landAmount: eur('40000.00'),
        buildingAmount: eur('160000.00'),
        method: 'PURCHASE_CONTRACT',
        supersedes: null,
      }),
      201,
    );

    // Loans: one with a set on P and Q, terms and a lender statement; one whose only set naming P is VOID; a VOID one.
    const loan = (lender: string) =>
      created('/loans', { lenderPartyId: lender, borrowerPartyIds: [id['buyer']], principalOriginal: eur('100000.00'), startDate: '2026-01-01' }, 'loanId');
    const set = (loanId: string, allocations: unknown[]) =>
      created(`/loans/${loanId}/allocations`, { validFrom: '2026-01-01', basis: 'MANUAL', allocations }, 'allocationSetId');
    id['shared'] = await loan(id['bank'] as string);
    await set(id['shared'], [
      { propertyReferenceId: p, share: '1/2' },
      { propertyReferenceId: q, share: '1/2' },
    ]);
    await created(
      `/loans/${id['shared']}/terms`,
      { validFrom: '2026-01-01', interestRate: '3.000', repaymentModel: 'ANNUITY', scheduledPayment: eur('500.00'), firstPaymentDate: '2026-01-31' },
      'termsId',
    );
    await created(`/loans/${id['shared']}/balance-statements`, { statementDate: '2026-06-30', balance: eur('98000.00'), source: 'Kontoauszug' }, 'statementId');
    id['voidSet'] = await loan(id['bank'] as string);
    const onlySet = await set(id['voidSet'], [{ propertyReferenceId: p, share: '1/1' }]);
    await json(await A('POST', `/loans/${id['voidSet']}/allocations/${onlySet}/void`, { reason: 'falsches Objekt' }), 200);
    id['voidLoan'] = await loan(id['oldBank'] as string);
    await set(id['voidLoan'], [{ propertyReferenceId: p, share: '1/1' }]);
    await json(await A('POST', `/loans/${id['voidLoan']}/void`, { reason: 'doppelt erfasst' }), 200);
    await json(await A('POST', `/parties/${id['oldBank']}/deactivate`, { reason: 'Bank aufgelöst' }), 200);
    // A Loan naming only Q is not in P's file.
    id['qLoan'] = await loan(id['unrelated'] as string);
    await set(id['qLoan'], [{ propertyReferenceId: q, share: '1/1' }]);

    // WEG memberships: a wrong one voided, the right one; the WEG with its administrator.
    id['weg'] = await created('/wegs', { displayName: 'WEG Musterweg 1', administratorPartyId: id['hv'] }, 'wegId');
    const badMembership = await created(
      `/wegs/${id['weg']}/memberships`,
      { propertyReferenceId: p, miteigentumsanteil: '1/3', validFrom: '2023-01-01' },
      'membershipId',
    );
    await json(await A('POST', `/weg-memberships/${badMembership}/void`, { reason: 'Komma verrutscht' }), 200);
    await created(`/wegs/${id['weg']}/memberships`, { propertyReferenceId: p, miteigentumsanteil: '125.5/1000', validFrom: '2023-01-01' }, 'membershipId');

    // Deposits (§58A): one of a Tenant whose rent is on P (with cash), one on P and Q, one without reconciled rent.
    const deposit = async (key: string, tenant: string) => {
      const { rows } = await pool.query(
        `INSERT INTO security_deposit (mre_realm_id, status, mre_tenant_id, expected_amount, currency, expected_amount_source, interest_bearing, created_by)
         VALUES ($1, 'ACTIVE', $2, '1500.00', 'EUR', 'REQUEST', false, 'seed') RETURNING id`,
        [REALM_A, tenant],
      );
      id[key] = rows[0].id as string;
    };
    const rentOf = async (tenant: string, property: string, day: string) => {
      const t = await booked('700.00', 'INFLOW', `2026-03-${day}`, [
        { amount: eur('700.00'), financialCategoryCode: 'RENT_BASE', propertyReferenceId: property },
      ]);
      await pool.query(
        `INSERT INTO rent_payment_reconciliation (mre_realm_id, status, transaction_id, mre_tenant_id, mre_rent_term, matched_amount, currency, confirmed_at, confirmed_by, created_by)
         VALUES ($1, 'CONFIRMED', $2, $3, $4, '700.00', 'EUR', now(), 'seed', 'seed')`,
        [REALM_A, t, tenant, `202603${day}00`],
      );
    };
    await deposit('own', '6c00000000000000000004a1');
    await deposit('several', '6c00000000000000000004a2');
    await deposit('none', '6c00000000000000000004a3');
    await rentOf('6c00000000000000000004a1', p, '01');
    await rentOf('6c00000000000000000004a2', p, '02');
    await rentOf('6c00000000000000000004a2', q, '03');
    const depositAccount = await created(
      '/financial-accounts',
      { accountType: 'SECURITY_DEPOSIT', displayName: 'Kautionskonto', currency: 'EUR' },
      'financialAccountId',
    );
    await booked(
      '1500.00',
      'INFLOW',
      '2026-03-05',
      [{ amount: eur('1500.00'), financialCategoryCode: 'SECURITY_DEPOSIT', securityDepositId: id['own'] }],
      depositAccount,
    );

    // Realm B: a property, a Party and a deposit; none of it may reach A's files.
    const { rows: bp } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f604b0', 'ACTIVE', 'seed') RETURNING id`,
      [REALM_B],
    );
    id['bProperty'] = bp[0].id as string;
    id['bParty'] = (await json<{ partyId: string }>(await call(REALM_B, 'POST', '/parties', { partyType: 'PERSON', displayName: 'Bea B' }), 201)).partyId;
  });

  it('the file of P: every collection in every status, in the export order, each element deep-equal to its single read', async () => {
    const p = id['p'] as string;
    const doc = await read(`/property-references/${p}/export.json`);
    expect(doc['propertyReference']).toEqual(await read(`/property-references/${p}`));
    const ownerships = doc['ownerships'] as { status: string }[];
    expect(ownerships.map((o) => o.status)).toEqual(['VOID', 'VALID']);
    expect(ownerships).toEqual((await read(`/property-references/${p}/ownerships`)).items);

    const acquisitions = doc['acquisitions'] as (Record<string, unknown> & {
      acquisitionId: string;
      costs: { status: string }[];
      payments: { unlinkedAt: string | null }[];
    })[];
    expect(acquisitions.map((a) => [a.acquisitionId, a['status']])).toEqual([
      [id['a1'], 'DRAFT'],
      [id['a2'], 'CANCELLED'],
    ]);
    for (const a of acquisitions) {
      const { costs, payments, landBuildingAllocations, ...own } = a;
      const path = `/acquisitions/${a.acquisitionId}`;
      expect(own).toEqual(await read(path));
      expect(costs).toEqual((await read(`${path}/costs`)).items);
      expect(payments).toEqual((await read(`${path}/payments`)).items);
      expect(landBuildingAllocations).toEqual((await read(`${path}/land-building-allocations`)).items);
    }
    expect(acquisitions[0]?.costs.map((c) => c.status)).toEqual(['ACTIVE', 'VOID']);
    expect(acquisitions[0]?.payments).toHaveLength(1);
    expect(acquisitions[0]?.payments[0]?.unlinkedAt).not.toBeNull();
    expect(acquisitions[0]?.['landBuildingAllocations']).toHaveLength(1);

    type ExportLoan = {
      loan: { loanId: string; status: string };
      terms: unknown[];
      allocationSets: { status: string; allocations: { propertyReferenceId: string }[] }[];
      balanceStatements: unknown[];
    };
    const loans = doc['loans'] as ExportLoan[];
    expect(loans.map((l) => l.loan.loanId)).toEqual([id['shared'], id['voidSet'], id['voidLoan']].sort());
    for (const l of loans) {
      const path = `/loans/${l.loan.loanId}`;
      expect(l.loan).toEqual(await read(path));
      expect(l.terms).toEqual((await read(`${path}/terms`)).items);
      expect(l.allocationSets).toEqual((await read(`${path}/allocations`)).items);
      if (l.loan.status === 'VOID') expect(l.balanceStatements).toEqual([]);
      else expect(l.balanceStatements).toEqual((await read(`${path}/balance-statements`)).items);
    }
    const byId = new Map(loans.map((l) => [l.loan.loanId, l]));
    expect(byId.get(id['shared'] as string)?.allocationSets[0]?.allocations.map((a) => a.propertyReferenceId)).toEqual([p, id['q']]);
    expect(byId.get(id['shared'] as string)?.terms).toHaveLength(1);
    expect(byId.get(id['shared'] as string)?.balanceStatements).toHaveLength(1);
    expect(byId.get(id['voidSet'] as string)?.allocationSets.map((s) => s.status)).toEqual(['VOID']);
    expect(byId.get(id['voidLoan'] as string)?.loan.status).toBe('VOID');

    const memberships = doc['wegMemberships'] as { membership: { membershipId: string; status: string }; weg: { wegId: string } }[];
    expect(memberships.map((m) => m.membership.status)).toEqual(['VOID', 'ACTIVE']);
    for (const m of memberships) {
      expect(m.membership).toEqual(await read(`/weg-memberships/${m.membership.membershipId}`));
      expect(m.weg).toEqual(await read(`/wegs/${id['weg']}`));
    }

    const deposits = doc['securityDeposits'] as { securityDepositId: string; cash: unknown[] }[];
    expect(deposits.map((d) => d.securityDepositId)).toEqual([id['own']]);
    expect(deposits[0]).toEqual(await read(`/security-deposits/${id['own']}`));
    expect(deposits[0]?.cash).toHaveLength(1);
    expect(doc['securityDepositsNotAttributed']).toEqual([
      { securityDepositId: id['several'], reason: 'SEVERAL_PROPERTY_REFERENCES', candidates: [p, id['q']].sort() },
    ]);
    expect(JSON.stringify(doc)).not.toContain(id['none']);

    const parties = doc['parties'] as { partyId: string; status: string }[];
    const named = ['seller', 'buyer', 'notary', 'bank', 'oldBank', 'hv'].map((k) => id[k] as string).sort();
    expect(parties.map((x) => x.partyId)).toEqual(named);
    for (const x of parties) expect(x).toEqual(await read(`/parties/${x.partyId}`));
    expect(parties.find((x) => x.partyId === id['oldBank'])?.status).toBe('INACTIVE');
    expect(parties.map((x) => x.partyId)).not.toContain(id['unrelated']);
  });

  it('the file of Q: the deposit on P and Q listed in both candidates files; only the Loans naming Q', async () => {
    const doc = await read(`/property-references/${id['q']}/export.json`);
    expect(doc['securityDepositsNotAttributed']).toEqual([
      { securityDepositId: id['several'], reason: 'SEVERAL_PROPERTY_REFERENCES', candidates: [id['p'], id['q']].sort() },
    ]);
    expect(doc['securityDeposits']).toEqual([]);
    expect((doc['loans'] as { loan: { loanId: string } }[]).map((l) => l.loan.loanId)).toEqual([id['shared'], id['qLoan']].sort());
    expect(doc['acquisitions']).toEqual([]);
    expect(JSON.stringify(doc)).not.toContain(id['none']);
  });

  it('Realm isolation: B cannot read P (404) and A cannot read B property; A files hold nothing of B', async () => {
    const asB = await call(REALM_B, 'GET', `/property-references/${id['p']}/export.json`);
    expect(asB.status).toBe(404);
    expect(await asB.json()).toMatchObject({ error: { code: 'NOT_FOUND', details: { propertyReferenceId: id['p'] } } });
    expect((await A('GET', `/property-references/${id['bProperty']}/export.json`)).status).toBe(404);
    const text = JSON.stringify(await read(`/property-references/${id['p']}/export.json`));
    for (const foreign of [REALM_B, id['bProperty'] as string, id['bParty'] as string]) expect(text).not.toContain(foreign);
    const csv = await (await A('GET', '/exports/transactions.csv?rows=splits')).text();
    expect(csv.split('\r\n').length).toBeGreaterThan(5);
    expect((await (await call(REALM_B, 'GET', '/exports/transactions.csv')).text()).split('\r\n')).toHaveLength(2);
  });

  it('the exports write nothing: no AuditRecord, the versions of every record unchanged, no MRE call', async () => {
    const snapshot = async () =>
      (
        await pool.query(
          `SELECT (SELECT count(*) FROM audit_record) AS audits, (SELECT coalesce(sum(version), 0) FROM loan) + (SELECT coalesce(sum(version), 0) FROM acquisition)
             + (SELECT coalesce(sum(version), 0) FROM ledger_transaction) + (SELECT coalesce(sum(version), 0) FROM security_deposit) AS versions`,
        )
      ).rows[0];
    const before = await snapshot();
    const calls = ctx.mre.requests.filter((r) => !r.path.startsWith('/api/v2/realms')).length;
    await read(`/property-references/${id['p']}/export.json`);
    expect((await A('GET', '/exports/transactions.csv?dialect=excel-de&rows=splits')).status).toBe(200);
    expect(await snapshot()).toEqual(before);
    expect(ctx.mre.requests.filter((r) => !r.path.startsWith('/api/v2/realms')).length).toBe(calls);
  });
});
