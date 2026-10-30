import { Kysely, PostgresDialect, sql, type CompiledQuery } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Direction, SplitInput } from '../../domains/ledger/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import {
  buildTaxYearView,
  sourceKeyOf,
  type NewTaxClassification,
  type TaxYearItem,
  type TaxYearOutcome,
  type TaxYearView,
} from '../../domains/taxation/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { PostgresCorrectionRepository } from './correction-repository.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLoanAllocationRepository } from './loan-allocation-repository.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import { PostgresRentReconciliationRepository } from './rent-reconciliation-repository.js';
import type { Database } from './schema.js';
import { PostgresSecurityDepositRepository } from './security-deposit-repository.js';
import { PostgresTaxClassificationRepository, taxYearSnapshot } from './tax-classification-repository.js';
import { rowsSnapshot } from './tax-year-view.test-support.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-7-04 persistence (api-design.md §58C, migration 0048): the view's items equal §55's list per source, over three
 * years; the deposits not attributed (both reasons); the cap; one snapshot; the plan of the split query; `up` and `down`
 * of 0048; and the counter-check "no cash mutated" with its mechanism. Figures and names are synthetic.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee000000000000f1';
const OTHER_REALM = '64b0c0ffee000000000000f2';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2026-10-30');
let counter = 0;
const nextTenant = () => `6512f0c2a1f7${(++counter).toString(16).padStart(12, '0')}`;

async function withMigrationLock(work: () => Promise<unknown>): Promise<void> {
  const lock = new pg.Client({ connectionString: databaseUrl });
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    await work();
  } finally {
    await lock.end().catch(() => undefined);
  }
}

const viewOf = (outcome: TaxYearOutcome): TaxYearView => {
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
};
const placedItems = (v: TaxYearView): TaxYearItem[] => [
  ...v.einnahmen.lines.flatMap((l) => l.items),
  ...v.werbungskosten.lines.flatMap((l) => l.items),
  ...v.capitalized.items,
  ...v.notInView.items,
  ...v.unclassified.items,
];

describe.skipIf(databaseUrl === undefined)('the tax-year view (§58C)', () => {
  const schema = testSchemaName('tax_year_view_test');
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let classifications: PostgresTaxClassificationRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let reconciliations: PostgresRentReconciliationRepository;
  let deposits: PostgresSecurityDepositRepository;
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
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    db = createDatabase(pool);
    classifications = new PostgresTaxClassificationRepository(db);
    transactions = new PostgresTransactionRepository(db);
    splits = new PostgresTransactionSplitRepository(db);
    reconciliations = new PostgresRentReconciliationRepository(db);
    deposits = new PostgresSecurityDepositRepository(db);
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
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f90000n + BigInt(++counter)).toString(16).padStart(24, '0');
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
  async function owner(pr: string, partyId: string, share: [number, number], validFrom: string, validUntil: string | null = null) {
    const o = await ownerships.create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        ownerPartyId: partyId,
        share: { numerator: share[0], denominator: share[1] },
        validFrom: day(validFrom),
        validUntil: validUntil === null ? null : day(validUntil),
        acquisitionId: null,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (o.kind !== 'CREATED') throw new Error(o.kind);
    return o.ownership.id;
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
  async function booked(set: SplitInput[], options: { direction?: Direction; bookingDate: string; realm?: string; confirm?: boolean }) {
    const realm = options.realm ?? REALM;
    const total = set.reduce((sum, s) => sum.add(s.amount), eur('0.00'));
    const created = await transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: giro.get(realm) as string,
        amount: total,
        direction: options.direction ?? 'OUTFLOW',
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
  const one = async (pr: string, amount: string, code: string, bookingDate: string, direction: Direction = 'OUTFLOW') =>
    (await booked([split(amount, code, { propertyReferenceId: pr })], { direction, bookingDate })).splitId;
  async function rent(pr: string, tenant: string, bookingDate: string, term: string) {
    const { tx, splitId } = await booked([split('900.00', 'RENT_BASE', { propertyReferenceId: pr })], { direction: 'INFLOW', bookingDate });
    const matched = await reconciliations.create(
      { mreRealmId: REALM, transactionId: tx, mreTenantId: tenant, mreRentTerm: term, matchedAmount: eur('900.00'), notes: null },
      actor,
    );
    if (matched.kind !== 'CREATED') throw new Error(matched.kind);
    return splitId;
  }
  /** A deposit of `tenant` with 3000 received and 2600 repaid, closed RETAINED on 30 June 2027 (400 kept). */
  async function retained(tenant: string, realm = REALM) {
    const created = await deposits.create(
      {
        mreRealmId: realm,
        mreTenantId: tenant,
        expectedAmount: eur('3000.00'),
        expectedAmountSource: 'REQUEST',
        holdingFinancialAccountId: null,
        interestBearing: false,
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const id = created.deposit.id;
    await booked([split('3000.00', 'SECURITY_DEPOSIT', { securityDepositId: id })], { direction: 'INFLOW', bookingDate: '2026-01-02', realm });
    await booked([split('2600.00', 'SECURITY_DEPOSIT', { securityDepositId: id })], { direction: 'OUTFLOW', bookingDate: '2027-06-20', realm });
    const closed = await deposits.close(id, realm, { closingDate: day('2027-06-30'), reason: 'RETAINED', closingNote: 'Mietrückstand' }, actor);
    if (closed.kind !== 'CLOSED') throw new Error(JSON.stringify(closed));
    return id;
  }
  /** A deposit of `tenant` with 3000 received and 3000 repaid, closed RETURNED on 30 June 2027 (nothing kept). */
  async function returned(tenant: string) {
    const created = await deposits.create(
      {
        mreRealmId: REALM,
        mreTenantId: tenant,
        expectedAmount: eur('3000.00'),
        expectedAmountSource: 'REQUEST',
        holdingFinancialAccountId: null,
        interestBearing: false,
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const id = created.deposit.id;
    await booked([split('3000.00', 'SECURITY_DEPOSIT', { securityDepositId: id })], { direction: 'INFLOW', bookingDate: '2026-01-02' });
    await booked([split('3000.00', 'SECURITY_DEPOSIT', { securityDepositId: id })], { direction: 'OUTFLOW', bookingDate: '2027-06-20' });
    const closed = await deposits.close(id, REALM, { closingDate: day('2027-06-30'), reason: 'RETURNED', closingNote: null }, actor);
    if (closed.kind !== 'CLOSED') throw new Error(JSON.stringify(closed));
    return id;
  }
  const classify = async (sourceId: string, overrides: Partial<NewTaxClassification>) => {
    const created = await classifications.createClassification(
      {
        mreRealmId: REALM,
        sourceType: 'TRANSACTION_SPLIT',
        sourceId,
        taxCategory: 'MAINTENANCE',
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
    return created.classification.id;
  };
  const read = (pr: string, year: number, ownerPartyId: string | null = null, realm = REALM) =>
    classifications.readTaxYear(pr, realm, year, ownerPartyId, today);
  const view = async (pr: string, year: number, ownerPartyId: string | null = null) => {
    const r = await read(pr, year, ownerPartyId);
    if (r === undefined) throw new Error('no PropertyReference');
    return buildTaxYearView(r, { year, ownerPartyId, today, registry: TAX_RULES });
  };
  const list = async (pr: string, year: number) => (await classifications.listTaxMeanings(pr, REALM, year, {}, { page: 1, pageSize: 200 }, today))?.items ?? [];

  /** A PropertyReference with a year of every kind of source: rent, a refund, principal, an unclassified, a capitalised and an elected repair. */
  async function fixture() {
    const pr = await propertyReference();
    const anna = await party('Anna Eigentümerin');
    await owner(pr, anna, [1, 1], '2020-01-01');
    const tenant = nextTenant();
    const ids = {
      pr,
      anna,
      tenant,
      decemberRent: await rent(pr, tenant, '2026-12-01', '2026120100'),
      januaryRent: await rent(pr, tenant, '2026-12-29', '2027010100'),
      rent: await rent(pr, tenant, '2027-03-01', '2027030100'),
      refund: await one(pr, '40.00', 'MAINTENANCE', '2027-04-02', 'INFLOW'),
      principal: await one(pr, '2400.00', 'OWNER_CONTRIBUTION', '2027-05-01', 'INFLOW'),
      other: await one(pr, '70.00', 'OTHER_EXPENSE', '2027-05-02'),
      capitalised: await one(pr, '5000.00', 'MAINTENANCE', '2027-06-01'),
      elected: await one(pr, '9000.00', 'MAINTENANCE', '2026-09-15'),
      lateRepair: await one(pr, '300.00', 'MAINTENANCE', '2028-02-01'),
    };
    await classify(ids.refund, { refundOfYear: 2026 });
    await classify(ids.capitalised, { treatment: 'CAPITALIZED' });
    await classify(ids.elected, { treatment: 'DISTRIBUTED_82B', distributionYears: 3, mostlyResidentialConfirmed: true });
    return ids;
  }

  it('the view’s items equal §55’s list for the same year, per source; over three years each source once, the § 82b one in each year with its part', async () => {
    const ids = await fixture();
    const seen = new Map<string, number[]>();
    for (const year of [2026, 2027, 2028]) {
      const v = viewOf(await view(ids.pr, year));
      const listed = await list(ids.pr, year);
      const items = placedItems(v);
      expect(items.map(sourceKeyOf).sort()).toEqual(listed.map((m) => sourceKeyOf(m)).sort());
      for (const m of listed) {
        const item = items.find((i) => sourceKeyOf(i) === sourceKeyOf(m)) as TaxYearItem;
        expect([item.taxCategory, item.treatment, item.reviewState, item.origin, item.classificationId, item.amount.amount]).toEqual([
          m.taxCategory,
          m.treatment,
          m.reviewState,
          m.origin,
          m.classificationId,
          m.amount.amount,
        ]);
        // The meaning's own flags, as they are; the view only adds its own.
        expect(item.flags.slice(0, m.flags.length)).toEqual(m.flags);
        // What counts in the year: the list's yearAmount, signed (no co-owner sells here, so nothing is folded).
        if (item.lineAmount !== null) expect(item.lineAmount.amount.replace('-', '')).toBe(m.yearAmount.amount);
        seen.set(sourceKeyOf(m), [...(seen.get(sourceKeyOf(m)) ?? []), year]);
      }
    }
    const once = [...seen.entries()].filter(([key]) => !key.includes(ids.elected));
    for (const [key, years] of once) expect(years, key).toHaveLength(1);
    expect(seen.get(`TRANSACTION_SPLIT/${ids.elected}/`)).toEqual([2026, 2027, 2028]);
    const v2027 = viewOf(await view(ids.pr, 2027));
    const line = (c: string) => [...v2027.einnahmen.lines, ...v2027.werbungskosten.lines].find((l) => l.taxCategory === c);
    expect(line('RENT')?.items.map((i) => i.sourceId)).toEqual([ids.januaryRent, ids.rent]);
    expect(line('REFUNDS_OF_EARLIER_YEARS')?.items.map((i) => [i.sourceId, i.lineAmount?.amount])).toEqual([[ids.refund, '40.00']]);
    expect(line('MAINTENANCE')?.subtotals).toEqual({ immediate: eur('0.00'), distributed82b: eur('3000.00') });
    expect(v2027.capitalized.items.map((i) => i.sourceId)).toEqual([ids.capitalised]);
    expect(v2027.notInView.items.map((i) => i.sourceId)).toEqual([ids.principal]);
    expect(v2027.unclassified.items.map((i) => i.sourceId)).toEqual([ids.other]);
    expect([v2027.einnahmen.total.amount, v2027.werbungskosten.total.amount, v2027.result.amount.amount]).toEqual(['1840.00', '3000.00', '-1160.00']);
    expect(v2027.owners?.map((o) => [o.ownerPartyId, o.result.amount.amount])).toEqual([[ids.anna, '-1160.00']]);
    expect(v2027.ruleVersions.map((r) => `${r.ruleCode}@${r.version}:${r.itemCount}`)).toEqual([
      'DE_82B_DISTRIBUTION@1:1',
      'DE_CASH_TIMING@1:7',
      'DE_CATEGORY_DEFAULTS@1:7',
    ]);
  });

  it('the deposits not attributed: SEVERAL_PROPERTY_REFERENCES in each candidate’s view, NO_RECONCILED_RENT in every view of the Realm; another Realm’s in none', async () => {
    const [first, second, third] = [await propertyReference(), await propertyReference(), await propertyReference()];
    const both = nextTenant();
    await rent(first, both, '2027-01-03', '2027010100');
    await rent(second, both, '2027-02-03', '2027020100');
    const several = await retained(both);
    const none = await retained(nextTenant());
    const foreign = await retained(nextTenant(), OTHER_REALM);
    const notAttributed = async (pr: string) => viewOf(await view(pr, 2027)).notAttributed.items.map((i) => [i.sourceId, i.notAttributed?.reason]);
    expect(await notAttributed(first)).toEqual(
      expect.arrayContaining([
        [several, 'SEVERAL_PROPERTY_REFERENCES'],
        [none, 'NO_RECONCILED_RENT'],
      ]),
    );
    expect(await notAttributed(second)).toEqual(
      expect.arrayContaining([
        [several, 'SEVERAL_PROPERTY_REFERENCES'],
        [none, 'NO_RECONCILED_RENT'],
      ]),
    );
    const elsewhere = await notAttributed(third);
    expect(elsewhere).toContainEqual([none, 'NO_RECONCILED_RENT']);
    expect(elsewhere.map(([id]) => id)).not.toContain(several);
    for (const pr of [first, second, third]) expect((await notAttributed(pr)).map(([id]) => id)).not.toContain(foreign);
    const v = viewOf(await view(first, 2027));
    expect(v.flags.find((f) => f.code === 'UNATTRIBUTED_ITEMS')).toBeDefined();
    expect(v.notAttributed.items.every((i) => i.lineAmount === null && i.share === null)).toBe(true);
    // Never summed: the retained amounts are in no total.
    expect(v.einnahmen.lines.find((l) => l.taxCategory === 'RETAINED_DEPOSIT_RENT')?.items).toEqual([]);
    expect(await view(first, 2026).then((o) => viewOf(o).notAttributed.items)).toEqual([]);
  });

  it('a deposit returned in full, without a reconciled rent, is not attributed anywhere: nothing was retained (review on #170)', async () => {
    const pr = await propertyReference();
    const deposit = await returned(nextTenant());
    const v = viewOf(await view(pr, 2027));
    expect(v.notAttributed.items.map((i) => i.sourceId)).not.toContain(deposit);
  });

  it('a VOID Ownership counts nowhere: not among the owners, and its Party is not an owner in the year (review on #170)', async () => {
    const pr = await propertyReference();
    const [anna, voided] = [await party('Anna'), await party('Storniert')];
    await owner(pr, anna, [1, 2], '2020-01-01');
    const wrong = await owner(pr, voided, [1, 2], '2020-01-01');
    const outcome = await ownerships.void(wrong, REALM, 'falsch erfasst', new Date('2026-10-30T10:00:00Z'), actor);
    expect(outcome.kind).toBe('VOIDED');
    await rent(pr, nextTenant(), '2027-03-01', '2027030100');
    const v = viewOf(await view(pr, 2027));
    expect(v.owners?.map((o) => o.ownerPartyId)).toEqual([anna]);
    expect(v.notOwned).not.toBeNull();
    expect(await view(pr, 2027, voided)).toEqual({ kind: 'NOT_AN_OWNER_IN_YEAR' });
  });

  /** A Loan from 2026-01-01 without terms; with `allocatedTo`, a VALID MANUAL set from that day, 1/1 onto it. */
  async function loan(allocatedTo: string | null) {
    const created = await loans.create(
      {
        mreRealmId: REALM,
        lenderPartyId: await party('Bank Beispiel'),
        borrowerPartyIds: [await party('Anna Darlehensnehmerin')],
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
    if (allocatedTo === null) return { loanId: created.loan.id, setId: null };
    const set = await allocations.create(
      created.loan.id,
      REALM,
      {
        validFrom: day('2026-01-01'),
        basis: 'MANUAL',
        allocations: [{ propertyReferenceId: allocatedTo, share: { numerator: 1n, denominator: 1n }, acquisitionId: null }],
        notes: null,
      },
      actor,
    );
    if (set.kind !== 'CREATED') throw new Error(set.kind);
    return { loanId: created.loan.id, setId: set.set.id };
  }
  const interestOf = (loanId: string, amount: string, bookingDate: string, options: { confirm?: boolean } = {}) =>
    booked([split(amount, 'LOAN_INTEREST', { loanId })], { bookingDate, ...options });
  const loanFlag = (v: TaxYearView) => v.flags.find((f) => f.code === 'LOAN_INTEREST_NOT_ATTRIBUTED')?.details;

  it('LOAN_INTEREST_NOT_ATTRIBUTED: the counting interest of the year of a Loan allocated to the PropertyReference, by §58A’s year; summed nowhere (review on #171)', async () => {
    const [pr, elsewhere] = [await propertyReference(), await propertyReference()];
    const anna = await party('Anna Eigentümerin');
    await owner(pr, anna, [1, 1], '2020-01-01');
    const allocated = await loan(pr);
    const other = await loan(elsewhere);
    const unallocated = await loan(null);
    const voided = await loan(pr);
    const counted = (await interestOf(allocated.loanId, '612.37', '2027-03-20')).splitId;
    const second = (await interestOf(allocated.loanId, '0.01', '2027-06-20')).splitId;
    // Not of 2027: booked in 2026; booked on 2027-12-30 and overridden to 2028 (§58A).
    const earlier = (await interestOf(allocated.loanId, '50.00', '2026-06-20')).splitId;
    const moved = (await interestOf(allocated.loanId, '70.00', '2027-12-30')).splitId;
    await classify(moved, { taxCategory: 'LOAN_INTEREST', treatment: 'DEDUCTIBLE', taxYear: 2028 });
    // Not counting: a Transaction not confirmed; one corrected away (the original CORRECTED, its reversal a REVERSAL).
    await interestOf(allocated.loanId, '80.00', '2027-04-20', { confirm: false });
    const reversed = await interestOf(allocated.loanId, '90.00', '2027-05-20');
    expect((await corrections.correct(reversed.tx, REALM, { reason: 'falsch', replacement: null }, actor)).kind).toBe('CORRECTED');
    // Not interest: principal of the allocated Loan.
    await booked([split('887.63', 'LOAN_PRINCIPAL', { loanId: allocated.loanId })], { bookingDate: '2027-03-20' });
    // Not allocated here: a Loan allocated to another PropertyReference, one without a set, one whose set is VOID.
    const elsewhereInterest = (await interestOf(other.loanId, '40.00', '2027-03-20')).splitId;
    await interestOf(unallocated.loanId, '30.00', '2027-03-20');
    expect((await allocations.void(voided.loanId, voided.setId as string, REALM, 'falsch erfasst', new Date('2026-10-30T10:00:00Z'), actor)).kind).toBe(
      'VOIDED',
    );
    await interestOf(voided.loanId, '20.00', '2027-03-20');

    for (const v of [viewOf(await view(pr, 2027)), viewOf(await view(pr, 2027, anna))]) {
      expect(loanFlag(v)).toEqual({ loanIds: [allocated.loanId], interestTotal: { amount: '612.38', currency: 'EUR' }, splitIds: [counted, second].sort() });
      expect(v.review.open).toContainEqual({ code: 'LOAN_INTEREST_NOT_ATTRIBUTED', count: 1 });
      expect([v.werbungskosten.total.amount, v.result.amount.amount]).toEqual(['0.00', '0.00']);
      expect(placedItems(v)).toEqual([]);
    }
    expect(loanFlag(viewOf(await view(pr, 2026)))).toEqual({
      loanIds: [allocated.loanId],
      interestTotal: { amount: '50.00', currency: 'EUR' },
      splitIds: [earlier],
    });
    expect(loanFlag(viewOf(await view(pr, 2028)))).toEqual({
      loanIds: [allocated.loanId],
      interestTotal: { amount: '70.00', currency: 'EUR' },
      splitIds: [moved],
    });
    expect(loanFlag(viewOf(await view(elsewhere, 2027)))).toEqual({
      loanIds: [other.loanId],
      interestTotal: { amount: '40.00', currency: 'EUR' },
      splitIds: [elsewhereInterest],
    });
    expect(loanFlag(viewOf(await view(await propertyReference(), 2027)))).toBeUndefined();
  });

  it('the cap: 5,000 items (notInView counted) → the view; 5,001 → TAX_YEAR_TOO_LARGE', { timeout: 60_000 }, async () => {
    const pr = await propertyReference();
    const bulk = async (n: number) => {
      await pool.query(
        `WITH t AS (
           INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by)
           SELECT $1, $2, 1, 'EUR', 'INFLOW', date '2027-03-01' + (g % 200), 'MANUAL', 'UNREVIEWED', 'x' FROM generate_series(1, $3::int) g RETURNING id)
         INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, created_by)
         SELECT t.id, $1, 1, 1, 'EUR', (SELECT id FROM financial_category WHERE code = 'OWNER_CONTRIBUTION'), $4, 'x' FROM t`,
        [REALM, giro.get(REALM), n, pr],
      );
      await pool.query(
        `UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', version = version + 1
          WHERE status = 'UNREVIEWED' AND id IN (SELECT transaction_id FROM transaction_split WHERE property_reference_id = $1)`,
        [pr],
      );
    };
    // The Realm's deposits without a PropertyReference count too (NO_RECONCILED_RENT: in every view of the Realm).
    const unattributed = viewOf(await view(pr, 2027)).notAttributed.items.length;
    await bulk(5000 - unattributed);
    const at5000 = viewOf(await view(pr, 2027));
    expect(at5000.notInView.items.length + at5000.notAttributed.items.length).toBe(5000);
    await bulk(1);
    expect(await view(pr, 2027)).toEqual({ kind: 'TAX_YEAR_TOO_LARGE', itemCount: 5001, limit: 5000 });
  });

  it('one snapshot: a classification committed while the view’s transaction waits is not seen', async () => {
    const pr = await propertyReference();
    const repair = await one(pr, '600.00', 'MAINTENANCE', '2027-05-01');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      // The read takes its snapshot with the PropertyReference, then waits on the WEG memberships, before the classifications.
      await holder.query('LOCK TABLE weg_membership IN ACCESS EXCLUSIVE MODE');
      const reading = read(pr, 2027);
      const deadline = Date.now() + 5_000;
      while (
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%weg_membership%' AND pid <> pg_backend_pid()`,
            )
          ).rows[0].count,
        ) < 1
      ) {
        if (Date.now() > deadline) throw new Error('the read does not wait');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await classify(repair, { treatment: 'CAPITALIZED' });
      await holder.query('ROLLBACK');
      const r = await reading;
      const before = viewOf(buildTaxYearView(r as NonNullable<typeof r>, { year: 2027, ownerPartyId: null, today, registry: TAX_RULES }));
      expect(before.werbungskosten.lines.find((l) => l.taxCategory === 'MAINTENANCE')?.items.map((i) => [i.sourceId, i.origin])).toEqual([[repair, 'DEFAULT']]);
      expect(viewOf(await view(pr, 2027)).capitalized.items.map((i) => i.sourceId)).toEqual([repair]);
    } finally {
      holder.release();
    }
  });

  it('the plan of the split query uses transaction_split_property_reference_idx', { timeout: 60_000 }, async () => {
    const sent: CompiledQuery[] = [];
    const logged = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === 'query') sent.push(event.query);
      },
    });
    const prs = (
      await pool.query(
        `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by)
         SELECT $1, lpad(to_hex(9000000 + g), 24, '0'), 'ACTIVE', 'x' FROM generate_series(1, 80) g RETURNING id`,
        [REALM],
      )
    ).rows.map((r) => r.id as string);
    await pool.query(
      `WITH t AS (
         INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by)
         SELECT $1, $2, 1, 'EUR', 'INFLOW', date '2026-01-01' + (g % 700), 'MANUAL', 'UNREVIEWED', 'x' FROM generate_series(1, 16000) g RETURNING id)
       INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, created_by)
       SELECT t.id, $1, 1, 1, 'EUR', (SELECT id FROM financial_category WHERE code = 'OWNER_CONTRIBUTION'),
              ($3::uuid[])[1 + (row_number() OVER ()) % 80], 'x' FROM t`,
      [REALM, giro.get(REALM), prs],
    );
    await pool.query(`ANALYZE transaction_split; ANALYZE ledger_transaction`);
    sent.length = 0;
    await new PostgresTaxClassificationRepository(logged).readTaxYear(prs[7] as string, REALM, 2027, null, today);
    const query = sent.find((q) => q.sql.includes('"s"."property_reference_id" = $') && q.sql.includes('"t"."booking_date" >='));
    if (query === undefined) throw new Error('the split query was not sent');
    const { rows } = await pool.query(`EXPLAIN (FORMAT JSON) ${query.sql}`, [...query.parameters]);
    expect(JSON.stringify(rows[0]['QUERY PLAN'])).toContain('transaction_split_property_reference_idx');
  });

  it('0048: the index is there; down drops it, up adds it again (under MIGRATION_ADVISORY_LOCK)', { timeout: 30_000 }, async () => {
    const downSchema = testSchemaName('tax_year_view_down_test');
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${downSchema}"`);
    await admin.end();
    const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
    try {
      await migrateToLatest(downPool, { migrationTableSchema: downSchema });
      const definition = async () =>
        (
          await downPool.query(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'transaction_split_property_reference_idx'`, [downSchema])
        ).rows.map((r) => r.indexdef as string);
      const [def] = await definition();
      expect(def).toContain('(property_reference_id, transaction_id)');
      expect(def).toContain('WHERE (property_reference_id IS NOT NULL)');
      const migration = await import('./migrations/0048_tax_year_view.js');
      await withMigrationLock(() => migration.down(createDatabase(downPool) as never));
      expect(await definition()).toEqual([]);
      // Nothing else changed: no table, column or trigger of transaction_split went with it.
      const triggers = await downPool.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'transaction_split'::regclass AND NOT tgisinternal`);
      expect(triggers.rows[0].n).toBeGreaterThan(0);
      await withMigrationLock(() => migration.up(createDatabase(downPool) as never));
      expect(await definition()).toHaveLength(1);
    } finally {
      await downPool.end();
    }
  });

  it('no cash mutated: every row and version unchanged, no AuditRecord, by views at both levels and of three years; a write inside the view’s transaction is refused', async () => {
    const ids = await fixture();
    await retained(nextTenant());
    const before = await rowsSnapshot(pool);
    for (const year of [2026, 2027, 2028]) {
      viewOf(await view(ids.pr, year));
      viewOf(await view(ids.pr, year, ids.anna));
    }
    expect(await rowsSnapshot(pool)).toEqual(before);
    // The mechanism: the view's transaction is READ ONLY.
    const refused = await taxYearSnapshot(db, (trx) => sql`UPDATE ledger_transaction SET description = description WHERE false`.execute(trx)).then(
      () => 'accepted',
      (error: { code?: string }) => error.code,
    );
    expect(refused).toBe('25006');
    const inserted = await taxYearSnapshot(db, (trx) =>
      trx.insertInto('audit_record').values({ entity_type: 'X', entity_id: 'x', action: 'X', actor_type: 'SYSTEM', actor_id: null, metadata: null }).execute(),
    ).then(
      () => 'accepted',
      (error: { code?: string }) => error.code,
    );
    expect(inserted).toBe('25006');
  });

  it('Realm isolation and the owner: unknown or foreign → undefined; a foreign Party reads as unknown', async () => {
    const pr = await propertyReference();
    const foreignPr = await propertyReference(OTHER_REALM);
    expect(await read(foreignPr, 2027)).toBeUndefined();
    expect(await read('nope', 2027)).toBeUndefined();
    const foreignParty = await party('Fremd', OTHER_REALM);
    expect((await read(pr, 2027, foreignParty))?.ownerPartyFound).toBe(false);
    expect((await read(pr, 2027, 'nope'))?.ownerPartyFound).toBe(false);
    const local = await party('Ben');
    expect((await read(pr, 2027, local))?.ownerPartyFound).toBe(true);
    expect(await view(pr, 2027, local)).toEqual({ kind: 'NOT_AN_OWNER_IN_YEAR' });
  });
});
