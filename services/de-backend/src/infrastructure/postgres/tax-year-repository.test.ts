import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseMea, type Mea, type NewAnnualStatement, type NewEconomicPlan } from '../../domains/weg/index.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrate.js';
import { testSchemaName } from './test-schema.test-support.js';
import type { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import type { PostgresRentalContractReferenceRepository } from './rental-contract-reference-repository.js';
import type { PostgresRentReconciliationRepository } from './rent-reconciliation-repository.js';
import type { PostgresSecurityDepositRepository } from './security-deposit-repository.js';
import type { PostgresWegRepository } from './weg-repository.js';
import type { PostgresWegEconomicPlanRepository } from './weg-economic-plan-repository.js';
import type { PostgresWegAnnualStatementRepository } from './weg-annual-statement-repository.js';
import type { PostgresLoanRepository } from './loan-repository.js';
import type { PostgresLoanTermsRepository } from './loan-terms-repository.js';
import type { PostgresPartyRepository } from './party-repository.js';
import {
  actor,
  codes,
  databaseUrl,
  day,
  due,
  eur,
  nextTenant,
  OTHER_REALM,
  REALM,
  reasonOf,
  splitsOf,
  UNKNOWN,
  useTaxYearDatabase,
  withMigrationLock,
} from './tax-year.test-support.js';

/**
 * VC-7-02 persistence (api-design.md §58A, migration 0046): the per-year list across the year-end in both directions,
 * with the due days of the RentalContractReference, the plan's `advanceDueDay` and the Loan's schedule; the override
 * and its refusals; every new guard past the repository (`advance_due_day` reads a plan of the Hausgeld tests, so both
 * stay in this file); and `down`. The deposit classifications with `reopen` stopping them, the RentalContractReference
 * (create, its order of checks, replay, amend, reads) and the serialisation of a deposit classification with a reopen
 * under RC and RR are in `tax-year-deposit.test.ts`; the setup is in `tax-year.test-support.ts`. Figures and names are
 * invented.
 */
let counter = 0;

describe.skipIf(databaseUrl === undefined)('Tax year and income (§58A)', () => {
  const { ctx, propertyReference, split, booked, rent, reference, request, list, meaning, retained } = useTaxYearDatabase('tax_year_test');
  let pool: pg.Pool;
  let classifications: PostgresTaxClassificationRepository;
  let references: PostgresRentalContractReferenceRepository;
  let reconciliations: PostgresRentReconciliationRepository;
  let deposits: PostgresSecurityDepositRepository;
  let wegs: PostgresWegRepository;
  let plans: PostgresWegEconomicPlanRepository;
  let statements: PostgresWegAnnualStatementRepository;
  let loans: PostgresLoanRepository;
  let terms: PostgresLoanTermsRepository;
  let parties: PostgresPartyRepository;
  beforeAll(() => {
    ({ pool, classifications, references, reconciliations, deposits, wegs, plans, statements, loans, terms, parties } = ctx);
  });

  describe('the tax year of rent (§58A)', () => {
    it('a January rent paid on 29 December: January’s year (assumed, then by day 3); day 15 moves it back; the list across the year-end', async () => {
      const pr = await propertyReference();
      const tenant = nextTenant();
      const january = await rent(pr, tenant, '2026-12-29', '2027010100');
      const december = await rent(pr, tenant, '2026-12-01', '2026120100');
      // A rent of 2 January for December, paid late: December's year, by the reference below.
      const late = await rent(pr, tenant, '2027-01-02', '2026120100');
      const before = await meaning(january);
      expect(before).toMatchObject({ taxYear: 2027, attribution: { bookingYear: 2026, proposedYear: 2027, overridden: false } });
      expect(codes(before?.flags)).toEqual(['DUE_DATE_ASSUMED', 'ATTRIBUTED_BY_10_DAY_RULE']);
      // Without a reference the December term's first day (1 December) lies outside the window: the late one stays in 2027.
      expect((await meaning(late))?.taxYear).toBe(2027);
      const ref = await reference(tenant, due([['2025-01-01', 3]]));
      expect(codes((await meaning(january))?.flags)).toEqual(['ATTRIBUTED_BY_10_DAY_RULE']);
      expect((await meaning(january))?.taxYear).toBe(2027);
      expect(splitsOf(await list(pr, 2026)).map((m) => m.splitId)).toEqual([december]);
      expect(splitsOf(await list(pr, 2027)).map((m) => m.splitId)).toEqual([january, late]);
      // Day 28: the December rent paid on 2 January is due on 28 December, inside the window: December's year. The
      // January rent is due on 28 January, outside it: the year paid. Both lists change, nothing is stored per split.
      await references.amendReference(ref.id, REALM, { rentDueDays: due([['2025-01-01', 28]]) }, actor);
      expect((await meaning(late))?.taxYear).toBe(2026);
      expect(splitsOf(await list(pr, 2026)).map((m) => m.splitId)).toEqual([december, january, late]);
      expect(splitsOf(await list(pr, 2027))).toEqual([]);
      // Day 15: the January rent is due outside the window, so it counts in the year paid.
      await references.amendReference(ref.id, REALM, { rentDueDays: due([['2025-01-01', 15]]) }, actor);
      expect(await meaning(january)).toMatchObject({ taxYear: 2026, flags: [] });
      expect(splitsOf(await list(pr, 2026)).map((m) => m.splitId)).toEqual([december, january]);
      expect(splitsOf(await list(pr, 2027)).map((m) => m.splitId)).toEqual([late]);
    });

    it('several terms on one Transaction, or none: no economic period, the booking year, flagged', async () => {
      const pr = await propertyReference();
      const tenant = nextTenant();
      const { tx, splitIds } = await booked([split('1800.00', 'RENT_BASE', { propertyReferenceId: pr })], { direction: 'INFLOW', bookingDate: '2026-12-30' });
      expect((await meaning(splitIds[0] as string))?.flags).toEqual([{ code: 'NO_ECONOMIC_PERIOD', details: { reason: 'NO_RECONCILIATION' } }]);
      for (const term of ['2026120100', '2027010100']) {
        const matched = await reconciliations.create(
          { mreRealmId: REALM, transactionId: tx, mreTenantId: tenant, mreRentTerm: term, matchedAmount: eur('900.00'), notes: null },
          actor,
        );
        expect(matched.kind).toBe('CREATED');
      }
      expect(await meaning(splitIds[0] as string)).toMatchObject({
        taxYear: 2026,
        flags: [{ code: 'NO_ECONOMIC_PERIOD', details: { reason: 'SEVERAL_TERMS' } }],
      });
    });
  });

  describe('Hausgeld and interest (§58A)', () => {
    async function member(advanceDueDay: number | null) {
      const weg = await wegs.createWeg(
        { mreRealmId: REALM, displayName: `WEG ${++counter}`, administratorPartyId: null, financialYearStartMonth: 1, notes: null },
        actor,
      );
      if (weg.kind !== 'CREATED') throw new Error(weg.kind);
      const pr = await propertyReference();
      const parsed = parseMea('125/10000');
      const m = await wegs.createMembership(
        {
          mreRealmId: REALM,
          wegId: weg.weg.id,
          propertyReferenceId: pr,
          mea: (parsed as { mea: Mea }).mea,
          validFrom: day('2026-01-01'),
          validUntil: null,
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (m.kind !== 'CREATED') throw new Error(m.kind);
      const plan: NewEconomicPlan = {
        mreRealmId: REALM,
        membershipId: m.membership.id,
        financialYear: 2026,
        effectiveFrom: day('2026-01-01'),
        resolutionDate: null,
        advanceDueDay,
        monthlyHausgeld: eur('300.00'),
        monthlyReserveContribution: eur('0.00'),
        recoverableCosts: eur('2400.00'),
        nonRecoverableCosts: eur('1200.00'),
        income: null,
        annualReserveContribution: null,
        costLines: [],
        sourceReferences: [],
        notes: null,
      };
      const created = await plans.createPlan(plan, actor);
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      expect(created.plan.advanceDueDay).toBe(advanceDueDay);
      return { pr, plan: created.plan };
    }

    it('a Hausgeld debit on 30 December with advanceDueDay 1 keeps its booking year, ECONOMIC_PERIOD_ASSUMED; the override moves it', async () => {
      const { pr } = await member(1);
      const { splitIds } = await booked([split('300.00', 'WEG_RECOVERABLE', { propertyReferenceId: pr })], { bookingDate: '2026-12-30' });
      const id = splitIds[0] as string;
      expect(await meaning(id)).toMatchObject({ taxYear: 2026, attribution: { proposedYear: 2027, overridden: false } });
      expect(codes((await meaning(id))?.flags)).toEqual(['ECONOMIC_PERIOD_ASSUMED']);
      const c = await classifications.createClassification(request(id, { taxCategory: 'WEG_HAUSGELD', treatment: 'DEDUCTIBLE', taxYear: 2027 }), actor);
      expect(c).toMatchObject({ kind: 'CREATED', classification: { taxYear: 2027, refundOfYear: null } });
      expect(await meaning(id)).toMatchObject({ taxYear: 2027, origin: 'CLASSIFICATION', attribution: { proposedYear: 2027, overridden: true } });
      expect(splitsOf(await list(pr, 2026))).toEqual([]);
      expect(splitsOf(await list(pr, 2027)).map((m) => m.splitId)).toEqual([id]);
      // Without advanceDueDay, day 1 is assumed.
      const assumed = await member(null);
      const other = await booked([split('300.00', 'WEG_NON_RECOVERABLE', { propertyReferenceId: assumed.pr })], { bookingDate: '2026-12-30' });
      expect(codes((await meaning(other.splitIds[0] as string))?.flags)).toEqual(['DUE_DATE_ASSUMED', 'ECONOMIC_PERIOD_ASSUMED']);
    });

    it('interest due on 30 December and debited on 4 January counts in December’s year; due 2 January, debited 30 December, in its own', async () => {
      const party = async (displayName: string) => {
        const p = await parties.create(
          {
            mreRealmId: REALM,
            partyType: 'PERSON',
            displayName,
            firstName: null,
            lastName: null,
            legalName: null,
            registrationNumber: null,
            email: null,
            phone: null,
          },
          actor,
        );
        if (p.kind !== 'CREATED') throw new Error(p.kind);
        return p.party.id;
      };
      const loanOf = async (firstPaymentDate: string) => {
        const created = await loans.create(
          {
            mreRealmId: REALM,
            lenderPartyId: await party('Bank'),
            borrowerPartyIds: [await party('Anna')],
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
        const t = await terms.create(
          created.loan.id,
          REALM,
          {
            validFrom: day('2026-01-01'),
            interestRate: 3000n,
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
        expect(t.kind).toBe('CREATED');
        return created.loan.id;
      };
      const thirtieth = await loanOf('2026-01-30');
      const back = await booked([split('250.00', 'LOAN_INTEREST', { loanId: thirtieth })], { bookingDate: '2027-01-04' });
      const moved = await meaning(back.splitIds[0] as string);
      expect(moved).toMatchObject({ taxYear: 2026, attribution: { bookingYear: 2027, proposedYear: 2026 } });
      expect(moved?.flags).toEqual([
        {
          code: 'ATTRIBUTED_BY_10_DAY_RULE',
          details: {
            bookingDate: '2027-01-04',
            dueDate: '2026-12-30',
            economicPeriod: { from: '2026-12-01', to: '2026-12-30' },
            dueDateSource: 'LOAN_SCHEDULE',
          },
        },
      ]);
      const second = await loanOf('2026-01-02');
      const early = await booked([split('250.00', 'LOAN_INTEREST', { loanId: second })], { bookingDate: '2026-12-30' });
      expect(await meaning(early.splitIds[0] as string)).toMatchObject({ taxYear: 2026, flags: [] });
      // Interest on a PropertyReference names no Loan: no schedule, the booking year, flagged.
      const pr = await propertyReference();
      const without = await booked([split('250.00', 'LOAN_INTEREST', { propertyReferenceId: pr })], { bookingDate: '2026-12-30' });
      expect((await meaning(without.splitIds[0] as string))?.flags).toEqual([{ code: 'NO_ECONOMIC_PERIOD', details: { reason: 'NO_LOAN' } }]);
    });
  });

  describe('override and refunds (§58A)', () => {
    it('a credit of a WEG annual statement, booked in the following year: a refund of the statement’s financialYear (review on #166)', async () => {
      const weg = await wegs.createWeg(
        { mreRealmId: REALM, displayName: `WEG ${++counter}`, administratorPartyId: null, financialYearStartMonth: 1, notes: null },
        actor,
      );
      if (weg.kind !== 'CREATED') throw new Error(weg.kind);
      const pr = await propertyReference();
      const m = await wegs.createMembership(
        {
          mreRealmId: REALM,
          wegId: weg.weg.id,
          propertyReferenceId: pr,
          mea: (parseMea('250/10000') as { mea: Mea }).mea,
          validFrom: day('2025-01-01'),
          validUntil: null,
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (m.kind !== 'CREATED') throw new Error(m.kind);
      const content: NewAnnualStatement = {
        mreRealmId: REALM,
        membershipId: m.membership.id,
        financialYear: 2025,
        periodFrom: day('2025-01-01'),
        periodUntil: day('2025-12-31'),
        documentDate: null,
        resolutionDate: null,
        dueDate: null,
        supersedes: null,
        costLines: [
          {
            position: 1,
            account: 'Hausmeister',
            group: 'RECOVERABLE',
            allocationKey: 'MEA',
            allocationTotal: null,
            allocationShare: null,
            totalAmount: eur('40000.00'),
            unitShare: eur('1000.00'),
            classification: null,
          },
        ],
        recoverableSubtotal: eur('1000.00'),
        nonRecoverableSubtotal: eur('0.00'),
        totalCosts: eur('1000.00'),
        hausgeldRequested: eur('1200.00'),
        hausgeldPaid: eur('1200.00'),
        reserveRequested: null,
        reservePaid: null,
        settlementPeak: eur('-200.00'),
        settlementResult: null,
        reserve: null,
        sourceReferences: [],
        notes: null,
      };
      const created = await statements.createStatement(content, actor);
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      const confirmed = await statements.confirmStatement(created.statement.id, REALM, new Date(), actor);
      if (confirmed.kind !== 'CONFIRMED') throw new Error(confirmed.kind);
      const { splitIds } = await booked([split('200.00', 'WEG_RECOVERABLE', { propertyReferenceId: pr, wegAnnualStatementId: created.statement.id })], {
        direction: 'INFLOW',
        bookingDate: '2026-05-12',
      });
      const credit = await meaning(splitIds[0] as string);
      expect(credit).toMatchObject({ taxYear: 2026, taxCategory: 'WEG_HAUSGELD', flags: [] });
      expect(credit?.refund).toEqual({
        kind: 'REFUND',
        ofYear: 2025,
        ofYearSource: 'WEG_ANNUAL_STATEMENT',
        presentation: 'INCOME',
        line: 'REFUNDS_OF_EARLIER_YEARS',
      });
      // The statement wins over a classification's refundOfYear.
      const c = await classifications.createClassification(
        request(splitIds[0] as string, { taxCategory: 'WEG_HAUSGELD', treatment: 'DEDUCTIBLE', refundOfYear: 2026 }),
        actor,
      );
      expect(c.kind).toBe('CREATED');
      expect((await meaning(splitIds[0] as string))?.refund).toMatchObject({ ofYear: 2025, ofYearSource: 'WEG_ANNUAL_STATEMENT', presentation: 'INCOME' });
    });

    it('taxYear ± 1 only (TAX_YEAR_OUT_OF_RANGE); refundOfYear ≤ the tax year (REFUND_YEAR_OUT_OF_RANGE); a refund of an earlier year', async () => {
      const pr = await propertyReference();
      const { splitIds } = await booked([split('80.00', 'INSURANCE', { propertyReferenceId: pr })], { direction: 'INFLOW', bookingDate: '2027-03-01' });
      const id = splitIds[0] as string;
      expect((await meaning(id))?.refund).toEqual({ kind: 'REFUND', ofYear: null, ofYearSource: null, presentation: 'REDUCES_LINE', line: 'INSURANCE' });
      expect(codes((await meaning(id))?.flags)).toEqual(['REFUND_YEAR_UNKNOWN']);
      const insurance = { taxCategory: 'INSURANCE', treatment: 'DEDUCTIBLE' } as const;
      expect(await classifications.createClassification(request(id, { ...insurance, taxYear: 2029 }), actor)).toEqual({
        kind: 'TAX_YEAR_OUT_OF_RANGE',
        taxYear: 2029,
        bookingYear: 2027,
      });
      expect(await classifications.createClassification(request(id, { ...insurance, refundOfYear: 2028 }), actor)).toEqual({
        kind: 'REFUND_YEAR_OUT_OF_RANGE',
        refundOfYear: 2028,
        taxYear: 2027,
      });
      const c = await classifications.createClassification(request(id, { ...insurance, refundOfYear: 2026 }), actor, {
        key: `k-${++counter}`,
        fingerprint: 'f',
      });
      if (c.kind !== 'CREATED') throw new Error(c.kind);
      expect((await meaning(id))?.refund).toEqual({
        kind: 'REFUND',
        ofYear: 2026,
        ofYearSource: 'CLASSIFICATION',
        presentation: 'INCOME',
        line: 'REFUNDS_OF_EARLIER_YEARS',
      });
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'TAX_CLASSIFIED'`, [c.classification.id]);
      expect(audit.rows[0].metadata).toMatchObject({ refundOfYear: 2026 });
    });
  });

  describe('schema past the repository (0046)', () => {
    const insertSplitClassification = (splitId: string, extra: { taxYear?: number | null; refundOfYear?: number | null } = {}) =>
      pool
        .query(
          `INSERT INTO tax_classification (mre_realm_id, source_type, transaction_split_id, tax_category, treatment, review_state, rule_code, rule_version,
             created_by, tax_year, refund_of_year)
           VALUES ($1, 'TRANSACTION_SPLIT', $2, 'MAINTENANCE', 'DEDUCTIBLE', 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x', $3, $4) RETURNING id`,
          [REALM, splitId, extra.taxYear ?? null, extra.refundOfYear ?? null],
        )
        .then(
          (r) => r.rows[0].id as string,
          (error) => reasonOf(error),
        );
    const insertDeposit = (depositId: string, values: { category?: string; treatment?: string | null; date?: string; amount?: string; extra?: string } = {}) =>
      pool
        .query(
          `INSERT INTO tax_classification (mre_realm_id, source_type, security_deposit_id, deposit_closing_date, deposit_retained_amount, tax_category, treatment,
             review_state, rule_code, rule_version, created_by${values.extra === undefined ? '' : `, ${values.extra.split('=')[0]}`})
           VALUES ($1, 'DEPOSIT_CLOSING', $2, $3, $4, $5, $6, 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x'${
             values.extra === undefined ? '' : `, ${values.extra.split('=')[1]}`
           }) RETURNING id`,
          [
            REALM,
            depositId,
            values.date ?? '2027-06-30',
            values.amount ?? '400.00',
            values.category ?? 'RETAINED_DEPOSIT_RENT',
            values.treatment === undefined ? 'INCOME' : values.treatment,
          ],
        )
        .then(
          (r) => r.rows[0].id as string,
          (error) => reasonOf(error),
        );

    it('tax_year: the booking year ± 1; refund_of_year: at most the tax year; both never change', async () => {
      const pr = await propertyReference();
      const make = async () =>
        (await booked([split('100.00', 'MAINTENANCE', { propertyReferenceId: pr })], { bookingDate: '2026-12-30' })).splitIds[0] as string;
      expect(await insertSplitClassification(await make(), { taxYear: 2028 })).toBe('(TAX_YEAR_OUT_OF_RANGE)');
      expect(await insertSplitClassification(await make(), { taxYear: 2024 })).toBe('(TAX_YEAR_OUT_OF_RANGE)');
      // Before the CHECK (2000–2100), the trigger already refuses a year that far away.
      expect(await insertSplitClassification(await make(), { taxYear: 1999 })).toBe('(TAX_YEAR_OUT_OF_RANGE)');
      expect(await insertSplitClassification(await make(), { taxYear: 2026, refundOfYear: 2027 })).toBe('(REFUND_YEAR_OUT_OF_RANGE)');
      expect(await insertSplitClassification(await make(), { refundOfYear: 2028 })).toBe('(REFUND_YEAR_OUT_OF_RANGE)');
      const ok = await insertSplitClassification(await make(), { taxYear: 2027, refundOfYear: 2026 });
      expect(ok).toMatch(/^[0-9a-f-]{36}$/);
      for (const set of ['tax_year = 2026', 'refund_of_year = 2025', `security_deposit_id = '${UNKNOWN}'`]) {
        expect(
          await pool.query(`UPDATE tax_classification SET ${set}, version = version + 1 WHERE id = $1`, [ok]).then(() => 'accepted', reasonOf),
          set,
        ).toMatch(/never change|tax_classification_one_source|tax_classification_deposit_fields/);
      }
      expect(
        await pool.query(`UPDATE tax_classification SET tax_year = 2026, version = version + 1 WHERE id = $1`, [ok]).then(() => 'accepted', reasonOf),
      ).toBe('never change');
    });

    it('the deposit: counted and its own closing only, its lines and treatments only, one source, one current, the Realm', async () => {
      const depositId = await retained(nextTenant());
      expect(await insertDeposit(depositId, { category: 'RENT' })).toBe('(TREATMENT_NOT_ALLOWED)');
      expect(await insertDeposit(depositId, { category: 'RETAINED_DEPOSIT_RENT', treatment: 'NOT_RELEVANT' })).toBe('tax_classification_fit');
      expect(await insertDeposit(depositId, { category: 'MAINTENANCE', treatment: 'DEDUCTIBLE' })).toBe('(TREATMENT_NOT_ALLOWED)');
      expect(await insertDeposit(depositId, { date: '2027-06-29' })).toBe('(SOURCE_NOT_COUNTED)');
      expect(await insertDeposit(depositId, { amount: '399.99' })).toBe('(SOURCE_NOT_COUNTED)');
      expect(await insertDeposit(depositId, { extra: 'tax_year=2027' })).toBe('tax_classification_deposit_fields');
      const pr = await propertyReference();
      const { splitIds } = await booked([split('100.00', 'MAINTENANCE', { propertyReferenceId: pr })], { bookingDate: '2026-06-01' });
      expect(await insertDeposit(depositId, { extra: `transaction_split_id='${splitIds[0]}'` })).toBe('tax_classification_one_source');
      const first = await insertDeposit(depositId);
      expect(first).toMatch(/^[0-9a-f-]{36}$/);
      expect(await insertDeposit(depositId)).toBe('tax_classification_current_deposit');
      // A deposit of another Realm, and an ACTIVE deposit.
      const foreign = await retained(nextTenant(), OTHER_REALM);
      expect(await insertDeposit(foreign)).toBe('tax_classification_deposit_fk');
      const active = await deposits.create(
        {
          mreRealmId: REALM,
          mreTenantId: nextTenant(),
          expectedAmount: eur('1000.00'),
          expectedAmountSource: 'REQUEST',
          holdingFinancialAccountId: null,
          interestBearing: false,
          notes: null,
        },
        actor,
      );
      if (active.kind !== 'CREATED') throw new Error(active.kind);
      expect(await insertDeposit(active.deposit.id)).toBe('(SOURCE_NOT_COUNTED)');
      // The closing it classified never changes.
      expect(
        await pool
          .query(`UPDATE tax_classification SET deposit_retained_amount = 1, version = version + 1 WHERE id = $1`, [first])
          .then(() => 'accepted', reasonOf),
      ).toBe('never change');
    });

    it('rental_contract_reference: the due days checked (day 1–31, validFrom unique, ascending, real, at most 20); the guard', async () => {
      const insert = (days: unknown) =>
        pool
          .query(
            `INSERT INTO rental_contract_reference (mre_realm_id, mre_tenant_id, rent_due_days, created_by) VALUES ($1, $2, $3::jsonb, 'x') RETURNING id`,
            [REALM, nextTenant(), JSON.stringify(days)],
          )
          .then(
            (r) => r.rows[0].id as string,
            (error) => reasonOf(error),
          );
      const refused = 'rental_contract_reference_due_days';
      expect(await insert([{ validFrom: '2025-01-01', day: 0 }])).toBe(refused);
      expect(await insert([{ validFrom: '2025-01-01', day: 32 }])).toBe(refused);
      expect(await insert([{ validFrom: '2025-01-01', day: 3.5 }])).toBe(refused);
      expect(await insert([{ validFrom: '2025-01-01', day: '3' }])).toBe(refused);
      expect(
        await insert([
          { validFrom: '2025-01-01', day: 3 },
          { validFrom: '2025-01-01', day: 4 },
        ]),
      ).toBe(refused);
      expect(
        await insert([
          { validFrom: '2028-01-01', day: 3 },
          { validFrom: '2025-01-01', day: 4 },
        ]),
      ).toBe(refused);
      expect(await insert([{ validFrom: '2025-02-30', day: 3 }])).toBe(refused);
      expect(await insert([{ validFrom: '2025-1-1', day: 3 }])).toBe(refused);
      expect(await insert([{ validFrom: '2025-01-01' }])).toBe(refused);
      expect(await insert([{ validFrom: '2025-01-01', day: 3, note: 'x' }])).toBe(refused);
      expect(await insert({ validFrom: '2025-01-01', day: 3 })).toBe(refused);
      expect(await insert(Array.from({ length: 21 }, (_, i) => ({ validFrom: `${2000 + i}-01-01`, day: 1 })))).toBe(refused);
      expect(await insert(Array.from({ length: 20 }, (_, i) => ({ validFrom: `${2000 + i}-01-01`, day: 31 })))).toMatch(/^[0-9a-f-]{36}$/);
      const id = await insert([
        { validFrom: '2025-01-01', day: 1 },
        { validFrom: '2028-01-01', day: 31 },
      ]);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      // Past an insert, an update is checked the same way.
      expect(
        await pool
          .query(`UPDATE rental_contract_reference SET rent_due_days = '[{"validFrom":"2025-01-01","day":40}]', version = version + 1 WHERE id = $1`, [id])
          .then(() => 'accepted', reasonOf),
      ).toBe(refused);
      const update = (set: string) => pool.query(`UPDATE rental_contract_reference SET ${set} WHERE id = $1`, [id]).then(() => 'accepted', reasonOf);
      expect(await update(`mre_tenant_id = '${nextTenant()}', version = version + 1`)).toBe('never change');
      expect(await update(`mre_realm_id = '${OTHER_REALM}', version = version + 1`)).toBe('never change');
      expect(await update(`notes = 'x'`)).toBe('exactly one');
      expect(await update(`notes = 'x', version = version + 2`)).toBe('exactly one');
      expect(await update(`version = version`)).toBe('accepted');
      expect(await update(`notes = 'x', version = version + 1`)).toBe('accepted');
      expect(await pool.query(`DELETE FROM rental_contract_reference WHERE id = $1`, [id]).then(() => 'accepted', reasonOf)).toBe('never deleted');
      expect(
        await pool
          .query(`INSERT INTO rental_contract_reference (mre_realm_id, mre_tenant_id, created_by, version) VALUES ($1, $2, 'x', 2)`, [REALM, nextTenant()])
          .then(() => 'accepted', reasonOf),
      ).toBe('only inserted with version 1');
      const tenant = nextTenant();
      await insert([]).then(() => undefined);
      await pool.query(`INSERT INTO rental_contract_reference (mre_realm_id, mre_tenant_id, created_by) VALUES ($1, $2, 'x')`, [REALM, tenant]);
      expect(
        await pool
          .query(`INSERT INTO rental_contract_reference (mre_realm_id, mre_tenant_id, created_by) VALUES ($1, $2, 'x')`, [REALM, tenant])
          .then(() => 'accepted', reasonOf),
      ).toBe('rental_contract_reference_tenant_key');
    });

    it('weg_economic_plan.advance_due_day: 1–31, and fixed', async () => {
      const { rows } = await pool.query(`SELECT id FROM weg_economic_plan WHERE status = 'ACTIVE' AND advance_due_day = 1 LIMIT 1`);
      const planId = rows[0].id as string;
      expect(
        await pool.query(`UPDATE weg_economic_plan SET advance_due_day = 2 WHERE id = $1`, [planId]).then(
          () => 'accepted',
          (error: { message?: string }) => (error.message?.includes('advance_due_day never changes') ? 'fixed' : reasonOf(error)),
        ),
      ).toBe('fixed');
      // The CHECK on an insert (an update is refused by the guard first).
      expect(
        await pool
          .query(
            `INSERT INTO weg_economic_plan (mre_realm_id, membership_id, financial_year, effective_from, monthly_hausgeld, monthly_reserve_contribution,
               recoverable_costs, non_recoverable_costs, currency, status, created_by, advance_due_day)
             SELECT mre_realm_id, membership_id, financial_year, effective_from + 1, monthly_hausgeld, monthly_reserve_contribution, recoverable_costs,
                    non_recoverable_costs, currency, 'ACTIVE', 'x', 0 FROM weg_economic_plan WHERE id = $1`,
            [planId],
          )
          .then(() => 'accepted', reasonOf),
      ).toBe('weg_economic_plan_advance_due_day_check');
      // A void still passes: the day is kept.
      expect(
        await pool
          .query(`UPDATE weg_economic_plan SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1 WHERE id = $1`, [
            planId,
          ])
          .then(() => 'accepted', reasonOf),
      ).toBe('accepted');
    });

    it('down restores 0045 and drops the table, the column and the functions (under MIGRATION_ADVISORY_LOCK)', { timeout: 30_000 }, async () => {
      const downSchema = testSchemaName('tax_year_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema} -c application_name=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        await withMigrationLock(async () => {
          // 0047 (VC-7-03) builds on 0046: it goes first.
          await (await import('./migrations/0047_tax_weg_spending.js')).down(createDatabase(downPool) as never);
          await (await import('./migrations/0046_tax_year_and_income.js')).down(createDatabase(downPool) as never);
        });
        expect((await downPool.query(`SELECT to_regclass('rental_contract_reference') AS t`)).rows[0].t).toBeNull();
        const columns = await downPool.query(
          `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1
             AND (column_name IN ('tax_year', 'refund_of_year', 'security_deposit_id', 'deposit_closing_date', 'deposit_retained_amount', 'advance_due_day')
                  AND table_name IN ('tax_classification', 'weg_economic_plan'))`,
          [downSchema],
        );
        expect(columns.rows).toEqual([]);
        const functions = await downPool.query(
          `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = $1
             AND proname IN ('tax_classification_tax_year', 'tax_classification_deposit_counts', 'tax_classification_deposit_treatment',
                             'tax_classification_source_fixed', 'rental_contract_reference_due_days_valid', 'rental_contract_reference_texts_valid',
                             'rental_contract_reference_guard', 'weg_economic_plan_advance_due_day_fixed')`,
          [downSchema],
        );
        expect(functions.rows).toEqual([]);
        // 0045's CHECKs are back: a deposit source and the new lines are refused.
        const checks = await downPool.query(
          `SELECT conname, pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
            WHERE nspname = $1 AND conname IN ('tax_classification_source_type_check', 'tax_classification_tax_category_check') ORDER BY conname`,
          [downSchema],
        );
        expect(checks.rows.map((r) => r.conname)).toEqual(['tax_classification_source_type_check', 'tax_classification_tax_category_check']);
        expect(checks.rows.some((r) => String(r.def).includes('DEPOSIT_CLOSING') || String(r.def).includes('REFUNDS_OF_EARLIER_YEARS'))).toBe(false);
        // 0045 is intact: its own triggers remain.
        const triggers = await downPool.query(
          `SELECT tgname FROM pg_trigger WHERE tgrelid = 'tax_classification'::regclass AND NOT tgisinternal ORDER BY tgname`,
        );
        expect(triggers.rows.map((r) => r.tgname)).toEqual([
          'tax_classification_chain',
          'tax_classification_frozen',
          'tax_classification_initial',
          'tax_classification_source_counts',
          'tax_classification_treatment',
        ]);
      } finally {
        await downPool.end();
      }
    });
  });
});
