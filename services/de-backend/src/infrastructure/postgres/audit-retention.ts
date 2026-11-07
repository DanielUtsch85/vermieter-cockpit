import { sql, type Kysely, type Transaction } from 'kysely';
import {
  AUDIT_MARKER,
  AUDIT_PSEUDONYMISABLE_ACTION,
  AUDIT_PSEUDONYMISABLE_ENTITY_TYPES,
  AUDIT_PSEUDONYMISED_ACTION,
  auditRetentionCutoff,
  auditRetentionEndsOn,
  berlinYear,
  pseudonymiseAuditMetadata,
} from '../../domains/audit/index.js';
import type { CleanupTimers } from './idempotency-retention.js';
import type { Database } from './schema.js';

/**
 * VC-X-24 (api-design.md §58U; Entscheidung des Projektinhabers, 2026-11-06): after ten years from the end of its
 * creation year (Europe/Berlin), every personal value in the history of an `AMENDED` record (a Party's seven fields) is
 * replaced by the marker `[entfernt:v1]`; the record stays. The job runs once on start, before the server listens, and
 * once a day (`main.ts`, as VC-X-12); the erasure procedure (`audit-erasure.ts`) uses the same write.
 *
 * Each batch is one transaction: the due records are locked `FOR UPDATE SKIP LOCKED` (a second run at the same time takes
 * other records or none; the row lock re-reads `pseudonymised_at`, so a record is never replaced twice, and 0076's guard
 * refuses a second pseudonymisation anyway), each gets its markers and `pseudonymised_at`, and one `AUDIT_PSEUDONYMISED`
 * record on the same entity documents it. A record without a personal value is left unchanged and not marked. The job
 * needs no Realm: the marker is the same in every Realm, and the record keeps its entity, so the documenting record
 * belongs to the entity's Realm as the original does.
 */
export const AUDIT_PSEUDONYMISATION_BATCH = 500;
export const AUDIT_PSEUDONYMISATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUDIT_RETENTION_ACTOR = 'audit-retention';

export type PseudonymisationBasis = 'RETENTION_EXPIRED' | 'ERASURE_REQUEST';

export interface AuditRecordRow {
  readonly id: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly occurred_at: Date;
  readonly metadata: unknown;
}

/**
 * Replaces the personal values of one locked, due record and writes its `AUDIT_PSEUDONYMISED` record; answers the
 * replaced paths, or `undefined` when the record holds none (then nothing is written).
 */
export async function pseudonymiseAuditRecord(
  trx: Transaction<Database>,
  row: AuditRecordRow,
  now: Date,
  basis: PseudonymisationBasis,
): Promise<readonly string[] | undefined> {
  const replaced = pseudonymiseAuditMetadata(row.entity_type, row.metadata);
  if (replaced === undefined) return undefined;
  const updated = await trx
    .updateTable('audit_record')
    .set({ metadata: JSON.stringify(replaced.metadata), pseudonymised_at: now })
    .where('id', '=', row.id)
    .where('pseudonymised_at', 'is', null)
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows) !== 1) return undefined;
  await trx
    .insertInto('audit_record')
    .values({
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      action: AUDIT_PSEUDONYMISED_ACTION,
      actor_type: 'SYSTEM',
      actor_id: AUDIT_RETENTION_ACTOR,
      previous_version: null,
      new_version: null,
      metadata: JSON.stringify({
        auditRecordId: row.id,
        paths: replaced.paths,
        marker: AUDIT_MARKER,
        basis,
        retentionEndedOn: auditRetentionEndsOn(row.occurred_at),
      }),
    })
    .execute();
  return replaced.paths;
}

/**
 * Pseudonymises every due record (created before `auditRetentionCutoff(now)`, uses `audit_record_retention_idx`) in
 * batches of `batchSize`, one transaction each, in `id` order; answers how many records were pseudonymised.
 */
export async function pseudonymiseDueAuditRecords(db: Kysely<Database>, now: Date, options: { readonly batchSize?: number } = {}): Promise<number> {
  const batchSize = options.batchSize ?? AUDIT_PSEUDONYMISATION_BATCH;
  const cutoff = auditRetentionCutoff(now);
  let after: string | undefined;
  let total = 0;
  for (;;) {
    const { selected, last, pseudonymised } = await db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('audit_record')
        .select(['id', 'entity_type', 'entity_id', 'occurred_at', 'metadata'])
        .where('action', '=', AUDIT_PSEUDONYMISABLE_ACTION)
        .where('pseudonymised_at', 'is', null)
        .where('entity_type', 'in', AUDIT_PSEUDONYMISABLE_ENTITY_TYPES)
        .where('occurred_at', '<', cutoff)
        .$if(after !== undefined, (qb) => qb.where(sql<boolean>`id > ${after}::uuid`))
        .orderBy('id')
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .execute();
      let count = 0;
      for (const row of rows) if ((await pseudonymiseAuditRecord(trx, row, now, 'RETENTION_EXPIRED')) !== undefined) count += 1;
      return { selected: rows.length, last: rows.at(-1)?.id, pseudonymised: count };
    });
    total += pseudonymised;
    if (selected < batchSize || last === undefined) return total;
    after = last;
  }
}

/** The log line of a run: the count and the cutoff's day (`01.01.(N − 10)` in Europe/Berlin). */
export function pseudonymisationLogLine(count: number, now: Date): string {
  const cutoff = `${berlinYear(auditRetentionCutoff(now))}-01-01`;
  return `audit pseudonymisation: ${count} record(s) pseudonymised (retention 10 years, created before ${cutoff})`;
}

export interface AuditPseudonymisation {
  /** The run on start; settles after its log line, never rejects (a failure is logged). */
  readonly firstRun: Promise<void>;
  /** Clears the daily interval (on shutdown). */
  stop(): void;
}

const nodeTimers: CleanupTimers<NodeJS.Timeout> = {
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (handle) => clearInterval(handle),
};

/**
 * Runs `pseudonymise` once now and then once a day; the interval is `unref()`'d and `stop()` clears it. Each run logs one
 * line with the count; a failed run logs the error and does not stop the start, the next run tries again.
 */
export function startAuditPseudonymisation<H extends { unref(): unknown } = NodeJS.Timeout>(deps: {
  readonly pseudonymise: (now: Date) => Promise<number>;
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
  readonly now?: () => Date;
  readonly timers?: CleanupTimers<H>;
}): AuditPseudonymisation {
  const now = deps.now ?? (() => new Date());
  const timers = deps.timers ?? (nodeTimers as unknown as CleanupTimers<H>);
  const run = async (): Promise<void> => {
    const at = now();
    try {
      deps.log(pseudonymisationLogLine(await deps.pseudonymise(at), at));
    } catch (error) {
      deps.logError(`audit pseudonymisation failed: ${String(error)}`);
    }
  };
  const firstRun = run();
  const handle = timers.setInterval(() => void run(), AUDIT_PSEUDONYMISATION_INTERVAL_MS);
  handle.unref();
  return { firstRun, stop: () => timers.clearInterval(handle) };
}
