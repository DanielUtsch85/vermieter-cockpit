import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import { describe, expect, it } from 'vitest';
import { getTaxYearView, type RealmPrincipal } from './application/index.js';
import { sha256Fingerprinter as fingerprinter } from './infrastructure/hashing/index.js';
import type { Database } from './infrastructure/postgres/schema.js';
import { PostgresTaxClassificationRepository } from './infrastructure/postgres/tax-classification-repository.js';
import { rowsSnapshot } from './infrastructure/postgres/tax-year-view.test-support.js';
import { OTHER_REALM, REALM, actor, databaseUrl, day, eur, nextTenant, useTaxYearDatabase } from './infrastructure/postgres/tax-year.test-support.js';

/**
 * VC-X-51 persistence (api-design.md §58J, no migration): a deposit without a PropertyReference closed anew since its
 * classification through the real read (`closedDepositsOf` passes it with `counts: false`, `NOT_COUNTED`
 * `CLOSING_CHANGED`) and the view listing it in `notAttributed` of its candidates' 2028 views only; the read passing no
 * other non-counting deposit (a reopened one, one with nothing retained; Frage 3); Realm isolation; the history of the
 * reopen, the closing and the classifications; "no cash mutated" and no AuditRecord written by a view.
 * Entscheidung des Projektinhabers, 2026-11-03, §58J Fragen 1–4. Synthetic values only.
 */
const principal = (mreRealmId = REALM): RealmPrincipal => ({ mreRealmId, email: actor.actorId }) as RealmPrincipal;
const now = () => new Date('2029-10-30T10:00:00Z');
const today = day('2029-10-30');

describe.skipIf(databaseUrl === undefined)('an unattributed deposit closed anew since its classification (§58J)', () => {
  const { ctx, propertyReference, booked, split, rent, depositRequest } = useTaxYearDatabase('tax_year_unattributed_repository_test');
  const view = (pr: string, year: number, realm = REALM) =>
    getTaxYearView({ repository: ctx.classifications, fingerprinter, now })({ principal: principal(realm), propertyReferenceId: pr, year, ownerPartyId: null });
  const listed = async (pr: string, year: number) => (await view(pr, year)).notAttributed.items.map((i) => i.sourceId);
  /** The open codes but OWNERSHIP_INCOMPLETE (these PropertyReferences have no Ownership). */
  const openCodes = (v: Awaited<ReturnType<typeof view>>) => v.review.open.map((o) => o.code).filter((c) => c !== 'OWNERSHIP_INCOMPLETE');
  async function depositOf(tenant: string, realm = REALM) {
    const created = await ctx.deposits.create(
      {
        mreRealmId: realm,
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
  async function close(D: string, closingDate: string, reason: 'RETAINED' | 'RETURNED' = 'RETAINED', realm = REALM) {
    const closed = await ctx.deposits.close(D, realm, { closingDate: day(closingDate), reason, closingNote: 'Schaden (synthetisch)' }, actor);
    if (closed.kind !== 'CLOSED') throw new Error(JSON.stringify(closed));
  }
  async function classify(D: string, realm = REALM) {
    const c = await ctx.classifications.createClassification({ ...depositRequest(D, { taxCategory: 'RETAINED_DEPOSIT_DAMAGES' }), mreRealmId: realm }, actor);
    if (c.kind !== 'CREATED') throw new Error(c.kind);
    return c.classification.id as string;
  }
  /**
   * §58J's example: T's rent on P1 and on P2 (a booking error never corrected), so D is SEVERAL_PROPERTY_REFERENCES; D
   * held 900.00, 600.00 repaid on 2027-12-15, closed on 2027-12-20 (300.00), classified; reopened, 50.00 repaid on
   * 2028-01-10 and closed anew on 2028-01-10 (250.00, tax year 2028); the classification still names the first closing.
   */
  async function example() {
    const [P1, P2, P3] = [await propertyReference(), await propertyReference(), await propertyReference()];
    const T = nextTenant();
    await rent(P1, T, '2027-03-01', '2027030100');
    await rent(P2, T, '2027-04-01', '2027040100');
    const D = await depositOf(T);
    await cash(D, '900.00', 'INFLOW', '2026-01-05');
    await cash(D, '600.00', 'OUTFLOW', '2027-12-15');
    await close(D, '2027-12-20');
    const classificationId = await classify(D);
    expect((await ctx.deposits.reopen(D, REALM, actor)).kind).toBe('REOPENED');
    await cash(D, '50.00', 'OUTFLOW', '2028-01-10');
    await close(D, '2028-01-10');
    return { P1, P2, P3, T, D, classificationId };
  }

  it('the example: the read passes D with CLOSING_CHANGED; listed in P1 s and P2 s 2028 (not P3 s), NOT_COUNTED open, not final; figures unchanged', async () => {
    const { P1, P2, P3, D, classificationId } = await example();
    const read = await ctx.classifications.readTaxYear(P1, REALM, 2028, null, today);
    expect(read?.unattributedDeposits.filter((d) => d.sourceId === D).map((d) => [d.counts, d.amount, d.classificationId, d.flags])).toEqual([
      [
        false,
        eur('250.00'),
        classificationId,
        [
          { code: 'NOT_COUNTED', details: { depositStatus: 'CLOSED', retainedAmount: eur('250.00'), reason: 'CLOSING_CHANGED' } },
          { code: 'NO_PROPERTY_REFERENCE', details: { reason: 'SEVERAL_PROPERTY_REFERENCES', candidates: [P1, P2].sort() } },
        ],
      ],
    ]);
    for (const pr of [P1, P2]) {
      const v = await view(pr, 2028);
      expect(
        v.notAttributed.items.map((i) => [i.sourceId, i.amount.amount, i.lineAmount, i.classificationId, i.notAttributed?.reason]),
        pr,
      ).toEqual([[D, '250.00', null, classificationId, 'SEVERAL_PROPERTY_REFERENCES']]);
      expect(v.notAttributed.items[0]?.flags.find((f) => f.code === 'NOT_COUNTED')?.details, pr).toMatchObject({ reason: 'CLOSING_CHANGED' });
      expect([v.flags.find((f) => f.code === 'UNATTRIBUTED_ITEMS')?.details, openCodes(v).sort(), v.review.final], pr).toEqual([
        { count: 1 },
        ['NOT_COUNTED', 'UNATTRIBUTED_ITEMS'],
        false,
      ]);
      expect([v.einnahmen.total.amount, v.result, v.unclassified.items], pr).toEqual(['0.00', expect.objectContaining({ amount: expect.anything() }), []]);
    }
    expect(await listed(P3, 2028)).toEqual([]);
    // 2027 after the reopen: D in no list of 2027.
    for (const pr of [P1, P2, P3]) expect(await listed(pr, 2027), pr).toEqual([]);
    // Classified anew: NOT_COUNTED goes, UNATTRIBUTED_ITEMS stays; still P1 and P2 only.
    const next = await ctx.classifications.createClassification(
      depositRequest(D, { taxCategory: 'RETAINED_DEPOSIT_DAMAGES', supersedes: classificationId }),
      actor,
    );
    if (next.kind !== 'CREATED') throw new Error(next.kind);
    for (const pr of [P1, P2]) {
      const v = await view(pr, 2028);
      expect([v.notAttributed.items.map((i) => [i.sourceId, i.classificationId]), openCodes(v), v.einnahmen.total.amount], pr).toEqual([
        [[D, next.classification.id]],
        ['UNATTRIBUTED_ITEMS'],
        '0.00',
      ]);
    }
    expect(await listed(P3, 2028)).toEqual([]);
  });

  it('the read passes no other non-counting deposit (Frage 3): a reopened one and one with nothing retained are in no view; every counts false is CLOSING_CHANGED', async () => {
    const { P1, P2, P3, D } = await example();
    // R: classified, reopened and not closed again (ACTIVE, in no year).
    const R = await depositOf(nextTenant());
    await cash(R, '900.00', 'INFLOW', '2026-01-05');
    await cash(R, '700.00', 'OUTFLOW', '2028-01-15');
    await close(R, '2028-01-20');
    await classify(R);
    expect((await ctx.deposits.reopen(R, REALM, actor)).kind).toBe('REOPENED');
    // N: returned in full on 2028-02-01 (CLOSED, nothing retained).
    const N = await depositOf(nextTenant());
    await cash(N, '900.00', 'INFLOW', '2026-01-05');
    await cash(N, '900.00', 'OUTFLOW', '2028-02-01');
    await close(N, '2028-02-01', 'RETURNED');
    for (const pr of [P1, P2, P3]) {
      const read = await ctx.classifications.readTaxYear(pr, REALM, 2028, null, today);
      const ids = read?.unattributedDeposits.map((d) => d.sourceId) ?? [];
      expect([ids.includes(R), ids.includes(N)], pr).toEqual([false, false]);
      expect(
        read?.unattributedDeposits.every((d) => d.counts || d.flags.some((f) => f.code === 'NOT_COUNTED' && f.details.reason === 'CLOSING_CHANGED')),
        pr,
      ).toBe(true);
      const items = await listed(pr, 2028);
      expect([items.includes(R), items.includes(N)], pr).toEqual([false, false]);
    }
    expect([await listed(P1, 2028), await listed(P3, 2028)]).toEqual([[D], []]);
  });

  it('Realm isolation: another Realm s deposit without a PropertyReference closed anew is in none of this Realm s views', async () => {
    const { P1, P2, P3, D } = await example();
    // Another Realm with its own account and cash: F closed on 2027-12-20, classified, reopened, closed anew on 2028-01-10.
    const account = await ctx.accounts.create({ mreRealmId: OTHER_REALM, accountType: 'BANK', displayName: 'Giro fremd', currency: 'EUR', iban: null }, actor);
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const F = await depositOf(nextTenant(), OTHER_REALM);
    const foreignCash = async (amount: string, direction: 'INFLOW' | 'OUTFLOW', bookingDate: string) => {
      const created = await ctx.transactions.createManual(
        {
          mreRealmId: OTHER_REALM,
          financialAccountId: account.account.id,
          amount: eur(amount),
          direction,
          bookingDate: day(bookingDate),
          valueDate: null,
          description: 'Kaution (synthetisch)',
          propertyReferenceId: null,
        },
        actor,
      );
      if (created.kind !== 'CREATED') throw new Error(created.kind);
      const replaced = await ctx.splits.replaceSplits(
        created.transaction.id,
        OTHER_REALM,
        [split(amount, 'SECURITY_DEPOSIT', { securityDepositId: F })],
        actor,
      );
      if (replaced.kind !== 'REPLACED') throw new Error(JSON.stringify(replaced));
      expect((await ctx.transactions.confirm(created.transaction.id, OTHER_REALM, actor)).kind).toBe('CONFIRMED');
    };
    await foreignCash('900.00', 'INFLOW', '2026-01-05');
    await foreignCash('600.00', 'OUTFLOW', '2027-12-15');
    await close(F, '2027-12-20', 'RETAINED', OTHER_REALM);
    await classify(F, OTHER_REALM);
    expect((await ctx.deposits.reopen(F, OTHER_REALM, actor)).kind).toBe('REOPENED');
    await foreignCash('50.00', 'OUTFLOW', '2028-01-10');
    await close(F, '2028-01-10', 'RETAINED', OTHER_REALM);
    expect(await ctx.classifications.findDepositTaxMeaning(F, OTHER_REALM, today)).toMatchObject({
      counts: false,
      propertyReferenceId: null,
      flags: [
        { code: 'NOT_COUNTED', details: { reason: 'CLOSING_CHANGED' } },
        { code: 'NO_PROPERTY_REFERENCE', details: { reason: 'NO_RECONCILED_RENT' } },
      ],
    });
    for (const pr of [P1, P2, P3]) {
      expect((await ctx.classifications.readTaxYear(pr, REALM, 2028, null, today))?.unattributedDeposits.map((d) => d.sourceId).includes(F), pr).toBe(false);
      expect((await listed(pr, 2028)).includes(F), pr).toBe(false);
    }
    expect(await listed(P1, 2028)).toEqual([D]);
    // In the other Realm, F is listed in every view (NO_RECONCILED_RENT); this Realm's PropertyReference is not found there.
    const theirs = await propertyReference(OTHER_REALM);
    expect((await view(theirs, 2028, OTHER_REALM)).notAttributed.items.map((i) => i.sourceId)).toEqual([F]);
    await expect(view(P1, 2028, OTHER_REALM)).rejects.toMatchObject({ name: 'PropertyReferenceNotFoundError' });
    // Each of the read's two deposit queries is scoped to the Realm on its own (the closings of the year, then their facts).
    const sent: CompiledQuery[] = [];
    const logged = new Kysely<Database>({ dialect: new PostgresDialect({ pool: ctx.pool }), log: (e) => void (e.level === 'query' && sent.push(e.query)) });
    await new PostgresTaxClassificationRepository(logged).readTaxYear(P1, REALM, 2028, null, today);
    const closings = sent.filter((q) => q.sql.includes('from "security_deposit"') && q.sql.includes('"closing_date" >='));
    expect(closings.length).toBeGreaterThan(0);
    for (const q of closings) expect([q.sql.includes('"mre_realm_id" = $'), q.parameters.includes(REALM)]).toEqual([true, true]);
  });

  it('history: the reopen, the closings and the classifications leave their AuditRecords; the views write none and mutate no cash', async () => {
    const { P1, P2, P3, D, classificationId } = await example();
    const actions = async (entityId: string) =>
      (await ctx.pool.query(`SELECT action FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [entityId])).rows.map((r) => r.action as string);
    expect(await actions(D)).toEqual(['CREATED', 'CLOSED', 'REOPENED', 'CLOSED']);
    expect(await actions(classificationId)).toEqual(['TAX_CLASSIFIED']);
    const before = await rowsSnapshot(ctx.pool);
    for (const pr of [P1, P2, P3]) for (const year of [2027, 2028]) await view(pr, year);
    expect(await rowsSnapshot(ctx.pool)).toEqual(before);
    const next = await ctx.classifications.createClassification(
      depositRequest(D, { taxCategory: 'RETAINED_DEPOSIT_DAMAGES', supersedes: classificationId }),
      actor,
    );
    if (next.kind !== 'CREATED') throw new Error(next.kind);
    expect([await actions(classificationId), await actions(next.classification.id)]).toEqual([
      ['TAX_CLASSIFIED', 'TAX_CLASSIFICATION_SUPERSEDED'],
      ['TAX_CLASSIFIED'],
    ]);
    const after = await rowsSnapshot(ctx.pool);
    for (const pr of [P1, P2, P3]) await view(pr, 2028);
    expect(await rowsSnapshot(ctx.pool)).toEqual(after);
  });
});
