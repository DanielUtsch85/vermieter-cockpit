import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import { describe, expect, it } from 'vitest';
import { acknowledgeAttributionChange, getTaxYearView, withdrawAcknowledgement, type RealmPrincipal } from './application/index.js';
import type { SplitInput } from './domains/ledger/index.js';
import { sha256Fingerprinter as fingerprinter } from './infrastructure/hashing/index.js';
import { PostgresCorrectionRepository } from './infrastructure/postgres/correction-repository.js';
import { createDatabase } from './infrastructure/postgres/database.js';
import type { Database } from './infrastructure/postgres/schema.js';
import { PostgresTaxClassificationRepository } from './infrastructure/postgres/tax-classification-repository.js';
import { PostgresTaxStatementRepository } from './infrastructure/postgres/tax-statement-repository.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import { OTHER_REALM, REALM, actor, databaseUrl, day, eur, nextTenant, useTaxYearDatabase } from './infrastructure/postgres/tax-year.test-support.js';
import { stageAudit } from './infrastructure/postgres/audit-stage.test-support.js';

/**
 * VC-X-50 persistence (api-design.md §58I, migration 0065): `DEPOSIT_REOPENED`/`DEPOSIT_CLOSED` derived in the view's and
 * the command's snapshots from the deposit's `SecurityDeposit` records (a year `null` stored and audited as `null`);
 * `TRANSACTION_CORRECTED`/`TRANSACTION_REVERSED` from the corrected Transaction's one record, the original selected
 * through its replacement where only that is on P or in the year; the deposit of the moved rent judged by §58H's kinds
 * (VC-X-49's release and match), never by the correction's; the order of checks, idempotency, withdrawal, Realm
 * isolation, "no cash mutated", the plans. The schema tests of 0065 are in `tax-statement-movers-schema.test.ts`.
 * Entscheidung des Projektinhabers, 2026-11-03, §58I Fragen 1–7. Synthetic values only.
 */
const principal = (mreRealmId = REALM): RealmPrincipal => ({ mreRealmId, email: actor.actorId }) as RealmPrincipal;
const now = () => new Date('2029-10-30T10:00:00Z');
type Entry = { kind: string; auditRecordId: string; changeFingerprint: string; acknowledgement: unknown; items: Record<string, unknown>[] } & Record<
  string,
  unknown
>;

describe.skipIf(databaseUrl === undefined)('the deposit s other movers (§58I)', () => {
  const { ctx, propertyReference, booked, split, request: classification, depositRequest } = useTaxYearDatabase('tax_statement_movers_repository_test');
  const statements = () => new PostgresTaxStatementRepository(createDatabase(ctx.pool));
  const corrections = () => new PostgresCorrectionRepository(createDatabase(ctx.pool));
  const acknowledge = () => acknowledgeAttributionChange({ repository: statements(), fingerprinter, now });
  const view = (pr: string, year: number, realm = REALM) =>
    getTaxYearView({ repository: ctx.classifications, fingerprinter, now })({ principal: principal(realm), propertyReferenceId: pr, year, ownerPartyId: null });
  const entries = async (pr: string, year: number, code: string) => ((await view(pr, year)).flags.find((f) => f.code === code)?.details ?? []) as Entry[];
  const level = async (pr: string, year: number, code: string) => {
    const v = await view(pr, year);
    return [v.review.open.some((o) => o.code === code), v.review.info.some((o) => o.code === code)];
  };
  /** The open codes but OWNERSHIP_INCOMPLETE (these PropertyReferences have no Ownership): `[]` is final but for it. */
  const openCodes = (v: Awaited<ReturnType<typeof view>>) => v.review.open.map((o) => o.code).filter((c) => c !== 'OWNERSHIP_INCOMPLETE');
  const lineOf = async (pr: string, year: number, category: string) =>
    (await view(pr, year)).einnahmen.lines.find((l) => l.taxCategory === category)?.total.amount ?? '0.00';
  const at = (id: string, iso: string) => stageAudit(ctx.pool, `UPDATE audit_record SET occurred_at = $2 WHERE id = $1`, [id, iso]);
  const recordIds = async (entityId: string, action: string) =>
    (await ctx.pool.query(`SELECT id FROM audit_record WHERE entity_id = $1 AND action = $2`, [entityId, action])).rows.map((r) => r.id as string);
  /** The one record of the action not yet re-timed: the times set here may lie after the new record's (written now). */
  const fresh = new Set<string>();
  const recordOf = async (entityId: string, action: string) => {
    const id = (await recordIds(entityId, action)).find((r) => !fresh.has(r));
    if (id === undefined) throw new Error(`no new ${action} record of ${entityId}`);
    fresh.add(id);
    return id;
  };
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
  /** A rent on `pr` matched to `term` of `tenant`, the CONFIRMED record set to `confirmedAt`. */
  async function matched(pr: string, tenant: string, amount: string, bookingDate: string, term: string, confirmedAt: string) {
    const { tx, splitIds } = await booked([split(amount, 'RENT_BASE', { propertyReferenceId: pr })], { direction: 'INFLOW', bookingDate });
    const reconciliationId = await match(tx, tenant, amount, term, confirmedAt);
    return { tx, reconciliationId, splitId: splitIds[0] as string };
  }
  async function match(tx: string, tenant: string, amount: string, term: string, confirmedAt: string) {
    const created = await ctx.reconciliations.create(
      { mreRealmId: REALM, transactionId: tx, mreTenantId: tenant, mreRentTerm: term, matchedAmount: eur(amount), notes: null },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    await at(await recordOf(created.reconciliation.id, 'CONFIRMED'), confirmedAt);
    return created.reconciliation.id as string;
  }
  async function depositOf(tenant: string) {
    const created = await ctx.deposits.create(
      {
        mreRealmId: REALM,
        mreTenantId: tenant,
        expectedAmount: eur('900.00'),
        expectedAmountSource: 'REQUEST',
        holdingFinancialAccountId: null,
        interestBearing: false,
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    return created.deposit.id as string;
  }
  const cash = (D: string, amount: string, direction: 'INFLOW' | 'OUTFLOW', bookingDate: string) =>
    booked([split(amount, 'SECURITY_DEPOSIT', { securityDepositId: D })], { direction, bookingDate });
  async function close(D: string, closingDate: string, recordedAt: string) {
    const closed = await ctx.deposits.close(D, REALM, { closingDate: day(closingDate), reason: 'RETAINED', closingNote: 'Schaden (synthetisch)' }, actor);
    if (closed.kind !== 'CLOSED') throw new Error(JSON.stringify(closed));
    const record = await recordOf(D, 'CLOSED');
    await at(record, recordedAt);
    return record;
  }
  async function reopen(D: string, recordedAt: string) {
    expect((await ctx.deposits.reopen(D, REALM, actor)).kind).toBe('REOPENED');
    const record = await recordOf(D, 'REOPENED');
    await at(record, recordedAt);
    return record;
  }
  /** §58I example (a): T's rent on P1 matched in 2027; D held 900.00, 600.00 repaid on 2027-12-15, closed on 2027-12-20 (300.00), classified. */
  async function exampleA() {
    const P1 = await propertyReference();
    const T = nextTenant();
    await matched(P1, T, '900.00', '2027-03-01', '2027030100', '2027-03-05T10:00:00Z');
    const D = await depositOf(T);
    await cash(D, '900.00', 'INFLOW', '2026-01-05');
    await cash(D, '600.00', 'OUTFLOW', '2027-12-15');
    await close(D, '2027-12-20', '2027-12-20T10:00:00Z');
    const c = await ctx.classifications.createClassification(depositRequest(D, { taxCategory: 'RETAINED_DEPOSIT_DAMAGES' }), actor);
    if (c.kind !== 'CREATED') throw new Error(c.kind);
    return { P1, T, D };
  }

  it('example (a): reopened on 2028-02-12, closed anew on 2028-02-14 with 2028-01-10 and 250.00; 2027 flagged by the reopen (2027 to null), 2028 not; acknowledged, stored and audited with null', async () => {
    const { P1, T, D } = await exampleA();
    expect([await lineOf(P1, 2027, 'RETAINED_DEPOSIT_DAMAGES'), await entries(P1, 2027, 'ATTRIBUTION_INPUT_CHANGED')]).toEqual(['300.00', []]);
    const untouched = await rowsSnapshot(ctx.pool);
    const reopened = await reopen(D, '2028-02-12T10:00:00Z');
    expect(await lineOf(P1, 2027, 'RETAINED_DEPOSIT_DAMAGES')).toBe('0.00');
    await cash(D, '50.00', 'OUTFLOW', '2028-01-10');
    const closed = await close(D, '2028-01-10', '2028-02-14T10:00:00Z');
    const e27 = await entries(P1, 2027, 'ATTRIBUTION_INPUT_CHANGED');
    expect(e27).toEqual([
      expect.objectContaining({
        kind: 'DEPOSIT_REOPENED',
        entityType: 'SecurityDeposit',
        entityId: D,
        securityDepositId: D,
        mreTenantId: T,
        closingDate: '2027-12-20',
        reason: 'RETAINED',
        auditRecordId: reopened,
        amendedAt: '2028-02-12T10:00:00.000Z',
        items: [{ sourceId: D, yearBefore: 2027, yearAfter: null }],
        acknowledgement: null,
      }),
    ]);
    expect(await level(P1, 2027, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([true, false]);
    // 2028: the CLOSED record was made during 2028; D is listed not counting (CLOSING_CHANGED), open by §58I Frage 4.
    const v28 = await view(P1, 2028);
    expect(v28.flags.map((f) => f.code)).not.toContain('ATTRIBUTION_INPUT_CHANGED');
    expect(v28.unclassified.items.map((i) => [i.sourceId, i.reviewState, i.flags.find((f) => f.code === 'NOT_COUNTED')?.details])).toEqual([
      [D, 'USER_CONFIRMED', expect.objectContaining({ reason: 'CLOSING_CHANGED' })],
    ]);
    expect(openCodes(v28)).toEqual(['NOT_COUNTED']);
    // The order of checks: the CLOSED record is not a change of 2027; a wrong fingerprint differs; the wrong kind is not flagged.
    const run = acknowledge();
    const entry = e27[0] as Entry;
    await expect(run(ask(P1, 2027, { auditRecordId: closed, changeFingerprint: entry.changeFingerprint }))).rejects.toMatchObject({
      name: 'AttributionChangeNotFlaggedError',
    });
    await expect(run(ask(P1, 2027, { ...entry, changeFingerprint: 'f'.repeat(64) }))).rejects.toMatchObject({ name: 'AttributionChangeDiffersError' });
    await expect(run(ask(P1, 2027, entry, { kind: 'DEPOSIT_CLOSED' }))).rejects.toMatchObject({ name: 'AttributionChangeNotFlaggedError' });
    const created = await run(ask(P1, 2027, entry, { kind: 'DEPOSIT_REOPENED', idempotencyKey: 'x50-reopen-1' }));
    expect(created).toMatchObject({
      created: true,
      acknowledgement: { change: { kind: 'DEPOSIT_REOPENED', items: [{ sourceId: D, yearBefore: 2027, yearAfter: null }] } },
    });
    // Idempotent: the same key replays; a second request without a key is a no-op.
    expect(await run(ask(P1, 2027, entry, { kind: 'DEPOSIT_REOPENED', idempotencyKey: 'x50-reopen-1' }))).toMatchObject({ replayed: true });
    expect(await run(ask(P1, 2027, entry))).toMatchObject({ created: false, replayed: false });
    expect(await level(P1, 2027, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([false, true]);
    const id = created.acknowledgement.acknowledgementId;
    const stored = await ctx.pool.query(`SELECT source_id, year_before, year_after FROM tax_year_acknowledgement_item WHERE acknowledgement_id = $1`, [id]);
    expect(stored.rows).toEqual([{ source_id: D, year_before: 2027, year_after: null }]);
    const audit = await ctx.pool.query(`SELECT metadata FROM audit_record WHERE entity_id = $1 AND action = 'ACKNOWLEDGED'`, [id]);
    expect(audit.rows[0].metadata).toMatchObject({
      kind: 'DEPOSIT_REOPENED',
      entityType: 'SecurityDeposit',
      items: [{ sourceId: D, yearBefore: 2027, yearAfter: null }],
    });
    // Withdrawn: open again.
    await withdrawAcknowledgement({ repository: statements() })({
      principal: principal(),
      propertyReferenceId: P1,
      year: 2027,
      acknowledgementId: id,
      reason: 'Irrtum (synthetisch)',
    });
    expect(await level(P1, 2027, 'ATTRIBUTION_INPUT_CHANGED')).toEqual([true, false]);
    // A new classification of the new closing: 250.00 in 2028, nothing open; no cash and no deposit row written by views or statements.
    const old = (await ctx.classifications.listHistory('DEPOSIT_CLOSING', D, REALM))?.find((h) => h.supersededBy === null);
    const next = await ctx.classifications.createClassification(
      depositRequest(D, { taxCategory: 'RETAINED_DEPOSIT_DAMAGES', supersedes: old?.id ?? null }),
      actor,
    );
    expect(next.kind).toBe('CREATED');
    expect([await lineOf(P1, 2028, 'RETAINED_DEPOSIT_DAMAGES'), openCodes(await view(P1, 2028))]).toEqual(['250.00', []]);
    const after = await rowsSnapshot(ctx.pool);
    expect(after['rent_payment_reconciliation']).toEqual(untouched['rent_payment_reconciliation']);
    const viewsOnly = await rowsSnapshot(ctx.pool);
    for (const year of [2027, 2028]) await view(P1, year);
    expect(await rowsSnapshot(ctx.pool)).toEqual(viewsOnly);
  });

  it('variant, a reopen by mistake: closed again with 2027-12-20 and 300.00; two entries of 2027, the old classification counts again', async () => {
    const { P1, D } = await exampleA();
    const reopened = await reopen(D, '2028-02-12T10:00:00Z');
    const closed = await close(D, '2027-12-20', '2028-02-14T10:00:00Z');
    expect((await entries(P1, 2027, 'ATTRIBUTION_INPUT_CHANGED')).map((e) => [e.kind, e.auditRecordId, e.items])).toEqual([
      ['DEPOSIT_REOPENED', reopened, [{ sourceId: D, yearBefore: 2027, yearAfter: null }]],
      ['DEPOSIT_CLOSED', closed, [{ sourceId: D, yearBefore: null, yearAfter: 2027 }]],
    ]);
    expect(await lineOf(P1, 2027, 'RETAINED_DEPOSIT_DAMAGES')).toBe('300.00');
    const v = await view(P1, 2027);
    const item = v.einnahmen.lines.find((l) => l.taxCategory === 'RETAINED_DEPOSIT_DAMAGES')?.items[0];
    expect(item?.flags.find((f) => f.code === 'ATTRIBUTION_INPUT_CHANGED')?.details).toEqual([
      expect.objectContaining({ kind: 'DEPOSIT_REOPENED', yearBefore: 2027, yearAfter: null }),
      expect.objectContaining({ kind: 'DEPOSIT_CLOSED', yearBefore: null, yearAfter: 2027 }),
    ]);
    // Both acknowledged: nothing of §58I open in 2027 (the PropertyReference has no Ownership here: OWNERSHIP_INCOMPLETE aside).
    const run = acknowledge();
    for (const e of await entries(P1, 2027, 'ATTRIBUTION_INPUT_CHANGED')) await run(ask(P1, 2027, e));
    expect([openCodes(await view(P1, 2027)), await lineOf(P1, 2027, 'RETAINED_DEPOSIT_DAMAGES')]).toEqual([[], '300.00']);
  });

  it('a deposit not attributed (SEVERAL_PROPERTY_REFERENCES) is no candidate: reopened after the year, neither view is flagged', async () => {
    const [P1, P2] = [await propertyReference(), await propertyReference()];
    const V = nextTenant();
    await matched(P1, V, '900.00', '2027-03-01', '2027030100', '2027-03-05T10:00:00Z');
    await matched(P2, V, '80.00', '2027-05-03', '2027050100', '2027-05-05T10:00:00Z');
    const D = await depositOf(V);
    await cash(D, '900.00', 'INFLOW', '2026-01-05');
    await cash(D, '600.00', 'OUTFLOW', '2027-12-15');
    await close(D, '2027-12-20', '2027-12-20T10:00:00Z');
    for (const pr of [P1, P2]) expect((await view(pr, 2027)).notAttributed.items.map((i) => i.sourceId)).toEqual([D]);
    await reopen(D, '2028-02-12T10:00:00Z');
    for (const pr of [P1, P2]) {
      const v = await view(pr, 2027);
      // Each code alone (a not.arrayContaining of several codes would pass with one of them present).
      expect(v.flags.map((f) => f.code).filter((c) => c === 'ATTRIBUTION_INPUT_CHANGED' || c === 'ATTRIBUTION_HISTORY_INCONSISTENT')).toEqual([]);
      expect(v.notAttributed.items).toEqual([]);
    }
  });

  it('an inconsistent deposit history (a REOPENED clearing another closing) is ATTRIBUTION_HISTORY_INCONSISTENT with SecurityDeposit; its records unused', async () => {
    const { P1, D } = await exampleA();
    const reopened = await reopen(D, '2028-02-12T10:00:00Z');
    await stageAudit(ctx.pool, `UPDATE audit_record SET metadata = jsonb_set(metadata, '{cleared,closingDate}', '"2027-12-21"') WHERE id = $1`, [reopened]);
    const v = await view(P1, 2027);
    expect(v.flags.filter((f) => f.code === 'ATTRIBUTION_HISTORY_INCONSISTENT')).toEqual([
      { code: 'ATTRIBUTION_HISTORY_INCONSISTENT', details: { entityType: 'SecurityDeposit', entityId: D } },
    ]);
    expect(v.flags.map((f) => f.code)).not.toContain('ATTRIBUTION_INPUT_CHANGED');
    expect(openCodes(v)).toContain('ATTRIBUTION_HISTORY_INCONSISTENT');
  });

  /** §58I example (b): X 950.00 booked 2027-11-03, S1 RENT_BASE on P1 (a booking error), matched to U s 2027-11, classified. */
  async function exampleB(withDeposit = false) {
    const [P1, P2] = [await propertyReference(), await propertyReference()];
    const U = nextTenant();
    const x = await matched(P1, U, '950.00', '2027-11-03', '2027110100', '2027-11-05T10:00:00Z');
    expect((await ctx.classifications.createClassification(classification(x.splitId), actor)).kind).toBe('CREATED');
    let E: string | null = null;
    if (withDeposit) {
      E = await depositOf(U);
      await cash(E, '900.00', 'INFLOW', '2026-01-05');
      await cash(E, '700.00', 'OUTFLOW', '2027-12-15');
      await close(E, '2027-12-20', '2027-12-20T10:00:00Z');
      expect((await ctx.classifications.createClassification(depositRequest(E), actor)).kind).toBe('CREATED');
    }
    return { P1, P2, U, E, ...x };
  }
  /** Released, corrected (the replacement's splits as given) and matched again, each recorded at the given times. */
  async function moved(x: { tx: string; reconciliationId: string }, U: string, splits: SplitInput[], o: { bookingDate?: string; at?: string } = {}) {
    const recorded = o.at ?? '2028-03-02T10:00:00Z';
    const released = await ctx.reconciliations.release(x.reconciliationId, REALM, 'Falsches Objekt (synthetisch)', new Date(), actor);
    expect(released.kind).toBe('RELEASED');
    await at(await recordOf(x.reconciliationId, 'RELEASED'), recorded.replace('10:00', '09:00'));
    const outcome = await corrections().correct(
      x.tx,
      REALM,
      {
        reason: 'Buchung auf falsches Objekt (synthetisch)',
        replacement: { splits, ...(o.bookingDate === undefined ? {} : { bookingDate: day(o.bookingDate) }) },
      },
      actor,
    );
    if (outcome.kind !== 'CORRECTED') throw new Error(JSON.stringify(outcome));
    const record = await recordOf(x.tx, 'CORRECTED');
    await at(record, recorded);
    const Y = outcome.result.replacement?.id as string;
    const reconciliation = await match(Y, U, '950.00', '2027110100', recorded.replace('10:00', '11:00'));
    const { rows } = await ctx.pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1 ORDER BY position`, [Y]);
    return { record, Y, R: outcome.result.reversal.id as string, S2: rows[0].id as string, reconciliation };
  }

  it('example (b): X corrected on 2028-03-02 from P1 to P2; both views flagged with their split, P2 found through the replacement; acknowledged in both, part items stored', async () => {
    const { P1, P2, U, tx, splitId: S1, reconciliationId } = await exampleB();
    expect([await lineOf(P1, 2027, 'RENT'), await lineOf(P2, 2027, 'RENT')]).toEqual(['950.00', '0.00']);
    const { record, Y, R, S2 } = await moved({ tx, reconciliationId }, U, [split('950.00', 'RENT_BASE', { propertyReferenceId: P2 })]);
    expect([await lineOf(P1, 2027, 'RENT'), await lineOf(P2, 2027, 'RENT')]).toEqual(['0.00', '950.00']);
    const [e1, e2] = [await entries(P1, 2027, 'PROPERTY_PART_CHANGED'), await entries(P2, 2027, 'PROPERTY_PART_CHANGED')];
    const keys = {
      kind: 'TRANSACTION_CORRECTED',
      entityType: 'Transaction',
      entityId: tx,
      transactionId: tx,
      reversalTransactionId: R,
      replacementTransactionId: Y,
      auditRecordId: record,
    };
    expect(e1).toEqual([
      expect.objectContaining({
        ...keys,
        reason: 'Buchung auf falsches Objekt (synthetisch)',
        items: [
          {
            sourceType: 'TRANSACTION_SPLIT',
            sourceId: S1,
            taxYear: 2027,
            stateBefore: 'ATTRIBUTED',
            partBefore: { amount: '950.00', currency: 'EUR' },
            stateAfter: 'NONE',
            partAfter: null,
          },
        ],
      }),
    ]);
    expect(e2).toEqual([
      expect.objectContaining({
        ...keys,
        items: [
          {
            sourceType: 'TRANSACTION_SPLIT',
            sourceId: S2,
            taxYear: 2027,
            stateBefore: 'NONE',
            partBefore: null,
            stateAfter: 'ATTRIBUTED',
            partAfter: { amount: '950.00', currency: 'EUR' },
          },
        ],
      }),
    ]);
    // Release and match move no year (a booking in November): §58E raises nothing.
    for (const pr of [P1, P2]) expect((await view(pr, 2027)).flags.map((f) => f.code)).not.toContain('ATTRIBUTION_INPUT_CHANGED');
    const s2 = (await view(P2, 2027)).einnahmen.lines.find((l) => l.taxCategory === 'RENT')?.items[0];
    expect(s2?.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['PROPERTY_PART_CHANGED', 'CLASSIFICATION_ON_CORRECTED_SPLIT']));
    const run = acknowledge();
    const a1 = await run(ask(P1, 2027, e1[0] as Entry));
    const a2 = await run(ask(P2, 2027, e2[0] as Entry, { kind: 'TRANSACTION_CORRECTED' }));
    expect([await level(P1, 2027, 'PROPERTY_PART_CHANGED'), await level(P2, 2027, 'PROPERTY_PART_CHANGED')]).toEqual([
      [false, true],
      [false, true],
    ]);
    const items = await ctx.pool.query(
      `SELECT source_type, source_id, state_before, part_before::text, state_after, part_after::text FROM tax_year_acknowledgement_part_item WHERE acknowledgement_id IN ($1, $2) ORDER BY state_before`,
      [a1.acknowledgement.acknowledgementId, a2.acknowledgement.acknowledgementId],
    );
    expect(items.rows).toEqual([
      { source_type: 'TRANSACTION_SPLIT', source_id: S1, state_before: 'ATTRIBUTED', part_before: '950.00', state_after: 'NONE', part_after: null },
      { source_type: 'TRANSACTION_SPLIT', source_id: S2, state_before: 'NONE', part_before: null, state_after: 'ATTRIBUTED', part_after: '950.00' },
    ]);
    // P2 stays open through S2's classification (P7-D2), never cleared by the acknowledgement.
    expect((await view(P2, 2027)).review.open.map((o) => o.code)).toContain('CLASSIFICATION_ON_CORRECTED_SPLIT');
  });

  it('a description-only correction raises nothing; a reversal raises TRANSACTION_REVERSED in P1 only', async () => {
    const { P1, P2, tx } = await exampleB();
    // The reconciliation blocks the correction (TRANSACTION_RENT_RECONCILED): released first, recorded in 2027.
    const { rows } = await ctx.pool.query(`SELECT id FROM rent_payment_reconciliation WHERE transaction_id = $1`, [tx]);
    await ctx.reconciliations.release(rows[0].id, REALM, 'Korrektur (synthetisch)', new Date(), actor);
    await at(await recordOf(rows[0].id, 'RELEASED'), '2027-11-20T10:00:00Z');
    const described = await corrections().correct(
      tx,
      REALM,
      { reason: 'Verwendungszweck (synthetisch)', replacement: { description: 'Miete November' } },
      actor,
    );
    if (described.kind !== 'CORRECTED') throw new Error(described.kind);
    await at(await recordOf(tx, 'CORRECTED'), '2028-03-02T10:00:00Z');
    expect([await entries(P1, 2027, 'PROPERTY_PART_CHANGED'), await lineOf(P1, 2027, 'RENT')]).toEqual([[], '950.00']);
    const Y = described.result.replacement?.id as string;
    const reversed = await corrections().correct(Y, REALM, { reason: 'Rückbuchung (synthetisch)', replacement: null }, actor);
    if (reversed.kind !== 'CORRECTED') throw new Error(reversed.kind);
    const record = await recordOf(Y, 'REVERSED');
    await at(record, '2028-03-05T10:00:00Z');
    expect((await entries(P1, 2027, 'PROPERTY_PART_CHANGED')).map((e) => [e.kind, e.auditRecordId, e['replacementTransactionId']])).toEqual([
      ['TRANSACTION_REVERSED', record, null],
    ]);
    expect(await entries(P2, 2027, 'PROPERTY_PART_CHANGED')).toEqual([]);
  });

  it('only the replacement in the year: booked 2026-06-15 on P, corrected after 2027 to 2027-06-15; P 2027 flagged through the replacement, 2026 too; a correction on neither is not read', async () => {
    const P = await propertyReference();
    const { tx, splitIds } = await booked([split('400.00', 'OTHER_INCOME', { propertyReferenceId: P })], { direction: 'INFLOW', bookingDate: '2026-06-15' });
    const outcome = await corrections().correct(tx, REALM, { reason: 'Datum (synthetisch)', replacement: { bookingDate: day('2027-06-15') } }, actor);
    if (outcome.kind !== 'CORRECTED') throw new Error(outcome.kind);
    await at(await recordOf(tx, 'CORRECTED'), '2028-02-01T10:00:00Z');
    const e27 = await entries(P, 2027, 'PROPERTY_PART_CHANGED');
    expect(e27.map((e) => [e.kind, e.entityId, e.items.map((i) => [i['stateBefore'], i['stateAfter'], i['taxYear']])])).toEqual([
      ['TRANSACTION_CORRECTED', tx, [['NONE', 'ATTRIBUTED', 2027]]],
    ]);
    expect((await entries(P, 2026, 'PROPERTY_PART_CHANGED')).map((e) => e.items.map((i) => [i['sourceId'], i['stateAfter']]))).toEqual([
      [[splitIds[0], 'NONE']],
    ]);
    // Counter-check: a correction on another PropertyReference (both splits there) is never read for P.
    const Q = await propertyReference();
    const other = await booked([split('400.00', 'OTHER_INCOME', { propertyReferenceId: Q })], { direction: 'INFLOW', bookingDate: '2027-06-15' });
    const elsewhere = await corrections().correct(
      other.tx,
      REALM,
      { reason: 'Betrag (synthetisch)', replacement: { amount: eur('410.00'), splits: [split('410.00', 'OTHER_INCOME', { propertyReferenceId: Q })] } },
      actor,
    );
    expect(elsewhere.kind).toBe('CORRECTED');
    await at(await recordOf(other.tx, 'CORRECTED'), '2028-02-01T10:00:00Z');
    const sent: CompiledQuery[] = [];
    const logged = new Kysely<Database>({ dialect: new PostgresDialect({ pool: ctx.pool }), log: (e) => void (e.level === 'query' && sent.push(e.query)) });
    await new PostgresTaxClassificationRepository(logged).readTaxYear(P, REALM, 2027, null, day('2029-10-30'));
    expect(sent.some((q) => q.parameters.includes(other.tx))).toBe(false);
    expect((await entries(P, 2027, 'PROPERTY_PART_CHANGED')).map((e) => e.entityId)).toEqual([tx]);
    expect((await entries(Q, 2027, 'PROPERTY_PART_CHANGED')).map((e) => e.entityId)).toEqual([other.tx]);
  });

  it('the deposit under a correction (§58H pinned): the release flags E in P1, the match in P2; the correction s entry has no deposit item', async () => {
    const { P1, P2, U, E, tx, reconciliationId } = await exampleB(true);
    expect(await lineOf(P1, 2027, 'RETAINED_DEPOSIT_RENT')).toBe('200.00');
    const { record, reconciliation } = await moved({ tx, reconciliationId }, U, [split('950.00', 'RENT_BASE', { propertyReferenceId: P2 })]);
    const [p1, p2] = [await entries(P1, 2027, 'PROPERTY_PART_CHANGED'), await entries(P2, 2027, 'PROPERTY_PART_CHANGED')];
    const summary = (list: Entry[]) => list.map((e) => [e.kind, e.items.map((i) => [i['sourceType'], i['stateBefore'], i['stateAfter']])]);
    expect(summary(p1)).toEqual([
      ['DEPOSIT_RECONCILIATION_RELEASED', [['DEPOSIT_CLOSING', 'ATTRIBUTED', 'NOT_ATTRIBUTED']]],
      ['TRANSACTION_CORRECTED', [['TRANSACTION_SPLIT', 'ATTRIBUTED', 'NONE']]],
    ]);
    expect(summary(p2)).toEqual([
      ['TRANSACTION_CORRECTED', [['TRANSACTION_SPLIT', 'NONE', 'ATTRIBUTED']]],
      ['DEPOSIT_RECONCILIATION_CONFIRMED', [['DEPOSIT_CLOSING', 'NOT_ATTRIBUTED', 'ATTRIBUTED']]],
    ]);
    expect(
      [...p1, ...p2]
        .filter((e) => e.kind === 'TRANSACTION_CORRECTED')
        .every((e) => e.auditRecordId === record && e.items.every((i) => i['sourceType'] === 'TRANSACTION_SPLIT')),
    ).toBe(true);
    expect(p2.find((e) => e.kind === 'DEPOSIT_RECONCILIATION_CONFIRMED')?.['reconciliationId']).toBe(reconciliation);
    expect([await lineOf(P1, 2027, 'RETAINED_DEPOSIT_RENT'), await lineOf(P2, 2027, 'RETAINED_DEPOSIT_RENT')]).toEqual(['0.00', '200.00']);
    expect(E).not.toBeNull();
  });

  it('an inconsistent correction history (the record s replacement differs from the link) is ATTRIBUTION_HISTORY_INCONSISTENT with Transaction', async () => {
    const { P1, U, tx, reconciliationId, P2 } = await exampleB();
    const { record } = await moved({ tx, reconciliationId }, U, [split('950.00', 'RENT_BASE', { propertyReferenceId: P2 })]);
    await stageAudit(
      ctx.pool,
      `UPDATE audit_record SET metadata = jsonb_set(metadata, '{replacementTransactionId}', '"00000000-0000-4000-8000-000000000000"') WHERE id = $1`,
      [record],
    );
    const v = await view(P1, 2027);
    expect(v.flags.filter((f) => f.code === 'ATTRIBUTION_HISTORY_INCONSISTENT')).toEqual([
      { code: 'ATTRIBUTION_HISTORY_INCONSISTENT', details: { entityType: 'Transaction', entityId: tx } },
    ]);
    expect(v.flags.map((f) => f.code)).not.toContain('PROPERTY_PART_CHANGED');
  });

  it('Realm isolation: another Realm s deposit and correction are never read; their records are not flagged here', async () => {
    const { P1, T, D } = await exampleA();
    await reopen(D, '2028-02-12T10:00:00Z');
    // Another Realm's deposit of the same Tenant id, with a closing of 2027 reopened after the year (records as written there).
    const created = await ctx.deposits.create(
      {
        mreRealmId: OTHER_REALM,
        mreTenantId: T,
        expectedAmount: eur('900.00'),
        expectedAmountSource: 'REQUEST',
        holdingFinancialAccountId: null,
        interestBearing: false,
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const foreign = created.deposit.id as string;
    const closing = { closingDate: '2027-12-20', reason: 'RETAINED', closingNote: null, heldAtClosing: { amount: '300.00', currency: 'EUR' } };
    await ctx.pool.query(
      `INSERT INTO audit_record (entity_type, entity_id, action, occurred_at, actor_type, actor_id, metadata) VALUES
         ('SecurityDeposit', $1, 'CLOSED', '2027-12-20T10:00:00Z', 'USER', 'anna@example.com', $2), ('SecurityDeposit', $1, 'REOPENED', '2028-02-13T10:00:00Z', 'USER', 'anna@example.com', $3)`,
      [foreign, JSON.stringify(closing), JSON.stringify({ cleared: closing })],
    );
    expect((await entries(P1, 2027, 'ATTRIBUTION_INPUT_CHANGED')).map((e) => e['securityDepositId'])).toEqual([D]);
    const [entry] = await entries(P1, 2027, 'ATTRIBUTION_INPUT_CHANGED');
    // The other Realm sees no view of P1 and cannot acknowledge its change through its own PropertyReference.
    await expect(view(P1, 2027, OTHER_REALM)).rejects.toMatchObject({ name: 'PropertyReferenceNotFoundError' });
    const theirs = await propertyReference(OTHER_REALM);
    await expect(acknowledge()({ ...ask(theirs, 2027, entry as Entry), principal: principal(OTHER_REALM) })).rejects.toMatchObject({
      name: 'AttributionChangeNotFlaggedError',
    });
    // The other Realm's view of its own PropertyReference reads none of D's records.
    const sent: CompiledQuery[] = [];
    const logged = new Kysely<Database>({ dialect: new PostgresDialect({ pool: ctx.pool }), log: (e) => void (e.level === 'query' && sent.push(e.query)) });
    await new PostgresTaxClassificationRepository(logged).readTaxYear(theirs, OTHER_REALM, 2027, null, day('2029-10-30'));
    expect(sent.some((q) => q.parameters.includes(D))).toBe(false);
  });

  it('the plans: the SecurityDeposit and Transaction records by audit_record_entity_idx inside the view snapshot', async () => {
    const { P1, D } = await exampleA();
    await reopen(D, '2028-02-12T10:00:00Z');
    const b = await exampleB();
    await moved({ tx: b.tx, reconciliationId: b.reconciliationId }, b.U, [split('950.00', 'RENT_BASE', { propertyReferenceId: b.P2 })]);
    const sent: CompiledQuery[] = [];
    const logged = new Kysely<Database>({ dialect: new PostgresDialect({ pool: ctx.pool }), log: (e) => void (e.level === 'query' && sent.push(e.query)) });
    for (const pr of [P1, b.P1]) await new PostgresTaxClassificationRepository(logged).readTaxYear(pr, REALM, 2027, null, day('2029-10-30'));
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
    expect(await planOf((s, p) => s.includes('from "audit_record"') && p.includes('SecurityDeposit'))).toContain('audit_record_entity_idx');
    expect(await planOf((s, p) => s.includes('from "audit_record"') && p.includes('Transaction') && p.includes('CORRECTED'))).toContain(
      'audit_record_entity_idx',
    );
  });
});
