import { beforeAll, describe, expect, it } from 'vitest';
import { computeVersionEntries, inputFingerprint, liveSchedule, planRecord, type ScheduleRead, type ScheduleVersion } from './domains/depreciation/index.js';
import { RANDOM_TODAY, randomSchedule, seeded, type RandomIds } from './domains/depreciation/version-random.test-support.js';
import { TAX_RULES } from './domains/tax-rules/index.js';
import { Money, type BusinessDate } from './shared/index.js';
import { sha256Fingerprinter } from './infrastructure/hashing/index.js';
import { PostgresAcquisitionRepository } from './infrastructure/postgres/acquisition-repository.js';
import { createDatabase } from './infrastructure/postgres/database.js';
import { PostgresDepreciationAssetRepository } from './infrastructure/postgres/depreciation-asset-repository.js';
import { readVersionById } from './infrastructure/postgres/depreciation-schedule-version-reads.js';
import {
  REALM,
  actor,
  databaseUrl,
  expectStoredAsPlanned,
  useScheduleVersionDatabase,
} from './infrastructure/postgres/depreciation-schedule-version.test-support.js';
import { PostgresFinancialAccountRepository } from './infrastructure/postgres/financial-account-repository.js';
import { PostgresTaxClassificationRepository } from './infrastructure/postgres/tax-classification-repository.js';
import { PostgresTransactionRepository } from './infrastructure/postgres/transaction-repository.js';
import { PostgresTransactionSplitRepository } from './infrastructure/postgres/transaction-split-repository.js';

/**
 * VC-X-35 (api-design.md §60 "As implemented (VC-8-04)" 13): a property test over seeded random schedules — purchases,
 * owners, sales, capitalised items (splits and WEG uses, anschaffungsnahe or not, refunds), an item linked to a separate
 * asset, and separate assets (`version-random.test-support.ts`) — each serialised to 0052's rows and read back.
 *
 * Each case goes the whole way through the database: the domain plans the version from the random schedule
 * (`planRecord`, SHA-256 fingerprints), the repository records it in its own transaction (`record`, its decision
 * replaced by that plan, superseding the case before; the deferred chain trigger runs at each commit), and it is read
 * back row by row in a fresh snapshot. The stored-row mapping has no in-process half (it is SQL on both sides), so the
 * database round trip is the only one. About 200 ms a case, most of it the domain's derivation of up to 60 years (planned,
 * then recomputed from the rows): 40 cases take about 8 s, hence the explicit timeout. Stage 2 on the stored inputs under
 * the other registries (no database) is `domains/depreciation/version-roundtrip.test.ts`'s.
 *
 * The ids of the random schedules point at rows that exist (0052's composite keys: the asset, the purchases and their
 * allocations, the Parties and the classifications of the Realm); every other value is random. Synthetic data only.
 */
const CASES = 40;

describe.skipIf(databaseUrl === undefined)('random schedules round trip through 0052’s rows (VC-X-35)', () => {
  const { ctx, party, acc8, allocate } = useScheduleVersionDatabase('schedule_version_roundtrip_test');
  const ids = {} as { building: RandomIds };

  beforeAll(async () => {
    const db = createDatabase(ctx.pool);
    const s = await acc8();
    const parties = [s.a, s.b, await party('Erbin C'), await party('Käufer D'), await party('Käuferin E')];
    const created = await new PostgresAcquisitionRepository(db).create(
      {
        mreRealmId: REALM,
        propertyReferenceId: s.pr,
        purchasePrice: Money.of('110000.00', 'EUR'),
        acquiredShare: { numerator: 2, denominator: 5 },
        contractDate: '2029-07-01' as BusinessDate,
        economicTransferDate: '2029-07-01' as BusinessDate,
        landRegistryTransferDate: null,
        buyerPartyIds: [parties[3] as string],
        sellerPartyIds: [s.b],
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (created.kind !== 'CREATED') throw new Error(created.kind);
    const x = created.acquisition.id;
    const xAllocation = await allocate(REALM, x, null);

    // Capitalised splits of the PropertyReference: three MAINTENANCE classifications and the kitchen's OTHER_EXPENSE one.
    const classifications = new PostgresTaxClassificationRepository(db);
    const account = await new PostgresFinancialAccountRepository(db).create(
      { mreRealmId: REALM, accountType: 'BANK', displayName: 'Giro', currency: 'EUR', iban: null },
      actor,
    );
    if (account.kind !== 'CREATED') throw new Error(account.kind);
    const capitalizedSplit = async (taxCategory: 'MAINTENANCE' | 'OTHER_EXPENSE') => {
      const transactions = new PostgresTransactionRepository(db);
      const t = await transactions.createManual(
        {
          mreRealmId: REALM,
          financialAccountId: account.account.id,
          amount: Money.of('6000.00', 'EUR'),
          direction: 'OUTFLOW',
          bookingDate: '2027-04-28' as BusinessDate,
          valueDate: null,
          description: 'Rechnung (synthetisch)',
          propertyReferenceId: null,
        },
        actor,
      );
      if (t.kind !== 'CREATED') throw new Error(t.kind);
      const replaced = await new PostgresTransactionSplitRepository(db).replaceSplits(
        t.transaction.id,
        REALM,
        [
          {
            amount: Money.of('6000.00', 'EUR'),
            financialCategoryCode: 'MAINTENANCE',
            propertyReferenceId: s.pr,
            loanId: null,
            securityDepositId: null,
            description: null,
          },
        ],
        actor,
      );
      if (replaced.kind !== 'REPLACED') throw new Error(replaced.kind);
      if ((await transactions.confirm(t.transaction.id, REALM, actor)).kind !== 'CONFIRMED') throw new Error('confirm');
      const splitId = (await ctx.pool.query(`SELECT id FROM transaction_split WHERE transaction_id = $1`, [t.transaction.id])).rows[0].id as string;
      const c = await classifications.createClassification(
        {
          mreRealmId: REALM,
          sourceType: 'TRANSACTION_SPLIT',
          sourceId: splitId,
          taxCategory,
          treatment: 'CAPITALIZED',
          reviewState: 'USER_CONFIRMED',
          supersedes: null,
          notes: null,
          sourceReferences: [],
        },
        actor,
      );
      if (c.kind !== 'CREATED') throw new Error(c.kind);
      return { splitId, classificationId: c.classification.id };
    };
    const maintenance = [await capitalizedSplit('MAINTENANCE'), await capitalizedSplit('MAINTENANCE'), await capitalizedSplit('MAINTENANCE')];
    const kitchenSplit = await capitalizedSplit('OTHER_EXPENSE');
    const separate = await new PostgresDepreciationAssetRepository(db, { capitalizedSources: classifications.capitalizedSources }).create(
      {
        mreRealmId: REALM,
        propertyReferenceId: s.pr,
        assetType: 'SEPARATE_ASSET',
        depreciationMethod: 'LINEAR_7_1',
        buildingCompletionYear: null,
        description: 'Einbauküche, Wohnung 3 (synthetisch)',
        usefulLifeYears: 10,
        usefulLifeBasis: 'BFH IX R 14/15 (verification-checklist B8)',
        acquiredOn: '2027-04-20' as BusinessDate,
        items: [{ sourceType: 'TRANSACTION_SPLIT', sourceId: kitchenSplit.splitId, sourcePosition: null }],
        sourceReferences: [],
        reviewState: 'CONFIRMED',
        advisorPartyId: null,
        shorterUsefulLives: [],
        purchaseMethods: [],
        notes: null,
      },
      actor,
    );
    if (separate.kind !== 'CREATED') throw new Error(JSON.stringify(separate));
    const common = {
      propertyReferenceId: s.pr,
      parties,
      acquisitions: [
        { id: s.w, allocationId: s.allocation },
        { id: x, allocationId: xAllocation },
      ],
      classifications: [...maintenance, kitchenSplit].map((c) => c.classificationId),
    };
    ids.building = { ...common, assetId: s.assetId, separateAssetId: separate.asset.id };
  });

  const readBack = (versionId: string): Promise<ScheduleVersion | undefined> =>
    createDatabase(ctx.pool)
      .transaction()
      .execute((trx) => readVersionById(trx, versionId));

  it(`${CASES} seeded random schedules: recorded, read back row by row equal to the plan, recomputed to their own entries`, { timeout: 60_000 }, async () => {
    const random = seeded(20261101);
    const seen = { recorded: 0, refused: 0, separate: 0, sales: 0, items: 0, refunds: 0, pools: 0, linked: 0, fractions: 0 };
    const previous = new Map<string, string>();
    for (let run = 0; run < CASES; run++) {
      const { input, throughYear, label } = randomSchedule(random, ids.building, run);
      const read: ScheduleRead = {
        asset: input.asset,
        acquisitions: input.acquisitions,
        ownerships: input.ownerships,
        capitalizedItems: input.capitalizedItems ?? [],
        links: input.links ?? [],
        ownerPartyFound: null,
        currentVersion: null,
      };
      const context = { registry: TAX_RULES, fingerprinter: sha256Fingerprinter, today: RANDOM_TODAY, recordedBy: actor.actorId };
      const expectedInputFingerprint = inputFingerprint(
        liveSchedule(read, TAX_RULES, sha256Fingerprinter, RANDOM_TODAY, throughYear).inputs,
        throughYear,
        sha256Fingerprinter,
      );
      const request = { throughYear, reason: `Zufallsplan ${run} (synthetisch)`, expectedInputFingerprint, acceptChangedYears: [] };
      const decision = planRecord({ schedule: read, current: null }, request, context);
      const where = `run ${run} through ${throughYear}: ${label}`;
      if (decision.kind !== 'RECORD') {
        // Only a year without a figure, or nothing yet to record, is refused (§60 steps 4 and 5).
        expect([where, decision.kind === 'REFUSED' && ['SCHEDULE_NOT_COMPLETE', 'NOTHING_TO_RECORD'].includes(decision.refusal.kind)]).toEqual([where, true]);
        seen.refused++;
        continue;
      }
      const planned = decision.version;
      // The random asset is the building or the separate asset row; the header's facts are the random schedule's.
      const outcome = await ctx.versions.record({
        assetId: planned.assetId,
        mreRealmId: REALM,
        actor,
        decide: () => ({ kind: 'RECORD', version: planned, changedYears: [] }),
      });
      if (outcome.kind !== 'RECORDED') throw new Error(`${where}: ${JSON.stringify(outcome)}`);
      const stored = await readBack(outcome.version.versionId);
      if (stored === undefined) throw new Error(`${where}: not read back`);
      expectStoredAsPlanned(stored, planned, where);
      expect(stored.entries, where).toEqual(outcome.version.entries);
      expect(computeVersionEntries(stored.inputs, TAX_RULES, stored.fromYear, stored.throughYear), where).toEqual(stored.entries);
      expect(stored.supersedesVersionId, where).toBe(previous.get(stored.assetId) ?? null);
      previous.set(stored.assetId, stored.versionId);
      seen.recorded++;
      if (input.asset.assetType === 'SEPARATE_ASSET') seen.separate++;
      if (input.acquisitions.length > 1) seen.sales++;
      const items = stored.inputs.components.filter((c) => c.kind === 'CAPITALIZED_ITEM');
      seen.items += items.length;
      seen.refunds += items.filter((c) => c.basis < 0n).length;
      seen.pools += stored.inputs.components.some((c) => c.parts.some((p) => p.poolKey !== null)) ? 1 : 0;
      seen.linked += (input.links ?? []).length;
      seen.fractions += stored.inputs.components.flatMap((c) => c.parts).filter((p) => p.fractions.length > 0).length;
    }
    // The draw covers what the property is about.
    expect(seen.recorded, JSON.stringify(seen)).toBeGreaterThanOrEqual(CASES * 0.9);
    for (const key of ['separate', 'sales', 'items', 'refunds', 'pools', 'linked', 'fractions'] as const) {
      expect([key, seen[key] > 0], JSON.stringify(seen)).toEqual([key, true]);
    }
  });
});
