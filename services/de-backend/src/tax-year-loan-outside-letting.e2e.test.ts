import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { stageAudit } from './infrastructure/postgres/audit-stage.test-support.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import { databaseUrl, REALM_A, REALM_B, usePhase2App } from './phase-2-acceptance.test-support.js';
import { codes, type Json as View } from './phase-8-acceptance.test-support.js';
import { itemFlagKinds } from './tax-year-item-flags.test-support.js';

/**
 * VC-X-43 end to end (api-design.md §58V; Entscheidung des Projektinhabers, 2026-11-07), wired as in main.ts: the
 * section's synthetic example through the HTTP API. PropertyReferences P1 < P2, P1 owned by A and B 1/2 each, P2 by C;
 * Loan L (200,000.00, debt from 2027-01-01, monthly, interest due on the last day) with S1 from 2027-01-01 (P1 1/2, P2
 * 3/10, outside letting 1/5, with its evidence) and S2 from 2027-04-16 (P1 5/8, P2 3/8). March pays 450.01 interest and
 * 1,000.00 principal, April 600.00 interest. The views at both levels, the item and the informative year flag, Financing
 * beside the items, the sets, the property's Loans, the export, a part change by a set adding a part after the year,
 * the refusals, Realm isolation and no cash mutated. Synthetic data only.
 */
const P1 = '0000a043-0000-4000-8000-0000000000e1';
const P2 = '0000a043-0000-4000-8000-0000000000e2';
const [OA, OB, OC] = ['0000b043-0000-4000-8000-0000000000ea', '0000b043-0000-4000-8000-0000000000eb', '0000b043-0000-4000-8000-0000000000ec'];
const BANK = '0000b043-0000-4000-8000-0000000000e9';
const EVIDENCE = ['Auszahlungsbeleg der Bank vom 2027-01-04 (synthetisch)', 'Kaufvertrag Pkw vom 2027-01-05 (synthetisch)'];

describe.skipIf(databaseUrl === undefined)('a Loan partly used outside letting (VC-X-43) end to end', () => {
  const { ctx, call, json, eur } = usePhase2App('tax_year_loan_outside_letting_e2e');
  let pool: pg.Pool;
  const A = (method: string, path: string, body?: unknown) => call(REALM_A, method, path, body);
  const created = async (path: string, body: unknown, key: string, realm = REALM_A) =>
    (await json<Record<string, string>>(await call(realm, 'POST', path, body), 201))[key] as string;
  const view = async (pr: string, year: number, owner?: string) =>
    json<View>(await A('GET', `/property-references/${pr}/tax-years/${year}${owner === undefined ? '' : `?ownerPartyId=${owner}`}`), 200);
  const ids: Record<string, string> = {};
  const lineOf = (v: View, category: string): View => v.werbungskosten.lines.find((l: View) => l.taxCategory === category);

  /** A Realm's PropertyReferences, parties, Ownerships, Loan with schedule, account and a debit helper. */
  async function seed(realm: string, prs: readonly string[], parties: readonly string[]) {
    for (const [i, id] of prs.entries()) {
      await pool.query(
        `INSERT INTO property_reference (id, mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, $3, 'ACTIVE', 'x')`,
        [id, realm, `6512f0c2a1b2c3d4e5f6e0${realm === REALM_A ? 'a' : 'b'}${i}`],
      );
    }
    for (const [id, display] of parties.map((p, i) => [p, `Person ${i + 1} (synthetisch)`] as const)) {
      await pool.query(`INSERT INTO party (id, mre_realm_id, party_type, display_name, status, created_by) VALUES ($1, $2, 'PERSON', $3, 'ACTIVE', 'x')`, [
        id,
        realm,
        display,
      ]);
    }
    const loan = async (lender: string, borrower: string, principal: string) => {
      const id = await created(
        '/loans',
        { lenderPartyId: lender, borrowerPartyIds: [borrower], principalOriginal: eur(principal), startDate: '2027-01-01' },
        'loanId',
        realm,
      );
      await created(
        `/loans/${id}/terms`,
        { validFrom: '2027-01-01', interestRate: '3.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-01-31' },
        'termsId',
        realm,
      );
      return id;
    };
    const giro = await created('/financial-accounts', { accountType: 'BANK', displayName: 'Giro', currency: 'EUR' }, 'financialAccountId', realm);
    const debit = async (bookingDate: string, splits: readonly [string, string, string][]) => {
      const total = splits.reduce((s, [a]) => s + Number(a.replace('.', '')), 0);
      const t = await created(
        '/transactions',
        { financialAccountId: giro, amount: eur((total / 100).toFixed(2)), direction: 'OUTFLOW', bookingDate },
        'transactionId',
        realm,
      );
      const res = await json<{ splits: { splitId: string }[] }>(
        await call(realm, 'PUT', `/transactions/${t}/splits`, {
          splits: splits.map(([a, code, loanId]) => ({ amount: eur(a), financialCategoryCode: code, loanId })),
        }),
        200,
      );
      await json(await call(realm, 'POST', `/transactions/${t}/confirm`), 200);
      return res.splits.map((s) => s.splitId);
    };
    return { loan, debit };
  }

  beforeAll(async () => {
    ({ pool } = ctx);
    const { loan, debit } = await seed(REALM_A, [P1, P2], [OA, OB, OC, BANK]);
    for (const [pr, ownerPartyId, share] of [
      [P1, OA, '1/2'],
      [P1, OB, '1/2'],
      [P2, OC, '1/1'],
    ] as const) {
      await created('/ownerships', { propertyReferenceId: pr, ownerPartyId, share, validFrom: '2026-01-01' }, 'ownershipId');
    }
    ids['L'] = await loan(BANK, OA, '200000.00');
    ids['S1'] = await created(
      `/loans/${ids['L']}/allocations`,
      {
        validFrom: '2027-01-01',
        basis: 'MANUAL',
        allocations: [
          { propertyReferenceId: P1, share: '1/2' },
          { propertyReferenceId: P2, share: '3/10' },
        ],
        outsideLetting: { share: '1/5' },
        useEvidence: EVIDENCE,
      },
      'allocationSetId',
    );
    ids['S2'] = await created(
      `/loans/${ids['L']}/allocations`,
      {
        validFrom: '2027-04-16',
        allocations: [
          { propertyReferenceId: P1, share: '5/8' },
          { propertyReferenceId: P2, share: '3/8' },
        ],
        useEvidence: ['Verkaufsbeleg Pkw vom 2027-04-15 (synthetisch)'],
      },
      'allocationSetId',
    );
    [ids['march'], ids['marchPrincipal']] = (await debit('2027-03-31', [
      ['450.01', 'LOAN_INTEREST', ids['L']],
      ['1000.00', 'LOAN_PRINCIPAL', ids['L']],
    ])) as [string, string];
    [ids['april']] = (await debit('2027-04-30', [['600.00', 'LOAN_INTEREST', ids['L']]])) as [string];
  });

  it('the views of 2027: P1 562.51 (A and B), P2 337.50 (C); outside letting 150.00 in no figure, on each item and in the informative year flag', async () => {
    const [v1, v2] = [await view(P1, 2027), await view(P2, 2027)];
    const items = (v: View) =>
      lineOf(v, 'LOAN_INTEREST').items.map((i: View) => [i.sourceId, i.lineAmount?.amount, i.loanAllocation?.share, i.loanAllocation?.outsideLetting]);
    expect(items(v1)).toEqual([
      [ids['march'], '225.01', '1/2', { share: '1/5', part: eur('90.00') }],
      [ids['april'], '337.50', '9/16', { share: '1/10', part: eur('60.00') }],
    ]);
    expect(items(v2)).toEqual([
      [ids['march'], '135.00', '3/10', { share: '1/5', part: eur('90.00') }],
      [ids['april'], '202.50', '27/80', { share: '1/10', part: eur('60.00') }],
    ]);
    expect([lineOf(v1, 'LOAN_INTEREST').total, lineOf(v2, 'LOAN_INTEREST').total, v1.werbungskosten.total, v2.werbungskosten.total]).toEqual([
      eur('562.51'),
      eur('337.50'),
      eur('562.51'),
      eur('337.50'),
    ]);
    expect(lineOf(v1, 'LOAN_INTEREST').items[1]?.loanAllocation?.segments.map((s: View) => [s.allocationSetId, s.share, s.outsideLettingShare])).toEqual([
      [ids['S1'], '1/2', '1/5'],
      [ids['S2'], '5/8', null],
    ]);
    const owners = v1.owners?.map((o: View) => [o.ownerPartyId, o.werbungskosten.total.amount]);
    expect(owners).toEqual([
      [OA, '281.26'],
      [OB, '281.25'],
    ]);
    expect(v2.owners?.map((o: View) => [o.ownerPartyId, o.werbungskosten.total.amount])).toEqual([[OC, '337.50']]);
    for (const v of [v1, v2, await view(P1, 2027, OA), await view(P1, 2027, OB), await view(P2, 2027, OC)]) {
      expect(v.flags.find((f: View) => f.code === 'LOAN_INTEREST_OUTSIDE_LETTING')?.details).toEqual({
        loanIds: [ids['L']],
        interestTotal: eur('150.00'),
        splitIds: [ids['march'], ids['april']].sort(),
      });
      expect(v.review.info).toContainEqual({ code: 'LOAN_INTEREST_OUTSIDE_LETTING', count: 1 });
      expect(v.review.open.map((o: View) => o.code)).not.toContain('LOAN_INTEREST_OUTSIDE_LETTING');
      expect(v.notAttributed.items).toEqual([]);
    }
    // The owner level: A's and B's parts of P1's part only.
    expect(lineOf(await view(P1, 2027, OA), 'LOAN_INTEREST').items.map((i: View) => i.lineAmount?.amount)).toEqual(['112.51', '168.75']);
    // §58C follow-up (Entscheidung des Projektinhabers, 2026-11-09): the generic walk over the views with outsideLetting.
    for (const v of [v1, v2, await view(P1, 2027, OA)]) itemFlagKinds(v);
    // 2028: nothing of 2027, no flag.
    expect(codes((await view(P1, 2028)).flags)).not.toContain('LOAN_INTEREST_OUTSIDE_LETTING');
  });

  it('Financing: remaining debt and payments per property with outsideLetting beside the items; the columns sum to the totals', async () => {
    const debt = await json<View>(await A('GET', `/loans/${ids['L']}/remaining-debt?asOf=2027-03-31&perProperty=true`), 200);
    expect(debt.actual).toEqual(eur('199000.00'));
    expect(debt.items.map((i: View) => [i.propertyReferenceId, i.share, i.actual.amount])).toEqual([
      [P1, '1/2', '99500.00'],
      [P2, '3/10', '59700.00'],
    ]);
    // §58O: `planned` is the plan rebased on the booked repayment (interest only: 199,000.00), so the difference is 0 here;
    // a plan behind the actual debt is in the domain test. The identities hold on the HTTP figures.
    expect([debt.planned, debt.difference]).toEqual([eur('199000.00'), eur('0.00')]);
    expect(debt.outsideLetting).toEqual({ share: '1/5', actual: eur('39800.00'), planned: eur('39800.00'), difference: eur('0.00') });
    const c = (m: { amount: string }) => Math.round(Number(m.amount) * 100);
    expect(c(debt.outsideLetting.difference)).toBe(c(debt.outsideLetting.actual) - c(debt.outsideLetting.planned));
    for (const k of ['actual', 'planned', 'difference'])
      expect(debt.items.reduce((s: number, i: View) => s + c(i[k]), 0) + c(debt.outsideLetting[k]), k).toBe(c(debt[k]));
    const later = await json<View>(await A('GET', `/loans/${ids['L']}/remaining-debt?asOf=2027-05-31&perProperty=true`), 200);
    expect(later.outsideLetting).toBeNull();
    const payments = await json<View>(await A('GET', `/loans/${ids['L']}/payments?year=2027&perProperty=true`), 200);
    expect([payments.interest, payments.principal]).toEqual([eur('1050.01'), eur('1000.00')]);
    expect(payments.items).toEqual([
      { propertyReferenceId: P1, interest: eur('600.01'), principal: eur('500.00') },
      { propertyReferenceId: P2, interest: eur('360.00'), principal: eur('300.00') },
    ]);
    expect(payments.outsideLetting).toEqual({ interest: eur('90.00'), principal: eur('200.00') });
    expect((await json<View>(await A('GET', `/loans/${ids['L']}/payments?year=2027`), 200)).outsideLetting).toBeUndefined();
  });

  it('the sets, the property s Loans and the export: the part and the evidence, exportFormatVersion 1', async () => {
    const sets = await json<View>(await A('GET', `/loans/${ids['L']}/allocations`), 200);
    expect(sets.items.map((s: View) => [s.allocationSetId, s.outsideLetting, s.useEvidence])).toEqual([
      [ids['S1'], { share: '1/5' }, EVIDENCE],
      [ids['S2'], null, ['Verkaufsbeleg Pkw vom 2027-04-15 (synthetisch)']],
    ]);
    const onDay = await json<View>(await A('GET', `/loans/${ids['L']}/allocations?asOf=2027-02-01`), 200);
    expect(onDay.set.outsideLetting).toEqual({ share: '1/5' });
    const loans = await json<View>(await A('GET', `/property-references/${P1}/loans`), 200);
    expect(loans.items.map((i: View) => [i.allocationSetId, i.share, i.outsideLettingShare])).toEqual([
      [ids['S2'], '5/8', null],
      [ids['S1'], '1/2', '1/5'],
    ]);
    const file = await json<View>(await A('GET', `/property-references/${P1}/export.json`), 200);
    expect(file.exportFormatVersion).toBe(1);
    expect(file.loans[0].allocationSets).toEqual(sets.items);
  });

  it('the refusals: PURCHASE_PRICE with a part, the part without evidence, a sum above 1/1, a set of only the part', async () => {
    const fields = async (body: unknown) => {
      const res = await A('POST', `/loans/${ids['L']}/allocations`, body);
      expect(res.status).toBe(400);
      return ((await res.json()) as View).error.details.fields;
    };
    expect(
      await fields({
        validFrom: '2027-06-01',
        basis: 'PURCHASE_PRICE',
        allocations: [{ propertyReferenceId: P1, acquisitionId: P2 }],
        outsideLetting: { share: '1/5' },
        useEvidence: EVIDENCE,
      }),
    ).toContainEqual({ field: 'outsideLetting', code: 'NOT_ALLOWED_FOR_BASIS' });
    expect(await fields({ validFrom: '2027-06-01', allocations: [{ propertyReferenceId: P1, share: '4/5' }], outsideLetting: { share: '1/5' } })).toEqual([
      { field: 'useEvidence', code: 'REQUIRED' },
    ]);
    expect(
      await fields({
        validFrom: '2027-06-01',
        allocations: [{ propertyReferenceId: P1, share: '1/1' }],
        outsideLetting: { share: '1/5' },
        useEvidence: EVIDENCE,
      }),
    ).toEqual([{ field: 'allocations', code: 'SHARE_SUM_NOT_ONE' }]);
    expect(await fields({ validFrom: '2027-06-01', allocations: [], outsideLetting: { share: '1/1' }, useEvidence: EVIDENCE })).toEqual(
      expect.arrayContaining([{ field: 'outsideLetting.share', code: 'OUT_OF_RANGE' }]),
    );
    expect((await json<View>(await A('GET', `/loans/${ids['L']}/allocations`), 200)).items).toHaveLength(2);
  });

  it('§58G: a set adding a part outside letting, recorded after the year end, raises PROPERTY_PART_CHANGED with the moved part', async () => {
    const before = await view(P1, 2027);
    const L2 = await created('/loans', { lenderPartyId: BANK, borrowerPartyIds: [OB], principalOriginal: eur('10000.00'), startDate: '2027-01-01' }, 'loanId');
    await created(
      `/loans/${L2}/terms`,
      { validFrom: '2027-01-01', interestRate: '3.000', repaymentModel: 'INTEREST_ONLY', firstPaymentDate: '2027-01-31' },
      'termsId',
    );
    await created(`/loans/${L2}/allocations`, { validFrom: '2027-01-01', allocations: [{ propertyReferenceId: P1, share: '1/1' }] }, 'allocationSetId');
    const giro = await created('/financial-accounts', { accountType: 'BANK', displayName: 'Giro 2', currency: 'EUR' }, 'financialAccountId');
    const t = await created(
      '/transactions',
      { financialAccountId: giro, amount: eur('100.00'), direction: 'OUTFLOW', bookingDate: '2027-05-31' },
      'transactionId',
    );
    const [split] = (
      await json<View>(
        await A('PUT', `/transactions/${t}/splits`, { splits: [{ amount: eur('100.00'), financialCategoryCode: 'LOAN_INTEREST', loanId: L2 }] }),
        200,
      )
    ).splits as { splitId: string }[];
    await json(await A('POST', `/transactions/${t}/confirm`), 200);
    const withPart = await created(
      `/loans/${L2}/allocations`,
      { validFrom: '2027-05-01', allocations: [{ propertyReferenceId: P1, share: '4/5' }], outsideLetting: { share: '1/5' }, useEvidence: EVIDENCE },
      'allocationSetId',
    );
    await stageAudit(pool, `UPDATE audit_record SET occurred_at = '2028-02-10T10:00:00Z' WHERE entity_id = $1 AND action = 'CREATED'`, [withPart]);
    const v = await view(P1, 2027);
    const entries = v.flags.find((f: View) => f.code === 'PROPERTY_PART_CHANGED')?.details as View[];
    expect(
      entries.flatMap((e: View) => e.items.map((i: View) => [i.sourceId, i.stateBefore, i.partBefore?.amount, i.stateAfter, i.partAfter?.amount])),
    ).toEqual([[split?.splitId, 'ATTRIBUTED', '100.00', 'ATTRIBUTED', '80.00']]);
    expect(entries[0]?.changeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(lineOf(v, 'LOAN_INTEREST').total).toEqual(eur((562.51 + 80).toFixed(2)));
    expect(v.flags.find((f: View) => f.code === 'LOAN_INTEREST_OUTSIDE_LETTING')?.details.interestTotal).toEqual(eur('170.00'));
    expect(codes(before.flags)).not.toContain('PROPERTY_PART_CHANGED');
  });

  it('Realm isolation and no cash mutated: a same-shaped Loan of Realm B reaches no view, read or export of Realm A', async () => {
    const [Q1, Q2] = ['0000a043-0000-4000-8000-0000000000f1', '0000a043-0000-4000-8000-0000000000f2'];
    const [QA, QBANK] = ['0000b043-0000-4000-8000-0000000000fa', '0000b043-0000-4000-8000-0000000000f9'];
    const b = await seed(REALM_B, [Q1, Q2], [QA, QBANK]);
    const LB = await b.loan(QBANK, QA, '200000.00');
    await created(
      `/loans/${LB}/allocations`,
      {
        validFrom: '2027-01-01',
        allocations: [
          { propertyReferenceId: Q1, share: '1/2' },
          { propertyReferenceId: Q2, share: '3/10' },
        ],
        outsideLetting: { share: '1/5' },
        useEvidence: EVIDENCE,
      },
      'allocationSetId',
      REALM_B,
    );
    await b.debit('2027-03-31', [['999.99', 'LOAN_INTEREST', LB]]);
    // A set of Realm A naming Realm B's PropertyReference is refused.
    expect(
      (
        await A('POST', `/loans/${ids['L']}/allocations`, {
          validFrom: '2027-09-01',
          allocations: [{ propertyReferenceId: Q1, share: '4/5' }],
          outsideLetting: { share: '1/5' },
          useEvidence: EVIDENCE,
        })
      ).status,
    ).toBe(404);
    for (const path of [
      `/loans/${LB}/allocations`,
      `/loans/${LB}/payments?year=2027&perProperty=true`,
      `/property-references/${Q1}/tax-years/2027`,
      `/property-references/${Q1}/loans`,
    ]) {
      expect((await A('GET', path)).status, path).toBe(404);
    }
    const snapshot = await rowsSnapshot(pool);
    const v1 = await view(P1, 2027);
    expect(JSON.stringify(v1)).not.toContain(LB);
    expect(v1.flags.find((f: View) => f.code === 'LOAN_INTEREST_OUTSIDE_LETTING')?.details.loanIds).not.toContain(LB);
    expect(JSON.stringify(await json<View>(await A('GET', `/property-references/${P1}/export.json`), 200))).not.toContain(LB);
    await A('GET', `/loans/${ids['L']}/payments?year=2027&perProperty=true`);
    await A('GET', `/loans/${ids['L']}/remaining-debt?asOf=2027-03-31&perProperty=true`);
    expect(await rowsSnapshot(pool)).toEqual(snapshot);
  });
});
