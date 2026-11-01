import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { deriveSchedule, type ScheduleComponent } from '../../domains/depreciation/index.js';
import { TAX_RULES } from '../../domains/tax-rules/index.js';
import { buildTaxYearView, type TaxYearView } from '../../domains/taxation/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { OTHER_REALM, REALM, TODAY, actor, databaseUrl, useScheduleVersionDatabase } from './depreciation-schedule-version.test-support.js';
import { PostgresFinancialAccountRepository } from './financial-account-repository.js';
import type { Database } from './schema.js';
import { PostgresTaxClassificationRepository, taxYearSnapshot } from './tax-classification-repository.js';
import { readTaxYear } from './tax-year-reads.js';
import { levelOf, taxYearDepreciationIn } from './tax-year-depreciation.js';
import { rowsSnapshot } from './tax-year-view.test-support.js';
import { PostgresTransactionRepository } from './transaction-repository.js';
import { PostgresTransactionSplitRepository } from './transaction-split-repository.js';

/**
 * VC-8-05's adapter against PostgreSQL (api-design.md §58C "How the view gets the AfA without a cycle", "Limits,
 * performance, consistency"): the levels it carries (§58C's review table), the view's AfA equal to the schedule's
 * components of the year at both levels, §60's recording state of the year (none recorded — the shipped default — then
 * recorded, then changed), a `VOID` asset not read, one snapshot with the view, the cap with the AfA components, the
 * query plans, no module cycle, and "no cash mutated" over the extended tables. ACC8's purchase (synthetic).
 */
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
/** After the anschaffungsnahe window of ACC8 (2026-07-01 to 2029-06-30): the check is final, nothing else is open. */
const LATER = day('2029-10-15');

describe.skipIf(databaseUrl === undefined)('the AfA in the tax-year view: the adapter (VC-8-05)', () => {
  const { ctx, acc8, allocate, record } = useScheduleVersionDatabase('tax_year_depreciation_test');
  let giro = '';

  beforeAll(async () => {
    const created = await new PostgresFinancialAccountRepository(createDatabase(ctx.pool)).create(
      { mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    giro = created.account.id;
  });

  const tax = () => new PostgresTaxClassificationRepository(createDatabase(ctx.pool));
  async function view(pr: string, year: number, ownerPartyId: string | null = null, today = TODAY): Promise<TaxYearView> {
    const read = await tax().readTaxYear(pr, REALM, year, ownerPartyId, today);
    if (read === undefined) throw new Error('no read');
    const outcome = buildTaxYearView(read, { year, ownerPartyId, today, registry: TAX_RULES });
    if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
    return outcome.view;
  }
  const afa = (v: TaxYearView, line: string) => v.werbungskosten.afaLines?.find((l) => l.line === line);
  const money = (m: Money | null | undefined) => m?.amount ?? null;
  async function repairSplit(pr: string, amount: string, date: string): Promise<string> {
    const db = createDatabase(ctx.pool);
    const transactions = new PostgresTransactionRepository(db);
    const created = await transactions.createManual(
      {
        mreRealmId: REALM,
        financialAccountId: giro,
        amount: eur(amount),
        direction: 'OUTFLOW',
        bookingDate: day(date),
        valueDate: null,
        description: 'Rechnung (synthetisch)',
        propertyReferenceId: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const replaced = await new PostgresTransactionSplitRepository(db).replaceSplits(
      created.transaction.id,
      REALM,
      [{ amount: eur(amount), financialCategoryCode: 'MAINTENANCE', propertyReferenceId: pr, loanId: null, securityDepositId: null, description: null }],
      actor,
    );
    if (replaced.kind !== 'REPLACED') throw new Error(JSON.stringify(replaced));
    if ((await transactions.confirm(created.transaction.id, REALM, actor)).kind !== 'CONFIRMED') throw new Error('confirm');
    return (await ctx.pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1`, [created.transaction.id])).rows[0].id as string;
  }
  async function capitalize(splitId: string): Promise<void> {
    const outcome = await tax().createClassification(
      {
        mreRealmId: REALM,
        sourceType: 'TRANSACTION_SPLIT',
        sourceId: splitId,
        taxCategory: 'MAINTENANCE',
        treatment: 'CAPITALIZED',
        reviewState: 'USER_CONFIRMED',
        supersedes: null,
        notes: null,
        sourceReferences: [],
      },
      actor,
    );
    if (outcome.kind !== 'CREATED') throw new Error(JSON.stringify(outcome));
  }

  it('carries each Depreciation code at the level of §58C’s review table (§59A, §59B, §60)', () => {
    const open = [
      'ASSET_NOT_CONFIRMED',
      'COMPLETION_YEAR_MISSING',
      'ACQUISITION_NOT_CONFIRMED',
      'NO_ALLOCATION',
      'ALLOCATION_NOT_CONFIRMED',
      'NO_BUILDING',
      'USEFUL_LIFE_NOT_CONFIRMED',
      'HISTORICAL_RULE_NOT_SUPPORTED',
      'DEPRECIATION_METHOD_UNKNOWN',
      'NO_APPLICABLE_RULE',
      'BUYER_ALREADY_OWNER',
      'DISPOSAL_DATE_MISSING',
      'TRANSFER_DATE_MISSING',
      'NO_CAPITALIZED_ITEMS',
      'ITEM_CLASSIFICATION_NEEDS_REVIEW',
      'LINKED_ITEM_NOT_CAPITALIZED',
      'USEFUL_LIFE_NOT_SHORTER',
      'USEFUL_LIFE_START_TO_VERIFY',
      'DISPOSAL_YEAR_TO_VERIFY',
      'HISTORICAL_RULE_TO_VERIFY',
      'SHARE_REDUCTION_SPLIT_TO_VERIFY',
      'OWNER_WITHOUT_ACQUISITION',
      'SUBSEQUENT_COST_START_TO_VERIFY',
      'SUBSEQUENT_COST_END_TO_VERIFY',
      'SUBSEQUENT_COST_SHORTER_LIFE_TO_VERIFY',
      'CAPITALIZED_YEAR_DIFFERS',
      'CAPITALIZED_ITEM_NOT_OWNED',
      'REFUND_EXCEEDS_CAPITALIZED',
      'LATER_ITEM_TO_VERIFY',
      'ANSCHAFFUNGSNAHE_NO_LONGER_ABOVE',
      'DEPRECIATION_SCHEDULE_NOT_RECORDED',
      'DEPRECIATION_CHANGED_SINCE_RECORDED',
      'RECORDED_VERSION_NOT_REPRODUCIBLE',
    ];
    const informative = [
      'SHORTER_USEFUL_LIFE',
      'ACQUISITION_COST_UNPAID',
      'OWNER_SHARE_CHANGED',
      'ANSCHAFFUNGSNAHE_CAPITALIZED',
      'CAPITALIZED_REFUND',
      'GWG_THRESHOLD_MAY_APPLY',
      'DATE_IS_BOOKING_DATE',
      'WITHDRAWAL_DATE_ASSUMED',
    ];
    expect(open.filter((code) => levelOf(code) !== 'OPEN')).toEqual([]);
    expect(informative.filter((code) => levelOf(code) !== 'INFORMATIVE')).toEqual([]);
  });

  it('the view’s AfA equals the schedule’s components of the year at both levels; nothing recorded (the shipped default): NOT_RECORDED, final false', async () => {
    const { pr, a, b, assetId } = await acc8();
    for (const year of [2026, 2027]) {
      for (const owner of [null, a, b]) {
        const v = await view(pr, year, owner);
        const read = await ctx.source.read(assetId, REALM, owner);
        if (read === undefined) throw new Error('no read');
        const schedule = deriveSchedule({ ...read, today: TODAY, from: year, to: year, ownerPartyId: owner }, TAX_RULES);
        const component = schedule.components[0] as ScheduleComponent;
        const y = component.years[0];
        expect(
          afa(v, 'AFA_BUILDING')?.items.map((i) => [i.componentId, i.kind, money(i.amount), i.rule, i.months, money(i.basis), i.rate?.rate, i.start?.method]),
        ).toEqual([
          [
            component.componentId,
            'ACQUISITION',
            money(y?.amount),
            { ruleCode: y?.rule?.ruleCode, version: y?.rule?.version },
            y?.months,
            money(component.basis.amount),
            component.rate?.rate,
            'TRANSFER_DATE',
          ],
        ]);
        if (owner !== null) expect(afa(v, 'AFA_BUILDING')?.items[0]?.share).toMatchObject({ share: component.owners[0]?.share, partKey: `OWNER:${owner}` });
        expect([v.depreciation.status, v.result.basis, v.review.final]).toEqual(['AVAILABLE', 'AFTER_DEPRECIATION', false]);
        expect(v.depreciation.assets.map((x) => x.recording?.state)).toEqual(['NOT_RECORDED']);
        expect(v.flags.map((f) => f.code)).toContain('DEPRECIATION_SCHEDULE_NOT_RECORDED');
        expect(v.review.open).toContainEqual({ code: 'DEPRECIATION_SCHEDULE_NOT_RECORDED', count: 1 });
      }
    }
    const v2026 = await view(pr, 2026);
    expect([money(afa(v2026, 'AFA_BUILDING')?.total), v2026.owners?.map((o) => money(o.werbungskosten.afaLines?.[0]?.total))]).toEqual([
      '2544.00',
      ['1526.40', '1017.60'],
    ]);
    // Before the purchase: nothing active, no recording flag, no AfA.
    const v2025 = await view(pr, 2025);
    expect([v2025.depreciation.status, money(v2025.depreciation.amount), v2025.depreciation.assets, v2025.flags]).toEqual(['AVAILABLE', '0.00', [], []]);
  });

  it('recorded: 2026 UNCHANGED and final after the window; a superseded allocation makes it CHANGED_SINCE_RECORDED (open), the line still the derived figure', async () => {
    const { pr, w, allocation, assetId } = await acc8();
    expect((await record(assetId, { throughYear: 2027 })).kind).toBe('RECORDED');
    const recorded = await view(pr, 2026, null, LATER);
    expect(recorded.depreciation.assets[0]?.recording).toMatchObject({ state: 'UNCHANGED', versionNumber: 1, throughYear: 2027, reproducible: true });
    expect([recorded.flags, recorded.review.open, recorded.review.final]).toEqual([[], [], true]);
    // Before the window closes the check keeps it open (ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL), whatever the AfA.
    expect((await view(pr, 2026)).review.open).toEqual([{ code: 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL', count: 1 }]);
    await allocate(REALM, w, allocation);
    const changed = await view(pr, 2026, null, LATER);
    expect(changed.flags).toEqual([
      {
        code: 'DEPRECIATION_CHANGED_SINCE_RECORDED',
        details: expect.objectContaining({
          assetId,
          year: 2026,
          recorded: { amount: '2544.00', currency: 'EUR' },
          derived: { amount: '2544.00', currency: 'EUR' },
          amountChanged: false,
          causes: ['INPUTS'],
        }),
      },
    ]);
    expect([money(afa(changed, 'AFA_BUILDING')?.total), changed.review.final]).toEqual(['2544.00', false]);
  });

  it('a VOID asset is not read: NO_ASSET (open), DEPRECIATION_NOT_AVAILABLE, BEFORE_DEPRECIATION', async () => {
    const { pr, w, assetId } = await acc8();
    expect((await ctx.assets.void(assetId, REALM, 'falsch angelegt', new Date('2028-01-20T10:00:00Z'), actor)).kind).toBe('VOIDED');
    const v = await view(pr, 2026);
    expect([v.depreciation.status, v.depreciation.assets, v.result.basis, v.depreciation.gaps]).toEqual([
      'DEPRECIATION_NOT_AVAILABLE',
      [],
      'BEFORE_DEPRECIATION',
      [{ code: 'NO_ASSET', assetId: null, componentId: null, ownerPartyIds: [], details: { acquisitionIds: [w], items: [], ownershipInYear: true } }],
    ]);
    expect(v.flags.map((f) => f.code)).toEqual(['DEPRECIATION_NOT_AVAILABLE', 'ANSCHAFFUNGSNAHE_CHECK_NOT_FINAL']);
    // Before the purchase and without an Ownership in the year: nothing needs an asset.
    expect((await view(pr, 2025)).depreciation.gaps).toEqual([]);
  });

  it('one snapshot: a capitalisation, an allocation superseded and a version recorded meanwhile are not seen; capitalized and the AfA agree', async () => {
    const { pr, w, allocation, assetId } = await acc8();
    const repair = await repairSplit(pr, '35700.00', '2027-03-10');
    const read = await readTaxYear(createDatabase(ctx.pool), TAX_RULES, pr, REALM, 2027, null, TODAY, tax().capitalizedSources, async () => {
      // Committed by other connections between the view's own reads and the adapter's.
      await capitalize(repair);
      await allocate(REALM, w, allocation);
      expect((await record(assetId, { throughYear: 2027 })).kind).toBe('RECORDED');
    });
    if (read === undefined) throw new Error('no read');
    const outcome = buildTaxYearView(read, { year: 2027, ownerPartyId: null, today: TODAY, registry: TAX_RULES });
    if (outcome.kind !== 'VIEW') throw new Error(outcome.kind);
    const v = outcome.view;
    expect([v.capitalized.items, afa(v, 'AFA_BUILDING')?.items.map((i) => i.kind), v.depreciation.assets[0]?.recording?.state]).toEqual([
      [],
      ['ACQUISITION'],
      'NOT_RECORDED',
    ]);
    // Read again afterwards: all three are seen together.
    const after = await view(pr, 2027);
    expect([after.capitalized.items.map((i) => i.component?.componentId), afa(after, 'AFA_BUILDING')?.items.map((i) => i.componentId)]).toEqual([
      [`TRANSACTION_SPLIT:${repair}`],
      [`ACQUISITION:${w}`, `TRANSACTION_SPLIT:${repair}`],
    ]);
    expect(money(afa(after, 'AFA_BUILDING')?.total)).toBe('5802.00');
    // The version was recorded on the state after both changes, so it now reads UNCHANGED.
    expect(after.depreciation.assets[0]?.recording?.state).toBe('UNCHANGED');
  });

  it('the cap counts the AfA components: 5,000 with the purchase → the view; 5,001 → TAX_YEAR_TOO_LARGE', { timeout: 60_000 }, async () => {
    const { pr } = await acc8();
    const bulk = async (n: number) => {
      await ctx.pool.query(
        `WITH t AS (
           INSERT INTO ledger_transaction (mre_realm_id, financial_account_id, amount, currency, direction, booking_date, provenance, status, created_by)
           SELECT $1, $2, 1, 'EUR', 'INFLOW', date '2027-03-01' + (g % 200), 'MANUAL', 'UNREVIEWED', 'x' FROM generate_series(1, $3::int) g RETURNING id)
         INSERT INTO transaction_split (transaction_id, mre_realm_id, position, amount, currency, financial_category_id, property_reference_id, created_by)
         SELECT t.id, $1, 1, 1, 'EUR', (SELECT id FROM financial_category WHERE code = 'OWNER_CONTRIBUTION'), $4, 'x' FROM t`,
        [REALM, giro, n, pr],
      );
      await ctx.pool.query(
        `UPDATE ledger_transaction SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', version = version + 1
          WHERE status = 'UNREVIEWED' AND id IN (SELECT transaction_id FROM transaction_split WHERE property_reference_id = $1)`,
        [pr],
      );
    };
    const run = async () => {
      const read = await tax().readTaxYear(pr, REALM, 2027, null, TODAY);
      if (read === undefined) throw new Error('no read');
      return buildTaxYearView(read, { year: 2027, ownerPartyId: null, today: TODAY, registry: TAX_RULES });
    };
    await bulk(4999);
    const at5000 = await run();
    if (at5000.kind !== 'VIEW') throw new Error(at5000.kind);
    expect([at5000.view.notInView.items.length, afa(at5000.view, 'AFA_BUILDING')?.itemCount]).toEqual([4999, 1]);
    await bulk(1);
    expect(await run()).toEqual({ kind: 'TAX_YEAR_TOO_LARGE', itemCount: 5001, limit: 5000 });
  });

  it('the plans of the asset, capitalised-split and CURRENT-version queries inside the view’s snapshot use their indexes', async () => {
    const { pr } = await acc8();
    const sent: CompiledQuery[] = [];
    const logged = new Kysely<Database>({ dialect: new PostgresDialect({ pool: ctx.pool }), log: (e) => void (e.level === 'query' && sent.push(e.query)) });
    await new PostgresTaxClassificationRepository(logged).readTaxYear(pr, REALM, 2027, null, TODAY);
    const planOf = async (match: (sql: string) => boolean) => {
      const query = sent.find((q) => match(q.sql));
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
    expect(await planOf((s) => s.includes('from "depreciation_asset"') && s.includes('"status" = $'))).toMatch(
      /depreciation_asset_(property_reference_idx|building_active)/,
    );
    expect(await planOf((s) => s.includes("v.status = 'CURRENT'"))).toContain('depreciation_schedule_version_current');
    expect(await planOf((s) => s.includes('"s"."property_reference_id" = $') && s.includes('"treatment" = $'))).toContain(
      'transaction_split_property_reference_idx',
    );
  });

  it('no module cycle among tax-classification-repository.ts, tax-year-depreciation.ts and capitalized-items.ts', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
      'tax-classification-repository.ts',
      'tax-year-reads.ts',
      'tax-year-depreciation.ts',
      'capitalized-items.ts',
      'depreciation-schedule-source.ts',
    ];
    const imports = (file: string) => [...readFileSync(join(here, file), 'utf8').matchAll(/from '\.\/([^']+)\.js'/g)].map((m) => `${m[1]}.ts`);
    expect(imports('tax-classification-repository.ts')).toContain('tax-year-reads.ts');
    expect(imports('tax-year-reads.ts')).toContain('tax-year-depreciation.ts');
    expect(imports('tax-year-depreciation.ts')).toEqual(expect.arrayContaining(['capitalized-items.ts', 'depreciation-schedule-source.ts']));
    // None of the lower ones reaches back to the repository or the view's reads.
    for (const file of ['tax-year-depreciation.ts', 'capitalized-items.ts', 'depreciation-schedule-source.ts']) {
      expect(imports(file), file).not.toContain('tax-classification-repository.ts');
      expect(imports(file), file).not.toContain('tax-year-reads.ts');
    }
    expect(files.length).toBe(5);
  });

  it('no cash mutated around views of three years at both levels (the extended tables); a write inside the view’s transaction is refused', async () => {
    const { pr, a, assetId } = await acc8();
    expect((await record(assetId, { throughYear: 2027 })).kind).toBe('RECORDED');
    const before = await rowsSnapshot(ctx.pool);
    for (const year of [2026, 2027, 2028]) for (const owner of [null, a]) await view(pr, year, owner);
    expect(await rowsSnapshot(ctx.pool)).toEqual(before);
    const refused = await taxYearSnapshot(createDatabase(ctx.pool), async (trx) => {
      await taxYearDepreciationIn(trx, {
        mreRealmId: REALM,
        propertyReferenceId: pr,
        year: 2027,
        ownerPartyId: null,
        today: TODAY,
        registry: TAX_RULES,
        capitalizedSources: tax().capitalizedSources,
      });
      return trx
        .updateTable('depreciation_asset')
        .set({ notes: 'x' })
        .where('id', '=', assetId)
        .execute()
        .then(
          () => 'accepted',
          (e: { code?: string }) => e.code,
        );
    }).catch((e: { code?: string }) => e.code);
    expect(refused).toBe('25006');
  });

  it('Realm: another Realm’s same-named setup never reaches the view; another Realm reads this PropertyReference as unknown', async () => {
    const mine = await acc8();
    await acc8(OTHER_REALM);
    const v = await view(mine.pr, 2026);
    expect(v.depreciation.assets.map((x) => x.assetId)).toEqual([mine.assetId]);
    expect(await tax().readTaxYear(mine.pr, OTHER_REALM, 2026, null, TODAY)).toBeUndefined();
  });
});
