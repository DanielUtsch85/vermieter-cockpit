import type { Kysely } from 'kysely';
import { expect } from 'vitest';
import {
  NOT_OWNED_PART,
  centsText,
  computeVersionEntries,
  planRecord,
  reproduce,
  type RecordedSchedule,
  type ScheduleVersion,
  type VersionEntry,
} from './domains/depreciation/index.js';
import { businessDayOf } from './domains/ledger/index.js';
import { TAX_RULES } from './domains/tax-rules/index.js';
import { ScheduleVersionRefusedError } from './application/index.js';
import { depreciationCommands } from './depreciation-commands.test-support.js';
import { sha256Fingerprinter } from './infrastructure/hashing/index.js';
import { PostgresDepreciationScheduleSource, PostgresScheduleVersionRepository, PostgresTaxClassificationRepository } from './infrastructure/postgres/index.js';
import { expectStoredAsPlanned } from './infrastructure/postgres/depreciation-schedule-version.test-support.js';
import type { Database } from './infrastructure/postgres/schema.js';

/**
 * VC-X-35 (api-design.md §60 "As implemented (VC-8-04)" 13): the reproduction from the database for an e2e scenario of
 * §59A or §59B. Built with the recording switch on, in test-only wiring as ACC8's (`depreciationCommands`, no
 * environment variable), on the scenario's own database, with its own clock (a recorded year is never after today):
 *
 * 1. the schedule's input fingerprint of `throughYear`, and the record command (use case and repository, switch on);
 * 2. the version read back from the database in a fresh snapshot, row by row (`PostgresScheduleVersionRepository.find`),
 *    equal field by field to the version the domain plans from the same read (`planRecord`): the stored-row mapping
 *    loses nothing and rounds nothing;
 * 3. recomputed from its stored inputs alone (`computeVersionEntries`) to its own entries, and `reproduce` clean;
 * 4. equal to the schedule read: every year's amount and residual value, every component's part per year (each owner's
 *    and `NOT_OWNED`'s amount, an owner's months, fraction and residual value), and every year `UNCHANGED`;
 * 5. the single version's read: reproducible, every year `UNCHANGED`.
 *
 * A scenario with a year that has no figure is not recordable (§60 open question 1): `expectNotRecordable` checks the
 * refusal and that nothing was stored. Synthetic data only. Test support only.
 */
export function reproductionFromDatabase(db: Kysely<Database>, now: () => Date) {
  const commands = depreciationCommands(db, { recordingEnabled: true, now });
  const capitalizedSources = new PostgresTaxClassificationRepository(db).capitalizedSources;
  const versions = new PostgresScheduleVersionRepository(db, capitalizedSources, now);
  const source = new PostgresDepreciationScheduleSource(db, capitalizedSources, now);
  const principalOf = (mreRealmId: string) => ({ email: 'anna@example.com', mreRealmId, mreRole: 'administrator' });
  const reason = (throughYear: number) => `AfA laut Einkommensteuererklärung ${throughYear} (synthetisch)`;

  async function attempt(assetId: string, throughYear: number, mreRealmId: string, acceptChangedYears: readonly number[] = []) {
    const principal = principalOf(mreRealmId);
    const probe = await commands.schedule({ principal, assetId, from: throughYear, to: throughYear, ownerPartyId: null });
    const expectedInputFingerprint = probe.years[0]?.inputFingerprint as string;
    return commands.recordVersion({ principal, assetId, throughYear, reason: reason(throughYear), expectedInputFingerprint, acceptChangedYears });
  }

  /**
   * Records `assetId` through `throughYear` (superseding its `CURRENT` version, the changed years named) and checks steps
   * 2–5 above; returns the version read back.
   */
  async function expectReproducible(
    assetId: string,
    throughYear: number,
    mreRealmId: string,
    acceptChangedYears: readonly number[] = [],
  ): Promise<ScheduleVersion> {
    const label = `${assetId} through ${throughYear}`;
    const principal = principalOf(mreRealmId);
    const recorded = await attempt(assetId, throughYear, mreRealmId, acceptChangedYears);
    expect([label, recorded.created, recorded.version.throughYear]).toEqual([label, true, throughYear]);

    // 2. Read back in a fresh snapshot; equal to the domain's plan from the same read (a predecessor changes no field of it).
    const found = await versions.find(assetId, mreRealmId, recorded.version.versionId);
    if (found === undefined) throw new Error(`${label}: not read back`);
    const stored = found.version;
    const planned = planRecord(
      { schedule: { ...found.schedule, currentVersion: null }, current: null },
      { throughYear, reason: reason(throughYear), expectedInputFingerprint: stored.inputFingerprint, acceptChangedYears: [] },
      { registry: TAX_RULES, fingerprinter: sha256Fingerprinter, today: businessDayOf(now()), recordedBy: principal.email },
    );
    if (planned.kind !== 'RECORD') throw new Error(`${label}: planned ${planned.kind}`);
    expectStoredAsPlanned(stored, planned.version, label);
    expect(stored.entries.length, label).toBeGreaterThan(0);

    // 3. Recomputed from the stored inputs alone.
    expect(computeVersionEntries(stored.inputs, TAX_RULES, stored.fromYear, stored.throughYear), label).toEqual(stored.entries);
    expect(reproduce(stored, TAX_RULES, sha256Fingerprinter), label).toEqual({ reproducible: true, causes: [], years: [] });

    // 4. Equal to the schedule read.
    const schedule = await commands.schedule({ principal, assetId, from: stored.fromYear, to: throughYear, ownerPartyId: null });
    expect(
      stored.years.map((y) => [y.year, centsText(y.amount), centsText(y.residualValue)]),
      label,
    ).toEqual(schedule.years.map((y) => [y.year, y.amount?.amount, y.residualValue?.amount]));
    expect(partsOf(stored.entries), label).toEqual(partsOfSchedule(schedule));
    expect(
      schedule.years.map((y) => y.recording),
      label,
    ).toEqual(schedule.years.map(() => 'UNCHANGED'));
    expect(schedule.recordedVersion?.versionId, label).toBe(stored.versionId);

    // 5. The single version's read.
    const view = await commands.getVersion({ principal, assetId, versionId: stored.versionId });
    expect([view.reproduction, view.comparison?.years.map((y) => y['state'])], label).toEqual([
      { reproducible: true, causes: [], years: [] },
      stored.years.map(() => 'UNCHANGED'),
    ]);
    return stored;
  }

  /** A year without a figure through `throughYear`: `SCHEDULE_NOT_COMPLETE`, and no version stored. */
  async function expectNotRecordable(assetId: string, throughYear: number, mreRealmId: string): Promise<void> {
    await expect(attempt(assetId, throughYear, mreRealmId)).rejects.toSatisfy(
      (e: unknown) => e instanceof ScheduleVersionRefusedError && e.refusal.kind === 'SCHEDULE_NOT_COMPLETE',
    );
    expect(await versions.list(assetId, mreRealmId, null)).toEqual([]);
    expect((await source.read(assetId, mreRealmId, null))?.currentVersion).toBeNull();
  }

  return { expectReproducible, expectNotRecordable };
}

type Part = readonly [
  year: number,
  componentId: string,
  partKey: string,
  amount: string,
  months: number | null,
  fraction: string | null,
  residual: string | null,
];
const byKey = (a: Part, b: Part) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);

/** The stored entries as parts per year and component: an owner's with months, fraction and residual; `NOT_OWNED` with its amount. */
function partsOf(entries: readonly VersionEntry[]): Part[] {
  return entries
    .map((e): Part => {
      const owner = e.partKey !== NOT_OWNED_PART;
      return [
        e.year,
        e.componentId,
        e.partKey,
        centsText(e.amount),
        owner ? e.months : null,
        owner ? e.fraction : null,
        owner ? centsText(e.residualValue) : null,
      ];
    })
    .sort(byKey);
}

/** The schedule read's parts in the same shape: each component year's owners and its `notOwned`. */
function partsOfSchedule(schedule: RecordedSchedule): Part[] {
  const parts: Part[] = [];
  for (const c of schedule.components) {
    for (const y of c.years) {
      for (const o of y.owners) {
        if (o.amount === null) continue;
        parts.push([y.year, c.componentId, `OWNER:${o.ownerPartyId}`, o.amount.amount, o.months, o.fraction, o.residualValue?.amount ?? null]);
      }
      if (y.notOwned !== null) parts.push([y.year, c.componentId, NOT_OWNED_PART, y.notOwned.amount, null, null, null]);
    }
  }
  return parts.sort(byKey);
}
