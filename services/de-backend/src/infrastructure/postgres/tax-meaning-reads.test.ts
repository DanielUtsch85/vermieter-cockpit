import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { DE_CATEGORY_DEFAULTS_V1, type TaxListItem, type TaxMeaning, type TaxPage } from '../../domains/taxation/index.js';
import type { PostgresCorrectionRepository } from './correction-repository.js';
import type { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { databaseUrl, REALM, OTHER_REALM, actor, eur, today, UNKNOWN, split, useTaxClassificationDatabase } from './tax-classification.test-support.js';

/**
 * VC-7-01 persistence (api-design.md §55): the tax meaning per split and per property and year, read by
 * `tax-meaning-reads.ts`. Figures are invented.
 */
/** The split items of a page of the per-property list (VC-7-02 adds retained deposits). */
const splitsOf = (page: TaxPage<TaxListItem> | undefined): TaxMeaning[] =>
  (page?.items ?? []).filter((m): m is TaxMeaning & TaxListItem => m.sourceType === 'TRANSACTION_SPLIT');

describe.skipIf(databaseUrl === undefined)('TaxClassification meanings (§55)', () => {
  const { ctx, propertyReference, booked, oneSplit, classified } = useTaxClassificationDatabase('tax_meaning_reads_test');
  let pool: pg.Pool;
  let classifications: PostgresTaxClassificationRepository;
  let corrections: PostgresCorrectionRepository;
  beforeAll(() => {
    ({ pool, classifications, corrections } = ctx);
  });

  describe('tax meaning (§55)', () => {
    it('DEFAULT, CLASSIFICATION, NOT_COUNTED, CLASSIFICATION_ON_CORRECTED_SPLIT; 404 of another Realm', async () => {
      const pr = await propertyReference();
      const { tx, splitIds } = await booked([split('100.00', 'MAINTENANCE', pr), split('20.00', 'OTHER_EXPENSE', pr)]);
      const [maintenance, other] = splitIds as [string, string];
      expect(await classifications.findTaxMeaning(maintenance, REALM, today)).toMatchObject({
        splitId: maintenance,
        transactionId: tx,
        bookingDate: '2026-03-02',
        direction: 'OUTFLOW',
        amount: eur('100.00'),
        financialCategoryCode: 'MAINTENANCE',
        propertyReferenceId: pr,
        counts: true,
        taxCategory: 'MAINTENANCE',
        treatment: 'DEDUCTIBLE',
        reviewState: 'SUGGESTED',
        origin: 'DEFAULT',
        rule: { ruleCode: 'DE_CATEGORY_DEFAULTS', version: 1 },
        classificationId: null,
        flags: [],
      });
      expect(await classifications.findTaxMeaning(other, REALM, today)).toMatchObject({
        taxCategory: 'UNCLASSIFIED',
        treatment: null,
        reviewState: 'NEEDS_REVIEW',
      });
      const c = await classified(maintenance);
      expect(await classifications.findTaxMeaning(maintenance, REALM, today)).toMatchObject({
        origin: 'CLASSIFICATION',
        treatment: 'CAPITALIZED',
        reviewState: 'USER_CONFIRMED',
        classificationId: c.id,
      });
      const corrected = await corrections.correct(tx, REALM, { reason: 'Beschreibung', replacement: { description: 'Heizung' } }, actor);
      if (corrected.kind !== 'CORRECTED' || corrected.result.replacement === null) throw new Error(corrected.kind);
      expect(await classifications.findTaxMeaning(maintenance, REALM, today)).toMatchObject({
        counts: false,
        origin: 'CLASSIFICATION',
        flags: [{ code: 'NOT_COUNTED', details: { transactionStatus: 'CORRECTED', correctionRole: null } }],
      });
      const { rows } = await pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [corrected.result.replacement.id]);
      expect(await classifications.findTaxMeaning(rows[0].id, REALM, today)).toMatchObject({
        counts: true,
        origin: 'DEFAULT',
        treatment: 'DEDUCTIBLE',
        flags: [{ code: 'CLASSIFICATION_ON_CORRECTED_SPLIT', details: { originalTransactionId: tx, classificationIds: [c.id] } }],
      });
      // The replacement's other split shares the Transaction: the flag is per Transaction's original (P7-D2).
      expect((await classifications.findTaxMeaning(rows[1].id, REALM, today))?.flags.map((f) => f.code)).toEqual(['CLASSIFICATION_ON_CORRECTED_SPLIT']);
      const { rows: reversal } = await pool.query(
        `SELECT s.id FROM transaction_split s JOIN ledger_transaction t ON t.id = s.transaction_id WHERE t.correction_of_transaction_id = $1 AND t.correction_role = 'REVERSAL' ORDER BY position`,
        [tx],
      );
      expect(await classifications.findTaxMeaning(reversal[0].id, REALM, today)).toMatchObject({
        counts: false,
        flags: [{ code: 'NOT_COUNTED', details: { transactionStatus: 'CONFIRMED', correctionRole: 'REVERSAL' } }],
      });
      expect(await classifications.findTaxMeaning(maintenance, OTHER_REALM, today)).toBeUndefined();
      expect(await classifications.findTaxMeaning(UNKNOWN, REALM, today)).toBeUndefined();
      const open = await oneSplit('MAINTENANCE', { confirm: false });
      expect((await classifications.findTaxMeaning(open.splitId, REALM, today))?.flags).toEqual([
        { code: 'NOT_COUNTED', details: { transactionStatus: 'CLASSIFIED', correctionRole: null } },
      ]);
    });

    it('per property and year: only counting splits of the year, ordered, filtered and paged; unknown property', async () => {
      const pr = await propertyReference();
      const a = await booked([split('900.00', 'RENT_BASE', pr), split('150.00', 'RENT_OPERATING_COST_ADVANCE', pr)], {
        direction: 'INFLOW',
        bookingDate: '2026-02-01',
      });
      const b = await booked([split('80.00', 'OTHER_EXPENSE', pr)], { bookingDate: '2026-01-15' });
      const c = await booked([split('300.00', 'MAINTENANCE', pr)], { bookingDate: '2026-12-31' });
      await booked([split('300.00', 'MAINTENANCE', pr)], { bookingDate: '2025-12-31' });
      await booked([split('300.00', 'MAINTENANCE', pr)], { bookingDate: '2027-01-01' });
      await booked([split('300.00', 'MAINTENANCE', pr)], { bookingDate: '2026-06-01', confirm: false });
      await booked([split('300.00', 'MAINTENANCE', await propertyReference())], { bookingDate: '2026-06-01' });
      const reversed = await booked([split('40.00', 'BANK_FEES', pr)], { bookingDate: '2026-05-01' });
      await corrections.correct(reversed.tx, REALM, { reason: 'falsch', replacement: null }, actor);
      await classified(c.splitIds[0] as string, { reviewState: 'NEEDS_REVIEW' });
      const page = { page: 1, pageSize: 200 };
      const all = await classifications.listTaxMeanings(pr, REALM, 2026, {}, page, today);
      expect(splitsOf(all).map((m) => [m.bookingDate, m.financialCategoryCode, m.origin])).toEqual([
        ['2026-01-15', 'OTHER_EXPENSE', 'DEFAULT'],
        ['2026-02-01', 'RENT_BASE', 'DEFAULT'],
        ['2026-02-01', 'RENT_OPERATING_COST_ADVANCE', 'DEFAULT'],
        ['2026-12-31', 'MAINTENANCE', 'CLASSIFICATION'],
      ]);
      expect(all?.total).toBe(4);
      expect(splitsOf(await classifications.listTaxMeanings(pr, REALM, 2026, { reviewStates: ['NEEDS_REVIEW'] }, page, today)).map((m) => m.splitId)).toEqual([
        b.splitIds[0],
        c.splitIds[0],
      ]);
      expect(splitsOf(await classifications.listTaxMeanings(pr, REALM, 2026, { origins: ['CLASSIFICATION'] }, page, today)).map((m) => m.splitId)).toEqual([
        c.splitIds[0],
      ]);
      expect(
        splitsOf(await classifications.listTaxMeanings(pr, REALM, 2026, { taxCategories: ['RENT', 'OPERATING_COST_ADVANCES'] }, page, today)).map(
          (m) => m.splitId,
        ),
      ).toEqual(a.splitIds);
      const second = await classifications.listTaxMeanings(pr, REALM, 2026, {}, { page: 2, pageSize: 3 }, today);
      expect(second).toMatchObject({ page: 2, pageSize: 3, total: 4 });
      expect(splitsOf(second).map((m) => m.splitId)).toEqual([c.splitIds[0]]);
      expect(await classifications.listTaxMeanings(pr, OTHER_REALM, 2026, {}, page, today)).toBeUndefined();
      expect(await classifications.listTaxMeanings(UNKNOWN, REALM, 2026, {}, page, today)).toBeUndefined();
      expect((await classifications.listTaxMeanings(pr, REALM, 2024, {}, page, today))?.items).toEqual([]);
    });

    it('every category seeded by the migrations is listed in the default table', async () => {
      const { rows } = await pool.query(`SELECT code, category_type FROM financial_category ORDER BY code`);
      for (const row of rows) expect(Object.keys(DE_CATEGORY_DEFAULTS_V1.parameters.defaults), row.code).toContain(row.code);
      expect(rows.length).toBe(Object.keys(DE_CATEGORY_DEFAULTS_V1.parameters.defaults).length);
    });
  });
});
