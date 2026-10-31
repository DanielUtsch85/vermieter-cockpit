import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paymentsInYear, type AllocationRequest } from '../../domains/financing/index.js';
import type { SplitInput } from '../../domains/ledger/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { buildTaxYearView, type NewTaxClassification, type TaxYearItem, type TaxYearView } from '../../domains/taxation/index.js';
import { Money, centsOf, type BusinessDate } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLoanAllocationRepository } from './loan-allocation-repository.js';
import { PostgresLoanDebtRepository } from './loan-debt-repository.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { rowsSnapshot } from './tax-year-view.test-support.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-X-29 persistence (api-design.md §58D; no migration): the interest of an allocated Loan in the tax-year view. The
 * counting selection of #171 with the three cases, two PropertyReferences of one set (`MANUAL` and `PURCHASE_PRICE`),
 * the cross-check with Financing's per-property payments, one snapshot for the sets, the plans, no cash mutated and
 * Realm isolation. Figures and names are synthetic.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee000000000000e1';
const OTHER_REALM = '64b0c0ffee000000000000e2';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2026-10-30');
let counter = 0;

const viewOf = (outcome: ReturnType<typeof buildTaxYearView>): TaxYearView => {
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
};
const placed = (v: TaxYearView): TaxYearItem[] => [
  ...v.einnahmen.lines.flatMap((l) => l.items),
  ...v.werbungskosten.lines.flatMap((l) => l.items),
  ...v.capitalized.items,
  ...v.notInView.items,
  ...v.unclassified.items,
];
const interestLine = (v: TaxYearView) =>
  v.werbungskosten.lines.find((l) => l.taxCategory === 'LOAN_INTEREST') as TaxYearView['werbungskosten']['lines'][number];
const loanFlag = (v: TaxYearView) => v.flags.find((f) => f.code === 'LOAN_INTEREST_NOT_ATTRIBUTED')?.details;

describe.skipIf(databaseUrl === undefined)('the interest of an allocated Loan in the tax-year view (§58D)', () => {
  const schema = testSchemaName('tax_year_loan_interest_test');
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let classifications: PostgresTaxClassificationRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let ownerships: PostgresOwnershipRepository;
  let parties: PostgresPartyRepository;
  let loans: PostgresLoanRepository;
  let allocations: PostgresLoanAllocationRepository;
  let corrections: PostgresCorrectionRepository;
  const giro = new Map<string, string>();

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c application_name=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    db = createDatabase(pool);
    classifications = new PostgresTaxClassificationRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    ownerships = new PostgresOwnershipRepository(db);
    parties = new PostgresPartyRepository(db);
    loans = new PostgresLoanRepository(db);
    allocations = new PostgresLoanAllocationRepository(db);
    corrections = new PostgresCorrectionRepository(db);
    for (const realm of [REALM, OTHER_REALM]) {
      const created = await new PostgresFinancialAccountRepository(db).create(
        { mreRealmId: realm, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null },
        actor,
      );
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      giro.set(realm, created.account.id);
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  async function propertyReference(realm = REALM) {
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fa0000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [realm, mrePropertyId],
    );
    return rows[0].id as string;
  }
  async function party(name: string, realm = REALM) {
    const outcome = await parties.create(
      {
        mreRealmId: realm,
        partyType: 'PERSON',
        displayName: name,
        firstName: null,
        lastName: null,
        legalName: null,
        registrationNumber: null,
        email: null,
        phone: null,
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party.id;
  }
  async function owner(pr: string, partyId: string, share: [number, number]) {
    const o = await ownerships.create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        ownerPartyId: partyId,
        share: { numerator: share[0], denominator: share[1] },
        validFrom: day('2020-01-01'),
        validUntil: null,
        acquisitionId: null,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (o.kind !== 'CREATED') throw new Error(o.kind);
  }
  /** A purchase price for a `PURCHASE_PRICE` set (a DRAFT Acquisition is enough, §41.3). */
  async function acquisition(pr: string, price: string) {
    const { rows } = await pool.query(
      `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, created_by)
       VALUES ($1, $2, 'DRAFT', $3, 'EUR', 1, 1, '2026-06-15', 'x') RETURNING id`,
      [REALM, pr, price],
    );
    return rows[0].id as string;
  }
  const split = (amount: string, financialCategoryCode: string, overrides: Partial<SplitInput> = {}): SplitInput => ({
    amount: eur(amount),
    financialCategoryCode,
    propertyReferenceId: null,
    loanId: null,
    securityDepositId: null,
    description: null,
    ...overrides,
  });
  async function booked(set: SplitInput[], options: { bookingDate: string; realm?: string; confirm?: boolean }) {
    const realm = options.realm ?? REALM;
    const created = await transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: giro.get(realm) as string,
        amount: set.reduce((sum, s) => sum.add(s.amount), eur('0.00')),
        direction: 'OUTFLOW',
        bookingDate: day(options.bookingDate),
        valueDate: null,
        description: 'Buchung',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const tx = created.transaction.id;
    const outcome = await splits.replaceSplits(tx, realm, set, actor);
    if (outcome.kind !== 'REPLACED') throw new Error(JSON.stringify(outcome));
    if (options.confirm !== false) expect((await transactions.confirm(tx, realm, actor)).kind).toBe('CONFIRMED');
    const { rows } = await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [tx]);
    return { tx, splitId: rows[0].id as string };
  }
  const interestOf = async (loanId: string, amount: string, bookingDate: string, options: { confirm?: boolean; realm?: string } = {}) =>
    booked([split(amount, 'LOAN_INTEREST', { loanId })], { bookingDate, ...options });
  const classify = async (sourceId: string, overrides: Partial<NewTaxClassification>) => {
    const created = await classifications.createClassification(
      {
        mreRealmId: REALM,
        sourceType: 'TRANSACTION_SPLIT',
        sourceId,
        taxCategory: 'LOAN_INTEREST',
        treatment: 'DEDUCTIBLE',
        reviewState: 'USER_CONFIRMED',
        supersedes: null,
        notes: null,
        sourceReferences: [],
        ...overrides,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(JSON.stringify(created));
  };
  const manual = (validFrom: string, entries: readonly (readonly [string, bigint, bigint])[]): AllocationRequest => ({
    validFrom: day(validFrom),
    basis: 'MANUAL',
    allocations: entries.map(([propertyReferenceId, numerator, denominator]) => ({
      propertyReferenceId,
      share: { numerator, denominator },
      acquisitionId: null,
    })),
    notes: null,
  });
  async function appended(loanId: string, request: AllocationRequest, realm = REALM) {
    const outcome = await allocations.create(loanId, realm, request, actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.set;
  }
  /** A Loan from 2026-01-01 without terms; with `request`, its first set. */
  async function loan(request: AllocationRequest | null, realm = REALM) {
    const created = await loans.create(
      {
        mreRealmId: realm,
        lenderPartyId: await party('Bank Beispiel', realm),
        borrowerPartyIds: [await party('Anna Darlehensnehmerin', realm)],
        principalOriginal: eur('100000.00'),
        startDate: day('2026-01-01'),
        disbursementDate: null,
        maturityDate: null,
        contractNumber: null,
        acquisitionId: null,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const set = request === null ? null : await appended(created.loan.id, request, realm);
    return { loanId: created.loan.id, setId: set?.id ?? null };
  }
  const read = (pr: string, year: number, ownerPartyId: string | null = null, realm = REALM) =>
    classifications.readTaxYear(pr, realm, year, ownerPartyId, today);
  const view = async (pr: string, year: number, ownerPartyId: string | null = null) => {
    const r = await read(pr, year, ownerPartyId);
    if (r === undefined) throw new Error('no PropertyReference');
    return viewOf(buildTaxYearView(r, { year, ownerPartyId, today, registry: TAX_RULES }));
  };

  it('the three cases over #171’s selection: the counting interest of the year is an item where a set covers its day; not counting splits reach nothing', async () => {
    const [pr, elsewhere] = [await propertyReference(), await propertyReference()];
    const anna = await party('Anna Eigentümerin');
    await owner(pr, anna, [1, 1]);
    const allocated = await loan(manual('2026-01-01', [[pr, 1n, 1n]]));
    const other = await loan(manual('2026-01-01', [[elsewhere, 1n, 1n]]));
    const unallocated = await loan(null);
    const voided = await loan(manual('2026-01-01', [[pr, 1n, 1n]]));
    const late = await loan(manual('2027-06-01', [[pr, 1n, 1n]]));
    const counted = (await interestOf(allocated.loanId, '612.37', '2027-03-20')).splitId;
    const second = (await interestOf(allocated.loanId, '0.01', '2027-06-20')).splitId;
    const earlier = (await interestOf(allocated.loanId, '50.00', '2026-06-20')).splitId;
    const moved = (await interestOf(allocated.loanId, '70.00', '2027-12-30')).splitId;
    await classify(moved, { taxYear: 2028 });
    // Not counting: a Transaction not confirmed; one corrected away; principal of the allocated Loan.
    await interestOf(allocated.loanId, '80.00', '2027-04-20', { confirm: false });
    const reversed = await interestOf(allocated.loanId, '90.00', '2027-05-20');
    expect((await corrections.correct(reversed.tx, REALM, { reason: 'falsch', replacement: null }, actor)).kind).toBe('CORRECTED');
    await booked([split('887.63', 'LOAN_PRINCIPAL', { loanId: allocated.loanId })], { bookingDate: '2027-03-20' });
    // Not here: a Loan allocated elsewhere, one without a set, one whose only set is VOID.
    const elsewhereInterest = (await interestOf(other.loanId, '40.00', '2027-03-20')).splitId;
    await interestOf(unallocated.loanId, '30.00', '2027-03-20');
    expect((await allocations.void(voided.loanId, voided.setId as string, REALM, 'falsch erfasst', new Date('2026-10-30T10:00:00Z'), actor)).kind).toBe(
      'VOIDED',
    );
    await interestOf(voided.loanId, '20.00', '2027-03-20');
    // Not attributed: booked before the late Loan's first set; attributed: on its first day.
    const beforeSet = (await interestOf(late.loanId, '15.00', '2027-05-31')).splitId;
    const onSet = (await interestOf(late.loanId, '25.00', '2027-06-01')).splitId;

    for (const owner of [null, anna]) {
      const v = await view(pr, 2027, owner);
      expect(interestLine(v).items.map((i) => [i.sourceId, i.lineAmount?.amount, i.loanAllocation?.share])).toEqual([
        [counted, '612.37', '1/1'],
        [onSet, '25.00', '1/1'],
        [second, '0.01', '1/1'],
      ]);
      expect(interestLine(v).total.amount).toBe('637.38');
      expect(placed(v)).toHaveLength(3);
      expect(v.notAttributed.items.map((i) => [i.sourceId, i.notAttributed?.reason, i.notAttributed?.candidates])).toEqual([
        [beforeSet, 'NO_LOAN_ALLOCATION', [pr]],
      ]);
      expect(loanFlag(v)).toEqual({ loanIds: [late.loanId], interestTotal: { amount: '15.00', currency: 'EUR' }, splitIds: [beforeSet] });
    }
    expect(interestLine(await view(pr, 2026)).items.map((i) => i.sourceId)).toEqual([earlier]);
    expect(interestLine(await view(pr, 2028)).items.map((i) => [i.sourceId, i.reviewState])).toEqual([[moved, 'USER_CONFIRMED']]);
    const elsewhereView = await view(elsewhere, 2027);
    expect([interestLine(elsewhereView).items.map((i) => i.sourceId), loanFlag(elsewhereView)]).toEqual([[elsewhereInterest], undefined]);
    for (const year of [2026, 2028]) expect(loanFlag(await view(pr, year))).toBeUndefined();
    expect(placed(await view(await propertyReference(), 2027))).toEqual([]);
  });

  it('two PropertyReferences of one set: the two views’ parts of each split sum to it, MANUAL and PURCHASE_PRICE alike; equal to Financing’s per-property interest', async () => {
    const [p1, p2] = (await Promise.all([propertyReference(), propertyReference()])).sort();
    const amounts = ['450.01', '449.99', '0.01', '1234.57'];
    const priced = async () => {
      const l = await loan(null);
      const set = await appended(l.loanId, {
        validFrom: day('2026-01-01'),
        basis: 'PURCHASE_PRICE',
        allocations: [
          { propertyReferenceId: p1, share: null, acquisitionId: await acquisition(p1, '300000.00') },
          { propertyReferenceId: p2, share: null, acquisitionId: await acquisition(p2, '175000.00') },
        ],
        notes: null,
      });
      return { loanId: l.loanId, setId: set.id };
    };
    const manualLoan = await loan(
      manual('2026-01-01', [
        [p1, 3n, 5n],
        [p2, 2n, 5n],
      ]),
    );
    const pricedLoan = await priced();
    for (const [i, amount] of amounts.entries()) {
      await interestOf(manualLoan.loanId, amount, `2027-0${i + 2}-10`);
      await interestOf(pricedLoan.loanId, amount, `2027-0${i + 2}-11`);
    }
    const [v1, v2] = [await view(p1, 2027), await view(p2, 2027)];
    const items = (v: TaxYearView, loanId: string) => interestLine(v).items.filter((i) => i.loanAllocation?.loanId === loanId);
    for (const loanId of [manualLoan.loanId, pricedLoan.loanId]) {
      const [a, b] = [items(v1, loanId), items(v2, loanId)];
      expect(a.map((x, k) => centsOf(x.lineAmount as Money) + centsOf(b[k]?.lineAmount as Money))).toEqual(amounts.map((x) => centsOf(eur(x))));
      // Financing's per-property payments read gives the same interest per property (§41.6).
      const inputs = await new PostgresLoanDebtRepository(db).debtInputs(loanId, REALM);
      const payments = paymentsInYear(inputs as NonNullable<typeof inputs>, 2027, true);
      if (payments.kind !== 'PER_PROPERTY') throw new Error(payments.kind);
      expect(payments.items.map((p) => p.interest)).toEqual([a, b].map((xs) => xs.reduce((s, x) => s + centsOf(x.lineAmount as Money), 0n)));
    }
    // PURCHASE_PRICE (12/19, 7/19): the flag on every item in both views, open.
    for (const v of [v1, v2]) {
      for (const item of items(v, pricedLoan.loanId)) {
        expect(item.flags).toEqual([
          { code: 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', details: { loanId: pricedLoan.loanId, allocationSetId: pricedLoan.setId } },
        ]);
      }
      for (const item of items(v, manualLoan.loanId)) expect(item.flags).toEqual([]);
      expect(v.review.open).toContainEqual({ code: 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', count: 4 });
    }
    expect(items(v1, pricedLoan.loanId)[0]?.loanAllocation).toMatchObject({ basis: 'PURCHASE_PRICE', share: '12/19' });
    expect(centsOf(interestLine(v1).total) + centsOf(interestLine(v2).total)).toBe(2n * amounts.reduce((s, x) => s + centsOf(eur(x)), 0n));
  });

  it('one snapshot: a set appended, or the last set voided, while the view’s transaction waits is not seen', async () => {
    const [pr, other] = [await propertyReference(), await propertyReference()];
    const appendedLoan = await loan(manual('2027-01-01', [[pr, 1n, 1n]]));
    const voidedLoan = await loan(manual('2027-01-01', [[pr, 1n, 1n]]));
    const half = await appended(
      voidedLoan.loanId,
      manual('2027-07-01', [
        [pr, 1n, 2n],
        [other, 1n, 2n],
      ]),
    );
    await interestOf(appendedLoan.loanId, '100.00', '2027-08-01');
    await interestOf(voidedLoan.loanId, '100.00', '2027-08-02');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // The read takes its snapshot with the PropertyReference, then waits on the WEG memberships, before the sets.
      await holder.query('LOCK TABLE weg_membership IN ACCESS EXCLUSIVE MODE');
      const reading = read(pr, 2027);
      const deadline = Date.now() + 5_000;
      while (
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND application_name = current_setting('application_name') AND query LIKE '%weg_membership%' AND pid <> pg_backend_pid()`,
            )
          ).rows[0].count,
        ) < 1
      ) {
        if (Date.now() > deadline) throw new Error('the read does not wait');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await appended(
        appendedLoan.loanId,
        manual('2027-07-01', [
          [pr, 1n, 2n],
          [other, 1n, 2n],
        ]),
      );
      expect((await allocations.void(voidedLoan.loanId, half.id, REALM, 'falsch erfasst', new Date('2026-10-30T10:00:00Z'), actor)).kind).toBe('VOIDED');
      await holder.query('ROLLBACK');
      const r = await reading;
      const seen = viewOf(buildTaxYearView(r as NonNullable<typeof r>, { year: 2027, ownerPartyId: null, today, registry: TAX_RULES }));
      expect(interestLine(seen).items.map((i) => i.lineAmount?.amount)).toEqual(['100.00', '50.00']);
      expect(interestLine(await view(pr, 2027)).items.map((i) => i.lineAmount?.amount)).toEqual(['50.00', '100.00']);
    } finally {
      holder.release();
    }
  });

  it(
    'the plans: the candidate splits by transaction_split_loan_idx and an index of loan_allocation; the sets by loan_allocation_set_loan_idx',
    { timeout: 60_000 },
    async () => {
      const sent: CompiledQuery[] = [];
      const logged = new Kysely<Database>({
        dialect: new PostgresDialect({ pool }),
        log: (event) => {
          if (event.level === 'query') sent.push(event.query);
        },
      });
      const pr = await propertyReference();
      const l = await loan(manual('2026-01-01', [[pr, 1n, 1n]]));
      await interestOf(l.loanId, '10.00', '2027-03-01');
      // Many splits without a Loan, so a scan of transaction_split would not pay.
      await pool.query(
        `WITH t AS (
         INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by)
         SELECT $1, $2, 1, 'EUR', 'INFLOW', date '2026-01-01' + (g % 700), 'MANUAL', 'UNREVIEWED', 'x' FROM generate_series(1, 16000) g RETURNING id)
       INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, created_by)
       SELECT t.id, $1, 1, 1, 'EUR', (SELECT id FROM financial_category WHERE code = 'OWNER_CONTRIBUTION'), 'x' FROM t`,
        [REALM, giro.get(REALM)],
      );
      await pool.query(`ANALYZE transaction_split; ANALYZE ledger_transaction; ANALYZE loan_allocation; ANALYZE loan_allocation_set`);
      sent.length = 0;
      await new PostgresTaxClassificationRepository(logged).readTaxYear(pr, REALM, 2027, null, today);
      const explain = async (query: CompiledQuery | undefined, settings = '') => {
        if (query === undefined) throw new Error('the query was not sent');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          if (settings !== '') await client.query(settings);
          const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${query.sql}`, [...query.parameters]);
          return JSON.stringify(rows[0]['QUERY PLAN']);
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };
      const candidateQuery = sent.find((q) => q.sql.includes('"s"."loan_id" in (select'));
      expect(await explain(candidateQuery)).toContain('transaction_split_loan_idx');
      // The allocation tables of a test are tiny, so the planner scans them; without the scan, the reads use their indexes:
      // the entries by the PropertyReference (0026's loan_allocation_property_reference_idx), or from the set side by the
      // unique (set_id, property_reference_id), whichever the planner prices lower on so few rows.
      expect(await explain(candidateQuery, 'SET LOCAL enable_seqscan = off')).toMatch(/"Index Name":"loan_allocation_property(_reference_idx)?"/);
      const setRead = sent.find((q) => q.sql.includes('from "loan_allocation_set" where') && q.sql.includes('"loan_id" in ('));
      // The batched set read is filtered by the Realm as every read is; 0026's composite keys make this a second guard,
      // so it is asserted on the statement rather than by data (another Realm's set cannot name this Realm's Loan).
      expect(setRead?.sql).toContain('"mre_realm_id" = $1');
      expect(setRead?.parameters[0]).toBe(REALM);
      expect(await explain(setRead, 'SET LOCAL enable_seqscan = off')).toContain('loan_allocation_set_loan_idx');
    },
  );

  it(
    'no cash mutated by views with Loan items; Realm isolation: another Realm’s Loan, set and split with a same-named setup reach no view',
    { timeout: 30_000 },
    async () => {
      const pr = await propertyReference();
      const l = await loan(manual('2026-01-01', [[pr, 1n, 1n]]));
      await interestOf(l.loanId, '10.00', '2027-03-01');
      const foreignPr = await propertyReference(OTHER_REALM);
      const foreign = await loan(manual('2026-01-01', [[foreignPr, 1n, 1n]]), OTHER_REALM);
      const foreignSplit = (await interestOf(foreign.loanId, '99.00', '2027-03-01', { realm: OTHER_REALM })).splitId;
      const before = await rowsSnapshot(pool);
      const v = await view(pr, 2027);
      await view(pr, 2027, null);
      expect(await rowsSnapshot(pool)).toEqual(before);
      expect(interestLine(v).items.map((i) => i.lineAmount?.amount)).toEqual(['10.00']);
      expect([...placed(v), ...v.notAttributed.items].some((i) => i.sourceId === foreignSplit)).toBe(false);
      expect(loanFlag(v)).toBeUndefined();
      // The foreign set's Loan is not among the sets read for this Realm.
      expect([...((await read(pr, 2027))?.loanAllocationSets.keys() ?? [])]).toEqual([l.loanId]);
      expect(await read(foreignPr, 2027)).toBeUndefined();
    },
  );
});
