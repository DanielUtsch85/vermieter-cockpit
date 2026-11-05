import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import { describe, expect, it } from 'vitest';
import { acknowledgeAttributionChange, getTaxYearView, withdrawAcknowledgement, type RealmPrincipal } from './application/index.js';
import { parseRate, type AllocationRequest } from './domains/financing/index.js';
import { TAX_RULES } from './domains/tax-rules/index.js';
import { sha256Fingerprinter as fingerprinter } from './infrastructure/hashing/index.js';
import { createDatabase } from './infrastructure/postgres/database.js';
import { PostgresLoanAllocationRepository } from './infrastructure/postgres/loan-allocation-repository.js';
import type { Database } from './infrastructure/postgres/schema.js';
import { PostgresTaxClassificationRepository } from './infrastructure/postgres/tax-classification-repository.js';
import { PostgresTaxStatementRepository } from './infrastructure/postgres/tax-statement-repository.js';
import { readTaxYear } from './infrastructure/postgres/tax-year-reads.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import { OTHER_REALM, REALM, actor, databaseUrl, day, useTaxYearDatabase } from './infrastructure/postgres/tax-year.test-support.js';
import { Money } from './shared/index.js';

/**
 * VC-X-48 persistence (api-design.md §58G, migration 0063): the part changes derived in the view's and the command's
 * snapshots from the `LoanAllocationSet` AuditRecords; the order of checks with the optional `kind`; the part items
 * stored and audited; idempotency, withdrawal, one snapshot, Realm isolation, "no cash mutated" and the plans. The
 * schema tests of 0063 are in `tax-statement-part-schema.test.ts`. The example of §58G, synthetic values only.
 */
const principal = (mreRealmId = REALM): RealmPrincipal => ({ mreRealmId, email: actor.actorId }) as RealmPrincipal;
const now = () => new Date('2029-10-30T10:00:00Z');
type Entry = { kind: string; auditRecordId: string; changeFingerprint: string; acknowledgement: unknown; items: { sourceId: string }[] };

describe.skipIf(databaseUrl === undefined)('part changes of the allocation sets (§58G)', () => {
  const { ctx, propertyReference, booked, split } = useTaxYearDatabase('tax_statement_part_repository_test');
  const statements = () => new PostgresTaxStatementRepository(createDatabase(ctx.pool));
  const allocations = () => new PostgresLoanAllocationRepository(createDatabase(ctx.pool));
  const acknowledge = () => acknowledgeAttributionChange({ repository: statements(), fingerprinter, now });
  const taxYear = () => getTaxYearView({ repository: ctx.classifications, fingerprinter, now });
  const view = (pr: string, year: number, realm = REALM) => taxYear()({ principal: principal(realm), propertyReferenceId: pr, year, ownerPartyId: null });
  const entries = async (pr: string, year: number) => ((await view(pr, year)).flags.find((f) => f.code === 'PROPERTY_PART_CHANGED')?.details ?? []) as Entry[];
  const level = async (pr: string, year: number) => {
    const v = await view(pr, year);
    return [v.review.open.some((o) => o.code === 'PROPERTY_PART_CHANGED'), v.review.info.some((o) => o.code === 'PROPERTY_PART_CHANGED')];
  };
  const interestLine = async (pr: string, year: number) =>
    (await view(pr, year)).werbungskosten.lines.find((l) => l.taxCategory === 'LOAN_INTEREST')?.total.amount ?? '0.00';
  const at = (id: string, iso: string) => ctx.pool.query(`UPDATE audit_record SET occurred_at = $2 WHERE id = $1`, [id, iso]);
  const recordOf = async (entityId: string, action: string) =>
    (await ctx.pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2`, [entityId, action])).rows[0].id as string;
  const share = (n: bigint, d: bigint) => ({ numerator: n, denominator: d });

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
  /** A Loan from 2027-01-01 with monthly terms due on the last day of each month, recorded before the years. */
  async function loan() {
    const created = await ctx.loans.create(
      {
        mreRealmId: REALM,
        lenderPartyId: await party('Bank (synthetisch)'),
        borrowerPartyIds: [await party('Anna (synthetisch)')],
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
    const loanId = created.loan.id as string;
    const terms = await ctx.terms.create(
      loanId,
      REALM,
      {
        validFrom: day('2027-01-01'),
        interestRate: parseRate('3.000') as never,
        repaymentModel: 'INTEREST_ONLY',
        scheduledPayment: null,
        firstPaymentDate: day('2027-01-31'),
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
    await at(await recordOf(terms.terms.id, 'CREATED'), '2026-12-01T10:00:00Z');
    return loanId;
  }
  async function appendSet(loanId: string, validFrom: string, entries: readonly (readonly [string, bigint, bigint])[], recordedAt: string) {
    const request: AllocationRequest = {
      validFrom: day(validFrom),
      basis: 'MANUAL',
      allocations: entries.map(([propertyReferenceId, n, d]) => ({ propertyReferenceId, share: share(n, d), acquisitionId: null })),
      notes: null,
    };
    const created = await allocations().create(loanId, REALM, request, actor);
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const setId = created.set.id as string;
    const auditRecordId = await recordOf(setId, 'CREATED');
    await at(auditRecordId, recordedAt);
    return { setId, auditRecordId };
  }
  async function voidSet(loanId: string, setId: string, recordedAt: string) {
    const voided = await allocations().void(loanId, setId, REALM, 'Falsche Aufteilung (synthetisch)', new Date(recordedAt), actor);
    if (voided.kind !== 'VOIDED') throw new Error(voided.kind);
    const auditRecordId = await recordOf(setId, 'VOIDED');
    await at(auditRecordId, recordedAt);
    return auditRecordId;
  }
  /** §58G's example up to step 1: S1 (3/5, 2/5) from 2027-02-01, the four debits, S2 (1/2, 1/2) from 2027-07-01 on 2028-03-01. */
  async function example() {
    const [a, b] = [await propertyReference(), await propertyReference()];
    const [P1, P2] = a < b ? [a, b] : [b, a];
    const L = await loan();
    const S1 = await appendSet(
      L,
      '2027-02-01',
      [
        [P1, 3n, 5n],
        [P2, 2n, 5n],
      ],
      '2027-02-01T10:00:00Z',
    );
    const debit = async (amount: string, bookingDate: string) =>
      (await booked([split(amount, 'LOAN_INTEREST', { loanId: L })], { bookingDate })).splitIds[0] as string;
    const d = [
      await debit('450.01', '2027-03-31'),
      await debit('449.99', '2027-07-30'),
      await debit('448.00', '2028-01-03'),
      await debit('446.00', '2028-06-30'),
    ];
    const before = [await interestLine(P1, 2027), await interestLine(P2, 2027)];
    const S2 = await appendSet(
      L,
      '2027-07-01',
      [
        [P1, 1n, 2n],
        [P2, 1n, 2n],
      ],
      '2028-03-01T10:00:00Z',
    );
    return { P1, P2, L, S1, S2, d, before };
  }
  const request = (pr: string, year: number, e: Pick<Entry, 'auditRecordId' | 'changeFingerprint'>, o: Record<string, unknown> = {}) => ({
    principal: principal(),
    propertyReferenceId: pr,
    year,
    auditRecordId: e.auditRecordId,
    expectedFingerprint: e.changeFingerprint,
    reason: 'Erklärung 2027 noch nicht abgegeben (synthetisch)',
    ...o,
  });

  it('the example: 808.80 to 719.01 and 539.20 to 628.99 in 2027 (1,348.00 both times), both views flagged, 2028 not; no year flag', async () => {
    const { P1, P2, S2, d, before } = await example();
    expect(before).toEqual(['808.80', '539.20']);
    expect([await interestLine(P1, 2027), await interestLine(P2, 2027)]).toEqual(['719.01', '628.99']);
    for (const pr of [P1, P2]) {
      const [entry] = await entries(pr, 2027);
      expect([entry?.kind, entry?.auditRecordId, entry?.items.map((i) => i.sourceId)]).toEqual([
        'LOAN_ALLOCATION_SET_ADDED',
        S2.auditRecordId,
        [d[1], d[2]].sort(),
      ]);
      expect(await level(pr, 2027)).toEqual([true, false]);
      expect(await entries(pr, 2028)).toEqual([]);
      expect((await view(pr, 2027)).flags.map((f) => f.code)).not.toContain('ATTRIBUTION_INPUT_CHANGED');
    }
    expect((await entries(P1, 2027))[0]?.items).toEqual(
      [
        {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: d[1],
          taxYear: 2027,
          stateBefore: 'ATTRIBUTED',
          partBefore: { amount: '269.99', currency: 'EUR' },
          stateAfter: 'ATTRIBUTED',
          partAfter: { amount: '225.00', currency: 'EUR' },
        },
        {
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: d[2],
          taxYear: 2027,
          stateBefore: 'ATTRIBUTED',
          partBefore: { amount: '268.80', currency: 'EUR' },
          stateAfter: 'ATTRIBUTED',
          partAfter: { amount: '224.00', currency: 'EUR' },
        },
      ].sort((x, y) => ((x.sourceId as string) < (y.sourceId as string) ? -1 : 1)),
    );
    expect(await interestLine(P1, 2028)).toBe('223.00');
  });

  it('the order of checks: CHANGE_NOT_FLAGGED (a year the record does not touch, another kind named), 412, 201 with part items and AuditRecord, the no-op', async () => {
    const { P1, P2, S2 } = await example();
    const [entry] = (await entries(P1, 2027)) as [Entry];
    const run = acknowledge();
    await expect(run(request(P1, 2028, entry))).rejects.toMatchObject({ name: 'AttributionChangeNotFlaggedError', year: 2028, kind: undefined });
    await expect(run(request(P1, 2027, entry, { kind: 'LOAN_ALLOCATION_SET_VOIDED' }))).rejects.toMatchObject({
      name: 'AttributionChangeNotFlaggedError',
      kind: 'LOAN_ALLOCATION_SET_VOIDED',
    });
    await expect(run(request(P1, 2027, entry, { kind: 'LOAN_TERMS_ADDED' }))).rejects.toMatchObject({ name: 'AttributionChangeNotFlaggedError' });
    await expect(run(request(P1, 2027, { ...entry, changeFingerprint: 'a'.repeat(64) }))).rejects.toMatchObject({
      name: 'AttributionChangeDiffersError',
      currentFingerprint: entry.changeFingerprint,
    });
    const snapshot = await rowsSnapshot(ctx.pool);
    const created = await run(request(P1, 2027, entry, { kind: 'LOAN_ALLOCATION_SET_ADDED' }));
    expect(created).toMatchObject({
      created: true,
      acknowledgement: { status: 'ACTIVE', version: 1, change: { kind: 'LOAN_ALLOCATION_SET_ADDED', entityType: 'LoanAllocationSet', entityId: S2.setId } },
    });
    expect(created.acknowledgement.change.items.map((i) => ('stateBefore' in i ? [i.stateBefore, i.partBefore?.amount, i.partAfter?.amount] : i))).toEqual(
      expect.arrayContaining([
        ['ATTRIBUTED', '269.99', '225.00'],
        ['ATTRIBUTED', '268.80', '224.00'],
      ]),
    );
    const id = created.acknowledgement.acknowledgementId;
    const rows = async (table: string) => Number((await ctx.pool.query(`SELECT count(*) AS n FROM ${table} WHERE acknowledgement_id = $1`, [id])).rows[0].n);
    expect([await rows('tax_year_acknowledgement_part_item'), await rows('tax_year_acknowledgement_item')]).toEqual([2, 0]);
    const audit = (await ctx.pool.query(`SELECT entity_type, action, new_version, metadata FROM audit_record WHERE entity_id = $1`, [id])).rows;
    expect(audit).toEqual([
      {
        entity_type: 'TaxYearAcknowledgement',
        action: 'ACKNOWLEDGED',
        new_version: 1,
        metadata: expect.objectContaining({
          kind: 'LOAN_ALLOCATION_SET_ADDED',
          entityType: 'LoanAllocationSet',
          auditRecordId: S2.auditRecordId,
          changeFingerprint: entry.changeFingerprint,
        }),
      },
    ]);
    expect((audit[0].metadata.items as { partBefore: unknown }[]).map((i) => i.partBefore)).toEqual(
      expect.arrayContaining([
        { amount: '269.99', currency: 'EUR' },
        { amount: '268.80', currency: 'EUR' },
      ]),
    );
    // Only the acknowledgement, its part items and its AuditRecord were written.
    const after = await rowsSnapshot(ctx.pool);
    for (const table of Object.keys(after).filter(
      (t) => !['tax_year_acknowledgement', 'tax_year_acknowledgement_part_item', 'audit_record', 'property_reference'].includes(t),
    ))
      expect(after[table], table).toEqual(snapshot[table]);
    expect(after['audit_record']).toBe((snapshot['audit_record'] as number) + 1);
    // The no-op, with or without the kind, whatever the reason.
    for (const o of [{}, { kind: 'LOAN_ALLOCATION_SET_ADDED' }]) {
      const again = await run(request(P1, 2027, entry, { ...o, reason: 'ein anderer Grund' }));
      expect([again.created, again.acknowledgement.acknowledgementId]).toEqual([false, id]);
    }
    // P1 informative, the figures unchanged; P2 still open, and P1's fingerprint does not fit P2's change.
    expect([await level(P1, 2027), await interestLine(P1, 2027)]).toEqual([[false, true], '719.01']);
    expect(await level(P2, 2027)).toEqual([true, false]);
    await expect(run(request(P2, 2027, entry))).rejects.toMatchObject({ name: 'AttributionChangeDiffersError' });
  });

  it('idempotency: the kind is part of the payload; a replay answers as recorded; withdraw re-opens; step 2 flags both years', async () => {
    const { P1, P2, L, S2, d } = await example();
    const [entry] = (await entries(P1, 2027)) as [Entry];
    const run = acknowledge();
    const keyed = { ...request(P1, 2027, entry), idempotencyKey: 'part-1' };
    const first = await run(keyed);
    expect((await run(keyed)).replayed).toBe(true);
    await expect(run({ ...keyed, kind: 'LOAN_ALLOCATION_SET_ADDED' })).rejects.toMatchObject({ name: 'IdempotencyKeyConflictError' });
    const withdrawn = await withdrawAcknowledgement({ repository: statements() })({
      principal: principal(),
      propertyReferenceId: P1,
      year: 2027,
      acknowledgementId: first.acknowledgement.acknowledgementId,
      reason: 'Irrtum (synthetisch)',
    });
    expect([withdrawn.status, withdrawn.change.items.length]).toEqual(['WITHDRAWN', 2]);
    expect(await level(P1, 2027)).toEqual([true, false]);
    await run(request(P1, 2027, entry));
    // Step 2: S2 voided on 2029-02-01. The ADDED entry keeps its acknowledgement; a VOIDED entry in 2027 and in 2028.
    const voided = await voidSet(L, S2.setId, '2029-02-01T10:00:00Z');
    const e2027 = await entries(P1, 2027);
    expect(e2027.map((e) => [e.kind, e.acknowledgement === null])).toEqual([
      ['LOAN_ALLOCATION_SET_ADDED', false],
      ['LOAN_ALLOCATION_SET_VOIDED', true],
    ]);
    expect(await interestLine(P1, 2027)).toBe('808.80');
    for (const pr of [P1, P2]) {
      const [e2028] = (await entries(pr, 2028)) as [Entry];
      expect([e2028.kind, e2028.auditRecordId, e2028.items.map((i) => i.sourceId)]).toEqual(['LOAN_ALLOCATION_SET_VOIDED', voided, [d[3]]]);
    }
    expect([await interestLine(P1, 2028), await interestLine(P2, 2028)]).toEqual(['267.60', '178.40']);
    await run(request(P1, 2028, (await entries(P1, 2028))[0] as Entry));
    expect([await level(P1, 2028), await level(P2, 2028), await level(P1, 2027)]).toEqual([
      [false, true],
      [true, false],
      [true, false],
    ]);
  });

  it('a Loan whose only set naming P was voided after the year: still read (any set names P), flagged ATTRIBUTED to NONE', async () => {
    const P3 = await propertyReference();
    const L = await loan();
    const only = await appendSet(L, '2027-01-01', [[P3, 1n, 1n]], '2027-01-01T10:00:00Z');
    const splitId = (await booked([split('250.00', 'LOAN_INTEREST', { loanId: L })], { bookingDate: '2027-05-31' })).splitIds[0];
    expect(await interestLine(P3, 2027)).toBe('250.00');
    const voided = await voidSet(L, only.setId, '2028-03-01T10:00:00Z');
    const v = await view(P3, 2027);
    expect([await interestLine(P3, 2027), v.notAttributed.items.length]).toEqual(['0.00', 0]);
    expect(v.flags.find((f) => f.code === 'PROPERTY_PART_CHANGED')?.details).toEqual([
      expect.objectContaining({
        kind: 'LOAN_ALLOCATION_SET_VOIDED',
        auditRecordId: voided,
        items: [
          expect.objectContaining({
            sourceId: splitId,
            stateBefore: 'ATTRIBUTED',
            partBefore: { amount: '250.00', currency: 'EUR' },
            stateAfter: 'NONE',
            partAfter: null,
          }),
        ],
      }),
    ]);
    expect(v.review.final).toBe(false);
  });

  it('one snapshot: a set appended between the view own reads and the AfA reads is not seen; the next read flags it', async () => {
    const { P1, L } = await example();
    const later = async () => {
      await appendSet(L, '2027-10-01', [[P1, 1n, 1n]], '2028-04-01T10:00:00Z');
    };
    const read = await readTaxYear(createDatabase(ctx.pool), TAX_RULES, P1, REALM, 2027, null, day('2029-10-30'), undefined, later);
    expect(read?.parts?.loans[0]?.sets.length).toBe(2);
    expect((await entries(P1, 2027)).map((e) => e.kind)).toEqual(['LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_ADDED']);
  });

  it('Realm isolation: another Realm set on the Loan and its record are never read, its acknowledgements never seen, its PropertyReference not flagged', async () => {
    const { P1, L, S2 } = await example();
    const [entry] = (await entries(P1, 2027)) as [Entry];
    // A fixture the composite keys and guards forbid, built with them dropped in this test schema only: a set of
    // another Realm on L naming P1 1/1 from 2027-09-01, recorded after the year (it would move d3 to 448.00).
    await ctx.pool.query(`ALTER TABLE loan_allocation_set DROP CONSTRAINT loan_allocation_set_loan_fk`);
    await ctx.pool.query(`ALTER TABLE loan_allocation DROP CONSTRAINT loan_allocation_property_reference_fk`);
    await ctx.pool.query(`ALTER TABLE loan_allocation_set DISABLE TRIGGER USER`);
    await ctx.pool.query(`ALTER TABLE loan_allocation DISABLE TRIGGER USER`);
    try {
      const foreign = (
        await ctx.pool.query(
          `INSERT INTO loan_allocation_set (mre_realm_id, loan_id, status, valid_from, basis, created_by) VALUES ($1, $2, 'VALID', '2027-09-01', 'MANUAL', 'x') RETURNING id`,
          [OTHER_REALM, L],
        )
      ).rows[0].id as string;
      await ctx.pool.query(
        `INSERT INTO loan_allocation (set_id, mre_realm_id, position, property_reference_id, share_numerator, share_denominator) VALUES ($1, $2, 0, $3, 1, 1)`,
        [foreign, OTHER_REALM, P1],
      );
      await ctx.pool.query(
        `INSERT INTO audit_record (entity_type, entity_id, action, actor_type, actor_id, new_version, metadata, occurred_at) VALUES ('LoanAllocationSet', $1, 'CREATED', 'USER', 'x', 1, '{}', '2028-05-01T10:00:00Z')`,
        [foreign],
      );
    } finally {
      await ctx.pool.query(`ALTER TABLE loan_allocation_set ENABLE TRIGGER USER`);
      await ctx.pool.query(`ALTER TABLE loan_allocation ENABLE TRIGGER USER`);
    }
    expect((await entries(P1, 2027)).map((e) => e.auditRecordId)).toEqual([S2.auditRecordId]);
    expect(await interestLine(P1, 2027)).toBe('719.01');
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

  it('no cash mutated: the views write nothing, before and after the acknowledgement', async () => {
    const { P1, P2 } = await example();
    const snapshot = await rowsSnapshot(ctx.pool);
    for (const pr of [P1, P2]) for (const year of [2027, 2028]) await view(pr, year);
    expect(await rowsSnapshot(ctx.pool)).toEqual(snapshot);
    await acknowledge()(request(P1, 2027, (await entries(P1, 2027))[0] as Entry));
    const acknowledged = await rowsSnapshot(ctx.pool);
    for (const pr of [P1, P2]) await view(pr, 2027);
    expect(await rowsSnapshot(ctx.pool)).toEqual(acknowledged);
  });

  it('the plans: the set records by audit_record_entity_idx and the Loans by loan_allocation_property_reference_idx, inside the view snapshot', async () => {
    const { P1 } = await example();
    const sent: CompiledQuery[] = [];
    const logged = new Kysely<Database>({ dialect: new PostgresDialect({ pool: ctx.pool }), log: (e) => void (e.level === 'query' && sent.push(e.query)) });
    await new PostgresTaxClassificationRepository(logged).readTaxYear(P1, REALM, 2027, null, day('2029-10-30'));
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
    expect(await planOf((s, p) => s.includes('from "audit_record"') && p.includes('LoanAllocationSet'))).toContain('audit_record_entity_idx');
    expect(await planOf((s, p) => s.includes('"las"."status" in') && p.includes('VOID'))).toContain('loan_allocation_property_reference_idx');
  });
});
