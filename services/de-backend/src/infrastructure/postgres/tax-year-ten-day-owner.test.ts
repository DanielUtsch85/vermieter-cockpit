import { beforeAll, describe, expect, it } from 'vitest';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { buildTaxYearView, type TaxYearItem, type TaxYearOutcome, type TaxYearView } from '../../domains/taxation/index.js';
import { centsOf, type Money } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { PostgresOwnershipRepository } from './ownership-repository.js';
import { actor, codes, databaseUrl, day, due, nextTenant, OTHER_REALM, REALM, today, useTaxYearDatabase } from './tax-year.test-support.js';

/**
 * VC-X-39 (api-design.md §58F) at the owner level, per the owner's decision 237-1 (Entscheidung des Projektinhabers,
 * 2026-11-02): the item flag `PROPOSED_BY_10_DAY_RULE` is in an owner's view only where that owner has a part in the
 * split; the year flag of the same code stays unfiltered, as every year flag (§58C), and names the whole split's amount
 * (237-3). Two January 2027 rents paid on 2026-12-23 and 2026-12-29 without a recorded due date, around an owner change
 * on 2026-12-28: Anna 3/4 throughout, Ben 1/4 until 2026-12-27, Clara 1/4 from 2026-12-28. Synthetic data only.
 */
describe.skipIf(databaseUrl === undefined)('the 10-day proposal at the owner level (§58F, decision 237-1)', () => {
  const { ctx, propertyReference, rent, newReference } = useTaxYearDatabase('tax_year_ten_day_owner_test');
  let ownerships: PostgresOwnershipRepository;
  beforeAll(() => {
    ownerships = new PostgresOwnershipRepository(createDatabase(ctx.pool));
  });

  const PROPOSED = 'PROPOSED_BY_10_DAY_RULE';
  async function party(displayName: string, realm = REALM) {
    const outcome = await ctx.parties.create(
      {
        mreRealmId: realm,
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
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.party.id;
  }
  async function owner(pr: string, partyId: string, share: [number, number], validFrom: string, validUntil: string | null = null) {
    const o = await ownerships.create(
      {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        ownerPartyId: partyId,
        share: { numerator: share[0], denominator: share[1] },
        validFrom: day(validFrom),
        validUntil: validUntil === null ? null : day(validUntil),
        acquisitionId: null,
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (o.kind !== 'CREATED') throw new Error(o.kind);
  }
  const outcome = async (pr: string, year: number, ownerPartyId: string | null = null, realm = REALM): Promise<TaxYearOutcome> => {
    const read = await ctx.classifications.readTaxYear(pr, realm, year, ownerPartyId, today);
    if (read === undefined) throw new Error('no PropertyReference');
    return buildTaxYearView(read, { year, ownerPartyId, today, registry: TAX_RULES });
  };
  const view = async (pr: string, year: number, ownerPartyId: string | null = null): Promise<TaxYearView> => {
    const o = await outcome(pr, year, ownerPartyId);
    if (o.kind !== 'VIEW') throw new Error(o.kind);
    return o.view;
  };
  const items = (v: TaxYearView): TaxYearItem[] => [...v.einnahmen.lines.flatMap((l) => l.items), ...v.notInView.items, ...v.unclassified.items];
  /** Each item with its share and whether it carries the item flag. */
  const itemFlags = (v: TaxYearView) => items(v).map((i) => [i.sourceId, i.lineAmount?.amount, codes(i.flags).includes(PROPOSED)]);
  type YearFlag = { count: number; items: { sourceId: string; amount: Money; countedInYear: number; open: boolean }[] };
  const yearFlag = (v: TaxYearView) => v.flags.find((f) => f.code === PROPOSED)?.details as YearFlag | undefined;
  const openCount = (v: TaxYearView) => v.review.open.find((o) => o.code === PROPOSED)?.count ?? 0;
  const bySourceId = (a: readonly unknown[], b: readonly unknown[]) => ((a[0] as string) < (b[0] as string) ? -1 : 1);
  const auditCount = async () => Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM audit_record`)).rows[0].n);

  async function fixture() {
    const pr = await propertyReference();
    const [anna, ben, clara] = [await party('Anna Eigentümerin'), await party('Ben Eigentümer'), await party('Clara Eigentümerin')];
    await owner(pr, anna, [3, 4], '2020-01-01');
    await owner(pr, ben, [1, 4], '2020-01-01', '2026-12-27');
    await owner(pr, clara, [1, 4], '2026-12-28');
    const [t1, t2] = [nextTenant(), nextTenant()];
    const early = await rent(pr, t1, '2026-12-23', '2027010100');
    const late = await rent(pr, t2, '2026-12-29', '2027010100');
    const march = await rent(pr, t1, '2027-03-01', '2027030100');
    return { pr, anna, ben, clara, t1, t2, early, late, march };
  }

  it('the item flag only at the owners with a part in the split; the year flag unfiltered at every owner, with the whole amount', async () => {
    const f = await fixture();
    const auditBefore = await auditCount();

    // 2026, the year paid: both splits count here, each with its item flag at the owners on its booking date only.
    const [p26, anna26, ben26, clara26] = [
      await view(f.pr, 2026),
      await view(f.pr, 2026, f.anna),
      await view(f.pr, 2026, f.ben),
      await view(f.pr, 2026, f.clara),
    ];
    expect(itemFlags(p26)).toEqual([
      [f.early, '900.00', true],
      [f.late, '900.00', true],
    ]);
    expect(itemFlags(anna26)).toEqual([
      [f.early, '675.00', true],
      [f.late, '675.00', true],
    ]);
    // Ben has no part in the late split (sold before it), Clara none in the early one (bought after it).
    expect(itemFlags(ben26)).toEqual([[f.early, '225.00', true]]);
    expect(itemFlags(clara26)).toEqual([[f.late, '225.00', true]]);
    // The item keeps both of its flags at the owner with a part, as at the property level.
    expect([ben26, clara26].map((v) => items(v).map((i) => codes(i.flags)))).toEqual([[['DUE_DATE_ASSUMED', PROPOSED]], [['DUE_DATE_ASSUMED', PROPOSED]]]);
    expect([p26, anna26, ben26, clara26].map(openCount)).toEqual([2, 2, 1, 1]);
    // Counted in 2026: no year flag there, at any level.
    expect([p26, anna26, ben26, clara26].map(yearFlag)).toEqual([undefined, undefined, undefined, undefined]);

    // 2027, the proposed year: no item of either split, the year flag at every level alike, unfiltered by the owner's part.
    const [p27, anna27, clara27] = [await view(f.pr, 2027), await view(f.pr, 2027, f.anna), await view(f.pr, 2027, f.clara)];
    for (const v of [p27, anna27, clara27]) {
      expect(items(v).map((i) => i.sourceId)).toEqual([f.march]);
      expect(yearFlag(v)).toEqual(yearFlag(p27));
      expect(openCount(v)).toBe(1);
      expect(v.review.final).toBe(false);
    }
    // Clara has no part in the early split, yet her year flag names it, with the whole split's amount (237-3), unsummed.
    expect(yearFlag(clara27)?.items.map((i) => [i.sourceId, i.amount.amount, i.countedInYear, i.open])).toEqual(
      [
        [f.early, '900.00', 2026, true],
        [f.late, '900.00', 2026, true],
      ].sort(bySourceId),
    );
    // Ben owns nothing in 2027 and has no part in an item of it: not an owner in the year, as before.
    expect(await outcome(f.pr, 2027, f.ben)).toEqual({ kind: 'NOT_AN_OWNER_IN_YEAR' });

    // Unchanged money: each year the owners sum to the property, and the two years hold the three rents once.
    const rentCents = (v: TaxYearView) => centsOf(v.einnahmen.total);
    expect(rentCents(anna26) + rentCents(ben26) + rentCents(clara26)).toBe(rentCents(p26));
    expect(rentCents(anna27) + rentCents(clara27)).toBe(rentCents(p27));
    expect([rentCents(p26), rentCents(p27), rentCents(p26) + rentCents(p27)]).toEqual([180000n, 90000n, 270000n]);
    expect(p26.owners?.map((o) => [o.ownerPartyId, o.einnahmen.total.amount])).toEqual(
      [
        [f.anna, '1350.00'],
        [f.ben, '225.00'],
        [f.clara, '225.00'],
      ].sort(bySourceId),
    );
    // History: the views write nothing, no AuditRecord.
    expect(await auditCount()).toBe(auditBefore);
  });

  it('a confirmed taxYear: counted in 2027 at its participants only; the item flag informative there, the year flag in 2026 unfiltered (237-2)', async () => {
    const f = await fixture();
    const created = await ctx.classifications.createClassification(
      {
        mreRealmId: REALM,
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: f.late,
        taxCategory: 'RENT',
        treatment: 'INCOME',
        reviewState: 'USER_CONFIRMED',
        supersedes: null,
        notes: null,
        sourceReferences: [],
        taxYear: 2027,
      },
      actor,
    );
    expect(created.kind).toBe('CREATED');
    const [anna27, clara27] = [await view(f.pr, 2027, f.anna), await view(f.pr, 2027, f.clara)];
    expect(itemFlags(anna27)).toEqual([
      [f.late, '675.00', true],
      [f.march, '675.00', false],
    ]);
    expect(itemFlags(clara27)).toEqual([
      [f.late, '225.00', true],
      [f.march, '225.00', false],
    ]);
    // Informative: the late split's flag in review.info; the early one still open in the year flag of 2027.
    expect(clara27.review.info.find((o) => o.code === PROPOSED)?.count).toBe(1);
    // 2026: Ben has no part in the late split, yet his year flag names it, informative, beside his own open item.
    const ben26 = await view(f.pr, 2026, f.ben);
    expect(itemFlags(ben26)).toEqual([[f.early, '225.00', true]]);
    expect(yearFlag(ben26)?.items.map((i) => [i.sourceId, i.amount.amount, i.countedInYear, i.open])).toEqual([[f.late, '900.00', 2027, false]]);
    expect(yearFlag(ben26)).toEqual(yearFlag(await view(f.pr, 2026)));
  });

  it('Realm isolation: a reference of another Realm for the same Tenant decides nothing; its Party is no owner; its read sees no PropertyReference', async () => {
    const f = await fixture();
    // The same mreTenantId in OTHER_REALM, with a recorded due day 3: REALM's rents keep their proposal.
    const foreign = await ctx.references.createReference(newReference(f.t2, due([['2026-01-01', 3]]), OTHER_REALM), actor);
    expect(foreign.kind).toBe('CREATED');
    const clara26 = await view(f.pr, 2026, f.clara);
    expect(itemFlags(clara26)).toEqual([[f.late, '225.00', true]]);
    expect(yearFlag(await view(f.pr, 2027, f.clara))?.count).toBe(2);
    const stranger = await party('Fremd', OTHER_REALM);
    expect((await ctx.classifications.readTaxYear(f.pr, REALM, 2026, stranger, today))?.ownerPartyFound).toBe(false);
    expect(await ctx.classifications.readTaxYear(f.pr, OTHER_REALM, 2026, f.clara, today)).toBeUndefined();
    // Counter-check: the same due day in REALM decides the late split; it moves to 2027 and the flag goes at both places.
    expect((await ctx.references.createReference(newReference(f.t2, due([['2026-01-01', 3]])), actor)).kind).toBe('CREATED');
    expect(itemFlags(await view(f.pr, 2026, f.clara))).toEqual([]);
    expect(yearFlag(await view(f.pr, 2027, f.clara))?.items.map((i) => i.sourceId)).toEqual([f.early]);
  });
});
