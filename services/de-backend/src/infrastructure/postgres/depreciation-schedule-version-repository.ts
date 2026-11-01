import { sql, type Kysely, type Transaction } from 'kysely';
import {
  centsText,
  type RecordDecision,
  type RecordOutcome,
  type RecordRead,
  type ScheduleVersion,
  type ScheduleVersionRepository,
  type ScheduleVersionStatus,
} from '../../domains/depreciation/index.js';
import { businessDayOf } from '../../domains/ledger/index.js';
import type { AuditActor, RuleRef } from '../../shared/index.js';
import { writeAudit } from './audit.js';
import type { CapitalizedSourcesReader } from './capitalized-items.js';
import { UUID } from './depreciation-asset-rows.js';
import { readScheduleIn } from './depreciation-schedule-source.js';
import { findVersion, listVersions, lockCurrentVersion, readVersionById, storedRuleVersionHashes } from './depreciation-schedule-version-reads.js';
import { insertVersion } from './depreciation-schedule-version-rows.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import type { Database } from './schema.js';

/**
 * PostgreSQL implementation of the recorded schedule versions (api-design.md §60, migration 0052). A record is one
 * `REPEATABLE READ` read-write transaction in the lock order of §60 "Concurrency": the key, the PropertyReference
 * (no-op write), the asset `FOR UPDATE`, the `CURRENT` version `FOR UPDATE`; then the derivation's snapshot read in it,
 * the use case's decision, the supersede, the version's rows, the AuditRecords and the key. A serialisation failure
 * (`40001`) is answered as such: the use case retries with a fresh snapshot. Nothing outside 0052's tables and the
 * AuditRecords is written (P8-D14).
 */

const ENTITY_TYPE = 'DepreciationScheduleVersion';
const RECORD_SCOPE = 'depreciation-schedule-version.record';

/** Thrown inside the transaction to roll back the key claim and every write together. */
class Rejected extends Error {
  constructor(readonly outcome: RecordOutcome) {
    super(outcome.kind);
  }
}

/** What a key stores (§15): the answer as recorded; a version changes only by the supersede step, so it is re-read. */
interface RecordSnapshot {
  readonly kind: 'RECORDED' | 'UNCHANGED';
  readonly versionId: string;
  readonly status: ScheduleVersionStatus;
  readonly version: number;
}

const isSerializationFailure = (error: unknown) => (error as { code?: string } | null)?.code === '40001';

export class PostgresScheduleVersionRepository implements ScheduleVersionRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly capitalizedSources: CapitalizedSourcesReader,
    private readonly now: () => Date = () => new Date(),
    /**
     * Test seam only (§60 "Concurrency" tests): awaited inside the record's transaction between two statements of the
     * derivation (after the asset's read), so a test can hold the transaction there. `main.ts` never sets it.
     */
    private readonly afterAssetRead?: () => Promise<void>,
  ) {}

  async record(input: Parameters<ScheduleVersionRepository['record']>[0]): Promise<RecordOutcome> {
    const { assetId, mreRealmId, actor, idempotency, decide } = input;
    if (!UUID.test(assetId)) return { kind: 'NOT_FOUND' };
    try {
      return await this.db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx): Promise<RecordOutcome> => {
          // 1. The key.
          const ref = { mreRealmId, scope: RECORD_SCOPE, key: idempotency?.key ?? '' };
          if (idempotency !== undefined) {
            const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
            if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
            if (claim.kind === 'REPLAY') return replayed(trx, claim.result as RecordSnapshot);
          }
          // 2. The PropertyReference (no-op write), 3. the asset FOR UPDATE.
          await sql`
            UPDATE property_reference SET version = version
            WHERE id = (SELECT property_reference_id FROM depreciation_asset WHERE id = ${assetId} AND mre_realm_id = ${mreRealmId})
          `.execute(trx);
          const locked = await sql`SELECT id FROM depreciation_asset WHERE id = ${assetId} AND mre_realm_id = ${mreRealmId} FOR UPDATE`.execute(trx);
          if (locked.rows.length === 0) throw new Rejected({ kind: 'NOT_FOUND' });
          // 4. The CURRENT version FOR UPDATE; 5. the derivation's inputs in this snapshot, and the decision.
          const current = await lockCurrentVersion(trx, assetId);
          const schedule = await readScheduleIn(trx, this.capitalizedSources, businessDayOf(this.now()), assetId, mreRealmId, null, this.afterAssetRead);
          if (schedule === undefined) throw new Rejected({ kind: 'NOT_FOUND' });
          const read: RecordRead = { schedule, current };
          const decision = decide(read);
          // 6. Supersede, insert, audit, record the key.
          const outcome = await this.execute(trx, mreRealmId, actor, current, decision);
          if (outcome.kind === 'REFUSED') throw new Rejected(outcome);
          if (idempotency !== undefined && (outcome.kind === 'RECORDED' || outcome.kind === 'UNCHANGED')) {
            const snapshot: RecordSnapshot = {
              kind: outcome.kind,
              versionId: outcome.version.versionId,
              status: outcome.version.status,
              version: outcome.version.version,
            };
            await recordIdempotentResult(trx, ref, outcome.version.versionId, snapshot);
          }
          return outcome;
        });
    } catch (error) {
      if (error instanceof Rejected) return error.outcome;
      if (isSerializationFailure(error)) return { kind: 'SERIALIZATION_FAILURE' };
      throw error;
    }
  }

  private async execute(
    trx: Transaction<Database>,
    mreRealmId: string,
    actor: AuditActor,
    current: ScheduleVersion | null,
    decision: RecordDecision,
  ): Promise<RecordOutcome> {
    if (decision.kind === 'REFUSED') return { kind: 'REFUSED', refusal: decision.refusal };
    if (decision.kind === 'NOOP') return { kind: 'UNCHANGED', version: decision.version, replayed: false };
    const at = this.now();
    // The predecessor first (the successor key is deferred), then the new version with its rows.
    let newId: string | undefined;
    if (current !== null) {
      newId = (await sql<{ id: string }>`SELECT gen_random_uuid() AS id`.execute(trx)).rows[0]?.id;
      await sql`
        UPDATE depreciation_schedule_version SET status = 'SUPERSEDED', superseded_by_id = ${newId}, superseded_at = ${at}, version = version + 1
        WHERE id = ${current.versionId}
      `.execute(trx);
    }
    const versionNumber = (current?.versionNumber ?? 0) + 1;
    const id = await insertVersion(trx, mreRealmId, versionNumber, decision.version, newId);
    const version = await readVersionById(trx, id);
    if (version === undefined) throw new Error(`DepreciationScheduleVersion ${id} vanished`);
    const v = decision.version;
    await writeAudit(trx, { type: ENTITY_TYPE, id }, 'RECORDED', actor, {
      newVersion: 1,
      metadata: {
        assetId: v.assetId,
        versionNumber,
        fromYear: v.fromYear,
        throughYear: v.throughYear,
        reason: v.reason,
        inputFingerprint: v.inputFingerprint,
        outputFingerprint: v.outputFingerprint,
        calculationVersion: v.calculationVersion,
        ruleVersions: v.inputs.rules.map((r) => ({ ruleCode: r.ruleCode, version: r.version, ruleVersionHash: r.ruleVersionHash })),
        supersedesVersionId: current?.versionId ?? null,
        acceptedChangedYears: decision.changedYears.map((c) => c.year),
        years: v.years.map((y) => ({ year: y.year, amount: { amount: centsText(y.amount), currency: v.inputs.currency } })),
        openFlags: [...new Set(v.flags.filter((f) => f.level === 'OPEN').map((f) => f.code))].sort(),
      },
    });
    if (current !== null) {
      const money = (c: bigint | null) => (c === null ? null : { amount: centsText(c), currency: current.inputs.currency });
      await writeAudit(trx, { type: ENTITY_TYPE, id: current.versionId }, 'SUPERSEDED', actor, {
        previousVersion: 1,
        newVersion: 2,
        metadata: {
          supersededByVersionId: id,
          changedYears: decision.changedYears.map((c) => ({ year: c.year, recorded: money(c.recorded), derived: money(c.derived) })),
        },
      });
    }
    return { kind: 'RECORDED', version, replayed: false };
  }

  list(assetId: string, mreRealmId: string, statuses: readonly ScheduleVersionStatus[] | null): Promise<readonly ScheduleVersion[] | undefined> {
    return listVersions(this.db, assetId, mreRealmId, statuses);
  }

  find(assetId: string, mreRealmId: string, versionId: string) {
    return findVersion(
      this.db,
      (trx, id, realm) => readScheduleIn(trx, this.capitalizedSources, businessDayOf(this.now()), id, realm, null),
      assetId,
      mreRealmId,
      versionId,
    );
  }

  storedRuleVersionHashes(): Promise<readonly (RuleRef & { readonly ruleVersionHash: string })[]> {
    return storedRuleVersionHashes(this.db);
  }
}

async function replayed(trx: Transaction<Database>, snapshot: RecordSnapshot): Promise<RecordOutcome> {
  const stored = await readVersionById(trx, snapshot.versionId);
  if (stored === undefined) throw new Error(`DepreciationScheduleVersion ${snapshot.versionId} of a recorded key vanished`);
  // The answer as recorded (§15): the status and row version of then, whatever superseded it since.
  const version: ScheduleVersion =
    stored.status === snapshot.status
      ? stored
      : { ...stored, status: snapshot.status, supersededByVersionId: null, supersededAt: null, version: snapshot.version };
  return { kind: snapshot.kind, version, replayed: true };
}
