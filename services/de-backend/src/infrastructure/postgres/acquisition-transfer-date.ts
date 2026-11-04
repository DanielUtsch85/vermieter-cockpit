import type { Kysely } from 'kysely';
import { ownershipStart, planRecordTransferDate, type AcquisitionRepository, type RecordTransferDateOutcome } from '../../domains/acquisition/index.js';
import { COLUMNS, fromSnapshot, readOne, toSnapshot, withParties } from './acquisition-rows.js';
import { writeAudit } from './audit.js';
import { claimIdempotencyKey, recordIdempotentResult } from './idempotency.js';
import type { Database } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = 'acquisition.transfer-date.record';
export const ECONOMIC_TRANSFER_DATE_RECORDED = 'ECONOMIC_TRANSFER_DATE_RECORDED';

/** Thrown inside the transaction to roll back the key claim with it. */
class Rejected extends Error {
  constructor(readonly outcome: RecordTransferDateOutcome) {
    super(outcome.kind);
  }
}

/**
 * `POST /acquisitions/{id}/economic-transfer-date` (api-design.md §58N "Concurrency and locks"): one READ COMMITTED
 * transaction in the order of every path (§27.1): the key, the PropertyReference (no-op write, as every Ownership
 * writer), the Acquisition `FOR UPDATE`, re-read, the plan, the write (0067's guard admits exactly it), one AuditRecord
 * `ECONOMIC_TRANSFER_DATE_RECORDED`, the key's result. It serialises with `confirm`, `cancel`, cost, payment, allocation
 * and Ownership writes; a second recording waits and then answers `TRANSFER_DATE_ALREADY_SET`. No Ownership is written.
 */
export async function recordEconomicTransferDateIn(
  db: Kysely<Database>,
  input: Parameters<AcquisitionRepository['recordEconomicTransferDate']>[0],
): Promise<RecordTransferDateOutcome> {
  const { id, mreRealmId, record, at, actor, expectedVersions, idempotency } = input;
  if (!UUID.test(id)) return { kind: 'NOT_FOUND' };
  try {
    return await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx): Promise<RecordTransferDateOutcome> => {
        const ref = { mreRealmId, scope: SCOPE, key: idempotency?.key ?? '' };
        if (idempotency !== undefined) {
          const claim = await claimIdempotencyKey(trx, ref, idempotency.fingerprint);
          if (claim.kind === 'CONFLICT') return { kind: 'IDEMPOTENCY_CONFLICT' };
          if (claim.kind === 'REPLAY') return { kind: 'RECORDED', acquisition: fromSnapshot(claim.result), replayed: true };
        }
        await trx
          .updateTable('property_reference')
          .set((eb) => ({ version: eb.ref('version') }))
          .where('id', '=', (eb) => eb.selectFrom('acquisition').select('property_reference_id').where('id', '=', id).where('mre_realm_id', '=', mreRealmId))
          .execute();
        const row = await trx
          .selectFrom('acquisition')
          .select(COLUMNS)
          .where('id', '=', id)
          .where('mre_realm_id', '=', mreRealmId)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) throw new Rejected({ kind: 'NOT_FOUND' });
        const [current] = await withParties(trx, [row]);
        if (current === undefined) throw new Rejected({ kind: 'NOT_FOUND' });
        const plan = planRecordTransferDate(current, record, at, expectedVersions);
        if (plan.kind !== 'RECORD') throw new Rejected(plan);
        await trx
          .updateTable('acquisition')
          .set({
            economic_transfer_date: record.economicTransferDate,
            economic_transfer_recorded_at: at,
            economic_transfer_source_references: [...record.sourceReferences],
            version: plan.next.version,
            updated_at: at,
          })
          .where('id', '=', id)
          .execute();
        const recorded = await readOne(trx, id);
        await writeAudit(trx, { type: 'Acquisition', id }, ECONOMIC_TRANSFER_DATE_RECORDED, actor, {
          previousVersion: current.version,
          newVersion: recorded.version,
          metadata: {
            economicTransferDate: record.economicTransferDate,
            sourceReferences: record.sourceReferences,
            notes: record.notes,
            contractDate: current.contractDate,
            status: current.status,
            // §58N (b): the day the Ownerships begin stays the contract date.
            ownershipStart: ownershipStart(recorded),
          },
        });
        if (idempotency !== undefined) await recordIdempotentResult(trx, ref, id, toSnapshot(recorded));
        return { kind: 'RECORDED', acquisition: recorded, replayed: false };
      });
  } catch (error) {
    if (error instanceof Rejected) return error.outcome;
    throw error;
  }
}
