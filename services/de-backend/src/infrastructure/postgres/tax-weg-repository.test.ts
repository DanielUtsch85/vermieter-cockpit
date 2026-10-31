import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { WegTaxMeaning } from '../../domains/taxation/index.js';
import type { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import { actor, AT, codes, databaseUrl, day, eur, OTHER_REALM, REALM, today, UNKNOWN, useTaxWegDatabase } from './tax-weg.test-support.js';
import type { PostgresWegSpecialAssessmentRepository } from './weg-special-assessment-repository.js';

/**
 * VC-7-03 persistence (api-design.md §58B, migration 0047): classifications of reserve withdrawals and Sonderumlage uses
 * (create with its order of checks, supersede, replay, history), a superseded statement, the per-property list with
 * withdrawals, uses and § 82b parts, the anschaffungsnahe check through the repository, and nothing else written. Every
 * new CHECK and guard past the repository, the VC-X-26 indexes, `down`, the start check and the locks under RC and RR
 * are in `tax-weg-guards.test.ts`; the setup is in `tax-weg.test-support.ts`. Figures and names are synthetic.
 */
let counter = 0;

describe.skipIf(databaseUrl === undefined)('WEG spending, Erhaltungsaufwand and § 82b (§58B)', () => {
  const { ctx, member, line, statement, assessment, request, split, booked, acquisition, propertyReference, withdrawalMeaning, useMeaning, list, keys } =
    useTaxWegDatabase('tax_weg_test');
  let pool: pg.Pool;
  let classifications: PostgresTaxClassificationRepository;
  let assessments: PostgresWegSpecialAssessmentRepository;
  beforeAll(() => {
    ({ pool, classifications, assessments } = ctx);
  });

  describe('a reserve withdrawal (§58B)', () => {
    it('its meaning: unit share, own date or the period end assumed; NOT_A_WITHDRAWAL; 404 for no line or another Realm', async () => {
      const { membershipId } = await member();
      const st = await statement(membershipId);
      expect(await withdrawalMeaning(st, 1)).toMatchObject({
        amount: eur('1000.00'),
        date: '2026-06-15',
        dateSource: 'WITHDRAWAL',
        counts: true,
        taxYear: 2026,
        taxCategory: 'UNCLASSIFIED',
        reviewState: 'NEEDS_REVIEW',
        origin: 'DEFAULT',
        rule: { ruleCode: 'DE_WEG_SPENDING', version: 1 },
      });
      const undated = await withdrawalMeaning(st, 2);
      expect(undated).toMatchObject({ amount: eur('500.00'), date: '2026-12-31', dateSource: 'PERIOD_END' });
      expect(codes(undated?.flags)).toEqual(['WITHDRAWAL_DATE_ASSUMED']);
      expect(await withdrawalMeaning(st, 3)).toMatchObject({ counts: false, notCountedReason: 'NOT_A_WITHDRAWAL' });
      expect(await withdrawalMeaning(st, 4)).toBeUndefined();
      expect(await classifications.findWithdrawalTaxMeaning(st, 1, OTHER_REALM, today)).toBeUndefined();
      expect(await withdrawalMeaning(UNKNOWN, 1)).toBeUndefined();
    });

    it('create: the order of checks, supersede, replay, the history by position, the AuditRecord; nothing else written', async () => {
      const { membershipId } = await member();
      const draft = await statement(membershipId, {}, false);
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', UNKNOWN, 1), actor)).toEqual({ kind: 'SOURCE_NOT_FOUND' });
      expect(await classifications.createClassification({ ...request('WEG_RESERVE_WITHDRAWAL', draft, 1), mreRealmId: OTHER_REALM }, actor)).toEqual({
        kind: 'SOURCE_NOT_FOUND',
      });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', draft, 9), actor)).toEqual({ kind: 'SOURCE_NOT_FOUND' });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', draft, 1), actor)).toMatchObject({
        kind: 'WEG_SOURCE_NOT_COUNTED',
        reason: 'STATEMENT_NOT_CONFIRMED',
        details: { status: 'DRAFT' },
      });
      const st = await statement((await member()).membershipId);
      const before = (await pool.query(`SELECT version, reserve, status FROM weg_annual_statement WHERE id = $1`, [st])).rows[0];
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 3), actor)).toMatchObject({
        kind: 'WEG_SOURCE_NOT_COUNTED',
        reason: 'NOT_A_WITHDRAWAL',
      });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1, { taxCategory: 'MAINTENANCE' }), actor)).toMatchObject({
        kind: 'TREATMENT_NOT_ALLOWED',
        sourceType: 'WEG_RESERVE_WITHDRAWAL',
      });
      expect(
        await classifications.createClassification(
          request('WEG_RESERVE_WITHDRAWAL', st, 1, { treatment: 'DISTRIBUTED_82B', distributionYears: 3, mostlyResidentialConfirmed: false }),
          actor,
        ),
      ).toEqual({ kind: 'DISTRIBUTION_NOT_ALLOWED', reason: 'NOT_MOSTLY_RESIDENTIAL' });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1, { netAmount: eur('1000.01') }), actor)).toEqual({
        kind: 'NET_AMOUNT_EXCEEDS_GROSS',
        netAmount: eur('1000.01'),
        grossAmount: eur('1000.00'),
      });
      expect(
        await classifications.createClassification(
          request('WEG_RESERVE_WITHDRAWAL', st, 1, { treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: UNKNOWN }),
          actor,
        ),
      ).toEqual({ kind: 'ACQUISITION_NOT_FOUND', acquisitionId: UNKNOWN });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1, { taxYear: 2026 }), actor)).toEqual({
        kind: 'FIELD_NOT_SUPPORTED',
        field: 'taxYear',
      });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 2, { taxYear: 2027 }), actor)).toEqual({
        kind: 'WITHDRAWAL_TAX_YEAR_OUT_OF_RANGE',
        taxYear: 2027,
        allowedYears: [2026],
      });
      const key = { key: `k-${++counter}`, fingerprint: 'f' };
      const first = await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1, { netAmount: eur('840.34') }), actor, key);
      expect(first).toMatchObject({
        kind: 'CREATED',
        classification: {
          sourceType: 'WEG_RESERVE_WITHDRAWAL',
          sourceId: st,
          sourcePosition: 1,
          reserveWithdrawal: { unitShare: eur('1000.00') },
          netAmount: eur('840.34'),
          rule: { ruleCode: 'DE_WEG_SPENDING', version: 1 },
          treatmentRule: null,
        },
      });
      if (first.kind !== 'CREATED') return;
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1, { netAmount: eur('840.34') }), actor, key)).toMatchObject({
        kind: 'REPLAYED',
        classification: { id: first.classification.id, netAmount: eur('840.34'), sourcePosition: 1 },
      });
      expect(await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1), actor)).toEqual({
        kind: 'CLASSIFICATION_EXISTS',
        currentClassificationId: first.classification.id,
      });
      const second = await classifications.createClassification(
        request('WEG_RESERVE_WITHDRAWAL', st, 1, {
          treatment: 'DISTRIBUTED_82B',
          distributionYears: 2,
          mostlyResidentialConfirmed: true,
          supersedes: first.classification.id,
        }),
        actor,
      );
      expect(second).toMatchObject({
        kind: 'CREATED',
        classification: { treatmentRule: { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 }, distributionYears: 2 },
      });
      const history = await classifications.listHistory('WEG_RESERVE_WITHDRAWAL', st, REALM, 1);
      expect(history?.map((c) => [c.treatment, c.supersededBy === null])).toEqual([
        ['DEDUCTIBLE', false],
        ['DISTRIBUTED_82B', true],
      ]);
      expect(await classifications.listHistory('WEG_RESERVE_WITHDRAWAL', st, REALM, 2)).toEqual([]);
      expect(await classifications.listHistory('WEG_RESERVE_WITHDRAWAL', st, OTHER_REALM, 1)).toBeUndefined();
      const audit = await pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'TAX_CLASSIFIED'`, [
        second.kind === 'CREATED' ? second.classification.id : '',
      ]);
      expect(audit.rows[0].metadata).toMatchObject({
        sourcePosition: 1,
        distributionYears: 2,
        mostlyResidentialConfirmed: true,
        treatmentRule: { ruleCode: 'DE_82B_DISTRIBUTION', version: 1 },
      });
      // Nothing else written: the statement row and its version unchanged (the lock is a no-op write).
      expect((await pool.query(`SELECT version, reserve, status FROM weg_annual_statement WHERE id = $1`, [st])).rows[0]).toEqual(before);
      const meaning = (await withdrawalMeaning(st, 1)) as WegTaxMeaning;
      expect(meaning.distribution?.parts.map((p) => [p.year, p.amount.amount])).toEqual([
        [2026, '500.00'],
        [2027, '500.00'],
      ]);
    });

    it('a superseded statement: its classification stops counting; the successor reads the default with PREDECESSOR_CLASSIFIED; the list holds only the new', async () => {
      const { pr, membershipId } = await member();
      const st = await statement(membershipId);
      const c1 = await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 1), actor);
      const c2 = await classifications.createClassification(request('WEG_RESERVE_WITHDRAWAL', st, 2), actor);
      expect([c1.kind, c2.kind]).toEqual(['CREATED', 'CREATED']);
      expect(keys((await list(pr, 2026, ['WEG_RESERVE_WITHDRAWAL']))?.items)).toEqual(['WEG_RESERVE_WITHDRAWAL:1:1000.00', 'WEG_RESERVE_WITHDRAWAL:2:500.00']);
      const corrected = await statement(membershipId, {
        supersedes: st,
        reserve: { source: 'ANNUAL_STATEMENT', lines: [line(1, 'WITHDRAWAL', '8800.00', '2026-06-20')], unitShareOpening: null, unitShareClosing: null },
      });
      expect(await withdrawalMeaning(st, 1)).toMatchObject({ counts: false, notCountedReason: 'STATEMENT_SUPERSEDED', origin: 'CLASSIFICATION' });
      const successor = await withdrawalMeaning(corrected, 1);
      expect(successor).toMatchObject({ counts: true, origin: 'DEFAULT', reviewState: 'NEEDS_REVIEW', amount: eur('1100.00') });
      expect(successor?.flags).toContainEqual({
        code: 'PREDECESSOR_CLASSIFIED',
        details: {
          statementId: st,
          classificationIds: [c1, c2].map((c) => (c.kind === 'CREATED' ? c.classification.id : '')).sort(),
        },
      });
      expect(keys((await list(pr, 2026))?.items)).toEqual(['WEG_RESERVE_WITHDRAWAL:1:1100.00']);
      expect(
        await classifications.createClassification(
          request('WEG_RESERVE_WITHDRAWAL', st, 1, { supersedes: c1.kind === 'CREATED' ? c1.classification.id : null }),
          actor,
        ),
      ).toMatchObject({
        kind: 'WEG_SOURCE_NOT_COUNTED',
        reason: 'STATEMENT_SUPERSEDED',
      });
      // The history of the old one stays readable.
      expect(await classifications.listHistory('WEG_RESERVE_WITHDRAWAL', st, REALM, 1)).toHaveLength(1);
    });
  });

  describe('a Sonderumlage use (§58B)', () => {
    it('counts; a replace changing it stops the classification (USE_CHANGED); a dropped use answers 404 with its history kept; a void stops it', async () => {
      const { membershipId } = await member();
      const a = await assessment(membershipId, [
        { position: 1, date: '2026-09-01', unitShare: '3000.00' },
        { position: 2, date: '2027-02-01', unitShare: '2000.00' },
      ]);
      expect(await useMeaning(a, 1)).toMatchObject({ amount: eur('3000.00'), date: '2026-09-01', dateSource: 'USE', taxYear: 2026, counts: true });
      expect(codes((await useMeaning(a, 1))?.flags)).toEqual(['USES_EXCEED_PAID']);
      const c = await classifications.createClassification(request('WEG_ASSESSMENT_USE', a, 1), actor);
      expect(c).toMatchObject({ kind: 'CREATED', classification: { assessmentUse: { date: '2026-09-01', unitShare: eur('3000.00') }, taxYear: null } });
      const replace = (uses: { position: number; date: string; unitShare: string; description?: string }[]) =>
        assessments.replaceUses(
          a,
          REALM,
          uses.map((u) => ({ position: u.position, date: day(u.date), description: u.description ?? `Verwendung ${u.position}`, unitShare: eur(u.unitShare) })),
          actor,
          today,
        );
      await replace([
        { position: 1, date: '2026-09-01', unitShare: '3000.00', description: 'neu beschrieben' },
        { position: 2, date: '2027-02-01', unitShare: '2000.00' },
      ]);
      expect(await useMeaning(a, 1)).toMatchObject({ counts: true, origin: 'CLASSIFICATION' });
      await replace([
        { position: 1, date: '2026-09-02', unitShare: '3000.00' },
        { position: 2, date: '2027-02-01', unitShare: '2000.00' },
      ]);
      expect(await useMeaning(a, 1)).toMatchObject({ counts: false, notCountedReason: 'USE_CHANGED', origin: 'CLASSIFICATION' });
      const id = c.kind === 'CREATED' ? c.classification.id : '';
      expect(await classifications.reviewClassification(id, REALM, { kind: 'CONFIRM' }, actor)).toMatchObject({
        kind: 'WEG_SOURCE_NOT_COUNTED',
        reason: 'USE_CHANGED',
      });
      const again = await classifications.createClassification(request('WEG_ASSESSMENT_USE', a, 1, { supersedes: id }), actor);
      expect(again).toMatchObject({ kind: 'CREATED', classification: { assessmentUse: { date: '2026-09-02' } } });
      await replace([{ position: 2, date: '2027-02-01', unitShare: '2000.00' }]);
      expect(await useMeaning(a, 1)).toBeUndefined();
      expect(await classifications.listHistory('WEG_ASSESSMENT_USE', a, REALM, 1)).toHaveLength(2);
      expect(await classifications.createClassification(request('WEG_ASSESSMENT_USE', a, 1), actor)).toEqual({ kind: 'SOURCE_NOT_FOUND' });
      const voided = await assessments.voidAssessment(a, REALM, 'falsch', AT, actor, today);
      expect(voided.kind).toBe('VOIDED');
      expect(await useMeaning(a, 2)).toMatchObject({ counts: false, notCountedReason: 'ASSESSMENT_VOID' });
      expect(await classifications.createClassification(request('WEG_ASSESSMENT_USE', a, 2), actor)).toMatchObject({
        kind: 'WEG_SOURCE_NOT_COUNTED',
        reason: 'ASSESSMENT_VOID',
      });
    });

    it('nothing else written (VC-7-05): a use classification, a capitalisation on the check and their §57 steps leave the assessment, the Acquisition and its allocation unchanged in row and version', async () => {
      const { pr, membershipId } = await member();
      const acquired = await acquisition(pr);
      const a = await assessment(membershipId, [{ position: 1, date: '2026-09-01', unitShare: '3000.00' }]);
      const rows = async () => ({
        assessment: (await pool.query(`SELECT to_jsonb(a) AS row FROM weg_special_assessment a WHERE id = $1`, [a])).rows,
        acquisition: (await pool.query(`SELECT to_jsonb(q) AS row FROM acquisition q WHERE id = $1`, [acquired])).rows,
        allocation: (await pool.query(`SELECT to_jsonb(l) AS row FROM land_building_allocation l WHERE acquisition_id = $1`, [acquired])).rows,
      });
      const before = await rows();
      expect(before.assessment).toHaveLength(1);
      const first = await classifications.createClassification(request('WEG_ASSESSMENT_USE', a, 1, { reviewState: 'NEEDS_REVIEW' }), actor);
      if (first.kind !== 'CREATED') throw new Error(first.kind);
      expect(await rows()).toEqual(before);
      const capitalised = await classifications.createClassification(
        request('WEG_ASSESSMENT_USE', a, 1, { treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: acquired, supersedes: first.classification.id }),
        actor,
      );
      if (capitalised.kind !== 'CREATED') throw new Error(capitalised.kind);
      expect(capitalised.classification.treatmentRule).toEqual({ ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 });
      expect(await rows()).toEqual(before);
      const id = capitalised.classification.id;
      for (const step of [
        { kind: 'ADVISOR_CONFIRM', advisorPartyId: null, note: null },
        { kind: 'MARK_NEEDS_REVIEW', reason: 'prüfen' },
        { kind: 'CONFIRM' },
      ] as const) {
        expect(await classifications.reviewClassification(id, REALM, step, actor), step.kind).toMatchObject({ kind: 'REVIEWED', changed: true });
      }
      await useMeaning(a, 1);
      await classifications.anschaffungsnaheCheck(acquired, REALM, today);
      // Refused commands too: a second create without supersedes.
      expect(await classifications.createClassification(request('WEG_ASSESSMENT_USE', a, 1), actor)).toMatchObject({ kind: 'CLASSIFICATION_EXISTS' });
      expect(await rows()).toEqual(before);
      expect((await classifications.listHistory('WEG_ASSESSMENT_USE', a, REALM, 1))?.map((c) => c.version)).toEqual([2, 4]);
    });
  });

  describe('the per-property list (§58B)', () => {
    it('withdrawals and uses of the year, a § 82b source of an earlier year with its part; the order; the sourceType filter; never a cost line', async () => {
      const { pr, membershipId } = await member();
      const st = await statement(membershipId);
      const a = await assessment(membershipId, [{ position: 1, date: '2026-06-15', unitShare: '900.00' }]);
      const { splitIds } = await booked([split('9000.00', 'MAINTENANCE', pr), split('300.00', 'WEG_RESERVE_CONTRIBUTION', pr)], '2026-06-15');
      const election = await classifications.createClassification(
        {
          mreRealmId: REALM,
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: splitIds[0] as string,
          taxCategory: 'MAINTENANCE',
          treatment: 'DISTRIBUTED_82B',
          reviewState: 'USER_CONFIRMED',
          supersedes: null,
          notes: null,
          sourceReferences: [],
          distributionYears: 3,
          mostlyResidentialConfirmed: true,
        },
        actor,
      );
      expect(election.kind).toBe('CREATED');
      // On 15.06.2026: the splits first, then the withdrawal, then the use.
      expect(keys((await list(pr, 2026))?.items)).toEqual([
        'TRANSACTION_SPLIT:-:3000.00',
        'TRANSACTION_SPLIT:-:300.00',
        'WEG_RESERVE_WITHDRAWAL:1:1000.00',
        'WEG_ASSESSMENT_USE:1:900.00',
        'WEG_RESERVE_WITHDRAWAL:2:500.00',
      ]);
      expect(keys((await list(pr, 2027))?.items)).toEqual(['TRANSACTION_SPLIT:-:3000.00']);
      expect(keys((await list(pr, 2028))?.items)).toEqual(['TRANSACTION_SPLIT:-:3000.00']);
      expect(keys((await list(pr, 2029))?.items)).toEqual([]);
      expect(keys((await list(pr, 2026, ['WEG_ASSESSMENT_USE']))?.items)).toEqual(['WEG_ASSESSMENT_USE:1:900.00']);
      // The WEG_FUNDS split stays NOT_RELEVANT; no cost line is listed.
      const items = (await list(pr, 2026))?.items ?? [];
      expect(items.find((m) => m.sourceType === 'TRANSACTION_SPLIT' && m.financialCategoryCode === 'WEG_RESERVE_CONTRIBUTION')).toMatchObject({
        taxCategory: 'NOT_RELEVANT',
        treatment: 'NOT_RELEVANT',
      });
      // The statement's cost line (unit share 1,000.00, Hausmeister) is in none of the items: they are the five above.
      expect(items).toHaveLength(5);
      expect(items.filter((m) => m.sourceType === 'WEG_RESERVE_WITHDRAWAL').map((m) => m.sourceId)).toEqual([st, st]);
      expect(items.filter((m) => m.sourceType === 'WEG_ASSESSMENT_USE').map((m) => m.sourceId)).toEqual([a]);
    });
  });

  describe('the anschaffungsnahe check through the repository (§58B)', () => {
    it('a split and a use in the window, above 15 %; flagged in their meanings; a CANCELLED Acquisition left to the use case', async () => {
      const pr = await propertyReference();
      const { membershipId } = await member({ pr });
      const acq = await acquisition(pr);
      const { splitIds } = await booked([split('18000.00', 'MAINTENANCE', pr)], '2026-05-14');
      const repair = await classifications.createClassification(
        {
          mreRealmId: REALM,
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: splitIds[0] as string,
          taxCategory: 'MAINTENANCE',
          treatment: 'DEDUCTIBLE',
          reviewState: 'USER_CONFIRMED',
          supersedes: null,
          notes: null,
          sourceReferences: [],
          netAmount: eur('15126.05'),
        },
        actor,
      );
      expect(repair.kind).toBe('CREATED');
      const a = await assessment(membershipId, [{ position: 1, date: '2027-06-10', unitShare: '14800.00' }]);
      await classifications.createClassification(request('WEG_ASSESSMENT_USE', a, 1), actor);
      const check = await classifications.anschaffungsnaheCheck(acq, REALM, today);
      // No acquisition costs here: basis 240,000 × 198,000 / 264,000 = 180,000.00, threshold 27,000.00.
      expect(check).toMatchObject({ status: 'ABOVE_THRESHOLD', threshold: '27000.00', sum: eur('29926.05'), affectedYears: [2026, 2027], final: false });
      expect(codes((await classifications.findTaxMeaning(splitIds[0] as string, REALM, today))?.flags)).toContain('ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN');
      expect(await useMeaning(a, 1)).toMatchObject({
        treatment: 'DEDUCTIBLE',
        suggestion: { treatment: 'CAPITALIZED', reason: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN', acquisitionIds: [acq], final: false },
      });
      expect(await classifications.anschaffungsnaheCheck(acq, OTHER_REALM, today)).toBeUndefined();
      // The capitalisation following the check names the Acquisition; outside the window it is refused.
      const outside = await assessment(membershipId, [{ position: 1, date: '2029-03-16', unitShare: '100.00' }]);
      expect(
        await classifications.createClassification(
          request('WEG_ASSESSMENT_USE', outside, 1, { treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: acq }),
          actor,
        ),
      ).toEqual({ kind: 'ANSCHAFFUNGSNAHE_NOT_APPLICABLE', reason: 'OUTSIDE_WINDOW', acquisitionId: acq });
      const other = await member();
      const foreignUse = await assessment(other.membershipId, [{ position: 1, date: '2027-01-01', unitShare: '100.00' }]);
      expect(
        await classifications.createClassification(
          request('WEG_ASSESSMENT_USE', foreignUse, 1, { treatment: 'CAPITALIZED', anschaffungsnaheAcquisitionId: acq }),
          actor,
        ),
      ).toMatchObject({ reason: 'OTHER_PROPERTY_REFERENCE' });
      // Nothing written on the Acquisition or its allocation.
      expect((await pool.query(`SELECT version FROM acquisition WHERE id = $1`, [acq])).rows[0].version).toBe(2);
    });
  });
});
