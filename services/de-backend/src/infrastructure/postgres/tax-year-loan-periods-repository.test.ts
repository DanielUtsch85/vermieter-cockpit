import { sha256Fingerprinter as fingerprinter } from '../hashing/index.js';
import type { Kysely } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRate, type AllocationRequest } from '../../domains/financing/index.js';
import type { SplitInput } from '../../domains/ledger/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { buildTaxYearView, partOn, type NewTaxClassification, type TaxYearView } from '../../domains/taxation/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import { PostgresLoanAllocationRepository } from './loan-allocation-repository.js';
import { loanPeriodFactsOf } from './loan-interest-periods.js';
import { PostgresLoanRepository } from './loan-repository.js';
import { PostgresLoanTermsRepository } from './loan-terms-repository.js';
import { migrateToLatest } from './migrate.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { PostgresPartyRepository } from './party-repository.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { reasonOf } from './tax-weg.test-support.js';
import { rowsSnapshot } from './tax-year-view.test-support.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-X-40 persistence (api-design.md §58L; migration 0069; Entscheidung des Projektinhabers, 2026-11-04, L1–L12): the
 * interest period read in the view's snapshot (each candidate Loan's `VALID` terms, schedule and `debtFrom`, in the
 * Realm), Example 1 and Example 3 through the real read, the view's and `partOn`'s parts equal, the recorded
 * `interestPeriod` on the classification (Example 2, its AuditRecord, its refusals, and the 10-day rule ignoring it),
 * 0069 past the repository (each guard with its counter-check), reading writes nothing, and Realm isolation. Synthetic.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee000000000000f1';
const OTHER_REALM = '64b0c0ffee000000000000f2';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const today = day('2026-11-05');
const UUID = /^[0-9a-f-]{36}$/;
let counter = 0;

const viewOf = (outcome: ReturnType<typeof buildTaxYearView>): TaxYearView => {
  if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
  return outcome.view;
};
const interestItems = (v: TaxYearView) => v.werbungskosten.lines.find((l) => l.taxCategory === 'LOAN_INTEREST')?.items ?? [];

describe.skipIf(databaseUrl === undefined)('loan interest by periods of use in the tax-year view (§58L, migration 0069)', () => {
  const schema = testSchemaName('tax_year_loan_periods_test');
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let classifications: PostgresTaxClassificationRepository;
  let transactions: PostgresTransactionRepository;
  let splits: PostgresTransactionSplitRepository;
  let parties: PostgresPartyRepository;
  let loans: PostgresLoanRepository;
  let terms: PostgresLoanTermsRepository;
  let allocations: PostgresLoanAllocationRepository;
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
    parties = new PostgresPartyRepository(db);
    loans = new PostgresLoanRepository(db);
    terms = new PostgresLoanTermsRepository(db);
    allocations = new PostgresLoanAllocationRepository(db);
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
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5fb0000n + BigInt(++counter)).toString(16).padStart(24, '0');
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
    const o = await new PostgresOwnershipRepository(db).create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        ownerPartyId: partyId,
        share: { numerator: share[0], denominator: share[1] },
        validFrom: day('2026-01-01'),
        validUntil: null,
        acquisitionId: null,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (o.kind !== 'CREATED') throw new Error(o.kind);
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
  async function booked(set: SplitInput[], bookingDate: string, realm = REALM) {
    const created = await transactions.createManual(
      {
        mreRealmId: realm,
        financialAccountId: giro.get(realm) as string,
        amount: set.reduce((sum, s) => sum.add(s.amount), eur('0.00')),
        direction: 'OUTFLOW',
        bookingDate: day(bookingDate),
        valueDate: null,
        description: 'Zinsbelastung',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const tx = created.transaction.id;
    const outcome = await splits.replaceSplits(tx, realm, set, actor);
    if (outcome.kind !== 'REPLACED') throw new Error(JSON.stringify(outcome));
    expect((await transactions.confirm(tx, realm, actor)).kind).toBe('CONFIRMED');
    const { rows } = await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [tx]);
    return rows[0].id as string;
  }
  const interestOf = (loanId: string, amount: string, bookingDate: string, realm = REALM) =>
    booked([split(amount, 'LOAN_INTEREST', { loanId })], bookingDate, realm);
  const classify = (sourceId: string, overrides: Partial<NewTaxClassification>, realm = REALM) =>
    classifications.createClassification(
      {
        mreRealmId: realm,
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
  const manual = (validFrom: string, entries: readonly (readonly [string, string])[]): AllocationRequest => ({
    validFrom: day(validFrom),
    basis: 'MANUAL',
    allocations: entries.map(([propertyReferenceId, share]) => {
      const [n, d] = share.split('/') as [string, string];
      return { propertyReferenceId, share: { numerator: BigInt(n), denominator: BigInt(d) }, acquisitionId: null };
    }),
    notes: null,
  });
  /** A Loan from `startDate`, with monthly interest-only terms from `firstPaymentDate` (or none) and its sets. */
  async function loan(startDate: string, firstPaymentDate: string | null, sets: readonly AllocationRequest[], realm = REALM) {
    const created = await loans.create(
      {
        mreRealmId: realm,
        lenderPartyId: await party('Bank Beispiel', realm),
        borrowerPartyIds: [await party('Anna Darlehensnehmerin', realm)],
        principalOriginal: eur('120000.00'),
        startDate: day(startDate),
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
    const loanId = created.loan.id;
    if (firstPaymentDate !== null) {
      const added = await terms.create(
        loanId,
        realm,
        {
          validFrom: day(startDate),
          interestRate: parseRate('3.000') as bigint,
          repaymentModel: 'INTEREST_ONLY',
          scheduledPayment: null,
          firstPaymentDate: day(firstPaymentDate),
          principalAtStart: null,
          fixedRateUntil: null,
          initialRepaymentRate: null,
          specialRepaymentLimit: null,
          notes: null,
        },
        actor,
      );
      if (added.kind !== 'CREATED') throw new Error(added.kind);
    }
    const setIds: string[] = [];
    for (const request of sets) {
      const outcome = await allocations.create(loanId, realm, request, actor);
      if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
      setIds.push(outcome.set.id);
    }
    return { loanId, setIds };
  }
  const read = async (pr: string, year: number, ownerPartyId: string | null = null, realm = REALM) => {
    const r = await classifications.readTaxYear(pr, realm, year, ownerPartyId, today);
    if (r === undefined) throw new Error('no PropertyReference');
    return r;
  };
  const view = async (pr: string, year: number, ownerPartyId: string | null = null, realm = REALM) =>
    viewOf(buildTaxYearView(await read(pr, year, ownerPartyId, realm), { year, ownerPartyId, today, registry: TAX_RULES, fingerprinter }));
  const parts = (v: TaxYearView) => interestItems(v).map((i) => [i.sourceId, i.lineAmount?.amount]);
  const properties = async () => {
    const [p1, p2] = [await propertyReference(), await propertyReference()].sort() as [string, string];
    const [a, b] = [await party('Eigentümerin A'), await party('Eigentümer B')].sort() as string[] as [string, string];
    await owner(p1, a, [1, 2]);
    await owner(p1, b, [1, 2]);
    await owner(p2, await party('Eigentümerin C'), [1, 1]);
    return { p1, p2, a, b };
  };

  it('Example 1 through the real read: P1 230.00 and 150.00, P2 80.00 and 150.00, the owners A 115.00 and B 115.00; partOn equals the view', async () => {
    const { p1, p2, a, b } = await properties();
    const l = await loan('2027-01-01', '2027-01-31', [
      manual('2027-01-01', [[p1, '1/1']]),
      manual('2027-03-16', [
        [p1, '1/2'],
        [p2, '1/2'],
      ]),
    ]);
    const march = await interestOf(l.loanId, '310.00', '2027-03-31');
    const april = await interestOf(l.loanId, '300.00', '2027-04-30');
    const snapshot = await rowsSnapshot(pool);
    const [v1, v2] = [await view(p1, 2027), await view(p2, 2027)];
    expect(parts(v1)).toEqual([
      [march, '230.00'],
      [april, '150.00'],
    ]);
    expect(parts(v2)).toEqual([
      [march, '80.00'],
      [april, '150.00'],
    ]);
    expect(interestItems(v1)[0]?.loanAllocation).toMatchObject({
      share: '23/31',
      allocationSetId: null,
      interestPeriod: { from: '2027-03-01', until: '2027-03-31', source: 'LOAN_SCHEDULE' },
      segments: [
        { from: '2027-03-01', until: '2027-03-15', allocationSetId: l.setIds[0], share: '1/1' },
        { from: '2027-03-16', until: '2027-03-31', allocationSetId: l.setIds[1], share: '1/2' },
      ],
    });
    expect(interestItems(await view(p1, 2027, a)).map((i) => i.lineAmount?.amount)).toEqual(['115.00', '75.00']);
    expect(interestItems(await view(p1, 2027, b)).map((i) => i.lineAmount?.amount)).toEqual(['115.00', '75.00']);
    // §58G's partOn over the same read: the view's figures, at every candidate (one function).
    for (const pr of [p1, p2]) {
      const r = await read(pr, 2027);
      const loanParts = r.parts?.loans.find((x) => x.loanId === l.loanId);
      const valid = (loanParts?.sets ?? []).map((h) => h.set).filter((s) => s.status === 'VALID');
      const v = pr === p1 ? v1 : v2;
      for (const c of loanParts?.candidates ?? []) {
        expect(partOn(pr, valid, c).part?.amount).toBe(interestItems(v).find((i) => i.sourceId === c.sourceId)?.lineAmount?.amount);
      }
    }
    // History: the terms and the sets with their own AuditRecords as today; the views wrote nothing.
    const actions = await pool.query(`SELECT entity_type, action FROM audit_record WHERE entity_id = ANY($1::text[]) ORDER BY entity_type, action`, [
      [...l.setIds],
    ]);
    expect(actions.rows).toEqual([
      { entity_type: 'LoanAllocationSet', action: 'CREATED' },
      { entity_type: 'LoanAllocationSet', action: 'CREATED' },
    ]);
    expect(
      Number(
        (
          await pool.query(
            `SELECT count(*) AS n FROM audit_record WHERE entity_type = 'LoanTerms' AND action = 'CREATED' AND entity_id IN (SELECT id::text FROM loan_terms WHERE loan_id = $1)`,
            [l.loanId],
          )
        ).rows[0].n,
      ),
    ).toBe(1);
    expect(await rowsSnapshot(pool)).toEqual(snapshot);
  });

  it('Example 3 through the real read: clipped at debtFrom P1 81.00; with the first set from 2027-03-20 not attributed with the uncovered days', async () => {
    const { p1 } = await properties();
    const covered = await loan('2027-03-16', '2027-03-31', [manual('2027-03-16', [[p1, '1/1']])]);
    const late = await loan('2027-03-16', '2027-03-31', [manual('2027-03-20', [[p1, '1/1']])]);
    const ok = await interestOf(covered.loanId, '81.00', '2027-03-31');
    const gap = await interestOf(late.loanId, '81.00', '2027-03-31');
    const v = await view(p1, 2027);
    expect(parts(v)).toEqual([[ok, '81.00']]);
    expect(interestItems(v)[0]?.loanAllocation?.interestPeriod).toEqual({ from: '2027-03-16', until: '2027-03-31', source: 'LOAN_SCHEDULE' });
    expect(v.notAttributed.items.map((i) => [i.sourceId, i.notAttributed?.reason, i.notAttributed?.uncovered])).toEqual([
      [gap, 'NO_LOAN_ALLOCATION', [{ from: '2027-03-16', until: '2027-03-19' }]],
    ]);
    expect(v.flags.find((f) => f.code === 'LOAN_INTEREST_NOT_ATTRIBUTED')?.details).toEqual({
      loanIds: [late.loanId],
      interestTotal: { amount: '81.00', currency: 'EUR' },
      splitIds: [gap],
    });
  });

  it('a Loan without terms (rule 8): by the booking date with INTEREST_PERIOD_UNKNOWN, informative with one VALID set', async () => {
    const { p1 } = await properties();
    const l = await loan('2027-01-01', null, [manual('2027-01-01', [[p1, '1/1']])]);
    const s = await interestOf(l.loanId, '450.00', '2027-05-31');
    const v = await view(p1, 2027);
    expect(parts(v)).toEqual([[s, '450.00']]);
    expect(interestItems(v)[0]?.flags).toContainEqual({
      code: 'INTEREST_PERIOD_UNKNOWN',
      details: { loanId: l.loanId, reason: 'NO_SCHEDULE', validAllocationSets: 1 },
    });
    expect(v.review.info).toContainEqual({ code: 'INTEREST_PERIOD_UNKNOWN', count: 1 });
  });

  it('Example 2 with the recorded period (L4): P1 2,730.00, P2 920.00; stored, audited and replayed; the 10-day rule ignores it', async () => {
    const { p1, p2 } = await properties();
    const l = await loan('2026-01-01', '2026-01-31', [manual('2026-01-01', [[p1, '1/1']]), manual('2027-10-01', [[p2, '1/1']])]);
    const s = await interestOf(l.loanId, '3650.00', '2027-12-30');
    expect([parts(await view(p1, 2027)), parts(await view(p2, 2027))]).toEqual([[], [[s, '3650.00']]]);
    const created = await classify(s, { interestPeriod: { from: day('2027-01-01'), until: day('2027-12-31') } }, REALM);
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    expect(created.classification.interestPeriod).toEqual({ from: '2027-01-01', until: '2027-12-31' });
    const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'TAX_CLASSIFIED'`, [created.classification.id]);
    expect(audit.rows[0].metadata.interestPeriod).toEqual({ from: '2027-01-01', until: '2027-12-31' });
    expect([parts(await view(p1, 2027)), parts(await view(p2, 2027))]).toEqual([[[s, '2730.00']], [[s, '920.00']]]);
    expect(interestItems(await view(p1, 2027))[0]?.loanAllocation?.interestPeriod).toEqual({
      from: '2027-01-01',
      until: '2027-12-31',
      source: 'CLASSIFICATION',
    });

    // Booked 2028-01-05: the schedule's due date 2027-12-31 moves it into 2027; the recorded January 2028 only allocates it.
    const m = await loan('2026-01-01', '2026-01-31', [manual('2026-01-01', [[p1, '1/1']]), manual('2028-01-16', [[p2, '1/1']])]);
    const jan = await interestOf(m.loanId, '310.00', '2028-01-05');
    expect((await classify(jan, { interestPeriod: { from: day('2028-01-01'), until: day('2028-01-31') } })).kind).toBe('CREATED');
    const y1 = await view(p1, 2027);
    const item = interestItems(y1).find((i) => i.sourceId === jan);
    expect([item?.taxYear, item?.lineAmount?.amount, item?.flags.map((f) => f.code)]).toEqual([2027, '150.00', ['ATTRIBUTED_BY_10_DAY_RULE']]);
    expect(interestItems(await view(p2, 2027)).find((i) => i.sourceId === jan)?.lineAmount?.amount).toBe('160.00');
    expect(interestItems(await view(p1, 2028)).find((i) => i.sourceId === jan)).toBeUndefined();
  });

  it('the recorded period is refused off a Loan interest split (NOT_SUPPORTED at interestPeriod); counter-check accepted', async () => {
    const pr = await propertyReference();
    const l = await loan('2027-01-01', '2027-01-31', [manual('2027-01-01', [[pr, '1/1']])]);
    const period = { interestPeriod: { from: day('2027-03-01'), until: day('2027-03-31') } };
    const insurance = await booked([split('80.00', 'INSURANCE', { propertyReferenceId: pr })], '2027-03-31');
    expect(await classify(insurance, { taxCategory: 'INSURANCE', ...period })).toEqual({ kind: 'FIELD_NOT_SUPPORTED', field: 'interestPeriod' });
    const principal = await booked([split('500.00', 'LOAN_PRINCIPAL', { loanId: l.loanId })], '2027-03-31');
    expect(await classify(principal, { taxCategory: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', ...period })).toEqual({
      kind: 'FIELD_NOT_SUPPORTED',
      field: 'interestPeriod',
    });
    expect((await classify(await interestOf(l.loanId, '310.00', '2027-03-31'), period)).kind).toBe('CREATED');
  });

  it('only VALID terms make the schedule: a VOID later period due on the 15th is never read; counter-check: the same terms VALID give the other period', async () => {
    const { p1, p2 } = await properties();
    const sets = [
      manual('2027-01-01', [[p1, '1/1']]),
      manual('2027-03-16', [
        [p1, '1/2'],
        [p2, '1/2'],
      ]),
    ];
    /** Example 1's Loan (terms from 2027-01-01, due on the last day) and a second period from 2027-02-01, due on the 15th. */
    const withSecondTerms = async () => {
      const l = await loan('2027-01-01', '2027-01-31', sets);
      const added = await terms.create(
        l.loanId,
        REALM,
        {
          validFrom: day('2027-02-01'),
          interestRate: parseRate('3.000') as bigint,
          repaymentModel: 'INTEREST_ONLY',
          scheduledPayment: null,
          firstPaymentDate: day('2027-02-15'),
          principalAtStart: null,
          fixedRateUntil: null,
          initialRepaymentRate: null,
          specialRepaymentLimit: null,
          notes: null,
        },
        actor,
      );
      if (added.kind !== 'CREATED') throw new Error(added.kind);
      return { ...l, termsId: added.terms.id };
    };
    const voided = await withSecondTerms();
    expect((await terms.void(voided.loanId, voided.termsId, REALM, 'falsch erfasst (synthetisch)', new Date('2027-02-10T10:00:00Z'), actor)).kind).toBe(
      'VOIDED',
    );
    const valid = await withSecondTerms();
    const fromVoided = await interestOf(voided.loanId, '310.00', '2027-03-31');
    const fromValid = await interestOf(valid.loanId, '310.00', '2027-03-31');
    const items = interestItems(await view(p1, 2027));
    const of = (splitId: string) => items.find((i) => i.sourceId === splitId);
    // The VOID period is ignored: monthly to the last day, 2027-03-01 – 2027-03-31 over S1 and S2, P1 230.00.
    expect(of(fromVoided)?.loanAllocation?.interestPeriod).toEqual({ from: '2027-03-01', until: '2027-03-31', source: 'LOAN_SCHEDULE' });
    expect(of(fromVoided)?.lineAmount?.amount).toBe('230.00');
    // Counter-check: VALID, the payment of 2027-04-15 is nearest, 2027-03-16 – 2027-04-15 wholly S2, P1 155.00.
    expect(of(fromValid)?.loanAllocation?.interestPeriod).toEqual({ from: '2027-03-16', until: '2027-04-15', source: 'LOAN_SCHEDULE' });
    expect(of(fromValid)?.lineAmount?.amount).toBe('155.00');
    const p2Parts = new Map(parts(await view(p2, 2027)).map(([id, amount]) => [id, amount] as const));
    expect([p2Parts.get(fromVoided), p2Parts.get(fromValid)]).toEqual(['80.00', '155.00']);
  });

  describe('0069 past the repository', () => {
    const insert = async (values: Record<string, unknown>, disableTriggers = false): Promise<string> => {
      const row: Record<string, unknown> = {
        mre_realm_id: REALM,
        source_type: 'TRANSACTION_SPLIT',
        tax_category: 'LOAN_INTEREST',
        treatment: 'DEDUCTIBLE',
        review_state: 'USER_CONFIRMED',
        rule_code: 'DE_CATEGORY_DEFAULTS',
        rule_version: 1,
        created_by: 'x',
        ...values,
      };
      const columns = Object.keys(row);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (disableTriggers) await client.query('ALTER TABLE tax_classification DISABLE TRIGGER USER');
        const { rows } = await client.query(
          `INSERT INTO tax_classification (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          Object.values(row),
        );
        await client.query(disableTriggers ? 'ROLLBACK' : 'COMMIT');
        return disableTriggers ? 'accepted' : (rows[0].id as string);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        return reasonOf(error as { message?: string });
      } finally {
        client.release();
      }
    };
    const interestSplit = async () => {
      const pr = await propertyReference();
      const l = await loan('2027-01-01', '2027-01-31', [manual('2027-01-01', [[pr, '1/1']])]);
      return interestOf(l.loanId, '100.00', '2027-03-31');
    };

    it('both ends or neither, from not after until (tax_classification_interest_period); counter-check: a one-day period and none accepted', async () => {
      const at = async (from: string | null, until: string | null) =>
        insert({ transaction_split_id: await interestSplit(), interest_period_from: from, interest_period_until: until });
      expect(await at('2027-03-01', null)).toBe('tax_classification_interest_period');
      expect(await at(null, '2027-03-31')).toBe('tax_classification_interest_period');
      expect(await at('2027-04-01', '2027-03-31')).toBe('tax_classification_interest_period');
      expect(await at('2027-03-31', '2027-03-31')).toMatch(UUID);
      expect(await at(null, null)).toMatch(UUID);
    });

    it('only on a split (the CHECK alone, guards off): a deposit source with a period is refused; counter-check: without one only its foreign key', async () => {
      const deposit = {
        source_type: 'DEPOSIT_CLOSING',
        security_deposit_id: '00000000-0000-4000-8000-0000000000aa',
        deposit_closing_date: '2027-03-31',
        deposit_retained_amount: '100.00',
        tax_category: 'OTHER_INCOME',
        treatment: 'INCOME',
      };
      expect(await insert({ ...deposit, interest_period_from: '2027-03-01', interest_period_until: '2027-03-31' }, true)).toBe(
        'tax_classification_interest_period',
      );
      expect(await insert(deposit, true)).not.toBe('tax_classification_interest_period');
    });

    it('only on a Loan LOAN_INTEREST split (INTEREST_PERIOD_NOT_ALLOWED); counter-check: the same period on a Loan interest split accepted', async () => {
      const pr = await propertyReference();
      const l = await loan('2027-01-01', '2027-01-31', [manual('2027-01-01', [[pr, '1/1']])]);
      const period = { interest_period_from: '2027-03-01', interest_period_until: '2027-03-31' };
      const insurance = await booked([split('80.00', 'INSURANCE', { propertyReferenceId: pr })], '2027-03-31');
      expect(await insert({ transaction_split_id: insurance, tax_category: 'INSURANCE', ...period })).toBe('(INTEREST_PERIOD_NOT_ALLOWED)');
      const principal = await booked([split('500.00', 'LOAN_PRINCIPAL', { loanId: l.loanId })], '2027-03-31');
      expect(await insert({ transaction_split_id: principal, tax_category: 'NOT_RELEVANT', treatment: 'NOT_RELEVANT', ...period })).toBe(
        '(INTEREST_PERIOD_NOT_ALLOWED)',
      );
      expect(await insert({ transaction_split_id: insurance, tax_category: 'INSURANCE' })).toMatch(UUID);
      expect(await insert({ transaction_split_id: await interestOf(l.loanId, '310.00', '2027-03-31'), ...period })).toMatch(UUID);
    });

    it('the period never changes (the frozen guard covers it); counter-check: a version step alone passes', async () => {
      const id = await insert({ transaction_split_id: await interestSplit(), interest_period_from: '2027-03-01', interest_period_until: '2027-03-31' });
      const update = async (set: string) =>
        pool.query(`UPDATE tax_classification SET ${set} WHERE id = $1`, [id]).then(
          () => 'accepted',
          (error: { message?: string }) => reasonOf(error),
        );
      expect(await update(`interest_period_until = '2027-04-30', version = version + 1`)).toBe('never change');
      expect(await update(`interest_period_from = NULL, interest_period_until = NULL, version = version + 1`)).toBe('never change');
      expect(await update(`version = version + 1`)).toBe('accepted');
    });
  });

  it('Realm isolation: another Realm Loan with the same dates, sets and debits changes nothing here, and its terms are never read for this Realm', async () => {
    const { p1, p2 } = await properties();
    const sets = (a: string, b: string) => [
      manual('2027-01-01', [[a, '1/1']]),
      manual('2027-03-16', [
        [a, '1/2'],
        [b, '1/2'],
      ]),
    ];
    const here = await loan('2027-01-01', '2027-01-31', sets(p1, p2));
    const mine = await interestOf(here.loanId, '310.00', '2027-03-31');
    const before = [parts(await view(p1, 2027)), parts(await view(p2, 2027))];
    const [f1, f2] = [await propertyReference(OTHER_REALM), await propertyReference(OTHER_REALM)].sort() as [string, string];
    const foreign = await loan('2027-01-01', '2027-01-15', sets(f1, f2), OTHER_REALM);
    const theirs = await interestOf(foreign.loanId, '310.00', '2027-03-31', OTHER_REALM);
    expect([parts(await view(p1, 2027)), parts(await view(p2, 2027))]).toEqual(before);
    expect(before).toEqual([[[mine, '230.00']], [[mine, '80.00']]]);
    // Its own view takes its own terms (due on the 15th: 2027-03-16 – 2027-04-15, wholly its second set).
    expect(parts(await view(f1, 2027, null, OTHER_REALM))).toEqual([[theirs, '155.00']]);
    await db.transaction().execute(async (trx) => {
      expect([...(await loanPeriodFactsOf(trx, REALM, [foreign.loanId])).keys()]).toEqual([]);
      expect([...(await loanPeriodFactsOf(trx, OTHER_REALM, [foreign.loanId])).keys()]).toEqual([foreign.loanId]);
    });
    // Another Realm cannot record a period on this Realm's split.
    expect((await classify(mine, { interestPeriod: { from: day('2027-03-01'), until: day('2027-03-31') } }, OTHER_REALM)).kind).toBe('SOURCE_NOT_FOUND');
  });
});
