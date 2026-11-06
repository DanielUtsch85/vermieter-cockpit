import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  acknowledgeAttributionChange,
  confirmAllocationSet,
  getTaxYearView,
  withdrawAcknowledgement,
  withdrawConfirmation,
  type RealmPrincipal,
} from './application/index.js';
import type { AllocationRequest } from './domains/financing/index.js';
import { TAX_RULES } from './domains/tax-rules/index.js';
import { Money } from './shared/index.js';
import { sha256Fingerprinter as fingerprinter } from './infrastructure/hashing/index.js';
import { createDatabase } from './infrastructure/postgres/database.js';
import { migrateToLatest } from './infrastructure/postgres/migrate.js';
import { migrations } from './infrastructure/postgres/migrations/index.js';
import { testSchemaName } from './infrastructure/postgres/test-schema.test-support.js';
import { PostgresLoanAllocationRepository } from './infrastructure/postgres/loan-allocation-repository.js';
import { readTaxYear } from './infrastructure/postgres/tax-year-reads.js';
import { PostgresTaxStatementRepository } from './infrastructure/postgres/tax-statement-repository.js';
import { waitForLocks } from './infrastructure/postgres/rent-reconciliation.test-support.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import {
  OTHER_REALM,
  REALM,
  UNKNOWN,
  actor,
  databaseUrl,
  day,
  due,
  nextTenant,
  useTaxYearDatabase,
  withMigrationLock,
} from './infrastructure/postgres/tax-year.test-support.js';

/**
 * VC-X-28 persistence (api-design.md §58E, migration 0060): the orders of checks of both commands and their answers,
 * the no-ops, idempotency, the withdrawals, the view reading the statements in its snapshot, the two concurrency cases,
 * AuditRecords, Realm isolation and "no cash mutated". Figures and names are synthetic.
 */
const principal = (mreRealmId = REALM): RealmPrincipal => ({ mreRealmId, email: actor.actorId }) as RealmPrincipal;
const today = day('2029-10-30');
const now = () => new Date('2029-10-30T10:00:00Z');

describe.skipIf(databaseUrl === undefined)('the statements of the tax-year view (§58E)', () => {
  const { ctx, propertyReference, rent, reference, booked, split } = useTaxYearDatabase('tax_statement_repository_test');
  const statements = () => new PostgresTaxStatementRepository(createDatabase(ctx.pool));
  const acknowledge = (repository = statements()) => acknowledgeAttributionChange({ repository, fingerprinter });
  const taxYear = () => getTaxYearView({ repository: ctx.classifications, fingerprinter, now });
  const at = (id: string, iso: string) => ctx.pool.query(`UPDATE audit_record SET occurred_at = $2 WHERE id = $1`, [id, iso]);
  const recordOf = async (entityId: string, action: string) =>
    (await ctx.pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2`, [entityId, action])).rows[0].id as string;
  const auditsOf = async (entityId: string) =>
    (
      await ctx.pool.query(
        `SELECT entity_type, action, previous_version, new_version, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`,
        [entityId],
      )
    ).rows;

  /** A January 2028 rent paid on 2027-12-29, due day 3, matched on 2028-01-05: the change flagged in 2027 only. */
  async function matchedLate() {
    const pr = await propertyReference();
    const tenant = nextTenant();
    const ref = await reference(tenant, due([['2026-01-01', 3]]));
    await at(await recordOf(ref.id, 'CREATED'), '2026-06-01T10:00:00Z');
    const splitId = await rent(pr, tenant, '2027-12-29', '2028010100');
    const reconciliation = (await ctx.pool.query(`SELECT id FROM rent_payment_reconciliation WHERE mre_tenant_id = $1`, [tenant])).rows[0].id as string;
    const auditRecordId = await recordOf(reconciliation, 'CONFIRMED');
    await at(auditRecordId, '2028-01-05T10:00:00Z');
    const entry = (
      (await taxYear()({ principal: principal(), propertyReferenceId: pr, year: 2027, ownerPartyId: null })).flags.find(
        (f) => f.code === 'ATTRIBUTION_INPUT_CHANGED',
      )?.details as { auditRecordId: string; changeFingerprint: string }[]
    )[0] as { auditRecordId: string; changeFingerprint: string };
    return { pr, splitId, reconciliation, auditRecordId, fingerprint: entry.changeFingerprint };
  }
  const request = (pr: string, year: number, auditRecordId: string, expectedFingerprint: string, reason = 'Erklärung noch nicht abgegeben') => ({
    principal: principal(),
    propertyReferenceId: pr,
    year,
    auditRecordId,
    expectedFingerprint,
    reason,
  });

  it('the acknowledgement in its order of checks: 404, CHANGE_NOT_FLAGGED (another year, another record, another Realm), 412, 201, the no-op; its AuditRecord', async () => {
    const { pr, splitId, auditRecordId, fingerprint } = await matchedLate();
    const run = acknowledge();
    await expect(run(request(UNKNOWN, 2027, auditRecordId, fingerprint))).rejects.toMatchObject({ name: 'PropertyReferenceNotFoundError' });
    const foreign = await propertyReference(OTHER_REALM);
    await expect(run({ ...request(foreign, 2027, auditRecordId, fingerprint), principal: principal(OTHER_REALM) })).rejects.toMatchObject({
      name: 'AttributionChangeNotFlaggedError',
    });
    await expect(run({ ...request(pr, 2027, auditRecordId, fingerprint), principal: principal(OTHER_REALM) })).rejects.toMatchObject({
      name: 'PropertyReferenceNotFoundError',
    });
    await expect(run(request(pr, 2028, auditRecordId, fingerprint))).rejects.toMatchObject({ name: 'AttributionChangeNotFlaggedError', year: 2028 });
    await expect(run(request(pr, 2027, UNKNOWN, fingerprint))).rejects.toMatchObject({
      name: 'AttributionChangeNotFlaggedError',
    });
    await expect(run(request(pr, 2027, auditRecordId, 'f'.repeat(64)))).rejects.toMatchObject({
      name: 'AttributionChangeDiffersError',
      currentFingerprint: fingerprint,
    });
    const before = await rowsSnapshot(ctx.pool);
    const created = await run(request(pr, 2027, auditRecordId, fingerprint));
    expect(created).toMatchObject({ created: true, replayed: false, acknowledgement: { status: 'ACTIVE', version: 1, year: 2027, propertyReferenceId: pr } });
    expect(created.acknowledgement.change).toMatchObject({
      auditRecordId,
      kind: 'RECONCILIATION_CONFIRMED',
      fingerprint,
      items: [{ sourceId: splitId, yearBefore: 2027, yearAfter: 2028 }],
    });
    // Nothing else changed: only the statement's rows and one AuditRecord (the PropertyReference's no-op write keeps its version).
    const after = await rowsSnapshot(ctx.pool);
    for (const table of ['ledger_transaction', 'transaction_split', 'tax_classification', 'rent_payment_reconciliation', 'property_reference']) {
      expect(after[table], table).toEqual(before[table]);
    }
    expect(after['audit_record']).toBe((before['audit_record'] as number) + 1);
    expect(await auditsOf(created.acknowledgement.acknowledgementId)).toEqual([
      {
        entity_type: 'TaxYearAcknowledgement',
        action: 'ACKNOWLEDGED',
        previous_version: null,
        new_version: 1,
        metadata: expect.objectContaining({
          propertyReferenceId: pr,
          year: 2027,
          auditRecordId,
          kind: 'RECONCILIATION_CONFIRMED',
          changeFingerprint: fingerprint,
        }),
      },
    ]);
    // The no-op: the same acknowledgement, whatever reason; no AuditRecord.
    const again = await run(request(pr, 2027, auditRecordId, fingerprint, 'anders'));
    expect([again.created, again.acknowledgement.acknowledgementId, again.acknowledgement.reason]).toEqual([
      false,
      created.acknowledgement.acknowledgementId,
      'Erklärung noch nicht abgegeben',
    ]);
    expect((await rowsSnapshot(ctx.pool))['audit_record']).toBe(after['audit_record']);
  });

  it('idempotency: a replay answers as recorded (also after the withdrawal), another payload under the key 409', async () => {
    const { pr, auditRecordId, fingerprint } = await matchedLate();
    const run = acknowledge();
    const keyed = { ...request(pr, 2027, auditRecordId, fingerprint), idempotencyKey: 'ack-1' };
    const first = await run(keyed);
    await withdrawAcknowledgement({ repository: statements() })({
      principal: principal(),
      propertyReferenceId: pr,
      year: 2027,
      acknowledgementId: first.acknowledgement.acknowledgementId,
      reason: 'Irrtum',
    });
    const replay = await run(keyed);
    expect([replay.replayed, replay.created, replay.acknowledgement.status, replay.acknowledgement.version]).toEqual([true, true, 'ACTIVE', 1]);
    await expect(run({ ...keyed, reason: 'ein anderer' })).rejects.toMatchObject({ name: 'IdempotencyKeyConflictError' });
  });

  it('withdraw: 404 for another year or Realm, If-Match 412, WITHDRAWN with its AuditRecord, the repeat a no-op keeping the first reason; the change open again', async () => {
    const { pr, auditRecordId, fingerprint } = await matchedLate();
    const { acknowledgement } = await acknowledge()(request(pr, 2027, auditRecordId, fingerprint));
    const withdraw = withdrawAcknowledgement({ repository: statements() });
    const input = { principal: principal(), propertyReferenceId: pr, year: 2027, acknowledgementId: acknowledgement.acknowledgementId, reason: 'Irrtum' };
    await expect(withdraw({ ...input, year: 2028 })).rejects.toMatchObject({ name: 'TaxYearAcknowledgementNotFoundError' });
    await expect(withdraw({ ...input, principal: principal(OTHER_REALM) })).rejects.toMatchObject({ name: 'TaxYearAcknowledgementNotFoundError' });
    await expect(withdraw({ ...input, expectedVersions: [2] })).rejects.toMatchObject({ name: 'VersionConflictError', currentVersion: 1 });
    expect(await withdraw({ ...input, expectedVersions: [1] })).toMatchObject({
      status: 'WITHDRAWN',
      version: 2,
      withdrawReason: 'Irrtum',
      withdrawnBy: actor.actorId,
    });
    expect(await withdraw({ ...input, reason: 'anders', expectedVersions: [1] })).toMatchObject({ status: 'WITHDRAWN', version: 2, withdrawReason: 'Irrtum' });
    expect((await auditsOf(acknowledgement.acknowledgementId)).map((a) => [a.action, a.previous_version, a.new_version, a.metadata])).toEqual([
      ['ACKNOWLEDGED', null, 1, expect.anything()],
      ['WITHDRAWN', 1, 2, { reason: 'Irrtum' }],
    ]);
    const view = await taxYear()({ principal: principal(), propertyReferenceId: pr, year: 2027, ownerPartyId: null });
    expect(view.review.open).toContainEqual({ code: 'ATTRIBUTION_INPUT_CHANGED', count: 1 });
  });

  it('the view reads the statements in its one snapshot: one committed between its own reads and the AfA adapter reads is not seen', async () => {
    const { pr, auditRecordId, fingerprint } = await matchedLate();
    const read = await readTaxYear(createDatabase(ctx.pool), TAX_RULES, pr, REALM, 2027, null, today, undefined, async () => {
      await acknowledge()(request(pr, 2027, auditRecordId, fingerprint));
    });
    expect(read?.acknowledgements).toEqual([]);
    const later = await readTaxYear(createDatabase(ctx.pool), TAX_RULES, pr, REALM, 2027, null, today);
    expect(later?.acknowledgements?.map((a) => a.change.auditRecordId)).toEqual([auditRecordId]);
  });

  it('two acknowledgements of one change: they meet on the PropertyReference row; the later fails to serialise, is retried and ends in the no-op', async () => {
    /** Runs `count` acknowledgements of one change: the first held after its derivation until the second waits on the row. */
    const race = async (attempts: number) => {
      const { pr, auditRecordId, fingerprint } = await matchedLate();
      let release: () => void = () => undefined;
      let reached: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const arrived = new Promise<void>((resolve) => (reached = resolve));
      let calls = 0;
      const slow = new PostgresTaxStatementRepository(createDatabase(ctx.pool), TAX_RULES, async () => {
        if (++calls === 1) {
          reached();
          await held;
        }
      });
      const first = acknowledge(slow)(request(pr, 2027, auditRecordId, fingerprint));
      await arrived;
      const second = acknowledgeAttributionChange({ repository: statements(), fingerprinter, attempts })(request(pr, 2027, auditRecordId, fingerprint));
      await waitForLocks(ctx.pool);
      release();
      return { pr, first: await first, second: await second.catch((e: unknown) => e) };
    };
    const { pr, first, second } = await race(3);
    expect([first.created, (second as { created: boolean }).created]).toEqual([true, false]);
    expect((second as { acknowledgement: { acknowledgementId: string } }).acknowledgement.acknowledgementId).toBe(first.acknowledgement.acknowledgementId);
    expect(Number((await ctx.pool.query(`SELECT count(*) AS n FROM tax_year_acknowledgement WHERE property_reference_id = $1`, [pr])).rows[0].n)).toBe(1);
    // With one attempt only, the lost race is 503 CONCURRENT_UPDATE.
    expect((await race(1)).second).toMatchObject({ name: 'ConcurrentUpdateError' });
  });

  /** A Loan with a set from 2027-01-01 (PURCHASE_PRICE over two units, or MANUAL). */
  async function loanWith(basis: 'PURCHASE_PRICE' | 'MANUAL' | 'SINGLE') {
    const [p1, p2] = [await propertyReference(), await propertyReference()];
    const acquisition = async (pr: string, price: string) =>
      (
        await ctx.pool.query(
          `INSERT INTO acquisition (mre_realm_id, property_reference_id, status, purchase_price, currency, acquired_share_numerator, acquired_share_denominator, contract_date, created_by)
           VALUES ($1, $2, 'DRAFT', $3, 'EUR', 1, 1, '2026-06-15', 'x') RETURNING id`,
          [REALM, pr, price],
        )
      ).rows[0].id as string;
    const party = async (name: string) => {
      const o = await ctx.parties.create(
        {
          mreRealmId: REALM,
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
      if (o.kind !== 'CREATED') throw new Error(o.kind);
      return o.party.id;
    };
    const created = await ctx.loans.create(
      {
        mreRealmId: REALM,
        lenderPartyId: await party('Bank'),
        borrowerPartyIds: [await party('Anna')],
        principalOriginal: Money.of('100000.00', 'EUR'),
        startDate: day('2027-01-01'),
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
    const requestOf: AllocationRequest =
      basis === 'MANUAL'
        ? {
            validFrom: day('2027-01-01'),
            basis: 'MANUAL',
            allocations: [
              { propertyReferenceId: p1, share: { numerator: 1n, denominator: 2n }, acquisitionId: null },
              { propertyReferenceId: p2, share: { numerator: 1n, denominator: 2n }, acquisitionId: null },
            ],
            notes: null,
          }
        : {
            validFrom: day('2027-01-01'),
            basis: 'PURCHASE_PRICE',
            allocations: [
              { propertyReferenceId: p1, share: null, acquisitionId: await acquisition(p1, '300000.00') },
              ...(basis === 'SINGLE' ? [] : [{ propertyReferenceId: p2, share: null, acquisitionId: await acquisition(p2, '200000.00') }]),
            ],
            notes: null,
          };
    const set = await new PostgresLoanAllocationRepository(createDatabase(ctx.pool)).create(loanId, REALM, requestOf, actor);
    if (set.kind !== 'CREATED') throw new Error(set.kind);
    return { loanId, setId: set.set.id as string, p1, p2, party };
  }

  it('the confirmation in its order of checks: Loan, set (also of another Loan), advisor, NOTHING_TO_CONFIRM (MANUAL, one entry, VOID), the no-op; its AuditRecord; withdraw', async () => {
    const confirm = confirmAllocationSet({ repository: statements() });
    const { loanId, setId, party } = await loanWith('PURCHASE_PRICE');
    const other = await loanWith('PURCHASE_PRICE');
    const body = { principal: principal(), loanId, allocationSetId: setId, reason: 'Darlehen finanziert beide Käufe', advisorPartyId: null };
    await expect(confirm({ ...body, loanId: UNKNOWN })).rejects.toMatchObject({ name: 'LoanNotFoundError' });
    await expect(confirm({ ...body, principal: principal(OTHER_REALM) })).rejects.toMatchObject({ name: 'LoanNotFoundError' });
    await expect(confirm({ ...body, allocationSetId: other.setId })).rejects.toMatchObject({ name: 'LoanAllocationSetNotFoundError' });
    await expect(confirm({ ...body, advisorPartyId: UNKNOWN })).rejects.toMatchObject({ name: 'PartyNotFoundError' });
    for (const basis of ['MANUAL', 'SINGLE'] as const) {
      const l = await loanWith(basis);
      await expect(confirm({ ...body, loanId: l.loanId, allocationSetId: l.setId }), basis).rejects.toMatchObject({
        name: 'NothingToConfirmError',
        nothingCause: basis === 'MANUAL' ? 'NOT_PURCHASE_PRICE' : 'SINGLE_ENTRY',
      });
    }
    const advisor = await party('Steuerberaterin (synthetisch)');
    const created = await confirm({ ...body, advisorPartyId: advisor });
    expect(created).toMatchObject({ created: true, confirmation: { status: 'ACTIVE', version: 1, advisorPartyId: advisor, set: { basis: 'PURCHASE_PRICE' } } });
    expect(created.confirmation.set.allocations.map((a) => a.share)).toEqual(['3/5', '2/5']);
    const again = await confirm({ ...body, reason: 'anders' });
    expect([again.created, again.confirmation.confirmationId]).toEqual([false, created.confirmation.confirmationId]);
    expect((await auditsOf(created.confirmation.confirmationId)).map((a) => [a.entity_type, a.action, a.new_version])).toEqual([
      ['LoanAllocationTaxConfirmation', 'CONFIRMED', 1],
    ]);
    // The set voided: nothing to confirm any more; the confirmation stays and can still be withdrawn.
    const voided = await new PostgresLoanAllocationRepository(createDatabase(ctx.pool)).void(loanId, setId, REALM, 'Falsch', new Date(), actor);
    expect(voided.kind).toBe('VOIDED');
    await expect(confirm(body)).rejects.toMatchObject({ name: 'NothingToConfirmError', nothingCause: 'SET_VOID' });
    const withdraw = withdrawConfirmation({ repository: statements() });
    const input = { principal: principal(), loanId, allocationSetId: setId, confirmationId: created.confirmation.confirmationId, reason: 'Irrtum' };
    await expect(withdraw({ ...input, allocationSetId: other.setId })).rejects.toMatchObject({ name: 'LoanAllocationTaxConfirmationNotFoundError' });
    expect(await withdraw(input)).toMatchObject({ status: 'WITHDRAWN', version: 2 });
    expect(await withdraw({ ...input, reason: 'anders' })).toMatchObject({ status: 'WITHDRAWN', withdrawReason: 'Irrtum' });
  });

  it('a confirmation against a void of its set: it waits on the Loan row and then sees the void (SET_VOID), never a guard error', async () => {
    const { loanId, setId } = await loanWith('PURCHASE_PRICE');
    const holder = await ctx.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE loan SET version = version WHERE id = $1`, [loanId]);
      await holder.query(`UPDATE loan_allocation_set SET status = 'VOID', voided_at = now(), void_reason = 'x', version = version + 1 WHERE id = $1`, [setId]);
      const confirming = confirmAllocationSet({ repository: statements() })({
        principal: principal(),
        loanId,
        allocationSetId: setId,
        reason: 'x',
        advisorPartyId: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query('COMMIT');
      await expect(confirming).rejects.toMatchObject({ name: 'NothingToConfirmError', nothingCause: 'SET_VOID' });
    } finally {
      holder.release();
    }
  });

  it('the price flag in the view: open without, informative with the ACTIVE confirmation, the same parts; a confirmation of another set clears nothing', async () => {
    const { loanId, setId, p1 } = await loanWith('PURCHASE_PRICE');
    const other = await loanWith('PURCHASE_PRICE');
    const splitId = (await booked([split('250.00', 'LOAN_INTEREST', { loanId })], { bookingDate: '2027-06-30' })).splitIds[0];
    const view = () => taxYear()({ principal: principal(), propertyReferenceId: p1, year: 2027, ownerPartyId: null });
    const item = async () => (await view()).werbungskosten.lines.flatMap((l) => l.items).find((i) => i.sourceId === splitId);
    const before = await item();
    await confirmAllocationSet({ repository: statements() })({
      principal: principal(),
      loanId: other.loanId,
      allocationSetId: other.setId,
      reason: 'x',
      advisorPartyId: null,
    });
    expect((await view()).review.open).toContainEqual({ code: 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', count: 1 });
    await confirmAllocationSet({ repository: statements() })({ principal: principal(), loanId, allocationSetId: setId, reason: 'x', advisorPartyId: null });
    const after = await view();
    expect(after.review.open.map((o) => o.code)).not.toContain('LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY');
    expect(after.review.info).toContainEqual({ code: 'LOAN_ALLOCATION_BY_PURCHASE_PRICE_TO_VERIFY', count: 1 });
    expect((await item())?.lineAmount).toEqual(before?.lineAmount);
    // Realm isolation: another Realm reads no confirmation of this set.
    const foreign = await statements().listConfirmations(loanId, setId, OTHER_REALM);
    expect(foreign).toBe('LOAN_NOT_FOUND');
  });

  it('Realm isolation past the composite keys: another Realm reconciliation of the Transaction and terms of the Loan are never read', async () => {
    const changesOf = async (pr: string) =>
      (await taxYear()({ principal: principal(), propertyReferenceId: pr, year: 2027, ownerPartyId: null })).flags.filter(
        (f) => f.code === 'ATTRIBUTION_INPUT_CHANGED',
      );
    // Fixtures the composite keys forbid, built with them dropped in this test schema only.
    await ctx.pool.query(`ALTER TABLE rent_payment_reconciliation DROP CONSTRAINT rent_payment_reconciliation_transaction_fk`);
    await ctx.pool.query(`ALTER TABLE loan_terms DROP CONSTRAINT loan_terms_loan_fk`);
    const pr = await propertyReference();
    const tenant = nextTenant();
    await reference(tenant, due([['2026-01-01', 3]]));
    const { tx } = await booked([split('800.00', 'RENT_BASE', { propertyReferenceId: pr })], { direction: 'INFLOW', bookingDate: '2027-12-29' });
    const foreign = (
      await ctx.pool.query(
        `INSERT INTO rent_payment_reconciliation (mre_realm_id, status, transaction_id, mre_tenant_id, mre_rent_term, matched_amount, currency, confirmed_at, confirmed_by, created_by)
         VALUES ($1, 'CONFIRMED', $2, $3, '2028010100', 800, 'EUR', now(), 'x', 'x') RETURNING id`,
        [OTHER_REALM, tx, tenant],
      )
    ).rows[0].id as string;
    await ctx.pool.query(
      `INSERT INTO audit_record (entity_type, entity_id, action, actor_type, actor_id, new_version, metadata, occurred_at) VALUES ('RentPaymentReconciliation', $1, 'CONFIRMED', 'USER', 'x', 1, '{}', '2028-01-05T10:00:00Z')`,
      [foreign],
    );
    expect(await changesOf(pr)).toEqual([]);
    const { loanId, p1 } = await loanWith('MANUAL');
    await booked([split('250.00', 'LOAN_INTEREST', { loanId })], { bookingDate: '2028-01-03' });
    const terms = (
      await ctx.pool.query(
        `INSERT INTO loan_terms (mre_realm_id, loan_id, status, valid_from, interest_rate, repayment_model, first_payment_date, currency, created_by)
         VALUES ($1, $2, 'VALID', '2027-01-01', 3.000, 'INTEREST_ONLY', '2027-01-31', 'EUR', 'x') RETURNING id`,
        [OTHER_REALM, loanId],
      )
    ).rows[0].id as string;
    await ctx.pool.query(
      `INSERT INTO audit_record (entity_type, entity_id, action, actor_type, actor_id, new_version, metadata, occurred_at) VALUES ('LoanTerms', $1, 'CREATED', 'USER', 'x', 1, '{}', '2029-02-01T10:00:00Z')`,
      [terms],
    );
    expect(await changesOf(p1)).toEqual([]);
  });

  describe('the schema past the repository (0060)', () => {
    /** An acknowledgement row as SQL: valid unless overridden. */
    const ackRow = (pr: string, o: Record<string, string> = {}) => {
      const v = {
        mre_realm_id: `'${REALM}'`,
        property_reference_id: `'${pr}'`,
        tax_year: '2027',
        audit_record_id: 'gen_random_uuid()',
        change_kind: `'RECONCILIATION_CONFIRMED'`,
        change_entity_type: `'RentPaymentReconciliation'`,
        change_entity_id: 'gen_random_uuid()',
        change_recorded_at: 'now()',
        change_fingerprint: `repeat('a', 64)`,
        reason: `'Grund'`,
        acknowledged_by: `'anna@example.com'`,
        status: `'ACTIVE'`,
        ...o,
      };
      return `INSERT INTO tax_year_acknowledgement (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')}) RETURNING id`;
    };
    const outcome = async (sql: string, params: unknown[] = []) =>
      ctx.pool.query(sql, params).then(
        () => 'accepted',
        (e: { code?: string; message?: string }) =>
          e.code === '23505' ? 'duplicate' : e.code === '23514' ? 'check' : /api-design §58E/.test(e.message ?? '') ? 'guard' : e.code,
      );

    it('an acknowledgement is inserted only ACTIVE, version 1, its kind with its entity, created_txid its own; counter-check: the valid row', async () => {
      const pr = await propertyReference();
      expect(await outcome(ackRow(pr, { status: `'WITHDRAWN'`, withdrawn_at: 'now()', withdrawn_by: `'x'`, withdraw_reason: `'x'` }))).toBe('guard');
      expect(await outcome(ackRow(pr, { version: '2' }))).toBe('guard');
      expect(await outcome(ackRow(pr, { created_txid: '1' }))).toBe('guard');
      expect(await outcome(ackRow(pr, { change_entity_type: `'RentalContractReference'` }))).toBe('check');
      expect(await outcome(ackRow(pr, { change_kind: `'LOAN_ALLOCATION_SET_ADDED'`, change_entity_type: `'LoanTerms'` }))).toBe('check');
      expect(await outcome(ackRow(pr, { change_fingerprint: `repeat('A', 64)` }))).toBe('check');
      expect(await outcome(ackRow(pr, { reason: `' Grund'` }))).toBe('check');
      expect(await outcome(ackRow(pr, { tax_year: '1999' }))).toBe('check');
      expect(await outcome(ackRow(pr, { mre_realm_id: `'${OTHER_REALM}'` }))).toBe('23503');
      expect(await outcome(ackRow(pr))).toBe('accepted');
    });

    it('frozen: only ACTIVE → WITHDRAWN with its three fields and version + 1; never deleted; one ACTIVE per change and fingerprint', async () => {
      const pr = await propertyReference();
      const id = (await ctx.pool.query(ackRow(pr, { audit_record_id: `'${UNKNOWN}'` }))).rows[0].id as string;
      expect(await outcome(`UPDATE tax_year_acknowledgement SET reason = 'anders' WHERE id = $1`, [id])).toBe('guard');
      expect(
        await outcome(
          `UPDATE tax_year_acknowledgement SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_by = 'x', withdraw_reason = 'x' WHERE id = $1`,
          [id],
        ),
      ).toBe('guard');
      expect(
        await outcome(`UPDATE tax_year_acknowledgement SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_by = 'x', version = 2 WHERE id = $1`, [id]),
      ).not.toBe('accepted');
      expect(await outcome(`DELETE FROM tax_year_acknowledgement WHERE id = $1`, [id])).toBe('guard');
      expect(await outcome(ackRow(pr, { audit_record_id: `'${UNKNOWN}'` }))).toBe('duplicate');
      // Counter-checks: another fingerprint of the same record; the withdrawal; then the same change again.
      expect(await outcome(ackRow(pr, { audit_record_id: `'${UNKNOWN}'`, change_fingerprint: `repeat('b', 64)` }))).toBe('accepted');
      expect(
        await outcome(
          `UPDATE tax_year_acknowledgement SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_by = 'x', withdraw_reason = 'x', version = 2 WHERE id = $1`,
          [id],
        ),
      ).toBe('accepted');
      expect(await outcome(`UPDATE tax_year_acknowledgement SET version = 3, withdraw_reason = 'y' WHERE id = $1`, [id])).toBe('guard');
      expect(await outcome(ackRow(pr, { audit_record_id: `'${UNKNOWN}'` }))).toBe('accepted');
    });

    it('items only in the transaction of their acknowledgement, never changed or deleted; counter-check: in the same transaction', async () => {
      const pr = await propertyReference();
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        const id = (await client.query(ackRow(pr))).rows[0].id as string;
        await client.query(`INSERT INTO tax_year_acknowledgement_item VALUES ($1, $2, gen_random_uuid(), 2027, 2028)`, [id, REALM]);
        await client.query('COMMIT');
        expect(await outcome(`INSERT INTO tax_year_acknowledgement_item VALUES ($1, $2, gen_random_uuid(), 2027, 2028)`, [id, REALM])).toBe('guard');
        expect(await outcome(`UPDATE tax_year_acknowledgement_item SET year_after = 2029 WHERE acknowledgement_id = $1`, [id])).toBe('guard');
        expect(await outcome(`DELETE FROM tax_year_acknowledgement_item WHERE acknowledgement_id = $1`, [id])).toBe('guard');
        await client.query('BEGIN');
        const other = (await client.query(ackRow(pr))).rows[0].id as string;
        const same = await client
          .query(`INSERT INTO tax_year_acknowledgement_item VALUES ($1, $2, gen_random_uuid(), 2027, 2027)`, [other, REALM])
          .catch((e: { code: string }) => e.code);
        await client.query('ROLLBACK');
        expect(same).toBe('23514');
      } finally {
        client.release();
      }
    });

    it('a confirmation only of a VALID PURCHASE_PRICE set with two entries, ACTIVE v1, one ACTIVE per set, frozen; counter-check: the valid one', async () => {
      const row = (setId: string, o: Record<string, string> = {}) => {
        const v = { mre_realm_id: `'${REALM}'`, allocation_set_id: `'${setId}'`, reason: `'Grund'`, confirmed_by: `'x'`, status: `'ACTIVE'`, ...o };
        return `INSERT INTO loan_allocation_tax_confirmation (${Object.keys(v).join(', ')}) VALUES (${Object.values(v).join(', ')}) RETURNING id`;
      };
      for (const basis of ['MANUAL', 'SINGLE'] as const) expect(await outcome(row((await loanWith(basis)).setId)), basis).toBe('guard');
      const voided = await loanWith('PURCHASE_PRICE');
      await new PostgresLoanAllocationRepository(createDatabase(ctx.pool)).void(voided.loanId, voided.setId, REALM, 'x', new Date(), actor);
      expect(await outcome(row(voided.setId))).toBe('guard');
      const { setId } = await loanWith('PURCHASE_PRICE');
      expect(await outcome(row(setId, { version: '2' }))).toBe('guard');
      expect(await outcome(row(setId, { mre_realm_id: `'${OTHER_REALM}'` }))).toBe('23503');
      const id = (await ctx.pool.query(row(setId))).rows[0].id as string;
      expect(await outcome(row(setId))).toBe('duplicate');
      expect(await outcome(`UPDATE loan_allocation_tax_confirmation SET reason = 'anders' WHERE id = $1`, [id])).toBe('guard');
      expect(await outcome(`DELETE FROM loan_allocation_tax_confirmation WHERE id = $1`, [id])).toBe('guard');
      expect(
        await outcome(
          `UPDATE loan_allocation_tax_confirmation SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_by = 'x', withdraw_reason = 'x', version = 2 WHERE id = $1`,
          [id],
        ),
      ).toBe('accepted');
    });

    it(
      'up and down under MIGRATION_ADVISORY_LOCK: down refused with a statement present, else drops the three tables and their functions',
      { timeout: 30_000 },
      async () => {
        const downSchema = testSchemaName('tax_statement_down_test');
        const admin = new pg.Client({ connectionString: databaseUrl });
        await admin.connect();
        await admin.query(`CREATE SCHEMA "${downSchema}"`);
        await admin.end();
        const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
        try {
          await migrateToLatest(downPool, { migrationTableSchema: downSchema });
          const migration = migrations['0060_tax_year_acknowledgements'] as { up: (db: never) => Promise<void>; down: (db: never) => Promise<void> };
          const tables = async () =>
            Number(
              (
                await downPool.query(
                  `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('tax_year_acknowledgement', 'tax_year_acknowledgement_item', 'loan_allocation_tax_confirmation')`,
                  [downSchema],
                )
              ).rows[0].n,
            );
          expect(await tables()).toBe(3);
          const pr = (
            await downPool.query(
              `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, '6512f0c2a1b2c3d4e5f6e2ff', 'ACTIVE', 'x') RETURNING id`,
              [REALM],
            )
          ).rows[0].id as string;
          await downPool.query(ackRow(pr));
          let refused: unknown;
          await withMigrationLock(async () => {
            refused = await migration.down(createDatabase(downPool) as never).catch((e: unknown) => e);
          });
          expect(refused).toMatchObject({ code: '23514' });
          expect(await tables()).toBe(3);
          await downPool.query(`ALTER TABLE tax_year_acknowledgement DISABLE TRIGGER USER`);
          await downPool.query(`DELETE FROM tax_year_acknowledgement`);
          // 0063 (VC-X-48) depends on these tables: rolled back first, as the Migrator would, and applied again below.
          const parts = migrations['0063_tax_year_part_acknowledgements'] as typeof migration;
          // 0064 (VC-X-49) builds on 0063: its own down first.
          const further = migrations['0064_tax_year_further_inputs'] as typeof migration;
          // 0065 (VC-X-50) builds on 0064: its own down first.
          const movers = migrations['0065_tax_year_deposit_and_correction_movers'] as typeof migration;
          const loanParts = migrations['0071_tax_year_loan_schedule_part_kinds'] as typeof migration;
          // 0071 (VC-X-54) widens these CHECKs and patches the shape guard after them: its own down first, up again at the end.
          // 0073 (VC-X-57) patches 0072's passages of acquisition_frozen and 0050's functions: rolled back before 0072, not applied again.
          await withMigrationLock(() => (migrations['0073_ownership_start_on_confirm'] as typeof migration).down(createDatabase(downPool) as never));
          // 0072 (VC-X-55) widens the same CHECKs and patches 0067's passage of the shape guard after 0071: rolled back first.
          // It is not applied again below: 0065's up writes its own shape guard, without 0067's passage that 0072 patches.
          await withMigrationLock(() => (migrations['0072_ownership_extend_to_economic_transfer'] as typeof migration).down(createDatabase(downPool) as never));
          await withMigrationLock(() => loanParts.down(createDatabase(downPool) as never));
          await withMigrationLock(() => movers.down(createDatabase(downPool) as never));
          await withMigrationLock(() => further.down(createDatabase(downPool) as never));
          await withMigrationLock(() => parts.down(createDatabase(downPool) as never));
          await withMigrationLock(() => migration.down(createDatabase(downPool) as never));
          expect(await tables()).toBe(0);
          const functions = await downPool.query(
            `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE nspname = $1 AND (proname LIKE 'tax_year_acknowledgement%' OR proname LIKE 'tax_statement%' OR proname LIKE 'loan_allocation_tax%')`,
            [downSchema],
          );
          expect(functions.rows).toEqual([]);
          await withMigrationLock(() => migration.up(createDatabase(downPool) as never));
          await withMigrationLock(() => parts.up(createDatabase(downPool) as never));
          await withMigrationLock(() => further.up(createDatabase(downPool) as never));
          await withMigrationLock(() => movers.up(createDatabase(downPool) as never));
          await withMigrationLock(() => loanParts.up(createDatabase(downPool) as never));
          expect(await tables()).toBe(3);
        } finally {
          await downPool.end();
        }
      },
    );
  });
});
