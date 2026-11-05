import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import { describe, expect, it } from 'vitest';
import { acknowledgeAttributionChange, getTaxYearView, withdrawAcknowledgement, type RealmPrincipal } from './application/index.js';
import { parseRate } from './domains/financing/index.js';
import { parseMea, type Mea } from './domains/weg/index.js';
import { sha256Fingerprinter as fingerprinter } from './infrastructure/hashing/index.js';
import { createDatabase } from './infrastructure/postgres/database.js';
import { PostgresLoanAllocationRepository } from './infrastructure/postgres/loan-allocation-repository.js';
import type { Database } from './infrastructure/postgres/schema.js';
import { PostgresTaxClassificationRepository } from './infrastructure/postgres/tax-classification-repository.js';
import { PostgresTaxStatementRepository } from './infrastructure/postgres/tax-statement-repository.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import { OTHER_REALM, REALM, actor, databaseUrl, day, due, eur, nextTenant, useTaxYearDatabase } from './infrastructure/postgres/tax-year.test-support.js';
import { Money } from './shared/index.js';

/**
 * VC-X-49 persistence (api-design.md §58H, migration 0064): `LOAN_CLOSED` derived in the view's and the command's
 * snapshots from the Loan's `CLOSED` AuditRecord; the deposit's PropertyReference from its Tenant's reconciliation
 * records (`DEPOSIT_RECONCILIATION_CONFIRMED`, `DEPOSIT_RECONCILIATION_RELEASED`); one record as two changes answering
 * `CHANGE_AMBIGUOUS` without `kind` and acknowledged per kind (Entscheidung des Projektinhabers, 2026-11-03, §58G
 * Frage 4); the items stored in their shape and audited; idempotency, withdrawal, Realm isolation, "no cash mutated",
 * the plans; a WEG economic plan added and voided moving nothing (§58H Frage 1). The schema tests of 0064 are in
 * `tax-statement-further-schema.test.ts`. Synthetic values only.
 */
const principal = (mreRealmId = REALM): RealmPrincipal => ({ mreRealmId, email: actor.actorId }) as RealmPrincipal;
const now = () => new Date('2029-10-30T10:00:00Z');
type Entry = { kind: string; auditRecordId: string; changeFingerprint: string; acknowledgement: unknown; items: Record<string, unknown>[] };

describe.skipIf(databaseUrl === undefined)('further silent inputs of the tax year (§58H)', () => {
  const {
    ctx,
    propertyReference,
    booked,
    split,
    reference,
    retained,
    depositRequest,
    request: classification,
  } = useTaxYearDatabase('tax_statement_further_repository_test');
  const statements = () => new PostgresTaxStatementRepository(createDatabase(ctx.pool));
  const acknowledge = () => acknowledgeAttributionChange({ repository: statements(), fingerprinter, now });
  const view = (pr: string, year: number, realm = REALM) =>
    getTaxYearView({ repository: ctx.classifications, fingerprinter, now })({ principal: principal(realm), propertyReferenceId: pr, year, ownerPartyId: null });
  const entries = async (pr: string, year: number, code: string) => ((await view(pr, year)).flags.find((f) => f.code === code)?.details ?? []) as Entry[];
  const level = async (pr: string, year: number, code: string) => {
    const v = await view(pr, year);
    return [v.review.open.some((o) => o.code === code), v.review.info.some((o) => o.code === code)];
  };
  const lineOf = async (pr: string, year: number, category: string) =>
    [...(await view(pr, year)).einnahmen.lines, ...(await view(pr, year)).werbungskosten.lines].find((l) => l.taxCategory === category)?.total.amount ?? '0.00';
  const at = (id: string, iso: string) => ctx.pool.query(`UPDATE audit_record SET occurred_at = $2 WHERE id = $1`, [id, iso]);
  const recordOf = async (entityId: string, action: string) =>
    (await ctx.pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2 ORDER BY occurred_at DESC LIMIT 1`, [entityId, action])).rows[0]
      .id as string;
  const reason = 'Erklärung 2027 noch nicht abgegeben (synthetisch)';
  const ask = (pr: string, year: number, e: Pick<Entry, 'auditRecordId' | 'changeFingerprint'>, o: Record<string, unknown> = {}) => ({
    principal: principal(),
    propertyReferenceId: pr,
    year,
    auditRecordId: e.auditRecordId,
    expectedFingerprint: e.changeFingerprint,
    reason,
    ...o,
  });

  async function party(name: string) {
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
  }
  /**
   * §58H's Loan M: 24,480.00 from 2026-01-01, interest only at 3 % due on the 6th, `MANUAL` 1/1 to P3 from 2026-01-01
   * (recorded in 2025/2026); the last debit on 2028-01-03 (interest 61.20 and the whole principal); closed `REPAID` on
   * 2028-01-03, the record set to `closedAt`.
   */
  async function loanClosed(closedAt: string | null) {
    const P3 = await propertyReference();
    const created = await ctx.loans.create(
      {
        mreRealmId: REALM,
        lenderPartyId: await party('Bank (synthetisch)'),
        borrowerPartyIds: [await party('Dora (synthetisch)')],
        principalOriginal: Money.of('24480.00', 'EUR'),
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
    const M = created.loan.id as string;
    const terms = await ctx.terms.create(
      M,
      REALM,
      {
        validFrom: day('2026-01-01'),
        interestRate: parseRate('3.000') as never,
        repaymentModel: 'INTEREST_ONLY',
        scheduledPayment: null,
        firstPaymentDate: day('2026-01-06'),
        principalAtStart: null,
        fixedRateUntil: null,
        paymentIntervalMonths: 1,
        initialRepaymentRate: null,
        specialRepaymentLimit: null,
        notes: null,
      },
      actor,
    );
    if (terms.kind !== 'CREATED') throw new Error(terms.kind);
    await at(await recordOf(terms.terms.id, 'CREATED'), '2025-12-01T10:00:00Z');
    const set = await new PostgresLoanAllocationRepository(createDatabase(ctx.pool)).create(
      M,
      REALM,
      {
        validFrom: day('2026-01-01'),
        basis: 'MANUAL',
        allocations: [{ propertyReferenceId: P3, share: { numerator: 1n, denominator: 1n }, acquisitionId: null }],
        notes: null,
      },
      actor,
    );
    if (set.kind !== 'CREATED') throw new Error(set.kind);
    await at(await recordOf(set.set.id, 'CREATED'), '2026-01-01T10:00:00Z');
    const { splitIds } = await booked([split('61.20', 'LOAN_INTEREST', { loanId: M }), split('24480.00', 'LOAN_PRINCIPAL', { loanId: M })], {
      bookingDate: '2028-01-03',
    });
    const before = { 2027: await lineOf(P3, 2027, 'LOAN_INTEREST'), 2028: await lineOf(P3, 2028, 'LOAN_INTEREST') };
    let closing = '';
    if (closedAt !== null) {
      const closed = await ctx.loans.close(M, REALM, { closingDate: day('2028-01-03'), reason: 'REPAID', refinancedByLoanId: null, closingNote: null }, actor);
      if (closed.kind !== 'CLOSED') throw new Error(JSON.stringify(closed));
      closing = await recordOf(M, 'CLOSED');
      await at(closing, closedAt);
    }
    return { P3, M, debit: splitIds[0] as string, before, closing };
  }

  it('a Loan closed on 2028-02-15: P3 2027 loses the 61.20 with LOAN_CLOSED open, 2028 gains it unflagged; the order of checks; the year item stored and audited', async () => {
    const { P3, M, debit, before, closing } = await loanClosed('2028-02-15T10:00:00Z');
    expect(before).toEqual({ 2027: '61.20', 2028: '0.00' });
    expect([await lineOf(P3, 2027, 'LOAN_INTEREST'), await lineOf(P3, 2028, 'LOAN_INTEREST')]).toEqual(['0.00', '61.20']);
    const [entry] = await entries(P3, 2027, 'ATTRIBUTION_INPUT_CHANGED');
    expect(entry).toMatchObject({
      kind: 'LOAN_CLOSED',
      entityType: 'Loan',
      entityId: M,
      loanId: M,
      closingDate: '2028-01-03',
      closingReason: 'REPAID',
      auditRecordId: closing,
      amendedAt: '2028-02-15T10:00:00.000Z',
      items: [{ sourceId: debit, yearBefore: 2027, yearAfter: 2028 }],
      acknowledgement: null,
    });
    expect([await level(P3, 2027, 'ATTRIBUTION_INPUT_CHANGED'), await entries(P3, 2028, 'ATTRIBUTION_INPUT_CHANGED')]).toEqual([[true, false], []]);
    const e = entry as Entry;
    const run = acknowledge();
    await expect(run(ask(P3, 2028, e))).rejects.toMatchObject({ name: 'AttributionChangeNotFlaggedError', year: 2028 });
    await expect(run(ask(P3, 2027, e, { kind: 'DEPOSIT_RECONCILIATION_CONFIRMED' }))).rejects.toMatchObject({ name: 'AttributionChangeNotFlaggedError' });
    await expect(run(ask(P3, 2027, { ...e, changeFingerprint: 'a'.repeat(64) }))).rejects.toMatchObject({ name: 'AttributionChangeDiffersError' });
    const snapshot = await rowsSnapshot(ctx.pool);
    const created = await run(ask(P3, 2027, e, { kind: 'LOAN_CLOSED', idempotencyKey: 'closed-1' }));
    expect(created.acknowledgement.change).toMatchObject({
      kind: 'LOAN_CLOSED',
      entityType: 'Loan',
      items: [{ sourceId: debit, yearBefore: 2027, yearAfter: 2028 }],
    });
    const id = created.acknowledgement.acknowledgementId;
    const stored = await ctx.pool.query(
      `SELECT (SELECT count(*) FROM tax_year_acknowledgement_item WHERE acknowledgement_id = $1) AS y, (SELECT count(*) FROM tax_year_acknowledgement_part_item WHERE acknowledgement_id = $1) AS p`,
      [id],
    );
    expect(stored.rows[0]).toEqual({ y: '1', p: '0' });
    const audit = await ctx.pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1`, [id]);
    expect(audit.rows).toEqual([
      { action: 'ACKNOWLEDGED', metadata: expect.objectContaining({ kind: 'LOAN_CLOSED', entityType: 'Loan', auditRecordId: closing }) },
    ]);
    const after = await rowsSnapshot(ctx.pool);
    for (const table of ['ledger_transaction', 'transaction_split', 'loan', 'loan_terms', 'loan_allocation_set'])
      expect(after[table], table).toEqual(snapshot[table]);
    // Idempotent under the key; informative; the figures unchanged; withdrawn: open again.
    expect((await run(ask(P3, 2027, e, { kind: 'LOAN_CLOSED', idempotencyKey: 'closed-1' }))).replayed).toBe(true);
    expect([await level(P3, 2027, 'ATTRIBUTION_INPUT_CHANGED'), await lineOf(P3, 2027, 'LOAN_INTEREST')]).toEqual([[false, true], '0.00']);
    await withdrawAcknowledgement({ repository: statements() })({
      principal: principal(),
      propertyReferenceId: P3,
      year: 2027,
      acknowledgementId: id,
      reason: 'Irrtum',
    });
    expect(await level(P3, 2027, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([true, false]);
    // Realm isolation: another Realm's PropertyReference with M's record is not flagged.
    const theirs = await propertyReference(OTHER_REALM);
    await expect(acknowledge()({ ...ask(theirs, 2027, e), principal: principal(OTHER_REALM) })).rejects.toMatchObject({
      name: 'AttributionChangeNotFlaggedError',
    });
  });

  it('a Loan closed on 2029-01-10 flags both years; a Loan not closed flags none and keeps the 61.20 in 2027', async () => {
    const late = await loanClosed('2029-01-10T10:00:00Z');
    expect([(await entries(late.P3, 2027, 'ATTRIBUTION_INPUT_CHANGED')).length, (await entries(late.P3, 2028, 'ATTRIBUTION_INPUT_CHANGED')).length]).toEqual([
      1, 1,
    ]);
    const open = await loanClosed(null);
    expect([await entries(open.P3, 2027, 'ATTRIBUTION_INPUT_CHANGED'), await lineOf(open.P3, 2027, 'LOAN_INTEREST')]).toEqual([[], '61.20']);
  });

  /** A payment of `amount` booked on `pr` and matched to `term` of `tenant`; the reconciliation and its CONFIRMED record set to `confirmedAt`. */
  async function matched(pr: string, tenant: string, amount: string, bookingDate: string, term: string, confirmedAt: string) {
    const { tx, splitIds } = await booked([split(amount, 'RENT_BASE', { propertyReferenceId: pr })], { direction: 'INFLOW', bookingDate });
    const created = await ctx.reconciliations.create(
      { mreRealmId: REALM, transactionId: tx, mreTenantId: tenant, mreRentTerm: term, matchedAmount: eur(amount), notes: null },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const auditRecordId = await recordOf(created.reconciliation.id, 'CONFIRMED');
    await at(auditRecordId, confirmedAt);
    return { reconciliationId: created.reconciliation.id as string, auditRecordId, splitId: splitIds[0] as string };
  }
  /** §58H's deposit (here 400.00 retained, 2027-06-30): T's rent on P1 matched in 2027, D classified RETAINED_DEPOSIT_RENT / INCOME. */
  async function deposit() {
    const [P1, P2] = [await propertyReference(), await propertyReference()];
    const T = nextTenant();
    await matched(P1, T, '900.00', '2027-03-01', '2027030100', '2027-03-05T10:00:00Z');
    const D = await retained(T);
    const c = await ctx.classifications.createClassification(depositRequest(D), actor);
    if (c.kind !== 'CREATED') throw new Error(c.kind);
    return { P1, P2, T, D };
  }
  const depositItem = (D: string, stateBefore: string, partBefore: string | null, stateAfter: string, partAfter: string | null) => ({
    sourceType: 'DEPOSIT_CLOSING',
    sourceId: D,
    taxYear: 2027,
    stateBefore,
    partBefore: partBefore === null ? null : { amount: partBefore, currency: 'EUR' },
    stateAfter,
    partAfter: partAfter === null ? null : { amount: partAfter, currency: 'EUR' },
  });

  it('the deposit moved by a match on P2 (2028-02-10) and back by its release (2028-02-20): P1 two entries, P2 none; acknowledged per kind, part items stored', async () => {
    const { P1, P2, T, D } = await deposit();
    expect([await lineOf(P1, 2027, 'RETAINED_DEPOSIT_RENT'), await entries(P1, 2027, 'PROPERTY_PART_CHANGED')]).toEqual(['400.00', []]);
    const untouched = await rowsSnapshot(ctx.pool);
    const second = await matched(P2, T, '80.00', '2027-05-03', '2027050100', '2028-02-10T10:00:00Z');
    const p1 = await view(P1, 2027);
    expect(p1.einnahmen.lines.find((l) => l.taxCategory === 'RETAINED_DEPOSIT_RENT')?.total.amount).toBe('0.00');
    expect(p1.notAttributed.items.map((i) => [i.sourceId, i.flags.map((f) => f.code)])).toEqual([[D, expect.arrayContaining(['PROPERTY_PART_CHANGED'])]]);
    const [entry] = await entries(P1, 2027, 'PROPERTY_PART_CHANGED');
    expect(entry).toMatchObject({
      kind: 'DEPOSIT_RECONCILIATION_CONFIRMED',
      entityType: 'RentPaymentReconciliation',
      entityId: second.reconciliationId,
      reconciliationId: second.reconciliationId,
      mreTenantId: T,
      mreRentTerm: '2027050100',
      securityDepositIds: [D],
      auditRecordId: second.auditRecordId,
      items: [depositItem(D, 'ATTRIBUTED', '400.00', 'NOT_ATTRIBUTED', null)],
    });
    // P2 lists D not attributed, never flagged; the 80.00 is mid-year, so no year flag anywhere.
    const p2 = await view(P2, 2027);
    expect(p2.notAttributed.items.map((i) => [i.sourceId, i.flags.some((f) => f.code === 'PROPERTY_PART_CHANGED')])).toEqual([[D, false]]);
    // Each code alone (a not.arrayContaining of several codes would pass with one of them present).
    const p2Codes = p2.flags.map((f) => f.code);
    for (const code of ['PROPERTY_PART_CHANGED', 'ATTRIBUTION_INPUT_CHANGED']) expect(p2Codes).not.toContain(code);
    expect(p1.flags.map((f) => f.code)).not.toContain('ATTRIBUTION_INPUT_CHANGED');
    // Released on 2028-02-20: D is P1's again.
    const released = await ctx.reconciliations.release(second.reconciliationId, REALM, 'Zahlung eines anderen Mieters (synthetisch)', new Date(), actor);
    expect(released.kind).toBe('RELEASED');
    const release = await recordOf(second.reconciliationId, 'RELEASED');
    await at(release, '2028-02-20T10:00:00Z');
    expect(await lineOf(P1, 2027, 'RETAINED_DEPOSIT_RENT')).toBe('400.00');
    const both = await entries(P1, 2027, 'PROPERTY_PART_CHANGED');
    expect(both.map((x) => [x.kind, x.auditRecordId, x.items])).toEqual([
      ['DEPOSIT_RECONCILIATION_CONFIRMED', second.auditRecordId, [depositItem(D, 'ATTRIBUTED', '400.00', 'NOT_ATTRIBUTED', null)]],
      ['DEPOSIT_RECONCILIATION_RELEASED', release, [depositItem(D, 'NOT_ATTRIBUTED', null, 'ATTRIBUTED', '400.00')]],
    ]);
    expect(await entries(P2, 2027, 'PROPERTY_PART_CHANGED')).toEqual([]);
    // Acknowledged per kind: the part items in 0063's table with source_type DEPOSIT_CLOSING, the AuditRecord in the part shape.
    const run = acknowledge();
    const first = await run(ask(P1, 2027, both[0] as Entry, { kind: 'DEPOSIT_RECONCILIATION_CONFIRMED' }));
    expect(await level(P1, 2027, 'PROPERTY_PART_CHANGED')).toEqual([true, false]);
    const last = await run(ask(P1, 2027, both[1] as Entry));
    expect(await level(P1, 2027, 'PROPERTY_PART_CHANGED')).toEqual([false, true]);
    const items = await ctx.pool.query(
      `SELECT source_type, source_id, state_before, part_before::text, state_after, part_after::text FROM tax_year_acknowledgement_part_item WHERE acknowledgement_id IN ($1, $2) ORDER BY state_before`,
      [first.acknowledgement.acknowledgementId, last.acknowledgement.acknowledgementId],
    );
    expect(items.rows).toEqual([
      { source_type: 'DEPOSIT_CLOSING', source_id: D, state_before: 'ATTRIBUTED', part_before: '400.00', state_after: 'NOT_ATTRIBUTED', part_after: null },
      { source_type: 'DEPOSIT_CLOSING', source_id: D, state_before: 'NOT_ATTRIBUTED', part_before: null, state_after: 'ATTRIBUTED', part_after: '400.00' },
    ]);
    const audit = await ctx.pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'ACKNOWLEDGED'`, [
      first.acknowledgement.acknowledgementId,
    ]);
    expect(audit.rows[0].metadata).toMatchObject({
      kind: 'DEPOSIT_RECONCILIATION_CONFIRMED',
      items: [depositItem(D, 'ATTRIBUTED', '400.00', 'NOT_ATTRIBUTED', null)],
    });
    // No deposit and no classification changed by the moves and the acknowledgements.
    const after = await rowsSnapshot(ctx.pool);
    expect(after['security_deposit']).toEqual(untouched['security_deposit']);
    expect(after['tax_classification']).toEqual(untouched['tax_classification']);
  });

  it('a reconciled Transaction with a rent split on P1 and a non-rent split on P2: D stays P1 s, P2 has no entry; its release after the year flags P1', async () => {
    const [P1, P2] = [await propertyReference(), await propertyReference()];
    const T = nextTenant();
    // Only the rent split's PropertyReference counts for the deposit (§58A, DEPOSIT_RENT_CODES), never OTHER_INCOME's.
    const { tx } = await booked([split('900.00', 'RENT_BASE', { propertyReferenceId: P1 }), split('50.00', 'OTHER_INCOME', { propertyReferenceId: P2 })], {
      direction: 'INFLOW',
      bookingDate: '2027-03-01',
    });
    const created = await ctx.reconciliations.create(
      { mreRealmId: REALM, transactionId: tx, mreTenantId: T, mreRentTerm: '2027030100', matchedAmount: eur('900.00'), notes: null },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    await at(await recordOf(created.reconciliation.id, 'CONFIRMED'), '2027-03-05T10:00:00Z');
    const D = await retained(T);
    const c = await ctx.classifications.createClassification(depositRequest(D), actor);
    if (c.kind !== 'CREATED') throw new Error(c.kind);
    expect([await lineOf(P1, 2027, 'RETAINED_DEPOSIT_RENT'), (await view(P2, 2027)).notAttributed.items.map((i) => i.sourceId)]).toEqual(['400.00', []]);
    expect([await entries(P1, 2027, 'PROPERTY_PART_CHANGED'), await entries(P2, 2027, 'PROPERTY_PART_CHANGED')]).toEqual([[], []]);
    // Released on 2028-02-20: D has no reconciled rent; P1 ATTRIBUTED 400.00 to NOT_ATTRIBUTED, P2 NONE to NOT_ATTRIBUTED (no entry).
    expect((await ctx.reconciliations.release(created.reconciliation.id, REALM, 'Falsch zugeordnet (synthetisch)', new Date(), actor)).kind).toBe('RELEASED');
    const release = await recordOf(created.reconciliation.id, 'RELEASED');
    await at(release, '2028-02-20T10:00:00Z');
    expect((await entries(P1, 2027, 'PROPERTY_PART_CHANGED')).map((e) => [e.kind, e.auditRecordId, e.items])).toEqual([
      ['DEPOSIT_RECONCILIATION_RELEASED', release, [depositItem(D, 'ATTRIBUTED', '400.00', 'NOT_ATTRIBUTED', null)]],
    ]);
    expect(await entries(P2, 2027, 'PROPERTY_PART_CHANGED')).toEqual([]);
  });

  it('CHANGE_AMBIGUOUS on real data: the first match of a Tenant (a January rent paid on 2027-12-30) moves its year and its deposit; each acknowledged by its kind', async () => {
    const P = await propertyReference();
    const T = nextTenant();
    const ref = await reference(T, due([['2026-01-01', 1]]));
    await at(await recordOf(ref.id, 'CREATED'), '2026-06-01T10:00:00Z');
    const D = await retained(T);
    const { auditRecordId, splitId } = await matched(P, T, '900.00', '2027-12-30', '2028010100', '2028-02-10T10:00:00Z');
    const [year] = await entries(P, 2027, 'ATTRIBUTION_INPUT_CHANGED');
    const [part] = await entries(P, 2027, 'PROPERTY_PART_CHANGED');
    expect([year?.kind, year?.auditRecordId, year?.items]).toEqual([
      'RECONCILIATION_CONFIRMED',
      auditRecordId,
      [{ sourceId: splitId, yearBefore: 2027, yearAfter: 2028 }],
    ]);
    expect([part?.kind, part?.auditRecordId, part?.items]).toEqual([
      'DEPOSIT_RECONCILIATION_CONFIRMED',
      auditRecordId,
      [depositItem(D, 'NOT_ATTRIBUTED', null, 'ATTRIBUTED', '400.00')],
    ]);
    expect(year?.changeFingerprint).not.toBe(part?.changeFingerprint);
    const run = acknowledge();
    const snapshot = await rowsSnapshot(ctx.pool);
    await expect(run(ask(P, 2027, part as Entry))).rejects.toMatchObject({
      name: 'AttributionChangeAmbiguousError',
      auditRecordId,
      year: 2027,
      kinds: ['DEPOSIT_RECONCILIATION_CONFIRMED', 'RECONCILIATION_CONFIRMED'],
    });
    expect(await rowsSnapshot(ctx.pool)).toEqual(snapshot);
    // The other kind's fingerprint under a kind: 412.
    await expect(
      run(ask(P, 2027, { auditRecordId, changeFingerprint: year?.changeFingerprint as string }, { kind: 'DEPOSIT_RECONCILIATION_CONFIRMED' })),
    ).rejects.toMatchObject({
      name: 'AttributionChangeDiffersError',
    });
    await run(ask(P, 2027, part as Entry, { kind: 'DEPOSIT_RECONCILIATION_CONFIRMED' }));
    // One acknowledgement clears only its own change.
    expect([await level(P, 2027, 'PROPERTY_PART_CHANGED'), await level(P, 2027, 'ATTRIBUTION_INPUT_CHANGED')]).toEqual([
      [false, true],
      [true, false],
    ]);
    await run(ask(P, 2027, year as Entry, { kind: 'RECONCILIATION_CONFIRMED' }));
    expect(await level(P, 2027, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([false, true]);
    const listed = await statements().listAcknowledgements(P, 2027, REALM, ['ACTIVE']);
    expect(listed?.map((a) => [a.change.kind, a.change.auditRecordId]).sort()).toEqual([
      ['DEPOSIT_RECONCILIATION_CONFIRMED', auditRecordId],
      ['RECONCILIATION_CONFIRMED', auditRecordId],
    ]);
  });

  it('Realm isolation: another Realm s reconciliation of the same Tenant id is never read; its ids are not flagged here', async () => {
    const { P1, T } = await deposit();
    const account = await ctx.accounts.create({ mreRealmId: OTHER_REALM, accountType: 'BANK', displayName: 'Giro B', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const theirs = await propertyReference(OTHER_REALM);
    const tx = await ctx.transactions.createManual(
      {
        mreRealmId: OTHER_REALM,
        financialAccountId: account.account.id,
        amount: eur('80.00'),
        direction: 'INFLOW',
        bookingDate: day('2027-05-03'),
        valueDate: null,
        description: 'Buchung',
        propertyReferenceId: null,
      },
      actor,
    );
    if (tx.kind !== 'CREATED') throw new Error(tx.kind);
    const id = tx.transaction.id;
    await ctx.splits.replaceSplits(id, OTHER_REALM, [split('80.00', 'RENT_BASE', { propertyReferenceId: theirs })], actor);
    expect((await ctx.transactions.confirm(id, OTHER_REALM, actor)).kind).toBe('CONFIRMED');
    const foreign = await ctx.reconciliations.create(
      { mreRealmId: OTHER_REALM, transactionId: id, mreTenantId: T, mreRentTerm: '2027050100', matchedAmount: eur('80.00'), notes: null },
      actor,
    );
    if (foreign.kind !== 'CREATED') throw new Error(foreign.kind);
    const record = await recordOf(foreign.reconciliation.id, 'CONFIRMED');
    await at(record, '2028-02-10T10:00:00Z');
    expect([await lineOf(P1, 2027, 'RETAINED_DEPOSIT_RENT'), await entries(P1, 2027, 'PROPERTY_PART_CHANGED')]).toEqual(['400.00', []]);
    await expect(acknowledge()(ask(P1, 2027, { auditRecordId: record, changeFingerprint: 'a'.repeat(64) }))).rejects.toMatchObject({
      name: 'AttributionChangeNotFlaggedError',
    });
    expect((await view(theirs, 2027, OTHER_REALM)).flags.map((f) => f.code)).not.toContain('PROPERTY_PART_CHANGED');
  });

  it('no cash mutated: the views write nothing with the new kinds present', async () => {
    const { P1, P2, T } = await deposit();
    await matched(P2, T, '80.00', '2027-05-03', '2027050100', '2028-02-10T10:00:00Z');
    const { P3 } = await loanClosed('2028-02-15T10:00:00Z');
    const snapshot = await rowsSnapshot(ctx.pool);
    for (const pr of [P1, P2, P3]) for (const year of [2027, 2028]) await view(pr, year);
    expect(await rowsSnapshot(ctx.pool)).toEqual(snapshot);
  });

  it('a WEG economic plan voided and replaced after the year (day 1 to day 28) and voided again moves nothing in 2027 (§58H Frage 1)', async () => {
    const weg = await ctx.wegs.createWeg(
      { mreRealmId: REALM, displayName: 'WEG Beispiel (synthetisch)', administratorPartyId: null, financialYearStartMonth: 1, notes: null },
      actor,
    );
    if (weg.kind !== 'CREATED') throw new Error(weg.kind);
    const P4 = await propertyReference();
    const m = await ctx.wegs.createMembership(
      {
        mreRealmId: REALM,
        wegId: weg.weg.id,
        propertyReferenceId: P4,
        mea: (parseMea('125/10000') as { mea: Mea }).mea,
        validFrom: day('2026-01-01'),
        validUntil: null,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (m.kind !== 'CREATED') throw new Error(m.kind);
    const plan = async (advanceDueDay: number, recordedAt: string) => {
      const created = await ctx.plans.createPlan(
        {
          mreRealmId: REALM,
          membershipId: m.membership.id,
          financialYear: 2027,
          effectiveFrom: day('2027-01-01'),
          resolutionDate: null,
          advanceDueDay,
          monthlyHausgeld: eur('250.00'),
          monthlyReserveContribution: eur('0.00'),
          recoverableCosts: eur('2000.00'),
          nonRecoverableCosts: eur('1000.00'),
          income: null,
          annualReserveContribution: null,
          costLines: [],
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      await at(await recordOf(created.plan.id, 'CREATED'), recordedAt);
      return created.plan.id;
    };
    const voidPlan = async (id: string, recordedAt: string) => {
      expect((await ctx.plans.voidPlan(id, REALM, 'Falscher Fälligkeitstag (synthetisch)', new Date(recordedAt), actor)).kind).toBe('VOIDED');
      await at(await recordOf(id, 'VOIDED'), recordedAt);
    };
    const E1 = await plan(1, '2027-01-05T10:00:00Z');
    const { splitIds } = await booked([split('250.00', 'WEG_RECOVERABLE', { propertyReferenceId: P4 })], { bookingDate: '2027-12-30' });
    const debit = splitIds[0] as string;
    const c = await ctx.classifications.createClassification(classification(debit, { taxCategory: 'WEG_HAUSGELD', treatment: 'DEDUCTIBLE' }), actor);
    if (c.kind !== 'CREATED') throw new Error(c.kind);
    const state = async () => {
      const v = await view(P4, 2027);
      const item = [...v.werbungskosten.lines, ...v.einnahmen.lines].flatMap((l) => l.items).find((i) => i.sourceId === debit);
      return {
        line: v.werbungskosten.lines.find((l) => l.taxCategory === 'WEG_HAUSGELD')?.total.amount,
        taxYear: item?.taxYear,
        changes: v.flags.filter((f) => f.code === 'ATTRIBUTION_INPUT_CHANGED' || f.code === 'PROPERTY_PART_CHANGED'),
        open: v.review.open.map((o) => o.code),
        final: v.review.final,
        itemFlags: (item?.flags ?? []).map((f) => f.code),
        proposedYear: (await ctx.classifications.findTaxMeaning(debit, REALM, day('2028-10-30')))?.attribution.proposedYear,
      };
    };
    const before = await state();
    expect([before.line, before.taxYear, before.changes, before.proposedYear, before.itemFlags]).toEqual([
      '250.00',
      2027,
      [],
      2028,
      ['ECONOMIC_PERIOD_ASSUMED'],
    ]);
    await voidPlan(E1, '2028-02-01T10:00:00Z');
    const E2 = await plan(28, '2028-02-01T10:05:00Z');
    const replaced = await state();
    expect([replaced.line, replaced.taxYear, replaced.changes, replaced.proposedYear, replaced.itemFlags, replaced.open, replaced.final]).toEqual([
      '250.00',
      2027,
      [],
      2027,
      [],
      before.open,
      before.final,
    ]);
    await voidPlan(E2, '2028-02-02T10:00:00Z');
    const none = await state();
    expect([none.line, none.taxYear, none.changes, none.itemFlags, none.open, none.final]).toEqual([
      '250.00',
      2027,
      [],
      ['NO_ECONOMIC_PERIOD'],
      before.open,
      before.final,
    ]);
  });

  it('the plans: the CLOSED and the reconciliation records by audit_record_entity_idx, the Tenants reconciliations by the term index, inside the view snapshot', async () => {
    const { P1, P2, T } = await deposit();
    await matched(P2, T, '80.00', '2027-05-03', '2027050100', '2028-02-10T10:00:00Z');
    const { P3 } = await loanClosed('2028-02-15T10:00:00Z');
    const sent: CompiledQuery[] = [];
    const logged = new Kysely<Database>({ dialect: new PostgresDialect({ pool: ctx.pool }), log: (e) => void (e.level === 'query' && sent.push(e.query)) });
    for (const pr of [P1, P3]) await new PostgresTaxClassificationRepository(logged).readTaxYear(pr, REALM, 2027, null, day('2029-10-30'));
    const planOf = async (match: (sql: string, parameters: readonly unknown[]) => boolean) => {
      const query = sent.find((q) => match(q.sql, q.parameters));
      if (query === undefined) throw new Error('query not sent');
      const client = await ctx.pool.connect();
      try {
        await client.query('SET enable_seqscan = off');
        return JSON.stringify((await client.query(`EXPLAIN (FORMAT JSON) ${query.sql}`, [...query.parameters])).rows[0]['QUERY PLAN']);
      } finally {
        await client.query('RESET enable_seqscan');
        client.release();
      }
    };
    expect(await planOf((s, p) => s.includes('from "audit_record"') && p.includes('Loan') && p.includes('CLOSED'))).toContain('audit_record_entity_idx');
    expect(await planOf((s, p) => s.includes('from "audit_record"') && p.includes('RentPaymentReconciliation'))).toContain('audit_record_entity_idx');
    expect(await planOf((s) => s.includes('from "rent_payment_reconciliation" where') && s.includes('"mre_tenant_id" in'))).toContain(
      'rent_payment_reconciliation_term_idx',
    );
  });
});
