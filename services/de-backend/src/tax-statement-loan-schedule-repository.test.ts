import { describe, expect, it } from 'vitest';
import { acknowledgeAttributionChange, getTaxYearView, withdrawAcknowledgement, type RealmPrincipal } from './application/index.js';
import { parseRate, reconciledPlan, type SchedulePeriod } from './domains/financing/index.js';
import { TAX_RULES } from './domains/tax-rules/index.js';
import { sha256Fingerprinter as fingerprinter } from './infrastructure/hashing/index.js';
import { createDatabase } from './infrastructure/postgres/database.js';
import { PostgresLoanAllocationRepository } from './infrastructure/postgres/loan-allocation-repository.js';
import { PostgresTaxStatementRepository } from './infrastructure/postgres/tax-statement-repository.js';
import { readTaxYear } from './infrastructure/postgres/tax-year-reads.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import { OTHER_REALM, REALM, actor, databaseUrl, day, useTaxYearDatabase } from './infrastructure/postgres/tax-year.test-support.js';
import { Money } from './shared/index.js';

/**
 * VC-X-54 persistence (api-design.md §58P, migration 0071): `LOAN_TERMS_PART_ADDED`, `LOAN_TERMS_PART_VOIDED` and
 * `LOAN_CLOSED_PART` derived in the view's and the command's snapshots from the `LoanTerms` and `Loan` AuditRecords
 * (Entscheidung des Projektinhabers, 2026-11-05, §58P Fragen 1–11); Examples 1–3 through the real reads, the order of
 * checks with the new kinds (`kind` narrowing, `CHANGE_AMBIGUOUS` from real data, `CHANGE_NOT_FLAGGED`), the part items
 * stored and audited, idempotency, withdrawal, one snapshot, history (the reads write nothing), Realm isolation. The
 * schema tests of 0071 are in `tax-statement-loan-schedule-schema.test.ts`. Synthetic values only.
 */
const principal = (mreRealmId = REALM): RealmPrincipal => ({ mreRealmId, email: actor.actorId }) as RealmPrincipal;
const now = () => new Date('2029-10-30T10:00:00Z');
type Item = { sourceId: string; stateBefore: string; partBefore: { amount: string } | null; stateAfter: string; partAfter: { amount: string } | null };
type Entry = { kind: string; entityType: string; entityId: string; auditRecordId: string; changeFingerprint: string; acknowledgement: unknown; items: Item[] };
type TermsData = Partial<Omit<SchedulePeriod, 'id'>>;

describe.skipIf(databaseUrl === undefined)('terms records and closings as part changes (§58P)', () => {
  const { ctx, propertyReference, booked, split, request: classification } = useTaxYearDatabase('tax_statement_loan_schedule_repository_test');
  const statements = () => new PostgresTaxStatementRepository(createDatabase(ctx.pool));
  const allocations = () => new PostgresLoanAllocationRepository(createDatabase(ctx.pool));
  const acknowledge = () => acknowledgeAttributionChange({ repository: statements(), fingerprinter, now });
  const view = (pr: string, year: number, realm = REALM) =>
    getTaxYearView({ repository: ctx.classifications, fingerprinter, now })({ principal: principal(realm), propertyReferenceId: pr, year, ownerPartyId: null });
  const flagOf = async (pr: string, year: number, code: string) => ((await view(pr, year)).flags.find((f) => f.code === code)?.details ?? []) as Entry[];
  const entries = (pr: string, year: number) => flagOf(pr, year, 'PROPERTY_PART_CHANGED');
  const moved = (e: Entry | undefined) =>
    (e?.items ?? []).map((i) => [i.sourceId, i.stateBefore, i.partBefore?.amount ?? null, i.stateAfter, i.partAfter?.amount ?? null]);
  const interestLine = async (pr: string, year: number) =>
    (await view(pr, year)).werbungskosten.lines.find((l) => l.taxCategory === 'LOAN_INTEREST')?.total.amount ?? '0.00';
  const at = (id: string, iso: string) => ctx.pool.query(`UPDATE audit_record SET occurred_at = $2 WHERE id = $1`, [id, iso]);
  const recordOf = async (entityId: string, action: string) =>
    (await ctx.pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2 ORDER BY occurred_at DESC LIMIT 1`, [entityId, action])).rows[0]
      .id as string;
  const reason = 'Erklärung 2027 noch nicht abgegeben (synthetisch)';
  const request = (pr: string, year: number, e: Pick<Entry, 'auditRecordId' | 'changeFingerprint'>, o: Record<string, unknown> = {}) => ({
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
  async function loan() {
    const created = await ctx.loans.create(
      {
        mreRealmId: REALM,
        lenderPartyId: await party('Bank (synthetisch)'),
        borrowerPartyIds: [await party('Dora (synthetisch)')],
        principalOriginal: Money.of('120000.00', 'EUR'),
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
    return created.loan.id as string;
  }
  /** A terms period of the Loan recorded at `recordedAt`: Loan Q's (`ANNUITY` 3 %, 1 800.00, due 2027-03-31) unless overridden. */
  async function terms(loanId: string, recordedAt: string, o: TermsData = {}) {
    const created = await ctx.terms.create(
      loanId,
      REALM,
      {
        validFrom: day('2027-01-01'),
        interestRate: parseRate('3.000') as never,
        repaymentModel: 'ANNUITY',
        scheduledPayment: Money.of('1800.00', 'EUR'),
        firstPaymentDate: day('2027-03-31'),
        principalAtStart: null,
        fixedRateUntil: null,
        paymentIntervalMonths: 1,
        initialRepaymentRate: null,
        specialRepaymentLimit: null,
        notes: null,
        ...o,
      } as never,
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(JSON.stringify(created));
    const record = await recordOf(created.terms.id, 'CREATED');
    await at(record, recordedAt);
    return { termsId: created.terms.id as string, record };
  }
  async function voidTerms(loanId: string, termsId: string, recordedAt: string) {
    const voided = await ctx.terms.void(loanId, termsId, REALM, 'mit Intervall neu erfasst (synthetisch)', new Date(recordedAt), actor);
    if (voided.kind !== 'VOIDED') throw new Error(JSON.stringify(voided));
    const record = await recordOf(termsId, 'VOIDED');
    await at(record, recordedAt);
    return record;
  }
  async function appendSet(loanId: string, validFrom: string, shares: [string, bigint, bigint][]) {
    const o = await allocations().create(
      loanId,
      REALM,
      {
        validFrom: day(validFrom),
        basis: 'MANUAL',
        allocations: shares.map(([propertyReferenceId, numerator, denominator]) => ({
          propertyReferenceId,
          share: { numerator, denominator },
          acquisitionId: null,
        })),
        notes: null,
      },
      actor,
    );
    if (o.kind !== 'CREATED') throw new Error(JSON.stringify(o));
    await at(await recordOf(o.set.id, 'CREATED'), '2027-01-02T10:00:00Z');
    return o.set.id as string;
  }
  const pay = async (loanId: string, bookingDate: string, interest: string, principal?: string) =>
    (
      await booked([split(interest, 'LOAN_INTEREST', { loanId }), ...(principal === undefined ? [] : [split(principal, 'LOAN_PRINCIPAL', { loanId })])], {
        bookingDate,
      })
    ).splitIds[0] as string;

  /** §58P Example 1: Loan Q, Tm monthly (r0), voided (r1) and re-entered quarterly as Tq (r2) on 2028-02-10. */
  async function example1() {
    const [P1, P2] = [await propertyReference(), await propertyReference()].sort() as [string, string];
    const Q = await loan();
    const tm = await terms(Q, '2027-01-04T10:00:00Z');
    await appendSet(Q, '2027-01-01', [[P1, 1n, 1n]]);
    await appendSet(Q, '2027-03-01', [
      [P1, 1n, 2n],
      [P2, 1n, 2n],
    ]);
    const d1 = await pay(Q, '2027-03-31', '900.00', '900.00');
    await pay(Q, '2027-06-30', '893.25', '906.75');
    await pay(Q, '2027-09-30', '886.45', '913.55');
    await pay(Q, '2027-12-31', '879.60', '920.40');
    const before = [await interestLine(P1, 2027), await interestLine(P2, 2027)];
    const r1 = await voidTerms(Q, tm.termsId, '2028-02-10T09:00:00Z');
    const tq = await terms(Q, '2028-02-10T09:05:00Z', { paymentIntervalMonths: 3 } as TermsData);
    return { P1, P2, Q, d1, tm, r1, tq, before };
  }

  it('Example 1 through the real read: r2 alone is LOAN_TERMS_PART_ADDED in both views (d1 450.00 to 745.00 and to 155.00), the figures as now', async () => {
    const { P1, P2, Q, d1, tq, before } = await example1();
    expect(before).toEqual(['1779.66', '1779.64']);
    expect([await interestLine(P1, 2027), await interestLine(P2, 2027)]).toEqual(['2074.66', '1484.64']);
    const [e1] = (await entries(P1, 2027)) as [Entry];
    expect(await entries(P1, 2027)).toHaveLength(1);
    expect(e1).toMatchObject({
      kind: 'LOAN_TERMS_PART_ADDED',
      entityType: 'LoanTerms',
      entityId: tq.termsId,
      auditRecordId: tq.record,
      loanId: Q,
      termsId: tq.termsId,
      validFrom: '2027-01-01',
    });
    expect(moved(e1)).toEqual([[d1, 'ATTRIBUTED', '450.00', 'ATTRIBUTED', '745.00']]);
    expect(moved((await entries(P2, 2027))[0])).toEqual([[d1, 'ATTRIBUTED', '450.00', 'ATTRIBUTED', '155.00']]);
    // No year moves: no ATTRIBUTION_INPUT_CHANGED; 2028 has no item.
    expect(await flagOf(P1, 2027, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([]);
    expect(await entries(P1, 2028)).toEqual([]);
    // The view's change is the command's: acknowledged with the view's fingerprint.
    const created = await acknowledge()(request(P1, 2027, e1, { kind: 'LOAN_TERMS_PART_ADDED' }));
    expect(created.acknowledgement.change).toMatchObject({
      kind: 'LOAN_TERMS_PART_ADDED',
      entityType: 'LoanTerms',
      entityId: tq.termsId,
      fingerprint: e1.changeFingerprint,
    });
  });

  it('the order of checks: another year or kind CHANGE_NOT_FLAGGED, another fingerprint CHANGE_DIFFERS; the part item stored and audited; idempotent; withdrawn: open again; P2 still open', async () => {
    const { P1, P2, d1, tm, r1, tq } = await example1();
    const e = (await entries(P1, 2027))[0] as Entry;
    const run = acknowledge();
    await expect(run(request(P1, 2028, e))).rejects.toMatchObject({ name: 'AttributionChangeNotFlaggedError', year: 2028 });
    await expect(run(request(P1, 2027, e, { kind: 'LOAN_TERMS_PART_VOIDED' }))).rejects.toMatchObject({ name: 'AttributionChangeNotFlaggedError' });
    await expect(run(request(P1, 2027, e, { kind: 'LOAN_TERMS_ADDED' }))).rejects.toMatchObject({ name: 'AttributionChangeNotFlaggedError' });
    // The void r1 and Tm's creation move nothing: not flagged.
    await expect(run(request(P1, 2027, { ...e, auditRecordId: r1 }))).rejects.toMatchObject({ name: 'AttributionChangeNotFlaggedError' });
    await expect(run(request(P1, 2027, { ...e, auditRecordId: tm.record }))).rejects.toMatchObject({ name: 'AttributionChangeNotFlaggedError' });
    await expect(run(request(P1, 2027, { ...e, changeFingerprint: 'a'.repeat(64) }))).rejects.toMatchObject({ name: 'AttributionChangeDiffersError' });
    const snapshot = await rowsSnapshot(ctx.pool);
    const created = await run(request(P1, 2027, e, { idempotencyKey: 'terms-part-1' }));
    const id = created.acknowledgement.acknowledgementId;
    const stored = await ctx.pool.query(
      `SELECT source_type, source_id, tax_year, state_before, part_before::text, state_after, part_after::text FROM tax_year_acknowledgement_part_item WHERE acknowledgement_id = $1`,
      [id],
    );
    expect(stored.rows).toEqual([
      {
        source_type: 'TRANSACTION_SPLIT',
        source_id: d1,
        tax_year: 2027,
        state_before: 'ATTRIBUTED',
        part_before: '450.00',
        state_after: 'ATTRIBUTED',
        part_after: '745.00',
      },
    ]);
    const row = await ctx.pool.query(`SELECT change_kind, change_entity_type, change_entity_id, audit_record_id FROM tax_year_acknowledgement WHERE id = $1`, [
      id,
    ]);
    expect(row.rows[0]).toEqual({
      change_kind: 'LOAN_TERMS_PART_ADDED',
      change_entity_type: 'LoanTerms',
      change_entity_id: tq.termsId,
      audit_record_id: tq.record,
    });
    const audit = await ctx.pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1`, [id]);
    expect(audit.rows).toEqual([
      {
        action: 'ACKNOWLEDGED',
        metadata: expect.objectContaining({
          kind: 'LOAN_TERMS_PART_ADDED',
          entityType: 'LoanTerms',
          auditRecordId: tq.record,
          items: [
            {
              sourceType: 'TRANSACTION_SPLIT',
              sourceId: d1,
              taxYear: 2027,
              stateBefore: 'ATTRIBUTED',
              partBefore: { amount: '450.00', currency: 'EUR' },
              stateAfter: 'ATTRIBUTED',
              partAfter: { amount: '745.00', currency: 'EUR' },
            },
          ],
        }),
      },
    ]);
    // The inputs' AuditRecords unchanged; no cash, no Loan, no terms, no set written.
    const after = await rowsSnapshot(ctx.pool);
    for (const table of ['ledger_transaction', 'transaction_split', 'loan', 'loan_terms', 'loan_allocation_set', 'tax_classification'])
      expect(after[table], table).toEqual(snapshot[table]);
    expect(after['audit_record']).toBe((snapshot['audit_record'] as number) + 1);
    expect((await run(request(P1, 2027, e, { idempotencyKey: 'terms-part-1' }))).replayed).toBe(true);
    const v = await view(P1, 2027);
    expect([v.review.open.some((o) => o.code === 'PROPERTY_PART_CHANGED'), v.review.info.some((o) => o.code === 'PROPERTY_PART_CHANGED')]).toEqual([
      false,
      true,
    ]);
    expect(await interestLine(P1, 2027)).toBe('2074.66');
    expect((await view(P2, 2027)).review.open.some((o) => o.code === 'PROPERTY_PART_CHANGED')).toBe(true);
    await withdrawAcknowledgement({ repository: statements() })({
      principal: principal(),
      propertyReferenceId: P1,
      year: 2027,
      acknowledgementId: id,
      reason: 'Irrtum (synthetisch)',
    });
    expect((await view(P1, 2027)).review.open.some((o) => o.code === 'PROPERTY_PART_CHANGED')).toBe(true);
  });

  it('Example 2 through the real read: the closing recorded on 2028-01-20 is LOAN_CLOSED_PART, the stub 190.00 from P2 to P1; P1 1 390.00, P2 0.00', async () => {
    const [P1, P2] = [await propertyReference(), await propertyReference()].sort() as [string, string];
    const C = await loan();
    await terms(C, '2027-01-02T09:00:00Z', { repaymentModel: 'INTEREST_ONLY', scheduledPayment: null, firstPaymentDate: day('2027-01-31') } as TermsData);
    await appendSet(C, '2027-01-01', [[P1, 1n, 1n]]);
    await appendSet(C, '2027-05-01', [[P2, 1n, 1n]]);
    for (const d of ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']) await pay(C, d, '300.00');
    const stub = await pay(C, '2027-05-20', '190.00', '120000.00');
    expect([await interestLine(P1, 2027), await interestLine(P2, 2027)]).toEqual(['1200.00', '190.00']);
    const closed = await ctx.loans.close(C, REALM, { closingDate: day('2027-05-20'), reason: 'REPAID', refinancedByLoanId: null, closingNote: null }, actor);
    if (closed.kind !== 'CLOSED') throw new Error(JSON.stringify(closed));
    const r3 = await recordOf(C, 'CLOSED');
    await at(r3, '2028-01-20T08:00:00Z');
    expect([await interestLine(P1, 2027), await interestLine(P2, 2027)]).toEqual(['1390.00', '0.00']);
    const [p1] = (await entries(P1, 2027)) as [Entry];
    expect(p1).toMatchObject({
      kind: 'LOAN_CLOSED_PART',
      entityType: 'Loan',
      entityId: C,
      auditRecordId: r3,
      loanId: C,
      closingDate: '2027-05-20',
      closingReason: 'REPAID',
    });
    expect(moved(p1)).toEqual([[stub, 'NONE', null, 'ATTRIBUTED', '190.00']]);
    expect(moved((await entries(P2, 2027))[0])).toEqual([[stub, 'ATTRIBUTED', '190.00', 'NONE', null]]);
    expect(await flagOf(P1, 2027, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([]);
    // P2 acknowledges its own entry (it has no item of the stub any more): accepted, a NONE part item stored.
    const p2 = (await entries(P2, 2027))[0] as Entry;
    const ack = await acknowledge()(request(P2, 2027, p2, { kind: 'LOAN_CLOSED_PART' }));
    expect(ack.acknowledgement.change).toMatchObject({ kind: 'LOAN_CLOSED_PART', entityType: 'Loan', entityId: C });
    // Question 10: the stub recorded on the classification is used; P2 gets it back, the closing moves it no more.
    const recorded = await ctx.classifications.createClassification(
      classification(stub, { taxCategory: 'LOAN_INTEREST', treatment: 'DEDUCTIBLE', interestPeriod: { from: day('2027-05-01'), until: day('2027-05-20') } }),
      actor,
    );
    expect(recorded.kind).toBe('CREATED');
    expect([await interestLine(P1, 2027), await interestLine(P2, 2027)]).toEqual(['1200.00', '190.00']);
    expect([await entries(P1, 2027), await entries(P2, 2027)]).toEqual([[], []]);
  });

  it('Example 3 through the real read: one terms record a year change and a part change of 2027; CHANGE_AMBIGUOUS without kind, each acknowledged with its kind', async () => {
    const [P1, P2] = [await propertyReference(), await propertyReference()].sort() as [string, string];
    const L = await loan();
    const io = { repaymentModel: 'INTEREST_ONLY', scheduledPayment: null } as TermsData;
    await terms(L, '2027-01-02T09:00:00Z', { ...io, firstPaymentDate: day('2027-02-05') });
    await appendSet(L, '2027-01-01', [[P1, 1n, 1n]]);
    await appendSet(L, '2027-11-01', [
      [P1, 1n, 2n],
      [P2, 1n, 2n],
    ]);
    const ordinary = await pay(L, '2027-12-20', '310.00');
    const january = await pay(L, '2028-01-03', '300.00');
    const r5 = await terms(L, '2028-02-10T09:00:00Z', { ...io, validFrom: day('2027-12-01'), firstPaymentDate: day('2028-02-05'), paymentIntervalMonths: 3 });
    const [year] = (await flagOf(P1, 2027, 'ATTRIBUTION_INPUT_CHANGED')) as [Entry & { items: { sourceId: string; yearBefore: number; yearAfter: number }[] }];
    expect([year.kind, year.auditRecordId, year.items]).toEqual(['LOAN_TERMS_ADDED', r5.record, [{ sourceId: january, yearBefore: 2027, yearAfter: 2028 }]]);
    const [part] = (await entries(P1, 2027)) as [Entry];
    expect([part.kind, part.auditRecordId, moved(part)]).toEqual([
      'LOAN_TERMS_PART_ADDED',
      r5.record,
      [[ordinary, 'ATTRIBUTED', '155.00', 'ATTRIBUTED', '285.00']],
    ]);
    const run = acknowledge();
    await expect(run(request(P1, 2027, part))).rejects.toMatchObject({
      name: 'AttributionChangeAmbiguousError',
      kinds: ['LOAN_TERMS_ADDED', 'LOAN_TERMS_PART_ADDED'],
    });
    await run(request(P1, 2027, part, { kind: 'LOAN_TERMS_PART_ADDED' }));
    const v = await view(P1, 2027);
    expect([v.review.open.some((o) => o.code === 'ATTRIBUTION_INPUT_CHANGED'), v.review.open.some((o) => o.code === 'PROPERTY_PART_CHANGED')]).toEqual([
      true,
      false,
    ]);
    await run(request(P1, 2027, year, { kind: 'LOAN_TERMS_ADDED' }));
    const both = await view(P1, 2027);
    expect(both.review.open.some((o) => o.code === 'ATTRIBUTION_INPUT_CHANGED' || o.code === 'PROPERTY_PART_CHANGED')).toBe(false);
  });

  it('the rebase: a special repayment re-anchors Financing s plan, Taxation keeps the contract plan, no booked period moves; a terms re-entry after the year end flags nothing', async () => {
    const [P1, P2] = [await propertyReference(), await propertyReference()].sort() as [string, string];
    const F = await loan();
    const t = await terms(F, '2027-01-02T09:00:00Z', { firstPaymentDate: day('2027-01-31') });
    await appendSet(F, '2027-01-01', [[P1, 1n, 1n]]);
    await appendSet(F, '2027-08-01', [[P2, 1n, 1n]]);
    const { tx, splitIds } = await booked([split('115000.00', 'LOAN_PRINCIPAL', { loanId: F })], { bookingDate: '2027-04-15' });
    const september = await pay(F, '2027-09-30', '10.00');
    // Financing's plan re-anchored on the actual debt of 5 000.00 from April on ends before September; the September debit
    // re-anchors it again at its matched contract entry, so around a booked debit the rebased plan's dates are the
    // contract's (§58O question 12 (b)): the rebase moves no booked split's period, and Taxation reads the contract plan.
    const periods = ((await ctx.terms.list(F, REALM, 'VALID')) ?? []) as readonly SchedulePeriod[];
    const loanRow = await ctx.loans.findById(F, REALM);
    const special = { transactionId: tx, bookingDate: day('2027-04-15'), category: 'LOAN_PRINCIPAL' as const, amount: 11_500_000n };
    expect(splitIds).toHaveLength(1);
    const early = reconciledPlan(loanRow as never, periods, [special]);
    expect((early.plan.schedule.entries.at(-1)?.paymentDate ?? '') < '2027-09-01').toBe(true);
    expect(early.contract.schedule.entries.some((e) => e.paymentDate === '2027-09-30')).toBe(true);
    const both = reconciledPlan(loanRow as never, periods, [
      special,
      { transactionId: 'sept', bookingDate: day('2027-09-30'), category: 'LOAN_INTEREST', amount: 1_000n },
    ]);
    expect(both.rebases.length).toBeGreaterThan(0);
    const around = (plan: typeof both.plan) => plan.schedule.entries.map((e) => e.paymentDate).filter((d) => d >= '2027-08-01' && d <= '2027-09-30');
    expect(around(both.plan)).toEqual(around(both.contract));
    // The view reads the contract plan: September's period 2027-09-01 – 09-30, wholly P2.
    const v2 = await view(P2, 2027);
    const item = v2.werbungskosten.lines.find((l) => l.taxCategory === 'LOAN_INTEREST')?.items.find((i) => i.sourceId === september);
    expect(item?.loanAllocation?.interestPeriod).toEqual({ from: '2027-09-01', until: '2027-09-30', source: 'LOAN_SCHEDULE' });
    expect([await interestLine(P1, 2027), await interestLine(P2, 2027)]).toEqual(['0.00', '10.00']);
    // The same terms voided and entered again in 2028: both sides the contract plan, no part moves, no flag.
    await voidTerms(F, t.termsId, '2028-02-10T09:00:00Z');
    await terms(F, '2028-02-10T09:05:00Z', { firstPaymentDate: day('2027-01-31') });
    expect([await entries(P1, 2027), await entries(P2, 2027)]).toEqual([[], []]);
  });

  it('one snapshot: a terms record written between the view own reads and the AfA reads is not seen; the next read flags it', async () => {
    const [P1, P2] = [await propertyReference(), await propertyReference()].sort() as [string, string];
    const Q = await loan();
    const tm = await terms(Q, '2027-01-04T10:00:00Z');
    await appendSet(Q, '2027-01-01', [[P1, 1n, 1n]]);
    await appendSet(Q, '2027-03-01', [
      [P1, 1n, 2n],
      [P2, 1n, 2n],
    ]);
    await pay(Q, '2027-03-31', '900.00', '900.00');
    await voidTerms(Q, tm.termsId, '2028-02-10T09:00:00Z');
    const later = async () => {
      await terms(Q, '2028-02-10T09:05:00Z', { paymentIntervalMonths: 3 } as TermsData);
    };
    const read = await readTaxYear(createDatabase(ctx.pool), TAX_RULES, P1, REALM, 2027, null, day('2029-10-30'), undefined, later);
    expect(read?.parts?.loans[0]?.schedule?.terms.length).toBe(1);
    expect((await entries(P1, 2027)).map((e) => e.kind)).toEqual(['LOAN_TERMS_PART_ADDED']);
  });

  it('history: the views write nothing (no row, no AuditRecord); the terms and closing records are read unchanged', async () => {
    const { P1, P2, tm, r1, tq } = await example1();
    const records = async () =>
      (
        await ctx.pool.query(`SELECT id, entity_type, entity_id, action, occurred_at FROM audit_record WHERE id = ANY($1) ORDER BY id`, [
          [tm.record, r1, tq.record],
        ])
      ).rows;
    const kept = await records();
    expect(kept.map((r) => r.action).sort()).toEqual(['CREATED', 'CREATED', 'VOIDED']);
    const snapshot = await rowsSnapshot(ctx.pool);
    for (const pr of [P1, P2]) for (const year of [2027, 2028]) await view(pr, year);
    expect(await rowsSnapshot(ctx.pool)).toEqual(snapshot);
    expect(await records()).toEqual(kept);
  });

  it('Realm isolation: another Realm s terms period on the Loan and its record are never read; its acknowledgements never seen; its ids CHANGE_NOT_FLAGGED', async () => {
    const { P1, Q } = await example1();
    const [entry] = (await entries(P1, 2027)) as [Entry];
    // A fixture the composite keys forbid, built with them dropped in this test schema only: another Realm's terms period
    // on Q due on the 15th from 2027-03-01, recorded after the year (it would move d1 again).
    await ctx.pool.query(`ALTER TABLE loan_terms DROP CONSTRAINT loan_terms_loan_fk`);
    await ctx.pool.query(`ALTER TABLE loan_terms DISABLE TRIGGER USER`);
    let foreign = '';
    try {
      foreign = (
        await ctx.pool.query(
          `INSERT INTO loan_terms (mre_realm_id, loan_id, status, valid_from, interest_rate, repayment_model, first_payment_date, currency, created_by)
           VALUES ($1, $2, 'VALID', '2027-03-01', 3.000, 'INTEREST_ONLY', '2027-03-15', 'EUR', 'x') RETURNING id`,
          [OTHER_REALM, Q],
        )
      ).rows[0].id as string;
      await ctx.pool.query(
        `INSERT INTO audit_record (entity_type, entity_id, action, actor_type, actor_id, new_version, metadata, occurred_at) VALUES ('LoanTerms', $1, 'CREATED', 'USER', 'x', 1, '{}', '2028-05-01T10:00:00Z')`,
        [foreign],
      );
    } finally {
      await ctx.pool.query(`ALTER TABLE loan_terms ENABLE TRIGGER USER`);
    }
    expect((await entries(P1, 2027)).map((e) => e.auditRecordId)).toEqual([entry.auditRecordId]);
    expect(await interestLine(P1, 2027)).toBe('2074.66');
    await acknowledge()(request(P1, 2027, entry));
    expect(await statements().listAcknowledgements(P1, 2027, OTHER_REALM, null)).toBeUndefined();
    await expect(acknowledge()({ ...request(P1, 2027, entry), principal: principal(OTHER_REALM) })).rejects.toMatchObject({
      name: 'PropertyReferenceNotFoundError',
    });
    const theirs = await propertyReference(OTHER_REALM);
    await expect(acknowledge()({ ...request(theirs, 2027, entry), principal: principal(OTHER_REALM) })).rejects.toMatchObject({
      name: 'AttributionChangeNotFlaggedError',
    });
    expect(((await view(theirs, 2027, OTHER_REALM)).flags ?? []).map((f) => f.code)).not.toContain('PROPERTY_PART_CHANGED');
  });
});
