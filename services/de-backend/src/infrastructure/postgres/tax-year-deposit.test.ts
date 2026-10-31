import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PostgresTaxClassificationRepository } from './tax-classification-repository.js';
import type { PostgresRentalContractReferenceRepository } from './rental-contract-reference-repository.js';
import type { PostgresSecurityDepositRepository } from './security-deposit-repository.js';
import { actor, databaseUrl, day, due, eur, nextTenant, OTHER_REALM, REALM, reasonOf, today, UNKNOWN, useTaxYearDatabase } from './tax-year.test-support.js';

/**
 * VC-7-02 persistence (api-design.md §58A, migration 0046): deposit classifications with `reopen` stopping them; the
 * RentalContractReference (create, its order of checks, replay, amend, reads); and the serialisation of a deposit
 * classification with a reopen under RC and RR (P7-D9). The tax year of rent, Hausgeld and interest, the override, the
 * guards past the repository and `down` are in `tax-year-repository.test.ts`; the setup is in
 * `tax-year.test-support.ts`. Figures and names are invented.
 */
let counter = 0;

describe.skipIf(databaseUrl === undefined)('Tax year and income (§58A): the retained deposit and the RentalContractReference', () => {
  const { ctx, propertyReference, rent, newReference, list, retained, depositRequest } = useTaxYearDatabase('tax_year_deposit_test');
  let pool: pg.Pool;
  let classifications: PostgresTaxClassificationRepository;
  let references: PostgresRentalContractReferenceRepository;
  let deposits: PostgresSecurityDepositRepository;
  beforeAll(() => {
    ({ pool, classifications, references, deposits } = ctx);
  });

  describe('the retained deposit (§58A)', () => {
    it('nothing else written (VC-7-05): a deposit classification, its supersede and its §57 steps leave the deposit and its cash unchanged in row and version', async () => {
      const tenant = nextTenant();
      const pr = await propertyReference();
      await rent(pr, tenant, '2027-03-01', '2027030100');
      const depositId = await retained(tenant);
      const rows = async () => ({
        deposit: (await pool.query(`SELECT to_jsonb(d) AS row FROM security_deposit d WHERE id = $1`, [depositId])).rows,
        splits: (await pool.query(`SELECT to_jsonb(s) AS row FROM transaction_split s WHERE security_deposit_id = $1 ORDER BY id`, [depositId])).rows,
        transactions: (
          await pool.query(
            `SELECT to_jsonb(t) AS row FROM ledger_transaction t WHERE id IN (SELECT transaction_id FROM transaction_split WHERE security_deposit_id = $1) ORDER BY id`,
            [depositId],
          )
        ).rows,
      });
      const before = await rows();
      expect([before.deposit, before.splits]).toEqual([[expect.anything()], [expect.anything(), expect.anything()]]);
      const first = await classifications.createClassification(depositRequest(depositId, { reviewState: 'NEEDS_REVIEW' }), actor);
      if (first.kind !== 'CREATED') throw new Error(first.kind);
      expect(await rows()).toEqual(before);
      const second = await classifications.createClassification(
        depositRequest(depositId, { taxCategory: 'RETAINED_DEPOSIT_DAMAGES', supersedes: first.classification.id }),
        actor,
      );
      if (second.kind !== 'CREATED') throw new Error(second.kind);
      for (const step of [
        { kind: 'MARK_NEEDS_REVIEW', reason: 'prüfen' },
        { kind: 'CONFIRM' },
        { kind: 'ADVISOR_CONFIRM', advisorPartyId: null, note: null },
      ] as const) {
        expect(await classifications.reviewClassification(second.classification.id, REALM, step, actor), step.kind).toMatchObject({
          kind: 'REVIEWED',
          changed: true,
        });
      }
      await classifications.findDepositTaxMeaning(depositId, REALM, today);
      // Refused commands too: another create without supersedes, a step on the superseded one.
      expect(await classifications.createClassification(depositRequest(depositId), actor)).toMatchObject({ kind: 'CLASSIFICATION_EXISTS' });
      expect(await classifications.reviewClassification(first.classification.id, REALM, { kind: 'CONFIRM' }, actor)).toMatchObject({
        kind: 'CLASSIFICATION_SUPERSEDED',
      });
      expect(await rows()).toEqual(before);
    });

    it('its meaning and classification; the per-property list; reopen stops it; a new closing needs a new classification', async () => {
      const tenant = nextTenant();
      const pr = await propertyReference();
      await rent(pr, tenant, '2027-03-01', '2027030100');
      const depositId = await retained(tenant);
      expect(await classifications.findDepositTaxMeaning(depositId, REALM, today)).toMatchObject({
        sourceType: 'DEPOSIT_CLOSING',
        sourceId: depositId,
        counts: true,
        taxYear: 2027,
        amount: eur('400.00'),
        propertyReferenceId: pr,
        taxCategory: 'UNCLASSIFIED',
        treatment: null,
        reviewState: 'NEEDS_REVIEW',
        origin: 'DEFAULT',
        flags: [],
      });
      expect(await classifications.findDepositTaxMeaning(depositId, OTHER_REALM, today)).toBeUndefined();
      expect(await classifications.findDepositTaxMeaning(UNKNOWN, REALM, today)).toBeUndefined();
      const refused = await classifications.createClassification(depositRequest(depositId, { taxCategory: 'RENT' }), actor);
      expect(refused).toMatchObject({ kind: 'TREATMENT_NOT_ALLOWED', categoryType: null });
      const c = await classifications.createClassification(depositRequest(depositId), actor);
      if (c.kind !== 'CREATED') throw new Error(c.kind);
      expect(c.classification).toMatchObject({
        sourceType: 'DEPOSIT_CLOSING',
        sourceId: depositId,
        depositClosing: { closingDate: '2027-06-30', retainedAmount: eur('400.00') },
        taxYear: null,
      });
      const items = (await list(pr, 2027))?.items ?? [];
      expect(items.map((m) => [m.sourceType, m.taxCategory])).toEqual([
        ['TRANSACTION_SPLIT', 'RENT'],
        ['DEPOSIT_CLOSING', 'RETAINED_DEPOSIT_RENT'],
      ]);
      expect(await classifications.listHistory('DEPOSIT_CLOSING', depositId, REALM)).toHaveLength(1);
      expect(await classifications.listHistory('DEPOSIT_CLOSING', depositId, OTHER_REALM)).toBeUndefined();
      // A second classification without supersedes, as for a split.
      expect(await classifications.createClassification(depositRequest(depositId), actor)).toEqual({
        kind: 'CLASSIFICATION_EXISTS',
        currentClassificationId: c.classification.id,
      });
      // Reopen: the classification stops counting; a create is refused; the list leaves the deposit out.
      expect((await deposits.reopen(depositId, REALM, actor)).kind).toBe('REOPENED');
      expect(await classifications.findDepositTaxMeaning(depositId, REALM, today)).toMatchObject({
        counts: false,
        origin: 'CLASSIFICATION',
        flags: [{ code: 'NOT_COUNTED', details: { depositStatus: 'ACTIVE', reason: 'NOT_CLOSED' } }],
      });
      expect(await classifications.createClassification(depositRequest(depositId, { supersedes: c.classification.id }), actor)).toMatchObject({
        kind: 'DEPOSIT_NOT_COUNTED',
        depositStatus: 'ACTIVE',
        reason: 'NOT_CLOSED',
      });
      expect(await classifications.reviewClassification(c.classification.id, REALM, { kind: 'CONFIRM' }, actor)).toMatchObject({ kind: 'DEPOSIT_NOT_COUNTED' });
      expect((await list(pr, 2027))?.items.map((m) => m.sourceType)).toEqual(['TRANSACTION_SPLIT']);
      // Closed again on another date: the old classification does not count; a new one supersedes it.
      const reclosed = await deposits.close(depositId, REALM, { closingDate: day('2027-07-31'), reason: 'RETAINED', closingNote: 'Schaden Küche' }, actor);
      expect(reclosed.kind).toBe('CLOSED');
      expect(await classifications.findDepositTaxMeaning(depositId, REALM, today)).toMatchObject({
        counts: false,
        flags: [{ code: 'NOT_COUNTED', details: { reason: 'CLOSING_CHANGED' } }],
      });
      const next = await classifications.createClassification(
        depositRequest(depositId, { taxCategory: 'RETAINED_DEPOSIT_DAMAGES', supersedes: c.classification.id }),
        actor,
      );
      expect(next).toMatchObject({ kind: 'CREATED', classification: { depositClosing: { closingDate: '2027-07-31' } } });
      expect(await classifications.findDepositTaxMeaning(depositId, REALM, today)).toMatchObject({ counts: true, taxCategory: 'RETAINED_DEPOSIT_DAMAGES' });
      expect((await classifications.listHistory('DEPOSIT_CLOSING', depositId, REALM))?.map((h) => h.supersededBy === null)).toEqual([false, true]);
    });

    it('no derivable PropertyReference is flagged, never silent: NO_RECONCILED_RENT, SEVERAL_PROPERTY_REFERENCES (review on #166)', async () => {
      const lonely = await retained(nextTenant());
      expect(await classifications.findDepositTaxMeaning(lonely, REALM, today)).toMatchObject({
        counts: true,
        propertyReferenceId: null,
        flags: [{ code: 'NO_PROPERTY_REFERENCE', details: { reason: 'NO_RECONCILED_RENT' } }],
      });
      const tenant = nextTenant();
      const [first, second] = [await propertyReference(), await propertyReference()];
      await rent(first, tenant, '2027-03-01', '2027030100');
      await rent(second, tenant, '2027-04-01', '2027040100');
      const shared = await retained(tenant);
      const several = await classifications.findDepositTaxMeaning(shared, REALM, today);
      expect(several).toMatchObject({ counts: true, propertyReferenceId: null });
      expect(several?.flags).toEqual([
        { code: 'NO_PROPERTY_REFERENCE', details: { reason: 'SEVERAL_PROPERTY_REFERENCES', candidates: [first, second].sort() } },
      ]);
      // In neither property's list; the flag is where it shows (VC-7-04 lists it as "nicht zugeordnet").
      for (const pr of [first, second]) expect((await list(pr, 2027))?.items.map((m) => m.sourceType)).toEqual(['TRANSACTION_SPLIT']);
    });

    it('not CLOSED, or nothing retained: DEPOSIT_NOT_COUNTED; an unknown or foreign deposit: SOURCE_NOT_FOUND', async () => {
      const open = await retained(nextTenant(), OTHER_REALM);
      expect(await classifications.createClassification(depositRequest(open), actor)).toEqual({ kind: 'SOURCE_NOT_FOUND' });
      expect(await classifications.createClassification({ ...depositRequest(open), mreRealmId: OTHER_REALM }, actor)).toMatchObject({
        kind: 'DEPOSIT_NOT_COUNTED',
        reason: 'NOT_CLOSED',
      });
      expect(await classifications.createClassification(depositRequest(UNKNOWN), actor)).toEqual({ kind: 'SOURCE_NOT_FOUND' });
      // Returned in full: closed, nothing retained.
      const created = await deposits.create(
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
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      expect((await deposits.close(created.deposit.id, REALM, { closingDate: day('2027-06-30'), reason: 'RETURNED', closingNote: null }, actor)).kind).toBe(
        'CLOSED',
      );
      expect(await classifications.createClassification(depositRequest(created.deposit.id), actor)).toMatchObject({
        kind: 'DEPOSIT_NOT_COUNTED',
        depositStatus: 'CLOSED',
        reason: 'NOTHING_RETAINED',
      });
    });
  });

  describe('RentalContractReference (§58A)', () => {
    it('create, RENTAL_CONTRACT_REFERENCE_EXISTS, replay; amend with its no-op, If-Match and changedEntries; the reads', async () => {
      const tenant = nextTenant();
      const key = { key: `k-${++counter}`, fingerprint: 'f' };
      const created = await references.createReference(newReference(tenant, due([['2025-01-01', 3]])), actor, key);
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      expect(created.reference).toMatchObject({ mreTenantId: tenant, rentDueDays: [{ validFrom: '2025-01-01', day: 3 }], version: 1 });
      expect(await references.createReference(newReference(tenant), actor, key)).toEqual({ kind: 'REPLAYED', reference: created.reference });
      expect(await references.createReference(newReference(tenant), actor, { key: key.key, fingerprint: 'other' })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
      expect(await references.createReference(newReference(tenant), actor)).toEqual({
        kind: 'REFERENCE_EXISTS',
        rentalContractReferenceId: created.reference.id,
      });
      // One per Tenant and Realm: the same Tenant id in another Realm is another reference.
      expect((await references.createReference(newReference(tenant, [], OTHER_REALM), actor)).kind).toBe('CREATED');
      const id = created.reference.id;
      expect(await references.amendReference(id, REALM, { rentDueDays: due([['2025-01-01', 3]]) }, actor, [9])).toMatchObject({
        kind: 'AMENDED',
        changed: false,
        reference: { version: 1 },
      });
      expect(await references.amendReference(id, REALM, { notes: 'Nachtrag' }, actor, [9])).toEqual({
        kind: 'VERSION_CONFLICT',
        expectedVersions: [9],
        currentVersion: 1,
      });
      const amended = await references.amendReference(
        id,
        REALM,
        {
          rentDueDays: due([
            ['2025-01-01', 5],
            ['2028-01-01', 15],
          ]),
        },
        actor,
        [1],
      );
      expect(amended).toMatchObject({ kind: 'AMENDED', changed: true, reference: { version: 2, notes: null } });
      const audits = await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY new_version`, [id]);
      expect(audits.rows.map((r) => r.action)).toEqual(['CREATED', 'AMENDED']);
      expect(audits.rows[1].metadata).toEqual({
        changedFields: ['rentDueDays'],
        changedEntries: [
          { validFrom: '2025-01-01', from: 3, to: 5 },
          { validFrom: '2028-01-01', from: null, to: 15 },
        ],
      });
      expect(await references.findReference(id, REALM)).toMatchObject({ version: 2 });
      expect(await references.findReference(id, OTHER_REALM)).toBeUndefined();
      expect(await references.findReference('x', REALM)).toBeUndefined();
      expect((await references.findByTenant(tenant, REALM))?.id).toBe(id);
      expect(await references.findByTenant(nextTenant(), REALM)).toBeUndefined();
      expect(await references.amendReference(id, OTHER_REALM, { notes: 'x' }, actor)).toEqual({ kind: 'NOT_FOUND' });
    });
  });

  describe('concurrency on the deposit row (P7-D9)', () => {
    const waitForLock = async (text: string) => {
      const deadline = Date.now() + 5_000;
      while (
        Number(
          (
            await pool.query(
              `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND application_name = current_setting('application_name') AND query LIKE $1`,
              [`%${text}%`],
            )
          ).rows[0].count,
        ) < 1
      ) {
        if (Date.now() > deadline) throw new Error('no session waits on a lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const insertSql = `INSERT INTO tax_classification (mre_realm_id, source_type, security_deposit_id, deposit_closing_date, deposit_retained_amount, tax_category,
         treatment, review_state, rule_code, rule_version, created_by)
       VALUES ($1, 'DEPOSIT_CLOSING', $2, '2027-06-30', 400.00, 'RETAINED_DEPOSIT_RENT', 'INCOME', 'USER_CONFIRMED', 'DE_CATEGORY_DEFAULTS', 1, 'x')`;
    const reopenSql = `UPDATE security_deposit SET status = 'ACTIVE', closing_date = NULL, closing_reason = NULL, closing_note = NULL, held_at_closing = NULL,
         version = version + 1 WHERE id = $1`;
    const countCurrent = async (depositId: string) =>
      Number((await pool.query(`SELECT count(*) FROM tax_classification WHERE security_deposit_id = $1 AND superseded_at IS NULL`, [depositId])).rows[0].count);

    it('RC: a create waiting on a reopen in flight sees it: DEPOSIT_NOT_COUNTED (repository and trigger)', async () => {
      for (const path of ['repository', 'trigger'] as const) {
        const depositId = await retained(nextTenant());
        const holder = await pool.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(reopenSql, [depositId]);
          const creating =
            path === 'repository'
              ? classifications.createClassification(depositRequest(depositId), actor)
              : pool.query(insertSql, [REALM, depositId]).then(() => 'accepted', reasonOf);
          await waitForLock(path === 'repository' ? 'update "security_deposit"' : 'INSERT INTO tax_classification');
          await holder.query('COMMIT');
          if (path === 'repository') expect(await creating, path).toMatchObject({ kind: 'DEPOSIT_NOT_COUNTED', depositStatus: 'ACTIVE' });
          else expect(await creating, path).toBe('(SOURCE_NOT_COUNTED)');
          expect(await countCurrent(depositId)).toBe(0);
        } finally {
          holder.release();
        }
      }
    });

    it('RC: a reopen waiting on a create in flight proceeds; the classification then does not count', async () => {
      const depositId = await retained(nextTenant());
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(insertSql, [REALM, depositId]);
        const reopening = deposits.reopen(depositId, REALM, actor);
        await waitForLock('"security_deposit"');
        await holder.query('COMMIT');
        expect((await reopening).kind).toBe('REOPENED');
        expect(await classifications.findDepositTaxMeaning(depositId, REALM, today)).toMatchObject({ origin: 'CLASSIFICATION', counts: false });
      } finally {
        holder.release();
      }
    });

    it('RR: a create and a reopen of the deposit, both orders: the later one fails to serialise', async () => {
      for (const first of ['create', 'reopen'] as const) {
        const depositId = await retained(nextTenant());
        const [a, b] = [await pool.connect(), await pool.connect()];
        try {
          await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await a.query('SELECT count(*) FROM security_deposit');
          await b.query('SELECT count(*) FROM tax_classification');
          if (first === 'create') await a.query(insertSql, [REALM, depositId]);
          else await a.query(reopenSql, [depositId]);
          const late = (first === 'create' ? b.query(reopenSql, [depositId]) : b.query(insertSql, [REALM, depositId])).then(
            () => 'written',
            (error: { code?: string }) => error.code,
          );
          await waitForLock(first === 'create' ? 'UPDATE security_deposit SET status' : 'INSERT INTO tax_classification');
          await a.query('COMMIT');
          expect(await late, first).toBe('40001');
          await b.query('ROLLBACK');
        } finally {
          a.release();
          b.release();
        }
      }
    });
  });
});
